/**
 * Remote Bridge Relay Worker v30
 * ======================================
 * Changes from v18:
 * - Single-instance lock (PID file at /tmp/relay-worker.lock)
 * - EAI_AGAIN/ENOTFOUND/ECONNRESET retry (3x exponential backoff)
 * - PDF detection: if downloaded .pptx/.docx is actually a PDF
 *   (after DRM deprotection), extract text via pdfminer/pdftotext/markitdown
 * - Better startup logging with timestamps
 * - extractViaBridgeCOM now uses PDF export + relay-side PDF extraction
 * - Version display: v30
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
const VERSION   = 'v30';
const LOCK_FILE = path.join(os.tmpdir(), 'relay-worker.lock');

const CONFIG = {
  pollInterval:         3000,
  claudeTimeout:        120000,
  heartbeatInterval:    15000,
  maxPromptLen:         8000,
  bridgeExtractTimeout: 90000,  // 90s for Bridge COM → PDF extraction
};

let isProcessing = false;
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
        // Check if old process is still alive
        try {
          process.kill(oldPid, 0); // 0 = just check existence
          // If we get here, the old process is alive — kill it
          log('[Lock] 기존 릴레이(PID=' + oldPid + ') 종료 중...');
          try { process.kill(oldPid, 'SIGTERM'); } catch(e) {}
          // Wait a moment for it to die
          const killDeadline = Date.now() + 3000;
          while (Date.now() < killDeadline) {
            try { process.kill(oldPid, 0); } catch(e) { break; }
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
          }
        } catch(e) {
          // Process doesn't exist, stale lock
          log('[Lock] 스테일 락 파일 발견 (PID=' + oldPid + '), 무시');
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
    if (current === String(process.pid)) {
      fs.unlinkSync(LOCK_FILE);
    }
  } catch(e) {}
}

process.on('exit', releaseLock);
process.on('SIGINT', () => { releaseLock(); process.exit(0); });
process.on('SIGTERM', () => { releaseLock(); process.exit(0); });
process.on('uncaughtException', e => { err('[Fatal]', e.message); releaseLock(); process.exit(1); });

// ── HTTPS helper (with EAI_AGAIN retry) ──────────────────────────────────────
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
  try {
    await dbUpsert('commands', {
      id: 'bridge-heartbeat', action: 'heartbeat', target: 'bridge',
      content: 'relay-written', status: 'completed', result: tsVal,
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

// ── Recover stuck messages ────────────────────────────────────────────────────
async function recoverStuckMessages() {
  try {
    const stuck = await dbSelect('messages', 'role=eq.user&status=eq.processing&select=id,content');
    if (!stuck || stuck.length === 0) return;
    log('[Recovery] processing 상태 메시지', stuck.length, '개 → pending 복구');
    for (const msg of stuck) {
      await dbUpdate('messages', 'id=eq.' + encodeURIComponent(msg.id), { status: 'pending' });
    }
  } catch (e) {
    err('[Recovery] 실패:', e.message);
  }
}

// ── Ping Handler ──────────────────────────────────────────────────────────────
async function handlePings() {
  try {
    const rows = await dbSelect('commands', 'action=eq.ping&status=eq.pending&order=created_at.asc&limit=10');
    if (!rows || rows.length === 0) return;
    const now = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
    for (const row of rows) {
      await dbUpdate('commands', 'id=eq.' + row.id, {
        status: 'completed',
        result: 'pong from relay ' + VERSION + '/' + HOSTNAME + ' at ' + now,
      });
    }
  } catch (e) { /* silent */ }
}

// ── Run Claude ────────────────────────────────────────────────────────────────
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

// ── Build prompt ──────────────────────────────────────────────────────────────
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
// File content extraction methods
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Detect if a file buffer is actually a PDF (magic bytes %PDF)
 */
function isPdfBuffer(buf) {
  return buf.length >= 4 &&
    buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46;
}

/**
 * Method 0: Extract PDF text via Python (pdfminer.six → pypdf → pdftotext)
 */
