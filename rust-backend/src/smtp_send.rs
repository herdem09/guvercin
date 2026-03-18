use lettre::{
    message::{header::ContentType, MultiPart, SinglePart},
    transport::smtp::client::{Tls, TlsParameters},
    transport::smtp::authentication::Credentials,
    Message, AsyncSmtpTransport, Tokio1Executor, AsyncTransport,
};
use std::net::IpAddr;
use tracing::{error, info};

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
    html_body: &str,
    plain_body: &str,
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

    let mut builder = Message::builder()
        .from(from.parse().map_err(|e| format!("Invalid 'from' address: {}", e))?)
        .subject(subject);

    for addr_str in to {
        let addr = addr_str.parse().map_err(|e| format!("Invalid 'to' address: {}", e))?;
        builder = builder.to(addr);
    }
    for addr_str in cc {
        let addr = addr_str.parse().map_err(|e| format!("Invalid 'cc' address: {}", e))?;
        builder = builder.cc(addr);
    }
    for addr_str in bcc {
        let addr = addr_str.parse().map_err(|e| format!("Invalid 'bcc' address: {}", e))?;
        builder = builder.bcc(addr);
    }

    let multipart = MultiPart::alternative()
        .singlepart(
            SinglePart::builder()
                .header(ContentType::TEXT_PLAIN)
                .body(plain_body.to_string()),
        )
        .singlepart(
            SinglePart::builder()
                .header(ContentType::TEXT_HTML)
                .body(html_body.to_string()),
        );

    let email_message = builder
        .multipart(multipart)
        .map_err(|e| format!("Failed to build message: {}", e))?;

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
