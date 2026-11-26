//! `opc pull`: `GET /sessions/{id}/workspace/archive?path=…` as tar+zstd,
//! unpacked into a staging directory beside the destination and moved into
//! place, so a failed pull leaves nothing half-written. Every entry is
//! checked: no absolute paths, no `..`, no links that point out of the
//! destination, no writing through links, no hard links or devices.

use super::transfer::{self, Counters, MAX_BYTES, MAX_FILES, safe_relative};
use super::{Ctx, print_json, println_out, resolve};
use crate::cli::PullArgs;
use crate::error::{Error, Result};
use crate::http::session_path;
use http::Method;
use serde_json::{Value, json};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Kind {
    File { size: u64, exec: bool },
    Dir,
    Symlink(PathBuf),
}

#[derive(Debug, Clone)]
pub struct Item {
    /// Relative to the pulled path, `/`-separated.
    pub rel: String,
    pub kind: Kind,
    /// A local file of that name would be replaced.
    pub overwrites: bool,
}

#[derive(Debug, Clone)]
pub struct Options {
    /// The destination as given or defaulted.
    pub dest: PathBuf,
    /// The last part of the remote path: a single file pulled is this entry.
    pub base: String,
    pub force: bool,
    pub dry_run: bool,
}

#[derive(Debug, Default)]
pub struct Outcome {
    pub items: Vec<Item>,
    pub files: u64,
    pub bytes: u64,
    /// Where it was written: `dest`, or `dest/<base>` for a file pulled into
    /// an existing directory.
    pub target: PathBuf,
    pub single_file: bool,
    /// The destination has files and `--force` was not given (dry runs only;
    /// a real pull fails instead).
    pub refused: bool,
}

impl Outcome {
    pub fn overwritten(&self) -> Vec<&str> {
        self.items.iter().filter(|i| i.overwrites).map(|i| i.rel.as_str()).collect()
    }
}

fn rejected(reason: &str, message: impl Into<String>) -> Error {
    Error::new("pull_rejected", message).with("reason", reason)
}

fn invalid(message: impl Into<String>) -> Error {
    rejected("invalid_archive", format!("the archive is unsafe to unpack: {}", message.into()))
}

fn io_err(what: &Path, e: io::Error) -> Error {
    Error::new("io", format!("{}: {e}", what.display()))
}

fn not_empty(dest: &Path) -> Error {
    rejected("destination_not_empty", format!("{} already has files: pass --force to write into it (nothing is deleted)", dest.display()))
}

/// A directory with something in it.
fn has_files(p: &Path) -> bool {
    std::fs::read_dir(p).map(|mut d| d.next().is_some()).unwrap_or(false)
}

fn is_dir_nofollow(p: &Path) -> bool {
    std::fs::symlink_metadata(p).map(|m| m.is_dir()).unwrap_or(false)
}

fn exists_nofollow(p: &Path) -> bool {
    std::fs::symlink_metadata(p).is_ok()
}

/// Refuses when any directory between `root` and `root/rel` is a link, so
/// nothing is ever written through one.
fn check_no_links(root: &Path, rel: &Path) -> Result<()> {
    let mut p = root.to_path_buf();
    let parts: Vec<_> = rel.components().collect();
    for c in parts.iter().take(parts.len().saturating_sub(1)) {
        p.push(c);
        if std::fs::symlink_metadata(&p).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err(invalid(format!("{} would be written through the link {}", rel.display(), p.display())));
        }
    }
    Ok(())
}

/// Removes the staging directory however the pull ends.
struct Staging(Option<PathBuf>);

impl Drop for Staging {
    fn drop(&mut self) {
        if let Some(p) = self.0.take() {
            let _ = std::fs::remove_dir_all(p);
        }
    }
}

