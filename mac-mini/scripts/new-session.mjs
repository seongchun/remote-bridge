#!/usr/bin/env node
// Create a fresh workspace (session) on the target machine.
// Usage: node scripts/new-session.mjs <name>

import { randomBytes } from 'node:crypto';
import { loadCloud } from './lib/config.mjs';
import { makeClient } from './lib/supa.mjs';
import { buildPayload } from './lib/hmac.mjs';

async function main() {
  const name = process.argv[2];
  if (!name) {
    console.error('Usage: new-session.mjs <name>');
    process.exit(64);
  }
  const cfg = loadCloud();
  const db = makeClient(cfg);
  const payload = buildPayload({ action: 'new_session', session: name }, cfg.secret);
  const id = 'new-' + Date.now() + '-' + randomBytes(4).toString('hex');

  await db.insert('commands', {
    id,
    action: 'new_session',
    target: cfg.target,
    content: JSON.stringify(payload),
    status: 'pending',
    created_at: new Date().toISOString(),
  });

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    const rows = await db.select(
      'commands',
      `id=eq.${encodeURIComponent(id)}&select=status,result`
    );
    if (!rows || !rows[0]) continue;
    const { status, result } = rows[0];
    if (status === 'completed') {
      console.log(result || `session "${name}" ready`);
      process.exit(0);
    }
    if (status === 'error') {
      console.error('ERROR: ' + (result || ''));
      process.exit(2);
    }
  }
  console.error('TIMEOUT creating session');
  process.exit(3);
}

main().catch((e) => {
  console.error('[new-session] fatal:', e.stack || e.message);
  process.exit(1);
});
