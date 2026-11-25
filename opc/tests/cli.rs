//! opc against the in-process fake Computer: exit codes, JSON validated
//! against the schema, behaviour without a terminal, reconnects and backoff.

mod support;

use serde_json::Value;
use std::time::Duration;
use support::{Failure, Fake, Seed};

const T: Duration = Duration::from_secs(10);

struct Out {
    code: i32,
    stdout: String,
    stderr: String,
}

impl Out {
    fn json(&self) -> Value {
        serde_json::from_str(self.stdout.trim()).unwrap_or_else(|e| panic!("stdout is not JSON ({e}): {:?}\nstderr: {}", self.stdout, self.stderr))
    }
    fn lines(&self) -> Vec<Value> {
        self.stdout.lines().filter(|l| !l.trim().is_empty()).map(|l| serde_json::from_str(l).unwrap_or_else(|e| panic!("not JSON ({e}): {l}"))).collect()
    }
    fn err_json(&self) -> Value {
        let line = self.stderr.lines().find(|l| l.starts_with("{\"error\"")).unwrap_or_else(|| panic!("no error JSON on stderr: {}", self.stderr));
        serde_json::from_str(line).unwrap()
    }
}

fn run(fake: &Fake, args: &[&str]) -> Out {
    run_in(fake, args, None)
}

fn run_in(fake: &Fake, args: &[&str], stdin: Option<&str>) -> Out {
    let mut c = fake.opc();
    c.args(args);
    if let Some(s) = stdin {
        c.write_stdin(s);
    }
    let o = c.output().expect("run opc");
    Out { code: o.status.code().unwrap_or(-1), stdout: String::from_utf8_lossy(&o.stdout).into(), stderr: String::from_utf8_lossy(&o.stderr).into() }
}

/// opc's own output must match the published schema.
fn check(name: &str, v: &Value) {
    if let Err(e) = support::check(name, v) {
        panic!("opc printed an object that does not match the schema: {e}");
    }
}

#[test]
fn print_replies_and_exits_zero() {
    let fake = Fake::start();
    let o = run(&fake, &["-p", "reply hello there"]);
    assert_eq!(o.code, 0, "{}", o.stderr);
    assert_eq!(o.stdout.trim(), "hello there");
    fake.assert_no_panics();
}

// ---- -p and the Result --------------------------------------------------

#[test]
fn print_json_result_validates() {
    let fake = Fake::start();
    let o = run(&fake, &["-p", "--output-format", "json", "reply ok"]);
    assert_eq!(o.code, 0, "{}", o.stderr);
    let r = o.json();
    check("Result", &r);
    assert_eq!(r["subtype"], "success");
    assert_eq!(r["result"], "ok");
    assert!(r["sessionId"].as_str().unwrap().starts_with("cs_"));
    // The session id is minted on the client.
    let creates = fake.requests_to("POST /sessions");
    assert_eq!(creates.len(), 1);
    assert_eq!(creates[0].json()["id"], r["sessionId"]);
    fake.assert_no_panics();
}

#[test]
fn print_stream_json_has_init_and_result_lines() {
    let fake = Fake::start();
    let o = run(&fake, &["-p", "--output-format", "stream-json", "tool"]);
    assert_eq!(o.code, 0, "{}", o.stderr);
    let lines = o.lines();
    assert_eq!(lines[0]["type"], "system", "{:?}", lines[0]);
    let last = lines.last().unwrap();
    assert_eq!(last["type"], "result");
    check("Result", last);
    for l in &lines[1..lines.len() - 1] {
        if l["type"] == "event" || l.get("seq").is_some() {
            let e = l.get("event").unwrap_or(l);
            check("Event", e);
        }
    }
}

#[test]
fn failed_turn_exits_one_with_error_result() {
    let fake = Fake::start();
    let o = run(&fake, &["-p", "--output-format", "json", "fail broken on purpose"]);
    assert_eq!(o.code, 1, "{}", o.stderr);
    let r = o.json();
    check("Result", &r);
    assert_eq!(r["isError"], true);
}

#[test]
fn an_ask_exits_five_with_the_ask() {
    let fake = Fake::start();
    let o = run(&fake, &["-p", "--output-format", "json", "approve"]);
    assert_eq!(o.code, 5, "{}", o.stderr);
    let r = o.json();
    check("Result", &r);
    assert!(r["ask"]["id"].as_str().unwrap().starts_with("ak_"), "{r}");
}

#[test]
fn send_wait_and_wait_take_on_ask() {
    let fake = Fake::start();
    let sid = fake.seed_session(Seed::new("x"));
    let o = run(&fake, &["send", "-s", &sid, "--wait", "--on-ask", "dismiss", "--json", "approve"]);
    assert_eq!(o.code, 0, "{}", o.stderr);
    check("Result", &o.json());
    let o = run(&fake, &["send", "-s", &sid, "approve"]);
    assert_eq!(o.code, 0, "{}", o.stderr);
    let o = run(&fake, &["wait", &sid, "--on-ask", "dismiss", "--json"]);
    assert_eq!(o.code, 0, "{}", o.stderr);
    assert!(o.json()["ask"].is_null(), "{}", o.stdout);
}

#[test]
fn silent_turn_prints_nothing() {
    let fake = Fake::start();
    let o = run(&fake, &["-p", "silent"]);
    assert_eq!(o.code, 0, "{}", o.stderr);
    assert_eq!(o.stdout.trim(), "");
}

