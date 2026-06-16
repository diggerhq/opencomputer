"""FUSE-backed filesystem mounts inside a sandbox.

Two drivers:

- ``rclone`` (default, via :meth:`Mounts.add`): wrap any of rclone's ~40
  backends (S3, GCS, Azure Blob, SFTP, WebDAV, Dropbox, …) behind a simple
  remote+creds shape. Creds are written to a tmpfs file (mode 0600), never
  persisted on the worker.
- ``command`` (via :meth:`Mounts.add_command`): run your own FUSE daemon /
  mount command. Use this when you already have a FUSE-ready filesystem and
  don't want rclone as a middle layer. Secrets are injected into the daemon's
  process env (never the command line) and never persisted.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

import httpx

MountBackend = Literal["s3", "gcs", "azureblob", "sftp", "webdav", "dropbox"]


@dataclass
class MountInfo:
    """An active mount as tracked by the worker.

    ``rclone_version`` (rclone driver) is the rclone version inside the sandbox
    captured at mount-add time (e.g. ``"v1.65.2"``). rclone is baked into the
    rootfs, so different sandboxes may carry different versions; this lets ops
    triage backend-specific bug reports quickly.
    """

    path: str
    read_only: bool
    driver: str = "rclone"
    # rclone driver
    remote: str = ""
    backend: str = ""
    rclone_version: str = ""
    # command driver
    command: list[str] = field(default_factory=list)
    env: dict[str, str] = field(default_factory=dict)


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

    async def add_command(
        self,
        path: str,
        command: list[str],
        env: dict[str, str] | None = None,
        secrets: dict[str, str] | None = None,
        read_only: bool = True,
    ) -> MountInfo:
        """Mount a filesystem by running your own FUSE daemon / mount command.

        Use this when you already have a FUSE-ready filesystem (your own VFS,
        gcsfuse, s3fs, …) and don't want rclone as a middle layer. The platform
        manages the mountpoint, env/secret injection, and teardown; ``command``
        establishes the mount.

        Args:
            path: Absolute mountpoint inside the VM.
            command: argv for the FUSE daemon. Any ``"{mountpoint}"`` token is
                replaced with ``path``.
            env: Env vars for the command (returned by :meth:`list`).
            secrets: Secret env vars — injected into the daemon's process env
                (never the command line, so they don't leak via ``ps``), and
                never recorded or returned by :meth:`list`.
            read_only: Advisory for this driver — your command must honor it.
                Also exported to the daemon as ``OC_MOUNT_READONLY=1``. Default
                ``True``.

        Example:
            >>> await sandbox.mounts.add_command(
            ...     path="/mnt/data",
            ...     command=["gcsfuse", "my-bucket", "{mountpoint}"],
            ...     secrets={"GOOGLE_APPLICATION_CREDENTIALS_JSON": sa_json},
            ... )
        """
        body: dict[str, object] = {
            "path": path,
            "driver": "command",
            "command": command,
            "readOnly": read_only,
        }
        if env is not None:
            body["env"] = env
        if secrets is not None:
            body["secrets"] = secrets

        resp = await self._client.post(
            f"/sandboxes/{self._sandbox_id}/mounts", json=body
        )
        resp.raise_for_status()
        return _mount_from_dict(resp.json())

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
        driver=data.get("driver", "rclone"),
        read_only=data.get("readOnly", True),
        remote=data.get("remote", ""),
        backend=data.get("backend", ""),
        rclone_version=data.get("rcloneVersion", ""),
        command=data.get("command", []) or [],
        env=data.get("env", {}) or {},
    )
