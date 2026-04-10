/**
 * Remote Bridge Relay Worker v24
 * ======================================
 * UPDATES from v21:
 * - FIXED: Write-Host → Write-Output in Bridge COM PS script (Write-Host goes to
 *   stream 6/Information which Invoke-Expression | Out-String does NOT capture)
 * - FIXED: Bridge COM PS script wrapped in Start-Job with 90s timeout to prevent
 *   PowerPoint COM hanging indefinitely on DRM dialogs or slow file opens
 * - FIXED: PS script now explicitly outputs to stdout via Write-Output
 * - IMPROVED: Better error output capture in the job-based wrapper
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

const CONFIG = {
  pollInterval:      3000,
  claudeTimeout:     120000,
  heartbeatInterval: 15000,
  maxPromptLen:      4000,
  bridgeExtractTimeout: 60000,  // 60s for Bridge COM extraction
  drmMode:             true,    // 회사PC DRM: PPTX는 Bridge COM 직행
};

let isProcessing = false;
const HOSTNAME = os.hostname();
const CLAUDE_EXE = process.env.CLAUDE_PATH || 'claude';

// ── HTTPS helper ──────────────────────────────────────────────────────────────
function supaReq(method, path, body, extraHeaders) {
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
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function dbSelect(table, query) { return supaReq('GET', table + (query ? '?' + query : ''), null, null); }
function dbInsert(table, obj)   { return supaReq('POST', table, obj, { 'Prefer': 'return=minimal' }); }
function dbUpdate(table, query, obj) { return supaReq('PATCH', table + '?' + query, obj, { 'Prefer': 'return=minimal' }); }
function dbUpsert(table, obj)   { return supaReq('POST', table, obj, { 'Prefer': 'resolution=merge-duplicates,return=minimal' }); }

// ── Download file from file_chunks ────────────────────────────────────────────
async function chunksDownload(messageId, fileName) {
  const query = `message_id=eq.${encodeURIComponent(messageId)}&file_name=eq.${encodeURIComponent(fileName)}&order=chunk_index.asc&select=chunk_index,total_chunks,data`;
  const chunks = await dbSelect('file_chunks', query);
  if (!chunks || chunks.length === 0) {
    throw new Error(`No chunks found for message=${messageId}, file=${fileName}`);
  }
  const totalExpected = chunks[0].total_chunks;
  if (chunks.length !== totalExpected) {
    console.warn(`[Chunks] 경고: ${fileName} - 예상 ${totalExpected}개 중 ${chunks.length}개 수신`);
  }
  chunks.sort((a, b) => a.chunk_index - b.chunk_index);
  const base64Full = chunks.map(c => c.data).join('');
  const buffer = Buffer.from(base64Full, 'base64');
  console.log(`[Chunks] ${fileName}: ${chunks.length}개 청크 → ${buffer.length} bytes`);
  return buffer;
}

// ── Heartbeat ─────────────────────────────────────────────────────────────────

async function chunksUpload(messageId, fileName, buffer) {
  const CHUNK_SIZE = 30000;
  const b64 = buffer.toString('base64');
  const total = Math.ceil(b64.length / CHUNK_SIZE);
  for (let i = 0; i < total; i++) {
    const chunk = b64.substring(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
    await dbInsert('file_chunks', {
      message_id: messageId,
      file_name: fileName,
      chunk_index: i,
      total_chunks: total,
      data: chunk,
    });
  }
  console.log('[Upload]', fileName, '→', total, '개 청크 업로드 완료');
}

async function sendHeartbeat() {
  const ts = new Date().toISOString();
  try {
    await dbUpsert('commands', {
      id: 'relay-heartbeat', action: 'heartbeat', target: 'relay',
      content: isProcessing ? 'busy' : 'idle', status: 'completed', result: ts,
    });
  } catch (e) { console.error('[HB] relay err:', e.message); }
  try {
    await dbUpsert('commands', {
      id: 'bridge-heartbeat', action: 'heartbeat', target: 'bridge',
      content: 'relay-written', status: 'completed', result: ts,
    });
  } catch (e) { console.error('[HB] bridge err:', e.message); }
}

// ── Check if Bridge (company PC) is online ────────────────────────────────────
async function checkBridgeOnline() {
  try {
    const rows = await dbSelect('commands', 'id=eq.bridge-heartbeat&select=result');
    if (rows && rows.length && rows[0].result) {
      const ago = (Date.now() - new Date(rows[0].result).getTime()) / 1000;
      return ago < 120; // Online if heartbeat within 2 minutes
    }
    return false;
  } catch(e) { return false; }
}

// ── Recover stuck messages ────────────────────────────────────────────────────
async function recoverStuckMessages() {
  try {
    // Only recover messages stuck within the last 60 minutes
    // Older messages are from previous sessions and should not be reprocessed
    const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const stuck = await dbSelect('messages',
      'role=eq.user&status=eq.processing&created_at=gt.' + encodeURIComponent(cutoff) + '&select=id,content,created_at');
    if (!stuck || stuck.length === 0) return;
    console.log('[Recovery] 최근 1시간 내 stuck 메시지', stuck.length, '개 → pending 복구');
    for (const msg of stuck) {
      await dbUpdate('messages', 'id=eq.' + encodeURIComponent(msg.id), { status: 'pending' });
      console.log('[Recovery]  -', msg.id.slice(0,8), '"' + (msg.content||'').slice(0,40) + '"');
    }
  } catch (e) {
    console.error('[Recovery] 실패:', e.message);
  }
}
// ── Cleanup stale Bridge extract commands ────────────────────────────────────
// Old relay-extract-* commands left from previous sessions (crash/timeout)
// cause Bridge to re-open Office apps on next run. Clear them at startup.
async function cleanupStaleExtractCommands() {
  try {
    await supaReq('DELETE', 'commands?id=like.relay-extract-%25&status=eq.pending', null, null);
    console.log('[Startup] 잔여 Bridge 추출 명령 정리 완료');
  } catch(e) { /* non-critical */ }
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
        result: 'pong from relay v22/' + HOSTNAME + ' at ' + now,
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
    const cmd = CLAUDE_EXE + ' --print --dangerously-skip-permissions < "' + tmpFile + '"';
    console.log('[Claude] 실행:', cmd.slice(0, 80));
    const proc = spawn(cmd, [], {
      timeout: CONFIG.claudeTimeout,
      shell:   true,
      env:     process.env,
      cwd:     'C:\\CoworkRelay',
    });
    let out = '', err = '';
    proc.stdout.on('data', d => { out += d.toString(); });
    proc.stderr.on('data', d => { err += d.toString(); });
    proc.on('close', code => {
      try { fs.unlinkSync(tmpFile); } catch(e) {}
      if ((code === 0 || (code === null && out.trim())) && out.trim()) {
        resolve(out.trim());
      } else if ((code === 0 || code === null) && !out.trim()) {
        reject(new Error('claude 응답 없음. stderr: ' + err.slice(0, 200)));
      } else {
        reject(new Error('claude 종료코드 ' + code + ': ' + (err || out).slice(0, 300)));
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
      '&status=eq.completed&order=created_at.asc&limit=6&select=id,role,content,files');
    if (!rows || rows.length === 0) return currentContent;
    const hist = rows
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => {
        let line = (m.role === 'user' ? 'Human' : 'Assistant') + ': ' + (m.content||'').slice(0, 300);
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

// ── LEGACY: Extract attached files from content ────────────────────────────────
async function extractAttachedFiles(content) {
  const files = [];
  let processedContent = content;
  const pattern = /\[ATTACHED_FILE:(.+?)\]\n([\s\S]*?)\n\[\/ATTACHED_FILE\]/g;
  let match;
  while ((match = pattern.exec(content)) !== null) {
    const fileName = match[1];
    const base64Data = match[2];
    try {
      const buffer = Buffer.from(base64Data, 'base64');
      const tmpPath = path.join(os.tmpdir(), 'relay-attach-' + Date.now() + '-' + fileName);
      fs.writeFileSync(tmpPath, buffer);
      console.log('[ExtractFiles] 추출:', fileName, 'size=' + buffer.length);
      files.push({ name: fileName, path: tmpPath });
      processedContent = processedContent.replace(match[0], '');
    } catch (e) {
      console.error('[ExtractFiles] 오류:', fileName, e.message);
    }
  }
  return { files, content: processedContent.trim() };
}

// ═══════════════════════════════════════════════════════════════════════════════
// NEW v17: File content extraction (markitdown → python-pptx → Bridge COM)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Method 1: Extract via markitdown CLI
 */
function extractViaMarkitdown(filePath) {
  const out = execSync(`markitdown "${filePath}"`, {
    encoding: 'utf8',
    timeout: 30000,
    shell: true
  });
  return out.trim();
}

/**
 * Method 2: Extract PPTX text via Python + python-pptx
 */
function extractViaPythonPptx(filePath) {
  // Try python, then py
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
      encoding: 'utf8',
      timeout: 30000,
      shell: true
    });
    return out.trim();
  } finally {
    try { fs.unlinkSync(scriptPath); } catch(e) {}
  }
}