/// A parent that leaves stdin open and never writes (execFile, docker -i)
/// must not stop `-p "message"` from running.
#[test]
fn open_silent_stdin_does_not_hang() {
    let fake = Fake::start();
    let mut c = std::process::Command::new(env!("CARGO_BIN_EXE_opc"));
    c.envs(fake.env()).env_remove("OPC_LOG").args(["-p", "reply not stuck"]);
    c.stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
    let mut child = c.spawn().unwrap();
    let _held_open = child.stdin.take();
    let end = std::time::Instant::now() + T;
    while child.try_wait().unwrap().is_none() {
        assert!(std::time::Instant::now() < end, "opc -p waited on an open, silent stdin");
        std::thread::sleep(Duration::from_millis(20));
    }
    let o = child.wait_with_output().unwrap();
    assert_eq!(o.status.code(), Some(0), "{}", String::from_utf8_lossy(&o.stderr));
    assert_eq!(String::from_utf8_lossy(&o.stdout).trim(), "not stuck");
}

/// Input that starts a little late is still added to the message.
#[test]
fn piped_input_after_words_is_appended() {
    let fake = Fake::start();
    let mut c = std::process::Command::new(env!("CARGO_BIN_EXE_opc"));
    c.envs(fake.env()).env_remove("OPC_LOG").args(["-p", "reply"]);
    c.stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
    let mut child = c.spawn().unwrap();
    let mut w = child.stdin.take().unwrap();
    std::thread::sleep(Duration::from_millis(50));
    std::io::Write::write_all(&mut w, b"late input").unwrap();
    drop(w);
    let o = child.wait_with_output().unwrap();
    assert_eq!(o.status.code(), Some(0), "{}", String::from_utf8_lossy(&o.stderr));
    assert!(String::from_utf8_lossy(&o.stdout).contains("late input"), "{}", String::from_utf8_lossy(&o.stdout));
}

#[test]
fn message_from_stdin() {
    let fake = Fake::start();
    let o = run_in(&fake, &["-p"], Some("reply from stdin\n"));
    assert_eq!(o.code, 0, "{}", o.stderr);
    assert_eq!(o.stdout.trim(), "from stdin");
}

#[test]
fn idempotency_key_makes_one_turn() {
    let fake = Fake::start();
    let a = run(&fake, &["-p", "--idempotency-key", "job-42", "--output-format", "json", "reply once"]);
    let b = run(&fake, &["-p", "--idempotency-key", "job-42", "--output-format", "json", "reply once"]);
    assert_eq!(a.code, 0, "{}", a.stderr);
    assert_eq!(b.code, 0, "{}", b.stderr);
    assert_eq!(a.json()["sessionId"], b.json()["sessionId"]);
    let sid = a.json()["sessionId"].as_str().unwrap().to_string();
    assert_eq!(fake.turns(&sid).len(), 1);
    assert_eq!(fake.session_ids().len(), 1);
}

#[test]
fn timeout_exits_124_and_names_the_turn() {
    let fake = Fake::start();
    let o = run(&fake, &["-p", "--timeout", "300ms", "slow 5000"]);
    assert_eq!(o.code, 124, "{}", o.stderr);
    assert!(o.stderr.contains("opc a") || o.stderr.contains("still running"), "{}", o.stderr);
}

#[test]
fn continue_a_session_with_dash_s() {
    let fake = Fake::start();
    let sid = fake.seed_session(Seed::new("existing"));
    let o = run(&fake, &["-p", "-s", &sid, "reply again"]);
    assert_eq!(o.code, 0, "{}", o.stderr);
    assert_eq!(o.stdout.trim(), "again");
    assert_eq!(fake.turns(&sid).len(), 1);
    assert!(fake.requests_to("POST /sessions").is_empty());
}

// ---- errors and exit codes ------------------------------------------------

#[test]
fn rejected_key_exits_three_with_error_json() {
    let fake = Fake::start();
    fake.revoke_key();
    let o = run(&fake, &["-p", "--output-format", "json", "reply x"]);
    assert_eq!(o.code, 3, "{}", o.stderr);
    let e = o.err_json();
    check("Error", &e["error"]);
    assert_eq!(e["error"]["code"], "unauthenticated");
}

#[test]
fn no_credits_exits_six() {
    let fake = Fake::start();
    fake.fail_next("POST /sessions", 1, Failure::insufficient_credits());
    let o = run(&fake, &["-p", "--output-format", "json", "reply x"]);
    assert_eq!(o.code, 6, "{}", o.stderr);
    check("Error", &o.err_json()["error"]);
}

#[test]
fn unknown_session_is_a_usage_error() {
    let fake = Fake::start();
    let o = run(&fake, &["send", "-s", "cs_0000000000000000", "hi"]);
    assert_eq!(o.code, 2, "{}", o.stderr);
}

#[test]
fn bad_flags_exit_two() {
    let fake = Fake::start();
    let o = run(&fake, &["ls", "--no-such-flag"]);
    assert_eq!(o.code, 2);
}

#[test]
fn retries_through_unavailable_with_backoff() {
    let fake = Fake::start();
    fake.fail_next("POST /sessions", 2, Failure::unavailable(50));
    let o = run(&fake, &["-p", "reply survived"]);
    assert_eq!(o.code, 0, "{}", o.stderr);
    assert_eq!(o.stdout.trim(), "survived");
    assert!(fake.requests_to("POST /sessions").len() >= 3);
}

