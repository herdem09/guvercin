use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use lettre::{
    message::{header, header::ContentType, Attachment, MultiPart, SinglePart},
    transport::smtp::authentication::Credentials,
    transport::smtp::client::{Tls, TlsParameters},
    AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor,
};
use serde::{Deserialize, Serialize};
use std::net::IpAddr;
use tracing::{error, info};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum OutgoingMailFormat {
    #[default]
    Plain,
    Html,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum OutgoingAttachmentDisposition {
    #[default]
    Attachment,
    Inline,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct OutgoingAttachment {
    pub filename: String,
    pub content_type: String,
    pub data_base64: String,
    #[serde(default)]
    pub disposition: OutgoingAttachmentDisposition,
    #[serde(default)]
    pub content_id: Option<String>,
}

enum MessageBody {
    Single(SinglePart),
    Multi(MultiPart),
}

fn is_loopback_smtp_host(host: &str) -> bool {
    let host = host.trim();
    if host.eq_ignore_ascii_case("localhost") || host == "::1" {
        return true;
    }
    if let Ok(ip) = host.parse::<IpAddr>() {
        return ip.is_loopback();
    }
    host.starts_with("127.")
}

fn build_local_tls_parameters() -> Result<TlsParameters, String> {
    TlsParameters::builder("localhost".to_string())
        .dangerous_accept_invalid_hostnames(true)
        .dangerous_accept_invalid_certs(true)
        .build()
        .map_err(|e| format!("Failed to build local TLS parameters: {}", e))
}

fn parse_content_type(content_type: &str) -> Result<ContentType, String> {
    ContentType::parse(content_type.trim())
        .map_err(|e| format!("Invalid content type '{}': {}", content_type, e))
}

fn build_plain_part(plain_body: &str) -> SinglePart {
    SinglePart::builder()
        .header(ContentType::TEXT_PLAIN)
        .body(plain_body.to_string())
}

fn build_html_part(html_body: &str) -> SinglePart {
    SinglePart::builder()
        .header(ContentType::TEXT_HTML)
        .body(html_body.to_string())
}

fn decode_attachment_bytes(attachment: &OutgoingAttachment) -> Result<Vec<u8>, String> {
    BASE64_STANDARD
        .decode(attachment.data_base64.trim())
        .map_err(|e| format!("Attachment '{}' is not valid base64: {}", attachment.filename, e))
}

fn build_attachment_part(
    attachment: &OutgoingAttachment,
    force_regular_attachment: bool,
) -> Result<SinglePart, String> {
    let body = decode_attachment_bytes(attachment)?;
    let content_type = parse_content_type(&attachment.content_type)?;
    let filename = if attachment.filename.trim().is_empty() {
        "attachment".to_string()
    } else {
        attachment.filename.trim().to_string()
    };

    if !force_regular_attachment
        && matches!(attachment.disposition, OutgoingAttachmentDisposition::Inline)
    {
        let content_id = attachment
            .content_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| format!("Inline attachment '{}' is missing content_id", filename))?;
        Ok(Attachment::new_inline_with_name(content_id.to_string(), filename).body(body, content_type))
    } else {
        Ok(Attachment::new(filename).body(body, content_type))
    }
}

fn build_message_body(
    format: OutgoingMailFormat,
    plain_body: &str,
    html_body: &str,
    attachments: &[OutgoingAttachment],
) -> Result<MessageBody, String> {
    let plain_part = build_plain_part(plain_body);

    if matches!(format, OutgoingMailFormat::Plain) || html_body.trim().is_empty() {
        if attachments.is_empty() {
            return Ok(MessageBody::Single(plain_part));
        }

        let mut mixed = MultiPart::mixed().singlepart(plain_part);
        for attachment in attachments {
            mixed = mixed.singlepart(build_attachment_part(attachment, true)?);
        }
        return Ok(MessageBody::Multi(mixed));
    }

    let mut inline_attachments = Vec::new();
    let mut regular_attachments = Vec::new();
    for attachment in attachments {
        if matches!(attachment.disposition, OutgoingAttachmentDisposition::Inline) {
            inline_attachments.push(attachment);
        } else {
            regular_attachments.push(attachment);
        }
    }

    let alternative = if inline_attachments.is_empty() {
        MultiPart::alternative()
            .singlepart(plain_part)
            .singlepart(build_html_part(html_body))
    } else {
        let mut related = MultiPart::related().singlepart(build_html_part(html_body));
        for attachment in inline_attachments {
            related = related.singlepart(build_attachment_part(attachment, false)?);
        }
        MultiPart::alternative()
            .singlepart(plain_part)
            .multipart(related)
    };

    if regular_attachments.is_empty() {
        return Ok(MessageBody::Multi(alternative));
    }

    let mut mixed = MultiPart::mixed().multipart(alternative);
    for attachment in regular_attachments {
        mixed = mixed.singlepart(build_attachment_part(attachment, false)?);
    }
    Ok(MessageBody::Multi(mixed))
}

fn build_message(
    from: &str,
    to: Vec<String>,
    cc: Vec<String>,
    bcc: Vec<String>,
    subject: &str,
    format: OutgoingMailFormat,
    html_body: &str,
    plain_body: &str,
    attachments: &[OutgoingAttachment],
    raw_headers: &[(String, String)],
) -> Result<Message, String> {
    let mut builder = Message::builder()
        .from(from.parse().map_err(|e| format!("Invalid 'from' address: {}", e))?)
        .subject(subject);

    for addr_str in to {
        let addr = addr_str
            .parse()
            .map_err(|e| format!("Invalid 'to' address: {}", e))?;
        builder = builder.to(addr);
    }
    for addr_str in cc {
        let addr = addr_str
            .parse()
            .map_err(|e| format!("Invalid 'cc' address: {}", e))?;
        builder = builder.cc(addr);
    }
    for addr_str in bcc {
        let addr = addr_str
            .parse()
            .map_err(|e| format!("Invalid 'bcc' address: {}", e))?;
        builder = builder.bcc(addr);
    }
    for (name, value) in raw_headers {
        let header_name = header::HeaderName::new_from_ascii(name.trim().to_string())
            .map_err(|e| format!("Invalid header name '{}': {}", name, e))?;
        builder = builder.raw_header(header::HeaderValue::new(header_name, value.trim().to_string()));
    }

    match build_message_body(format, plain_body, html_body, attachments)? {
        MessageBody::Single(part) => builder
            .singlepart(part)
            .map_err(|e| format!("Failed to build message: {}", e)),
        MessageBody::Multi(part) => builder
            .multipart(part)
            .map_err(|e| format!("Failed to build message: {}", e)),
    }
}

pub fn build_rfc822_message(
    from: &str,
    to: Vec<String>,
    cc: Vec<String>,
    bcc: Vec<String>,
    subject: &str,
    format: OutgoingMailFormat,
    html_body: &str,
    plain_body: &str,
    attachments: &[OutgoingAttachment],
    raw_headers: &[(String, String)],
) -> Result<Vec<u8>, String> {
    let message = build_message(
        from,
        to,
        cc,
        bcc,
        subject,
        format,
        html_body,
        plain_body,
        attachments,
        raw_headers,
    )?;
    Ok(message.formatted())
}

pub async fn send_mail(
    smtp_host: &str,
    smtp_port: u16,
    ssl_mode: &str,
    email: &str,
    password: &str,
    from: &str,
    to: Vec<String>,
    cc: Vec<String>,
    bcc: Vec<String>,
    subject: &str,
    format: OutgoingMailFormat,
    html_body: &str,
    plain_body: &str,
    attachments: &[OutgoingAttachment],
) -> Result<(), String> {
    send_mail_with_headers(
        smtp_host,
        smtp_port,
        ssl_mode,
        email,
        password,
        from,
        to,
        cc,
        bcc,
        subject,
        format,
        html_body,
        plain_body,
        attachments,
        &[],
    )
    .await
}

pub async fn send_mail_with_headers(
    smtp_host: &str,
    smtp_port: u16,
    ssl_mode: &str,
    email: &str,
    password: &str,
    from: &str,
    to: Vec<String>,
    cc: Vec<String>,
    bcc: Vec<String>,
    subject: &str,
    format: OutgoingMailFormat,
    html_body: &str,
    plain_body: &str,
    attachments: &[OutgoingAttachment],
    raw_headers: &[(String, String)],
) -> Result<(), String> {
    info!(
        "Preparing to send email to {} recipients via {}:{} ({})",
        to.len() + cc.len() + bcc.len(),
        smtp_host,
        smtp_port,
        ssl_mode
    );

    if to.is_empty() && cc.is_empty() && bcc.is_empty() {
        return Err("No recipients specified".into());
    }

    let upper_ssl_mode = ssl_mode.to_uppercase();
    if matches!(upper_ssl_mode.as_str(), "SSL" | "STARTTLS")
        && smtp_host.parse::<IpAddr>().is_ok()
        && !is_loopback_smtp_host(smtp_host)
    {
        return Err(format!(
            "SMTP mode {} requires a hostname, not an IP address ({}). Use a real hostname like smtp.example.com. Loopback hosts are supported separately.",
            ssl_mode, smtp_host
        ));
    }

    let email_message = build_message(
        from,
        to,
        cc,
        bcc,
        subject,
        format,
        html_body,
        plain_body,
        attachments,
        raw_headers,
    )?;

    let credentials = Credentials::new(email.to_string(), password.to_string());
    let is_loopback = is_loopback_smtp_host(smtp_host);

    let mailer: AsyncSmtpTransport<Tokio1Executor> = match upper_ssl_mode.as_str() {
        "SSL" => {
            if is_loopback {
                let tls = build_local_tls_parameters()?;
                AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(smtp_host)
                    .port(smtp_port)
                    .tls(Tls::Wrapper(tls))
                    .credentials(credentials)
                    .build()
            } else {
                AsyncSmtpTransport::<Tokio1Executor>::relay(smtp_host)
                    .map_err(|e| format!("Failed to create SMTPS relay for {}: {}", smtp_host, e))?
                    .port(smtp_port)
                    .credentials(credentials)
                    .build()
            }
        }
        "STARTTLS" => {
            if is_loopback {
                let tls = build_local_tls_parameters()?;
                AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(smtp_host)
                    .port(smtp_port)
                    .tls(Tls::Required(tls))
                    .credentials(credentials)
                    .build()
            } else {
                AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(smtp_host)
                    .map_err(|e| format!("Failed to create STARTTLS relay for {}: {}", smtp_host, e))?
                    .port(smtp_port)
                    .credentials(credentials)
                    .build()
            }
        }
        _ => AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(smtp_host)
            .port(smtp_port)
            .credentials(credentials)
            .build(),
    };

    match mailer.send(email_message).await {
        Ok(_) => {
            info!("Email sent successfully");
            Ok(())
        }
        Err(e) => {
            error!(
                "Could not send email via {}:{} ({}): {}",
                smtp_host, smtp_port, ssl_mode, e
            );
            Err(format!(
                "Could not send email via {}:{} ({}): {}",
                smtp_host, smtp_port, ssl_mode, e
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{build_message, OutgoingAttachment, OutgoingAttachmentDisposition, OutgoingMailFormat};

    fn sample_attachment(disposition: OutgoingAttachmentDisposition) -> OutgoingAttachment {
        OutgoingAttachment {
            filename: "sample.txt".to_string(),
            content_type: "text/plain".to_string(),
            data_base64: "SGVsbG8=".to_string(),
            disposition,
            content_id: Some("cid-123".to_string()),
        }
    }

    #[test]
    fn builds_plain_only_message() {
        let message = build_message(
            "sender@example.com",
            vec!["to@example.com".to_string()],
            vec![],
            vec![],
            "Plain",
            OutgoingMailFormat::Plain,
            "",
            "Hello plain",
            &[],
            &[],
        )
        .expect("plain message");

        let bytes = message.formatted();
        let formatted = String::from_utf8_lossy(&bytes);
        assert!(formatted.contains("Content-Type: text/plain"));
        assert!(!formatted.contains("multipart/alternative"));
        assert!(!formatted.contains("text/html"));
    }

    #[test]
    fn builds_html_alternative_message() {
        let message = build_message(
            "sender@example.com",
            vec!["to@example.com".to_string()],
            vec![],
            vec![],
            "HTML",
            OutgoingMailFormat::Html,
            "<p>Hello html</p>",
            "Hello html",
            &[],
            &[],
        )
        .expect("html message");

        let bytes = message.formatted();
        let formatted = String::from_utf8_lossy(&bytes);
        assert!(formatted.contains("multipart/alternative"));
        assert!(formatted.contains("Content-Type: text/html"));
        assert!(formatted.contains("<p>Hello html</p>"));
    }

    #[test]
    fn builds_html_message_with_inline_attachment() {
        let message = build_message(
            "sender@example.com",
            vec!["to@example.com".to_string()],
            vec![],
            vec![],
            "Inline",
            OutgoingMailFormat::Html,
            "<p><img src=\"cid:cid-123\"></p>",
            "Inline",
            &[sample_attachment(OutgoingAttachmentDisposition::Inline)],
            &[],
        )
        .expect("inline html message");

        let bytes = message.formatted();
        let formatted = String::from_utf8_lossy(&bytes);
        let related_index = formatted.find("multipart/related").expect("related multipart");
        let html_index = formatted.find("Content-Type: text/html").expect("html part");
        let cid_index = formatted.find("Content-ID: <cid-123>").expect("cid part");
        assert!(formatted.contains("multipart/related"));
        assert!(formatted.contains("Content-ID: <cid-123>"));
        assert!(formatted.contains("Content-Disposition: inline; filename=\"sample.txt\""));
        assert!(html_index < cid_index);
        assert!(related_index < cid_index);
    }

    #[test]
    fn builds_html_message_with_inline_and_regular_attachments() {
        let message = build_message(
            "sender@example.com",
            vec!["to@example.com".to_string()],
            vec![],
            vec![],
            "Mixed",
            OutgoingMailFormat::Html,
            "<p><img src=\"cid:cid-123\"></p>",
            "Inline",
            &[
                sample_attachment(OutgoingAttachmentDisposition::Inline),
                OutgoingAttachment {
                    filename: "doc.pdf".to_string(),
                    content_type: "application/pdf".to_string(),
                    data_base64: "SGVsbG8=".to_string(),
                    disposition: OutgoingAttachmentDisposition::Attachment,
                    content_id: None,
                },
            ],
            &[],
        )
        .expect("mixed message");

        let bytes = message.formatted();
        let formatted = String::from_utf8_lossy(&bytes);
        assert!(formatted.contains("multipart/mixed"));
        assert!(formatted.contains("multipart/related"));
        assert!(formatted.contains("filename=\"doc.pdf\""));
    }

    #[test]
    fn builds_message_with_raw_headers() {
        let message = build_message(
            "sender@example.com",
            vec!["to@example.com".to_string()],
            vec![],
            vec![],
            "Headers",
            OutgoingMailFormat::Plain,
            "",
            "Body",
            &[],
            &[("In-Reply-To".to_string(), "<msg-1@example.com>".to_string())],
        )
        .expect("message with raw headers");

        let bytes = message.formatted();
        let formatted = String::from_utf8_lossy(&bytes);
        assert!(formatted.contains("In-Reply-To: <msg-1@example.com>"));
    }
}
