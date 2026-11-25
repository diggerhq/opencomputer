//! Workspace routes on a real directory per session: list, read, download a
//! tar (zstd when asked), and upload a tar with the docs' rules.

use super::http::Out;
use super::model::{ApiErr, Idem, Shared, now, rand_str};
use bytes::Bytes;
use serde_json::{Map, Value, json};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

/// The session's workspace, created with one repository on first use.
pub fn dir(sh: &Shared, sid: &str) -> PathBuf {
    let d = sh.workspace_root.join(sid);
    if !d.exists() {
        let repo = d.join("billing-service");
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        std::fs::write(repo.join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
        std::fs::write(repo.join("README.md"), "# billing-service\n").unwrap();
    }
    d
}

fn iso(t: std::time::SystemTime) -> String {
    let t = time::OffsetDateTime::from(t);
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z", t.year(), t.month() as u8, t.day(), t.hour(), t.minute(), t.second(), t.millisecond())
}

fn check_path(p: &str) -> Result<(), ApiErr> {
    let path = Path::new(p);
    if path.is_absolute() || path.components().any(|c| matches!(c, Component::ParentDir | Component::RootDir | Component::Prefix(_))) {
        return Err(ApiErr::field(400, "invalid_path", "path", "path is absolute or contains .."));
    }
    Ok(())
}

fn qs(q: &Map<String, Value>, k: &str) -> Option<String> {
    q.get(k).and_then(Value::as_str).map(str::to_string)
}

fn header(h: &[(String, String)], name: &str) -> Option<String> {
    h.iter().find(|(k, _)| k == name).map(|(_, v)| v.clone())
}

#[allow(clippy::too_many_arguments)]
pub async fn handle(sh: &Arc<Shared>, method: &str, sid: &str, rest: &str, q: &Map<String, Value>, headers: &[(String, String)], body: Bytes, actor: Value, idem: Option<String>) -> Result<Out, ApiErr> {
    let root = dir(sh, sid);
    match (method, rest) {
        ("GET", "files") => list(sh, sid, &root, q),
        ("GET", "file") => {
            let p = qs(q, "path").ok_or_else(|| ApiErr::bad("path", "path is required"))?;
            check_path(&p)?;
            let f = root.join(&p);
            let meta = std::fs::metadata(&f).ok().filter(|m| m.is_file()).ok_or_else(|| ApiErr::new(404, "path_not_found", format!("no file {p}")))?;
            if meta.len() > 100 * 1024 * 1024 {
                return Err(ApiErr::new(413, "too_large", "the file is over 100 MiB"));
            }
            let bytes = std::fs::read(&f).unwrap();
            let etag = format!("\"{:016x}\"", fnv(&bytes));
            if header(headers, "if-none-match").as_deref() == Some(etag.as_str()) {
                return Ok(Out::Raw { status: 304, content_type: "application/octet-stream".into(), body: vec![], headers: vec![("etag".into(), etag)] });
            }
            let ct = if std::str::from_utf8(&bytes).is_ok() { "text/plain; charset=utf-8" } else { "application/octet-stream" };
            Ok(Out::Raw { status: 200, content_type: ct.into(), body: bytes, headers: vec![("etag".into(), etag)] })
        }
        ("GET", "archive") => {
            let p = qs(q, "path").unwrap_or_default();
            check_path(&p)?;
            let target = if p.is_empty() { root.clone() } else { root.join(&p) };
            let meta = std::fs::symlink_metadata(&target).map_err(|_| ApiErr::new(404, "path_not_found", format!("nothing at {p}")))?;
            let mut b = tar::Builder::new(Vec::new());
            b.follow_symlinks(false);
            if meta.is_dir() {
                append_dir(&mut b, &target, Path::new("")).unwrap();
            } else {
                b.append_path_with_name(&target, target.file_name().unwrap()).unwrap();
            }
            let tar = b.into_inner().unwrap();
            let zstd_ok = header(headers, "accept-encoding").is_some_and(|a| a.split(',').any(|e| e.trim().starts_with("zstd")));
            if zstd_ok {
                let z = zstd::encode_all(&tar[..], 3).unwrap();
                return Ok(Out::Raw { status: 200, content_type: "application/x-tar".into(), body: z, headers: vec![("content-encoding".into(), "zstd".into())] });
            }
            Ok(Out::Raw { status: 200, content_type: "application/x-tar".into(), body: tar, headers: vec![] })
        }
        ("PUT", "archive") => upload(sh, sid, &root, q, headers, body, actor, idem),
        _ => Err(ApiErr::new(404, "not_found", format!("no route {method} workspace/{rest}"))),
    }
}

fn fnv(b: &[u8]) -> u64 {
    b.iter().fold(0xcbf29ce484222325u64, |h, x| (h ^ *x as u64).wrapping_mul(0x100000001b3))
}

fn append_dir(b: &mut tar::Builder<Vec<u8>>, dir: &Path, rel: &Path) -> std::io::Result<()> {
    let mut entries: Vec<_> = std::fs::read_dir(dir)?.filter_map(Result::ok).collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        if e.file_name() == ".git" {
            continue;
        }
        let name = rel.join(e.file_name());
        let ft = e.file_type()?;
        if ft.is_dir() {
            b.append_dir(&name, e.path())?;
            append_dir(b, &e.path(), &name)?;
        } else {
            b.append_path_with_name(e.path(), &name)?;
        }
    }
    Ok(())
}

