//! The command line, as `docs/reference/commands.mdx` describes it.
//!
//! One parser: the root takes `opc [options] [message]…`, and a first word
//! that names a command is that command (clap matches subcommands before
//! positionals). A command that then cannot parse the rest is reported as a
//! message that should have been quoted.

use crate::error::Error;
use clap::{Args, Parser, Subcommand, ValueEnum};
use std::path::PathBuf;
use std::time::Duration;

const AFTER_HELP: &str = "\
Exit codes:
  0    success                       4    unreachable or busy, retry
  1    the turn failed or was        5    waiting for a person
       cancelled                     6    out of credits
  2    usage error                   124  timed out
  3    not logged in / no access     130  interrupted

Scripting: opc help scripting
Telemetry: opc sends anonymous usage timings and error classes on its
  connection, never content. Off: OPC_TELEMETRY=0 or opc config telemetry off
  (opc help telemetry)";

pub fn version() -> &'static str {
    concat!(env!("CARGO_PKG_VERSION"), " (protocol opc.v1, schema computer-api.v1)")
}

#[derive(Debug, Parser)]
#[command(
    name = "opc",
    version = version(),
    about = "The terminal for your organization's computer",
    args_conflicts_with_subcommands = true,
    disable_help_subcommand = true,
    after_help = AFTER_HELP,
    max_term_width = 100
)]
pub struct Cli {
    #[command(flatten)]
    pub global: Global,
    #[command(subcommand)]
    pub command: Option<Command>,
    #[command(flatten)]
    pub run: RunArgs,
    /// The message. Several words are joined; `-` reads standard input.
    #[arg(value_name = "MESSAGE", trailing_var_arg = true)]
    pub message: Vec<String>,
}

#[derive(Debug, Clone, Args, Default)]
pub struct Global {
    /// On exit, print where the time went to standard error
    #[arg(long, global = true)]
    pub timing: bool,
    /// No colors (same as NO_COLOR=1)
    #[arg(long, global = true)]
    pub no_color: bool,
    /// No progress messages on standard error
    #[arg(short, long, global = true)]
    pub quiet: bool,
    /// Debug logs to standard error (same as OPC_LOG=debug)
    #[arg(short, long, global = true)]
    pub verbose: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum Format {
    Text,
    Json,
    StreamJson,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum, Default)]
pub enum OnAsk {
    #[default]
    Fail,
    Dismiss,
    Wait,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum IfBusy {
    #[default]
    Queue,
    Steer,
    Interrupt,
}

impl IfBusy {
    pub fn as_str(self) -> &'static str {
        match self {
            IfBusy::Queue => "queue",
            IfBusy::Steer => "steer",
            IfBusy::Interrupt => "interrupt",
        }
    }
}

#[derive(Debug, Clone, Args, Default)]
pub struct Delivery {
    /// If a turn is running, deliver into it
    #[arg(long, conflicts_with_all = ["queue", "interrupt"])]
    pub steer: bool,
    /// If a turn is running, run as its own turn after it (the default)
    #[arg(long, conflicts_with = "interrupt")]
    pub queue: bool,
    /// Stop the running turn and every queued one, then run
    #[arg(long)]
    pub interrupt: bool,
}

impl Delivery {
    pub fn if_busy(&self) -> IfBusy {
        if self.steer {
            IfBusy::Steer
        } else if self.interrupt {
            IfBusy::Interrupt
        } else {
            IfBusy::Queue
        }
    }
    pub fn given(&self) -> bool {
        self.steer || self.queue || self.interrupt
    }
}

