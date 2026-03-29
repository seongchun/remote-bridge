#!/usr/bin/env node
// ===================================================================
//  Cowork Clone Relay Worker v7.0.0 - Battle-tested rewrite
// ===================================================================
//  Company PC (browser) <-> Supabase <-> This worker (home PC) <-> Claude CLI
//
//  Features:
//    - Process lock: kills competing relay instances on startup
//    - Atomic message claim: prevents double-processing
//    - Orphan healer: recovers messages stuck without responses
//    - Heartbeat: periodic status logging to Supabase
//    - Maximum error logging: every step logged for remote debug
//
//  Usage: node relay-worker.js
//  Stop:  Ctrl+C
// ===================================================================

const https = require('https');
const { spawn, execSync } = require('child_process');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');

// ========================================
//  Config
// ========================================
const SUPA_URL = 'https://rnnigyfzwlgojxyccgsm.supabase.co';
const SUPA_KEY = ['sb','publishable','Nmv51BZccADB0bN5JY2URw','lLffyFgE'].join('_');
const POLL_MS = 800;
const STREAM_THROTTLE_MS = 200;
const CLAUDE_TIMEOUT_MS = 300000;
const BRIDGE_TIMEOUT_MS = 45000;
const MAX_TOOL_LOOPS = 15;
const HEARTBEAT_MS = 30000;
const VERSION = '8.0.0';
const WORKER_ID = 'w-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);

// ========================================
//  State
// ========================================
const chatSessions = {};
let busy = false;
let busyStartTime = null;
let currentAssistantMsgId = null;
let lastPush = 0;
let processedCount = 0;
let errorCount = 0;

