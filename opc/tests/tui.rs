//! The interactive screen end to end: opc in a pseudo-terminal against the
//! fake Computer, driven with keys, as a person would.

mod support;

use std::io::{Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use support::{Fake, Seed};

const T: Duration = Duration::from_secs(10);

struct Pty {
    child: Child,
    master: std::fs::File,
    out: Arc<Mutex<Vec<u8>>>,
}

impl Pty {
    fn spawn(fake: &Fake, args: &[&str]) -> Pty {
        Pty::spawn_with(fake, args, &[])
    }

    /// As `spawn`, without the fake's variables named in `unset`.
    fn spawn_with(fake: &Fake, args: &[&str], unset: &[&str]) -> Pty {
        Pty::spawn_env(fake, args, unset, &[])
    }

    /// As `spawn_with`, with the variables in `set` in place of the fake's.
    fn spawn_env(fake: &Fake, args: &[&str], unset: &[&str], set: &[(&str, &str)]) -> Pty {
        let (mut m, mut s) = (0, 0);
        let mut ws = libc::winsize { ws_row: 40, ws_col: 120, ws_xpixel: 0, ws_ypixel: 0 };
        // SAFETY: openpty fills in two descriptors we then own.
        let r = unsafe { libc::openpty(&mut m, &mut s, std::ptr::null_mut(), std::ptr::null_mut::<libc::termios>() as _, &mut ws as *mut libc::winsize as _) };
        assert_eq!(r, 0, "openpty");
        // SAFETY: both are fresh descriptors from openpty.
        let (master, slave) = unsafe { (OwnedFd::from_raw_fd(m), OwnedFd::from_raw_fd(s)) };
        let mut c = Command::new(env!("CARGO_BIN_EXE_opc"));
        c.args(args).env_remove("OPC_LOG").env_remove("LC_ALL").env_remove("LC_CTYPE").env("LANG", "C.UTF-8").env("TERM", "xterm-256color");
        for (k, v) in fake.env() {
            if !unset.contains(&k.as_str()) {
                c.env(k, v);
            }
        }
        for (k, v) in set {
            c.env(k, v);
        }
        c.stdin(Stdio::from(slave.try_clone().unwrap())).stdout(Stdio::from(slave.try_clone().unwrap())).stderr(Stdio::from(slave));
        // SAFETY: only async-signal-safe calls between fork and exec.
        unsafe {
            c.pre_exec(|| {
                if libc::setsid() < 0 || libc::ioctl(0, libc::TIOCSCTTY as _, 0) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let child = c.spawn().expect("spawn opc");
        let master = std::fs::File::from(master);
        let out = Arc::new(Mutex::new(Vec::new()));
        let (mut rd, mut wr, o2) = (master.try_clone().unwrap(), master.try_clone().unwrap(), out.clone());
        std::thread::spawn(move || {
            let mut buf = [0u8; 65536];
            while let Ok(n) = rd.read(&mut buf) {
                if n == 0 {
                    break;
                }
                // Answer the device-attributes query, as terminals do.
                if buf[..n].windows(3).any(|w| w == b"\x1b[c") {
                    let _ = wr.write_all(b"\x1b[?62;22c");
                }
                o2.lock().unwrap().extend_from_slice(&buf[..n]);
            }
        });
        Pty { child, master, out }
    }

    /// Everything printed so far, escape sequences removed.
    fn screen(&self) -> String {
        let raw = String::from_utf8_lossy(&self.out.lock().unwrap()).to_string();
        strip(&raw)
    }

    fn wait_for(&self, what: &str) {
        let end = Instant::now() + T;
        while Instant::now() < end {
            if self.screen().contains(what) {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        panic!("{what:?} never appeared on the screen:\n{}", self.screen());
    }

    /// Waits for a line holding `what` that is not the echo of a message
    /// typed as `reply <what>`.
    fn wait_reply(&self, what: &str) {
        let end = Instant::now() + T;
        while Instant::now() < end {
            if self.screen().lines().any(|l| l.contains(what) && !l.contains("reply ")) {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        panic!("the reply {what:?} never appeared on the screen:\n{}", self.screen());
    }

    fn keys(&mut self, k: &[u8]) {
        self.master.write_all(k).unwrap();
        self.master.flush().unwrap();
    }

    fn wait_exit(&mut self) -> i32 {
        let end = Instant::now() + T;
        while Instant::now() < end {
            if let Some(s) = self.child.try_wait().unwrap() {
                return s.code().unwrap_or(-1);
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let _ = self.child.kill();
        panic!("opc did not exit:\n{}", self.screen());
    }
}

impl Drop for Pty {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = self.master.as_raw_fd();
    }
}

fn strip(s: &str) -> String {
    let mut out = String::new();
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        if c == '\x1b' {
            match it.next() {
                Some('[') => {
                    for c in it.by_ref() {
                        if ('@'..='~').contains(&c) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    while let Some(c) = it.next() {
                        if c == '\x07' || (c == '\x1b' && it.peek() == Some(&'\\')) {
                            break;
                        }
                    }
                }
                _ => {}
            }
        } else if c != '\r' {
            out.push(c);
        }
    }
    out
}

/// The one session the fake has, waiting for it to be created.
fn only_session(fake: &Fake) -> String {
    let end = Instant::now() + T;
    loop {
        let ids: Vec<String> = fake.read(|w| w.sessions.iter().map(|s| s.id.clone()).collect());
        assert!(ids.len() <= 1, "sessions: {ids:?}");
        if let Some(i) = ids.first() {
            return i.clone();
        }
        assert!(Instant::now() < end, "no session was created");
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// Launch to prompt needs no server: against an address that never answers,
/// the prompt line still comes up at once. The budget in timing.mdx is 10 ms;
/// this gate is loose enough for a debug build on a shared runner and still
/// fails if launch ever waits on the network.
#[test]
fn prompt_does_not_wait_for_the_network() {
    let fake = Fake::start();
    let hole = [("OPENCOMPUTER_API_URL", "https://10.255.255.1"), ("OPC_WIRE_URL", "wss://10.255.255.1"), ("OPENCOMPUTER_API_KEY", "not-a-key")];
    let mut ms: Vec<u128> = (0..10)
        .map(|_| {
            let t0 = Instant::now();
            let p = Pty::spawn_env(&fake, &[], &[], &hole);
            p.wait_for("type a message");
            t0.elapsed().as_millis()
        })
        .collect();
    ms.sort();
    assert!(ms[ms.len() / 2] <= 250, "launch -> prompt, median of 10: {}ms ({ms:?})", ms[ms.len() / 2]);
}

#[test]
fn new_session_replies_and_detaches() {
    let fake = Fake::start();
    let mut p = Pty::spawn(&fake, &["reply hello from the fake"]);
    let sid = only_session(&fake);
    p.wait_reply("hello from the fake");
    assert!(fake.wait_idle(&sid, T));
    p.keys(b"\x04");
    assert_eq!(p.wait_exit(), 0);
    p.wait_for("[detached from");
    assert_eq!(fake.turns(&sid).len(), 1);
    fake.assert_no_panics();
}

#[test]
fn typed_message_is_sent_as_a_turn() {
    let fake = Fake::start();
    let mut p = Pty::spawn(&fake, &[]);
    p.wait_for("type a message");
    std::thread::sleep(Duration::from_millis(300));
    p.keys(b"reply typed and sent\r");
    let sid = only_session(&fake);
    p.wait_reply("typed and sent");
    assert!(fake.wait_idle(&sid, T));
    p.keys(b"\x04");
    assert_eq!(p.wait_exit(), 0);
    assert_eq!(fake.turns(&sid).len(), 1);
}

#[test]
fn approval_is_answered_with_a_key() {
    let fake = Fake::start();
    let mut p = Pty::spawn(&fake, &["approve"]);
    let sid = only_session(&fake);
    let ask = fake.wait_ask(&sid, T).expect("an ask");
    p.wait_for("rm -rf build");
    // Past the guard that keeps typing from answering by accident.
    std::thread::sleep(Duration::from_millis(900));
    p.keys(b"y");
    assert!(fake.wait_idle(&sid, T), "the turn did not finish; asks {:?} frames {:?} calls {:?}", fake.asks(&sid), fake.ws_frames().iter().filter(|f| f.dir != support::Dir::In).filter_map(|f| f.text.clone()).filter(|t| !t.contains("\"method\"")).collect::<Vec<_>>(), fake.ws_calls().iter().map(|(m, p)| format!("{m} {p}")).collect::<Vec<_>>());
    let a = fake.asks(&sid).into_iter().find(|a| a["id"] == ask["id"]).unwrap();
    assert_eq!(a["status"], "answered", "{a}");
    p.keys(b"\x04");
    assert_eq!(p.wait_exit(), 0);
}

#[test]
fn attach_shows_history_and_ctrl_c_twice_detaches() {
    let fake = Fake::start();
    let sid = fake.seed_session(Seed { turns: vec!["reply the earlier answer".into()], ..Seed::new("seeded") });
    let mut p = Pty::spawn(&fake, &["a", &sid]);
    p.wait_for("the earlier answer");
    p.keys(b"\x03");
    std::thread::sleep(Duration::from_millis(100));
    p.keys(b"\x03");
    assert_eq!(p.wait_exit(), 0);
    p.wait_for("[detached from \"seeded\"");
}

#[test]
fn plan_is_approved_with_y() {
    let fake = Fake::start();
    let mut p = Pty::spawn(&fake, &["plan"]);
    let sid = only_session(&fake);
    fake.wait_ask(&sid, T).expect("a plan ask");
    p.wait_for("do it");
    std::thread::sleep(Duration::from_millis(900));
    p.keys(b"y");
    assert!(fake.wait_idle(&sid, T), "the turn did not finish:\n{}", p.screen());
    let a = fake.asks(&sid).pop().unwrap();
    assert_eq!(a["status"], "answered", "{a}");
    assert_eq!(a["answer"]["decision"], "allow", "{a}");
    p.keys(b"\x04");
    assert_eq!(p.wait_exit(), 0);
}

#[test]
fn esc_interrupts_the_running_turn() {
    let fake = Fake::start();
    let mut p = Pty::spawn(&fake, &["slow 20000"]);
    let sid = only_session(&fake);
    assert!(fake.wait_for(T, {
        let sid = sid.clone();
        move |w| w.sess(&sid).is_ok_and(|s| s.active().is_some())
    }));
    std::thread::sleep(Duration::from_millis(300));
    p.keys(b"\x1b");
    assert!(fake.wait_idle(&sid, T), "Esc did not interrupt:\n{}", p.screen());
    let t = fake.turns(&sid).pop().unwrap();
    assert_eq!(t["status"], "cancelled", "{t}");
    p.keys(b"\x04");
    assert_eq!(p.wait_exit(), 0);
}

#[test]
fn sigterm_and_sighup_put_the_terminal_back() {
    for (sig, code) in [(libc::SIGTERM, 143), (libc::SIGHUP, 129)] {
        let fake = Fake::start();
        let mut p = Pty::spawn(&fake, &[]);
        p.wait_for("type a message");
        // SAFETY: a plain kill(2) to our own child.
        assert_eq!(unsafe { libc::kill(p.child.id() as i32, sig) }, 0);
        assert_eq!(p.wait_exit(), code);
        std::thread::sleep(Duration::from_millis(100));
        let raw = String::from_utf8_lossy(&p.out.lock().unwrap()).to_string();
        let (on, off) = (raw.rfind("\x1b[?2004h").unwrap(), raw.rfind("\x1b[?2004l").expect("bracketed paste off"));
        assert!(off > on, "bracketed paste left on: {raw:?}");
        assert!(raw.ends_with("\x1b[23;0t"), "the title is not put back: {:?}", &raw[raw.len().saturating_sub(80)..]);
    }
}

#[test]
fn a_narrower_window_erases_the_reflowed_live_area() {
    let fake = Fake::start();
    let mut p = Pty::spawn(&fake, &[]);
    p.wait_for("type a message");
    std::thread::sleep(Duration::from_millis(300));
    let before = p.out.lock().unwrap().len();
    let ws = libc::winsize { ws_row: 40, ws_col: 60, ws_xpixel: 0, ws_ypixel: 0 };
    // SAFETY: TIOCSWINSZ on our pty master; the kernel sends SIGWINCH.
    assert_eq!(unsafe { libc::ioctl(p.master.as_raw_fd(), libc::TIOCSWINSZ as _, &ws) }, 0);
    let end = Instant::now() + T;
    let raw = loop {
        let raw = String::from_utf8_lossy(&p.out.lock().unwrap()[before..]).to_string();
        if raw.contains("\x1b[?2026l") || Instant::now() > end {
            break raw;
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    assert!(raw.contains(&format!("J{}\r\n", "─".repeat(60))), "{raw:?}");
    // The 120-column rule above the prompt now takes two lines.
    assert!(raw.starts_with("\x1b[?2026h\r\x1b[2A\x1b[J"), "{raw:?}");
    p.keys(b"\x04");
    assert_eq!(p.wait_exit(), 0);
}

/// The telemetry events of one name opc sent on the wire.
fn telemetry(fake: &Fake, name: &str) -> Vec<serde_json::Value> {
    fake.ws_calls()
        .into_iter()
        .filter(|(m, _)| m == "telemetry")
        .flat_map(|(_, p)| p["events"].as_array().cloned().unwrap_or_default())
        .filter(|e| e["name"] == name)
        .collect()
}

#[test]
fn telemetry_measures_enter_to_first_output_once_per_turn() {
    let fake = Fake::start();
    let mut p = Pty::spawn(&fake, &[]);
    p.wait_for("type a message");
    std::thread::sleep(Duration::from_millis(300));
    p.keys(b"reply typed and sent\r");
    let sid = only_session(&fake);
    p.wait_reply("typed and sent");
    assert!(fake.wait_idle(&sid, T));
    p.keys(b"\x04");
    assert_eq!(p.wait_exit(), 0);
    let turns = telemetry(&fake, "cli.turn");
    assert_eq!(turns.len(), 1, "{turns:?}");
    let t = &turns[0];
    assert_eq!(t["sessionId"], sid.as_str());
    assert_eq!(t["turnId"], fake.turns(&sid)[0]["id"]);
    let d = &t["data"];
    assert!(d["first_output_ms"].as_u64().zip(d["first_output_received_ms"].as_u64()).is_some_and(|(o, r)| o >= r), "{t}");
    assert!(d["first_output_received_ms"].as_u64().zip(d["first_event_ms"].as_u64()).is_some_and(|(o, e)| o >= e), "{t}");
    assert_eq!(d["interrupted"], false);
    assert!(!telemetry(&fake, "cli.attach").is_empty());
    let conns = telemetry(&fake, "cli.connection");
    assert_eq!(conns.len(), 1, "{conns:?}");
    assert_eq!(conns[0]["data"]["close_code"], 1000);
    assert!(conns[0]["data"]["frames"].as_u64().unwrap() > 0);
}

#[test]
fn telemetry_measures_an_answer_and_an_interrupt() {
    let fake = Fake::start();
    let mut p = Pty::spawn(&fake, &["approve"]);
    let sid = only_session(&fake);
    fake.wait_ask(&sid, T).expect("an ask");
    p.wait_for("rm -rf build");
    std::thread::sleep(Duration::from_millis(900));
    p.keys(b"y");
    assert!(fake.wait_idle(&sid, T));
    p.keys(b"\x04");
    assert_eq!(p.wait_exit(), 0);
    let c = telemetry(&fake, "cli.control");
    assert_eq!(c.len(), 1, "{c:?}");
    assert_eq!(c[0]["data"]["kind"], "answer");
    assert_eq!(c[0]["data"]["ok"], true);
    assert!(c[0]["data"]["round_trip_ms"].is_u64() && c[0]["data"]["applied_ms"].is_u64(), "{}", c[0]);

    let fake = Fake::start();
    let mut p = Pty::spawn(&fake, &["slow 20000"]);
    let sid = only_session(&fake);
    assert!(fake.wait_for(T, {
        let sid = sid.clone();
        move |w| w.sess(&sid).is_ok_and(|s| s.active().is_some())
    }));
    std::thread::sleep(Duration::from_millis(300));
    p.keys(b"\x1b");
    assert!(fake.wait_idle(&sid, T));
    p.wait_for("interrupted");
    p.keys(b"\x04");
    assert_eq!(p.wait_exit(), 0);
    let c = telemetry(&fake, "cli.control");
    assert_eq!(c.len(), 1, "{c:?}");
    assert_eq!(c[0]["data"]["kind"], "interrupt");
    assert_eq!(c[0]["data"]["ok"], true);
    assert!(c[0]["data"]["applied_ms"].is_u64(), "{}", c[0]);
}

/// Not a check: writes what the screen looks like, raw, to `$OPC_SCREEN_OUT`
/// (render it with any terminal emulator) for design review.
/// `OPC_SCREEN_OUT=/tmp/s.ansi cargo test --test tui screen_dump -- --ignored`
#[test]
#[ignore]
fn screen_dump() {
    let Ok(out) = std::env::var("OPC_SCREEN_OUT") else {
        return;
    };
    let fake = Fake::start();
    let sid = fake.seed_session(
        Seed::new("fix the flaky test in segment.test.ts")
            .mode("bypassPermissions")
            .model("claude-opus-5-5", "high"),
    );
    let mut p = Pty::spawn_with(&fake, &["a", &sid], &["NO_COLOR"]);
    p.wait_for("type a message");
    std::thread::sleep(Duration::from_millis(300));
    p.keys(b"tool\r");
    p.wait_reply("tool done");
    std::thread::sleep(Duration::from_millis(200));
    p.keys(b"reply The test is **flaky** because `segment.test.ts` races the timer. I made it use fake timers and it passed 50 runs.\r");
    p.wait_reply("passed 50 runs");
    assert!(fake.wait_idle(&sid, T));
    std::thread::sleep(Duration::from_millis(500));
    std::fs::write(out, &*p.out.lock().unwrap()).unwrap();
}
