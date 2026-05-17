---
description: Fetch the last N sys_log entries from the Victus relay.
argument-hint: [count, default 20]
allowed-tools: Bash(node scripts/logs.mjs:*)
---

!`node scripts/logs.mjs ${ARGUMENTS:-20}`
