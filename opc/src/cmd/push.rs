//! `opc push` and `--push`: a local directory, filtered by `.gitignore` and
//! `.opcignore`, streamed as one tar+zstd body to
//! `PUT /sessions/{id}/workspace/archive?path={name}`.

use super::transfer::{self, Counters, MAX_BYTES, MAX_FILES};
use super::{Ctx, print_json, println_out, resolve};
use crate::cli::PushArgs;
use crate::error::{Error, Result};
use crate::http::session_path;
use bytes::Bytes;
use http::Method;
use serde_json::{Value, json};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Kind {
    File { size: u64, exec: bool },
    Dir,
    Symlink(PathBuf),
}

#[derive(Debug, Clone)]
pub struct Entry {
    /// Relative to the pushed directory, `/`-separated.
    pub rel: String,
    pub kind: Kind,
    abs: PathBuf,
    mtime: u64,
}

/// What a push sends: every entry, in path order, and the totals the limits
/// apply to (files and links count as files; sizes are file contents).
#[derive(Debug, Default)]
pub struct Plan {
    pub entries: Vec<Entry>,
    pub files: u64,
    pub bytes: u64,
}

impl Plan {
    pub fn within_limits(&self) -> bool {
        self.files <= MAX_FILES && self.bytes <= MAX_BYTES
    }
}

/// Walks `root`: `.git` is always left out; `.gitignore` files in `root`
/// and below, and `.opcignore` files, apply unless `no_ignore`. Hidden files
/// are kept. Links are not followed. Sockets, FIFOs and devices are skipped.
pub fn plan(root: &Path, no_ignore: bool) -> Result<Plan> {
    let mut b = ignore::WalkBuilder::new(root);
    b.standard_filters(false)
        .hidden(false)
        .parents(false)
        .ignore(false)
        .git_global(false)
        .git_exclude(false)
        .require_git(false)
        .follow_links(false)
        .git_ignore(!no_ignore)
        .filter_entry(|e| e.file_name() != ".git")
        .sort_by_file_name(|a, b| a.cmp(b));
    if !no_ignore {
        b.add_custom_ignore_filename(".opcignore");
    }
    let mut plan = Plan::default();
    for item in b.build() {
        let entry = item.map_err(|e| Error::new("io", format!("cannot read {}: {e}", root.display())))?;
        if entry.depth() == 0 {
            continue;
        }
        let abs = entry.path().to_path_buf();
        let rel_path = abs.strip_prefix(root).map_err(|_| Error::new("io", format!("{} is outside {}", abs.display(), root.display())))?;
        let rel = rel_path.components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/");
        let meta = std::fs::symlink_metadata(&abs).map_err(|e| Error::new("io", format!("cannot read {}: {e}", abs.display())))?;
        let mtime = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_secs());
        let ft = meta.file_type();
        let kind = if ft.is_symlink() {
            let target = std::fs::read_link(&abs).map_err(|e| Error::new("io", format!("cannot read the link {}: {e}", abs.display())))?;
            plan.files += 1;
            Kind::Symlink(target)
        } else if ft.is_dir() {
            Kind::Dir
        } else if ft.is_file() {
            plan.files += 1;
            plan.bytes += meta.len();
            Kind::File { size: meta.len(), exec: is_exec(&meta) }
        } else {
            crate::log::debug(&format!("push: skipping {}, not a file, directory or link", abs.display()));
            continue;
        };
        plan.entries.push(Entry { rel, kind, abs, mtime });
    }
    Ok(plan)
}

#[cfg(unix)]
fn is_exec(meta: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    meta.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn is_exec(_meta: &std::fs::Metadata) -> bool {
    false
}

/// A file's contents, exactly `size` bytes, or an error if it shrank while
/// being read (a short entry would corrupt the archive).
struct Exact<R> {
    inner: io::Take<R>,
    left: u64,
    name: String,
}

impl<R: Read> Read for Exact<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let n = self.inner.read(buf)?;
        if n == 0 && self.left > 0 && !buf.is_empty() {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, format!("{} changed while it was being read", self.name)));
        }
        self.left -= n as u64;
        Ok(n)
    }
}