function extractViaPdf(filePath) {
  // Try pdfminer.six first
  const pyCommands = ['python', 'py', 'python3'];
  for (const pyCmd of pyCommands) {
    try {
      execSync(`${pyCmd} -c "import pdfminer"`, { stdio: 'pipe', shell: true, timeout: 5000 });
      const script = `
import sys, io
from pdfminer.high_level import extract_text
text = extract_text(sys.argv[1])
print(text[:80000] if len(text) > 80000 else text)
`;
      const scriptPath = path.join(os.tmpdir(), 'pdf-extract-' + Date.now() + '.py');
      fs.writeFileSync(scriptPath, script, 'utf8');
      try {
        const out = execSync(`${pyCmd} "${scriptPath}" "${filePath}"`, {
          encoding: 'utf8', timeout: 30000, shell: true
        });
        return out.trim();
      } finally {
        try { fs.unlinkSync(scriptPath); } catch(e) {}
      }
    } catch(e) {}
  }

  // Try pypdf
  for (const pyCmd of pyCommands) {
    try {
      execSync(`${pyCmd} -c "import pypdf"`, { stdio: 'pipe', shell: true, timeout: 5000 });
      const script = `
import sys
from pypdf import PdfReader
r = PdfReader(sys.argv[1])
text = ''
for page in r.pages:
    text += page.extract_text() or ''
    text += '\\n'
print(text[:80000] if len(text) > 80000 else text)
`;
      const scriptPath = path.join(os.tmpdir(), 'pypdf-extract-' + Date.now() + '.py');
      fs.writeFileSync(scriptPath, script, 'utf8');
      try {
        const out = execSync(`${pyCmd} "${scriptPath}" "${filePath}"`, {
          encoding: 'utf8', timeout: 30000, shell: true
        });
        return out.trim();
      } finally {
        try { fs.unlinkSync(scriptPath); } catch(e) {}
      }
    } catch(e) {}
  }

  // Try pdftotext CLI (poppler-utils)
  try {
    const out = execSync(`pdftotext "${filePath}" -`, {
      encoding: 'utf8', timeout: 30000, shell: true
    });
    return out.trim();
  } catch(e) {}

  throw new Error('PDF 추출 도구 없음 (pdfminer.six, pypdf, pdftotext 모두 실패)');
}

/**
 * Method 1: Extract via markitdown CLI
 */
function extractViaMarkitdown(filePath) {
  const out = execSync(`markitdown "${filePath}"`, {
    encoding: 'utf8', timeout: 30000, shell: true
  });
  return out.trim();
}

/**
 * Method 2: Extract PPTX text via Python + python-pptx
 */
function extractViaPythonPptx(filePath) {
  const pyCommands = ['python', 'py', 'python3'];
  let pyCmd = null;
  for (const cmd of pyCommands) {
    try {
      execSync(cmd + ' -c "from pptx import Presentation"', { stdio: 'pipe', shell: true, timeout: 5000 });
      pyCmd = cmd;
      break;
    } catch(e) {}
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
    const out = execSync(`${pyCmd} "${scriptPath}" "${filePath}"`, {
      encoding: 'utf8', timeout: 30000, shell: true
    });
    return out.trim();
  } finally {
    try { fs.unlinkSync(scriptPath); } catch(e) {}
  }
}

/**
 * Method 3: Extract via Bridge (company PC) using PowerShell + Office COM
 * Bridge exports DRM-protected file to PDF using ExportAsFixedFormat.
 * The PDF is served on localhost:7655 → browser JS fetches → uploads to Supabase.
 * Relay then downloads the PDF chunks and extracts text using extractViaPdf().
 *
 * NOTE: This method is called ONLY for the initial text extraction fallback.
 * In normal DRM flow, browser handles ExportAsFixedFormat → PDF → re-upload.
 * This method handles the case where browser-side DRM flow was skipped.
 */
