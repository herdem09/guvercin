use std::{
    collections::HashMap,
    net::TcpStream,
    sync::{Arc, Mutex},
};

use chrono::{DateTime, Datelike, Duration, NaiveDate};
use imap;
use native_tls::TlsConnector;
use tracing::{error, info, warn};

use crate::mail_models::{
    AdvancedSearchRequest, AttachmentInfo, MailContent, MailPreview, MailSearchPreview,
    ReadStatus, SearchScope, merge_mailbox_label_into_preview,
};
use mailparse::{
    addrparse_header, parse_mail, DispositionType, MailAddr, MailHeaderMap, ParsedMail,
};

// ─────────────────────────────────────────────────────────────────
// Public state held per-account IMAP session
// One session is kept alive as long as the dashboard is open.
// ─────────────────────────────────────────────────────────────────

pub struct ImapState {
    /// account_id  →  live session wrapper
    sessions: Mutex<HashMap<i64, ImapSession>>,
}

impl ImapState {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }
}

// ─────────────────────────────────────────────────────────────────
// Session wrapper – hides the generic type behind trait objects
// ─────────────────────────────────────────────────────────────────

pub enum ImapSession {
    Plain(imap::Session<TcpStream>),
    Tls(imap::Session<native_tls::TlsStream<TcpStream>>),
}

impl ImapSession {
    fn noop(&mut self) -> Result<(), String> {
        let result = match self {
            ImapSession::Plain(s) => s.noop(),
            ImapSession::Tls(s) => s.noop(),
        };
        result.map(|_| ()).map_err(|e| format!("{e}"))
    }

    fn list_mailboxes(&mut self) -> Vec<String> {
        let result = match self {
            ImapSession::Plain(s) => s.list(Some(""), Some("*")),
            ImapSession::Tls(s) => s.list(Some(""), Some("*")),
        };
        match result {
            Ok(names) => names.iter().map(|n| n.name().to_string()).collect(),
            Err(e) => {
                warn!("list_mailboxes error: {e}");
                vec![]
            }
        }
    }

    fn select_mailbox(&mut self, name: &str) -> Result<u32, String> {
        let mb = match self {
            ImapSession::Plain(s) => s.select(name),
            ImapSession::Tls(s) => s.select(name),
        };
        match mb {
            Ok(mb) => Ok(mb.exists),
            Err(e) => Err(format!("{e}")),
        }
    }

    fn fetch_headers(&mut self, sequence: &str) -> Vec<MailPreview> {
        let data = match self {
            ImapSession::Plain(s) => s.fetch(
                sequence,
                "(BODY.PEEK[HEADER.FIELDS (FROM TO SUBJECT DATE CONTENT-TYPE IMPORTANCE X-PRIORITY KEYWORDS X-CATEGORY)] FLAGS UID RFC822.SIZE)",
            ),
            ImapSession::Tls(s) => s.fetch(
                sequence,
                "(BODY.PEEK[HEADER.FIELDS (FROM TO SUBJECT DATE CONTENT-TYPE IMPORTANCE X-PRIORITY KEYWORDS X-CATEGORY)] FLAGS UID RFC822.SIZE)",
            ),
        };

        let fetches = match data {
            Ok(f) => f,
            Err(e) => {
                warn!("fetch_headers error: {e}");
                return vec![];
            }
        };

        let mut previews = Vec::new();
        for msg in fetches.iter() {
            let uid = msg
                .uid
                .map(|u| u.to_string())
                .unwrap_or_else(|| msg.message.to_string());
            let seen = msg
                .flags()
                .iter()
                .any(|f| matches!(f, imap::types::Flag::Seen));
            let flagged = msg
                .flags()
                .iter()
                .any(|f| matches!(f, imap::types::Flag::Flagged));

            // Extract custom keywords from FLAGS as labels
            let mut labels = Vec::new();
            for f in msg.flags().iter() {
                if let imap::types::Flag::Custom(s) = f {
                    let keyword = s.to_string();
                    if !labels.contains(&keyword) {
                        labels.push(keyword);
                    }
                }
            }

            if let Some(header_bytes) = msg.header() {
                let header_str = String::from_utf8_lossy(header_bytes);
                let subject = parse_header(&header_str, "Subject");
                let from_raw = parse_header(&header_str, "From");
                let recipient_to = parse_header(&header_str, "To");
                let date = parse_header(&header_str, "Date");
                let content_type = parse_content_type(&parse_header(&header_str, "Content-Type"));
                let importance = parse_importance(&header_str);
                let category = parse_category(&header_str);
                // Merge labels from headers if any (e.g. Keywords header)
                for h_label in parse_labels(&header_str) {
                    if !labels.contains(&h_label) {
                        labels.push(h_label);
                    }
                }
                let (name, address) = split_from(&from_raw);

                previews.push(MailPreview {
                    id: uid,
                    name,
                    address,
                    subject,
                    date,
                    seen,
                    flagged,
                    recipient_to,
                    size: msg.size.unwrap_or(0) as usize,
                    importance,
                    content_type,
                    category,
                    labels,
                });
            }
        }
        previews
    }

    fn fetch_mail_raw(&mut self, uid: &str) -> Option<Vec<u8>> {
        let data = match self {
            ImapSession::Plain(s) => s.uid_fetch(uid, "BODY.PEEK[]"),
            ImapSession::Tls(s) => s.uid_fetch(uid, "BODY.PEEK[]"),
        };
        let fetches = data.ok()?;
        let msg = fetches.iter().next()?;
        let raw = msg.body()?;
        Some(raw.to_vec())
    }