/// Settings and set-up for a new session.
#[derive(Debug, Clone, Args, Default)]
pub struct NewSession {
    /// Model for the new session
    #[arg(long, value_name = "MODEL")]
    pub model: Option<String>,
    /// Effort level for the new session
    #[arg(long, value_name = "LEVEL")]
    pub effort: Option<String>,
    /// Speed for the new session: fast (the default) or standard
    #[arg(long, value_name = "SPEED", value_parser = ["fast", "standard"])]
    pub speed: Option<String>,
    /// Permission mode for the new session
    #[arg(long, visible_alias = "permission-mode", value_name = "MODE")]
    pub mode: Option<String>,
    /// Title, instead of one from the first message
    #[arg(long, value_name = "TITLE")]
    pub title: Option<String>,
    /// Metadata for the new session (repeatable)
    #[arg(long = "metadata", value_name = "KEY=VALUE", value_parser = parse_kv)]
    pub metadata: Vec<(String, String)>,
    /// Push a directory into the new session before sending (repeatable)
    #[arg(long = "push", value_name = "DIR")]
    pub push: Vec<PathBuf>,
    /// Make a retry safe: a repeat within 24 hours does nothing new
    #[arg(long, value_name = "KEY")]
    pub idempotency_key: Option<String>,
}

#[derive(Debug, Clone, Args, Default)]
pub struct Output {
    /// text, json or stream-json
    #[arg(long, value_enum, value_name = "FORMAT")]
    pub output_format: Option<Format>,
    /// Short for --output-format json
    #[arg(long, conflicts_with = "output_format")]
    pub json: bool,
}

impl Output {
    pub fn format(&self) -> Format {
        if self.json { Format::Json } else { self.output_format.unwrap_or(Format::Text) }
    }
}

/// `opc` and `opc -p`.
#[derive(Debug, Clone, Args, Default)]
pub struct RunArgs {
    /// Non-interactive: send, wait, print the result
    #[arg(short, long)]
    pub print: bool,
    /// With -p, send to an existing session instead of creating one
    #[arg(short = 's', long = "session", value_name = "ID")]
    pub session: Option<String>,
    #[command(flatten)]
    pub delivery: Delivery,
    #[command(flatten)]
    pub new: NewSession,
    /// With -p: text, json or stream-json
    #[arg(long, value_enum, value_name = "FORMAT")]
    pub output_format: Option<Format>,
    /// With -p: short for --output-format json
    #[arg(long, conflicts_with = "output_format")]
    pub json: bool,
    /// With stream-json: also print deltas (text, reasoning, tool calls being written, tool output)
    #[arg(long)]
    pub include_partial_messages: bool,
    /// With -p, when an ask opens: fail (exit 5), dismiss, or wait (also on send --wait and wait)
    #[arg(long, value_enum, value_name = "ACTION")]
    pub on_ask: Option<OnAsk>,
    /// With -p: give up after this long (90s, 20m, 2h), exit 124
    #[arg(long, value_parser = parse_duration, value_name = "DURATION")]
    pub timeout: Option<Duration>,
    /// With --timeout: interrupt the turn before exiting
    #[arg(long)]
    pub interrupt_on_timeout: bool,
    /// With -p: interrupt the turn whenever opc exits before it ends
    #[arg(long)]
    pub interrupt_on_exit: bool,
    /// With -p: also wait for the background subagents the turn launched
    #[arg(long)]
    pub wait_subagents: bool,
}

impl RunArgs {
    pub fn format(&self) -> Format {
        if self.json { Format::Json } else { self.output_format.unwrap_or(Format::Text) }
    }
}

#[derive(Debug, Subcommand)]
pub enum Command {
    /// Create a session, send a message, return at once
    New(NewArgs),
    /// Attach to a session
    #[command(visible_alias = "attach")]
    A(AttachArgs),
    /// List sessions
    #[command(visible_alias = "list")]
    Ls(LsArgs),
    /// Print a session's history and exit
    Log(LogArgs),
    /// Send a message and return when it is accepted
    Send(SendArgs),
    /// Wait for a session, a turn, or several
    Wait(WaitArgs),
    /// Print a session's activity until it is idle or waiting
    Watch(WatchArgs),
    /// Interrupt the running turn and cancel queued ones
    Interrupt(InterruptArgs),
    /// List and answer asks
    #[command(subcommand)]
    Ask(AskCommand),
    /// List, stop and read a session's subagents
    Subagents(SubagentsArgs),
    /// Set a session's title
    Rename(RenameArgs),
    /// Archive a session
    Archive(SessionOnly),
    /// Bring an archived session back
    Unarchive(SessionOnly),
    /// Open the session on the dashboard
    Open(OpenArgs),
    /// Print the agent's changes as a git diff
    Diff(DiffArgs),
    /// Copy a local directory into a session's workspace
    Push(PushArgs),
    /// Copy a directory or file from a session's workspace
    Pull(PullArgs),
    /// Open a shell in a session's workspace
    Shell(ShellArgs),
    /// Log in
    Login(LoginArgs),
    /// Log out
    Logout,
    /// Who the credential is
    Whoami(JsonOnly),
    /// Check the path to your computer
    Doctor(JsonOnly),
    /// Print the JSON Schema of the API's objects
    Schema(SchemaArgs),
    /// Help for a command, or a topic
    Help(HelpArgs),
    /// Print a shell completion script
    Completion(CompletionArgs),
    /// Settings of this opc
    #[command(subcommand)]
    Config(ConfigCommand),
}

