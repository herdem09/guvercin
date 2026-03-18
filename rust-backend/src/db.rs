use std::path::{Path, PathBuf};
use std::{collections::HashMap, sync::Arc};

use sqlx::{
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
    Connection, SqliteConnection, SqlitePool,
};
use tokio::sync::{Mutex, RwLock};

use crate::crypto::CryptoManager;
use crate::error::AppError;
use crate::keystore::{self, KeyStoreError};
use crate::models::TransferSnapshot;

#[derive(Clone)]
pub struct AppState {
    pub databases_dir: PathBuf,
    pub transfer_progress: Arc<Mutex<HashMap<i64, TransferSnapshot>>>,
    inner: Arc<RwLock<Option<Arc<AppStateInner>>>>,
}

#[derive(Clone)]
pub struct AppStateInner {
    pub general_pool: SqlitePool,
    pub crypto: Arc<CryptoManager>,
}

impl AppState {
    pub async fn initialize(db_dir: Option<PathBuf>) -> Result<Self, AppError> {
        let databases_dir = if let Some(dir) = db_dir {
            dir
        } else {
            detect_databases_dir().map_err(|e| AppError::BadRequest(e.to_string()))?
        };

        tokio::fs::create_dir_all(&databases_dir).await.map_err(|e| AppError::BadRequest(format!("Failed to create DB dir: {e}")))?;
        tracing::info!("Using databases directory: {:?}", databases_dir);

        let general_db_path = databases_dir.join("general.db");
        let general_db_path_str = general_db_path.to_string_lossy().into_owned();
        tracing::info!("General database path: {:?}", general_db_path);

        let inner = match keystore::load_master_key(crate::crypto::KEYRING_PROMPT).await {
            Ok(raw) => {
                let crypto = Arc::new(
                    CryptoManager::from_raw(raw)
                        .map_err(|e| AppError::KeyringUnavailable(format!("master key invalid: {e}")))?,
                );
                let general_pool = connect_sqlite(&general_db_path, &crypto)
                    .await
                    .map_err(|e| AppError::db(e, &general_db_path_str))?;
                init_general_db(&general_pool)
                    .await
                    .map_err(|e| AppError::db(e, &general_db_path_str))?;
                Some(Arc::new(AppStateInner {
                    general_pool,
                    crypto,
                }))
            }
            Err(KeyStoreError::NotFound) => None,
            Err(KeyStoreError::Denied) => {
                return Err(AppError::KeyringDenied(
                    "Keyring access denied. Unlock keyring to continue.".to_string()
                ))
            }
            Err(KeyStoreError::Other(e)) => {
                return Err(AppError::KeyringUnavailable(format!("keyring error: {e}")))
            }
        };

        Ok(Self {
            databases_dir,
            transfer_progress: Arc::new(Mutex::new(HashMap::new())),
            inner: Arc::new(RwLock::new(inner)),
        })
    }

    pub async fn ready_or_none(&self) -> Option<Arc<AppStateInner>> {
        self.inner.read().await.clone()
    }

    pub async fn ensure_ready(&self, create_if_missing: bool) -> Result<Arc<AppStateInner>, AppError> {
        if let Some(inner) = self.ready_or_none().await {
            return Ok(inner);
        }

        if !create_if_missing {
            return Err(AppError::KeyringUnavailable(
                "Encryption key not initialized. Complete setup to create the key.".to_string(),
            ));
        }

        let raw = match keystore::load_master_key(crate::crypto::KEYRING_PROMPT).await {
            Ok(raw) => raw,
            Err(KeyStoreError::NotFound) => {
                let crypto = match CryptoManager::create_and_store(crate::crypto::KEYRING_PROMPT)
                    .await
                {
                    Ok(crypto) => crypto,
                    Err(KeyStoreError::Denied) => {
                        return Err(AppError::KeyringDenied(
                            "Keyring access denied".to_string(),
                        ))
                    }
                    Err(KeyStoreError::Other(e)) => {
                        return Err(AppError::KeyringUnavailable(e));
                    }
                    Err(KeyStoreError::NotFound) => {
                        return Err(AppError::KeyringUnavailable("Master key not found after creation attempt".to_string()));
                    }
                };
                return self.init_with_crypto(Arc::new(crypto)).await;
            }
            Err(KeyStoreError::Denied) => {
                return Err(AppError::KeyringDenied(
                    "Keyring access denied".to_string(),
                ))
            }
            Err(KeyStoreError::Other(e)) => {
                return Err(AppError::KeyringUnavailable(e));
            }
        };

        let crypto = Arc::new(
            CryptoManager::from_raw(raw)
                .map_err(|e| AppError::KeyringUnavailable(e.to_string()))?,
        );
        self.init_with_crypto(crypto).await
    }