/// Reads the archive and, unless a dry run, writes it into place.
pub fn unpack<R: Read>(archive: R, opt: &Options, counters: &Counters) -> Result<Outcome> {
    let dest = &opt.dest;
    let dest_is_dir = is_dir_nofollow(dest);
    if exists_nofollow(dest) && !dest_is_dir && std::fs::symlink_metadata(dest).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err(rejected("destination_not_empty", format!("{} is a link: opc pull does not write through links", dest.display())));
    }
    let dest_has_files = dest_is_dir && has_files(dest);

    // Unpack beside the destination (inside it when it exists), so the
    // final moves are renames on one filesystem.
    let mut staging = Staging(None);
    let stage = if opt.dry_run {
        None
    } else {
        let parent = if dest_is_dir {
            dest.clone()
        } else {
            let p = dest.parent().filter(|p| !p.as_os_str().is_empty()).map_or_else(|| PathBuf::from("."), Path::to_path_buf);
            std::fs::create_dir_all(&p).map_err(|e| io_err(&p, e))?;
            p
        };
        let s = parent.join(format!(".opc-pull-{}", crate::ids::random_base32(10).to_ascii_lowercase()));
        std::fs::create_dir(&s).map_err(|e| io_err(&s, e))?;
        staging.0 = Some(s.clone());
        Some(s)
    };

    let mut out = Outcome::default();
    let mut ar = tar::Archive::new(archive);
    let entries = ar.entries().map_err(|e| invalid(e.to_string()))?;
    let mut count = 0usize;
    for entry in entries {
        let mut entry = entry.map_err(|e| invalid(format!("cannot read it: {e}")))?;
        let raw = entry.path().map_err(|e| invalid(e.to_string()))?.to_string_lossy().into_owned();
        let rel = safe_relative(&raw).map_err(invalid)?;
        if rel.as_os_str().is_empty() || rel.components().any(|c| c.as_os_str() == ".git") {
            continue;
        }
        let rel_s = rel.components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/");
        let h = entry.header();
        let kind = match h.entry_type() {
            tar::EntryType::Regular | tar::EntryType::Continuous => {
                Kind::File { size: entry.size(), exec: h.mode().unwrap_or(0o644) & 0o111 != 0 }
            }
            tar::EntryType::Directory => Kind::Dir,
            tar::EntryType::Symlink => {
                let target = entry.link_name().map_err(|e| invalid(e.to_string()))?.map(|t| t.into_owned()).unwrap_or_default();
                if target.as_os_str().is_empty() || !transfer::link_stays_inside(&rel, &target) {
                    return Err(invalid(format!("the link {rel_s} points outside it, to {}", target.display())));
                }
                Kind::Symlink(target)
            }
            tar::EntryType::XGlobalHeader => continue,
            t => return Err(invalid(format!("{rel_s} is a {t:?} entry; only files, directories and links are unpacked"))),
        };
        if let Kind::File { size, .. } = kind {
            out.files += 1;
            out.bytes += size;
        } else if let Kind::Symlink(_) = kind {
            out.files += 1;
        }
        if out.files > MAX_FILES || out.bytes > MAX_BYTES {
            return Err(rejected("too_large", "the pull is over the limit of 1 GiB and 100,000 files: pull a smaller path"));
        }
        count += 1;
        // Only a lone file named like the path is a file pull; anything
        // more is a directory, and the destination's rule applies now,
        // before the rest downloads.
        let maybe_single = count == 1 && matches!(kind, Kind::File { .. }) && rel_s == opt.base;
        if !maybe_single && exists_nofollow(dest) && !dest_is_dir {
            return Err(rejected("destination_not_empty", format!("{} is a file, and workspace/{} is a directory", dest.display(), opt.base)));
        }
        if !maybe_single && dest_has_files && !opt.force {
            if !opt.dry_run {
                return Err(not_empty(dest));
            }
            out.refused = true;
        }
        let overwrites = !matches!(kind, Kind::Dir) && exists_nofollow(&dest.join(&rel));
        if let Some(stage) = &stage {
            check_no_links(stage, &rel)?;
            let path = stage.join(&rel);
            write_entry(&mut entry, &path, &kind)?;
        }
        if let Kind::File { size, .. } = kind {
            counters.add(1, size);
        }
        out.items.push(Item { rel: rel_s, kind, overwrites });
    }

    out.single_file = out.items.len() == 1 && matches!(out.items[0].kind, Kind::File { .. }) && out.items[0].rel == opt.base;
    out.target = if out.single_file && dest_is_dir { dest.join(&opt.base) } else { dest.clone() };
    if out.single_file {
        let exists = exists_nofollow(&out.target);
        out.items[0].overwrites = exists;
        if exists && is_dir_nofollow(&out.target) {
            return Err(rejected("destination_not_empty", format!("{} is a directory", out.target.display())));
        }
        if exists && !opt.force {
            if !opt.dry_run {
                return Err(rejected("destination_not_empty", format!("{} exists: pass --force to overwrite it", out.target.display())));
            }
            out.refused = true;
        }
    }
    let Some(stage) = stage else { return Ok(out) };

    if out.single_file {
        let from = stage.join(&opt.base);
        std::fs::rename(&from, &out.target).map_err(|e| io_err(&out.target, e))?;
    } else if !exists_nofollow(dest) {
        // A new destination: one rename of the whole tree.
        std::fs::rename(&stage, dest).map_err(|e| io_err(dest, e))?;
        staging.0 = None;
    } else {
        merge(&stage, dest, &out.items)?;
    }
    Ok(out)
}

