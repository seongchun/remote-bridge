/**
 * Remote Bridge Relay Worker v16
 * ======================================
 * UPDATES from v15:
 * - REPLACED: Supabase Storage download with file_chunks REST API approach
 * - NEW: chunksDownload() — fetches file chunks from file_chunks table, reassembles base64
 * - UPDATED: processMessage() to use chunksDownload() instead of storageDownload()
 * - REMOVED: storageDownload() / storageUpload() (Storage API blocked by corporate proxy)
 * - KEPT: All existing functions (sendHeartbeat, recoverStuck, handlePings, runClaude, etc.)
 */
const https    = require('https');
const { spawn } = require('child_process');
const { execSync } = require('child_process');
const crypto   = require('crypto');
const os       = require('os');
const fs       = require('fs');
const path     = require('path');

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

// --- HTTPS helper ---
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
// ===== NEW: Download file from file_chunks table =====
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

// --- Heartbeat ---
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

// --- Recover stuck messages ---
async function recoverStuckMessages() {
  try {
    const stuck = await dbSelect('messages', 'role=eq.user&status=eq.processing&select=id,content');
    if (!stuck || stuck.length === 0) return;
    console.log('[Recovery] processing 상태 메시지', stuck.length, '개 → pending 복구');
    for (const msg of stuck) {
      await dbUpdate('messages', 'id=eq.' + encodeURIComponent(msg.id), { status: 'pending' });
      console.log('[Recovery]  -', msg.id.slice(0,8), '"' + (msg.content||'').slice(0,40) + '"');
    }
  } catch (e) {
    console.error('[Recovery] 실패:', e.message);
  }
}

// --- Ping Handler ---
async function handlePings() {
  try {
    const rows = await dbSelect('commands', 'action=eq.ping&status=eq.pending&order=created_at.asc&limit=10');
    if (!rows || rows.length === 0) return;
    const now = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
    for (const row of rows) {
      await dbUpdate('commands', 'id=eq.' + row.id, {
        status: 'completed',
        result: 'pong from relay v16/' + HOSTNAME + ' at ' + now,
      });
    }
  } catch (e) { /* silent */ }
}
// --- Run Claude ---
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
    console.log('[Claude] 실행:', cmd.slice(0, 80));

    const proc = spawn(cmd, [], {
      timeout: CONFIG.claudeTimeout,
      shell:   true,
      env:     process.env,
    });

    let out = '', err = '';
    proc.stdout.on('data', d => { out += d.toString(); });
    proc.stderr.on('data', d => { err += d.toString(); });

    proc.on('close', code => {
      try { fs.unlinkSync(tmpFile); } catch(e) {}
      if (code === 0 && out.trim()) {
        resolve(out.trim());
      } else if (code === 0 && !out.trim()) {
        reject(new Error('claude 응답 없음. stderr: ' + err.slice(0, 200)));
      } else {
        reject(new Error('claude 종료코드 ' + code + ': ' + (err || out).slice(0, 300)));
      }
    });

    proc.on('error', e => {
      try { fs.unlinkSync(tmpFile); } catch(e2) {}
      reject(new Error(
        'Claude 실행 실패: ' + e.message +
        '\n힌트: CMD에서 "where claude" 로 경로 확인 후' +
        '\n      set CLAUDE_PATH=<경로\\claude.cmd>'
      ));
    });
  });
}

