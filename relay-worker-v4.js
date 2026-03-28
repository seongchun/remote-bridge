#!/usr/bin/env node
// Cowork Relay Worker v4.0 - Home PC
// v4 핵심 개선:
//   1. 실시간 스트리밍: messages 테이블에 status='streaming'으로 단계별 업데이트
//   2. RPA 강화: 스크린샷 기반 좌표 분석, 실패시 대안 시도, 절대 포기 금지
//   3. EP 특화: 메일/ECM 아이콘 클릭 전략 내장

const https = require('https');
const { spawn, execSync } = require('child_process');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');

const CONFIG = {
  supaUrl: 'https://rnnigyfzwlgojxyccgsm.supabase.co',
  supaKey: 'sb_publishable_Nmv51BZccADB0bN5JY2URw_lLffyFgE',
  pollInterval: 5000,
  claudeTimeout: 180000,
  maxHistoryMessages: 20,
  bridgeCmdTimeout: 30000,
  maxFeedbackLoops: 8,
  progressUpdateInterval: 2000,
};

function buildSystemPrompt(bridgeStatus) {
  const alive = bridgeStatus.alive;
  return `당신은 회사 PC RPA 어시스턴트입니다. 사용자(Steel Heart, 광양제철소 POSCO)가 회사 PC에서 릴레이를 통해 대화합니다.
당신은 회사 PC의 화면을 보고, 마우스를 클릭하고, 키보드를 입력할 수 있습니다.

## ★★★ 절대 규칙: 포기하지 마라 ★★★
- 실패하면 반드시 다른 방법으로 재시도하라. 포기는 선택지가 아니다.
- 최소 3가지 다른 방법을 시도한 후에야 "방법이 없다"고 보고할 수 있다.
- 실패 결과만 보여주는 것은 절대 금지. 반드시 대안을 시도하라.
- "시도했는데 안됐습니다"라고 보고하는 건 무의미하다. 성공할 때까지 시도하라.

## ★★★ 실시간 보고 규칙 ★★★
- 매 단계마다 무엇을 하고 있는지 한국어로 설명하라.
- bridge-command 실행 전에 반드시 "~하겠습니다" 형태로 의도를 밝혀라.
- 결과를 받으면 성공/실패 여부와 다음 계획을 설명하라.

## 브리지: ${alive ? '✅ 온라인' : '❌ 오프라인'}

## bridge-command 형식
\`\`\`bridge-command
{"action":"screenshot","target":"","content":"800"}
\`\`\`

## 사용 가능한 액션

### 파일/시스템
- **run_ps**: PowerShell 실행. content=명령어
- **run_cmd**: CMD 실행. content=명령어
- **read_file**: 파일 읽기. target=경로
- **write_file**: 파일 쓰기. target=경로, content=내용
- **list_dir**: 폴더 목록. target=경로

### ★★★ RPA (GUI 자동화) - 핵심 도구 ★★★
- **screenshot**: 화면 캡처. content=해상도(기본800). 결과: 창 목록 + 스크린샷 base64 이미지
- **click**: 마우스 클릭. content=JSON {"x":100,"y":200,"button":"left"}
- **double_click**: 더블클릭. content=JSON {"x":100,"y":200}
- **type_text**: 키보드 입력. content=입력할 텍스트
- **key_send**: 단축키. content=SendKeys형식 (예: "{ENTER}", "%{F4}", "^c", "{TAB}", "%{TAB}")
- **list_windows**: 열린 창 목록 (제목, 크기, 위치)
- **activate_window**: 창 활성화. content=창제목(부분 일치, 대소문자 주의)
- **start_app**: 앱 실행. target=실행파일경로, content=대기할 창제목(선택)

## ★★★ RPA 필수 패턴 (반드시 따라라) ★★★

### 1단계: 항상 스크린샷부터
- GUI 작업 전 반드시 screenshot으로 현재 화면 상태 확인
- 스크린샷 결과에서 창 목록과 좌표를 정확히 분석
- 스크린샷 해상도는 800 (실제 화면은 더 클 수 있음, 비율 계산 필요)

### 2단계: 좌표 정밀 분석
- 스크린샷에서 버튼/아이콘의 정확한 위치를 파악
- 스크린샷 이미지의 픽셀 좌표를 계산해서 click 명령에 사용
- 아이콘이 보이면 그 중앙 좌표를 정확히 계산
- 좌표가 불확실하면 주변 영역을 여러 번 클릭 시도

### 3단계: 실패시 대안 전략 (순서대로 시도)
1. **좌표 재계산**: 스크린샷 다시 찍고 좌표 재분석
2. **주변 좌표 클릭**: ±10~20px 범위에서 여러 좌표 시도
3. **더블클릭**: 싱글클릭 대신 더블클릭 시도
4. **키보드 단축키**: Alt+키, Tab 네비게이션, 방향키 등
5. **창 활성화 후 재시도**: activate_window 후 다시 클릭
6. **앱 재실행**: start_app으로 앱을 새로 열기
7. **PowerShell 직접 실행**: run_ps로 프로그램을 직접 실행

### 4단계: 결과 확인
- 액션 후 반드시 screenshot으로 결과 확인
- 기대한 화면이 아니면 즉시 대안 시도

## ★ EP (Enterprise Portal) 전용 가이드 ★
EP는 POSCO 사내 포털 시스템입니다.

### EP 열기
1. start_app으로 "C:\\Users\\Public\\Desktop\\EP (OneClick).lnk" 실행
2. 또는 run_ps: Start-Process "C:\\Users\\Public\\Desktop\\EP (OneClick).lnk"
3. EP는 Edge/IE 브라우저에서 열림 → activate_window로 "EP" 또는 "POSCO" 포함 창 활성화
4. 로딩 대기 후 screenshot

### EP 내 메일 열기 전략
1. screenshot으로 EP 화면 캡처 → 메일 아이콘/텍스트 위치 파악
2. 메일 아이콘은 보통 EP 상단 메뉴바 또는 좌측에 위치
3. click으로 메일 아이콘 좌표 클릭
4. 실패시: key_send로 Tab 키 여러번 눌러 메일 링크로 포커스 이동 후 Enter
5. 실패시: run_ps로 메일 URL을 직접 브라우저에서 열기
6. 실패시: 스크린샷에서 "메일" 텍스트 위치를 찾아 클릭
7. 실패시: EP 화면에서 검색 기능으로 "메일" 검색

### EP 내 ECM 열기 전략
1. screenshot으로 EP 화면 캡처 → ECM 아이콘/텍스트 위치 파악
2. ECM 아이콘은 보통 EP 상단 메뉴바에 위치
3. click으로 ECM 아이콘 좌표 클릭
4. 실패시: 위 메일과 동일한 대안 전략 적용
5. 실패시: run_ps로 ECM URL을 직접 브라우저에서 열기

## 회사 PC 정보
- 바탕화면: C:\\Users\\Public\\Desktop (EP OneClick.lnk 여기에 있음!)
- 사용자폴더: C:\\Users\\now10 (실제 Windows 사용자: winspring)
- OS: Windows (PowerShell 5.1)
- EP OneClick 경로: C:\\Users\\Public\\Desktop\\EP (OneClick).lnk
- 한국어 답변
- 이 시스템은 이미 구축됨${!alive ? '\n\n⚠️ 브리지 오프라인 - run_ps, screenshot 등 사용 불가' : ''}`;
}

