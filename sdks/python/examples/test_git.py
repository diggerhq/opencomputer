#!/usr/bin/env python3
"""
Git Operations Test

Tests:
  1. Init repo (creates on server + sets up workspace)
  2. Push (stage, commit, push)
  3. Status / log / diff
  4. Clone into a second sandbox
  5. Branch and checkout
  6. Push from branch, pull from main
  7. Multiple commits (log history)

Usage:
  python examples/test_git.py
"""

import asyncio
import sys
import uuid

from opensandbox import Sandbox

GREEN = "\033[32m"
RED = "\033[31m"
BOLD = "\033[1m"
DIM = "\033[2m"
RESET = "\033[0m"

passed = 0
failed = 0


def green(msg: str) -> None:
    print(f"{GREEN}\u2713 {msg}{RESET}")


def red(msg: str) -> None:
    print(f"{RED}\u2717 {msg}{RESET}")


def bold(msg: str) -> None:
    print(f"{BOLD}{msg}{RESET}")


def dim(msg: str) -> None:
    print(f"{DIM}  {msg}{RESET}")


def check(desc: str, condition: bool, detail: str = "") -> None:
    global passed, failed
    if condition:
        green(desc)
        passed += 1
    else:
        red(f"{desc} ({detail})" if detail else desc)
        failed += 1


async def main() -> None:
    global passed, failed

    bold("\n\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557")
    bold("\u2551       Git Operations Test                        \u2551")
    bold("\u255a\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255d\n")

    # Use a unique repo name per run to avoid collisions
    repo_name = f"test-git-{uuid.uuid4().hex[:8]}"

    sandbox1 = None
    sandbox2 = None

    try:
        sandbox1 = await Sandbox.create(template="base", timeout=120)
        green(f"Created sandbox 1: {sandbox1.sandbox_id}")
        print()

        # ── Test 1: Init repo ──
        bold("━━━ Test 1: Init repo ━━━\n")

        repo = await sandbox1.git.init(name=repo_name)
        check("Repo created with name", repo.name == repo_name, f"got {repo.name}")
        check("Repo has a slug", len(repo.slug) > 0, f"slug={repo.slug}")
        check("Repo has an id", len(repo.id) > 0, f"id={repo.id}")
        dim(f"Repo: {repo.slug} (id={repo.id})")

        status = await sandbox1.git.status()
        check("Git status works after init", status.exit_code == 0, status.stderr)
        check("On main branch", "main" in status.stdout, status.stdout[:80])
        print()

        # ── Test 2: Push ──
        bold("━━━ Test 2: Push ━━━\n")

        # Create a file and push
        await sandbox1.files.write("/workspace/hello.txt", "Hello from sandbox!")
        push_result = await sandbox1.git.push(message="initial commit")
        check("Push exit code 0", push_result.exit_code == 0, push_result.stderr[:200])
        check("Push mentions main branch", "main" in push_result.stderr, push_result.stderr[:200])
        print()

        # ── Test 3: Status / log / diff ──
        bold("━━━ Test 3: Status / log / diff ━━━\n")

        status2 = await sandbox1.git.status()
        check("Clean status after push", "nothing to commit" in status2.stdout, status2.stdout[:100])

        log1 = await sandbox1.git.log()
        check("Log shows initial commit", "initial commit" in log1.stdout, log1.stdout[:100])

        # Make a change and check diff
        await sandbox1.files.write("/workspace/hello.txt", "Hello updated!")
        diff1 = await sandbox1.git.diff()
        check("Diff shows change", "Hello updated" in diff1.stdout, diff1.stdout[:100])

        # Reset the change for clean state
        await sandbox1.commands.run("cd /workspace && git checkout -- hello.txt")
        print()

        # ── Test 4: Clone into second sandbox ──
        bold("━━━ Test 4: Clone into second sandbox ━━━\n")

        sandbox2 = await Sandbox.create(template="base", timeout=120)
        green(f"Created sandbox 2: {sandbox2.sandbox_id}")

        clone_result = await sandbox2.git.clone(repo.slug, path="/tmp/cloned-repo")
        check("Clone exit code 0", clone_result.exit_code == 0, clone_result.stderr[:200])

        # Verify the file exists (use commands.run because /tmp is outside workspace volume)
        cat_result = await sandbox2.commands.run("cat /tmp/cloned-repo/hello.txt")
        check("Cloned file has correct content",
              cat_result.stdout.strip() == "Hello from sandbox!",
              f"got: {cat_result.stdout[:50]}")
        print()

        # ── Test 5: Branch and checkout ──
        bold("━━━ Test 5: Branch and checkout ━━━\n")

        branch_result = await sandbox1.git.branch("feature-1")
        check("Branch created", branch_result.exit_code == 0, branch_result.stderr)

        status3 = await sandbox1.git.status()
        check("On feature-1 branch", "feature-1" in status3.stdout, status3.stdout[:80])

        checkout_result = await sandbox1.git.checkout("main")
        check("Checkout main", checkout_result.exit_code == 0, checkout_result.stderr)

        status4 = await sandbox1.git.status()
        check("Back on main", "main" in status4.stdout, status4.stdout[:80])
        print()

        # ── Test 6: Push from branch, pull from second sandbox ──
        bold("━━━ Test 6: Push and pull across sandboxes ━━━\n")

        # Switch to feature branch, add file, push
        await sandbox1.git.checkout("feature-1")
        await sandbox1.files.write("/workspace/feature.txt", "feature content")
        push2 = await sandbox1.git.push(message="add feature file", branch="feature-1")
        check("Push feature branch", push2.exit_code == 0, push2.stderr[:200])

        # Push a change on main too
        await sandbox1.git.checkout("main")
        await sandbox1.files.write("/workspace/main-update.txt", "main update")
        push3 = await sandbox1.git.push(message="update main")
        check("Push main update", push3.exit_code == 0, push3.stderr[:200])

        # Pull from sandbox2 (cloned to /tmp/cloned-repo)
        pull_result = await sandbox2.commands.run("cd /tmp/cloned-repo && git pull", timeout=60)
        check("Pull succeeds", pull_result.exit_code == 0, pull_result.stderr[:200])

        # Verify the pulled file (use commands.run because /tmp is outside workspace volume)
        cat_main = await sandbox2.commands.run("cat /tmp/cloned-repo/main-update.txt")
        check("Pulled file has correct content",
              cat_main.stdout.strip() == "main update",
              f"got: {cat_main.stdout[:50]}")
        print()

        # ── Test 7: Multiple commits and log history ──
        bold("━━━ Test 7: Multiple commits and log ━━━\n")

        for i in range(3):
            await sandbox1.files.write(f"/workspace/file-{i}.txt", f"content {i}")
            await sandbox1.git.push(message=f"commit {i}")

        log2 = await sandbox1.git.log(max_count=5)
        check("Log shows multiple commits", log2.exit_code == 0)

        lines = [l for l in log2.stdout.strip().split("\n") if l.strip()]
        check("Log has at least 4 entries", len(lines) >= 4, f"got {len(lines)} lines")
        dim(f"Log output:\n    " + "\n    ".join(lines[:5]))
        print()

    except Exception as e:
        red(f"Fatal error: {e}")
        import traceback
        traceback.print_exc()
        failed += 1
    finally:
        if sandbox1:
            await sandbox1.kill()
            green("Sandbox 1 killed")
        if sandbox2:
            await sandbox2.kill()
            green("Sandbox 2 killed")

    # --- Summary ---
    bold("========================================")
    bold(f" Results: {passed} passed, {failed} failed")
    bold("========================================\n")
    if failed > 0:
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
