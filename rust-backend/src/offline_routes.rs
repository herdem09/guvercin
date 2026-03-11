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
use chrono::{DateTime, Duration, NaiveDate, Utc};
use serde::Deserialize;
use serde_json::{self, json};
use sqlx::{QueryBuilder, Row, Sqlite, SqlitePool};

use crate::{
    db::{self, AppState},
    error::AppError,
    imap_session::{self, ImapState},
    mail_models::{
        AdvancedSearchRequest, AdvancedSearchResponse, MailContent, MailListResponse, MailPreview,
        MailSearchPreview, MailboxListResponse, ReadStatus, SearchScope,
        merge_mailbox_label_into_preview,
    },
    mail_routes::MailAppState,
    models::{
        DownloadRuleInput, DownloadRuleRecord, InitialSyncPolicyInput, OfflineActionRequest,
        OfflineActionResponse, OfflineConfigResponse, OfflineSetupPayload, OfflineStatusResponse,
        SyncNowResponse, TransferProgress, TransferSnapshot,
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
    cache_raw_rfc822: bool,
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

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn is_removed_flag_action(action_type: &str) -> bool {
    matches!(action_type, "flag" | "unflag")
}

fn validate_offline_action_type(action_type: &str) -> Result<(), AppError> {
    if is_removed_flag_action(action_type) {
        return Err(AppError::BadRequest(
            "Flag actions are no longer supported".to_string(),
        ));
    }
    Ok(())
}

fn normalize_label_values(labels: Vec<String>) -> Vec<String> {
    let mut normalized = Vec::new();

    for label in labels {
        let trimmed = label.trim();
        if trimmed.is_empty() {
            continue;
        }
        if normalized
            .iter()
            .any(|existing: &String| existing.eq_ignore_ascii_case(trimmed))
        {
            continue;
        }
        normalized.push(trimmed.to_string());
    }

    normalized
}

fn parse_labels_json_value(raw: &str) -> Vec<String> {
    let parsed = serde_json::from_str::<Vec<String>>(raw).unwrap_or_default();
    normalize_label_values(parsed)
}

fn serialize_labels_json_value(labels: &[String]) -> String {
    serde_json::to_string(labels).unwrap_or_else(|_| "[]".to_string())
}

fn normalize_mailbox_list(values: &[String]) -> Vec<String> {
    let mut normalized = Vec::new();
    for value in values {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            continue;
        }
        if normalized
            .iter()
            .any(|existing: &String| existing.eq_ignore_ascii_case(trimmed))
        {
            continue;
        }
        normalized.push(trimmed.to_string());
    }
    normalized
}

fn parse_ymd(value: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(value.trim(), "%Y-%m-%d").ok()
}

fn apply_advanced_search_filters(
    qb: &mut QueryBuilder<Sqlite>,
    req: &AdvancedSearchRequest,
    normalized_mailboxes: &[String],
) {
    if matches!(req.scope, SearchScope::Mailboxes) {
        qb.push(" AND folder IN (");
        let mut separated = qb.separated(", ");
        for mailbox in normalized_mailboxes {
            separated.push_bind(mailbox.clone());
        }
        qb.push(")");
    }

    if let Some(value) = req.from.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
        let pattern = format!("%{}%", value);
        qb.push(" AND (LOWER(COALESCE(sender_address, '')) LIKE LOWER(")
            .push_bind(pattern.clone())
            .push(") OR LOWER(COALESCE(sender_name, '')) LIKE LOWER(")
            .push_bind(pattern)
            .push("))");
    }

    if let Some(value) = req.to.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
        let pattern = format!("%{}%", value);
        qb.push(" AND LOWER(COALESCE(recipient_to, '')) LIKE LOWER(")
            .push_bind(pattern)
            .push(")");
    }

    if let Some(value) = req.cc.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
        let pattern = format!("%{}%", value);
        qb.push(" AND LOWER(COALESCE(cc_value, '')) LIKE LOWER(")
            .push_bind(pattern)
            .push(")");
    }

    if let Some(value) = req.subject.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
        let pattern = format!("%{}%", value);
        qb.push(" AND LOWER(COALESCE(subject, '')) LIKE LOWER(")
            .push_bind(pattern)
            .push(")");
    }

    if let Some(value) = req.keywords.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
        let pattern = format!("%{}%", value);
        qb.push(" AND (LOWER(COALESCE(plain_body, '')) LIKE LOWER(")
            .push_bind(pattern.clone())
            .push(") OR LOWER(COALESCE(html_body, '')) LIKE LOWER(")
            .push_bind(pattern)
            .push("))");
    }

    if let Some(date) = req
        .date_start
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .and_then(parse_ymd)
        .and_then(|d| d.and_hms_opt(0, 0, 0))
        .map(|dt| DateTime::<Utc>::from_naive_utc_and_offset(dt, Utc).timestamp_millis())
    {
        qb.push(" AND date_ms >= ").push_bind(date);
    }

    if let Some(date) = req
        .date_end
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .and_then(parse_ymd)
        .and_then(|d| d.checked_add_signed(Duration::days(1)))
        .and_then(|d| d.and_hms_opt(0, 0, 0))
        .map(|dt| DateTime::<Utc>::from_naive_utc_and_offset(dt, Utc).timestamp_millis())
    {
        qb.push(" AND date_ms < ").push_bind(date);
    }

    match req.read_status.unwrap_or(ReadStatus::All) {
        ReadStatus::Read => {
            qb.push(" AND COALESCE(seen, 0) != 0");
        }
        ReadStatus::Unread => {
            qb.push(" AND COALESCE(seen, 0) = 0");
        }
        ReadStatus::All => {}
    }

    if req.has_attachments {
        qb.push(
            " AND (LOWER(COALESCE(content_type, '')) LIKE 'multipart/mixed%'\
             OR LOWER(COALESCE(content_type, '')) LIKE 'multipart/related%'\
             OR LOWER(COALESCE(content_type, '')) LIKE 'multipart/report%')",
        );
    }
}

fn strip_label_mailbox_prefix(mailbox: &str) -> Option<String> {
    let trimmed = mailbox.trim();
    let lower = trimmed.to_ascii_lowercase();

    if lower.starts_with("labels/") {
        return Some(trimmed[7..].trim_matches('/').to_string());
    }
    if lower.starts_with("labels/") {
        return Some(trimmed[10..].trim_matches('/').to_string());
    }
    if lower.starts_with("[labels]/") {
        return Some(trimmed[9..].trim_matches('/').to_string());
    }

    None
}

fn mailbox_matches_label(mailbox: &str, label: &str) -> bool {
    let normalized_label = label.trim();
    if normalized_label.is_empty() {
        return false;
    }

    strip_label_mailbox_prefix(mailbox)
        .map(|candidate| candidate.eq_ignore_ascii_case(normalized_label))
        .unwrap_or(false)
}

struct LocalLabelMutation {
    labels_json: String,
    next_category: Option<String>,
    delete_row: bool,
}

fn compute_local_label_mutation(
    existing_labels_json: &str,
    category: Option<&str>,
    label: &str,
    add: bool,
    folder: &str,
) -> LocalLabelMutation {
    let trimmed_label = label.trim();
    let mut labels = parse_labels_json_value(existing_labels_json);

    if add {
        if !labels
            .iter()
            .any(|existing| existing.eq_ignore_ascii_case(trimmed_label))
        {
            labels.push(trimmed_label.to_string());
        }
    } else {
        labels.retain(|existing| !existing.eq_ignore_ascii_case(trimmed_label));
    }

    let category_value = category.map(str::trim).filter(|value| !value.is_empty());
    let next_category = if add {
        category_value
            .map(str::to_string)
            .or_else(|| labels.first().cloned())
    } else if category_value.map(|value| value.eq_ignore_ascii_case(trimmed_label)).unwrap_or(false) {
        labels.first().cloned()
    } else {
        category_value.map(str::to_string)
    };

    LocalLabelMutation {
        labels_json: serialize_labels_json_value(&labels),
        delete_row: !add && mailbox_matches_label(folder, trimmed_label),
        next_category,
    }
}

