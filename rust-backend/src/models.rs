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

#[derive(Serialize)]
pub struct FinalizeSuccessResponse {
    pub status: &'static str,
    pub message: String,
    pub account_id: i64,
}
