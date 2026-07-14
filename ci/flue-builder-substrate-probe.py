#!/usr/bin/env python3
"""Prove the Flue build sandbox's final network and credential topology."""

from __future__ import annotations

import argparse
import base64
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import sys
import time
from typing import Any
from urllib import error, parse, request
import uuid


ROOT = Path(__file__).resolve().parents[1]
SNAPSHOT_MODULE_PATH = ROOT / "deploy" / "flue-builder" / "snapshot.py"
PRODUCTION_HOSTS = {"app.opencomputer.dev", "api.opencomputer.dev"}
FINAL_NETWORK_POLICY = "public"
METADATA_URL = "http://169.254.169.254/v1/status"
NPM_PROBE_PACKAGE = "is-number@7.0.0"
PRIVATE_CANARY_NETWORKS = tuple(
    ipaddress.ip_network(value)
    for value in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10")
)
FORBIDDEN_CREDENTIAL_NAMES = (
    "OPENCOMPUTER_API_KEY",
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "AGENT_BUILD_SOURCE_TOKEN",
    "AGENT_BUILD_SOURCE_BROKER_SECRET",
    "AGENT_WORKER_WFP_API_TOKEN",
    "WFP_API_TOKEN",
    "CLOUDFLARE_API_TOKEN",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
)


class ProbeError(RuntimeError):
    pass


def load_snapshot_module() -> Any:
    spec = importlib.util.spec_from_file_location("flue_builder_snapshot", SNAPSHOT_MODULE_PATH)
    if spec is None or spec.loader is None:
        raise ProbeError("cannot load the snapshot recipe validator")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


SNAPSHOT = load_snapshot_module()


def require_env(name: str) -> str:
    value = os.environ.get(name, "")
    if not value:
        raise ProbeError(f"{name} is required")
    return value


def validate_private_canary(raw: str) -> str:
    parsed = parse.urlsplit(raw)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ProbeError("AGENT_BUILD_PRIVATE_CANARY_URL must be an absolute HTTP(S) URL")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ProbeError("private canary URL must not contain credentials, query, or fragment")
    try:
        address = ipaddress.ip_address(parsed.hostname)
    except ValueError as exc:
        raise ProbeError("private canary host must be a literal IPv4 address") from exc
    if address.version != 4 or not any(address in network for network in PRIVATE_CANARY_NETWORKS):
        raise ProbeError("private canary must use RFC1918 or CGNAT IPv4 space")
    return raw


def safe_api_url(raw: str) -> str:
    try:
        normalized = SNAPSHOT.normalize_api_url(raw)
    except SNAPSHOT.SnapshotError as exc:
        raise ProbeError(str(exc)) from exc
    parsed = parse.urlsplit(normalized)
    if parsed.scheme == "http" and os.environ.get("AGENT_BUILD_PROBE_ALLOW_HTTP") != "1":
        raise ProbeError("HTTP API URLs require AGENT_BUILD_PROBE_ALLOW_HTTP=1")
    if parsed.hostname in PRODUCTION_HOSTS and os.environ.get("AGENT_BUILD_PROBE_ALLOW_PRODUCTION") != "1":
        raise ProbeError("production probing requires AGENT_BUILD_PROBE_ALLOW_PRODUCTION=1")
    return normalized


def static_check() -> tuple[dict[str, Any], dict[str, Any]]:
    try:
        coordinate, manifest = SNAPSHOT.check_recipe()
    except SNAPSHOT.SnapshotError as exc:
        raise ProbeError(str(exc)) from exc
    if coordinate["snapshot"].get("networkPolicy") != FINAL_NETWORK_POLICY:
        raise ProbeError("probe requires the final networkPolicy=public topology")
    if METADATA_URL != "http://169.254.169.254/v1/status":
        raise ProbeError("probe metadata coordinate has drifted")
    if NPM_PROBE_PACKAGE != "is-number@7.0.0":
        raise ProbeError("probe npm package coordinate has drifted")
    return coordinate, manifest


