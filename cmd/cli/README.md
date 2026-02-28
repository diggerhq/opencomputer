# OpenSandbox CLI (osb)

Command-line interface for managing OpenSandbox environments.

## Installation

### Build from source

```bash
# Build the CLI
make build-cli

# Install to /usr/local/bin
make install-cli

# Or install manually
go install github.com/opensandbox/opensandbox/cmd/cli@latest
```

## Configuration

The CLI requires an API key and base URL. Configure via environment variables or flags:

```bash
# Environment variables (recommended)
export OPENSANDBOX_API_KEY="your-api-key"
export OPENSANDBOX_URL="http://localhost:8080"

# Or use flags
osb --api-key "your-api-key" --url "http://localhost:8080" sandbox list
```

## Usage

### Sandboxes

```bash
# Create a sandbox
osb sandbox create --template ubuntu
osb sandbox create --template python --cpus 2 --memory 2048 --timeout 600

# List all sandboxes
osb sandbox list

# Get sandbox details
osb sandbox get <sandbox-id>
osb sandbox get <sandbox-id> --json

# Kill a sandbox
osb sandbox kill <sandbox-id>

# Set timeout
osb sandbox timeout <sandbox-id> 600

# Hibernate and wake
osb sandbox hibernate <sandbox-id>
osb sandbox wake <sandbox-id>
```

### Execute Commands

```bash
# Execute a command
osb exec <sandbox-id> ls -la /workspace
osb exec <sandbox-id> python --version

# Execute a shell command
osb shell <sandbox-id> "cd /workspace && ls -la"

# Get JSON output
osb exec <sandbox-id> ls -la --json
```

### File Operations

```bash
# Read a file
osb files cat <sandbox-id> /workspace/hello.py

# Write a file
osb files write <sandbox-id> /workspace/test.txt "hello world"

# Write from stdin
echo "hello from stdin" | osb files write <sandbox-id> /workspace/test.txt -

# List directory
osb files ls <sandbox-id> /workspace
osb files ls <sandbox-id> /workspace -l

# Create directory
osb files mkdir <sandbox-id> /workspace/mydir

# Remove file/directory
osb files rm <sandbox-id> /workspace/test.txt
```

### Templates

```bash
# List templates
osb templates list
osb templates list --json
```

### Workers

```bash
# List registered workers (server mode only)
osb workers
osb workers --json
```

## Examples

### Create and use a sandbox

```bash
# Create a Python sandbox
SANDBOX_ID=$(osb sandbox create --template python | grep "Sandbox created:" | awk '{print $3}')

# Write a Python script
osb files write $SANDBOX_ID /workspace/hello.py "print('Hello from OpenSandbox!')"

# Execute it
osb exec $SANDBOX_ID python /workspace/hello.py

# Kill the sandbox
osb sandbox kill $SANDBOX_ID
```

### Quick script execution

```bash
# One-liner to create, execute, and clean up
SANDBOX_ID=$(osb sandbox create --template python | grep "Sandbox created:" | awk '{print $3}') && \
  osb exec $SANDBOX_ID python -c "print('Hello!')" && \
  osb sandbox kill $SANDBOX_ID
```

### File upload workflow

```bash
# Create sandbox
SANDBOX_ID=$(osb sandbox create --template node | grep "Sandbox created:" | awk '{print $3}')

# Upload local file
osb files write $SANDBOX_ID /workspace/index.js "$(cat ./local-script.js)"

# Execute it
osb exec $SANDBOX_ID node /workspace/index.js

# Download result
osb files cat $SANDBOX_ID /workspace/output.txt > result.txt

# Cleanup
osb sandbox kill $SANDBOX_ID
```

## Command Reference

### Global Flags

- `--url`: OpenSandbox API base URL (default: `$OPENSANDBOX_URL` or `http://localhost:8080`)
- `--api-key`: API key for authentication (default: `$OPENSANDBOX_API_KEY`)

### Commands

| Command | Description |
|---------|-------------|
| `osb sandbox create` | Create a new sandbox |
| `osb sandbox list` | List all sandboxes |
| `osb sandbox get <id>` | Get sandbox details |
| `osb sandbox kill <id>` | Kill (delete) a sandbox |
| `osb sandbox timeout <id> <secs>` | Set sandbox timeout |
| `osb sandbox hibernate <id>` | Hibernate sandbox to S3 |
| `osb sandbox wake <id>` | Wake hibernated sandbox |
| `osb exec <id> <cmd> [args...]` | Execute command in sandbox |
| `osb shell <id> <cmd>` | Execute shell command |
| `osb files cat <id> <path>` | Read file from sandbox |
| `osb files write <id> <path> <content>` | Write file to sandbox |
| `osb files ls <id> <path>` | List directory contents |
| `osb files mkdir <id> <path>` | Create directory |
| `osb files rm <id> <path>` | Remove file/directory |
| `osb templates list` | List all templates |
| `osb workers` | List registered workers |

### Aliases

- `sb` → `sandbox`
- `ls` → `list`
- `rm` → `kill`
- `tpl` → `templates`

## Environment Variables

- `OPENSANDBOX_URL`: API base URL
- `OPENSANDBOX_API_KEY`: API key for authentication

## Exit Codes

- `0`: Success
- `1`: General error
- Exit code from executed command (for `osb exec`)
