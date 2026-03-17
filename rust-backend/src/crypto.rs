use std::path::Path;

use anyhow::{anyhow, bail, Context, Result};
use chacha20poly1305::aead::Aead;
use chacha20poly1305::{Key, KeyInit, XChaCha20Poly1305, XNonce};
use hkdf::Hkdf;
use rand::RngCore;
use sha2::Sha256;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use zeroize::Zeroizing;

pub const KEYRING_PROMPT: &str = "Guvercin needs access to its encryption key.";
const MASTER_KEY_LEN: usize = 32;

const FILE_MAGIC: &[u8; 5] = b"GVCN1";
const FILE_VERSION: u8 = 1;
const FILE_NONCE_LEN: usize = 16;
const FILE_TAG_LEN: usize = 16;
const DEFAULT_CHUNK_SIZE: usize = 64 * 1024;

#[derive(Clone)]
pub struct CryptoManager {
    master_key: Zeroizing<Vec<u8>>,
}

impl CryptoManager {
    pub fn from_raw(raw: Vec<u8>) -> Result<Self> {
        if raw.is_empty() {
            bail!("master key is empty");
        }
        if raw.len() != MASTER_KEY_LEN {
            bail!("stored master key has invalid length");
        }
        Ok(Self {
            master_key: Zeroizing::new(raw),
        })
    }

    pub async fn create_and_store(
        prompt: &str,
    ) -> std::result::Result<Self, crate::keystore::KeyStoreError> {
        let mut raw = vec![0u8; MASTER_KEY_LEN];
        rand::thread_rng().fill_bytes(&mut raw);
        crate::keystore::store_master_key(prompt, &raw).await?;

        Self::from_raw(raw).map_err(|e| crate::keystore::KeyStoreError::Other(e.to_string()))
    }

    pub fn derive_key(&self, context: &[u8]) -> Result<Zeroizing<[u8; 32]>> {
        let hk = Hkdf::<Sha256>::new(None, &self.master_key);
        let mut out = Zeroizing::new([0u8; 32]);
        hk.expand(context, out.as_mut())
            .map_err(|_| anyhow!("hkdf expand failed"))?;
        Ok(out)
    }

    pub fn sqlcipher_key_hex_for_db(&self, path: &Path) -> Result<String> {
        let info = format!("db:{}", path.display());
        let key = self.derive_key(info.as_bytes())?;
        Ok(hex::encode(&*key))
    }

    pub fn file_key(&self, purpose: &str) -> Result<Zeroizing<[u8; 32]>> {
        let info = format!("file:{purpose}");
        self.derive_key(info.as_bytes())
    }
}

pub async fn encrypt_bytes_to_file(key: &[u8; 32], data: &[u8], path: &Path) -> Result<()> {
    let mut file = tokio::fs::File::create(path).await?;
    write_encrypted_header(&mut file, DEFAULT_CHUNK_SIZE).await?;
    let cipher = XChaCha20Poly1305::new(Key::from_slice(key));

    let base_nonce = random_file_nonce();
    file.write_all(&base_nonce).await?;

    let mut counter: u64 = 0;
    for chunk in data.chunks(DEFAULT_CHUNK_SIZE) {
        let nonce = stream_nonce(&base_nonce, counter);
        let ciphertext = cipher
            .encrypt(XNonce::from_slice(&nonce), chunk)
            .map_err(|e| anyhow!("failed to encrypt file chunk: {:?}", e))?;
        write_frame(&mut file, &ciphertext).await?;
        counter = counter.saturating_add(1);
    }

    file.flush().await?;
    Ok(())
}

pub async fn decrypt_file_to_bytes(key: &[u8; 32], path: &Path) -> Result<Vec<u8>> {
    let mut file = tokio::fs::File::open(path).await?;
    let (chunk_size, base_nonce) = read_encrypted_header(&mut file).await?;
    let cipher = XChaCha20Poly1305::new(Key::from_slice(key));

    let mut counter: u64 = 0;
    let mut out = Vec::new();
    while let Some(ciphertext) = read_frame(&mut file).await? {
        if ciphertext.len() > chunk_size + FILE_TAG_LEN {
            bail!("encrypted frame size exceeds configured chunk size");
        }
        let nonce = stream_nonce(&base_nonce, counter);
        let plaintext = cipher
            .decrypt(XNonce::from_slice(&nonce), ciphertext.as_ref())
            .map_err(|e| anyhow!("failed to decrypt file chunk: {:?}", e))?;
        out.extend_from_slice(&plaintext);
        counter = counter.saturating_add(1);
    }

    Ok(out)
}

pub async fn encrypt_file_to_file(key: &[u8; 32], src: &Path, dst: &Path) -> Result<()> {
    let mut input = tokio::fs::File::open(src).await?;
    let mut output = tokio::fs::File::create(dst).await?;
    encrypt_reader_to_writer(key, &mut input, &mut output).await?;
    Ok(())
}

pub async fn decrypt_file_to_file(key: &[u8; 32], src: &Path, dst: &Path) -> Result<()> {
    let mut input = tokio::fs::File::open(src).await?;
    let mut output = tokio::fs::File::create(dst).await?;
    decrypt_reader_to_writer(key, &mut input, &mut output).await?;
    Ok(())
}

