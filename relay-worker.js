/**
 * Remote Bridge Relay Worker v31
 * ======================================
 * Changes from v30:
 * - Supabase sys_log: all events logged → Claude can monitor & auto-fix
 * - Startup resilience: retries Supabase 5x instead of immediate exit
 * - Supabase keep-alive: pings every 6h to prevent free-tier project pause
 * - Graceful restart: handles 'relay-restart' command via Supabase
 * - Detailed error context: errors include stack + message_id for diagnosis
 * - DRM fix: pre-snapshot FED5 PIDs (from v30) maintained
 */
const https    = require('https');
const { spawn } = require('child_process');
const { execSync, spawnSync } = require('child_process');
const crypto   = require('crypto');
const os       = require('os');
const fs       = require('fs');
const path     = require('path');

const SUPA_HOST = 'rnnigyfzwlgojxyccgsm.supabase.co';
const SUPA_URL  = 'https://' + SUPA_HOST;
const SUPA_KEY  = 'sb_publishable_Nmv51BZccADB0bN5JY2URw_lLffyFgE';
const VERSION   = 'v31';
const LOCK_FILE = path.join(os.tmpdir(), 'relay-worker.lock');

const CONFIG = {
  pollInterval:         3000,
  claudeTimeout:        120000,
  heartbeatInterval:    15000,
  maxPromptLen:         8000,
  bridgeExtractTimeout: 90000,
  keepAliveInterval:    6 * 60 * 60 * 1000,   // 6h — prevents Supabase free-tier pause
  sysLogMaxRows:        500,                    // Keep sys_log table lean
  startupRetries:       5,                      // Retry Supabase check on startup
  startupRetryDelay:    10000,                  // 10s between startup retries
};

let isProcessing  = false;
let shuttingDown  = false;
const HOSTNAME = os.hostname();
const CLAUDE_EXE = process.env.CLAUDE_PATH || 'claude';

function ts() {
  return new Date().toLocaleTimeString('ko-KR', { hour12: false });
}
function log(...args)  { console.log('[' + ts() + ']', ...args); }
function warn(...args) { console.warn('[' + ts() + '] WARN', ...args); }
function err(...args)  { console.error('[' + ts() + '] ERR', ...args); }

// ── Single-instance lock ───────────────────────────────────────────────────────
function acquireLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const oldPid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10);
      if (!isNaN(oldPid) && oldPid !== process.pid) {
        try {
          process.kill(oldPid, 0);
          log('[Lock] 기존 릴레이(PID=' + oldPid + ') 종료 중...');
          try { process.kill(oldPid, 'SIGTERM'); } catch(e) {}
          const killDeadline = Date.now() + 3000;
          while (Date.now() < killDeadline) {
            try { process.kill(oldPid, 0); } catch(e) { break; }
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
          }
        } catch(e) {
          log('[Lock] 스테일 락 파일 (PID=' + oldPid + '), 무시');
        }
      }
    }
    fs.writeFileSync(LOCK_FILE, String(process.pid), 'utf8');
    log('[Lock] 락 취득 (PID=' + process.pid + ')');
  } catch (e) {
    warn('[Lock] 락 파일 오류:', e.message);
  }
}

function releaseLock() {
  try {
    const current = fs.readFileSync(LOCK_FILE, 'utf8').trim();
    if (current === String(process.pid)) fs.unlinkSync(LOCK_FILE);
  } catch(e) {}
}

process.on('exit', releaseLock);
process.on('SIGINT', () => { releaseLock(); process.exit(0); });
process.on('SIGTERM', () => { releaseLock(); process.exit(0); });
process.on('uncaughtException', e => { err('[Fatal]', e.message); releaseLock(); process.exit(1); });

