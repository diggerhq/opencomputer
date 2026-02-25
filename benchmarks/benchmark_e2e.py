#!/usr/bin/env python3
"""
Benchmark: OpenSandbox vs E2B vs Daytona

Scenario: Create sandbox → git clone → npm install → npm run dev → kill

Usage:
    pip install opensandbox e2b daytona

    # Set API keys
    export OPENSANDBOX_API_KEY=...
    export OPENSANDBOX_API_URL=...     # default: https://app.opensandbox.ai

    export E2B_API_KEY=...

    export DAYTONA_API_KEY=...
    export DAYTONA_API_URL=...         # default: https://app.daytona.io/api
    export DAYTONA_TARGET=us           # runner location

    # Run all providers, 3 iterations each
    python benchmark_e2e.py --providers opensandbox e2b daytona --iterations 3

    # Single provider with custom repo
    python benchmark_e2e.py --providers e2b --repo https://github.com/expressjs/express

    # Full clone (no --depth 1)
    python benchmark_e2e.py --providers opensandbox --no-shallow
"""

import argparse
import asyncio
import json
import os
import statistics
import sys
import time
from dataclasses import dataclass, field, asdict
from typing import Optional

# ---------------------------------------------------------------------------
# Config defaults
# ---------------------------------------------------------------------------
DEFAULT_REPO = "https://github.com/expressjs/express"
DEFAULT_DEV_CMD = "node -e \"require('http').createServer((q,s)=>{s.writeHead(200);s.end('ok')}).listen(3000,()=>console.log('listening'))\""
DEV_RUN_SECONDS = 5  # how long to let the dev server run before stopping


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------
@dataclass
class StepResult:
    name: str
    duration_s: float
    success: bool
    error: str = ""


@dataclass
class RunResult:
    provider: str
    iteration: int
    steps: list[StepResult] = field(default_factory=list)
    total_s: float = 0.0
    success: bool = True
    error: str = ""


@dataclass
class BenchmarkSummary:
    provider: str
    iterations: int
    runs: list[RunResult] = field(default_factory=list)

    def successful_runs(self) -> list[RunResult]:
        return [r for r in self.runs if r.success]

    def step_times(self, step_name: str) -> list[float]:
        return [
            s.duration_s
            for r in self.successful_runs()
            for s in r.steps
            if s.name == step_name
        ]

    def total_times(self) -> list[float]:
        return [r.total_s for r in self.successful_runs()]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def fmt_seconds(s: float) -> str:
    if s < 1:
        return f"{s * 1000:.0f}ms"
    return f"{s:.2f}s"


def stats_line(times: list[float]) -> str:
    if not times:
        return "no data"
    avg = statistics.mean(times)
    if len(times) > 1:
        std = statistics.stdev(times)
        lo, hi = min(times), max(times)
        return f"{fmt_seconds(avg):>8}  ±{fmt_seconds(std):>7}   [{fmt_seconds(lo)} .. {fmt_seconds(hi)}]"
    return f"{fmt_seconds(avg):>8}"