fn list(sh: &Arc<Shared>, sid: &str, root: &Path, q: &Map<String, Value>) -> Result<Out, ApiErr> {
    let p = qs(q, "path").unwrap_or_default();
    check_path(&p)?;
    let depth = match qs(q, "depth") {
        None => 1,
        Some(d) => d.parse::<usize>().ok().filter(|d| (1..=10).contains(d)).ok_or_else(|| ApiErr::bad("depth", "depth is 1 to 10"))?,
    };
    let limit = match qs(q, "limit") {
        None => 20,
        Some(d) => d.parse::<usize>().ok().filter(|d| (1..=100).contains(d)).ok_or_else(|| ApiErr::bad("limit", "limit is 1 to 100"))?,
    };
    let start = match qs(q, "cursor") {
        None => 0,
        Some(c) => c.strip_prefix('c').and_then(|n| n.parse().ok()).ok_or_else(|| ApiErr::new(400, "invalid_cursor", "unknown cursor"))?,
    };
    let base = if p.is_empty() { root.to_path_buf() } else { root.join(&p) };
    if !base.is_dir() {
        return Err(ApiErr::new(404, "path_not_found", format!("no directory {p}")));
    }
    let uploads = sh.read(|w| w.sess(sid).map(|s| s.uploads.clone()))?;
    let mut all = vec![];
    walk(root, &base, depth, &uploads, &mut all);
    let end = (start + limit).min(all.len());
    let next = if end < all.len() { json!(format!("c{end}")) } else { Value::Null };
    Ok(Out::Json(200, json!({"path": p, "entries": all.get(start..end).map(<[Value]>::to_vec).unwrap_or_default(), "nextCursor": next})))
}

