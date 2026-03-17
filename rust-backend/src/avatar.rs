
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use sha2::{Digest, Sha256};
use sqlx::SqlitePool;

use crate::crypto::{self, CryptoManager};
use crate::db::AppState;

pub fn email_hash(email: &str) -> String {
    let mut h = Sha256::new();
    h.update(email.to_lowercase().trim().as_bytes());
    hex::encode(h.finalize())
}

fn email_domain(email: &str) -> Option<String> {
    email.rsplit('@').next().map(|d| d.trim().to_lowercase())
}

fn http_client() -> reqwest::Result<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .user_agent("Guvercin/1.0 (avatar resolver)")
        .build()
}

#[derive(Debug)]
pub struct CachedAvatar {
    pub file_path: String,
    pub content_type: String,
}

pub async fn query_cache(pool: &SqlitePool, hash: &str) -> sqlx::Result<Option<CachedAvatar>> {
    let row: Option<(String, String, bool, String)> = sqlx::query_as(
        r#"
        SELECT file_path, content_type, not_found, last_checked
        FROM avatar_cache
        WHERE email_hash = ?
          AND datetime(last_checked, '+30 days') > datetime('now')
        "#,
    )
    .bind(hash)
    .fetch_optional(pool)
    .await?;

    match row {
        Some((fp, ct, not_found, _)) if !not_found && !fp.is_empty() => {
            Ok(Some(CachedAvatar { file_path: fp, content_type: ct }))
        }
        
        Some((_, _, true, _)) => Ok(None),
        _ => Ok(None),
    }
}

pub async fn is_negative_cached(pool: &SqlitePool, hash: &str) -> bool {
    let row: Option<bool> = sqlx::query_scalar(
        r#"
        SELECT not_found FROM avatar_cache
        WHERE email_hash = ?
          AND datetime(last_checked, '+30 days') > datetime('now')
        "#,
    )
    .bind(hash)
    .fetch_optional(pool)
    .await
    .unwrap_or(None);

    row.unwrap_or(false)
}

pub async fn cache_avatar(
    pool: &SqlitePool,
    email: &str,
    hash: &str,
    data: &[u8],
    content_type: &str,
    source: &str,
    cache_dir: &Path,
    crypto: &CryptoManager,
) -> anyhow::Result<PathBuf> {
    tokio::fs::create_dir_all(cache_dir).await?;

    let ext = if content_type.contains("svg") {
        "svg"
    } else if content_type.contains("png") {
        "png"
    } else if content_type.contains("webp") {
        "webp"
    } else {
        "jpg"
    };
    let filename = format!("{hash}.{ext}");
    let path = cache_dir.join(&filename);
    let key = crypto.file_key("avatar-cache")?;
    crypto::encrypt_bytes_to_file(&key, data, &path).await?;

    sqlx::query(
        r#"
        INSERT INTO avatar_cache (email_hash, email, file_path, content_type, source, not_found, last_checked)
        VALUES (?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP)
        ON CONFLICT(email_hash) DO UPDATE SET
            file_path    = excluded.file_path,
            content_type = excluded.content_type,
            source       = excluded.source,
            not_found    = 0,
            last_checked = CURRENT_TIMESTAMP
        "#,
    )
    .bind(hash)
    .bind(email)
    .bind(path.to_string_lossy().as_ref())
    .bind(content_type)
    .bind(source)
    .execute(pool)
    .await?;

    Ok(path)
}

pub async fn cache_not_found(pool: &SqlitePool, email: &str, hash: &str) {
    let _ = sqlx::query(
        r#"
        INSERT INTO avatar_cache (email_hash, email, file_path, content_type, source, not_found, last_checked)
        VALUES (?, ?, '', '', 'none', 1, CURRENT_TIMESTAMP)
        ON CONFLICT(email_hash) DO UPDATE SET
            not_found    = 1,
            last_checked = CURRENT_TIMESTAMP
        "#,
    )
    .bind(hash)
    .bind(email)
    .execute(pool)
    .await;
}

type AvatarResult = Option<(Vec<u8>, String)>; 

async fn try_contact(user_pool: &SqlitePool, email: &str) -> AvatarResult {
    let row: Option<(Vec<u8>,)> = sqlx::query_as(
        "SELECT avatar_data FROM contacts WHERE mail_address = ? AND avatar_data IS NOT NULL LIMIT 1",
    )
    .bind(email)
    .fetch_optional(user_pool)
    .await
    .unwrap_or(None);

    row.and_then(|(blob,)| {
        if blob.is_empty() {
            None
        } else {
            Some((blob, "image/jpeg".to_string()))
        }
    })
}

