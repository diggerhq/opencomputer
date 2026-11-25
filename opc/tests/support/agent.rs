//! The scripted agent. The first word of a turn's input picks the script; see
//! the table in `mod.rs`. Every step checks that the turn still runs, so an
//! interrupt, a suspend or a cancel stops the script where it is.

use super::model::{End, Shared, new_id, now, st};
use serde_json::{Value, json};
use std::sync::Arc;
use std::time::Duration;

struct Run {
    sh: Arc<Shared>,
    sid: String,
    tid: String,
    step: Duration,
}

impl Run {
    /// Applies a step if the turn still runs. Returns false when it does not.
    fn step<R>(&self, f: impl FnOnce(&mut super::model::World) -> R) -> Option<R> {
        self.sh.with(|w| {
            let running = w.sess(&self.sid).ok().and_then(|s| s.turn(&self.tid)).is_some_and(|t| t["status"] == "running");
            if running {
                w.read_steering(&self.sid, &self.tid);
                Some(f(w))
            } else {
                None
            }
        })
    }

    fn alive(&self) -> bool {
        self.sh.read(|w| w.sess(&self.sid).ok().and_then(|s| s.turn(&self.tid)).is_some_and(|t| t["status"] == "running"))
    }

    /// Sleeps, returning early (false) if the turn stops running.
    async fn pause(&self, d: Duration) -> bool {
        let (sid, tid) = (self.sid.clone(), self.tid.clone());
        self.sh
            .wait_until(Some(d), move |w| !w.sess(&sid).ok().and_then(|s| s.turn(&tid)).is_some_and(|t| t["status"] == "running"))
            .await;
        self.alive()
    }

    async fn tick(&self) -> bool {
        self.pause(self.step).await
    }

    fn emit(&self, ty: &str, data: Value) -> bool {
        self.step(|w| {
            w.emit(&self.sid, Some(&self.tid), ty, None, data);
        })
        .is_some()
    }

    fn delta(&self, ty: &str, data: Value) -> bool {
        self.step(|w| w.delta(&self.sid, Some(&self.tid), ty, data)).is_some()
    }

    fn end(&self, end: End) {
        self.step(|w| w.end_turn(&self.sid, &self.tid, end, None));
    }

    /// Streams a reply as deltas, then records it.
    async fn say(&self, text: &str, parent: Option<&str>) -> bool {
        let block = format!("blk_{}", super::model::rand_str(8));
        let chars: Vec<char> = text.chars().collect();
        let n = chars.len().div_ceil(3).max(1);
        for chunk in chars.chunks(n) {
            let piece: String = chunk.iter().collect();
            if !self.delta("message.delta", json!({"blockId": block, "parentCallId": parent, "text": piece})) || !self.tick().await {
                return false;
            }
        }
        self.emit("message.completed", json!({"blockId": block, "parentCallId": parent, "text": text}))
    }

    async fn reply(&self, text: &str) {
        if self.say(text, None).await {
            self.end(End::Completed { text: Some(text.to_string()), silent: false });
        }
    }

    fn tool_started(&self, sub: Option<&str>, tool: &str, call: &str, parent: Option<&str>, title: &str, input: Value) -> bool {
        // tool.preparing comes before tool.started, as a delta.
        let path = input.get("file_path").and_then(Value::as_str);
        let description = input.get("description").and_then(Value::as_str);
        let prep = json!({"callId": call, "toolName": tool, "subagentId": sub, "path": path, "description": description, "lines": null});
        if !self.delta("tool.preparing", prep) {
            return false;
        }
        let data = json!({"subagentId": sub, "toolName": tool, "callId": call, "parentCallId": parent, "title": title, "input": input, "inputTruncated": false});
        self.step(|w| {
            w.s(&self.sid).open_calls.entry(self.tid.clone()).or_default().push(data.clone());
            w.emit(&self.sid, Some(&self.tid), "tool.started", None, data);
        })
        .is_some()
    }

