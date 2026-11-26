//! `--timing`: where the time went, measured with a monotonic clock.
//!
//! Durations only cross between our clock and the servers' (`Server-Timing`,
//! `timing.serverUs`, `firstTokenMs`); the clocks are never compared.

use std::collections::VecDeque;
use std::fmt::Write as _;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, Default)]
pub struct Split {
    pub total: Duration,
    pub ours: Duration,
    pub server: Option<Duration>,
    pub model: Option<Duration>,
}

impl Split {
    pub fn network(&self) -> Duration {
        self.total.saturating_sub(self.ours).saturating_sub(self.server.unwrap_or_default()).saturating_sub(self.model.unwrap_or_default())
    }
}

#[derive(Debug, Clone, Default)]
pub struct TurnTiming {
    pub turn_id: String,
    pub accepted: Option<Split>,
    pub first_token: Option<Split>,
    pub streaming: Option<Duration>,
}

#[derive(Debug, Default)]
struct Data {
    prompt: Option<Duration>,
    create: Option<Duration>,
    connect: Option<(Duration, bool)>,
    ready: Option<Duration>,
    agent_start: Option<(String, Option<Duration>)>,
    turn: Option<TurnTiming>,
    worst_frame: Option<Duration>,
    pings: VecDeque<Duration>,
    edge: Option<String>,
    requests: Vec<(String, Duration, Option<Duration>)>,
}

pub struct Timing {
    pub start: Instant,
    data: Mutex<Data>,
}

static TIMING: OnceLock<Timing> = OnceLock::new();

/// Call first thing in `main`.
pub fn init() {
    let _ = TIMING.set(Timing { start: Instant::now(), data: Mutex::new(Data::default()) });
}

pub fn get() -> &'static Timing {
    TIMING.get_or_init(|| Timing { start: Instant::now(), data: Mutex::new(Data::default()) })
}

pub fn since_start() -> Duration {
    get().start.elapsed()
}

impl Timing {
    fn with<R>(&self, f: impl FnOnce(&mut Data) -> R) -> R {
        let mut d = self.data.lock().unwrap_or_else(|e| e.into_inner());
        f(&mut d)
    }

    pub fn mark_prompt(&self) {
        let t = self.start.elapsed();
        self.with(|d| { d.prompt.get_or_insert(t); });
    }
    pub fn mark_create(&self, took: Duration) {
        self.with(|d| d.create = Some(took));
    }
    pub fn mark_connect(&self, took: Duration, resumed_tls: bool) {
        self.with(|d| d.connect = Some((took, resumed_tls)));
    }
    pub fn mark_ready(&self) {
        let t = self.start.elapsed();
        self.with(|d| { d.ready.get_or_insert(t); });
    }
    pub fn agent_start(&self, kind: &str, took: Option<Duration>) {
        self.with(|d| d.agent_start = Some((kind.to_string(), took)));
    }
    pub fn turn(&self, f: impl FnOnce(&mut TurnTiming)) {
        self.with(|d| f(d.turn.get_or_insert_with(TurnTiming::default)));
    }
    pub fn new_turn(&self, turn_id: &str) {
        self.with(|d| d.turn = Some(TurnTiming { turn_id: turn_id.to_string(), ..Default::default() }));
    }
    pub fn frame(&self, took: Duration) {
        self.with(|d| {
            if d.worst_frame.is_none_or(|w| took > w) {
                d.worst_frame = Some(took);
            }
        });
    }
    pub fn ping(&self, rtt: Duration) {
        self.with(|d| {
            if d.pings.len() == 20 {
                d.pings.pop_front();
            }
            d.pings.push_back(rtt);
        });
    }
    pub fn rtt(&self) -> Option<Duration> {
        self.with(|d| median(d.pings.iter().copied().collect()))
    }
    pub fn edge(&self, edge: &str) {
        self.with(|d| d.edge = Some(edge.to_string()));
    }
    pub fn request(&self, label: &str, took: Duration, server: Option<Duration>) {
        self.with(|d| {
            if d.requests.len() < 64 {
                d.requests.push((label.to_string(), took, server));
            }
        });
    }

