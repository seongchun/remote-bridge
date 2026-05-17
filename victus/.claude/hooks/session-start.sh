#!/bin/bash
# Runs on every cloud session start. Surfaces relay status + available sessions to the LLM.
# Never blocks the session — prints a single status line on stdout regardless of outcome.

set +e

cd "$(dirname "$0")/../.." || exit 0

missing=()
for v in SUPABASE_URL SUPABASE_ANON_KEY DISPATCH_SECRET; do
  if [ -z "${!v}" ]; then missing+=("$v"); fi
done
if [ ${#missing[@]} -gt 0 ]; then
  echo "[victus] MISSING ENV: ${missing[*]} — set these in Claude Code environment config."
  exit 0
fi

STATUS_LINE="$(node scripts/status.mjs --quiet 2>/dev/null || echo 'UNKNOWN')"
echo "[victus] $STATUS_LINE"

if [[ "$STATUS_LINE" == OK* ]]; then
  echo "[victus] available sessions:"
  node scripts/sessions.mjs 2>/dev/null | sed 's/^/  /' || true
fi

exit 0
