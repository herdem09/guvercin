use std::sync::Arc;

use axum::{
    extract::{Form, Json, State},
    http::StatusCode,
    response::IntoResponse,
};
use serde_json::json;

use crate::{
    db::AppState,
    error::AppError,
    i18n::tr,
    imap_client,
    models::{
        AccountSettingsResponse, AccountSummary, AccountsResponse, FinalizeAccountBody,
        FinalizeAccountData,         FinalizeSuccessResponse, MailboxPreviewRequest,
        MailboxPreviewResponse, SetFontBody, SetLayoutBody, SetMailboxCountDisplayBody, SetOrderBody, SetThemeBody,
        SetConversationViewBody, SetupAccountForm, SetupFailureFormData,
        SetupFailureResponse, SetupSuccessResponse, UpdateAccountSettingsBody, DeleteAccountBody,
    },
    offline_routes,
};

pub async fn health_check() -> impl IntoResponse {
    (StatusCode::OK, "OK")
}

pub async fn get_accounts(
    State(state): State<Arc<AppState>>,
) -> Result<Json<AccountsResponse>, AppError> {
    let Some(inner) = state.ready_or_none().await else {
        return Ok(Json(AccountsResponse { accounts: vec![] }));
    };
    let rows = sqlx::query_as::<_, AccountSummary>(
        r#"
        SELECT account_id, email_address, display_name, provider_type,
               imap_host, imap_port, smtp_host, smtp_port, sync_status,
               last_sync_time, language, theme, font, layout, ssl_mode, mailbox_order, label_order,
               mailbox_count_display, conversation_view, thread_order
        FROM accounts
        "#,
    )
    .fetch_all(&inner.general_pool)
    .await?;

    Ok(Json(AccountsResponse { accounts: rows }))
}

pub async fn setup_account(
    State(state): State<Arc<AppState>>,
    Form(form): Form<SetupAccountForm>,
) -> impl IntoResponse {
    let email = form.email_address.trim().to_string();

    if let Some(inner) = state.ready_or_none().await {
        if let Ok(existing) =
            sqlx::query_scalar::<_, i64>("SELECT account_id FROM accounts WHERE email_address = ?")
                .bind(&email)
                .fetch_optional(&inner.general_pool)
                .await
        {
            if existing.is_some() {
                let body = json!({
                    "status": "already_exists",
                    "message": tr("This email address is already registered."),
                });
                return (StatusCode::CONFLICT, Json(body)).into_response();
            }
        }
    }

    let skip_auth = form
        .skip_auth
        .as_deref()
        .unwrap_or("false")
        .eq_ignore_ascii_case("true");

    let imap_port: u16 = form
        .imap_port
        .as_deref()
        .map(|s| s.trim())
        .and_then(|s| s.parse().ok())
        .unwrap_or(143);

    let smtp_port_raw = form
        .smtp_port
        .as_deref()
        .map(|s| s.trim())
        .unwrap_or_default()
        .to_string();
    let ssl_mode = form
        .ssl_mode
        .as_deref()
        .map(|s| s.trim())
        .unwrap_or("STARTTLS");

    let (success, message) = if skip_auth {
        (true, tr("Authorization skipped by user."))
    } else {
        let imap_server = form.imap_server.trim().to_string();
        let password = form.password.trim().to_string();
        let (ok, msg) =
            imap_client::authorize(&imap_server, &email, &password, imap_port, false, &ssl_mode)
                .await;
        (ok, msg)
    };

    if success {
        let body = SetupSuccessResponse {
            status: "success",
            message: tr("Authorization successful."),
        };
        (StatusCode::OK, Json(body)).into_response()
    } else {
        let form_data = SetupFailureFormData {
            email: email.clone(),
            display_name: form.display_name.clone().unwrap_or_default(),
            imap_server: form.imap_server.clone(),
            imap_port: imap_port.to_string(),
            smtp_server: form.smtp_server.clone().unwrap_or_default(),
            smtp_port: smtp_port_raw,
            password: form.password.clone(),
        };

        let body = SetupFailureResponse {
            status: "failure",
            message,
            form_data,
        };

        (StatusCode::UNAUTHORIZED, Json(body)).into_response()
    }
}

