---
description: Send a task to Victus's Claude CLI in a workspace session.
argument-hint: [--session <name>] [--fresh] [--timeout <sec>] -- <task>
allowed-tools: Bash(node scripts/dispatch.mjs:*)
---

Dispatch `$ARGUMENTS` to Victus and stream the result back.

!`node scripts/dispatch.mjs $ARGUMENTS`

After the command returns, summarize what Victus actually did and surface any errors plainly. If the output starts with `ERROR:` or `TIMEOUT:`, explain the likely cause and suggest a fix (check `/status`, view `/logs`, retry with `--fresh`, etc.).
