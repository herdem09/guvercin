use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("Database error (path: {1}): {0}")]
    Database(#[source] sqlx::Error, String),
    #[error("Bad request: {0}")]
    BadRequest(String),
    #[error("Keyring unavailable: {0}")]
    KeyringUnavailable(String),
    #[error("Keyring denied: {0}")]
    KeyringDenied(String),
}

impl AppError {
    pub fn db(err: sqlx::Error, path: impl Into<String>) -> Self {
        AppError::Database(err, path.into())
    }
}

impl From<sqlx::Error> for AppError {
    fn from(err: sqlx::Error) -> Self {
        AppError::Database(err, "unknown".to_string())
    }
}

#[derive(Serialize)]
struct ErrorBody {
    status: &'static str,
    message: String,
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            AppError::Database(e, path) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Database error (path: {path}): {e}"),
            ),
            AppError::BadRequest(msg) => (StatusCode::BAD_REQUEST, msg),
            AppError::KeyringUnavailable(msg) => (StatusCode::PRECONDITION_REQUIRED, msg),
            AppError::KeyringDenied(msg) => (StatusCode::FORBIDDEN, msg),
        };

        let body = Json(ErrorBody {
            status: "error",
            message,
        });

        (status, body).into_response()
    }
}