fn write_entry<R: Read>(entry: &mut R, path: &Path, kind: &Kind) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| io_err(parent, e))?;
    }
    if exists_nofollow(path) && !matches!(kind, Kind::Dir) {
        // A repeated entry: the later one wins.
        let _ = std::fs::remove_file(path);
    }
    match kind {
        Kind::Dir => std::fs::create_dir_all(path).map_err(|e| io_err(path, e))?,
        Kind::File { exec, .. } => {
            let mut f = std::fs::File::create(path).map_err(|e| io_err(path, e))?;
            io::copy(entry, &mut f).map_err(|e| io_err(path, e))?;
            set_exec(&f, *exec).map_err(|e| io_err(path, e))?;
        }
        Kind::Symlink(target) => make_link(target, path)?,
    }
    Ok(())
}

#[cfg(unix)]
fn set_exec(f: &std::fs::File, exec: bool) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    f.set_permissions(std::fs::Permissions::from_mode(if exec { 0o755 } else { 0o644 }))
}

#[cfg(not(unix))]
fn set_exec(_f: &std::fs::File, _exec: bool) -> io::Result<()> {
    Ok(())
}

#[cfg(unix)]
fn make_link(target: &Path, path: &Path) -> Result<()> {
    std::os::unix::fs::symlink(target, path).map_err(|e| io_err(path, e))
}

#[cfg(not(unix))]
fn make_link(target: &Path, path: &Path) -> Result<()> {
    crate::log::warn(&format!("{} is a link to {}; links are not created on this system", path.display(), target.display()));
    Ok(())
}

/// Moves each staged entry into an existing destination: directories are
/// created, files and links replace what has their name, nothing else is
/// touched, and nothing is written through a local link.
fn merge(stage: &Path, dest: &Path, items: &[Item]) -> Result<()> {
    for item in items {
        let rel = PathBuf::from(&item.rel);
        let to = dest.join(&rel);
        if let Err(e) = check_no_links(dest, &rel) {
            return Err(rejected("destination_not_empty", e.message.replace("the archive is unsafe to unpack: ", "")));
        }
        match item.kind {
            Kind::Dir => {
                if !is_dir_nofollow(&to) {
                    if exists_nofollow(&to) {
                        return Err(rejected("destination_not_empty", format!("{} is a file here and a directory in the workspace", to.display())));
                    }
                    std::fs::create_dir_all(&to).map_err(|e| io_err(&to, e))?;
                }
            }
            _ => {
                if is_dir_nofollow(&to) {
                    return Err(rejected("destination_not_empty", format!("{} is a directory here and a file in the workspace", to.display())));
                }
                if let Some(p) = to.parent() {
                    std::fs::create_dir_all(p).map_err(|e| io_err(p, e))?;
                }
                std::fs::rename(stage.join(&rel), &to).map_err(|e| io_err(&to, e))?;
            }
        }
    }
    Ok(())
}

