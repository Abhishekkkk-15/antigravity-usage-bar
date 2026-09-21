# Antigravity Multi-Account Usage Bar (`agy-usage`)

**Usage limits, session quotas (5h / weekly), rate limits, and seamless account switching for Google Antigravity CLI (`agy`) and Gemini accounts.**

100% local. Zero third-party runtime dependencies. Works on Windows, macOS, and Linux.

---

## Features

- **Direct Antigravity Telemetry Ingestion**: Ingests real, live quota telemetry directly from `agy`:
  - **Gemini Models** (5-Hour Session & 7-Day Weekly Limits)
  - **Claude and GPT Models** (5-Hour Session & 7-Day Weekly Limits)
- **Multi-Account Quota Tracking**: Monitor rate limits and remaining headroom across multiple Google / Antigravity accounts in one unified dashboard.
- **Account Headroom Ranker**: Automatically identifies and highlights which account has the most available quota headroom right now.
- **1-Click / 1-Command Account Switcher**: Quickly switch the active account used by `agy` without re-logging in.
- **Machine-Wide Rate-Limit Shield**: Inter-process file lock (`usage-cache.lock`) enforces minimum request spacing to prevent unnecessary throttling.
- **Security & Privacy**: Secrets and OAuth tokens are redacted automatically; credentials are stored locally with atomic file writes.

---

## Installation

Requires **Node.js 18+**.

```bash
# Clone the repository
git clone https://github.com/kjsik11/antigravity-usage-bar.git
cd antigravity-usage-bar

# Link globally for terminal access
npm link
```

Now you can use `agy-usage` (or `antigravity-usage`) anywhere in your terminal.

---

## Usage

### 1. Add / Authenticate Accounts

```bash
# Add a Google AI Studio API Key (tested & validated live)
agy-usage add-key AIzaSy... --label personal-key

# Sign in to an additional Google / Antigravity account via browser OAuth PKCE
agy-usage login --label work

# Track active account currently used in Antigravity CLI (~/.gemini)
agy-usage add

# Track a specific email from your environment
agy-usage add developer@gmail.com --label personal
```

### 2. View Limits & Headroom

```bash
# View all accounts, rate limit progress bars, and countdown timers
agy-usage

# Live auto-refreshing dashboard in your terminal
agy-usage watch

# Export structured JSON for prompt status bars, tmux, or shell scripts
agy-usage --json
```

### 3. Switch Active Accounts & Configure Tiers

```bash
# Set subscription tier for an account (pro, free, workspace, payg)
agy-usage tier my-google-account pro

# Switch Antigravity CLI to your 'work' account
agy-usage switch work

# Or switch by email
agy-usage switch personal@gmail.com

# Verify which account is currently active in agy
agy-usage whoami
```

### 4. Manage Accounts

```bash
# List all tracked accounts and token validity
agy-usage list

# Remove an account and its credentials
agy-usage remove work
```

---

## Architecture

```
antigravity-usage-bar/
├── cli.mjs          # Terminal UI, progress bar rendering & argument parser
├── src/
│   ├── core.mjs     # Account collection, health checks & orchestration
│   ├── auth.mjs     # OAuth 2.0 PKCE loopback server & token refresh
│   ├── quota.mjs    # agy telemetry ingestion, quota windows & cache lock
│   └── storage.mjs  # Atomic file store, inter-process lock & secret redaction
└── test/
    └── core.test.mjs # 100% offline automated test suite
```

---

## License

MIT