    fn tool_ended(&self, call: &str, ok: bool, output: Value, message: &str) -> bool {
        self.step(|w| {
            let calls = w.s(&self.sid).open_calls.entry(self.tid.clone()).or_default();
            let Some(i) = calls.iter().position(|c| c["callId"] == call) else { return };
            let c = calls.remove(i);
            let data = if ok {
                json!({"subagentId": c["subagentId"], "toolName": c["toolName"], "callId": call, "parentCallId": c["parentCallId"], "title": c["title"],
                       "output": output, "outputTruncated": false, "fileChanges": null, "durationMs": 12})
            } else {
                json!({"subagentId": c["subagentId"], "toolName": c["toolName"], "callId": call, "parentCallId": c["parentCallId"], "title": c["title"],
                       "message": message, "settledBy": null})
            };
            w.emit(&self.sid, Some(&self.tid), if ok { "tool.completed" } else { "tool.failed" }, None, data);
        })
        .is_some()
    }

    /// Opens an ask and waits until it closes. Returns the closed ask, or None if the turn stopped.
    async fn ask(&self, kind: &str, body: Value) -> Option<Value> {
        let aid = new_id("ak_");
        let mut ask = json!({
            "id": aid, "sessionId": self.sid, "turnId": self.tid, "kind": kind, "status": "open", "createdAt": now(),
            "closedAt": null, "closedBy": null, "answer": null, "approval": null, "question": null, "secret": null,
        });
        ask[kind] = body;
        super::schema::validate("Ask", &ask);
        self.step(|w| {
            w.s(&self.sid).asks.push(ask.clone());
            w.emit(&self.sid, Some(&self.tid), "ask.opened", None, json!({"ask": ask}));
        })?;
        let (sid, tid, a2) = (self.sid.clone(), self.tid.clone(), aid.clone());
        self.sh
            .wait_until(None, move |w| {
                let Ok(s) = w.sess(&sid) else { return true };
                s.ask(&a2).is_none_or(|a| a["status"] != "open") || !s.turn(&tid).is_some_and(|t| t["status"] == "running")
            })
            .await;
        if !self.alive() {
            return None;
        }
        self.sh.read(|w| w.sess(&self.sid).ok().and_then(|s| s.ask(&aid).cloned()))
    }
}

fn call_id() -> String {
    format!("call_{}", super::model::rand_str(12))
}

