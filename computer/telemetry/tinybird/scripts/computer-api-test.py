"""Check for the work 084 computer API endpoints and dashboard (Q1 to Q10 and the
"do we need to optimize?" checks). Builds a fixture from the real runner facts
(fixtures/runner-facts.ndjson, the Slack turns as v3) plus the same turns again
as a v4 runner with every interval stretched 1.5x, plus one or a few of each
084 event with hand-picked values, then runs every endpoint and asserts values
computed here by hand. Then it runs the SQL of every panel and alert rule in
the rendered Grafana JSON (computer-api, speed, alerting/rules) against the
same data, so a panel that does not parse fails here, not in Grafana. Needs
chdb and tornado.

  python -I computer-api-test.py
"""
import datetime
import json
import pathlib
import re
import sys
import tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from turns_local import ROOT, endpoint, load  # noqa: E402

HERE = pathlib.Path(__file__).resolve().parent
TELEMETRY = ROOT.parent
failed = 0


def check(name, ok, got=None):
    global failed
    failed += not ok
    print("PASS" if ok else "FAIL", name, "" if ok else got)


def q(values, p):
    """ClickHouse `quantile` on a handful of values: linear between the closest ranks."""
    v = sorted(values)
    h = (len(v) - 1) * p
    lo = int(h)
    return v[lo] + (h - lo) * (v[min(lo + 1, len(v) - 1)] - v[lo])


FMT = "%Y-%m-%d %H:%M:%S.%f"


def parse(ts):
    return datetime.datetime.strptime(ts if "." in ts else ts + ".000", FMT)


def show(t):
    return t.strftime(FMT)[:-3]


# --- The fixture -------------------------------------------------------------

base = [json.loads(line) for line in (HERE / "fixtures" / "runner-facts.ndjson").read_text().splitlines()]
s0 = min(parse(t) for f in base for t in (f["occurred_at"], f.get("sent_at")) if t)


def stretch(ts):
    return show(s0 + (parse(ts) - s0) * 1.5)


def clone_id(v):
    return "c4" + v[2:] if v else v


# The same three Slack turns from a v4 runner, every interval 1.5x as long: K2 is
# exactly 1.5x. The third turn had an API client attached.
starts = sorted(f["occurred_at"] for f in base if f["event_name"] == "turn.started")
v4 = []
for f in base:
    g = {**f, "event_id": clone_id(f["event_id"]), "session_key": "k4", "occurred_at": stretch(f["occurred_at"])}
    for k in ("turn_id", "trace_id"):
        if f.get(k):
            g[k] = clone_id(f[k])
    if f.get("sent_at"):
        g["sent_at"] = stretch(f["sent_at"])
    if f["event_name"] == "turn.started":
        data = json.loads(f["data"])
        data.update(host_protocol=4, api=True, api_clients=1 if f["occurred_at"] == starts[-1] else 0)
        g["data"] = json.dumps(data)
    v4.append(g)
v4_turns = [clone_id(f["turn_id"]) for f in sorted(base, key=lambda f: f["occurred_at"]) if f["event_name"] == "turn.started"]

T0 = datetime.datetime(2026, 10, 14, 3, 0, 0)
seq = 0
events = []


def ev(name, at, data=None, **env):
    """One 084 event `at` seconds after T0, org o1, host h1."""
    global seq
    seq += 1
    events.append({
        "schema_version": 1, "event_id": f"e084-{seq:04d}", "event_name": name, "occurred_at": show(T0 + datetime.timedelta(seconds=at)),
        "service_name": env.pop("service", "host"), "service_version": "test", "region": "local", "synthetic": False,
        "org_id": "o1", "host_id": "h1", "session_key": "cs_1", **env, "data": json.dumps(data or {}),
    })


