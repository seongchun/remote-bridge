#!/usr/bin/env node
// List workspaces (sessions) on the target machine by sending action=list_sessions.

import { randomBytes } from 'node:crypto';
import { loadCloud } from './lib/config.mjs';
import { makeClient } from './lib/supa.mjs';
import { buildPayload } from './lib/hmac.mjs';

async function main() {
  const cfg = loadCloud();
  const db = makeClient(cfg);
  const payload = buildPayload({ action: 'list_sessions' }, cfg.secret);
  const id = 'list-' + Date.now() + '-' + randomBytes(4).toString('hex');

  await db.insert('commands', {
    id,
    action: 'list_sessions',
    target: cfg.target,
    content: JSON.stringify(payload),
    status: 'pending',
    created_at: new Date().toISOString(),
  });

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    const rows = await db.select(
      'commands',
      `id=eq.${encodeURIComponent(id)}&select=status,result`
    );
    if (!rows || !rows[0]) continue;
    const { status, result } = rows[0];
    if (status === 'completed') {
      try {
        const data = JSON.parse(result || '{}');
        const sessions = data.sessions || [];
        if (!sessions.length) {
          console.log(`(no Claude sessions found in ${data.root || '~/.claude/projects'})`);
          process.exit(0);
        }
        console.log(`Claude sessions on ${cfg.target} (${sessions.length}):`);
        console.log('Pass <id-prefix> to `/dispatch --resume` to continue any of them.\n');
        sessions.forEach((s, i) => {
          const idx = String(i + 1).padStart(2);
          const idPrefix = (s.sessionId || '').slice(0, 8);
          const last = s.lastModified
            ? new Date(s.lastModified).toISOString().slice(0, 16).replace('T', ' ')
            : 'unknown          ';
          const cwdBase = s.cwd && s.cwd !== '(unknown)'
            ? s.cwd.split(/[\\/]/).filter(Boolean).pop() || s.cwd
            : '(unknown)';
          const preview = s.firstMessagePreview || '(no preview)';
          console.log(`[${idx}] ${idPrefix}  ${last}  ${cwdBase}: ${preview}`);
        });
      } catch {
        console.log(result);
      }
      process.exit(0);
    }
    if (status === 'error') {
      console.error('ERROR: ' + (result || ''));
      process.exit(2);
    }
  }
  console.error('TIMEOUT listing sessions');
  process.exit(3);
}

main().catch((e) => {
  console.error('[sessions] fatal:', e.stack || e.message);
  process.exit(1);
});