# ---------------------------------------------------------------------------
# OpenSandbox benchmark (async SDK)
# ---------------------------------------------------------------------------
async def run_opensandbox(
    repo_url: str,
    dev_cmd: str,
    shallow: bool,
    template: str,
    iteration: int,
    dev_seconds: int = DEV_RUN_SECONDS,
) -> RunResult:
    # Lazy import so missing SDK doesn't break other providers
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "sdks", "python"))
    from opensandbox import Sandbox

    result = RunResult(provider="opensandbox", iteration=iteration)
    total_start = time.perf_counter()
    sandbox = None

    try:
        # 1. Create sandbox
        t = time.perf_counter()
        sandbox = await Sandbox.create(template=template, timeout=600)
        result.steps.append(StepResult("create_sandbox", time.perf_counter() - t, True))
        print(f"    sandbox {sandbox.sandbox_id} created")

        # Setup: ensure node/npm/git are available
        t = time.perf_counter()
        print("    [setup] checking node/npm/git …")
        check = await sandbox.commands.run("node --version && npm --version && git --version", timeout=30)
        if check.exit_code != 0:
            print("    [setup] installing node via nvm …")
            install_cmd = (
                "apt-get update -qq && apt-get install -y -qq curl git > /dev/null 2>&1 && "
                "curl -fsSL https://deb.nodesource.com/setup_20.x | bash - > /dev/null 2>&1 && "
                "apt-get install -y -qq nodejs > /dev/null 2>&1 && "
                "node --version && npm --version"
            )
            setup = await sandbox.commands.run(install_cmd, timeout=120)
            if setup.exit_code != 0:
                raise RuntimeError(f"Node setup failed: {setup.stderr or setup.stdout}")
            print(f"    [setup] node ready: {setup.stdout.strip()}")
        result.steps.append(StepResult("setup", time.perf_counter() - t, True))

        # 2. Git clone
        depth_flag = "--depth 1" if shallow else ""
        t = time.perf_counter()
        r = await sandbox.commands.run(
            f"git clone {depth_flag} {repo_url} /workspace/app 2>&1",
            timeout=180,
        )
        dur = time.perf_counter() - t
        result.steps.append(StepResult("git_clone", dur, r.exit_code == 0, (r.stderr or r.stdout) if r.exit_code != 0 else ""))
        if r.exit_code != 0:
            raise RuntimeError(f"git clone failed: {r.stderr or r.stdout}")

        # 3. npm install
        t = time.perf_counter()
        r = await sandbox.commands.run(
            "cd /workspace/app && npm install --cache /workspace/.npm-cache 2>&1",
            timeout=300,
        )
        dur = time.perf_counter() - t
        result.steps.append(StepResult("npm_install", dur, r.exit_code == 0, (r.stderr or r.stdout) if r.exit_code != 0 else ""))
        if r.exit_code != 0:
            # Fetch npm debug log on failure
            log_r = await sandbox.commands.run(
                "cat $(ls -t /.npm/_logs/*-debug-0.log /workspace/.npm-cache/_logs/*-debug-0.log 2>/dev/null | head -1) 2>&1 | tail -40",
                timeout=10,
            )
            debug_log = log_r.stdout.strip() if log_r.exit_code == 0 else ""
            output = r.stdout.strip() or r.stderr.strip()
            raise RuntimeError(f"npm install failed:\n{output}\n{debug_log}")

        # 4. Dev server (run for dev_seconds then stop)
        t = time.perf_counter()
        r = await sandbox.commands.run(
            f"cd /workspace/app && timeout {dev_seconds} bash -c \"{dev_cmd}\" 2>&1 || true",
            timeout=dev_seconds + 15,
        )
        result.steps.append(StepResult("npm_run_dev", time.perf_counter() - t, True))

        # 5. Kill sandbox
        t = time.perf_counter()
        await sandbox.kill()
        result.steps.append(StepResult("kill_sandbox", time.perf_counter() - t, True))
        sandbox = None

        result.total_s = time.perf_counter() - total_start
        return result

    except Exception as e:
        result.success = False
        result.error = str(e)
        result.total_s = time.perf_counter() - total_start
        if sandbox:
            try:
                await sandbox.kill()
            except Exception:
                pass
        return result


