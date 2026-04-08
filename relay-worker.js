/**
 * Remote Bridge Relay Worker v14
 * NEW: markitdown 기반 첨부파일 추출 (Cowork 동일 방식)
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
// Auto-detect Claude CLI location
function findClaude() {
  if (process.env.CLAUDE_PATH) {
    try { fs.accessSync(process.env.CLAUDE_PATH); return process.env.CLAUDE_PATH; } catch(e) {}
  }
  // Try 'where' command (Windows) or 'which' (Linux/Mac)
  const whichCmd = os.platform() === 'win32' ? 'where' : 'which';
  for (const name of ['claude.cmd', 'claude.bat', 'claude.exe', 'claude']) {
    try {
      const p = execSync(whichCmd + ' ' + name, { stdio: 'pipe', shell: true }).toString().trim().split('\n')[0].trim();
      if (p) return p;
    } catch(e) {}
  }
  // Search common Windows paths
  if (os.platform() === 'win32') {
    const home = process.env.USERPROFILE || process.env.HOME || '';
    const ad = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const lad = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const candidates = [
      path.join(ad, 'npm', 'claude.cmd'),
      path.join(ad, 'npm', 'node_modules', '.bin', 'claude.cmd'),
      path.join(lad, 'Programs', 'claude', 'claude.exe'),
      path.join(lad, 'AnthropicClaude', 'claude.exe'),
      path.join(home, '.claude', 'local', 'claude.exe'),
      'C:\\Program Files\\Claude\\claude.exe',
      'C:\\Program Files\\Anthropic\\claude.exe',
    ];
    for (const c of candidates) {
      try { fs.accessSync(c); return c; } catch(e) {}
    }
  }
  return 'claude'; // fallback
}
const CLAUDE_EXE = findClaude();

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

/**
 * Extract attached files from message content using markitdown
 * Parses [ATTACHED_FILE:filename]base64data[/ATTACHED_FILE] markers
 * Saves to temp, runs markitdown, replaces marker with extracted text
 */
async function extractAttachedFiles(content) {
  const regex = /\[ATTACHED_FILE:([^\]]+)\]\n([\s\S]*?)\n\[\/ATTACHED_FILE\]/g;
  let match;
  const files = [];
  while ((match = regex.exec(content)) !== null) {
    files.push({ name: match[1], data: match[2], fullMatch: match[0] });
  }
  if (files.length === 0) return content;

  let result = content;
  for (const f of files) {
    console.log('[Extract] Processing: ' + f.name + ' (' + Math.round(f.data.length * 0.75 / 1024) + 'KB)');
    const tmpDir = path.join(os.tmpdir(), 'relay-files-' + Date.now());
    try { fs.mkdirSync(tmpDir, { recursive: true }); } catch(e) {}
    const tmpPath = path.join(tmpDir, f.name);
    try {
      // Decode base64 and save to temp file
      const buf = Buffer.from(f.data, 'base64');
      fs.writeFileSync(tmpPath, buf);

      // Try markitdown first
      let extracted = '';
      try {
        extracted = execSync('markitdown "' + tmpPath + '"', {
          timeout: 60000, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024
        }).trim();
      } catch(e1) {
        // Fallback: try python -m markitdown
        try {
          extracted = execSync('python -m markitdown "' + tmpPath + '"', {
            timeout: 60000, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024
          }).trim();
        } catch(e2) {
          try {
            extracted = execSync('python3 -m markitdown "' + tmpPath + '"', {
              timeout: 60000, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024
            }).trim();
          } catch(e3) {
            console.error('[Extract] markitdown failed for ' + f.name + ':', e3.message);
            extracted = '[파일 추출 실패: ' + f.name + ' - markitdown 미설치 또는 오류]';
          }
        }
      }

      // Replace the marker with extracted content
      const replacement = '\n--- 첨부파일: ' + f.name + ' ---\n' + extracted + '\n--- 끝: ' + f.name + ' ---\n';
      result = result.replace(f.fullMatch, replacement);
      console.log('[Extract] Done: ' + f.name + ' -> ' + extracted.length + ' chars');
    } catch(e) {
      console.error('[Extract] Error processing ' + f.name + ':', e.message);
      result = result.replace(f.fullMatch, '\n[파일 처리 오류: ' + f.name + ']\n');
    } finally {
      // Cleanup
      try { fs.unlinkSync(tmpPath); } catch(e) {}
      try { fs.rmdirSync(tmpDir); } catch(e) {}
    }
  }
  return result;
}

async function processMessage(msg) {
  const { id, chat_id, content } = msg;
  console.log('[Worker] msg=' + id.slice(0,16) + ' len=' + content.length);
  try { await dbUpdate('messages', 'id=eq.' + encodeURIComponent(id), { status: 'processing' }); } catch(e) {}
  await sendHeartbeat();
  try {
    // v14: Extract attached files using markitdown before building prompt
    const processedContent = await extractAttachedFiles(content);
    const prompt = await buildPrompt(chat_id, processedContent);
    const response = await runClaude(prompt);
    console.log('[Worker] 응답:', response.slice(0,60));
    const replyId = 'rep-' + Date.now();
    await dbInsert('messages', {
      id: replyId, chat_id, role: 'assistant',
      content: response, status: 'completed'
    });
    await dbUpdate('messages', 'id=eq.' + encodeURIComponent(id), { status: 'completed' });
  } catch(e) {
    console.error('[Worker] Error:', e.message);
    await dbUpdate('messages', 'id=eq.' + encodeURIComponent(id), {
      status: 'error',
      content: '[오류] ' + e.message
    });
  }
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
  console.log('[Relay] Remote Bridge Relay Worker v14');
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