    /// The report printed on exit, as in `docs/reference/timing.mdx`.
    pub fn report(&self) -> String {
        self.with(|d| {
            let mut out = String::new();
            let row = |out: &mut String, indent: usize, label: &str, value: String| {
                let pad = 40usize.saturating_sub(indent + label.chars().count());
                let _ = writeln!(out, "{:indent$}{label}{:pad$} {value:>8}", "", "");
            };
            if d.prompt.is_some() || d.create.is_some() || d.connect.is_some() || d.ready.is_some() {
                out.push_str("launch\n");
                if let Some(p) = d.prompt {
                    row(&mut out, 2, "process start → prompt", ms(p));
                }
                let parallel = d.create.is_some() && d.connect.is_some();
                if let Some(c) = d.create {
                    row(&mut out, 2, "session create (API)", format!("{}{}", ms(c), if parallel { "   ┐ in parallel" } else { "" }));
                }
                if let Some((c, resumed)) = d.connect {
                    let note = if parallel { "   ┘" } else if resumed { "   TLS resumed" } else { "" };
                    row(&mut out, 2, "connection open + attach", format!("{}{note}", ms(c)));
                }
                if let Some(r) = d.ready {
                    row(&mut out, 2, "launch → ready", ms(r));
                }
                if let Some((kind, took)) = &d.agent_start {
                    row(&mut out, 2, "agent start", match took {
                        Some(t) => format!("{kind} · {}", ms(*t)),
                        None => kind.clone(),
                    });
                }
            }
            if let Some(t) = &d.turn {
                let _ = writeln!(out, "last turn ({})", crate::ids::short(&t.turn_id));
                let split = |out: &mut String, s: &Split| {
                    let mut parts = vec![format!("ours {}", ms(s.ours))];
                    if let Some(sv) = s.server {
                        parts.push(format!("server {}", ms(sv)));
                    }
                    parts.push(format!("network {}", ms(s.network())));
                    if let Some(m) = s.model {
                        parts.push(format!("model {}", ms(m)));
                    }
                    let _ = writeln!(out, "    {}", parts.join(" · "));
                };
                if let Some(a) = &t.accepted {
                    row(&mut out, 2, "enter → accepted", ms(a.total));
                    split(&mut out, a);
                }
                if let Some(f) = &t.first_token {
                    row(&mut out, 2, "enter → first token", ms(f.total));
                    split(&mut out, f);
                }
                if let Some(s) = t.streaming {
                    row(&mut out, 2, "first token → last token", ms(s));
                }
                if let Some(w) = d.worst_frame {
                    row(&mut out, 2, "render, worst frame", ms(w));
                }
            } else if let Some(w) = d.worst_frame {
                row(&mut out, 0, "render, worst frame", ms(w));
            }
            if !d.requests.is_empty() {
                out.push_str("requests\n");
                for (label, took, server) in &d.requests {
                    let v = match server {
                        Some(s) => format!("{} (server {})", ms(*took), ms(*s)),
                        None => ms(*took),
                    };
                    row(&mut out, 2, label, v);
                }
            }
            let rtt = median(d.pings.iter().copied().collect());
            if rtt.is_some() || d.edge.is_some() {
                out.push_str("connection\n");
                if let Some(r) = rtt {
                    row(&mut out, 2, &format!("round trip (median of last {})", d.pings.len()), ms(r));
                }
                if let Some(e) = &d.edge {
                    row(&mut out, 2, "edge", e.clone());
                }
            }
            row(&mut out, 0, "total", ms(self.start.elapsed()));
            out
        })
    }
}

pub fn median(mut v: Vec<Duration>) -> Option<Duration> {
    if v.is_empty() {
        return None;
    }
    v.sort();
    Some(v[v.len() / 2])
}

/// `4 ms`, `92 ms`, `1.39 s`, `0.4 ms`.
pub fn ms(d: Duration) -> String {
    let m = d.as_secs_f64() * 1000.0;
    if m >= 1000.0 {
        format!("{:.2} s", m / 1000.0)
    } else if m >= 10.0 || m == 0.0 {
        format!("{m:.0} ms")
    } else {
        format!("{m:.1} ms")
    }
}

/// Parses `Server-Timing`: the `total` entry's `dur`, else the sum of all.
pub fn parse_server_timing(header: &str) -> Option<Duration> {
    let mut total = None;
    let mut sum = 0.0;
    let mut any = false;
    for entry in header.split(',') {
        let mut parts = entry.split(';').map(str::trim);
        let name = parts.next().unwrap_or("");
        let dur = parts.find_map(|p| p.strip_prefix("dur=")).and_then(|v| v.trim_matches('"').parse::<f64>().ok());
        if let Some(d) = dur {
            any = true;
            sum += d;
            if name == "total" {
                total = Some(d);
            }
        }
    }
    let msf = total.or(any.then_some(sum))?;
    Some(Duration::from_secs_f64((msf / 1000.0).max(0.0)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_timing() {
        assert_eq!(parse_server_timing("edge;dur=1, total;dur=3"), Some(Duration::from_millis(3)));
        assert_eq!(parse_server_timing("a;dur=1.5, b;dur=0.5"), Some(Duration::from_millis(2)));
        assert_eq!(parse_server_timing("cache;desc=hit"), None);
    }

    #[test]
    fn formats() {
        assert_eq!(ms(Duration::from_millis(92)), "92 ms");
        assert_eq!(ms(Duration::from_millis(1390)), "1.39 s");
        assert_eq!(ms(Duration::from_micros(4200)), "4.2 ms");
    }

    #[test]
    fn split_network_is_the_rest() {
        let s = Split {
            total: Duration::from_millis(84),
            ours: Duration::from_millis(1),
            server: Some(Duration::from_millis(3)),
            model: None,
        };
        assert_eq!(s.network(), Duration::from_millis(80));
    }
}