# Check 1: minute 03:00 has journal batches (two appends), 03:05 and 03:06 are quiet.
ev("sessionlog.append", 10, dict(epoch=1, events=10, turns=1, append_ms=150, do_ack_ms=80, do_chain_wait_ms=20, rows=10, bytes=1000, dupes=0,
                                 mismatches=0, spills_sync=1, spill_sync_bytes=500, spill_sync_ms=40, refolded=True, refold_ms=9,
                                 storage_bytes=4000, commit_lag_ms_max=300), service="gateway", surface="api", duration_ms=150)
ev("sessionlog.append", 20, dict(epoch=1, events=20, turns=1, append_ms=250, do_ack_ms=120, do_chain_wait_ms=0, rows=20, bytes=3000, dupes=1,
                                 mismatches=1, refused="", storage_bytes=5000, commit_lag_ms_max=500), service="gateway", surface="api", duration_ms=250)
ev("computer.write", 30, dict(method="steer", held=True, held_ms=700, replayed=False, timed_out=False, do_ms=30), service="gateway", surface="cli", duration_ms=900)
ev("dispatch.sent", 40, dict(attempt=1, wait_ms=150), service="gateway", duration_ms=150)
ev("ack.done", 41, dict(call_ms=100), service="gateway", duration_ms=300)
ev("computer.write", 300, dict(method="steer", held=False, replayed=True, timed_out=False, do_ms=50), service="gateway", surface="api", duration_ms=60)
ev("dispatch.sent", 310, dict(attempt=1, wait_ms=20), service="gateway", duration_ms=20)
ev("ack.done", 311, dict(call_ms=100), service="gateway", duration_ms=200)
ev("computer.write", 360, dict(method="interrupt", held=False, replayed=False, timed_out=True, do_ms=10), service="gateway", surface="api", duration_ms=30000, outcome="failed")
ev("sessionlog.spill", 400, dict(spills=2, spill_bytes=7000, spill_ms_max=55, failed=1), service="gateway")

# The journal of the v4 turns: per turn a flushed batch and an urgent one (turn end).
urgent_newest = [10, 40, 25]
for i, turn in enumerate(v4_turns):
    ev("mirror.batch", 600 + i * 10, dict(events=5, first_seq=1, last_seq=5, oldest_age_ms=120, newest_age_ms=30, resent=False, urgent=False), turn_id=turn, surface="slack")
    ev("mirror.batch", 601 + i * 10, dict(events=3, first_seq=6, last_seq=8, oldest_age_ms=60, newest_age_ms=urgent_newest[i], resent=False, urgent=True), turn_id=turn, surface="slack")
ev("mirror.batch", 700, dict(events=4, first_seq=9, last_seq=12, oldest_age_ms=500, newest_age_ms=400, resent=True, urgent=False), surface="api")
ev("mirror.ack", 602, dict(seq=8, batches=2, events=8, commit_ms=90, age_ms=150), surface="slack")
ev("mirror.ack", 612, dict(seq=8, batches=2, events=8, commit_ms=210, age_ms=250), surface="slack")

# Q3 and Q4: API reads and the edge.
ev("edge.request", 800, dict(route="sessions", method="GET", status=200, upstream="blue", auth="ok", via="api"), service="edge", surface="api", duration_ms=50)
ev("edge.request", 801, dict(route="messages", method="POST", status=503, upstream="blue", auth="ok", via="api"), service="edge", surface="api", duration_ms=30)
ev("edge.request", 802, dict(route="sessions", method="GET", status=429, upstream="edge", auth="ok", via="api", rate_limited=True, key_id="key_1"), service="edge", surface="api", duration_ms=2)
ev("httpapi.request", 803, dict(route="events", op="poll", method="GET", status=200, wait_ms=25000, events=0, empty=True), service="gateway", surface="api", duration_ms=25000)
ev("httpapi.request", 804, dict(route="events", op="poll", method="GET", status=200, wait_ms=3000, events=2, empty=False, oldest_age_ms=80, newest_age_ms=20),
   service="gateway", surface="api", duration_ms=3000)