async fn set_transfer_receiving(
    app_state: &Arc<AppState>,
    account_id: i64,
    progress: Option<TransferProgress>,
) {
    let mut map = app_state.transfer_progress.lock().await;
    let entry = map.entry(account_id).or_insert(TransferSnapshot {
        receiving: None,
        sending: None,
    });
    entry.receiving = progress;
}

async fn set_transfer_sending(
    app_state: &Arc<AppState>,
    account_id: i64,
    progress: Option<TransferProgress>,
) {
    let mut map = app_state.transfer_progress.lock().await;
    let entry = map.entry(account_id).or_insert(TransferSnapshot {
        receiving: None,
        sending: None,
    });
    entry.sending = progress;
}

async fn get_transfer_snapshot(app_state: &Arc<AppState>, account_id: i64) -> Option<TransferSnapshot> {
    let map = app_state.transfer_progress.lock().await;
    map.get(&account_id).cloned()
}

pub async fn get_local_mailboxes(
    State(state): State<Arc<MailAppState>>,
    Path(account_id): Path<i64>,
) -> Result<Json<MailboxListResponse>, AppError> {
    let pool = db::get_user_db_pool(&state._db, account_id).await?;

    let mut mailboxes = sqlx::query_scalar::<_, String>(
        r#"
        SELECT path_by_name
        FROM folders
        WHERE is_visible = 1
        ORDER BY CASE WHEN UPPER(path_by_name) = 'INBOX' THEN 0 ELSE 1 END, path_by_name ASC
        "#,
    )
    .fetch_all(&pool)
    .await?;

    if mailboxes.is_empty() {
        mailboxes = sqlx::query_scalar::<_, String>(
            r#"
            SELECT DISTINCT folder
            FROM local_mail_cache
            ORDER BY CASE WHEN UPPER(folder) = 'INBOX' THEN 0 ELSE 1 END, folder ASC
            "#,
        )
        .fetch_all(&pool)
        .await?;
    }

    Ok(Json(MailboxListResponse::from_mailboxes(mailboxes)))
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
        SELECT uid, sender_name, sender_address, recipient_to, subject, date_value, seen, flagged, size_bytes, importance_value, content_type, category, labels_json
        FROM local_mail_cache
        WHERE folder = ?
        ORDER BY date_ms DESC, uid DESC
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
        .map(|r| {
            let mut preview = MailPreview {
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
                recipient_to: r
                    .try_get::<Option<String>, _>("recipient_to")
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
                flagged: r
                    .try_get::<Option<i64>, _>("flagged")
                    .ok()
                    .flatten()
                    .unwrap_or(0)
                    != 0,
                size: r
                    .try_get::<Option<i64>, _>("size_bytes")
                    .ok()
                    .flatten()
                    .unwrap_or(0)
                    .max(0) as usize,
                importance: r
                    .try_get::<Option<i64>, _>("importance_value")
                    .ok()
                    .flatten()
                    .unwrap_or(0) as i32,
                content_type: r
                    .try_get::<Option<String>, _>("content_type")
                    .ok()
                    .flatten()
                    .unwrap_or_default(),
                category: r
                    .try_get::<Option<String>, _>("category")
                    .ok()
                    .flatten()
                    .unwrap_or_default(),
                labels: r
                    .try_get::<Option<String>, _>("labels_json")
                    .ok()
                    .flatten()
                    .map(|value| parse_labels_json_value(&value))
                    .unwrap_or_default(),
            };

            merge_mailbox_label_into_preview(&mut preview, &q.mailbox);
            preview
        })
        .collect();

    Ok(Json(MailListResponse {
        total_count: total.max(0) as usize,
        mails,
    }))
}

pub async fn search_advanced(
    State(state): State<Arc<MailAppState>>,
    Path(account_id): Path<i64>,
    Json(body): Json<AdvancedSearchRequest>,
) -> Result<Json<AdvancedSearchResponse>, AppError> {
    let pool = db::get_user_db_pool(&state._db, account_id).await?;
    let normalized_mailboxes = normalize_mailbox_list(&body.mailboxes);

    if matches!(body.scope, SearchScope::Mailboxes) && normalized_mailboxes.is_empty() {
        return Err(AppError::BadRequest(
            "mailboxes must be provided when scope=mailboxes".to_string(),
        ));
    }

    let mut count_qb = QueryBuilder::<Sqlite>::new(
        "SELECT COUNT(1) FROM local_mail_cache WHERE 1=1",
    );
    apply_advanced_search_filters(&mut count_qb, &body, &normalized_mailboxes);
    let (total,): (i64,) = count_qb.build_query_as::<(i64,)>().fetch_one(&pool).await?;

    let mut qb = QueryBuilder::<Sqlite>::new(
        r#"
        SELECT uid, sender_name, sender_address, recipient_to, subject, date_value, seen, flagged,
               size_bytes, importance_value, content_type, category, labels_json, folder
        FROM local_mail_cache
        WHERE 1=1
        "#,
    );
    apply_advanced_search_filters(&mut qb, &body, &normalized_mailboxes);
    qb.push(" ORDER BY date_ms DESC, uid DESC");

    let rows = qb.build().fetch_all(&pool).await?;
    let mails = rows
        .into_iter()
        .map(|r| {
            let mailbox = r
                .try_get::<Option<String>, _>("folder")
                .ok()
                .flatten()
                .unwrap_or_default();
            let mut preview = MailPreview {
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
                recipient_to: r
                    .try_get::<Option<String>, _>("recipient_to")
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
                flagged: r
                    .try_get::<Option<i64>, _>("flagged")
                    .ok()
                    .flatten()
                    .unwrap_or(0)
                    != 0,
                size: r
                    .try_get::<Option<i64>, _>("size_bytes")
                    .ok()
                    .flatten()
                    .unwrap_or(0)
                    .max(0) as usize,
                importance: r
                    .try_get::<Option<i64>, _>("importance_value")
                    .ok()
                    .flatten()
                    .unwrap_or(0) as i32,
                content_type: r
                    .try_get::<Option<String>, _>("content_type")
                    .ok()
                    .flatten()
                    .unwrap_or_default(),
                category: r
                    .try_get::<Option<String>, _>("category")
                    .ok()
                    .flatten()
                    .unwrap_or_default(),
                labels: r
                    .try_get::<Option<String>, _>("labels_json")
                    .ok()
                    .flatten()
                    .map(|value| parse_labels_json_value(&value))
                    .unwrap_or_default(),
            };

            merge_mailbox_label_into_preview(&mut preview, &mailbox);

            MailSearchPreview {
                mailbox,
                mail: preview,
            }
        })
        .collect();

    Ok(Json(AdvancedSearchResponse {
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
        SELECT uid, subject, sender_name, sender_address, date_value, cc_value, bcc_value, plain_body, html_body, raw_rfc822
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

            let html_body = r
                .try_get::<Option<String>, _>("html_body")
                .ok()
                .flatten()
                .unwrap_or_default();
            let plain_body = r
                .try_get::<Option<String>, _>("plain_body")
                .ok()
                .flatten()
                .unwrap_or_default();

            if html_body.trim().is_empty() && plain_body.trim().is_empty() {
                return (
                    StatusCode::NOT_FOUND,
                    Json(json!({"error":"Mail body not cached offline"})),
                )
                    .into_response();
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
                cc: r
                    .try_get::<Option<String>, _>("cc_value")
                    .ok()
                    .flatten()
                    .unwrap_or_default(),
                bcc: r
                    .try_get::<Option<String>, _>("bcc_value")
                    .ok()
                    .flatten()
                    .unwrap_or_default(),
                date: r
                    .try_get::<Option<String>, _>("date_value")
                    .ok()
                    .flatten()
                    .unwrap_or_default(),
                html_body,
                plain_body,
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

#[derive(serde::Serialize)]
struct InlinePrefetchResponse {
    html_body: String,
    cached_count: usize,
}

pub async fn prefetch_local_inline_assets(
    State(state): State<Arc<MailAppState>>,
    Path((account_id, uid)): Path<(i64, String)>,
    Query(q): Query<LocalMailListQuery>,
) -> impl IntoResponse {
    let pool = match db::get_user_db_pool(&state._db, account_id).await {
        Ok(p) => p,
        Err(e) => return e.into_response(),
    };

    let row = sqlx::query("SELECT html_body FROM local_mail_cache WHERE uid = ? AND folder = ?")
        .bind(&uid)
        .bind(&q.mailbox)
        .fetch_optional(&pool)
        .await;

    let Ok(Some(row)) = row else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({"error":"Mail not found in offline cache"})),
        )
            .into_response();
    };

    let html = row
        .try_get::<Option<String>, _>("html_body")
        .ok()
        .flatten()
        .unwrap_or_default();
    if html.is_empty() {
        return Json(InlinePrefetchResponse {
            html_body: html,
            cached_count: 0,
        })
        .into_response();
    }

    let url_to_asset = cache_inline_assets_for_html(&pool, account_id, &html).await;
    let rewritten = rewrite_html_inline_image_srcs(&html, account_id, &url_to_asset);

    if rewritten != html {
        let _ = sqlx::query(
            "UPDATE local_mail_cache SET html_body = ?, updated_at = CURRENT_TIMESTAMP WHERE uid = ? AND folder = ?",
        )
        .bind(&rewritten)
        .bind(&uid)
        .bind(&q.mailbox)
        .execute(&pool)
        .await;
    }

    Json(InlinePrefetchResponse {
        html_body: rewritten,
        cached_count: url_to_asset.len(),
    })
    .into_response()
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

    let row =
        match sqlx::query("SELECT raw_rfc822 FROM local_mail_cache WHERE uid = ? AND folder = ?")
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

pub async fn get_local_mail_raw(
    State(state): State<Arc<MailAppState>>,
    Path((account_id, uid)): Path<(i64, String)>,
    Query(q): Query<LocalMailListQuery>,
) -> impl IntoResponse {
    let pool = match db::get_user_db_pool(&state._db, account_id).await {
        Ok(p) => p,
        Err(e) => return e.into_response(),
    };

    let row =
        match sqlx::query("SELECT raw_rfc822 FROM local_mail_cache WHERE uid = ? AND folder = ?")
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
            Json(json!({"error":"Mail not found in offline cache"})),
        )
            .into_response();
    };

    let raw = row
        .try_get::<Option<Vec<u8>>, _>("raw_rfc822")
        .ok()
        .flatten();

    let Some(raw_bytes) = raw else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({"error":"Raw mail not cached offline"})),
        )
            .into_response();
    };

    let file_name = if uid.trim().is_empty() {
        "message.msg".to_string()
    } else {
        format!("{uid}.msg")
    };
    let escaped = file_name.replace('"', "\\\"");
    let encoded = percent_encode_filename(&file_name);
    let disposition = format!("attachment; filename=\"{escaped}\"; filename*=UTF-8''{encoded}");

    Response::builder()
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
        .into_response()
}