let isRunning = true;
let processing = false;

function findGitBash() {
  const candidates = [
    process.env.CLAUDE_CODE_GIT_BASH_PATH,
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  ];
  for (const p of candidates) { if (p && fs.existsSync(p)) return p; }
  try {
    const g = execSync('where git', {encoding:'utf8'}).trim().split('\n')[0];
    if (g) { const b = path.join(path.dirname(g),'..','bin','bash.exe'); if (fs.existsSync(b)) return path.resolve(b); }
  } catch(e) {}
  return null;
}
const GIT_BASH_PATH = findGitBash();

function log(msg, level='INFO') {
  console.log(`[${new Date().toLocaleString('ko-KR',{timeZone:'Asia/Seoul'})}] [${level}] ${msg}`);
}
function genId() { return 'r4-'+Date.now().toString(36)+'-'+Math.random().toString(36).substr(2,8); }

// Supabase REST
function supaFetch(method, urlPath, body=null) {
  return new Promise((resolve, reject) => {
    const u = new URL(CONFIG.supaUrl+'/rest/v1'+urlPath);
    const opts = {
      hostname:u.hostname, port:443, path:u.pathname+u.search, method,
      headers: {'apikey':CONFIG.supaKey,'Authorization':'Bearer '+CONFIG.supaKey,'Content-Type':'application/json','Prefer':'return=representation'}
    };
    const req = https.request(opts, res => {
      let d=''; res.on('data',c=>d+=c);
      res.on('end', ()=> res.statusCode>=400 ? reject(new Error(`Supa ${method} ${urlPath} -> ${res.statusCode}: ${d}`)) : resolve(d?JSON.parse(d):null));
    });
    req.on('error',reject);
    req.setTimeout(15000,()=>{req.destroy();reject(new Error('Supa timeout'));});
    if(body)req.write(JSON.stringify(body));
    req.end();
  });
}