fn walk(root: &Path, dir: &Path, depth: usize, uploads: &std::collections::HashMap<String, (String, Value)>, out: &mut Vec<Value>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = rd.filter_map(Result::ok).collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let path = e.path();
        let rel = path.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
        let meta = std::fs::symlink_metadata(&path).unwrap();
        let ty = if meta.file_type().is_symlink() {
            "symlink"
        } else if meta.is_dir() {
            "dir"
        } else {
            "file"
        };
        let (pushed_at, pushed_by) = match uploads.get(&rel) {
            Some((at, by)) => (json!(at), by.clone()),
            None => (Value::Null, Value::Null),
        };
        out.push(json!({
            "path": rel, "type": ty, "bytes": if ty == "file" { json!(meta.len()) } else { Value::Null },
            "modifiedAt": meta.modified().map(iso).unwrap_or_else(|_| now()), "pushedAt": pushed_at, "pushedBy": pushed_by,
        }));
        if ty == "dir" && depth > 1 && e.file_name() != ".git" {
            walk(root, &path, depth - 1, uploads, out);
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn upload(sh: &Arc<Shared>, sid: &str, root: &Path, q: &Map<String, Value>, headers: &[(String, String)], body: Bytes, actor: Value, idem: Option<String>) -> Result<Out, ApiErr> {
    let name = qs(q, "path").unwrap_or_default();
    let valid = !name.is_empty() && !name.starts_with('.') && name.len() <= 255 && name.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b));
    if !valid {
        return Err(ApiErr::field(400, "invalid_path", "path", "a name is one level of letters, digits, ., - and _, not starting with ."));
    }
    let fingerprint = format!("workspace.put {sid} {name} {:016x}", fnv(&body));
    if let Some(key) = &idem
        && let Some((fp, status, resp)) = sh.read(|w| w.idem.get(key).map(|i| (i.fingerprint.clone(), i.status, i.response.clone())))
    {
        if fp != fingerprint {
            return Err(ApiErr::field(409, "idempotency_conflict", "Idempotency-Key", "this Idempotency-Key was used with a different request"));
        }
        return Ok(Out::Json(status, resp));
    }
    let raw = match header(headers, "content-encoding").as_deref() {
        None | Some("identity") => body.to_vec(),
        Some("zstd") => zstd::decode_all(&body[..]).map_err(|e| ApiErr::new(400, "invalid_archive", format!("the body is not zstd: {e}")))?,
        Some(other) => return Err(ApiErr::new(400, "invalid_archive", format!("the fake does not decode {other}"))),
    };
    // Check every entry before writing anything.
    let mut files = 0u64;
    let mut bytes = 0u64;
    {
        let mut a = tar::Archive::new(&raw[..]);
        let entries = a.entries().map_err(|e| ApiErr::new(400, "invalid_archive", format!("not a tar archive: {e}")))?;
        for e in entries {
            let e = e.map_err(|e| ApiErr::new(400, "invalid_archive", format!("not a tar archive: {e}")))?;
            let p = e.path().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
            let path = Path::new(&p);
            let bad_path = path.is_absolute() || path.components().any(|c| matches!(c, Component::ParentDir | Component::RootDir));
            let et = e.header().entry_type();
            let bad_type = et.is_hard_link() || et.is_character_special() || et.is_block_special() || et.is_fifo();
            if bad_path || bad_type {
                return Err(ApiErr::new(400, "invalid_archive", format!("refused entry {p}")).with("entry", p));
            }
            if et.is_file() {
                files += 1;
                bytes += e.header().size().unwrap_or(0);
            }
        }
    }
    let target = root.join(&name);
    let previous = sh.read(|w| w.sess(sid).map(|s| s.uploads.get(&name).cloned()))?;
    if target.exists() && previous.is_none() {
        return Err(ApiErr::field(409, "path_exists", "path", format!("{name} exists and was not uploaded")));
    }
    let tmp = root.join(format!(".upload-{}", rand_str(8)));
    std::fs::create_dir_all(&tmp).unwrap();
    tar::Archive::new(&raw[..]).unpack(&tmp).map_err(|e| {
        let _ = std::fs::remove_dir_all(&tmp);
        ApiErr::new(400, "invalid_archive", format!("could not unpack: {e}"))
    })?;
    if target.exists() {
        std::fs::remove_dir_all(&target).unwrap();
    }
    std::fs::rename(&tmp, &target).unwrap();
    let (status, resp) = sh.with(|w| -> Result<(u16, Value), ApiErr> {
        let at = now();
        w.sess_mut(sid)?.uploads.insert(name.clone(), (at, actor.clone()));
        let seq = w.emit(sid, None, "files.pushed", Some(&actor), json!({"path": name, "files": files, "bytes": bytes, "replaced": previous.is_some()}));
        let replaced = previous.as_ref().map(|(at, by)| json!({"pushedAt": at, "pushedBy": by})).unwrap_or(Value::Null);
        let resp = json!({"upload": {"path": name, "files": files, "bytes": bytes, "replaced": replaced}, "seq": seq});
        if let Some(key) = &idem {
            w.idem.insert(key.clone(), Idem { fingerprint: fingerprint.clone(), status: 200, response: resp.clone() });
        }
        Ok((200, resp))
    })?;
    Ok(Out::Json(status, resp))
}
