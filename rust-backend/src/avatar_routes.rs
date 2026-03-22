
use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{header::CONTENT_TYPE, StatusCode},
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use std::sync::Arc;
use crate::{avatar, crypto, db::AppState};

#[derive(Deserialize)]
pub struct AvatarQuery {
    pub email: String,
}

pub async fn get_avatar(
    State(state): State<Arc<AppState>>,
    Path(account_id): Path<i64>,
    Query(q): Query<AvatarQuery>,
) -> impl IntoResponse {
    let email = q.email.trim().to_lowercase();
    if email.is_empty() || !email.contains('@') {
        return (StatusCode::BAD_REQUEST, "Missing or invalid email").into_response();
    }

    let hash = avatar::email_hash(&email);
    let inner = match state.ensure_ready(false).await {
        Ok(inner) => inner,
        Err(e) => return e.into_response(),
    };
    let pool = &inner.general_pool;

    if avatar::is_negative_cached(pool, &hash).await {
        return StatusCode::NO_CONTENT.into_response();
    }

    if let Ok(Some(cached)) = avatar::query_cache(pool, &hash).await {
        let data = if let Some(crypto) = inner.crypto.as_ref() {
            let key = match crypto.file_key("avatar-cache") {
                Ok(k) => k,
                Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
            };
            match crate::crypto::decrypt_file_to_bytes(&key, cached.file_path.as_ref()).await {
                Ok(d) => d,
                Err(_) => {
                    // Fall through to re-resolve
                    avatar::spawn_resolve(email, account_id, state);
                    return StatusCode::ACCEPTED.into_response();
                }
            }
        } else {
            // Unencrypted mode: read raw file
            match tokio::fs::read(cached.file_path.as_str()).await {
                Ok(d) => d,
                Err(_) => {
                    avatar::spawn_resolve(email, account_id, state);
                    return StatusCode::ACCEPTED.into_response();
                }
            }
        };

        return Response::builder()
            .status(StatusCode::OK)
            .header(CONTENT_TYPE, cached.content_type)
            .header("Cache-Control", "public, max-age=86400")
            .body(Body::from(data))
            .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response());
    }

    avatar::spawn_resolve(email, account_id, state);
    StatusCode::ACCEPTED.into_response()
}
