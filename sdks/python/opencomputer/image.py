"""Declarative image builder for OpenSandbox."""

from __future__ import annotations

import base64
import hashlib
import json
import os
from dataclasses import dataclass, field, replace
from typing import Any


@dataclass(frozen=True)
class ImageStep:
    type: str
    args: dict[str, Any]

    def to_dict(self) -> dict[str, Any]:
        return {"type": self.type, "args": self.args}


@dataclass(frozen=True)
class Image:
    """Declarative image builder.

    Defines a reproducible sandbox environment via a fluent API.
    Under the hood, the manifest is sent to the server which boots a base sandbox,
    executes each step, checkpoints the result, and caches it by content hash.

    Example::

        image = (
            Image.base()
            .apt_install(["curl", "git"])
            .pip_install(["requests", "pandas"])
            .add_file("/workspace/config.json", '{"key": "value"}')
            .env({"PROJECT_ROOT": "/workspace"})
            .workdir("/workspace")
        )

        # On-demand: cached by content hash
        sandbox = await Sandbox.create(image=image)

        # Pre-built snapshot
        await Snapshot.create(name="data-science", image=image)
    """

    _base: str = "base"
    _steps: tuple[ImageStep, ...] = field(default_factory=tuple)
    # RAM for the build phase (apt/pip). 0 = server default (generous). Does not
    # pin the output image — the server re-snapshots at the runtime floor.
    _builder_memory_mb: int = 0
    # Memory floor of the OUTPUT image. 0 = server default (1 GB). Forks can't run
    # below this but can scale up. Raise only for images with heavy boot services.
    _runtime_memory_mb: int = 0

    @classmethod
    def base(cls) -> Image:
        """Create a new image starting from the default OpenSandbox environment.

        The base includes Ubuntu 22.04 with Python, Node.js, build tools, and
        common utilities. Customize by chaining steps like .apt_install(),
        .pip_install(), .run_commands(), etc.
        """
        return cls()

    def apt_install(self, packages: list[str]) -> Image:
        """Install system packages via apt-get."""
        return replace(
            self,
            _steps=(*self._steps, ImageStep("apt_install", {"packages": packages})),
        )

    def pip_install(self, packages: list[str]) -> Image:
        """Install Python packages via pip."""
        return replace(
            self,
            _steps=(*self._steps, ImageStep("pip_install", {"packages": packages})),
        )

    def run_commands(self, *commands: str) -> Image:
        """Run one or more shell commands."""
        return replace(
            self,
            _steps=(*self._steps, ImageStep("run", {"commands": list(commands)})),
        )

    def env(self, vars: dict[str, str]) -> Image:
        """Set environment variables (written to /etc/environment)."""
        return replace(
            self,
            _steps=(*self._steps, ImageStep("env", {"vars": vars})),
        )

    def workdir(self, path: str) -> Image:
        """Set the default working directory."""
        return replace(
            self,
            _steps=(*self._steps, ImageStep("workdir", {"path": path})),
        )

    def add_file(self, remote_path: str, content: str) -> Image:
        """Add a file with inline content to the image.

        Args:
            remote_path: Absolute path inside the sandbox where the file will be written.
            content: String content of the file.
        """
        encoded = base64.b64encode(content.encode()).decode()
        return replace(
            self,
            _steps=(*self._steps, ImageStep("add_file", {
                "path": remote_path,
                "content": encoded,
                "encoding": "base64",
            })),
        )

    def add_local_file(self, local_path: str, remote_path: str) -> Image:
        """Add a local file into the image.

        Reads the file from disk and embeds its content in the manifest.

        Args:
            local_path: Path to the file on the local machine.
            remote_path: Absolute path inside the sandbox where the file will be written.
        """
        with open(local_path, "rb") as f:
            encoded = base64.b64encode(f.read()).decode()
        return replace(
            self,
            _steps=(*self._steps, ImageStep("add_file", {
                "path": remote_path,
                "content": encoded,
                "encoding": "base64",
            })),
        )

    def add_local_dir(self, local_path: str, remote_path: str) -> Image:
        """Add a local directory into the image.

        Recursively reads all files and embeds them in the manifest.

        Args:
            local_path: Path to the directory on the local machine.
            remote_path: Absolute path inside the sandbox where the directory will be created.
        """
        files: list[dict[str, str]] = []
        for root, _dirs, filenames in os.walk(local_path):
            for fname in filenames:
                full = os.path.join(root, fname)
                rel = os.path.relpath(full, local_path)
                with open(full, "rb") as f:
                    encoded = base64.b64encode(f.read()).decode()
                files.append({"relativePath": rel, "content": encoded})
        return replace(
            self,
            _steps=(*self._steps, ImageStep("add_dir", {
                "path": remote_path,
                "files": files,
            })),
        )

    def builder_memory(self, mb: int) -> Image:
        """Set the RAM (MB) for the build phase. Use this when a build OOMs at the
        default (e.g. heavy ``apt``/``pip``). Does not affect the output's floor."""
        return replace(self, _builder_memory_mb=mb)

    def runtime_memory(self, mb: int) -> Image:
        """Set the memory floor (MB) of the resulting image. Forks can't run below
        it. Defaults to 1 GB; raise only for images whose services auto-start heavy."""
        return replace(self, _runtime_memory_mb=mb)

    def to_dict(self) -> dict[str, Any]:
        """Returns the manifest as a plain dict (for JSON serialization)."""
        d: dict[str, Any] = {
            "base": self._base,
            "steps": [s.to_dict() for s in self._steps],
        }
        if self._builder_memory_mb > 0:
            d["builderMemoryMB"] = self._builder_memory_mb
        if self._runtime_memory_mb > 0:
            d["runtimeMemoryMB"] = self._runtime_memory_mb
        return d

    def cache_key(self) -> str:
        """Deterministic content hash for caching. Memory knobs are resource
        params, not image content, so they're excluded (matches the server)."""
        content = {"base": self._base, "steps": [s.to_dict() for s in self._steps]}
        canonical = json.dumps(content, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(canonical.encode()).hexdigest()