#[test]
fn cold_computer_is_retried_with_the_same_key() {
    let fake = Fake::start();
    fake.fail_next("POST /sessions", 2, Failure::new(503, "computer_unavailable").with("retryAfterMs", 50));
    let o = run(&fake, &["-p", "--idempotency-key", "cold-1", "reply warm now"]);
    assert_eq!(o.code, 0, "{}", o.stderr);
    assert_eq!(o.stdout.trim(), "warm now");
    let reqs = fake.requests_to("POST /sessions");
    assert!(reqs.len() >= 3, "{}", reqs.len());
    let keys: Vec<_> = reqs.iter().map(|r| r.idempotency_key().map(str::to_string)).collect();
    assert!(keys[0].is_some() && keys.iter().all(|k| k == &keys[0]), "{keys:?}");
    assert!(reqs.iter().all(|r| r.json() == reqs[0].json()), "the retried body changed");
}

#[test]
fn rate_limit_honours_retry_after() {
    let fake = Fake::start();
    fake.fail_next("POST /sessions", 1, Failure::rate_limited(200));
    let t = std::time::Instant::now();
    let o = run(&fake, &["-p", "reply later"]);
    assert_eq!(o.code, 0, "{}", o.stderr);
    assert!(t.elapsed() >= Duration::from_millis(200));
}

#[test]
fn reconnects_and_catches_up_without_gaps() {
    let fake = Fake::start();
    fake.drop_ws_after(6);
    let o = run(&fake, &["-p", "--output-format", "stream-json", "slow 600"]);
    assert_eq!(o.code, 0, "{}", o.stderr);
    assert!(fake.ws_connections() >= 2, "expected a reconnect");
    let seqs: Vec<u64> = o.lines().iter().filter_map(|l| l.get("event").unwrap_or(l).get("seq").and_then(Value::as_u64)).collect();
    let mut sorted = seqs.clone();
    sorted.dedup();
    assert_eq!(seqs, sorted, "duplicate or out-of-order events: {seqs:?}");
    assert_eq!(o.lines().last().unwrap()["subtype"], "success");
}

// ---- without a terminal ----------------------------------------------------

#[test]
fn login_without_a_terminal_exits_three() {
    let fake = Fake::start();
    let mut c = fake.opc();
    c.env_remove("OPENCOMPUTER_API_KEY").arg("login");
    let o = c.output().unwrap();
    assert_eq!(o.status.code(), Some(3));
}

#[test]
fn nothing_logged_in_exits_three() {
    let fake = Fake::start();
    let mut c = fake.opc();
    c.env_remove("OPENCOMPUTER_API_KEY").args(["-p", "reply x"]);
    let o = c.output().unwrap();
    assert_eq!(o.status.code(), Some(3), "{}", String::from_utf8_lossy(&o.stderr));
}

#[test]
fn no_progress_on_stderr_without_a_terminal() {
    let fake = Fake::start();
    let o = run(&fake, &["-p", "tool"]);
    assert_eq!(o.code, 0, "{}", o.stderr);
    assert!(!o.stderr.contains('⏺'), "{}", o.stderr);
    assert!(!o.stderr.contains("\x1b["), "escape codes without a terminal");
}

#[test]
fn interactive_without_a_terminal_refuses_to_guess() {
    let fake = Fake::start();
    let o = run(&fake, &[]);
    assert_ne!(o.code, 0);
    assert!(fake.session_ids().is_empty(), "no session without a terminal or a message");
}

// ---- sessions --------------------------------------------------------------

#[test]
fn new_send_wait() {
    let fake = Fake::start();
    let o = run(&fake, &["new", "--title", "scripted"]);
    assert_eq!(o.code, 0, "{}", o.stderr);
    let sid = o.stdout.trim().to_string();
    assert!(sid.starts_with("cs_"), "{sid}");
    let o = run(&fake, &["send", "-s", &sid, "reply sent"]);
    assert_eq!(o.code, 0, "{}", o.stderr);
    let tid = o.stdout.trim().to_string();
    assert!(tid.starts_with("tn_"), "{tid}");
    let o = run(&fake, &["wait", &tid, "--json"]);
    assert_eq!(o.code, 0, "{}", o.stderr);
    let r = o.json();
    check("Result", &r);
    assert_eq!(r["result"], "sent");
}

#[test]
fn speed_goes_with_a_new_session_only() {
    let fake = Fake::start();
    let o = run(&fake, &["new", "--speed", "standard"]);
    assert_eq!(o.code, 0, "{}", o.stderr);
    let sid = o.stdout.trim().to_string();
    assert_eq!(fake.requests_to("POST /sessions")[0].json()["speed"], "standard");
    let o = run(&fake, &["-p", "--output-format", "stream-json", "--speed", "fast", "reply ok"]);
    assert_eq!(o.code, 0, "{}", o.stderr);
    assert_eq!(o.lines()[0]["settings"]["speed"], "fast", "{}", o.stdout);
    let o = run(&fake, &["-p", "reply ok"]);
    assert_eq!(o.code, 0, "{}", o.stderr);
    assert!(fake.requests_to("POST /sessions").last().unwrap().json().get("speed").is_none());
    let o = run(&fake, &["new", "--speed", "slow"]);
    assert_eq!(o.code, 2, "{}", o.stderr);
    let o = run(&fake, &["-p", "-s", &sid, "--speed", "fast", "reply ok"]);
    assert_eq!(o.code, 2, "{}", o.stderr);
    assert!(o.stderr.contains("--speed is for a new session"), "{}", o.stderr);
}