    fn uid_store_flag(&mut self, uid: &str, flag: &str, add: bool) -> Result<(), String> {
        let op = if add {
            format!("+FLAGS ({flag})")
        } else {
            format!("-FLAGS ({flag})")
        };
        let res = match self {
            ImapSession::Plain(s) => s.uid_store(uid, &op),
            ImapSession::Tls(s) => s.uid_store(uid, &op),
        };
        res.map(|_| ()).map_err(|e| format!("{e}"))
    }

    fn uid_store_keyword(&mut self, uid: &str, keyword: &str, add: bool) -> Result<(), String> {
        let keyword = keyword.trim();
        if keyword.is_empty() {
            return Err("Label keyword cannot be empty".to_string());
        }

        if keyword.chars().any(|ch| {
            ch.is_whitespace() || matches!(ch, '(' | ')' | '{' | '%' | '*' | '"' | '\\' | ']')
        }) {
            return Err(format!(
                "Label \"{keyword}\" contains characters not supported by IMAP keywords"
            ));
        }

        let op = if add {
            format!("+FLAGS ({keyword})")
        } else {
            format!("-FLAGS ({keyword})")
        };
        let res = match self {
            ImapSession::Plain(s) => s.uid_store(uid, &op),
            ImapSession::Tls(s) => s.uid_store(uid, &op),
        };
        res.map(|_| ()).map_err(|e| format!("{e}"))
    }

    fn uid_move_to(&mut self, uid: &str, folder: &str) -> Result<(), String> {
        // COPY + \Deleted + EXPUNGE fallback that works on common IMAP servers.
        let copied = match self {
            ImapSession::Plain(s) => s.uid_copy(uid, folder),
            ImapSession::Tls(s) => s.uid_copy(uid, folder),
        };
        copied.map_err(|e| format!("{e}"))?;
        self.uid_store_flag(uid, "\\Deleted", true)?;
        let expunge = match self {
            ImapSession::Plain(s) => s.expunge(),
            ImapSession::Tls(s) => s.expunge(),
        };
        expunge.map(|_| ()).map_err(|e| format!("{e}"))
    }

    fn uid_delete(&mut self, uid: &str) -> Result<(), String> {
        self.uid_store_flag(uid, "\\Deleted", true)?;
        let expunge = match self {
            ImapSession::Plain(s) => s.expunge(),
            ImapSession::Tls(s) => s.expunge(),
        };
        expunge.map(|_| ()).map_err(|e| format!("{e}"))
    }

    /// UID SEARCH UID <since_uid>:* — returns UIDs of messages we haven't seen yet.
    fn search_new_uids(&mut self, since_uid: u32) -> Vec<u32> {
        let query = format!("UID {}:*", since_uid + 1);
        let result = match self {
            ImapSession::Plain(s) => s.uid_search(&query),
            ImapSession::Tls(s) => s.uid_search(&query),
        };
        match result {
            Ok(set) => {
                let mut v: Vec<u32> = set.into_iter().collect();
                v.sort_unstable();
                v
            }
            Err(e) => {
                warn!("UID SEARCH error: {e}");
                vec![]
            }
        }
    }

    fn uid_search_query(&mut self, query: &str) -> Result<Vec<u32>, String> {
        let result = match self {
            ImapSession::Plain(s) => s.uid_search(query),
            ImapSession::Tls(s) => s.uid_search(query),
        };
        match result {
            Ok(set) => {
                let mut v: Vec<u32> = set.into_iter().collect();
                v.sort_unstable();
                Ok(v)
            }
            Err(e) => Err(format!("{e}")),
        }
    }

    /// Fetch headers for an explicit comma-separated UID set (e.g. "101,102,103").
    fn fetch_headers_by_uid_set(&mut self, uid_set: &str, account_id: i64, mailbox: &str) -> Vec<MailPreview> {
        let data = match self {
            ImapSession::Plain(s) => s.uid_fetch(
                uid_set,
                "(BODY.PEEK[HEADER.FIELDS (FROM TO SUBJECT DATE CONTENT-TYPE IMPORTANCE X-PRIORITY KEYWORDS X-CATEGORY)] FLAGS UID RFC822.SIZE)",
            ),
            ImapSession::Tls(s) => s.uid_fetch(
                uid_set,
                "(BODY.PEEK[HEADER.FIELDS (FROM TO SUBJECT DATE CONTENT-TYPE IMPORTANCE X-PRIORITY KEYWORDS X-CATEGORY)] FLAGS UID RFC822.SIZE)",
            ),
        };

        let fetches = match data {
            Ok(f) => f,
            Err(e) => {
                warn!("uid_fetch error: {e}");
                return vec![];
            }
        };

        let mut previews = Vec::new();
        for msg in fetches.iter() {
            let uid = if let Some(uid) = msg.uid {
                uid.to_string()
            } else {
                warn!(
                    "uid_fetch returned message without UID (account_id={}, mailbox={}, uid_set={}, seq={})",
                    account_id,
                    mailbox,
                    uid_set,
                    msg.message
                );
                msg.message.to_string()
            };
            let seen = msg
                .flags()
                .iter()
                .any(|f| matches!(f, imap::types::Flag::Seen));
            let flagged = msg
                .flags()
                .iter()
                .any(|f| matches!(f, imap::types::Flag::Flagged));

            // Extract custom keywords from FLAGS as labels
            let mut labels = Vec::new();
            for f in msg.flags().iter() {
                if let imap::types::Flag::Custom(s) = f {
                    let keyword = s.to_string();
                    if !labels.contains(&keyword) {
                        labels.push(keyword);
                    }
                }
            }

            if let Some(header_bytes) = msg.header() {
                let header_str = String::from_utf8_lossy(header_bytes);
                let subject = parse_header(&header_str, "Subject");
                let from_raw = parse_header(&header_str, "From");
                let recipient_to = parse_header(&header_str, "To");
                let date = parse_header(&header_str, "Date");
                let content_type = parse_content_type(&parse_header(&header_str, "Content-Type"));
                let importance = parse_importance(&header_str);
                let category = parse_category(&header_str);
                // Merge labels from headers if any (e.g. Keywords header)
                for h_label in parse_labels(&header_str) {
                    if !labels.contains(&h_label) {
                        labels.push(h_label);
                    }
                }
                let (name, address) = split_from(&from_raw);

                previews.push(MailPreview {
                    id: uid,
                    name,
                    address,
                    subject,
                    date,
                    seen,
                    flagged,
                    recipient_to,
                    size: msg.size.unwrap_or(0) as usize,
                    importance,
                    content_type,
                    category,
                    labels,
                });
            }
        }
        previews
    }
}

