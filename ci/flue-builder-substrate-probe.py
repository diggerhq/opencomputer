#!/usr/bin/env python3
"""Prove the pinned Flue builder in an ordinary OpenComputer sandbox."""

from __future__ import annotations

import argparse
import base64
import importlib.util
import json
import os
from pathlib import Path
import secrets
import sys
import time
from typing import Any
from urllib import error, parse, request
import uuid


ROOT = Path(__file__).resolve().parents[1]
SNAPSHOT_MODULE_PATH = ROOT / "deploy" / "flue-builder" / "snapshot.py"
PRODUCTION_HOSTS = {"app.opencomputer.dev", "api.opencomputer.dev"}
STARTER_REPO = "https://github.com/diggerhq/oc-flue-starter.git"
STARTER_REF = "5c51d7edbbf2472fbe48386c4f9b192279330c9b"
# The sandbox lifetime must cover checkout + the independently bounded install
# and golden-build phases. A 10-minute VM expired correctly while the latter
# command was still running, which made its worker-local async handle disappear.
SANDBOX_TIMEOUT_SECONDS = 30 * 60
FORBIDDEN_CREDENTIAL_NAMES = (
    "V3_DATABASE_URL",
    "AGENTS_DATABASE_URL",
    "OPENCOMPUTER_API_KEY",
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "GITHUB_APP_PRIVATE_KEY",
    "GITHUB_APP_PRIVATE_KEY_BASE64",
    "AGENT_BUILD_SOURCE_TOKEN",
    "AGENT_BUILD_SOURCE_BROKER_SECRET",
    "AGENT_BUILD_BROKER_AUTH_SECRET",
    "AGENT_BUILD_TRIGGER_AUTH_SECRET",
    "AGENT_WORKER_WFP_API_TOKEN",
    "AGENT_WORKER_WFP_ACCOUNT_ID",
    "WFP_API_TOKEN",
    "V3_INTERNAL_AUTH_SECRET",
    "INFISICAL_TOKEN",
    "V3_SECRET_STORE_KEY",
    "CLOUDFLARE_API_TOKEN",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "REPO_ARTIFACTS_R2_ACCESS_KEY_ID",
    "REPO_ARTIFACTS_R2_SECRET_ACCESS_KEY",
    "AGENT_BUNDLES_R2_ACCESS_KEY_ID",
    "AGENT_BUNDLES_R2_SECRET_ACCESS_KEY",
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


def safe_api_url(raw: str) -> str:
    try:
        normalized = SNAPSHOT.normalize_api_url(raw)
    except SNAPSHOT.SnapshotError as exc:
        raise ProbeError(str(exc)) from exc
    parsed = parse.urlsplit(normalized)
    if parsed.scheme == "http" and os.environ.get("FLUE_BUILD_PROBE_ALLOW_HTTP") != "1":
        raise ProbeError("HTTP API URLs require FLUE_BUILD_PROBE_ALLOW_HTTP=1")
    if parsed.hostname in PRODUCTION_HOSTS and os.environ.get("FLUE_BUILD_PROBE_ALLOW_PRODUCTION") != "1":
        raise ProbeError("production probing requires FLUE_BUILD_PROBE_ALLOW_PRODUCTION=1")
    return normalized


def static_check() -> tuple[dict[str, Any], dict[str, Any]]:
    try:
        coordinate, manifest = SNAPSHOT.check_recipe()
    except SNAPSHOT.SnapshotError as exc:
        raise ProbeError(str(exc)) from exc
    if set(coordinate["snapshot"]) != {"name", "builderMemoryMB", "runtimeMemoryMB"}:
        raise ProbeError("builder coordinate must use only ordinary snapshot fields")
    if set(coordinate["attestation"]) != {
        "schemaVersion", "snapshotName", "baseImage", "platform", "node", "npm", "oc",
        "buildToolchain",
    }:
        raise ProbeError("builder attestation must contain only toolchain coordinates")
    if STARTER_REPO != "https://github.com/diggerhq/oc-flue-starter.git":
        raise ProbeError("golden starter repository coordinate has drifted")
    if len(STARTER_REF) != 40 or any(c not in "0123456789abcdef" for c in STARTER_REF):
        raise ProbeError("golden starter ref must be a lowercase commit SHA")
    return coordinate, manifest


class LiveProbe:
    def __init__(self, coordinate: dict[str, Any], manifest: dict[str, Any]):
        self.coordinate = coordinate
        self.manifest = manifest
        self.snapshot_name = coordinate["snapshot"]["name"]
        self.api_url = safe_api_url(require_env("OPENCOMPUTER_API_URL"))
        self.api_key = require_env("OPENCOMPUTER_API_KEY")
        self.api = SNAPSHOT.API(self.api_url, self.api_key)
        self.checkpoint_id = require_env("FLUE_BUILD_SANDBOX_CHECKPOINT_ID")
        try:
            uuid.UUID(self.checkpoint_id)
        except ValueError as exc:
            raise ProbeError(
                "FLUE_BUILD_SANDBOX_CHECKPOINT_ID must be a UUID from snapshot.py's receipt"
            ) from exc

        expected = coordinate["attestation"]
        configured = {
            "FLUE_BUILD_SANDBOX_SNAPSHOT": self.snapshot_name,
            "FLUE_BUILD_NODE_VERSION": expected["node"]["version"],
            "FLUE_BUILD_NPM_VERSION": expected["npm"]["version"],
            "FLUE_BUILD_OC_VERSION": expected["oc"]["version"],
            "FLUE_BUILD_OC_BINARY_SHA256": expected["oc"]["binarySha256"],
        }
        for name, expected_value in configured.items():
            if require_env(name) != expected_value:
                raise ProbeError(f"{name} does not match coordinate.json")

        self.sandboxes: list[str] = []

        # These values exist only in the trusted probe process. Sandbox request
        # bodies are constructed explicitly below and never include its env.
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

    def create_sandbox(self) -> str:
        # This is deliberately the normal public create shape. In particular it
        # carries no credentials, secret store, or feature-specific policy.
        body = {"snapshot": self.snapshot_name, "timeout": SANDBOX_TIMEOUT_SECONDS}
        _, response = self.call("POST", "/sandboxes", body, allowed_statuses={201}, timeout=180)
        if not isinstance(response, dict) or not isinstance(response.get("sandboxID"), str):
            raise ProbeError("sandbox create response is missing sandboxID")
        sandbox_id = response["sandboxID"]
        self.sandboxes.append(sandbox_id)
        if response.get("fromCheckpointId") != self.checkpoint_id:
            raise ProbeError("sandbox did not fork the pinned checkpoint")
        return sandbox_id

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
        _, handle = self.call(
            "POST",
            f"/sandboxes/{quoted}/exec/run-async",
            body,
            allowed_statuses={202},
            timeout=60,
        )
        if not isinstance(handle, dict) or not isinstance(handle.get("execId"), str):
            raise ProbeError("async exec response is missing execId")

        exec_id = parse.quote(handle["execId"], safe="")
        deadline = time.monotonic() + timeout + 60
        delay = 0.2
        while time.monotonic() < deadline:
            _, response = self.call(
                "GET",
                f"/sandboxes/{quoted}/exec/{exec_id}/result",
                allowed_statuses={200},
                timeout=30,
            )
            if not isinstance(response, dict) or not isinstance(response.get("running"), bool):
                raise ProbeError("async exec result is invalid")
            if not response["running"]:
                if response.get("error"):
                    raise ProbeError("async exec failed before returning a process result")
                if not isinstance(response.get("exitCode"), int):
                    raise ProbeError("async exec result is missing exitCode")
                return response
            time.sleep(delay)
            delay = min(delay * 2, 2.0)
        raise ProbeError("async exec result exceeded the bounded client wait")

    def exec_long(
        self,
        sandbox_id: str,
        command: str,
        args: list[str] | None = None,
        envs: dict[str, str] | None = None,
        timeout: int = 600,
    ) -> dict[str, Any]:
        """Run via the public long-lived exec-session/list contract.

        The result-handle API is suitable for short commands, but production
        workers may forget a handle during a long build. Exec sessions are the
        public reattachable/background surface; this probe needs only the exit
        code, so it polls the session list without transporting output.
        """
        body: dict[str, Any] = {
            "cmd": command,
            "args": args or [],
            "timeout": timeout,
            "maxRunAfterDisconnect": timeout + 90,
        }
        if envs is not None:
            body["envs"] = envs
        quoted = parse.quote(sandbox_id, safe="")
        _, started = self.call(
            "POST",
            f"/sandboxes/{quoted}/exec",
            body,
            allowed_statuses={200, 201, 202},
            timeout=60,
        )
        if not isinstance(started, dict) or not isinstance(started.get("sessionID"), str):
            raise ProbeError("long exec response is missing sessionID")
        session_id = started["sessionID"]
        deadline = time.monotonic() + timeout + 90
        delay = 0.2
        seen = False
        while time.monotonic() < deadline:
            _, sessions = self.call(
                "GET",
                f"/sandboxes/{quoted}/exec",
                allowed_statuses={200},
                timeout=30,
            )
            if not isinstance(sessions, list):
                raise ProbeError("long exec session list is invalid")
            current = next(
                (
                    item for item in sessions
                    if isinstance(item, dict) and item.get("sessionID") == session_id
                ),
                None,
            )
            if current is not None:
                seen = True
                if not isinstance(current.get("running"), bool):
                    raise ProbeError("long exec session state is invalid")
                if not current["running"]:
                    if not isinstance(current.get("exitCode"), int):
                        raise ProbeError("long exec session is missing exitCode")
                    return {
                        "exitCode": current["exitCode"],
                        "stdout": "",
                        "stderr": "",
                    }
            elif seen:
                raise ProbeError("long exec session disappeared")
            time.sleep(delay)
            delay = min(delay * 2, 2.0)
        try:
            encoded = parse.quote(session_id, safe="")
            self.call(
                "POST",
                f"/sandboxes/{quoted}/exec/{encoded}/kill",
                {"signal": 9},
                allowed_statuses={200, 204},
                timeout=30,
            )
        except ProbeError:
            pass
        raise ProbeError("long exec session exceeded the bounded client wait")

    def read_guest_file(self, sandbox_id: str, path: str, max_bytes: int = 512 * 1024) -> bytes:
        quoted_id = parse.quote(sandbox_id, safe="")
        quoted_path = parse.quote(path, safe="")
        req = request.Request(
            f"{self.api_url}/sandboxes/{quoted_id}/files?path={quoted_path}",
            headers={
                "Accept": "application/octet-stream",
                "User-Agent": SNAPSHOT.USER_AGENT,
                "X-API-Key": self.api_key,
            },
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
            raise ProbeError(
                f"{label} failed inside the sandbox (exit {response['exitCode']})"
            )
        return str(response.get("stdout", ""))

    def assert_builder_runtime(self, sandbox_id: str) -> None:
        javascript = r"""
const cp = require("child_process");
const fs = require("fs");
const run = (cmd, args) => cp.execFileSync(cmd, args, {encoding: "utf8"}).trim();
const marker = "/workspace/.flue-builder-probe-" + process.pid;
fs.writeFileSync(marker, "ok");
fs.unlinkSync(marker);
process.stdout.write(JSON.stringify({
  nodeVersion: process.versions.node,
  npmVersion: run("/usr/local/bin/npm", ["--version"]),
  ocVersion: run("/opt/opencomputer/bin/oc", ["--version"]),
  ocSha256: run("/usr/bin/sha256sum", ["/opt/opencomputer/bin/oc"]).split(/\s+/)[0],
  gitVersion: run("/usr/bin/git", ["--version"]),
  installerRemoved: !fs.existsSync("/tmp/opencomputer-flue-builder-install.sh"),
  workspaceWritable: true,
  attestation: JSON.parse(fs.readFileSync("/opt/opencomputer/agent-build-snapshot.json", "utf8"))
}));
""".strip()
        raw = self.expect_success(
            "builder runtime attestation",
            self.exec(sandbox_id, "node", ["-e", javascript]),
        )
        try:
            observed = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ProbeError("builder runtime attestation returned invalid JSON") from exc
        attestation = self.coordinate["attestation"]
        expected = {
            "nodeVersion": attestation["node"]["version"],
            "npmVersion": attestation["npm"]["version"],
            "ocVersion": f"oc version {attestation['oc']['sourceCommit']}",
            "ocSha256": attestation["oc"]["binarySha256"],
            "installerRemoved": True,
            "workspaceWritable": True,
            "attestation": attestation,
        }
        for key, value in expected.items():
            if observed.get(key) != value:
                raise ProbeError(f"builder runtime differs from coordinate field {key}")
        if not str(observed.get("gitVersion", "")).startswith("git version "):
            raise ProbeError("builder snapshot is missing git")

    def prove_golden_build(self, sandbox_id: str) -> None:
        prepare = r"""
set -euo pipefail
root=/workspace/flue-builder-probe
rm -rf "$root"
mkdir -p "$root" "$HOME" "$npm_config_cache"
git init -q "$root"
git -C "$root" remote add origin "$1"
git -C "$root" fetch -q --depth=1 origin "$2"
git -C "$root" checkout -q --detach FETCH_HEAD
test "$(git -C "$root" rev-parse HEAD)" = "$2"
""".strip()
        clean_env = {
            "PATH": "/opt/opencomputer/bin:/usr/local/bin:/usr/bin:/bin",
            "HOME": "/tmp/flue-probe-home",
            "npm_config_cache": "/tmp/flue-probe-npm-cache",
            "CI": "1",
            "LANG": "C.UTF-8",
            "TZ": "UTC",
        }
        self.expect_success(
            "pinned public starter checkout",
            self.exec_long(
                sandbox_id,
                "/bin/bash",
                ["-c", prepare, "probe", STARTER_REPO, STARTER_REF],
                clean_env,
                timeout=120,
            ),
        )
        self.expect_success(
            "public npm install",
            self.exec_long(
                sandbox_id,
                "/bin/bash",
                ["-c", "cd /workspace/flue-builder-probe && npm ci --no-audit --no-fund"],
                clean_env,
                timeout=600,
            ),
        )
        self.expect_success(
            "golden Flue artifact build",
            self.exec_long(
                sandbox_id,
                "/bin/bash",
                [
                    "-c",
                    "cd /workspace/flue-builder-probe && "
                    "OC_BIN=/opt/opencomputer/bin/oc npm run test:fixtures",
                ],
                clean_env,
                timeout=600,
            ),
        )

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
  if (/^[0-9]+$/.test(entry)) add("/proc/" + entry + "/environ");
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
        print("[1/7] validating immutable snapshot name, manifest, and checkpoint")
        self.validate_snapshot()

        print("[2/7] creating an ordinary disposable OpenComputer sandbox")
        sandbox_id = self.create_sandbox()

        print("[3/7] verifying the exact toolchain and writable workspace")
        self.assert_builder_runtime(sandbox_id)

        print("[4/7] checking out the pinned public starter")
        print("[5/7] running public npm install")
        print("[6/7] running the golden Flue artifact build")
        self.prove_golden_build(sandbox_id)

        print("[7/7] proving coordinator credential sentinels were not passed to the sandbox")
        self.scan_guest_for_credentials(sandbox_id)


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
                "Flue builder sandbox probe is runnable for "
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
    print("PASS: ordinary Flue build sandbox produced the golden artifact without coordinator credentials")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
