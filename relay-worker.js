/**
 * Remote Bridge Relay Worker v8
 * - Uses Node.js built-in 'https' module (no SDK, no fetch dependency)
 * - Watches 'messages' table for pending user messages
 * - Uses local Claude CLI (claude --print) via Max plan - no API key needed
 */

const https = require('https');
const { spawn } = require('child_process');
const { execSync } = require('child_process');
const crypto = require('crypto');

const SUPA_HOST = 'rnnigyfzwlgojxyccgsm.supabase.co';
const SUPA_KEY  = 'sb_publishable_Nmv51BZccADB0bN5JY2URw_lLffyFgE';

const CONFIG = {
  pollInterval: 3000,
  claudeTimeout: 300000,
  heartbeatInterval: 20000,
};

let isProcessing = false;

// --- Low-level HTTPS helper ---
function supaReq(method, path, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const headers = {
      'apikey': SUPA_KEY,
      'Authorization': 'Bearer ' + SUPA_KEY,
      'Content-Type': 'application/json',
    };
    if (extraHeaders) Object.assign(headers, extraHeaders);
    if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);

    const req = https.request({
      hostname: SUPA_HOST,
      path: '/rest/v1/' + path,
      method: method,
      headers: headers,
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        const ok = res.statusCode >= 200 && res.statusCode < 300;
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : null; } catch(e) { parsed = raw; }
        if (ok) resolve(parsed);
        else reject(new Error('HTTP ' + res.statusCode + ': ' + JSON.stringify(parsed)));
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function dbSelect(table, query) {
  return supaReq('GET', table + (query ? '?' + query : ''), null, null);
}
function dbInsert(table, obj) {
  return supaReq('POST', table, obj, { 'Prefer': 'return=minimal' });
}
function dbUpdate(table, query, obj) {
  return supaReq('PATCH', table + '?' + query, obj, { 'Prefer': 'return=minimal' });
}
function dbUpsert(table, obj) {
  return supaReq('POST', table, obj, { 'Prefer': 'resolution=merge-duplicates,return=minimal' });
}

// --- Heartbeat ---
async function sendHeartbeat(busy) {
  try {
    await dbUpsert('commands', {
      id: 'relay-heartbeat',
      content: busy ? 'busy' : 'idle',
      status: 'heartbeat',
      updated_at: new Date().toISOString(),
    });
  } catch (e) { /* silent */ }
}

// --- Claude CLI ---
function runClaude(prompt) {
  return new Promise((resolve, reject) => {
    const proc = spawn('claude', ['--print', prompt], {
      timeout: CONFIG.claudeTimeout,
      env: process.env,
    });
    let out = '', err = '';
    proc.stdout.on('data', d => { out += d.toString(); });
    proc.stderr.on('data', d => { err += d.toString(); });
    proc.on('close', code => {
      if (code === 0) resolve(out.trim());
      else reject(new Error('claude exit ' + code + ': ' + err.substring(0, 300)));
    });
    proc.on('error', e => reject(new Error('spawn: ' + e.message)));
  });
}

// --- Build prompt with history ---
async function buildPrompt(chatId, currentContent) {
  try {
    const rows = await dbSelect('messages',
      'chat_id=eq.' + encodeURIComponent(chatId) +
      '&status=eq.completed&order=created_at.asc&limit=20&select=role,content');
    if (!rows || rows.length === 0) return currentContent;
    const hist = rows
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => (m.role === 'user' ? 'Human' : 'Assistant') + ': ' + m.content)
      .join('\n\n');
    return hist + '\n\nHuman: ' + currentContent;
  } catch (e) {
    return currentContent;
  }
}

// --- Process one pending message ---
async function processMessage(msg) {
  const id = msg.id, chat_id = msg.chat_id, content = msg.content;
  console.log('[Worker] msg=' + String(id).substring(0,8) + ' chat=' + String(chat_id).substring(0,8));

  try { await dbUpdate('messages', 'id=eq.' + id, { status: 'processing' }); } catch(e) {}
  await sendHeartbeat(true);

  try {
    const prompt = await buildPrompt(chat_id, content);
    const response = await runClaude(prompt);

    const rid = (typeof crypto.randomUUID === 'function')
      ? crypto.randomUUID()
      : 'resp-' + Date.now() + '-' + Math.random().toString(36).slice(2,8);

    await dbInsert('messages', {
      id: rid,
      chat_id: chat_id,
      role: 'assistant',
      content: response,
      status: 'completed',
      created_at: new Date().toISOString(),
    });
    try { await dbUpdate('messages', 'id=eq.' + id, { status: 'completed' }); } catch(e) {}
    console.log('[Worker] OK ->', rid.substring(0,8));

  } catch (err) {
    console.error('[Worker] Error:', err.message);
    try {
      await dbInsert('messages', {
        id: 'err-' + Date.now(),
        chat_id: chat_id,
        role: 'assistant',
        content: '[\uC624\uB958] ' + err.message,
        status: 'error',
        created_at: new Date().toISOString(),
      });
      await dbUpdate('messages', 'id=eq.' + id, { status: 'error' });
    } catch(e2) {}
  }

  await sendHeartbeat(false);
}

// --- Poll ---
async function poll() {
  if (isProcessing) return;
  try {
    const rows = await dbSelect('messages',
      'role=eq.user&status=eq.pending&order=created_at.asc&limit=1');
    if (!rows || rows.length === 0) return;
    isProcessing = true;
    await processMessage(rows[0]);
    isProcessing = false;
  } catch (e) {
    console.error('[Poll] Error:', e.message);
    isProcessing = false;
  }
}

// --- Main ---
async function main() {
  console.log('[Relay] Remote Bridge Relay Worker v8 (https mode)');
  console.log('[Relay] Max plan (Claude CLI) - no API key, no SDK');
  console.log('');

  try {
    const ver = execSync('claude --version', { stdio: 'pipe' }).toString().trim();
    console.log('[OK] Claude CLI:', ver);
  } catch (e) {
    console.error('[ERROR] Claude CLI not found.');
    process.exit(1);
  }

  try {
    const rows = await dbSelect('messages', 'limit=1&select=id');
    console.log('[OK] Supabase connected, messages table OK');
  } catch (e) {
    console.error('[ERROR] Supabase failed:', e.message);
    process.exit(1);
  }

  console.log('[OK] Ready. Polling every', CONFIG.pollInterval, 'ms...\n');
  await sendHeartbeat(false);
  setInterval(() => sendHeartbeat(isProcessing), CONFIG.heartbeatInterval);
  setInterval(poll, CONFIG.pollInterval);
  poll();
}

main().catch(e => { console.error('[FATAL]', e.message); process.exit(1); });
