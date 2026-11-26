//! Ids: minting session ids on the client, recognising the kinds, and
//! idempotency keys.
//!
//! Every id is a prefix and lowercase Crockford base32 (`0-9a-hjkmnp-tv-z`):
//! `cs_` + 16 for sessions, `tn_`/`ak_`/`wc_`/`tm_` + 12, `ev_` + 16.

pub const ALPHABET: &[u8; 32] = b"0123456789abcdefghjkmnpqrstvwxyz";

/// Random bytes from the OS. Panics only if the OS has no randomness, in which
/// case nothing else would work either.
pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut buf = [0u8; N];
    getrandom::fill(&mut buf).expect("the OS random number generator failed");
    buf
}

/// `n` characters of Crockford base32 from the OS RNG (5 bits each, no bias).
pub fn random_base32(n: usize) -> String {
    let bytes = random_bytes::<20>(); // 160 bits: enough for 32 characters
    let mut out = String::with_capacity(n);
    let mut acc: u32 = 0;
    let mut bits = 0;
    let mut it = bytes.iter();
    while out.len() < n {
        if bits < 5 {
            match it.next() {
                Some(b) => {
                    acc = (acc << 8) | u32::from(*b);
                    bits += 8;
                }
                None => {
                    // More than 32 characters asked: continue with fresh bytes.
                    out.push_str(&random_base32(n - out.len()));
                    break;
                }
            }
        }
        bits -= 5;
        out.push(ALPHABET[((acc >> bits) & 31) as usize] as char);
    }
    out
}

/// The session id for a create with the person's idempotency key: the same
/// key from the same credential always names the same session, so a repeat
/// sends the same body and gets `duplicate: true` instead of a conflict.
pub fn session_id_for_key(api_key: &str, key: &str) -> String {
    let mut ctx = ring::digest::Context::new(&ring::digest::SHA256);
    ctx.update(b"opc session id v1\0");
    ctx.update(api_key.as_bytes());
    ctx.update(b"\0");
    ctx.update(key.as_bytes());
    let d = ctx.finish();
    let mut out = String::from("cs_");
    let (mut acc, mut bits) = (0u32, 0);
    for b in d.as_ref() {
        acc = (acc << 8) | u32::from(*b);
        bits += 8;
        while bits >= 5 && out.len() < 19 {
            bits -= 5;
            out.push(ALPHABET[((acc >> bits) & 31) as usize] as char);
        }
        acc &= (1 << bits) - 1;
        if out.len() == 19 {
            break;
        }
    }
    out
}

/// A new session id, minted on the client so the attach can be dialled at the
/// same moment as the create.
pub fn mint_session_id() -> String {
    format!("cs_{}", random_base32(16))
}

/// A random idempotency key for a request the user gave no key for.
pub fn idempotency_key() -> String {
    format!("opc-{}", random_base32(26))
}

pub fn is_base32(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| ALPHABET.contains(&b))
}

fn is_id(s: &str, prefix: &str, len: usize) -> bool {
    s.len() == prefix.len() + len && s.starts_with(prefix) && is_base32(&s[prefix.len()..])
}

pub fn is_session_id(s: &str) -> bool {
    is_id(s, "cs_", 16)
}

pub fn is_turn_id(s: &str) -> bool {
    is_id(s, "tn_", 12)
}

pub fn is_ask_id(s: &str) -> bool {
    is_id(s, "ak_", 12)
}

/// A subagent id (`sa_…`); the length is not checked, the spec does not
/// fix it.
pub fn looks_like_subagent(s: &str) -> bool {
    s.starts_with("sa_") && s.len() > 3
}

/// Lenient forms used when an argument names a turn: tolerate any length so a
/// test server with other id lengths still works.
pub fn looks_like_turn(s: &str) -> bool {
    s.starts_with("tn_") && s.len() > 3
}

/// A word that can be a session prefix: four or more base32 characters,
/// optionally with `cs_`.
pub fn session_prefix(s: &str) -> Option<&str> {
    let body = s.strip_prefix("cs_").unwrap_or(s);
    (body.len() >= 4 && body.len() <= 16 && is_base32(body)).then_some(body)
}

/// A Slack thread link: `https://<team>.slack.com/archives/<channel>/p<ts>`.
/// Returns the channel id and the thread ts (`1700000000.000100`).
pub fn parse_slack_link(s: &str) -> Option<(String, String)> {
    let rest = s.strip_prefix("https://").or_else(|| s.strip_prefix("http://"))?;
    let (host, path) = rest.split_once('/')?;
    if !host.ends_with("slack.com") {
        return None;
    }
    let path = path.split(['?', '#']).next()?;
    let mut parts = path.split('/');
    if parts.next()? != "archives" {
        return None;
    }
    let channel = parts.next()?.to_string();
    let p = parts.next()?.strip_prefix('p')?;
    if p.len() < 7 || !p.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let (secs, micros) = p.split_at(p.len() - 6);
    // A reply link names its thread in `thread_ts`; prefer it.
    let thread_ts = s
        .split_once("thread_ts=")
        .map(|(_, t)| t.split('&').next().unwrap_or(t).to_string());
    Some((channel, thread_ts.unwrap_or_else(|| format!("{secs}.{micros}"))))
}

/// The first `n` characters after the prefix, for display: `7f3a`.
pub fn short(id: &str) -> &str {
    let body = id.split_once('_').map_or(id, |(_, b)| b);
    &body[..body.len().min(4)]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn minted_ids_are_valid_and_distinct() {
        let a = mint_session_id();
        let b = mint_session_id();
        assert!(is_session_id(&a), "{a}");
        assert_ne!(a, b);
        assert_eq!(random_base32(40).len(), 40);
    }

    #[test]
    fn kinds() {
        assert!(is_session_id("cs_7f3a9k2m4q8r1t6v"));
        assert!(!is_session_id("cs_7f3a9k2m4q8r1t6u")); // u is not Crockford
        assert!(is_turn_id("tn_4m8q2x7c1v9b"));
        assert!(is_ask_id("ak_9b4m8q2x7c1v"));
        assert_eq!(session_prefix("7f3a"), Some("7f3a"));
        assert_eq!(session_prefix("cs_7f3a"), Some("7f3a"));
        assert_eq!(session_prefix("7f3"), None);
        assert_eq!(session_prefix("push"), None); // u
        assert_eq!(session_prefix("fix"), None);
    }

    #[test]
    fn slack_links() {
        let (c, ts) = parse_slack_link("https://acme.slack.com/archives/C06ABC/p1700000000000100").unwrap();
        assert_eq!(c, "C06ABC");
        assert_eq!(ts, "1700000000.000100");
        let (_, ts) =
            parse_slack_link("https://acme.slack.com/archives/C06ABC/p1700000001000200?thread_ts=1700000000.000100&cid=C06ABC")
                .unwrap();
        assert_eq!(ts, "1700000000.000100");
        assert!(parse_slack_link("https://example.com/archives/C/p1").is_none());
    }
}

#[cfg(test)]
mod key_tests {
    #[test]
    fn derived_ids_are_stable_and_distinct() {
        let a = super::session_id_for_key("k1", "job-1");
        assert_eq!(a.len(), 19);
        assert!(a.starts_with("cs_") && super::is_base32(&a[3..]));
        assert_eq!(a, super::session_id_for_key("k1", "job-1"));
        assert_ne!(a, super::session_id_for_key("k2", "job-1"));
        assert_ne!(a, super::session_id_for_key("k1", "job-2"));
    }
}
