# OpenComputer vs E2B Benchmarks

Benchmark suite to compare OpenComputer with E2B cloud sandboxes.

## Results Summary

Benchmarks run against OpenComputer deployed on Fly.io (with gRPC SDK) and E2B cloud.

### Overall: OpenComputer Wins Every Category 🚀

| Metric | OpenComputer gRPC | E2B | Winner |
|--------|------------------|-----|--------|
| **Sandbox Creation** | 120 ms | 232 ms | **OpenComputer 1.9x faster** |
| **Sandbox Destroy** | 16 ms | 108 ms | **OpenComputer 6.6x faster** |
| **Command Execution** | 28 ms | 52 ms | **OpenComputer 1.9x faster** |
| **File Write** | 10 ms | 34 ms | **OpenComputer 3.4x faster** |
| **File Read** | 9 ms | 50 ms | **OpenComputer 5.5x faster** |
| **Workflow Total** | 756 ms | 1322 ms | **OpenComputer 1.7x faster** |
| **Concurrency (8x)** | 27.5/s | 11.8/s | **OpenComputer 2.3x faster** |

### 1. Sandbox Creation Time

| Provider | Create Avg (ms) | Destroy Avg (ms) |
|----------|-----------------|------------------|
| OpenComputer gRPC | 120 | 16 |
| E2B | 232 | 108 |

**OpenComputer is ~2x faster** at creating and **6.6x faster** at destroying sandbox sessions.

### 2. Command Execution Latency

| Command | OpenComputer gRPC (ms) | E2B (ms) | Winner |
|---------|------------------|----------|--------|
| echo | 76 | 65 | E2B |
| pwd | 40 | 88 | **OpenComputer** |
| ls | 43 | 72 | **OpenComputer** |
| env | 41 | 41 | Tie |
| python_version | 12 | 50 | **OpenComputer** |
| git_version | 16 | 46 | **OpenComputer** |
| uname | 13 | 39 | **OpenComputer** |
| cat_etc_os | 13 | 43 | **OpenComputer** |
| loop_100 | 12 | 40 | **OpenComputer** |
| calculate | 11 | 36 | **OpenComputer** |
| **Overall Avg** | **28** | **52** | **OpenComputer** |

**OpenComputer is ~1.9x faster** for command execution with the gRPC SDK.

### 3. File Operations

| Operation | OpenComputer gRPC (ms) | E2B (ms) | Winner |
|-----------|------------------|----------|--------|
| Write 100B | 10 | 36 | **OpenComputer 3.6x** |
| Write 1KB | 10 | 32 | **OpenComputer 3.2x** |
| Read 100B | 9 | 36 | **OpenComputer 4x** |
| Read 1KB | 9 | 63 | **OpenComputer 7x** |

**OpenComputer is 3-7x faster** for file operations with native gRPC file APIs (no shell/base64 overhead).

### 4. Realistic Workflow (Git Clone + Edit)

| Step | OpenComputer gRPC (ms) | E2B (ms) | Winner |
|------|------------------|----------|--------|
| sandbox_create | 45 | 129 | **OpenComputer** |
| mkdir | 70 | 157 | **OpenComputer** |
| git_clone | 539 | 653 | **OpenComputer** |
| list_files | 16 | 44 | **OpenComputer** |
| write_file | 9 | 36 | **OpenComputer** |
| read_readme | 12 | 45 | **OpenComputer** |
| git_status | 13 | 45 | **OpenComputer** |
| git_diff | 14 | 40 | **OpenComputer** |
| cleanup | 13 | 67 | **OpenComputer** |
| sandbox_destroy | 14 | 105 | **OpenComputer** |
| **Total** | **756** | **1322** | **OpenComputer 1.7x** |

**OpenComputer wins every step** of the workflow, with a **1.7x faster total time**.

### 5. Concurrency (Parallel Sandboxes)

| Concurrency | OpenComputer Wall Time | OpenComputer Throughput/s | E2B Wall Time | E2B Throughput/s |
|-------------|----------------------|--------------------------|---------------|------------------|
| 1 | 469ms | 2.13 | 519ms | 1.93 |
| 2 | 250ms | 8.02 | 528ms | 3.79 |
| 4 | 245ms | 16.30 | 519ms | 7.70 |
| 8 | 291ms | **27.49** | 677ms | 11.81 |

**OpenComputer scales much better** with concurrent workloads:
- At 8 concurrent sandboxes, OpenComputer achieves **27.5 sandboxes/sec** vs E2B's **11.8 sandboxes/sec**
- OpenComputer maintains consistent ~250-290ms wall time while E2B degrades to 677ms
- **2.3x higher throughput** at scale

### Key Takeaways

