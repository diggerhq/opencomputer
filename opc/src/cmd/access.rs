//! `opc access`: show or change who may use a session.

use super::resolve::resolve;
use super::run::SHARED_WARNING;
use super::{Ctx, print_json, println_out};
use crate::api::types::{Access, Session};
use crate::cli::AccessArgs;
use crate::error::{Error, Result};
use crate::http::session_path;
use serde_json::{Value, json};

const USAGE: &str = "opc access <id> [owner | org | people <user>...]";

/// What the command was asked to do, before any request.
#[derive(Debug, PartialEq)]
enum Change {
    Show,
    Set { mode: String, people: Vec<String> },
    Edit { add: Vec<String>, remove: Vec<String> },
}

fn parse(a: &AccessArgs) -> Result<(String, Change)> {
    let (target, rest) = match &a.session.session {
        Some(s) => (Some(s.clone()), a.args.clone()),
        None => {
            let mut it = a.args.clone().into_iter();
            (it.next(), it.collect::<Vec<_>>())
        }
    };
    let target = target.filter(|t| !t.trim().is_empty()).ok_or_else(|| Error::usage(format!("which session? {USAGE}")))?;
    let mut words = rest.into_iter();
    let mode = words.next();
    let people: Vec<String> = words.collect();
    let editing = !a.add.is_empty() || !a.remove.is_empty();
    let change = match mode.as_deref() {
        None if editing => Change::Edit { add: a.add.clone(), remove: a.remove.clone() },
        None => Change::Show,
        Some(m) if editing => return Err(Error::usage(format!("--add and --remove change who a session is shared with: use them without {m}"))),
        Some(m @ ("owner" | "org")) if !people.is_empty() => return Err(Error::usage(format!("{m} takes no people: {USAGE}"))),
        Some("people") if people.is_empty() => return Err(Error::usage("who? opc access <id> people <user id or email>...")),
        Some(m @ ("owner" | "org" | "people")) => Change::Set { mode: m.to_string(), people },
        Some(m) => return Err(Error::usage(format!("access is owner, org or people, not {m:?}"))),
    };
    Ok((target, change))
}

/// The people list after `--add` and `--remove`; an empty list is owner only.
fn edited(current: &Access, add: &[String], remove: &[String]) -> Result<(String, Vec<String>)> {
    if current.mode == "org" {
        return Err(Error::usage("this session is shared with the whole organization: to share it with some people only, use opc access <id> people <user>..."));
    }
    let mut people = if current.mode == "people" { current.people.clone() } else { Vec::new() };
    for r in remove {
        let before = people.len();
        people.retain(|p| !p.eq_ignore_ascii_case(r));
        if people.len() == before {
            return Err(Error::usage(format!("{r} is not one of this session's people (they are listed by user id: opc access <id>)")));
        }
    }
    for p in add {
        if !people.iter().any(|x| x.eq_ignore_ascii_case(p)) {
            people.push(p.clone());
        }
    }
    let mode = if people.is_empty() { "owner" } else { "people" };
    Ok((mode.to_string(), people))
}

pub async fn run(ctx: &mut Ctx, a: AccessArgs) -> Result<i32> {
    let (target, change) = parse(&a)?;
    ctx.require_key()?;
    let sid = resolve(ctx, &target).await?.id;
    let (mode, people) = match change {
        Change::Show => {
            let session = get(ctx, &sid).await?;
            print(ctx, &session, a.json);
            return Ok(0);
        }
        Change::Set { mode, people } => (mode, people),
        Change::Edit { add, remove } => {
            let session = get(ctx, &sid).await?;
            let current = session.access.ok_or_else(unsupported)?;
            edited(&current, &add, &remove)?
        }
    };
    let body = match mode.as_str() {
        "people" => json!({"access": {"mode": "people", "people": people}}),
        m => json!({"access": {"mode": m}}),
    };
    if mode != "owner" {
        ctx.note(SHARED_WARNING);
    }
    let got = ctx.http.patch(&session_path(&sid, ""), &body).await.map_err(crate::error::access_change)?;
    let (session, usable) = read_session(&sid, &got)?;
    if usable {
        crate::cache::upsert_session(ctx.http.api_url(), &session);
    }
    print(ctx, &session, a.json);
    Ok(0)
}

async fn get(ctx: &Ctx, sid: &str) -> Result<Session> {
    Ok(read_session(sid, &ctx.http.get(&session_path(sid, ""), &[]).await?)?.0)
}