// ── HTTPS helper (with retry) ──────────────────────────────────────────────────
async function supaReq(method, path, body, extraHeaders, retryCount = 0) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const headers = {
      'apikey':        SUPA_KEY,
      'Authorization': 'Bearer ' + SUPA_KEY,
      'Content-Type':  'application/json',
    };
    if (extraHeaders) Object.assign(headers, extraHeaders);
    if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);
    const req = https.request({
      hostname: SUPA_HOST,
      path:     '/rest/v1/' + path,
      method:   method,
      headers:  headers,
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
    req.on('error', async e => {
      const retryable = ['EAI_AGAIN', 'ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED'].includes(e.code);
      if (retryable && retryCount < 3) {
        const delay = (retryCount + 1) * 3000;
        warn('[Retry] ' + e.code + ' → ' + delay + 'ms 후 재시도 (' + (retryCount+1) + '/3)');
        await new Promise(r => setTimeout(r, delay));
        supaReq(method, path, body, extraHeaders, retryCount + 1).then(resolve).catch(reject);
      } else {
        reject(e);
      }
    });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function dbSelect(table, query) { return supaReq('GET', table + (query ? '?' + query : ''), null, null); }
function dbInsert(table, obj)   { return supaReq('POST', table, obj, { 'Prefer': 'return=minimal' }); }
function dbUpdate(table, query, obj) { return supaReq('PATCH', table + '?' + query, obj, { 'Prefer': 'return=minimal' }); }
function dbUpsert(table, obj)   { return supaReq('POST', table, obj, { 'Prefer': 'resolution=merge-duplicates,return=minimal' }); }
function dbDelete(table, query) { return supaReq('DELETE', table + '?' + query, null, null); }

// ── sys_log: fire-and-forget Supabase logging ─────────────────────────────────
// Writes to sys_log table. If table doesn't exist, silently no-ops.
// Claude monitors this table via scheduled task to auto-diagnose issues.
function sysLog(level, event, detail) {
  const id = 'log-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  const obj = {
    id,
    level,       // 'info' | 'warn' | 'error' | 'fatal'
    component:   'relay',
    event,       // e.g. 'startup', 'message_received', 'error', 'drm_start'
    detail:      typeof detail === 'string' ? detail : JSON.stringify(detail),
    hostname:    HOSTNAME,
    version:     VERSION,
    created_at:  new Date().toISOString(),
  };
  // Fire-and-forget: never throws, never blocks
  dbInsert('sys_log', obj).catch(() => {});
}

// Periodic cleanup: keep only last N rows in sys_log
async function cleanupSysLog() {
  try {
    // Get the Nth oldest row's created_at
    const rows = await dbSelect('sys_log',
      'order=created_at.desc&limit=1&offset=' + CONFIG.sysLogMaxRows + '&select=created_at');
    if (rows && rows.length > 0) {
      const cutoff = rows[0].created_at;
      await dbDelete('sys_log', 'created_at=lt.' + encodeURIComponent(cutoff));
      log('[SysLog] 오래된 로그 정리 완료 (cutoff:', cutoff, ')');
    }
  } catch(e) { /* silent — table may not exist */ }
}

// ── Supabase keep-alive ────────────────────────────────────────────────────────
// Supabase free tier pauses after ~1 week of inactivity.
// This periodic ping prevents that.
async function keepAlive() {
  try {
    await dbSelect('messages', 'limit=1&select=id');
    log('[KeepAlive] Supabase 핑 성공 — 프리 티어 일시정지 방지');
  } catch(e) {
    warn('[KeepAlive] Supabase 핑 실패:', e.message.slice(0, 80));
  }
}

// ── Download file from file_chunks ────────────────────────────────────────────
async function chunksDownload(messageId, fileName) {
  const query = `message_id=eq.${encodeURIComponent(messageId)}&file_name=eq.${encodeURIComponent(fileName)}&order=chunk_index.asc&select=chunk_index,total_chunks,data`;
  const chunks = await dbSelect('file_chunks', query);
  if (!chunks || chunks.length === 0) {
    throw new Error(`No chunks found for message=${messageId}, file=${fileName}`);
  }
  const totalExpected = chunks[0].total_chunks;
  if (chunks.length !== totalExpected) {
    warn(`[Chunks] 경고: ${fileName} - 예상 ${totalExpected}개 중 ${chunks.length}개 수신`);
  }
  chunks.sort((a, b) => a.chunk_index - b.chunk_index);
  const base64Full = chunks.map(c => c.data).join('');
  const buffer = Buffer.from(base64Full, 'base64');
  log(`[Chunks] ${fileName}: ${chunks.length}청크 → ${buffer.length} bytes`);
  return buffer;
}

// ── Heartbeat ─────────────────────────────────────────────────────────────────
async function sendHeartbeat() {
  const tsVal = new Date().toISOString();
  try {
    await dbUpsert('commands', {
      id: 'relay-heartbeat', action: 'heartbeat', target: 'relay',
      content: isProcessing ? 'busy' : 'idle', status: 'completed', result: tsVal,
    });
  } catch (e) { /* silent */ }
}

// ── Check if Bridge (company PC) is online ────────────────────────────────────
async function checkBridgeOnline() {
  try {
    const rows = await dbSelect('commands', 'id=eq.bridge-heartbeat&select=result');
    if (rows && rows.length && rows[0].result) {
      const ago = (Date.now() - new Date(rows[0].result).getTime()) / 1000;
      return ago < 120;
    }
    return false;
  } catch(e) { return false; }
}

// ── Recover stuck messages ─────────────────────────────────────────────────────
async function recoverStuckMessages() {
  try {
    const stuck = await dbSelect('messages', 'role=eq.user&status=eq.processing&select=id,content');
    if (!stuck || stuck.length === 0) return;
    log('[Recovery] processing 상태 메시지', stuck.length, '개 → pending 복구');
    sysLog('warn', 'stuck_messages_recovered', { count: stuck.length });
    for (const msg of stuck) {
      await dbUpdate('messages', 'id=eq.' + encodeURIComponent(msg.id), { status: 'pending' });
    }
  } catch (e) {
    err('[Recovery] 실패:', e.message);
  }
}

// ── Command Handler (ping + restart + auto_debug) ─────────────────────────────
async function handleCommands() {
  try {
    const rows = await dbSelect('commands',
      'action=in.(ping,relay-restart,relay-status,auto_debug)&status=eq.pending&order=created_at.asc&limit=10');
    if (!rows || rows.length === 0) return;

    const now = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });

    for (const row of rows) {
      if (row.action === 'relay-restart') {
        log('[Command] relay-restart → graceful shutdown');
        sysLog('info', 'restart_command', { cmd_id: row.id });
        await dbUpdate('commands', 'id=eq.' + row.id, {
          status: 'completed',
          result: 'relay ' + VERSION + '/' + HOSTNAME + ' shutting down at ' + now,
        });
        setTimeout(() => { releaseLock(); process.exit(0); }, 500);
        return;
      }

      if (row.action === 'relay-status') {
        const statusDetail = JSON.stringify({
          version: VERSION, hostname: HOSTNAME, pid: process.pid,
          isProcessing, uptime: process.uptime().toFixed(0) + 's', time: now,
        });
        await dbUpdate('commands', 'id=eq.' + row.id, { status: 'completed', result: statusDetail });
        continue;
      }

      if (row.action === 'auto_debug') {
        // 브라우저가 45초 응답 없음 감지 → 자가진단 실행
        log('[AutoDebug] 자가진단 요청 수신');
        await dbUpdate('commands', 'id=eq.' + row.id, { status: 'completed', result: 'diagnosing' });
        // 비동기로 진단 실행 (polling을 block하지 않음)
        runAutoDebug(row).catch(e => err('[AutoDebug] 오류:', e.message));
        continue;
      }

      // ping
      await dbUpdate('commands', 'id=eq.' + row.id, {
        status: 'completed',
        result: 'pong from relay ' + VERSION + '/' + HOSTNAME + ' at ' + now,
      });
    }
  } catch (e) { /* silent */ }
}

