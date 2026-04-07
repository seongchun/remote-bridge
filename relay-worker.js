/**
 * Remote Bridge Relay Worker v7
 * - Watches 'messages' table (not 'commands') for pending user messages
 * - Uses local Claude CLI (claude --print) via Max plan - no API key needed
 * Schema: messages { id, chat_id, role, content, status, created_at, attachments }
 */

const { createClient } = require('@supabase/supabase-js');
const { spawn } = require('child_process');
const { execSync } = require('child_process');
const crypto = require('crypto');

const CONFIG = {
  supaUrl: 'https://rnnigyfzwlgojxyccgsm.supabase.co',
  supaKey: 'sb_publishable_Nmv51BZccADB0bN5JY2URw_lLffyFgE',
  pollInterval: 3000,
  claudeTimeout: 300000,
  heartbeatInterval: 20000,
};

const supabase = createClient(CONFIG.supaUrl, CONFIG.supaKey);
let isProcessing = false;

// ─── Heartbeat ────────────────────────────────────────────
async function sendHeartbeat(busy = false) {
  try {
    await supabase.from('commands').upsert({
      id: 'relay-heartbeat',
      content: busy ? 'busy' : 'idle',
      status: 'heartbeat',
      updated_at: new Date().toISOString(),
    }, { onConflict: 'id' });
  } catch (e) { /* silent */ }
}

// ─── Run Claude CLI ────────────────────────────────────────────
function runClaude(prompt) {
  return new Promise((resolve, reject) => {
    const proc = spawn('claude', ['--print', prompt], {
      timeout: CONFIG.claudeTimeout,
      env: process.env,
    });
    let output = '', errOut = '';
    proc.stdout.on('data', d => { output += d.toString(); });
    proc.stderr.on('data', d => { errOut += d.toString(); });
    proc.on('close', code => {
      if (code === 0) resolve(output.trim());
      else reject(new Error(`claude exited ${code}: ${errOut.substring(0, 200)}`));
    });
    proc.on('error', e => reject(new Error(`spawn failed: ${e.message}`)));
  });
}

// ─── Build conversation prompt ────────────────────────────────────────────
async function buildPrompt(chatId, currentContent) {
  try {
    const { data } = await supabase
      .from('messages')
      .select('role, content')
      .eq('chat_id', chatId)
      .eq('status', 'completed')
      .order('created_at', { ascending: true })
      .limit(20);

    if (!data || data.length === 0) return currentContent;

    const history = data
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => `${m.role === 'user' ? 'Human' : 'Assistant'}: ${m.content}`)
      .join('\n\n');

    return `${history}\n\nHuman: ${currentContent}`;
  } catch (e) {
    return currentContent;
  }
}

// ─── Process a pending message ────────────────────────────────────────────
async function processMessage(msg) {
  const { id, chat_id, content } = msg;
  console.log(`[Worker] Processing: "${String(content).substring(0, 60)}"`);

  await supabase.from('messages').update({ status: 'processing' }).eq('id', id);
  await sendHeartbeat(true);

  try {
    const prompt = await buildPrompt(chat_id, content);
    const response = await runClaude(prompt);

    const responseId = crypto.randomUUID ? crypto.randomUUID() : `resp-${Date.now()}`;
    await supabase.from('messages').insert({
      id: responseId,
      chat_id,
      role: 'assistant',
      content: response,
      status: 'completed',
      created_at: new Date().toISOString(),
    });

    await supabase.from('messages').update({ status: 'completed' }).eq('id', id);
    console.log(`[Worker] Done: ${responseId.substring(0, 8)}...`);

  } catch (err) {
    console.error(`[Worker] Error: ${err.message}`);

    await supabase.from('messages').insert({
      id: `err-${Date.now()}`,
      chat_id,
      role: 'assistant',
      content: `[\uC624\uB958] ${err.message}`,
      status: 'error',
      created_at: new Date().toISOString(),
    });

    await supabase.from('messages').update({ status: 'error' }).eq('id', id);
  }

  await sendHeartbeat(false);
}

// ─── Poll loop ────────────────────────────────────────────
async function poll() {
  if (isProcessing) return;
  try {
    const { data, error } = await supabase
      .from('messages')
      .select('*')
      .eq('role', 'user')
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(1);

    if (error) { console.error('[Poll]', error.message); return; }
    if (!data || data.length === 0) return;

    isProcessing = true;
    await processMessage(data[0]);
    isProcessing = false;
  } catch (e) {
    console.error('[Poll] Exception:', e.message);
    isProcessing = false;
  }
}

// ─── Main ────────────────────────────────────────────
async function main() {
  console.log('[Relay] Remote Bridge Relay Worker v7');
  console.log('[Relay] Max plan (Claude CLI) - no API key needed');
  console.log(`[Relay] Supabase: ${CONFIG.supaUrl}`);
  console.log('');

  try {
    const ver = execSync('claude --version', { stdio: 'pipe' }).toString().trim();
    console.log(`[OK] Claude CLI: ${ver}`);
  } catch (e) {
    console.error('[ERROR] Claude CLI not found. Install from https://claude.ai/download');
    process.exit(1);
  }

  try {
    const { error } = await supabase.from('messages').select('id').limit(1);
    if (error) throw new Error(error.message);
    console.log('[OK] Supabase connected');
  } catch (e) {
    console.error('[ERROR] Supabase connection failed:', e.message);
    process.exit(1);
  }

  console.log('[OK] Ready. Waiting for messages...\n');

  sendHeartbeat(false);
  setInterval(() => sendHeartbeat(isProcessing), CONFIG.heartbeatInterval);
  setInterval(poll, CONFIG.pollInterval);
  poll();
}

main().catch(e => { console.error('[FATAL]', e.message); process.exit(1); });
