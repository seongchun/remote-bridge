/**
 * Remote Bridge Relay Worker v36
 * ======================================
 * 변경사항 (v35 → v36):
 * - [ARCH] DRM 파일 처리 정공법 복원:
 *   1) Method 0(ZIP 구조) 실패 + DRM 서명 감지
 *   2) Bridge 온라인이면 → Methods 1,2 건너뛰고 Method 3(회사 PC Office COM→PDF) 직행
 *   3) Bridge 오프라인이면 → 즉시 DRM 안내 반환 (fail-fast, 3~10초 낭비 제거)
 * - [FIX] Method 3 PowerShell 오류 수정:
 *   * Supabase REST 문법 =eq= → =eq. (올바른 필터)
 *   * $i: (스코프 구분자로 해석됨) → ${i}: (변수 종료 명시)
 * - [FIX] Claude 프롬프트에 DRM 감지 시 명확한 시스템 지침 주입
 *   → 사용자에게 환각 대신 정확한 DRM 안내 제공
 * - [UX] interim 메시지 컨텍스트별 구분:
 *   * 파일 없음: "💭 답변 생성 중..."
 *   * 파일 있음: "📎 파일 분석 중... (N개)"
 *   → 실제와 맞지 않는 고정 문구 제거
 * - [SYNC] cowork-web.html v36과 동기화
 */
'use strict';
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
const VERSION   = 'v36';
const LOCK_FILE = path.join(os.tmpdir(), 'relay-worker.lock');

const CONFIG = {
  pollInterval:         3000,
  claudeTimeout:        120000,
  heartbeatInterval:    15000,
  maxPromptLen:         8000,
  bridgeExtractTimeout: 90000,
  keepAliveInterval:    6 * 60 * 60 * 1000,  // 6h
  sysLogMaxRows:        500,
  startupRetries:       5,
  startupRetryDelay:    10000,
  supaRetryMax:         5,                    // v33: 3→5
  watchdogInterval:     60000,                // v33: 60초마다 워치독
  watchdogStuckMin:     3,                    // v33: 3분 이상 processing → 복구
  markitdownInstalled:  null,                 // null=미확인, true/false
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

// ── HTTPS helper (5회 재시도, 지수 백오프 최대 30초) ────────────────────────────
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
      if (retryable && retryCount < CONFIG.supaRetryMax) {
        const delay = Math.min((retryCount + 1) * 3000, 30000);
        warn('[Retry] ' + e.code + ' → ' + delay + 'ms 후 재시도 (' + (retryCount + 1) + '/' + CONFIG.supaRetryMax + ')');
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
function dbUpsert(table, obj)   { return supaReq('POST', table + '?on_conflict=id', obj, { 'Prefer': 'resolution=merge-duplicates,return=minimal' }); }
function dbDelete(table, query) { return supaReq('DELETE', table + '?' + query, null, null); }

// ── sys_log: fire-and-forget Supabase logging ─────────────────────────────────
function sysLog(level, event, detail) {
  const id = 'log-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  const obj = {
    id, level, component: 'relay', event,
    detail:      typeof detail === 'string' ? detail : JSON.stringify(detail),
    hostname:    HOSTNAME,
    version:     VERSION,
    created_at:  new Date().toISOString(),
  };
  dbInsert('sys_log', obj).catch(() => {});
}

async function cleanupSysLog() {
  try {
    const rows = await dbSelect('sys_log',
      'order=created_at.desc&limit=1&offset=' + CONFIG.sysLogMaxRows + '&select=created_at');
    if (rows && rows.length > 0) {
      const cutoff = rows[0].created_at;
      await dbDelete('sys_log', 'created_at=lt.' + encodeURIComponent(cutoff));
      log('[SysLog] 오래된 로그 정리 완료');
    }
  } catch(e) {}
}

// ── Supabase keep-alive ────────────────────────────────────────────────────────
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
  } catch (e) {
    warn('[Heartbeat] upsert 실패:', e.message.slice(0, 120));
    sysLog('warn', 'heartbeat_fail', { err: e.message.slice(0, 200) });
  }
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

