use std::{path::PathBuf, sync::Arc};

use axum::{
    extract::{Json, State},
    http::StatusCode,
    response::IntoResponse,
};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::{db::AppState, error::AppError};

/* ─── Persistent settings file ──────────────────────────────────── */

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SecuritySettings {
    /// Always true (encryption is always on). Stored for UI parity.
    #[serde(default = "default_true")]
    pub data_encrypted: bool,
    /// none | pc_only | both | account_only
    #[serde(default = "default_login_policy")]
    pub login_policy: String,
}

fn default_true() -> bool {
    true
}
fn default_login_policy() -> String {
    "pc_only".to_string()
}

impl Default for SecuritySettings {
    fn default() -> Self {
        Self {
            data_encrypted: true,
            login_policy: "pc_only".to_string(),
        }
    }
}

fn settings_path(state: &AppState) -> PathBuf {
    state.databases_dir.join("security_settings.json")
}

async fn load_settings(state: &AppState) -> SecuritySettings {
    let path = settings_path(state);
    match tokio::fs::read_to_string(&path).await {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => SecuritySettings::default(),
    }
}

async fn save_settings(state: &AppState, settings: &SecuritySettings) -> std::io::Result<()> {
    let path = settings_path(state);
    let json = serde_json::to_string_pretty(settings).unwrap_or_default();
    tokio::fs::write(&path, json).await
}

/* ─── Handlers ───────────────────────────────────────────────────── */

pub async fn get_security_settings(
    State(state): State<Arc<AppState>>,
) -> Json<SecuritySettings> {
    Json(load_settings(&state).await)
}

pub async fn put_security_settings(
    State(state): State<Arc<AppState>>,
    Json(body): Json<SecuritySettings>,
) -> impl IntoResponse {
    // Normalize: data_encrypted is always forced true
    let to_save = SecuritySettings {
        data_encrypted: true,
        login_policy: body.login_policy.clone(),
    };

    match save_settings(&state, &to_save).await {
        Ok(_) => (
            StatusCode::OK,
            Json(json!({ "status": "ok", "settings": to_save })),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "status": "error", "message": e.to_string() })),
        )
            .into_response(),
    }
}

/* ─── Password verification ──────────────────────────────────────── */

#[derive(Deserialize)]
pub struct VerifyPasswordBody {
    pub account_id: i64,
    pub password: String,
}

pub async fn verify_password(
    State(state): State<Arc<AppState>>,
    Json(body): Json<VerifyPasswordBody>,
) -> impl IntoResponse {
    // We need the DB to read auth_token
    let inner = match state.ensure_ready(false).await {
        Ok(i) => i,
        Err(e) => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({ "ok": false, "error": e.to_string() })),
            )
                .into_response();
        }
    };

    let stored_pw: Option<String> =
        match sqlx::query_scalar("SELECT auth_token FROM accounts WHERE account_id = ?")
            .bind(body.account_id)
            .fetch_optional(&inner.general_pool)
            .await
        {
            Ok(r) => r,
            Err(e) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({ "ok": false, "error": e.to_string() })),
                )
                    .into_response();
            }
        };

    let matches = stored_pw
        .as_deref()
        .map(|db_pw| db_pw == body.password.as_str())
        .unwrap_or(false);

    if matches {
        (StatusCode::OK, Json(json!({ "ok": true }))).into_response()
    } else {
        (StatusCode::OK, Json(json!({ "ok": false, "error": "wrong_password" }))).into_response()
    }
}

/* ─── AppError compat ────────────────────────────────────────────── */
impl From<AppError> for (StatusCode, Json<serde_json::Value>) {
    fn from(e: AppError) -> Self {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "status": "error", "message": e.to_string() })),
        )
    }
}
