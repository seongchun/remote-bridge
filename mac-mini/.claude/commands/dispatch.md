---
description: Send a task to the Mac Mini's Claude CLI in a workspace session.
argument-hint: [--session <name>] [--fresh] [--timeout <sec>] -- <task>
allowed-tools: Bash(node scripts/dispatch.mjs:*)
---

Dispatch `$ARGUMENTS` to the Mac Mini and stream the result back.

!`node scripts/dispatch.mjs $ARGUMENTS`

After the command returns, summarize what the Mac actually did and surface any errors plainly. If the output starts with `ERROR:` or `TIMEOUT:`, explain the likely cause and suggest a fix (check `/status`, view `/logs`, retry with `--fresh`, etc.).
