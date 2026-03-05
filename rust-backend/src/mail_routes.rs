use axum::{
    body::Body,
    extract::{Json, Path, Query, State},
    http::{
        header::{CONTENT_DISPOSITION, CONTENT_LENGTH, CONTENT_TYPE},
        StatusCode,
    },
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use serde_json::json;
use sqlx::Row;
use std::sync::Arc;

use crate::{
    imap_session::{self, ImapState},
    mail_models::{ConnectImapBody, MailListResponse, MailboxListResponse},
};

// Shared state includes both DB state and IMAP sessions
pub struct MailAppState {
    pub _db: Arc<crate::db::AppState>,
    pub imap: Arc<ImapState>,
}

// ─────────────────────────────────────────────────────────────────
// POST /mail/connect
// Connect & authenticate an IMAP account, keep session alive.
// ─────────────────────────────────────────────────────────────────
pub async fn connect_imap(
    State(state): State<Arc<MailAppState>>,
    Json(body): Json<ConnectImapBody>,
) -> impl IntoResponse {
    let result = tokio::task::spawn_blocking({
        let imap_state = state.imap.clone();
        let email = body.email.clone();
        let password = body.password.clone();
        let host = body.imap_host.clone();
        let port = body.imap_port;
        let ssl = body.ssl_mode.clone();
        let id = body.account_id;
        move || {
            imap_session::connect_and_login(&imap_state, id, &email, &password, &host, port, &ssl)
        }
    })
    .await
    .unwrap_or_else(|e| Err(format!("Task panic: {e}")));

    if result.is_ok() {
        let _ =
            sqlx::query("UPDATE accounts SET auth_token = ?, ssl_mode = ? WHERE account_id = ?")
                .bind(&body.password)
                .bind(&body.ssl_mode)
                .bind(body.account_id)
                .execute(&state._db.general_pool)
                .await;
    }

    match result {
        Ok(()) => (StatusCode::OK, Json(json!({"status": "connected"}))).into_response(),
        Err(e) => (StatusCode::BAD_GATEWAY, Json(json!({"error": e}))).into_response(),
    }
}

pub async fn connect_imap_stored(
    State(state): State<Arc<MailAppState>>,
    Path(account_id): Path<i64>,
) -> impl IntoResponse {
    let account = match sqlx::query(
        "SELECT email_address, imap_host, imap_port, auth_token, ssl_mode FROM accounts WHERE account_id = ?",
    )
    .bind(account_id)
    .fetch_one(&state._db.general_pool)
    .await {
        Ok(a) => a,
        Err(_) => return (StatusCode::NOT_FOUND, Json(json!({"error": "Account not found"}))).into_response(),
    };

    let email: String = account
        .try_get::<Option<String>, _>("email_address")
        .unwrap_or_default()
        .unwrap_or_default();
    let host: String = account
        .try_get::<Option<String>, _>("imap_host")
        .unwrap_or_default()
        .unwrap_or_default();
    let port: i64 = account
        .try_get::<Option<i64>, _>("imap_port")
        .unwrap_or_default()
        .unwrap_or(143);
    let password: String = account
        .try_get::<Option<String>, _>("auth_token")
        .unwrap_or_default()
        .unwrap_or_default();
    let ssl: String = account
        .try_get::<Option<String>, _>("ssl_mode")
        .unwrap_or_default()
        .unwrap_or_else(|| "STARTTLS".to_string());

    if password.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "No password stored"})),
        )
            .into_response();
    }

    let result = tokio::task::spawn_blocking({
        let imap_state = state.imap.clone();
        move || {
            imap_session::connect_and_login(
                &imap_state,
                account_id,
                &email,
                &password,
                &host,
                port as u16,
                &ssl,
            )
        }
    })
    .await
    .unwrap_or_else(|e| Err(format!("Task panic: {e}")));

    match result {
        Ok(()) => (StatusCode::OK, Json(json!({"status": "connected"}))).into_response(),
        Err(e) => (StatusCode::BAD_GATEWAY, Json(json!({"error": e}))).into_response(),
    }
}

// ─────────────────────────────────────────────────────────────────
// GET /mail/:account_id/mailboxes
// ─────────────────────────────────────────────────────────────────
pub async fn get_mailboxes(
    State(state): State<Arc<MailAppState>>,
    Path(account_id): Path<i64>,
) -> impl IntoResponse {
    let mailboxes = tokio::task::spawn_blocking({
        let imap_state = state.imap.clone();
        move || imap_session::list_mailboxes(&imap_state, account_id)
    })
    .await
    .unwrap_or_default();

    Json(MailboxListResponse { mailboxes })
}

// ─────────────────────────────────────────────────────────────────
// GET /mail/:account_id/list?mailbox=INBOX&page=1&per_page=50
// ─────────────────────────────────────────────────────────────────
#[derive(Deserialize)]
pub struct MailListQuery {
    #[serde(default = "default_inbox")]
    pub mailbox: String,
    #[serde(default = "default_page")]
    pub page: usize,
    #[serde(default = "default_per_page")]
    pub per_page: usize,
}
fn default_inbox() -> String {
    "INBOX".into()
}
fn default_page() -> usize {
    1
}
fn default_per_page() -> usize {
    50
}

#[derive(Deserialize)]
pub struct MailContentQuery {
    #[serde(default = "default_inbox")]
    pub mailbox: String,
}