/**
 * Method 3: Extract via Bridge (company PC) using PowerShell + Office COM
 * Handles DRM-protected files since the company PC has the DRM agent
 */
async function extractViaBridgeCOM(messageId, fileName) {
  const ext = path.extname(fileName).toLowerCase();
  const safeName = fileName.replace(/'/g, "''"); // PS single-quote escape\n
  // Build PowerShell script wrapped in Start-Job for timeout safety.
  // CRITICAL: Use Write-Output (not Write-Host) — Bridge captures via
  //   Invoke-Expression $content 2>&1 | Out-String
  // Write-Host sends to Information stream (6) which is NOT captured.
  // Write-Output sends to Success stream (1) which IS captured.
  const lines = [
    `$supaUrl = '${SUPA_URL}'`,
    `$supaKey = '${SUPA_KEY}'`,
    `$msgId = '${messageId}'`,
    `$fileName = '${safeName}'`,
    `$ext = '${ext}'`,
    '',
    '# Run extraction in a background job with 90-second timeout',
    '# This prevents PowerPoint/Word COM from hanging indefinitely',
    '$job = Start-Job -ScriptBlock {',
    '  param($supaUrl, $supaKey, $msgId, $fileName, $ext)',
    '',
    '  # Download file_chunks from Supabase',
    '  $uri = $supaUrl + "/rest/v1/file_chunks" +',
    '    "?message_id=eq." + [uri]::EscapeDataString($msgId) +',
    '    "&file_name=eq." + [uri]::EscapeDataString($fileName) +',
    '    "&order=chunk_index.asc&select=chunk_index,data"',
    '  $hdr = @{ apikey = $supaKey; Authorization = "Bearer $supaKey" }',
    '  try {',
    '    $chunks = Invoke-RestMethod -Uri $uri -Headers $hdr -Method Get',
    '  } catch {',
    '    Write-Output ("FAIL:chunk download error: " + $_.Exception.Message)',
    '    return',
    '  }',
    '',
    '  if (-not $chunks -or $chunks.Count -eq 0) {',
    '    Write-Output ("FAIL:no chunks found (msgId=$msgId file=$fileName)")',
    '    return',
    '  }',
    '',
    '  # Reassemble base64 -> bytes -> temp file',
    '  $b64 = ($chunks | Sort-Object chunk_index | ForEach-Object { $_.data }) -join ""',
    '  $bytes = [Convert]::FromBase64String($b64)',
    '  $tmpF = [IO.Path]::Combine($env:TEMP, "bridge-" + [DateTime]::Now.Ticks + $ext)',
    '  [IO.File]::WriteAllBytes($tmpF, $bytes)',
    '',
    '  try {',
    '    if ($ext -eq ".pptx" -or $ext -eq ".ppt") {',
    '      $app = New-Object -ComObject PowerPoint.Application',
    '      $app.Visible = [Microsoft.Office.Core.MsoTriState]::msoTrue',
    '      $pres = $app.Presentations.Open($tmpF, $true, $false, $false)',
    '      $txt = ""',
    '      foreach ($sl in $pres.Slides) {',
    '        $txt += "=== Slide " + $sl.SlideIndex + " ===`n"',
    '        foreach ($sh in $sl.Shapes) {',
    '          if ($sh.HasTextFrame -eq [Microsoft.Office.Core.MsoTriState]::msoTrue) {',
    '            $t = $sh.TextFrame.TextRange.Text.Trim()',
    '            if ($t.Length -gt 0) { $txt += $t + "`n" }',
    '          }',
    '        }',
    '        $txt += "`n"',
    '      }',
    '      $pres.Close()',
    '      $app.Quit()',
    '      [System.Runtime.Interopservices.Marshal]::ReleaseComObject($app) | Out-Null',
    '    } elseif ($ext -eq ".docx" -or $ext -eq ".doc") {',
    '      $app = New-Object -ComObject Word.Application',
    '      $app.Visible = $true',
    '      $doc = $app.Documents.Open($tmpF, $false, $true)',
    '      $txt = $doc.Content.Text',
    '      $doc.Close($false)',
    '      $app.Quit()',
    '      [System.Runtime.Interopservices.Marshal]::ReleaseComObject($app) | Out-Null',
    '    } else {',
    '      Write-Output ("FAIL:unsupported extension: $ext")',
    '      return',
    '    }',
    '    $len = [Math]::Min($txt.Length, 50000)',
    '    Write-Output ("OK:" + $txt.Substring(0, $len))',
    '  } catch {',
    '    Write-Output ("FAIL:COM error: " + $_.Exception.Message)',
    '  } finally {',
    '    Remove-Item $tmpF -ErrorAction SilentlyContinue',
    '  }',
    '} -ArgumentList $supaUrl, $supaKey, $msgId, $fileName, $ext',
    '',
    '# Wait up to 90 seconds, then kill if still running',
    '$done = $job | Wait-Job -Timeout 90',
    'if (-not $done) {',
    '  Stop-Job $job',
    '  Remove-Job $job',
    '  Write-Output "FAIL:PowerPoint COM timed out (90s) - DRM dialog or slow open"',
    '} else {',
    '  $out = Receive-Job $job 2>&1 | Out-String',
    '  Remove-Job $job',
    '  Write-Output $out.Trim()',
    '}',
  ];
  const psScript = lines.join('\n');

  const cmdId = 'relay-extract-' + Date.now() + '-' + Math.random().toString(36).slice(2, 5);
  await dbInsert('commands', {
    id: cmdId,
    action: 'run_ps',
    target: '',
    content: psScript,
    status: 'pending',
  });
  console.log('[Bridge] COM 추출 요청:', fileName, '→ cmd:', cmdId);

  // Poll for result
  const deadline = Date.now() + CONFIG.bridgeExtractTimeout;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 2000));
    const rows = await dbSelect('commands', `id=eq.${encodeURIComponent(cmdId)}&select=status,result`);
    if (rows && rows.length) {
      const row = rows[0];
      if (row.status === 'completed' || row.status === 'error') {
        try { await supaReq('DELETE', `commands?id=eq.${encodeURIComponent(cmdId)}`, null, null); } catch(e) {}
        const result = (row.result || '').trim();
        if (result.startsWith('OK:')) {
          console.log('[Bridge] COM 추출 성공:', fileName, result.slice(3, 80) + '...');
          return result.slice(3);
        }
        const errMsg = result.startsWith('FAIL:') ? result.slice(5) : result;
        throw new Error('Bridge COM 실패: ' + errMsg.slice(0, 200));
      }
    }
  }
  // Timeout — cleanup
  try { await supaReq('DELETE', `commands?id=eq.${encodeURIComponent(cmdId)}`, null, null); } catch(e) {}
  throw new Error(`Bridge 추출 시간 초과 (${CONFIG.bridgeExtractTimeout/1000}초). 회사 PC Bridge가 온라인인지 확인하세요.`);
}