// ★★★ 실시간 스트리밍: messages 테이블에 streaming 상태로 업데이트 ★★★
let streamingMsgId = null;

async function createStreamingMessage(chatId) {
  streamingMsgId = 'stream-' + genId();
  await supaFetch('POST', '/messages', {
    id: streamingMsgId,
    chat_id: chatId,
    role: 'assistant',
    content: JSON.stringify({ text: '', thinking: null, tools: [], step: '요청 처리 시작...', loop: 0 }),
    status: 'streaming'
  });
  return streamingMsgId;
}

async function updateStreamingMessage(chatId, data) {
  if (!streamingMsgId) return;
  try {
    await supaFetch('PATCH', '/messages?id=eq.' + streamingMsgId, {
      content: JSON.stringify(data),
      status: 'streaming'
    });
  } catch(e) {
    log('Streaming update failed: ' + e.message, 'WARN');
  }
}

async function finalizeStreamingMessage(chatId, userMsgId, data) {
  if (streamingMsgId) {
    // Update the streaming message to completed with final data
    await supaFetch('PATCH', '/messages?id=eq.' + streamingMsgId, {
      content: JSON.stringify(data),
      status: 'completed'
    });
  } else {
    // Fallback: create new completed message
    await supaFetch('POST', '/messages', {
      id: genId(),
      chat_id: chatId,
      role: 'assistant',
      content: JSON.stringify(data),
      status: 'completed'
    });
  }
  await markCompleted(userMsgId);
  streamingMsgId = null;
  log('Response sent (loops: ' + (data.loops || 1) + ')');
}

// Bridge health
async function checkBridgeHealth() {
  try {
    // 1) Check last completed command timestamp
    const r = await supaFetch('GET', '/commands?status=eq.completed&order=created_at.desc&limit=1&select=id,created_at');
    if (r && r.length) {
      const t = new Date(r[0].created_at);
      const d = (Date.now() - t) / 60000;
      if (d < 5) return { alive: true, lastSeen: t.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }), minutesAgo: Math.round(d) };
    }
    // 2) Timestamp stale or no records -> active ping to confirm
    log('Bridge timestamp stale, sending active ping...');
    const ok = await quickPing();
    if (ok) return { alive: true, lastSeen: '방금 ping 응답', minutesAgo: 0 };
    return { alive: false, lastSeen: r && r.length ? new Date(r[0].created_at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : '기록 없음' };
  } catch(e) { return { alive: false, lastSeen: '확인 실패' }; }
}

// Quick ping
async function quickPing() {
  try {
    const pid = 'ping-' + Date.now();
    await supaFetch('POST', '/commands', { id: pid, action: 'ping', target: '', content: '', status: 'pending' });
    for (let i = 0; i < 4; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const [res] = await supaFetch('GET', '/commands?id=eq.' + pid + '&select=status');
      if (res && res.status === 'completed') { supaFetch('DELETE', '/commands?id=eq.' + pid).catch(() => {}); return true; }
    }
    supaFetch('DELETE', '/commands?id=eq.' + pid).catch(() => {});
    return false;
  } catch(e) { return false; }
}

