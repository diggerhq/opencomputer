---
name: opensandbox
description: Create and manage OpenSandbox environments. Use when user wants to create sandboxes, run code in isolated environments, test code, or execute commands in a clean environment. Automatically invoked for tasks like "create a sandbox", "run this in a sandbox", or "test this code".
argument-hint: [action] [options]
allowed-tools: Bash(osb *)
user-invocable: true
---

# OpenSandbox Skill

This skill provides seamless integration with OpenSandbox, allowing you to create and manage isolated sandbox environments directly from Claude Code.

## What is OpenSandbox?

OpenSandbox provides secure, isolated environments (sandboxes) where you can:
- Execute code safely without affecting your local machine
- Test code in clean environments (ubuntu, python, node)
- Run multiple isolated environments concurrently
- Persist work and hibernate/wake sandboxes on demand

## Available Commands

### Sandbox Management

```bash
# Create a sandbox
osb sandbox create --template <ubuntu|python|node> [options]

# List all sandboxes
osb sandbox list

# Get sandbox details
osb sandbox get <sandbox-id>

# Kill a sandbox
osb sandbox kill <sandbox-id>

# Hibernate (save to cloud)
osb sandbox hibernate <sandbox-id>

# Wake from hibernation
osb sandbox wake <sandbox-id>
```

### Execute Commands

```bash
# Run a command
osb exec <sandbox-id> <command> [args...]

# Run a shell command
osb shell <sandbox-id> "<shell-command>"
```

### File Operations

```bash
# Read a file
osb files cat <sandbox-id> <path>

# Write a file
osb files write <sandbox-id> <path> <content>
echo "content" | osb files write <sandbox-id> <path> -

# List directory
osb files ls <sandbox-id> <path>

# Create directory
osb files mkdir <sandbox-id> <path>

# Remove file
osb files rm <sandbox-id> <path>
```

## Usage Patterns

### Pattern 1: Quick Code Execution

When user wants to run code:

1. Create a sandbox with appropriate template
2. Write the code to a file
3. Execute the code
4. Show results
5. Clean up (kill sandbox)

Example:
```bash
# Create Python sandbox
SANDBOX_ID=$(osb sandbox create --template python | grep "Sandbox created:" | awk '{print $3}')

# Write code
echo 'print("Hello from OpenSandbox!")' | osb files write $SANDBOX_ID /tmp/test.py -

# Execute
osb exec $SANDBOX_ID python /tmp/test.py

# Cleanup
osb sandbox kill $SANDBOX_ID
```

### Pattern 2: Interactive Development

For longer interactions:

1. Create a sandbox
2. Remember the sandbox ID in context
3. Execute multiple commands
4. Show results after each step
5. Keep sandbox alive for follow-up questions
6. Kill when conversation ends

### Pattern 3: Multi-File Projects

For complex projects:

1. Create sandbox
2. Create directory structure (`osb files mkdir`)
3. Write multiple files
4. Execute build/test commands
5. Read output files if needed

## Templates

- **ubuntu**: Basic Ubuntu environment with bash, curl, git
- **python**: Ubuntu + Python 3 + pip
- **node**: Ubuntu + Node.js 20 + npm

## Configuration

Users must set:
```bash
export OPENSANDBOX_API_KEY="your-api-key"
export OPENSANDBOX_URL="https://api.opensandbox.ai"  # optional, defaults to localhost
```

## Best Practices

1. **Always capture sandbox ID** when creating sandboxes
2. **Show output** from commands to the user
3. **Clean up** sandboxes after use (unless user wants to keep them)
4. **Use appropriate templates** (python for Python code, node for JS/TS)
5. **Handle errors** gracefully and show error messages
6. **Use shell command** for complex bash operations
7. **Pipe content** when writing large files (`echo "..." | osb files write ... -`)

## Error Handling

Common errors:
- "API key is required": User needs to set `OPENSANDBOX_API_KEY`
- "sandbox not found": Sandbox was killed or ID is wrong
- "command not found": `osb` CLI not installed or not in PATH

## Examples

### Example 1: Test Python Script
```bash
# Create sandbox
SB=$(osb sandbox create --template python | grep "Sandbox created:" | awk '{print $3}')

# Write script
cat << 'EOF' | osb files write $SB /workspace/test.py -
import sys
print(f"Python {sys.version}")
print("Hello from OpenSandbox!")
EOF

# Run it
osb exec $SB python /workspace/test.py

# Cleanup
osb sandbox kill $SB
```

### Example 2: Install Package and Run
```bash
SB=$(osb sandbox create --template python | grep "Sandbox created:" | awk '{print $3}')

# Install package
osb exec $SB pip install requests

# Write script that uses it
echo 'import requests; print(requests.get("https://api.github.com").status_code)' | \
  osb files write $SB /tmp/test.py -

# Run
osb exec $SB python /tmp/test.py

osb sandbox kill $SB
```

### Example 3: Node.js Project
```bash
SB=$(osb sandbox create --template node | grep "Sandbox created:" | awk '{print $3}')

# Create package.json
cat << 'EOF' | osb files write $SB /workspace/package.json -
{
  "name": "test-project",
  "version": "1.0.0",
  "type": "module"
}
EOF

# Write code
echo 'console.log("Hello from Node!")' | osb files write $SB /workspace/index.js -

# Run
osb exec $SB node /workspace/index.js

osb sandbox kill $SB
```

## Tips for Claude

- **Proactively create sandboxes** when user asks to run/test code
- **Show the commands** you're running for transparency
- **Parse output** to extract sandbox IDs and results
- **Keep sandboxes alive** during active development sessions
- **Offer to clean up** at the end of tasks
- **Suggest templates** based on the language/task
- **Use JSON output** (`--json`) when you need to parse structured data
- **Remember sandbox IDs** across multiple turns in the conversation

## When to Use This Skill

Use this skill when:
- User wants to "run this code"
- User asks to "test this script"
- User wants to "try this in a clean environment"
- User needs to "install packages and test"
- User wants to "create a sandbox"
- User is developing/debugging code and needs isolation
- User wants to avoid cluttering their local machine

## When NOT to Use

Don't use for:
- Simple code explanations (no execution needed)
- Read-only operations on local files
- Questions about OpenSandbox itself (unless execution is involved)
