// Env loading. Cloud-side and relay-side variants.

import path from 'node:path';
import os from 'node:os';

function req(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`[config] missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}
const opt = (n, d) => process.env[n] || d;

export function loadCloud() {
  return {
    supaUrl: req('SUPABASE_URL'),
    supaKey: req('SUPABASE_ANON_KEY'),
    secret: req('DISPATCH_SECRET'),
    target: opt('DISPATCH_TARGET', 'victus'),
    timeoutMs: parseInt(opt('DISPATCH_TIMEOUT_MS', '900000'), 10),
  };
}

export function loadRelay() {
  return {
    supaUrl: req('SUPABASE_URL'),
    supaKey: req('SUPABASE_ANON_KEY'),
    secret: req('DISPATCH_SECRET'),
    target: opt('RELAY_TARGET', 'victus'),
    workspaceRoot: opt('WORKSPACE_ROOT', path.join(os.homedir(), 'claude-workspaces')),
    claudePath: opt('CLAUDE_PATH', 'claude'),
  };
}