# ---------------------------------------------------------------------------
# E2B benchmark (sync SDK)
# ---------------------------------------------------------------------------
def run_e2b(
    repo_url: str,
    dev_cmd: str,
    shallow: bool,
    iteration: int,
    dev_seconds: int = DEV_RUN_SECONDS,
) -> RunResult:
    from e2b import Sandbox

    result = RunResult(provider="e2b", iteration=iteration)
    total_start = time.perf_counter()
    sandbox = None

    try:
        # 1. Create sandbox
        t = time.perf_counter()
        sandbox = Sandbox.create(timeout=600)
        result.steps.append(StepResult("create_sandbox", time.perf_counter() - t, True))
        print(f"    sandbox {sandbox.sandbox_id} created")

        # 2. Git clone
        depth_flag = "--depth 1" if shallow else ""
        t = time.perf_counter()
        r = sandbox.commands.run(
            f"git clone {depth_flag} {repo_url} /workspace/app 2>&1",
            timeout=180,
        )
        dur = time.perf_counter() - t
        result.steps.append(StepResult("git_clone", dur, r.exit_code == 0, r.stderr if r.exit_code != 0 else ""))
        if r.exit_code != 0:
            raise RuntimeError(f"git clone failed: {r.stderr}")

        # 3. npm install
        t = time.perf_counter()
        r = sandbox.commands.run(
            "cd /workspace/app && npm install 2>&1",
            timeout=300,
        )
        dur = time.perf_counter() - t
        result.steps.append(StepResult("npm_install", dur, r.exit_code == 0, r.stderr if r.exit_code != 0 else ""))
        if r.exit_code != 0:
            raise RuntimeError(f"npm install failed: {r.stderr}")

        # 4. Dev server (background → wait → kill)
        t = time.perf_counter()
        handle = sandbox.commands.run(
            f"cd /workspace/app && {dev_cmd}",
            background=True,
        )
        time.sleep(dev_seconds)
        try:
            handle.kill()
        except Exception:
            pass
        result.steps.append(StepResult("npm_run_dev", time.perf_counter() - t, True))

        # 5. Kill sandbox
        t = time.perf_counter()
        sandbox.kill()
        result.steps.append(StepResult("kill_sandbox", time.perf_counter() - t, True))
        sandbox = None

        result.total_s = time.perf_counter() - total_start
        return result

    except Exception as e:
        result.success = False
        result.error = str(e)
        result.total_s = time.perf_counter() - total_start
        if sandbox:
            try:
                sandbox.kill()
            except Exception:
                pass
        return result


# ---------------------------------------------------------------------------
# Daytona benchmark (sync SDK)
# ---------------------------------------------------------------------------
def run_daytona(
    repo_url: str,
    dev_cmd: str,
    shallow: bool,
    iteration: int,
    dev_seconds: int = DEV_RUN_SECONDS,
) -> RunResult:
    from daytona import Daytona, CreateSandboxFromImageParams

    result = RunResult(provider="daytona", iteration=iteration)
    total_start = time.perf_counter()
    daytona_client = Daytona()
    sandbox = None

    try:
        # 1. Create sandbox (node:20 image, git pre-installed on Daytona)
        t = time.perf_counter()
        sandbox = daytona_client.create(
            params=CreateSandboxFromImageParams(
                image="node:20",
                auto_stop_interval=0,
            ),
            timeout=60,
        )
        result.steps.append(StepResult("create_sandbox", time.perf_counter() - t, True))
        print(f"    sandbox {sandbox.id} created")

        # Setup: ensure git is available (node:20 image may not have it)
        check = sandbox.process.exec("git --version", timeout=10)
        if check.exit_code != 0:
            print("    [setup] installing git …")
            sandbox.process.exec(
                "apt-get update -qq && apt-get install -y -qq git > /dev/null 2>&1",
                timeout=60,
            )

        # 2. Git clone
        depth_flag = "--depth 1" if shallow else ""
        home_dir = "/home/daytona"
        t = time.perf_counter()
        r = sandbox.process.exec(
            f"git clone {depth_flag} {repo_url} {home_dir}/app 2>&1",
            timeout=180,
        )
        dur = time.perf_counter() - t
        result.steps.append(StepResult("git_clone", dur, r.exit_code == 0, r.result if r.exit_code != 0 else ""))
        if r.exit_code != 0:
            raise RuntimeError(f"git clone failed: {r.result}")

        # 3. npm install
        t = time.perf_counter()
        r = sandbox.process.exec("npm install 2>&1", cwd=f"{home_dir}/app", timeout=300)
        dur = time.perf_counter() - t
        result.steps.append(StepResult("npm_install", dur, r.exit_code == 0, r.result if r.exit_code != 0 else ""))
        if r.exit_code != 0:
            raise RuntimeError(f"npm install failed: {r.result}")

        # 4. Dev server (run for dev_seconds then stop)
        t = time.perf_counter()
        r = sandbox.process.exec(
            f"timeout {dev_seconds} sh -c '{dev_cmd}' 2>&1 || true",
            cwd=f"{home_dir}/app",
            timeout=dev_seconds + 15,
        )
        result.steps.append(StepResult("npm_run_dev", time.perf_counter() - t, True))

        # 5. Kill sandbox
        t = time.perf_counter()
        sandbox.delete()
        result.steps.append(StepResult("kill_sandbox", time.perf_counter() - t, True))
        sandbox = None

        result.total_s = time.perf_counter() - total_start
        return result

    except Exception as e:
        result.success = False
        result.error = str(e)
        result.total_s = time.perf_counter() - total_start
        if sandbox:
            try:
                sandbox.delete()
            except Exception:
                pass
        return result