class LiveProbe:
    def __init__(self, coordinate: dict[str, Any], manifest: dict[str, Any]):
        self.coordinate = coordinate
        self.manifest = manifest
        self.snapshot_name = coordinate["snapshot"]["name"]
        self.api_url = safe_api_url(require_env("OPENCOMPUTER_API_URL"))
        self.api_key = require_env("OPENCOMPUTER_API_KEY")
        self.api = SNAPSHOT.API(self.api_url, self.api_key)
        self.checkpoint_id = require_env("AGENT_BUILD_SANDBOX_CHECKPOINT_ID")
        try:
            uuid.UUID(self.checkpoint_id)
        except ValueError as exc:
            raise ProbeError(
                "AGENT_BUILD_SANDBOX_CHECKPOINT_ID must be a UUID from snapshot.py's receipt"
            ) from exc
        configured_snapshot = require_env("AGENT_BUILD_SANDBOX_SNAPSHOT")
        if configured_snapshot != self.snapshot_name:
            raise ProbeError("AGENT_BUILD_SANDBOX_SNAPSHOT does not match coordinate.json")
        expected_node = coordinate["attestation"]["node"]["version"]
        if require_env("AGENT_BUILD_NODE_VERSION") != expected_node:
            raise ProbeError("AGENT_BUILD_NODE_VERSION does not match coordinate.json")
        if os.environ.get("AGENT_BUILD_PROBE_ALLOW_UNRESTRICTED_CONTROL") != "1":
            raise ProbeError(
                "set AGENT_BUILD_PROBE_ALLOW_UNRESTRICTED_CONTROL=1 to permit the control sandbox"
            )
        self.private_canary = validate_private_canary(
            require_env("AGENT_BUILD_PRIVATE_CANARY_URL")
        )
        self.private_marker = require_env("AGENT_BUILD_PRIVATE_CANARY_EXPECT")
        if not (4 <= len(self.private_marker) <= 128) or "\n" in self.private_marker:
            raise ProbeError("private canary marker must be a 4-128 character non-secret string")
        self.sandboxes: list[str] = []

        # Put synthetic values under the real forbidden names in this trusted
        # coordinator process. The raw adapter below constructs every body
        # explicitly; none of these values may cross into the guest.
        self.sentinels: dict[str, str] = {}
        for name in FORBIDDEN_CREDENTIAL_NAMES:
            original = os.environ.get(name)
            if original and len(original) >= 12:
                self.sentinels[f"{name} (original)"] = original
            synthetic = f"flue-probe-{name.lower()}-{secrets.token_urlsafe(24)}"
            os.environ[name] = synthetic
            self.sentinels[name] = synthetic

    def call(
        self,
        method: str,
        path: str,
        body: Any | None = None,
        allowed_statuses: set[int] | None = None,
        timeout: float = 60,
    ) -> tuple[int, Any]:
        try:
            return self.api.call(method, path, body, allowed_statuses, timeout)
        except SNAPSHOT.SnapshotError as exc:
            raise ProbeError(str(exc)) from exc

    def validate_snapshot(self) -> None:
        name = parse.quote(self.snapshot_name, safe="")
        _, response = self.call("GET", f"/snapshots/{name}", allowed_statuses={200})
        try:
            snapshot = SNAPSHOT.assert_snapshot_matches(response, self.coordinate, self.manifest)
        except SNAPSHOT.SnapshotError as exc:
            raise ProbeError(str(exc)) from exc
        if snapshot.get("status") != "ready":
            raise ProbeError("pinned builder snapshot is not ready")
        if snapshot.get("checkpointId") != self.checkpoint_id:
            raise ProbeError("snapshot checkpoint differs from the immutable receipt coordinate")

    def create_sandbox(self, restricted: bool) -> tuple[str, dict[str, Any]]:
        body: dict[str, Any] = {"snapshot": self.snapshot_name, "timeout": 600}
        if restricted:
            body["networkPolicy"] = FINAL_NETWORK_POLICY
        _, response = self.call("POST", "/sandboxes", body, allowed_statuses={201}, timeout=180)
        if not isinstance(response, dict) or not isinstance(response.get("sandboxID"), str):
            raise ProbeError("sandbox create response is missing sandboxID")
        sandbox_id = response["sandboxID"]
        self.sandboxes.append(sandbox_id)
        if response.get("fromCheckpointId") != self.checkpoint_id:
            raise ProbeError("sandbox did not fork the pinned checkpoint")
        if restricted and int(response.get("hostPort") or 0) != 0:
            raise ProbeError("restricted sandbox unexpectedly received an inbound host port")
        return sandbox_id, response

    def exec(
        self,
        sandbox_id: str,
        command: str,
        args: list[str] | None = None,
        envs: dict[str, str] | None = None,
        timeout: int = 20,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {"cmd": command, "args": args or [], "timeout": timeout}
        if envs is not None:
            body["envs"] = envs
        quoted = parse.quote(sandbox_id, safe="")
        _, response = self.call(
            "POST",
            f"/sandboxes/{quoted}/exec/run",
            body,
            allowed_statuses={200},
            timeout=timeout + 20,
        )
        if not isinstance(response, dict) or not isinstance(response.get("exitCode"), int):
            raise ProbeError("exec response is missing exitCode")
        return response

    def read_guest_file(self, sandbox_id: str, path: str, max_bytes: int = 512 * 1024) -> bytes:
        quoted_id = parse.quote(sandbox_id, safe="")
        quoted_path = parse.quote(path, safe="")
        req = request.Request(
            f"{self.api_url}/sandboxes/{quoted_id}/files?path={quoted_path}",
            headers={"Accept": "application/octet-stream", "X-API-Key": self.api_key},
        )
        try:
            with self.api.opener.open(req, timeout=30) as response:
                value = response.read(max_bytes + 1)
        except (error.HTTPError, error.URLError) as exc:
            raise ProbeError(f"trusted file read could not inspect {path}") from exc
        if len(value) > max_bytes:
            raise ProbeError(f"trusted file read exceeded its bound for {path}")
        return value

    @staticmethod
    def expect_success(label: str, response: dict[str, Any]) -> str:
        if response["exitCode"] != 0:
            raise ProbeError(f"{label} failed inside the sandbox")
        return str(response.get("stdout", ""))

    @staticmethod
    def expect_transport_block(label: str, response: dict[str, Any]) -> None:
        exit_code = response["exitCode"]
        if exit_code == 0:
            raise ProbeError(f"{label} was reachable from the restricted sandbox")
        if exit_code not in {7, 28}:
            raise ProbeError(
                f"{label} failed with exit {exit_code}, not a curl connection refusal/timeout"
            )

    @staticmethod
    def curl_args(url: str) -> list[str]:
        return [
            "--noproxy",
            "*",
            "--fail",
            "--silent",
            "--show-error",
            "--connect-timeout",
            "2",
            "--max-time",
            "5",
            url,
        ]

    def assert_builder_attestation(self, sandbox_id: str) -> None:
        self.expect_success(
            "non-root runtime verifier",
            self.exec(
                sandbox_id,
                "/opt/opencomputer/bin/verify-flue-builder-runtime",
            ),
        )

        javascript = r"""
const cp = require("child_process");
const fs = require("fs");
const run = (cmd, args) => cp.execFileSync(cmd, args, {encoding: "utf8"}).trim();
const endpointPaths = [
  "/dev/virtio-ports/agent", "/dev/vport0p1", "/dev/vport1p1", "/dev/vport2p1",
  "/tmp/osb-agent.sock"
];
const result = {
  nodeVersion: process.versions.node,
  npmVersion: run("/usr/local/bin/npm", ["--version"]),
  ocVersion: run("/opt/opencomputer/bin/oc", ["--version"]),
  ocSha256: run("/usr/bin/sha256sum", ["/opt/opencomputer/bin/oc"]).split(/\s+/)[0],
  gitVersion: run("/usr/bin/git", ["--version"]),
  runtimeUid: process.getuid(),
  runtimeGid: process.getgid(),
  runtimeGroups: process.getgroups().sort((a, b) => a - b),
  nodeUid: fs.statSync("/opt/opencomputer/node-v22.19.0/bin/node").uid,
  nodeMode: fs.statSync("/opt/opencomputer/node-v22.19.0/bin/node").mode & 0o777,
  ocUid: fs.statSync("/opt/opencomputer/bin/oc").uid,
  ocMode: fs.statSync("/opt/opencomputer/bin/oc").mode & 0o777,
  verifierUid: fs.statSync("/opt/opencomputer/bin/verify-flue-builder-runtime").uid,
  verifierMode: fs.statSync("/opt/opencomputer/bin/verify-flue-builder-runtime").mode & 0o777,
  attestationUid: fs.statSync("/opt/opencomputer/agent-build-snapshot.json").uid,
  attestationMode: fs.statSync("/opt/opencomputer/agent-build-snapshot.json").mode & 0o777,
  sudoPresent: fs.existsSync("/usr/bin/sudo") || fs.existsSync("/bin/sudo"),
  agentEndpoints: endpointPaths.filter((path) => fs.existsSync(path)).map((path) => {
    const stat = fs.statSync(path);
    return {path, uid: stat.uid, mode: stat.mode & 0o777};
  }),
  installerRemoved: !fs.existsSync("/tmp/opencomputer-flue-builder-install.sh"),
  attestation: JSON.parse(fs.readFileSync("/opt/opencomputer/agent-build-snapshot.json", "utf8"))
};
process.stdout.write(JSON.stringify(result));
""".strip()
        raw = self.expect_success(
            "builder attestation", self.exec(sandbox_id, "node", ["-e", javascript])
        )
        try:
            observed = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ProbeError("builder attestation command returned invalid JSON") from exc
        attestation = self.coordinate["attestation"]
        expected = {
            "nodeVersion": attestation["node"]["version"],
            "npmVersion": attestation["npm"]["version"],
            "ocSha256": attestation["oc"]["binarySha256"],
            "runtimeUid": attestation["security"]["runtimeUid"],
            "runtimeGid": attestation["security"]["runtimeGid"],
            "runtimeGroups": [attestation["security"]["runtimeGid"]],
            "nodeUid": 0,
            "nodeMode": 0o755,
            "ocUid": 0,
            "ocMode": 0o555,
            "verifierUid": 0,
            "verifierMode": 0o555,
            "attestationUid": 0,
            "attestationMode": 0o444,
            "sudoPresent": False,
            "attestation": attestation,
        }
        for key, value in expected.items():
            if observed.get(key) != value:
                raise ProbeError(f"builder runtime differs from coordinate field {key}")
        expected_oc_version = f"oc version {attestation['oc']['sourceCommit']}"
        if observed.get("ocVersion") != expected_oc_version:
            raise ProbeError("builder oc --version differs from the pinned source commit")
        if not str(observed.get("gitVersion", "")).startswith("git version "):
            raise ProbeError("builder snapshot is missing git")
        if observed.get("installerRemoved") is not True:
            raise ProbeError("builder installer was left in the runtime snapshot")
        endpoints = observed.get("agentEndpoints")
        if not isinstance(endpoints, list):
            raise ProbeError("builder endpoint attestation is invalid")
        for endpoint in endpoints:
            if (
                not isinstance(endpoint, dict)
                or endpoint.get("uid") != 0
                or endpoint.get("mode") != 0o600
            ):
                raise ProbeError("a guest agent transport node is accessible to repository code")

        self.prove_guest_agent_isolation(sandbox_id)

    def prove_guest_agent_isolation(self, sandbox_id: str) -> None:
        # osb-agent is PID 1 and its unauthenticated RPC surface includes root
        # exec, root file writes, and binary upgrade. This adversarial probe
        # runs as uid 1000. It sends an HTTP/2 client preface to guest-local
        # AF_VSOCK/Unix endpoints and fails if the root gRPC server answers;
        # it also attempts to open every known virtio-serial agent device.
        python = r'''
import array
import fcntl
import glob
import json
import os
import socket
import sys

HTTP2_PREFACE = b"PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n"
EMPTY_SETTINGS = b"\x00\x00\x00\x04\x00\x00\x00\x00\x00"
failures = []
checked = []

def root_grpc_answered(sock):
    sock.settimeout(1.0)
    sock.sendall(HTTP2_PREFACE + EMPTY_SETTINGS)
    try:
        return bool(sock.recv(9))
    except (ConnectionError, OSError, TimeoutError):
        return False

if hasattr(socket, "AF_VSOCK"):
    cids = {getattr(socket, "VMADDR_CID_LOCAL", 1)}
    try:
        values = array.array("I", [0])
        with open("/dev/vsock", "rb", buffering=0) as device:
            fcntl.ioctl(device.fileno(), 0x7B9, values, True)
        cids.add(values[0])
    except OSError:
        pass
    for cid in sorted(cids):
        checked.append(f"vsock:{cid}:1024")
        client = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
        client.settimeout(1.0)
        try:
            client.connect((cid, 1024))
            if root_grpc_answered(client):
                failures.append(f"vsock:{cid}:1024")
        except OSError:
            pass
        finally:
            client.close()

devices = sorted(set(
    glob.glob("/dev/virtio-ports/agent")
    + glob.glob("/dev/vport0p1")
    + glob.glob("/dev/vport1p1")
    + glob.glob("/dev/vport2p1")
))
for path in devices:
    checked.append(path)
    try:
        descriptor = os.open(path, os.O_RDWR | os.O_NONBLOCK)
    except OSError:
        continue
    else:
        os.close(descriptor)
        failures.append(path)

unix_path = "/tmp/osb-agent.sock"
if os.path.exists(unix_path):
    checked.append(unix_path)
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    client.settimeout(1.0)
    try:
        client.connect(unix_path)
        if root_grpc_answered(client):
            failures.append(unix_path)
    except OSError:
        pass
    finally:
        client.close()

print(json.dumps({"checked": checked, "failures": failures}, sort_keys=True))
if failures:
    sys.exit(42)
'''.strip()
        response = self.exec(
            sandbox_id,
            "/usr/bin/python3",
            ["-c", python],
            timeout=15,
        )
        if response["exitCode"] != 0:
            raise ProbeError("repository code reached a root guest-agent control transport")
        try:
            result = json.loads(str(response.get("stdout", "")))
        except json.JSONDecodeError as exc:
            raise ProbeError("guest-agent isolation probe returned invalid JSON") from exc
        if not isinstance(result.get("checked"), list) or result.get("failures") != []:
            raise ProbeError("guest-agent isolation probe returned an invalid result")

    def prove_control_paths(self, sandbox_id: str) -> None:
        private = self.expect_success(
            "private control canary",
            self.exec(sandbox_id, "curl", self.curl_args(self.private_canary)),
        )
        if self.private_marker not in private:
            raise ProbeError("private control canary did not return its expected non-secret marker")

        metadata = self.expect_success(
            "metadata control path",
            self.exec(
                sandbox_id,
                "curl",
                self.curl_args(METADATA_URL),
            ),
        )
        if not metadata.strip():
            raise ProbeError("metadata control path returned an empty response")

        host_script = r'''
set -euo pipefail
gateway="$(ip -4 route show default | awk 'NR == 1 {print $3}')"
test -n "$gateway"
curl --noproxy '*' --fail --silent --show-error --connect-timeout 2 --max-time 5 "http://${gateway}:8888/"
'''.strip()
        host = self.expect_success(
            "guest-to-host control path",
            self.exec(sandbox_id, "/bin/bash", ["-c", host_script]),
        )
        if not host.strip():
            raise ProbeError("guest-to-host control path returned an empty response")

    def prove_public_npm(self, sandbox_id: str) -> None:
        script = r'''
set -euo pipefail
mkdir -p "$HOME" "$npm_config_cache"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cd "$work"
package="$(npm pack --ignore-scripts --silent "$1")"
test -s "$package"
sha256sum "$package" >/dev/null
'''.strip()
        clean_env = {
            "PATH": "/opt/opencomputer/bin:/usr/local/bin:/usr/bin:/bin",
            "HOME": "/tmp/flue-probe-home",
            "npm_config_cache": "/tmp/flue-probe-npm-cache",
            "CI": "1",
            "LANG": "C.UTF-8",
            "TZ": "UTC",
        }
        self.expect_success(
            "public npm registry and tarball",
            self.exec(
                sandbox_id,
                "/bin/bash",
                ["-c", script, "probe", NPM_PROBE_PACKAGE],
                clean_env,
                timeout=90,
            ),
        )

    def prove_restricted_paths(self, sandbox_id: str) -> None:
        self.expect_transport_block(
            "private service canary",
            self.exec(sandbox_id, "curl", self.curl_args(self.private_canary)),
        )
        self.expect_transport_block(
            "link-local metadata service",
            self.exec(
                sandbox_id,
                "curl",
                self.curl_args(METADATA_URL),
            ),
        )
        host_script = r'''
set -euo pipefail
gateway="$(ip -4 route show default | awk 'NR == 1 {print $3}')"
test -n "$gateway"
curl --noproxy '*' --fail --silent --show-error --connect-timeout 2 --max-time 5 "http://${gateway}:8888/"
'''.strip()
        self.expect_transport_block(
            "guest-to-host service",
            self.exec(sandbox_id, "/bin/bash", ["-c", host_script]),
        )

    def start_inbound_test_server(self, sandbox_id: str) -> None:
        javascript = (
            'require("http").createServer((_,res)=>res.end("flue-probe-ok"))'
            '.listen(32123,"0.0.0.0");setInterval(()=>{},60000);'
        )
        start_script = (
            "set -euo pipefail; "
            "setsid node -e \"$1\" >/tmp/flue-probe-http.log 2>&1 </dev/null & "
            "echo $! >/tmp/flue-probe-http.pid"
        )
        self.expect_success(
            "local inbound test server start",
            self.exec(sandbox_id, "/bin/bash", ["-c", start_script, "probe", javascript]),
        )
        readiness_script = r'''
set -euo pipefail
for _ in $(seq 1 30); do
  if value="$(curl --noproxy '*' --fail --silent --connect-timeout 1 --max-time 2 "$1")"; then
    printf '%s' "$value"
    exit 0
  fi
  sleep 0.1
done
exit 1
'''.strip()
        loopback = self.expect_success(
            "local inbound test server loopback",
            self.exec(
                sandbox_id,
                "/bin/bash",
                ["-c", readiness_script, "probe", "http://127.0.0.1:32123/"],
            ),
        )
        if loopback.strip() != "flue-probe-ok":
            raise ProbeError("local inbound test server did not become ready")

    @staticmethod
    def public_preview_body(hostname: str) -> bytes:
        if not re.fullmatch(r"[A-Za-z0-9.-]+", hostname) or "." not in hostname:
            raise ProbeError("preview API returned an invalid hostname")
        opener = request.build_opener(SNAPSHOT.NoCredentialRedirect())
        req = request.Request(f"https://{hostname}/", headers={"Accept": "text/plain"})
        try:
            with opener.open(req, timeout=5) as response:
                return response.read(4096)
        except error.HTTPError as exc:
            return exc.read(4096)
        except error.URLError:
            return b""

    def prove_control_inbound(self, sandbox_id: str) -> None:
        self.start_inbound_test_server(sandbox_id)
        quoted = parse.quote(sandbox_id, safe="")
        _, preview = self.call(
            "POST",
            f"/sandboxes/{quoted}/preview",
            {"port": 32123},
            allowed_statuses={200, 201},
        )
        if not isinstance(preview, dict) or not isinstance(preview.get("hostname"), str):
            raise ProbeError("control preview response is missing hostname")
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if self.public_preview_body(preview["hostname"]).strip() == b"flue-probe-ok":
                return
            time.sleep(1)
        raise ProbeError("unrestricted control preview never reached its live guest server")

    def prove_inbound_disabled(self, sandbox_id: str, create_response: dict[str, Any]) -> None:
        self.start_inbound_test_server(sandbox_id)
        quoted = parse.quote(sandbox_id, safe="")
        status, _ = self.call(
            "POST",
            f"/sandboxes/{quoted}/preview",
            {"port": 32123},
            allowed_statuses={409},
        )
        if status != 409:
            raise ProbeError("restricted sandbox preview creation was not rejected")

        sandbox_domain = create_response.get("sandboxDomain")
        if not isinstance(sandbox_domain, str) or not sandbox_domain:
            raise ProbeError("restricted sandbox response is missing sandboxDomain")
        hostname = f"{sandbox_id}-p32123.{sandbox_domain}"
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if self.public_preview_body(hostname).strip() == b"flue-probe-ok":
                raise ProbeError("restricted sandbox guest server was reachable through public ingress")
            time.sleep(1)

    def scan_guest_for_credentials(self, sandbox_id: str) -> None:
        javascript = r"""
const fs = require("fs");
const path = require("path");
const chunks = [Buffer.from(JSON.stringify(process.env))];
const seen = ["process.env"];
let total = chunks[0].length;
const MAX_TOTAL = 384 * 1024;
const add = (candidate) => {
  if (total >= MAX_TOTAL) return;
  try {
    const stat = fs.statSync(candidate);
    if (!stat.isFile()) return;
    const value = fs.readFileSync(candidate).subarray(0, Math.min(stat.size, 64 * 1024));
    chunks.push(Buffer.from("\n" + candidate + "\n"));
    chunks.push(value);
    seen.push(candidate);
    total += value.length + candidate.length + 2;
  } catch (_) {}
};
for (const candidate of [
  "/etc/environment", "/etc/profile", "/etc/bash.bashrc", "/etc/npmrc",
  "/root/.npmrc", "/root/.config/npm/npmrc",
  "/home/sandbox/.npmrc", "/home/sandbox/.config/npm/npmrc",
  "/home/oai/share/.npmrc", "/opt/opencomputer/agent-build-snapshot.json"
]) add(candidate);
try {
  for (const candidate of fs.readdirSync("/etc/profile.d")) add(path.join("/etc/profile.d", candidate));
} catch (_) {}
for (const entry of fs.readdirSync("/proc")) {
  if (/^[0-9]+$/.test(entry)) add(`/proc/${entry}/environ`);
}
process.stdout.write(JSON.stringify({
  payload: Buffer.concat(chunks).subarray(0, MAX_TOTAL).toString("base64"),
  seen
}));
""".strip()
        raw_result = self.expect_success(
            "credential sentinel scan",
            self.exec(sandbox_id, "node", ["-e", javascript], timeout=30),
        ).strip()
        try:
            scan = json.loads(raw_result)
            guest_bytes = base64.b64decode(scan["payload"], validate=True)
            seen = set(scan["seen"])
        except (json.JSONDecodeError, KeyError, TypeError, ValueError) as exc:
            raise ProbeError("credential sentinel scan returned an invalid result") from exc
        for required in ("process.env", "/opt/opencomputer/agent-build-snapshot.json"):
            if required not in seen:
                raise ProbeError(f"credential sentinel scan could not inspect {required}")

        # Exec correctly runs as the unprivileged repository user. The trusted
        # coordinator's file API is serviced by PID 1 and can still inspect
        # PID 1's environment without restoring sudo to repository code.
        guest_bytes += b"\n/proc/1/environ\n" + self.read_guest_file(
            sandbox_id, "/proc/1/environ"
        )

        matches: list[str] = []
        for name, value in self.sentinels.items():
            raw = value.encode()
            variants = {
                raw,
                base64.b64encode(raw),
                base64.urlsafe_b64encode(raw),
                base64.urlsafe_b64encode(raw).rstrip(b"="),
            }
            if any(variant and variant in guest_bytes for variant in variants):
                matches.append(name)
        if matches:
            # Names are safe diagnostics. Never print the matching values or
            # the guest blob, which could itself contain unrelated secrets.
            raise ProbeError("credential sentinel values reached the guest: " + ", ".join(matches))

    def destroy_all(self) -> list[str]:
        failures: list[str] = []
        while self.sandboxes:
            sandbox_id = self.sandboxes.pop()
            quoted = parse.quote(sandbox_id, safe="")
            try:
                self.call("DELETE", f"/sandboxes/{quoted}", allowed_statuses={200, 204}, timeout=60)
            except ProbeError:
                failures.append(sandbox_id)
        return failures

    def run(self) -> None:
        print("[1/8] validating immutable snapshot name, manifest, and checkpoint")
        self.validate_snapshot()

        print("[2/8] creating unrestricted control sandbox (explicitly authorized)")
        control_id, _ = self.create_sandbox(restricted=False)
        self.assert_builder_attestation(control_id)

        print("[3/8] proving private, metadata, and guest-host control targets are live")
        self.prove_control_paths(control_id)
        self.prove_control_inbound(control_id)

        print("[4/8] creating final-topology networkPolicy=public sandbox")
        restricted_id, restricted_response = self.create_sandbox(restricted=True)
        self.assert_builder_attestation(restricted_id)

        print("[5/8] proving public npm registry and package tarball egress")
        self.prove_public_npm(restricted_id)

        print("[6/8] proving private, link-local/metadata, and guest-host denial")
        self.prove_restricted_paths(restricted_id)

        print("[7/8] proving inbound host-port and preview paths are disabled")
        self.prove_inbound_disabled(restricted_id, restricted_response)

        print("[8/8] proving coordinator credential sentinels are absent from the guest")
        self.scan_guest_for_credentials(restricted_id)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true", help="validate the probe and recipe offline")
    mode.add_argument("--run", action="store_true", help="run the guarded real-sandbox proof")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    probe: LiveProbe | None = None
    cleanup_failures: list[str] = []
    try:
        coordinate, manifest = static_check()
        if args.check:
            print(
                "Flue builder substrate probe is runnable for "
                f"{coordinate['snapshot']['name']} ({coordinate['recipe']['materializedManifestSha256']})"
            )
            return 0
        probe = LiveProbe(coordinate, manifest)
        probe.run()
    except (ProbeError, SNAPSHOT.SnapshotError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    finally:
        if probe is not None:
            cleanup_failures = probe.destroy_all()
            if cleanup_failures:
                print(
                    "warning: failed to destroy probe sandboxes: " + ", ".join(cleanup_failures),
                    file=sys.stderr,
                )
    if cleanup_failures:
        return 1
    print("PASS: final Flue build topology permits public npm only and exposes no credential sentinels")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
