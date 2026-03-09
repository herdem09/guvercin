mod avatar;
mod avatar_routes;
mod db;
mod error;
mod i18n;
mod imap_client;
mod imap_session;
mod mail_models;
mod mail_routes;
mod models;
mod offline_routes;
mod routes;

use axum::{
    routing::{delete, get, post},
    Router,
};
use std::{net::SocketAddr, sync::Arc};
use tokio::net::TcpListener;
use tower_http::{
    cors::{Any, CorsLayer},
    trace::TraceLayer,
};
use tracing_subscriber::{EnvFilter, FmtSubscriber};

use crate::db::AppState;
use crate::imap_session::ImapState;
use crate::mail_routes::MailAppState;

use std::path::PathBuf;

pub async fn run(db_dir: Option<PathBuf>) -> anyhow::Result<()> {
    println!("Guvercin Backend v1.1 Starting...");
    dotenvy::dotenv().ok();

    let subscriber = FmtSubscriber::builder()
        .with_env_filter(EnvFilter::from_default_env())
        .finish();
    tracing::subscriber::set_global_default(subscriber).expect("setting default subscriber failed");

    let db_state = Arc::new(AppState::initialize(db_dir).await?);
    let imap_state = Arc::new(ImapState::new());

    let mail_state = Arc::new(MailAppState {
        _db: db_state.clone(),
        imap: imap_state.clone(),
    });

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    // ── Auth / account routes (use Arc<AppState>) ─────────────────
    let auth_router = Router::new()
        .route("/health", get(routes::health_check))
        .route("/api/auth/accounts", get(routes::get_accounts))
        .route("/api/auth/setup", post(routes::setup_account))
        .route(
            "/api/auth/mailboxes-preview",
            post(routes::preview_mailboxes),
        )
        .route("/api/account/finalize", post(routes::finalize_account))
        .route("/api/avatar/:account_id", get(avatar_routes::get_avatar))
        .with_state(db_state);

    // ── Mail / IMAP routes (use Arc<MailAppState>) ─────────────────
    let mail_router = Router::new()
        .route("/api/mail/connect", post(mail_routes::connect_imap))
        .route(
            "/api/mail/:account_id/connect-stored",
            post(mail_routes::connect_imap_stored),
        )
        .route(
            "/api/mail/:account_id/mailboxes",
            get(mail_routes::get_mailboxes).post(mail_routes::create_mailbox),
        )
        .route(
            "/api/mail/:account_id/list",
            get(mail_routes::get_mail_list),
        )
        .route(
            "/api/mail/:account_id/search-advanced",
            post(mail_routes::search_advanced),
        )
        .route(
            "/api/mail/:account_id/content/:uid",
            get(mail_routes::get_mail_content),
        )
        .route("/api/mail/:account_id/raw/:uid", get(mail_routes::get_mail_raw))
        .route(
            "/api/mail/:account_id/content/:uid/attachments/:attachment_index",
            get(mail_routes::download_attachment),
        )
        .route(
            "/api/mail/:account_id/disconnect",
            delete(mail_routes::disconnect_imap),
        )
        .route(
            "/api/offline/:account_id/config",
            get(offline_routes::get_offline_config).put(offline_routes::put_offline_config),
        )
        .route(
            "/api/offline/:account_id/status",
            get(offline_routes::get_offline_status),
        )
        .route(
            "/api/offline/:account_id/local-mailboxes",
            get(offline_routes::get_local_mailboxes),
        )
        .route(
            "/api/offline/:account_id/actions",
            post(offline_routes::post_offline_action),
        )
        .route(
            "/api/offline/:account_id/sync-now",
            post(offline_routes::sync_now),
        )
        .route(
            "/api/offline/:account_id/local-list",
            get(offline_routes::get_local_mail_list),
        )
        .route(
            "/api/offline/:account_id/search-advanced",
            post(offline_routes::search_advanced),
        )
        .route(
            "/api/offline/:account_id/local-content/:uid",
            get(offline_routes::get_local_mail_content),
        )
        .route(
            "/api/offline/:account_id/local-raw/:uid",
            get(offline_routes::get_local_mail_raw),
        )
        .route(
            "/api/offline/:account_id/local-content/:uid/prefetch-inline",
            post(offline_routes::prefetch_local_inline_assets),
        )
        .route(
            "/api/offline/:account_id/local-content/:uid/attachments/:attachment_index",
            get(offline_routes::download_local_attachment),
        )
        .route(
            "/api/offline/:account_id/inline-assets/:asset_id",
            get(offline_routes::get_inline_asset),
        )
        .with_state(mail_state);

    // ── Merge both routers ─────────────────────────────────────────
    let app = auth_router
        .merge(mail_router)
        .layer(cors)
        .layer(TraceLayer::new_for_http());

    let addr = SocketAddr::from(([0, 0, 0, 0], 5000));
    tracing::info!("Starting Axum server on {}", addr);

    let listener = TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}
