use serde::{Deserialize, Serialize};
use sqlx::FromRow;

#[derive(Serialize, FromRow)]
pub struct AccountSummary {
    pub account_id: i64,
    pub email_address: Option<String>,
    pub display_name: Option<String>,
    pub provider_type: String,
    pub imap_host: Option<String>,
    pub imap_port: Option<i64>,
    pub smtp_host: Option<String>,
    pub smtp_port: Option<i64>,
    pub sync_status: Option<i64>,
    pub last_sync_time: Option<String>,
    pub language: Option<String>,
    pub theme: Option<String>,
    pub font: Option<String>,
}

#[derive(Serialize)]
pub struct AccountsResponse {
    pub accounts: Vec<AccountSummary>,
}

#[derive(Deserialize)]
pub struct SetupAccountForm {
    #[serde(rename = "EMAIL_ADDRESS")]
    pub email_address: String,
    #[serde(rename = "DISPLAY_NAME")]
    pub display_name: Option<String>,
    #[serde(rename = "IMAP_SERVER")]
    pub imap_server: String,
    #[serde(rename = "IMAP_PORT")]
    pub imap_port: Option<String>,
    #[serde(rename = "SMTP_SERVER")]
    pub smtp_server: Option<String>,
    #[serde(rename = "SMTP_PORT")]
    pub smtp_port: Option<String>,
    #[serde(rename = "PASSWORD")]
    pub password: String,
    #[serde(rename = "SKIP_AUTH")]
    pub skip_auth: Option<String>,
    #[serde(rename = "SSL_MODE")]
    pub ssl_mode: Option<String>,
}

#[derive(Serialize)]
pub struct SetupSuccessResponse {
    pub status: &'static str,
    pub message: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailboxPreviewRequest {
    pub email: String,
    pub imap_server: String,
    pub imap_port: Option<String>,
    pub password: String,
    pub ssl_mode: Option<String>,
}

#[derive(Serialize)]
pub struct MailboxPreviewResponse {
    pub mailboxes: Vec<String>,
    pub folders: Vec<String>,
    pub labels: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupFailureFormData {
    pub email: String,
    pub display_name: String,
    pub imap_server: String,
    pub imap_port: String,
    pub smtp_server: String,
    pub smtp_port: String,
    pub password: String,
}

#[derive(Serialize)]
pub struct SetupFailureResponse {
    pub status: &'static str,
    pub message: String,
    #[serde(rename = "formData")]
    pub form_data: SetupFailureFormData,
}

#[derive(Deserialize)]
pub struct FinalizeAccountBody {
    pub account: Option<FinalizeAccountData>,
    pub language: Option<String>,
    pub font: Option<String>,
    pub ai: Option<AiConfig>,
    pub offline: Option<OfflineSetupPayload>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FinalizeAccountData {
    pub email: String,
    pub display_name: Option<String>,
    pub imap_server: Option<String>,
    pub imap_port: Option<String>,
    pub smtp_server: Option<String>,
    pub smtp_port: Option<String>,
    pub password: Option<String>,
    pub ssl_mode: Option<String>,
}

#[derive(Deserialize)]
pub struct AiConfig {
    pub r#type: Option<bool>,
    pub model_name: Option<String>,
    pub api_key_server_url: Option<String>,
    pub base_url_context_window: Option<String>,
}

#[derive(Deserialize, Serialize, Clone)]
pub struct OfflineSetupPayload {
    pub enabled: bool,
    #[serde(default)]
    pub download_rules: Vec<DownloadRuleInput>,
    pub initial_sync_policy: InitialSyncPolicyInput,
    #[serde(default = "default_cache_raw_rfc822")]
    pub cache_raw_rfc822: bool,
}

fn default_cache_raw_rfc822() -> bool {
    true
}

#[derive(Deserialize, Serialize, Clone)]
pub struct DownloadRuleInput {
    pub node_path: String,
    pub node_type: String,
    pub rule_type: String,
    pub source: String,
}

#[derive(Deserialize, Serialize, Clone)]
pub struct InitialSyncPolicyInput {
    pub mode: String,
    pub value: Option<i64>,
}

#[derive(Serialize)]
pub struct FinalizeSuccessResponse {
    pub status: &'static str,
    pub message: String,
    pub account_id: i64,
}

#[derive(Serialize, FromRow)]
pub struct DownloadRuleRecord {
    pub id: i64,
    pub node_path: String,
    pub node_type: String,
    pub rule_type: String,
    pub source: String,
    pub is_active: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Serialize)]
pub struct OfflineConfigResponse {
    pub enabled: bool,
    pub initial_sync_policy: InitialSyncPolicyInput,
    pub download_rules: Vec<DownloadRuleRecord>,
    pub cache_raw_rfc822: bool,
}

#[derive(Deserialize)]
pub struct OfflineActionRequest {
    pub action_type: String,
    pub target_uid: Option<String>,
    pub target_folder: Option<String>,
    pub payload: Option<serde_json::Value>,
}

#[derive(Serialize)]
pub struct OfflineActionResponse {
    pub status: &'static str,
    pub queued_id: i64,
}

#[derive(Serialize)]
pub struct SyncNowResponse {
    pub status: &'static str,
    pub processed: usize,
    pub failed: usize,
}

#[derive(Serialize)]
pub struct OfflineStatusResponse {
    pub network_online: bool,
    pub backend_reachable: bool,
    pub imap_reachable: bool,
    pub smtp_reachable: bool,
    pub queue_depth: i64,
    pub sync_state: String,
    pub last_sync_at: Option<String>,
    pub last_error: Option<String>,
    pub transfer: Option<TransferSnapshot>,
}

#[derive(Serialize, Clone)]
pub struct TransferSnapshot {
    pub receiving: Option<TransferProgress>,
    pub sending: Option<TransferProgress>,
}

#[derive(Serialize, Clone)]
pub struct TransferProgress {
    /// "receiving" or "sending"
    pub direction: String,
    /// e.g. "emails", "queue"
    pub resource: String,
    pub mailbox: Option<String>,
    pub total: Option<i64>,
    pub done: i64,
    pub remaining: Option<i64>,
    /// Optional human-friendly detail like "mark_read" or "sync INBOX".
    pub detail: Option<String>,
    /// Unix epoch milliseconds, for UI "stale" handling.
    pub updated_at_ms: i64,
}
