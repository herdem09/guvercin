use axum::{
    body::Body,
    extract::{Json, Path, Query, State},
    http::{
        header::{CONTENT_DISPOSITION, CONTENT_LENGTH, CONTENT_TYPE},
        StatusCode,
    },
    response::{IntoResponse, Response},
};
use chrono::DateTime;
use mailparse::MailHeaderMap;
use serde::Deserialize;
use serde_json::json;
use sqlx::Row;
use std::sync::Arc;

use crate::{
    imap_session::{self, ImapState},
    mail_models::{
        AdvancedSearchRequest, AdvancedSearchResponse, ConnectImapBody, MailListResponse,
        MailboxListResponse, merge_mailbox_label_into_preview,
    },
};

pub struct MailAppState {
    pub _db: Arc<crate::db::AppState>,
    pub imap: Arc<ImapState>,
}

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
        let inner = match state._db.ensure_ready(false).await {
            Ok(inner) => inner,
            Err(e) => return e.into_response(),
        };
        let _ =
            sqlx::query("UPDATE accounts SET auth_token = ?, ssl_mode = ? WHERE account_id = ?")
                .bind(&body.password)
                .bind(&body.ssl_mode)
                .bind(body.account_id)
                .execute(&inner.general_pool)
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
    .fetch_one(
        &match state._db.ensure_ready(false).await {
            Ok(inner) => inner.general_pool.clone(),
            Err(e) => return e.into_response(),
        },
    )
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

    Json(MailboxListResponse::from_mailboxes(mailboxes))
}

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

#[derive(Deserialize)]
pub struct MailboxCreateBody {
    pub name: String,
}

pub async fn get_mail_list(
    State(state): State<Arc<MailAppState>>,
    Path(account_id): Path<i64>,
    Query(q): Query<MailListQuery>,
) -> impl IntoResponse {
    let (total, mut mails) = tokio::task::spawn_blocking({
        let imap_state = state.imap.clone();
        let mailbox = q.mailbox.clone();
        move || imap_session::fetch_mail_list(&imap_state, account_id, &mailbox, q.page, q.per_page)
    })
    .await
    .unwrap_or_default();

    mails
        .iter_mut()
        .for_each(|mail| merge_mailbox_label_into_preview(mail, &q.mailbox));

    if let Ok(pool) = crate::db::get_user_db_pool(&state._db, account_id).await {
        for mail in &mails {
            let date_ms: i64 = DateTime::parse_from_rfc2822(&mail.date)
                .map(|dt| dt.timestamp_millis())
                .unwrap_or(0);
            let labels_json = serde_json::to_string(&mail.labels).unwrap_or_else(|_| "[]".to_string());
            let _ = sqlx::query(
                r#"
                INSERT INTO local_mail_cache (
                    uid, folder, sender_name, sender_address, recipient_to, subject, date_value, date_ms,
                    seen, flagged, size_bytes, importance_value, content_type, category, labels_json, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(uid, folder) DO UPDATE SET
                    sender_name = excluded.sender_name,
                    sender_address = excluded.sender_address,
                    recipient_to = excluded.recipient_to,
                    subject = excluded.subject,
                    date_value = excluded.date_value,
                    date_ms = excluded.date_ms,
                    seen = excluded.seen,
                    flagged = excluded.flagged,
                    size_bytes = excluded.size_bytes,
                    importance_value = excluded.importance_value,
                    content_type = excluded.content_type,
                    category = excluded.category,
                    labels_json = excluded.labels_json,
                    updated_at = CURRENT_TIMESTAMP
                "#,
            )
            .bind(&mail.id)
            .bind(&q.mailbox)
            .bind(&mail.name)
            .bind(&mail.address)
            .bind(&mail.recipient_to)
            .bind(&mail.subject)
            .bind(&mail.date)
            .bind(date_ms)
            .bind(mail.seen as i64)
            .bind(mail.flagged as i64)
            .bind(mail.size as i64)
            .bind(mail.importance as i64)
            .bind(&mail.content_type)
            .bind(&mail.category)
            .bind(&labels_json)
            .execute(&pool)
            .await;
        }
    }

    Json(MailListResponse {
        total_count: total,
        mails,
    })
}

pub async fn search_advanced(
    State(state): State<Arc<MailAppState>>,
    Path(account_id): Path<i64>,
    Json(body): Json<AdvancedSearchRequest>,
) -> impl IntoResponse {
    if matches!(body.scope, crate::mail_models::SearchScope::Mailboxes) && body.mailboxes.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "mailboxes must be provided when scope=mailboxes" })),
        )
            .into_response();
    }

    let result = tokio::task::spawn_blocking({
        let imap_state = state.imap.clone();
        let req = body.clone();
        move || imap_session::advanced_search(&imap_state, account_id, &req)
    })
    .await
    .unwrap_or_else(|e| Err(format!("Task panic: {e}")));

    match result {
        Ok(mails) => Json(AdvancedSearchResponse {
            total_count: mails.len(),
            mails,
        })
        .into_response(),
        Err(error) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": error })),
        )
            .into_response(),
    }
}

