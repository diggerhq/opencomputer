"""blue-modal-shim: HTTPS control plane for Modal sandboxes, called by blue's workerd edge.

Mirrors what AWS Lambda-MicroVMs provides sandboxEnsure today:
  POST /sandboxes           -> create VM sandbox, mount volume, deliver run hook, return id+tunnel
  GET  /sandboxes/{id}      -> status + tunnel URL (supervisorRequest endpoint resolution)
  POST /sandboxes/{id}/terminate
  POST /sandboxes/{id}/suspend   -> FS snapshot -> terminate -> imageId (stored per sessionId)
  GET  /snapshots/{sessionId}    -> last snapshot imageId for resume
  GET  /volumes/{name}/list      -> recursive listing of a workspace volume
  GET  /volumes/{name}/stat      -> one entry (404 when missing)
  GET  /volumes/{name}/file      -> stream a volume file's bytes
  POST /volumes/{name}/export    -> stream a volume file into a presigned S3 PUT
  GET  /dl?vol&path&exp&sig      -> public HMAC-signed download (workspace download URLs)
Auth: X-Shim-Token header (shared secret, env BLUE_SHIM_TOKEN on both sides).
/dl carries no header auth — its HMAC query parameter is the credential,
exactly like a presigned S3 URL. Set DL_DOMAIN on the deploy machine to
serve the app (and so /dl) on a custom domain instead of *.modal.run.
Set SHIM_SECRET_NAME to deploy against another secret (mo-dev uses
blue-shim-config-mo-dev with `modal deploy ... --name blue-modal-shim-mo-dev`).
"""
import hashlib
import hmac
import json
import mimetypes
import os
import posixpath
import threading
import time
from typing import Optional

import modal
import modal.experimental

app = modal.App("blue-modal-shim")

web_image = modal.Image.debian_slim().pip_install("fastapi[standard]", "httpx")

snapshots = modal.Dict.from_name("blue-modal-snapshots", create_if_missing=True)
# sandbox_id -> session_id, so suspend can key the snapshot by session even
# when the caller (a runtime-action endpoint) only knows the sandbox id.
sandbox_sessions = modal.Dict.from_name("blue-modal-sandbox-sessions", create_if_missing=True)
# session_id -> sandbox_id, so a retried ensure returns the sandbox the
# first (acknowledged-or-not) create made instead of stranding a duplicate
# on the same volume.
session_sandboxes = modal.Dict.from_name("blue-modal-session-sandboxes", create_if_missing=True)
# image_id -> {session_id, superseded_at}: snapshot images a newer snapshot
# of the same session replaced. Only a session's latest snapshot is ever
# restored, and that one is kept forever (an ended session can still wake);
# these are the ones safe to delete. Deletion is gated by
# SNAPSHOT_DELETE_SUPERSEDED=1 (see verify-snapshot-delete.py); until then
# the record is what a later cleanup works from.
superseded_snapshots = modal.Dict.from_name(
    "blue-modal-superseded-snapshots", create_if_missing=True
)
# sandbox_id -> BLUE_SANDBOX_TOKEN; the platform sends it in env at create
# and reads it back from status to authenticate supervisor tunnel calls.
sandbox_tokens = modal.Dict.from_name("blue-modal-sandbox-tokens", create_if_missing=True)
# sandbox_id -> {"domains", "cidrs"}: the outbound allowlists a sandbox was
# created with (work 057). Absent means an open network. A deduplicated
# ensure reuses a sandbox only when its policy is the one requested.
sandbox_policies = modal.Dict.from_name("blue-modal-sandbox-policies", create_if_missing=True)
# sandbox_id -> unix seconds the shim first knew it: set at create, or by the
# first listing for a sandbox created before this record existed. The sweep
# reads it so a sandbox still booting is never taken for an orphan.
sandbox_seen = modal.Dict.from_name("blue-modal-sandbox-seen", create_if_missing=True)

# The supervisor's port in the standard image. A runtime profile's image can
# listen elsewhere (an operator image: 9090); the platform sends it as supervisor_port.
# A sandbox exposes exactly one encrypted port, its supervisor's.
SUPERVISOR_PORT = 8080


