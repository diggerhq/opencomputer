"""Git operations inside a sandbox."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import httpx

from opensandbox.commands import Commands, ProcessResult


@dataclass
class RepoInfo:
    """Repository metadata."""

    id: str
    name: str
    slug: str
    description: str = ""
    default_branch: str = "main"
    clone_url: str = ""
    created_at: str = ""


@dataclass
class Git:
    """Git operations for a sandbox.

    Provides transparent authentication against the OpenSandbox git server.
    All git operations run inside the sandbox via commands.run().
    """

    _client: httpx.AsyncClient
    _sandbox_id: str
    _commands: Commands
    _api_key: str
    _git_domain: str
    _org_slug: str
    _credentials_injected: bool = field(default=False, repr=False)
    _repo_slug: str | None = field(default=None, repr=False)

    async def _ensure_credentials(self) -> None:
        """Inject .netrc credentials into the sandbox for transparent git auth."""
        if self._credentials_injected:
            return

        # Write .netrc (host without port)
        host = self._git_domain.rsplit(":", 1)[0] if ":" in self._git_domain else self._git_domain
        netrc = f"machine {host}\\nlogin {self._api_key}\\npassword x"
        await self._commands.run(
            f'printf "{netrc}\\n" > ~/.netrc && chmod 600 ~/.netrc',
            timeout=10,
        )
        # Configure git defaults
        await self._commands.run(
            'git config --global init.defaultBranch main '
            '&& git config --global user.email "sandbox@opensandbox.ai" '
            '&& git config --global user.name "OpenSandbox"',
            timeout=10,
        )
        self._credentials_injected = True

    def _remote_url(self, repo_slug: str) -> str:
        """Build the clone URL for a repo on the OpenSandbox git server."""
        return f"http://{self._git_domain}/{self._org_slug}/{repo_slug}.git"

    async def init(
        self,
        name: str | None = None,
        default_branch: str = "main",
    ) -> RepoInfo:
        """Initialize a git repo in /workspace and create the backing repository.

        Args:
            name: Repository name (defaults to sandbox ID).
            default_branch: Default branch name (defaults to "main").

        Returns:
            RepoInfo with the created repository metadata.
        """
        await self._ensure_credentials()

        repo_name = name or self._sandbox_id

        # Create repo on server via control plane API
        resp = await self._client.post(
            "/repos",
            json={"name": repo_name, "description": f"Created from sandbox {self._sandbox_id}"},
        )

        if resp.status_code == 409:
            # Already exists
            slug = repo_name.lower().replace(" ", "-")
            repo_info = RepoInfo(id="", name=repo_name, slug=slug)
        else:
            resp.raise_for_status()
            data = resp.json()
            repo_info = RepoInfo(
                id=data.get("id", ""),
                name=data.get("name", repo_name),
                slug=data.get("slug", ""),
                description=data.get("description", ""),
                default_branch=data.get("defaultBranch", default_branch),
                clone_url=data.get("cloneUrl", ""),
                created_at=data.get("createdAt", ""),
            )

        self._repo_slug = repo_info.slug

        # Initialize git in workspace and set remote
        url = self._remote_url(repo_info.slug)
        await self._commands.run(
            f"cd /workspace && git init -b {default_branch} && git remote add origin {url}",
            timeout=15,
        )

        return repo_info

    async def push(
        self,
        message: str = "update",
        branch: str | None = None,
    ) -> ProcessResult:
        """Stage all changes, commit, and push to the remote repository.

        Args:
            message: Commit message (defaults to "update").
            branch: Branch to push (defaults to pushing all).
        """
        await self._ensure_credentials()
        branch_arg = f"origin {branch}" if branch else "--all"
        return await self._commands.run(
            f'cd /workspace && git add -A && git commit -m "{message}" --allow-empty && git push -u {branch_arg}',
            timeout=120,
        )

    async def pull(self) -> ProcessResult:
        """Pull latest changes from the remote repository."""
        await self._ensure_credentials()
        return await self._commands.run("cd /workspace && git pull", timeout=60)

    async def clone(
        self,
        repo: str,
        path: str = "/workspace",
        branch: str | None = None,
    ) -> ProcessResult:
        """Clone a repository into the sandbox.

        Args:
            repo: Repository name (from OpenSandbox git server) or full git URL.
            path: Target directory (defaults to "/workspace").
            branch: Branch to check out after cloning.
        """
        await self._ensure_credentials()

        url = repo if ("://" in repo or "@" in repo) else self._remote_url(repo)
        branch_arg = f"-b {branch}" if branch else ""
        self._repo_slug = None if "://" in repo else repo

        return await self._commands.run(
            f"git clone {branch_arg} {url} {path}".strip(),
            timeout=120,
        )

    async def status(self) -> ProcessResult:
        """Get the current git status of /workspace."""
        return await self._commands.run("cd /workspace && git status", timeout=10)

    async def log(self, max_count: int = 10) -> ProcessResult:
        """Get the git log of /workspace."""
        return await self._commands.run(
            f"cd /workspace && git log --oneline -n {max_count}",
            timeout=10,
        )

    async def diff(self) -> ProcessResult:
        """Get the current diff of /workspace."""
        return await self._commands.run("cd /workspace && git diff", timeout=10)

    async def branch(self, name: str) -> ProcessResult:
        """Create and checkout a new branch."""
        return await self._commands.run(
            f"cd /workspace && git checkout -b {name}",
            timeout=10,
        )

    async def checkout(self, name: str) -> ProcessResult:
        """Checkout an existing branch."""
        return await self._commands.run(
            f"cd /workspace && git checkout {name}",
            timeout=10,
        )