// ─────────────────────────────────────────────────────────────────
// Public API – called from route handlers
// ─────────────────────────────────────────────────────────────────

/// Connect & login, store session keyed by account_id.
pub fn connect_and_login(
    state: &Arc<ImapState>,
    account_id: i64,
    email: &str,
    password: &str,
    imap_host: &str,
    imap_port: u16,
    ssl_mode: &str,
) -> Result<(), String> {
    let mut builder = TlsConnector::builder();
    builder.danger_accept_invalid_certs(true);
    builder.danger_accept_invalid_hostnames(true);
    let tls = builder.build().map_err(|e| format!("{e}"))?;

    let session = match ssl_mode.to_uppercase().as_str() {
        "SSL" => {
            let client = imap::connect((imap_host, imap_port), imap_host, &tls)
                .map_err(|e| format!("{e}"))?;
            let s = client
                .login(email, password)
                .map_err(|(e, _)| format!("{e}"))?;
            ImapSession::Tls(s)
        }
        "STARTTLS" => {
            let client = imap::connect_starttls((imap_host, imap_port), imap_host, &tls)
                .map_err(|e| format!("{e}"))?;
            let s = client
                .login(email, password)
                .map_err(|(e, _)| format!("{e}"))?;
            ImapSession::Tls(s)
        }
        _ => {
            // NONE – plain TCP
            let tcp = TcpStream::connect((imap_host, imap_port)).map_err(|e| format!("{e}"))?;

            // Set timeouts to prevent infinite blocking
            tcp.set_read_timeout(Some(std::time::Duration::from_secs(30)))
                .ok();
            tcp.set_write_timeout(Some(std::time::Duration::from_secs(30)))
                .ok();

            let mut client = imap::Client::new(tcp);
            client.read_greeting().map_err(|e| format!("{e}"))?;
            let s = client
                .login(email, password)
                .map_err(|(e, _)| format!("{e}"))?;
            ImapSession::Plain(s)
        }
    };

    state.sessions.lock().unwrap().insert(account_id, session);
    info!("IMAP session opened for account {account_id}");
    Ok(())
}

pub fn list_mailboxes(state: &Arc<ImapState>, account_id: i64) -> Vec<String> {
    let mut sessions = state.sessions.lock().unwrap();
    match sessions.get_mut(&account_id) {
        Some(s) => s.list_mailboxes(),
        None => {
            warn!("No IMAP session for account {account_id}");
            vec![]
        }
    }
}

pub fn fetch_mail_list(
    state: &Arc<ImapState>,
    account_id: i64,
    mailbox: &str,
    page: usize,
    per_page: usize,
) -> (usize, Vec<MailPreview>) {
    let mut sessions = state.sessions.lock().unwrap();
    let session = match sessions.get_mut(&account_id) {
        Some(s) => s,
        None => {
            warn!("No IMAP session for account {account_id}");
            return (0, vec![]);
        }
    };

    let total = match session.select_mailbox(mailbox) {
        Ok(n) => n as usize,
        Err(e) => {
            error!("select_mailbox {mailbox}: {e}");
            return (0, vec![]);
        }
    };

    if total == 0 {
        return (0, vec![]);
    }

    // Newest first: compute reverse-paged sequence set
    let start_from_end = (page.saturating_sub(1)) * per_page;
    if start_from_end >= total {
        return (total, vec![]);
    }

    // e.g. total=100, page=1, per_page=50  → seq 51:100 (newest 50)
    let hi = total - start_from_end;
    let lo = if hi > per_page { hi - per_page + 1 } else { 1 };
    let sequence = format!("{lo}:{hi}");

    let mut previews = session.fetch_headers(&sequence);

    fn date_ms(date_value: &str) -> i64 {
        DateTime::parse_from_rfc2822(date_value)
            .map(|dt| dt.timestamp_millis())
            .unwrap_or(0)
    }
    fn uid_num(id: &str) -> u32 {
        id.parse::<u32>().unwrap_or(0)
    }

    // Sort newest-first by sent date. Tie-break by UID (if available).
    previews.sort_by(|a, b| {
        date_ms(&b.date)
            .cmp(&date_ms(&a.date))
            .then_with(|| uid_num(&b.id).cmp(&uid_num(&a.id)))
            .then_with(|| b.id.cmp(&a.id))
    });
    (total, previews)
}

