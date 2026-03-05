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
        AccountSummary, AccountsResponse, FinalizeAccountBody, FinalizeAccountData,
        FinalizeSuccessResponse, MailboxPreviewRequest, MailboxPreviewResponse, SetupAccountForm,
        SetupFailureFormData, SetupFailureResponse, SetupSuccessResponse,
    },
    offline_routes,
};

pub async fn health_check() -> impl IntoResponse {
    (StatusCode::OK, "OK")
}

pub async fn get_accounts(
    State(state): State<Arc<AppState>>,
) -> Result<Json<AccountsResponse>, AppError> {
    let rows = sqlx::query_as::<_, AccountSummary>(
        r#"
        SELECT account_id, email_address, display_name, provider_type,
               imap_host, imap_port, smtp_host, smtp_port, sync_status,
               last_sync_time, language, theme, font
        FROM accounts
        "#,
    )
    .fetch_all(&state.general_pool)
    .await?;

    Ok(Json(AccountsResponse { accounts: rows }))
}

pub async fn setup_account(
    State(state): State<Arc<AppState>>,
    Form(form): Form<SetupAccountForm>,
) -> impl IntoResponse {
    let email = form.email_address.trim().to_string();

    // Check existing account
    if let Ok(existing) =
        sqlx::query_scalar::<_, i64>("SELECT account_id FROM accounts WHERE email_address = ?")
            .bind(&email)
            .fetch_optional(&state.general_pool)
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
                    || lower.starts_with("etiketler/")
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
    let ai_config = payload.ai;
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

    let mut tx = state.general_pool.begin().await?;

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
                smtp_host = ?, smtp_port = ?, language = ?, font = ?, auth_token = ?, ssl_mode = ?
            WHERE email_address = ?
            "#,
        )
        .bind(&display_name)
        .bind(&imap_server)
        .bind(imap_port)
        .bind(&smtp_server)
        .bind(smtp_port)
        .bind(&language)
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
                 imap_host, imap_port, smtp_host, smtp_port, language, font, auth_token, ssl_mode)
            VALUES (?, ?, 'imap', ?, ?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(&email)
        .bind(&display_name)
        .bind(&imap_server)
        .bind(imap_port)
        .bind(&smtp_server)
        .bind(smtp_port)
        .bind(&language)
        .bind(&font)
        .bind(password)
        .bind(&ssl_mode)
        .execute(&mut *tx)
        .await?;
        res.last_insert_rowid()
    };

    tx.commit().await?;

    // Ensure user DB exists, getting its pool so we can write AI settings into it
    let user_pool = crate::db::get_user_db_pool(&state, account_id).await?;

    // AI config
    if let Some(ai) = ai_config {
        let mut user_tx = user_pool.begin().await?;
        sqlx::query(
            r#"
            INSERT INTO ai (model_name, type, api_key_server_url, base_url_context_window)
            VALUES (?, ?, ?, ?)
            "#,
        )
        .bind(ai.model_name)
        .bind(ai.r#type)
        .bind(ai.api_key_server_url)
        .bind(ai.base_url_context_window)
        .execute(&mut *user_tx)
        .await?;
        user_tx.commit().await?;
    }

    offline_routes::save_offline_setup(&state, account_id, offline_config).await?;
    offline_routes::spawn_initial_sync(state.clone(), account_id);

    let resp = FinalizeSuccessResponse {
        status: "success",
        message: tr("Account finalized successfully."),
        account_id,
    };

    Ok(Json(resp))
}
