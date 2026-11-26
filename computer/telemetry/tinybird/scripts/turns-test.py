"""CI check for the `turns` pipe (work 054): derive turns from the facts the
real Agent SDK produced in src/dev/telemetry-check.ts (fixtures/runner-facts.ndjson,
regenerate with `--out`) and assert the derived row. Needs chdb.

  python -I turns-test.py
"""
import datetime
import json
import pathlib
import sys
import tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from turns_local import load  # noqa: E402

HERE = pathlib.Path(__file__).resolve().parent
s = load(str(HERE / "fixtures" / "runner-facts.ndjson"))
rows = [json.loads(line) for line in s.query("SELECT * FROM turns ORDER BY sent_at", "JSONEachRow").bytes().decode().splitlines()]

failed = 0


def check(name, ok, got):
    global failed
    failed += not ok
    print("PASS" if ok else "FAIL", name, "" if ok else got)


# Expected values straight from the facts, independent of the SQL (work 068).
facts = [json.loads(line) for line in (HERE / "fixtures" / "runner-facts.ndjson").read_text().splitlines()]


def ms(ts):
    return int(datetime.datetime.fromisoformat(ts).timestamp() * 1000)


def first_call_ctx(turn_id):
    calls = sorted((e["occurred_at"], json.loads(e["data"])) for e in facts if e.get("turn_id") == turn_id and e["event_name"] == "model.response_started")
    d = calls[0][1]
    return d["input_tokens"] + d["cache_read_tokens"] + d["cache_creation_tokens"]


def inter_call_gaps(turn_id):
    steps = sorted((ms(e["occurred_at"]), e["event_name"] == "model.response_started") for e in facts if e.get("turn_id") == turn_id and e["event_name"] in ("tool.completed", "model.response_started"))
    return [b[0] - a[0] for a, b in zip(steps, steps[1:]) if b[1] and not a[1]]


check("no placeholder: first content = first visible", all(r["first_content_ms"] == r["first_visible_ms"] for r in rows), rows)
cold, warm, prewarmed = rows if len(rows) == 3 else (None, None, None)
check("three turns", len(rows) == 3, len(rows))
if cold:
    check("cold: two model calls, one tool", (cold["model_calls"], cold["tool_calls"]) == (2, 1), cold)
    check("cold: ordered milestones", cold["model_requested_ms"] <= cold["first_token_ms"] <= cold["renderable_ms"] <= cold["first_visible_ms"] <= cold["ended_ms"] <= cold["closed_ms"], cold)
    # Nothing else shows yet, so the card comes 300 ms into the thinking (runner/thinking.ts), reported as `thinking.shown`.
    check("cold: renderable at the Thinking… card", 250 <= cold["renderable_ms"] - cold["first_token_ms"] < 1400, cold)
    check("cold: thinking is not overhead", cold["overhead_ms"] < 2500, cold)
    check("cold: the tool's input and run are split", cold["tool_input_ms"] < 100 and cold["tool_run_ms"] >= 900, cold)
    check("cold: thinking time", cold["thinking_ms"] >= 2400, cold)
    check("cold: longest silence was thinking", cold["silence_cause"] == "thinking" and cold["max_silence_ms"] > 1000, cold)
    check("cold: usage and cost", cold["input_tokens"] > 0 and cold["cost_usd"] > 0, cold)
    check("cold: context at its first request", cold["ctx_tokens"] == first_call_ctx(cold["turn_id"]) > 0, cold["ctx_tokens"])
    gaps = inter_call_gaps(cold["turn_id"])
    check("cold: one step after a tool result, its first-token wait summed and maxed", len(gaps) == 1 and (cold["inter_call_ttft_ms"], cold["inter_call_ttft_max_ms"]) == (sum(gaps), max(gaps)), (gaps, cold["inter_call_ttft_ms"], cold["inter_call_ttft_max_ms"]))
if warm:
    check("warm: its own turn, path and seq", warm["turn_id"] != cold["turn_id"] and warm["path"] == "warm" and warm["turn_seq"] == 2, warm)
    check("warm: no harness start", warm["harness_init_ms"] is None, warm)
    check("warm: no tool, no step between requests", warm["inter_call_ttft_ms"] is None and warm["ctx_tokens"] == first_call_ctx(warm["turn_id"]), warm)
    check("warm: cost is this turn's share", 0 < warm["cost_usd"] < cold["cost_usd"], warm)
