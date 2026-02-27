# Installing OpenSandbox Claude Skill

Quick guide for users to install the OpenSandbox skill in Claude Code.

## One-Command Install

```bash
# Copy skill to your Claude skills directory
mkdir -p ~/.claude/skills
cp -r skills/opensandbox ~/.claude/skills/
```

## What You'll Need

1. **OpenSandbox CLI** installed (`osb` command)
2. **API Key** from opensandbox.ai
3. **Claude Code** (desktop app or CLI)

## Step-by-Step Installation

### 1. Install OpenSandbox CLI

Choose one:

```bash
# Option A: Binary install (recommended)
curl -sSL https://opensandbox.ai/install.sh | bash

# Option B: Build from source
git clone https://github.com/opensandbox/opensandbox
cd opensandbox
make build-cli
sudo make install-cli
```

### 2. Get Your API Key

Sign up at [opensandbox.ai](https://opensandbox.ai) or use your self-hosted instance.

### 3. Configure Environment

Add to your `~/.bashrc` or `~/.zshrc`:

```bash
export OPENSANDBOX_API_KEY="your-api-key-here"
export OPENSANDBOX_URL="https://api.opensandbox.ai"  # optional
```

Then reload:
```bash
source ~/.bashrc  # or ~/.zshrc
```

### 4. Install the Skill

```bash
# Create skills directory
mkdir -p ~/.claude/skills

# Clone or download OpenSandbox repo
git clone https://github.com/opensandbox/opensandbox
cd opensandbox

# Copy the skill
cp -r skills/opensandbox ~/.claude/skills/

# Or create symlink (for auto-updates)
ln -s "$(pwd)/skills/opensandbox" ~/.claude/skills/opensandbox
```

### 5. Verify Installation

```bash
# Test CLI
osb sandbox list

# Start Claude Code
# The skill should be available at /opensandbox
```

## Usage

Once installed, Claude will automatically use OpenSandbox when you:
- Ask to run code
- Want to test something
- Need a clean environment

Or invoke manually with:
```
/opensandbox create python
```

## Troubleshooting

### CLI Not Found
```bash
which osb  # Should show path to osb binary
```

### API Key Not Set
```bash
echo $OPENSANDBOX_API_KEY  # Should show your key
```

### Skill Not Loading
```bash
ls ~/.claude/skills/opensandbox/SKILL.md  # Should exist
```

## Uninstall

```bash
rm -rf ~/.claude/skills/opensandbox
```

## Support

- Documentation: https://opensandbox.ai/docs
- Issues: https://github.com/opensandbox/opensandbox/issues
- Discord: https://discord.gg/opensandbox
