/**
 * Remote Bridge Relay Worker v6
 * - Uses local Claude CLI (claude --print) via Max plan subscription
 * - No API key required, no additional billing
 * - Polls Supabase for commands from company PC
 */

const { createClient } = require('@supabase/supabase-js');
const { spawn } = require('child_process');

const CONFIG = {
  supaUrl: 'https://rnnigyfzwlgojxyccgsm.supabase.co',
  supaKey: 'sb_publishable_Nmv51BZccADB0bN5JY2URw_lLffyFgE',
  pollInterval: 3000,
  claudeTimeout: 300000,
  maxHistory: 20,
  heartbeatInterval: 30000,
};

const supabase = createClient(CONFIG.supaUrl, CONFIG.supaKey);
const conversationHistory = [];
let isProcessing = false;
let workerId = null;

async function sendHeartbeat() {
  try {
    await supabase.from('commands').upsert({
      id: 'heartbeat', status: 'heartbeat',
      created_at: new Date().toISOString(), worker_id: workerId,
    }, { onConflict: 'id' });
  } catch (e) {}
}

function runClaude(prompt, history) {
  return new Promise((resolve, reject) => {
    let fullPrompt = prompt;
    if (history.length > 0) {
      const ctx = history.map(h => `${h.role === 'user' ? 'Human' : 'Assistant'}: ${h.content}`).join('\n\n');
      fullPrompt = `${ctx}\n\nHuman: ${prompt}`;
    }
    const proc = spawn('claude', ['--print', fullPrompt], {
      timeout: CONFIG.claudeTimeout, env: process.env,
    });
    let output = '', err = '';
    proc.stdout.on('data', d => { output += d.toString(); });
    proc.stderr.on('data', d => { err += d.toString(); });
    proc.on('close', code => {
      if (code === 0) resolve(output.trim());
      else reject(new Error(`claude exited ${code}: ${err}`));
    });
    proc.on('error', e => reject(new Error(`spawn failed: ${e.message}`)));
  });
}

async function processCommand(command) {
  const { id, message, session_id } = command;
  console.log(`[Worker] ${id}: "${String(message).substring(0, 60)}"`);

  await supabase.from('commands').update({
    status: 'processing', started_at: new Date().toISOString(),
  }).eq('id', id);

  try {
    const hist = conversationHistory.filter(h => h.session_id === session_id).slice(-CONFIG.maxHistory);
    const response = await runClaude(message, hist);

    conversationHistory.push({ role: 'user', content: message, session_id });
    conversationHistory.push({ role: 'assistant', content: response, session_id });
    while (conversationHistory.length > CONFIG.maxHistory * 2) conversationHistory.shift();

    await supabase.from('results').insert({
      command_id: id, session_id, content: response, created_at: new Date().toISOString(),
    });
    await supabase.from('commands').update({
      status: 'completed', completed_at: new Date().toISOString(),
    }).eq('id', id);
    console.log(`[Worker] Done: ${id}`);
  } catch (e) {
    console.error(`[Worker] Error: ${e.message}`);
    await supabase.from('results').insert({
      command_id: id, session_id, content: `[ERROR] ${e.message}`, created_at: new Date().toISOString(),
    });
    await supabase.from('commands').update({
      status: 'error', completed_at: new Date().toISOString(),
    }).eq('id', id);
  }
}

async function poll() {
  if (isProcessing) return;
  try {
    const { data, error } = await supabase
      .from('commands').select('*')
      .eq('status', 'pending').order('created_at', { ascending: true }).limit(1);
    if (error || !data || data.length === 0) return;
    isProcessing = true;
    await processCommand(data[0]);
    isProcessing = false;
  } catch (e) { console.error('[Poll]', e.message); isProcessing = false; }
}

async function main() {
  workerId = `worker-${Date.now()}`;
  console.log('[Relay] Remote Bridge Relay Worker v6');
  console.log('[Relay] Using local Claude CLI (Max plan) - no API key needed');
  console.log(`[Relay] Supabase: ${CONFIG.supaUrl}`);
  console.log('');

  const { execSync } = require('child_process');
  try {
    execSync('claude --version', { stdio: 'pipe' });
    console.log('[OK] Claude CLI found');
  } catch (e) {
    console.error('[ERROR] Claude CLI not found. Install from https://claude.ai/download');
    process.exit(1);
  }

  sendHeartbeat();
  setInterval(sendHeartbeat, CONFIG.heartbeatInterval);
  setInterval(poll, CONFIG.pollInterval);
  poll();
}

main().catch(e => { console.error('[FATAL]', e.message); process.exit(1); });