/// Writes the plan as a tar archive (paths relative, no `./` prefix; modes
/// 0755/0644 by the executable bit; owner 0).
pub fn write_tar<W: Write>(plan: &Plan, out: W, counters: &Counters) -> io::Result<W> {
    let mut tar = tar::Builder::new(out);
    for e in &plan.entries {
        let mut h = tar::Header::new_gnu();
        h.set_mtime(e.mtime);
        h.set_uid(0);
        h.set_gid(0);
        match &e.kind {
            Kind::Dir => {
                h.set_entry_type(tar::EntryType::Directory);
                h.set_mode(0o755);
                h.set_size(0);
                tar.append_data(&mut h, format!("{}/", e.rel), io::empty())?;
            }
            Kind::File { size, exec } => {
                h.set_entry_type(tar::EntryType::Regular);
                h.set_mode(if *exec { 0o755 } else { 0o644 });
                h.set_size(*size);
                let f = std::fs::File::open(&e.abs).map_err(|err| io::Error::new(err.kind(), format!("cannot read {}: {err}", e.abs.display())))?;
                tar.append_data(&mut h, &e.rel, Exact { inner: f.take(*size), left: *size, name: e.abs.display().to_string() })?;
                counters.add(1, *size);
            }
            Kind::Symlink(target) => {
                h.set_entry_type(tar::EntryType::Symlink);
                h.set_mode(0o777);
                h.set_size(0);
                tar.append_link(&mut h, &e.rel, target)?;
                counters.add(1, 0);
            }
        }
    }
    tar.into_inner()
}

/// tar, then zstd, into `out`.
fn write_archive<W: Write>(plan: &Plan, out: W, counters: &Counters) -> io::Result<W> {
    let enc = zstd::stream::write::Encoder::new(out, 3)?;
    let enc = write_tar(plan, enc, counters)?;
    let mut out = enc.finish()?;
    out.flush()?;
    Ok(out)
}

/// The workspace name: `--to`, else the directory's name.
fn upload_name(dir: &Path, to: Option<&str>) -> Result<String> {
    let rejected = |m: String| Error::new("push_rejected", m).with("reason", "invalid_path");
    match to {
        Some(t) if transfer::valid_upload_name(t) => Ok(t.to_string()),
        Some(t) => Err(rejected(format!(
            "--to {t}: a name is one level under the workspace, of letters, digits, ., - and _, not starting with ."
        ))),
        None => {
            let name = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            if transfer::valid_upload_name(&name) {
                Ok(name)
            } else if name.is_empty() {
                Err(rejected(format!("{} has no name to push it under: pass --to <name>", dir.display())))
            } else {
                Err(rejected(format!("{name} cannot be a workspace name: pass --to <name> (letters, digits, ., - and _)")))
            }
        }
    }
}

/// The directory to push, absolute, checked.
fn local_dir(dir: &Path) -> Result<PathBuf> {
    let abs = std::fs::canonicalize(dir).map_err(|e| Error::usage(format!("{}: {e}", dir.display())))?;
    if !abs.is_dir() {
        return Err(Error::usage(format!("{} is not a directory: opc push sends a directory", dir.display())));
    }
    Ok(abs)
}

fn too_large(plan: &Plan) -> Error {
    Error::new(
        "push_rejected",
        format!(
            "{} and {} is over the limit of 1 GiB and 100,000 files per push: leave some out with .opcignore",
            transfer::files(plan.files),
            transfer::human_bytes(plan.bytes)
        ),
    )
    .with("reason", "too_large")
    .with("files", plan.files)
    .with("bytes", plan.bytes)
}

async fn plan_async(dir: PathBuf, no_ignore: bool) -> Result<Plan> {
    tokio::task::spawn_blocking(move || plan(&dir, no_ignore))
        .await
        .map_err(|e| Error::new("internal", format!("listing files: {e}")))?
}

/// Maps the API's refusals to `push_rejected` with `reason`.
fn map_error(e: Error, name: &str) -> Error {
    let message = match e.code.as_str() {
        "path_exists" => format!("workspace/{name} already exists and was not pushed by opc. Use --to <another name>."),
        "invalid_path" => format!("{name} cannot be a workspace name: {}", e.message),
        "too_large" => "the push is over the limit of 1 GiB and 100,000 files, unpacked: leave some out with .opcignore".into(),
        _ => return e,
    };
    let mut out = Error::new("push_rejected", message).with("reason", e.code.clone());
    for (k, v) in e.extra {
        out.extra.entry(k).or_insert(v);
    }
    out.status = e.status;
    out
}

