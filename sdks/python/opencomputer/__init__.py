"""OpenComputer Python SDK - cloud sandbox platform. Deprecated: 1.2.0 is the final release."""

import warnings as _warnings

#: Shown once per process, on the first ``import opencomputer``. A
#: FutureWarning, not a DeprecationWarning: Python's default filters show it
#: to end users wherever the import happens, not only in ``__main__``.
DEPRECATION_MESSAGE = (
    "opencomputer-sdk is deprecated and receives no further releases: the "
    "OpenComputer sandbox platform it targets is shut down. For Serverless "
    "Agents use the management API (https://opencomputer.dev/agents/api) or "
    "the TypeScript client @opencomputer/sdk/agents (npm install @opencomputer/sdk)."
)
_warnings.warn(DEPRECATION_MESSAGE, FutureWarning, stacklevel=2)

from opencomputer.sandbox import Sandbox, ScalingLockedError, PlanLimitError, SandboxFamilyLimitError
from opencomputer.browser import Browser, BrowserProfile
from opencomputer.agent import Agent, AgentEvent, AgentSession, AgentSessionInfo
from opencomputer.filesystem import Filesystem
from opencomputer.exec import Exec, ProcessResult, ExecSession, ExecSessionInfo
from opencomputer.image import Image
from opencomputer.mounts import Mounts, MountInfo
from opencomputer.pty import Pty, PtySession
from opencomputer.shell import Shell, ShellBusyError, ShellClosedError
from opencomputer.template import Template
from opencomputer.project import SecretStore
from opencomputer.snapshot import Snapshots
from opencomputer.usage import (
    Usage,
    Tags,
    UsageSandboxItem,
    UsageTagItem,
    UsageTotals,
    UsageUntaggedBucket,
    UsageBySandboxResponse,
    UsageByTagResponse,
    SandboxUsageResponse,
    SandboxUsagePoint,
    SandboxUsageTotals,
    TagKeyInfo,
)

__all__ = [
    "Sandbox",
    "Browser",
    "BrowserProfile",
    "ScalingLockedError",
    "PlanLimitError",
    "SandboxFamilyLimitError",
    "Agent",
    "AgentEvent",
    "AgentSession",
    "AgentSessionInfo",
    "Filesystem",
    "Exec",
    "ProcessResult",
    "ExecSession",
    "ExecSessionInfo",
    "Image",
    "Mounts",
    "MountInfo",
    "Pty",
    "PtySession",
    "Shell",
    "ShellBusyError",
    "ShellClosedError",
    "Template",
    "SecretStore",
    "Snapshots",
    "Usage",
    "Tags",
    "UsageSandboxItem",
    "UsageTagItem",
    "UsageTotals",
    "UsageUntaggedBucket",
    "UsageBySandboxResponse",
    "UsageByTagResponse",
    "SandboxUsageResponse",
    "SandboxUsagePoint",
    "SandboxUsageTotals",
    "TagKeyInfo",
]

# Single source of truth — pyproject.toml reads the same file, so the published
# version and the version the SDK announces to the server cannot disagree.
from opencomputer.version import __version__  # noqa: E402,F401