// ===== Build prompt =====
async function buildPrompt(chatId, currentContent) {
  try {
    const rows = await dbSelect('messages',
      'chat_id=eq.' + encodeURIComponent(chatId) +
      '&status=eq.completed&order=created_at.asc&limit=10&select=id,role,content,files');
    if (!rows || rows.length === 0) return currentContent;
    const hist = rows
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => {
        let line = (m.role === 'user' ? 'Human' : 'Assistant') + ': ' + (m.content||'').slice(0, 500);
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
// ===== LEGACY: Extract attached files from content =====
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

// ===== Process message (uses file_chunks table) =====
async function processMessage(msg) {
  const id = msg.id, chat_id = msg.chat_id;
  let content = msg.content || '';
  let attachedFiles = [];

  console.log('[Worker] 처리 중:', id.slice(0,8), '"' + content.slice(0,50) + '"');
  try { await dbUpdate('messages', 'id=eq.' + encodeURIComponent(id), { status: 'processing' }); } catch(e) {}
  await sendHeartbeat();

  try {
    // ===== Download files from file_chunks table =====
    if (msg.files && Array.isArray(msg.files) && msg.files.length > 0) {
      console.log('[Worker] 파일 개수:', msg.files.length);
      for (const file of msg.files) {
        try {
          console.log('[Worker] file_chunks에서 다운로드:', file.name, '(' + (file.chunks || '?') + '개 청크)');
          const buffer = await chunksDownload(id, file.name);
          const tmpPath = path.join(os.tmpdir(), 'relay-chunk-' + Date.now() + '-' + file.name);
          fs.writeFileSync(tmpPath, buffer);

          attachedFiles.push({ name: file.name, path: tmpPath });
          console.log('[Worker] 저장 완료:', tmpPath, 'size=' + buffer.length);
        } catch (e) {
          console.error('[Worker] 파일 다운로드 실패:', file.name, e.message);
        }
      }
    }

    // ===== LEGACY: Extract [ATTACHED_FILE:...] markers =====
    if (content.includes('[ATTACHED_FILE:')) {
      const extracted = await extractAttachedFiles(content);
      attachedFiles = attachedFiles.concat(extracted.files);
      content = extracted.content;
    }

    // ===== Run markitdown on attached files =====
    let fileContentText = '';
    for (const file of attachedFiles) {
      try {
        console.log('[Worker] markitdown 실행:', file.name);
        const markdownOutput = execSync(`markitdown "${file.path}"`, { encoding: 'utf8' }).toString();
        fileContentText += `\n=== ${file.name} ===\n${markdownOutput}\n`;
      } catch (e) {
        console.warn('[Worker] markitdown 실패:', file.name, '→ 파일경로만 사용');
        fileContentText += `\n[첨부파일: ${file.name} at ${file.path}]\n`;
      }
    }

    // ===== Build final prompt =====
    let finalContent = content + fileContentText;
    const prompt = await buildPrompt(chat_id, finalContent);
    console.log('[Worker] 프롬프트 길이:', prompt.length, '자');

    // ===== Run Claude =====
    const response = await runClaude(prompt);
    console.log('[Worker] 응답 수신:', response.slice(0,60));

    // ===== Insert assistant response =====
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
        content: errMsg, status: 'error',
        files: null,
        created_at: new Date().toISOString(),
      });
      await dbUpdate('messages', 'id=eq.' + encodeURIComponent(id), { status: 'completed' });
    } catch(e2) { console.error('[Worker] 오류 기록 실패:', e2.message); }

    for (const file of attachedFiles) {
      try { fs.unlinkSync(file.path); } catch(e) {}
    }
  }
  await sendHeartbeat();
}
// ===== Poll =====
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

// --- Main ---
async function main() {
  console.log('╔════════════════════════════════════════════╗');
  console.log('║  Remote Bridge Relay Worker v16            ║');
  console.log('║  - file_chunks REST API (no Storage)      ║');
  console.log('║  - Corporate proxy compatible             ║');
  console.log('║  - Legacy [ATTACHED_FILE:...] support      ║');
  console.log('╠════════════════════════════════════════════╣');
  console.log('║  Hostname:', HOSTNAME.padEnd(31), '║');
  console.log('╚════════════════════════════════════════════╝\n');

  try {
    const ver = execSync(CLAUDE_EXE + ' --version', { stdio: 'pipe', shell: true }).toString().trim();
    console.log('[OK] Claude CLI:', ver);
  } catch (e) {
    console.warn('[WARN] claude --version 실패:', e.message.slice(0, 80));
    console.warn('[HINT] CMD에서: where claude');
    console.warn('[HINT] 찾은 경로를 set CLAUDE_PATH=<경로> 로 설정 후 재시작');
  }

  try {
    await dbSelect('messages', 'limit=1&select=id');
    console.log('[OK] Supabase 연결 성공');
  } catch (e) {
    console.error('[FATAL] Supabase 연결 실패:', e.message);
    process.exit(1);
  }

  try {
    await dbSelect('file_chunks', 'limit=1&select=id');
    console.log('[OK] file_chunks 테이블 접근 성공');
  } catch (e) {
    console.warn('[WARN] file_chunks 테이블 접근 실패:', e.message.slice(0, 80));
    console.warn('[HINT] Supabase에서 file_chunks 테이블 생성 필요');
  }

  await recoverStuckMessages();

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
