#!/usr/bin/env node
// relay.mjs — polls Supabase `commands` for actions targeting this machine,
// verifies HMAC, then performs the requested action. Cross-platform (Node only).
//
// Actions:
//   run_claude     — spawn `claude --print --dangerously-skip-permissions`.
//                    With payload.session_id, resumes that real Claude session
//                    (looks up its cwd from ~/.claude/projects/<encoded>/<id>.jsonl).
//                    Without, falls back to workspace-dir mode using payload.session.
//   list_sessions  — enumerate real Claude conversations from ~/.claude/projects/*.jsonl
//   new_session    — mkdir a new subdirectory under WORKSPACE_ROOT (workspace-mode only)
//   heartbeat      — implicit, emitted by us every 15s
//
// Designed to run under launchd (macOS) or NSSM/Task Scheduler (Windows).

import { spawn, execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadRelay } from '../scripts/lib/config.mjs';
import { makeClient } from '../scripts/lib/supa.mjs';
import { verifyPayload } from '../scripts/lib/hmac.mjs';

const cfg = loadRelay();
const db = makeClient(cfg);

const VERSION = 'relay-v1';
const HOSTNAME = os.hostname();
const COMPONENT = cfg.target === 'mac-mini' ? 'mac-relay' : 'victus-relay';
const LOCK_FILE = path.join(os.tmpdir(), `${cfg.target}-relay.lock`);

const CONFIG = {
  pollInterval: 3000,
  claudeTimeout: 15 * 60 * 1000,
  heartbeatInterval: 15000,
  keepAliveInterval: 6 * 3600 * 1000,
  sysLogCleanupInterval: 6 * 3600 * 1000,
  sysLogMaxRows: 500,
  startupRetries: 5,
  startupRetryDelay: 10000,
  cancelCheckInterval: 5000,
  resultTruncate: 50000,
};

let isProcessing = false;
let shuttingDown = false;

const ts = () => new Date().toISOString().slice(11, 19);
const log = (...a) => console.log('[' + ts() + ']', ...a);
const warn = (...a) => console.warn('[' + ts() + '] WARN', ...a);
const err = (...a) => console.error('[' + ts() + '] ERR', ...a);

function sysLog(level, event, detail) {
  const id = 'log-' + Date.now() + '-' + randomBytes(2).toString('hex');
  db.insert('sys_log', {
    id,
    level,
    component: COMPONENT,
    event,
    detail: typeof detail === 'string' ? detail : JSON.stringify(detail),
    hostname: HOSTNAME,
    version: VERSION,
    created_at: new Date().toISOString(),
  }).catch(() => {});
}

// ── single-instance lock ───────────────────────────────────────────────────────
function acquireLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const oldPid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10);
      if (!isNaN(oldPid) && oldPid !== process.pid) {
        try {
          process.kill(oldPid, 0);
          log('[Lock] killing previous instance PID=' + oldPid);
          try { process.kill(oldPid, 'SIGTERM'); } catch {}
          const deadline = Date.now() + 3000;
          while (Date.now() < deadline) {
            try { process.kill(oldPid, 0); } catch { break; }
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
          }
        } catch {
          log('[Lock] stale lock, ignoring');
        }
      }
    }
    fs.writeFileSync(LOCK_FILE, String(process.pid), 'utf8');
    log('[Lock] acquired PID=' + process.pid);
  } catch (e) {
    warn('[Lock]', e.message);
  }
}
function releaseLock() {
  try {
    const c = fs.readFileSync(LOCK_FILE, 'utf8').trim();
    if (c === String(process.pid)) fs.unlinkSync(LOCK_FILE);
  } catch {}
}
process.on('exit', releaseLock);
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { shuttingDown = true; releaseLock(); process.exit(0); });
}
process.on('uncaughtException', (e) => {
  err('[Fatal]', e.stack || e.message);
  releaseLock();
  process.exit(1);
});

// ── workspace path resolution (refuse traversal) ──────────────────────────────
function safeName(s) {
  return (s || 'default').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64) || 'default';
}
function resolveWorkspace(name, { create = true } = {}) {
  const safe = safeName(name);
  const root = path.resolve(cfg.workspaceRoot);
  const full = path.resolve(root, safe);
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw new Error('workspace escape: ' + name);
  }
  if (create) fs.mkdirSync(full, { recursive: true });
  return full;
}

