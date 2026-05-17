#!/usr/bin/env node
// Read the target's heartbeat and report online/offline + busy/idle.
// Usage: status.mjs [--quiet]

import { loadCloud } from './lib/config.mjs';
import { makeClient } from './lib/supa.mjs';

async function main() {
  const cfg = loadCloud();
  const db = makeClient(cfg);
  const quiet = process.argv.includes('--quiet');

  const rows = await db.select(
    'commands',
    `id=eq.${encodeURIComponent(cfg.target + '-heartbeat')}&select=result,content`
  );

  if (!rows || !rows.length || !rows[0].result) {
    if (quiet) console.log(`NEVER ${cfg.target}`);
    else console.log(`${cfg.target}: NEVER CONNECTED — see relay/README.md to install`);
    process.exit(1);
  }

  const ageSec = Math.round((Date.now() - new Date(rows[0].result).getTime()) / 1000);
  const state = rows[0].content || 'unknown';
  const online = ageSec < 120;
  if (quiet) {
    console.log(`${online ? 'OK' : 'OFFLINE'} ${ageSec} ${state}`);
  } else {
    const ageStr = ageSec < 60 ? `${ageSec}s` : `${Math.round(ageSec / 60)}m`;
    if (online) {
      console.log(`${cfg.target}: online (${state}, last seen ${ageStr} ago)`);
    } else {
      console.log(
        `${cfg.target}: OFFLINE — last seen ${ageStr} ago. On Victus run (PowerShell): Restart-Service VictusRelay`
      );
    }
  }
  process.exit(online ? 0 : 1);
}

main().catch((e) => {
  console.error('[status] fatal:', e.message);
  process.exit(1);
});
