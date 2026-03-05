use std::sync::Arc;

use axum::{
    body::Body,
    extract::{Json, Path, Query, State},
    http::{
        header::{CONTENT_DISPOSITION, CONTENT_LENGTH, CONTENT_TYPE},
        StatusCode,
    },
    response::{IntoResponse, Response},
};
use chrono::{DateTime, Duration, Utc};
use serde::Deserialize;
use serde_json::json;
use sqlx::{Row, SqlitePool};

use crate::{
    db::{self, AppState},
    error::AppError,
    imap_session::{self, ImapState},
    mail_models::{MailContent, MailListResponse, MailPreview},
    mail_routes::MailAppState,
    models::{
        DownloadRuleInput, DownloadRuleRecord, InitialSyncPolicyInput, OfflineActionRequest,
        OfflineActionResponse, OfflineConfigResponse, OfflineSetupPayload, OfflineStatusResponse,
        SyncNowResponse,
    },
};

#[derive(Deserialize)]
pub struct LocalMailListQuery {
    #[serde(default = "default_inbox")]
    pub mailbox: String,
    #[serde(default = "default_page")]
    pub page: usize,
    #[serde(default = "default_per_page")]
    pub per_page: usize,
}

struct AccountImapSettings {
    email: String,
    imap_host: String,
    imap_port: u16,
    password: String,
    ssl_mode: String,
}

struct SyncPolicy {
    enabled: bool,
    mode: String,
    value: Option<i64>,
}

fn default_inbox() -> String {
    "INBOX".to_string()
}

fn default_page() -> usize {
    1
}

fn default_per_page() -> usize {
    50
}

pub async fn get_local_mail_list(
    State(state): State<Arc<MailAppState>>,
    Path(account_id): Path<i64>,
    Query(q): Query<LocalMailListQuery>,
) -> Result<Json<MailListResponse>, AppError> {
    let pool = db::get_user_db_pool(&state._db, account_id).await?;
    let offset = q.page.saturating_sub(1) * q.per_page;

    let total: i64 = sqlx::query_scalar("SELECT COUNT(1) FROM local_mail_cache WHERE folder = ?")
        .bind(&q.mailbox)
        .fetch_one(&pool)
        .await
        .unwrap_or(0);

    let rows = sqlx::query(
        r#"
        SELECT uid, sender_name, sender_address, subject, date_value, seen
        FROM local_mail_cache
        WHERE folder = ?
        ORDER BY updated_at DESC
        LIMIT ? OFFSET ?
        "#,
    )
    .bind(&q.mailbox)
    .bind(q.per_page as i64)
    .bind(offset as i64)
    .fetch_all(&pool)
    .await?;

    let mails = rows
        .into_iter()
        .map(|r| MailPreview {
            id: r.try_get::<String, _>("uid").unwrap_or_default(),
            name: r
                .try_get::<Option<String>, _>("sender_name")
                .ok()
                .flatten()
                .unwrap_or_default(),
            address: r
                .try_get::<Option<String>, _>("sender_address")
                .ok()
                .flatten()
                .unwrap_or_default(),
            subject: r
                .try_get::<Option<String>, _>("subject")
                .ok()
                .flatten()
                .unwrap_or_default(),
            date: r
                .try_get::<Option<String>, _>("date_value")
                .ok()
                .flatten()
                .unwrap_or_default(),
            seen: r
                .try_get::<Option<i64>, _>("seen")
                .ok()
                .flatten()
                .unwrap_or(0)
                != 0,
        })
        .collect();

    Ok(Json(MailListResponse {
        total_count: total.max(0) as usize,
        mails,
    }))
}