// ═══════════════════════════════════════════════════════════════════════════════
// [v33 NEW] Office XML 추출 — PowerShell Expand-Archive (Python 불필요)
// PPTX/DOCX/XLSX 파일은 ZIP 아카이브 → XML 파싱으로 텍스트 추출
// ═══════════════════════════════════════════════════════════════════════════════
function extractViaOfficeXML(filePath, ext) {
  const tmpDir = path.join(os.tmpdir(), 'ofxml-' + Date.now() + '-' + Math.random().toString(36).slice(2, 5));
  try {
    // PowerShell Expand-Archive는 Windows 5.1(PS v4+)부터 내장
    const safeFile = filePath.replace(/'/g, "''");
    const safeTmp  = tmpDir.replace(/'/g, "''");
    execSync(
      `powershell -NoProfile -Command "Expand-Archive -LiteralPath '${safeFile}' -DestinationPath '${safeTmp}' -Force"`,
      { shell: true, timeout: 30000 }
    );

    const texts = [];

    if (['.pptx', '.ppt'].includes(ext)) {
      // ppt/slides/slide*.xml → <a:t> 태그
      const slidesDir = path.join(tmpDir, 'ppt', 'slides');
      if (!fs.existsSync(slidesDir)) throw new Error('ppt/slides 디렉토리 없음 — DRM 파일일 수 있음');
      const slideFiles = fs.readdirSync(slidesDir)
        .filter(f => /^slide\d+\.xml$/i.test(f))
        .sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]));
      if (slideFiles.length === 0) throw new Error('슬라이드 XML 파일 없음');
      for (let i = 0; i < slideFiles.length; i++) {
        const xml = fs.readFileSync(path.join(slidesDir, slideFiles[i]), 'utf8');
        const tags = xml.match(/<a:t[^>]*>([^<]*)<\/a:t>/g) || [];
        const slideText = tags.map(t => t.replace(/<[^>]+>/g, '')).filter(s => s.trim()).join(' ');
        if (slideText.trim()) texts.push(`=== 슬라이드 ${i + 1} ===\n${slideText.trim()}`);
      }
      log(`[OfficeXML] PPTX: ${slideFiles.length}슬라이드, ${texts.length}섹션 추출`);

    } else if (['.docx', '.doc'].includes(ext)) {
      // word/document.xml → <w:t> 태그
      const docXml = path.join(tmpDir, 'word', 'document.xml');
      if (!fs.existsSync(docXml)) throw new Error('word/document.xml 없음 — DRM 파일일 수 있음');
      const xml = fs.readFileSync(docXml, 'utf8');
      const tags = xml.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || [];
      const docText = tags.map(t => t.replace(/<[^>]+>/g, '')).filter(s => s.trim()).join(' ');
      if (docText.trim()) texts.push(docText.trim());
      log(`[OfficeXML] DOCX: ${docText.length}자 추출`);

    } else if (['.xlsx', '.xls'].includes(ext)) {
      // sharedStrings.xml (문자열 인덱스 테이블) 로드
      const sharedStrings = [];
      const ssPath = path.join(tmpDir, 'xl', 'sharedStrings.xml');
      if (fs.existsSync(ssPath)) {
        const ssXml = fs.readFileSync(ssPath, 'utf8');
        const siBlocks = ssXml.match(/<si>[\s\S]*?<\/si>/g) || [];
        siBlocks.forEach(si => {
          const tTags = si.match(/<t[^>]*>([^<]*)<\/t>/g) || [];
          sharedStrings.push(tTags.map(t => t.replace(/<[^>]+>/g, '')).join(''));
        });
      }
      // xl/worksheets/sheet*.xml
      const wsDir = path.join(tmpDir, 'xl', 'worksheets');
      if (!fs.existsSync(wsDir)) throw new Error('xl/worksheets 디렉토리 없음 — DRM 파일일 수 있음');
      const sheetFiles = fs.readdirSync(wsDir)
        .filter(f => /^sheet\d+\.xml$/i.test(f))
        .sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]));
      sheetFiles.forEach((sf, si) => {
        const xml = fs.readFileSync(path.join(wsDir, sf), 'utf8');
        const rows = xml.match(/<row[^>]*>[\s\S]*?<\/row>/g) || [];
        const rowTexts = rows.map(row => {
          const cells = row.match(/<c[^>]*>[\s\S]*?<\/c>/g) || [];
          return cells.map(cell => {
            const tAttr = (cell.match(/\st="([^"]*)"/) || [])[1];
            const vMatch = cell.match(/<v>([^<]*)<\/v>/);
            if (!vMatch) return '';
            const val = vMatch[1];
            if (tAttr === 's') return sharedStrings[parseInt(val)] || val;
            return val;
          }).filter(Boolean).join('\t');
        }).filter(Boolean);
        if (rowTexts.length) texts.push(`=== Sheet ${si + 1} ===\n${rowTexts.join('\n')}`);
      });
      log(`[OfficeXML] XLSX: ${sheetFiles.length}시트, ${texts.length}섹션 추출`);
    }

    if (texts.length === 0) throw new Error('추출된 텍스트 없음 — XML 구조가 다를 수 있음');
    const result = texts.join('\n\n');
    log(`[OfficeXML] 성공: 총 ${result.length}자`);
    return result;

  } finally {
    // 임시 폴더 항상 정리
    try { execSync(`if exist "${tmpDir}" rd /s /q "${tmpDir}"`, { shell: true, timeout: 10000 }); } catch(e) {}
  }
}

// ── PDF 추출 ───────────────────────────────────────────────────────────────────
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

// [v33 NEW] markitdown 자동 설치 시도
async function tryAutoInstallMarkitdown() {
  if (CONFIG.markitdownInstalled === true) return true;
  if (CONFIG.markitdownInstalled === false) return false;
  try {
    log('[AutoInstall] markitdown 자동 설치 시도...');
    execSync('pip install markitdown[all] --quiet', { shell: true, timeout: 120000, stdio: 'pipe' });
    CONFIG.markitdownInstalled = true;
    log('[AutoInstall] markitdown 설치 성공');
    sysLog('info', 'auto_install_success', { pkg: 'markitdown' });
    return true;
  } catch(e) {
    CONFIG.markitdownInstalled = false;
    warn('[AutoInstall] markitdown 설치 실패:', e.message.slice(0, 100));
    return false;
  }
}