impl Command {
    pub fn name(&self) -> &'static str {
        match self {
            Command::New(_) => "new",
            Command::A(_) => "a",
            Command::Ls(_) => "ls",
            Command::Log(_) => "log",
            Command::Send(_) => "send",
            Command::Wait(_) => "wait",
            Command::Watch(_) => "watch",
            Command::Interrupt(_) => "interrupt",
            Command::Ask(_) => "ask",
            Command::Subagents(_) => "subagents",
            Command::Rename(_) => "rename",
            Command::Archive(_) => "archive",
            Command::Unarchive(_) => "unarchive",
            Command::Open(_) => "open",
            Command::Diff(_) => "diff",
            Command::Push(_) => "push",
            Command::Pull(_) => "pull",
            Command::Shell(_) => "shell",
            Command::Login(_) => "login",
            Command::Logout => "logout",
            Command::Whoami(_) => "whoami",
            Command::Doctor(_) => "doctor",
            Command::Schema(_) => "schema",
            Command::Help(_) => "help",
            Command::Completion(_) => "completion",
            Command::Config(_) => "config",
        }
    }

    /// Whether errors should be JSON (any JSON format selected).
    pub fn wants_json(&self) -> bool {
        let out = |o: &Output| o.format() != Format::Text;
        match self {
            Command::New(a) => a.json,
            Command::Ls(a) => a.json,
            Command::Log(a) => out(&a.output),
            Command::Send(a) => a.json,
            Command::Wait(a) => a.json,
            Command::Watch(a) => a.json || a.output_format.is_some_and(|f| f != Format::Text),
            Command::Interrupt(a) => a.json,
            Command::Ask(a) => a.json(),
            Command::Subagents(a) => a.json(),
            Command::Push(a) => a.json,
            Command::Pull(a) => a.json,
            Command::Whoami(a) | Command::Doctor(a) => a.json,
            Command::Config(ConfigCommand::Telemetry(a)) => a.json,
            _ => false,
        }
    }

    pub fn is_stream_json(&self) -> bool {
        match self {
            Command::Log(a) => a.output.format() == Format::StreamJson,
            Command::Watch(a) => a.output_format == Some(Format::StreamJson),
            _ => false,
        }
    }
}

/// The session operand: `-s <id>` or the first positional.
#[derive(Debug, Clone, Args, Default)]
pub struct SessionOpt {
    /// The session: an id, a prefix, `-` for the last one, or a Slack link
    #[arg(short = 's', long = "session", value_name = "ID")]
    pub session: Option<String>,
}

#[derive(Debug, Args)]
pub struct NewArgs {
    /// The message; `-` reads standard input
    #[arg(value_name = "MESSAGE")]
    pub message: Vec<String>,
    #[command(flatten)]
    pub new: NewSession,
    /// Print what creating the session returned
    #[arg(long)]
    pub json: bool,
}

#[derive(Debug, Args)]
pub struct AttachArgs {
    /// A session id, prefix, `-`, Slack link, or words to search titles
    #[arg(value_name = "ID|WORDS")]
    pub target: Vec<String>,
    #[command(flatten)]
    pub session: SessionOpt,
    /// Attach without the ability to send or answer
    #[arg(long)]
    pub read_only: bool,
    /// Print the last n turns in full
    #[arg(long, value_name = "N", value_parser = clap::value_parser!(u32).range(1..=50), conflicts_with = "no_history")]
    pub history: Option<u32>,
    /// Do not print earlier turns
    #[arg(long)]
    pub no_history: bool,
}

