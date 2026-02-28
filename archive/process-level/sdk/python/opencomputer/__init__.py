"""OpenComputer Python SDK.

A high-performance Python client for OpenComputer, using gRPC for
fast command execution and file operations.

Usage:
    from opencomputer import OpenComputer

    async with OpenComputer("https://opencomputer.fly.dev") as client:
        sandbox = await client.create()

        result = await sandbox.run("echo hello")
        print(result.stdout)

        await sandbox.write_file("/tmp/test.py", "print('hello')")
        content = await sandbox.read_file("/tmp/test.py")

        await sandbox.destroy()
"""

from .client import OpenComputer
from .sandbox import Sandbox, CommandResult
from .exceptions import (
    OpenComputerError,
    SandboxNotFoundError,
    SandboxConnectionError,
    CommandExecutionError,
    FileOperationError,
)

__version__ = "0.1.0"

__all__ = [
    "OpenComputer",
    "Sandbox",
    "CommandResult",
    "OpenComputerError",
    "SandboxNotFoundError",
    "SandboxConnectionError",
    "CommandExecutionError",
    "FileOperationError",
]