/// One upload attempt: the archive is built on a blocking thread while the
/// request sends it.
async fn upload_once(ctx: &Ctx, session_id: &str, name: &str, plan: Arc<Plan>, key: &str, counters: Arc<Counters>) -> Result<Value> {
    let (tx, rx) = tokio::sync::mpsc::channel::<io::Result<Bytes>>(8);
    let build = tokio::task::spawn_blocking(move || {
        let abort = tx.clone();
        let r = write_archive(&plan, transfer::ChannelWriter::new(tx), &counters).map(|_| ());
        if let Err(e) = &r {
            // Ends the body with an error: the server discards the upload.
            let _ = abort.blocking_send(Err(io::Error::new(e.kind(), e.to_string())));
        }
        r
    });
    let headers = [("content-type", "application/x-tar".to_string()), ("content-encoding", "zstd".to_string()), ("accept", "application/json".to_string())];
    let query = crate::http::q(&[("path", name)]);
    let path = session_path(session_id, "/workspace/archive");
    let send = async {
        let res = ctx.http.stream(Method::PUT, &path, &query, &headers, transfer::channel_body(rx), Some(key)).await?;
        use http_body_util::BodyExt;
        let bytes = res.into_body().collect().await.map_err(|e| Error::unreachable(format!("reading the response: {e}")))?.to_bytes();
        Ok::<Value, Error>(serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    };
    let (sent, built) = tokio::join!(send, build);
    match built {
        Ok(Err(e)) if e.kind() != io::ErrorKind::BrokenPipe => return Err(Error::new("io", e.to_string())),
        Err(e) => return Err(Error::new("internal", format!("building the archive: {e}"))),
        _ => {}
    }
    sent
}

/// Pushes `dir` into the session's workspace and returns
/// `{sessionId, path, files, bytes, replaced}` (used by `--push` on a new
/// session, with `<key>:upload:<n>`). Prints nothing.
pub async fn push_dir(ctx: &Ctx, session_id: &str, dir: &Path, to: Option<&str>, idempotency_key: Option<String>) -> Result<Value> {
    push(ctx, session_id, dir, to, idempotency_key, false).await.map(|(v, _)| v)
}

async fn push(ctx: &Ctx, session_id: &str, dir: &Path, to: Option<&str>, key: Option<String>, meter: bool) -> Result<(Value, Duration)> {
    let started = Instant::now();
    let abs = local_dir(dir)?;
    let name = upload_name(&abs, to)?;
    // `--push` always applies the ignore files.
    let plan = Arc::new(plan_async(abs, false).await?);
    if !plan.within_limits() {
        return Err(too_large(&plan));
    }
    send_plan(ctx, session_id, &name, plan, key, meter, started).await
}

async fn send_plan(ctx: &Ctx, session_id: &str, name: &str, plan: Arc<Plan>, key: Option<String>, meter: bool, started: Instant) -> Result<(Value, Duration)> {
    let key = key.unwrap_or_else(crate::ids::idempotency_key);
    let budget_end = ctx.http.retry_budget_end();
    let mut attempt = 0u32;
    let body = loop {
        attempt += 1;
        let counters = Arc::new(Counters::default());
        let _meter = transfer::Meter::start(meter, "↑", format!("workspace/{name}"), counters.clone());
        // Safe to repeat: the same key, and a failed upload changes nothing.
        // `429`/`503` (a computer starting) are retried for the same budget
        // as any other call; a dropped connection three times at most.
        let e = match upload_once(ctx, session_id, name, plan.clone(), &key, counters).await {
            Ok(v) => break v,
            Err(e) => e,
        };
        let wait = match ctx.http.retry_wait(&e, attempt, budget_end) {
            Some(w) => w,
            None if attempt < 3 && e.code == "unreachable" => Duration::from_millis(500 * u64::from(attempt)),
            None => return Err(map_error(e, name)),
        };
        crate::log::info(&format!("push: {}; retrying in {}", e.message, crate::timing::ms(wait)));
        tokio::time::sleep(wait).await;
    };
    let upload = body.get("upload").cloned().unwrap_or(Value::Null);
    let out = json!({
        "sessionId": session_id,
        "path": upload.get("path").cloned().unwrap_or_else(|| json!(name)),
        "files": upload.get("files").cloned().unwrap_or_else(|| json!(plan.files)),
        "bytes": upload.get("bytes").cloned().unwrap_or_else(|| json!(plan.bytes)),
        "replaced": upload.get("replaced").cloned().unwrap_or(Value::Null),
    });
    Ok((out, started.elapsed()))
}

/// `↑ billing → workspace/billing · 412 files · 3.1 MB · 0.9 s`, and a line
/// saying what it replaced.
pub fn summary(result: &Value, from: &str, took: Duration) -> String {
    let path = result["path"].as_str().unwrap_or("");
    let mut s = format!(
        "↑ {from} → workspace/{path} · {} · {} · {}",
        transfer::files(result["files"].as_u64().unwrap_or(0)),
        transfer::human_bytes(result["bytes"].as_u64().unwrap_or(0)),
        transfer::human_secs(took)
    );
    if let Some(r) = result.get("replaced").filter(|r| !r.is_null()) {
        let when = r["pushedAt"].as_str().and_then(transfer::ago).map(|a| format!(" (previously pushed {a})")).unwrap_or_default();
        s.push_str(&format!("\nreplaced workspace/{path}{when}"));
    }
    s
}

pub async fn run(ctx: &Ctx, a: PushArgs) -> Result<i32> {
    let dir = a.dir.clone().unwrap_or_else(|| PathBuf::from("."));
    let abs = local_dir(&dir)?;
    let name = upload_name(&abs, a.to.as_deref())?;
    let plan = plan_async(abs.clone(), a.no_ignore).await?;

    if a.dry_run {
        print_dry_run(ctx, &plan, &name, a.json);
        return if plan.within_limits() { Ok(0) } else { Err(too_large(&plan)) };
    }
    if !plan.within_limits() {
        return Err(too_large(&plan));
    }

    let target = a.session.session.as_deref();
    let resolved = resolve::session_or_last(ctx, target, true).await?;
    if target.is_none() {
        announce(ctx, &resolved).await;
    }
    let show = ctx.tty.stderr && !ctx.global.quiet;
    let (result, took) = send_plan(ctx, &resolved.id, &name, Arc::new(plan), a.idempotency_key.clone(), show, Instant::now()).await?;
    if show {
        let from = abs.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| abs.display().to_string());
        eprintln!("{}", summary(&result, &from, took));
    }
    if a.json {
        print_json(ctx, &result);
    }
    Ok(0)
}