#[derive(Debug, Args)]
pub struct LsArgs {
    /// starting, running, waiting, idle or suspended (repeatable)
    #[arg(long, value_name = "STATUS")]
    pub status: Vec<String>,
    /// Only sessions with this metadata (repeatable)
    #[arg(long = "metadata", value_name = "KEY=VALUE", value_parser = parse_kv)]
    pub metadata: Vec<(String, String)>,
    /// Only archived sessions
    #[arg(long)]
    pub archived: bool,
    /// At most n rows, up to 500
    #[arg(long, default_value_t = 50, value_parser = clap::value_parser!(u32).range(1..=500))]
    pub limit: u32,
    /// Add the last line the agent wrote
    #[arg(long)]
    pub long: bool,
    /// A JSON array of sessions
    #[arg(long)]
    pub json: bool,
}

#[derive(Debug, Args)]
pub struct LogArgs {
    #[arg(value_name = "ID")]
    pub id: Option<String>,
    #[command(flatten)]
    pub session: SessionOpt,
    /// Everything, as the session screen shows it with details open
    #[arg(long)]
    pub details: bool,
    /// Only events after this seq
    #[arg(long, value_name = "SEQ")]
    pub after: Option<u64>,
    /// Only this turn
    #[arg(long, value_name = "TURN")]
    pub turn: Option<String>,
    /// Only these event types, such as `tool.*` (repeatable)
    #[arg(long, value_name = "GLOB")]
    pub types: Vec<String>,
    #[command(flatten)]
    pub output: Output,
}

#[derive(Debug, Args)]
pub struct SendArgs {
    /// The session, then the message (`-` reads standard input)
    #[arg(value_name = "ID MESSAGE", required = true)]
    pub args: Vec<String>,
    #[command(flatten)]
    pub session: SessionOpt,
    #[command(flatten)]
    pub delivery: Delivery,
    /// Then wait for the turn and print its Result
    #[arg(long)]
    pub wait: bool,
    /// With --wait: give up after this long, exit 124
    #[arg(long, value_parser = parse_duration, value_name = "DURATION", requires = "wait")]
    pub timeout: Option<Duration>,
    /// With --wait: also wait for the background subagents the turn launched
    #[arg(long, requires = "wait")]
    pub wait_subagents: bool,
    /// With --wait, when an ask opens: fail (exit 5), dismiss, or wait
    #[arg(long, value_enum, value_name = "ACTION", requires = "wait")]
    pub on_ask: Option<OnAsk>,
    /// A repeat sends nothing new and prints the original turn
    #[arg(long, value_name = "KEY")]
    pub idempotency_key: Option<String>,
    /// Print what sending returned (with --wait, the Result)
    #[arg(long)]
    pub json: bool,
}

#[derive(Debug, Args)]
pub struct WaitArgs {
    /// Session ids or turn ids
    #[arg(value_name = "ID|TURN")]
    pub ids: Vec<String>,
    #[command(flatten)]
    pub session: SessionOpt,
    /// Wait for this turn of the session
    #[arg(long, value_name = "TURN")]
    pub turn: Option<String>,
    /// With several ids: return when the first is done
    #[arg(long, conflicts_with = "all")]
    pub any: bool,
    /// With several ids: return when every one is done
    #[arg(long)]
    pub all: bool,
    /// Give up after this long, exit 124
    #[arg(long, value_parser = parse_duration, value_name = "DURATION")]
    pub timeout: Option<Duration>,
    /// Also wait for the background subagents the turn launched
    #[arg(long)]
    pub wait_subagents: bool,
    /// When an ask opens: fail (exit 5), dismiss, or wait
    #[arg(long, value_enum, value_name = "ACTION")]
    pub on_ask: Option<OnAsk>,
    /// The Result of the last turn
    #[arg(long)]
    pub json: bool,
}

