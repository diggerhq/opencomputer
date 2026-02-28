# OpenSandbox CLI Test Suite

Comprehensive test suite for the OpenSandbox CLI (`osb`), modeled after the TypeScript SDK tests.

## Test Coverage

The test suite validates:

1. **Lifecycle** (`test-lifecycle.sh`)
   - Sandbox creation with templates
   - Listing and getting sandbox details
   - Setting timeout
   - Killing sandboxes
   - Custom CPU/memory configuration

2. **Commands** (`test-commands.sh`)
   - Basic command execution
   - stderr handling
   - Non-zero exit codes
   - Large stdout output
   - Shell features (pipes, redirects, wildcards)
   - Cross-tool file access

3. **File Operations** (`test-file-ops.sh`)
   - Large file write/read (100KB)
   - Special characters in content
   - Deeply nested directories
   - File deletion and overwrite
   - Directory listing
   - Empty file handling
   - stdin/stdout piping

4. **Python Template** (`test-python-template.sh`)
   - Python 3 availability
   - pip availability
   - Standard library modules
   - File I/O from Python
   - Python version checks
   - pip install validation

5. **Multi-Template** (`test-multi-template.sh`)
   - Ubuntu template
   - Python template
   - Node template
   - Template isolation
   - Concurrent sandbox operation

## Running Tests

### All Tests

```bash
# Run all tests
./scripts/cli-tests/run-all-tests.sh

# Skip slow tests
./scripts/cli-tests/run-all-tests.sh --skip-slow
```

### Individual Tests

```bash
# Run specific test
./scripts/cli-tests/test-lifecycle.sh
./scripts/cli-tests/test-commands.sh
./scripts/cli-tests/test-file-ops.sh
./scripts/cli-tests/test-python-template.sh
./scripts/cli-tests/test-multi-template.sh
```

### Via Makefile

```bash
# Run all CLI tests
make test-cli

# Run individual test
make test-cli-lifecycle
make test-cli-commands
make test-cli-file-ops
make test-cli-python
make test-cli-multi
```

## Requirements

- **CLI Built**: `make build-cli` (creates `bin/osb`)
- **API Running**: Server must be running at `$OPENSANDBOX_URL` (default: `http://localhost:8080`)
- **API Key**: Set `$OPENSANDBOX_API_KEY` environment variable
- **Dependencies**: bash, jq, python3

## Configuration

The tests use environment variables:

```bash
# Required
export OPENSANDBOX_API_KEY="your-api-key"

# Optional
export OPENSANDBOX_URL="http://localhost:8080"  # API base URL
export OSB="/path/to/osb"                       # CLI binary path (default: bin/osb)
```

## Test Output

Each test provides detailed output:

```
╔══════════════════════════════════════════════════╗
║       Sandbox Lifecycle Test                     ║
╚══════════════════════════════════════════════════╝

━━━ Test 1: Create sandbox ━━━

✓ Sandbox created
✓ Output contains template
✓ Output contains status

━━━ Test 2: List sandboxes ━━━

✓ List contains our sandbox
✓ List shows ubuntu template
✓ List shows running status

========================================
 Results: 18 passed, 0 failed
========================================
```

## Exit Codes

- `0`: All tests passed
- `1`: One or more tests failed

## Adding New Tests

To add a new test:

1. Create `scripts/cli-tests/test-your-feature.sh`
2. Follow the template structure:
   ```bash
   #!/usr/bin/env bash
   set -euo pipefail

   # Setup colors and check function
   # Create sandbox
   # Run tests with check() assertions
   # Cleanup in trap
   # Print summary
   ```
3. Add to `TEST_SUITES` array in `run-all-tests.sh`
4. Make executable: `chmod +x scripts/cli-tests/test-your-feature.sh`

## Comparison with SDK Tests

These CLI tests mirror the TypeScript SDK tests in `sdks/typescript/examples/`:

| TypeScript Test | CLI Test |
|-----------------|----------|
| `test-commands.ts` | `test-commands.sh` |
| `test-file-ops.ts` | `test-file-ops.sh` |
| `test-python-sdk.ts` | `test-python-template.sh` |
| `test-multi-template.ts` | `test-multi-template.sh` |
| `lifecycle-test.ts` | `test-lifecycle.sh` |

Both test suites validate the same functionality through different interfaces (SDK vs CLI).

## CI/CD Integration

Run tests in CI:

```bash
#!/bin/bash
# Start server
make run-dev &
SERVER_PID=$!
sleep 5

# Run tests
export OPENSANDBOX_API_KEY="test-key"
export OPENSANDBOX_URL="http://localhost:8080"
./scripts/cli-tests/run-all-tests.sh

# Cleanup
kill $SERVER_PID
```

## Debugging Failed Tests

1. **Check server logs**: Ensure the server is running
2. **Verify API key**: `echo $OPENSANDBOX_API_KEY`
3. **Test CLI manually**: `./bin/osb sandbox list`
4. **Run individual test**: `./scripts/cli-tests/test-lifecycle.sh`
5. **Check sandbox state**: `./bin/osb sandbox list`
6. **Enable debug output**: Add `set -x` to test script

## Known Issues

- Tests require a clean environment (no pre-existing sandboxes with conflicting IDs)
- Large file tests may be slow on network-constrained environments
- Node template tests require Node 18+ in the sandbox image
