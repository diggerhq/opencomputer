"""07 — PTY session survives live worker migration with the WS held open.

Validates the lazy-rebind path: when the destination worker's local
ptyManager misses for an inbound WS, handlers.go falls back to
ptyManager.RebindFromAgent which opens a fresh agent.PTYAttach. The in-VM
bash + PTY are preserved across the migration (the agent owns them), so the
rebind succeeds and the user's terminal continues.

Source-side ReleaseForSandbox is also exercised: without it the source
worker's gRPC PTY stream would linger on a dead vsock and the edge DO
would never see the upstream close that triggers the redial.

Skips if the cluster has only one worker.

Run with OPENCOMPUTER_API_URL + OPENCOMPUTER_API_KEY set in env.
"""
import asyncio
import sys
import time

import websockets

from _ws_common import create_sandbox, delete_sandbox, edge_client, list_workers, open_pty


def log(m: str) -> None:
    print(f"[07] {time.strftime('%H:%M:%S')} {m}", flush=True)


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
            _, ws = await open_pty(c, sid)
            sink = bytearray()
            closed: tuple | None = None

            async def reader():
                nonlocal closed
                while True:
                    try:
                        f = await asyncio.wait_for(ws.recv(), timeout=2.0)
                    except asyncio.TimeoutError:
                        continue
                    except websockets.ConnectionClosed as e:
                        closed = (e.code, e.reason)
                        return
                    b = f if isinstance(f, bytes) else f.encode()
                    if b:
                        sink.extend(b)

            rt = asyncio.create_task(reader())
            await ws.send("echo PRE_MIG && echo H > /tmp/x\n")
            await asyncio.sleep(2)
            r = await c.post(f"/api/sandboxes/{sid}/migrate", json={"targetWorker": tgt}, timeout=120)
            log(f"migrate {r.status_code} ms={r.json().get('elapsedMs')}")

            # Retry POST_MIG send for up to 30s — covers the DO redial window
            # during which client→upstream frames are dropped.
            deadline = time.time() + 30
            while time.time() < deadline:
                if b"POST_MIG" in sink: break
                if closed:
                    log(f"FAIL — WS dropped during migration: {closed}")
                    rt.cancel(); return 1
                try:
                    await ws.send("cat /tmp/x && echo POST_MIG\n")
                except Exception:
                    pass
                await asyncio.sleep(3)
            rt.cancel()
            try: await ws.close()
            except: pass

            pre = b"PRE_MIG" in sink
            post = b"POST_MIG" in sink
            file_ok = b"H\r" in sink or b"H\n" in sink
            log(f"pre={pre} post={post} file={file_ok} closed={closed}")
            ok = pre and post and file_ok and closed is None
            log("PASS" if ok else "FAIL")
            return 0 if ok else 1
        finally:
            await delete_sandbox(c, sid)


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