// ── heartbeat / liveness ──────────────────────────────────────────────────────
async function sendHeartbeat() {
  try {
    await db.upsert('commands', {
      id: cfg.target + '-heartbeat',
      action: 'heartbeat',
      target: cfg.target,
      content: isProcessing ? 'busy' : 'idle',
      status: 'completed',
      result: new Date().toISOString(),
    });
  } catch (e) {
    warn('[Heartbeat]', e.message.slice(0, 100));
  }
}
async function keepAlive() {
  try { await db.select('commands', 'limit=1&select=id'); } catch {}
}
async function cleanupSysLog() {
  try {
    const rows = await db.select(
      'sys_log',
      'order=created_at.desc&limit=1&offset=' + CONFIG.sysLogMaxRows + '&select=created_at'
    );
    if (rows && rows.length > 0) {
      await db.delete('sys_log', 'created_at=lt.' + encodeURIComponent(rows[0].created_at));
    }
  } catch {}
}

// ── helpers: real Claude session discovery ────────────────────────────────────
const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

function readSessionMeta(jsonlPath) {
  let cwd = null;
  let firstUserMsg = '';
  try {
    const text = fs.readFileSync(jsonlPath, 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      if (!cwd && typeof obj.cwd === 'string') cwd = obj.cwd;
      if (!firstUserMsg && obj.type === 'user' && obj.message) {
        const c = obj.message.content;
        if (typeof c === 'string') firstUserMsg = c;
        else if (Array.isArray(c)) {
          const t = c.find((x) => x && typeof x.text === 'string');
          if (t) firstUserMsg = t.text;
        }
      }
      if (cwd && firstUserMsg) break;
    }
  } catch {}
  return { cwd, firstUserMsg: firstUserMsg.replace(/\s+/g, ' ').trim().slice(0, 80) };
}

// Resolve an exact session-id OR a unique prefix to { sessionId, cwd, jsonlPath }.
// On prefix collision picks the most recently modified match.
function findSessionInfo(sessionIdOrPrefix) {
  if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) return null;
  const matches = [];
  for (const projDir of fs.readdirSync(CLAUDE_PROJECTS_DIR)) {
    const dirPath = path.join(CLAUDE_PROJECTS_DIR, projDir);
    let entries;
    try { entries = fs.readdirSync(dirPath); } catch { continue; }
    for (const file of entries) {
      if (!file.endsWith('.jsonl')) continue;
      const sid = file.replace(/\.jsonl$/, '');
      if (sid === sessionIdOrPrefix || sid.startsWith(sessionIdOrPrefix)) {
        const full = path.join(dirPath, file);
        let mtime = 0;
        try { mtime = fs.statSync(full).mtimeMs; } catch {}
        matches.push({ sid, full, mtime });
      }
    }
  }
  if (!matches.length) return null;
  matches.sort((a, b) => b.mtime - a.mtime);
  const pick = matches[0];
  const meta = readSessionMeta(pick.full);
  return { sessionId: pick.sid, cwd: meta.cwd, jsonlPath: pick.full };
}

// ── action: run_claude ────────────────────────────────────────────────────────
// opts: { mode: 'resume'|'workspace', sessionId?, cwd, fresh? }
function runClaude(prompt, opts, dispatchId) {
  return new Promise((resolve, reject) => {
    const tmpFile = path.join(os.tmpdir(), 'relay-prompt-' + Date.now() + '.txt');
    fs.writeFileSync(tmpFile, prompt, 'utf8');

    let resumeFlag = '';
    if (opts.mode === 'resume' && opts.sessionId) {
      resumeFlag = `--resume ${opts.sessionId} `;
    } else if (!opts.fresh) {
      resumeFlag = '--continue ';
    }
    const cmd = `"${cfg.claudePath}" ${resumeFlag}--dangerously-skip-permissions --print < "${tmpFile}"`;
    const cwd = opts.cwd;
    log('[Claude]', {
      mode: opts.mode,
      sessionId: opts.sessionId ? opts.sessionId.slice(0, 8) : null,
      cwd: path.basename(cwd),
      fresh: !!opts.fresh,
      preview: prompt.slice(0, 60).replace(/\n/g, ' '),
    });

    const proc = spawn(cmd, [], { shell: true, cwd, env: process.env });
    let out = '', errText = '', settled = false;
    const cleanup = () => { try { fs.unlinkSync(tmpFile); } catch {} };
    const done = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      clearInterval(cancelTimer);
      cleanup();
      fn();
    };
    const killTimer = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch {}
      done(() => reject(new Error('TIMEOUT ' + CONFIG.claudeTimeout / 1000 + 's')));
    }, CONFIG.claudeTimeout);
    const cancelTimer = setInterval(async () => {
      try {
        const rows = await db.select(
          'commands',
          `id=eq.${encodeURIComponent(dispatchId)}&select=status`
        );
        if (rows && rows[0] && rows[0].status === 'error') {
          try { proc.kill('SIGTERM'); } catch {}
          done(() => reject(new Error('CANCELED')));
        }
      } catch {}
    }, CONFIG.cancelCheckInterval);
    proc.stdout.on('data', (d) => (out += d.toString()));
    proc.stderr.on('data', (d) => (errText += d.toString()));
    proc.on('close', (code) => {
      done(() => {
        if (code === 0 && out.trim()) resolve(out.trim());
        else if (code === 0) reject(new Error('claude returned empty. stderr: ' + errText.slice(0, 200)));
        else reject(new Error('claude exit ' + code + ': ' + (errText || out).slice(0, 300)));
      });
    });
    proc.on('error', (e) => done(() => reject(new Error('spawn: ' + e.message))));
  });
}

