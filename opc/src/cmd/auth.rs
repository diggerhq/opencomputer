//! `opc login`, `logout` and `whoami`. The same device login and the same
//! configuration file as the `opencomputer` CLI.

use super::{Ctx, print_json, println_out};
use crate::cli::{JsonOnly, LoginArgs};
use crate::config::{Config, KeySource, Login};
use crate::error::{Error, Result};
use crate::http::Http;
use http::Method;
use serde_json::{Value, json};
use std::time::{Duration, Instant};

/// The credential's name: the machine's.
fn credential_name() -> String {
    let host = std::env::var("HOSTNAME")
        .ok()
        .or_else(|| std::fs::read_to_string("/etc/hostname").ok())
        .or_else(|| std::process::Command::new("hostname").output().ok().and_then(|o| String::from_utf8(o.stdout).ok()))
        .unwrap_or_default();
    let clean: String = host.trim().chars().filter(|c| !c.is_control()).collect();
    let clean = clean.split('.').next().unwrap_or("").to_string();
    if clean.is_empty() { "opc".to_string() } else { clean.chars().take(100).collect() }
}

/// A connection that sends no credential.
fn anonymous(config: &Config) -> Result<Http> {
    let mut c = config.clone();
    c.api_key = None;
    c.key_source = None;
    Http::new(&c)
}

fn with_key(config: &Config, key: &str) -> Result<Http> {
    let mut c = config.clone();
    c.api_key = Some(key.to_string());
    Http::new(&c)
}

pub async fn login(ctx: &mut Ctx, a: LoginArgs) -> Result<i32> {
    if !ctx.tty.stdin || !ctx.tty.stderr {
        return Err(Error::new("not_logged_in", "opc login needs a terminal to confirm the code").hint("in scripts and CI, set OPENCOMPUTER_API_KEY"));
    }
    if ctx.config.key_source == Some(KeySource::Env) && !a.force {
        return Err(Error::usage("OPENCOMPUTER_API_KEY is set and takes precedence: unset it, or pass --force"));
    }
    if ctx.http.has_key() && !a.force && let Ok(me) = ctx.http.get("/me", &[]).await {
        eprintln!("Already logged in as {}. opc login --force to log in again.", who(&me));
        return Ok(0);
    }
    let anon = anonymous(&ctx.config)?;
    let receipt = anon.call_root(Method::POST, "/auth/cli/device", None).await?.body;
    let s = |k: &str| receipt.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let (device, code, url) = (s("device_code"), s("user_code"), s("verification_uri_complete"));
    let expires = receipt.get("expires_in").and_then(Value::as_u64).unwrap_or(0);
    let mut interval = receipt.get("interval").and_then(Value::as_u64).unwrap_or(0);
    if device.is_empty() || code.is_empty() || expires == 0 || interval == 0 {
        return Err(Error::new("internal", "OpenComputer returned an incomplete login response"));
    }
    if !url.starts_with("https://") && !url.starts_with("http://localhost") && !url.starts_with("http://127.0.0.1") {
        return Err(Error::new("internal", "OpenComputer returned an unsafe login link"));
    }
    eprintln!("  Open {url} and enter the code\n      {code}");
    if !a.no_browser {
        super::manage::open_browser(&url);
    }
    eprintln!("  Waiting for confirmation… (Ctrl+C to cancel)");
    let name = credential_name();
    let deadline = Instant::now() + Duration::from_secs(expires);
    let credential = loop {
        if Instant::now() + Duration::from_secs(interval) >= deadline {
            return Err(Error::new("not_logged_in", "the code expired: run opc login again"));
        }
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(interval)) => {}
            _ = tokio::signal::ctrl_c() => return Err(Error::new("interrupted", "login cancelled")),
        }
        let body = json!({"device_code": device, "credential_name": name});
        let got = anon.call_root(Method::POST, "/auth/cli/device/exchange", Some(&body)).await?.body;
        if got.get("status").and_then(Value::as_str) == Some("authorized") {
            break got.get("credential").cloned().unwrap_or(Value::Null);
        }
        interval = interval.max(got.get("retry_after").and_then(Value::as_u64).unwrap_or(interval));
    };
    let key = credential.get("key").and_then(Value::as_str).filter(|k| !k.is_empty()).ok_or_else(|| Error::new("internal", "the login returned no credential"))?.to_string();
    let me = with_key(&ctx.config, &key)?.get("/me", &[]).await?;
    let previous = if a.force { ctx.config.file.api_key.clone() } else { None };
    let login = Login {
        credential_id: credential.get("id").and_then(Value::as_str).map(String::from),
        key_prefix: credential.get("key_prefix").and_then(Value::as_str).map(String::from),
        name: credential.get("name").and_then(Value::as_str).map(String::from).or(Some(name.clone())),
    };
    ctx.config.save_login(&key, login)?;
    if let Some(old) = previous.filter(|o| *o != key) {
        // Revoke the credential this one replaces; failing that is not fatal.
        if let Ok(h) = with_key(&ctx.config, &old) {
            let _ = h.call_root(Method::DELETE, "/auth/cli/credential", None).await;
        }
    }
    ctx.reload()?;
    let org = me.pointer("/organization/name").and_then(Value::as_str).unwrap_or("");
    eprintln!("✓ Logged in as {} · {org}", who(&me));
    eprintln!("  Credential \"{name}\" saved to {}", tilde(&ctx.config.path));
    Ok(0)
}