| Metric | Winner | Improvement |
|--------|--------|-------------|
| Sandbox creation | **OpenComputer** | 1.9x faster |
| Sandbox destroy | **OpenComputer** | 6.6x faster |
| Command execution | **OpenComputer** | 1.9x faster |
| File operations | **OpenComputer** | 3-7x faster |
| Git clone | **OpenComputer** | 1.2x faster |
| Concurrency | **OpenComputer** | 2.3x throughput |
| Total workflow | **OpenComputer** | 1.7x faster |

**OpenComputer with gRPC wins across the board.**

### What Changed?

The gRPC implementation provides:
- **Binary protocol** - No JSON serialization overhead
- **Native file I/O** - Direct filesystem access, no shell commands
- **Connection reuse** - Persistent gRPC channel
- **Edge deployment** - Deploy close to users for low latency

---

## Prerequisites

### 1. OpenComputer (Local)
Must be running locally:
```bash
# From the repository root
docker compose up --build
```

### 2. E2B (Cloud)
Requires an E2B API key:
```bash
export E2B_API_KEY=your_api_key
```

### 3. Python Dependencies
```bash
cd benchmarks
pip install -r requirements.txt
```

## Quick Test

Before running full benchmarks, verify connectivity:

```bash
# Test OpenComputer
python quick_test.py

# Test E2B
python quick_test.py --provider e2b

# Test both
python quick_test.py --provider all
```

## Running Benchmarks

### Full Suite
```bash
# Run all benchmarks for all available providers
python run_benchmarks.py

# Run with more iterations for better accuracy
python run_benchmarks.py --iterations 5
```

### Provider-Specific
```bash
# Only test OpenComputer
python run_benchmarks.py --provider opencomputer

# Only test E2B
python run_benchmarks.py --provider e2b
```

### Individual Benchmarks
```bash
# Run specific benchmarks only
python run_benchmarks.py --only creation
python run_benchmarks.py --only creation commands
python run_benchmarks.py --only workflow

# Or run them directly
python benchmark_creation.py --provider opencomputer --iterations 5
python benchmark_commands.py --provider e2b --iterations 3
python benchmark_files.py --provider opencomputer
python benchmark_workflow.py --provider opencomputer
python benchmark_concurrency.py --provider opencomputer
```

## Benchmark Categories

### 1. Creation (`benchmark_creation.py`)
Measures sandbox startup and teardown time.
- **Create time**: How long to spin up a new sandbox session
- **Destroy time**: How long to tear down and cleanup

### 2. Commands (`benchmark_commands.py`)
Measures command execution latency for various operations:
- Simple commands (echo, pwd, ls)
- System info (uname, env)
- Tool availability (git, python versions)
- Loops and calculations

### 3. Files (`benchmark_files.py`)
Measures file read/write performance across different sizes:
- Tiny: 100 bytes
- Small: 1 KB
- Medium: 10 KB
- Large: 100 KB
- XLarge: 1 MB

### 4. Workflow (`benchmark_workflow.py`)
Measures a realistic git workflow:
1. Create sandbox
2. Git clone (shallow)
3. List files
4. Write a new file
5. Read README
6. Git status/diff
7. Cleanup and destroy

### 5. Concurrency (`benchmark_concurrency.py`)
Measures parallel sandbox operations:
- Tests 1, 2, 4, 8 concurrent sandboxes
- Measures wall clock time and throughput
- Identifies bottlenecks in parallel workloads

## Output

Results are saved to the `results/` directory:
- `results/benchmark_YYYYMMDD_HHMMSS.json` - Raw JSON results
- `results/benchmark_YYYYMMDD_HHMMSS.md` - Formatted markdown report

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENCOMPUTER_URL` | `https://opencomputer-test.fly.dev` | OpenComputer server URL |
| `E2B_API_KEY` | - | E2B API key (required for E2B tests) |

## Example Output

```
============================================================
SUMMARY
============================================================

## 1. Sandbox Creation Time

| Provider | Create Avg (ms) | Create Std | Destroy Avg (ms) |
|----------|-----------------|------------|------------------|
| opencomputer | 45.23 | 5.12 | 12.45 |
| e2b | 2345.67 | 234.56 | 156.78 |

## 2. Command Execution Latency

| Command | opencomputer (ms) | e2b (ms) |
|---------|------------------|----------|
| echo | 15.23 | 89.45 |
| pwd | 14.56 | 87.23 |
| ls | 18.34 | 95.67 |
...
```

## Notes

- OpenComputer benchmarks require Docker with `--privileged` mode
- E2B benchmarks require internet connectivity and valid API key
- File operations on OpenComputer use commands (cat, base64) while E2B uses native SDK
- Concurrency tests may hit rate limits on E2B free tier