# ---------------------------------------------------------------------------
# Orchestrator
# ---------------------------------------------------------------------------
STEP_ORDER = ["create_sandbox", "setup", "git_clone", "npm_install", "npm_run_dev", "kill_sandbox"]


def run_provider(
    provider: str,
    repo_url: str,
    dev_cmd: str,
    shallow: bool,
    iterations: int,
    template: str,
    dev_seconds: int = DEV_RUN_SECONDS,
) -> BenchmarkSummary:
    summary = BenchmarkSummary(provider=provider, iterations=iterations)

    for i in range(iterations):
        print(f"\n  [{provider}] iteration {i + 1}/{iterations}")

        if provider == "opensandbox":
            run_result = asyncio.run(
                run_opensandbox(repo_url, dev_cmd, shallow, template, i + 1, dev_seconds)
            )
        elif provider == "e2b":
            run_result = run_e2b(repo_url, dev_cmd, shallow, i + 1, dev_seconds)
        elif provider == "daytona":
            run_result = run_daytona(repo_url, dev_cmd, shallow, i + 1, dev_seconds)
        else:
            raise ValueError(f"Unknown provider: {provider}")

        summary.runs.append(run_result)

        # Print step timings
        if run_result.success:
            for step in run_result.steps:
                status = "OK" if step.success else "FAIL"
                print(f"    {step.name:<20} {fmt_seconds(step.duration_s):>10}  [{status}]")
            print(f"    {'TOTAL':<20} {fmt_seconds(run_result.total_s):>10}")
        else:
            print(f"    FAILED: {run_result.error}")

    return summary


def print_comparison(summaries: list[BenchmarkSummary]):
    """Print a side-by-side comparison table."""
    providers = [s.provider for s in summaries]

    print("\n" + "=" * 80)
    print("BENCHMARK RESULTS")
    print("=" * 80)

    # Header
    header = f"{'Step':<20}"
    for p in providers:
        header += f" | {p:>18}"
    print(header)
    print("-" * len(header))

    # Per-step comparison
    for step_name in STEP_ORDER:
        row = f"{step_name:<20}"
        for s in summaries:
            times = s.step_times(step_name)
            if times:
                avg = statistics.mean(times)
                row += f" | {fmt_seconds(avg):>18}"
            else:
                row += f" | {'—':>18}"
        print(row)

    # Total
    print("-" * len(header))
    row = f"{'TOTAL':<20}"
    for s in summaries:
        times = s.total_times()
        if times:
            avg = statistics.mean(times)
            row += f" | {fmt_seconds(avg):>18}"
        else:
            row += f" | {'—':>18}"
    print(row)

    # Success rate
    row = f"{'Success rate':<20}"
    for s in summaries:
        ok = len(s.successful_runs())
        row += f" | {f'{ok}/{s.iterations}':>18}"
    print(row)

    print("=" * 80)

    # Detailed stats
    print("\nDETAILED STATISTICS (avg ± std  [min .. max])")
    print("-" * 70)
    for s in summaries:
        print(f"\n  {s.provider}")
        for step_name in STEP_ORDER:
            times = s.step_times(step_name)
            print(f"    {step_name:<20} {stats_line(times)}")
        print(f"    {'TOTAL':<20} {stats_line(s.total_times())}")