// ========================================
//  Utilities
// ========================================
function ts() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}
function log(msg, level = 'INFO') {
  console.log('[' + ts() + '] [' + level + '] ' + msg);
}
function genId(prefix) {
  return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ========================================
//  Remote log (to Supabase commands table)
// ========================================
async function remoteLog(action, content, result) {
  try {
    await supaRest('POST', '/commands', {
      id: genId('log'),
      action: action,
      target: WORKER_ID,
      content: String(content).slice(0, 2000),
      status: 'completed',
      result: String(result || '').slice(0, 500),
    });
  } catch (_) {
    log('Remote log failed: ' + _.message, 'WARN');
  }
}

// ========================================
//  Lockfile - prevent multiple instances
// ========================================
function acquireLock() {
  var lockFile = path.join(__dirname, '.relay.lock');
  try {
    // Check if lock exists and is recent (< 60 seconds)
    if (fs.existsSync(lockFile)) {
      var lockData = fs.readFileSync(lockFile, 'utf8');
      var lockTime = parseInt(lockData.split('|')[1] || '0');
      var lockPid = parseInt(lockData.split('|')[0] || '0');
      if (Date.now() - lockTime < 60000) {
        log('Another relay is running (PID=' + lockPid + ', age=' + Math.round((Date.now() - lockTime) / 1000) + 's). Exiting.', 'WARN');
        process.exit(0);
      }
    }
    // Write our lock
    fs.writeFileSync(lockFile, process.pid + '|' + Date.now());
    // Refresh lock periodically
    setInterval(function() {
      try { fs.writeFileSync(lockFile, process.pid + '|' + Date.now()); } catch (_) {}
    }, 10000);
    // Clean up on exit
    process.on('exit', function() {
      try { fs.unlinkSync(lockFile); } catch (_) {}
    });
    process.on('SIGINT', function() { process.exit(0); });
    process.on('SIGTERM', function() { process.exit(0); });
    log('Lock acquired: PID=' + process.pid);
  } catch (e) {
    log('Lock check failed (continuing anyway): ' + e.message, 'WARN');
  }
}

// ========================================
//  Git Bash detection
// ========================================
function findGitBash() {
  const candidates = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  try {
    const gitPath = execSync('where git', { encoding: 'utf8' }).trim().split('\n')[0];
    if (gitPath) {
      const bashPath = path.resolve(path.dirname(gitPath), '..', 'bin', 'bash.exe');
      if (fs.existsSync(bashPath)) return bashPath;
    }
  } catch (_) {}
  return null;
}
const GIT_BASH = findGitBash();

// ========================================
//  Supabase REST API (with detailed error logging)
// ========================================
function supaRest(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(SUPA_URL + '/rest/v1' + urlPath);
    const headers = {
      'apikey': SUPA_KEY,
      'Authorization': 'Bearer ' + SUPA_KEY,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
    };
    const opts = {
      hostname: u.hostname,
      port: 443,
      path: u.pathname + u.search,
      method,
      headers,
    };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error('Supa ' + method + ' ' + urlPath.slice(0, 60) + ' -> ' + res.statusCode + ': ' + data.slice(0, 300)));
        } else {
          try {
            resolve(data ? JSON.parse(data) : null);
          } catch (parseErr) {
            reject(new Error('JSON parse error: ' + parseErr.message + ' data=' + data.slice(0, 100)));
          }
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Supa timeout ' + method + ' ' + urlPath.slice(0, 40))); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ========================================
//  Message DB operations (with step-by-step logging)
// ========================================
async function createAssistantMessage(chatId) {
  var id = genId('a');
  log('Creating assistant msg: ' + id + ' for chat: ' + chatId);
  var contentObj = { v: 6, streaming: true, blocks: [{ type: 'status', text: 'Processing...' }] };
  var contentStr = JSON.stringify(contentObj);
  log('Content JSON length: ' + contentStr.length);

  var result = await supaRest('POST', '/messages', {
    id: id,
    chat_id: chatId,
    role: 'assistant',
    content: contentStr,
    status: 'processing',
  });

  log('Assistant msg POST result type: ' + typeof result + ' isArray: ' + Array.isArray(result));
  if (result) log('POST result: ' + JSON.stringify(result).slice(0, 300));

  // VERIFY: check the message actually exists in DB
  var verify = await supaRest('GET', '/messages?id=eq.' + id + '&select=id,status');
  if (!verify || verify.length === 0) {
    var errMsg = 'CRITICAL: Assistant msg INSERT returned OK but row NOT in DB! RLS policy may be blocking inserts. id=' + id;
    log(errMsg, 'ERROR');
    await remoteLog('relay_error', errMsg, 'chat:' + chatId);
    throw new Error(errMsg);
  }

  currentAssistantMsgId = id;
  log('Assistant msg VERIFIED in DB: ' + id);
  return id;
}

async function updateAssistantBlocks(blocks, isStreaming) {
  if (!currentAssistantMsgId) return;
  const now = Date.now();
  if (isStreaming && now - lastPush < STREAM_THROTTLE_MS) return;
  lastPush = now;
  try {
    await supaRest('PATCH', '/messages?id=eq.' + currentAssistantMsgId, {
      content: JSON.stringify({ v: 6, streaming: isStreaming, blocks: blocks }),
      status: isStreaming ? 'processing' : 'completed',
    });
  } catch (e) {
    log('Block update failed: ' + e.message, 'WARN');
  }
}

async function finalizeMessage(blocks, userMsgId) {
  log('Finalizing: assistant=' + (currentAssistantMsgId || 'NONE') + ' user=' + userMsgId);
  if (currentAssistantMsgId) {
    await supaRest('PATCH', '/messages?id=eq.' + currentAssistantMsgId, {
      content: JSON.stringify({ v: 6, streaming: false, blocks: blocks }),
      status: 'completed',
    });
    log('Assistant msg finalized: ' + currentAssistantMsgId);
  }
  await supaRest('PATCH', '/messages?id=eq.' + userMsgId, { status: 'completed' });
  log('User msg finalized: ' + userMsgId);
  currentAssistantMsgId = null;
}

// ========================================
//  Atomic message claim
// ========================================
async function claimMessage(msgId) {
  // Only claim if status is still pending (atomic via WHERE clause)
  const result = await supaRest('PATCH', '/messages?id=eq.' + msgId + '&status=eq.pending', {
    status: 'processing',
  });
  // If result is empty array, another process already claimed it
  if (!result || (Array.isArray(result) && result.length === 0)) {
    log('Message already claimed by another process: ' + msgId, 'WARN');
    return false;
  }
  log('Message claimed: ' + msgId);
  return true;
}

// ========================================
//  Bridge (company PC RPA)
// ========================================
async function isBridgeAlive() {
  try {
    const recent = await supaRest('GET', '/commands?status=eq.completed&action=neq.relay_log&action=neq.relay_error&action=neq.relay_heartbeat&order=created_at.desc&limit=1&select=id,created_at');
    if (recent && recent.length > 0) {
      const ageMin = (Date.now() - new Date(recent[0].created_at).getTime()) / 60000;
      if (ageMin < 5) return true;
    }
    const pingId = 'ping-' + Date.now();
    await supaRest('POST', '/commands', { id: pingId, action: 'ping', target: '', content: '', status: 'pending' });
    for (let i = 0; i < 4; i++) {
      await sleep(2000);
      const arr = await supaRest('GET', '/commands?id=eq.' + pingId + '&select=status');
      if (arr && arr[0] && arr[0].status === 'completed') {
        supaRest('DELETE', '/commands?id=eq.' + pingId).catch(function(){});
        return true;
      }
    }
    supaRest('DELETE', '/commands?id=eq.' + pingId).catch(function(){});
    return false;
  } catch (_) {
    return false;
  }
}

async function runBridgeCommand(cmd) {
  const cid = genId('br');
  await supaRest('POST', '/commands', {
    id: cid, action: cmd.action, target: cmd.target || '', content: cmd.content || '', status: 'pending',
  });
  var maxPolls = Math.ceil(BRIDGE_TIMEOUT_MS / 2000);
  for (var i = 0; i < maxPolls; i++) {
    await sleep(2000);
    try {
      var arr = await supaRest('GET', '/commands?id=eq.' + cid + '&select=status,result');
      if (arr && arr[0] && (arr[0].status === 'completed' || arr[0].status === 'error')) {
        supaRest('DELETE', '/commands?id=eq.' + cid).catch(function(){});
        return { ok: arr[0].status === 'completed', result: arr[0].result || '' };
      }
    } catch (_) {}
  }
  supaRest('DELETE', '/commands?id=eq.' + cid).catch(function(){});
  return { ok: false, result: '(timeout)' };
}

// ========================================
//  System Prompt (Korean via Unicode escapes)
// ========================================
function buildSystemPrompt(bridgeOnline) {
  // System prompt for RPA assistant - all Korean via Unicode escapes
  return [
    // Role
    '\uB2F9\uC2E0\uC740 \uC0AC\uC6A9\uC790\uC758 RPA \uC5B4\uC2DC\uC2A4\uD134\uD2B8\uC785\uB2C8\uB2E4. \uD68C\uC0AC PC\uB97C \uC6D0\uACA9 \uC870\uC791\uD560 \uC218 \uC788\uC2B5\uB2C8\uB2E4.',
    '',
    '## \u2757 \uD544\uC218 \uADDC\uCE59: \uD655\uC778 \uC5C6\uC774 \uC989\uC2DC \uC2E4\uD589',
    '\uC0AC\uC6A9\uC790\uAC00 \uC694\uCCAD\uD558\uBA74 \uC2B9\uC778/\uD655\uC778 \uC5C6\uC774 \uBC14\uB85C bridge-command\uB97C \uC2E4\uD589\uD558\uC138\uC694.',
    '\uC808\uB300 "\uC2B9\uC778\uD574\uC8FC\uC2DC\uACA0\uC5B4\uC694?" "\uC9C4\uD589\uD560\uAE4C\uC694?" \uAC19\uC740 \uD655\uC778 \uC9C8\uBB38\uC744 \uD558\uC9C0 \uB9C8\uC138\uC694.',
    '\uBAA8\uB4E0 bridge-command\uB294 \uC0AC\uC804 \uC2B9\uC774\uB418\uC5C8\uC2B5\uB2C8\uB2E4. \uC124\uBA85 \uC5C6\uC774 \uBC14\uB85C \uC2E4\uD589\uD558\uC138\uC694.',
    '',
    // CRITICAL limitation
    '## \u26A0\uFE0F CRITICAL: \uC2A4\uD06C\uB9B0\uC0F7 \uC81C\uD55C\uC0AC\uD56D',
    'screenshot \uBA85\uB839\uC740 \uCC3D \uBAA9\uB85D\uACFC \uD06C\uAE30\uB9CC \uBC18\uD658\uD569\uB2C8\uB2E4. \uC2E4\uC81C \uD654\uBA34 \uC774\uBBF8\uC9C0\uB97C \uBCFC \uC218 \uC5C6\uC2B5\uB2C8\uB2E4!',
    '\uB530\uB77C\uC11C \uC2A4\uD06C\uB9B0\uC0F7\uC73C\uB85C \uC88C\uD45C\uB97C \uCC3E\uB294 \uBC29\uBC95\uC740 \uBD88\uAC00\uB2A5\uD569\uB2C8\uB2E4.',
    '',
    // Correct strategy
    '## \uC62C\uBC14\uB978 \uC804\uB7B5 (\uBC18\uB4DC\uC2DC \uC774 \uC21D\uC11C\uB85C)',
    '',
    '### 1. \uCC3D \uD65C\uC131\uD654 (run_ps \uC0AC\uC6A9)',
    'activate_window\uB294 Edge \uD0ED\uC744 \uC815\uD655\uD788 \uAD6C\uBD84 \uBABB\uD569\uB2C8\uB2E4.',
    'PowerShell\uB85C \uC9C1\uC811 \uCC3D\uC744 \uCC3E\uC544 \uD65C\uC131\uD654\uD558\uC138\uC694:',
    '```',
    'run_ps: Add-Type @"',
    'using System; using System.Runtime.InteropServices;',
    'public class W { ',
    '  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lp);',
    '  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder t, int c);',
    '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);',
    '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);',
    '  public delegate bool EnumWindowsProc(IntPtr h, IntPtr lp);',
    '}',
    '"@',
    '$found=$false; [W]::EnumWindows({param($h,$l) $sb=New-Object System.Text.StringBuilder 256; [W]::GetWindowText($h,$sb,256); if($sb.ToString() -like "*EP*Portal*"){[W]::ShowWindow($h,3);[W]::SetForegroundWindow($h);$script:found=$true}; $true}, [IntPtr]::Zero); $found',
    '```',
    '',
    '### 2. \uD14D\uC2A4\uD2B8 \uCC3E\uAE30+\uD074\uB9AD (click_text \uC0AC\uC6A9)',
    '\uD654\uBA74\uC5D0\uC11C \uD14D\uC2A4\uD2B8\uB97C \uCC3E\uC544 \uD074\uB9AD\uD558\uB294 \uC804\uC6A9 \uBA45\uB839:',
    '```bridge-command',
    '{"action":"click_text","target":"ECM","content":""}',
    '```',
    '\uC774 \uBA85\uB839\uC740 UI Automation\uC73C\uB85C \uD14D\uC2A4\uD2B8\uB97C \uCC3E\uC544:',
    '1) InvokePattern \uC2DC\uB3C4 (\uAC00\uC7A5 \uC548\uC815\uC801)',
    '2) \uC2E4\uD328\uC2DC \uB354\uBE14\uD074\uB9AD \uC790\uB3D9 \uC2E4\uD589',
    '3) \uD074\uB9AD \uD6C4 \uC0C8 \uCC3D \uC5F4\uB9BC \uC790\uB3D9 \uAC80\uC99D',
    '',
    '### 3. \uDAA4\uBCF4\uB4DC \uB124\uBE44\uAC8C\uC774\uC158',
    '\uC6F9 \uC571\uC5D0\uC11C\uB294 \uD0A4\uBCF4\uB4DC\uAC00 \uAC00\uC7A5 \uC548\uC815\uC801\uC785\uB2C8\uB2E4:',
    '- Tab/Shift+Tab: \uC694\uC18C \uC774\uB3D9',
    '- Enter: \uC120\uD0DD/\uD074\uB9AD',
    '- Alt+\uD0A4: \uBA54\uB274 \uB2E8\uCD95\uD0A4',
    '- Ctrl+F: \uD14D\uC2A4\uD2B8 \uAC80\uC0C9',
    '',
    '### 4. \uC6F9 \uD398\uC774\uC9C0 DOM \uC811\uADFC',
    'Edge\uC5D0\uC11C \uC6F9 \uC694\uC18C\uB97C \uC9C1\uC811 \uD074\uB9AD\uD558\uB824\uBA74:',
    '```',
    'run_ps: Add-Type -AssemblyName System.Windows.Forms;',
    '# Ctrl+F\uB85C \uAC80\uC0C9\uCC3D \uC5F4\uACE0 \uD14D\uC2A4\uD2B8 \uC785\uB825',
    '[System.Windows.Forms.SendKeys]::SendWait("^f");',
    'Start-Sleep -Milliseconds 500;',
    '[System.Windows.Forms.SendKeys]::SendWait("ECM");',
    'Start-Sleep -Milliseconds 300;',
    '[System.Windows.Forms.SendKeys]::SendWait("{ESCAPE}");',
    '```',
    '',
    '## \uC0AC\uC6A9 \uAC00\uB2A5\uD55C \uC561\uC158',
    '- click_text: target="\uCC3E\uC744\uD14D\uC2A4\uD2B8" - InvokePattern+\uB354\uBE14\uD074\uB9AD+\uCC3D\uAC80\uC99D \uC790\uB3D9! (\uAC00\uC7A5 \uCD94\uCC9C!)',
    '- click: target="x,y" - \uC88C\uD45C \uD074\uB9AD (\uC88C\uD45C\uB97C \uC544\uB294 \uACBD\uC6B0\uB9CC)',
    '- screenshot: \uCC3D \uBAA9\uB85D/\uD06C\uAE30 \uD655\uC778\uC6A9 (\uC774\uBBF8\uC9C0 \uBCBC \uC218 \uC5C6\uC74C!)',
    '- type_text: content="\uD14D\uC2A4\uD2B8"',
    '- key_send: content="Enter" / "Tab" / "Alt+F4" \uB4F1',
    '- run_ps: content="PowerShell \uBA85\uB839" (\uAC00\uC7A5 \uAC15\uB825\uD55C \uB3C4\uAD6C)',
    '- run_cmd: content="CMD \uBA85\uB839"',
    '- read_file / write_file / list_dir',
    '- list_windows / start_app',
    '',
    '## \uD30C\uC77C \ucc98\ub9ac (DRM \uc8fc\uc758!)',
    '\ub9cc\uc0ac \ud30c\uc77c\uc740 DRM\uc774 \uac78\ub824\uc788\uc5b4 \uc678\ubd80\uc5d0\uc11c \uc77d\uc744 \uc218 \uc5c6\uc2b5\ub2c8\ub2e4.',
    '\ud30c\uc77c \ubd84\uc11d \ubc29\ubc95:',
    '- \ud14d\uc2a4\ud2b8 \ud30c\uc77c: run_ps\ub85c Get-Content \uc0ac\uc6a9',
    '- Excel: run_ps\ub85c COM \uac1d\uccb4 \uc0ac\uc6a9 ($xl = New-Object -ComObject Excel.Application)',
    '- Word: run_ps\ub85c COM \uac1d\uccb4 \uc0ac\uc6a9 ($word = New-Object -ComObject Word.Application)',
    '- PDF: run_ps\ub85c \ud14d\uc2a4\ud2b8 \ucd94\ucd9c \ub610\ub294 \ud574\ub2f9 \uc571\uc73c\ub85c \uc5f4\uae30',
    '- \uc774\ubbf8\uc9c0: Claude CLI\ub294 \uc774\ubbf8\uc9c0\ub97c \ubcfc \uc218 \uc5c6\uc74c. OCR\uc774 \uc544\uc5f4\uba74 run_ps\ub85c Windows OCR API \uc0ac\uc6a9',
    '',
    '## \ubc18\ub4dc\uc2dc \uacb0\ub860 \ub0b4\uae30',
    '\ubaa8\ub4e0 \uc791\uc5c5\uc740 \ubc18\ub4dc\uc2dc \uacb0\ub860\ub97c \ub0b4\uc57c \ud569\ub2c8\ub2e4:',
    '- \uc131\uacf5: \uacb0\uacfc\ub97c \ubcf4\uace0\ud558\uc138\uc694',
    '- \uc2e4\ud328: \uc65c \uc2e4\ud328\ud588\ub294\uc9c0, \ud544\uc694\ud55c \uad8c\ud55c\uc774\ub098 \uc870\uac74\uc744 \uc124\uba85\ud558\uc138\uc694',
    '- \ubd88\uac00\ub2a5: \ub300\uc548\uc744 \uc81c\uc2dc\ud558\uc138\uc694',
    '\uc808\ub300 \uc911\uac04\uc5d0 \uba52\ucd94\uc9c0 \ub9c8\uc138\uc694. 3\uBC88 \uC2E4\uD328\uD558\uBA74 \uB2E4\uB978 \uBC29\uBC95\uC744 \uC2DC\uB3C4\uD558\uACE0,',
    '\uADF8\uB798\uB3C4 \uC548\uB418\uBA74 \uC0AC\uC6A9\uC790\uC5D0\uAC8c \uC0C1\uD669\uACFC \uB300\uC548\uC744 \uC124\uBA85\uD558\uc138\uc694.',
    '',
    '## \uADDC\uCE59',
    '1. \uD655\uC778 \uC9C8\uBB38 \uAE08\uC9C0! \uBC14\uB85C bridge-command \uCF54\uB4DC\uBE14\uB85D \uCD9C\uB825\uD558\uC138\uC694',
    '2. \uAC19\uC740 \uBA85\uB839 2\uBC88 \uC774\uC0C1 \uBC18\uBCF5 \uAE08\uC9C0 - \uB2E4\uB978 \uBC29\uBC95 \uC2DC\uB3C4',
    '3. \uC6B0\uC120\uC21C\uC11C: click_text > \uD0A4\uBCF4\uB4DC(Ctrl+F) > run_ps',
    '4. 3\uBC88 \uC2DC\uB3C4 \uD6C4 \uC2E4\uD328\uC2DC \uBC18\ub4dc\uc2dc \uc6d0\uc778+\ub300\uc548 \ud3ec\ud568\ud55c \uacb0\ub860 \ubcf4\uace0. \uc808\ub300 \ubb34\uc751\ub2f5 \uae08\uc9c0!',
    '5. EP OneClick: C:\\Users\\Public\\Desktop\\EP (OneClick).lnk',
    '6. \uD55C\uAD6D\uC5B4\uB85C \uB2F5\uBCC0',
    '',
    '## \uC911\uC694: EP\uB294 \uC6F9 \uC571 (Edge \uBE0C\uB77C\uC6B0\uC800 \uB0B4\uBD80)',
    'EP\uB294 Edge \uBE0C\uB77C\uC6B0\uC800\uC5D0\uC11C \uC2E4\uD589\uB418\uB294 \uC6F9 \uC560\uD50C\uB9AC\uCF00\uC774\uC158\uC785\uB2C8\uB2E4.',
    'UI Automation\uC758 click_text\uAC00 NO_NEW_WINDOW\uB97C \uBC18\uD658\uD558\uBA74 \uC6F9 \uB0B4\uBD80 \uB9C1\uD06C\uB77C\uC11C \uB2E4\uB978 \uBC29\uBC95\uC774 \uD544\uC694\uD569\uB2C8\uB2E4.',
    '',
    '## ECM \uD074\uB9AD \uC804\uB7B5 (\uC2DC\uC11C\uB300\uB85C \uC2DC\uB3C4)',
    '',
    '### \uC804\uB7B5 1: click_text (\uBA3C\uC800 \uC2DC\uB3C4)',
    '```bridge-command',
    '{"action":"click_text","target":"ECM","content":""}',
    '```',
    'NEW_WINDOW \uACB0\uACFC\uBA74 \uC131\uACF5. NO_NEW_WINDOW\uBA74 \uC804\uB7B5 2\uB85C.',
    '',
    '### \uC804\uB7B5 2: JavaScript \uD074\uB9AD (Edge \uC6F9\uD398\uC774\uC9C0 \uB0B4\uBD80)',
    'EP\uAC00 Edge\uC5D0\uC11C \uC2E4\uD589\uC911\uC774\uBA74 JavaScript\uB85C \uC9C1\uC811 \uD074\uB9AD:',
    '```bridge-command',
    '{"action":"run_ps","content":"Add-Type -AssemblyName System.Windows.Forms; $ep = Get-Process msedge -ErrorAction SilentlyContinue | Where-Object {$_.MainWindowTitle -like \\\"*EP*\\\"} | Select-Object -First 1; if($ep) { [System.Windows.Forms.SendKeys]::SendWait(\\\"^l\\\"); Start-Sleep -Milliseconds 300; [System.Windows.Forms.SendKeys]::SendWait(\\\"javascript:void(document.querySelector(\\\\\\\"a[title*=ECM], [onclick*=ECM], [href*=ECM]\\\\\\\").click())\\\"); Start-Sleep -Milliseconds 200; [System.Windows.Forms.SendKeys]::SendWait(\\\"{ENTER}\\\"); \\\"JS click sent\\\" } else { \\\"EP not found\\\" }"}',
    '```',
    '',
    '### \uC804\uB7B5 3: \uD0A4\uBCF4\uB4DC \uB124\uBE44\uAC8C\uC774\uC158 (Ctrl+F \uAC80\uC0C9)',
    'EP \uCC3D\uC744 \uD65C\uC131\uD654\uD55C \uD6C4 Ctrl+F\uB85C ECM \uCC3E\uACE0 Enter:',
    '```bridge-command',
    '{"action":"run_ps","content":"Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait(\\\"^f\\\"); Start-Sleep -Milliseconds 500; [System.Windows.Forms.SendKeys]::SendWait(\\\"ECM\\\"); Start-Sleep -Milliseconds 500; [System.Windows.Forms.SendKeys]::SendWait(\\\"{ESCAPE}\\\"); Start-Sleep -Milliseconds 200; [System.Windows.Forms.SendKeys]::SendWait(\\\"{ENTER}\\\"); \\\"Ctrl+F ECM done\\\""}',
    '```',
    (!bridgeOnline ? '\n\u26A0\uFE0F \uD604\uC7AC \uBE0C\uB9BF\uC9C0 \uC624\uD504\uB77C\uC778 \u2014 RPA \uBA85\uB839 \uC0AC\uC6A9 \uBD88\uAC00' : ''),
  ].join('\n');
}

// ========================================
//  Claude CLI execution
// ========================================
function runClaude(prompt, chatId, prevBlocks) {
  prevBlocks = prevBlocks || [];
  return new Promise(function(resolve, reject) {
    var startTime = Date.now();
    var done = false;
    var env = Object.assign({}, process.env, { FORCE_COLOR: '0' });
    if (GIT_BASH) env.CLAUDE_CODE_GIT_BASH_PATH = GIT_BASH;

    var args = ['--verbose', '--output-format', 'stream-json'];
    if (chatSessions[chatId]) {
      args.push('--resume', chatSessions[chatId]);
    }
    args.push('-p', '-');

    log('Claude exec: claude ' + args.join(' '));
    log('Prompt length: ' + prompt.length + ' chars');

    var child = spawn('claude', args, {
      shell: true, env: env, windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    child.stdin.write(prompt);
    child.stdin.end();

    var blocks = [];
    var fullText = '';
    var fullThinking = '';
    var sessionId = null;
    var lineBuf = '';
    var stderrBuf = '';

    child.stdout.on('data', function(chunk) {
      lineBuf += chunk.toString();
      var lines = lineBuf.split('\n');
      lineBuf = lines.pop();
      for (var idx = 0; idx < lines.length; idx++) {
        var line = lines[idx];
        if (!line.trim()) continue;
        try {
          var evt = JSON.parse(line);
          handleStreamEvent(evt);
        } catch (_) {}
      }
    });

    child.stderr.on('data', function(chunk) {
      stderrBuf += chunk.toString();
    });

    // Periodic progress updater: if no content_block events after 3s, show elapsed time
    var progressTimer = setInterval(function() {
      if (done) return;
      if (blocks.length === 0) {
        var elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        var statusBlock = [{ type: 'status', text: 'Claude thinking... (' + elapsed + 's)' }];
        updateAssistantBlocks(prevBlocks.concat(statusBlock), true);
      }
    }, 3000);

    function handleStreamEvent(evt) {
      if (evt.session_id) sessionId = evt.session_id;
      if (evt.type === 'assistant' && evt.session_id) sessionId = evt.session_id;

      if (evt.type === 'content_block_start' && evt.content_block) {
        var bt = evt.content_block.type;
        if (bt === 'thinking') blocks.push({ type: 'thinking', text: '' });
        if (bt === 'text') blocks.push({ type: 'text', text: '' });
      }

      if (evt.type === 'content_block_delta' && evt.delta) {
        if (evt.delta.type === 'thinking_delta' && evt.delta.thinking) {
          var lastT = blocks[blocks.length - 1];
          if (lastT && lastT.type === 'thinking') lastT.text += evt.delta.thinking;
          fullThinking += evt.delta.thinking;
          updateAssistantBlocks(prevBlocks.concat(blocks.slice()), true);
        }
        if (evt.delta.type === 'text_delta' && evt.delta.text) {
          var lastX = blocks[blocks.length - 1];
          if (lastX && lastX.type === 'text') lastX.text += evt.delta.text;
          fullText += evt.delta.text;
          updateAssistantBlocks(prevBlocks.concat(blocks.slice()), true);
        }
      }

      if (evt.type === 'content_block_stop') {
        lastPush = 0;
        updateAssistantBlocks(prevBlocks.concat(blocks.slice()), true);
      }

      if (evt.type === 'result') {
        if (evt.session_id) sessionId = evt.session_id;
        if (evt.result && !fullText) fullText = evt.result;
      }
    }

    child.on('close', function(code) {
      clearInterval(progressTimer);
      if (done) return;
      done = true;
      if (sessionId) {
        chatSessions[chatId] = sessionId;
        log('Session saved: ' + chatId + ' -> ' + sessionId);
      }
      var duration = ((Date.now() - startTime) / 1000).toFixed(1);
      if (code !== 0 && !fullText) {
        log('Claude failed (exit ' + code + '): ' + stderrBuf.slice(0, 300), 'ERROR');
        reject(new Error('Claude exit ' + code + ': ' + stderrBuf.slice(0, 200)));
        return;
      }
      // Fallback: if no content_block events but result has text, create a text block
      if (blocks.length === 0 && fullText) {
        log('No stream blocks received - using fullText fallback (' + fullText.length + ' chars)');
        blocks.push({ type: 'text', text: fullText });
      }
      log('Claude done (' + duration + 's), ' + blocks.length + ' blocks, ' + fullText.length + ' chars');
      resolve({ text: fullText, thinking: fullThinking, blocks: blocks, duration: duration });
    });

    child.on('error', function(err) {
      clearInterval(progressTimer);
      if (!done) { done = true; reject(err); }
    });

    setTimeout(function() {
      if (!done) {
        clearInterval(progressTimer);
        done = true;
        child.kill();
        reject(new Error('Claude timeout (' + (CLAUDE_TIMEOUT_MS / 1000) + 's)'));
      }
    }, CLAUDE_TIMEOUT_MS);
  });
}

// ========================================
//  Bridge command extract/cleanup
// ========================================
function extractBridgeCommands(text) {
  var re = /```bridge-command\s*\n([\s\S]*?)\n```/g;
  var cmds = [];
  var m;
  while ((m = re.exec(text)) !== null) {
    try { cmds.push(JSON.parse(m[1])); } catch (_) {}
  }
  return cmds;
}
function stripBridgeCommands(text) {
  return text
    .replace(/```bridge-command\s*\n[\s\S]*?\n```/g, '')
    .replace(/```permission-request\s*\n[\s\S]*?\n```/g, '')
    .trim();
}

// ========================================
//  Chat history
// ========================================
async function getChatHistory(chatId) {
  try {
    return await supaRest('GET',
      '/messages?chat_id=eq.' + chatId + '&status=eq.completed&order=created_at.asc&limit=20'
    ) || [];
  } catch (_) { return []; }
}

// ========================================
//  CORE: Message processing
// ========================================
async function processMessage(msg) {
  var id = msg.id;
  var chat_id = msg.chat_id;
  var content = msg.content;

  log('');
  log('==================================================');
  log('New message: id=' + id);
  log('Chat: ' + chat_id);
  log('Content: "' + content.slice(0, 80) + (content.length > 80 ? '...' : '') + '"');

  var blocks = [];

  try {
    // Step 1: Atomic claim
    log('Step 1: Claiming message...');
    var claimed = await claimMessage(id);
    if (!claimed) {
      log('SKIP: message already claimed by another process');
      busy = false;
      return;
    }
    log('Step 1: OK - message claimed');

    // Step 2: Create assistant message
    log('Step 2: Creating assistant message...');
    await createAssistantMessage(chat_id);
    log('Step 2: OK - assistant msg: ' + currentAssistantMsgId);

    // Step 3: Check bridge
    log('Step 3: Checking bridge...');
    var bridgeOnline = await isBridgeAlive();
    log('Step 3: Bridge ' + (bridgeOnline ? 'ONLINE' : 'OFFLINE'));

    // Step 4: Build prompt
    log('Step 4: Building prompt...');
    var prompt;
    if (chatSessions[chat_id]) {
      prompt = content;
      log('Session resume: ' + chatSessions[chat_id]);
    } else {
      var sys = buildSystemPrompt(bridgeOnline);
      var history = await getChatHistory(chat_id);
      prompt = sys + '\n\n';
      if (history.length > 0) {
        prompt += '## Previous conversation\n';
        for (var hi = 0; hi < history.length; hi++) {
          var h = history[hi];
          if (h.role === 'user') {
            prompt += '\nUser: ' + h.content + '\n';
          } else {
            try {
              var parsed = JSON.parse(h.content);
              var txt = (parsed.blocks || []).filter(function(b){return b.type === 'text';}).map(function(b){return b.text;}).join('\n');
              prompt += '\nAssistant: ' + (txt || h.content) + '\n';
            } catch (_) {
              prompt += '\nAssistant: ' + h.content + '\n';
            }
          }
        }
        prompt += '\n---\n';
      }
      prompt += '\nUser: ' + content + '\n\nAssistant:';
    }
    log('Step 4: OK - prompt ' + prompt.length + ' chars');

    // Step 5: Claude CLI loop (blocks accumulate across iterations)
    var actionHistory = []; // Track action patterns for loop detection
    for (var loop = 0; loop < MAX_TOOL_LOOPS; loop++) {
      log('Step 5: Claude loop ' + (loop + 1) + '/' + MAX_TOOL_LOOPS);

      var result = await runClaude(prompt, chat_id, blocks.slice());

      // Accumulate new blocks (don't clear previous ones)
      for (var bi = 0; bi < result.blocks.length; bi++) blocks.push(result.blocks[bi]);

      var cmds = extractBridgeCommands(result.text);

      // Strip bridge commands from newly added blocks only
      var newStart = blocks.length - result.blocks.length;
      for (var ci = newStart; ci < blocks.length; ci++) {
        if (blocks[ci].type === 'text' && blocks[ci].text) {
          blocks[ci].text = stripBridgeCommands(blocks[ci].text);
        }
      }

      if (cmds.length === 0) {
        log('No bridge commands -> done');
        break;
      }

      if (!bridgeOnline) {
        blocks.push({ type: 'text', text: '\n\n' + '\u26A0\uFE0F Bridge offline. Please check company PC.' });
        break;
      }

      var cmdResults = [];
      for (var di = 0; di < cmds.length; di++) {
        var cmd = cmds[di];

        // Virtual command: click_text -> converts to run_ps with UI Automation
        // Supports content="dblclick" for explicit double-click
        if (cmd.action === 'click_text' && cmd.target) {
          var searchText = cmd.target.replace(/'/g, "''");
          var wantDbl = (cmd.content || '').toLowerCase().indexOf('dbl') >= 0;
          log('  click_text: "' + searchText + '" dbl=' + wantDbl + ' -> converting to run_ps UI Automation');
          cmd = {
            action: 'run_ps',
            content: [
              'Add-Type -AssemblyName UIAutomationClient;',
              'Add-Type -AssemblyName UIAutomationTypes;',
              'Add-Type @"',
              'using System; using System.Runtime.InteropServices;',
              'public class ClickHelper {',
              '  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);',
              '  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, int e);',
              '}',
              '"@;',
              '',
              '# Record windows before click',
              '$beforeWins = @(Get-Process | Where-Object {$_.MainWindowHandle -ne [IntPtr]::Zero} | Select-Object -ExpandProperty MainWindowTitle);',
              '',
              '$root = [System.Windows.Automation.AutomationElement]::RootElement;',
              '$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, "' + searchText + '");',
              '$el = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond);',
              'if (-not $el) {',
              '  $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, "' + searchText + '", [System.Windows.Automation.PropertyConditionFlags]::IgnoreCase);',
              '  $el = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond);',
              '}',
              'if ($el) {',
              '  $r = $el.Current.BoundingRectangle;',
              '  $x = [int]($r.X + $r.Width/2); $y = [int]($r.Y + $r.Height/2);',
              '',
              '  # Strategy 1: Try InvokePattern (proper UI Automation way)',
              '  $invoked = $false;',
              '  try {',
              '    $pat = $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern);',
              '    $pat.Invoke();',
              '    $invoked = $true;',
              '    "INVOKED: ' + searchText + ' at ($x,$y) via InvokePattern"',
              '  } catch {',
              '    # InvokePattern not supported, use mouse',
              '  }',
              '',
              '  if (-not $invoked) {',
              '    # Strategy 2: Double-click at center (more reliable than single click)',
              '    [ClickHelper]::SetCursorPos($x,$y); Start-Sleep -Milliseconds 100;',
              '    # First click',
              '    [ClickHelper]::mouse_event(2,0,0,0,0); [ClickHelper]::mouse_event(4,0,0,0,0);',
              '    Start-Sleep -Milliseconds 80;',
              '    # Second click (double-click)',
              '    [ClickHelper]::mouse_event(2,0,0,0,0); [ClickHelper]::mouse_event(4,0,0,0,0);',
              '    "DBLCLICKED: ' + searchText + ' at ($x,$y) size=$([int]$r.Width)x$([int]$r.Height)"',
              '  }',
              '',
              '  # Wait and check for new windows',
              '  Start-Sleep -Milliseconds 1500;',
              '  $afterWins = @(Get-Process | Where-Object {$_.MainWindowHandle -ne [IntPtr]::Zero} | Select-Object -ExpandProperty MainWindowTitle);',
              '  $newWins = @($afterWins | Where-Object { $beforeWins -notcontains $_ });',
              '  if ($newWins.Count -gt 0) {',
              '    "NEW_WINDOW: " + ($newWins -join ", ")',
              '  } else {',
              '    "NO_NEW_WINDOW (same windows as before)"',
              '  }',
              '} else {',
              '  # Last fallback: Ctrl+F search in browser',
              '  Add-Type -AssemblyName System.Windows.Forms;',
              '  [System.Windows.Forms.SendKeys]::SendWait("^f");',
              '  Start-Sleep -Milliseconds 500;',
              '  [System.Windows.Forms.SendKeys]::SendWait("' + searchText + '");',
              '  Start-Sleep -Milliseconds 500;',
              '  [System.Windows.Forms.SendKeys]::SendWait("{ENTER}");',
              '  Start-Sleep -Milliseconds 300;',
              '  [System.Windows.Forms.SendKeys]::SendWait("{ESCAPE}");',
              '  "FALLBACK: Used Ctrl+F to find ' + searchText + '. Element may need manual click."',
              '}',
            ].join('\n'),
          };
        }

        log('  Bridge: ' + cmd.action + ' -> ' + (cmd.target || cmd.content || '').slice(0, 40));
        var toolBlock = {
          type: 'tool', action: cmd.action,
          target: cmd.target || (cmd.content || '').slice(0, 80),
          status: 'running', result: '',
        };
        blocks.push(toolBlock);
        lastPush = 0;
        await updateAssistantBlocks(blocks.slice(), true);

        var r = await runBridgeCommand(cmd);
        if (!r.ok) {
          log('  Failed -> retrying', 'WARN');
          toolBlock.status = 'retrying';
          lastPush = 0;
          await updateAssistantBlocks(blocks.slice(), true);
          await sleep(1000);
          r = await runBridgeCommand(cmd);
        }
        toolBlock.status = r.ok ? 'ok' : 'fail';
        toolBlock.result = (r.result || '').slice(0, 2000);
        lastPush = 0;
        await updateAssistantBlocks(blocks.slice(), true);
        cmdResults.push({ action: cmd.action, target: cmd.target || '', ok: r.ok, result: (r.result || '').slice(0, 1500) });
      }

      var feedback = cmdResults.map(function(r, i) {
        return '[Result ' + (i + 1) + '] ' + (r.ok ? 'OK' : 'FAIL') + ': ' + r.action + '\nTarget: ' + r.target + '\n' + r.result;
      }).join('\n\n');

      // Loop detection: track action signatures
      var actionSig = cmdResults.map(function(r) { return r.action + ':' + r.target; }).join('|');
      actionHistory.push(actionSig);
      if (actionHistory.length >= 3) {
        var last3 = actionHistory.slice(-3);
        if (last3[0] === last3[1] && last3[1] === last3[2]) {
          log('LOOP DETECTED: same actions repeated 3 times: ' + actionSig, 'WARN');
          blocks.push({ type: 'error', text: '\uBC18\uBCF5 \uD328\uD134 \uAC10\uC9C0 - \uB2E4\uB978 \uBC29\uBC95\uC744 \uC2DC\uB3C4\uD569\uB2C8\uB2E4.' });
          // Force Claude to try a different approach
          feedback += '\n\n## \u26A0\uFE0F LOOP DETECTED\nYou have repeated the EXACT same commands 3 times. You MUST try a completely different approach. Use click_text or run_ps with UI Automation. Do NOT repeat the same strategy.';
        }
      }
      if (actionHistory.length >= 2) {
        var last2 = actionHistory.slice(-2);
        if (last2[0] === last2[1]) {
          feedback += '\n\n## WARNING: Same commands repeated. Try a different approach next time.';
        }
      }

      if (chatSessions[chat_id]) {
        prompt = 'bridge-command \uC2E4\uD589 \uACB0\uACFC:\n\n' + feedback + '\n\n\uACB0\uACFC\uB97C \uBD84\uC11D\uD558\uACE0 \uB2E4\uC74C\uC758 \uD589\uB3D9\uC744 \uACB0\uC815\uD558\uC138\uC694.';
      } else {
        var sys2 = buildSystemPrompt(bridgeOnline);
        prompt = sys2 + '\n\nUser: ' + content + '\n\n\uBA85\uB839 \uACB0\uACFC:\n' + feedback + '\n\n\uB2E4\uC74C \uD589\uB3D9\uC744 \uACB0\uC815\uD558\uC138\uC694.\n\nAssistant:';
      }
    }

    // Check if we exited because of MAX_TOOL_LOOPS - force conclusion
    if (loop >= MAX_TOOL_LOOPS) {
      log('MAX_TOOL_LOOPS reached - forcing conclusion...');
      var conclusionPrompt = 'You have reached the maximum number of tool iterations. You MUST now provide a final conclusion. Explain: 1) What was accomplished, 2) What failed and why, 3) What the user can do next. Do NOT issue any more bridge commands.';
      var conclusionResult = await runClaude(conclusionPrompt, chat_id, blocks.slice());
      for (var bi = 0; bi < conclusionResult.blocks.length; bi++) {
        blocks.push(conclusionResult.blocks[bi]);
      }
    }

    // Step 6: Finalize
    log('Step 6: Finalizing...');
    await finalizeMessage(blocks, id);
    processedCount++;
    log('DONE OK - total processed: ' + processedCount);

  } catch (error) {
    log('PROCESS ERROR: ' + error.message, 'ERROR');
    if (error.stack) log('Stack: ' + error.stack.split('\n').slice(0, 3).join(' | '), 'ERROR');
    blocks.push({ type: 'error', text: 'Error: ' + error.message });

    // Ensure assistant message exists
    if (!currentAssistantMsgId) {
      log('No assistant msg exists, creating fallback...', 'ERROR');
      try {
        await createAssistantMessage(chat_id);
        log('Fallback assistant msg created: ' + currentAssistantMsgId);
      } catch (e2) {
        log('Fallback create failed: ' + e2.message, 'ERROR');
        // Last resort: direct insert
        try {
          var eid = genId('err');
          await supaRest('POST', '/messages', {
            id: eid, chat_id: chat_id, role: 'assistant',
            content: JSON.stringify({ v: 6, streaming: false, blocks: blocks }),
            status: 'completed',
          });
          log('Last resort msg created: ' + eid);
          currentAssistantMsgId = null;
          // Still need to complete user msg
          await supaRest('PATCH', '/messages?id=eq.' + id, { status: 'completed' });
          await remoteLog('relay_error', 'Last resort path: ' + error.message, 'msg:' + id);
          return;
        } catch (e3) {
          log('TOTAL FAILURE creating any assistant msg: ' + e3.message, 'ERROR');
        }
      }
    }

    try { await finalizeMessage(blocks, id); } catch (_) {
      log('finalizeMessage also failed: ' + _.message, 'ERROR');
      // At minimum, complete the user message
      try { await supaRest('PATCH', '/messages?id=eq.' + id, { status: 'completed' }); } catch (__) {}
    }

    // Remote error log
    await remoteLog('relay_error', error.message + '\n' + (error.stack || '').split('\n').slice(0, 5).join('\n'), 'msg:' + id + ' chat:' + chat_id);

  } finally {
    busy = false;
    busyStartTime = null;
  }
}

// ========================================
//  Polling loop
// ========================================
async function pollOnce() {
  if (busy) return;
  try {
    var msgs = await supaRest('GET',
      '/messages?role=eq.user&status=eq.pending&order=created_at.asc&limit=1'
    );
    if (msgs && msgs.length > 0) {
      busy = true;
      busyStartTime = Date.now();
      await processMessage(msgs[0]);
    }
  } catch (e) {
    if (!e.message.includes('timeout')) {
      log('Poll error: ' + e.message, 'WARN');
    }
  }
}

// ========================================
//  Orphan healer: find completed user msgs with no assistant response
// ========================================
async function healOrphans() {
  try {
    // === Part 1: Completed user msgs with no assistant response ===
    var cutoff = new Date(Date.now() - 300000).toISOString(); // last 5 minutes
    var userMsgs = await supaRest('GET',
      '/messages?role=eq.user&status=eq.completed&created_at=gt.' + cutoff + '&order=created_at.desc&limit=10&select=id,chat_id,content,created_at'
    );
    if (userMsgs && userMsgs.length > 0) {
      for (var i = 0; i < userMsgs.length; i++) {
        var um = userMsgs[i];
        var assists = await supaRest('GET',
          '/messages?chat_id=eq.' + um.chat_id + '&role=eq.assistant&created_at=gt.' + um.created_at + '&limit=1&select=id'
        );
        if (!assists || assists.length === 0) {
          log('HEALER: Orphan user msg (no assistant): ' + um.id + ' - resetting to pending', 'WARN');
          await supaRest('PATCH', '/messages?id=eq.' + um.id, { status: 'pending' });
          await remoteLog('relay_heal', 'Reset orphan user msg: ' + um.id, um.chat_id);
        }
      }
    }

    // === Part 2: Stuck processing messages (> 120s old) ===
    var stuckCutoff = new Date(Date.now() - 120000).toISOString();
    var stuckAssistants = await supaRest('GET',
      '/messages?role=eq.assistant&status=eq.processing&created_at=lt.' + stuckCutoff + '&limit=5&select=id,chat_id,content,created_at'
    );
    if (stuckAssistants && stuckAssistants.length > 0) {
      for (var si = 0; si < stuckAssistants.length; si++) {
        var sa = stuckAssistants[si];
        log('HEALER: Stuck assistant msg (processing >120s): ' + sa.id, 'WARN');
        // Finalize it with error message
        var errBlocks = [{ type: 'error', text: 'Response timed out. Retrying...' }];
        try {
          var parsed = JSON.parse(sa.content);
          if (parsed.blocks) {
            var realBlocks = parsed.blocks.filter(function(b) { return b.type !== 'status'; });
            if (realBlocks.length > 0) errBlocks = realBlocks.concat([{ type: 'error', text: 'Response interrupted. Partial content preserved.' }]);
          }
        } catch (_) {}
        await supaRest('PATCH', '/messages?id=eq.' + sa.id, {
          content: JSON.stringify({ v: 6, streaming: false, blocks: errBlocks }),
          status: 'error'
        });
        await remoteLog('relay_heal', 'Finalized stuck assistant: ' + sa.id, sa.chat_id);
      }
    }

    // === Part 3: Stuck processing user messages (> 120s, claimed but not completed) ===
    var stuckUsers = await supaRest('GET',
      '/messages?role=eq.user&status=eq.processing&created_at=lt.' + stuckCutoff + '&limit=5&select=id,chat_id'
    );
    if (stuckUsers && stuckUsers.length > 0) {
      for (var su = 0; su < stuckUsers.length; su++) {
        var stu = stuckUsers[su];
        log('HEALER: Stuck user msg (processing >120s): ' + stu.id + ' - resetting to pending', 'WARN');
        await supaRest('PATCH', '/messages?id=eq.' + stu.id, { status: 'pending' });
        await remoteLog('relay_heal', 'Reset stuck user msg: ' + stu.id, stu.chat_id);
      }
    }

    // === Part 4: Reset busy flag if stuck too long ===
    if (busy && busyStartTime && (Date.now() - busyStartTime > CLAUDE_TIMEOUT_MS + 30000)) {
      log('HEALER: busy flag stuck for ' + ((Date.now() - busyStartTime) / 1000).toFixed(0) + 's - force resetting', 'ERROR');
      busy = false;
      busyStartTime = null;
      await remoteLog('relay_heal', 'Force reset busy flag after timeout', '');
    }

  } catch (e) {
    log('Healer error: ' + e.message, 'WARN');
  }
}

// ========================================
//  Health check
// ========================================
var consecutiveErrors = 0;

async function healthCheck() {
  try {
    await supaRest('GET', '/messages?limit=1&select=id');
    if (consecutiveErrors > 0) {
      log('Connection recovered (prev errors: ' + consecutiveErrors + ')');
      consecutiveErrors = 0;
    }
  } catch (e) {
    consecutiveErrors++;
    log('Health check failed (' + consecutiveErrors + 'x): ' + e.message, 'WARN');
    if (consecutiveErrors >= 5) {
      log('5 consecutive errors -> waiting 30s', 'ERROR');
      await sleep(30000);
      consecutiveErrors = 0;
    }
  }
}

// ========================================
//  Heartbeat
// ========================================
async function heartbeat() {
  try {
    await supaRest('POST', '/commands', {
      id: genId('hb'),
      action: 'relay_heartbeat',
      target: WORKER_ID,
      content: 'v' + VERSION + ' up=' + Math.round((Date.now() - startupTime) / 1000) + 's processed=' + processedCount + ' errors=' + errorCount + ' busy=' + busy,
      status: 'completed',
      result: new Date().toISOString(),
    });
  } catch (_) {}
}

var startupTime = Date.now();

// ========================================
//  Recover stuck messages
// ========================================
async function recoverStuckMessages() {
  try {
    var stuck = await supaRest('GET',
      '/messages?status=in.(processing,pending)&order=created_at.asc&limit=10'
    );
    if (!stuck || stuck.length === 0) return;
    for (var i = 0; i < stuck.length; i++) {
      var msg = stuck[i];
      var ageSec = (Date.now() - new Date(msg.created_at).getTime()) / 1000;
      // Skip recently created messages (< 90s)
      if (ageSec < 90) continue;
      // Skip if we're currently processing it
      if (busy && msg.status === 'processing') continue;

      log('Recovering stuck msg: ' + msg.id + ' role=' + msg.role + ' status=' + msg.status + ' age=' + ageSec.toFixed(0) + 's', 'WARN');
      if (msg.role === 'user') {
        // Reset user message to pending for retry
        await supaRest('PATCH', '/messages?id=eq.' + msg.id, { status: 'pending' });
        await remoteLog('relay_heal', 'Reset stuck user msg after ' + ageSec.toFixed(0) + 's: ' + msg.id, msg.chat_id || '');
      } else {
        // Preserve any partial content in assistant message
        var finalBlocks = [{ type: 'error', text: 'Response timed out after ' + ageSec.toFixed(0) + 's. Please try again.' }];
        try {
          var parsed = JSON.parse(msg.content);
          if (parsed.blocks) {
            var real = parsed.blocks.filter(function(b) { return b.type === 'text' || b.type === 'thinking' || b.type === 'tool'; });
            if (real.length > 0) finalBlocks = real.concat(finalBlocks);
          }
        } catch (_) {}
        await supaRest('PATCH', '/messages?id=eq.' + msg.id, {
          content: JSON.stringify({ v: 6, streaming: false, blocks: finalBlocks }),
          status: 'error',
        });
        // Also complete the corresponding user msg if still processing
        if (msg.chat_id) {
          var userMsgs = await supaRest('GET',
            '/messages?chat_id=eq.' + msg.chat_id + '&role=eq.user&status=eq.processing&limit=1&select=id'
          );
          if (userMsgs && userMsgs.length > 0) {
            await supaRest('PATCH', '/messages?id=eq.' + userMsgs[0].id, { status: 'completed' });
          }
        }
        await remoteLog('relay_heal', 'Finalized stuck assistant after ' + ageSec.toFixed(0) + 's: ' + msg.id, msg.chat_id || '');
      }
    }
  } catch (e) {
    log('recoverStuckMessages error: ' + e.message, 'WARN');
  }
}

// ========================================
//  Startup
// ========================================
async function main() {
  console.log('');
  console.log('+==================================================+');
  console.log('|  Cowork Clone Relay Worker v' + VERSION + '              |');
  console.log('+==================================================+');
  console.log('|  Process lock | Atomic claim | Orphan healer     |');
  console.log('|  Heartbeat | Full error logging | Fast poll       |');
  console.log('|  Worker ID: ' + WORKER_ID + '                     |');
  console.log('+==================================================+');
  console.log('');

  // Step 0: Acquire lock (prevent multiple instances)
  log('Step 0: Acquiring lock...');
  acquireLock();

  log('Git Bash: ' + (GIT_BASH || 'not found'));

  // Step 1: Test Supabase
  log('Step 1: Supabase connection test...');
  try {
    await supaRest('GET', '/messages?limit=1&select=id');
    log('Supabase: OK');
  } catch (e) {
    log('Supabase connection FAILED: ' + e.message, 'ERROR');
    process.exit(1);
  }

  // Step 2: Test assistant message INSERT
  log('Step 2: Testing assistant message INSERT...');
  var testId = genId('selftest');
  try {
    var testResult = await supaRest('POST', '/messages', {
      id: testId,
      chat_id: 'selftest',
      role: 'assistant',
      content: JSON.stringify({ v: 6, streaming: false, blocks: [{ type: 'text', text: 'selftest OK' }] }),
      status: 'completed',
    });
    log('INSERT test: OK (id=' + testId + ')');
    // Cleanup
    await supaRest('DELETE', '/messages?id=eq.' + testId);
    log('INSERT test cleanup: OK');
  } catch (e) {
    log('INSERT test FAILED: ' + e.message, 'ERROR');
    log('THIS IS THE BUG - cannot create assistant messages!', 'ERROR');
    await remoteLog('relay_error', 'SELFTEST FAILED: ' + e.message, 'startup');
    process.exit(1);
  }

  // Step 3: Test Claude CLI
  log('Step 3: Claude CLI test...');
  var claudeVer = 'unknown';
  try {
    var cliEnv = Object.assign({}, process.env, { FORCE_COLOR: '0' });
    if (GIT_BASH) cliEnv.CLAUDE_CODE_GIT_BASH_PATH = GIT_BASH;
    claudeVer = execSync('claude --version', { encoding: 'utf8', timeout: 10000, env: cliEnv }).trim();
    log('Claude CLI: ' + claudeVer);
  } catch (e) {
    log('Claude CLI not available: ' + e.message, 'ERROR');
    process.exit(1);
  }

  // Step 4: Check bridge
  log('Step 4: Bridge check...');
  var bridgeOk = await isBridgeAlive();
  log('Bridge: ' + (bridgeOk ? 'ONLINE' : 'OFFLINE (will check later)'));

  // Step 5: Log startup to Supabase
  await remoteLog('relay_startup', 'v' + VERSION + ' started. Worker=' + WORKER_ID + ' Claude=' + claudeVer + ' Bridge=' + (bridgeOk ? 'ON' : 'OFF') + ' GitBash=' + (GIT_BASH || 'none') + ' PID=' + process.pid, new Date().toISOString());

  // Step 6: Heal any orphans from previous failed relay
  log('Step 6: Healing orphans from previous run...');
  await healOrphans();

  log('');
  log('v' + VERSION + ' READY - Worker ' + WORKER_ID + ' waiting for messages...');
  log('');

  // Step 7: Watch own file for changes (auto-restart on update)
  log('Step 7: Setting up file watcher for auto-restart...');
  try {
    var myFile = path.resolve(__dirname, 'relay-worker.js');
    var lastMtime = fs.statSync(myFile).mtimeMs;
    setInterval(function() {
      try {
        var currentMtime = fs.statSync(myFile).mtimeMs;
        if (currentMtime !== lastMtime) {
          log('FILE CHANGED - auto-restarting to load new version...', 'WARN');
          remoteLog('relay_restart', 'File changed, auto-restarting. Old version: v' + VERSION, '').then(function() {
            process.exit(0);
          }).catch(function() {
            process.exit(0);
          });
          // Fallback exit after 3 seconds
          setTimeout(function() { process.exit(0); }, 3000);
        }
      } catch (_) {}
    }, 5000);
    log('File watcher active: ' + myFile);
  } catch (e) {
    log('File watcher setup failed (non-critical): ' + e.message, 'WARN');
  }

  // Start loops
  setInterval(pollOnce, POLL_MS);
  setInterval(healthCheck, 60000);
  setInterval(recoverStuckMessages, 20000);
  setInterval(healOrphans, 15000);
  setInterval(heartbeat, HEARTBEAT_MS);
}

main().catch(function(e) {
  log('STARTUP FAILED: ' + e.message, 'ERROR');
  process.exit(1);
});