async fn try_bimi(client: &reqwest::Client, domain: &str) -> AvatarResult {
    
    let host = format!("default._bimi.{domain}");
    
    let doh_url = format!(
        "https://dns.google/resolve?name={}&type=TXT",
        urlencoding_simple(&host)
    );
    let resp = client.get(&doh_url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let json: serde_json::Value = resp.json().await.ok()?;
    let answers = json.get("Answer")?.as_array()?;
    for answer in answers {
        let data = answer.get("data")?.as_str().unwrap_or("");
        
        if data.contains("v=BIMI1") {
            if let Some(logo_url) = extract_bimi_logo(data) {
                if let Ok(img_resp) = client.get(&logo_url).send().await {
                    if img_resp.status().is_success() {
                        let ct = img_resp
                            .headers()
                            .get("content-type")
                            .and_then(|v| v.to_str().ok())
                            .unwrap_or("image/svg+xml")
                            .to_string();
                        let bytes = img_resp.bytes().await.ok()?;
                        if !bytes.is_empty() {
                            return Some((bytes.to_vec(), ct));
                        }
                    }
                }
            }
        }
    }
    None
}

fn extract_bimi_logo(txt: &str) -> Option<String> {
    for part in txt.split(';') {
        let kv: Vec<&str> = part.splitn(2, '=').collect();
        if kv.len() == 2 && kv[0].trim().to_lowercase() == "l" {
            let url = kv[1].trim().trim_matches('"').trim();
            if !url.is_empty() && url.starts_with("http") {
                return Some(url.to_string());
            }
        }
    }
    None
}

async fn try_google_profile(client: &reqwest::Client, email: &str) -> AvatarResult {
    let url = format!(
        "https://profiles.google.com/s2/photos/profile/{}",
        urlencoding_simple(email)
    );
    let resp = client.get(&url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let final_url = resp.url().to_string();
    
    if !final_url.contains("/photo/") && !final_url.contains("s96-c") {
        return None;
    }
    let ct = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("image/jpeg")
        .to_string();
    if !ct.starts_with("image/") {
        return None;
    }
    let bytes = resp.bytes().await.ok()?;
    if bytes.is_empty() {
        return None;
    }
    Some((bytes.to_vec(), ct))
}

async fn try_gravatar(client: &reqwest::Client, email: &str) -> AvatarResult {
    let hash = format!("{:x}", md5::compute(email.to_lowercase().trim()));
    let url = format!("https://www.gravatar.com/avatar/{hash}?d=404&s=128");
    let resp = client.get(&url).send().await.ok()?;
    if resp.status() == 404 || !resp.status().is_success() {
        return None;
    }
    let ct = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("image/jpeg")
        .to_string();
    let bytes = resp.bytes().await.ok()?;
    if bytes.is_empty() {
        return None;
    }
    Some((bytes.to_vec(), ct))
}

async fn try_clearbit(client: &reqwest::Client, domain: &str) -> AvatarResult {
    let url = format!("https://logo.clearbit.com/{domain}");
    let resp = client.get(&url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let ct = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("image/png")
        .to_string();
    if !ct.starts_with("image/") {
        return None;
    }
    let bytes = resp.bytes().await.ok()?;
    if bytes.is_empty() {
        return None;
    }
    Some((bytes.to_vec(), ct))
}

async fn try_google_favicon(client: &reqwest::Client, domain: &str) -> AvatarResult {
    let url = format!(
        "https://www.google.com/s2/favicons?domain={}&sz=128",
        urlencoding_simple(domain)
    );
    let resp = client.get(&url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let ct = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("image/png")
        .to_string();
    let bytes = resp.bytes().await.ok()?;
    
    if bytes.len() < 200 {
        return None;
    }
    Some((bytes.to_vec(), ct))
}

async fn try_og_image(client: &reqwest::Client, domain: &str) -> AvatarResult {
    let root = format!("https://{domain}");
    let resp = client
        .get(&root)
        .timeout(Duration::from_secs(8))
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let html = resp.text().await.ok()?;

    let candidate_urls: Vec<String> = {
        let doc = scraper::Html::parse_document(&html);
        let selectors: &[(&str, &str)] = &[
            ("meta[property='og:image']", "content"),
            ("meta[name='og:image']", "content"),
            ("link[rel='apple-touch-icon']", "href"),
            ("link[rel='apple-touch-icon-precomposed']", "href"),
        ];
        let mut urls = Vec::new();
        for (selector_str, attr) in selectors {
            if let Ok(sel) = scraper::Selector::parse(selector_str) {
                for el in doc.select(&sel) {
                    if let Some(val) = el.value().attr(attr) {
                        let url = resolve_url(val, &root);
                        if !url.is_empty() {
                            urls.push(url);
                        }
                    }
                }
            }
        }
        urls
        
    };

    for img_url in candidate_urls {
        if let Ok(img_resp) = client.get(&img_url).send().await {
            if img_resp.status().is_success() {
                let ct = img_resp
                    .headers()
                    .get("content-type")
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("image/png")
                    .to_string();
                if ct.starts_with("image/") {
                    let bytes = img_resp.bytes().await.ok()?;
                    if !bytes.is_empty() {
                        return Some((bytes.to_vec(), ct));
                    }
                }
            }
        }
    }
    None
}

async fn try_favicon_ico(client: &reqwest::Client, domain: &str) -> AvatarResult {
    let url = format!("https://{domain}/favicon.ico");
    let resp = client.get(&url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let ct = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("image/x-icon")
        .to_string();
    let bytes = resp.bytes().await.ok()?;
    if bytes.is_empty() {
        return None;
    }
    Some((bytes.to_vec(), ct))
}

pub async fn run_waterfall(
    email: String,
    account_id: i64,
    state: Arc<AppState>,
) {
    let hash = email_hash(&email);
    let Some(inner) = state.ready_or_none().await else {
        return;
    };
    let pool = &inner.general_pool;

    if let Ok(Some(_)) = query_cache(pool, &hash).await {
        return;
    }

    let domain = match email_domain(&email) {
        Some(d) => d,
        None => {
            cache_not_found(pool, &email, &hash).await;
            return;
        }
    };

    let client = match http_client() {
        Ok(c) => c,
        Err(_) => return,
    };

    let cache_dir = build_avatar_cache_dir();

    if let Ok(user_pool) = crate::db::get_user_db_pool(&state, account_id).await {
        if let Some((data, ct)) = try_contact(&user_pool, &email).await {
            let _ = cache_avatar(
                pool,
                &email,
                &hash,
                &data,
                &ct,
                "contact",
                &cache_dir,
                &inner.crypto,
            )
                    .await;
            return;
        }
    }

    if let Some((data, ct)) = try_bimi(&client, &domain).await {
        let _ = cache_avatar(pool, &email, &hash, &data, &ct, "bimi", &cache_dir, &inner.crypto)
            .await;
        return;
    }

    if let Some((data, ct)) = try_google_profile(&client, &email).await {
        let _ = cache_avatar(
            pool,
            &email,
            &hash,
            &data,
            &ct,
            "google",
            &cache_dir,
            &inner.crypto,
        )
                .await;
        return;
    }

    if let Some((data, ct)) = try_gravatar(&client, &email).await {
        let _ = cache_avatar(
            pool,
            &email,
            &hash,
            &data,
            &ct,
            "gravatar",
            &cache_dir,
            &inner.crypto,
        )
                .await;
        return;
    }

    if let Some((data, ct)) = try_clearbit(&client, &domain).await {
        let _ = cache_avatar(
            pool,
            &email,
            &hash,
            &data,
            &ct,
            "clearbit",
            &cache_dir,
            &inner.crypto,
        )
                .await;
        return;
    }

    if let Some((data, ct)) = try_google_favicon(&client, &domain).await {
        let _ = cache_avatar(
            pool,
            &email,
            &hash,
            &data,
            &ct,
            "google_favicon",
            &cache_dir,
            &inner.crypto,
        )
        .await;
        return;
    }

    if let Some((data, ct)) = try_og_image(&client, &domain).await {
        let _ = cache_avatar(
            pool,
            &email,
            &hash,
            &data,
            &ct,
            "og_image",
            &cache_dir,
            &inner.crypto,
        )
        .await;
        return;
    }

    if let Some((data, ct)) = try_favicon_ico(&client, &domain).await {
        let _ = cache_avatar(
            pool,
            &email,
            &hash,
            &data,
            &ct,
            "favicon",
            &cache_dir,
            &inner.crypto,
        )
                .await;
        return;
    }

    cache_not_found(pool, &email, &hash).await;
}

pub fn build_avatar_cache_dir() -> PathBuf {
    if let Some(home) = dirs::home_dir() {
        return home.join(".cache").join("guvercin").join("avatars");
    }
    PathBuf::from("/tmp/guvercin/avatars")
}

pub fn spawn_resolve(email: String, account_id: i64, state: Arc<AppState>) {
    tokio::spawn(async move {
        run_waterfall(email, account_id, state).await;
    });
}

fn urlencoding_simple(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9'
            | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

fn resolve_url(href: &str, base: &str) -> String {
    if href.starts_with("http://") || href.starts_with("https://") {
        href.to_string()
    } else if href.starts_with("//") {
        format!("https:{href}")
    } else if href.starts_with('/') {
        
        let base_trimmed = base.trim_end_matches('/');
        format!("{base_trimmed}{href}")
    } else {
        format!("{base}/{href}")
    }
}
