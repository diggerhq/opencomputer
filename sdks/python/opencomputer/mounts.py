"""FUSE-backed remote filesystem mounts inside a sandbox.

Mounts use ``rclone mount`` under the hood — one driver covering ~40 backends
(S3, GCS, Azure Blob, SFTP, WebDAV, Dropbox, etc.). Credentials are passed
inline, written to a tmpfs file inside the VM (mode 0600), and never persisted
on the worker. v1 does NOT auto-restore mounts on hibernate/wake — callers
re-issue ``add(...)`` after a wake if they need the mount back.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

import httpx

MountBackend = Literal["s3", "gcs", "azureblob", "sftp", "webdav", "dropbox"]


@dataclass
class MountInfo:
    """An active mount as tracked by the worker.

    ``rclone_version`` is the rclone version inside the sandbox captured at
    mount-add time (e.g. ``"v1.65.2"``). rclone is baked into the rootfs, so
    different sandboxes may carry different versions; this lets ops triage
    backend-specific bug reports quickly.
    """

    path: str
    remote: str
    read_only: bool
    backend: str = ""
    rclone_version: str = ""


@dataclass
class Mounts:
    """Mount remote filesystems via rclone+FUSE inside the sandbox."""

    _client: httpx.AsyncClient
    _sandbox_id: str

    async def add(
        self,
        path: str,
        remote: str,
        backend: MountBackend | None = None,
        creds: dict[str, str] | None = None,
        rclone_config: str | None = None,
        read_only: bool = True,
        mount_options: list[str] | None = None,
    ) -> MountInfo:
        """Mount a remote filesystem at ``path`` inside the sandbox.

        Args:
            path: Absolute path inside the VM where the remote will be mounted.
            remote: rclone remote spec — ``"<name>:<path>"`` (e.g. ``"s3:my-bucket/prefix"``).
            backend: One of ``s3``, ``gcs``, ``azureblob``, ``sftp``, ``webdav``,
                ``dropbox``. Determines how ``creds`` are templated into the
                rclone config. Omit when passing ``rclone_config`` directly.
            creds: Backend-specific config keys (rclone field names — e.g. for
                S3: ``access_key_id``, ``secret_access_key``, ``region``).
            rclone_config: Raw rclone config string. Overrides ``backend`` and
                ``creds`` — useful for backends not in the typed list or for
                advanced tuning.
            read_only: Default ``True``. Object-store FUSE mounts have
                well-known write footguns; opt in to RW explicitly.
            mount_options: Extra args appended to ``rclone mount`` (e.g.
                ``["--dir-cache-time", "1m"]``).
        """
        body: dict[str, object] = {
            "path": path,
            "remote": remote,
            "readOnly": read_only,
        }
        if backend is not None:
            body["backend"] = backend
        if creds is not None:
            body["creds"] = creds
        if rclone_config is not None:
            body["rcloneConfig"] = rclone_config
        if mount_options is not None:
            body["mountOptions"] = mount_options

        resp = await self._client.post(
            f"/sandboxes/{self._sandbox_id}/mounts", json=body
        )
        resp.raise_for_status()
        data = resp.json()
        return _mount_from_dict(data)

    async def list(self) -> list[MountInfo]:
        """List the mounts this worker is tracking for the sandbox.

        Returns empty after hibernate/wake — re-issue ``add()`` for any mounts
        you need back.
        """
        resp = await self._client.get(f"/sandboxes/{self._sandbox_id}/mounts")
        resp.raise_for_status()
        data = resp.json() or []
        return [_mount_from_dict(entry) for entry in data]

    async def remove(self, path: str) -> None:
        """Unmount a path previously passed to ``add()``. No-op if not mounted."""
        try:
            resp = await self._client.delete(
                f"/sandboxes/{self._sandbox_id}/mounts", params={"path": path}
            )
            if resp.status_code == 404:
                return
            resp.raise_for_status()
        except httpx.HTTPError:
            raise


def _mount_from_dict(data: dict) -> MountInfo:
    return MountInfo(
        path=data["path"],
        remote=data["remote"],
        backend=data.get("backend", ""),
        read_only=data.get("readOnly", True),
        rclone_version=data.get("rcloneVersion", ""),
    )