fn quote_imap_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for ch in value.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\r' | '\n' => out.push(' '),
            _ => out.push(ch),
        }
    }
    out.push('"');
    out
}

fn parse_ymd(value: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(value.trim(), "%Y-%m-%d").ok()
}

fn format_imap_date(date: NaiveDate) -> String {
    let month = match date.month() {
        1 => "Jan",
        2 => "Feb",
        3 => "Mar",
        4 => "Apr",
        5 => "May",
        6 => "Jun",
        7 => "Jul",
        8 => "Aug",
        9 => "Sep",
        10 => "Oct",
        11 => "Nov",
        12 => "Dec",
        _ => "Jan",
    };
    format!("{:02}-{month}-{}", date.day(), date.year())
}

pub fn build_imap_advanced_query(req: &AdvancedSearchRequest) -> String {
    let mut parts: Vec<String> = Vec::new();

    let from = req.from.as_deref().map(str::trim).filter(|v| !v.is_empty());
    let to = req.to.as_deref().map(str::trim).filter(|v| !v.is_empty());
    let cc = req.cc.as_deref().map(str::trim).filter(|v| !v.is_empty());
    let subject = req.subject.as_deref().map(str::trim).filter(|v| !v.is_empty());
    let keywords = req.keywords.as_deref().map(str::trim).filter(|v| !v.is_empty());

    if let Some(value) = from {
        parts.push(format!("FROM {}", quote_imap_string(value)));
    }
    if let Some(value) = to {
        parts.push(format!("TO {}", quote_imap_string(value)));
    }
    if let Some(value) = cc {
        parts.push(format!("CC {}", quote_imap_string(value)));
    }
    if let Some(value) = subject {
        parts.push(format!("SUBJECT {}", quote_imap_string(value)));
    }
    if let Some(value) = keywords {
        parts.push(format!("BODY {}", quote_imap_string(value)));
    }

    if let Some(start) = req
        .date_start
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .and_then(parse_ymd)
    {
        parts.push(format!("SENTSINCE {}", format_imap_date(start)));
    }

    if let Some(end) = req
        .date_end
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .and_then(parse_ymd)
        .and_then(|d| d.checked_add_signed(Duration::days(1)))
    {
        parts.push(format!("SENTBEFORE {}", format_imap_date(end)));
    }

    match req.read_status.unwrap_or(ReadStatus::All) {
        ReadStatus::Read => parts.push("SEEN".to_string()),
        ReadStatus::Unread => parts.push("UNSEEN".to_string()),
        ReadStatus::All => {}
    }

    if parts.is_empty() {
        "ALL".to_string()
    } else {
        parts.join(" ")
    }
}

fn matches_attachment_hint(content_type: &str) -> bool {
    let value = content_type.trim().to_ascii_lowercase();
    value.starts_with("multipart/mixed")
        || value.starts_with("multipart/related")
        || value.starts_with("multipart/report")
}

pub fn advanced_search(
    state: &Arc<ImapState>,
    account_id: i64,
    req: &AdvancedSearchRequest,
) -> Result<Vec<MailSearchPreview>, String> {
    let mut sessions = state.sessions.lock().unwrap();
    let session = sessions
        .get_mut(&account_id)
        .ok_or_else(|| format!("No IMAP session for account {account_id}"))?;

    let query = build_imap_advanced_query(req);

    let mut mailboxes: Vec<String> = match req.scope {
        SearchScope::All => session.list_mailboxes(),
        SearchScope::Mailboxes => req.mailboxes.clone(),
    };

    // Normalize + drop empty + de-dupe while keeping order.
    let mut seen = std::collections::HashSet::new();
    mailboxes.retain(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            return false;
        }
        let lower = trimmed.to_ascii_lowercase();
        if matches!(lower.as_str(), "folders" | "labels" | "etiketler" | "[labels]") {
            return false;
        }
        if seen.contains(&lower) {
            return false;
        }
        seen.insert(lower);
        true
    });

    let want_attachments = req.has_attachments;
    let mut results: Vec<MailSearchPreview> = Vec::new();
    let chunk_size = 200usize;

    for mailbox in mailboxes {
        if session.select_mailbox(&mailbox).is_err() {
            continue;
        }

        let uids = match session.uid_search_query(&query) {
            Ok(v) => v,
            Err(e) => {
                warn!("advanced_search UID SEARCH error (mailbox={mailbox}): {e}");
                continue;
            }
        };

        if uids.is_empty() {
            continue;
        }

        for chunk in uids.chunks(chunk_size) {
            let uid_set = chunk
                .iter()
                .map(|u| u.to_string())
                .collect::<Vec<_>>()
                .join(",");
            let mut previews = session.fetch_headers_by_uid_set(&uid_set, account_id, &mailbox);

            for preview in previews.iter_mut() {
                merge_mailbox_label_into_preview(preview, &mailbox);
            }

            for preview in previews {
                if want_attachments && !matches_attachment_hint(&preview.content_type) {
                    continue;
                }
                results.push(MailSearchPreview {
                    mailbox: mailbox.clone(),
                    mail: preview,
                });
            }
        }
    }

    fn date_ms(date_value: &str) -> i64 {
        DateTime::parse_from_rfc2822(date_value)
            .map(|dt| dt.timestamp_millis())
            .unwrap_or(0)
    }
    fn uid_num(id: &str) -> u32 {
        id.parse::<u32>().unwrap_or(0)
    }

    results.sort_by(|a, b| {
        date_ms(&b.mail.date)
            .cmp(&date_ms(&a.mail.date))
            .then_with(|| uid_num(&b.mail.id).cmp(&uid_num(&a.mail.id)))
            .then_with(|| b.mail.id.cmp(&a.mail.id))
    });

    Ok(results)
}