// ── Auto-Debug: relay self-diagnosis using Claude CLI ─────────────────────────
async function runAutoDebug(cmd) {
  const chatId = cmd.target;
  let ctx = {};
  try { ctx = JSON.parse(cmd.content || '{}'); } catch(e) {}

  sysLog('info', 'auto_debug_start', { chatId: chatId ? chatId.slice(0,8) : '?', ctx: JSON.stringify(ctx).slice(0, 200) });

  // Gather diagnostics
  let diagText = '=== 자가진단 보고서 ===\n';
  diagText += `시간: ${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}\n`;
  diagText += `릴레이: ${VERSION}/${HOSTNAME} (PID=${process.pid}, 가동시간=${process.uptime().toFixed(0)}s)\n`;
  diagText += `처리 중: ${isProcessing}\n\n`;

  // Check stuck messages
  try {
    const stuck = await dbSelect('messages', 'role=eq.user&status=in.(pending,processing)&select=id,status,created_at');
    if (stuck && stuck.length > 0) {
      diagText += `대기/처리 중 메시지: ${stuck.length}개\n`;
      stuck.forEach(m => {
        const age = Math.floor((Date.now() - new Date(m.created_at).getTime()) / 1000);
        diagText += `  - id=${m.id.slice(0,8)} status=${m.status} (${age}초 전)\n`;
      });
    } else {
      diagText += '대기 메시지: 없음\n';
    }
  } catch(e) {
    diagText += `대기 메시지 확인 실패: ${e.message}\n`;
  }

  // Recent sys_log errors
  try {
    const errs = await dbSelect('sys_log', 'level=in.(error,fatal)&order=created_at.desc&limit=5&select=event,detail,created_at');
    if (errs && errs.length > 0) {
      diagText += '\n최근 오류:\n';
      errs.forEach(e => {
        diagText += `  [${e.event}] ${(e.detail||'').slice(0, 120)}\n`;
      });
    }
  } catch(e) { diagText += '\nsys_log 접근 불가\n'; }

  // Check Claude CLI
  try {
    const ver = execSync(CLAUDE_EXE + ' --version', { stdio: 'pipe', shell: true, timeout: 5000 }).toString().trim();
    diagText += `\nClaude CLI: ${ver}\n`;
  } catch(e) {
    diagText += `\nClaude CLI 오류: ${e.message.slice(0, 100)}\n`;
  }

  // Context from browser
  if (ctx.recentErrors && ctx.recentErrors !== '없음') {
    diagText += `\n브라우저가 보고한 오류:\n${ctx.recentErrors.slice(0, 300)}\n`;
  }

  // Run Claude to diagnose
  const diagPrompt = `당신은 Remote Bridge v31 자가진단 AI입니다. 다음 진단 정보를 분석하고, 한국어로 간결하게 (5줄 이내) 문제와 해결책을 알려주세요.

${diagText}

분석 결과를 다음 형식으로 출력하세요:
🔍 **진단 결과**: (무엇이 문제인지)
🔧 **해결 방법**: (사용자가 취해야 할 행동, 또는 "자동 복구 완료")`;

  let diagResult = diagText;
  try {
    diagResult = await runClaude(diagPrompt);
    sysLog('info', 'auto_debug_done', { chatId: chatId ? chatId.slice(0,8) : '?' });
  } catch(e) {
    diagResult = `진단 완료 (Claude CLI 응답 없음):\n\n${diagText}`;
    sysLog('error', 'auto_debug_claude_fail', { err: e.message.slice(0, 200) });
  }

  // Auto-recover stuck messages
  try {
    const stuck = await dbSelect('messages', 'role=eq.user&status=eq.processing&select=id');
    for (const m of (stuck || [])) {
      await dbUpdate('messages', 'id=eq.' + encodeURIComponent(m.id), { status: 'pending' });
      log('[AutoDebug] stuck 메시지 복구:', m.id.slice(0, 8));
    }
  } catch(e) {}

  // Post diagnosis result to chat
  if (chatId) {
    try {
      const rid = 'debug-' + Date.now();
      await dbInsert('messages', {
        id: rid, chat_id: chatId, role: 'assistant',
        content: diagResult, status: 'completed',
        files: null, created_at: new Date().toISOString(),
      });
      log('[AutoDebug] 진단 결과 전송 완료');
    } catch(e) {
      err('[AutoDebug] 결과 전송 실패:', e.message);
    }
  }
}

// ── Run Claude ─────────────────────────────────────────────────────────────────
function runClaude(prompt) {
  return new Promise((resolve, reject) => {
    const tmpFile = path.join(os.tmpdir(), 'relay-prompt-' + Date.now() + '.txt');
    try {
      fs.writeFileSync(tmpFile, prompt, 'utf8');
    } catch (e) {
      reject(new Error('임시파일 쓰기 실패: ' + e.message));
      return;
    }
    const cmd = CLAUDE_EXE + ' --print < "' + tmpFile + '"';
    log('[Claude] 실행:', cmd.slice(0, 80));
    const proc = spawn(cmd, [], {
      timeout: CONFIG.claudeTimeout,
      shell:   true,
      env:     process.env,
    });
    let out = '', errText = '';
    proc.stdout.on('data', d => { out += d.toString(); });
    proc.stderr.on('data', d => { errText += d.toString(); });
    proc.on('close', code => {
      try { fs.unlinkSync(tmpFile); } catch(e) {}
      if (code === 0 && out.trim()) {
        resolve(out.trim());
      } else if (code === 0 && !out.trim()) {
        reject(new Error('claude 응답 없음. stderr: ' + errText.slice(0, 200)));
      } else {
        reject(new Error('claude 종료코드 ' + code + ': ' + (errText || out).slice(0, 300)));
      }
    });
    proc.on('error', e => {
      try { fs.unlinkSync(tmpFile); } catch(e2) {}
      reject(new Error('Claude 실행 실패: ' + e.message));
    });
  });
}