#[derive(Debug, Args)]
pub struct WatchArgs {
    #[arg(value_name = "ID")]
    pub ids: Vec<String>,
    #[command(flatten)]
    pub session: SessionOpt,
    /// Print recorded events after this seq first, then live ones
    #[arg(long, value_name = "SEQ", conflicts_with = "from_start")]
    pub after: Option<u64>,
    /// Print the whole history first (same as --after 0)
    #[arg(long)]
    pub from_start: bool,
    /// Keep watching across turns until interrupted
    #[arg(long)]
    pub follow: bool,
    /// Give up after this long, exit 124
    #[arg(long, value_parser = parse_duration, value_name = "DURATION")]
    pub timeout: Option<Duration>,
    /// text, json (the Result of the last turn) or stream-json
    #[arg(long, value_enum, value_name = "FORMAT")]
    pub output_format: Option<Format>,
    /// Short for --output-format json
    #[arg(long, conflicts_with = "output_format")]
    pub json: bool,
    /// With stream-json: also print deltas (text, reasoning, tool calls being written, tool output)
    #[arg(long)]
    pub include_partial_messages: bool,
}

#[derive(Debug, Args)]
pub struct InterruptArgs {
    #[arg(value_name = "ID")]
    pub id: Option<String>,
    #[command(flatten)]
    pub session: SessionOpt,
    /// Return as soon as the interrupt is recorded
    #[arg(long)]
    pub no_wait: bool,
    #[arg(long)]
    pub json: bool,
}

#[derive(Debug, Subcommand)]
pub enum AskCommand {
    /// Open asks in a session, or in all your sessions
    Ls(AskLsArgs),
    /// Allow an approval
    Allow(AskDecideArgs),
    /// Deny an approval
    Deny(AskDecideArgs),
    /// Allow an approval and its alwaysAllows rule for the rest of the session
    Always(AskDecideArgs),
    /// Answer a question
    Answer(AskAnswerArgs),
    /// Close any ask without an answer
    Dismiss(AskDecideArgs),
}

impl AskCommand {
    pub fn json(&self) -> bool {
        match self {
            AskCommand::Ls(a) => a.json,
            AskCommand::Allow(a) | AskCommand::Deny(a) | AskCommand::Always(a) | AskCommand::Dismiss(a) => a.json,
            AskCommand::Answer(a) => a.json,
        }
    }
}

#[derive(Debug, Args)]
pub struct AskLsArgs {
    #[arg(value_name = "ID")]
    pub id: Option<String>,
    #[command(flatten)]
    pub session: SessionOpt,
    #[arg(long)]
    pub json: bool,
}

#[derive(Debug, Args)]
pub struct AskDecideArgs {
    #[arg(value_name = "ASK")]
    pub ask: String,
    #[command(flatten)]
    pub session: SessionOpt,
    /// A message the agent reads with the decision
    #[arg(short, long, value_name = "MESSAGE")]
    pub message: Option<String>,
    /// For a plan: the permission mode to switch to when allowing it, such as acceptEdits
    #[arg(long, value_name = "MODE")]
    pub mode: Option<String>,
    #[arg(long)]
    pub json: bool,
}

#[derive(Debug, Args)]
pub struct AskAnswerArgs {
    #[arg(value_name = "ASK")]
    pub ask: String,
    /// `-` reads the API's answer body from standard input
    #[arg(value_name = "-")]
    pub stdin: Option<String>,
    #[command(flatten)]
    pub session: SessionOpt,
    /// An option label exactly as given (repeatable for multiSelect)
    #[arg(long, value_name = "LABEL")]
    pub choice: Vec<String>,
    /// An answer in your own words
    #[arg(long, value_name = "TEXT")]
    pub text: Option<String>,
    #[arg(long)]
    pub json: bool,
}

/// `opc subagents [ls|stop|result]`; without a subcommand, `ls`.
#[derive(Debug, Args)]
#[command(args_conflicts_with_subcommands = true)]
pub struct SubagentsArgs {
    #[command(subcommand)]
    pub command: Option<SubagentsCommand>,
    #[command(flatten)]
    pub ls: SubagentsLsArgs,
}