fn who(me: &Value) -> String {
    let name = me.pointer("/person/name").and_then(Value::as_str).unwrap_or("you");
    match me.pointer("/person/email").and_then(Value::as_str) {
        Some(e) => format!("{name} ({e})"),
        None => name.to_string(),
    }
}

fn tilde(p: &std::path::Path) -> String {
    let home = crate::config::home();
    match p.strip_prefix(&home) {
        Ok(rest) => format!("~/{}", rest.display()),
        Err(_) => p.display().to_string(),
    }
}

pub async fn logout(ctx: &mut Ctx) -> Result<i32> {
    if ctx.config.file.api_key.is_none() {
        if ctx.config.key_source == Some(KeySource::Env) {
            return Err(Error::usage("the credential comes from OPENCOMPUTER_API_KEY: unset it to log out"));
        }
        ctx.note("not logged in");
        return Ok(0);
    }
    let key = ctx.config.file.api_key.clone().unwrap_or_default();
    let revoked = match with_key(&ctx.config, &key) {
        Ok(h) => h.call_root(Method::DELETE, "/auth/cli/credential", None).await.map(|_| ()),
        Err(e) => Err(e),
    };
    ctx.config.clear_login()?;
    match revoked {
        Ok(_) => ctx.note("logged out"),
        Err(e) => ctx.note(&format!(
            "logged out on this machine, but the credential could not be revoked ({}): revoke it on the dashboard under Settings → API keys",
            e.message
        )),
    }
    Ok(0)
}

pub async fn whoami(ctx: &Ctx, a: JsonOnly) -> Result<i32> {
    ctx.require_key()?;
    let me = ctx.http.get("/me", &[]).await?;
    if let Some(u) = crate::wire::reconnect::wire_url_from_me(&me) {
        crate::cache::set_wire_url(&ctx.config.api_url, &u);
    }
    if a.json {
        print_json(ctx, &me);
        return Ok(0);
    }
    let g = |p: &str| me.pointer(p).and_then(Value::as_str).unwrap_or("").to_string();
    println_out(&who(&me));
    println_out(&format!("organization  {}", g("/organization/name")));
    let kind = g("/credential/kind");
    let created = g("/credential/createdAt");
    let mut cred = format!("credential    {}", g("/credential/name"));
    if !kind.is_empty() {
        cred.push_str(&format!(" ({kind})"));
    }
    if created.len() >= 10 {
        cred.push_str(&format!(" · created {}", &created[..10]));
    }
    println_out(&cred);
    println_out(&format!("api           {}", ctx.config.api_url));
    let computer = match g("/computer/status").as_str() {
        "not_set_up" => "not set up".to_string(),
        "" => "unknown".to_string(),
        s => s.to_string(),
    };
    println_out(&format!("computer      {computer}"));
    Ok(0)
}