#[test]
fn send_wait_reports_the_turn() {
    let fake = Fake::start();
    let sid = fake.seed_session(Seed::new("x"));
    let o = run(&fake, &["send", "-s", &sid, "--wait", "reply waited"]);
    assert_eq!(o.code, 0, "{}", o.stderr);
    assert!(o.stdout.contains("waited"), "{}", o.stdout);
}

#[test]
fn wait_any_over_many_sessions_uses_one_connection() {
    let fake = Fake::start();
    let mut ids = Vec::new();
    for i in 0..5 {
        let sid = fake.seed_session(Seed::new(&format!("s{i}")));
        fake.send(&sid, if i == 3 { "reply first" } else { "slow 3000" }, "queue").unwrap();
        ids.push(sid);
    }
    let before = fake.ws_connections();
    let mut args = vec!["wait", "--any", "--json"];
    args.extend(ids.iter().map(String::as_str));
    let o = run(&fake, &args);
    assert_eq!(o.code, 0, "{}", o.stderr);
    check("Result", &o.json());
    assert_eq!(o.json()["sessionId"], ids[3].as_str());
    assert_eq!(fake.ws_connections() - before, 1);
}

#[test]
fn wait_all_reports_every_session_when_one_is_lost() {
    let fake = Fake::start();
    let ok = fake.seed_session(Seed::new("fine"));
    let lost = fake.seed_session(Seed::new("lost"));
    fake.send(&ok, "reply done", "queue").unwrap();
    fake.fail_next(&format!("ws attach {lost}"), 1, Failure::forbidden("not_yours"));
    let o = run(&fake, &["wait", "--all", "--json", &ok, &lost]);
    assert_eq!(o.code, 1, "{}\n{}", o.stdout, o.stderr);
    let lines: Vec<serde_json::Value> = o.stdout.lines().map(|l| serde_json::from_str(l).unwrap()).collect();
    assert_eq!(lines.len(), 2, "{}", o.stdout);
    let good = lines.iter().find(|l| l["sessionId"] == ok.as_str()).expect("the healthy session's Result");
    check("Result", good);
    let bad = lines.iter().find(|l| l["sessionId"] == lost.as_str()).expect("the lost session's line");
    assert_eq!(bad["isError"], true, "{bad}");

    // `--all` keeps its documented codes: not all completed is 1.
    // Text: each answer under its session, the lost one on stderr.
    fake.fail_next(&format!("ws attach {lost}"), 1, Failure::forbidden("not_yours"));
    let o = run(&fake, &["wait", "--all", &ok, &lost]);
    assert_eq!(o.code, 1, "{}", o.stderr);
    assert!(o.stdout.contains(&ok), "{}", o.stdout);
    assert!(o.stderr.contains(&lost), "{}", o.stderr);
}

#[test]
fn watch_goes_on_when_one_session_is_lost() {
    let fake = Fake::start();
    let ok = fake.seed_session(Seed::new("fine"));
    let lost = fake.seed_session(Seed::new("lost"));
    fake.send(&ok, "reply done", "queue").unwrap();
    fake.fail_next(&format!("ws attach {lost}"), 1, Failure::forbidden("not_yours"));
    let o = run(&fake, &["watch", "--json", &ok, &lost]);
    assert_eq!(o.code, 1, "{}\n{}", o.stdout, o.stderr);
    assert!(o.stdout.lines().any(|l| l.contains("\"type\":\"error\"") && l.contains(&lost)), "{}", o.stdout);
    assert!(o.stdout.lines().any(|l| l.contains(&ok) && !l.contains("\"type\":\"error\"")), "{}", o.stdout);
}

#[test]
fn ls_json_validates() {
    let fake = Fake::start();
    fake.seed_session(Seed::new("one").meta("ticket", "LIN-1"));
    fake.seed_session(Seed::new("two"));
    let o = run(&fake, &["ls", "--json"]);
    assert_eq!(o.code, 0, "{}", o.stderr);
    let v = o.json();
    let arr = v.as_array().or_else(|| v["sessions"].as_array()).expect("an array of sessions").clone();
    assert_eq!(arr.len(), 2);
    for s in &arr {
        check("Session", s);
    }
    let o = run(&fake, &["ls", "--metadata", "ticket=LIN-1", "--json"]);
    let v = o.json();
    let arr = v.as_array().or_else(|| v["sessions"].as_array()).unwrap().clone();
    assert_eq!(arr.len(), 1);
}

#[test]
fn log_json_events_validate() {
    let fake = Fake::start();
    let o = run(&fake, &["-p", "--output-format", "json", "tool"]);
    let sid = o.json()["sessionId"].as_str().unwrap().to_string();
    let o = run(&fake, &["log", "-s", &sid, "--json"]);
    assert_eq!(o.code, 0, "{}", o.stderr);
    let v = o.json();
    let events = v["events"].as_array().unwrap();
    assert!(events.iter().any(|e| e["type"] == "tool.completed"));
    for e in events {
        check("Event", e);
    }
}

