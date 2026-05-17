#!/usr/bin/env node
// Fetch recent sys_log entries from the relay.
// Usage: logs.mjs [count, default 20]

import { loadCloud } from './lib/config.mjs';
import { makeClient } from './lib/supa.mjs';

async function main() {
  const cfg = loadCloud();
  const db = makeClient(cfg);
  const count = parseInt(process.argv[2] || '20', 10);
  const component = cfg.target === 'mac-mini' ? 'mac-relay' : 'victus-relay';

  const rows = await db.select(
    'sys_log',
    `component=eq.${encodeURIComponent(component)}&order=created_at.desc&limit=${count}&select=created_at,level,event,detail,hostname`
  );

  if (!rows || !rows.length) {
    console.log('(no log entries)');
    return;
  }

  for (const r of rows.reverse()) {
    const t = r.created_at.slice(11, 19);
    const lvl = (r.level || '').toUpperCase().padEnd(5);
    const ev = (r.event || '').padEnd(20);
    let detail = r.detail || '';
    if (detail.length > 100) detail = detail.slice(0, 100) + '...';
    console.log(`${t} ${lvl} ${ev} ${detail}`);
  }
}

main().catch((e) => {
  console.error('[logs] fatal:', e.message);
  process.exit(1);
});
