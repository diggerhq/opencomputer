#!/usr/bin/env python3
"""Validate or explicitly create the immutable Flue builder snapshot."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from typing import Any
from urllib import error, parse, request


ROOT = Path(__file__).resolve().parent
COORDINATE_PATH = ROOT / "coordinate.json"
PRODUCTION_HOSTS = {"app.opencomputer.dev", "api.opencomputer.dev"}


class SnapshotError(RuntimeError):
    pass


class NoCredentialRedirect(request.HTTPRedirectHandler):
    """Never forward the operator API key to a redirected origin."""

    def redirect_request(self, req: Any, fp: Any, code: int, msg: str, headers: Any, newurl: str) -> None:
        return None


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def canonical_json(value: Any) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def load_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise SnapshotError(f"cannot read valid JSON from {path}: {exc}") from exc


def materialize_manifest() -> dict[str, Any]:
    template_path = ROOT / "image.json"
    template = load_json(template_path)
    if not isinstance(template, dict) or not isinstance(template.get("steps"), list):
        raise SnapshotError("image.json must contain an object with a steps array")

    # Round-trip to make a deep copy composed only of JSON values.
    manifest = json.loads(json.dumps(template))
    for index, step in enumerate(manifest["steps"]):
        if not isinstance(step, dict) or not isinstance(step.get("args"), dict):
            raise SnapshotError(f"image step {index} must contain an args object")
        args = step["args"]
        source_name = args.pop("contentFrom", None)
        if source_name is None:
            continue
        if step.get("type") != "add_file":
            raise SnapshotError(f"image step {index} uses contentFrom outside add_file")
        source = (ROOT / str(source_name)).resolve()
        if source.parent != ROOT or not source.is_file():
            raise SnapshotError(f"image step {index} contentFrom must name a file in {ROOT}")
        if "content" in args:
            raise SnapshotError(f"image step {index} cannot contain content and contentFrom")
        args["content"] = base64.b64encode(source.read_bytes()).decode("ascii")

    return manifest


def check_recipe() -> tuple[dict[str, Any], dict[str, Any]]:
    coordinate = load_json(COORDINATE_PATH)
    manifest = materialize_manifest()
    if not isinstance(coordinate, dict) or coordinate.get("schemaVersion") != 1:
        raise SnapshotError("coordinate.json schemaVersion must be 1")

    snapshot = coordinate.get("snapshot")
    recipe = coordinate.get("recipe")
    expected_attestation = coordinate.get("attestation")
    if not all(isinstance(value, dict) for value in (snapshot, recipe, expected_attestation)):
        raise SnapshotError("coordinate.json is missing snapshot, recipe, or attestation")

    installer_name = recipe.get("installer")
    template_name = recipe.get("imageTemplate")
    if installer_name != "install-snapshot.sh" or template_name != "image.json":
        raise SnapshotError("coordinate recipe must use the repository-owned installer and image template")

    installer_path = ROOT / installer_name
    template_path = ROOT / template_name
    observed = {
        "installerSha256": sha256_bytes(installer_path.read_bytes()),
        "imageTemplateSha256": sha256_bytes(template_path.read_bytes()),
        "materializedManifestSha256": sha256_bytes(canonical_json(manifest)),
    }
    for key, value in observed.items():
        expected = recipe.get(key)
        if expected != value:
            raise SnapshotError(f"coordinate recipe {key} is {expected!r}; expected {value}")

    if snapshot.get("name") != expected_attestation.get("snapshotName"):
        raise SnapshotError("snapshot name and attestation snapshotName differ")
    if snapshot.get("networkPolicy") != "public":
        raise SnapshotError("the Flue builder snapshot must declare networkPolicy=public")
    if manifest.get("base") != expected_attestation.get("baseImage"):
        raise SnapshotError("image base and attestation baseImage differ")
    for key in ("builderMemoryMB", "runtimeMemoryMB"):
        if manifest.get(key) != snapshot.get(key):
            raise SnapshotError(f"manifest and coordinate disagree on {key}")

    syntax = subprocess.run(
        ["bash", "-n", str(installer_path)],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    if syntax.returncode != 0:
        raise SnapshotError(f"install-snapshot.sh fails bash -n: {syntax.stderr.strip()}")

    emitted = subprocess.run(
        ["bash", str(installer_path), "coordinate"],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    if emitted.returncode != 0:
        raise SnapshotError(f"installer coordinate failed: {emitted.stderr.strip()}")
    try:
        actual_attestation = json.loads(emitted.stdout)
    except json.JSONDecodeError as exc:
        raise SnapshotError("installer coordinate did not emit valid JSON") from exc
    if actual_attestation != expected_attestation:
        raise SnapshotError("installer attestation and coordinate.json attestation differ")

    return coordinate, manifest


def normalize_api_url(raw: str) -> str:
    parsed = parse.urlsplit(raw.strip())
    if parsed.scheme not in {"https", "http"} or not parsed.hostname:
        raise SnapshotError("API URL must be an absolute HTTP(S) URL")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise SnapshotError("API URL must not contain credentials, query, or fragment")
    path = parsed.path.rstrip("/")
    if path not in {"", "/api"}:
        raise SnapshotError("API URL path must be empty or /api")
    return parse.urlunsplit((parsed.scheme, parsed.netloc, "/api", "", ""))


class API:
    def __init__(self, api_url: str, api_key: str):
        self.api_url = normalize_api_url(api_url)
        self.api_key = api_key
        self.opener = request.build_opener(NoCredentialRedirect())

    def call(
        self,
        method: str,
        path: str,
        body: Any | None = None,
        allowed_statuses: set[int] | None = None,
        timeout: float = 60,
    ) -> tuple[int, Any]:
        allowed = allowed_statuses or {200}
        payload = None if body is None else canonical_json(body)
        headers = {"Accept": "application/json", "X-API-Key": self.api_key}
        if payload is not None:
            headers["Content-Type"] = "application/json"
        req = request.Request(
            f"{self.api_url}{path}", data=payload, headers=headers, method=method
        )
        try:
            with self.opener.open(req, timeout=timeout) as response:
                status = response.status
                raw = response.read()
        except error.HTTPError as exc:
            status = exc.code
            raw = exc.read()
        except error.URLError as exc:
            raise SnapshotError(f"OpenComputer API request failed: {exc.reason}") from exc
        if status not in allowed:
            # Snapshot responses never need to echo caller secrets. Bound the
            # diagnostic anyway so a proxy cannot flood operator output.
            detail = raw.decode("utf-8", "replace")[:500]
            if self.api_key:
                detail = detail.replace(self.api_key, "[REDACTED]")
            raise SnapshotError(f"OpenComputer API {method} {path} returned {status}: {detail}")
        if not raw:
            return status, None
        try:
            return status, json.loads(raw)
        except json.JSONDecodeError as exc:
            raise SnapshotError(f"OpenComputer API {method} {path} returned invalid JSON") from exc


def response_manifest(snapshot: dict[str, Any]) -> dict[str, Any]:
    value = snapshot.get("manifest")
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError as exc:
            raise SnapshotError("snapshot response manifest is invalid JSON") from exc
    if not isinstance(value, dict):
        raise SnapshotError("snapshot response is missing an object manifest")
    return value


def assert_snapshot_matches(
    response: Any, coordinate: dict[str, Any], manifest: dict[str, Any]
) -> dict[str, Any]:
    if not isinstance(response, dict):
        raise SnapshotError("snapshot response must be an object")
    expected_name = coordinate["snapshot"]["name"]
    if response.get("name") != expected_name:
        raise SnapshotError("snapshot response name does not match the pinned coordinate")
    if canonical_json(response_manifest(response)) != canonical_json(manifest):
        raise SnapshotError("existing snapshot manifest differs from the pinned recipe; use a new name")
    return response


def write_receipt(path: Path, response: dict[str, Any], coordinate: dict[str, Any]) -> None:
    checkpoint_id = response.get("checkpointId")
    if not isinstance(checkpoint_id, str) or not checkpoint_id:
        raise SnapshotError("ready snapshot response is missing checkpointId")
    receipt = {
        "schemaVersion": 1,
        "snapshotName": coordinate["snapshot"]["name"],
        "checkpointId": checkpoint_id,
        "snapshotId": response.get("id"),
        "materializedManifestSha256": coordinate["recipe"]["materializedManifestSha256"],
        "observedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    path = path.resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("wb", dir=path.parent, delete=False) as handle:
        handle.write(canonical_json(receipt))
        temporary = Path(handle.name)
    os.replace(temporary, path)


def create_snapshot(args: argparse.Namespace) -> None:
    coordinate, manifest = check_recipe()
    expected_name = coordinate["snapshot"]["name"]
    if args.confirm_name != expected_name:
        raise SnapshotError(f"--confirm-name must exactly equal {expected_name}")
    if os.environ.get("AGENT_BUILD_SNAPSHOT_ALLOW_CREATE") != "1":
        raise SnapshotError("set AGENT_BUILD_SNAPSHOT_ALLOW_CREATE=1 to permit snapshot creation")

    api_url = args.api_url or os.environ.get("OPENCOMPUTER_API_URL", "")
    if not api_url:
        raise SnapshotError("provide --api-url or OPENCOMPUTER_API_URL")
    normalized = normalize_api_url(api_url)
    parsed = parse.urlsplit(normalized)
    if parsed.scheme == "http" and os.environ.get("AGENT_BUILD_SNAPSHOT_ALLOW_HTTP") != "1":
        raise SnapshotError("HTTP API URLs require AGENT_BUILD_SNAPSHOT_ALLOW_HTTP=1")
    if parsed.hostname in PRODUCTION_HOSTS and os.environ.get("AGENT_BUILD_SNAPSHOT_ALLOW_PRODUCTION") != "1":
        raise SnapshotError("production snapshot creation requires AGENT_BUILD_SNAPSHOT_ALLOW_PRODUCTION=1")

    api_key = os.environ.get(args.api_key_env, "")
    if not api_key:
        raise SnapshotError(f"{args.api_key_env} is required")
    api = API(normalized, api_key)
    quoted_name = parse.quote(expected_name, safe="")

    status, current = api.call("GET", f"/snapshots/{quoted_name}", allowed_statuses={200, 404})
    if status == 404:
        print(f"Creating immutable builder snapshot {expected_name}")
        _, current = api.call(
            "POST",
            "/snapshots?async=1",
            {"name": expected_name, "image": manifest},
            allowed_statuses={202},
        )
    else:
        print(f"Snapshot {expected_name} already exists; validating it without mutation")
    current = assert_snapshot_matches(current, coordinate, manifest)

    deadline = time.monotonic() + args.timeout_seconds
    while current.get("status") == "building":
        if time.monotonic() >= deadline:
            raise SnapshotError("timed out waiting for snapshot build")
        time.sleep(args.poll_seconds)
        _, current = api.call("GET", f"/snapshots/{quoted_name}", allowed_statuses={200})
        current = assert_snapshot_matches(current, coordinate, manifest)

    if current.get("status") != "ready":
        raise SnapshotError(f"snapshot ended in status {current.get('status')!r}")
    write_receipt(Path(args.receipt), current, coordinate)
    print(f"Snapshot is ready; immutable checkpoint receipt written to {args.receipt}")
    print("Set AGENT_BUILD_SANDBOX_CHECKPOINT_ID from that receipt before running the substrate probe.")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("check", help="validate all local recipe pins without network access")

    create = subparsers.add_parser("create", help="explicitly create or validate the pinned snapshot")
    create.add_argument("--api-url", help="OpenComputer URL; defaults to OPENCOMPUTER_API_URL")
    create.add_argument("--api-key-env", default="OPENCOMPUTER_API_KEY")
    create.add_argument("--confirm-name", required=True)
    create.add_argument("--receipt", required=True)
    create.add_argument("--timeout-seconds", type=int, default=1800)
    create.add_argument("--poll-seconds", type=float, default=5)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        if args.command == "check":
            coordinate, _ = check_recipe()
            print(
                "Flue builder snapshot recipe is pinned: "
                f"{coordinate['snapshot']['name']} "
                f"({coordinate['recipe']['materializedManifestSha256']})"
            )
        else:
            create_snapshot(args)
    except SnapshotError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