ev("httpapi.request", 805, dict(route="messages", op="send", method="POST", status=200, do_ms=12, log_ms=5, replayed=True), service="gateway", surface="cli", duration_ms=40)
ev("computer.unavailable", 806, dict(wait_ms=4000), service="gateway")
ev("computer.unavailable", 807, dict(wait_ms=6000), service="gateway")

# Q5: the wire.
ev("wireworker.request", 900, dict(kind="upgrade", via="ticket", result="ok"), service="gateway", duration_ms=20)
ev("ticket.minted", 901, dict(result="minted", sessions=1, key_written=True), service="gateway", duration_ms=15)
ev("wire.connect", 902, {}, surface="cli")
ev("wire.refused", 903, dict(status=4029))
ev("wire.attach", 904, dict(connection_id="wc_1", attach_ms=12, via="url", resume=False, replay=True, deltas=True), surface="cli", outcome="completed")
ev("wire.flush", 905, dict(connection_id="wc_1", frames=10, bytes=2000, events=8, deltas=2, oldest_age_ms=70, wait_ms_max=900, queued_bytes=100, paused=True, duplicates=2),
   surface="cli")
ev("wire.detached", 906, dict(connection_id="wc_1", reason="epoch_changed"), surface="cli")
ev("wire.terminal", 907, dict(connection_id="wc_1", bytes_in=10, bytes_out=20, exited=True), surface="cli", duration_ms=5000)
ev("wire.files", 908, dict(op="put", bytes=1000), surface="cli", duration_ms=30, outcome="completed")
ev("wire.close", 909, dict(connection_id="wc_1", code=1000, attaches=1, frames_in=3, bytes_in=300, frames_out=50, bytes_out=9000), surface="cli", duration_ms=60000)
ev("wire.sample", 910, dict(connections=2, members=1, attached=1, terminals=1, queued_bytes_max=100))

# Q6: recovery.
ev("sessionlog.recovery", 1000, dict(kind="recover_alarm", reason="host_gone", sessions=1, events=5), service="gateway", duration_ms=30, outcome="completed")
ev("api.held", 1001, dict(asked=True), duration_ms=400)
ev("api.stale_epoch", 1002, dict(epoch=1, known=2))
ev("api.epoch_adopted", 1003, dict(epoch=2, start_seq=9, tail_events=4, torn=True, held_frames=3, retired_runner=False, attempt=1), duration_ms=250, outcome="completed")

# Q7: opc (the relay forwards with surface cli, the client facts in data).
opc = dict(client_version="0.1.0-rc.4", os="linux", arch="x86_64")
ev("cli.turn", 1100, dict(first_event_ms=640, first_output_received_ms=700, first_output_ms=812, **opc), surface="cli", turn_id="t-cli-1")
ev("cli.turn", 1101, dict(interrupted=True, **opc), surface="cli", turn_id="t-cli-2")
ev("cli.attach", 1102, dict(attach_ms=200, connect_ms=150, reconnect=True, gap_ms=1500, replayed_events=4, **opc), surface="cli")
ev("cli.control", 1103, dict(kind="steer", round_trip_ms=90, applied_ms=300, ok=True, **opc), surface="cli")
ev("cli.control", 1104, dict(kind="interrupt", round_trip_ms=5000, ok=False, **opc), surface="cli")
ev("cli.error", 1105, dict(close_code=1006, **{"class": "ws_closed"}, **opc), surface="cli")
ev("cli.render", 1106, dict(lag_ms=150, draw_ms=3, **opc), surface="cli")
ev("cli.connection", 1107, dict(up_ms=60000, frames=40, bytes=8000, close_code=1006, reconnect=False, **opc), surface="cli")
ev("cli.overflow", 1108, dict(dropped=7, **opc), surface="cli")

# Q8: API writes at the runner.
ev("api.write", 1200, dict(method="steered", delivery="live"), service="runner", surface="cli", duration_ms=120, outcome="completed")
ev("api.write", 1201, dict(method="interrupt", delivery="live"), service="runner", surface="api", duration_ms=2000, outcome="failed")