#[test]
fn rename_and_archive() {
    let fake = Fake::start();
    let sid = fake.seed_session(Seed::new("old"));
    assert_eq!(run(&fake, &["rename", &sid, "new title"]).code, 0);
    assert_eq!(fake.session(&sid)["title"], "new title");
    assert_eq!(run(&fake, &["archive", &sid]).code, 0);
    assert_eq!(fake.session(&sid)["archived"], true);
}

#[test]
fn interrupt_cancels_the_running_turn() {
    let fake = Fake::start();
    let sid = fake.seed_session(Seed::new("busy"));
    let (tid, _) = fake.send(&sid, "slow 10000", "queue").unwrap();
    fake.wait_for(T, {
        let sid = sid.clone();
        move |w| w.sessions.iter().any(|s| s.id == sid && s.status == "running")
    });
    let o = run(&fake, &["interrupt", "-s", &sid]);
    assert_eq!(o.code, 0, "{}", o.stderr);
    assert!(fake.wait_turn(&sid, &tid, T));
    assert_eq!(fake.turn(&sid, &tid)["status"], "cancelled");
}

// ---- asks ------------------------------------------------------------------

#[test]
fn allow_an_approval() {
    let fake = Fake::start();
    let sid = fake.seed_session(Seed::new("needs ok"));
    fake.send(&sid, "approve", "queue").unwrap();
    let ask = fake.wait_ask(&sid, T).expect("an ask");
    let id = ask["id"].as_str().unwrap();
    let o = run(&fake, &["ask", "ls", "-s", &sid, "--json"]);
    assert_eq!(o.code, 0, "{}", o.stderr);
    let o = run(&fake, &["ask", "allow", id, "-s", &sid]);
    assert_eq!(o.code, 0, "{}", o.stderr);
    assert!(fake.wait_idle(&sid, T));
    let a = fake.asks(&sid).into_iter().find(|a| a["id"] == id).unwrap();
    assert_eq!(a["status"], "answered");
    // A second answer finds it closed.
    let o = run(&fake, &["ask", "deny", id, "-s", &sid]);
    assert_ne!(o.code, 0);
    assert!(o.stderr.contains("already"), "{}", o.stderr);
}

#[test]
fn approve_a_plan_with_a_mode() {
    let fake = Fake::start();
    let sid = fake.seed_session(Seed::new("plan").mode("plan"));
    fake.send(&sid, "plan", "queue").unwrap();
    let ask = fake.wait_ask(&sid, T).expect("an ask");
    let o = run(&fake, &["ask", "allow", ask["id"].as_str().unwrap(), "-s", &sid, "--mode", "acceptEdits"]);
    assert_eq!(o.code, 0, "{}", o.stderr);
    assert!(fake.wait_for(T, {
        let sid = sid.clone();
        move |w| w.sessions.iter().any(|s| s.id == sid && s.mode == "acceptEdits")
    }));
}

#[test]
fn answer_a_question() {
    let fake = Fake::start();
    let sid = fake.seed_session(Seed::new("q"));
    fake.send(&sid, "question", "queue").unwrap();
    let ask = fake.wait_ask(&sid, T).expect("an ask");
    let o = run(&fake, &["ask", "answer", ask["id"].as_str().unwrap(), "-s", &sid, "--choice", "blue"]);
    assert_eq!(o.code, 0, "{}", o.stderr);
    assert!(fake.wait_idle(&sid, T));
}

// ---- subagents -------------------------------------------------------------

#[test]
fn wait_subagents_returns_every_subagent_ended() {
    let fake = Fake::start();
    let o = run(&fake, &["-p", "--wait-subagents", "--output-format", "json", "subagent bg 300"]);
    assert_eq!(o.code, 0, "{}", o.stderr);
    let r = o.json();
    check("Result", &r);
    let subs = r["subagents"].as_array().expect("Result.subagents");
    assert!(!subs.is_empty());
    for s in subs {
        assert_ne!(s["status"], "running", "{s}");
    }
}

#[test]
fn subagents_ls_and_stop() {
    let fake = Fake::start();
    let sid = fake.seed_session(Seed::new("sa"));
    fake.send(&sid, "subagent bg 10000", "queue").unwrap();
    assert!(fake.wait_for(T, {
        let sid = sid.clone();
        move |w| w.sessions.iter().any(|s| s.id == sid && s.subagents.iter().any(|a| a["status"] == "running"))
    }));
    let o = run(&fake, &["subagents", "ls", "-s", &sid, "--json"]);
    assert_eq!(o.code, 0, "{}", o.stderr);
    let v = o.json();
    let list = v["subagents"].as_array().unwrap();
    assert_eq!(list.len(), 1);
    check("Subagent", &list[0]);
    let id = list[0]["id"].as_str().unwrap();
    let o = run(&fake, &["subagents", "stop", id, "-s", &sid]);
    assert_eq!(o.code, 0, "{}", o.stderr);
    let o = run(&fake, &["subagents", "result", id, "-s", &sid]);
    assert_eq!(o.code, 1, "a stopped subagent has no result: {}", o.stderr);
}

// ---- secrets ---------------------------------------------------------------