pub async fn get_inline_asset(
    State(state): State<Arc<MailAppState>>,
    Path((account_id, asset_id)): Path<(i64, String)>,
) -> impl IntoResponse {
    let pool = match db::get_user_db_pool(&state._db, account_id).await {
        Ok(p) => p,
        Err(e) => return e.into_response(),
    };

    let row = match sqlx::query("SELECT content_type, body FROM inline_asset_cache WHERE asset_id = ?")
        .bind(&asset_id)
        .fetch_optional(&pool)
        .await
    {
        Ok(r) => r,
        Err(e) => return AppError::from(e).into_response(),
    };

    let Some(row) = row else {
        return (StatusCode::NOT_FOUND, Json(json!({"error":"Inline asset not cached"}))).into_response();
    };

    let content_type = row
        .try_get::<String, _>("content_type")
        .unwrap_or_else(|_| "application/octet-stream".to_string());
    if !content_type.to_ascii_lowercase().starts_with("image/") {
        return (StatusCode::NOT_FOUND, Json(json!({"error":"Unsupported inline asset type"}))).into_response();
    }

    let body: Vec<u8> = row
        .try_get::<Vec<u8>, _>("body")
        .unwrap_or_default();

    Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, content_type)
        .header(CONTENT_LENGTH, body.len().to_string())
        .body(Body::from(body))
        .unwrap_or_else(|_| Response::builder().status(StatusCode::INTERNAL_SERVER_ERROR).body(Body::empty()).unwrap())
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
        cache_raw_rfc822: true,
    });

    let pool = db::get_user_db_pool(app_state, account_id).await?;
    let mut tx = pool.begin().await?;

    sqlx::query(
        r#"
        INSERT INTO offline_config (id, enabled, initial_sync_mode, initial_sync_value, cache_raw_rfc822, updated_at)
        VALUES (1, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET
            enabled = excluded.enabled,
            initial_sync_mode = excluded.initial_sync_mode,
            initial_sync_value = excluded.initial_sync_value,
            cache_raw_rfc822 = excluded.cache_raw_rfc822,
            updated_at = CURRENT_TIMESTAMP
        "#,
    )
    .bind(setup.enabled as i64)
    .bind(&setup.initial_sync_policy.mode)
    .bind(setup.initial_sync_policy.value)
    .bind(setup.cache_raw_rfc822 as i64)
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
        "SELECT enabled, initial_sync_mode, initial_sync_value, cache_raw_rfc822 FROM offline_config WHERE id = 1",
    )
    .fetch_optional(&pool)
    .await?;

    let (enabled, mode, value, cache_raw_rfc822) = if let Some(r) = row {
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
            r.try_get::<Option<i64>, _>("cache_raw_rfc822")
                .ok()
                .flatten()
                .unwrap_or(1)
                != 0,
        )
    } else {
        (true, "all".to_string(), None, true)
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
        cache_raw_rfc822,
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
        transfer: get_transfer_snapshot(&state._db, account_id).await,
    }))
}

