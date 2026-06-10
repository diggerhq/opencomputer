"""08 — Exec session survives live worker migration.

Same lazy-rebind path as 07, but for ExecSessionAttach. Requires the
matching pieces:
  - ExecSessionHandle.Cancel + ExecSessionManager.ReleaseForSandbox so the
    source worker's gRPC stream is canceled on outgoing migration (without
    this, the worker's exec WS handler stays blocked on the scrollback
    subscription and the DO never sees an upstream close).
  - handlers.go exec WS handler skips emitting the 0x03 exit marker when
    ExitCode is nil (without this, a cancel looks like a process exit to
    the edge DO and triggers "exec completed" close instead of redial).

Skips if the cluster has only one worker.

Run with OPENCOMPUTER_API_URL + OPENCOMPUTER_API_KEY set in env.
"""
import asyncio
import re
import sys
import time

import websockets

from _ws_common import create_sandbox, delete_sandbox, edge_client, list_workers, open_exec


def log(m: str) -> None:
    print(f"[08] {time.strftime('%H:%M:%S')} {m}", flush=True)


async def main() -> int:
    async with edge_client() as c:
        sb = await create_sandbox(c)
        sid = sb["sandboxID"]
        src = sb["workerID"]
        workers = await list_workers(c)
        others = [w["worker_id"] for w in workers if w["worker_id"] != src]
        if not others:
            log("SKIP — only one worker in the cluster")
            await delete_sandbox(c, sid)
            return 0
        tgt = others[0]
        log(f"sandbox={sid} src={src} tgt={tgt}")
        try:
            _, ws = await open_exec(c, sid, "for i in $(seq 1 30); do echo OUT_$i; sleep 1; done")
            seen: dict[int, int] = {}
            closed: tuple | None = None
            scrollback_ends = 0
            t0 = time.time()
            events: list[tuple[float, str]] = []

            async def reader():
                nonlocal closed, scrollback_ends
                while True:
                    try:
                        f = await asyncio.wait_for(ws.recv(), timeout=2.0)
                    except asyncio.TimeoutError:
                        continue
                    except websockets.ConnectionClosed as e:
                        closed = (e.code, e.reason)
                        return
                    b = f if isinstance(f, bytes) else f.encode()
                    if not b: continue
                    if len(b) == 1 and b[0] == 0x04:
                        scrollback_ends += 1
                        events.append((time.time() - t0, "scrollback_end"))
                        continue
                    payload = b[1:] if (len(b) >= 1 and b[0] in (0x01, 0x02)) else b
                    for m in re.findall(rb"OUT_(\d+)", payload):
                        n = int(m)
                        if n not in seen:
                            events.append((time.time() - t0, f"OUT_{n}"))
                        seen[n] = seen.get(n, 0) + 1

            rt = asyncio.create_task(reader())
            await asyncio.sleep(5)
            r = await c.post(f"/api/sandboxes/{sid}/migrate", json={"targetWorker": tgt}, timeout=120)
            log(f"migrate {r.status_code} ms={r.json().get('elapsedMs')}")

            await asyncio.sleep(35)  # let the 30s loop finish + headroom
            rt.cancel()
            try: await ws.close()
            except: pass

            log(f"unique OUT_ markers: {len(seen)}/30 scrollback_ends={scrollback_ends} close={closed}")
            pre_mig = any(t < 5.5 and ev.startswith("OUT_") for t, ev in events)
            post_mig = any(t > 7.0 and ev.startswith("OUT_") for t, ev in events)
            ok = pre_mig and post_mig and closed is not None and closed[0] == 1000
            log(f"pre_mig={pre_mig} post_mig={post_mig}")
            log("PASS" if ok else "FAIL")
            return 0 if ok else 1
        finally:
            await delete_sandbox(c, sid)


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