pub async fn run_turn(sh: Arc<Shared>, sid: String, tid: String) {
    let step = Duration::from_millis(sh.knobs.lock().unwrap().step_ms);
    let (input, sub, compact) = sh.read(|w| {
        let s = w.sess(&sid).expect("session");
        let t = s.turn(&tid).expect("turn");
        (t["input"].as_str().map(str::to_string), st(t, "subagentId"), s.compact_turns.contains(&tid))
    });
    let r = Run { sh, sid, tid, step };
    if !r.tick().await {
        return;
    }
    if compact {
        r.delta("session.compacting", json!({}));
        if !r.pause(Duration::from_millis(40)).await {
            return;
        }
        let before = r.sh.read(|w| w.sess(&r.sid).ok().and_then(|s| s.used_tokens));
        r.emit("session.compacted", json!({"beforeTokens": before, "afterTokens": 3000, "auto": false}));
        r.step(|w| w.s(&r.sid).used_tokens = Some(3000));
        r.end(End::Completed { text: None, silent: false });
        return;
    }
    let Some(input) = input else {
        // A turn the agent started itself, after a background subagent ended.
        let (name, result) = r.sh.read(|w| {
            let sa = w.sess(&r.sid).ok().and_then(|s| s.subagent(&sub).cloned()).unwrap_or(Value::Null);
            (st(&sa, "name"), st(&sa, "result"))
        });
        r.reply(&format!("Background subagent {name} finished: {result}")).await;
        return;
    };
    let words: Vec<&str> = input.split_whitespace().collect();
    let rest = |n: usize| words.iter().skip(n).copied().collect::<Vec<_>>().join(" ");
    let num = |i: usize, d: u64| words.get(i).and_then(|w| w.parse::<u64>().ok()).unwrap_or(d);
    match words.first().copied().unwrap_or("") {
        "reply" => r.reply(&rest(1)).await,
        "silent" => r.end(End::Completed { text: None, silent: true }),
        "fail" => {
            let msg = if words.len() > 1 { rest(1) } else { "scripted failure".into() };
            r.end(End::Failed { code: "agent_failed".into(), message: msg });
        }
        "slow" => {
            let ms = num(1, 1000);
            if r.pause(Duration::from_millis(ms)).await {
                r.reply(&format!("done after {ms} ms")).await;
            }
        }
        "tool" => {
            let c = call_id();
            if !r.tool_started(None, "Bash", &c, None, "echo hi", json!({"command": "echo hi", "description": "echo hi"})) || !r.tick().await {
                return;
            }
            if !r.delta("tool.delta", json!({"callId": c, "text": "hi\n"})) || !r.tick().await {
                return;
            }
            if r.tool_ended(&c, true, json!("hi\n"), "") {
                r.reply("tool done").await;
            }
        }
        "approve" | "plan" => {
            let plan = words[0] == "plan";
            let once = words.get(1) == Some(&"once");
            let c = call_id();
            let (tool, title, input, always) = if plan {
                ("ExitPlanMode", "Approve the plan".to_string(), json!({"plan": "1. do it"}), Value::Null)
            } else {
                ("Bash", "rm -rf build".to_string(), json!({"command": "rm -rf build"}), if once { Value::Null } else { json!("Bash(rm:*)") })
            };
            if !r.tool_started(None, tool, &c, None, &title, input.clone()) {
                return;
            }
            let Some(ask) = r.ask("approval", json!({"toolName": tool, "callId": c, "input": input, "title": title, "alwaysAllows": always})).await else { return };
            let status = st(&ask, "status");
            let decision = ask["answer"]["decision"].as_str().unwrap_or("").to_string();
            if status == "answered" && decision != "deny" {
                if r.tool_ended(&c, true, json!("ok"), "") {
                    r.reply(&format!("approval: {decision}")).await;
                }
            } else {
                let what = if status == "answered" { "deny".to_string() } else { status.clone() };
                if r.tool_ended(&c, false, Value::Null, &format!("not approved: {what}")) {
                    let msg = ask["answer"]["message"].as_str().map(|m| format!(" ({m})")).unwrap_or_default();
                    r.reply(&format!("approval: {what}{msg}")).await;
                }
            }
        }
        "question" => {
            let q = json!({"questions": [{"id": "q1", "header": "Color", "text": "Pick a color", "multiSelect": false,
                "options": [{"label": "red", "description": null}, {"label": "blue", "description": "the calm one"}]}]});
            let Some(ask) = r.ask("question", q).await else { return };
            let status = st(&ask, "status");
            if status == "answered" {
                let a = &ask["answer"]["answers"][0];
                let mut parts: Vec<String> = a["choices"].as_array().map(|c| c.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default();
                if let Some(t) = a["text"].as_str().filter(|t| !t.is_empty()) {
                    parts.push(t.to_string());
                }
                r.reply(&format!("answer: {}", parts.join(", "))).await;
            } else {
                r.reply(&format!("question: {status}")).await;
            }
        }
        "secret" => {
            let name = words.get(1).copied().unwrap_or("API_KEY").to_string();
            let Some(ask) = r.ask("secret", json!({"name": name, "purpose": format!("to use {name}"), "file": false})).await else { return };
            r.reply(&format!("secret {name}: {}", st(&ask, "status"))).await;
        }
        "subagent" => {
            let bg = words.get(1) == Some(&"bg");
            let ms = num(2, 200);
            subagent(&r, bg, ms).await;
        }
        _ => r.reply(&format!("You said: {input}")).await,
    }
}

async fn subagent(r: &Run, bg: bool, ms: u64) {
    let task_call = call_id();
    if !r.tool_started(None, "Task", &task_call, None, "researcher", json!({"description": "research", "prompt": "look around", "run_in_background": bg})) {
        return;
    }
    let said = new_id("sa_");
    let sa = json!({
        "id": said, "sessionId": r.sid, "turnId": r.tid, "callId": task_call, "name": "researcher", "agentType": "general-purpose",
        "background": bg, "status": "running", "activity": null, "toolCalls": 0, "tokens": 0, "createdAt": now(), "endedAt": null,
        "durationMs": null, "result": null, "resultTruncated": false, "error": null, "stoppedBy": null,
    });
    super::schema::validate("Subagent", &sa);
    let ok = r.step(|w| {
        w.s(&r.sid).subagents.push(sa.clone());
        w.emit(&r.sid, Some(&r.tid), "subagent.started", None, json!({"subagent": sa}));
    });
    if ok.is_none() {
        return;
    }
    if bg {
        if !r.tool_ended(&task_call, true, json!(format!("started {said} in the background")), "") {
            return;
        }
        r.step(|w| w.jobs.push(super::model::Job::Background { sid: r.sid.clone(), said: said.clone(), ms }));
        r.reply("started a background subagent").await;
        return;
    }
    let running = |r: &Run| r.sh.read(|w| w.sess(&r.sid).ok().and_then(|s| s.subagent(&said)).is_some_and(|x| x["status"] == "running"));
    let third = Duration::from_millis(ms / 3);
    // Progress, a nested tool call, more progress.
    progress(r, &said, "Reading files", 1, 400);
    if !r.pause(third).await {
        return;
    }
    if running(r) {
        let c = call_id();
        if !r.tool_started(Some(&said), "Read", &c, Some(&task_call), "README.md", json!({"file_path": "README.md"})) {
            return;
        }
        if !r.tick().await || !r.tool_ended(&c, true, json!("# readme"), "") {
            return;
        }
        progress(r, &said, "Summarizing", 2, 900);
        if !r.pause(third).await {
            return;
        }
    }
    if running(r) {
        if !r.pause(third).await {
            return;
        }
        if running(r) && r.step(|w| w.end_subagent(&r.sid, &said, "completed", Some("found 3 things".into()), None)).is_none() {
            return;
        }
    }
    let status = r.sh.read(|w| w.sess(&r.sid).ok().and_then(|s| s.subagent(&said)).map(|x| st(x, "status")).unwrap_or_default());
    if r.tool_ended(&task_call, true, json!(format!("subagent {status}")), "") {
        r.reply(&format!("subagent {status}")).await;
    }
}

fn progress(r: &Run, said: &str, activity: &str, calls: u64, tokens: u64) {
    r.sh.with(|w| {
        let Ok(s) = w.sess_mut(&r.sid) else { return };
        let Some(sa) = s.subagent_mut(said) else { return };
        if sa["status"] != "running" {
            return;
        }
        sa["activity"] = activity.into();
        sa["toolCalls"] = calls.into();
        sa["tokens"] = tokens.into();
        let tid = st(sa, "turnId");
        w.delta(&r.sid, Some(&tid), "subagent.progress", json!({"subagentId": said, "activity": activity, "toolCalls": calls, "tokens": tokens}));
    });
}

/// A background subagent: progress over `ms`, then it ends and the agent takes a turn.
pub async fn run_background(sh: Arc<Shared>, sid: String, said: String, ms: u64) {
    let running = |sh: &Shared| sh.read(|w| w.sess(&sid).ok().and_then(|s| s.subagent(&said)).is_some_and(|x| x["status"] == "running"));
    let step = Duration::from_millis(ms / 3);
    for (i, act) in ["Reading files", "Running tests", "Summarizing"].iter().enumerate() {
        let (s2, a2) = (sid.clone(), said.clone());
        sh.wait_until(Some(step), move |w| !w.sess(&s2).ok().and_then(|s| s.subagent(&a2)).is_some_and(|x| x["status"] == "running")).await;
        if !running(&sh) {
            return;
        }
        sh.with(|w| {
            let s = w.s(&sid);
            let Some(sa) = s.subagent_mut(&said) else { return };
            sa["activity"] = (*act).into();
            sa["toolCalls"] = (i as u64 + 1).into();
            sa["tokens"] = (300 * (i as u64 + 1)).into();
            let tid = st(sa, "turnId");
            w.delta(&sid, Some(&tid), "subagent.progress", json!({"subagentId": said, "activity": act, "toolCalls": i + 1, "tokens": 300 * (i + 1)}));
        });
    }
    sh.with(|w| {
        let still = w.sess(&sid).ok().and_then(|s| s.subagent(&said)).is_some_and(|x| x["status"] == "running");
        if still {
            w.end_subagent(&sid, &said, "completed", Some("background work done".into()), None);
            w.subagent_turn(&sid, &said);
        }
    });
}