// ── Build prompt ───────────────────────────────────────────────────────────────
async function buildPrompt(chatId, currentContent) {
  try {
    const rows = await dbSelect('messages',
      'chat_id=eq.' + encodeURIComponent(chatId) +
      '&status=eq.completed&order=created_at.asc&limit=10&select=id,role,content,files');
    if (!rows || rows.length === 0) return currentContent;
    const hist = rows
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => {
        let line = (m.role === 'user' ? 'Human' : 'Assistant') + ': ' + (m.content||'').slice(0, 600);
        if (m.files && Array.isArray(m.files) && m.files.length > 0) {
          const fileNames = m.files.map(f => f.name).join(', ');
          line += '\n[첨부파일: ' + fileNames + ']';
        }
        return line;
      })
      .join('\n\n');
    const full = hist + '\n\nHuman: ' + currentContent;
    return full.length > CONFIG.maxPromptLen
      ? 'Human: ' + currentContent
      : full;
  } catch (e) {
    return currentContent;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// File content extraction
// ═══════════════════════════════════════════════════════════════════════════════

function isPdfBuffer(buf) {
  return buf.length >= 4 &&
    buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46;
}

function extractViaPdf(filePath) {
  const pyCommands = ['python', 'py', 'python3'];
  for (const pyCmd of pyCommands) {
    try {
      const script = `
import sys
try:
    from pdfminer.high_level import extract_text
    print(extract_text(sys.argv[1]))
    sys.exit(0)
except ImportError:
    pass
try:
    import pypdf
    r = pypdf.PdfReader(sys.argv[1])
    print("\\n".join(p.extract_text() or "" for p in r.pages))
    sys.exit(0)
except ImportError:
    pass
sys.exit(1)
`.trim();
      const scriptPath = path.join(os.tmpdir(), 'pdf-extract-' + Date.now() + '.py');
      fs.writeFileSync(scriptPath, script, 'utf8');
      try {
        const out = execSync(`${pyCmd} "${scriptPath}" "${filePath}"`,
          { encoding: 'utf8', timeout: 30000, shell: true });
        return out.trim();
      } finally {
        try { fs.unlinkSync(scriptPath); } catch(e) {}
      }
    } catch(e) {
      if (e.status !== 1) continue;
      throw e;
    }
  }
  throw new Error('python not found');
}

function extractViaMarkitdown(filePath) {
  const out = execSync(`markitdown "${filePath}"`,
    { encoding: 'utf8', timeout: 60000, shell: true });
  return out.trim();
}

function extractViaPythonPptx(filePath) {
  let pyCmd = null;
  for (const cmd of ['python', 'py', 'python3']) {
    try { execSync(`${cmd} -c "from pptx import Presentation"`, { stdio: 'pipe', shell: true, timeout: 5000 }); pyCmd = cmd; break; } catch(e) {}
  }
  if (!pyCmd) throw new Error('python-pptx not available');

  const script = [
    'import sys',
    'from pptx import Presentation',
    'prs = Presentation(sys.argv[1])',
    'for i, slide in enumerate(prs.slides):',
    '    print(f"=== Slide {i+1} ===")',
    '    for shape in slide.shapes:',
    '        if hasattr(shape, "text_frame"):',
    '            for para in shape.text_frame.paragraphs:',
    '                t = para.text.strip()',
    '                if t: print(t)',
    '    print()',
  ].join('\n');

  const scriptPath = path.join(os.tmpdir(), 'pptx-extract-' + Date.now() + '.py');
  fs.writeFileSync(scriptPath, script, 'utf8');
  try {
    const out = execSync(`${pyCmd} "${scriptPath}" "${filePath}"`,
      { encoding: 'utf8', timeout: 30000, shell: true });
    return out.trim();
  } finally {
    try { fs.unlinkSync(scriptPath); } catch(e) {}
  }
}

/**
 * DRM deprotect via Bridge (company PC) — uses PowerShell COM automation.
 * v31 change: PS script uploads PDF directly to Supabase (no HTTP server).
 * This eliminates the localhost:7655 dependency that was unreachable from home PC.
 */
async function extractViaBridgeCOMDirect(messageId, fileName) {
  const ext = path.extname(fileName).toLowerCase();
  const safeName = fileName.replace(/'/g, "''");

  // PS script: download from Supabase → COM export to PDF → upload back to Supabase
  const lines = [
    `$supaUrl = '${SUPA_URL}'`,
    `$supaKey = '${SUPA_KEY}'`,
    `$msgId = '${messageId}'`,
    `$fileName = '${safeName}'`,
    `$ext = '${ext}'`,
    '',
    '# Download file_chunks from Supabase',
    '$uri = $supaUrl + "/rest/v1/file_chunks" +',
    '  "?message_id=eq=" + [uri]::EscapeDataString($msgId) +',
    '  "&file_name=eq=" + [uri]::EscapeDataString($fileName) +',
    '  "&order=chunk_index.asc&select=chunk_index,data"',
    '$hdr = @{ apikey = $supaKey; Authorization = "Bearer $supaKey" }',
    'try {',
    '  $chunks = Invoke-RestMethod -Uri $uri -Headers $hdr -Method Get',
    '} catch {',
    '  Write-Output ("FAIL:chunk download error: " + $_.Exception.Message); return',
    '}',
    'if (-not $chunks -or $chunks.Count -eq 0) { Write-Output "FAIL:no chunks"; return }',
    '',
    '# Reassemble → temp file',
    '$b64 = ($chunks | Sort-Object chunk_index | ForEach-Object { $_.data }) -join ""',
    '$bytes = [Convert]::FromBase64String($b64)',
    '$ts = Get-Date -f "yyyyMMddHHmmssfff"',
    '$tmpF   = [IO.Path]::Combine($env:TEMP, "bridge-src-" + $ts + $ext)',
    '$tmpPdf = [IO.Path]::Combine($env:TEMP, "bridge-out-" + $ts + ".pdf")',
    '[IO.File]::WriteAllBytes($tmpF, $bytes)',
    '',
    '# [v31 DRM FIX] Snapshot pre-existing FED5 PIDs before COM starts',
    '$preFed5Ids = @(Get-Process -EA 0 | Where-Object {',
    '  $_.MainWindowTitle -ne "" -and $_.MainWindowTitle -match "FED5"',
    '} | Select-Object -ExpandProperty Id)',
    '',
    '# COM export to PDF',
    '$comJob = Start-Job -ScriptBlock {',
    '  param($tmpF, $tmpPdf, $ext)',
    '  try {',
    '    if ($ext -eq ".pptx" -or $ext -eq ".ppt") {',
    '      Stop-Process -Name POWERPNT -Force -EA 0',
    '      $app = New-Object -ComObject PowerPoint.Application; $app.Visible = 1',
    '      Start-Sleep 8',
    '      $pres = $app.Presentations.Open($tmpF, 0, 0, 1)',
    '      $pres.ExportAsFixedFormat($tmpPdf, 2, 1)',
    '      $pres.Close(); $app.Quit()',
    '    } elseif ($ext -eq ".xlsx" -or $ext -eq ".xls") {',
    '      Stop-Process -Name EXCEL -Force -EA 0',
    '      $app = New-Object -ComObject Excel.Application; $app.Visible = 0; $app.DisplayAlerts = 0',
    '      Start-Sleep 6',
    '      $wb = $app.Workbooks.Open($tmpF)',
    '      $wb.ExportAsFixedFormat(0, $tmpPdf)',
    '      $wb.Close($false); $app.Quit()',
    '    } elseif ($ext -eq ".docx" -or $ext -eq ".doc") {',
    '      Stop-Process -Name WINWORD -Force -EA 0',
    '      $app = New-Object -ComObject Word.Application; $app.Visible = 0',
    '      Start-Sleep 6',
    '      $wDoc = $app.Documents.Open($tmpF, 0, 0)',
    '      $wDoc.ExportAsFixedFormat($tmpPdf, 17, 0)',
    '      $wDoc.Close($false); $app.Quit()',
    '    } else { Write-Output "FAIL:unsupported:$ext"; return }',
    '    Write-Output "OK"',
    '  } catch { Write-Output ("FAIL:COM:" + $_.Exception.Message) }',
    '  finally { Remove-Item $tmpF -EA 0 }',
    '} -ArgumentList $tmpF, $tmpPdf, $ext',
    '',
    '# Monitor with pre-snapshot FED5 check (v31 DRM fix)',
    '$epDetected = $false; $comWait = 0; $maxWait = 180',
    'while ($comJob.State -eq "Running" -and $comWait -lt $maxWait) {',
    '  Start-Sleep 2; $comWait += 2',
    '  $newFed5 = Get-Process -EA 0 | Where-Object {',
    '    $_.MainWindowTitle -ne "" -and $_.MainWindowTitle -match "FED5" -and $preFed5Ids -notcontains $_.Id',
    '  }',
    '  if ($newFed5 -and -not $epDetected) {',
    '    $epDetected = $true',
    '    if (($maxWait - $comWait) -lt 90) { $maxWait = $comWait + 90 }',
    '  }',
    '}',
    'if ($comJob.State -ne "Completed") {',
    '  Stop-Job $comJob -EA 0; Remove-Job $comJob -EA 0',
    '  if ($epDetected) { Write-Output "EP_LOGIN_REQUIRED" } else { Write-Output "COM_TIMEOUT" }',
    '  return',
    '}',
    '$comOut = Receive-Job $comJob 2>&1 | Out-String; Remove-Job $comJob -EA 0',
    'if ($comOut.Trim() -ne "OK") { Write-Output ("FAIL:COM:" + $comOut.Trim()); return }',
    '',
    '# PDF → upload directly to Supabase file_chunks (v31: no HTTP server)',
    'if (-not (Test-Path $tmpPdf)) { Write-Output "FAIL:PDF not found after export"; return }',
    '$pdfBytes = [IO.File]::ReadAllBytes($tmpPdf)',
    'Remove-Item $tmpPdf -EA 0',
    '$b64Pdf = [Convert]::ToBase64String($pdfBytes)',
    '',
    '# Split into 900KB chunks and upload',
    '$chunkSize = 900 * 1024',
    '$totalLen  = $b64Pdf.Length',
    '$totalChunks = [Math]::Ceiling($totalLen / $chunkSize)',
    '$pdfName = $fileName + ".drm.pdf"',
    '',
    '# Delete any stale chunks first',
    '$delUri = $supaUrl + "/rest/v1/file_chunks?message_id=eq=" + [uri]::EscapeDataString($msgId) + "&file_name=eq=" + [uri]::EscapeDataString($pdfName)',
    'try { Invoke-RestMethod -Uri $delUri -Headers $hdr -Method Delete } catch {}',
    '',
    'for ($i = 0; $i -lt $totalChunks; $i++) {',
    '  $start  = $i * $chunkSize',
    '  $length = [Math]::Min($chunkSize, $totalLen - $start)',
    '  $chunkData = $b64Pdf.Substring($start, $length)',
    '  $body = @{',
    '    message_id  = $msgId',
    '    file_name   = $pdfName',
    '    chunk_index = $i',
    '    total_chunks = $totalChunks',
    '    data        = $chunkData',
    '  } | ConvertTo-Json -Depth 2',
    '  $insUri = $supaUrl + "/rest/v1/file_chunks"',
    '  $insHdr = $hdr + @{ "Content-Type" = "application/json"; "Prefer" = "return=minimal" }',
    '  try {',
    '    Invoke-RestMethod -Uri $insUri -Headers $insHdr -Method Post -Body $body | Out-Null',
    '  } catch {',
    '    Write-Output ("FAIL:upload chunk $i: " + $_.Exception.Message); return',
    '  }',
    '}',
    'Write-Output ("OK:UPLOADED_PDF:" + $pdfName + ":chunks=" + $totalChunks)',
  ];

  const psScript = lines.join('\n');
  const cmdId = 'relay-drm-' + Date.now() + '-' + Math.random().toString(36).slice(2, 5);

  sysLog('info', 'drm_start', { messageId: messageId.slice(0, 8), fileName, cmdId });

  await dbInsert('commands', {
    id: cmdId, action: 'run_ps', target: '', content: psScript, status: 'pending',
  });
  log('[Bridge] DRM 직접 업로드 요청:', fileName, '→ cmd:', cmdId);

  const deadline = Date.now() + CONFIG.bridgeExtractTimeout;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 2000));
    const rows = await dbSelect('commands', `id=eq.${encodeURIComponent(cmdId)}&select=status,result`);
    if (rows && rows.length) {
      const row = rows[0];
      if (row.status === 'completed' || row.status === 'error') {
        try { await dbDelete('commands', `id=eq.${encodeURIComponent(cmdId)}`); } catch(e) {}
        const result = (row.result || '').trim();

        if (result === 'EP_LOGIN_REQUIRED') {
          sysLog('warn', 'drm_ep_login', { messageId: messageId.slice(0, 8), fileName });
          throw new Error('EP 로그인이 필요합니다. EP(FED5)에 로그인 후 재시도하세요.');
        }
        if (result === 'COM_TIMEOUT') {
          sysLog('error', 'drm_timeout', { messageId: messageId.slice(0, 8), fileName });
          throw new Error('COM 작업 타임아웃 (180초). Office가 응답하지 않습니다.');
        }
        if (result.startsWith('OK:UPLOADED_PDF:')) {
          // e.g. OK:UPLOADED_PDF:report.pptx.drm.pdf:chunks=3
          const parts = result.split(':');
          const uploadedName = parts[2];
          log('[Bridge] PDF 업로드 완료:', uploadedName);
          sysLog('info', 'drm_uploaded', { messageId: messageId.slice(0, 8), uploadedName });
          return uploadedName;  // relay will download this PDF name
        }
        const errMsg = result.startsWith('FAIL:') ? result.slice(5) : result;
        sysLog('error', 'drm_fail', { messageId: messageId.slice(0, 8), fileName, err: errMsg.slice(0, 200) });
        throw new Error('Bridge DRM 실패: ' + errMsg.slice(0, 200));
      }
    }
  }
  try { await dbDelete('commands', `id=eq.${encodeURIComponent(cmdId)}`); } catch(e) {}
  sysLog('error', 'drm_timeout_relay', { messageId: messageId.slice(0, 8), fileName });
  throw new Error(`Bridge 응답 없음 (${CONFIG.bridgeExtractTimeout/1000}초)`);
}

