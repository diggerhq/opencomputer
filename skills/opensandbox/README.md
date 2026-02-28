# OpenSandbox Claude Skill

A Claude Code skill that enables seamless interaction with OpenSandbox directly from your conversations with Claude.

## What This Does

This skill teaches Claude how to:
- Create and manage OpenSandbox environments
- Execute code in isolated sandboxes
- Manage files and directories
- Handle sandbox lifecycle (create, hibernate, wake, kill)

When you ask Claude to "run this Python script" or "test this code in a clean environment", Claude will automatically use OpenSandbox.

## Installation

### 1. Install OpenSandbox CLI

```bash
# Option A: Install from binary (if available)
curl -sSL https://opensandbox.ai/install.sh | bash

# Option B: Build from source
git clone https://github.com/opensandbox/opensandbox
cd opensandbox
make build-cli
sudo make install-cli
```

### 2. Configure API Key

Get your API key from [opensandbox.ai](https://opensandbox.ai) (or your self-hosted instance), then:

```bash
# Add to ~/.bashrc or ~/.zshrc
export OPENSANDBOX_API_KEY="your-api-key-here"
export OPENSANDBOX_URL="https://api.opensandbox.ai"  # optional, defaults to localhost:8080
```

### 3. Install the Skill

```bash
# Create skills directory if it doesn't exist
mkdir -p ~/.claude/skills

# Copy the opensandbox skill
cp -r skills/opensandbox ~/.claude/skills/

# Or symlink it (for development)
ln -s /path/to/opensandbox/skills/opensandbox ~/.claude/skills/opensandbox
```

### 4. Verify Installation

```bash
# Test the CLI
osb sandbox list

# Start Claude Code
# The skill will be available automatically
```

## Usage

Once installed, simply ask Claude to run code:

```
You: Can you test this Python script?

[paste your code]

Claude: I'll create a Python sandbox and test this for you.

[Claude automatically creates sandbox, uploads code, runs it, shows results]
```

### Example Conversations

**Quick Code Execution:**
```
You: Run this: print("hello world")

Claude creates a Python sandbox, executes the code, shows output, and cleans up.
```

**Multi-Step Development:**
```
You: Create a Python sandbox and install requests

Claude creates sandbox, remembers the ID, installs requests.

You: Now write a script that fetches data from an API

Claude writes the script and runs it in the same sandbox.

You: Great, can you modify it to handle errors?

Claude updates the script and re-runs it.
```

**Complex Projects:**
```
You: I have a Node.js project. Can you test if it works?

Claude creates a Node sandbox, sets up the project structure, installs dependencies, and runs tests.
```

## Skill Commands

The skill recognizes these invocations:

```bash
# Manual invocation
/opensandbox create python
/opensandbox run <sandbox-id> python script.py
/opensandbox list

# Automatic invocation (Claude detects intent)
"Run this code"
"Test this script"
"Create a sandbox"
"Execute this in a clean environment"
```

## Features

### Automatic Mode
- Claude detects when you want to run code
- Automatically creates appropriate sandbox (python, node, ubuntu)
- Handles file upload, execution, and cleanup
- Shows you the results

### Manual Control
- Use `/opensandbox` to explicitly invoke the skill
- Manage sandboxes manually with flags
- Keep sandboxes alive across conversation turns

### File Management
- Upload code directly from your conversation
- Create directory structures
- Read output files back

### Error Handling
- Clear error messages if API key is missing
- Graceful handling of sandbox failures
- Suggestions for fixing common issues

## Configuration

### Environment Variables

```bash
# Required
export OPENSANDBOX_API_KEY="osb_..."

# Optional
export OPENSANDBOX_URL="https://api.opensandbox.ai"  # API endpoint
```

### Skill Settings

Edit `~/.claude/skills/opensandbox/SKILL.md` to customize:
- `allowed-tools`: Add/remove CLI commands Claude can use
- `description`: Adjust when the skill auto-activates
- `argument-hint`: Customize autocomplete suggestions

## Troubleshooting

### "API key is required"
```bash
# Set your API key
export OPENSANDBOX_API_KEY="your-key-here"

# Verify it's set
echo $OPENSANDBOX_API_KEY
```

### "osb: command not found"
```bash
# Install the CLI
make install-cli

# Or add to PATH
export PATH="$PATH:/path/to/opensandbox/bin"
```

### "Connection refused"
```bash
# Check if server is running
curl http://localhost:8080/health

# Or set custom URL
export OPENSANDBOX_URL="https://your-server.com"
```

### Skill Not Loading
```bash
# Verify skill location
ls ~/.claude/skills/opensandbox/SKILL.md

# Restart Claude Code
# The skill should appear in /opensandbox autocomplete
```

## Examples

### Python Script Testing
```
You: Test this Python script:
```python
def fibonacci(n):
    if n <= 1: return n
    return fibonacci(n-1) + fibonacci(n-2)

for i in range(10):
    print(fibonacci(i))
```

Claude: I'll test this in a Python sandbox.
[Creates sandbox, uploads code, runs it, shows output, cleans up]
```

### Package Installation
```
You: Can you test if pandas works with this data?

Claude: I'll create a Python sandbox with pandas.
[Creates sandbox, installs pandas, writes test code, runs it]
```

### Multi-File Projects
```
You: I have a Flask app. Can you test it?

Claude: I'll set up a Python sandbox with Flask.
[Creates sandbox, sets up project structure, installs requirements, runs app]
```

## Advanced Usage

### Keep Sandbox Alive

```
You: Create a Python sandbox and keep it running

Claude: [Creates sandbox, shows ID]

You: Install numpy and scipy

Claude: [Installs in existing sandbox]

You: Now run this computation...

Claude: [Uses same sandbox]
```

### Custom Templates

```
You: Create a sandbox with ubuntu template

Claude: [Creates ubuntu sandbox for shell scripting]
```

### Hibernate and Wake

```
You: Hibernate my sandbox for later

Claude: [Saves sandbox to cloud]

[Later...]

You: Wake up my sandbox from yesterday

Claude: [Restores sandbox from cloud]
```

## For OpenSandbox Developers

To update the skill:

1. Edit `skills/opensandbox/SKILL.md`
2. Users can update by running:
   ```bash
   cp -r skills/opensandbox ~/.claude/skills/
   ```

To distribute:
- Include skill in release packages
- Provide installation script
- Document in getting started guide

## Resources

- [OpenSandbox Documentation](https://opensandbox.ai/docs)
- [CLI Reference](../../cmd/cli/README.md)
- [Claude Code Skills Documentation](https://claude.ai/skills)

## License

This skill is part of OpenSandbox and follows the same license as the project.