# Q9: a key synced, revoked, then refused at the edge and at the wire Worker.
ev("keys.synced", 1300, dict(key_id="key_1", trigger="sync", ok=True, kv_writes=2), service="gateway", duration_ms=40)
ev("keys.synced", 1301, dict(key_id="key_2", trigger="observe", ok=False, kv_writes=0), service="gateway", duration_ms=10)
ev("keys.revoked", 1302, dict(key_id="key_1", known=True, host_told=True), service="gateway", duration_ms=25)
ev("edge.request", 1303, dict(route="sessions", method="GET", status=401, upstream="edge", auth="invalid", via="api", key_id="key_1"), service="edge", surface="api", duration_ms=3)
ev("wireworker.request", 1305, dict(kind="upgrade", via="key", result="refused", reason="revoked", key_id="key_1"), service="gateway", duration_ms=4)

# Q10: gauges.
ev("api.sample", 1400, dict(host_protocol=4, open_journals=3, runner_writers=2, host_writers=1, journal_bytes=9000, held_frames=0))
ev("api.sample", 1460, dict(host_protocol=4, open_journals=5, runner_writers=4, host_writers=1, journal_bytes=12000, held_frames=2))
ev("host.sample", 1410, dict(busy_runners=2, load1=0.5))

with tempfile.NamedTemporaryFile("w", suffix=".ndjson", delete=False) as out:
    out.write("\n".join(json.dumps(f) for f in base + v4 + events))
s = load(out.name)
pathlib.Path(out.name).unlink()
P = {"since": "2026-10-13 00:00:00", "until": "2026-10-15 00:00:00"}


def rows(name, **params):
    return endpoint(s, name, {**P, **params})


def one(rs, **match):
    hit = [r for r in rs if all(r.get(k) == v for k, v in match.items())]
    return hit[0] if len(hit) == 1 else {"rows matching": len(hit), "match": match}


# --- Q1 ------------------------------------------------------------------------

sbp = rows("slack_by_protocol")
v3w, v4w, v4c = one(sbp, protocol="v3", path="warm"), one(sbp, protocol="v4", path="warm"), one(sbp, protocol="v4+client", path="warm")
check("Q1: v3, v4 and v4+client warm and new rows", {(r["protocol"], r["path"]) for r in sbp} == {("v3", "new"), ("v3", "warm"), ("v4", "new"), ("v4", "warm"), ("v4+client", "warm")}, sbp)
turns = {t["turn_id"]: t for t in (json.loads(x) for x in s.query("SELECT turn_id, first_visible_ms, overhead_ms, path FROM turns", "JSONEachRow").bytes().decode().splitlines())}
k2_v3 = sorted(t["first_visible_ms"] for i, t in turns.items() if not i.startswith("c4") and t["path"] == "warm")
k2_v4 = sorted(t["first_visible_ms"] for i, t in turns.items() if i.startswith("c4") and t["path"] == "warm")
check("Q1: the v4 copies' K2 is 1.5x the v3 turns'", all(abs(b - 1.5 * a) <= 2 for a, b in zip(k2_v3, k2_v4)), (k2_v3, k2_v4))
check("Q1: v3 warm K2 p95", v3w.get("k2_p95") == round(q(k2_v3, 0.95)), (v3w, k2_v3))
check("Q1: v4 journal per turn (2 batches, 8 events, urgent send age)", (v4w.get("journal_turns"), v4w.get("batches_per_turn_p95"), v4w.get("events_per_turn_p95"), v4w.get("urgent_send_age_p95")) == (1, 2, 8, 40), v4w)
check("Q1: v4+client journal urgent age", v4c.get("urgent_send_age_p95") == 25, v4c)
check("Q1: v3 has no journal, null rather than 0", v3w.get("journal_turns") == 0 and v3w.get("batches_per_turn_p95") is None, v3w)

# --- Decision checks ---------------------------------------------------------------