/// The session from a `GET` or `PATCH`, and whether you may use it. An admin
/// who may change the access but not use the session gets no session back
/// (`session: null`), only its access.
fn read_session(sid: &str, got: &Value) -> Result<(Session, bool)> {
    if got.get("session").is_some_and(Value::is_null) {
        let mut session = Session { id: sid.to_string(), ..Default::default() };
        session.access = serde_json::from_value(got.get("access").cloned().unwrap_or_default()).ok();
        session.can_manage_access = got.get("canManageAccess").and_then(Value::as_bool);
        return Ok((session, false));
    }
    let session = serde_json::from_value(got.get("session").cloned().unwrap_or_else(|| got.clone()))
        .map_err(|e| Error::new("internal", format!("the API returned a session opc cannot read: {e}")))?;
    Ok((session, true))
}

fn unsupported() -> Error {
    Error::new("feature_unavailable", "this computer does not report who may use a session yet")
}

fn print(ctx: &Ctx, s: &Session, as_json: bool) {
    if as_json {
        print_json(ctx, &json!({"sessionId": s.id, "access": s.access, "canManageAccess": s.can_manage_access}));
        return;
    }
    let Some(access) = &s.access else {
        ctx.note(&unsupported().message);
        return;
    };
    for line in lines(s, access) {
        println_out(&line);
    }
}

fn lines(s: &Session, access: &Access) -> Vec<String> {
    let mut out = vec![format!("access  {}", access.label())];
    if let Some(o) = &s.owner {
        let name = if o.name.is_empty() { o.id.as_str() } else { o.name.as_str() };
        out.push(format!("owner   {name}"));
    }
    if access.mode == "people" {
        out.push(format!("people  {}", access.people.join(", ")));
    }
    if s.can_manage_access == Some(false) {
        out.push("you can't change this".into());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::SessionOpt;

    fn args(words: &[&str], add: &[&str], remove: &[&str]) -> AccessArgs {
        AccessArgs {
            args: words.iter().map(|s| s.to_string()).collect(),
            session: SessionOpt { session: None },
            add: add.iter().map(|s| s.to_string()).collect(),
            remove: remove.iter().map(|s| s.to_string()).collect(),
            json: false,
        }
    }

    #[test]
    fn parses_what_to_do() {
        assert_eq!(parse(&args(&["7f3a"], &[], &[])).unwrap(), ("7f3a".into(), Change::Show));
        assert_eq!(parse(&args(&["7f3a", "org"], &[], &[])).unwrap().1, Change::Set { mode: "org".into(), people: vec![] });
        assert_eq!(
            parse(&args(&["7f3a", "people", "a@x.com", "usr_b"], &[], &[])).unwrap().1,
            Change::Set { mode: "people".into(), people: vec!["a@x.com".into(), "usr_b".into()] }
        );
        assert_eq!(parse(&args(&["7f3a"], &["usr_b"], &[])).unwrap().1, Change::Edit { add: vec!["usr_b".into()], remove: vec![] });
        for bad in [&["7f3a", "people"][..], &["7f3a", "org", "usr_b"], &["7f3a", "everyone"], &[]] {
            assert_eq!(parse(&args(bad, &[], &[])).unwrap_err().code, "usage", "{bad:?}");
        }
        assert_eq!(parse(&args(&["7f3a", "owner"], &["usr_b"], &[])).unwrap_err().code, "usage");
    }

    #[test]
    fn edits_the_people_list() {
        let people = |p: &[&str]| Access { mode: "people".into(), people: p.iter().map(|s| s.to_string()).collect(), ..Default::default() };
        let owner = Access { mode: "owner".into(), ..Default::default() };
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        assert_eq!(edited(&owner, &s(&["usr_a"]), &[]).unwrap(), ("people".into(), s(&["usr_a"])));
        assert_eq!(edited(&people(&["usr_a"]), &s(&["usr_b", "usr_a"]), &[]).unwrap(), ("people".into(), s(&["usr_a", "usr_b"])));
        assert_eq!(edited(&people(&["usr_a"]), &[], &s(&["usr_a"])).unwrap(), ("owner".into(), vec![]));
        assert_eq!(edited(&people(&["usr_a"]), &[], &s(&["usr_z"])).unwrap_err().code, "usage");
        let org = Access { mode: "org".into(), ..Default::default() };
        assert_eq!(edited(&org, &s(&["usr_a"]), &[]).unwrap_err().code, "usage");
    }

    #[test]
    fn reads_the_access_an_admin_outside_the_session_gets() {
        let got = json!({"session": null, "access": {"mode": "owner", "people": []}, "canManageAccess": true, "seq": 7});
        let (s, usable) = read_session("cs_x", &got).unwrap();
        assert!(!usable);
        assert_eq!(s.id, "cs_x");
        assert_eq!(s.access.unwrap().mode, "owner");
        assert_eq!(s.can_manage_access, Some(true));
    }
}