impl SubagentsArgs {
    pub fn json(&self) -> bool {
        match &self.command {
            None => self.ls.json,
            Some(SubagentsCommand::Ls(a)) => a.json,
            Some(SubagentsCommand::Stop(a)) | Some(SubagentsCommand::Result(a)) => a.json,
        }
    }
}

#[derive(Debug, Subcommand)]
pub enum SubagentsCommand {
    /// The running subagents of a session (with --all-statuses, every one)
    Ls(SubagentsLsArgs),
    /// Stop a running subagent
    Stop(SubagentArgs),
    /// Print a subagent's full result
    Result(SubagentArgs),
}

#[derive(Debug, Clone, Args, Default)]
pub struct SubagentsLsArgs {
    #[arg(value_name = "ID")]
    pub id: Option<String>,
    #[command(flatten)]
    pub session: SessionOpt,
    /// Ended subagents too
    #[arg(long)]
    pub all_statuses: bool,
    #[arg(long)]
    pub json: bool,
}

#[derive(Debug, Args)]
pub struct SubagentArgs {
    /// The subagent (sa_…)
    #[arg(value_name = "SUBAGENT")]
    pub subagent: String,
    #[command(flatten)]
    pub session: SessionOpt,
    #[arg(long)]
    pub json: bool,
}

#[derive(Debug, Args)]
pub struct RenameArgs {
    /// The session, then the title
    #[arg(value_name = "ID TITLE", required = true)]
    pub args: Vec<String>,
    #[command(flatten)]
    pub session: SessionOpt,
}

#[derive(Debug, Args)]
pub struct SessionOnly {
    #[arg(value_name = "ID")]
    pub id: Option<String>,
    #[command(flatten)]
    pub session: SessionOpt,
}

#[derive(Debug, Args)]
pub struct OpenArgs {
    #[arg(value_name = "ID")]
    pub id: Option<String>,
    #[command(flatten)]
    pub session: SessionOpt,
}

#[derive(Debug, Args)]
pub struct DiffArgs {
    #[arg(value_name = "ID")]
    pub id: Option<String>,
    #[command(flatten)]
    pub session: SessionOpt,
    /// A summary per file
    #[arg(long)]
    pub stat: bool,
}

#[derive(Debug, Args)]
pub struct PushArgs {
    /// The directory to push (default: the current one)
    #[arg(value_name = "DIR")]
    pub dir: Option<PathBuf>,
    #[command(flatten)]
    pub session: SessionOpt,
    /// The name in the workspace (default: the directory's name)
    #[arg(long, value_name = "NAME")]
    pub to: Option<String>,
    /// Send files .gitignore would leave out
    #[arg(long)]
    pub no_ignore: bool,
    /// Print what would be sent
    #[arg(long)]
    pub dry_run: bool,
    #[arg(long, value_name = "KEY")]
    pub idempotency_key: Option<String>,
    #[arg(long)]
    pub json: bool,
}

#[derive(Debug, Args)]
pub struct PullArgs {
    /// The path in the workspace
    #[arg(value_name = "PATH")]
    pub path: String,
    /// The local directory (default: the path's name, here)
    #[arg(value_name = "DIR")]
    pub dir: Option<PathBuf>,
    #[command(flatten)]
    pub session: SessionOpt,
    /// Write into a directory that has files
    #[arg(long)]
    pub force: bool,
    /// Print what would be written
    #[arg(long)]
    pub dry_run: bool,
    #[arg(long)]
    pub json: bool,
}

#[derive(Debug, Args)]
pub struct ShellArgs {
    #[arg(value_name = "ID")]
    pub id: Option<String>,
    #[command(flatten)]
    pub session: SessionOpt,
    /// Run this command and exit with its code
    #[arg(short = 'c', long = "command", value_name = "COMMAND")]
    pub command: Option<String>,
    /// No terminal: pipes only
    #[arg(long)]
    pub no_tty: bool,
}

#[derive(Debug, Args)]
pub struct LoginArgs {
    /// Print the link instead of opening a browser
    #[arg(long)]
    pub no_browser: bool,
    /// Log in again even with a working credential
    #[arg(long)]
    pub force: bool,
}