doc = json.loads((TELEMETRY / "thresholds.json").read_text())
decisions = {t["id"]: t for t in doc["computer_api"] if t["kind"] == "decision"}
pipe = (ROOT / "endpoints" / "optimize_checks.pipe").read_text()
defaults = {}
for m in re.finditer(r"\('(\w+)', \{\{ Float64\(t_(\w+), ([\d.]+)\) \}\}, \{\{ Int32\(n_(\w+), (\d+)\) \}\}\)", pipe):
    check(f"optimize_checks: {m[1]} params named after it", m[1] == m[2] == m[4], m.group(0))
    defaults[m[1]] = (float(m[3]), int(m[5]))
check("optimize_checks: defaults are thresholds.json's decision rows", defaults == {i: (float(t["threshold"]), t["min_n"]) for i, t in decisions.items()},
      (defaults, decisions))

oc = rows("optimize_checks")
check("optimize_checks: one row per decision", sorted(r["id"] for r in oc) == sorted(decisions), oc)
check("optimize_checks: below min_n nothing is called", all(r["verdict"] == "not enough data" for r in oc), oc)
low = {f"n_{i}": 1 for i in decisions}
oc = {r["id"]: r for r in rows("optimize_checks", **low)}
expect = {
    "do_batch_p95": (2, q([80, 120], 0.95), "optimize"),
    "do_write_p95": (3, q([30, 50, 10], 0.95), "ok"),
    # busy ms per org-minute: 03:00 = (80 - 20) + 120 + 30, 03:05 = 50, 03:06 = 10.
    "do_busy_ms_per_min_p95": (3, q([210, 50, 10], 0.95), "ok"),
    "dispatch_wait_busy_delta_p95": (1, 150 - 20, "optimize"),
    "k1_busy_delta_p95": (1, 300 - 200, "ok"),
    "sessionlog_append_p95": (2, q([150, 250], 0.95), "optimize"),
    "commit_p95": (2, q([90, 210], 0.95), "optimize"),
    "slack_k2_v4_ratio": (2, q(k2_v4, 0.95) / q(k2_v3, 0.95), "optimize"),
    "journal_hop_p95": (3, q(urgent_newest, 0.95), "ok"),
}
for i, (n, value, verdict) in expect.items():
    r = oc.get(i, {})
    check(f"optimize_checks: {i} = {round(value, 2)} -> {verdict}", r.get("n") == n and abs((r.get("value") or -1) - value) < 0.02 and r.get("verdict") == verdict, r)
check("optimize_checks: the K2 ratio is about 1.5", abs(oc["slack_k2_v4_ratio"]["value"] - 1.5) < 0.02, oc["slack_k2_v4_ratio"])
check("optimize_checks: a threshold can be overridden", one(rows("optimize_checks", t_do_write_p95=40, **low), id="do_write_p95").get("verdict") == "optimize")

# --- Q2 to Q10 ---------------------------------------------------------------------

slc = one(rows("session_log_cost"), dimension="o1")
check("Q2: journal batches and events of org o1", (slc.get("journal_batches"), slc.get("journal_events")) == (7, 28), slc)
check("Q2: append latency, rows, bytes, dupes", (slc.get("appends"), slc.get("append_p50"), slc.get("append_max"), slc.get("rows"), slc.get("bytes"), slc.get("dupes")) == (2, 200, 250, 30, 4000, 1), slc)
check("Q2: spills in the append and after it", (slc.get("spills"), slc.get("spill_bytes"), slc.get("spill_ms_max"), slc.get("spills_failed")) == (3, 7500, 55, 1), slc)
check("Q2: refolds and storage", (slc.get("refolds"), slc.get("refold_ms_max"), slc.get("storage_bytes_max")) == (1, 9, 5000), slc)
check("Q2: by session", one(rows("session_log_cost", by="session_key"), dimension="cs_1").get("appends") == 2)
try:
    rows("session_log_cost", by="person_id")
    check("Q2: `by` is a closed list", False)
except (ValueError, SystemExit):
    check("Q2: `by` is a closed list", True)