    async fn init_with_crypto(&self, crypto: Arc<CryptoManager>) -> Result<Arc<AppStateInner>, AppError> {
        let mut guard = self.inner.write().await;
        if let Some(inner) = guard.as_ref() {
            return Ok(inner.clone());
        }

        let general_db_path = self.databases_dir.join("general.db");
        let general_db_path_str = general_db_path.to_string_lossy().into_owned();
        let general_pool = connect_sqlite(&general_db_path, &crypto)
            .await
            .map_err(|e| AppError::db(e, &general_db_path_str))?;
        init_general_db(&general_pool)
            .await
            .map_err(|e| AppError::db(e, &general_db_path_str))?;

        let inner = Arc::new(AppStateInner {
            general_pool,
            crypto,
        });
        *guard = Some(inner.clone());
        Ok(inner)
    }

    pub async fn require_general_pool(&self) -> Result<SqlitePool, AppError> {
        Ok(self.ensure_ready(false).await?.general_pool.clone())
    }
}

fn detect_databases_dir() -> anyhow::Result<PathBuf> {
    
    if let Ok(dir) = std::env::var("DATABASE_DIR") {
        return Ok(PathBuf::from(dir));
    }

    if let Some(home) = dirs::home_dir() {
        let p = home.join(".guvercin").join("databases");
        if std::fs::create_dir_all(&p).is_ok() {
            return Ok(p);
        }
    }

    let cwd = std::env::current_dir()?;
    let p = cwd.join("databases");
    Ok(p)
}

async fn connect_sqlite(path: &Path, crypto: &CryptoManager) -> sqlx::Result<SqlitePool> {
    let key_hex = crypto
        .sqlcipher_key_hex_for_db(path)
        .map_err(|e| sqlx::Error::Protocol(e.to_string()))?;

    let attempt = connect_sqlcipher(path, &key_hex).await;
    if attempt.is_ok() || !path.exists() {
        return attempt;
    }

    if is_plaintext_sqlite(path).await {
        migrate_plaintext_to_sqlcipher(path, &key_hex).await?;
        return connect_sqlcipher(path, &key_hex).await;
    }

    attempt
}

async fn connect_sqlcipher(path: &Path, key_hex: &str) -> sqlx::Result<SqlitePool> {
    let opts = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        .pragma("key", format!("\"x'{}'\"", key_hex))
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
        .synchronous(sqlx::sqlite::SqliteSynchronous::Normal);

    SqlitePoolOptions::new()
        .after_connect(move |conn, _| {
            Box::pin(async move {
                let cipher_version: Option<String> = sqlx::query_scalar("PRAGMA cipher_version;")
                    .fetch_optional(&mut *conn)
                    .await?;
                if cipher_version.as_deref().unwrap_or("").is_empty() {
                    return Err(sqlx::Error::Protocol(
                        "SQLCipher support not detected. Ensure libsqlite3-sys is built with bundled-sqlcipher."
                            .to_string(),
                    ));
                }

                sqlx::query("PRAGMA foreign_keys = ON;").execute(&mut *conn).await?;
                Ok(())
            })
        })
        .connect_with(opts)
        .await
}

async fn is_plaintext_sqlite(path: &Path) -> bool {
    let metadata = match tokio::fs::metadata(path).await {
        Ok(m) => m,
        Err(_) => return false,
    };
    if metadata.len() == 0 {
        return false;
    }

    let opts = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(false);
    let mut conn = match SqliteConnection::connect_with(&opts).await {
        Ok(conn) => conn,
        Err(_) => return false,
    };

    let res = sqlx::query_scalar::<_, i64>("SELECT count(*) FROM sqlite_master")
        .fetch_one(&mut conn)
        .await;
    res.is_ok()
}