/// `./q3` for a relative destination, as people type it.
fn shown(p: &Path) -> String {
    let s = p.display().to_string();
    if p.is_absolute() || s.starts_with('.') || s.starts_with('~') { s } else { format!("./{s}") }
}

/// The remote path, checked and normalized (`""` is the workspace).
fn remote_path(p: &str) -> Result<(String, String)> {
    let rel = safe_relative(p.trim()).map_err(|m| Error::usage(format!("{m}: the path is relative to the workspace, without ..")))?;
    let s = rel.components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/");
    let base = rel.file_name().map_or_else(|| "workspace".to_string(), |n| n.to_string_lossy().into_owned());
    Ok((s, base))
}

fn map_error(e: Error, remote: &str) -> Error {
    let shown = if remote.is_empty() { "workspace".to_string() } else { format!("workspace/{remote}") };
    let message = match e.code.as_str() {
        "path_not_found" => format!("{shown} does not exist"),
        "too_large" => format!("{shown} is over the limit of 1 GiB and 100,000 files: pull a smaller path"),
        "invalid_path" => return Error::usage(format!("{remote}: {}", e.message)),
        _ => return e,
    };
    let mut out = rejected(&e.code, message);
    for (k, v) in e.extra {
        out.extra.entry(k).or_insert(v);
    }
    out.status = e.status;
    out
}

