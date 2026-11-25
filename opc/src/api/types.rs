//! The API's objects, hand-written from `docs/api/reference/objects.mdx`.
//!
//! Lenient on purpose: every field defaults, enums are strings (they are open),
//! and unknown fields are kept in `extra` so an object printed back out is the
//! object the server sent. `tests/schema.rs` checks these against the vendored
//! JSON Schema.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Person {
    pub id: String,
    pub name: String,
    pub email: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Actor {
    pub id: String,
    pub name: String,
    pub via: String,
    pub client: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub model: Option<String>,
    pub effort: Option<String>,
    pub mode: Option<String>,
    /// `fast` or `standard`; absent or null (older servers) means fast.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speed: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Context {
    pub used_tokens: Option<u64>,
    pub window_tokens: Option<u64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Urls {
    pub dashboard: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct TurnSummary {
    pub id: String,
    pub status: String,
    pub ended_at: Option<String>,
    pub text: Option<String>,
    pub error: Option<Value>,
    pub reason: Option<String>,
    pub forced: Option<bool>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Turn {
    pub id: String,
    pub session_id: String,
    pub status: String,
    pub if_busy: Option<String>,
    /// Null for a turn the agent started itself (`trigger: "subagent"`).
    pub input: Option<String>,
    /// `message`, or `subagent` (an open enum).
    pub trigger: Option<String>,
    pub subagent_id: Option<String>,
    pub author: Option<Actor>,
    pub steering: Vec<Value>,
    pub created_at: Option<String>,
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
    pub text: Option<String>,
    pub error: Option<Value>,
    pub reason: Option<String>,
    pub forced: Option<bool>,
    pub usage: Option<Value>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Turn {
    pub fn is_ended(&self) -> bool {
        is_ended_status(&self.status)
    }
}

pub fn is_ended_status(s: &str) -> bool {
    matches!(s, "completed" | "failed" | "cancelled")
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Approval {
    pub tool_name: String,
    pub call_id: Option<String>,
    pub input: Value,
    pub title: String,
    pub always_allows: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct QuestionOption {
    pub label: String,
    pub description: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Question {
    pub id: String,
    pub header: Option<String>,
    pub text: String,
    pub multi_select: bool,
    pub options: Vec<QuestionOption>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Questions {
    pub questions: Vec<Question>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct SecretRequest {
    pub name: String,
    pub purpose: Option<String>,
    pub file: bool,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Ask {
    pub id: String,
    pub session_id: String,
    pub turn_id: Option<String>,
    pub kind: String,
    pub status: String,
    pub created_at: Option<String>,
    pub closed_at: Option<String>,
    pub closed_by: Option<Actor>,
    pub answer: Option<Value>,
    pub approval: Option<Approval>,
    pub question: Option<Questions>,
    pub secret: Option<SecretRequest>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Ask {
    pub fn is_open(&self) -> bool {
        self.status == "open"
    }

    /// One line for people: `approval for "Bash: terraform apply"`.
    pub fn describe(&self) -> String {
        match self.kind.as_str() {
            "approval" => {
                let title = self.approval.as_ref().map(|a| a.title.as_str()).unwrap_or("a tool call");
                format!("approval for \"{title}\"")
            }
            "question" => {
                let q = self.question.as_ref().and_then(|q| q.questions.first()).map(|q| q.text.as_str()).unwrap_or("");
                format!("question \"{q}\"")
            }
            "secret" => {
                let n = self.secret.as_ref().map(|s| s.name.as_str()).unwrap_or("");
                format!("secret {n}")
            }
            other => other.to_string(),
        }
    }
}

/// A subagent the session's agent launched (`sa_…`).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Subagent {
    pub id: String,
    pub session_id: String,
    pub turn_id: Option<String>,
    pub call_id: Option<String>,
    pub name: String,
    pub agent_type: Option<String>,
    pub background: bool,
    pub status: String,
    pub activity: Option<String>,
    pub tool_calls: u64,
    pub tokens: u64,
    pub created_at: Option<String>,
    pub ended_at: Option<String>,
    pub duration_ms: Option<u64>,
    pub result: Option<String>,
    pub result_truncated: Option<bool>,
    pub error: Option<Value>,
    pub stopped_by: Option<Value>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Subagent {
    pub fn is_running(&self) -> bool {
        self.status == "running"
    }

    /// Folds a `subagent.progress` delta's data in.
    pub fn apply_progress(&mut self, data: &Value) {
        if let Some(a) = data.get("activity") {
            self.activity = a.as_str().map(str::to_string);
        }
        if let Some(n) = data.get("toolCalls").and_then(Value::as_u64) {
            self.tool_calls = n;
        }
        if let Some(n) = data.get("tokens").and_then(Value::as_u64) {
            self.tokens = n;
        }
    }

    /// `{id, name, status, background}`, as the Result lists it.
    pub fn brief(&self) -> Value {
        serde_json::json!({"id": self.id, "name": self.name, "status": self.status, "background": self.background})
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub title: String,
    pub status: String,
    pub archived: bool,
    pub owner: Option<Person>,
    pub origin: Value,
    pub settings: Settings,
    pub metadata: Map<String, Value>,
    pub active_turn_id: Option<String>,
    pub queued: Vec<Turn>,
    pub asks: Vec<Ask>,
    /// The running subagents, oldest first.
    pub subagents: Vec<Subagent>,
    pub last_turn: Option<TurnSummary>,
    pub last_text: Option<String>,
    pub context: Option<Context>,
    pub last_seq: u64,
    pub log_epoch: u64,
    pub epoch_start_seq: u64,
    pub created_at: Option<String>,
    pub last_active_at: Option<String>,
    pub synced_at: Option<String>,
    pub urls: Urls,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Session {
    pub fn dashboard_url(&self, fallback: impl FnOnce() -> String) -> String {
        self.urls.dashboard.clone().unwrap_or_else(fallback)
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub name: Option<String>,
    pub efforts: Vec<String>,
    pub context_window: Option<u64>,
    pub default: bool,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Capabilities {
    pub models: Vec<ModelInfo>,
    pub modes: Vec<String>,
    pub features: Map<String, Value>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Capabilities {
    pub fn feature(&self, name: &str) -> bool {
        // An unknown feature is assumed on: the server refuses with
        // `feature_unavailable` if it is not, which is the better message.
        self.features.get(name).and_then(Value::as_bool).unwrap_or(true)
    }
}

/// A recorded event, kept as the JSON the server sent (printed verbatim by
/// `stream-json`), with typed accessors.
#[derive(Debug, Clone, PartialEq)]
pub struct Event(pub Value);

impl Event {
    pub fn seq(&self) -> u64 {
        self.0.get("seq").and_then(Value::as_u64).unwrap_or(0)
    }
    pub fn kind(&self) -> &str {
        self.0.get("type").and_then(Value::as_str).unwrap_or("")
    }
    pub fn session_id(&self) -> &str {
        self.0.get("sessionId").and_then(Value::as_str).unwrap_or("")
    }
    pub fn turn_id(&self) -> Option<&str> {
        self.0.get("turnId").and_then(Value::as_str)
    }
    pub fn data(&self) -> &Value {
        self.0.get("data").unwrap_or(&Value::Null)
    }
    pub fn str(&self, field: &str) -> Option<&str> {
        self.data().get(field).and_then(Value::as_str)
    }
    pub fn actor(&self) -> Option<Actor> {
        self.0.get("actor").filter(|v| !v.is_null()).and_then(|v| serde_json::from_value(v.clone()).ok())
    }
    pub fn created_at(&self) -> Option<&str> {
        self.0.get("createdAt").and_then(Value::as_str)
    }
}

/// A streamed delta: `{type, sessionId, turnId, data: {blockId|callId, parentCallId, text}}`.
#[derive(Debug, Clone, PartialEq)]
pub struct Delta(pub Value);

impl Delta {
    pub fn kind(&self) -> &str {
        self.0.get("type").and_then(Value::as_str).unwrap_or("")
    }
    /// Printed by `--include-partial-messages`: text and reasoning as they stream, a tool call
    /// while the model writes it (`tool.preparing`) and a running tool's output (`tool.delta`).
    pub fn partial(&self) -> bool {
        matches!(self.kind(), "message.delta" | "reasoning.delta" | "tool.preparing" | "tool.delta")
    }
    pub fn session_id(&self) -> &str {
        self.0.get("sessionId").and_then(Value::as_str).unwrap_or("")
    }
    pub fn turn_id(&self) -> Option<&str> {
        self.0.get("turnId").and_then(Value::as_str)
    }
    pub fn data(&self) -> &Value {
        self.0.get("data").unwrap_or(&Value::Null)
    }
    /// The block (`blockId`) or tool call (`callId`) it extends.
    pub fn key(&self) -> Option<&str> {
        let d = self.data();
        d.get("blockId").and_then(Value::as_str).or_else(|| d.get("callId").and_then(Value::as_str))
    }
    pub fn text(&self) -> &str {
        self.data().get("text").and_then(Value::as_str).unwrap_or("")
    }
}

/// `POST /sessions` → `{session, turn, delivery, duplicate, seq}`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Created {
    pub session: Session,
    pub turn: Option<Turn>,
    pub delivery: Option<String>,
    pub duplicate: bool,
    pub seq: u64,
}

/// `POST /sessions/{id}/turns` → `{turn, delivery, duplicate, seq}`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Sent {
    pub turn: Turn,
    pub delivery: String,
    pub duplicate: bool,
    pub seq: u64,
}

/// `GET /sessions/{id}/events` → `{events, earlierTurns, lastSeq, hasMore}`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct EventPage {
    pub events: Vec<Value>,
    pub last_seq: u64,
    pub has_more: bool,
    pub earlier_turns: Option<Vec<Turn>>,
    pub log_epoch: Option<u64>,
    pub epoch_start_seq: Option<u64>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn unknown_fields_survive_a_round_trip() {
        let v = json!({"id": "cs_7f3a9k2m4q8r1t6v", "title": "t", "status": "idle", "brandNew": {"x": 1}});
        let s: Session = serde_json::from_value(v).unwrap();
        assert_eq!(s.extra["brandNew"]["x"], 1);
        let back = serde_json::to_value(&s).unwrap();
        assert_eq!(back["brandNew"]["x"], 1);
        assert!(back["activeTurnId"].is_null());
    }

    #[test]
    fn speed_is_optional_in_settings() {
        let s: Settings = serde_json::from_value(json!({"model": "m", "effort": "high", "mode": "default"})).unwrap();
        assert_eq!(s.speed, None);
        assert!(serde_json::to_value(&s).unwrap().get("speed").is_none());
        let s: Settings = serde_json::from_value(json!({"model": "m", "effort": null, "mode": "default", "speed": "standard"})).unwrap();
        assert_eq!(s.speed.as_deref(), Some("standard"));
    }

    #[test]
    fn open_enums() {
        let t: Turn = serde_json::from_value(json!({"id": "tn_1", "status": "paused_by_martians"})).unwrap();
        assert!(!t.is_ended());
    }
}