/**
 * DRM deprotect via Bridge (company PC) — COM → PDF → Supabase
 */
async function extractViaBridgeCOMDirect(messageId, fileName) {
  const ext = path.extname(fileName).toLowerCase();
  const safeName = fileName.replace(/'/g, "''");

  const lines = [
    `$supaUrl = '${SUPA_URL}'`,
    `$supaKey = '${SUPA_KEY}'`,
    `$msgId = '${messageId}'`,
    `$fileName = '${safeName}'`,
    `$ext = '${ext}'`,
    '',
    // [v36 FIX] Supabase REST 문법은 =eq. (점) — 이전 =eq= 이중등호는 잘못됨
    '$uri = $supaUrl + "/rest/v1/file_chunks" +',
    '  "?message_id=eq." + [uri]::EscapeDataString($msgId) +',
    '  "&file_name=eq." + [uri]::EscapeDataString($fileName) +',
    '  "&order=chunk_index.asc&select=chunk_index,data"',
    '$hdr = @{ apikey = $supaKey; Authorization = "Bearer $supaKey" }',
    'try {',
    '  $chunks = Invoke-RestMethod -Uri $uri -Headers $hdr -Method Get',
    '} catch {',
    '  Write-Output ("FAIL:chunk download error: " + $_.Exception.Message); return',
    '}',
    'if (-not $chunks -or $chunks.Count -eq 0) { Write-Output "FAIL:no chunks"; return }',
    '$b64 = ($chunks | Sort-Object chunk_index | ForEach-Object { $_.data }) -join ""',
    '$bytes = [Convert]::FromBase64String($b64)',
    '$ts = Get-Date -f "yyyyMMddHHmmssfff"',
    '$tmpF   = [IO.Path]::Combine($env:TEMP, "bridge-src-" + $ts + $ext)',
    '$tmpPdf = [IO.Path]::Combine($env:TEMP, "bridge-out-" + $ts + ".pdf")',
    '[IO.File]::WriteAllBytes($tmpF, $bytes)',
    '',
    '$preFed5Ids = @(Get-Process -EA 0 | Where-Object {',
    '  $_.MainWindowTitle -ne "" -and $_.MainWindowTitle -match "FED5"',
    '} | Select-Object -ExpandProperty Id)',
    '',
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
    'if (-not (Test-Path $tmpPdf)) { Write-Output "FAIL:PDF not found after export"; return }',
    '$pdfBytes = [IO.File]::ReadAllBytes($tmpPdf)',
    'Remove-Item $tmpPdf -EA 0',
    '$b64Pdf = [Convert]::ToBase64String($pdfBytes)',
    '$chunkSize = 900 * 1024',
    '$totalLen  = $b64Pdf.Length',
    '$totalChunks = [Math]::Ceiling($totalLen / $chunkSize)',
    '$pdfName = $fileName + ".drm.pdf"',
    // [v36 FIX] =eq= → =eq.
    '$delUri = $supaUrl + "/rest/v1/file_chunks?message_id=eq." + [uri]::EscapeDataString($msgId) + "&file_name=eq." + [uri]::EscapeDataString($pdfName)',
    'try { Invoke-RestMethod -Uri $delUri -Headers $hdr -Method Delete } catch {}',
    'for ($i = 0; $i -lt $totalChunks; $i++) {',
    '  $start  = $i * $chunkSize',
    '  $length = [Math]::Min($chunkSize, $totalLen - $start)',
    '  $chunkData = $b64Pdf.Substring($start, $length)',
    '  $body = @{ message_id=$msgId; file_name=$pdfName; chunk_index=$i; total_chunks=$totalChunks; data=$chunkData } | ConvertTo-Json -Depth 2',
    '  $insUri = $supaUrl + "/rest/v1/file_chunks"',
    '  $insHdr = $hdr + @{ "Content-Type" = "application/json"; "Prefer" = "return=minimal" }',
    '  try { Invoke-RestMethod -Uri $insUri -Headers $insHdr -Method Post -Body $body | Out-Null }',
    // [v36 FIX] PowerShell에서 "$i:"는 scope 구분자로 해석되어 파싱 오류 → ${i}로 명시
    '  catch { Write-Output ("FAIL:upload chunk ${i}: " + $_.Exception.Message); return }',
    '}',
    'Write-Output ("OK:UPLOADED_PDF:" + $pdfName + ":chunks=" + $totalChunks)',
  ];

  const psScript = lines.join('\n');
  const cmdId = 'relay-drm-' + Date.now() + '-' + Math.random().toString(36).slice(2, 5);

  sysLog('info', 'drm_start', { messageId: messageId.slice(0, 8), fileName, cmdId });
  await dbInsert('commands', {
    id: cmdId, action: 'run_ps', target: '', content: psScript, status: 'pending',
  });
  log('[Bridge] DRM 요청:', fileName, '→ cmd:', cmdId);

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
          sysLog('warn', 'drm_ep_login', { messageId: messageId.slice(0, 8) });
          throw new Error('EP 로그인이 필요합니다. EP(FED5)에 로그인 후 재시도하세요.');
        }
        if (result === 'COM_TIMEOUT') {
          sysLog('error', 'drm_timeout', { messageId: messageId.slice(0, 8) });
          throw new Error('COM 작업 타임아웃 (180초). Office가 응답하지 않습니다.');
        }
        if (result.startsWith('OK:UPLOADED_PDF:')) {
          const uploadedName = result.split(':')[2];
          log('[Bridge] PDF 업로드 완료:', uploadedName);
          sysLog('info', 'drm_uploaded', { messageId: messageId.slice(0, 8), uploadedName });
          return uploadedName;
        }
        const errMsg = result.startsWith('FAIL:') ? result.slice(5) : result;
        sysLog('error', 'drm_fail', { messageId: messageId.slice(0, 8), err: errMsg.slice(0, 200) });
        throw new Error('Bridge DRM 실패: ' + errMsg.slice(0, 200));
      }
    }
  }
  try { await dbDelete('commands', `id=eq.${encodeURIComponent(cmdId)}`); } catch(e) {}
  sysLog('error', 'drm_timeout_relay', { messageId: messageId.slice(0, 8) });
  throw new Error(`Bridge 응답 없음 (${CONFIG.bridgeExtractTimeout / 1000}초)`);
}