pub async fn encrypt_reader_to_writer<R, W>(
    key: &[u8; 32],
    reader: &mut R,
    writer: &mut W,
) -> Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    write_encrypted_header(writer, DEFAULT_CHUNK_SIZE).await?;
    let cipher = XChaCha20Poly1305::new(Key::from_slice(key));

    let base_nonce = random_file_nonce();
    writer.write_all(&base_nonce).await?;

    let mut counter: u64 = 0;
    let mut buf = vec![0u8; DEFAULT_CHUNK_SIZE];
    loop {
        let n = reader.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        let nonce = stream_nonce(&base_nonce, counter);
        let ciphertext = cipher
            .encrypt(XNonce::from_slice(&nonce), &buf[..n])
            .map_err(|e| anyhow!("failed to encrypt file chunk: {:?}", e))?;
        write_frame(writer, &ciphertext).await?;
        counter = counter.saturating_add(1);
    }

    writer.flush().await?;
    Ok(())
}

pub async fn decrypt_reader_to_writer<R, W>(
    key: &[u8; 32],
    reader: &mut R,
    writer: &mut W,
) -> Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let (chunk_size, base_nonce) = read_encrypted_header(reader).await?;
    let cipher = XChaCha20Poly1305::new(Key::from_slice(key));

    let mut counter: u64 = 0;
    while let Some(ciphertext) = read_frame(reader).await? {
        if ciphertext.len() > chunk_size + FILE_TAG_LEN {
            bail!("encrypted frame size exceeds configured chunk size");
        }
        let nonce = stream_nonce(&base_nonce, counter);
        let plaintext = cipher
            .decrypt(XNonce::from_slice(&nonce), ciphertext.as_ref())
            .map_err(|e| anyhow!("failed to decrypt file chunk: {:?}", e))?;
        writer.write_all(&plaintext).await?;
        counter = counter.saturating_add(1);
    }

    writer.flush().await?;
    Ok(())
}

fn random_file_nonce() -> [u8; FILE_NONCE_LEN] {
    let mut out = [0u8; FILE_NONCE_LEN];
    rand::thread_rng().fill_bytes(&mut out);
    out
}

fn stream_nonce(base: &[u8; FILE_NONCE_LEN], counter: u64) -> [u8; 24] {
    let mut nonce = [0u8; 24];
    nonce[..FILE_NONCE_LEN].copy_from_slice(base);
    nonce[FILE_NONCE_LEN..].copy_from_slice(&counter.to_be_bytes());
    nonce
}

async fn write_encrypted_header<W: AsyncWrite + Unpin>(
    writer: &mut W,
    chunk_size: usize,
) -> Result<()> {
    writer.write_all(FILE_MAGIC).await?;
    writer.write_all(&[FILE_VERSION]).await?;
    writer.write_all(&(chunk_size as u32).to_be_bytes()).await?;
    Ok(())
}

async fn read_encrypted_header<R: AsyncRead + Unpin>(
    reader: &mut R,
) -> Result<(usize, [u8; FILE_NONCE_LEN])> {
    let mut magic = [0u8; FILE_MAGIC.len()];
    reader.read_exact(&mut magic).await?;
    if &magic != FILE_MAGIC {
        bail!("invalid encrypted file header");
    }

    let mut version = [0u8; 1];
    reader.read_exact(&mut version).await?;
    if version[0] != FILE_VERSION {
        bail!("unsupported encrypted file version");
    }

    let mut chunk_buf = [0u8; 4];
    reader.read_exact(&mut chunk_buf).await?;
    let chunk_size = u32::from_be_bytes(chunk_buf) as usize;
    if chunk_size == 0 || chunk_size > (1024 * 1024 * 16) {
        bail!("invalid encrypted file chunk size");
    }

    let mut base_nonce = [0u8; FILE_NONCE_LEN];
    reader.read_exact(&mut base_nonce).await?;

    Ok((chunk_size, base_nonce))
}

async fn write_frame<W: AsyncWrite + Unpin>(writer: &mut W, frame: &[u8]) -> Result<()> {
    let len = u32::try_from(frame.len()).context("frame length overflow")?;
    writer.write_all(&len.to_be_bytes()).await?;
    writer.write_all(frame).await?;
    Ok(())
}

async fn read_frame<R: AsyncRead + Unpin>(reader: &mut R) -> Result<Option<Vec<u8>>> {
    let mut len_buf = [0u8; 4];
    if !read_exact_or_eof(reader, &mut len_buf).await? {
        return Ok(None);
    }

    let len = u32::from_be_bytes(len_buf) as usize;
    if len == 0 {
        bail!("invalid encrypted frame length");
    }

    let mut frame = vec![0u8; len];
    reader.read_exact(&mut frame).await?;
    Ok(Some(frame))
}

async fn read_exact_or_eof<R: AsyncRead + Unpin>(
    reader: &mut R,
    buf: &mut [u8],
) -> Result<bool> {
    let mut read = 0;
    while read < buf.len() {
        let n = reader.read(&mut buf[read..]).await?;
        if n == 0 {
            if read == 0 {
                return Ok(false);
            }
            bail!("unexpected eof while reading encrypted frame");
        }
        read += n;
    }
    Ok(true)
}