pub fn fetch_mail_raw_in_mailbox(
    state: &Arc<ImapState>,
    account_id: i64,
    mailbox: &str,
    uid: &str,
) -> Option<Vec<u8>> {
    let mut sessions = state.sessions.lock().unwrap();
    let session = sessions.get_mut(&account_id)?;
    session.select_mailbox(mailbox).ok()?;
    session.fetch_mail_raw(uid)
}

/// Return UIDs of messages with UID > since_uid in the given mailbox.
/// Returns (total_count, new_uids). total_count is the current EXISTS count.
pub fn fetch_new_uids_since(
    state: &Arc<ImapState>,
    account_id: i64,
    mailbox: &str,
    since_uid: u32,
) -> (usize, Vec<u32>) {
    let mut sessions = state.sessions.lock().unwrap();
    let session = match sessions.get_mut(&account_id) {
        Some(s) => s,
        None => {
            warn!("No IMAP session for account {account_id}");
            return (0, vec![]);
        }
    };

    let total = match session.select_mailbox(mailbox) {
        Ok(n) => n as usize,
        Err(e) => {
            error!("select_mailbox {mailbox}: {e}");
            return (0, vec![]);
        }
    };

    if total == 0 {
        return (0, vec![]);
    }

    let new_uids = session.search_new_uids(since_uid);
    (total, new_uids)
}

/// Fetch mail previews (headers) for a specific list of UIDs.
pub fn fetch_headers_for_uids(
    state: &Arc<ImapState>,
    account_id: i64,
    mailbox: &str,
    uids: &[u32],
) -> Vec<MailPreview> {
    if uids.is_empty() {
        return vec![];
    }
    let mut sessions = state.sessions.lock().unwrap();
    let session = match sessions.get_mut(&account_id) {
        Some(s) => s,
        None => return vec![],
    };
    // Select mailbox (already selected from fetch_new_uids_since, but be safe)
    let _ = session.select_mailbox(mailbox);
    // Build UID set string e.g. "101,102,103"
    let uid_set: String = uids.iter().map(|u| u.to_string()).collect::<Vec<_>>().join(",");
    session.fetch_headers_by_uid_set(&uid_set, account_id, mailbox)
}

pub fn parse_mail_content(uid: String, raw: &[u8]) -> MailContent {
    match parse_mail(raw) {
        Ok(parsed) => build_mail_content(uid, &parsed),
        Err(err) => {
            warn!(error = %err, "mailparse failed, falling back to basic parser");
            fallback_parse_rfc822(uid, raw)
        }
    }
}

pub fn find_attachment_bytes(
    raw: &[u8],
    attachment_index: usize,
) -> Option<(AttachmentInfo, Vec<u8>)> {
    let parsed = parse_mail(raw).ok()?;
    let descriptor = find_attachment_descriptor(&parsed, attachment_index)?;
    let bytes = descriptor.bytes?;
    Some((descriptor.info, bytes))
}

pub fn disconnect(state: &Arc<ImapState>, account_id: i64) {
    let mut sessions = state.sessions.lock().unwrap();
    if let Some(mut s) = sessions.remove(&account_id) {
        match &mut s {
            ImapSession::Plain(sess) => {
                let _ = sess.logout();
            }
            ImapSession::Tls(sess) => {
                let _ = sess.logout();
            }
        }
        info!("IMAP session closed for account {account_id}");
    }
}

pub fn is_connected(state: &Arc<ImapState>, account_id: i64) -> bool {
    let mut sessions = state.sessions.lock().unwrap();
    let health = match sessions.get_mut(&account_id) {
        Some(session) => session.noop(),
        None => return false,
    };

    if let Err(err) = health {
        warn!("IMAP session unhealthy for account {account_id}: {err}");
        sessions.remove(&account_id);
        return false;
    }

    true
}

pub fn mark_seen(
    state: &Arc<ImapState>,
    account_id: i64,
    mailbox: &str,
    uid: &str,
    seen: bool,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap();
    let session = sessions
        .get_mut(&account_id)
        .ok_or_else(|| format!("No IMAP session for account {account_id}"))?;
    session.select_mailbox(mailbox)?;
    session.uid_store_flag(uid, "\\Seen", seen)
}

