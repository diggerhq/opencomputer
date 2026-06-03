"""06 — Exec session that exits cleanly closes the client WS exactly once.

Validates the v6 exec-exit suppression in sandbox_ws_gateway.ts. Without it,
the DO would see the worker's clean 1000 close (sent on session.Done) as a
transient drop, redial, reattach to the now-completed session, re-receive
scrollback + exit byte + close 1000, redial again, etc. — an infinite loop
that previously emitted 4000+ scrollback_end markers per session.

Run with OPENCOMPUTER_API_URL + OPENCOMPUTER_API_KEY set in env.
"""
import asyncio
import sys
import time

import websockets

from _ws_common import create_sandbox, delete_sandbox, edge_client, open_exec


def log(m: str) -> None:
    print(f"[06] {time.strftime('%H:%M:%S')} {m}", flush=True)


async def main() -> int:
    async with edge_client() as c:
        sb = await create_sandbox(c)
        sid = sb["sandboxID"]
        log(f"sandbox={sid}")
        try:
            _, ws = await open_exec(c, sid, "for i in $(seq 1 5); do echo OUT_$i; sleep 0.3; done")
            scrollback_ends = 0
            exit_markers = 0
            close_code = close_reason = None
            try:
                while True:
                    try:
                        f = await asyncio.wait_for(ws.recv(), timeout=15.0)
                    except asyncio.TimeoutError:
                        log("FAIL — timeout, exec never closed cleanly")
                        return 1
                    b = f if isinstance(f, bytes) else f.encode()
                    if len(b) == 1 and b[0] == 0x04:
                        scrollback_ends += 1
                    if len(b) == 5 and b[0] == 0x03:
                        exit_markers += 1
            except websockets.ConnectionClosed as e:
                close_code = e.code; close_reason = e.reason

            log(f"close=({close_code}, {close_reason!r}) scrollback_ends={scrollback_ends} exit_markers={exit_markers}")
            ok = (
                close_code == 1000
                and (close_reason or "") == "exec completed"
                and scrollback_ends == 1
                and exit_markers == 1
            )
            log("PASS" if ok else "FAIL")
            return 0 if ok else 1
        finally:
            await delete_sandbox(c, sid)


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