// ── action: list_sessions ─────────────────────────────────────────────────────
// Enumerates real Claude Code conversations from ~/.claude/projects/<encoded>/*.jsonl.
// Each .jsonl = one conversation, filename = sessionId. cwd is read straight from
// the first JSONL line that has a `cwd` field (more reliable than dir-name decoding).
function listSessions() {
  if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) {
    return { root: CLAUDE_PROJECTS_DIR, sessions: [] };
  }
  const out = [];
  for (const projDir of fs.readdirSync(CLAUDE_PROJECTS_DIR)) {
    const dirPath = path.join(CLAUDE_PROJECTS_DIR, projDir);
    let stat;
    try { stat = fs.statSync(dirPath); } catch { continue; }
    if (!stat.isDirectory()) continue;
    let entries;
    try { entries = fs.readdirSync(dirPath); } catch { continue; }
    for (const file of entries) {
      if (!file.endsWith('.jsonl')) continue;
      const sessionId = file.replace(/\.jsonl$/, '');
      const full = path.join(dirPath, file);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      const meta = readSessionMeta(full);
      out.push({
        sessionId,
        cwd: meta.cwd || '(unknown)',
        lastModified: st.mtime.toISOString(),
        sizeBytes: st.size,
        firstMessagePreview: meta.firstUserMsg,
      });
    }
  }
  out.sort((a, b) => b.lastModified.localeCompare(a.lastModified));
  return { root: CLAUDE_PROJECTS_DIR, sessions: out };
}

// ── action: new_session ───────────────────────────────────────────────────────
function newSession(name) {
  const dir = resolveWorkspace(name, { create: true });
  return `created ${dir}`;
}

// ── dispatch a command row ────────────────────────────────────────────────────
async function finish(id, status, result) {
  const s = typeof result === 'string' ? result : JSON.stringify(result);
  await db.update('commands', `id=eq.${encodeURIComponent(id)}`, {
    status,
    result: s.slice(0, CONFIG.resultTruncate),
  });
}