pub async fn post_offline_action(
    State(state): State<Arc<MailAppState>>,
    Path(account_id): Path<i64>,
    Json(payload): Json<OfflineActionRequest>,
) -> Result<Json<OfflineActionResponse>, AppError> {
    validate_offline_action_type(&payload.action_type)?;
    let pool = db::get_user_db_pool(&state._db, account_id).await?;
    let payload_json = payload
        .payload
        .as_ref()
        .map(|p| p.to_string())
        .unwrap_or_else(|| "{}".to_string());
    let payload_value = payload.payload.clone().unwrap_or_else(|| json!({}));
    let mut tx = pool.begin().await?;

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
        let cc_addrs = payload
            .payload
            .as_ref()
            .and_then(|p| p.get("cc"))
            .map(|v| v.to_string())
            .unwrap_or_else(|| "[]".to_string());
        let bcc_addrs = payload
            .payload
            .as_ref()
            .and_then(|p| p.get("bcc"))
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
            INSERT INTO outbox_mails (from_addr, to_addrs, cc_addrs, bcc_addrs, subject, body_text, status)
            VALUES (?, ?, ?, ?, ?, ?, 'pending')
            "#,
        )
        .bind(from_addr)
        .bind(to_addrs)
        .bind(cc_addrs)
        .bind(bcc_addrs)
        .bind(subject)
        .bind(body_text)
        .execute(&mut *tx)
        .await?;
    }

    let res = sqlx::query(
        r#"
        INSERT INTO offline_sync_queue (action_type, target_uid, target_folder, payload_json, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        "#,
    )
    .bind(&payload.action_type)
    .bind(&payload.target_uid)
    .bind(&payload.target_folder)
    .bind(payload_json)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    apply_local_action_side_effects(
        &pool,
        &payload.action_type,
        payload.target_uid.as_deref(),
        payload.target_folder.as_deref(),
        &payload_value,
    )
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

    let sending_total = rows.len() as i64;
    if sending_total > 0 {
        set_transfer_sending(
            &state._db,
            account_id,
            Some(TransferProgress {
                direction: "sending".to_string(),
                resource: "queue".to_string(),
                mailbox: None,
                total: Some(sending_total),
                done: 0,
                remaining: Some(sending_total),
                detail: Some("offline actions".to_string()),
                updated_at_ms: now_ms(),
            }),
        )
        .await;
    }

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

        let result = if is_removed_flag_action(action_type.as_str()) {
            Ok(())
        } else {
            match action_type.as_str() {
                "mark_read" => {
                    imap_session::mark_seen(&state.imap, account_id, &target_folder, &target_uid, true)
                }
                "mark_unread" => {
                    imap_session::mark_seen(&state.imap, account_id, &target_folder, &target_uid, false)
                }
                "delete" => imap_session::delete_mail(&state.imap, account_id, &target_folder, &target_uid),
                "move" => {
                    let destination = parsed
                        .get("destination")
                        .and_then(|v| v.as_str())
                        .unwrap_or(target_folder.as_str());
                    imap_session::move_mail(&state.imap, account_id, &target_folder, &target_uid, destination)
                }
                "label_add" => {
                    let label = parsed
                        .get("label")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default();
                    imap_session::set_label(&state.imap, account_id, &target_folder, &target_uid, label, true)
                }
                "label_remove" => {
                    let label = parsed
                        .get("label")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default();
                    imap_session::set_label(&state.imap, account_id, &target_folder, &target_uid, label, false)
                }
                "send" => Err("Queued send is not implemented on the backend yet".to_string()),
                _ => Err(format!("Unsupported action type: {action_type}")),
            }
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

        let done = (processed + failed) as i64;
        set_transfer_sending(
            &state._db,
            account_id,
            Some(TransferProgress {
                direction: "sending".to_string(),
                resource: "queue".to_string(),
                mailbox: None,
                total: Some(sending_total),
                done,
                remaining: Some((sending_total - done).max(0)),
                detail: Some(action_type.clone()),
                updated_at_ms: now_ms(),
            }),
        )
        .await;
    }

    set_transfer_sending(&state._db, account_id, None).await;
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

    let selected_mailboxes: Vec<String> = mailbox_list
        .into_iter()
        .filter(|mailbox| mailbox_is_selected(mailbox, &includes, &excludes))
        .collect();

    for mailbox in &selected_mailboxes {
        upsert_folder_metadata(&user_pool, mailbox).await?;
    }

    if policy.mode == "by_count" {
        let n = policy
            .value
            .unwrap_or(0)
            .max(0)
            .try_into()
            .unwrap_or(0usize);
        if n > 0 && !selected_mailboxes.is_empty() {
            let mut all_checkpoints_zero = true;
            for mailbox in &selected_mailboxes {
                let last_synced_uid: i64 = sqlx::query_scalar(
                    "SELECT last_synced_uid FROM sync_checkpoints WHERE folder_path = ?",
                )
                .bind(mailbox)
                .fetch_optional(&user_pool)
                .await?
                .unwrap_or(0);
                if last_synced_uid > 0 {
                    all_checkpoints_zero = false;
                    break;
                }
            }

            if all_checkpoints_zero {
                initial_sync_global_by_count(
                    app_state,
                    &user_pool,
                    imap_state,
                    account_id,
                    &selected_mailboxes,
                    &policy,
                    n,
                )
                .await?;
                set_transfer_receiving(app_state, account_id, None).await;
                return Ok(());
            }
        }
    }

    for mailbox in selected_mailboxes {
        sync_single_mailbox(app_state, &user_pool, imap_state, account_id, &mailbox, &policy).await?;
    }

    set_transfer_receiving(app_state, account_id, None).await;
    Ok(())
}

#[derive(Clone)]
struct MailCandidate {
    mailbox: String,
    uid: u32,
    date_ms: i64,
}

async fn initial_sync_global_by_count(
    app_state: &Arc<AppState>,
    pool: &SqlitePool,
    imap_state: &Arc<ImapState>,
    account_id: i64,
    mailboxes: &[String],
    policy: &SyncPolicy,
    limit_total: usize,
) -> Result<(), AppError> {
    let candidate_per_page = limit_total.clamp(50, 200);
    let max_pages = 5usize;

    let mut totals_by_mailbox = std::collections::HashMap::<String, usize>::new();
    let mut candidates: Vec<MailCandidate> = Vec::new();

    for page in 1..=max_pages {
        for mailbox in mailboxes {
            let total = *totals_by_mailbox.get(mailbox).unwrap_or(&usize::MAX);
            if total != usize::MAX && (page - 1) * candidate_per_page >= total {
                continue;
            }

            let (total_count, previews) = tokio::task::spawn_blocking({
                let imap_state = imap_state.clone();
                let mailbox = mailbox.clone();
                move || {
                    imap_session::fetch_mail_list(
                        &imap_state,
                        account_id,
                        &mailbox,
                        page,
                        candidate_per_page,
                    )
                }
            })
            .await
            .unwrap_or_default();

            totals_by_mailbox.insert(mailbox.clone(), total_count);

            for p in previews {
                let Ok(uid) = p.id.parse::<u32>() else {
                    continue;
                };
                let date_ms = chrono::DateTime::parse_from_rfc2822(&p.date)
                    .map(|dt| dt.timestamp_millis())
                    .unwrap_or(0);
                candidates.push(MailCandidate {
                    mailbox: mailbox.clone(),
                    uid,
                    date_ms,
                });
            }
        }

        if candidates.len() >= limit_total {
            break;
        }
    }

    candidates.sort_by(|a, b| b.date_ms.cmp(&a.date_ms).then_with(|| b.uid.cmp(&a.uid)));
    candidates.truncate(limit_total);

    let mut uids_by_mailbox: std::collections::HashMap<String, Vec<u32>> = std::collections::HashMap::new();
    for c in candidates {
        uids_by_mailbox.entry(c.mailbox).or_default().push(c.uid);
    }

    for (mailbox, mut uids) in uids_by_mailbox {
        uids.sort_unstable();
        uids.dedup();
        sync_specific_uids(
            app_state,
            pool,
            imap_state,
            account_id,
            &mailbox,
            &uids,
            policy.cache_raw_rfc822,
        )
        .await?;
    }

    Ok(())
}

async fn sync_specific_uids(
    app_state: &Arc<AppState>,
    pool: &SqlitePool,
    imap_state: &Arc<ImapState>,
    account_id: i64,
    mailbox: &str,
    uids: &[u32],
    cache_raw_rfc822: bool,
) -> Result<(), AppError> {
    if uids.is_empty() {
        return Ok(());
    }

    let total_new = uids.len() as i64;
    set_transfer_receiving(
        app_state,
        account_id,
        Some(TransferProgress {
            direction: "receiving".to_string(),
            resource: "emails".to_string(),
            mailbox: Some(mailbox.to_string()),
            total: Some(total_new),
            done: 0,
            remaining: Some(total_new),
            detail: Some(format!("{total_new} selected message(s)")),
            updated_at_ms: now_ms(),
        }),
    )
    .await;

    let mut done = 0i64;
    let mut max_uid_synced = 0u32;

    for chunk in uids.chunks(50) {
        let chunk_uids: Vec<u32> = chunk.to_vec();
        let chunk_uids_for_fetch = chunk_uids.clone();
        let mails = tokio::task::spawn_blocking({
            let imap_state = imap_state.clone();
            let mailbox = mailbox.to_string();
            move || {
                imap_session::fetch_headers_for_uids(
                    &imap_state,
                    account_id,
                    &mailbox,
                    &chunk_uids_for_fetch,
                )
            }
        })
        .await
        .unwrap_or_default();

        let aligned = align_previews_to_uids(&chunk_uids, &mails);
        for (uid, mut mail) in aligned {
            max_uid_synced = bump_max_uid_synced(max_uid_synced, uid);
            let uid_str = uid.to_string();
            mail.id = uid_str.clone();

            cache_mail_preview(pool, mailbox, &mail).await?;
            cache_mail_body_if_missing(
                pool,
                imap_state,
                account_id,
                mailbox,
                &uid_str,
                cache_raw_rfc822,
            )
            .await?;

            done += 1;
            set_transfer_receiving(
                app_state,
                account_id,
                Some(TransferProgress {
                    direction: "receiving".to_string(),
                    resource: "emails".to_string(),
                    mailbox: Some(mailbox.to_string()),
                    total: Some(total_new),
                    done,
                    remaining: Some((total_new - done).max(0)),
                    detail: Some("downloading emails".to_string()),
                    updated_at_ms: now_ms(),
                }),
            )
            .await;
        }
    }

    if max_uid_synced > 0 {
        let _ = sqlx::query(
            r#"
            INSERT INTO sync_checkpoints (folder_path, last_synced_uid, last_uid_validity, updated_at)
            VALUES (?, ?, 0, CURRENT_TIMESTAMP)
            ON CONFLICT(folder_path) DO UPDATE SET
                last_synced_uid = excluded.last_synced_uid,
                updated_at = CURRENT_TIMESTAMP
            "#,
        )
        .bind(mailbox)
        .bind(max_uid_synced as i64)
        .execute(pool)
        .await;
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
        "SELECT enabled, initial_sync_mode, initial_sync_value, cache_raw_rfc822 FROM offline_config WHERE id = 1",
    )
    .fetch_optional(pool)
    .await?;

    let policy = if let Some(r) = row {
        SyncPolicy {
            enabled: r
                .try_get::<Option<i64>, _>("enabled")
                .ok()
                .flatten()
                .unwrap_or(1)
                != 0,
            mode: r
                .try_get::<Option<String>, _>("initial_sync_mode")
                .ok()
                .flatten()
                .unwrap_or_else(|| "all".to_string()),
            value: r
                .try_get::<Option<i64>, _>("initial_sync_value")
                .ok()
                .flatten(),
            cache_raw_rfc822: r
                .try_get::<Option<i64>, _>("cache_raw_rfc822")
                .ok()
                .flatten()
                .unwrap_or(1)
                != 0,
        }
    } else {
        SyncPolicy {
            enabled: true,
            mode: "all".to_string(),
            value: None,
            cache_raw_rfc822: true,
        }
    };

    Ok((includes, excludes, policy))
}