// ── Main extraction — Method 0 우선순위 ────────────────────────────────────────
async function extractFileContent(messageId, fileName, filePath, fileBuffer) {
  const ext = path.extname(fileName).toLowerCase();
  const isPptx   = ['.pptx', '.ppt'].includes(ext);
  const isDocx   = ['.docx', '.doc'].includes(ext);
  const isXlsx   = ['.xlsx', '.xls'].includes(ext);
  const isOffice = isPptx || isDocx || isXlsx;
  const isPdf    = ext === '.pdf' || (fileBuffer && isPdfBuffer(fileBuffer));

  if (isPdf) {
    log('[Extract] PDF 파일:', fileName);
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

  if (isOffice) {
    const errors = {};

    // ── Method 0: Office XML (PowerShell Expand-Archive) ──────────────────────
    // 이것이 실패하는 방식으로 DRM 여부를 즉시 판단한다.
    try {
      log('[Extract] Method 0: Office XML -', fileName);
      const text = extractViaOfficeXML(filePath, ext);
      if (text && text.length > 10) {
        log('[Extract] Method 0 성공 ✓');
        return text;
      }
    } catch(e) {
      errors.officeXml = e.message.slice(0, 200);
      warn('[Extract] Method 0 실패:', errors.officeXml);

      // [v36 FIX] DRM fail-fast: "not a supported archive" = 파일 자체가 ZIP이 아님 = DRM 암호화
      const isDrmSignature =
        /not a supported archive/i.test(errors.officeXml) ||
        /supported archive file format/i.test(errors.officeXml) ||
        /ppt\/slides 디렉토리 없음|word\/document\.xml 없음|xl\/worksheets 디렉토리 없음/.test(errors.officeXml);

      if (isDrmSignature) {
        // [v36 RESTORE] DRM 감지 시 Bridge 온라인이면 Method 3으로 회사 PC Office로 PDF 변환 시도
        const bridgeOnline = await checkBridgeOnline();
        if (!bridgeOnline) {
          log('[Extract] DRM 파일 + Bridge 오프라인 → fail-fast');
          sysLog('warn', 'drm_detected_no_bridge', { fileName, size: fileBuffer ? fileBuffer.length : 0 });
          return `[DRM_PROTECTED:${fileName}]`;
        }
        log('[Extract] DRM 파일 감지됨 + Bridge 온라인 → Methods 1~2 건너뛰고 Method 3로 직행');
        errors.drmDetected = true;
        // fall through — Method 3만 시도
      } else {
        // DRM 아니면 일반 손상/구조 오류 — 다음 방법 시도
        sysLog('warn', 'office_xml_fail', { fileName, err: errors.officeXml });
      }
    }

    // ── Method 1: markitdown (비-DRM 파일의 대체 경로) ─────────────────────────
    if (!errors.drmDetected) {
      try {
        log('[Extract] Method 1: markitdown -', fileName);
        const text = extractViaMarkitdown(filePath);
        if (text && text.length > 10) {
          log('[Extract] Method 1 성공 ✓');
          return text;
        }
      } catch(e) {
        errors.markitdown = e.message.slice(0, 100);
        warn('[Extract] Method 1 실패:', errors.markitdown);
        if (errors.markitdown.includes('not found') || errors.markitdown.includes('not recognized')) {
          tryAutoInstallMarkitdown().catch(() => {});
        }
      }
    }

    // ── Method 2: python-pptx (PPTX only) ────────────────────────────────────
    if (isPptx && !errors.drmDetected) {
      try {
        log('[Extract] Method 2: python-pptx -', fileName);
        const text = extractViaPythonPptx(filePath);
        if (text && text.length > 10) {
          log('[Extract] Method 2 성공 ✓');
          return text;
        }
      } catch(e) {
        errors.pythonPptx = e.message.slice(0, 100);
        warn('[Extract] Method 2 실패:', errors.pythonPptx);
      }
    }

    // ── Method 3: Bridge DRM (회사 PC Office COM → PDF → 텍스트) ──────────────
    // 사용자의 공식 아키텍처: 회사 PC의 정품 Office로 DRM 파일을 열어
    // DRM이 해제된 PDF로 저장 → 집 PC가 PDF 텍스트 추출
    // DRM 감지됐거나 Methods 1~2 모두 실패 시 실행 (Bridge 온라인일 때만)
    if (errors.drmDetected || (errors.markitdown && (errors.pythonPptx || !isPptx))) {
      const bridgeOnline = await checkBridgeOnline();
      if (bridgeOnline) {
        try {
          log('[Extract] Method 3: Bridge DRM (Office COM → PDF) -', fileName);
          const uploadedPdfName = await extractViaBridgeCOMDirect(messageId, fileName);
          const pdfBuffer = await chunksDownload(messageId, uploadedPdfName);
          const pdfPath = path.join(os.tmpdir(), 'relay-drm-' + Date.now() + '.pdf');
          fs.writeFileSync(pdfPath, pdfBuffer);
          try {
            const text = extractViaPdf(pdfPath);
            if (text && text.length > 10) {
              log('[Extract] Method 3 성공 ✓ (DRM 우회)');
              sysLog('info', 'drm_bypass_success', { fileName, textLen: text.length });
              try {
                await dbDelete('file_chunks',
                  `message_id=eq.${encodeURIComponent(messageId)}&file_name=eq.${encodeURIComponent(uploadedPdfName)}`);
              } catch(_) {}
              return text;
            }
          } finally {
            try { fs.unlinkSync(pdfPath); } catch(_) {}
          }
        } catch(e) {
          errors.bridgeDrm = e.message.slice(0, 200);
          err('[Extract] Method 3 실패:', errors.bridgeDrm);
          sysLog('error', 'bridge_drm_fail', { fileName, err: errors.bridgeDrm });
        }
      } else {
        log('[Extract] Method 3 건너뜀: Bridge 오프라인');
        errors.bridgeDrm = 'bridge_offline';
      }
    }

    // DRM 파일인데 Method 3도 실패했으면 명시적 DRM 응답
    if (errors.drmDetected) {
      return `[DRM_PROTECTED:${fileName}]`;
    }

    // 모든 방법 실패 (DRM은 아니지만 추출 불가)
    const errorSummary = Object.entries(errors).map(([k, v]) => `• ${k}: ${v}`).join('\n');
    sysLog('error', 'extract_all_methods_failed', { fileName, errors: JSON.stringify(errors) });
    return `[파일 내용 추출 실패: ${fileName}]\n\n` +
           `시도한 방법:\n${errorSummary}\n\n` +
           `💡 해결 방법:\n` +
           `1. 파일이 손상되지 않았는지 확인하세요\n` +
           `2. 집 PC: pip install markitdown[all]\n` +
           `3. 또는 내용을 텍스트로 복사해서 직접 붙여넣기`;
  }

  return `[지원하지 않는 파일 형식: ${ext}]\n지원 형식: .pptx .ppt .docx .doc .xlsx .xls .pdf`;
}

// ── Recover stuck messages ─────────────────────────────────────────────────────
async function recoverStuckMessages(sinceMinutes) {
  try {
    let query = 'role=eq.user&status=eq.processing&select=id,content';
    if (sinceMinutes) {
      const threshold = new Date(Date.now() - sinceMinutes * 60 * 1000).toISOString();
      query = 'role=eq.user&status=eq.processing&created_at=lt.' + encodeURIComponent(threshold) + '&select=id,content';
    }
    const stuck = await dbSelect('messages', query);
    if (!stuck || stuck.length === 0) return 0;
    log('[Recovery] processing 메시지', stuck.length, '개 → pending 복구');
    sysLog('warn', 'stuck_messages_recovered', { count: stuck.length, sinceMinutes: sinceMinutes || 'all' });
    for (const msg of stuck) {
      await dbUpdate('messages', 'id=eq.' + encodeURIComponent(msg.id), { status: 'pending' });
    }
    return stuck.length;
  } catch (e) {
    err('[Recovery] 실패:', e.message);
    return 0;
  }
}

// [v33 NEW] 워치독: 60초마다 processing > 3분 메시지 자동 복구
async function watchdogRecovery() {
  try {
    const count = await recoverStuckMessages(CONFIG.watchdogStuckMin);
    if (count > 0) {
      log('[Watchdog] 고착 메시지', count, '개 자동 복구 완료');
    }
  } catch(e) {}
}

// ── Command Handler ────────────────────────────────────────────────────────────
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
        log('[AutoDebug] 자가진단 요청 수신');
        await dbUpdate('commands', 'id=eq.' + row.id, { status: 'completed', result: 'diagnosing' });
        runAutoDebug(row).catch(e => err('[AutoDebug] 오류:', e.message));
        continue;
      }

      // ping
      await dbUpdate('commands', 'id=eq.' + row.id, {
        status: 'completed',
        result: 'pong from relay ' + VERSION + '/' + HOSTNAME + ' at ' + now,
      });
    }
  } catch (e) {}
}

