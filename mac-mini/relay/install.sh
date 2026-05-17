#!/bin/bash
# Install the mac-mini relay as a launchd LaunchAgent (per-user).
# Interactive: prompts for Supabase URL/key/secret on first run.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CFG_DIR="$HOME/.config/seongchun-mac-mini"
ENV_FILE="$CFG_DIR/env"
PLIST_TEMPLATE="$REPO_DIR/relay/com.seongchun.mac-mini-relay.plist"
PLIST_TARGET="$HOME/Library/LaunchAgents/com.seongchun.mac-mini-relay.plist"
LOG_DIR="$HOME/Library/Logs"

mkdir -p "$CFG_DIR" "$HOME/Library/LaunchAgents" "$LOG_DIR"

if [ ! -f "$ENV_FILE" ]; then
  echo "Creating env file: $ENV_FILE"
  read -rp "SUPABASE_URL [https://rnnigyfzwlgojxyccgsm.supabase.co]: " SU
  SU=${SU:-https://rnnigyfzwlgojxyccgsm.supabase.co}
  read -rp "SUPABASE_ANON_KEY: " SK
  read -rp "DISPATCH_SECRET (must match cloud env var): " DS
  read -rp "WORKSPACE_ROOT [$HOME/claude-workspaces]: " WR
  WR=${WR:-$HOME/claude-workspaces}
  CLAUDE_BIN="$(command -v claude || true)"
  read -rp "CLAUDE_PATH [$CLAUDE_BIN]: " CB
  CB=${CB:-$CLAUDE_BIN}
  cat > "$ENV_FILE" <<EOF
SUPABASE_URL=$SU
SUPABASE_ANON_KEY=$SK
DISPATCH_SECRET=$DS
WORKSPACE_ROOT=$WR
CLAUDE_PATH=$CB
RELAY_TARGET=mac-mini
EOF
  chmod 600 "$ENV_FILE"
  mkdir -p "$WR/default"
fi

NODE_BIN="$(command -v node)"
if [ -z "$NODE_BIN" ]; then
  echo "Node.js not found. Install with: brew install node"
  exit 1
fi

# Substitute placeholders in the plist
sed \
  -e "s|__NODE__|$NODE_BIN|g" \
  -e "s|__SCRIPT__|$REPO_DIR/relay/relay.mjs|g" \
  -e "s|__ENV_FILE__|$ENV_FILE|g" \
  -e "s|__LOG_DIR__|$LOG_DIR|g" \
  "$PLIST_TEMPLATE" > "$PLIST_TARGET"

launchctl unload "$PLIST_TARGET" 2>/dev/null || true
launchctl load "$PLIST_TARGET"

echo ""
echo "Installed: $PLIST_TARGET"
echo "Logs:      $LOG_DIR/mac-mini-relay.out.log"
echo "Verify:    tail -f $LOG_DIR/mac-mini-relay.out.log"
echo "          (expect '[OK] Supabase reachable' and '[Ready]' within ~10s)"
