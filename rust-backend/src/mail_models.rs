use serde::{Deserialize, Serialize};

#[derive(Serialize, Clone)]
pub struct MailPreview {
    pub id: String,
    pub name: String,
    pub address: String,
    pub subject: String,
    pub date: String,
    pub seen: bool,
    pub flagged: bool,
    pub recipient_to: String,
    pub size: usize,
    pub importance: i32,
    pub content_type: String,
    pub category: String,
    pub labels: Vec<String>,
}

#[derive(Serialize)]
pub struct MailListResponse {
    pub total_count: usize,
    pub mails: Vec<MailPreview>,
}

#[derive(Serialize)]
pub struct MailboxListResponse {
    pub mailboxes: Vec<String>,
    pub folders: Vec<String>,
    pub labels: Vec<String>,
}

pub fn is_label_mailbox(mailbox: &str) -> bool {
    let lower = mailbox.trim().to_lowercase();
    lower.starts_with("labels/")
        || lower.starts_with("etiketler/")
        || lower.starts_with("[labels]/")
}

pub fn label_key_from_mailbox(mailbox: &str) -> Option<String> {
    let trimmed = mailbox.trim();
    let lower = trimmed.to_lowercase();

    let key = if lower.starts_with("labels/") {
        &trimmed["Labels/".len()..]
    } else if lower.starts_with("etiketler/") {
        &trimmed["Etiketler/".len()..]
    } else if lower.starts_with("[labels]/") {
        &trimmed["[Labels]/".len()..]
    } else {
        return None;
    };

    let key = key.trim_matches('/').trim();
    if key.is_empty() {
        None
    } else {
        Some(key.to_string())
    }
}

pub fn merge_mailbox_label_into_preview(mail: &mut MailPreview, mailbox: &str) {
    let Some(label_key) = label_key_from_mailbox(mailbox) else {
        return;
    };

    let exists = mail
        .labels
        .iter()
        .any(|existing| existing.eq_ignore_ascii_case(&label_key));
    if !exists {
        mail.labels.push(label_key.clone());
    }

    if mail.category.trim().is_empty() {
        mail.category = label_key;
    }
}

pub fn split_mailboxes(mailboxes: &[String]) -> (Vec<String>, Vec<String>) {
    let mut folders = Vec::new();
    let mut labels = Vec::new();

    for mailbox in mailboxes {
        if is_label_mailbox(mailbox) {
            labels.push(mailbox.clone());
        } else {
            folders.push(mailbox.clone());
        }
    }

    (folders, labels)
}

impl MailboxListResponse {
    pub fn from_mailboxes(mailboxes: Vec<String>) -> Self {
        let (folders, labels) = split_mailboxes(&mailboxes);
        Self {
            mailboxes,
            folders,
            labels,
        }
    }
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
    pub cc: String,
    pub bcc: String,
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

#[cfg(test)]
mod tests {
    use super::{
        MailPreview, MailboxListResponse, is_label_mailbox, label_key_from_mailbox,
        merge_mailbox_label_into_preview, split_mailboxes,
    };

    #[test]
    fn label_classifier_matches_labels_namespace() {
        assert!(is_label_mailbox("Labels/Work"));
    }

    #[test]
    fn label_classifier_matches_turkish_labels_namespace() {
        assert!(is_label_mailbox("Etiketler/Projeler"));
    }

    #[test]
    fn label_classifier_keeps_regular_mailboxes_as_folders() {
        let mailboxes = vec!["INBOX".to_string(), "Sent".to_string()];
        let (folders, labels) = split_mailboxes(&mailboxes);
        assert_eq!(folders, mailboxes);
        assert!(labels.is_empty());
    }

    #[test]
    fn mailbox_response_preserves_raw_mailboxes() {
        let mailboxes = vec!["INBOX".to_string(), "Labels/Work".to_string()];
        let response = MailboxListResponse::from_mailboxes(mailboxes.clone());
        assert_eq!(response.mailboxes, mailboxes);
        assert_eq!(response.folders, vec!["INBOX".to_string()]);
        assert_eq!(response.labels, vec!["Labels/Work".to_string()]);
    }

    #[test]
    fn label_key_is_extracted_from_label_mailbox() {
        assert_eq!(label_key_from_mailbox("Labels/Work/Urgent").as_deref(), Some("Work/Urgent"));
    }

    #[test]
    fn merge_mailbox_label_adds_missing_label_to_preview() {
        let mut preview = MailPreview {
            id: "1".to_string(),
            name: String::new(),
            address: String::new(),
            subject: String::new(),
            date: String::new(),
            seen: false,
            flagged: false,
            recipient_to: String::new(),
            size: 0,
            importance: 0,
            content_type: String::new(),
            category: String::new(),
            labels: Vec::new(),
        };

        merge_mailbox_label_into_preview(&mut preview, "Labels/Work");
        assert_eq!(preview.labels, vec!["Work".to_string()]);
        assert_eq!(preview.category, "Work".to_string());
    }
}