pub async fn create_mailbox(
    State(state): State<Arc<MailAppState>>,
    Path(account_id): Path<i64>,
    Json(body): Json<MailboxCreateBody>,
) -> impl IntoResponse {
    let mailbox = body.name.trim().to_string();
    if mailbox.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "Mailbox name is required" })),
        )
            .into_response();
    }

    let result = tokio::task::spawn_blocking({
        let imap_state = state.imap.clone();
        move || imap_session::create_mailbox(&imap_state, account_id, &mailbox)
    })
    .await
    .unwrap_or_else(|e| Err(format!("Task panic: {e}")));

    match result {
        Ok(()) => (StatusCode::OK, Json(json!({ "status": "created" }))).into_response(),
        Err(error) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": error })),
        )
            .into_response(),
    }
}

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
        let is_drafts_mailbox = {
            let lower = q.mailbox.trim().to_ascii_lowercase();
            lower == "drafts" || lower.ends_with("/drafts") || lower.ends_with(".drafts") || lower.contains("drafts")
        };
        let content = if is_drafts_mailbox {
            imap_session::parse_mail_content_with_attachment_data(uid_for_response, &raw_bytes)
        } else {
            imap_session::parse_mail_content(uid_for_response, &raw_bytes)
        };
        if let Ok(pool) = crate::db::get_user_db_pool(&state._db, account_id).await {
            let date_ms: i64 = DateTime::parse_from_rfc2822(&content.date)
                .map(|dt| dt.timestamp_millis())
                .unwrap_or(0);
            let _ = sqlx::query(
                r#"
                UPDATE local_mail_cache
                SET plain_body = ?, html_body = ?, date_value = ?, date_ms = ?, cc_value = ?, bcc_value = ?, raw_rfc822 = ?, updated_at = CURRENT_TIMESTAMP
                WHERE uid = ? AND folder = ?
                "#,
            )
            .bind(&content.plain_body)
            .bind(&content.html_body)
            .bind(&content.date)
            .bind(date_ms)
            .bind(&content.cc)
            .bind(&content.bcc)
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

pub async fn get_mail_raw(
    State(state): State<Arc<MailAppState>>,
    Path((account_id, uid)): Path<(i64, String)>,
    Query(q): Query<MailContentQuery>,
) -> impl IntoResponse {
    let file_name = if uid.trim().is_empty() {
        "message.msg".to_string()
    } else {
        format!("{uid}.msg")
    };

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
        let escaped = file_name.replace('"', "\\\"");
        let encoded = percent_encode_filename(&file_name);
        let disposition =
            format!("attachment; filename=\"{escaped}\"; filename*=UTF-8''{encoded}");
        return Response::builder()
            .status(StatusCode::OK)
            .header(CONTENT_TYPE, "application/vnd.ms-outlook")
            .header(CONTENT_LENGTH, raw_bytes.len().to_string())
            .header(CONTENT_DISPOSITION, disposition)
            .body(Body::from(raw_bytes))
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
        Json(json!({"error": "Mail not found"})),
    )
        .into_response()
}

fn parse_reply_seed_from_raw(raw: &[u8]) -> serde_json::Value {
    let mut message_id = String::new();
    let mut references = String::new();
    let mut in_reply_to = String::new();
    let mut reply_to = String::new();

    if let Ok(parsed) = mailparse::parse_mail(raw) {
        let headers = parsed.get_headers();
        message_id = headers
            .get_first_value("Message-ID")
            .unwrap_or_default()
            .trim()
            .to_string();
        references = headers
            .get_first_value("References")
            .unwrap_or_default()
            .trim()
            .to_string();
        in_reply_to = headers
            .get_first_value("In-Reply-To")
            .unwrap_or_default()
            .trim()
            .to_string();
        reply_to = headers
            .get_first_value("Reply-To")
            .unwrap_or_default()
            .trim()
            .to_string();
    }

    json!({
        "message_id": message_id,
        "references": references,
        "in_reply_to": in_reply_to,
        "reply_to": reply_to,
    })
}

pub async fn get_reply_seed(
    State(state): State<Arc<MailAppState>>,
    Path((account_id, uid)): Path<(i64, String)>,
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
        Json(parse_reply_seed_from_raw(&raw_bytes)).into_response()
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_reply_seed_from_raw_includes_reply_to() {
        let raw = concat!(
            "From: sender@example.com\r\n",
            "To: me@example.com\r\n",
            "Reply-To: reply@example.com\r\n",
            "Message-ID: <m1>\r\n",
            "\r\n",
            "Hello\r\n",
        );
        let seed = parse_reply_seed_from_raw(raw.as_bytes());
        assert_eq!(
            seed.get("reply_to").and_then(|v| v.as_str()).unwrap_or(""),
            "reply@example.com"
        );
        assert_eq!(
            seed.get("message_id").and_then(|v| v.as_str()).unwrap_or(""),
            "<m1>"
        );
    }
}

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