/**
 * Main file content extraction function — tries 3 methods in order
 * Returns extracted text, or an error message string (never throws)
 */
async function extractFileContent(messageId, fileName, filePath) {
  const ext = path.extname(fileName).toLowerCase();
  const isOffice = ['.pptx', '.ppt', '.docx', '.doc', '.xlsx', '.xls'].includes(ext);
  const isPptx   = ['.pptx', '.ppt'].includes(ext);
  const isDocx   = ['.docx', '.doc'].includes(ext);

  if (!CONFIG.drmMode || !isPptx) { // DRM 모드이면서 PPTX이면 Bridge COM 직행
  // ── Method 1: markitdown ──────────────────────────────────────────────────
  let e1msg = '';
  try {
    console.log('[Extract] Method 1: markitdown -', fileName);
    const text = extractViaMarkitdown(filePath);
    if (text && text.length > 10) {
      console.log('[Extract] markitdown 성공:', fileName);
      return text;
    }
  } catch(e) {
    e1msg = e.message.slice(0, 100);
    console.warn('[Extract] markitdown 실패:', e1msg);
  }

  // ── Method 2: python-pptx (PPTX only) ────────────────────────────────────
  if (isPptx) {
    let e2msg = '';
    try {
      console.log('[Extract] Method 2: python-pptx -', fileName);
      const text = extractViaPythonPptx(filePath);
      if (text && text.length > 10) {
        console.log('[Extract] python-pptx 성공:', fileName);
        return text;
      }
    } catch(e) {
      e2msg = e.message.slice(0, 100);
      console.warn('[Extract] python-pptx 실패:', e2msg);
    }

  } // end drmMode guard
    // ── Method 3: Bridge COM (회사 PC, DRM 해제 가능) ─────────────────────
    const bridgeOnline = await checkBridgeOnline();
    if (bridgeOnline) {
      try {
        console.log('[Extract] Method 3: Bridge COM -', fileName);
        const text = await extractViaBridgeCOM(messageId, fileName);
        if (text && text.length > 0) return text;
      } catch(e) {
        const e3msg = e.message;
        console.error('[Extract] Bridge COM 실패:', e3msg);
        return `[파일 내용 추출 실패: ${fileName}]\n` +
          `세 가지 방법 모두 실패했습니다:\n` +
          `• markitdown: ${e1msg}\n` +
          `• python-pptx: ${e2msg}\n` +
          `• Bridge COM: ${e3msg}\n\n` +
          `💡 해결 방법:\n` +
          `  1. 홈 PC에서: pip install markitdown[all]\n` +
          `  2. 홈 PC에서: pip install python-pptx\n` +
          `  3. 회사 PC가 켜져 있고 Bridge가 실행 중인지 확인`;
      }
    } else {
      return `[PPTX 처리 실패: ${fileName}]\n` +
        `markitdown과 python-pptx 모두 실패했습니다.\n` +
        `DRM 보호 파일의 경우 회사 PC Bridge를 통한 추출이 필요하지만 Bridge가 오프라인입니다.\n\n` +
        `💡 해결 방법:\n` +
        `  1. 홈 PC에서: pip install markitdown[all] 또는 pip install python-pptx\n` +
        `  2. 회사 PC를 켜고 Bridge(start-relay.bat) 실행 후 재시도`;
    }
  }

  // ── For DOCX files: try Bridge COM ───────────────────────────────────────
  if (isDocx) {
    const bridgeOnline = await checkBridgeOnline();
    if (bridgeOnline) {
      try {
        console.log('[Extract] DOCX Bridge COM -', fileName);
        const text = await extractViaBridgeCOM(messageId, fileName);
        if (text && text.length > 0) return text;
      } catch(e) {
        console.error('[Extract] DOCX Bridge COM 실패:', e.message);
      }
    }
  }

  // ── Final fallback: clear error message ───────────────────────────────────
  return `[파일 내용 추출 불가: ${fileName}]\n` +
    `지원 방법: markitdown(${e1msg || '명령 없음'})\n` +
    `�💡 홈 PC에서 pip install markitdown[all] 실행 후 재시도하세요.`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Process message (file extraction with full fallback chain)
// ═══════════════════════════════════════════════════════════════════════════════
async function processMessage(msg) {
  const id = msg.id, chat_id = msg.chat_id;
  let content = msg.content || '';
  let attachedFiles = [];

  console.log('[Worker] 처리 중:', id.slice(0,8), '"' + content.slice(0,50) + '"');
  try { await dbUpdate('messages', 'id=eq.' + encodeURIComponent(id), { status: 'processing' }); } catch(e) {}
  await sendHeartbeat();

  try {
    // ── Download files from file_chunks table ─────────────────────────────
    if (msg.files && Array.isArray(msg.files) && msg.files.length > 0) {
      console.log('[Worker] 파일 개수:', msg.files.length);
      for (const file of msg.files) {
        try {
          console.log('[Worker] file_chunks에서 다운로드:', file.name, '(' + (file.chunks || '?') + '개 청크)');
          const buffer = await chunksDownload(id, file.name);
          const tmpExt  = path.extname(file.name);
          const tmpPath = path.join(os.tmpdir(), 'relay-chunk-' + Date.now() + tmpExt);
          fs.writeFileSync(tmpPath, buffer);
          attachedFiles.push({ name: file.name, path: tmpPath });
          console.log('[Worker] 저장 완료:', tmpPath, 'size=' + buffer.length);
        } catch (e) {
          console.error('[Worker] 파일 다운로드 실패:', file.name, e.message);
        }
      }
    }

    // ── LEGACY: Extract [ATTACHED_FILE:...] markers ───────────────────────
    if (content.includes('[ATTACHED_FILE:')) {
      const extracted = await extractAttachedFiles(content);
      attachedFiles = attachedFiles.concat(extracted.files);
      content = extracted.content;
    }

    // ── Extract text from each file (with full fallback chain) ────────────
    let fileContentText = '';
    for (const file of attachedFiles) {
      console.log('[Worker] 파일 내용 추출 시작:', file.name);
      const extractedText = await extractFileContent(id, file.name, file.path);
      fileContentText += `\n\n=== 첨부파일: ${file.name} ===\n${extractedText}\n=== 끝 ===`;
    }

    // ── Build final prompt ────────────────────────────────────────────────
    const finalContent = content + fileContentText;
    const prompt = await buildPrompt(chat_id, finalContent);
    console.log('[Worker] 프롬프트 길이:', prompt.length, '자');

    // ── Run Claude (파일 생성 감지) ──────────────────────────────────────
    const workDir = 'C:\\CoworkRelay';
    const snapBefore = {};
    try {
      for (const f of fs.readdirSync(workDir)) {
        try { snapBefore[f] = fs.statSync(path.join(workDir, f)).mtimeMs; } catch(e) {}
      }
    } catch(e) {}

    // ── 파일 저장 위치 강제 지시 ──────────────────────────────
    const FILE_SAVE_RULE = '[중요 규칙] 생성하는 모든 파일(pptx, docx, xlsx, pdf, 이미지 등)은 반드시 C:\\CoworkRelay\\ 경로에 저장할 것. 바탕화면(Desktop), Downloads, Documents 등 다른 경로에 저장 절대 금지. Python으로 파일 생성 시에도 출력 경로를 r\'C:\\\\CoworkRelay\\\\파일명\'으로 명시할 것.';
    const finalPrompt = FILE_SAVE_RULE + '\n\n' + prompt;
    const response = await runClaude(finalPrompt);
    console.log('[Worker] 응답 수신:', response.slice(0,60));

    // ── 새 파일 / 변경된 파일 업로드 ────────────────────────────────────
    const rid = (typeof crypto.randomUUID === 'function')
      ? crypto.randomUUID()
      : 'resp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);

    const attachments = [];
    try {
      for (const f of fs.readdirSync(workDir)) {
        let stat;
        try { stat = fs.statSync(path.join(workDir, f)); } catch(e) { continue; }
        if (!stat.isFile()) continue;
        const before = snapBefore[f];
        if (before !== undefined && stat.mtimeMs <= before) continue;
        const ext = f.split('.').pop().toLowerCase();
        const skipExts = ['js','ps1','bat','json','log','tmp'];
        if (skipExts.includes(ext) && snapBefore[f] !== undefined) continue;
        const buf = fs.readFileSync(path.join(workDir, f));
        await chunksUpload(rid, f, buf);
        attachments.push({ type: 'file', name: f });
        console.log('[Worker] 파일 업로드:', f, buf.length + 'bytes');
      }
    } catch(e) {
      console.error('[Worker] 파일 스캔 오류:', e.message);
    }

    // ── Insert assistant response ─────────────────────────────────────────
    await dbInsert('messages', {
      id: rid, chat_id, role: 'assistant',
      content: response, status: 'completed',
      attachments: attachments.length > 0 ? attachments : null,
      files: null,
      created_at: new Date().toISOString(),
    });

    try { await dbUpdate('messages', 'id=eq.' + encodeURIComponent(id), { status: 'completed' }); } catch(e) {}
    console.log('[Worker] 완료 →', rid.slice(0,8));

    // Cleanup temp files
    for (const file of attachedFiles) {
      try { fs.unlinkSync(file.path); } catch(e) {}
    }

    // Cleanup file_chunks after successful processing
    if (msg.files && msg.files.length > 0) {
      try {
        await supaReq('DELETE', 'file_chunks?message_id=eq.' + encodeURIComponent(id), null, null);
        console.log('[Worker] file_chunks 정리 완료');
      } catch (e) {
        console.warn('[Worker] file_chunks 정리 실패:', e.message);
      }
    }

  } catch (err) {
    console.error('[Worker] 오류:', err.message);
    const errMsg = '⚠️ 오류: ' + err.message;
    try {
      await dbInsert('messages', {
        id: 'err-' + Date.now(), chat_id, role: 'assistant',
        content: errMsg, status: 'completed',
        files: null,
        created_at: new Date().toISOString(),
      });
      await dbUpdate('messages', 'id=eq.' + encodeURIComponent(id), { status: 'completed' });
    } catch(e2) { console.error('[Worker] 오류 기록 실패:', e2.message); }

    // Cleanup temp files on error
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
    console.error('[Poll] 오류:', e.message);
    isProcessing = false;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('╔════════════════════════════════════════════════╗');
  console.log('║  Remote Bridge Relay Worker v22                ║');
  console.log('║  - markitdown → python-pptx → Bridge COM       ║');
  console.log('║  - DRM 파일: Bridge(회사 PC) PowerShell COM     ║');
  console.log('║  - file_chunks REST API (no Storage)           ║');
  console.log('╠════════════════════════════════════════════════╣');
  console.log('║  Hostname:', HOSTNAME.padEnd(33), '║');
  console.log('╚════════════════════════════════════════════════╝\n');

  // Check Claude CLI
  try {
    const ver = execSync(CLAUDE_EXE + ' --version', { stdio: 'pipe', shell: true }).toString().trim();
    console.log('[OK] Claude CLI:', ver);
  } catch (e) {
    console.warn('[WARN] claude --version 실패:', e.message.slice(0, 80));
  }

  // Check markitdown
  try {
    execSync('markitdown --version', { stdio: 'pipe', shell: true, timeout: 5000 });
    console.log('[OK] markitdown: 설치됨');
  } catch(e) {
    console.warn('[WARN] markitdown: 미설치 → pip install markitdown[all]');
  }

  // Check python-pptx
  try {
    execSync('python -c "from pptx import Presentation"', { stdio: 'pipe', shell: true, timeout: 5000 });
    console.log('[OK] python-pptx: 설치됨');
  } catch(e) {
    console.warn('[WARN] python-pptx: 미설치 → pip install python-pptx');
  }

  // Check Supabase
  try {
    await dbSelect('messages', 'limit=1&select=id');
    console.log('[OK] Supabase 연결 성공');
  } catch (e) {
    console.error('[FATAL] Supabase 연결 실패:', e.message);
    process.exit(1);
  }

  // Check file_chunks table
  try {
    await dbSelect('file_chunks', 'limit=1&select=id');
    console.log('[OK] file_chunks 테이블 접근 성공');
  } catch (e) {
    console.warn('[WARN] file_chunks 테이블 접근 실패:', e.message.slice(0, 80));
  }

  // Check Bridge status
  const bridgeOnline = await checkBridgeOnline();
  console.log(bridgeOnline ? '[OK] Bridge (회사 PC): 온라인 (DRM 파일 추출 가능)' : '[WARN] Bridge (회사 PC): 오프라인 (DRM 파일은 처리 불가)');

  // Recover stuck messages
  await recoverStuckMessages();
  await cleanupStaleExtractCommands();

  // Start heartbeat and polling
  await sendHeartbeat();
  console.log('[OK] 하트비트 전송 완료');
  console.log('[OK] 폴링 시작 (' + CONFIG.pollInterval + 'ms)...\n');

  setInterval(sendHeartbeat, CONFIG.heartbeatInterval);
  setInterval(handlePings,   CONFIG.pollInterval);
  setInterval(poll,          CONFIG.pollInterval);
  poll();
  handlePings();
}

main().catch(e => { console.error('[FATAL]', e.message); process.exit(1); });