fr = rows("freshness")
check("Q3: host sent (slack): 3 turns x 2 batches, oldest 120", (one(fr, hop="1 host sent", surface="slack").get("n"), one(fr, hop="1 host sent", surface="slack").get("max")) == (6, 120), fr)
check("Q3: DO committed", (one(fr, hop="2 DO committed").get("n"), one(fr, hop="2 DO committed").get("max")) == (2, 250), fr)
check("Q3: blue commit lag", one(fr, hop="2b blue commit lag").get("max") == 500, fr)
check("Q3: API reader only when the read returned events", (one(fr, hop="3 API reader").get("n"), one(fr, hop="3 API reader").get("max")) == (1, 80), fr)
check("Q3: wire socket", one(fr, hop="4 wire socket").get("max") == 70, fr)
check("Q3: opc drew it 112 ms after receiving it", one(fr, hop="5 opc drawn").get("max") == 112, fr)
check("Q3: per turn", one(rows("freshness", per_turn=1), hop="1 host sent", turn_id=v4_turns[1]).get("max") == 120)

ha = rows("http_api")
check("Q4: long polls, empty ones and hold", (lambda r: (r.get("long_polls"), r.get("long_polls_empty"), r.get("long_poll_hold_p95")))(one(ha, layer="blue", route="events")) == (2, 1, round(q([3000, 25000], 0.95))), ha)
check("Q4: replays and DO time", (lambda r: (r.get("replayed"), r.get("do_p95")))(one(ha, layer="blue", route="messages")) == (1, 12), ha)
check("Q4: 503 at the edge", one(ha, layer="edge", route="messages", status_class="5xx").get("unavailable_503") == 1, ha)
check("Q4: rate limited", one(ha, layer="edge", route="sessions", status_class="4xx", auth="ok").get("rate_limited") == 1, ha)
check("Q4: outages and time until the host came", (lambda r: (r.get("n"), r.get("p50")))(one(ha, layer="outage")) == (2, 5000), ha)
check("Q4: auth failures by class", one(ha, layer="edge", auth="invalid").get("n") == 1, ha)
check("Q4: by key", one(rows("http_api", by_key=1), layer="edge", key_id="key_1", status_class="4xx", auth="ok").get("rate_limited") == 1)

wi = rows("wire")
check("Q5: refusals by status", one(wi, event="wire.refused", dim="4029").get("n") == 1, wi)
check("Q5: close code, lifetime and the connection's bytes", (lambda r: (r.get("max"), r.get("bytes_in"), r.get("bytes_out")))(one(wi, event="wire.close", dim="1000")) == (60000, 300, 9000), wi)
check("Q5: backpressure: flush wait and queued bytes", (lambda r: (r.get("max"), r.get("bytes_out"), r.get("queued_bytes_max")))(one(wi, event="wire.flush", dim="paused")) == (900, 2000, 100), wi)
check("Q5: relay attach time", one(wi, event="wire.attach", dim="url completed").get("max") == 12, wi)
check("Q5: opc attach time and reconnect gap", (one(wi, event="cli.attach", dim="reconnect").get("max"), one(wi, event="cli.reconnect gap").get("max")) == (200, 1500), wi)
check("Q5: ticket mint latency", one(wi, event="ticket.minted", dim="minted").get("max") == 15, wi)
check("Q5: pushes count as bytes in", one(wi, event="wire.files", dim="put completed").get("bytes_in") == 1000, wi)
check("Q5: gauges", one(wi, event="wire.sample", dim="connections").get("max") == 2, wi)
check("Q5: worker refusals by reason", one(wi, event="wireworker.request", dim="refused revoked").get("n") == 1, wi)