pub async fn get_mail_list(
    State(state): State<Arc<MailAppState>>,
    Path(account_id): Path<i64>,
    Query(q): Query<MailListQuery>,
) -> impl IntoResponse {
    let (total, mails) = tokio::task::spawn_blocking({
        let imap_state = state.imap.clone();
        let mailbox = q.mailbox.clone();
        move || imap_session::fetch_mail_list(&imap_state, account_id, &mailbox, q.page, q.per_page)
    })
    .await
    .unwrap_or_default();

    if let Ok(pool) = crate::db::get_user_db_pool(&state._db, account_id).await {
        for mail in &mails {
            let _ = sqlx::query(
                r#"
                INSERT INTO local_mail_cache (uid, folder, sender_name, sender_address, subject, date_value, seen, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(uid, folder) DO UPDATE SET
                    sender_name = excluded.sender_name,
                    sender_address = excluded.sender_address,
                    subject = excluded.subject,
                    date_value = excluded.date_value,
                    seen = excluded.seen,
                    updated_at = CURRENT_TIMESTAMP
                "#,
            )
            .bind(&mail.id)
            .bind(&q.mailbox)
            .bind(&mail.name)
            .bind(&mail.address)
            .bind(&mail.subject)
            .bind(&mail.date)
            .bind(mail.seen as i64)
            .execute(&pool)
            .await;
        }
    }

    Json(MailListResponse {
        total_count: total,
        mails,
    })
}

// ─────────────────────────────────────────────────────────────────
// GET /mail/:account_id/content/:uid
// ─────────────────────────────────────────────────────────────────
pub async fn get_mail_content(
    State(state): State<Arc<MailAppState>>,
    Path((account_id, uid)): Path<(i64, String)>,
    Query(q): Query<MailContentQuery>,
) -> impl IntoResponse {
    let uid_for_response = uid.clone();
    let raw = tokio::task::spawn_blocking({
        let imap_state = state.imap.clone();
        let uid = uid.clone();
        let mailbox = q.mailbox.clone();
        move || imap_session::fetch_mail_raw_in_mailbox(&imap_state, account_id, &mailbox, &uid)
    })
    .await
    .ok()
    .flatten();

    if let Some(raw_bytes) = raw {
        let content = imap_session::parse_mail_content(uid_for_response, &raw_bytes);
        if let Ok(pool) = crate::db::get_user_db_pool(&state._db, account_id).await {
            let _ = sqlx::query(
                r#"
                UPDATE local_mail_cache
                SET plain_body = ?, html_body = ?, date_value = ?, raw_rfc822 = ?, updated_at = CURRENT_TIMESTAMP
                WHERE uid = ? AND folder = ?
                "#,
            )
            .bind(&content.plain_body)
            .bind(&content.html_body)
            .bind(&content.date)
            .bind(raw_bytes)
            .bind(&content.id)
            .bind(&q.mailbox)
            .execute(&pool)
            .await;
        }
        Json(content).into_response()
    } else {
        (
            StatusCode::NOT_FOUND,
            Json(json!({"error": "Mail not found"})),
        )
            .into_response()
    }
}

pub async fn download_attachment(
    State(state): State<Arc<MailAppState>>,
    Path((account_id, uid, attachment_index)): Path<(i64, String, usize)>,
    Query(q): Query<MailContentQuery>,
) -> impl IntoResponse {
    let raw = tokio::task::spawn_blocking({
        let imap_state = state.imap.clone();
        let uid = uid.clone();
        let mailbox = q.mailbox.clone();
        move || imap_session::fetch_mail_raw_in_mailbox(&imap_state, account_id, &mailbox, &uid)
    })
    .await
    .ok()
    .flatten();

    if let Some(raw_bytes) = raw {
        if let Some((info, data)) =
            imap_session::find_attachment_bytes(&raw_bytes, attachment_index)
        {
            let escaped = info.filename.replace('"', "\\\"");
            let encoded = percent_encode_filename(&info.filename);
            let disposition =
                format!("attachment; filename=\"{escaped}\"; filename*=UTF-8''{encoded}");
            let response = Response::builder()
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
                });
            return response;
        }
        return (
            StatusCode::NOT_FOUND,
            Json(json!({"error": "Attachment not found"})),
        )
            .into_response();
    }

    (
        StatusCode::NOT_FOUND,
        Json(json!({"error": "Mail not found"})),
    )
        .into_response()
}

// ─────────────────────────────────────────────────────────────────
// DELETE /mail/:account_id/disconnect
// ─────────────────────────────────────────────────────────────────
pub async fn disconnect_imap(
    State(state): State<Arc<MailAppState>>,
    Path(account_id): Path<i64>,
) -> impl IntoResponse {
    tokio::task::spawn_blocking({
        let imap_state = state.imap.clone();
        move || imap_session::disconnect(&imap_state, account_id)
    })
    .await
    .ok();

    (StatusCode::OK, Json(json!({"status": "disconnected"}))).into_response()
}

fn percent_encode_filename(input: &str) -> String {
    input
        .as_bytes()
        .iter()
        .map(|&b| match b {
            0x21..=0x7e if b != b'%' && b != b'"' && b != b'\\' => (b as char).to_string(),
            _ => format!("%{:02X}", b),
        })
        .collect()
}