#[test]
fn secret_asks_are_answered_in_slack_and_only_skipped_here() {
    let fake = Fake::start();
    let o = run(&fake, &["--help"]);
    assert!(!o.stdout.contains("secret"), "no secret command: {}", o.stdout);
    let sid = fake.seed_session(Seed::new("s"));
    fake.send(&sid, "secret STRIPE_KEY", "queue").unwrap();
    let ask = fake.wait_ask(&sid, T).expect("an ask");
    let id = ask["id"].as_str().unwrap();
    let o = run(&fake, &["ask", "answer", id, "-s", &sid, "--text", "sk_test_value", "--json"]);
    assert_eq!(o.code, 2, "{}", o.stderr);
    let e: Value = serde_json::from_str(&o.stderr).expect("a JSON error");
    assert_eq!(e["error"]["code"], "answer_with_secret");
    assert!(o.stderr.contains("answered in Slack") && !o.stderr.contains("opc secret"), "{}", o.stderr);
    assert!(fake.requests_to("POST /sessions/*/asks/*/answer").is_empty());
    let o = run(&fake, &["ask", "dismiss", id, "-s", &sid]);
    assert_eq!(o.code, 0, "{}", o.stderr);
    assert!(fake.wait_idle(&sid, T));
}

// ---- offline ---------------------------------------------------------------

#[test]
fn schema_and_help_work_offline() {
    let fake = Fake::start();
    let o = run(&fake, &["schema", "result"]);
    assert_eq!(o.code, 0);
    assert_eq!(o.json()["$ref"], "#/$defs/Result");
    let o = run(&fake, &["help", "scripting"]);
    assert!(o.stdout.starts_with("Scripting"));
    assert!(fake.requests().is_empty());
}

#[test]
fn whoami_and_doctor() {
    let fake = Fake::start();
    let o = run(&fake, &["whoami", "--json"]);
    assert_eq!(o.code, 0, "{}", o.stderr);
    assert!(o.json()["person"].is_object());
    let o = run(&fake, &["doctor", "--json"]);
    assert_eq!(o.code, 0, "{}\n{}", o.stdout, o.stderr);
    let steps = o.json()["steps"].as_array().unwrap().clone();
    assert!(steps.iter().all(|s| s["ok"] == true), "{steps:?}");
    assert_eq!(steps.last().unwrap()["name"], "round trip");
}

#[test]
fn messages_that_look_like_commands() {
    let fake = Fake::start();
    let o = run(&fake, &["-p", "ls the files"]);
    assert_eq!(o.code, 0, "{}", o.stderr);
}

// ---- a server that accepts and never answers -------------------------------

/// A TCP port that accepts connections and never says a word: a TLS
/// handshake or a request to it hangs, as behind a firewall that eats
/// traffic.
fn silent_port() -> u16 {
    let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = l.local_addr().unwrap().port();
    std::thread::spawn(move || {
        let mut held = vec![];
        for c in l.incoming().flatten() {
            held.push(c);
        }
    });
    port
}

fn opc_against(fake: &Fake, api: &str, args: &[&str]) -> (Out, Duration) {
    let mut c = fake.opc();
    c.env("OPENCOMPUTER_API_URL", api).env("OPC_WIRE_URL", api.replace("http", "ws")).args(args);
    let t = std::time::Instant::now();
    let o = c.output().unwrap();
    (Out { code: o.status.code().unwrap_or(-1), stdout: String::from_utf8_lossy(&o.stdout).into(), stderr: String::from_utf8_lossy(&o.stderr).into() }, t.elapsed())
}

#[test]
fn connect_that_never_completes_fails_within_ten_seconds() {
    let fake = Fake::start();
    let port = silent_port();
    let (o, took) = opc_against(&fake, &format!("https://127.0.0.1:{port}"), &["ls", "--json"]);
    assert_eq!(o.code, 4, "{}", o.stderr);
    assert_eq!(o.err_json()["error"]["code"], "unreachable", "{}", o.stderr);
    assert!(took < Duration::from_secs(14), "took {took:?}");
}

#[test]
fn timeout_covers_the_first_request() {
    let fake = Fake::start();
    let port = silent_port();
    let (o, took) = opc_against(&fake, &format!("http://127.0.0.1:{port}"), &["-p", "--timeout", "2s", "--output-format", "json", "reply hi"]);
    assert_eq!(o.code, 124, "{}", o.stderr);
    assert!(took < Duration::from_secs(5), "took {took:?}");
}

// ---- a computer that is starting ------------------------------------------

#[test]
fn push_and_pull_wait_for_a_starting_computer() {
    let fake = Fake::start();
    let sid = fake.seed_session(Seed::new("ws"));
    let src = tempfile::tempdir().unwrap();
    std::fs::create_dir(src.path().join("app")).unwrap();
    std::fs::write(src.path().join("app/main.txt"), "hello").unwrap();
    let cold = || Failure::new(503, "computer_unavailable").with("retryAfterMs", 300);

    fake.fail_next("PUT /sessions/*/workspace/archive", 5, cold());
    let o = run(&fake, &["push", src.path().join("app").to_str().unwrap(), "-s", &sid, "--json"]);
    assert_eq!(o.code, 0, "{}", o.stderr);
    let puts = fake.requests_to("PUT /sessions/*/workspace/archive");
    assert_eq!(puts.len(), 6);
    assert!(puts.iter().all(|r| r.idempotency_key().is_some() && r.idempotency_key() == puts[0].idempotency_key()), "the key changed between retries");

    let dest = tempfile::tempdir().unwrap();
    fake.fail_next("GET /sessions/*/workspace/archive", 5, cold());
    let o = run(&fake, &["pull", "app", dest.path().join("app").to_str().unwrap(), "-s", &sid, "--json"]);
    assert_eq!(o.code, 0, "{}", o.stderr);
    assert_eq!(std::fs::read_to_string(dest.path().join("app/main.txt")).unwrap(), "hello");
}