pub async fn get_local_mail_content(
    State(state): State<Arc<MailAppState>>,
    Path((account_id, uid)): Path<(i64, String)>,
    Query(q): Query<LocalMailListQuery>,
) -> impl IntoResponse {
    let pool = match db::get_user_db_pool(&state._db, account_id).await {
        Ok(p) => p,
        Err(e) => return e.into_response(),
    };

    let row = sqlx::query(
        r#"
        SELECT uid, subject, sender_name, sender_address, date_value, plain_body, html_body, raw_rfc822
        FROM local_mail_cache
        WHERE uid = ? AND folder = ?
        "#,
    )
    .bind(&uid)
    .bind(&q.mailbox)
    .fetch_optional(&pool)
    .await;

    match row {
        Ok(Some(r)) => {
            if let Some(raw) = r.try_get::<Option<Vec<u8>>, _>("raw_rfc822").ok().flatten() {
                return Json(imap_session::parse_mail_content(uid, &raw)).into_response();
            }

            Json(MailContent {
                id: r.try_get::<String, _>("uid").unwrap_or(uid),
                subject: r
                    .try_get::<Option<String>, _>("subject")
                    .ok()
                    .flatten()
                    .unwrap_or_default(),
                from_name: r
                    .try_get::<Option<String>, _>("sender_name")
                    .ok()
                    .flatten()
                    .unwrap_or_default(),
                from_address: r
                    .try_get::<Option<String>, _>("sender_address")
                    .ok()
                    .flatten()
                    .unwrap_or_default(),
                date: r
                    .try_get::<Option<String>, _>("date_value")
                    .ok()
                    .flatten()
                    .unwrap_or_default(),
                html_body: r
                    .try_get::<Option<String>, _>("html_body")
                    .ok()
                    .flatten()
                    .unwrap_or_default(),
                plain_body: r
                    .try_get::<Option<String>, _>("plain_body")
                    .ok()
                    .flatten()
                    .unwrap_or_default(),
                attachments: vec![],
            })
            .into_response()
        }
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(json!({"error":"Mail not found"})),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": format!("DB error: {e}")})),
        )
            .into_response(),
    }
}

pub async fn download_local_attachment(
    State(state): State<Arc<MailAppState>>,
    Path((account_id, uid, attachment_index)): Path<(i64, String, usize)>,
    Query(q): Query<LocalMailListQuery>,
) -> impl IntoResponse {
    let pool = match db::get_user_db_pool(&state._db, account_id).await {
        Ok(p) => p,
        Err(e) => return e.into_response(),
    };

    let row = match sqlx::query("SELECT raw_rfc822 FROM local_mail_cache WHERE uid = ? AND folder = ?")
        .bind(&uid)
        .bind(&q.mailbox)
        .fetch_optional(&pool)
        .await
    {
        Ok(row) => row,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": format!("DB error: {e}")})),
            )
                .into_response()
        }
    };

    let Some(row) = row else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({"error":"Attachment not cached offline"})),
        )
            .into_response();
    };

    let raw = row
        .try_get::<Option<Vec<u8>>, _>("raw_rfc822")
        .ok()
        .flatten();

    let Some(raw) = raw else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({"error":"Attachment not cached offline"})),
        )
            .into_response();
    };

    if let Some((info, data)) = imap_session::find_attachment_bytes(&raw, attachment_index) {
        let escaped = info.filename.replace('"', "\\\"");
        let encoded = percent_encode_filename(&info.filename);
        let disposition = format!("attachment; filename=\"{escaped}\"; filename*=UTF-8''{encoded}");
        return Response::builder()
            .status(StatusCode::OK)
            .header(CONTENT_TYPE, info.content_type)
            .header(CONTENT_LENGTH, data.len().to_string())
            .header(CONTENT_DISPOSITION, disposition)
            .body(Body::from(data))
            .unwrap_or_else(|_| {
                Response::builder()
                    .status(StatusCode::INTERNAL_SERVER_ERROR)
                    .body(Body::empty())
                    .unwrap()
            })
            .into_response();
    }

    (
        StatusCode::NOT_FOUND,
        Json(json!({"error":"Attachment not found"})),
    )
        .into_response()
}