#[derive(Debug, Args)]
pub struct JsonOnly {
    #[arg(long)]
    pub json: bool,
}

#[derive(Debug, Args)]
pub struct SchemaArgs {
    /// result, event, session, turn or ask
    #[arg(value_name = "OBJECT")]
    pub object: Option<String>,
}

#[derive(Debug, Args)]
pub struct HelpArgs {
    #[arg(value_name = "TOPIC")]
    pub topic: Vec<String>,
}

#[derive(Debug, Subcommand)]
pub enum ConfigCommand {
    /// Show or set whether opc sends usage telemetry (on or off)
    Telemetry(TelemetryArgs),
}

#[derive(Debug, Args)]
pub struct TelemetryArgs {
    /// on or off; without it, the current setting and why
    #[arg(value_enum, value_name = "STATE")]
    pub state: Option<OnOff>,
    #[arg(long)]
    pub json: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum OnOff {
    On,
    Off,
}

#[derive(Debug, Args)]
pub struct CompletionArgs {
    #[arg(value_enum)]
    pub shell: CompletionShell,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum CompletionShell {
    Bash,
    Zsh,
    Fish,
}

/// Every command name, including aliases.
pub const COMMANDS: &[&str] = &[
    "new", "a", "attach", "ls", "list", "log", "send", "wait", "watch", "interrupt", "ask", "subagents", "rename", "archive", "unarchive",
    "open", "diff", "push", "pull", "shell", "login", "logout", "whoami", "doctor", "schema", "help", "completion",
];

/// Root options that take a value, for finding the first word.
const VALUE_OPTS: &[&str] = &[
    "-s", "--session", "--model", "--effort", "--speed", "--mode", "--permission-mode", "--title", "--metadata", "--push",
    "--idempotency-key", "--output-format", "--on-ask", "--timeout",
];

/// The first positional word on the command line and the positionals from
/// there on, as the root parser sees them.
pub fn first_word(args: &[String]) -> Option<(usize, &str)> {
    let mut i = 0;
    while i < args.len() {
        let a = args[i].as_str();
        if a == "--" {
            return None;
        }
        if a.starts_with('-') && a.len() > 1 {
            if VALUE_OPTS.contains(&a) {
                i += 1;
            }
            i += 1;
            continue;
        }
        return Some((i, a));
    }
    None
}

/// Parses argv (without the program name).
pub fn parse(args: Vec<String>) -> std::result::Result<Cli, clap::Error> {
    let mut full = vec!["opc".to_string()];
    full.extend(args);
    Cli::try_parse_from(full)
}

/// When a command cannot parse the rest, the words were probably a message.
pub fn looks_like_message(args: &[String], err: &clap::Error) -> Option<String> {
    use clap::error::{ContextKind, ContextValue, ErrorKind::*};
    // Only a stray bare word: a bad value, a conflict or a missing argument
    // is a real usage error, and quoting would send it as a turn.
    if !matches!(err.kind(), UnknownArgument | TooManyValues | InvalidSubcommand) {
        return None;
    }
    if let Some(ContextValue::String(bad)) = err.get(ContextKind::InvalidArg)
        && bad.starts_with('-')
    {
        return None;
    }
    let (i, word) = first_word(args)?;
    if !COMMANDS.contains(&word) {
        return None;
    }
    let words: Vec<&str> = args[i..].iter().map(String::as_str).filter(|a| !a.starts_with('-')).collect();
    if words.len() < 2 {
        return None;
    }
    let msg = words.join(" ");
    Some(format!("\"{msg}\" looks like a message. Quote it: opc \"{msg}\""))
}

pub fn parse_kv(s: &str) -> std::result::Result<(String, String), String> {
    match s.split_once('=') {
        Some((k, v)) if !k.is_empty() => Ok((k.to_string(), v.to_string())),
        _ => Err(format!("expected key=value, got {s:?}")),
    }
}

/// `90s`, `20m`, `2h`, `500ms`, or seconds.
pub fn parse_duration(s: &str) -> std::result::Result<Duration, String> {
    let s = s.trim();
    let (num, unit) = match s.find(|c: char| !c.is_ascii_digit() && c != '.') {
        Some(i) => (&s[..i], &s[i..]),
        None => (s, "s"),
    };
    let n: f64 = num.parse().map_err(|_| format!("not a duration: {s:?} (use 90s, 20m or 2h)"))?;
    let secs = match unit {
        "ms" => n / 1000.0,
        "s" => n,
        "m" => n * 60.0,
        "h" => n * 3600.0,
        "d" => n * 86400.0,
        _ => return Err(format!("not a duration: {s:?} (use 90s, 20m or 2h)")),
    };
    if !secs.is_finite() || secs <= 0.0 {
        return Err(format!("the duration must be positive: {s:?}"));
    }
    Ok(Duration::from_secs_f64(secs))
}

/// Turns a clap error into ours, keeping clap's message.
pub fn usage_error(err: &clap::Error) -> Error {
    let text = err.render().to_string();
    let first = text.lines().find(|l| !l.trim().is_empty()).unwrap_or("invalid usage");
    Error::usage(first.trim_start_matches("error: ").to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(s: &[&str]) -> std::result::Result<Cli, clap::Error> {
        parse(s.iter().map(|s| s.to_string()).collect())
    }

    #[test]
    fn words_become_a_message() {
        let c = p(&["why", "is", "the", "build", "red"]).unwrap();
        assert!(c.command.is_none());
        assert_eq!(c.message.join(" "), "why is the build red");
        let c = p(&["--", "ls"]).unwrap();
        assert!(c.command.is_none());
        assert_eq!(c.message, vec!["ls"]);
        let c = p(&["push the fix to main"]).unwrap();
        assert!(c.command.is_none());
    }

    #[test]
    fn commands_are_commands() {
        let c = p(&["ls", "--json"]).unwrap();
        assert!(matches!(c.command, Some(Command::Ls(_))));
        let c = p(&["-p", "--model", "x", "hello"]).unwrap();
        assert!(c.run.print);
        assert_eq!(c.message, vec!["hello"]);
        let c = p(&["--timing", "ls"]).unwrap();
        assert!(c.global.timing);
    }

    #[test]
    fn speed_is_fast_or_standard() {
        let c = p(&["-p", "--speed", "standard", "hello"]).unwrap();
        assert_eq!(c.run.new.speed.as_deref(), Some("standard"));
        assert_eq!(c.message, vec!["hello"]);
        assert!(p(&["-p", "--speed", "slow", "hello"]).is_err());
        assert_eq!(first_word(&["--speed".into(), "fast".into(), "ls".into()]), Some((2, "ls")));
    }

    #[test]
    fn unquoted_command_words_are_reported() {
        let args: Vec<String> = ["push", "the", "fix", "to", "main"].iter().map(|s| s.to_string()).collect();
        let err = parse(args.clone()).unwrap_err();
        let msg = looks_like_message(&args, &err).expect("should be reported");
        assert_eq!(msg, "\"push the fix to main\" looks like a message. Quote it: opc \"push the fix to main\"");
    }

    #[test]
    fn real_usage_errors_keep_their_message() {
        for argv in [&["ls", "--limit", "1000"][..], &["send", "cs_0123456789abcdefgh", "--timeout", "5s", "hi"], &["pull", "app", "--dir", "x"]] {
            let args: Vec<String> = argv.iter().map(|s| s.to_string()).collect();
            let err = parse(args.clone()).unwrap_err();
            assert_eq!(looks_like_message(&args, &err), None, "{argv:?}: {err}");
        }
    }

    #[test]
    fn durations() {
        assert_eq!(parse_duration("90s").unwrap(), Duration::from_secs(90));
        assert_eq!(parse_duration("20m").unwrap(), Duration::from_secs(1200));
        assert_eq!(parse_duration("2h").unwrap(), Duration::from_secs(7200));
        assert_eq!(parse_duration("5").unwrap(), Duration::from_secs(5));
        assert!(parse_duration("soon").is_err());
        assert!(parse_duration("0s").is_err());
    }

    #[test]
    fn the_parser_is_consistent() {
        use clap::CommandFactory;
        Cli::command().debug_assert();
    }
}
