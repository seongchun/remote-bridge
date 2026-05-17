#!/usr/bin/env node
// Send a task to the Mac Mini's Claude CLI.
//
// Two modes:
//   Resume mode:    --resume <session-id|prefix>           (resumes a real Claude conversation)
//   Workspace mode: [--session <name>] [--fresh]           (legacy; runs in workspace dir)
//
// Usage:
//   node scripts/dispatch.mjs --resume <id> [--timeout <sec>] -- <task...>
//   node scripts/dispatch.mjs --session <name> [--fresh] [--timeout <sec>] -- <task...>
//   node scripts/dispatch.mjs <task...>                     (session=default)
//
// --fresh   workspace mode only: start a brand-new claude conversation (default: --continue)
// --resume  resume a specific Claude session by id (or unique prefix from /sessions)
// --timeout per-call timeout override (seconds)
// Anything after `--` (or all non-flag args) is the task text.

import { randomBytes } from 'node:crypto';
import { loadCloud } from './lib/config.mjs';
import { makeClient } from './lib/supa.mjs';
import { buildPayload } from './lib/hmac.mjs';

function parseArgs(argv) {
  const o = { session: 'default', sessionId: null, fresh: false, timeoutMs: null, task: '' };
  const taskParts = [];
  let collectingTask = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (collectingTask) {
      taskParts.push(a);
      continue;
    }
    if (a === '--') {
      collectingTask = true;
    } else if (a === '--session' || a === '-s') {
      o.session = argv[++i];
    } else if (a === '--resume' || a === '-r') {
      o.sessionId = argv[++i];
    } else if (a === '--fresh' || a === '-f') {
      o.fresh = true;
    } else if (a === '--timeout' || a === '-t') {
      o.timeoutMs = parseInt(argv[++i], 10) * 1000;
    } else if (a.startsWith('--session=')) {
      o.session = a.slice(10);
    } else if (a.startsWith('--resume=')) {
      o.sessionId = a.slice(9);
    } else {
      taskParts.push(a);
    }
  }
  o.task = taskParts.join(' ').trim();
  return o;
}

async function main() {
  const cfg = loadCloud();
  const args = parseArgs(process.argv.slice(2));
  if (!args.task) {
    console.error('Usage: dispatch.mjs [--resume <id> | --session <name>] [--fresh] [--timeout <sec>] -- <task>');
    process.exit(64);
  }
  const timeoutMs = args.timeoutMs || cfg.timeoutMs;

  const db = makeClient(cfg);
  const payload = buildPayload(
    {
      action: 'run_claude',
      task: args.task,
      session: args.session,
      session_id: args.sessionId,
      fresh: args.fresh,
    },
    cfg.secret
  );
  const id = 'disp-' + Date.now() + '-' + randomBytes(4).toString('hex');

  const targetDesc = args.sessionId
    ? `resume=${args.sessionId}`
    : `session=${args.session}${args.fresh ? ' (fresh)' : ''}`;
  process.stderr.write(`[dispatch] id=${id} target=${cfg.target} ${targetDesc}\n`);

  await db.insert('commands', {
    id,
    action: 'run_claude',
    target: cfg.target,
    content: JSON.stringify(payload),
    status: 'pending',
    created_at: new Date().toISOString(),
  });

  let canceled = false;
  const cancel = async (sig) => {
    if (canceled) return;
    canceled = true;
    process.stderr.write(`\n[dispatch] ${sig} — asking relay to cancel\n`);
    try {
      await db.update('commands', `id=eq.${encodeURIComponent(id)}`, {
        status: 'error',
        result: 'CANCELED_BY_CLOUD',
      });
    } catch {}
    process.exit(130);
  };
  process.on('SIGINT', () => cancel('SIGINT'));
  process.on('SIGTERM', () => cancel('SIGTERM'));

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    let rows;
    try {
      rows = await db.select(
        'commands',
        `id=eq.${encodeURIComponent(id)}&select=status,result`
      );
    } catch (e) {
      process.stderr.write('[dispatch] poll error: ' + e.message.slice(0, 100) + '\n');
      continue;
    }
    if (!rows || !rows[0]) continue;
    const { status, result } = rows[0];
    if (status === 'completed') {
      process.stdout.write(result || '');
      process.stdout.write('\n');
      process.exit(0);
    }
    if (status === 'error') {
      console.error('ERROR: ' + (result || '(no detail)'));
      process.exit(2);
    }
  }

  try {
    await db.update('commands', `id=eq.${encodeURIComponent(id)}`, {
      status: 'error',
      result: 'TIMEOUT_CLOUD ' + timeoutMs / 1000 + 's',
    });
  } catch {}
  console.error('TIMEOUT: no response within ' + timeoutMs / 1000 + 's');
  process.exit(3);
}

main().catch((e) => {
  console.error('[dispatch] fatal:', e.stack || e.message);
  process.exit(1);
});