async function extractViaBridgeCOMPdf(messageId, fileName) {
  const ext = path.extname(fileName).toLowerCase();
  const safeName = fileName.replace(/'/g, "''");

  const lines = [
    `$supaUrl = '${SUPA_URL}'`,
    `$supaKey = '${SUPA_KEY}'`,
    `$msgId = '${messageId}'`,
    `$fileName = '${safeName}'`,
    `$ext = '${ext}'`,
    '',
    '# Run PDF export in a background job with 120-second timeout',
    '$job = Start-Job -ScriptBlock {',
    '  param($supaUrl, $supaKey, $msgId, $fileName, $ext)',
    '',
    '  # Download file_chunks from Supabase (GET only)',
    '  $uri = $supaUrl + "/rest/v1/file_chunks" +',
    '    "?message_id=eq=" + [uri]::EscapeDataString($msgId) +',
    '    "&file_name=eq=" + [uri]::EscapeDataString($fileName) +',
    '    "&order=chunk_index.asc&select=chunk_index,data"',
    '  $hdr = @{ apikey = $supaKey; Authorization = "Bearer $supaKey" }',
    '  try {',
    '    $chunks = Invoke-RestMethod -Uri $uri -Headers $hdr -Method Get',
    '  } catch {',
    '    Write-Output ("FAIL:chunk download error: " + $_.Exception.Message)',
    '    return',
    '  }',
    '  if (-not $chunks -or $chunks.Count -eq 0) {',
    '    Write-Output ("FAIL:no chunks found")',
    '    return',
    '  }',
    '',
    '  # Reassemble base64 → bytes → temp file',
    '  $b64 = ($chunks | Sort-Object chunk_index | ForEach-Object { $_.data }) -join ""',
    '  $bytes = [Convert]::FromBase64String($b64)',
    '  $ts = Get-Date -f "yyyyMMddHHmmssfff"',
    '  $tmpF = [IO.Path]::Combine($env:TEMP, "bridge-src-" + $ts + $ext)',
    '  $tmpPdf = [IO.Path]::Combine($env:TEMP, "bridge-out-" + $ts + ".pdf")',
    '  [IO.File]::WriteAllBytes($tmpF, $bytes)',
    '',
    '  try {',
    '    if ($ext -eq ".pptx" -or $ext -eq ".ppt") {',
    '      Stop-Process -Name POWERPNT -Force -EA 0; Start-Sleep 1',
    '      $app = New-Object -ComObject PowerPoint.Application; $app.Visible = 1',
    '      $pres = $app.Presentations.Open($tmpF, 0, 0, 1); Start-Sleep 5',
    '      $pres.ExportAsFixedFormat($tmpPdf, 2, 1)',
    '      $pres.Close(); $app.Quit()',
    '    } elseif ($ext -eq ".xlsx" -or $ext -eq ".xls") {',
    '      Stop-Process -Name EXCEL -Force -EA 0; Start-Sleep 1',
    '      $app = New-Object -ComObject Excel.Application; $app.Visible = 0; $app.DisplayAlerts = 0',
    '      $wb = $app.Workbooks.Open($tmpF); Start-Sleep 3',
    '      $wb.ExportAsFixedFormat(0, $tmpPdf)',
    '      $wb.Close($false); $app.Quit()',
    '    } elseif ($ext -eq ".docx" -or $ext -eq ".doc") {',
    '      Stop-Process -Name WINWORD -Force -EA 0; Start-Sleep 1',
    '      $app = New-Object -ComObject Word.Application; $app.Visible = 0',
    '      $wDoc = $app.Documents.Open($tmpF, 0, 0); Start-Sleep 3',
    '      $wDoc.ExportAsFixedFormat($tmpPdf, 17, 0)',
    '      $wDoc.Close($false); $app.Quit()',
    '    } else {',
    '      Write-Output ("FAIL:unsupported extension: $ext")',
    '      Remove-Item $tmpF -EA 0; return',
    '    }',
    '    # Serve PDF on localhost:7655',
    '    $pp = 7655',
    '    $lis = New-Object System.Net.HttpListener',
    "    $lis.Prefixes.Add('http://localhost:' + $pp + '/')",
    '    $lis.Start()',
    '    $ctx = $lis.GetContext()',
    "    $ctx.Response.Headers.Add('Access-Control-Allow-Origin','*')",
    '    $pdfBytes = [IO.File]::ReadAllBytes($tmpPdf)',
    '    $b64Pdf = [Convert]::ToBase64String($pdfBytes)',
    '    $respBytes = [Text.Encoding]::UTF8.GetBytes($b64Pdf)',
    '    $ctx.Response.ContentType = "text/plain; charset=utf-8"',
    '    $ctx.Response.ContentLength64 = $respBytes.LongLength',
    '    $ctx.Response.OutputStream.Write($respBytes, 0, $respBytes.Length)',
    '    $ctx.Response.Close(); $lis.Stop()',
    '    Remove-Item $tmpPdf -EA 0',
    '    Write-Output ("OK:SERVING:" + $pp)',
    '  } catch {',
    '    Write-Output ("FAIL:COM error: " + $_.Exception.Message)',
    '  } finally {',
    '    Remove-Item $tmpF -EA 0',
    '  }',
    '} -ArgumentList $supaUrl, $supaKey, $msgId, $fileName, $ext',
    '',
    '# Wait up to 120 seconds, then kill if still running',
    '$done = $job | Wait-Job -Timeout 120',
    'if (-not $done) {',
    '  Stop-Job $job; Remove-Job $job',
    '  Write-Output "FAIL:Bridge COM timed out (120s) - DRM dialog or slow open"',
    '} else {',
    '  $out = Receive-Job $job 2>&1 | Out-String',
    '  Remove-Job $job',
    '  Write-Output $out.Trim()',
    '}',
  ];
  const psScript = lines.join('\n');

  const cmdId = 'relay-pdf-' + Date.now() + '-' + Math.random().toString(36).slice(2, 5);
  await dbInsert('commands', {
    id: cmdId,
    action: 'run_ps',
    target: '',
    content: psScript,
    status: 'pending',
  });
  log('[Bridge] PDF 추출 요청:', fileName, '→ cmd:', cmdId);

  // Poll for result
  const deadline = Date.now() + CONFIG.bridgeExtractTimeout;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 2000));
    const rows = await dbSelect('commands', `id=eq.${encodeURIComponent(cmdId)}&select=status,result`);
    if (rows && rows.length) {
      const row = rows[0];
      if (row.status === 'completed' || row.status === 'error') {
        try { await dbDelete(`commands`, `id=eq.${encodeURIComponent(cmdId)}`); } catch(e) {}
        const result = (row.result || '').trim();
        if (result.startsWith('OK:SERVING:')) {
          // Bridge is serving the PDF on localhost. But relay is on home PC so can't access localhost!
          // This method is only useful if Bridge COMresult is the text itself.
          // Fall through to FAIL path.
          log('[Bridge] PDF 서버 모드 (localhost:7655) - relay는 접근 불가');
          throw new Error('Bridge는 PDF를 localhost에서 제공합니다. 브라우저 DRM 흐름을 사용하세요.');
        }
        if (result.startsWith('OK:')) {
          return result.slice(3);
        }
        const errMsg = result.startsWith('FAIL:') ? result.slice(5) : result;
        throw new Error('Bridge COM 실패: ' + errMsg.slice(0, 200));
      }
    }
  }
  try { await dbDelete(`commands`, `id=eq.${encodeURIComponent(cmdId)}`); } catch(e) {}
  throw new Error(`Bridge 추출 시간 초과 (${CONFIG.bridgeExtractTimeout/1000}초)`);
}