rc = rows("recovery")
check("Q6: recover alarms and why", (lambda r: (r.get("n"), r.get("extra")))(one(rc, kind="blue recover_alarm", detail="host_gone")) == (1, 6), rc)
check("Q6: held writes and their wait", one(rc, kind="blue held write").get("max") == 700, rc)
check("Q6: write answered from the idempotency record", one(rc, kind="blue write replayed").get("n") == 1, rc)
check("Q6: held-write timeouts", one(rc, kind="blue write timed out", detail="timed out").get("n") == 1, rc)
check("Q6: duplicates detected", one(rc, kind="blue append dupes/mismatches").get("extra") == 2, rc)
check("Q6: torn journal adoption", (lambda r: (r.get("max"), r.get("extra")))(one(rc, kind="host epoch adopted", detail="completed torn")) == (250, 3), rc)
check("Q6: frames held", one(rc, kind="host held frame", detail="asked for epoch").get("max") == 400, rc)
check("Q6: stale epoch, resend, relay duplicates and detach", all(one(rc, kind=k).get("n") == 1 for k in ("host stale epoch drop", "host batch resent", "relay duplicates dropped", "relay detached on epoch change")), rc)

cx = rows("cli_experience")
check("Q7: Enter to first drawn output", one(cx, metric="first_output_ms", detail="").get("p50") == 812, cx)
check("Q7: interrupted before output counted, no value", (lambda r: (r.get("n"), r.get("max")))(one(cx, metric="first_output_ms", detail="interrupted")) == (1, None), cx)
check("Q7: steer applied", one(cx, metric="control_applied_ms", detail="steer").get("max") == 300, cx)
check("Q7: failed interrupt", one(cx, metric="control_round_trip_ms", detail="interrupt").get("failed") == 1, cx)
check("Q7: errors by class", one(cx, metric="error", detail="ws_closed").get("n") == 1, cx)
check("Q7: render lag, overflow, connection", (one(cx, metric="render_lag_ms").get("max"), one(cx, metric="overflow_dropped").get("max"), one(cx, metric="connection_up_ms", detail="1006").get("max")) == (150, 7, 60000), cx)
check("Q7: by version and OS", all(r["client_version"] == "0.1.0-rc.4" and r["os"] == "linux" for r in cx), cx)
check("Q7: filter by version", rows("cli_experience", client_version="0.0.9") == [])

il = rows("interactive_latency")
check("Q8: steer through opc at the runner", one(il, layer="runner", surface="cli", method="steered").get("p50") == 120, il)
check("Q8: failed interrupt at the runner", one(il, layer="runner", surface="api", method="interrupt").get("failed") == 1, il)
check("Q8: opc's own view", one(il, layer="opc", method="steer").get("max") == 300, il)
check("Q8: blue's held write latency", one(il, layer="blue", surface="cli", method="steer").get("max") == 900, il)

ky = rows("keys")
check("Q9: syncs and their failures", (one(ky, what="synced sync").get("n"), one(ky, what="synced observe").get("failed")) == (1, 1), ky)
check("Q9: revoke reached the host", one(ky, what="revoked").get("host_told") == 1, ky)
check("Q9: refused after revoke, and how long after", (lambda r: (r.get("n"), r.get("failed"), r.get("max")))(one(ky, what="refused after revoke (edge)")) == (1, 1, 1000), ky)
check("Q9: the wire refused it too", one(ky, what="refused after revoke (wire)").get("max") == 3000, ky)

cl = rows("computer_load")
check("Q10: peak gauges per host and bucket", (lambda r: (r.get("open_journals"), r.get("journal_bytes"), r.get("held_frames"), r.get("busy_runners")))(one(cl, host_id="h1", time="2026-10-14 03:20:00")) == (5, 12000, 2, 2), cl)

# --- Grafana: every panel and rule runs ------------------------------------------------

NOW = "toDateTime64('2026-10-15 00:00:00', 3)"


