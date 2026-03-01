use std::path::{Path, PathBuf};

use sqlx::{sqlite::SqliteConnectOptions, SqlitePool};

use crate::error::AppError;

#[derive(Clone)]
pub struct AppState {
    pub general_pool: SqlitePool,
    pub databases_dir: PathBuf,
}

impl AppState {
    pub async fn initialize() -> anyhow::Result<Self> {
        let databases_dir = detect_databases_dir()?;

        // Ensure the databases/ directory exists
        tokio::fs::create_dir_all(&databases_dir).await?;

        let general_db_path = databases_dir.join("general.db");
        let general_pool = connect_sqlite(&general_db_path).await?;

        init_general_db(&general_pool).await?;

        Ok(Self {
            general_pool,
            databases_dir,
        })
    }
}

fn detect_databases_dir() -> anyhow::Result<PathBuf> {
    if let Ok(dir) = std::env::var("DATABASE_DIR") {
        return Ok(PathBuf::from(dir));
    }
    // Always use <cwd>/databases – created on demand.
    let cwd = std::env::current_dir()?;
    Ok(cwd.join("databases"))
}

/// Open (or create) a SQLite database at `path`.
async fn connect_sqlite(path: &Path) -> sqlx::Result<SqlitePool> {
    let opts = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true);
    SqlitePool::connect_with(opts).await
}

pub async fn get_user_db_pool(state: &AppState, account_id: i64) -> Result<SqlitePool, AppError> {
    let user_db_path = state.databases_dir.join(format!("{account_id}.db"));
    let pool = connect_sqlite(&user_db_path)
        .await
        .map_err(AppError::from)?;
    init_user_db(&pool).await.map_err(AppError::from)?;
    Ok(pool)
}

async fn init_general_db(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    // accounts table
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
            theme         TEXT DEFAULT 'LIGHT',
            font          TEXT,
            ssl_mode      TEXT DEFAULT 'STARTTLS'
        )
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS ai (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            model_name TEXT,
            type BOOLEAN,
            api_key_server_url TEXT,
            base_url_context_window TEXT
        )
        "#,
    )
    .execute(pool)
    .await?;

    // Migration for existing databases
    let _ = sqlx::query("ALTER TABLE accounts ADD COLUMN ssl_mode TEXT DEFAULT 'STARTTLS'")
        .execute(pool)
        .await;

    Ok(())
}

async fn init_user_db(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    // emails table
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

    // attachments table
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

    // folders table
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

    // contacts table
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

    Ok(())
}