pub fn set_label(
    state: &Arc<ImapState>,
    account_id: i64,
    mailbox: &str,
    uid: &str,
    label: &str,
    add: bool,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap();
    let session = sessions
        .get_mut(&account_id)
        .ok_or_else(|| format!("No IMAP session for account {account_id}"))?;
    session.select_mailbox(mailbox)?;
    session.uid_store_keyword(uid, label, add)?;

    // If adding a label, also search for the corresponding label folder (mailbox)
    // and copy the mail there so it appears in that folder.
    if add {
        let label_folders = ["Labels", "Etiketler", "[Labels]"];
        let mut target_folder = None;
        let mailboxes = session.list_mailboxes();
        
        for root in label_folders {
            let candidate = format!("{}/{}", root, label);
            if mailboxes.iter().any(|m| m.eq_ignore_ascii_case(&candidate)) {
                target_folder = Some(candidate);
                break;
            }
        }

        if let Some(folder) = target_folder {
            // Copy mail to target label folder (UID COPY)
            let _ = match session {
                ImapSession::Plain(s) => s.uid_copy(uid, folder),
                ImapSession::Tls(s) => s.uid_copy(uid, folder),
            };
        }
    } else {
        // If removing a label, and we have a corresponding folder, it's hard to find
        // and delete the specific copy in that folder by UID because it's in a different mailbox.
        // However, the keyword state (flag) is now updated globally on the server.
    }

    Ok(())
}

pub fn move_mail(
    state: &Arc<ImapState>,
    account_id: i64,
    source_mailbox: &str,
    uid: &str,
    destination: &str,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap();
    let session = sessions
        .get_mut(&account_id)
        .ok_or_else(|| format!("No IMAP session for account {account_id}"))?;
    session.select_mailbox(source_mailbox)?;
    session.uid_move_to(uid, destination)
}

pub fn create_mailbox(
    state: &Arc<ImapState>,
    account_id: i64,
    mailbox: &str,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap();
    let session = sessions
        .get_mut(&account_id)
        .ok_or_else(|| format!("No IMAP session for account {account_id}"))?;
    let result = match session {
        ImapSession::Plain(s) => s.create(mailbox),
        ImapSession::Tls(s) => s.create(mailbox),
    };
    result.map(|_| ()).map_err(|e| format!("{e}"))
}

pub fn delete_mail(
    state: &Arc<ImapState>,
    account_id: i64,
    mailbox: &str,
    uid: &str,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap();
    let session = sessions
        .get_mut(&account_id)
        .ok_or_else(|| format!("No IMAP session for account {account_id}"))?;
    session.select_mailbox(mailbox)?;
    session.uid_delete(uid)
}

fn build_mail_content(uid: String, parsed: &ParsedMail) -> MailContent {
    let headers = parsed.get_headers();
    let subject = headers.get_first_value("Subject").unwrap_or_default();
    let date = headers.get_first_value("Date").unwrap_or_default();
    let (from_name, from_address) = extract_sender(parsed);
    let cc = headers.get_first_value("Cc").unwrap_or_default();
    let bcc = headers.get_first_value("Bcc").unwrap_or_default();

    let mut plain = None;
    let mut html = None;
    collect_text_parts(parsed, &mut plain, &mut html);

    MailContent {
        id: uid,
        subject,
        from_name,
        from_address,
        cc,
        bcc,
        date,
        html_body: html.unwrap_or_default(),
        plain_body: plain.unwrap_or_default(),
        attachments: collect_attachment_infos(parsed),
    }
}

fn collect_text_parts(part: &ParsedMail, plain: &mut Option<String>, html: &mut Option<String>) {
    if part.subparts.is_empty() {
        let mimetype = part.ctype.mimetype.to_lowercase();
        if mimetype == "text/plain" && plain.is_none() {
            if let Ok(body) = part.get_body() {
                *plain = Some(body);
            }
        } else if mimetype == "text/html" && html.is_none() {
            if let Ok(body) = part.get_body() {
                *html = Some(body);
            }
        }
    } else {
        for child in &part.subparts {
            collect_text_parts(child, plain, html);
        }
    }
}

fn extract_sender(parsed: &ParsedMail) -> (String, String) {
    if let Some(header) = parsed.get_headers().get_first_header("From") {
        if let Ok(entries) = addrparse_header(header) {
            for addr in entries.iter() {
                if let MailAddr::Single(info) = addr {
                    return (
                        info.display_name.clone().unwrap_or_default(),
                        info.addr.clone(),
                    );
                }
            }
        }
        return (String::new(), header.get_value());
    }
    (String::new(), String::new())
}

fn collect_attachment_infos(parsed: &ParsedMail) -> Vec<AttachmentInfo> {
    let mut attachments = Vec::new();
    iterate_attachment_parts(parsed, &mut |part, idx| {
        if let Some(desc) = build_attachment_descriptor(part, idx, false) {
            attachments.push(desc.info);
        }
        false
    });
    attachments
}

fn find_attachment_descriptor(
    parsed: &ParsedMail,
    target_index: usize,
) -> Option<AttachmentDescriptor> {
    let mut descriptor = None;
    iterate_attachment_parts(parsed, &mut |part, idx| {
        if idx == target_index {
            if let Some(desc) = build_attachment_descriptor(part, idx, true) {
                descriptor = Some(desc);
                return true;
            }
        }
        false
    });
    descriptor
}

fn iterate_attachment_parts<F>(part: &ParsedMail, visitor: &mut F) -> bool
where
    F: FnMut(&ParsedMail, usize) -> bool,
{
    fn recurse<F>(part: &ParsedMail, counter: &mut usize, visitor: &mut F) -> bool
    where
        F: FnMut(&ParsedMail, usize) -> bool,
    {
        if part.subparts.is_empty() {
            if should_treat_as_attachment(part) {
                let idx = *counter;
                *counter += 1;
                if visitor(part, idx) {
                    return true;
                }
            }
        } else {
            for child in &part.subparts {
                if recurse(child, counter, visitor) {
                    return true;
                }
            }
        }
        false
    }

    let mut counter = 0;
    recurse(part, &mut counter, visitor)
}

