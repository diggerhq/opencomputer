//! The configuration file shared with the `opencomputer` CLI, and where the
//! credential comes from.
//!
//! `~/.opencomputer/config.json` (or `OPENCOMPUTER_CONFIG`):
//! `{ apiUrl, apiKey, login: { credentialId, keyPrefix, name } }`, written
//! atomically with mode 0600 in a 0700 directory, only by `opc login`.
//! `OPENCOMPUTER_API_KEY` beats the file, and the file's key is used only when
//! the file's `apiUrl` is the one in use, so a staging key never goes to
//! production.

use crate::error::{Error, Result};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};

pub const DEFAULT_API_URL: &str = "https://app.opencomputer.dev";
pub const API_PREFIX: &str = "/api/managed-agents/computer";
pub const DEFAULT_WIRE_URL: &str = "wss://wire.opencomputer.dev/v1";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Login {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credential_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key_prefix: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

/// The file as written by either CLI. Unknown fields are kept on rewrite.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigFile {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub login: Option<Login>,
    #[serde(flatten)]
    pub other: Map<String, Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeySource {
    Env,
    File,
}

#[derive(Clone)]
pub struct Config {
    pub path: PathBuf,
    pub file: ConfigFile,
    /// The normalized API URL, without a trailing slash: `https://app.opencomputer.dev`.
    pub api_url: String,
    pub api_key: Option<String>,
    pub key_source: Option<KeySource>,
    /// Problems reading the file, for `opc doctor`.
    pub file_error: Option<String>,
}

impl std::fmt::Debug for Config {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Config")
            .field("path", &self.path)
            .field("api_url", &self.api_url)
            .field("api_key", &self.api_key.as_ref().map(|_| "<redacted>"))
            .field("key_source", &self.key_source)
            .finish()
    }
}

pub fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

pub fn config_path() -> PathBuf {
    match std::env::var_os("OPENCOMPUTER_CONFIG") {
        Some(p) if !p.is_empty() => PathBuf::from(p),
        _ => home().join(".opencomputer").join("config.json"),
    }
}

pub fn state_dir() -> PathBuf {
    match std::env::var_os("OPC_STATE_DIR") {
        Some(p) if !p.is_empty() => PathBuf::from(p),
        _ => home().join(".opencomputer").join("opc"),
    }
}

/// As the `opencomputer` CLI does: https only (http on localhost),
/// trailing slashes and a trailing `/api` stripped.
pub fn normalize_api_url(raw: &str) -> Result<String> {
    let mut s = raw.trim().trim_end_matches('/').to_string();
    if let Some(stripped) = s.strip_suffix("/api") {
        s = stripped.trim_end_matches('/').to_string();
    }
    let (scheme, rest) = s
        .split_once("://")
        .ok_or_else(|| Error::usage(format!("OPENCOMPUTER_API_URL is not a URL: {raw}")))?;
    let host = rest.split(['/', ':']).next().unwrap_or("");
    let local = matches!(host, "localhost" | "127.0.0.1" | "[::1]" | "::1") || host.ends_with(".localhost");
    match scheme {
        "https" => {}
        "http" if local => {}
        _ => return Err(Error::usage(format!("the API URL must use https: {raw}"))),
    }
    Ok(s)
}