/**
 * Main file content extraction function
 * Returns extracted text, or an error message string (never throws)
 *
 * KEY CHANGE in v30: If file appears to be a PDF (magic bytes check or .pdf ext),
 * use PDF extraction first. This handles the DRM flow where browser uploads
 * the DRM-free PDF with the original .pptx file name.
 */
async function extractFileContent(messageId, fileName, filePath, fileBuffer) {
  const ext = path.extname(fileName).toLowerCase();
  const isOffice = ['.pptx', '.ppt', '.docx', '.doc', '.xlsx', '.xls'].includes(ext);
  const isPptx   = ['.pptx', '.ppt'].includes(ext);
  const isDocx   = ['.docx', '.doc'].includes(ext);
  const isPdf    = ext === '.pdf' || (fileBuffer && isPdfBuffer(fileBuffer));

  // ── If file is actually a PDF (DRM-free export), extract as PDF ──────────────
  if (isPdf) {
    log('[Extract] PDF 파일 감지:', fileName, isPdfBuffer(fileBuffer) ? '(magic bytes)' : '(.pdf ext)');
    try {
      const text = extractViaPdf(filePath);
      if (text && text.length > 10) {
        log('[Extract] PDF 추출 성공:', fileName, '→', text.length, '자');
        return text;
      }
    } catch(e) {
      warn('[Extract] PDF 추출 실패:', e.message.slice(0, 100));
    }
    // Try markitdown on the PDF
    try {
      const text = extractViaMarkitdown(filePath);
      if (text && text.length > 10) {
        log('[Extract] markitdown(PDF) 성공:', fileName);
        return text;
      }
    } catch(e) {}
    return `[PDF 텍스트 추출 실패: ${fileName}]\n💡 pip install pdfminer.six 또는 pip install pypdf 설치 필요`;
  }

  // ── Method 1: markitdown ──────────────────────────────────────────────────────
  let e1msg = '';
  try {
    log('[Extract] Method 1: markitdown -', fileName);
    const text = extractViaMarkitdown(filePath);
    if (text && text.length > 10) {
      log('[Extract] markitdown 성공:', fileName);
      return text;
    }
  } catch(e) {
    e1msg = e.message.slice(0, 100);
    warn('[Extract] markitdown 실패:', e1msg);
  }

  // ── Method 2: python-pptx (PPTX only) ────────────────────────────────────────
  if (isPptx) {
    let e2msg = '';
    try {
      log('[Extract] Method 2: python-pptx -', fileName);
      const text = extractViaPythonPptx(filePath);
      if (text && text.length > 10) {
        log('[Extract] python-pptx 성공:', fileName);
        return text;
      }
    } catch(e) {
      e2msg = e.message.slice(0, 100);
      warn('[Extract] python-pptx 실패:', e2msg);
    }

    // ── Method 3: Bridge COM (회사 PC) ─────────────────────────────────────────
    const bridgeOnline = await checkBridgeOnline();
    if (bridgeOnline) {
      try {
        log('[Extract] Method 3: Bridge COM PDF -', fileName);
        const text = await extractViaBridgeCOMPdf(messageId, fileName);
        if (text && text.length > 0) return text;
      } catch(e) {
        const e3msg = e.message;
        err('[Extract] Bridge COM 실패:', e3msg);
        return `[파일 내용 추출 실패: ${fileName}]\n세 가지 방법 모두 실패:\n• markitdown: ${e1msg}\n• python-pptx: ${e2msg}\n• Bridge COM: ${e3msg}\n\n💡 해결: pip install markitdown[all] 또는 pip install python-pptx`;
      }
    } else {
      return `[PPTX 처리 실패: ${fileName}]\nDRM 보호 파일의 경우 회사 PC Bridge를 통한 추출이 필요하지만 Bridge가 오프라인입니다.\n\n💡 해결:\n1. 홈 PC: pip install markitdown[all]\n2. 회사 PC: start-bridge.bat 실행 후 재시도`;
    }
  }

  // ── DOCX: try Bridge COM ──────────────────────────────────────────────────────
  if (isDocx) {
    const bridgeOnline = await checkBridgeOnline();
    if (bridgeOnline) {
      try {
        log('[Extract] DOCX Bridge COM PDF -', fileName);
        const text = await extractViaBridgeCOMPdf(messageId, fileName);
        if (text && text.length > 0) return text;
      } catch(e) {
        err('[Extract] DOCX Bridge COM 실패:', e.message);
      }
    }
  }

  return `[파일 내용 추출 불가: ${fileName}]\nmarkitdown: ${e1msg || '명령 없음'}\n💡 홈 PC에서 pip install markitdown[all] 실행 후 재시도하세요.`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Process message
// ═══════════════════════════════════════════════════════════════════════════════
async function processMessage(msg) {
  const id = msg.id, chat_id = msg.chat_id;
  let content = msg.content || '';
  let attachedFiles = [];

  log('[Worker] 처리 중:', id.slice(0,8), '"' + content.slice(0,50) + '"');
  try { await dbUpdate('messages', 'id=eq.' + encodeURIComponent(id), { status: 'processing' }); } catch(e) {}
  await sendHeartbeat();

  try {
    // ── Download files from file_chunks table ─────────────────────────────────
    if (msg.files && Array.isArray(msg.files) && msg.files.length > 0) {
      log('[Worker] 파일 개수:', msg.files.length);
      for (const file of msg.files) {
        try {
          log('[Worker] file_chunks에서 다운로드:', file.name, '(' + (file.chunks || '?') + '청크)');
          const buffer = await chunksDownload(id, file.name);
          const tmpPath = path.join(os.tmpdir(), 'relay-chunk-' + Date.now() + '-' + file.name);
          fs.writeFileSync(tmpPath, buffer);
          attachedFiles.push({ name: file.name, path: tmpPath, buffer });
          log('[Worker] 저장 완료:', tmpPath, 'size=' + buffer.length,
            isPdfBuffer(buffer) ? '[실제 PDF!]' : '');
        } catch (e) {
          err('[Worker] 파일 다운로드 실패:', file.name, e.message);
        }
      }
    }

    // ── Extract text from each file ───────────────────────────────────────────
    let fileContentText = '';
    for (const file of attachedFiles) {
      log('[Worker] 파일 내용 추출 시작:', file.name);
      const extractedText = await extractFileContent(id, file.name, file.path, file.buffer);
      fileContentText += `\n\n=== 첨부파일: ${file.name} ===\n${extractedText}\n=== 끝 ===`;
    }

    // ── Build final prompt ────────────────────────────────────────────────────
    const finalContent = content + fileContentText;
    const prompt = await buildPrompt(chat_id, finalContent);
    log('[Worker] 프롬프트 길이:', prompt.length, '자');

    // ── Run Claude ────────────────────────────────────────────────────────────
    const response = await runClaude(prompt);
    log('[Worker] 응답 수신:', response.slice(0,60));

    // ── Insert assistant response ─────────────────────────────────────────────
    const rid = (typeof crypto.randomUUID === 'function')
      ? crypto.randomUUID()
      : 'resp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);

    await dbInsert('messages', {
      id: rid, chat_id, role: 'assistant',
      content: response, status: 'completed',
      files: null,
      created_at: new Date().toISOString(),
    });

    try { await dbUpdate('messages', 'id=eq.' + encodeURIComponent(id), { status: 'completed' }); } catch(e) {}
    log('[Worker] 완료 →', rid.slice(0,8));

    // Cleanup temp files
    for (const file of attachedFiles) {
      try { fs.unlinkSync(file.path); } catch(e) {}
    }

    // Cleanup file_chunks after successful processing
    if (msg.files && msg.files.length > 0) {
      try {
        await dbDelete('file_chunks', 'message_id=eq.' + encodeURIComponent(id));
        log('[Worker] file_chunks 정리 완료');
      } catch (e) {
        warn('[Worker] file_chunks 정리 실패:', e.message);
      }
    }

  } catch (err2) {
    err('[Worker] 오류:', err2.message);
    const errMsg = '⚠️ 오류: ' + err2.message;
    try {
      await dbInsert('messages', {
        id: 'err-' + Date.now(), chat_id, role: 'assistant',
        content: errMsg, status: 'error',
        files: null,
        created_at: new Date().toISOString(),
      });
      await dbUpdate('messages', 'id=eq.' + encodeURIComponent(id), { status: 'completed' });
    } catch(e2) { err('[Worker] 오류 기록 실패:', e2.message); }

    for (const file of attachedFiles) {
      try { fs.unlinkSync(file.path); } catch(e) {}
    }
  }
  await sendHeartbeat();
}

// ── Poll ──────────────────────────────────────────────────────────────────────
async function poll() {
  if (isProcessing) return;
  try {
    const rows = await dbSelect('messages', 'role=eq.user&status=eq.pending&order=created_at.asc&limit=1&select=id,chat_id,content,files');
    if (!rows || rows.length === 0) return;
    isProcessing = true;
    await processMessage(rows[0]);
    isProcessing = false;
  } catch (e) {
    err('[Poll] 오류:', e.message);
    isProcessing = false;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  acquireLock();

  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  Remote Bridge Relay Worker ' + VERSION + '                 ║');
  console.log('║  DRM 흐름: ExportAsFixedFormat → PDF → pdfminer  ║');
  console.log('║  단일 인스턴스 락 (PID 파일)                     ║');
  console.log('║  EAI_AGAIN 재시도 (3x 지수 백오프)               ║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log('║  Hostname: ' + HOSTNAME.padEnd(38) + '║');
  console.log('║  PID:      ' + String(process.pid).padEnd(38) + '║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  // Check Claude CLI
  try {
    const ver = execSync(CLAUDE_EXE + ' --version', { stdio: 'pipe', shell: true }).toString().trim();
    log('[OK] Claude CLI:', ver);
  } catch (e) {
    warn('[WARN] claude --version 실패:', e.message.slice(0, 80));
  }

  // Check markitdown
  try {
    execSync('markitdown --version', { stdio: 'pipe', shell: true, timeout: 5000 });
    log('[OK] markitdown: 설치됨');
  } catch(e) {
    warn('[WARN] markitdown: 미설치 → pip install markitdown[all]');
  }

  // Check pdfminer
  try {
    execSync('python -c "import pdfminer"', { stdio: 'pipe', shell: true, timeout: 5000 });
    log('[OK] pdfminer.six: 설치됨');
  } catch(e) {
    try {
      execSync('python3 -c "import pdfminer"', { stdio: 'pipe', shell: true, timeout: 5000 });
      log('[OK] pdfminer.six: 설치됨 (python3)');
    } catch(e2) {
      warn('[WARN] pdfminer.six: 미설치 → pip install pdfminer.six');
    }
  }

  // Check python-pptx
  try {
    execSync('python -c "from pptx import Presentation"', { stdio: 'pipe', shell: true, timeout: 5000 });
    log('[OK] python-pptx: 설치됨');
  } catch(e) {
    warn('[WARN] python-pptx: 미설치 → pip install python-pptx');
  }

  // Check Supabase
  try {
    await dbSelect('messages', 'limit=1&select=id');
    log('[OK] Supabase 연결 성공');
  } catch (e) {
    err('[FATAL] Supabase 연결 실패:', e.message);
    process.exit(1);
  }

  // Check file_chunks table
  try {
    await dbSelect('file_chunks', 'limit=1&select=id');
    log('[OK] file_chunks 테이블 접근 성공');
  } catch (e) {
    warn('[WARN] file_chunks 테이블 접근 실패:', e.message.slice(0, 80));
  }

  // Check Bridge status
  const bridgeOnline = await checkBridgeOnline();
  log(bridgeOnline ? '[OK] 🏢 Bridge (회사 PC): 온라인' : '[WARN] 🏢 Bridge (회사 PC): 오프라인 (DRM 파일은 브라우저 DRM 흐름으로 처리)');

  // Recover stuck messages
  await recoverStuckMessages();

  // Start heartbeat and polling
  await sendHeartbeat();
  log('[OK] 하트비트 전송 완료');
  log('[OK] 폴링 시작 (' + CONFIG.pollInterval + 'ms)...\n');

  setInterval(sendHeartbeat, CONFIG.heartbeatInterval);
  setInterval(handlePings,   CONFIG.pollInterval);
  setInterval(poll,          CONFIG.pollInterval);
  poll();
  handlePings();
}

main().catch(e => { err('[FATAL]', e.message); releaseLock(); process.exit(1); });
