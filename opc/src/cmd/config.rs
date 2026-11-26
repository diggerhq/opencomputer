//! `opc config`: opc's own settings, kept on this machine.

use serde_json::json;

use super::{Ctx, print_json, println_out};
use crate::cli::{ConfigCommand, OnOff, TelemetryArgs};
use crate::error::Result;
use crate::telemetry::{self, Setting};

pub fn run(ctx: &Ctx, c: ConfigCommand) -> Result<i32> {
    match c {
        ConfigCommand::Telemetry(a) => telemetry_cmd(ctx, a),
    }
}

/// `opc config telemetry [on|off]`: sets the file, then says what is in
/// force; the environment still wins over the file.
fn telemetry_cmd(ctx: &Ctx, a: TelemetryArgs) -> Result<i32> {
    if let Some(s) = a.state {
        telemetry::write_setting(s == OnOff::On)?;
    }
    let s = telemetry::read_setting();
    if a.json {
        print_json(ctx, &json!({"telemetry": s.on(), "source": source(s), "settings": telemetry::settings_path().display().to_string()}));
        return Ok(0);
    }
    let state = if s.on() { "on" } else { "off" };
    println_out(&format!("telemetry {state} ({})", s.why()));
    if a.state == Some(OnOff::On) && s == Setting::OffByEnv {
        println_out("the environment turns it off: unset OPC_TELEMETRY and DO_NOT_TRACK");
    }
    if a.state == Some(OnOff::Off) && s == Setting::OnByEnv {
        println_out("OPC_TELEMETRY in the environment turns it on: unset it");
    }
    Ok(0)
}

fn source(s: Setting) -> &'static str {
    match s {
        Setting::On => "default",
        Setting::OnByEnv | Setting::OffByEnv => "environment",
        Setting::OffByConfig => "config",
    }
}
