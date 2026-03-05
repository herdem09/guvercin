use imap;
use native_tls::TlsConnector;
use std::io::{Read, Write};

use crate::i18n::tr;

/// Attempts a real IMAP connection and login.
/// Returns (success, message).
pub async fn authorize(
    server: &str,
    email: &str,
    password: &str,
    port: u16,
    verify_ssl: bool,
    ssl_mode: &str,
) -> (bool, String) {
    // imap crate is blocking; run in a blocking task.
    let server = server.to_string();
    let email = email.to_string();
    let password = password.to_string();
    let ssl_mode = ssl_mode.to_string();

    tokio::task::spawn_blocking(move || {
        inner_authorize(&server, &email, &password, port, verify_ssl, &ssl_mode)
    })
    .await
    .unwrap_or_else(|e| (false, tr(&format!("Unexpected error: {e}"))))
}

pub async fn preview_mailboxes(
    server: &str,
    email: &str,
    password: &str,
    port: u16,
    verify_ssl: bool,
    ssl_mode: &str,
) -> Result<Vec<String>, String> {
    let server = server.to_string();
    let email = email.to_string();
    let password = password.to_string();
    let ssl_mode = ssl_mode.to_string();

    tokio::task::spawn_blocking(move || {
        inner_preview_mailboxes(&server, &email, &password, port, verify_ssl, &ssl_mode)
    })
    .await
    .unwrap_or_else(|e| Err(format!("Unexpected error: {e}")))
}

fn inner_authorize(
    server: &str,
    email: &str,
    password: &str,
    port: u16,
    verify_ssl: bool,
    ssl_mode: &str,
) -> (bool, String) {
    let mut builder = TlsConnector::builder();
    if !verify_ssl {
        #[allow(deprecated)]
        {
            builder.danger_accept_invalid_certs(true);
            builder.danger_accept_invalid_hostnames(true);
        }
    }

    let tls = match builder.build() {
        Ok(t) => t,
        Err(e) => {
            return (false, tr(&format!("Unexpected error: {e}")));
        }
    };

    match ssl_mode.to_uppercase().as_str() {
        "SSL" => match imap::connect((server, port), server, &tls) {
            Ok(client) => perform_auth(client, email, password),
            Err(e) => (false, tr(&format!("Unexpected error: {e}"))),
        },
        "STARTTLS" => match imap::connect_starttls((server, port), server, &tls) {
            Ok(client) => perform_auth(client, email, password),
            Err(e) => (false, tr(&format!("Unexpected error: {e}"))),
        },
        _ => {
            // NONE or fallback
            match std::net::TcpStream::connect((server, port)) {
                Ok(stream) => {
                    let mut client = imap::Client::new(stream);
                    if let Err(e) = client.read_greeting() {
                        return (false, tr(&format!("Unexpected error: {e}")));
                    }
                    perform_auth(client, email, password)
                }
                Err(e) => (false, tr(&format!("Unexpected error: {e}"))),
            }
        }
    }
}

fn perform_auth<T: Read + Write>(
    client: imap::Client<T>,
    email: &str,
    password: &str,
) -> (bool, String) {
    let mut session = match client.login(email, password) {
        Ok(s) => s,
        Err((imap::error::Error::No(resp), _)) => {
            return (false, tr(&format!("Login failed: {}", resp)));
        }
        Err((imap::error::Error::Bad(resp), _)) => {
            return (
                false,
                tr(&format!("Invalid command or protocol error: {}", resp)),
            );
        }
        Err((e, _)) => {
            return (false, tr(&format!("Unexpected error: {e}")));
        }
    };

    let _ = session.logout();

    (true, tr("Authorization successful."))
}

fn inner_preview_mailboxes(
    server: &str,
    email: &str,
    password: &str,
    port: u16,
    verify_ssl: bool,
    ssl_mode: &str,
) -> Result<Vec<String>, String> {
    let mut builder = TlsConnector::builder();
    if !verify_ssl {
        #[allow(deprecated)]
        {
            builder.danger_accept_invalid_certs(true);
            builder.danger_accept_invalid_hostnames(true);
        }
    }

    let tls = builder
        .build()
        .map_err(|e| format!("Unexpected error: {e}"))?;

    match ssl_mode.to_uppercase().as_str() {
        "SSL" => {
            let client = imap::connect((server, port), server, &tls)
                .map_err(|e| format!("Unexpected error: {e}"))?;
            perform_preview(client, email, password)
        }
        "STARTTLS" => {
            let client = imap::connect_starttls((server, port), server, &tls)
                .map_err(|e| format!("Unexpected error: {e}"))?;
            perform_preview(client, email, password)
        }
        _ => {
            let stream = std::net::TcpStream::connect((server, port))
                .map_err(|e| format!("Unexpected error: {e}"))?;
            let mut client = imap::Client::new(stream);
            client
                .read_greeting()
                .map_err(|e| format!("Unexpected error: {e}"))?;
            perform_preview(client, email, password)
        }
    }
}

fn perform_preview<T: Read + Write>(
    client: imap::Client<T>,
    email: &str,
    password: &str,
) -> Result<Vec<String>, String> {
    let mut session = client
        .login(email, password)
        .map_err(|(e, _)| format!("{e}"))?;
    let list = session
        .list(Some(""), Some("*"))
        .map_err(|e| format!("list mailbox failed: {e}"))?;
    let mailboxes = list.iter().map(|n| n.name().to_string()).collect();
    let _ = session.logout();
    Ok(mailboxes)
}