fn should_treat_as_attachment(part: &ParsedMail) -> bool {
    if !part.subparts.is_empty() {
        return false;
    }
    let disposition = part.get_content_disposition();
    let mimetype = part.ctype.mimetype.to_lowercase();
    let has_filename =
        disposition.params.contains_key("filename") || part.ctype.params.contains_key("name");

    if matches!(disposition.disposition, DispositionType::Attachment) {
        return true;
    }
    if has_filename {
        return true;
    }
    if mimetype.starts_with("text/") {
        return false;
    }
    if mimetype == "message/rfc822" {
        return false;
    }
    true
}

fn build_attachment_descriptor(
    part: &ParsedMail,
    index: usize,
    include_bytes: bool,
) -> Option<AttachmentDescriptor> {
    let disposition = part.get_content_disposition();
    let filename = disposition
        .params
        .get("filename")
        .cloned()
        .or_else(|| part.ctype.params.get("name").cloned())
        .unwrap_or_else(|| format!("attachment-{}", index + 1));

    let body = part.get_body_raw().ok()?;
    let size = body.len();
    let content_type = part.ctype.mimetype.clone();
    let is_inline = matches!(disposition.disposition, DispositionType::Inline);
    let bytes = if include_bytes { Some(body) } else { None };

    Some(AttachmentDescriptor {
        info: AttachmentInfo {
            id: index.to_string(),
            filename,
            content_type,
            size,
            is_inline,
        },
        bytes,
    })
}

fn fallback_parse_rfc822(uid: String, raw: &[u8]) -> MailContent {
    let text = String::from_utf8_lossy(raw);
    let (header_part, body_part) = if let Some(idx) = text.find("\r\n\r\n") {
        (&text[..idx], &text[idx + 4..])
    } else if let Some(idx) = text.find("\n\n") {
        (&text[..idx], &text[idx + 2..])
    } else {
        (text.as_ref(), "")
    };

    let subject = decode_encoded_word(&parse_header(header_part, "Subject"));
    let from_raw = parse_header(header_part, "From");
    let (from_name, from_address) = split_from(&from_raw);
    let cc = decode_encoded_word(&parse_header(header_part, "Cc"));
    let bcc = decode_encoded_word(&parse_header(header_part, "Bcc"));
    let date = parse_header(header_part, "Date");

    MailContent {
        id: uid,
        subject,
        from_name,
        from_address,
        cc,
        bcc,
        date,
        html_body: String::new(), // simplified – full MIME parsing is separate
        plain_body: body_part.chars().take(10000).collect(),
        attachments: vec![],
    }
}

struct AttachmentDescriptor {
    info: AttachmentInfo,
    bytes: Option<Vec<u8>>,
}

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

fn parse_header(headers: &str, name: &str) -> String {
    let wanted = name.to_ascii_lowercase();
    let mut current_key = String::new();
    let mut current_value = String::new();

    for line in headers.lines() {
        if line.starts_with(' ') || line.starts_with('\t') {
            if current_key == wanted && !current_value.is_empty() {
                current_value.push(' ');
                current_value.push_str(line.trim());
            }
            continue;
        }

        if current_key == wanted && !current_value.is_empty() {
            return decode_encoded_word(current_value.trim());
        }

        current_key.clear();
        current_value.clear();

        if let Some((key, value)) = line.split_once(':') {
            current_key = key.trim().to_ascii_lowercase();
            if current_key == wanted {
                current_value = value.trim().to_string();
            }
        }
    }

    if current_key == wanted && !current_value.is_empty() {
        return decode_encoded_word(current_value.trim());
    }

    String::new()
}

fn parse_content_type(value: &str) -> String {
    value
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase()
}

fn parse_importance(headers: &str) -> i32 {
    let importance = parse_header(headers, "Importance").to_ascii_lowercase();
    match importance.as_str() {
        "high" => 2,
        "normal" => 1,
        "low" => 0,
        _ => {
            let x_priority = parse_header(headers, "X-Priority");
            let digit = x_priority
                .chars()
                .find(|ch| ch.is_ascii_digit())
                .and_then(|ch| ch.to_digit(10))
                .unwrap_or(3);
            match digit {
                1 | 2 => 2,
                3 => 1,
                4 | 5 => 0,
                _ => 1,
            }
        }
    }
}

fn parse_category(headers: &str) -> String {
    let x_category = parse_header(headers, "X-Category");
    if !x_category.is_empty() {
        return x_category;
    }
    parse_header(headers, "Keywords")
}

fn parse_labels(headers: &str) -> Vec<String> {
    let keywords = parse_header(headers, "Keywords");
    if !keywords.is_empty() {
        let mut labels = Vec::new();
        for part in keywords.split(',') {
            let label = part.trim();
            if label.is_empty() {
                continue;
            }
            if !labels.iter().any(|existing| existing == label) {
                labels.push(label.to_string());
            }
        }
        if !labels.is_empty() {
            return labels;
        }
    }

    let category = parse_header(headers, "X-Category");
    if category.is_empty() {
        return Vec::new();
    }

    vec![category]
}