// Claude CLI (stream-json)
function callClaude(prompt, chatId) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    let settled = false;
    const env = { ...process.env, FORCE_COLOR: '0' };
    if (GIT_BASH_PATH) env.CLAUDE_CODE_GIT_BASH_PATH = GIT_BASH_PATH;

    const child = spawn('claude', ['-p', '--verbose', '--output-format', 'stream-json', '-'], {
      shell: true, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
    });
    child.stdin.write(prompt);
    child.stdin.end();

    let stdout = '', stderr = '', thinkingParts = [], textParts = [], thinkingStart = null;
    let lineBuffer = '';

    child.stdout.on('data', chunk => {
      const str = chunk.toString();
      stdout += str;
      lineBuffer += str;
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const evt = JSON.parse(line);
          if (evt.type === 'assistant' && evt.subtype === 'thinking') {
            if (!thinkingStart) thinkingStart = Date.now();
            thinkingParts.push(evt.content || '');
          } else if (evt.type === 'assistant' && evt.subtype === 'text') {
            textParts.push(evt.content || '');
          } else if (evt.type === 'content_block_delta') {
            if (evt.delta?.type === 'thinking_delta') { if (!thinkingStart) thinkingStart = Date.now(); thinkingParts.push(evt.delta.thinking || ''); }
            else if (evt.delta?.type === 'text_delta') { textParts.push(evt.delta.text || ''); }
          }
        } catch(e) {}
      }
    });
    child.stderr.on('data', c => stderr += c.toString());

    child.on('close', code => {
      if (settled) return; settled = true;
      const dur = Date.now() - start;
      if (code !== 0) { log('stream-json failed, plain fallback...', 'WARN'); callClaudePlain(prompt).then(resolve).catch(reject); return; }
      const allLines = stdout.split('\n').filter(l => l.trim());
      let finalText = '';
      for (const line of allLines) { try { const e = JSON.parse(line); if (e.type === 'result') finalText = e.result || ''; } catch(e) {} }
      const text = finalText || textParts.join('') || stdout.trim();
      if (!text) { reject(new Error('Claude empty response')); return; }
      const thinkMs = thinkingStart ? (Date.now() - thinkingStart) : 0;
      resolve({ text, thinking: thinkingParts.join('') || null, thinkingTime: thinkMs > 0 ? (thinkMs / 1000).toFixed(1) + 's' : null, duration: (dur / 1000).toFixed(1) + 's' });
    });
    child.on('error', err => { if (!settled) { settled = true; reject(err); } });
    setTimeout(() => { if (!settled) { settled = true; child.kill(); reject(new Error('Claude timeout')); } }, CONFIG.claudeTimeout);
  });
}

