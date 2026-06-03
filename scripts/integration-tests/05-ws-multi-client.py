"""05 — Two concurrent WS sessions on the same sandbox stay independent.

Validates the multi-session refactor in sandbox_ws_gateway.ts (v7). Pre-fix,
the second WS upgrade to the same sandbox_id clobbered the first's
clientWs/upstreamWs singletons on the DO instance — the first connection
would silently stop receiving frames. Post-fix, each upgrade gets its own
Session in a Set and they bridge to independent upstreams.

Run with OPENCOMPUTER_API_URL + OPENCOMPUTER_API_KEY set in env.
"""
import asyncio
import sys
import time

import websockets

from _ws_common import create_sandbox, delete_sandbox, edge_client, open_pty


def log(m: str) -> None:
    print(f"[05] {time.strftime('%H:%M:%S')} {m}", flush=True)


async def main() -> int:
    async with edge_client() as c:
        sb = await create_sandbox(c)
        sid = sb["sandboxID"]
        log(f"sandbox={sid}")
        try:
            pid_a, ws_a = await open_pty(c, sid)
            pid_b, ws_b = await open_pty(c, sid)
            log(f"opened pty_a={pid_a} pty_b={pid_b}")

            sink_a, sink_b = bytearray(), bytearray()

            async def drain(ws, sink):
                while True:
                    try:
                        f = await asyncio.wait_for(ws.recv(), timeout=2.0)
                    except asyncio.TimeoutError:
                        continue
                    except websockets.ConnectionClosed:
                        return
                    b = f if isinstance(f, bytes) else f.encode()
                    if b:
                        sink.extend(b)

            da = asyncio.create_task(drain(ws_a, sink_a))
            db = asyncio.create_task(drain(ws_b, sink_b))
            await asyncio.sleep(1.0)
            await ws_a.send("echo MARKER_FROM_A\n")
            await ws_b.send("echo MARKER_FROM_B\n")
            await asyncio.sleep(3.0)
            da.cancel(); db.cancel()
            await asyncio.gather(da, db, return_exceptions=True)
            await ws_a.close(); await ws_b.close()

            a_own = b"MARKER_FROM_A" in sink_a
            b_own = b"MARKER_FROM_B" in sink_b
            a_cross = b"MARKER_FROM_B" in sink_a
            b_cross = b"MARKER_FROM_A" in sink_b
            ok = a_own and b_own and not a_cross and not b_cross
            log(f"a_own={a_own} b_own={b_own} a_cross={a_cross} b_cross={b_cross}")
            log("PASS" if ok else "FAIL")
            return 0 if ok else 1
        finally:
            await delete_sandbox(c, sid)


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