#[test]
fn push_gives_the_session_before_the_uploads() {
    let fake = Fake::start();
    let src = tempfile::tempdir().unwrap();
    std::fs::write(src.path().join("main.txt"), "hello").unwrap();
    // The upload fails: the session still exists, and the caller knows it.
    fake.fail_next("PUT /sessions/*/workspace/archive", 1, Failure::new(400, "invalid_request"));
    let o = run(&fake, &["-p", "--push", src.path().to_str().unwrap(), "reply hi"]);
    assert_ne!(o.code, 0, "{}", o.stderr);
    let sid = fake.session_ids().pop().expect("a session was created");
    assert!(o.stderr.contains(&format!("opc: session {sid}")), "{}", o.stderr);
}

#[test]
fn wire_refusing_a_valid_key_exits_forbidden() {
    let fake = Fake::start();
    fake.refuse_ws(Some((4003, "not_your_session")));
    let t = std::time::Instant::now();
    let o = run(&fake, &["-p", "--output-format", "json", "reply hi"]);
    assert_eq!(o.code, 3, "{}", o.stderr);
    assert_eq!(o.err_json()["error"]["code"], "forbidden", "{}", o.stderr);
    assert!(t.elapsed() < Duration::from_secs(10), "it retried: {:?}", t.elapsed());
}

/// Another environment's key never goes to the production wire: without a
/// wire URL from that API's `/me`, opc says so and stops.
#[test]
fn non_default_api_without_a_wire_url_fails_clearly() {
    let fake = Fake::start();
    fake.set_ws_enabled(false);
    let mut c = fake.opc();
    c.env_remove("OPC_WIRE_URL").args(["-p", "--output-format", "json", "reply hi"]);
    let o = c.output().unwrap();
    let stderr = String::from_utf8_lossy(&o.stderr);
    assert_ne!(o.status.code(), Some(0), "{stderr}");
    assert!(stderr.contains("computer_not_set_up") && stderr.contains("wireUrl"), "{stderr}");
    assert!(!stderr.contains("wire.opencomputer.dev"), "{stderr}");
}

#[test]
fn print_accepts_json() {
    let fake = Fake::start();
    let o = run(&fake, &["-p", "--json", "reply as json"]);
    assert_eq!(o.code, 0, "{}", o.stderr);
    assert_eq!(o.json()["result"], "as json", "{}", o.stdout);
}

#[test]
fn stream_json_parse_failure_ends_stdout_with_a_result() {
    let fake = Fake::start();
    let o = run(&fake, &["-p", "--output-format", "stream-json", "--bogus", "hi"]);
    assert_eq!(o.code, 2);
    let last = o.lines().pop().expect("a result line");
    assert_eq!(last["type"], "result");
    assert_eq!(last["subtype"], "error");
}

#[test]
fn watch_json_errors_are_json() {
    let fake = Fake::start();
    fake.refuse_ws(Some((4003, "no_access")));
    let sid = fake.seed_session(Seed::new("w"));
    let o = run(&fake, &["watch", &sid, "--json"]);
    assert_eq!(o.code, 3, "{}", o.stderr);
    assert_eq!(o.err_json()["error"]["code"], "forbidden");
}

// ---- telemetry ------------------------------------------------------------

/// The `telemetry` notifications opc sent, each checked against the closed
/// table the server enforces: names, keys, value types and closed strings.
fn telemetry_frames(fake: &Fake) -> Vec<Value> {
    fake.ws_frames()
        .into_iter()
        .filter(|f| f.dir == support::Dir::In)
        .filter_map(|f| {
            let text = f.text.clone()?;
            let v: Value = serde_json::from_str(&text).ok()?;
            if v["method"] != "telemetry" {
                return None;
            }
            assert!(v.get("id").is_none(), "a notification, never a request: {text}");
            assert!(text.len() <= 16 * 1024, "frame over 16 KiB");
            Some(v["params"].clone())
        })
        .collect()
}