fn decode_encoded_word(s: &str) -> String {
    // Minimal RFC 2047 decoder for common =?charset?Q/B?encoded?= patterns
    let mut result = s.to_string();
    let mut search_from = 0;

    while let Some(start) = result[search_from..].find("=?") {
        let abs_start = search_from + start;
        if let Some(end) = result[abs_start..].find("?=") {
            let abs_end = abs_start + end + 2;
            let encoded = &result[abs_start..abs_end];
            let decoded = decode_rfc2047(encoded);

            // Replace this specific occurrence
            result.replace_range(abs_start..abs_end, &decoded);

            // Advance search_from past the decoded part to avoid re-scanning it
            search_from = abs_start + decoded.len();
        } else {
            break;
        }
    }
    result.trim().to_string()
}

fn decode_rfc2047(token: &str) -> String {
    // token looks like =?UTF-8?B?base64data?= or =?UTF-8?Q?qp_data?=
    let inner = token.trim_start_matches("=?").trim_end_matches("?=");
    let parts: Vec<&str> = inner.splitn(3, '?').collect();
    if parts.len() < 3 {
        return token.to_string();
    }
    let _charset = parts[0];
    let encoding = parts[1].to_ascii_uppercase();
    let data = parts[2];

    let bytes: Vec<u8> = match encoding.as_str() {
        "B" => match base64_decode(data) {
            Ok(b) => b,
            Err(_) => return token.to_string(),
        },
        "Q" => qp_decode(data),
        _ => return token.to_string(),
    };

    String::from_utf8_lossy(&bytes).to_string()
}

fn base64_decode(s: &str) -> Result<Vec<u8>, ()> {
    // Simple base64 decode without external crate
    let alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut buf = Vec::new();
    let chars: Vec<u8> = s
        .bytes()
        .filter(|&b| b != b'=')
        .map(|b| alphabet.find(b as char).unwrap_or(0) as u8)
        .collect();
    let mut i = 0;
    while i + 3 < chars.len() {
        buf.push((chars[i] << 2) | (chars[i + 1] >> 4));
        buf.push((chars[i + 1] << 4) | (chars[i + 2] >> 2));
        buf.push((chars[i + 2] << 6) | chars[i + 3]);
        i += 4;
    }
    if i + 2 < chars.len() {
        buf.push((chars[i] << 2) | (chars[i + 1] >> 4));
        buf.push((chars[i + 1] << 4) | (chars[i + 2] >> 2));
    } else if i + 1 < chars.len() {
        buf.push((chars[i] << 2) | (chars[i + 1] >> 4));
    }
    Ok(buf)
}

fn qp_decode(s: &str) -> Vec<u8> {
    let s = s.replace('_', " ");
    let mut bytes = Vec::new();
    let mut chars = s.bytes().peekable();
    while let Some(b) = chars.next() {
        if b == b'=' {
            let h1 = chars.next().unwrap_or(0);
            let h2 = chars.next().unwrap_or(0);
            let hex = format!("{}{}", h1 as char, h2 as char);
            if let Ok(val) = u8::from_str_radix(&hex, 16) {
                bytes.push(val);
            }
        } else {
            bytes.push(b);
        }
    }
    bytes
}

fn split_from(from: &str) -> (String, String) {
    // "Name <email@example.com>" or just "email@example.com"
    if let (Some(lt), Some(gt)) = (from.find('<'), from.find('>')) {
        let name = from[..lt].trim().trim_matches('"').to_string();
        let address = from[lt + 1..gt].trim().to_string();
        (name, address)
    } else {
        (String::new(), from.trim().to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::{build_imap_advanced_query, parse_labels};
    use crate::mail_models::{AdvancedSearchRequest, ReadStatus};

    #[test]
    fn parse_labels_splits_and_dedupes_keywords() {
        let labels = parse_labels("Keywords: Work, Urgent, Work,  , Clients\r\n");
        assert_eq!(labels, vec!["Work", "Urgent", "Clients"]);
    }

    #[test]
    fn parse_labels_falls_back_to_x_category() {
        let labels = parse_labels("X-Category: FollowUp\r\n");
        assert_eq!(labels, vec!["FollowUp"]);
    }

    #[test]
    fn parse_labels_returns_empty_without_keywords_or_category() {
        let labels = parse_labels("Subject: Hello\r\n");
        assert!(labels.is_empty());
    }

    #[test]
    fn build_imap_advanced_query_defaults_to_all() {
        let req = AdvancedSearchRequest::default();
        assert_eq!(build_imap_advanced_query(&req), "ALL");
    }

    #[test]
    fn build_imap_advanced_query_adds_unseen() {
        let mut req = AdvancedSearchRequest::default();
        req.read_status = Some(ReadStatus::Unread);
        assert_eq!(build_imap_advanced_query(&req), "UNSEEN");
    }

    #[test]
    fn build_imap_advanced_query_formats_date_range_inclusive_end() {
        let mut req = AdvancedSearchRequest::default();
        req.date_start = Some("2026-03-01".to_string());
        req.date_end = Some("2026-03-09".to_string());
        assert_eq!(
            build_imap_advanced_query(&req),
            "SENTSINCE 01-Mar-2026 SENTBEFORE 10-Mar-2026"
        );
    }

    #[test]
    fn build_imap_advanced_query_escapes_quotes_and_backslashes() {
        let mut req = AdvancedSearchRequest::default();
        req.subject = Some(r#"Hello "world" \\ test"#.to_string());
        assert_eq!(
            build_imap_advanced_query(&req),
            r#"SUBJECT "Hello \"world\" \\\\ test""#
        );
    }
}