pub async fn save_offline_setup(
    app_state: &Arc<AppState>,
    account_id: i64,
    offline: Option<OfflineSetupPayload>,
) -> Result<(), AppError> {
    let setup = offline.unwrap_or(OfflineSetupPayload {
        enabled: true,
        download_rules: vec![DownloadRuleInput {
            node_path: "INBOX".to_string(),
            node_type: "folder".to_string(),
            rule_type: "include_prefix".to_string(),
            source: "user".to_string(),
        }],
        initial_sync_policy: InitialSyncPolicyInput {
            mode: "all".to_string(),
            value: None,
        },
    });

    let pool = db::get_user_db_pool(app_state, account_id).await?;
    let mut tx = pool.begin().await?;

    sqlx::query(
        r#"
        INSERT INTO offline_config (id, enabled, initial_sync_mode, initial_sync_value, updated_at)
        VALUES (1, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET
            enabled = excluded.enabled,
            initial_sync_mode = excluded.initial_sync_mode,
            initial_sync_value = excluded.initial_sync_value,
            updated_at = CURRENT_TIMESTAMP
        "#,
    )
    .bind(setup.enabled as i64)
    .bind(&setup.initial_sync_policy.mode)
    .bind(setup.initial_sync_policy.value)
    .execute(&mut *tx)
    .await?;

    sqlx::query("UPDATE download_mails SET is_active = 0, updated_at = CURRENT_TIMESTAMP")
        .execute(&mut *tx)
        .await?;

    for rule in &setup.download_rules {
        sqlx::query(
            r#"
            INSERT INTO download_mails (node_path, node_type, rule_type, source, is_active, created_at, updated_at)
            VALUES (?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            ON CONFLICT(node_path, node_type, rule_type, is_active)
            DO UPDATE SET source = excluded.source, updated_at = CURRENT_TIMESTAMP
            "#,
        )
        .bind(&rule.node_path)
        .bind(&rule.node_type)
        .bind(&rule.rule_type)
        .bind(&rule.source)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;
    Ok(())
}

pub async fn get_offline_config(
    State(state): State<Arc<MailAppState>>,
    Path(account_id): Path<i64>,
) -> Result<Json<OfflineConfigResponse>, AppError> {
    let pool = db::get_user_db_pool(&state._db, account_id).await?;
    let row = sqlx::query(
        "SELECT enabled, initial_sync_mode, initial_sync_value FROM offline_config WHERE id = 1",
    )
    .fetch_optional(&pool)
    .await?;

    let (enabled, mode, value) = if let Some(r) = row {
        (
            r.try_get::<Option<i64>, _>("enabled")
                .ok()
                .flatten()
                .unwrap_or(1)
                != 0,
            r.try_get::<Option<String>, _>("initial_sync_mode")
                .ok()
                .flatten()
                .unwrap_or_else(|| "all".to_string()),
            r.try_get::<Option<i64>, _>("initial_sync_value")
                .ok()
                .flatten(),
        )
    } else {
        (true, "all".to_string(), None)
    };

    let rules = sqlx::query_as::<_, DownloadRuleRecord>(
        r#"
        SELECT id, node_path, node_type, rule_type, source, is_active, created_at, updated_at
        FROM download_mails
        WHERE is_active = 1
        ORDER BY node_path ASC
        "#,
    )
    .fetch_all(&pool)
    .await?;

    Ok(Json(OfflineConfigResponse {
        enabled,
        initial_sync_policy: InitialSyncPolicyInput { mode, value },
        download_rules: rules,
    }))
}

pub async fn put_offline_config(
    State(state): State<Arc<MailAppState>>,
    Path(account_id): Path<i64>,
    Json(payload): Json<OfflineSetupPayload>,
) -> Result<Json<OfflineConfigResponse>, AppError> {
    save_offline_setup(&state._db, account_id, Some(payload)).await?;
    get_offline_config(State(state), Path(account_id)).await
}

pub async fn get_offline_status(
    State(state): State<Arc<MailAppState>>,
    Path(account_id): Path<i64>,
) -> Result<Json<OfflineStatusResponse>, AppError> {
    let pool = db::get_user_db_pool(&state._db, account_id).await?;
    let queue_depth: i64 = sqlx::query_scalar(
        "SELECT COUNT(1) FROM offline_sync_queue WHERE status IN ('pending', 'failed', 'processing')",
    )
    .fetch_one(&pool)
    .await
    .unwrap_or(0);

    let status_row = sqlx::query(
        "SELECT sync_status, last_sync_time, smtp_host FROM accounts WHERE account_id = ?",
    )
    .bind(account_id)
    .fetch_optional(&state._db.general_pool)
    .await?;

    let (account_syncing, last_sync_at, smtp_reachable) = if let Some(r) = status_row {
        (
            r.try_get::<Option<i64>, _>("sync_status")
                .ok()
                .flatten()
                .unwrap_or(0)
                != 0,
            r.try_get::<Option<String>, _>("last_sync_time")
                .ok()
                .flatten(),
            r.try_get::<Option<String>, _>("smtp_host")
                .ok()
                .flatten()
                .map(|v| !v.is_empty())
                .unwrap_or(false),
        )
    } else {
        (false, None, false)
    };

    let last_error = {
        let row = sqlx::query(
            r#"
            SELECT last_error
            FROM offline_sync_queue
            WHERE status IN ('failed','dead')
            ORDER BY updated_at DESC
            LIMIT 1
            "#,
        )
        .fetch_optional(&pool)
        .await?;
        row.and_then(|r| r.try_get::<Option<String>, _>("last_error").ok().flatten())
    };

    let imap_reachable = imap_session::is_connected(&state.imap, account_id);
    let sync_state = if account_syncing || (imap_reachable && queue_depth > 0) {
        "syncing".to_string()
    } else if imap_reachable {
        "idle".to_string()
    } else {
        "offline".to_string()
    };

    Ok(Json(OfflineStatusResponse {
        network_online: true,
        backend_reachable: true,
        imap_reachable,
        smtp_reachable,
        queue_depth,
        sync_state,
        last_sync_at,
        last_error,
    }))
}

pub async fn post_offline_action(
    State(state): State<Arc<MailAppState>>,
    Path(account_id): Path<i64>,
    Json(payload): Json<OfflineActionRequest>,
) -> Result<Json<OfflineActionResponse>, AppError> {
    let pool = db::get_user_db_pool(&state._db, account_id).await?;
    let payload_json = payload
        .payload
        .as_ref()
        .map(|p| p.to_string())
        .unwrap_or_else(|| "{}".to_string());

    if payload.action_type == "send" {
        let from_addr = payload
            .payload
            .as_ref()
            .and_then(|p| p.get("from"))
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        let to_addrs = payload
            .payload
            .as_ref()
            .and_then(|p| p.get("to"))
            .map(|v| v.to_string())
            .unwrap_or_else(|| "[]".to_string());
        let subject = payload
            .payload
            .as_ref()
            .and_then(|p| p.get("subject"))
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        let body_text = payload
            .payload
            .as_ref()
            .and_then(|p| p.get("body"))
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();

        sqlx::query(
            r#"
            INSERT INTO outbox_mails (from_addr, to_addrs, subject, body_text, status)
            VALUES (?, ?, ?, ?, 'pending')
            "#,
        )
        .bind(from_addr)
        .bind(to_addrs)
        .bind(subject)
        .bind(body_text)
        .execute(&pool)
        .await?;
    }

    let res = sqlx::query(
        r#"
        INSERT INTO offline_sync_queue (action_type, target_uid, target_folder, payload_json, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        "#,
    )
    .bind(payload.action_type)
    .bind(payload.target_uid)
    .bind(payload.target_folder)
    .bind(payload_json)
    .execute(&pool)
    .await?;

    Ok(Json(OfflineActionResponse {
        status: "queued",
        queued_id: res.last_insert_rowid(),
    }))
}

pub async fn sync_now(
    State(state): State<Arc<MailAppState>>,
    Path(account_id): Path<i64>,
) -> Result<Json<SyncNowResponse>, AppError> {
    set_account_sync_status(&state._db, account_id, true).await?;
    let result = sync_now_impl(&state, account_id).await;
    let _ = set_account_sync_status(&state._db, account_id, false).await;
    let (processed, failed) = result?;

    Ok(Json(SyncNowResponse {
        status: "ok",
        processed,
        failed,
    }))
}

async fn sync_now_impl(
    state: &Arc<MailAppState>,
    account_id: i64,
) -> Result<(usize, usize), AppError> {
    ensure_imap_connected(&state._db, &state.imap, account_id).await?;
    let (processed, failed) = process_queue_once(state, account_id, 200).await?;
    sync_cached_mailboxes(&state._db, &state.imap, account_id).await?;
    touch_last_sync_time(&state._db, account_id).await?;
    Ok((processed, failed))
}

pub async fn process_queue_once(
    state: &Arc<MailAppState>,
    account_id: i64,
    limit: usize,
) -> Result<(usize, usize), AppError> {
    let pool = db::get_user_db_pool(&state._db, account_id).await?;
    let rows = sqlx::query(
        r#"
        SELECT id, action_type, target_uid, target_folder, payload_json, attempt_count
        FROM offline_sync_queue
        WHERE status = 'pending'
           OR (status = 'failed' AND (next_retry_at IS NULL OR next_retry_at <= CURRENT_TIMESTAMP))
        ORDER BY created_at ASC
        LIMIT ?
        "#,
    )
    .bind(limit as i64)
    .fetch_all(&pool)
    .await?;

    let mut processed = 0usize;
    let mut failed = 0usize;

    for row in rows {
        let id = row.try_get::<i64, _>("id").unwrap_or_default();
        let action_type = row
            .try_get::<String, _>("action_type")
            .unwrap_or_else(|_| "".to_string());
        let target_uid = row
            .try_get::<Option<String>, _>("target_uid")
            .ok()
            .flatten()
            .unwrap_or_default();
        let target_folder = row
            .try_get::<Option<String>, _>("target_folder")
            .ok()
            .flatten()
            .unwrap_or_default();
        let payload_json = row
            .try_get::<Option<String>, _>("payload_json")
            .ok()
            .flatten()
            .unwrap_or_else(|| "{}".to_string());
        let attempt_count = row
            .try_get::<Option<i64>, _>("attempt_count")
            .ok()
            .flatten()
            .unwrap_or(0);

        let _ = sqlx::query(
            "UPDATE offline_sync_queue SET status = 'processing', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        )
        .bind(id)
        .execute(&pool)
        .await;

        let parsed: serde_json::Value =
            serde_json::from_str(&payload_json).unwrap_or_else(|_| json!({}));

        let result = match action_type.as_str() {
            "mark_read" => imap_session::mark_seen(&state.imap, account_id, &target_uid, true),
            "mark_unread" => imap_session::mark_seen(&state.imap, account_id, &target_uid, false),
            "flag" => imap_session::mark_flagged(&state.imap, account_id, &target_uid, true),
            "unflag" => imap_session::mark_flagged(&state.imap, account_id, &target_uid, false),
            "delete" => imap_session::delete_mail(&state.imap, account_id, &target_uid),
            "move" => {
                let destination = parsed
                    .get("destination")
                    .and_then(|v| v.as_str())
                    .unwrap_or(target_folder.as_str());
                imap_session::move_mail(&state.imap, account_id, &target_uid, destination)
            }
            "label_add" => {
                let label = parsed
                    .get("label")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default();
                imap_session::set_label(&state.imap, account_id, &target_uid, label, true)
            }
            "label_remove" => {
                let label = parsed
                    .get("label")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default();
                imap_session::set_label(&state.imap, account_id, &target_uid, label, false)
            }
            "send" => Ok(()),
            _ => Err(format!("Unsupported action type: {action_type}")),
        };

        match result {
            Ok(_) => {
                processed += 1;
                let _ = sqlx::query(
                    r#"
                    UPDATE offline_sync_queue
                    SET status = 'done', last_error = NULL, updated_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                    "#,
                )
                .bind(id)
                .execute(&pool)
                .await;
            }
            Err(err_msg) => {
                failed += 1;
                let attempts = attempt_count + 1;
                let new_status = if attempts >= 8 { "dead" } else { "failed" };
                let backoff_secs = i64::pow(2, attempts.min(6) as u32);
                let _ = sqlx::query(
                    r#"
                    UPDATE offline_sync_queue
                    SET status = ?,
                        attempt_count = ?,
                        last_error = ?,
                        next_retry_at = DATETIME('now', '+' || ? || ' seconds'),
                        updated_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                    "#,
                )
                .bind(new_status)
                .bind(attempts)
                .bind(err_msg)
                .bind(backoff_secs)
                .bind(id)
                .execute(&pool)
                .await;
            }
        }
    }

    Ok((processed, failed))
}

pub fn spawn_initial_sync(app_state: Arc<AppState>, account_id: i64) {
    tokio::spawn(async move {
        let _ = set_account_sync_status(&app_state, account_id, true).await;
        if let Err(err) = initial_sync_impl(app_state.clone(), account_id).await {
            tracing::warn!("initial sync failed for account {}: {}", account_id, err);
        }
        let _ = set_account_sync_status(&app_state, account_id, false).await;
    });
}

async fn initial_sync_impl(app_state: Arc<AppState>, account_id: i64) -> Result<(), AppError> {
    let imap_state = Arc::new(ImapState::new());
    ensure_imap_connected(&app_state, &imap_state, account_id).await?;
    sync_cached_mailboxes(&app_state, &imap_state, account_id).await?;
    touch_last_sync_time(&app_state, account_id).await?;

    tokio::task::spawn_blocking({
        let imap_state = imap_state.clone();
        move || imap_session::disconnect(&imap_state, account_id)
    })
    .await
    .ok();

    Ok(())
}

async fn load_account_imap_settings(
    app_state: &Arc<AppState>,
    account_id: i64,
) -> Result<Option<AccountImapSettings>, AppError> {
    let account_row = sqlx::query(
        "SELECT email_address, imap_host, imap_port, auth_token, ssl_mode FROM accounts WHERE account_id = ?",
    )
    .bind(account_id)
    .fetch_optional(&app_state.general_pool)
    .await?;

    let Some(account_row) = account_row else {
        return Ok(None);
    };

    Ok(Some(AccountImapSettings {
        email: account_row
            .try_get::<Option<String>, _>("email_address")
            .ok()
            .flatten()
            .unwrap_or_default(),
        imap_host: account_row
            .try_get::<Option<String>, _>("imap_host")
            .ok()
            .flatten()
            .unwrap_or_default(),
        imap_port: account_row
            .try_get::<Option<i64>, _>("imap_port")
            .ok()
            .flatten()
            .unwrap_or(143) as u16,
        password: account_row
            .try_get::<Option<String>, _>("auth_token")
            .ok()
            .flatten()
            .unwrap_or_default(),
        ssl_mode: account_row
            .try_get::<Option<String>, _>("ssl_mode")
            .ok()
            .flatten()
            .unwrap_or_else(|| "STARTTLS".to_string()),
    }))
}

async fn ensure_imap_connected(
    app_state: &Arc<AppState>,
    imap_state: &Arc<ImapState>,
    account_id: i64,
) -> Result<(), AppError> {
    if imap_session::is_connected(imap_state, account_id) {
        return Ok(());
    }

    let Some(settings) = load_account_imap_settings(app_state, account_id).await? else {
        return Ok(());
    };

    if settings.email.is_empty() || settings.imap_host.is_empty() || settings.password.is_empty() {
        return Ok(());
    }

    let imap_state = imap_state.clone();
    let result = tokio::task::spawn_blocking(move || {
        imap_session::connect_and_login(
            &imap_state,
            account_id,
            &settings.email,
            &settings.password,
            &settings.imap_host,
            settings.imap_port,
            &settings.ssl_mode,
        )
    })
    .await
    .unwrap_or_else(|e| Err(format!("Task panic: {e}")));

    result.map_err(|e| AppError::BadRequest(format!("IMAP connect failed: {e}")))?;
    Ok(())
}

async fn sync_cached_mailboxes(
    app_state: &Arc<AppState>,
    imap_state: &Arc<ImapState>,
    account_id: i64,
) -> Result<(), AppError> {
    let user_pool = db::get_user_db_pool(app_state, account_id).await?;
    let (includes, excludes, policy) = load_sync_rules_and_policy(&user_pool).await?;
    if !policy.enabled {
        return Ok(());
    }

    let mailbox_list = tokio::task::spawn_blocking({
        let imap_state = imap_state.clone();
        move || imap_session::list_mailboxes(&imap_state, account_id)
    })
    .await
    .unwrap_or_default();

    for mailbox in mailbox_list {
        if !mailbox_is_selected(&mailbox, &includes, &excludes) {
            continue;
        }

        upsert_folder_metadata(&user_pool, &mailbox).await?;
        sync_single_mailbox(&user_pool, imap_state, account_id, &mailbox, &policy).await?;
    }

    Ok(())
}

async fn load_sync_rules_and_policy(
    pool: &SqlitePool,
) -> Result<(Vec<String>, Vec<String>, SyncPolicy), AppError> {
    let rules = sqlx::query(
        "SELECT node_path, rule_type FROM download_mails WHERE is_active = 1 ORDER BY id ASC",
    )
    .fetch_all(pool)
    .await?;
    let mut includes = Vec::new();
    let mut excludes = Vec::new();
    for r in rules {
        let path = r.try_get::<String, _>("node_path").unwrap_or_default();
        let rule_type = r.try_get::<String, _>("rule_type").unwrap_or_default();
        if rule_type == "include_prefix" {
            includes.push(path);
        } else if rule_type == "exclude_exact" {
            excludes.push(path);
        }
    }

    if includes.is_empty() {
        includes.push("INBOX".to_string());
    }

    let row = sqlx::query(
        "SELECT enabled, initial_sync_mode, initial_sync_value FROM offline_config WHERE id = 1",
    )
    .fetch_optional(pool)
    .await?;

    let policy = if let Some(r) = row {
        SyncPolicy {
            enabled: r.try_get::<Option<i64>, _>("enabled").ok().flatten().unwrap_or(1) != 0,
            mode: r
                .try_get::<Option<String>, _>("initial_sync_mode")
                .ok()
                .flatten()
                .unwrap_or_else(|| "all".to_string()),
            value: r
                .try_get::<Option<i64>, _>("initial_sync_value")
                .ok()
                .flatten(),
        }
    } else {
        SyncPolicy {
            enabled: true,
            mode: "all".to_string(),
            value: None,
        }
    };

    Ok((includes, excludes, policy))
}

fn mailbox_is_selected(mailbox: &str, includes: &[String], excludes: &[String]) -> bool {
    let included = includes.iter().any(|path| {
        path == "*" || mailbox == path || mailbox.starts_with(&format!("{path}/"))
    });
    let excluded = excludes.iter().any(|path| mailbox == path);
    included && !excluded
}

async fn upsert_folder_metadata(pool: &SqlitePool, mailbox: &str) -> Result<(), AppError> {
    sqlx::query(
        r#"
        INSERT INTO folders (path_by_name, path_by_id, name, type, is_visible)
        VALUES (?, ?, ?, 'USER', 1)
        ON CONFLICT(path_by_name) DO UPDATE SET name = excluded.name
        "#,
    )
    .bind(mailbox)
    .bind(mailbox)
    .bind(mailbox)
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        INSERT INTO sync_checkpoints (folder_path, last_synced_uid, last_uid_validity, updated_at)
        VALUES (?, 0, 0, CURRENT_TIMESTAMP)
        ON CONFLICT(folder_path) DO UPDATE SET updated_at = CURRENT_TIMESTAMP
        "#,
    )
    .bind(mailbox)
    .execute(pool)
    .await?;

    Ok(())
}

async fn sync_single_mailbox(
    pool: &SqlitePool,
    imap_state: &Arc<ImapState>,
    account_id: i64,
    mailbox: &str,
    policy: &SyncPolicy,
) -> Result<(), AppError> {
    let sync_marker = Utc::now().format("%Y-%m-%d %H:%M:%S").to_string();
    let per_page = 50usize;
    let mut page = 1usize;
    let mut synced_count = 0usize;
    let cutoff = policy_cutoff(policy);
    let limit = policy
        .value
        .filter(|_| policy.mode == "by_count")
        .map(|value| value.max(0) as usize);

    loop {
        let (total, mails) = tokio::task::spawn_blocking({
            let imap_state = imap_state.clone();
            let mailbox = mailbox.to_string();
            move || imap_session::fetch_mail_list(&imap_state, account_id, &mailbox, page, per_page)
        })
        .await
        .unwrap_or_default();

        if total == 0 || mails.is_empty() {
            break;
        }

        let mut reached_policy_end = false;
        for mail in mails {
            if limit.is_some_and(|max_count| synced_count >= max_count) {
                reached_policy_end = true;
                break;
            }
            if cutoff
                .as_ref()
                .is_some_and(|threshold| mail_date_before_threshold(&mail.date, threshold))
            {
                reached_policy_end = true;
                break;
            }

            cache_mail_preview(pool, mailbox, &mail).await?;
            cache_mail_body(pool, imap_state, account_id, mailbox, &mail.id).await?;
            synced_count += 1;
        }

        if reached_policy_end || page * per_page >= total {
            break;
        }
        page += 1;
    }

    sqlx::query("DELETE FROM local_mail_cache WHERE folder = ? AND updated_at < ?")
        .bind(mailbox)
        .bind(sync_marker)
        .execute(pool)
        .await?;

    Ok(())
}

fn policy_cutoff(policy: &SyncPolicy) -> Option<DateTime<Utc>> {
    if policy.mode != "by_days" {
        return None;
    }
    let days = policy.value.unwrap_or(0);
    if days <= 0 {
        return None;
    }
    Some(Utc::now() - Duration::days(days))
}

fn mail_date_before_threshold(date_value: &str, threshold: &DateTime<Utc>) -> bool {
    DateTime::parse_from_rfc2822(date_value)
        .map(|value| value.with_timezone(&Utc) < *threshold)
        .unwrap_or(false)
}

async fn cache_mail_preview(
    pool: &SqlitePool,
    mailbox: &str,
    mail: &MailPreview,
) -> Result<(), AppError> {
    sqlx::query(
        r#"
        INSERT INTO local_mail_cache (uid, folder, sender_name, sender_address, subject, seen, date_value, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(uid, folder) DO UPDATE SET
            sender_name = excluded.sender_name,
            sender_address = excluded.sender_address,
            subject = excluded.subject,
            seen = excluded.seen,
            date_value = excluded.date_value,
            updated_at = CURRENT_TIMESTAMP
        "#,
    )
    .bind(&mail.id)
    .bind(mailbox)
    .bind(&mail.name)
    .bind(&mail.address)
    .bind(&mail.subject)
    .bind(mail.seen as i64)
    .bind(&mail.date)
    .execute(pool)
    .await?;

    Ok(())
}

async fn cache_mail_body(
    pool: &SqlitePool,
    imap_state: &Arc<ImapState>,
    account_id: i64,
    mailbox: &str,
    uid: &str,
) -> Result<(), AppError> {
    let raw = tokio::task::spawn_blocking({
        let imap_state = imap_state.clone();
        let mailbox = mailbox.to_string();
        let uid = uid.to_string();
        move || imap_session::fetch_mail_raw_in_mailbox(&imap_state, account_id, &mailbox, &uid)
    })
    .await
    .ok()
    .flatten();

    let Some(raw) = raw else {
        return Ok(());
    };
    let content = imap_session::parse_mail_content(uid.to_string(), &raw);

    sqlx::query(
        r#"
        UPDATE local_mail_cache
        SET plain_body = ?, html_body = ?, date_value = ?, raw_rfc822 = ?, updated_at = CURRENT_TIMESTAMP
        WHERE uid = ? AND folder = ?
        "#,
    )
    .bind(&content.plain_body)
    .bind(&content.html_body)
    .bind(&content.date)
    .bind(raw)
    .bind(uid)
    .bind(mailbox)
    .execute(pool)
    .await?;

    Ok(())
}

async fn set_account_sync_status(
    app_state: &Arc<AppState>,
    account_id: i64,
    syncing: bool,
) -> Result<(), AppError> {
    sqlx::query("UPDATE accounts SET sync_status = ? WHERE account_id = ?")
        .bind(syncing as i64)
        .bind(account_id)
        .execute(&app_state.general_pool)
        .await?;
    Ok(())
}

async fn touch_last_sync_time(app_state: &Arc<AppState>, account_id: i64) -> Result<(), AppError> {
    sqlx::query("UPDATE accounts SET last_sync_time = CURRENT_TIMESTAMP WHERE account_id = ?")
        .bind(account_id)
        .execute(&app_state.general_pool)
        .await?;
    Ok(())
}

fn percent_encode_filename(input: &str) -> String {
    input
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'.' | b'_' | b'-' => {
                (byte as char).to_string()
            }
            _ => format!("%{byte:02X}"),
        })
        .collect()
}