fn mailbox_is_selected(mailbox: &str, includes: &[String], excludes: &[String]) -> bool {
    let included = includes
        .iter()
        .any(|path| path == "*" || mailbox == path || mailbox.starts_with(&format!("{path}/")));
    let excluded = excludes.iter().any(|path| mailbox == path);
    included && !excluded
}

async fn apply_local_action_side_effects(
    pool: &SqlitePool,
    action_type: &str,
    target_uid: Option<&str>,
    target_folder: Option<&str>,
    payload: &serde_json::Value,
) -> Result<(), AppError> {
    let Some(uid) = target_uid.filter(|value| !value.is_empty()) else {
        return Ok(());
    };
    let folder = target_folder.unwrap_or("INBOX");

    match action_type {
        "mark_read" => {
            sqlx::query(
                "UPDATE local_mail_cache SET seen = 1, updated_at = CURRENT_TIMESTAMP WHERE uid = ? AND folder = ?",
            )
            .bind(uid)
            .bind(folder)
            .execute(pool)
            .await?;
        }
        "mark_unread" => {
            sqlx::query(
                "UPDATE local_mail_cache SET seen = 0, updated_at = CURRENT_TIMESTAMP WHERE uid = ? AND folder = ?",
            )
            .bind(uid)
            .bind(folder)
            .execute(pool)
            .await?;
        }
        "delete" => {
            sqlx::query("DELETE FROM local_mail_cache WHERE uid = ? AND folder = ?")
                .bind(uid)
                .bind(folder)
                .execute(pool)
                .await?;
        }
        "move" => {
            let destination = payload
                .get("destination")
                .and_then(|value| value.as_str())
                .unwrap_or(folder);
            upsert_folder_metadata(pool, destination).await?;
            sqlx::query(
                "UPDATE local_mail_cache SET folder = ?, updated_at = CURRENT_TIMESTAMP WHERE uid = ? AND folder = ?",
            )
            .bind(destination)
            .bind(uid)
            .bind(folder)
            .execute(pool)
            .await?;
        }
        "label_add" => {
            let label = payload
                .get("label")
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty());
            if let Some(label) = label {
                let rows = sqlx::query(
                    "SELECT folder, category, labels_json FROM local_mail_cache WHERE uid = ?",
                )
                .bind(uid)
                .fetch_all(pool)
                .await?;

                for row in rows {
                    let row_folder = row
                        .try_get::<Option<String>, _>("folder")
                        .ok()
                        .flatten()
                        .unwrap_or_else(|| folder.to_string());
                    let existing_category = row.try_get::<Option<String>, _>("category").ok().flatten();
                    let existing_labels_json = row
                        .try_get::<Option<String>, _>("labels_json")
                        .ok()
                        .flatten()
                        .unwrap_or_else(|| "[]".to_string());

                    let mutation = compute_local_label_mutation(
                        &existing_labels_json,
                        existing_category.as_deref(),
                        label,
                        true,
                        &row_folder,
                    );

                    sqlx::query(
                        "UPDATE local_mail_cache SET category = ?, labels_json = ?, updated_at = CURRENT_TIMESTAMP WHERE uid = ? AND folder = ?",
                    )
                    .bind(mutation.next_category.as_deref())
                    .bind(&mutation.labels_json)
                    .bind(uid)
                    .bind(&row_folder)
                    .execute(pool)
                    .await?;
                }
            }
        }
        "label_remove" => {
            let label = payload
                .get("label")
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty());
            if let Some(label) = label {
                let rows = sqlx::query(
                    "SELECT folder, category, labels_json FROM local_mail_cache WHERE uid = ?",
                )
                .bind(uid)
                .fetch_all(pool)
                .await?;

                for row in rows {
                    let row_folder = row
                        .try_get::<Option<String>, _>("folder")
                        .ok()
                        .flatten()
                        .unwrap_or_else(|| folder.to_string());
                    let existing_category = row.try_get::<Option<String>, _>("category").ok().flatten();
                    let existing_labels_json = row
                        .try_get::<Option<String>, _>("labels_json")
                        .ok()
                        .flatten()
                        .unwrap_or_else(|| "[]".to_string());

                    let mutation = compute_local_label_mutation(
                        &existing_labels_json,
                        existing_category.as_deref(),
                        label,
                        false,
                        &row_folder,
                    );

                    if mutation.delete_row {
                        sqlx::query("DELETE FROM local_mail_cache WHERE uid = ? AND folder = ?")
                            .bind(uid)
                            .bind(&row_folder)
                            .execute(pool)
                            .await?;
                        continue;
                    }

                    sqlx::query(
                        "UPDATE local_mail_cache SET category = ?, labels_json = ?, updated_at = CURRENT_TIMESTAMP WHERE uid = ? AND folder = ?",
                    )
                    .bind(mutation.next_category.as_deref())
                    .bind(&mutation.labels_json)
                    .bind(uid)
                    .bind(&row_folder)
                    .execute(pool)
                    .await?;
                }
            }
        }
        _ => {}
    }

    Ok(())
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
    app_state: &Arc<AppState>,
    pool: &SqlitePool,
    imap_state: &Arc<ImapState>,
    account_id: i64,
    mailbox: &str,
    policy: &SyncPolicy,
) -> Result<(), AppError> {
    let per_page = 50usize;
    let cutoff = policy_cutoff(policy);
    let limit = policy
        .value
        .filter(|_| policy.mode == "by_count")
        .map(|value| value.max(0) as usize);

    let last_synced_uid: u32 = sqlx::query_scalar(
        "SELECT last_synced_uid FROM sync_checkpoints WHERE folder_path = ?",
    )
    .bind(mailbox)
    .fetch_optional(pool)
    .await?
    .map(|v: i64| v.max(0) as u32)
    .unwrap_or(0);

    let (_total, new_uids) = tokio::task::spawn_blocking({
        let imap_state = imap_state.clone();
        let mailbox = mailbox.to_string();
        move || imap_session::fetch_new_uids_since(&imap_state, account_id, &mailbox, last_synced_uid)
    })
    .await
    .unwrap_or((0, vec![]));

    let uids_to_sync: Vec<u32> = if last_synced_uid == 0 {
        let mut filtered = new_uids;
        if let Some(max_count) = limit {
            let skip = filtered.len().saturating_sub(max_count);
            filtered = filtered[skip..].to_vec();
        }
        filtered
    } else {
        new_uids
    };

    if uids_to_sync.is_empty() {
        tracing::debug!("No new messages for mailbox {mailbox} (checkpoint UID={last_synced_uid})");
        return Ok(());
    }

    let total_new = uids_to_sync.len() as i64;
    tracing::info!(
        "Incremental sync: {} new message(s) for {} (since UID {})",
        total_new, mailbox, last_synced_uid
    );

    set_transfer_receiving(
        app_state,
        account_id,
        Some(TransferProgress {
            direction: "receiving".to_string(),
            resource: "emails".to_string(),
            mailbox: Some(mailbox.to_string()),
            total: Some(total_new),
            done: 0,
            remaining: Some(total_new),
            detail: Some(format!("{total_new} new message(s)")),
            updated_at_ms: now_ms(),
        }),
    )
    .await;

    let mut synced_count = 0usize;
    let mut max_uid_synced: u32 = last_synced_uid;

    'outer: for chunk in uids_to_sync.chunks(per_page) {
        let chunk_uids: Vec<u32> = chunk.to_vec();
        let chunk_uids_for_fetch = chunk_uids.clone();
        let mails = tokio::task::spawn_blocking({
            let imap_state = imap_state.clone();
            let mailbox = mailbox.to_string();
            move || {
                imap_session::fetch_headers_for_uids(
                    &imap_state,
                    account_id,
                    &mailbox,
                    &chunk_uids_for_fetch,
                )
            }
        })
        .await
        .unwrap_or_default();

        let aligned = align_previews_to_uids(&chunk_uids, &mails);
        for (uid, mail) in aligned {
            if limit.is_some_and(|max_count| synced_count >= max_count) {
                break 'outer;
            }
            if cutoff
                .as_ref()
                .is_some_and(|threshold| mail_date_before_threshold(&mail.date, threshold))
            {
                break 'outer;
            }

            max_uid_synced = bump_max_uid_synced(max_uid_synced, uid);
            let uid_str = uid.to_string();
            let mut mail = mail;
            mail.id = uid_str.clone();

            cache_mail_preview(pool, mailbox, &mail).await?;
            
            cache_mail_body_if_missing(
                pool,
                imap_state,
                account_id,
                mailbox,
                &uid_str,
                policy.cache_raw_rfc822,
            )
            .await?;
            synced_count += 1;

            set_transfer_receiving(
                app_state,
                account_id,
                Some(TransferProgress {
                    direction: "receiving".to_string(),
                    resource: "emails".to_string(),
                    mailbox: Some(mailbox.to_string()),
                    total: Some(total_new),
                    done: synced_count as i64,
                    remaining: Some((total_new - synced_count as i64).max(0)),
                    detail: Some("downloading emails".to_string()),
                    updated_at_ms: now_ms(),
                }),
            )
            .await;
        }
    }

    if max_uid_synced > last_synced_uid {
        sqlx::query(
            r#"
            INSERT INTO sync_checkpoints (folder_path, last_synced_uid, last_uid_validity, updated_at)
            VALUES (?, ?, 0, CURRENT_TIMESTAMP)
            ON CONFLICT(folder_path) DO UPDATE SET
                last_synced_uid = excluded.last_synced_uid,
                updated_at = CURRENT_TIMESTAMP
            "#,
        )
        .bind(mailbox)
        .bind(max_uid_synced as i64)
        .execute(pool)
        .await?;
        tracing::info!("Checkpoint saved: {mailbox} last_uid={max_uid_synced}");
    }

    Ok(())
}