def _create_sandbox(
    *,
    app_name: str,
    image_name: str,
    snapshot_image_id: Optional[str],
    cpu: float,
    memory_mib: int,
    region: Optional[str],
    env: dict,
    volume_name: Optional[str],
    mount_path: Optional[str],
    timeout_seconds: int,
    supervisor_port: int = SUPERVISOR_PORT,
    outbound_policy: Optional[dict] = None,
) -> tuple[modal.Sandbox, str]:
    if snapshot_image_id:
        image = modal.Image.from_id(snapshot_image_id)
    else:
        image = modal.Image.from_name(image_name)
    volumes = {}
    if volume_name and mount_path:
        volumes[mount_path] = modal.Volume.from_name(volume_name, create_if_missing=True)
    oc_app = modal.App.lookup(app_name, create_if_missing=True)
    network = {}
    if outbound_policy is not None:
        # Both lists are always set together: Modal treats a missing one as
        # unrestricted, an empty one as nothing allowed.
        network = {
            "outbound_domain_allowlist": outbound_policy["domains"],
            "outbound_cidr_allowlist": outbound_policy["cidrs"],
        }
    sb = modal.Sandbox.create(
        app=oc_app,
        image=image,
        env=env,
        volumes=volumes,
        timeout=timeout_seconds,
        cpu=cpu,
        memory=memory_mib,
        runtime="vm",
        region=region,
        encrypted_ports=[supervisor_port],
        **network,
    )
    deadline = time.time() + 120
    while time.time() < deadline:
        p = sb.exec(
            "curl", "-sf", "-m", "2", f"http://localhost:{supervisor_port}/health"
        )
        p.stdout.read()
        p.stderr.read()
        if p.wait() == 0:
            break
        if sb.poll() is not None:
            raise RuntimeError("sandbox exited before supervisor became healthy")
        time.sleep(0.5)
    else:
        sb.terminate()
        raise RuntimeError("supervisor did not become healthy within 120s")
    tunnel = sb.tunnels()[supervisor_port]
    return sb, tunnel.url


def _supervisor_tunnel(sb: modal.Sandbox):
    """The sandbox's one encrypted tunnel (its supervisor's), or None."""
    tunnels = sb.tunnels()
    return tunnels.get(SUPERVISOR_PORT) or next(iter(tunnels.values()), None)


def _deliver_run_hook(
    sb: modal.Sandbox,
    payload: dict,
    timeout: float = 180,
    supervisor_port: int = SUPERVISOR_PORT,
) -> dict:
    body = json.dumps({"runHookPayload": json.dumps(payload)})
    t0 = time.time()
    while True:
        # No -f: a refused hook's body says why, and that is the error to keep.
        p = sb.exec(
            "curl",
            "-sS",
            "-m",
            "20",
            "-w",
            "\n%{http_code}",
            "-X",
            "POST",
            "-H",
            "content-type: application/json",
            "-d",
            body,
            f"http://localhost:{supervisor_port}/run",
        )
        out = p.stdout.read()
        err = p.stderr.read()
        code = p.wait()
        response, _, status = out.rpartition("\n")
        if code == 0 and status.startswith("2"):
            return {"hookMs": int((time.time() - t0) * 1000), "response": response}
        if sb.poll() is not None:
            raise RuntimeError("run hook delivery failed: sandbox exited")
        if time.time() - t0 > timeout:
            raise RuntimeError(
                f"run hook delivery failed after {int(time.time() - t0)}s: "
                f"{status or 'no response'} {(response or err).strip()[:500]}"
            )
        time.sleep(1)


# The platform reaches the shim through an edge that gives up on a request
# after about 100 seconds; past that the caller has already failed, so a
# sandbox finished later would never be used.
CREATE_REQUEST_BUDGET_SECONDS = 85


def _hook_budget(started_at: float) -> float:
    return max(15.0, CREATE_REQUEST_BUDGET_SECONDS - (time.time() - started_at))


def _terminate_quietly(sb: modal.Sandbox) -> None:
    try:
        sb.terminate()
    except Exception:
        pass