pub async fn preview_mailboxes(Json(payload): Json<MailboxPreviewRequest>) -> impl IntoResponse {
    let imap_port: u16 = payload
        .imap_port
        .as_deref()
        .map(|s| s.trim())
        .and_then(|s| s.parse().ok())
        .unwrap_or(143);
    let ssl_mode = payload
        .ssl_mode
        .as_deref()
        .map(|s| s.trim())
        .unwrap_or("STARTTLS");

    match imap_client::preview_mailboxes(
        payload.imap_server.trim(),
        payload.email.trim(),
        payload.password.trim(),
        imap_port,
        false,
        ssl_mode,
    )
    .await
    {
        Ok(mailboxes) => {
            let mut folders = Vec::new();
            let mut labels = Vec::new();

            for mailbox in &mailboxes {
                let lower = mailbox.to_lowercase();
                if lower.starts_with("labels/")
                    || lower.starts_with("labels/")
                    || lower.starts_with("[labels]/")
                {
                    labels.push(mailbox.clone());
                } else {
                    folders.push(mailbox.clone());
                }
            }

            (
                StatusCode::OK,
                Json(MailboxPreviewResponse {
                    mailboxes,
                    folders,
                    labels,
                }),
            )
                .into_response()
        }
        Err(err) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({
                "status": "error",
                "message": err
            })),
        )
            .into_response(),
    }
}

