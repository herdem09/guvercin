use serde::{Deserialize, Serialize};

#[derive(Serialize, Clone)]
pub struct MailPreview {
    pub id: String,
    pub name: String,
    pub address: String,
    pub subject: String,
    pub seen: bool,
}

#[derive(Serialize)]
pub struct MailListResponse {
    pub total_count: usize,
    pub mails: Vec<MailPreview>,
}

#[derive(Serialize)]
pub struct MailboxListResponse {
    pub mailboxes: Vec<String>,
}

#[derive(Deserialize)]
pub struct ConnectImapBody {
    pub account_id: i64,
    pub email: String,
    pub password: String,
    pub imap_host: String,
    pub imap_port: u16,
    pub ssl_mode: String,
}

#[derive(Serialize)]
pub struct MailContent {
    pub id: String,
    pub subject: String,
    pub from_name: String,
    pub from_address: String,
    pub date: String,
    pub html_body: String,
    pub plain_body: String,
    pub attachments: Vec<AttachmentInfo>,
}

#[derive(Serialize, Clone)]
pub struct AttachmentInfo {
    pub id: String,
    pub filename: String,
    pub content_type: String,
    pub size: usize,
    pub is_inline: bool,
}