async fn migrate_plaintext_to_sqlcipher(path: &Path, key_hex: &str) -> sqlx::Result<()> {
    let tmp_path = path.with_extension("db.enc");
    let backup_path = path.with_extension("db.bak");
    let _ = tokio::fs::remove_file(&tmp_path).await;

    {
        let opts = SqliteConnectOptions::new().filename(path).create_if_missing(false);
        let mut conn = SqliteConnection::connect_with(&opts).await?;
        let attach = format!(
            "ATTACH DATABASE '{}' AS encrypted KEY \"x'{}'\";",
            tmp_path.to_string_lossy(),
            key_hex
        );
        sqlx::query(&attach).execute(&mut conn).await?;
        sqlx::query("SELECT sqlcipher_export('encrypted');")
            .execute(&mut conn)
            .await?;
        sqlx::query("DETACH DATABASE encrypted;")
            .execute(&mut conn)
            .await?;
    }

    tokio::fs::rename(path, &backup_path).await?;
    tokio::fs::rename(&tmp_path, path).await?;
    Ok(())
}

pub async fn get_user_db_pool(state: &AppState, account_id: i64) -> Result<SqlitePool, AppError> {
    let user_db_path = state.databases_dir.join(format!("{account_id}.db"));
    let user_db_path_str = user_db_path.to_string_lossy().into_owned();

    let inner = state.ensure_ready(false).await?;

    let pool = connect_sqlite(&user_db_path, &inner.crypto)
        .await
        .map_err(|e| AppError::db(e, &user_db_path_str))?;

    init_user_db(&pool)
        .await
        .map_err(|e| AppError::db(e, &user_db_path_str))?;

    Ok(pool)
}

async fn init_general_db(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS accounts (
            account_id   INTEGER PRIMARY KEY AUTOINCREMENT,
            email_address TEXT UNIQUE,
            display_name  TEXT,
            provider_type TEXT NOT NULL DEFAULT 'imap',
            imap_host     TEXT,
            imap_port     INTEGER,
            smtp_host     TEXT,
            smtp_port     INTEGER,
            auth_token    TEXT,
            sync_status   BOOLEAN DEFAULT 0,
            last_sync_time DATETIME,
            language      TEXT DEFAULT 'EN',
            theme         TEXT DEFAULT 'SYSTEM',
            font          TEXT,
            ssl_mode      TEXT DEFAULT 'STARTTLS'
        )
        "#,
    )
    .execute(pool)
    .await?;

    let _ = sqlx::query("ALTER TABLE accounts ADD COLUMN ssl_mode TEXT DEFAULT 'STARTTLS'")
        .execute(pool)
        .await;

    let _ = sqlx::query("ALTER TABLE accounts ADD COLUMN theme TEXT DEFAULT 'SYSTEM'")
        .execute(pool)
        .await;
    let _ = sqlx::query("UPDATE accounts SET theme = 'SYSTEM' WHERE theme IS NULL OR theme = '' OR theme = 'LIGHT'")
        .execute(pool)
        .await;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS avatar_cache (
            email_hash   TEXT PRIMARY KEY,
            email        TEXT NOT NULL,
            file_path    TEXT NOT NULL DEFAULT '',
            content_type TEXT NOT NULL DEFAULT '',
            source       TEXT NOT NULL DEFAULT 'none',
            not_found    BOOLEAN NOT NULL DEFAULT 0,
            last_checked DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE INDEX IF NOT EXISTS idx_avatar_cache_checked
        ON avatar_cache(last_checked)
        "#,
    )
    .execute(pool)
    .await?;

    Ok(())
}

