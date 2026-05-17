#!/bin/bash
set -e
PLIST="$HOME/Library/LaunchAgents/com.seongchun.mac-mini-relay.plist"
launchctl unload "$PLIST" 2>/dev/null || true
rm -f "$PLIST"
echo "Uninstalled. Env file at ~/.config/seongchun-mac-mini/env retained."
