//! `opc doctor`: each link in the chain, in order, stopping at the first
//! that fails.

use super::{Ctx, print_json, println_out};
use crate::cli::JsonOnly;
use crate::config::KeySource;
use crate::error::{Error, Result, exit};
use crate::render::duration;
use crate::wire::WireEvent;
use serde_json::{Value, json};
use std::time::{Duration, Instant};

struct Step {
    name: &'static str,
    ok: bool,
    ms: Option<u64>,
    detail: String,
    error: Option<Error>,
}

struct Doctor<'a> {
    ctx: &'a Ctx,
    json: bool,
    steps: Vec<Step>,
}

impl Doctor<'_> {
    fn pass(&mut self, name: &'static str, ms: Option<u64>, detail: String) {
        self.show(Step { name, ok: true, ms, detail, error: None });
    }
    fn fail(&mut self, name: &'static str, ms: Option<u64>, e: Error) {
        self.show(Step { name, ok: false, ms, detail: e.message.clone(), error: Some(e) });
    }
    fn show(&mut self, s: Step) {
        if !self.json {
            let style = crate::render::Style { color: self.ctx.color };
            let mark = if s.ok { style.green("✓") } else { style.red("✗") };
            let time = s.ms.map(duration).unwrap_or_else(|| if s.ok { "(same request)".into() } else { String::new() });
            println_out(&format!("{mark} {:<13} {:<46} {time}", s.name, s.detail));
        }
        self.steps.push(s);
    }
    fn finish(self) -> Result<i32> {
        let failed = self.steps.iter().find(|s| !s.ok).and_then(|s| s.error.clone());
        if self.json {
            let steps: Vec<Value> = self
                .steps
                .iter()
                .map(|s| json!({"name": s.name, "ok": s.ok, "ms": s.ms, "detail": s.detail, "error": s.error.as_ref().map(|e| json!({"code": e.code, "message": e.message}))}))
                .collect();
            print_json(self.ctx, &json!({"steps": steps}));
        }
        match failed {
            None => Ok(exit::OK),
            Some(e) if self.json => Ok(e.exit_code()),
            Some(e) => {
                if let Some(h) = &e.hint {
                    eprintln!("  {h}");
                }
                Ok(e.exit_code())
            }
        }
    }
}

fn ms(t: Instant) -> Option<u64> {
    Some(t.elapsed().as_millis() as u64)
}

pub async fn run(ctx: &Ctx, a: JsonOnly) -> Result<i32> {
    let mut d = Doctor { ctx, json: a.json, steps: Vec::new() };
    let home = crate::config::home();
    let path = ctx.config.path.strip_prefix(&home).map(|p| format!("~/{}", p.display())).unwrap_or_else(|_| ctx.config.path.display().to_string());

    // 1. The configuration file.
    let t = Instant::now();
    match std::fs::metadata(&ctx.config.path) {
        Ok(_) => d.pass("config", ms(t), path),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => d.pass("config", ms(t), format!("{path} (none yet)")),
        Err(e) => {
            d.fail("config", ms(t), Error::new("config_unreadable", format!("{path}: {e}")));
            return d.finish();
        }
    }

    // 2–4. The credential, the API and the computer: one request.
    if !ctx.http.has_key() {
        d.fail("credential", None, Error::new("not_logged_in", "no credential").hint("run opc login, or set OPENCOMPUTER_API_KEY"));
        return d.finish();
    }
    let t = Instant::now();
    let me = match ctx.http.get("/me", &[]).await {
        Ok(me) => me,
        Err(e) if e.exit_code() == exit::AUTH => {
            d.fail("credential", ms(t), e);
            return d.finish();
        }
        Err(e) => {
            d.pass("credential", None, source(ctx));
            d.fail("api", ms(t), e);
            return d.finish();
        }
    };
    let g = |p: &str| me.pointer(p).and_then(Value::as_str).unwrap_or("").to_string();
    let who = [g("/credential/name"), g("/person/name"), g("/organization/name")].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" · ");
    d.pass("credential", ms(t), if who.is_empty() { source(ctx) } else { who });
    d.pass("api", None, ctx.config.api_url.clone());
    if let Some(u) = crate::wire::reconnect::wire_url_from_me(&me) {
        crate::cache::set_wire_url(&ctx.config.api_url, &u);
    }
    match g("/computer/status").as_str() {
        "not_set_up" => {
            d.fail("computer", None, Error::new("computer_not_set_up", "not set up").hint("finish setup at the dashboard, under Computer"));
            return d.finish();
        }
        s => d.pass("computer", None, if s.is_empty() { "unknown".into() } else { s.to_string() }),
    }

    // 5. The connection.
    let url = match ctx.wire_url().await {
        Ok(u) => u,
        Err(e) => {
            d.fail("connection", None, e);
            return d.finish();
        }
    };
    let t = Instant::now();
    let (wire, mut rx) = ctx.open_wire(Vec::new(), false).await?;
    let opened = tokio::time::timeout(Duration::from_secs(20), async {
        while let Some(ev) = rx.recv().await {
            match ev {
                WireEvent::Connected { region, .. } => return Ok(region),
                WireEvent::Fatal(e) => return Err(e),
                WireEvent::Reconnecting { error, .. } => return Err(error),
                _ => {}
            }
        }
        Err(Error::unreachable("the connection closed"))
    })
    .await
    .unwrap_or_else(|_| Err(Error::new("timeout", "no answer in 20 s")));
    match opened {
        Ok(region) => d.pass("connection", ms(t), match region {
            Some(r) => format!("{url} · {r}"),
            None => url,
        }),
        Err(e) => {
            d.fail("connection", ms(t), e);
            return d.finish();
        }
    }

    // 6. A round trip through it.
    let t = Instant::now();
    let mut rtts = Vec::new();
    for _ in 0..20 {
        let p = Instant::now();
        match wire.call("ping", json!({})).await {
            Ok(_) => rtts.push(p.elapsed().as_millis() as u64),
            Err(e) => {
                d.fail("round trip", ms(t), e);
                return d.finish();
            }
        }
    }
    rtts.sort_unstable();
    let median = rtts[rtts.len() / 2];
    let p90 = rtts[(rtts.len() * 9 / 10).min(rtts.len() - 1)];
    d.pass("round trip", ms(t), format!("{median} ms median, {p90} ms p90 ({} pings)", rtts.len()));
    d.finish()
}

fn source(ctx: &Ctx) -> String {
    match ctx.config.key_source {
        Some(KeySource::Env) => "OPENCOMPUTER_API_KEY".into(),
        _ => ctx.config.file.login.as_ref().and_then(|l| l.name.clone()).unwrap_or_else(|| "saved key".into()),
    }
}