fn bump_max_uid_synced(current: u32, processed_uid: u32) -> u32 {
    current.max(processed_uid)
}

fn align_previews_to_uids(chunk_uids: &[u32], previews: &[MailPreview]) -> Vec<(u32, MailPreview)> {
    use std::collections::{HashMap, HashSet};

    if chunk_uids.is_empty() || previews.is_empty() {
        return vec![];
    }

    let uid_set: HashSet<u32> = chunk_uids.iter().copied().collect();
    let mut idx_by_uid: HashMap<u32, usize> = HashMap::new();
    for (idx, preview) in previews.iter().enumerate() {
        if let Ok(uid) = preview.id.parse::<u32>() {
            if uid_set.contains(&uid) {
                idx_by_uid.entry(uid).or_insert(idx);
            }
        }
    }

    let matched = idx_by_uid.len();
    let fallback_positional =
        previews.len() == chunk_uids.len() && (matched == 0 || matched < (previews.len() / 2));

    if fallback_positional {
        return chunk_uids
            .iter()
            .copied()
            .zip(previews.iter().cloned())
            .map(|(uid, mut preview)| {
                preview.id = uid.to_string();
                (uid, preview)
            })
            .collect();
    }

    chunk_uids
        .iter()
        .copied()
        .filter_map(|uid| {
            idx_by_uid.get(&uid).map(|idx| {
                let mut preview = previews[*idx].clone();
                preview.id = uid.to_string();
                (uid, preview)
            })
        })
        .collect()
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

#[cfg(test)]
mod tests {
    use super::*;

    fn preview(id: &str) -> MailPreview {
        MailPreview {
            id: id.to_string(),
            name: "n".to_string(),
            address: "a@example.com".to_string(),
            recipient_to: "me@example.com".to_string(),
            subject: "s".to_string(),
            date: "Mon, 01 Jan 2024 00:00:00 +0000".to_string(),
            seen: false,
            flagged: false,
            size: 0,
            importance: 1,
            content_type: "text/plain".to_string(),
            category: String::new(),
            labels: Vec::new(),
        }
    }

    #[test]
    fn align_previews_uses_uid_match_when_available() {
        let chunk = vec![101, 102, 103];
        let previews = vec![preview("103"), preview("101"), preview("102")];
        let aligned = align_previews_to_uids(&chunk, &previews);
        let got: Vec<u32> = aligned.iter().map(|(uid, _)| *uid).collect();
        assert_eq!(got, chunk);
        for (uid, p) in aligned {
            assert_eq!(p.id, uid.to_string());
        }
    }

    #[test]
    fn align_previews_falls_back_to_positional_when_ids_not_uids() {
        let chunk = vec![5001, 5002];
        let previews = vec![preview("1"), preview("2")];
        let aligned = align_previews_to_uids(&chunk, &previews);
        assert_eq!(aligned.len(), 2);
        assert_eq!(aligned[0].0, 5001);
        assert_eq!(aligned[0].1.id, "5001");
        assert_eq!(aligned[1].0, 5002);
        assert_eq!(aligned[1].1.id, "5002");
    }

    #[test]
    fn bump_max_uid_synced_tracks_processed_uids() {
        let mut max_uid = 100;
        max_uid = bump_max_uid_synced(max_uid, 101);
        max_uid = bump_max_uid_synced(max_uid, 150);
        
        assert_eq!(max_uid, 150);
    }

    #[test]
    fn validate_offline_action_type_rejects_flag() {
        let result = validate_offline_action_type("flag");
        assert!(matches!(result, Err(AppError::BadRequest(_))));
    }

    #[test]
    fn validate_offline_action_type_rejects_unflag() {
        let result = validate_offline_action_type("unflag");
        assert!(matches!(result, Err(AppError::BadRequest(_))));
    }

    #[test]
    fn removed_flag_action_detection_matches_flag() {
        assert!(is_removed_flag_action("flag"));
    }

    #[test]
    fn removed_flag_action_detection_matches_unflag() {
        assert!(is_removed_flag_action("unflag"));
    }

    #[test]
    fn compute_local_label_mutation_adds_label_and_sets_category_when_empty() {
        let mutation = compute_local_label_mutation("[]", None, "Work", true, "INBOX");
        assert_eq!(mutation.labels_json, "[\"Work\"]");
        assert_eq!(mutation.next_category.as_deref(), Some("Work"));
        assert!(!mutation.delete_row);
    }

    #[test]
    fn compute_local_label_mutation_removes_label_and_deletes_matching_label_mailbox_row() {
        let mutation = compute_local_label_mutation(
            "[\"Work\",\"Urgent\"]",
            Some("Work"),
            "Work",
            false,
            "Labels/Work",
        );
        assert_eq!(mutation.labels_json, "[\"Urgent\"]");
        assert_eq!(mutation.next_category.as_deref(), Some("Urgent"));
        assert!(mutation.delete_row);
    }
}

async fn cache_mail_preview(
    pool: &SqlitePool,
    mailbox: &str,
    mail: &MailPreview,
) -> Result<(), AppError> {
    let mut mail = mail.clone();
    merge_mailbox_label_into_preview(&mut mail, mailbox);

    let date_ms: i64 = DateTime::parse_from_rfc2822(&mail.date)
        .map(|dt| dt.timestamp_millis())
        .unwrap_or(0);
    let labels_json = serialize_labels_json_value(&mail.labels);
    sqlx::query(
        r#"
        INSERT INTO local_mail_cache (
            uid, folder, sender_name, sender_address, recipient_to, subject, seen, flagged,
            date_value, date_ms, size_bytes, importance_value, content_type, category, labels_json, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(uid, folder) DO UPDATE SET
            sender_name = excluded.sender_name,
            sender_address = excluded.sender_address,
            recipient_to = excluded.recipient_to,
            subject = excluded.subject,
            seen = excluded.seen,
            flagged = excluded.flagged,
            date_value = excluded.date_value,
            date_ms = excluded.date_ms,
            size_bytes = excluded.size_bytes,
            importance_value = excluded.importance_value,
            content_type = excluded.content_type,
            category = excluded.category,
            labels_json = excluded.labels_json,
            updated_at = CURRENT_TIMESTAMP
        "#,
    )
    .bind(&mail.id)
    .bind(mailbox)
    .bind(&mail.name)
    .bind(&mail.address)
    .bind(&mail.recipient_to)
    .bind(&mail.subject)
    .bind(mail.seen as i64)
    .bind(mail.flagged as i64)
    .bind(&mail.date)
    .bind(date_ms)
    .bind(mail.size as i64)
    .bind(mail.importance as i64)
    .bind(&mail.content_type)
    .bind(&mail.category)
    .bind(&labels_json)
    .execute(pool)
    .await?;

    if let Ok(server_uid) = mail.id.parse::<i64>() {
        let folder_id: i64 = sqlx::query_scalar("SELECT folder_id FROM folders WHERE path_by_name = ?")
            .bind(mailbox)
            .fetch_optional(pool)
            .await?
            .unwrap_or(0);

        if folder_id > 0 {
            let _ = sqlx::query(
                r#"
                INSERT INTO emails (
                    server_uid, uid_validity, message_id, in_reply_to, sender_from, recipient_to,
                    recipient_cc, recipient_bcc, subject, date_sent, attach_amount, is_read,
                    is_flagged, folder_id, sync_status
                )
                VALUES (?, 0, NULL, NULL, ?, ?, NULL, NULL, ?, ?, NULL, ?, ?, ?, 1)
                ON CONFLICT(server_uid) DO UPDATE SET
                    sender_from = excluded.sender_from,
                    recipient_to = excluded.recipient_to,
                    subject = excluded.subject,
                    date_sent = excluded.date_sent,
                    is_read = excluded.is_read,
                    is_flagged = excluded.is_flagged,
                    folder_id = excluded.folder_id,
                    sync_status = excluded.sync_status
                "#,
            )
            .bind(server_uid)
            .bind(&mail.address)
            .bind(&mail.recipient_to)
            .bind(&mail.subject)
            .bind(&mail.date)
            .bind(mail.seen as i64)
            .bind(mail.flagged as i64)
            .bind(folder_id)
            .execute(pool)
            .await;
        }
    }

    Ok(())
}

async fn cache_mail_body_if_missing(
    pool: &SqlitePool,
    imap_state: &Arc<ImapState>,
    account_id: i64,
    mailbox: &str,
    uid: &str,
    cache_raw_rfc822: bool,
) -> Result<(), AppError> {
    
    let already_cached: bool = sqlx::query_scalar(
        "SELECT (plain_body IS NOT NULL OR html_body IS NOT NULL OR raw_rfc822 IS NOT NULL) FROM local_mail_cache WHERE uid = ? AND folder = ?",
    )
    .bind(uid)
    .bind(mailbox)
    .fetch_optional(pool)
    .await?
    .unwrap_or(false);

    if already_cached {
        return Ok(());
    }

    cache_mail_body(pool, imap_state, account_id, mailbox, uid, cache_raw_rfc822).await
}

async fn cache_mail_body(
    pool: &SqlitePool,
    imap_state: &Arc<ImapState>,
    account_id: i64,
    mailbox: &str,
    uid: &str,
    cache_raw_rfc822: bool,
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
    let url_to_asset = cache_inline_assets_for_html(pool, account_id, &content.html_body).await;
    let rewritten_html = rewrite_html_inline_image_srcs(&content.html_body, account_id, &url_to_asset);
    let date_ms: i64 = DateTime::parse_from_rfc2822(&content.date)
        .map(|dt| dt.timestamp_millis())
        .unwrap_or(0);

    sqlx::query(
        r#"
        UPDATE local_mail_cache
        SET plain_body = ?, html_body = ?, date_value = ?, date_ms = ?, cc_value = ?, bcc_value = ?, raw_rfc822 = ?, updated_at = CURRENT_TIMESTAMP
        WHERE uid = ? AND folder = ?
        "#,
    )
    .bind(&content.plain_body)
    .bind(&rewritten_html)
    .bind(&content.date)
    .bind(date_ms)
    .bind(&content.cc)
    .bind(&content.bcc)
    .bind(if cache_raw_rfc822 { Some(raw) } else { None })
    .bind(uid)
    .bind(mailbox)
    .execute(pool)
    .await?;

    if let Ok(server_uid) = uid.parse::<i64>() {
        let attach_amount = if cache_raw_rfc822 {
            content.attachments.len() as i64
        } else {
            0
        };
        let _ = sqlx::query(
            r#"
            UPDATE emails
            SET body_text = ?, body_html = ?, attach_amount = ?, date_sent = ?, sync_status = 1
            WHERE server_uid = ?
            "#,
        )
        .bind(&content.plain_body)
        .bind(&content.html_body)
        .bind(attach_amount)
        .bind(&content.date)
        .bind(server_uid)
        .execute(pool)
        .await;
    }

    Ok(())
}

fn inline_asset_id(url: &str) -> String {
    
    let mut hash: u64 = 0xcbf29ce484222325;
    for &b in url.as_bytes() {
        hash ^= b as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

async fn cache_inline_assets_for_html(
    pool: &SqlitePool,
    _account_id: i64,
    html: &str,
) -> std::collections::HashMap<String, String> {
    use std::{collections::HashMap, time::Duration};

    const MAX_INLINE_IMAGES_PER_MAIL: usize = 20;
    const MAX_INLINE_ASSET_BYTES: usize = 2 * 1024 * 1024; 

    if html.is_empty() {
        return HashMap::new();
    }

    let mut urls = extract_inline_img_urls(html);
    urls.sort();
    urls.dedup();
    urls.truncate(MAX_INLINE_IMAGES_PER_MAIL);

    let mut out: HashMap<String, String> = HashMap::new();
    for url in urls {
        let asset_id = inline_asset_id(&url);

        if let Ok(Some(_)) = sqlx::query_scalar::<_, i64>(
            "SELECT 1 FROM inline_asset_cache WHERE asset_id = ? LIMIT 1",
        )
        .bind(&asset_id)
        .fetch_optional(pool)
        .await
        {
            out.insert(url, asset_id);
            continue;
        }

        let url_clone = url.clone();
        let fetched = tokio::task::spawn_blocking(move || {
            fetch_inline_asset_http(&url_clone, MAX_INLINE_ASSET_BYTES, Duration::from_secs(8))
        })
        .await
        .ok()
        .flatten();

        let Some((content_type, body)) = fetched else {
            continue;
        };

        if !content_type.to_ascii_lowercase().starts_with("image/") || body.is_empty() {
            continue;
        }

        let _ = sqlx::query(
            r#"
            INSERT INTO inline_asset_cache (asset_id, url, content_type, body, updated_at)
            VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(asset_id) DO UPDATE SET
                url = excluded.url,
                content_type = excluded.content_type,
                body = excluded.body,
                updated_at = CURRENT_TIMESTAMP
            "#,
        )
        .bind(&asset_id)
        .bind(&url)
        .bind(&content_type)
        .bind(&body)
        .execute(pool)
        .await;

        out.insert(url, asset_id);
    }

    out
}

fn rewrite_html_inline_image_srcs(
    html: &str,
    account_id: i64,
    url_to_asset: &std::collections::HashMap<String, String>,
) -> String {
    if html.is_empty() || url_to_asset.is_empty() {
        return html.to_string();
    }

    let mut out = html.to_string();
    for (url, asset_id) in url_to_asset {
        let local = format!(
            "http://localhost:5000/api/offline/{}/inline-assets/{}",
            account_id, asset_id
        );
        out = out.replace(url, &local);
    }
    out
}

fn extract_inline_img_urls(html: &str) -> Vec<String> {
    let lower = html.to_ascii_lowercase();
    let mut urls = Vec::new();
    let mut pos = 0usize;
    while let Some(img_idx) = lower[pos..].find("<img") {
        let start = pos + img_idx;
        let tag_end = lower[start..].find('>').map(|i| start + i).unwrap_or(lower.len());
        let tag_lower = &lower[start..tag_end];
        if let Some(src_idx) = tag_lower.find("src=") {
            let mut i = start + src_idx + 4; 
            
            while i < tag_end && lower.as_bytes()[i].is_ascii_whitespace() {
                i += 1;
            }
            if i >= tag_end {
                pos = tag_end;
                continue;
            }
            let quote = lower.as_bytes()[i];
            let (url_start, url_end) = if quote == b'"' || quote == b'\'' {
                i += 1;
                let j = lower[i..tag_end]
                    .find(quote as char)
                    .map(|k| i + k)
                    .unwrap_or(tag_end);
                (i, j)
            } else {
                let j = lower[i..tag_end]
                    .find(|c: char| c.is_whitespace() || c == '>')
                    .map(|k| i + k)
                    .unwrap_or(tag_end);
                (i, j)
            };
            if url_end > url_start && url_end <= html.len() {
                let url = html[url_start..url_end].trim().to_string();
                if url.starts_with("http://") || url.starts_with("https://") {
                    urls.push(url);
                }
            }
        }
        pos = tag_end;
    }
    urls
}

fn fetch_inline_asset_http(
    url: &str,
    max_bytes: usize,
    timeout: std::time::Duration,
) -> Option<(String, Vec<u8>)> {
    fetch_inline_asset_http_inner(url, max_bytes, timeout, 1)
}

fn fetch_inline_asset_http_inner(
    url: &str,
    max_bytes: usize,
    timeout: std::time::Duration,
    redirects_left: usize,
) -> Option<(String, Vec<u8>)> {
    use native_tls::TlsConnector;
    use std::io::{Read, Write};
    use std::net::TcpStream;

    let (scheme, rest) = if let Some(r) = url.strip_prefix("https://") {
        ("https", r)
    } else if let Some(r) = url.strip_prefix("http://") {
        ("http", r)
    } else {
        return None;
    };

    let (host_port, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "/"),
    };

    let (host, port) = match host_port.rsplit_once(':') {
        Some((h, p)) if !h.contains(']') && p.chars().all(|c| c.is_ascii_digit()) => {
            (h, p.parse::<u16>().ok()?)
        }
        _ => (host_port, if scheme == "https" { 443 } else { 80 }),
    };

    let mut stream = TcpStream::connect((host, port)).ok()?;
    let _ = stream.set_read_timeout(Some(timeout));
    let _ = stream.set_write_timeout(Some(timeout));

    let request = format!(
        "GET {} HTTP/1.1\r\nHost: {}\r\nUser-Agent: guvercin\r\nAccept: image/*\r\nConnection: close\r\n\r\n",
        path, host
    )
    .into_bytes();

    if scheme == "https" {
        let connector = TlsConnector::new().ok()?;
        let mut tls = connector.connect(host, stream).ok()?;
        tls.write_all(&request).ok()?;
        tls.flush().ok()?;
        let mut buf = Vec::new();
        tls.read_to_end(&mut buf).ok()?;
        match parse_http_response(&buf, max_bytes) {
            HttpFetchResult::Image(ct, body) => Some((ct, body)),
            HttpFetchResult::Redirect(location) => {
                if redirects_left == 0 {
                    None
                } else if location.starts_with("http://") || location.starts_with("https://") {
                    fetch_inline_asset_http_inner(&location, max_bytes, timeout, redirects_left - 1)
                } else {
                    None
                }
            }
            HttpFetchResult::Other => None,
        }
    } else {
        stream.write_all(&request).ok()?;
        stream.flush().ok()?;
        let mut buf = Vec::new();
        stream.read_to_end(&mut buf).ok()?;
        match parse_http_response(&buf, max_bytes) {
            HttpFetchResult::Image(ct, body) => Some((ct, body)),
            HttpFetchResult::Redirect(location) => {
                if redirects_left == 0 {
                    None
                } else if location.starts_with("http://") || location.starts_with("https://") {
                    fetch_inline_asset_http_inner(&location, max_bytes, timeout, redirects_left - 1)
                } else {
                    None
                }
            }
            HttpFetchResult::Other => None,
        }
    }
}

enum HttpFetchResult {
    Image(String, Vec<u8>),
    Redirect(String),
    Other,
}

fn parse_http_response(buf: &[u8], max_bytes: usize) -> HttpFetchResult {
    let Some(header_end) = buf.windows(4).position(|w| w == b"\r\n\r\n") else {
        return HttpFetchResult::Other;
    };
    let headers = &buf[..header_end];
    let mut body = buf[header_end + 4..].to_vec();

    let header_str = String::from_utf8_lossy(headers);
    let mut lines = header_str.lines();
    let Some(status_line) = lines.next().map(|v| v.trim()) else {
        return HttpFetchResult::Other;
    };
    let Some(status) = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|v| v.parse::<u16>().ok())
    else {
        return HttpFetchResult::Other;
    };
    let is_redirect = matches!(status, 301 | 302 | 303 | 307 | 308);

    let mut content_type = "application/octet-stream".to_string();
    let mut transfer_chunked = false;
    let mut location: Option<String> = None;
    for line in lines {
        let line = line.trim();
        if let Some((k, v)) = line.split_once(':') {
            let key = k.trim().to_ascii_lowercase();
            let value = v.trim();
            if key == "content-type" {
                content_type = value.split(';').next().unwrap_or(value).trim().to_string();
            } else if key == "transfer-encoding" && value.to_ascii_lowercase().contains("chunked") {
                transfer_chunked = true;
            } else if key == "location" {
                location = Some(value.to_string());
            } else if key == "content-encoding" {
                
                return HttpFetchResult::Other;
            }
        }
    }

    if is_redirect {
        if let Some(loc) = location {
            return HttpFetchResult::Redirect(loc);
        }
        return HttpFetchResult::Other;
    }

    if !(200..300).contains(&status) {
        return HttpFetchResult::Other;
    }

    if transfer_chunked {
        body = match decode_chunked_body(&body) {
            Some(v) => v,
            None => return HttpFetchResult::Other,
        };
    }

    if body.len() > max_bytes {
        return HttpFetchResult::Other;
    }

    HttpFetchResult::Image(content_type, body)
}

fn decode_chunked_body(input: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < input.len() {
        
        let line_end = input[i..].windows(2).position(|w| w == b"\r\n")?;
        let line = &input[i..i + line_end];
        let size_str = String::from_utf8_lossy(line);
        let size = usize::from_str_radix(size_str.trim(), 16).ok()?;
        i += line_end + 2;
        if size == 0 {
            return Some(out);
        }
        if i + size > input.len() {
            return None;
        }
        out.extend_from_slice(&input[i..i + size]);
        i += size;
        
        if i + 2 <= input.len() && &input[i..i + 2] == b"\r\n" {
            i += 2;
        }
    }
    Some(out)
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