pub async fn run(ctx: &Ctx, a: PullArgs) -> Result<i32> {
    let started = Instant::now();
    let (remote, base) = remote_path(&a.path)?;
    let dest = a.dir.clone().unwrap_or_else(|| PathBuf::from(&base));
    let resolved = resolve::session_or_last(ctx, a.session.session.as_deref(), true).await?;

    // Fails before downloading when the answer is certain.
    if !a.force && !a.dry_run && is_dir_nofollow(&dest) && has_files(&dest) && a.dir.is_none() {
        return Err(not_empty(&dest));
    }

    let mut query = Vec::new();
    if !remote.is_empty() {
        query = crate::http::q(&[("path", remote.as_str())]);
    }
    let headers = [("accept", "application/x-tar".to_string()), ("accept-encoding", "zstd".to_string())];
    let res = ctx
        .http
        .stream(Method::GET, &session_path(&resolved.id, "/workspace/archive"), &query, &headers, crate::http::empty(), None)
        .await
        .map_err(|e| map_error(e, &remote))?;
    let encoding = res.headers().get("content-encoding").and_then(|v| v.to_str().ok()).unwrap_or("").trim().to_ascii_lowercase();
    let zstd = match encoding.as_str() {
        "zstd" => true,
        "" | "identity" => false,
        other => return Err(Error::new("invalid_response", format!("the archive came as {other}, which opc cannot read"))),
    };

    let (tx, rx) = tokio::sync::mpsc::channel(16);
    let forward = tokio::spawn(transfer::forward_body(res.into_body(), tx));
    let counters = Arc::new(Counters::default());
    let show = ctx.tty.stderr && !ctx.global.quiet && !a.dry_run;
    let meter = transfer::Meter::start(show, "↓", format!("workspace/{remote}"), counters.clone());
    let opt = Options { dest: dest.clone(), base, force: a.force, dry_run: a.dry_run };
    let c2 = counters.clone();
    let outcome = tokio::task::spawn_blocking(move || {
        let reader = transfer::ChannelReader::new(rx);
        if zstd {
            let dec = zstd::stream::read::Decoder::new(reader).map_err(|e| Error::new("io", e.to_string()))?;
            unpack(dec, &opt, &c2)
        } else {
            unpack(reader, &opt, &c2)
        }
    })
    .await
    .map_err(|e| Error::new("internal", format!("unpacking: {e}")))?;
    forward.abort();
    drop(meter);
    let outcome = outcome?;

    let overwritten = outcome.overwritten();
    if a.dry_run {
        if a.json {
            let entries: Vec<Value> = outcome
                .items
                .iter()
                .map(|i| match &i.kind {
                    Kind::File { size, .. } => json!({"path": i.rel, "type": "file", "bytes": size, "overwrites": i.overwrites}),
                    Kind::Dir => json!({"path": i.rel, "type": "dir", "bytes": null, "overwrites": false}),
                    Kind::Symlink(t) => json!({"path": i.rel, "type": "symlink", "bytes": null, "target": t.to_string_lossy(), "overwrites": i.overwrites}),
                })
                .collect();
            print_json(
                ctx,
                &json!({
                    "dryRun": true,
                    "sessionId": resolved.id,
                    "path": remote,
                    "dir": outcome.target.display().to_string(),
                    "files": outcome.files,
                    "bytes": outcome.bytes,
                    "overwritten": overwritten,
                    "entries": entries,
                }),
            );
        } else {
            for i in &outcome.items {
                let mark = if i.overwrites { "  (overwrites)" } else { "" };
                match &i.kind {
                    Kind::File { size, .. } => println_out(&format!("{:>8}  {}{mark}", transfer::human_bytes(*size), i.rel)),
                    Kind::Symlink(t) => println_out(&format!("{:>8}  {} -> {}{mark}", "link", i.rel, t.display())),
                    Kind::Dir => {}
                }
            }
            let over = if overwritten.is_empty() { String::new() } else { format!(", overwriting {}", transfer::files(overwritten.len() as u64)) };
            println_out(&format!(
                "would write {} · {} to {}{over}",
                transfer::files(outcome.files),
                transfer::human_bytes(outcome.bytes),
                shown(&outcome.target)
            ));
        }
        return if outcome.refused { Err(not_empty(&outcome.target)) } else { Ok(0) };
    }

    if show {
        eprintln!(
            "↓ workspace/{remote} → {} · {} · {} · {}",
            shown(&outcome.target),
            transfer::files(outcome.files),
            transfer::human_bytes(outcome.bytes),
            transfer::human_secs(started.elapsed())
        );
    }
    if a.json {
        print_json(
            ctx,
            &json!({
                "sessionId": resolved.id,
                "path": remote,
                "dir": outcome.target.display().to_string(),
                "files": outcome.files,
                "bytes": outcome.bytes,
                "overwritten": overwritten,
            }),
        );
    }
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    enum E<'a> {
        F(&'a str, &'a str),
        D(&'a str),
        L(&'a str, &'a str),
        H(&'a str, &'a str),
    }

    /// Builds a tar with raw header names, so unsafe paths survive.
    fn archive(entries: &[E]) -> Vec<u8> {
        let mut b = tar::Builder::new(Vec::new());
        for e in entries {
            let mut h = tar::Header::new_gnu();
            let (name, kind, data, link): (&str, tar::EntryType, &[u8], Option<&str>) = match e {
                E::F(n, d) => (n, tar::EntryType::Regular, d.as_bytes(), None),
                E::D(n) => (n, tar::EntryType::Directory, b"", None),
                E::L(n, t) => (n, tar::EntryType::Symlink, b"", Some(t)),
                E::H(n, t) => (n, tar::EntryType::Link, b"", Some(t)),
            };
            h.set_entry_type(kind);
            h.set_size(data.len() as u64);
            h.set_mode(0o644);
            {
                let gnu = h.as_gnu_mut().unwrap();
                gnu.name[..name.len()].copy_from_slice(name.as_bytes());
                if let Some(t) = link {
                    gnu.linkname[..t.len()].copy_from_slice(t.as_bytes());
                }
            }
            h.set_cksum();
            b.append(&h, data).unwrap();
        }
        b.into_inner().unwrap()
    }

    fn opts(dest: &Path, base: &str) -> Options {
        Options { dest: dest.to_path_buf(), base: base.into(), force: false, dry_run: false }
    }

    fn run_unpack(bytes: &[u8], o: &Options) -> Result<Outcome> {
        unpack(bytes, o, &Counters::default())
    }

    fn no_staging_left(dir: &Path) {
        for e in fs::read_dir(dir).unwrap() {
            let n = e.unwrap().file_name().to_string_lossy().into_owned();
            assert!(!n.starts_with(".opc-pull-"), "staging left behind: {n}");
        }
    }

    #[test]
    fn unpacks_a_directory_into_a_new_destination() {
        let t = tempfile::tempdir().unwrap();
        let dest = t.path().join("q3");
        let bytes = archive(&[E::D("sub/"), E::F("sub/a.txt", "hello"), E::F("b.txt", "x"), E::L("l", "sub/a.txt")]);
        let out = run_unpack(&bytes, &opts(&dest, "q3")).unwrap();
        assert_eq!((out.files, out.bytes), (3, 6));
        assert_eq!(fs::read_to_string(dest.join("sub/a.txt")).unwrap(), "hello");
        #[cfg(unix)]
        assert_eq!(fs::read_to_string(dest.join("l")).unwrap(), "hello");
        no_staging_left(t.path());
    }

    #[test]
    fn rejects_unsafe_entries_and_writes_nothing() {
        let cases: Vec<Vec<E>> = vec![
            vec![E::F("ok.txt", "1"), E::F("../evil", "x")],
            vec![E::F("/etc/evil", "x")],
            vec![E::F("a/../../evil", "x")],
            vec![E::L("l", "/etc")],
            vec![E::L("d/l", "../../outside")],
            vec![E::H("h", "ok.txt")],
            // A link inside, then a write through it.
            vec![E::L("l", "."), E::F("l/x", "x")],
        ];
        for (i, entries) in cases.iter().enumerate() {
            let t = tempfile::tempdir().unwrap();
            let dest = t.path().join("out");
            let err = run_unpack(&archive(entries), &opts(&dest, "out")).unwrap_err();
            assert_eq!(err.code, "pull_rejected", "case {i}: {}", err.message);
            assert_eq!(err.extra["reason"], "invalid_archive", "case {i}");
            assert!(!dest.exists(), "case {i}: the destination was created");
            assert!(!t.path().parent().unwrap().join("evil").exists());
            no_staging_left(t.path());
        }
    }

    #[test]
    fn refuses_a_destination_with_files_unless_forced() {
        let t = tempfile::tempdir().unwrap();
        let dest = t.path().join("billing");
        fs::create_dir(&dest).unwrap();
        fs::write(dest.join("mine.txt"), "mine").unwrap();
        fs::write(dest.join("a.txt"), "old").unwrap();
        let bytes = archive(&[E::F("a.txt", "new"), E::F("b.txt", "b")]);
        let err = run_unpack(&bytes, &opts(&dest, "billing")).unwrap_err();
        assert_eq!(err.extra["reason"], "destination_not_empty");
        assert_eq!(fs::read_to_string(dest.join("a.txt")).unwrap(), "old");

        // A dry run lists what it would overwrite and writes nothing.
        let dry = run_unpack(&bytes, &Options { dry_run: true, force: true, ..opts(&dest, "billing") }).unwrap();
        assert_eq!(dry.overwritten(), vec!["a.txt"]);
        assert!(!dest.join("b.txt").exists());
        let dry = run_unpack(&bytes, &Options { dry_run: true, ..opts(&dest, "billing") }).unwrap();
        assert!(dry.refused);

        let out = run_unpack(&bytes, &Options { force: true, ..opts(&dest, "billing") }).unwrap();
        assert_eq!(out.overwritten(), vec!["a.txt"]);
        assert_eq!(fs::read_to_string(dest.join("a.txt")).unwrap(), "new");
        assert_eq!(fs::read_to_string(dest.join("mine.txt")).unwrap(), "mine");
        no_staging_left(&dest);
    }

    #[test]
    fn an_empty_directory_is_filled() {
        let t = tempfile::tempdir().unwrap();
        let out = run_unpack(&archive(&[E::F("a", "1"), E::F("b", "2")]), &opts(t.path(), "x")).unwrap();
        assert_eq!(out.files, 2);
        assert_eq!(fs::read_to_string(t.path().join("b")).unwrap(), "2");
        no_staging_left(t.path());
    }

    #[cfg(unix)]
    #[test]
    fn never_writes_through_a_local_link() {
        let t = tempfile::tempdir().unwrap();
        let outside = t.path().join("outside");
        fs::create_dir(&outside).unwrap();
        let dest = t.path().join("dest");
        fs::create_dir(&dest).unwrap();
        std::os::unix::fs::symlink(&outside, dest.join("sub")).unwrap();
        let bytes = archive(&[E::D("sub/"), E::F("sub/x", "x")]);
        let err = run_unpack(&bytes, &Options { force: true, ..opts(&dest, "dest") }).unwrap_err();
        assert_eq!(err.code, "pull_rejected");
        assert!(!outside.join("x").exists());
    }

    #[test]
    fn a_single_file() {
        let t = tempfile::tempdir().unwrap();
        // Into a new path: the file itself.
        let to = t.path().join("q3.csv");
        let out = run_unpack(&archive(&[E::F("q3.csv", "a,b")]), &opts(&to, "q3.csv")).unwrap();
        assert!(out.single_file);
        assert_eq!(fs::read_to_string(&to).unwrap(), "a,b");
        // Again: refused without --force, replaced with it.
        let err = run_unpack(&archive(&[E::F("q3.csv", "c,d")]), &opts(&to, "q3.csv")).unwrap_err();
        assert_eq!(err.extra["reason"], "destination_not_empty");
        run_unpack(&archive(&[E::F("q3.csv", "c,d")]), &Options { force: true, ..opts(&to, "q3.csv") }).unwrap();
        assert_eq!(fs::read_to_string(&to).unwrap(), "c,d");
        // Into an existing directory with other files: beside them.
        let d = t.path().join("desk");
        fs::create_dir(&d).unwrap();
        fs::write(d.join("other"), "o").unwrap();
        let out = run_unpack(&archive(&[E::F("q3.csv", "e")]), &opts(&d, "q3.csv")).unwrap();
        assert_eq!(out.target, d.join("q3.csv"));
        assert_eq!(fs::read_to_string(d.join("q3.csv")).unwrap(), "e");
        no_staging_left(t.path());
        no_staging_left(&d);
    }

    #[test]
    fn limits() {
        let t = tempfile::tempdir().unwrap();
        let mut h = tar::Header::new_gnu();
        h.set_path("big").unwrap();
        h.set_size(MAX_BYTES + 1);
        h.set_entry_type(tar::EntryType::Regular);
        h.set_cksum();
        let bytes = h.as_bytes().to_vec();
        let err = run_unpack(&bytes, &opts(&t.path().join("o"), "o")).unwrap_err();
        assert_eq!(err.extra["reason"], "too_large");
    }

    #[test]
    fn remote_paths() {
        assert_eq!(remote_path("reports/q3/").unwrap(), ("reports/q3".into(), "q3".into()));
        assert_eq!(remote_path("./billing").unwrap(), ("billing".into(), "billing".into()));
        assert_eq!(remote_path(".").unwrap(), ("".into(), "workspace".into()));
        assert_eq!(remote_path("/etc").unwrap_err().code, "usage");
        assert_eq!(remote_path("a/../..").unwrap_err().code, "usage");
    }

    #[test]
    fn api_refusals_are_pull_rejected() {
        let e = map_error(Error::from_api(404, &json!({"error": {"code": "path_not_found", "message": "m"}})), "billing");
        assert_eq!((e.code.as_str(), e.extra["reason"].as_str(), e.exit_code()), ("pull_rejected", Some("path_not_found"), 2));
        assert_eq!(e.message, "workspace/billing does not exist");
        let e = map_error(Error::from_api(413, &json!({"error": {"code": "too_large", "message": "m", "files": 200000}})), "x");
        assert_eq!(e.extra["files"], 200000);
    }
}