async fn init_user_db(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS emails (
            local_id      INTEGER PRIMARY KEY AUTOINCREMENT,
            server_uid    INTEGER UNIQUE,
            uid_validity  INTEGER NOT NULL,
            message_id    TEXT UNIQUE,
            in_reply_to   TEXT,
            sender_from   TEXT NOT NULL,
            recipient_to  TEXT NOT NULL,
            recipient_cc  TEXT,
            recipient_bcc TEXT,
            subject       TEXT DEFAULT '',
            date_sent     DATETIME NOT NULL,
            body_text     TEXT,
            body_html     TEXT,
            attach_amount INTEGER,
            is_read       BOOLEAN DEFAULT 0,
            is_answered   BOOLEAN DEFAULT 0,
            is_forwarded  BOOLEAN DEFAULT 0,
            is_flagged    BOOLEAN DEFAULT 0,
            user_labels   TEXT,
            folder_id     INTEGER NOT NULL,
            sync_status   INTEGER DEFAULT 0
        )
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS attachments (
            ID               INTEGER PRIMARY KEY AUTOINCREMENT,
            locale_mail_ID   INTEGER NOT NULL,
            attachment_num   INTEGER NOT NULL,
            file_name        TEXT NOT NULL,
            just_name        TEXT NOT NULL,
            just_file_extension TEXT NOT NULL,
            mime_type        TEXT NOT NULL,
            file_size        INTEGER NOT NULL,
            is_downloaded    BOOLEAN DEFAULT 0,
            file_path        TEXT,
            content_id       TEXT NOT NULL,
            is_inline        BOOLEAN NOT NULL,
            inline_temp_path TEXT
        )
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS folders (
            folder_id     INTEGER PRIMARY KEY AUTOINCREMENT,
            path_by_name  TEXT UNIQUE NOT NULL,
            path_by_id    TEXT UNIQUE NOT NULL,
            name          TEXT NOT NULL,
            type          TEXT NOT NULL,
            unread_count  INTEGER DEFAULT 0,
            total_count   INTEGER DEFAULT 0,
            last_sync_uid INTEGER DEFAULT 0,
            is_visible    BOOLEAN DEFAULT 1
        )
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS contacts (
            contact_id    INTEGER PRIMARY KEY AUTOINCREMENT,
            name          TEXT,
            display_name  TEXT,
            mail_address  TEXT,
            phone_number_country_code TEXT,
            phone_number  INTEGER,
            fax_number    INTEGER,
            website       TEXT,
            last_contact_time DATETIME
        )
        "#,
    )
    .execute(pool)
    .await?;

    let _ = sqlx::query("ALTER TABLE contacts ADD COLUMN avatar_data BLOB")
        .execute(pool)
        .await;

    let _ = sqlx::query("DROP TABLE IF EXISTS ai").execute(pool).await;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS download_mails (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            node_path TEXT NOT NULL,
            node_type TEXT NOT NULL,
            rule_type TEXT NOT NULL,
            source TEXT NOT NULL,
            is_active BOOLEAN DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE UNIQUE INDEX IF NOT EXISTS idx_download_mails_unique_active
        ON download_mails(node_path, node_type, rule_type, is_active)
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS offline_config (
            id INTEGER PRIMARY KEY CHECK(id = 1),
            enabled BOOLEAN NOT NULL DEFAULT 1,
            initial_sync_mode TEXT NOT NULL DEFAULT 'all',
            initial_sync_value INTEGER,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        INSERT OR IGNORE INTO offline_config (id, enabled, initial_sync_mode, initial_sync_value)
        VALUES (1, 1, 'all', NULL)
        "#,
    )
    .execute(pool)
    .await?;

    let _ = sqlx::query(
        "ALTER TABLE offline_config ADD COLUMN cache_raw_rfc822 BOOLEAN NOT NULL DEFAULT 1",
    )
    .execute(pool)
    .await;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS offline_sync_queue (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            action_type TEXT NOT NULL,
            target_uid TEXT,
            target_folder TEXT,
            payload_json TEXT,
            status TEXT NOT NULL DEFAULT 'pending',
            attempt_count INTEGER NOT NULL DEFAULT 0,
            last_error TEXT,
            next_retry_at DATETIME,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE INDEX IF NOT EXISTS idx_offline_sync_queue_status_retry
        ON offline_sync_queue(status, next_retry_at, created_at)
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS outbox_mails (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            draft_rfc822 TEXT,
            from_addr TEXT,
            to_addrs TEXT,
            cc_addrs TEXT,
            bcc_addrs TEXT,
            format_value TEXT NOT NULL DEFAULT 'plain',
            subject TEXT,
            body_text TEXT,
            body_html TEXT,
            attachments_json TEXT,
            status TEXT NOT NULL DEFAULT 'pending',
            attempt_count INTEGER NOT NULL DEFAULT 0,
            next_retry_at DATETIME,
            last_error TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
        "#,
    )
    .execute(pool)
    .await?;

    let _ = sqlx::query("ALTER TABLE outbox_mails ADD COLUMN format_value TEXT NOT NULL DEFAULT 'plain'")
        .execute(pool)
        .await;
    let _ = sqlx::query("ALTER TABLE outbox_mails ADD COLUMN body_html TEXT")
        .execute(pool)
        .await;
    let _ = sqlx::query("ALTER TABLE outbox_mails ADD COLUMN attachments_json TEXT")
        .execute(pool)
        .await;

    sqlx::query(
        r#"
        CREATE INDEX IF NOT EXISTS idx_outbox_status_retry
        ON outbox_mails(status, next_retry_at, created_at)
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS sync_checkpoints (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            folder_path TEXT UNIQUE NOT NULL,
            last_synced_uid INTEGER DEFAULT 0,
            last_uid_validity INTEGER DEFAULT 0,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS mailbox_capabilities_cache (
            capability_key TEXT PRIMARY KEY,
            capability_value TEXT,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS local_mail_cache (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            uid TEXT NOT NULL,
            folder TEXT NOT NULL,
            sender_name TEXT,
            sender_address TEXT,
            recipient_to TEXT,
            subject TEXT,
            seen BOOLEAN DEFAULT 0,
            flagged BOOLEAN DEFAULT 0,
            date_value TEXT,
            date_ms INTEGER DEFAULT 0,
            size_bytes INTEGER DEFAULT 0,
            importance_value INTEGER DEFAULT 0,
            content_type TEXT,
            category TEXT,
            labels_json TEXT DEFAULT '[]',
            cc_value TEXT,
            bcc_value TEXT,
            plain_body TEXT,
            html_body TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(uid, folder)
        )
        "#,
    )
    .execute(pool)
    .await?;

    let _ = sqlx::query("ALTER TABLE local_mail_cache ADD COLUMN raw_rfc822 BLOB")
        .execute(pool)
        .await;

    let _ = sqlx::query("ALTER TABLE local_mail_cache ADD COLUMN date_ms INTEGER DEFAULT 0")
        .execute(pool)
        .await;

    let _ = sqlx::query("ALTER TABLE local_mail_cache ADD COLUMN cc_value TEXT")
        .execute(pool)
        .await;

    let _ = sqlx::query("ALTER TABLE local_mail_cache ADD COLUMN bcc_value TEXT")
        .execute(pool)
        .await;

    let _ = sqlx::query("ALTER TABLE local_mail_cache ADD COLUMN recipient_to TEXT")
        .execute(pool)
        .await;

    let _ = sqlx::query("ALTER TABLE local_mail_cache ADD COLUMN flagged BOOLEAN DEFAULT 0")
        .execute(pool)
        .await;

    let _ = sqlx::query("ALTER TABLE local_mail_cache ADD COLUMN size_bytes INTEGER DEFAULT 0")
        .execute(pool)
        .await;

    let _ = sqlx::query("ALTER TABLE local_mail_cache ADD COLUMN importance_value INTEGER DEFAULT 0")
        .execute(pool)
        .await;

    let _ = sqlx::query("ALTER TABLE local_mail_cache ADD COLUMN content_type TEXT")
        .execute(pool)
        .await;

    let _ = sqlx::query("ALTER TABLE local_mail_cache ADD COLUMN category TEXT")
        .execute(pool)
        .await;

    let _ = sqlx::query("ALTER TABLE local_mail_cache ADD COLUMN labels_json TEXT DEFAULT '[]'")
        .execute(pool)
        .await;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS inline_asset_cache (
            asset_id TEXT PRIMARY KEY,
            url TEXT NOT NULL,
            content_type TEXT NOT NULL,
            body BLOB NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE INDEX IF NOT EXISTS idx_inline_asset_cache_updated
        ON inline_asset_cache(updated_at)
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS draft_attachments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            draft_uid TEXT NOT NULL,
            filename TEXT NOT NULL,
            content_type TEXT NOT NULL,
            size_bytes INTEGER NOT NULL DEFAULT 0,
            data_base64 TEXT NOT NULL,
            disposition TEXT NOT NULL DEFAULT 'attachment',
            content_id TEXT,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE INDEX IF NOT EXISTS idx_draft_attachments_uid_sort
        ON draft_attachments(draft_uid, sort_order, id)
        "#,
    )
    .execute(pool)
    .await?;

    Ok(())
}