# A second deployment of the shim (mo-dev: `--name blue-modal-shim-mo-dev`)
# carries its own shared secret; name it with SHIM_SECRET_NAME on the deploy
# machine, as DL_DOMAIN names the domain.
@app.function(
    image=web_image,
    secrets=[modal.Secret.from_name(os.environ.get("SHIM_SECRET_NAME", "blue-shim-config"))],
)
@modal.asgi_app(
    custom_domains=[
        domain for domain in os.environ.get("DL_DOMAIN", "").split(",") if domain
    ]
)
def api():
    from fastapi import FastAPI, Header, HTTPException, Request
    from pydantic import BaseModel

    from fastapi.responses import StreamingResponse

    token = os.environ.get("BLUE_SHIM_TOKEN", "")
    web = FastAPI()

    # /dl answers browser fetches (the dashboard's "Download all" streams
    # each file into a zip), so it needs the same CORS as the S3 download
    # bucket behind downloads.opencomputer.dev. Scoped to /dl: every other
    # route is server-to-server behind X-Shim-Token.
    dl_origins = {
        origin.strip()
        for origin in os.environ.get(
            "DL_CORS_ORIGINS", "https://app.opencomputer.dev"
        ).split(",")
        if origin.strip()
    }

    @web.middleware("http")
    async def dl_cors(request: Request, call_next):
        if request.url.path != "/dl":
            return await call_next(request)
        origin = request.headers.get("origin", "")
        allowed = origin in dl_origins
        if request.method == "OPTIONS":
            from fastapi.responses import Response

            response = Response(status_code=204 if allowed else 403)
            if allowed:
                response.headers["access-control-allow-methods"] = "GET,HEAD,OPTIONS"
                response.headers["access-control-allow-headers"] = "*"
                response.headers["access-control-max-age"] = "300"
        else:
            response = await call_next(request)
        if allowed:
            response.headers["access-control-allow-origin"] = origin
            response.headers["access-control-expose-headers"] = (
                "ETag,Content-Length,Content-Type,Content-Disposition"
            )
        response.headers["vary"] = "Origin"
        return response

    def auth(x_shim_token: str = Header(default="")):
        if not token or hmac.compare_digest(x_shim_token, token) is False:
            raise HTTPException(401, "bad shim token")

    def _clean_path(path: str) -> Optional[str]:
        """Volume-relative path or None: no traversal, no leading slash."""
        if ".." in path.split("/") or "\x00" in path:
            return None
        cleaned = posixpath.normpath("/" + path.lstrip("/")).lstrip("/")
        if not cleaned or cleaned == ".":
            return None
        return cleaned

    def _volume(name: str) -> modal.Volume:
        return modal.Volume.from_name(name)

    _ENTRY_TYPES = {1: "file", 2: "directory", 3: "symlink"}

    def _entry_payload(entry) -> dict:
        mtime = getattr(entry, "mtime", None)
        # FileEntry.mtime is a unix timestamp, not a datetime.
        if isinstance(mtime, (int, float)):
            from datetime import datetime, timezone

            mtime = datetime.fromtimestamp(mtime, timezone.utc).isoformat()
        return {
            "path": entry.path.lstrip("/"),
            "type": _ENTRY_TYPES.get(entry.type, "other"),
            "size": entry.size,
            "mtime": mtime or None,
        }

    def _stat(vol: modal.Volume, path: str):
        """The FileEntry for a volume-relative path, or None."""
        parent = posixpath.dirname(path) or "/"
        base = posixpath.basename(path)
        try:
            entries = vol.listdir(parent, recursive=False)
        except Exception:
            return None
        for entry in entries:
            if entry.path.lstrip("/").rstrip("/").split("/")[-1] == base:
                return entry
        return None

    class CreateReq(BaseModel):
        image_name: str = "oc-blue-runtime"
        snapshot_image_id: Optional[str] = None
        cpu: float = 2
        memory_mib: int = 4096
        region: Optional[str] = None
        env: dict = {}
        volume_name: Optional[str] = None
        mount_path: Optional[str] = None
        timeout_seconds: int = 1800
        app_name: str = "opencomputer-sandboxes"
        run_hook_payload: Optional[dict] = None
        # Deliver the run hook after responding (work 078: the edge starts a
        # session runtime inside a 30 s waitUntil budget, and a session hook
        # answers only once OpenCode and the runtime have connected, which is
        # longer than that). The response then carries hook={"pending": true};
        # a delivery that fails terminates the sandbox, as a synchronous one
        # would have, so the caller sees it vanish rather than sit idle.
        run_hook_async: bool = False
        session_id: Optional[str] = None
        supervisor_port: int = SUPERVISOR_PORT
        outbound_domain_allowlist: Optional[list[str]] = None
        outbound_cidr_allowlist: Optional[list[str]] = None

        def outbound_policy(self) -> Optional[dict]:
            if self.outbound_domain_allowlist is None and self.outbound_cidr_allowlist is None:
                return None
            return {
                "domains": sorted(set(self.outbound_domain_allowlist or [])),
                "cidrs": sorted(set(self.outbound_cidr_allowlist or [])),
            }

    def _policy_of(sandbox_id: str) -> Optional[dict]:
        try:
            return sandbox_policies.get(sandbox_id)
        except Exception:
            return None

    def _deliver_run_hook_later(
        sb: modal.Sandbox, req: "CreateReq", terminate_on_failure: bool
    ) -> dict:
        """Delivers the run hook on a thread and reports it pending."""
        t0 = time.time()

        def deliver() -> None:
            try:
                hook = _deliver_run_hook(
                    sb,
                    req.run_hook_payload,
                    timeout=180,
                    supervisor_port=req.supervisor_port,
                )
                print(json.dumps({"event": "shim.run_hook_delivered", "sandbox_id": sb.object_id, "session_id": req.session_id, "hook_ms": hook["hookMs"]}))
            except Exception as e:
                print(json.dumps({"event": "shim.run_hook_failed", "sandbox_id": sb.object_id, "session_id": req.session_id, "error": str(e)[:500], "async": True}))
                if terminate_on_failure:
                    _terminate_quietly(sb)
                    _forget_sandbox(sb.object_id)

        threading.Thread(target=deliver, name=f"run-hook-{sb.object_id}", daemon=True).start()
        return {"pending": True, "startedAt": int(t0 * 1000)}

    @web.post("/sandboxes")
    def create(req: CreateReq, x_shim_token: str = Header(default="")):
        auth(x_shim_token)
        t0 = time.time()
        policy = req.outbound_policy()
        if req.session_id:
            # Idempotency: a lost create response makes the platform retry
            # the whole ensure — hand back the live sandbox for this session
            # rather than stranding a duplicate on the same volume.
            try:
                existing_id = session_sandboxes.get(req.session_id)
            except Exception:
                existing_id = None
            if existing_id:
                existing = None
                try:
                    existing = modal.Sandbox.from_id(existing_id)
                    if existing.poll() is None and _policy_of(existing_id) != policy:
                        # The deployment's egress changed since this sandbox
                        # was made; it must not serve the new policy.
                        existing.terminate()
                        _forget_sandbox(existing_id)
                    elif existing.poll() is None:
                        tunnel = _supervisor_tunnel(existing)
                        hook = None
                        if req.run_hook_payload:
                            # The first create may have died between sandbox
                            # boot and hook delivery; redelivering is safe —
                            # the supervisor reuses a delivery for the same
                            # session and generation.
                            hook = (
                                _deliver_run_hook_later(existing, req, terminate_on_failure=False)
                                if req.run_hook_async
                                else _deliver_run_hook(
                                    existing,
                                    req.run_hook_payload,
                                    timeout=_hook_budget(t0),
                                    supervisor_port=req.supervisor_port,
                                )
                            )
                        return {
                            "sandbox_id": existing_id,
                            "tunnel_url": tunnel.url,
                            "ready_ms": int((time.time() - t0) * 1000),
                            "hook": hook,
                            "deduplicated": True,
                            "outbound_policy": policy,
                        }
                except Exception as e:
                    # The session's sandbox cannot serve this request; the
                    # replacement made below takes its place, so this one
                    # must not keep running (and billing) to its timeout.
                    print(json.dumps({"event": "shim.dedup_replaced", "sandbox_id": existing_id, "session_id": req.session_id, "error": str(e)[:500]}))
                    if existing is not None:
                        _terminate_quietly(existing)
                    _forget_sandbox(existing_id)
        sb, tunnel_url = _create_sandbox(
            app_name=req.app_name,
            image_name=req.image_name,
            snapshot_image_id=req.snapshot_image_id,
            cpu=req.cpu,
            memory_mib=req.memory_mib,
            region=req.region,
            env=req.env,
            volume_name=req.volume_name,
            mount_path=req.mount_path,
            timeout_seconds=req.timeout_seconds,
            supervisor_port=req.supervisor_port,
            outbound_policy=policy,
        )
        ready_ms = int((time.time() - t0) * 1000)
        if policy is not None:
            sandbox_policies.put(sb.object_id, policy)
        sandbox_seen.put(sb.object_id, int(t0))
        if req.session_id:
            sandbox_sessions.put(sb.object_id, req.session_id)
            session_sandboxes.put(req.session_id, sb.object_id)
        sandbox_token = req.env.get("BLUE_SANDBOX_TOKEN")
        if sandbox_token:
            sandbox_tokens.put(sb.object_id, sandbox_token)
        hook = None
        if req.run_hook_payload and req.run_hook_async:
            hook = _deliver_run_hook_later(sb, req, terminate_on_failure=True)
        elif req.run_hook_payload:
            try:
                hook = _deliver_run_hook(
                    sb,
                    req.run_hook_payload,
                    timeout=_hook_budget(t0),
                    supervisor_port=req.supervisor_port,
                )
            except Exception as e:
                # The caller gets an error and will not use this sandbox.
                print(json.dumps({"event": "shim.run_hook_failed", "sandbox_id": sb.object_id, "session_id": req.session_id, "error": str(e)[:500]}))
                _terminate_quietly(sb)
                _forget_sandbox(sb.object_id)
                raise
        return {
            "sandbox_id": sb.object_id,
            "tunnel_url": tunnel_url,
            "ready_ms": ready_ms,
            "hook": hook,
            "outbound_policy": policy,
        }

    @web.get("/sandboxes")
    def list_sandboxes(app: str = "opencomputer-sandboxes", x_shim_token: str = Header(default="")):
        """The app's running sandboxes, with the session each was created for
        and when the shim first knew it, for the edge's idle sweep."""
        auth(x_shim_token)
        oc_app = modal.App.lookup(app, create_if_missing=True)
        now = int(time.time())
        out = []
        for sb in modal.Sandbox.list(app_id=oc_app.app_id):
            sandbox_id = sb.object_id
            try:
                session_id = sandbox_sessions.get(sandbox_id)
            except Exception:
                session_id = None
            try:
                seen = sandbox_seen.get(sandbox_id)
                if seen is None:
                    seen = now
                    sandbox_seen.put(sandbox_id, seen)
            except Exception:
                seen = now
            out.append({"sandbox_id": sandbox_id, "session_id": session_id, "seen_at": seen})
        return {"sandboxes": out}

    @web.get("/sandboxes/{sandbox_id}")
    def get(sandbox_id: str, x_shim_token: str = Header(default="")):
        auth(x_shim_token)
        try:
            sb = modal.Sandbox.from_id(sandbox_id)
        except Exception as e:
            raise HTTPException(404, str(e))
        status = "running" if sb.poll() is None else "terminated"
        out = {"sandbox_id": sandbox_id, "status": status}
        if status == "running":
            tunnel = _supervisor_tunnel(sb)
            if tunnel:
                out["tunnel_url"] = tunnel.url
            try:
                token = sandbox_tokens.get(sandbox_id)
                if token:
                    out["sandbox_token"] = token
            except Exception:
                pass
        return out

    def _forget_sandbox(sandbox_id: str) -> None:
        try:
            session_id = sandbox_sessions.get(sandbox_id)
            if session_id:
                session_sandboxes.pop(session_id)
                sandbox_sessions.pop(sandbox_id)
        except Exception:
            pass
        try:
            sandbox_tokens.pop(sandbox_id)
        except Exception:
            pass
        try:
            sandbox_policies.pop(sandbox_id)
        except Exception:
            pass
        try:
            sandbox_seen.pop(sandbox_id)
        except Exception:
            pass

    def _supersede_snapshot(image_id: str, session_id: str) -> None:
        """Records a replaced snapshot image and, when enabled, deletes it.
        Never fails the suspend: the new snapshot is already stored."""
        try:
            superseded_snapshots.put(
                image_id, {"session_id": session_id, "superseded_at": int(time.time())}
            )
        except Exception as e:
            print(json.dumps({"event": "shim.snapshot_supersede_unrecorded", "image_id": image_id, "error": str(e)}))
        if os.environ.get("SNAPSHOT_DELETE_SUPERSEDED") != "1":
            return
        try:
            modal.experimental.image_delete(image_id)
            superseded_snapshots.pop(image_id)
            print(json.dumps({"event": "shim.snapshot_deleted", "image_id": image_id, "session_id": session_id}))
        except Exception as e:
            print(json.dumps({"event": "shim.snapshot_delete_failed", "image_id": image_id, "error": str(e)}))

    @web.post("/sandboxes/{sandbox_id}/terminate")
    def terminate(sandbox_id: str, x_shim_token: str = Header(default="")):
        auth(x_shim_token)
        try:
            sb = modal.Sandbox.from_id(sandbox_id)
        except Exception:
            _forget_sandbox(sandbox_id)
            return {"terminated": True}
        sb.terminate()
        _forget_sandbox(sandbox_id)
        return {"terminated": True}

    class SuspendReq(BaseModel):
        session_id: Optional[str] = None
        ttl_ms: Optional[int] = None

    @web.post("/sandboxes/{sandbox_id}/suspend")
    def suspend(sandbox_id: str, req: SuspendReq, x_shim_token: str = Header(default="")):
        auth(x_shim_token)
        sb = modal.Sandbox.from_id(sandbox_id)
        session_id = req.session_id
        if not session_id:
            try:
                session_id = sandbox_sessions.get(sandbox_id)
            except Exception:
                session_id = None
        t0 = time.time()
        image = sb.snapshot_filesystem()
        snap_ms = int((time.time() - t0) * 1000)
        sb.terminate()
        _forget_sandbox(sandbox_id)
        if session_id:
            try:
                previous = snapshots.get(session_id)
            except Exception:
                previous = None
            snapshots.put(session_id, image.object_id)
            if previous and previous != image.object_id:
                _supersede_snapshot(previous, session_id)
        return {
            "image_id": image.object_id,
            "snapshot_ms": snap_ms,
            "terminated": True,
        }

    @web.get("/snapshots/{session_id}")
    def get_snapshot(session_id: str, x_shim_token: str = Header(default="")):
        auth(x_shim_token)
        try:
            return {"session_id": session_id, "image_id": snapshots.get(session_id)}
        except Exception:
            return {"session_id": session_id, "image_id": None}

    # ---- workspace volume filesystem -------------------------------------
    # The platform's /v1/workspaces/* contract, backed by Modal Volumes
    # instead of the S3 Files bucket. The volume API reads durable storage
    # directly, so these work whether or not a sandbox is running.

    _LIST_PAGE = 1000

    @web.get("/volumes/{name}/list")
    def volume_list(
        name: str,
        cursor: Optional[str] = None,
        x_shim_token: str = Header(default=""),
    ):
        auth(x_shim_token)
        try:
            vol = _volume(name)
            entries = sorted(vol.listdir("/", recursive=True), key=lambda e: e.path)
        except Exception as e:
            raise HTTPException(404, f"volume unavailable: {e}")
        offset = int(cursor) if cursor else 0
        page = entries[offset : offset + _LIST_PAGE]
        next_offset = offset + len(page)
        return {
            "entries": [_entry_payload(e) for e in page],
            "next_cursor": str(next_offset) if next_offset < len(entries) else None,
        }

    @web.get("/volumes/{name}/stat")
    def volume_stat(
        name: str,
        path: str,
        x_shim_token: str = Header(default=""),
    ):
        auth(x_shim_token)
        cleaned = _clean_path(path)
        if cleaned is None:
            raise HTTPException(400, "bad path")
        entry = _stat(_volume(name), cleaned)
        if entry is None:
            raise HTTPException(404, "not found")
        payload = _entry_payload(entry)
        payload["media_type"] = (
            mimetypes.guess_type(cleaned)[0] or "application/octet-stream"
        )
        return payload

    @web.get("/volumes/{name}/file")
    def volume_file(
        name: str,
        path: str,
        x_shim_token: str = Header(default=""),
    ):
        auth(x_shim_token)
        cleaned = _clean_path(path)
        if cleaned is None:
            raise HTTPException(400, "bad path")
        vol = _volume(name)
        entry = _stat(vol, cleaned)
        if entry is None:
            raise HTTPException(404, "not found")
        return StreamingResponse(
            vol.read_file(cleaned),
            media_type="application/octet-stream",
            headers={"content-length": str(entry.size)},
        )

    class ExportReq(BaseModel):
        path: str
        # Presigned S3 PUT the shim streams the volume file into; the
        # platform issues it so bytes go volume -> S3 without transiting
        # the workerd edge.
        put_url: str

    @web.post("/volumes/{name}/export")
    def volume_export(
        name: str,
        req: ExportReq,
        x_shim_token: str = Header(default=""),
    ):
        auth(x_shim_token)
        import httpx

        cleaned = _clean_path(req.path)
        if cleaned is None:
            raise HTTPException(400, "bad path")
        vol = _volume(name)
        before = _stat(vol, cleaned)
        if before is None:
            raise HTTPException(404, "not found")
        if before.type != 1:  # FileEntryType.FILE
            raise HTTPException(
                422,
                "not a regular file" if before.type != 3 else "symlink rejected",
            )
        digest = hashlib.sha256()
        size = 0

        def stream():
            nonlocal size
            for chunk in vol.read_file(cleaned):
                digest.update(chunk)
                size += len(chunk)
                yield chunk

        with httpx.Client(timeout=httpx.Timeout(600, connect=30)) as client:
            response = client.put(
                req.put_url,
                content=stream(),
                headers={"content-length": str(before.size)},
            )
        if response.status_code != 200:
            raise HTTPException(502, f"staging PUT failed: {response.status_code}")
        after = _stat(vol, cleaned)
        # Volumes expose no read version: stat-before / stat-after is the
        # closest equivalent of S3's CopySourceIfMatch on the source ETag.
        changed = (
            after is None
            or after.size != before.size
            or getattr(after, "mtime", None) != getattr(before, "mtime", None)
        )
        return {
            "changed": changed,
            "size": size,
            "sha256": digest.hexdigest(),
            "media_type": mimetypes.guess_type(cleaned)[0]
            or "application/octet-stream",
        }

    # Presigned-URL equivalent: the platform mints
    # sig = HMAC-SHA256(shim token, "vol\npath\nexp") and hands out this URL;
    # anyone holding it may fetch the file until exp, exactly like a
    # presigned S3 GET. Keep the TTL short.
    @web.get("/dl")
    def download(vol: str, path: str, exp: int, sig: str):
        cleaned = _clean_path(path)
        if cleaned is None:
            raise HTTPException(400, "bad path")
        now = int(time.time())
        if exp < now:
            raise HTTPException(403, "link expired")
        expected = hmac.new(
            token.encode(), f"{vol}\n{cleaned}\n{exp}".encode(), hashlib.sha256
        ).hexdigest()
        if not hmac.compare_digest(sig, expected):
            raise HTTPException(403, "bad signature")
        volume = _volume(vol)
        entry = _stat(volume, cleaned)
        if entry is None or entry.type != 1:
            raise HTTPException(404, "not found")
        from urllib.parse import quote

        filename = posixpath.basename(cleaned)
        return StreamingResponse(
            volume.read_file(cleaned),
            media_type=mimetypes.guess_type(cleaned)[0]
            or "application/octet-stream",
            headers={
                "content-length": str(entry.size),
                "content-disposition": (
                    f"attachment; filename*=UTF-8''{quote(filename)}"
                ),
            },
        )

    return web
