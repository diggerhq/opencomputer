"""Writes the Tinybird fixtures (work 054, "Tinybird project"): a `new` and a
`warm` trace in one thread, a duplicated event_id and turn_id, a silent turn,
a steer, an abandoned turn and a synthetic canary turn. Dated 2030 so the
tables' TTLs never expire them.

    python3 telemetry/scripts/tinybird-fixtures.py
"""
import json
import os
from datetime import datetime, timedelta, timezone

T0 = datetime(2030, 1, 1, 10, 0, 0, tzinfo=timezone.utc)
S1, S2, S3 = "T1:C1:1893492000.000100", "T1:C1:1893492300.000200", "T1:C2:1893492600.000300"
COMMON = dict(org_id="org_1", surface="slack", surface_workspace_id="T1", conversation_id="C1", person_id="U1",
              harness="claude-agent-sdk", provider="anthropic", model="claude-opus-5-5", tier="default",
              substrate="vm", region="westus2")
seq = 0

def ts(t): return t.strftime("%Y-%m-%d %H:%M:%S.") + f"{t.microsecond // 1000:03d}"

def uid(kind, n): return f"0193{kind:04x}-0000-7000-8000-{n:012x}"

events, turns = [], []

def ev(trace, sent, session, name, service, at_ms, dur=None, data=None, **kw):
    global seq
    seq += 1
    e = dict(schema_version=1, event_id=uid(1, seq), event_name=name, occurred_at=ts(sent + timedelta(milliseconds=at_ms)),
             service_name=service, service_version="1.0.0", region="westus2", synthetic=False,
             trace_id=trace, session_key=session, sent_at=ts(sent), data=json.dumps(data or {}), **COMMON_EV, **kw)
    if dur is not None: e["duration_ms"] = dur
    events.append(e)
    return e

COMMON_EV = {k: v for k, v in COMMON.items() if k != "region"}

def turn(n, trace, sent, session, path, outcome="completed", synthetic=False, **cols):
    row = dict(schema_version=1, turn_id=uid(2, n), trace_id=trace, session_key=session, turn_seq=n, sent_at=ts(sent),
               gateway_version="g1", host_version="h1", runner_version="r1", path=path, synthetic=synthetic,
               outcome=outcome, host_id="host-a", **COMMON, **cols)
    turns.append(row)
    return row

# Trace N: a new thread, cold path.
N, tN = uid(3, 1), T0
for args in [("message.received", "gateway", 300, 300, {"kind": "mention"}), ("ack.done", "gateway", 700, 700, {"indicator": "status"}),
             ("dispatch.sent", "gateway", 350, 50), ("deliver.received", "host", 400, 50),
             ("fork.repo", "host", 1900, 1400, {"repo": "3f9a1c0b2d4e", "fetch_ms": 900}), ("runner.ready", "host", 2600, 650),
             ("deliver.forwarded", "host", 2650, 2250), ("harness.started", "runner", 3300, 600, {"resume": False, "mcp_servers": 2}),
             ("model.requested", "runner", 3300, None, {"request_seq": 1}), ("model.first_token", "runner", 4800, 1500, {"request_seq": 1}),
             ("output.renderable", "runner", 5000, 5000, {"kind": "text"}), ("output.first_visible", "runner", 5200, 5200, {"mode": "native"}),
             ("turn.ended", "runner", 9000, 9000)]:
    ev(N, tN, S1, *args, **({} if args[1] == "gateway" else {"path": "new"}))
turn(1, N, tN, S1, "new", received_ms=300, dispatched_ms=350, host_received_ms=400, runner_ready_ms=2600, harness_ready_ms=3300,
     model_requested_ms=3300, first_token_ms=4800, renderable_ms=5000, first_visible_ms=5200, ended_ms=9000, fork_ms=1400,
     launch_ms=650, harness_init_ms=600, ttft_ms=1500, overhead_ms=3500, max_silence_ms=2000, model_calls=1, input_tokens=1000,
     output_tokens=200, cache_read_tokens=3000, cost_usd=0.02)

# Trace W: a warm reply in the same thread; one event and the turn row delivered twice.
W, tW = uid(3, 2), T0 + timedelta(minutes=5)
ev(W, tW, S1, "message.received", "gateway", 200, 200)
ev(W, tW, S1, "ack.done", "gateway", 400, 400, {"indicator": "status"})
dup = ev(W, tW, S1, "model.requested", "runner", 300, None, {"request_seq": 1}, path="warm")
events.append(dict(dup))
ev(W, tW, S1, "model.first_token", "runner", 1500, 1200, {"request_seq": 1}, path="warm")
ev(W, tW, S1, "output.first_visible", "runner", 2100, 2100, {"mode": "native"}, path="warm")
ev(W, tW, S1, "turn.ended", "runner", 4000, 4000, path="warm")
w = turn(2, W, tW, S1, "warm", received_ms=200, model_requested_ms=300, first_token_ms=1500, renderable_ms=1700, first_visible_ms=2100,
         ended_ms=4000, ttft_ms=1200, overhead_ms=300, max_silence_ms=3000, model_calls=1, input_tokens=500, output_tokens=100,
         cache_read_tokens=4500, cost_usd=0.01)
turns.append(dict(w))

# Trace St: a warm turn with a steer from a second message.
St, tSt = uid(3, 3), T0 + timedelta(minutes=10)
ev(St, tSt, S1, "ack.done", "gateway", 600, 600, {"indicator": "status"})
ev(St, tSt, S1, "steer.delivered", "runner", 8000, 250, {"steer_trace_id": uid(3, 9), "boundary_wait_ms": 1000}, path="warm")
turn(3, St, tSt, S1, "warm", received_ms=250, model_requested_ms=350, first_token_ms=1350, renderable_ms=2900, first_visible_ms=3000,
     ended_ms=12000, ttft_ms=1000, overhead_ms=450, max_silence_ms=5000, model_calls=3, tool_calls=2, steers=1, input_tokens=800,
     output_tokens=300, cache_read_tokens=7200, cost_usd=0.03)

# Trace Si: a silent warm turn: a thinking card shown and then removed, so first_visible_ms is set but K2 must skip it.
Si, tSi = uid(3, 4), T0 + timedelta(minutes=20)
turn(4, Si, tSi, S2, "warm", outcome="silent", received_ms=200, model_requested_ms=300, first_token_ms=1300, renderable_ms=1800,
     first_visible_ms=1900, ended_ms=2500, ttft_ms=1000, overhead_ms=400, model_calls=1, cost_usd=0.005)

# A warm turn whose runner died: no row, only the host's turn.abandoned.
ev(uid(3, 5), T0 + timedelta(minutes=25), S3, "turn.abandoned", "host", 30000, 30000, {"exit_reason": "unknown"}, path="warm")

# A synthetic canary turn: slow, and excluded unless include_synthetic is set.
Ca, tCa = uid(3, 6), T0 + timedelta(minutes=30)
turn(6, Ca, tCa, S3, "warm", synthetic=True, received_ms=200, model_requested_ms=300, first_token_ms=8000, renderable_ms=8500,
     first_visible_ms=9000, ended_ms=9500, ttft_ms=7700, overhead_ms=800, model_calls=1, cost_usd=0.001)

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tinybird", "fixtures")
with open(os.path.join(OUT, "calvin_events.ndjson"), "w") as f:
    f.writelines(json.dumps(e) + "\n" for e in events)
with open(os.path.join(OUT, "calvin_turns.ndjson"), "w") as f:
    f.writelines(json.dumps(t) + "\n" for t in turns)
