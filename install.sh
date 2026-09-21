#!/usr/bin/env bash
# Installer script for Antigravity Multi-Account Usage Bar (agy-usage) on macOS / Linux.
# Zero third-party runtime dependencies.

set -e

CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
MAGENTA='\033[0;35m'
NC='\033[0m' # No Color

echo ""
echo -e "${MAGENTA}✦ Antigravity Usage Bar (agy-usage) Installer${NC}"
echo -e "───────────────────────────────────────────────"

# 1. Check Node.js
if ! command -v node >/dev/null 2>&1; then
  echo -e "${RED}✖ Error: Node.js is not installed or not in PATH.${NC}"
  echo "Please install Node.js 18+ from https://nodejs.org/"
  exit 1
fi

NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VER" -lt 18 ]; then
  echo -e "${RED}✖ Error: Node.js 18+ required (detected $(node -v)).${NC}"
  exit 1
fi
echo -e "${GREEN}✔ Found Node.js ($(node -v))${NC}"

# 2. Determine paths
INSTALL_DIR="$HOME/.antigravity-usage"
BIN_DIR="$INSTALL_DIR/bin"
APP_DIR="$INSTALL_DIR/app"

mkdir -p "$BIN_DIR"
mkdir -p "$APP_DIR"

SCRIPT_DIR=""
if [ -n "${BASH_SOURCE[0]}" ]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
fi

# 3. Copy or download application files
if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/cli.mjs" ]; then
  echo -e "${CYAN}  Installing application files from local repository to $APP_DIR...${NC}"
  cp -f "$SCRIPT_DIR/cli.mjs" "$APP_DIR/cli.mjs"
  cp -f "$SCRIPT_DIR/package.json" "$APP_DIR/package.json"
  cp -rf "$SCRIPT_DIR/src" "$APP_DIR/"
else
  echo -e "${CYAN}  Downloading application files from GitHub to $APP_DIR...${NC}"
  TEMP_DIR=$(mktemp -d 2>/dev/null || mktemp -d -t 'agy')
  if command -v git >/dev/null 2>&1; then
    git clone --depth 1 https://github.com/Abhishekkkk-15/antigravity-usage-bar.git "$TEMP_DIR" >/dev/null 2>&1
    cp -f "$TEMP_DIR/cli.mjs" "$APP_DIR/cli.mjs"
    cp -f "$TEMP_DIR/package.json" "$APP_DIR/package.json"
    cp -rf "$TEMP_DIR/src" "$APP_DIR/"
    rm -rf "$TEMP_DIR"
  elif command -v curl >/dev/null 2>&1 && command -v tar >/dev/null 2>&1; then
    curl -fsSL https://github.com/Abhishekkkk-15/antigravity-usage-bar/archive/refs/heads/main.tar.gz | tar -xz -C "$APP_DIR" --strip-components=1
  else
    echo -e "${RED}✖ Error: Git or curl+tar required for remote installation.${NC}"
    exit 1
  fi
fi

# 4. Create executable wrapper scripts
cat << 'EOF' > "$BIN_DIR/agy-usage"
#!/usr/bin/env bash
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../app" >/dev/null 2>&1 && pwd)"
exec node "$DIR/cli.mjs" "$@"
EOF

chmod +x "$BIN_DIR/agy-usage"
ln -sf "$BIN_DIR/agy-usage" "$BIN_DIR/antigravity-usage"

# Also create Windows .cmd wrappers if running in MINGW/MSYS/Cygwin on Windows
if [[ "$OSTYPE" == "msys" || "$OSTYPE" == "cygwin" || "$OSTYPE" == "win32" ]]; then
  printf "@echo off\r\nnode \"%%~dp0..\\app\\cli.mjs\" %%*\r\n" > "$BIN_DIR/agy-usage.cmd"
  printf "@echo off\r\nnode \"%%~dp0..\\app\\cli.mjs\" %%*\r\n" > "$BIN_DIR/antigravity-usage.cmd"
fi

echo -e "${GREEN}✔ Created command wrappers (agy-usage, antigravity-usage)${NC}"

# 5. Check and configure PATH in profile files
PROFILE_FILE=""
if [ -n "$ZSH_VERSION" ] || [ -f "$HOME/.zshrc" ]; then
  PROFILE_FILE="$HOME/.zshrc"
elif [ -f "$HOME/.bashrc" ]; then
  PROFILE_FILE="$HOME/.bashrc"
elif [ -f "$HOME/.bash_profile" ]; then
  PROFILE_FILE="$HOME/.bash_profile"
elif [ -f "$HOME/.profile" ]; then
  PROFILE_FILE="$HOME/.profile"
fi

PATH_EXPORT="export PATH=\"\$HOME/.antigravity-usage/bin:\$PATH\""

if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
  if [ -n "$PROFILE_FILE" ] && [ -f "$PROFILE_FILE" ]; then
    if ! grep -qs "$BIN_DIR" "$PROFILE_FILE"; then
      echo "" >> "$PROFILE_FILE"
      echo "# Antigravity Usage Bar (agy-usage)" >> "$PROFILE_FILE"
      echo "$PATH_EXPORT" >> "$PROFILE_FILE"
      echo -e "${GREEN}✔ Added $BIN_DIR to $PROFILE_FILE${NC}"
    else
      echo -e "${GREEN}✔ $BIN_DIR already referenced in $PROFILE_FILE${NC}"
    fi
  fi
fi

# Optional /usr/local/bin symlink if writable
if [ -w "/usr/local/bin" ]; then
  ln -sf "$BIN_DIR/agy-usage" "/usr/local/bin/agy-usage"
  ln -sf "$BIN_DIR/antigravity-usage" "/usr/local/bin/antigravity-usage"
  echo -e "${GREEN}✔ Symlinked to /usr/local/bin/agy-usage${NC}"
fi

echo ""
echo -e "${GREEN}✔ Installation successful!${NC}"
echo ""
echo "Commands available in your terminal:"
echo "  agy-usage status     - Show active accounts & session limits"
echo "  agy-usage watch      - Live dashboard auto-refreshed in terminal"
echo "  agy-usage switch     - Switch active Antigravity account"
echo "  agy-usage add        - Track current logged-in Antigravity account"
echo ""
echo -e "${CYAN}Tip: Restart your terminal or run \`source ${PROFILE_FILE:-~/.bashrc}\` to apply PATH changes.${NC}"
echo ""