if prewarmed:
    check("prewarmed: harness up before the turn, no harness start in it", prewarmed["harness_init_ms"] is None and prewarmed["harness_ready_ms"] is None, prewarmed)
    check("prewarmed: the request goes out at turn start", prewarmed["model_requested_ms"] <= prewarmed["first_token_ms"], prewarmed)

# Work 068: the runner opens an addressed turn's message at push on a `Started`
# card, a write tagged `placeholder`. Replay the facts with one such write right
# after each turn starts: K2 (first visible) moves to it; first content and K3 don't.
added = []
for line in (HERE / "fixtures" / "runner-facts.ndjson").read_text().splitlines():
    f = json.loads(line)
    if f["event_name"] == "turn.started":
        added.append({**f, "event_id": f["event_id"][:-4] + "beef", "event_name": "surface.call", "duration_ms": 0, "outcome": "completed",
                      "data": json.dumps({"method": "chat.startStream", "status": "ok", "rate_limited": False, "placeholder": True})})
with tempfile.NamedTemporaryFile("w", suffix=".ndjson", delete=False) as out:
    out.write("\n".join(json.dumps(f) for f in added))
# chdb keeps one session per process: add the writes to the loaded table; the pipe nodes are views.
s.query(f"INSERT INTO calvin_events SELECT * FROM file('{out.name}', 'JSONEachRow') SETTINGS input_format_skip_unknown_fields = 1")
rows2 = [json.loads(line) for line in s.query("SELECT * FROM turns ORDER BY sent_at", "JSONEachRow").bytes().decode().splitlines()]
pathlib.Path(out.name).unlink()
for before, after in zip(rows, rows2):
    tag = f"placeholder ({before['path']}, seq {before['turn_seq']})"
    check(f"{tag}: first content is the old first visible", after["first_content_ms"] == before["first_visible_ms"], (before, after))
    check(f"{tag}: first visible is the opening card, earlier", after["first_visible_ms"] < before["first_visible_ms"], (before, after))
    check(f"{tag}: K3 unchanged", after["overhead_ms"] == before["overhead_ms"], (before, after))
check("no lag facts: client and loop lag are null", all(r["client_lag_max_ms"] is None and r["loop_lag_max_ms"] is None for r in rows), rows)

# Work 082: content writes carry how long they waited (`queued_ms`), and the
# runner reports its event-loop delay per window. Replay two stamped writes,
# one of them the opening card, and two loop windows per turn.
added = []
for line in (HERE / "fixtures" / "runner-facts.ndjson").read_text().splitlines():
    f = json.loads(line)
    if f["event_name"] == "turn.started":
        write = {**f, "event_name": "surface.call", "outcome": "completed"}
        added.append({**write, "event_id": f["event_id"][:-4] + "c0de", "duration_ms": 50,
                      "data": json.dumps({"method": "chat.appendStream", "status": "ok", "rate_limited": False, "queued_ms": 300})})
        added.append({**write, "event_id": f["event_id"][:-4] + "c0df", "duration_ms": 50,
                      "data": json.dumps({"method": "chat.startStream", "status": "ok", "rate_limited": False, "placeholder": True, "queued_ms": 900})})
        for suffix, worst in (("1a90", 12), ("1a91", 40)):
            added.append({**f, "event_id": f["event_id"][:-4] + suffix, "event_name": "loop.lag",
                          "data": json.dumps({"max_ms": worst, "mean_ms": 1, "window_ms": 5000})})
with tempfile.NamedTemporaryFile("w", suffix=".ndjson", delete=False) as out:
    out.write("\n".join(json.dumps(f) for f in added))
s.query(f"INSERT INTO calvin_events SELECT * FROM file('{out.name}', 'JSONEachRow') SETTINGS input_format_skip_unknown_fields = 1")
rows3 = [json.loads(line) for line in s.query("SELECT * FROM turns ORDER BY sent_at", "JSONEachRow").bytes().decode().splitlines()]
pathlib.Path(out.name).unlink()
for r in rows3:
    tag = f"lag ({r['path']}, seq {r['turn_seq']})"
    check(f"{tag}: client lag is the content write's wait plus its call, not the opening card's", r["client_lag_max_ms"] == 350, r["client_lag_max_ms"])
    check(f"{tag}: loop lag is the worst window", r["loop_lag_max_ms"] == 40, r["loop_lag_max_ms"])

print(f"{failed} FAILED" if failed else "all passed")
sys.exit(1 if failed else 0)
