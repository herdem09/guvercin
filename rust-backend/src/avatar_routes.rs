/// avatar_routes.rs
///
/// GET /api/avatar/:account_id?email=user@example.com
///
/// Returns:
///   200  – image bytes (cached avatar, with correct Content-Type)
///   202  – resolution kicked off in background; client should retry
///   204  – no avatar found (negative cache); client should use initials
///   400  – missing / malformed email query param

use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{header::CONTENT_TYPE, StatusCode},
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use std::sync::Arc;
use tokio::fs;

use crate::{avatar, db::AppState};

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
    let pool = &state.general_pool;

    // ── 1. Negative cache hit → 204 ───────────────────
    if avatar::is_negative_cached(pool, &hash).await {
        return StatusCode::NO_CONTENT.into_response();
    }

    // ── 2. Positive cache hit → stream file ───────────
    if let Ok(Some(cached)) = avatar::query_cache(pool, &hash).await {
        match fs::read(&cached.file_path).await {
            Ok(data) => {
                return Response::builder()
                    .status(StatusCode::OK)
                    .header(CONTENT_TYPE, cached.content_type)
                    .header("Cache-Control", "public, max-age=86400")
                    .body(Body::from(data))
                    .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response());
            }
            Err(_) => {
                // Cache entry points to a missing file – fall through to re-resolve.
            }
        }
    }

    // ── 3. Cache miss → spawn background waterfall, return 202 ──
    avatar::spawn_resolve(email, account_id, state);
    StatusCode::ACCEPTED.into_response()
}
