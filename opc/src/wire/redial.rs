//! Dialing a socket again: the one backoff policy and the one dial that both
//! sockets of a command use, the wire (`reconnect.rs`) and the live socket
//! (`live.rs`).
//!
//! A failed dial or a dropped socket waits on the backoff: none the first
//! time, then 250 ms doubling to 8 s with ±20 % jitter. A server's wait
//! (`Retry-After`, `retryAfterMs`) is honoured when longer, up to 30 s. A
//! socket that stayed up a minute starts the backoff over.

use super::client::{self, Frame};
use crate::error::{Error, Result};
use std::time::{Duration, Instant};
use tokio::sync::mpsc;

/// How long a dial may take before it counts as failed.
pub const DIAL_TIMEOUT: Duration = Duration::from_secs(10);
/// A socket up this long resets the backoff.
pub const STABLE: Duration = Duration::from_secs(60);
/// A server's wait is honoured up to this.
pub const HINT_MAX: Duration = Duration::from_secs(30);
const BACKOFF_START: Duration = Duration::from_millis(250);
const BACKOFF_MAX: Duration = Duration::from_secs(8);

/// When a socket is dialed next, and how many tries since it last held.
#[derive(Debug, Default)]
pub struct Redial {
    pub attempt: u32,
    /// The next dial (`None`: none is scheduled).
    pub at: Option<Instant>,
}

impl Redial {
    /// After a failure: on the backoff, or the server's wait when longer.
    pub fn back_off(&mut self, hint_ms: Option<u64>) -> Duration {
        self.after(hinted(backoff(self.attempt), hint_ms))
    }

    /// After a close that is no failure of ours (going away, restarting, a
    /// dead socket): at once the first time, within 250 ms when `spread` (a
    /// restarting server's clients must not all come back in the same
    /// instant), then on the backoff, so a server that keeps closing is not
    /// hammered.
    pub fn soon(&mut self, spread: bool) -> Duration {
        self.after(soon_delay(self.attempt, spread, unit_random()))
    }

    /// In `delay`, counted as a try.
    pub fn after(&mut self, delay: Duration) -> Duration {
        self.attempt = self.attempt.saturating_add(1);
        self.at = Some(Instant::now() + delay);
        delay
    }

    /// A socket that was up `up_for` went away: one that held [`STABLE`]
    /// starts the backoff over. True when it did.
    pub fn ended(&mut self, up_for: Duration) -> bool {
        let held = up_for >= STABLE;
        if held {
            self.attempt = 0;
        }
        held
    }

    /// Whether the scheduled dial is due at `now`; a due one is taken.
    pub fn due(&mut self, now: Instant) -> bool {
        let due = self.at.is_some_and(|t| now >= t);
        if due {
            self.at = None;
        }
        due
    }
}

/// Dials in the background, for at most [`DIAL_TIMEOUT`] (then fails with
/// `timed_out`). Frames arrive on `frames` tagged with `generation`; the
/// outcome goes to `done`.
pub fn dial(
    url: String,
    key: String,
    protocol: &'static str,
    generation: u64,
    frames: mpsc::UnboundedSender<(u64, Frame)>,
    timed_out: &'static str,
    done: impl FnOnce(u64, Result<client::Dialed>) + Send + 'static,
) {
    tokio::spawn(async move {
        let r = match tokio::time::timeout(DIAL_TIMEOUT, client::dial(&url, &key, protocol, generation, frames)).await {
            Ok(r) => r,
            Err(_) => Err(Error::unreachable(timed_out)),
        };
        done(generation, r);
    });
}

/// The wait before try `attempt`: none for the first, then 250 ms doubling
/// to 8 s, with ±20 % jitter.
pub fn backoff(attempt: u32) -> Duration {
    backoff_with(attempt, unit_random())
}

/// [`backoff`] with its random draw `r` in `[0, 1]`.
fn backoff_with(attempt: u32, r: f64) -> Duration {
    if attempt == 0 {
        return Duration::ZERO;
    }
    let base = BACKOFF_START.saturating_mul(1u32 << (attempt - 1).min(6)).min(BACKOFF_MAX);
    base.mul_f64(0.8 + 0.4 * r)
}

fn unit_random() -> f64 {
    u16::from_le_bytes(crate::ids::random_bytes::<2>()) as f64 / u16::MAX as f64
}

/// [`Redial::soon`]'s wait: none the first time, or up to 250 ms when
/// `spread`; then the backoff. `r` is the random draw.
fn soon_delay(attempt: u32, spread: bool, r: f64) -> Duration {
    match attempt {
        0 if spread => BACKOFF_START.mul_f64(r),
        n => backoff_with(n, r),
    }
}

/// `delay`, or the server's wait when that is longer (up to [`HINT_MAX`]).
pub fn hinted(delay: Duration, hint_ms: Option<u64>) -> Duration {
    hint_ms.map_or(delay, |ms| delay.max(Duration::from_millis(ms).min(HINT_MAX)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_grows_and_caps() {
        assert_eq!(backoff(0), Duration::ZERO);
        let b1 = backoff(1);
        assert!(b1 >= Duration::from_millis(200) && b1 <= Duration::from_millis(300), "{b1:?}");
        for n in 6..20 {
            let b = backoff(n);
            assert!(b >= Duration::from_millis(6400) && b <= Duration::from_millis(9600), "{b:?}");
        }
    }

    #[test]
    fn redials_spread_then_back_off() {
        assert_eq!(soon_delay(0, false, 1.0), Duration::ZERO);
        assert_eq!(soon_delay(0, true, 0.0), Duration::ZERO);
        assert_eq!(soon_delay(0, true, 1.0), Duration::from_millis(250));
        assert_eq!(soon_delay(1, true, 0.5), Duration::from_millis(250));
        assert_eq!(soon_delay(3, false, 0.5), Duration::from_secs(1));
        assert_eq!(soon_delay(30, true, 1.0), Duration::from_millis(9600));
    }

    #[test]
    fn a_socket_that_held_starts_over() {
        let mut r = Redial::default();
        for _ in 0..5 {
            r.back_off(None);
        }
        assert!(!r.ended(Duration::from_secs(1)));
        assert_eq!(r.attempt, 5);
        assert!(r.ended(STABLE));
        assert_eq!(r.attempt, 0);
        assert_eq!(r.back_off(None), Duration::ZERO);
        assert!(r.due(Instant::now()) && r.at.is_none());
    }

    #[test]
    fn hints_are_honoured_and_capped() {
        assert_eq!(hinted(Duration::from_secs(1), None), Duration::from_secs(1));
        assert_eq!(hinted(Duration::from_secs(1), Some(5000)), Duration::from_secs(5));
        assert_eq!(hinted(Duration::from_secs(1), Some(10)), Duration::from_secs(1));
        assert_eq!(hinted(Duration::ZERO, Some(3_600_000)), HINT_MAX);
    }
}
