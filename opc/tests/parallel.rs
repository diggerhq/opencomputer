//! Many opc processes at once against loaded fake servers: the connection's
//! `ready` can arrive before the dial is reported, and must not be lost.

mod support;
use std::time::Duration;
use support::Fake;

#[test]
fn parallel_runs_never_hang() {
    let hs: Vec<_> = (0..64).map(|_| std::thread::spawn(|| {
        let fake = Fake::start();
        let mut c = fake.opc();
        c.env("OPC_LOG", "debug").args(["-p", "--output-format", "json", "reply hi"]).timeout(Duration::from_secs(6));
        let o = c.output().unwrap();
        if o.status.code() != Some(0) {
            let mut s = format!("STDERR:\n{}\n", String::from_utf8_lossy(&o.stderr));
            for f in fake.ws_frames() { let t = f.text.clone().unwrap_or_default(); s += &format!("WS {:?} {}\n", f.dir, &t[..t.len().min(250)]); }
            for r in fake.requests() { s += &format!("HTTP {:?}\n", r); }
            return Some(s);
        }
        None
    })).collect();
    let fails: Vec<String> = hs.into_iter().filter_map(|h| h.join().unwrap()).collect();
    for f in fails.iter().take(2) { eprintln!("{f}\n=========="); }
    assert!(fails.is_empty(), "{} hung", fails.len());
}