def grafana(sql):
    sql = re.sub(r"\$__timeFilter\(([\w.]+)\)", r"\1 >= toDateTime64('2026-10-13 00:00:00', 3) AND \1 < toDateTime64('2026-10-15 00:00:00', 3)", sql)
    sql = re.sub(r"\$__timeInterval\(([\w.]+)\)", r"toStartOfMinute(\1)", sql)
    sql = re.sub(r"\$__(fromTime|toTime)", lambda m: "toDateTime64('2026-10-13 00:00:00', 3)" if m[1] == "fromTime" else NOW, sql)
    sql = re.sub(r"\$\{?(\w+)(:\w+)?\}?", lambda m: "'All'", sql)
    return re.sub(r"\bnow(64)?\(\)", NOW, sql)


def panels(dash):
    for p in dash["panels"]:
        yield from (p.get("panels") or [])
        yield p


targets = []
for name in ("computer-api", "speed"):
    dash = json.loads((TELEMETRY / "grafana" / "dashboards" / f"{name}.json").read_text())
    for p in panels(dash):
        for t in p.get("targets", []):
            targets.append((f"{name}: {p['title']}", t.get("rawSql") or t.get("sql") or ""))
rules = json.loads((TELEMETRY / "grafana" / "alerting" / "rules.json").read_text())
for g in rules["groups"]:
    for r in g["rules"]:
        for d in r["data"]:
            sql = d.get("model", {}).get("rawSql")
            if sql:
                targets.append((f"rule {r['uid']}", sql))
broken = []
for title, sql in targets:
    try:
        s.query(grafana(sql))
    except Exception as e:
        broken.append((title, str(e).split(" In scope")[0][:300]))
check(f"Grafana: all {len(targets)} panel and rule queries run", not broken, "\n  " + "\n  ".join(f"{t}: {e}" for t, e in broken))
api = json.loads((TELEMETRY / "grafana" / "dashboards" / "computer-api.json").read_text())


def panel_rows(prefix):
    p = next(p for p in api["panels"] if p["title"].startswith(prefix))
    out = s.query(grafana(p["targets"][0]["rawSql"]), "JSONEachRow").bytes().decode()
    return [json.loads(line) for line in out.splitlines()]


one_rows = panel_rows("1 ·")
check("panel 1: DO time per batch p95 at 03:00", abs(one(one_rows, metric="DO time per journal batch p95").get("value", 0) - q([80, 120], 0.95)) < 0.01, one_rows)
check("panel 1: dispatch wait busy − quiet in the hour", one(one_rows, metric="Slack dispatch wait p95: busy − quiet (hourly)").get("value") == 130, one_rows)
check("panel 1: K1 busy − quiet in the hour", one(one_rows, metric="K1 p95: busy − quiet (hourly)").get("value") == 100, one_rows)
four = panel_rows("4 ·")
check("panel 4: urgent batches' newest age p95", abs(one(four, metric="urgent batches: newest event age at send p95").get("value", 0) - q(urgent_newest, 0.95)) < 0.01, four)
three = panel_rows("3 ·")
check("panel 3: no ratio below 30 turns a side", all(r["K2 v4 ÷ v3"] is None for r in three), three)
busy = panel_rows("DO busy ms")
check("DO busy ms per org-minute", sorted(r["max"] for r in busy) == [10, 50, 210], busy)
top = api["panels"][0]
check("computer-api: the top row is 'Do we need to optimize?'", top.get("type") == "row" and top.get("title") == "Do we need to optimize?", top.get("title"))
first = [p for p in api["panels"][1:] if p.get("type") != "row"][:4]
check("computer-api: four decision panels, each with a threshold and its reasoning",
      len(first) == 4 and all(p.get("description") and p["fieldConfig"]["defaults"].get("thresholds", {}).get("steps", [{}])[-1].get("value") is not None for p in first),
      [p.get("title") for p in first])
ids = {r["uid"] for g in rules["groups"] for r in g["rules"]}
check("rules: every computer_api alert row has a rule", all(f"calvin-api-{t['id'].replace('_', '-')}" in ids for t in doc["computer_api"] if t["kind"] == "alert"),
      sorted(i for i in ids if i.startswith("calvin-api")))

print(f"{failed} FAILED" if failed else "all passed")
sys.exit(1 if failed else 0)