def export_json(summaries: list[BenchmarkSummary], output_path: str):
    """Export results as JSON."""
    data = {}
    for s in summaries:
        provider_data = {
            "iterations": s.iterations,
            "successful": len(s.successful_runs()),
            "steps": {},
            "total": {},
        }
        for step_name in STEP_ORDER:
            times = s.step_times(step_name)
            if times:
                provider_data["steps"][step_name] = {
                    "avg_s": round(statistics.mean(times), 3),
                    "std_s": round(statistics.stdev(times), 3) if len(times) > 1 else 0,
                    "min_s": round(min(times), 3),
                    "max_s": round(max(times), 3),
                    "values_s": [round(t, 3) for t in times],
                }
        total_times = s.total_times()
        if total_times:
            provider_data["total"] = {
                "avg_s": round(statistics.mean(total_times), 3),
                "std_s": round(statistics.stdev(total_times), 3) if len(total_times) > 1 else 0,
                "min_s": round(min(total_times), 3),
                "max_s": round(max(total_times), 3),
                "values_s": [round(t, 3) for t in total_times],
            }
        # Include errors
        errors = [r.error for r in s.runs if not r.success and r.error]
        if errors:
            provider_data["errors"] = errors

        data[s.provider] = provider_data

    with open(output_path, "w") as f:
        json.dump(data, f, indent=2)
    print(f"\nResults saved to {output_path}")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(
        description="Benchmark sandbox platforms: OpenSandbox vs E2B vs Daytona",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # All three providers, 3 iterations
  python benchmark_e2e.py --providers opensandbox e2b daytona -n 3

  # Just OpenSandbox with a custom repo
  python benchmark_e2e.py --providers opensandbox --repo https://github.com/fastify/fastify

  # Full clone (no --depth 1)
  python benchmark_e2e.py --providers e2b --no-shallow

  # Custom dev command
  python benchmark_e2e.py --providers opensandbox --dev-cmd "npm run dev"
""",
    )
    parser.add_argument(
        "--providers",
        nargs="+",
        choices=["opensandbox", "e2b", "daytona"],
        default=["opensandbox", "e2b", "daytona"],
        help="Providers to benchmark (default: all three)",
    )
    parser.add_argument(
        "-n", "--iterations",
        type=int,
        default=3,
        help="Number of iterations per provider (default: 3)",
    )
    parser.add_argument(
        "--repo",
        default=DEFAULT_REPO,
        help=f"Git repo URL to clone (default: {DEFAULT_REPO})",
    )
    parser.add_argument(
        "--dev-cmd",
        default=DEFAULT_DEV_CMD,
        help="Command to run as 'dev server' (default: simple HTTP server)",
    )
    parser.add_argument(
        "--no-shallow",
        action="store_true",
        help="Do a full clone instead of --depth 1",
    )
    parser.add_argument(
        "--dev-seconds",
        type=int,
        default=DEV_RUN_SECONDS,
        help=f"How long to run dev server before stopping (default: {DEV_RUN_SECONDS}s)",
    )
    parser.add_argument(
        "--opensandbox-template",
        default="node",
        help="OpenSandbox template to use (default: node)",
    )
    parser.add_argument(
        "--output",
        default="benchmark_results.json",
        help="JSON output file path (default: benchmark_results.json)",
    )

    args = parser.parse_args()

    shallow = not args.no_shallow
    dev_seconds = args.dev_seconds

    print("=" * 80)
    print("SANDBOX BENCHMARK: OpenSandbox vs E2B vs Daytona")
    print("=" * 80)
    print(f"  Repo:       {args.repo}")
    print(f"  Shallow:    {shallow}")
    print(f"  Dev cmd:    {args.dev_cmd[:60]}{'…' if len(args.dev_cmd) > 60 else ''}")
    print(f"  Dev time:   {dev_seconds}s")
    print(f"  Iterations: {args.iterations}")
    print(f"  Providers:  {', '.join(args.providers)}")
    print()

    # Check API keys
    key_checks = {
        "opensandbox": "OPENSANDBOX_API_KEY",
        "e2b": "E2B_API_KEY",
        "daytona": "DAYTONA_API_KEY",
    }
    for provider in args.providers:
        env_var = key_checks[provider]
        if not os.environ.get(env_var):
            print(f"  WARNING: {env_var} not set — {provider} may fail")

    summaries: list[BenchmarkSummary] = []

    for provider in args.providers:
        print(f"\n{'─' * 60}")
        print(f"  PROVIDER: {provider}")
        print(f"{'─' * 60}")

        summary = run_provider(
            provider=provider,
            repo_url=args.repo,
            dev_cmd=args.dev_cmd,
            shallow=shallow,
            iterations=args.iterations,
            template=args.opensandbox_template,
            dev_seconds=dev_seconds,
        )
        summaries.append(summary)

    # Print comparison
    print_comparison(summaries)

    # Export JSON
    export_json(summaries, args.output)


if __name__ == "__main__":
    main()