fn check_telemetry(p: &Value) {
    let ok_id = |s: &str| !s.is_empty() && s.len() <= 64 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    assert_eq!(p["v"], 1, "{p}");
    let c = &p["client"];
    assert_eq!(c["name"], "opc");
    assert!(c["version"].as_str().is_some_and(|v| !v.is_empty() && v.len() <= 32));
    assert!(["darwin", "linux", "windows", "other"].contains(&c["os"].as_str().unwrap()));
    assert!(["arm64", "x64", "other"].contains(&c["arch"].as_str().unwrap()));
    assert_eq!(c.as_object().unwrap().len(), 4, "{c}");
    let events = p["events"].as_array().expect("events");
    assert!((1..=20).contains(&events.len()));
    for e in events {
        let o = e.as_object().unwrap();
        for k in o.keys() {
            assert!(["name", "at", "sessionId", "turnId", "data"].contains(&k.as_str()), "key {k} in {e}");
        }
        assert!(e["at"].is_u64() || e["at"].is_i64(), "{e}");
        if let Some(s) = e.get("sessionId") {
            assert!(s.as_str().is_some_and(|s| s.starts_with("cs_") && ok_id(s)), "{e}");
        }
        if let Some(t) = e.get("turnId") {
            assert!(t.as_str().is_some_and(ok_id), "{e}");
        }
        let (keys, strings): (&[&str], &[(&str, &[&str])]) = match e["name"].as_str().unwrap() {
            "cli.turn" => (&["first_event_ms", "first_output_received_ms", "first_output_ms", "interrupted"], &[]),
            "cli.attach" => (&["attach_ms", "connect_ms", "reconnect", "gap_ms", "replayed_events"], &[]),
            "cli.control" => (&["kind", "round_trip_ms", "applied_ms", "ok"], &[("kind", &["steer", "interrupt", "answer", "cancel"])]),
            "cli.error" => (&["class", "close_code"], &[("class", &["ws_closed", "auth", "ticket", "rate_limited", "protocol", "render", "crash", "timeout", "other"])]),
            "cli.render" => (&["lag_ms", "draw_ms"], &[]),
            "cli.connection" => (&["up_ms", "frames", "bytes", "close_code", "reconnect"], &[]),
            "cli.overflow" => (&["dropped"], &[]),
            n => panic!("event {n} is not in the catalog"),
        };
        for (k, v) in e["data"].as_object().expect("data") {
            assert!(keys.contains(&k.as_str()), "key {k} in {e}");
            match v {
                Value::Number(n) => assert!(n.as_f64().is_some_and(|x| (0.0..=1e10).contains(&x)), "{e}"),
                Value::Bool(_) => {}
                Value::String(s) => assert!(strings.iter().any(|(sk, vals)| sk == k && vals.contains(&s.as_str())), "free string {k}={s} in {e}"),
                _ => panic!("value of {k} in {e}"),
            }
        }
    }
}

fn telemetry_events(fake: &Fake) -> Vec<Value> {
    let frames = telemetry_frames(fake);
    frames.iter().for_each(check_telemetry);
    frames.iter().flat_map(|p| p["events"].as_array().unwrap().clone()).collect()
}

#[test]
fn telemetry_rides_the_wire_without_content() {
    let fake = Fake::start();
    let o = run(&fake, &["-p", "--output-format", "json", "reply zebra-quokka-secret"]);
    assert_eq!(o.code, 0, "{}", o.stderr);
    let r = o.json();
    let events = telemetry_events(&fake);
    let names: Vec<&str> = events.iter().filter_map(|e| e["name"].as_str()).collect();
    let turn = events.iter().find(|e| e["name"] == "cli.turn").unwrap_or_else(|| panic!("no cli.turn in {names:?}"));
    assert_eq!(turn["turnId"], r["turnId"], "{turn}");
    assert_eq!(turn["sessionId"], r["sessionId"]);
    assert!(turn["data"]["first_output_ms"].is_u64(), "{turn}");
    assert!(names.contains(&"cli.attach"), "{names:?}");
    // Only the wire: no HTTP request carries telemetry.
    assert!(fake.requests().iter().all(|q| !q.path.contains("telemetry")));
    for f in fake.ws_frames().iter().filter(|f| f.dir == support::Dir::In) {
        let t = f.text.clone().unwrap_or_default();
        if t.contains("\"telemetry\"") {
            assert!(!t.contains("zebra") && !t.contains("quokka") && !t.contains("secret"), "content in telemetry: {t}");
        }
    }
    fake.assert_no_panics();
}

#[test]
fn telemetry_off_sends_nothing() {
    for (k, v) in [("OPC_TELEMETRY", "0"), ("OPC_TELEMETRY", "off"), ("DO_NOT_TRACK", "1")] {
        let fake = Fake::start();
        let o = fake.opc().env(k, v).args(["-p", "reply hello there"]).output().unwrap();
        assert_eq!(o.status.code(), Some(0));
        assert!(telemetry_frames(&fake).is_empty(), "{k}={v} still sent telemetry");
    }
}

#[test]
fn opc_config_telemetry_off_and_on() {
    let fake = Fake::start();
    let o = run(&fake, &["config", "telemetry"]);
    assert_eq!(o.code, 0, "{}", o.stderr);
    assert_eq!(o.stdout.trim(), "telemetry on (the default)");
    let o = run(&fake, &["config", "telemetry", "off"]);
    assert_eq!(o.stdout.trim(), "telemetry off (opc config telemetry off)");
    let o = run(&fake, &["config", "telemetry", "--json"]);
    assert_eq!(o.json()["telemetry"], false);
    assert_eq!(o.json()["source"], "config");
    let o = run(&fake, &["-p", "reply hello there"]);
    assert_eq!(o.code, 0, "{}", o.stderr);
    assert!(telemetry_frames(&fake).is_empty(), "sent after opc config telemetry off");
    // The environment wins over the file.
    let o = fake.opc().env("OPC_TELEMETRY", "1").args(["config", "telemetry"]).output().unwrap();
    assert_eq!(String::from_utf8_lossy(&o.stdout).trim(), "telemetry on (OPC_TELEMETRY)");
    let o = run(&fake, &["config", "telemetry", "on"]);
    assert_eq!(o.stdout.trim(), "telemetry on (the default)");
}

#[test]
fn help_says_how_to_turn_telemetry_off() {
    let fake = Fake::start();
    let o = run(&fake, &["--help"]);
    assert!(o.stdout.contains("OPC_TELEMETRY=0") && o.stdout.contains("opc config telemetry off"), "{}", o.stdout);
    let o = run(&fake, &["help", "telemetry"]);
    assert_eq!(o.code, 0);
    assert!(o.stdout.contains("never sends what you type"), "{}", o.stdout);
}
