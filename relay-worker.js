/**
 * Remote Bridge Relay Worker v12
 * FIX 1: 시작 시 'processing' 메시지를 'pending'으로 자동 복구
 * FIX 2: claude --print 프롬프트를 임시파일로 전달 (한글/특수문자 안전)
 * FIX 3: shell:true + CLAUDE_PATH 환경변수 지원
 */
const https   = require('https');
const { spawn } = require('child_process');
const { execSync } = require('child_process');
const crypto  = require('crypto');
const os      = require('os');
const fs      = require('fs');
const path    = require('path');

const SUPA_HOST = 'rnnigyfzwlgojxyccgsm.supabase.co';
const SUPA_KEY  = 'sb_publishable_Nmv51BZccADB0bN5JY2URw_lLffyFgE';

const CONFIG = {
  pollInterval:      3000,
  claudeTimeout:     120000,
  heartbeatInterval: 15000,
  maxPromptLen:      4000,
};

let isProcessing = false;
const HOSTNAME = os.hostname();
const CLAUDE_EXE = process.env.CLAUDE_PATH || 'claude';

function supaReq(method, spath, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const headers = {
      'apikey': SUPA_KEY, 'Authorization': 'Bearer ' + SUPA_KEY,
      'Content-Type': 'application/json',
    };
    if (extraHeaders) Object.assign(headers, extraHeaders);
    if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);
    const req = https.request({
      hostname: SUPA_HOST, path: '/rest/v1/' + spath, method,
      headers,
    }, res => {
      let raw = ''; res.on('data', c => raw += c);
      res.on('end', () => {
        const ok = res.statusCode >= 200 && res.statusCode < 300;
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : null; } catch(e) { parsed = raw; }
        if (ok) resolve(parsed); else reject(new Error('HTTP ' + res.statusCode + ': ' + JSON.stringify(parsed)));
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function dbSelect(table, q) { return supaReq('GET', table + (q ? '?' + q : ''), null, null); }
function dbInsert(table, obj) { return supaReq('POST', table, obj, { 'Prefer': 'return=minimal' }); }
function dbUpdate(table, q, obj) { return supaReq('PATCH', table + '?' + q, obj, { 'Prefer': 'return=minimal' }); }
function dbUpsert(table, obj) { return supaReq('POST', table, obj, { 'Prefer': 'resolution=merge-duplicates,return=minimal' }); }

async function sendHeartbeat() {
  const ts = new Date().toISOString();
  try { await dbUpsert('commands', { id: 'relay-heartbeat', action: 'heartbeat', target: 'relay', content: isProcessing ? 'busy' : 'idle', status: 'completed', result: ts }); } catch(e) { console.error('[HB] relay:', e.message); }
  try { await dbUpsert('commands', { id: 'bridge-heartbeat', action: 'heartbeat', target: 'bridge', content: 'relay-written', status: 'completed', result: ts }); } catch(e) { console.error('[HB] bridge:', e.message); }
}

// FIX 1: 시작 시 고착된 processing 메시지 복구
async function recoverStuck() {
  try {
    const stuck = await dbSelect('messages', 'role=eq.user&status=eq.processing&select=id,content');
    if (!stuck || stuck.length === 0) { console.log('[Recovery] 고착 메시지 없음'); return; }
    console.log('[Recovery]', stuck.length, '개 processing -> pending 복구');
    for (const m of stuck) {
      await dbUpdate('messages', 'id=eq.' + encodeURIComponent(m.id), { status: 'pending' });
      console.log('[Recovery]  -', m.id.slice(0,8), '"' + (m.content||'').slice(0,40) + '"');
    }
  } catch(e) { console.error('[Recovery] 실패:', e.message); }
}

async function handlePings() {
  try {
    const rows = await dbSelect('commands', 'action=eq.ping&status=eq.pending&order=created_at.asc&limit=10');
    if (!rows || rows.length === 0) return;
    const now = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
    for (const row of rows) {
      await dbUpdate('commands', 'id=eq.' + row.id, { status: 'completed', result: 'pong v12/' + HOSTNAME + ' ' + now });
    }
  } catch(e) {}
}

// FIX 2: 프롬프트를 임시파일 stdin으로 전달 (한글/특수문자 안전)
function runClaude(prompt) {
  return new Promise((resolve, reject) => {
    const tmpFile = path.join(os.tmpdir(), 'relay-' + Date.now() + '.txt');
    try { fs.writeFileSync(tmpFile, prompt, 'utf8'); } catch(e) { reject(new Error('tmpfile: ' + e.message)); return; }

    const cmd = CLAUDE_EXE + ' --print < "' + tmpFile + '"';
    console.log('[Claude] 실행 (prompt ' + prompt.length + '자)');

    const proc = spawn(cmd, [], { timeout: CONFIG.claudeTimeout, shell: true, env: process.env, windowsHide: true });
    let out = '', err = '';
    proc.stdout.on('data', d => { out += d.toString(); });
    proc.stderr.on('data', d => { err += d.toString(); });
    proc.on('close', code => {
      try { fs.unlinkSync(tmpFile); } catch(e) {}
      if (code === 0 && out.trim()) resolve(out.trim());
      else if (code === 0) reject(new Error('응답 없음. stderr: ' + err.slice(0,150)));
      else reject(new Error('exit ' + code + ': ' + (err||out).slice(0,200)));
    });
    proc.on('error', e => { try { fs.unlinkSync(tmpFile); } catch(e2) {} reject(new Error('spawn: ' + e.message)); });
  });
}

async function buildPrompt(chatId, content) {
  try {
    const rows = await dbSelect('messages', 'chat_id=eq.' + encodeURIComponent(chatId) + '&status=eq.completed&order=created_at.asc&limit=10&select=role,content');
    if (!rows || rows.length === 0) return content;
    const hist = rows.filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => (m.role === 'user' ? 'Human' : 'Assistant') + ': ' + (m.content||'').slice(0,500)).join('\n\n');
    const full = hist + '\n\nHuman: ' + content;
    return full.length > CONFIG.maxPromptLen ? content : full;
  } catch(e) { return content; }
}

async function processMessage(msg) {
  const { id, chat_id, content } = msg;
  console.log('[Worker]', id.slice(0,8), '"' + (content||'').slice(0,50) + '"');
  try { await dbUpdate('messages', 'id=eq.' + encodeURIComponent(id), { status: 'processing' }); } catch(e) {}
  await sendHeartbeat();
  try {
    const prompt = await buildPrompt(chat_id, content);
    const response = await runClaude(prompt);
    console.log('[Worker] 응답:', response.slice(0,60));
    const rid = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : 'resp-' + Date.now() + '-' + Math.random().toString(36).slice(2,8);
    await dbInsert('messages', { id: rid, chat_id, role: 'assistant', content: response, status: 'completed', created_at: new Date().toISOString() });
    try { await dbUpdate('messages', 'id=eq.' + encodeURIComponent(id), { status: 'completed' }); } catch(e) {}
    console.log('[Worker] 완료 ->', rid.slice(0,8));
  } catch(err) {
    console.error('[Worker] 오류:', err.message);
    try {
      await dbInsert('messages', { id: 'err-' + Date.now(), chat_id, role: 'assistant', content: '⚠️ 오류: ' + err.message, status: 'error', created_at: new Date().toISOString() });
      await dbUpdate('messages', 'id=eq.' + encodeURIComponent(id), { status: 'completed' });
    } catch(e2) {}
  }
  await sendHeartbeat();
}

async function poll() {
  if (isProcessing) return;
  try {
    const rows = await dbSelect('messages', 'role=eq.user&status=eq.pending&order=created_at.asc&limit=1');
    if (!rows || rows.length === 0) return;
    isProcessing = true;
    await processMessage(rows[0]);
    isProcessing = false;
  } catch(e) { console.error('[Poll]', e.message); isProcessing = false; }
}

async function main() {
  console.log('[Relay] Remote Bridge Relay Worker v12');
  console.log('[Relay] Hostname:', HOSTNAME); console.log('');

  try {
    const ver = execSync(CLAUDE_EXE + ' --version', { stdio: 'pipe', shell: true }).toString().trim();
    console.log('[OK] Claude CLI:', ver);
  } catch(e) {
    console.warn('[WARN] claude --version 실패:', e.message.slice(0,80));
    console.warn('[HINT] CMD에서 "where claude" 확인 후 set CLAUDE_PATH=<경로> 재시작');
  }

  try { await dbSelect('messages', 'limit=1&select=id'); console.log('[OK] Supabase 연결 성공'); }
  catch(e) { console.error('[FATAL] Supabase 실패:', e.message); process.exit(1); }

  await recoverStuck();
  await sendHeartbeat();
  console.log('[OK] 하트비트 전송 완료 (relay + bridge)');
  console.log('[OK] 폴링 시작...\n');

  setInterval(sendHeartbeat, CONFIG.heartbeatInterval);
  setInterval(handlePings, CONFIG.pollInterval);
  setInterval(poll, CONFIG.pollInterval);
  poll(); handlePings();
}

main().catch(e => { console.error('[FATAL]', e.message); process.exit(1); });