// ── Main extraction ────────────────────────────────────────────────────────────
async function extractFileContent(messageId, fileName, filePath, fileBuffer) {
  const ext = path.extname(fileName).toLowerCase();
  const isPptx   = ['.pptx', '.ppt'].includes(ext);
  const isDocx   = ['.docx', '.doc'].includes(ext);
  const isPdf    = ext === '.pdf' || (fileBuffer && isPdfBuffer(fileBuffer));

  if (isPdf) {
    log('[Extract] PDF 파일 감지:', fileName);
    try {
      const text = extractViaPdf(filePath);
      if (text && text.length > 10) return text;
    } catch(e) { warn('[Extract] PDF 추출 실패:', e.message.slice(0, 100)); }
    try {
      const text = extractViaMarkitdown(filePath);
      if (text && text.length > 10) return text;
    } catch(e) {}
    return `[PDF 텍스트 추출 실패: ${fileName}]\n💡 pip install pdfminer.six`;
  }

  // Method 1: markitdown
  let e1msg = '';
  try {
    log('[Extract] Method 1: markitdown -', fileName);
    const text = extractViaMarkitdown(filePath);
    if (text && text.length > 10) return text;
  } catch(e) { e1msg = e.message.slice(0, 100); }

  // Method 2: python-pptx (PPTX only)
  if (isPptx) {
    let e2msg = '';
    try {
      log('[Extract] Method 2: python-pptx -', fileName);
      const text = extractViaPythonPptx(filePath);
      if (text && text.length > 10) return text;
    } catch(e) { e2msg = e.message.slice(0, 100); }

    // Method 3: Bridge DRM direct upload (v31)
    const bridgeOnline = await checkBridgeOnline();
    if (bridgeOnline) {
      try {
        log('[Extract] Method 3: Bridge DRM 직접 업로드 -', fileName);
        const uploadedPdfName = await extractViaBridgeCOMDirect(messageId, fileName);
        // Download the PDF that bridge uploaded
        const pdfBuffer = await chunksDownload(messageId, uploadedPdfName);
        const pdfPath = path.join(os.tmpdir(), 'relay-drm-' + Date.now() + '.pdf');
        fs.writeFileSync(pdfPath, pdfBuffer);
        try {
          const text = extractViaPdf(pdfPath);
          if (text && text.length > 10) {
            await dbDelete('file_chunks', `message_id=eq.${encodeURIComponent(messageId)}&file_name=eq.${encodeURIComponent(uploadedPdfName)}`);
            return text;
          }
        } finally {
          try { fs.unlinkSync(pdfPath); } catch(e) {}
        }
      } catch(e) {
        const e3msg = e.message;
        err('[Extract] Bridge DRM 실패:', e3msg);
        return `[파일 내용 추출 실패: ${fileName}]\n• markitdown: ${e1msg}\n• python-pptx: ${e2msg}\n• Bridge DRM: ${e3msg}`;
      }
    } else {
      return `[PPTX 처리 불가: ${fileName}]\nDRM 파일은 회사 PC Bridge가 필요하지만 오프라인입니다.\n\n💡 해결:\n1. 홈 PC: pip install markitdown[all]\n2. 회사 PC: start-bridge.bat 실행 후 재시도`;
    }
  }

  if (isDocx) {
    const bridgeOnline = await checkBridgeOnline();
    if (bridgeOnline) {
      try {
        log('[Extract] DOCX Bridge DRM -', fileName);
        const uploadedPdfName = await extractViaBridgeCOMDirect(messageId, fileName);
        const pdfBuffer = await chunksDownload(messageId, uploadedPdfName);
        const pdfPath = path.join(os.tmpdir(), 'relay-drm-' + Date.now() + '.pdf');
        fs.writeFileSync(pdfPath, pdfBuffer);
        try {
          const text = extractViaPdf(pdfPath);
          if (text && text.length > 10) {
            await dbDelete('file_chunks', `message_id=eq.${encodeURIComponent(messageId)}&file_name=eq.${encodeURIComponent(uploadedPdfName)}`);
            return text;
          }
        } finally {
          try { fs.unlinkSync(pdfPath); } catch(e) {}
        }
      } catch(e) {
        err('[Extract] DOCX Bridge DRM 실패:', e.message);
      }
    }
  }

  return `[파일 내용 추출 불가: ${fileName}]\nmarkitdown: ${e1msg || '없음'}\n💡 홈 PC에서 pip install markitdown[all] 실행 후 재시도`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Process message
// ═══════════════════════════════════════════════════════════════════════════════
async function processMessage(msg) {
  const id = msg.id, chat_id = msg.chat_id;
  let content = msg.content || '';
  let attachedFiles = [];

  log('[Worker] 처리 중:', id.slice(0,8), '"' + content.slice(0,50) + '"');
  sysLog('info', 'message_received', { id: id.slice(0, 8), preview: content.slice(0, 80) });

  try { await dbUpdate('messages', 'id=eq.' + encodeURIComponent(id), { status: 'processing' }); } catch(e) {}
  await sendHeartbeat();

  try {
    // Download attached files
    if (msg.files && Array.isArray(msg.files) && msg.files.length > 0) {
      log('[Worker] 파일 개수:', msg.files.length);
      for (const file of msg.files) {
        try {
          log('[Worker] 다운로드:', file.name);
          const buffer = await chunksDownload(id, file.name);
          const tmpPath = path.join(os.tmpdir(), 'relay-chunk-' + Date.now() + '-' + file.name);
          fs.writeFileSync(tmpPath, buffer);
          attachedFiles.push({ name: file.name, path: tmpPath, buffer });
          log('[Worker] 저장:', tmpPath, buffer.length + 'B',
            isPdfBuffer(buffer) ? '[실제 PDF!]' : '');
        } catch (e) {
          err('[Worker] 파일 다운로드 실패:', file.name, e.message);
          sysLog('error', 'file_download_fail', { id: id.slice(0,8), file: file.name, err: e.message.slice(0, 200) });
        }
      }
    }

    // Extract text
    let fileContentText = '';
    for (const file of attachedFiles) {
      log('[Worker] 파일 추출:', file.name);
      const extractedText = await extractFileContent(id, file.name, file.path, file.buffer);
      fileContentText += `\n\n=== 첨부파일: ${file.name} ===\n${extractedText}\n=== 끝 ===`;
    }

    // Build prompt and run Claude
    const finalContent = content + fileContentText;
    const prompt = await buildPrompt(chat_id, finalContent);
    log('[Worker] 프롬프트 길이:', prompt.length);

    const response = await runClaude(prompt);
    log('[Worker] 응답 수신:', response.slice(0, 60));

    // Save response
    const rid = (typeof crypto.randomUUID === 'function')
      ? crypto.randomUUID()
      : 'resp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);

    await dbInsert('messages', {
      id: rid, chat_id, role: 'assistant',
      content: response, status: 'completed',
      files: null, created_at: new Date().toISOString(),
    });

    try { await dbUpdate('messages', 'id=eq.' + encodeURIComponent(id), { status: 'completed' }); } catch(e) {}
    sysLog('info', 'message_completed', { id: id.slice(0, 8), responseId: rid.slice(0, 8), files: attachedFiles.length });
    log('[Worker] 완료 →', rid.slice(0, 8));

    // Cleanup
    for (const file of attachedFiles) { try { fs.unlinkSync(file.path); } catch(e) {} }
    if (msg.files && msg.files.length > 0) {
      try { await dbDelete('file_chunks', 'message_id=eq.' + encodeURIComponent(id)); } catch(e) {}
    }

  } catch (err2) {
    err('[Worker] 오류:', err2.message);
    sysLog('error', 'message_error', { id: id.slice(0,8), err: err2.message.slice(0, 300), stack: (err2.stack||'').slice(0, 200) });

    const errMsg = '⚠️ 오류: ' + err2.message;
    try {
      await dbInsert('messages', {
        id: 'err-' + Date.now(), chat_id, role: 'assistant',
        content: errMsg, status: 'error',
        files: null, created_at: new Date().toISOString(),
      });
      await dbUpdate('messages', 'id=eq.' + encodeURIComponent(id), { status: 'completed' });
    } catch(e2) { err('[Worker] 오류 기록 실패:', e2.message); }

    for (const file of attachedFiles) { try { fs.unlinkSync(file.path); } catch(e) {} }
  }
  await sendHeartbeat();
}

// ── Poll ───────────────────────────────────────────────────────────────────────
async function poll() {
  if (isProcessing || shuttingDown) return;
  try {
    const rows = await dbSelect('messages',
      'role=eq.user&status=eq.pending&order=created_at.asc&limit=1&select=id,chat_id,content,files');
    if (!rows || rows.length === 0) return;
    isProcessing = true;
    await processMessage(rows[0]);
    isProcessing = false;
  } catch (e) {
    err('[Poll] 오류:', e.message);
    isProcessing = false;
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  acquireLock();

  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  Remote Bridge Relay Worker ' + VERSION + '                 ║');
  console.log('║  자가복구: Supabase sys_log + 재시작 명령 지원   ║');
  console.log('║  DRM: COM → PDF → Supabase 직접 업로드           ║');
  console.log('║  Keep-alive: 6시간마다 Supabase 핑               ║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log('║  Hostname: ' + HOSTNAME.padEnd(38) + '║');
  console.log('║  PID:      ' + String(process.pid).padEnd(38) + '║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  // Dheck Claude CLI
  try {
    const ver = execSync(CLAUDE_EXE + ' --version', { stdio: 'pipe', shell: true }).toString().trim();
    log('[OK] Claude CLI:', ver);
  } catch(e) {
    warn('[WARN] claude --version 실패:', e.message.slice(0, 80));
  }

  // Supabase 연결 — 최대 5회 재시도 (프리 티어 일시정지 시 즉시 종료하지 않음)
  let supaOk = false;
  for (let attempt = 1; attempt <= CONFIG.startupRetries; attempt++) {
    try {
      await dbSelect('messages', 'limit=1&select=id');
      log('[OK] Supabase 연결 성공');
      supaOk = true;
      break;
    } catch (e) {
      const isLast = attempt === CONFIG.startupRetries;
      if (isLast) {
        err('[FATAL] Supabase 연결 최종 실패 (' + attempt + '/' + CONFIG.startupRetries + '):', e.message);
        err('[HINT] Supabase 프리 티어가 일시정지됐을 수 있습니다.');
        err('[HINT] https://supabase.com/dashboard 에서 프로젝트 상태를 확인하세요.');
        releaseLock(); process.exit(1);
      } else {
        warn('[Retry] Supabase 연결 실패 (' + attempt + '/' + CONFIG.startupRetries + ') — ' + CONFIG.startupRetryDelay/1000 + '초 후 재시도:', e.message.slice(0, 80));
        await new Promise(r => setTimeout(r, CONFIG.startupRetryDelay));
      }
    }
  }

  // Check tools
  try { execSync('markitdown --version', { stdio: 'pipe', shell: true, timeout: 5000 }); log('[OK] markitdown: 설치됨'); }
  catch(e) { warn('[WARN] markitdown: 미설치 → pip install markitdown[all]'); }

  try { execSync('python -c "import pdfminer"', { stdio: 'pipe', shell: true, timeout: 5000 }); log('[OK] pdfminer.six: 설치됨'); }
  catch(e) {
    try { execSync('python3 -c "import pdfminer"', { stdio: 'pipe', shell: true, timeout: 5000 }); log('[OK] pdfminer.six: 설치됨 (python3)'); }
    catch(e2) { warn('[WARN] pdfminer.six: 미설치 → pip install pdfminer.six'); }
  }

  // Check Bridge
  const bridgeOnline = await checkBridgeOnline();
  log(bridgeOnline ? '[OK] 🏢 Bridge (회사 PC): 온라인' : '[WARN] 🏢 Bridge (회사 PC): 오프라인');

  // Recover stuck messages
  await recoverStuckMessages();

  // Log startup to Supabase
  sysLog('info', 'startup', { version: VERSION, hostname: HOSTNAME, pid: process.pid });

  await sendHeartbeat();
  log('[OK] 폴링 시작 (' + CONFIG.pollInterval + 'ms)...\n');

  // Periodic intervals
  setInterval(sendHeartbeat,    CONFIG.heartbeatInterval);
  setInterval(handleCommands,   CONFIG.pollInterval);
  setInterval(poll,             CONFIG.pollInterval);
  setInterval(keepAlive,        CONFIG.keepAliveInterval);

  // Daily sys_log cleanup
  setInterval(cleanupSysLog, 24 * 60 * 60 * 1000);

  // Immediate first run
  poll();
  handleCommands();
  // First keep-alive after 1 minute to verify Supabase stays alive
  setTimeout(keepAlive, 60 * 1000);
}

main().catch(e => { err('[FATAL]', e.message); releaseLock(); process.exit(1); });