pub async fn finalize_account(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<FinalizeAccountBody>,
) -> Result<Json<FinalizeSuccessResponse>, AppError> {
    let account: FinalizeAccountData = match payload.account {
        Some(a) => a,
        None => {
            return Err(AppError::BadRequest(tr("No data provided")));
        }
    };

    let language = payload.language.unwrap_or_else(|| "en".to_string());
    let font = payload.font.unwrap_or_else(|| "Arial".to_string());
    let theme = payload.theme.unwrap_or_else(|| "SYSTEM".to_string());
    let offline_config = payload.offline;

    let email = account.email.trim().to_string();
    let display_name = account
        .display_name
        .as_deref()
        .map(|s| s.trim().to_string());
    let imap_server = account.imap_server.as_deref().map(|s| s.trim().to_string());
    let imap_port: i64 = account
        .imap_port
        .as_deref()
        .map(|s| s.trim())
        .and_then(|p| p.parse().ok())
        .unwrap_or(143);
    let smtp_server = account.smtp_server.as_deref().map(|s| s.trim().to_string());
    let smtp_port: Option<i64> = account
        .smtp_port
        .as_deref()
        .map(|s| s.trim())
        .and_then(|p| p.parse().ok());
    let password = account.password.as_deref().map(|s| s.trim().to_string());
    let ssl_mode = account
        .ssl_mode
        .as_deref()
        .unwrap_or("STARTTLS")
        .to_string();

    let inner = state.ensure_ready(true).await?;
    let mut tx = inner.general_pool.begin().await?;

    let existing: Option<i64> =
        sqlx::query_scalar("SELECT account_id FROM accounts WHERE email_address = ?")
            .bind(&email)
            .fetch_optional(&mut *tx)
            .await?;

    let account_id: i64 = if let Some(id) = existing {
        sqlx::query(
            r#"
            UPDATE accounts
            SET display_name = ?, provider_type = 'imap', imap_host = ?, imap_port = ?,
                smtp_host = ?, smtp_port = ?, language = ?, theme = ?, font = ?, auth_token = ?, ssl_mode = ?
            WHERE email_address = ?
            "#,
        )
        .bind(&display_name)
        .bind(&imap_server)
        .bind(imap_port)
        .bind(&smtp_server)
        .bind(smtp_port)
        .bind(&language)
        .bind(&theme)
        .bind(&font)
        .bind(password.clone())
        .bind(&ssl_mode)
        .bind(&email)
        .execute(&mut *tx)
        .await?;
        id
    } else {
        let res = sqlx::query(
            r#"
            INSERT INTO accounts
                (email_address, display_name, provider_type,
                 imap_host, imap_port, smtp_host, smtp_port, language, theme, font, auth_token, ssl_mode)
            VALUES (?, ?, 'imap', ?, ?, ?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(&email)
        .bind(&display_name)
        .bind(&imap_server)
        .bind(imap_port)
        .bind(&smtp_server)
        .bind(smtp_port)
        .bind(&language)
        .bind(&theme)
        .bind(&font)
        .bind(password)
        .bind(&ssl_mode)
        .execute(&mut *tx)
        .await?;
        res.last_insert_rowid()
    };

    tx.commit().await?;

    let _ = crate::db::get_user_db_pool(&state, account_id).await?;

    offline_routes::save_offline_setup(&state, account_id, offline_config).await?;
    offline_routes::spawn_initial_sync(state.clone(), account_id);

    let resp = FinalizeSuccessResponse {
        status: "success",
        message: tr("Account finalized successfully."),
        account_id,
    };

    Ok(Json(resp))
}

pub async fn set_account_theme(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(account_id): axum::extract::Path<i64>,
    Json(payload): Json<SetThemeBody>,
) -> Result<impl IntoResponse, AppError> {
    let theme = payload.theme.trim();
    if theme.is_empty() {
        return Err(AppError::BadRequest(tr("No data provided")));
    }

    sqlx::query("UPDATE accounts SET theme = ? WHERE account_id = ?")
        .bind(theme)
        .bind(account_id)
        .execute(&state.ensure_ready(false).await?.general_pool)
        .await?;

    Ok((StatusCode::OK, Json(serde_json::json!({ "status": "success" }))))
}

pub async fn set_account_font(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(account_id): axum::extract::Path<i64>,
    Json(payload): Json<SetFontBody>,
) -> Result<impl IntoResponse, AppError> {
    let font = payload.font.trim();
    if font.is_empty() {
        return Err(AppError::BadRequest(tr("No data provided")));
    }

    sqlx::query("UPDATE accounts SET font = ? WHERE account_id = ?")
        .bind(font)
        .bind(account_id)
        .execute(&state.ensure_ready(false).await?.general_pool)
        .await?;

    Ok((StatusCode::OK, Json(serde_json::json!({ "status": "success" }))))
}

pub async fn set_account_layout(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(account_id): axum::extract::Path<i64>,
    Json(payload): Json<SetLayoutBody>,
) -> Result<impl IntoResponse, AppError> {
    let layout = payload.layout.trim();
    if layout.is_empty() {
        return Err(AppError::BadRequest(tr("No data provided")));
    }

    sqlx::query("UPDATE accounts SET layout = ? WHERE account_id = ?")
        .bind(layout)
        .bind(account_id)
        .execute(&state.ensure_ready(false).await?.general_pool)
        .await?;

    Ok((StatusCode::OK, Json(serde_json::json!({ "status": "success" }))))
}

pub async fn set_mailbox_count_display(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(account_id): axum::extract::Path<i64>,
    Json(payload): Json<SetMailboxCountDisplayBody>,
) -> Result<impl IntoResponse, AppError> {
    let mode = payload.mode.trim().to_lowercase();
    if !matches!(
        mode.as_str(),
        "unread_only" | "total_only" | "both" | "none"
    ) {
        return Err(AppError::BadRequest(tr("Invalid display mode")));
    }

    sqlx::query("UPDATE accounts SET mailbox_count_display = ? WHERE account_id = ?")
        .bind(&mode)
        .bind(account_id)
        .execute(&state.ensure_ready(false).await?.general_pool)
        .await?;

    Ok((StatusCode::OK, Json(serde_json::json!({ "status": "success" }))))
}

pub async fn set_conversation_view(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(account_id): axum::extract::Path<i64>,
    Json(payload): Json<SetConversationViewBody>,
) -> Result<impl IntoResponse, AppError> {
    let mode = payload.mode.trim().to_lowercase();
    if !matches!(mode.as_str(), "messages" | "threads") {
        return Err(AppError::BadRequest(tr("Invalid display mode")));
    }

    let pool = &state.ensure_ready(false).await?.general_pool;
    let existing_order: Option<String> =
        sqlx::query_scalar("SELECT thread_order FROM accounts WHERE account_id = ?")
            .bind(account_id)
            .fetch_optional(pool)
            .await
            .ok()
            .flatten();

    let order_raw = payload
        .thread_order
        .as_deref()
        .unwrap_or_default()
        .trim()
        .to_lowercase();
    let thread_order = if order_raw.is_empty() {
        existing_order.unwrap_or_else(|| "asc".to_string())
    } else {
        order_raw
    };

    if !matches!(thread_order.as_str(), "asc" | "desc") {
        return Err(AppError::BadRequest(tr("Invalid sort order")));
    }

    sqlx::query(
        "UPDATE accounts SET conversation_view = ?, thread_order = ? WHERE account_id = ?",
    )
    .bind(&mode)
    .bind(&thread_order)
    .bind(account_id)
    .execute(pool)
    .await?;

    Ok((StatusCode::OK, Json(serde_json::json!({ "status": "success" }))))
}

pub async fn set_mailbox_order(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(account_id): axum::extract::Path<i64>,
    Json(payload): Json<SetOrderBody>,
) -> Result<impl IntoResponse, AppError> {
    let order_json = serde_json::to_string(&payload.order).unwrap_or_else(|_| "[]".to_string());
    
    sqlx::query("UPDATE accounts SET mailbox_order = ? WHERE account_id = ?")
        .bind(order_json)
        .bind(account_id)
        .execute(&state.ensure_ready(false).await?.general_pool)
        .await?;

    Ok((StatusCode::OK, Json(serde_json::json!({ "status": "success" }))))
}

pub async fn set_label_order(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(account_id): axum::extract::Path<i64>,
    Json(payload): Json<SetOrderBody>,
) -> Result<impl IntoResponse, AppError> {
    let order_json = serde_json::to_string(&payload.order).unwrap_or_else(|_| "[]".to_string());
    
    sqlx::query("UPDATE accounts SET label_order = ? WHERE account_id = ?")
        .bind(order_json)
        .bind(account_id)
        .execute(&state.ensure_ready(false).await?.general_pool)
        .await?;

    Ok((StatusCode::OK, Json(serde_json::json!({ "status": "success" }))))
}

pub async fn get_account_settings(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(account_id): axum::extract::Path<i64>,
) -> Result<Json<AccountSettingsResponse>, AppError> {
    let row = sqlx::query(
        r#"
        SELECT account_id, email_address, display_name, imap_host, imap_port,
               smtp_host, smtp_port, ssl_mode, font, layout, mailbox_order, label_order,
               mailbox_count_display, conversation_view, thread_order
        FROM accounts WHERE account_id = ?
        "#,
    )
    .bind(account_id)
    .fetch_optional(&state.ensure_ready(false).await?.general_pool)
    .await?;

    let row = row.ok_or_else(|| AppError::BadRequest(tr("Account not found")))?;

    use sqlx::Row;
    Ok(Json(AccountSettingsResponse {
        account_id: row.try_get("account_id").unwrap_or(account_id),
        email_address: row.try_get("email_address").ok(),
        display_name: row.try_get("display_name").ok(),
        imap_server: row.try_get("imap_host").ok(),
        imap_port: row.try_get("imap_port").ok(),
        smtp_server: row.try_get("smtp_host").ok(),
        smtp_port: row.try_get("smtp_port").ok(),
        ssl_mode: row.try_get("ssl_mode").ok(),
        font: row.try_get("font").ok(),
        layout: row.try_get("layout").ok(),
        mailbox_order: row.try_get("mailbox_order").ok(),
        label_order: row.try_get("label_order").ok(),
        mailbox_count_display: row.try_get("mailbox_count_display").ok(),
        conversation_view: row.try_get("conversation_view").ok(),
        thread_order: row.try_get("thread_order").ok(),
    }))
}

pub async fn update_account_settings(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(account_id): axum::extract::Path<i64>,
    Json(payload): Json<UpdateAccountSettingsBody>,
) -> Result<impl IntoResponse, AppError> {
    let pool = &state.ensure_ready(false).await?.general_pool;

    // Retrieve existing values
    let row = sqlx::query(
        "SELECT imap_host, imap_port, smtp_host, smtp_port, ssl_mode, auth_token FROM accounts WHERE account_id = ?",
    )
    .bind(account_id)
    .fetch_optional(pool)
    .await?;

    let row = row.ok_or_else(|| AppError::BadRequest(tr("Account not found")))?;
    use sqlx::Row;

    let imap_server = payload.imap_server
        .as_deref().map(str::trim).map(str::to_string)
        .or_else(|| row.try_get::<Option<String>, _>("imap_host").ok().flatten())
        .unwrap_or_default();
    let imap_port: i64 = payload.imap_port
        .as_deref().map(str::trim)
        .and_then(|s| s.parse().ok())
        .or_else(|| row.try_get::<Option<i64>, _>("imap_port").ok().flatten())
        .unwrap_or(143);
    let smtp_server = payload.smtp_server
        .as_deref().map(str::trim).map(str::to_string)
        .or_else(|| row.try_get::<Option<String>, _>("smtp_host").ok().flatten())
        .unwrap_or_default();
    let smtp_port: Option<i64> = payload.smtp_port
        .as_deref().map(str::trim)
        .and_then(|s| s.parse().ok())
        .or_else(|| row.try_get::<Option<i64>, _>("smtp_port").ok().flatten());
    let ssl_mode = payload.ssl_mode
        .as_deref().map(str::trim).map(str::to_string)
        .or_else(|| row.try_get::<Option<String>, _>("ssl_mode").ok().flatten())
        .unwrap_or_else(|| "STARTTLS".to_string());
    let password = payload.password
        .as_deref().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
        .or_else(|| row.try_get::<Option<String>, _>("auth_token").ok().flatten());

    sqlx::query(
        r#"
        UPDATE accounts
        SET imap_host = ?, imap_port = ?, smtp_host = ?, smtp_port = ?,
            ssl_mode = ?, auth_token = ?
        WHERE account_id = ?
        "#,
    )
    .bind(&imap_server)
    .bind(imap_port)
    .bind(&smtp_server)
    .bind(smtp_port)
    .bind(&ssl_mode)
    .bind(password)
    .bind(account_id)
    .execute(pool)
    .await?;

    Ok((StatusCode::OK, Json(serde_json::json!({ "status": "success" }))))
}

pub async fn delete_account(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(account_id): axum::extract::Path<i64>,
    Json(payload): Json<DeleteAccountBody>,
) -> Result<impl IntoResponse, AppError> {
    let pool = &state.ensure_ready(false).await?.general_pool;

    let row = sqlx::query("SELECT auth_token FROM accounts WHERE account_id = ?")
        .bind(account_id)
        .fetch_optional(pool)
        .await?;

    let row = row.ok_or_else(|| AppError::BadRequest(tr("Account not found")))?;
    
    use sqlx::Row;
    let stored_pw: Option<String> = row.try_get("auth_token").ok().flatten();

    let password = payload.password.as_deref().unwrap_or("");
    let stored_pw_str = stored_pw.as_deref().unwrap_or("");
    
    if stored_pw_str != password {
        return Err(AppError::BadRequest(tr("Incorrect password")));
    }

    sqlx::query("DELETE FROM accounts WHERE account_id = ?")
        .bind(account_id)
        .execute(pool)
        .await?;

    // Also remove from user_db_pools if we can (though it requires locking and we might not strictly need it if we're shutting down or ignoring it).
    // The easiest is just removing files.
    let db_path = state.databases_dir.join(format!("{account_id}.db"));
    let db_shm = state.databases_dir.join(format!("{account_id}.db-shm"));
    let db_wal = state.databases_dir.join(format!("{account_id}.db-wal"));
    let db_enc = state.databases_dir.join(format!("{account_id}.db.enc"));
    
    let _ = tokio::fs::remove_file(db_path).await;
    let _ = tokio::fs::remove_file(db_shm).await;
    let _ = tokio::fs::remove_file(db_wal).await;
    let _ = tokio::fs::remove_file(db_enc).await;

    Ok((StatusCode::OK, Json(serde_json::json!({ "status": "success", "message": "Account deleted." }))))
}