function callClaudePlain(prompt) {
  return new Promise((resolve, reject) => {
    const start = Date.now(); let settled = false;
    const env = { ...process.env, FORCE_COLOR: '0' };
    if (GIT_BASH_PATH) env.CLAUDE_CODE_GIT_BASH_PATH = GIT_BASH_PATH;
    const child = spawn('claude', ['-p', '-'], { shell: true, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.write(prompt); child.stdin.end();
    let stdout = '', stderr = '';
    child.stdout.on('data', c => stdout += c.toString());
    child.stderr.on('data', c => stderr += c.toString());
    child.on('close', code => { if (settled) return; settled = true; if (code !== 0) { reject(new Error('Claude exit ' + code)); return; } const t = stdout.trim(); if (!t) { reject(new Error('empty')); return; } resolve({ text: t, thinking: null, thinkingTime: null, duration: ((Date.now() - start) / 1000).toFixed(1) + 's' }); });
    child.on('error', e => { if (!settled) { settled = true; reject(e); } });
    setTimeout(() => { if (!settled) { settled = true; child.kill(); reject(new Error('timeout')); } }, CONFIG.claudeTimeout);
  });
}

// Bridge command execution
async function executeBridgeCommand(cmd) {
  const cid = 'auto-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4);
  await supaFetch('POST', '/commands', { id: cid, action: cmd.action, target: cmd.target || '', content: cmd.content || '', status: 'pending' });
  const maxWait = CONFIG.bridgeCmdTimeout, poll = 2000;
  for (let i = 0; i < Math.ceil(maxWait / poll); i++) {
    await new Promise(r => setTimeout(r, poll));
    try {
      const [res] = await supaFetch('GET', '/commands?id=eq.' + cid + '&select=status,result');
      if (res && (res.status === 'completed' || res.status === 'error')) {
        supaFetch('DELETE', '/commands?id=eq.' + cid).catch(() => {});
        return { success: res.status === 'completed', result: res.result || '' };
      }
    } catch(e) {}
  }
  supaFetch('DELETE', '/commands?id=eq.' + cid).catch(() => {});
  return { success: false, result: '(브리지 타임아웃)' };
}

function extractBridgeCommands(text) {
  const rx = /```bridge-command\s*\n([\s\S]*?)\n```/g; const cmds = []; let m;
  while ((m = rx.exec(text)) !== null) { try { cmds.push(JSON.parse(m[1])); } catch(e) {} }
  return cmds;
}
function extractPermissions(text) {
  const rx = /```permission-request\s*\n([\s\S]*?)\n```/g; const perms = []; let m;
  while ((m = rx.exec(text)) !== null) { try { perms.push(JSON.parse(m[1])); } catch(e) {} }
  return perms;
}
function cleanText(text) {
  return text.replace(/```bridge-command\s*\n[\s\S]*?\n```/g, '').replace(/```permission-request\s*\n[\s\S]*?\n```/g, '').trim();
}

// Message handling
async function getPending() { return (await supaFetch('GET', '/messages?role=eq.user&status=eq.pending&order=created_at.asc&limit=1')) || []; }
async function markProcessing(id) { await supaFetch('PATCH', '/messages?id=eq.' + id, { status: 'processing' }); }
async function markCompleted(id) { await supaFetch('PATCH', '/messages?id=eq.' + id, { status: 'completed' }); }
async function getChatHistory(chatId) {
  try { return (await supaFetch('GET', '/messages?chat_id=eq.' + chatId + '&status=eq.completed&order=created_at.asc&limit=' + CONFIG.maxHistoryMessages)) || []; } catch(e) { return []; }
}

function buildPromptWithHistory(sys, history, msg) {
  let p = sys + '\n\n';
  if (history.length > 0) {
    p += '## 이전 대화\n';
    for (const h of history) {
      if (h.role === 'user') p += '\nUser: ' + h.content + '\n';
      else { try { p += '\nAssistant: ' + (JSON.parse(h.content).text || h.content) + '\n'; } catch(e) { p += '\nAssistant: ' + h.content + '\n'; } }
    }
    p += '\n---\n';
  }
  p += '\nUser: ' + msg + '\n\nAssistant:';
  return p;
}

// ★★★ CORE: Feedback loop with real-time streaming ★★★
async function processMessage(msg) {
  const { id, chat_id, content } = msg;
  log('New msg: "' + content.substring(0, 60) + (content.length > 60 ? '...' : '') + '"');

  const allTools = [], allThinking = [], stepLog = [];
  let finalText = '', totalThinkTime = 0, totalDur = 0;

  try {
    await markProcessing(id);

    // ★ Create streaming message in messages table
    await createStreamingMessage(chat_id);
    await updateStreamingMessage(chat_id, {
      text: '', thinking: null, tools: [], step: '🔄 요청 처리 시작...', loop: 0,
      steps: ['요청 처리 시작...']
    });

    const bridgeStatus = await checkBridgeHealth();
    log('Bridge: ' + (bridgeStatus.alive ? 'ALIVE' : 'OFFLINE'));
    const history = await getChatHistory(chat_id);
    const sys = buildSystemPrompt(bridgeStatus);

    let currentMsg = content;
    if (content.startsWith('[HOME]')) currentMsg = '[집PC작업] ' + content.substring(6).trim();
    if (content.startsWith('[APPROVED:')) currentMsg = '[사용자승인] ' + content;

    let prompt = buildPromptWithHistory(sys, history, currentMsg);

    for (let loop = 0; loop < CONFIG.maxFeedbackLoops; loop++) {
      log('--- Loop ' + (loop + 1) + '/' + CONFIG.maxFeedbackLoops + ' ---');

      // ★ Stream: Claude 호출 중
      stepLog.push('🧠 Claude에게 분석 요청 중... (루프 ' + (loop + 1) + ')');
      await updateStreamingMessage(chat_id, {
        text: finalText || '',
        thinking: allThinking.join('\n---\n') || null,
        tools: allTools,
        step: '🧠 Claude에게 분석 요청 중... (루프 ' + (loop + 1) + ')',
        loop: loop + 1,
        steps: stepLog.slice(-10)
      });

      const result = await callClaude(prompt, chat_id);
      log('Claude responded (' + result.duration + ')');
      totalDur += parseFloat(result.duration);
      if (result.thinking) { allThinking.push(result.thinking); totalThinkTime += parseFloat(result.thinkingTime || '0'); }

      const cmds = extractBridgeCommands(result.text);
      const perms = extractPermissions(result.text);
      const clean = cleanText(result.text);

      // ★ Stream: Claude 응답 수신
      stepLog.push('📝 Claude 응답 수신 (' + result.duration + ')');
      if (clean) {
        stepLog.push('💬 ' + clean.substring(0, 100) + (clean.length > 100 ? '...' : ''));
      }

      // Permission request -> stop loop
      if (perms.length > 0) {
        log('Permission request, stopping loop');
        await finalizeStreamingMessage(chat_id, id, {
          text: clean, thinking: allThinking.join('\n---\n') || null, tools: allTools,
          permissions: perms, thinkingTime: totalThinkTime.toFixed(1) + 's',
          duration: totalDur.toFixed(1) + 's', loops: loop + 1, steps: stepLog
        });
        return;
      }

      // No commands -> final response
      if (cmds.length === 0) {
        log('No bridge cmds, final (loop ' + (loop + 1) + ')');
        finalText = clean || result.text;
        break;
      }

      // Execute bridge commands
      if (!bridgeStatus.alive) {
        log('Bridge offline, quick ping...');
        stepLog.push('🔌 브리지 연결 확인 중...');
        await updateStreamingMessage(chat_id, {
          text: clean || '', thinking: allThinking.join('\n---\n') || null, tools: allTools,
          step: '🔌 브리지 연결 확인 중...', loop: loop + 1, steps: stepLog.slice(-10)
        });
        const ok = await quickPing();
        if (!ok) {
          allTools.push({ name: 'bridge_offline', target: '', result: '브리지 오프라인', success: false });
          finalText = clean + '\n\n⚠️ 브리지가 오프라인입니다.';
          break;
        }
        bridgeStatus.alive = true;
        stepLog.push('✅ 브리지 연결됨');
      }

      // ★ Stream: 브리지 명령 실행
      stepLog.push('⚡ 브리지 명령 ' + cmds.length + '개 실행 중...');
      await updateStreamingMessage(chat_id, {
        text: clean || '', thinking: allThinking.join('\n---\n') || null, tools: allTools,
        step: '⚡ 브리지 명령 ' + cmds.length + '개 실행 중...',
        loop: loop + 1, steps: stepLog.slice(-10),
        commands: cmds.map(c => c.action)
      });

      const loopResults = [];
      for (let ci = 0; ci < cmds.length; ci++) {
        const cmd = cmds[ci];
        const cmdDesc = cmd.action + (cmd.target ? ' → ' + cmd.target.substring(0, 40) : '') + (cmd.content ? ' (' + (cmd.content || '').substring(0, 40) + ')' : '');
        log('  Exec: ' + cmdDesc);

        // ★ Stream: 개별 명령 실행
        stepLog.push('  🔧 [' + (ci + 1) + '/' + cmds.length + '] ' + cmdDesc);
        await updateStreamingMessage(chat_id, {
          text: clean || '', thinking: allThinking.join('\n---\n') || null, tools: allTools,
          step: '🔧 명령 실행 중 [' + (ci + 1) + '/' + cmds.length + ']: ' + cmd.action,
          loop: loop + 1, steps: stepLog.slice(-10)
        });

        let r = await executeBridgeCommand(cmd);

        // Retry once on failure
        if (!r.success) {
          log('  Failed, retry...', 'WARN');
          stepLog.push('  ⚠️ 실패, 재시도...');
          await new Promise(r => setTimeout(r, 1000));
          r = await executeBridgeCommand(cmd);
        }

        const isScreenshot = cmd.action === 'screenshot';
        const resultPreview = isScreenshot ? '(스크린샷 캡처됨)' : (r.result || '').substring(0, 200);
        const entry = {
          name: cmd.action,
          target: cmd.target || (cmd.content || '').substring(0, 80),
          result: (r.result || '').substring(0, 2000),
          success: r.success
        };
        allTools.push(entry);
        loopResults.push(entry);

        // ★ Stream: 명령 결과
        stepLog.push('  ' + (r.success ? '✅' : '❌') + ' ' + cmd.action + ': ' + resultPreview.substring(0, 80));
        await updateStreamingMessage(chat_id, {
          text: clean || '', thinking: allThinking.join('\n---\n') || null, tools: allTools,
          step: (r.success ? '✅' : '❌') + ' ' + cmd.action + ' ' + (r.success ? '성공' : '실패'),
          loop: loop + 1, steps: stepLog.slice(-10)
        });
      }

      // ★ Feedback: build new prompt with results
      const resultSummary = loopResults.map((r, i) => {
        return '[BRIDGE_RESULT ' + (i + 1) + '] ' + (r.success ? '성공' : '실패') + ': ' + r.name + '\n대상: ' + r.target + '\n결과:\n' + r.result;
      }).join('\n\n');

      prompt = sys + '\n\n';
      if (history.length > 0) {
        prompt += '## 이전 대화\n';
        for (const h of history) {
          if (h.role === 'user') prompt += '\nUser: ' + h.content + '\n';
          else { try { prompt += '\nAssistant: ' + (JSON.parse(h.content).text || h.content) + '\n'; } catch(e) { prompt += '\nAssistant: ' + h.content + '\n'; } }
        }
        prompt += '\n---\n';
      }
      prompt += '\nUser: ' + currentMsg + '\n\n';
      prompt += 'Assistant (이전 응답): ' + clean + '\n\n';
      prompt += '--- 명령 실행 결과 ---\n' + resultSummary + '\n\n';
      prompt += '위 결과를 바탕으로 다음 행동을 결정하세요:\n';
      prompt += '- 성공한 경우: 결과를 사용자에게 정리해서 보고\n';
      prompt += '- 실패한 경우: 반드시 다른 방법으로 재시도 (스크린샷 다시 찍기, 다른 좌표, 키보드 단축키 등)\n';
      prompt += '- 추가 작업 필요: bridge-command로 다음 단계 실행\n';
      prompt += '★ 절대 포기하지 마라. 실패 보고만 하지 말고 반드시 대안을 시도하라.\n\nAssistant:';

      // ★ Stream: 결과 분석 중
      stepLog.push('🔄 결과 분석 후 다음 단계 결정 중...');
      await updateStreamingMessage(chat_id, {
        text: clean || '', thinking: allThinking.join('\n---\n') || null, tools: allTools,
        step: '🔄 결과 분석 후 다음 단계 결정 중... (루프 ' + (loop + 2) + ')',
        loop: loop + 1, steps: stepLog.slice(-10)
      });
      log('Feeding results back (loop ' + (loop + 2) + ')...');
    }

    // ★ Finalize: streaming → completed
    stepLog.push('✅ 작업 완료');
    await finalizeStreamingMessage(chat_id, id, {
      text: finalText,
      thinking: allThinking.join('\n---\n') || null,
      tools: allTools,
      permissions: [],
      thinkingTime: totalThinkTime.toFixed(1) + 's',
      duration: totalDur.toFixed(1) + 's',
      loops: allTools.length > 0 ? Math.ceil(allTools.length / 1) : 1,
      steps: stepLog
    });

  } catch(error) {
    log('Failed: ' + error.message, 'ERROR');
    stepLog.push('❌ 오류: ' + error.message);
    try {
      await finalizeStreamingMessage(chat_id, id, {
        text: '⚠️ 오류: ' + error.message + '\n다시 시도해주세요.',
        thinking: null, tools: allTools, permissions: [],
        thinkingTime: '0s', duration: '0s', loops: 0, steps: stepLog
      });
    } catch(e2) {
      log('Error response failed: ' + e2.message, 'ERROR');
      // Last resort: try to create a new message
      try {
        await supaFetch('POST', '/messages', {
          id: genId(), chat_id: chat_id, role: 'assistant',
          content: JSON.stringify({ text: '⚠️ 오류: ' + error.message, tools: [], steps: stepLog }),
          status: 'completed'
        });
        await markCompleted(id);
      } catch(e3) {}
    }
  }
}

// Heartbeat
async function sendHeartbeat() {
  const now = new Date().toISOString();
  try { await supaFetch('PATCH', '/commands?id=eq.relay-heartbeat', { status: 'completed', result: now, content: processing ? 'busy' : 'idle' }); }
  catch(e) { try { await supaFetch('POST', '/commands', { id: 'relay-heartbeat', action: 'heartbeat', target: 'home-pc', content: 'idle', status: 'completed', result: now }); } catch(e2) {} }
}

// Tests
async function testConnection() {
  try { log('Testing Supabase...'); await supaFetch('GET', '/messages?limit=1'); log('Supabase: OK'); return true; } catch(e) { log('Supabase FAILED: ' + e.message, 'ERROR'); return false; }
}
async function testClaude() {
  try { log('Testing Claude CLI...'); const r = await callClaudePlain('Say "relay-ok" and nothing else.'); log('Claude CLI: OK (' + r.duration + ')'); return true; } catch(e) { log('Claude FAILED: ' + e.message, 'ERROR'); return false; }
}

// Main loop
async function pollLoop() {
  sendHeartbeat();
  const hb = setInterval(sendHeartbeat, 30000);
  while (isRunning) {
    try {
      if (!processing) { const p = await getPending(); if (p.length > 0) { processing = true; await processMessage(p[0]); processing = false; } }
    } catch(e) { log('Poll error: ' + e.message, 'ERROR'); processing = false; }
    await new Promise(r => setTimeout(r, CONFIG.pollInterval));
  }
  clearInterval(hb);
}

// Start
function printBanner() {
  console.log('\n========================================================');
  console.log('  Cowork Relay Worker v4.0 - Home PC');
  console.log('========================================================');
  console.log('  ★ Real-time streaming to messages table');
  console.log('  ★ Enhanced RPA: never give up, try alternatives');
  console.log('  ★ EP-specific strategies for mail/ECM');
  console.log('  ★ Feedback loop with step-by-step progress');
  console.log('  Max loops: ' + CONFIG.maxFeedbackLoops + ' | Claude timeout: 180s');
  console.log('  Stop: Ctrl+C');
  console.log('========================================================\n');
}

process.on('SIGINT', () => { log('Shutting down...'); isRunning = false; setTimeout(() => process.exit(0), 2000); });
process.on('SIGTERM', () => { isRunning = false; setTimeout(() => process.exit(0), 2000); });

(async () => {
  printBanner();
  if (GIT_BASH_PATH) log('Git-bash: ' + GIT_BASH_PATH); else log('Git-bash NOT found!', 'WARN');
  if (!(await testConnection())) { console.log('\n[FATAL] Supabase failed.'); process.exit(1); }
  if (!(await testClaude())) { console.log('\n[FATAL] Claude CLI failed.'); process.exit(1); }
  const b = await checkBridgeHealth();
  log('Bridge: ' + (b.alive ? 'ALIVE' : 'OFFLINE') + ' (last: ' + b.lastSeen + ')');
  log('v4.0 active. Waiting for messages...\n');
  pollLoop().catch(e => { log('FATAL: ' + e.message, 'ERROR'); process.exit(1); });
})();