impl Config {
    pub fn load() -> Self {
        let path = config_path();
        let (file, file_error) = match std::fs::read(&path) {
            Ok(bytes) => match serde_json::from_slice::<ConfigFile>(&bytes) {
                Ok(f) => (f, None),
                Err(e) => (ConfigFile::default(), Some(format!("{} is not valid JSON: {e}", path.display()))),
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (ConfigFile::default(), None),
            Err(e) => (ConfigFile::default(), Some(format!("cannot read {}: {e}", path.display()))),
        };
        let env_url = std::env::var("OPENCOMPUTER_API_URL").ok().filter(|s| !s.trim().is_empty());
        let raw_url = env_url.clone().or_else(|| file.api_url.clone()).unwrap_or_else(|| DEFAULT_API_URL.into());
        let (api_url, url_error) = match normalize_api_url(&raw_url) {
            Ok(u) => (u, None),
            Err(e) => (DEFAULT_API_URL.to_string(), Some(e.message)),
        };
        let file_url = file.api_url.as_deref().and_then(|u| normalize_api_url(u).ok());
        let file_url_matches = file_url.as_deref().unwrap_or(DEFAULT_API_URL) == api_url;
        let (api_key, key_source) = match std::env::var("OPENCOMPUTER_API_KEY") {
            Ok(k) if !k.trim().is_empty() => (Some(k.trim().to_string()), Some(KeySource::Env)),
            _ => match &file.api_key {
                Some(k) if !k.is_empty() && file_url_matches => (Some(k.clone()), Some(KeySource::File)),
                _ => (None, None),
            },
        };
        Config { path, file, api_url, api_key, key_source, file_error: file_error.or(url_error) }
    }

    /// The Computer API's base: `https://app.opencomputer.dev/api/managed-agents/computer`.
    pub fn api_base(&self) -> String {
        format!("{}{}", self.api_url, API_PREFIX)
    }

    pub fn require_key(&self) -> Result<&str> {
        self.api_key.as_deref().ok_or_else(Error::not_logged_in)
    }

    /// The session's page on the dashboard, for when the API has not told us.
    pub fn dashboard_url(&self, session_id: &str) -> String {
        format!("{}/computer/sessions/{session_id}", self.api_url)
    }

    /// Saves a login: the key, the URL it belongs to and the login's names.
    pub fn save_login(&mut self, key: &str, login: Login) -> Result<()> {
        self.file.api_url = Some(self.api_url.clone());
        self.file.api_key = Some(key.to_string());
        self.file.login = Some(login);
        write_private_json(&self.path, &serde_json::to_value(&self.file)?)?;
        self.api_key = Some(key.to_string());
        self.key_source = Some(KeySource::File);
        Ok(())
    }

    pub fn clear_login(&mut self) -> Result<()> {
        self.file.api_key = None;
        self.file.login = None;
        if self.path.exists() {
            write_private_json(&self.path, &serde_json::to_value(&self.file)?)?;
        }
        if self.key_source == Some(KeySource::File) {
            self.api_key = None;
            self.key_source = None;
        }
        Ok(())
    }
}

/// Writes JSON atomically (temp file + rename) with mode 0600, creating the
/// directory with mode 0700.
pub fn write_private_json(path: &Path, value: &Value) -> Result<()> {
    let mut bytes = serde_json::to_vec_pretty(value)?;
    bytes.push(b'\n');
    write_private(path, &bytes)
}

pub fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    let dir = path.parent().unwrap_or(Path::new("."));
    create_private_dir(dir)?;
    let tmp = dir.join(format!(
        ".{}.{}.tmp",
        path.file_name().and_then(|n| n.to_str()).unwrap_or("file"),
        crate::ids::random_base32(8)
    ));
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let result = (|| {
        let mut f = opts.open(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        std::fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result.map_err(|e| Error::new("io", format!("cannot write {}: {e}", path.display())))
}

pub fn create_private_dir(dir: &Path) -> Result<()> {
    if dir.as_os_str().is_empty() || dir.exists() {
        return Ok(());
    }
    let mut b = std::fs::DirBuilder::new();
    b.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        b.mode(0o700);
    }
    b.create(dir).map_err(|e| Error::new("io", format!("cannot create {}: {e}", dir.display())))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_urls_like_the_node_cli() {
        assert_eq!(normalize_api_url("https://app.opencomputer.dev/").unwrap(), "https://app.opencomputer.dev");
        assert_eq!(normalize_api_url("https://x.dev/api/").unwrap(), "https://x.dev");
        assert_eq!(normalize_api_url("http://localhost:8787").unwrap(), "http://localhost:8787");
        assert_eq!(normalize_api_url("http://127.0.0.1:1/api").unwrap(), "http://127.0.0.1:1");
        assert!(normalize_api_url("http://example.com").is_err());
        assert!(normalize_api_url("example.com").is_err());
    }

    #[test]
    fn debug_never_shows_the_key() {
        let c = Config {
            path: "x".into(),
            file: ConfigFile::default(),
            api_url: DEFAULT_API_URL.into(),
            api_key: Some("sk_secret".into()),
            key_source: Some(KeySource::Env),
            file_error: None,
        };
        assert!(!format!("{c:?}").contains("sk_secret"));
    }
}