/// `pushing to 7f3a "flaky test…" (active 3d ago)`, before sending to the
/// session nobody named.
async fn announce(ctx: &Ctx, r: &resolve::Resolved) {
    let session = match &r.session {
        Some(s) => Some(s.clone()),
        None => match crate::cache::sessions(&ctx.config.api_url).into_iter().find(|s| s.id == r.id) {
            Some(s) => Some(s),
            None => ctx
                .http
                .get(&session_path(&r.id, ""), &[])
                .await
                .ok()
                .and_then(|v| serde_json::from_value::<crate::api::types::Session>(v.get("session").cloned().unwrap_or(v)).ok()),
        },
    };
    let mut line = format!("pushing to {}", crate::ids::short(&r.id));
    if let Some(s) = session {
        let title: String = if s.title.chars().count() > 40 { format!("{}…", s.title.chars().take(40).collect::<String>()) } else { s.title.clone() };
        if !title.is_empty() {
            line.push_str(&format!(" \"{title}\""));
        }
        if let Some(a) = s.last_active_at.as_deref().and_then(transfer::ago) {
            line.push_str(&format!(" (active {a})"));
        }
    }
    if !ctx.global.quiet {
        eprintln!("{line}");
    }
}

fn print_dry_run(ctx: &Ctx, plan: &Plan, name: &str, json: bool) {
    if json {
        let entries: Vec<Value> = plan
            .entries
            .iter()
            .map(|e| match &e.kind {
                Kind::File { size, .. } => json!({"path": e.rel, "type": "file", "bytes": size}),
                Kind::Dir => json!({"path": e.rel, "type": "dir", "bytes": null}),
                Kind::Symlink(t) => json!({"path": e.rel, "type": "symlink", "bytes": null, "target": t.to_string_lossy()}),
            })
            .collect();
        print_json(
            ctx,
            &json!({
                "dryRun": true,
                "path": name,
                "files": plan.files,
                "bytes": plan.bytes,
                "withinLimits": plan.within_limits(),
                "limits": {"files": MAX_FILES, "bytes": MAX_BYTES},
                "entries": entries,
            }),
        );
        return;
    }
    for e in &plan.entries {
        match &e.kind {
            Kind::File { size, .. } => println_out(&format!("{:>8}  {}", transfer::human_bytes(*size), e.rel)),
            Kind::Symlink(t) => println_out(&format!("{:>8}  {} -> {}", "link", e.rel, t.display())),
            Kind::Dir => {}
        }
    }
    println_out(&format!(
        "would send {} · {} → workspace/{name} (limit: 100,000 files and 1 GiB)",
        transfer::files(plan.files),
        transfer::human_bytes(plan.bytes)
    ));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tree() -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        fs::create_dir_all(r.join(".git/objects")).unwrap();
        fs::write(r.join(".git/HEAD"), "ref").unwrap();
        fs::create_dir_all(r.join(".github/workflows")).unwrap();
        fs::write(r.join(".github/workflows/ci.yml"), "on: push").unwrap();
        fs::write(r.join(".gitignore"), "node_modules/\n*.log\n").unwrap();
        fs::write(r.join(".opcignore"), "secret.txt\n").unwrap();
        fs::write(r.join(".env"), "A=1").unwrap();
        fs::write(r.join("secret.txt"), "s").unwrap();
        fs::write(r.join("app.log"), "log").unwrap();
        fs::create_dir_all(r.join("node_modules/x")).unwrap();
        fs::write(r.join("node_modules/x/index.js"), "x").unwrap();
        fs::create_dir_all(r.join("src/sub")).unwrap();
        fs::write(r.join("src/main.rs"), "fn main() {}").unwrap();
        fs::write(r.join("src/sub/.gitignore"), "gen.rs\n").unwrap();
        fs::write(r.join("src/sub/gen.rs"), "gen").unwrap();
        fs::write(r.join("src/sub/keep.rs"), "keep").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::write(r.join("run.sh"), "#!/bin/sh").unwrap();
            fs::set_permissions(r.join("run.sh"), fs::Permissions::from_mode(0o700)).unwrap();
            std::os::unix::fs::symlink("src/main.rs", r.join("link")).unwrap();
        }
        d
    }

    fn paths(p: &Plan) -> Vec<&str> {
        p.entries.iter().map(|e| e.rel.as_str()).collect()
    }

    #[test]
    fn honors_gitignore_and_opcignore_and_skips_git() {
        let d = tree();
        let p = plan(d.path(), false).unwrap();
        let got = paths(&p);
        for want in [".github/workflows/ci.yml", ".gitignore", ".env", "src/main.rs", "src/sub/keep.rs", "src/sub/.gitignore"] {
            assert!(got.contains(&want), "{want} missing from {got:?}");
        }
        for gone in ["secret.txt", "app.log", "node_modules", "node_modules/x/index.js", "src/sub/gen.rs"] {
            assert!(!got.contains(&gone), "{gone} should be ignored: {got:?}");
        }
        assert!(!got.iter().any(|p| p.starts_with(".git/") || *p == ".git"));
        // Path order, a directory before its contents.
        let src = got.iter().position(|p| *p == "src").unwrap();
        assert!(got.iter().position(|p| *p == "src/main.rs").unwrap() > src);
    }

    #[test]
    fn no_ignore_sends_everything_but_git() {
        let d = tree();
        let p = plan(d.path(), true).unwrap();
        let got = paths(&p);
        for want in ["secret.txt", "app.log", "node_modules/x/index.js", "src/sub/gen.rs"] {
            assert!(got.contains(&want), "{want} missing");
        }
        assert!(!got.iter().any(|p| p.starts_with(".git/") || *p == ".git"));
    }

    #[test]
    fn counts_files_and_bytes() {
        let d = tempfile::tempdir().unwrap();
        fs::write(d.path().join("a"), "12345").unwrap();
        fs::create_dir(d.path().join("d")).unwrap();
        fs::write(d.path().join("d/b"), "123").unwrap();
        let p = plan(d.path(), false).unwrap();
        assert_eq!((p.files, p.bytes), (2, 8));
        assert!(p.within_limits());
        let big = Plan { files: MAX_FILES + 1, ..Default::default() };
        assert!(!big.within_limits());
        assert_eq!(too_large(&big).exit_code(), 2);
        assert_eq!(too_large(&big).extra["reason"], "too_large");
    }

    #[test]
    fn archive_round_trips() {
        let d = tree();
        let p = plan(d.path(), false).unwrap();
        let counters = Counters::default();
        let bytes = write_archive(&p, Vec::new(), &counters).unwrap();
        assert_eq!(counters.get().0, p.files);
        let tar_bytes = zstd::decode_all(&bytes[..]).unwrap();
        let mut ar = tar::Archive::new(&tar_bytes[..]);
        let mut seen = Vec::new();
        for e in ar.entries().unwrap() {
            let mut e = e.unwrap();
            let path = e.path().unwrap().to_string_lossy().trim_end_matches('/').to_string();
            assert!(!path.starts_with('/') && !path.starts_with("./") && !path.contains(".."));
            if path == "src/main.rs" {
                let mut s = String::new();
                e.read_to_string(&mut s).unwrap();
                assert_eq!(s, "fn main() {}");
                assert_eq!(e.header().mode().unwrap(), 0o644);
            }
            #[cfg(unix)]
            {
                if path == "run.sh" {
                    assert_eq!(e.header().mode().unwrap(), 0o755);
                }
                if path == "link" {
                    assert_eq!(e.header().entry_type(), tar::EntryType::Symlink);
                    assert_eq!(e.link_name().unwrap().unwrap().to_string_lossy(), "src/main.rs");
                }
            }
            seen.push(path);
        }
        assert_eq!(seen, paths(&p));
    }

    #[test]
    fn names() {
        assert_eq!(upload_name(Path::new("/x/billing"), None).unwrap(), "billing");
        assert_eq!(upload_name(Path::new("/x/billing"), Some("billing-wip")).unwrap(), "billing-wip");
        for bad in [Some("a/b"), Some(".x"), Some("..")] {
            let e = upload_name(Path::new("/x/billing"), bad).unwrap_err();
            assert_eq!(e.code, "push_rejected");
            assert_eq!(e.extra["reason"], "invalid_path");
        }
        assert!(upload_name(Path::new("/x/my project"), None).unwrap_err().message.contains("--to"));
        assert!(upload_name(Path::new("/"), None).is_err());
    }

    #[test]
    fn api_refusals_are_push_rejected() {
        let e = map_error(Error::from_api(409, &json!({"error": {"code": "path_exists", "message": "m"}})), "billing-service");
        assert_eq!(e.code, "push_rejected");
        assert_eq!(e.extra["reason"], "path_exists");
        assert_eq!(e.message, "workspace/billing-service already exists and was not pushed by opc. Use --to <another name>.");
        assert_eq!(e.exit_code(), 2);
        let e = map_error(Error::from_api(413, &json!({"error": {"code": "too_large", "message": "m", "bytes": 5}})), "b");
        assert_eq!((e.extra["reason"].as_str(), e.extra["bytes"].as_u64()), (Some("too_large"), Some(5)));
        let e = map_error(Error::from_api(403, &json!({"error": {"code": "forbidden", "message": "m"}})), "b");
        assert_eq!(e.code, "forbidden");
    }

    #[test]
    fn summary_line() {
        let v = json!({"sessionId": "cs_x", "path": "billing", "files": 412, "bytes": 3_100_000, "replaced": null});
        assert_eq!(summary(&v, "billing", Duration::from_millis(900)), "↑ billing → workspace/billing · 412 files · 3.1 MB · 0.9 s");
        let v = json!({"path": "b", "files": 1, "bytes": 1, "replaced": {"pushedAt": "2020-01-01T00:00:00Z"}});
        assert!(summary(&v, "b", Duration::ZERO).contains("\nreplaced workspace/b (previously pushed "));
    }
}
