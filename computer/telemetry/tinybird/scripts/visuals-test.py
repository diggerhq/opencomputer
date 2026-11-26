"""Check of the `visuals` pipe (work 063) over synthetic runner facts (not in
CI yet: 060 F3). Cases: a visual with no render before it; an episode with a
retry and an install, posted from the render's own Bash call before that call
completes; a steered turn's dimensions; a log posted after a failed render; a
render with no visual after it; a `node shot.mjs` render seen only by its
post. Needs chdb.

  python -I visuals-test.py
"""
import json
import pathlib
import sys
import tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from turns_local import load  # noqa: E402

T = "turn-1"


def at(s):
    return f"2026-10-14 12:00:{s:02d}.000"


def ev(n, name, s, **kw):
    return {"schema_version": 1, "event_id": f"e{n}", "event_name": name, "occurred_at": at(s), "service_name": "runner",
            "turn_id": T, "trace_id": "tr-1", "session_key": "T1:C1:1.2", "path": "warm", "synthetic": False, **kw}


def call(n, s, kinds, done):
    tid = f"toolu_{n}"
    return [ev(f"{n}s", "model.block_started", s, tool_call_id=tid, tool_name="Bash", data=json.dumps({"kind": "tool"})),
            ev(f"{n}c", "tool.completed", done, tool_call_id=tid, data=json.dumps({"is_error": False, "command_kinds": kinds}))]


def posted(n, s, kind="image", call=""):
    return ev(f"p{n}", "file.posted", s, tool_call_id=call, data=json.dumps({"kind": kind, "bytes": 100, "source": "script"}))


events = [
    ev("t", "turn.started", 0),
    ev("steer", "prompt.pushed", 1, trace_id="tr-steer", path="cold", synthetic=True, data=json.dumps({"steer": True})),
    posted(0, 5),                  # an existing image: no render before it, not an episode
    *call(1, 6, "", 7),            # ls: no kind
    *call(2, 10, "browser", 12),   # first render: the episode starts here
    *call(3, 13, "install", 20),   # libraries
    *call(4, 21, "browser,post", 35),
    posted(1, 30, call="toolu_4"), # posted from the running call, before it completes
    *call(5, 40, "media", 50),     # a video never posted
    *call(6, 51, "", 52),
    posted(2, 52, kind="text"),    # the log of the failure: not a visual
    *call(7, 60, "", 70),          # node shot.mjs: no kind…
    posted(3, 69, call="toolu_7"), # …but its post makes it a render
]
with tempfile.NamedTemporaryFile("w", suffix=".ndjson", delete=False) as f:
    f.write("\n".join(json.dumps(e) for e in events))
s = load(f.name)
rows = [json.loads(line) for line in s.query("SELECT * FROM visuals ORDER BY started_at", "JSONEachRow").bytes().decode().splitlines()]

failed = 0


def check(name, ok, got):
    global failed
    failed += not ok
    print("PASS" if ok else "FAIL", name, "" if ok else got)


check("two episodes; the window after the last visual has no render", len(rows) == 2, rows)
if len(rows) == 2:
    first, second = rows
    check("posted: first render to the visual", (first["outcome"], first["visual_ms"]) == ("posted", 20000), first)
    check("posted: the retry and the install count", (first["renders"], first["installs"]) == (2, 1), first)
    check("dimensions are the turn's, not the steer's", (first["trace_id"], first["path"], first["synthetic"]) == ("tr-1", "warm", False), first)
    check("a log after a failed render is not a visual: still open", (second["outcome"], second["renders"]) == ("posted", 2), second)
    check("an untagged render is seen by its post", (second["visual_ms"], second["started_at"]) == (29000, at(40)), second)
print(f"{failed} FAILED" if failed else "all passed")
sys.exit(1 if failed else 0)