// ── Auto-Debug ─────────────────────────────────────────────────────────────────
async function runAutoDebug(cmd) {
  const chatId = cmd.target;
  let ctx = {};
  try { ctx = JSON.parse(cmd.content || '{}'); } catch(e) {}

  sysLog('info', 'auto_debug_start', { chatId: chatId ? chatId.slice(0, 8) : '?' });

  let diagText = '=== 자가진단 보고서 (v33) ===\n';
  diagText += `시간: ${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}\n`;
  diagText += `릴레이: ${VERSION}/${HOSTNAME} (PID=${process.pid}, 가동시간=${process.uptime().toFixed(0)}s)\n`;
  diagText += `처리 중: ${isProcessing}\n\n`;

  try {
    const stuck = await dbSelect('messages', 'role=eq.user&status=in.(pending,processing)&select=id,status,created_at');
    if (stuck && stuck.length > 0) {
      diagText += `대기/처리 중 메시지: ${stuck.length}개\n`;
      stuck.forEach(m => {
        const age = Math.floor((Date.now() - new Date(m.created_at).getTime()) / 1000);
        diagText += `  - id=${m.id.slice(0, 8)} status=${m.status} (${age}초 전)\n`;
      });
    } else {
      diagText += '대기 메시지: 없음\n';
    }
  } catch(e) { diagText += `대기 메시지 확인 실패: ${e.message}\n`; }

  try {
    const errs = await dbSelect('sys_log', 'level=in.(error,fatal)&order=created_at.desc&limit=5&select=event,detail,created_at');
    if (errs && errs.length > 0) {
      diagText += '\n최근 오류:\n';
      errs.forEach(e => { diagText += `  [${e.event}] ${(e.detail || '').slice(0, 120)}\n`; });
    }
  } catch(e) { diagText += '\nsys_log 접근 불가\n'; }

  try {
    const ver = execSync(CLAUDE_EXE + ' --version', { stdio: 'pipe', shell: true, timeout: 5000 }).toString().trim();
    diagText += `\nClaude CLI: ${ver}\n`;
  } catch(e) {
    diagText += `\nClaude CLI 오류: ${e.message.slice(0, 100)}\n`;
  }

  if (ctx.recentErrors && ctx.recentErrors !== '없음') {
    diagText += `\n브라우저가 보고한 오류:\n${ctx.recentErrors.slice(0, 300)}\n`;
  }

  const diagPrompt = `당신은 Remote Bridge 자가진단 AI입니다. 다음 진단 정보를 분석하고, 한국어로 간결하게 (5줄 이내) 문제와 해결책을 알려주세요.

${diagText}

분석 결과:
🔍 **진단 결과**: (무엇이 문제인지)
🔧 **해결 방법**: (사용자가 취해야 할 행동, 또는 "자동 복구 완료")`;

  let diagResult = diagText;
  try {
    diagResult = await runClaude(diagPrompt);
    sysLog('info', 'auto_debug_done', { chatId: chatId ? chatId.slice(0, 8) : '?' });
  } catch(e) {
    diagResult = `진단 완료 (Claude CLI 응답 없음):\n\n${diagText}`;
    sysLog('error', 'auto_debug_claude_fail', { err: e.message.slice(0, 200) });
  }

  // 고착 메시지 자동 복구
  try {
    const recovered = await recoverStuckMessages(0);
    if (recovered > 0) diagResult += `\n\n✅ 자동 복구: ${recovered}개 고착 메시지 → pending 재설정`;
  } catch(e) {}

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
    const proc = spawn(cmd, [], { shell: true, env: process.env });
    let out = '', errText = '', settled = false;
    function done(fn) { if (!settled) { settled = true; clearTimeout(killTimer); fn(); } }

    const killTimer = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch(e2) {}
      done(() => {
        try { fs.unlinkSync(tmpFile); } catch(e2) {}
        reject(new Error('Claude CLI timeout (' + CONFIG.claudeTimeout / 1000 + 's) — 응답 없음'));
      });
    }, CONFIG.claudeTimeout);

    proc.stdout.on('data', d => { out += d.toString(); });
    proc.stderr.on('data', d => { errText += d.toString(); });
    proc.on('close', code => {
      done(() => {
        try { fs.unlinkSync(tmpFile); } catch(e) {}
        if (code === 0 && out.trim()) {
          resolve(out.trim());
        } else if (code === 0 && !out.trim()) {
          reject(new Error('claude 응답 없음. stderr: ' + errText.slice(0, 200)));
        } else {
          reject(new Error('claude 종료코드 ' + code + ': ' + (errText || out).slice(0, 300)));
        }
      });
    });
    proc.on('error', e => {
      done(() => {
        try { fs.unlinkSync(tmpFile); } catch(e2) {}
        reject(new Error('Claude 실행 실패: ' + e.message));
      });
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
        let line = (m.role === 'user' ? 'Human' : 'Assistant') + ': ' + (m.content || '').slice(0, 600);
        if (m.files && Array.isArray(m.files) && m.files.length > 0) {
          line += '\n[첨부파일: ' + m.files.map(f => f.name).join(', ') + ']';
        }
        return line;
      })
      .join('\n\n');
    const full = hist + '\n\nHuman: ' + currentContent;
    return full.length > CONFIG.maxPromptLen ? 'Human: ' + currentContent : full;
  } catch (e) {
    return currentContent;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Process message — 임시 메시지 + 오류 5회 재시도
// ═══════════════════════════════════════════════════════════════════════════════
async function processMessage(msg) {
  const id = msg.id, chat_id = msg.chat_id;
  let content = msg.content || '';
  let attachedFiles = [];

  log('[Worker] 처리 중:', id.slice(0, 8), '"' + content.slice(0, 50) + '"');
  sysLog('info', 'message_received', { id: id.slice(0, 8), preview: content.slice(0, 80) });

  try { await dbUpdate('messages', 'id=eq.' + encodeURIComponent(id), { status: 'processing' }); } catch(e) {}
  await sendHeartbeat();

  // [v36 UX] 컨텍스트별 interim 메시지 — 실제와 맞게
  const fileCount = (msg.files && Array.isArray(msg.files)) ? msg.files.length : 0;
  const interimText = fileCount > 0
    ? `📎 파일 분석 중... (${fileCount}개 파일)`
    : `💭 답변 생성 중...`;
  const interimId = 'interim-' + id.slice(0, 8) + '-' + Date.now();
  let interimSent = false;
  try {
    await dbInsert('messages', {
      id: interimId, chat_id, role: 'assistant',
      content: interimText,
      status: 'pending', files: null, created_at: new Date().toISOString(),
    });
    interimSent = true;
    log('[Worker] 임시 메시지 전송 ✓ (' + interimText + ')');
  } catch(e) {
    warn('[Worker] 임시 메시지 전송 실패 (무시):', e.message.slice(0, 80));
  }

  try {
    // 파일 다운로드
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
          sysLog('error', 'file_download_fail', { id: id.slice(0, 8), file: file.name, err: e.message.slice(0, 200) });
        }
      }
    }

    // 파일 텍스트 추출
    let fileContentText = '';
    let drmBlockedFiles = [];
    for (const file of attachedFiles) {
      log('[Worker] 파일 추출:', file.name);
      const extractedText = await extractFileContent(id, file.name, file.path, file.buffer);
      // [v36] DRM 감지 시 전용 섹션으로 분리
      const drmMatch = /^\[DRM_PROTECTED:(.+)\]$/.exec(extractedText);
      if (drmMatch) {
        drmBlockedFiles.push(drmMatch[1]);
      } else {
        fileContentText += `\n\n=== 첨부파일: ${file.name} ===\n${extractedText}\n=== 끝 ===`;
      }
    }

    // [v36] DRM 파일이 있으면 Claude에게 명확한 시스템 지침 주입 → 환각 방지
    let systemDirective = '';
    if (drmBlockedFiles.length > 0) {
      systemDirective =
        '\n\n[시스템 지침 — 반드시 따를 것]\n' +
        '사용자가 첨부한 다음 파일은 DRM(문서보안)으로 암호화되어 있어 내용을 읽을 수 없습니다:\n' +
        drmBlockedFiles.map(f => '• ' + f).join('\n') + '\n\n' +
        '사용자에게 다음 내용 그대로 안내하세요. 파일 경로나 폴더 권한에 대해 언급하지 마세요:\n' +
        '──────────────────────────\n' +
        '❌ 첨부하신 파일은 회사 문서보안(DRM)으로 암호화되어 있어 읽을 수 없습니다.\n\n' +
        '📌 해결 방법 (택 1):\n' +
        '1. **PowerPoint에서 열기 → 다른 이름으로 저장** → 파일 형식 "PowerPoint 프레젠테이션(*.pptx)"으로 저장 → 보안 해제된 파일을 업로드\n' +
        '2. **내용 복사하여 붙여넣기**: PPT 내용을 선택하고 Ctrl+C → 이 채팅창에 Ctrl+V\n' +
        '3. **화면 캡처 후 업로드**: 슬라이드를 캡처해서 이미지로 업로드 (이미지는 DRM 대상 아님)\n' +
        '──────────────────────────\n';
    }

    const finalContent = content + fileContentText + systemDirective;
    const prompt = await buildPrompt(chat_id, finalContent);
    log('[Worker] 프롬프트 길이:', prompt.length);

    const response = await runClaude(prompt);
    log('[Worker] 응답 수신:', response.slice(0, 60));

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

    // 정리
    for (const file of attachedFiles) { try { fs.unlinkSync(file.path); } catch(e) {} }
    if (msg.files && msg.files.length > 0) {
      try { await dbDelete('file_chunks', 'message_id=eq.' + encodeURIComponent(id)); } catch(e) {}
    }

  } catch (procErr) {
    err('[Worker] 처리 오류:', procErr.message);
    sysLog('error', 'message_error', {
      id: id.slice(0, 8),
      err: procErr.message.slice(0, 300),
      stack: (procErr.stack || '').slice(0, 200),
    });

    // [v33 NEW] 오류 메시지 5회 재시도 — 반드시 사용자에게 전달
    const errMsg = '⚠️ 오류가 발생했습니다:\n' + procErr.message +
      '\n\n💡 파일 분석 실패 시 회사 PC에서 start-bridge.bat 실행 후 재시도해 주세요.';
    let saved = false;
    for (let attempt = 1; attempt <= 5 && !saved; attempt++) {
      try {
        await dbInsert('messages', {
          id: 'err-' + Date.now() + '-' + attempt,
          chat_id, role: 'assistant',
          content: errMsg, status: 'error',
          files: null, created_at: new Date().toISOString(),
        });
        saved = true;
        log('[Worker] 오류 메시지 저장 성공 (시도 ' + attempt + ')');
      } catch(e2) {
        warn('[Worker] 오류 메시지 저장 실패 (시도 ' + attempt + '):', e2.message.slice(0, 80));
        if (attempt < 5) await new Promise(r => setTimeout(r, attempt * 2000));
      }
    }

    try { await dbUpdate('messages', 'id=eq.' + encodeURIComponent(id), { status: 'completed' }); } catch(e) {}
    for (const file of attachedFiles) { try { fs.unlinkSync(file.path); } catch(e) {} }
  }

  // 임시 메시지 항상 삭제 (finally 역할)
  if (interimSent) {
    try { await dbDelete('messages', 'id=eq.' + encodeURIComponent(interimId)); } catch(e) {}
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
  console.log('║  [v36] DRM 감지 → Bridge Office COM → PDF 변환     ║');
  console.log('║  [v36] Bridge 오프라인이면 DRM fail-fast (빠른 안내)║');
  console.log('║  [v36] 컨텍스트별 대기 메시지 (파일/텍스트 구분)   ║');
  console.log('║  [v33] Office XML / 워치독 / 5회 재시도 유지       ║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log('║  Hostname: ' + HOSTNAME.padEnd(38) + '║');
  console.log('║  PID:      ' + String(process.pid).padEnd(38) + '║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  // Claude CLI 확인
  try {
    const ver = execSync(CLAUDE_EXE + ' --version', { stdio: 'pipe', shell: true }).toString().trim();
    log('[OK] Claude CLI:', ver);
  } catch(e) {
    warn('[WARN] claude --version 실패:', e.message.slice(0, 80));
  }

  // PowerShell 확인 (Office XML 추출 필수)
  try {
    execSync('powershell -NoProfile -Command "Write-Output OK"', { stdio: 'pipe', shell: true, timeout: 5000 });
    log('[OK] PowerShell: 사용 가능 (Office XML 추출 지원)');
  } catch(e) {
    warn('[WARN] PowerShell 사용 불가 — Office XML 추출 제한됨:', e.message.slice(0, 60));
  }

  // Supabase 연결 — 최대 5회 재시도
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
        err('[FATAL] Supabase 연결 최종 실패:', e.message);
        releaseLock(); process.exit(1);
      } else {
        warn('[Retry] Supabase 연결 실패 (' + attempt + '/' + CONFIG.startupRetries + ') — ' + CONFIG.startupRetryDelay / 1000 + '초 후:', e.message.slice(0, 80));
        await new Promise(r => setTimeout(r, CONFIG.startupRetryDelay));
      }
    }
  }

  // 도구 확인
  try {
    execSync('markitdown --version', { stdio: 'pipe', shell: true, timeout: 5000 });
    CONFIG.markitdownInstalled = true;
    log('[OK] markitdown: 설치됨');
  } catch(e) {
    CONFIG.markitdownInstalled = false;
    warn('[WARN] markitdown: 미설치 (Method 0 Office XML이 대신 동작함)');
  }

  try { execSync('python -c "import pdfminer"', { stdio: 'pipe', shell: true, timeout: 5000 }); log('[OK] pdfminer.six: 설치됨'); }
  catch(e) {
    try { execSync('python3 -c "import pdfminer"', { stdio: 'pipe', shell: true, timeout: 5000 }); log('[OK] pdfminer.six: 설치됨 (python3)'); }
    catch(e2) { warn('[WARN] pdfminer.six: 미설치 → pip install pdfminer.six'); }
  }

  // Bridge 상태
  const bridgeOnline = await checkBridgeOnline();
  log(bridgeOnline ? '[OK] 🏢 Bridge (회사 PC): 온라인' : '[WARN] 🏢 Bridge (회사 PC): 오프라인');

  // 시작 시 고착 메시지 복구 (기존 all + v33 워치독)
  await recoverStuckMessages(null);

  sysLog('info', 'startup', { version: VERSION, hostname: HOSTNAME, pid: process.pid });
  await sendHeartbeat();
  log('[OK] 폴링 시작 (' + CONFIG.pollInterval + 'ms)...\n');

  // 주기적 작업 등록
  setInterval(sendHeartbeat,   CONFIG.heartbeatInterval);
  setInterval(handleCommands,  CONFIG.pollInterval);
  setInterval(poll,            CONFIG.pollInterval);
  setInterval(keepAlive,       CONFIG.keepAliveInterval);
  setInterval(watchdogRecovery, CONFIG.watchdogInterval);  // [v33 NEW] 60초 워치독
  setInterval(cleanupSysLog,   24 * 60 * 60 * 1000);

  // 즉시 첫 실행
  poll();
  handleCommands();
  setTimeout(keepAlive, 60 * 1000);
}

main().catch(e => { err('[FATAL]', e.message); releaseLock(); process.exit(1); });
