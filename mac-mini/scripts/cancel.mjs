#!/usr/bin/env node
// Cancel a running/pending dispatch. Usage: cancel.mjs <id> | --latest

import { loadCloud } from './lib/config.mjs';
import { makeClient } from './lib/supa.mjs';

async function main() {
  const cfg = loadCloud();
  const db = makeClient(cfg);
  const arg = process.argv[2];
  if (!arg) {
    console.error('Usage: cancel.mjs <dispatch-id> | --latest');
    process.exit(64);
  }

  let id = arg;
  if (arg === '--latest') {
    const rows = await db.select(
      'commands',
      `action=eq.run_claude&target=eq.${encodeURIComponent(cfg.target)}&status=in.(pending,processing)&order=created_at.desc&limit=1&select=id`
    );
    if (!rows || !rows.length) {
      console.log('no active dispatch found');
      process.exit(0);
    }
    id = rows[0].id;
  }

  await db.update('commands', `id=eq.${encodeURIComponent(id)}`, {
    status: 'error',
    result: 'CANCELED_BY_CLOUD',
  });
  console.log(`canceled ${id}`);
}

main().catch((e) => {
  console.error('[cancel] fatal:', e.message);
  process.exit(1);
});