async function processCommand(cmd) {
  let payload;
  try { payload = JSON.parse(cmd.content); }
  catch (e) {
    sysLog('warn', 'bad_json', { id: cmd.id.slice(0, 12) });
    return finish(cmd.id, 'error', 'BAD_JSON: ' + e.message);
  }

  const v = verifyPayload(payload, cfg.secret);
  if (!v.ok) {
    sysLog('warn', 'hmac_reject', { id: cmd.id.slice(0, 12), reason: v.reason, action: payload.action });
    return finish(cmd.id, 'error', 'HMAC_REJECT: ' + v.reason);
  }

  try {
    await db.update('commands', `id=eq.${encodeURIComponent(cmd.id)}`, { status: 'processing' });
  } catch (e) {
    warn('[mark-processing]', e.message.slice(0, 80));
  }

  try {
    if (payload.action === 'run_claude') {
      let opts;
      if (payload.session_id) {
        const info = findSessionInfo(payload.session_id);
        if (!info) return finish(cmd.id, 'error', 'UNKNOWN_SESSION: ' + payload.session_id);
        if (!info.cwd) return finish(cmd.id, 'error', 'SESSION_NO_CWD: ' + info.sessionId);
        opts = { mode: 'resume', sessionId: info.sessionId, cwd: info.cwd, fresh: false };
        sysLog('info', 'run_claude_start', {
          id: cmd.id.slice(0, 12),
          mode: 'resume',
          sessionId: info.sessionId.slice(0, 8),
          cwd: info.cwd,
          taskPreview: (payload.task || '').slice(0, 80),
        });
      } else {
        opts = { mode: 'workspace', cwd: resolveWorkspace(payload.session), fresh: payload.fresh };
        sysLog('info', 'run_claude_start', {
          id: cmd.id.slice(0, 12),
          mode: 'workspace',
          session: payload.session,
          taskPreview: (payload.task || '').slice(0, 80),
        });
      }
      const result = await runClaude(payload.task, opts, cmd.id);
      sysLog('info', 'run_claude_done', { id: cmd.id.slice(0, 12), len: result.length });
      return finish(cmd.id, 'completed', result);
    }
    if (payload.action === 'list_sessions') {
      const data = listSessions();
      sysLog('info', 'list_sessions', { count: data.sessions.length });
      return finish(cmd.id, 'completed', JSON.stringify(data));
    }
    if (payload.action === 'new_session') {
      const msg = newSession(payload.session);
      sysLog('info', 'new_session', { session: payload.session });
      return finish(cmd.id, 'completed', msg);
    }
    return finish(cmd.id, 'error', 'UNKNOWN_ACTION: ' + payload.action);
  } catch (e) {
    sysLog('error', 'action_fail', {
      id: cmd.id.slice(0, 12),
      action: payload.action,
      err: e.message.slice(0, 300),
    });
    return finish(cmd.id, 'error', e.message);
  }
}

// ── poll loop ─────────────────────────────────────────────────────────────────
async function poll() {
  if (isProcessing || shuttingDown) return;
  try {
    const rows = await db.select(
      'commands',
      `action=in.(run_claude,list_sessions,new_session)&status=eq.pending&target=eq.${encodeURIComponent(cfg.target)}&order=created_at.asc&limit=1&select=id,content,action`
    );
    if (!rows || !rows.length) return;
    isProcessing = true;
    try { await processCommand(rows[0]); }
    finally {
      isProcessing = false;
      await sendHeartbeat();
    }
  } catch (e) {
    err('[Poll]', e.message);
    isProcessing = false;
  }
}

// ── main ──────────────────────────────────────────────────────────────────────
async function main() {
  acquireLock();

  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  relay ' + VERSION.padEnd(40) + '  ║');
  console.log('║  hostname:  ' + HOSTNAME.padEnd(35) + '  ║');
  console.log('║  target:    ' + cfg.target.padEnd(35) + '  ║');
  console.log('║  workspace: ' + cfg.workspaceRoot.slice(0, 35).padEnd(35) + '  ║');
  console.log('║  PID:       ' + String(process.pid).padEnd(35) + '  ║');
  console.log('╚══════════════════════════════════════════════════╝');

  // Ensure workspace root exists
  fs.mkdirSync(cfg.workspaceRoot, { recursive: true });

  try {
    const ver = execSync(`"${cfg.claudePath}" --version`, { stdio: 'pipe', shell: true }).toString().trim();
    log('[OK] claude CLI:', ver);
  } catch (e) {
    warn('[WARN] claude --version failed:', e.message.slice(0, 80));
  }

  for (let i = 1; i <= CONFIG.startupRetries; i++) {
    try {
      await db.select('commands', 'limit=1&select=id');
      log('[OK] Supabase reachable');
      break;
    } catch (e) {
      if (i === CONFIG.startupRetries) {
        err('[FATAL] Supabase unreachable:', e.message);
        releaseLock();
        process.exit(1);
      }
      warn(`[Retry] Supabase ${i}/${CONFIG.startupRetries}:`, e.message.slice(0, 80));
      await new Promise((r) => setTimeout(r, CONFIG.startupRetryDelay));
    }
  }

  sysLog('info', 'startup', { hostname: HOSTNAME, target: cfg.target });
  await sendHeartbeat();

  setInterval(poll, CONFIG.pollInterval);
  setInterval(sendHeartbeat, CONFIG.heartbeatInterval);
  setInterval(keepAlive, CONFIG.keepAliveInterval);
  setInterval(cleanupSysLog, CONFIG.sysLogCleanupInterval);
  log('[Ready] polling every', CONFIG.pollInterval / 1000 + 's');
}

main().catch((e) => {
  err('[main]', e.stack || e.message);
  releaseLock();
  process.exit(1);
});
