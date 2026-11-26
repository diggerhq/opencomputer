//! Validation of everything the fake emits against `schema/computer-api.v1.json`.
//!
//! A name is resolved, in order, as:
//! - a `$defs` name (`Session`, `Turn`, `Event.turn.started`, …);
//! - `method:<name>` for a WebSocket method's result (`method:events.list`);
//! - `notification:<name>` (`notification:ready`);
//! - `client:<name>` for a client notification (`client:sessions.ack`).
//!
//! `Event` and `Delta` are checked against the def for their `type` when there
//! is one. A type the schema does not know yet (`tool.preparing` and
//! `session.compacting`) is checked against the envelope only, so they
//! validate until the published schema includes them.

use jsonschema::Validator;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

const SCHEMA: &str = include_str!("../../schema/computer-api.v1.json");

struct Schemas {
    doc: Value,
    cache: Mutex<HashMap<String, &'static Validator>>,
}

fn schemas() -> &'static Schemas {
    static S: OnceLock<Schemas> = OnceLock::new();
    S.get_or_init(|| Schemas { doc: serde_json::from_str(SCHEMA).expect("schema/computer-api.v1.json is JSON"), cache: Mutex::new(HashMap::new()) })
}

/// The JSON pointer (within the rebuilt root) a name resolves to.
fn pointer(name: &str) -> Option<String> {
    let s = schemas();
    let props = &s.doc["properties"];
    if let Some(m) = name.strip_prefix("method:") {
        props["methods"]["properties"].get(m)?;
        return Some(format!("#/$defs/__methods/properties/{m}/properties/result"));
    }
    if let Some(n) = name.strip_prefix("notification:") {
        props["notifications"]["properties"].get(n)?;
        return Some(format!("#/$defs/__notifications/properties/{n}"));
    }
    if let Some(n) = name.strip_prefix("client:") {
        props["clientNotifications"]["properties"].get(n)?;
        return Some(format!("#/$defs/__clientNotifications/properties/{n}"));
    }
    s.doc["$defs"].get(name)?;
    Some(format!("#/$defs/{name}"))
}

fn validator(name: &str) -> &'static Validator {
    let s = schemas();
    if let Some(v) = s.cache.lock().unwrap().get(name) {
        return v;
    }
    let ptr = pointer(name).unwrap_or_else(|| panic!("schema: no definition named {name:?}"));
    let mut defs = s.doc["$defs"].clone();
    let props = &s.doc["properties"];
    defs["__methods"] = props["methods"].clone();
    defs["__notifications"] = props["notifications"].clone();
    defs["__clientNotifications"] = props["clientNotifications"].clone();
    let root = json!({
        "$schema": s.doc["$schema"],
        "$id": s.doc["$id"],
        "$defs": defs,
        "$ref": ptr,
    });
    let v = jsonschema::validator_for(&root).unwrap_or_else(|e| panic!("schema: {name}: {e}"));
    let v: &'static Validator = Box::leak(Box::new(v));
    s.cache.lock().unwrap().insert(name.to_string(), v);
    v
}

fn has_def(name: &str) -> bool {
    schemas().doc["$defs"].get(name).is_some()
}

/// Picks the most specific definition for a value: `Event.<type>`/`Delta.<type>`.
fn specific(name: &str, v: &Value) -> String {
    // The `event` and `delta` notifications carry an Event or a Delta.
    let base = match name {
        "notification:event" => "Event",
        "notification:delta" => "Delta",
        n => n,
    };
    if (base == "Event" || base == "Delta")
        && let Some(t) = v.get("type").and_then(Value::as_str)
    {
        let d = format!("{base}.{t}");
        if has_def(&d) {
            return d;
        }
        return if base == "Event" { "Event.other".into() } else { "__delta_envelope".into() };
    }
    name.to_string()
}

fn delta_envelope(v: &Value) -> Result<(), String> {
    let ok = v.get("type").is_some_and(Value::is_string)
        && v.get("sessionId").and_then(Value::as_str).is_some_and(|s| s.starts_with("cs_"))
        && v.get("turnId").is_some_and(|t| t.is_null() || t.is_string())
        && v.get("data").is_some_and(Value::is_object);
    if ok { Ok(()) } else { Err(format!("not a Delta envelope {{type, sessionId, turnId, data}}: {v}")) }
}

/// Checks `v` against the named definition; `Err` lists every violation.
pub fn check(name: &str, v: &Value) -> Result<(), String> {
    let def = specific(name, v);
    if def == "__delta_envelope" {
        return delta_envelope(v);
    }
    let val = validator(&def);
    let errs: Vec<String> = val.iter_errors(v).map(|e| format!("  at {}: {}", e.instance_path, e)).take(10).collect();
    if errs.is_empty() { Ok(()) } else { Err(format!("schema violation against {def}:\n{}\nvalue: {}", errs.join("\n"), short(v))) }
}

/// Panics with a clear message when `v` does not match the named definition.
pub fn validate(name: &str, v: &Value) {
    if let Err(e) = check(name, v) {
        panic!("fake server emitted an invalid object: {e}");
    }
}

fn short(v: &Value) -> String {
    let s = v.to_string();
    if s.len() > 2000 { format!("{}…", &s[..s.char_indices().take_while(|(i, _)| *i < 2000).last().map_or(0, |(i, _)| i)]) } else { s }
}
