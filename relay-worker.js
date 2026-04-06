#!/usr/bin/env node
/**
 * Cowork Relay Worker v5.0 - Home PC
 * CHANGE: Anthropic API 직접 호출 (claude CLI 불필요)
 * SETUP:  set ANTHROPIC_API_KEY=sk-ant-xxxxxxxx  (CMD)
 *         $env:ANTHROPIC_API_KEY="sk-ant-xxxxxxxx" (PowerShell)
 *         node relay-worker-v5.js
 */
const https   = require('https');
const { URL } = require('url');

const CONFIG = {
  supaUrl:          'https://rnnigyfzwlgojxyccgsm.supabase.co',
  supaKey:          'sb_publishable_Nmv51BZccADB0bN5JY2URw_lLffyFgE',
  anthropicApiKey:  process.env.ANTHROPIC_API_KEY || '',
  anthropicModel:   process.env.ANTHROPIC_MODEL   || 'claude-sonnet-4-5',
  pollInterval:     5000,
  claudeTimeout:    180000,
  maxHistory:       20,
  bridgeTimeout:    30000,
  maxLoops:         8,
  maxTokens:        8192,
};

let isRunning   = true;
let processing  = false;
let streamMsgId = null;

function log(msg, lv='INFO') {
  const ts = new Date().toLocaleString('ko-KR',{timeZone:'Asia/Seoul'});
  console.log(`[${ts}] [${lv}] ${msg}`);
}
function genId() { return 'r5-'+Date.now().toString(36)+'-'+Math.random().toString(36).substr(2,8); }
function sleep(ms) { return new Promise(r=>setTimeout(r,ms)); }

function buildSys(bridgeAlive) {
  return `당신은 회사 PC RPA 어시스턴트입니다. 사용자(Steel Heart, POSCO)가 집 PC 릴레이를 통해 대화합니다.
회사 PC의 화면을 보고, 마우스를 클릭하고, 키보드를 입력하고, 파일을 조작할 수 있습니다.

## 절대 규칙: 포기하지 마라
- 실패하면 반드시 다른 방법으로 재시도. 최소 3가지 다른 방법 시도 후에야 불가 보고 가능
- 실패 결과만 보여주는 것은 금지. 반드시 대안을 시도하라

## 실시간 서술 규칙
- 모든 사고과정과 행동을 사용자가 실시간으로 읽는다. 옆에서 설명하듯 써라
- bridge-command 실행 전 의도를 반드시 먼저 설명
- bridge-command 사이사이에 설명 텍스트를 넣어라

## 브리지 상태: ${bridgeAlive ? '✅ 온라인' : '❌ 오프라인'}

## bridge-command 형식
\`\`\`bridge-command
{"action":"screenshot","target":"","content":"800"}
\`\`\`

## 사용 가능한 액션
- run_ps: PowerShell 실행. content=명령어
- run_cmd: CMD 실행. content=명령어
- read_file: 파일 읽기. target=경로
- write_file: 파일 쓰기. target=경로, content=내용
- list_dir: 폴더 목록. target=경로
- screenshot: 화면 캡처. content=해상도(기본800)
- click: 마우스 클릭. content={"x":100,"y":200,"button":"left"}
- double_click: 더블클릭. content={"x":100,"y":200}
- type_text: 키보드 입력. content=텍스트
- key_send: 단축키. content=SendKeys형식
- list_windows: 열린 창 목록
- activate_window: 창 활성화. content=창 제목 일부
- start_app: 앱 실행. target=경로

## 회사 PC 정보
- 바탕화면: C:\\Users\\Public\\Desktop
- EP OneClick: C:\\Users\\Public\\Desktop\\EP (OneClick).lnk
- 한국어로 답변${!bridgeAlive?'\n\n⚠️ 브리지 오프라인 - GUI 명령 사용 불가':''}`;
}

function httpsReq(opts, body, timeout=30000) {
  return new Promise((res,rej)=>{
    const req=https.request(opts, r=>{
      let d=''; r.on('data',c=>d+=c);
      r.on('end',()=>{ if(r.statusCode>=400){rej(new Error('HTTP '+r.statusCode+': '+d.slice(0,300)))} else{try{res(JSON.parse(d))}catch(e){res(d)}} });
    });
    req.on('error',rej);
    req.setTimeout(timeout,()=>{req.destroy();rej(new Error('timeout'))});
    if(body) req.write(typeof body==='string'?body:JSON.stringify(body));
    req.end();
  });
}

function supaFetch(method, path, body=null) {
  const u=new URL(CONFIG.supaUrl+'/rest/v1'+path);
  return httpsReq({hostname:u.hostname,port:443,path:u.pathname+u.search,method,
    headers:{'apikey':CONFIG.supaKey,'Authorization':'Bearer '+CONFIG.supaKey,
             'Content-Type':'application/json','Prefer':'return=representation'}
  },body,20000);
}

async function callClaude(messages, systemPrompt) {
  if (!CONFIG.anthropicApiKey) throw new Error('ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다.\n설정: $env:ANTHROPIC_API_KEY="sk-ant-..."');
  const body={model:CONFIG.anthropicModel,max_tokens:CONFIG.maxTokens,system:systemPrompt,messages};
  const start=Date.now();
  log(`API call (model:${CONFIG.anthropicModel}, msgs:${messages.length})`);
  const r=await httpsReq({
    hostname:'api.anthropic.com',port:443,path:'/v1/messages',method:'POST',
    headers:{'anthropic-api-key':CONFIG.anthropicApiKey,'anthropic-version':'2023-06-01','content-type':'application/json'}
  },body,CONFIG.claudeTimeout);
  if(!r.content?.length) throw new Error('Empty Anthropic response');
  const text=r.content.filter(b=>b.type==='text').map(b=>b.text).join('');
  if(!text) throw new Error('No text in response');
  const dur=((Date.now()-start)/1000).toFixed(1)+'s';
  log(`API OK (${dur}, in:${r.usage?.input_tokens||'?'} out:${r.usage?.output_tokens||'?'})`);
  return {text,duration:dur};
}

async function createStreamMsg(chatId) {
  streamMsgId='stream-'+genId();
  await supaFetch('POST','/messages',{id:streamMsgId,chat_id:chatId,role:'assistant',
    content:JSON.stringify({text:'',tools:[],step:'요청 처리 시작...',loop:0,steps:[]}),status:'streaming'});
  return streamMsgId;
}
async function updateStreamMsg(data) {
  if(!streamMsgId) return;
  try{ await supaFetch('PATCH','/messages?id=eq.'+streamMsgId,{content:JSON.stringify(data),status:'streaming'}); }
  catch(e){log('Stream update failed: '+e.message,'WARN');}
}
async function finalizeStreamMsg(chatId,userMsgId,data) {
  if(streamMsgId){
    await supaFetch('PATCH','/messages?id=eq.'+streamMsgId,{content:JSON.stringify(data),status:'completed'});
  } else {
    await supaFetch('POST','/messages',{id:genId(),chat_id:chatId,role:'assistant',content:JSON.stringify(data),status:'completed'});
  }
  await supaFetch('PATCH','/messages?id=eq.'+userMsgId,{status:'completed'});
  streamMsgId=null;
  log('Finalized (loops:'+(data.loops||1)+')');
}

async function checkBridge() {
  try {
    const r=await supaFetch('GET','/commands?status=eq.completed&order=created_at.desc&limit=1&select=id,created_at');
    if(r&&r.length){const mins=(Date.now()-new Date(r[0].created_at))/60000;if(mins<5)return{alive:true};}
    const ok=await quickPing();
    return{alive:ok};
  }catch(e){return{alive:false};}
}
async function quickPing() {
  try {
    const pid='ping-'+Date.now();
    await supaFetch('POST','/commands',{id:pid,action:'ping',target:'',content:'',status:'pending'});
    for(let i=0;i<4;i++){
      await sleep(2000);
      const[res]=await supaFetch('GET','/commands?id=eq.'+pid+'&select=status');
      if(res&&res.status==='completed'){supaFetch('DELETE','/commands?id=eq.'+pid).catch(()=>{});return true;}
    }
    supaFetch('DELETE','/commands?id=eq.'+pid).catch(()=>{});
    return false;
  }catch(e){return false;}
}
async function execBridgeCmd(cmd) {
  const cid='auto-'+Date.now()+'-'+Math.random().toString(36).substr(2,4);
  await supaFetch('POST','/commands',{id:cid,action:cmd.action,target:cmd.target||'',content:cmd.content||'',status:'pending'});
  for(let i=0;i<Math.ceil(CONFIG.bridgeTimeout/2000);i++){
    await sleep(2000);
    try{
      const[res]=await supaFetch('GET','/commands?id=eq.'+cid+'&select=status,result');
      if(res&&(res.status==='completed'||res.status==='error')){
        supaFetch('DELETE','/commands?id=eq.'+cid).catch(()=>{});
        return{ok:res.status==='completed',result:res.result||''};
      }
    }catch(e){}
  }
  supaFetch('DELETE','/commands?id=eq.'+cid).catch(()=>{});
  return{ok:false,result:'(브리지 타임아웃)'};
}

function extractCmds(text){
  const rx=/```bridge-command\s*\n([\s\S]*?)\n```/g,cmds=[];let m;
  while((m=rx.exec(text))!==null){try{cmds.push(JSON.parse(m[1]))}catch(e){}}
  return cmds;
}
function cleanText(text){ return text.replace(/```bridge-command\s*\n[\s\S]*?\n```/g,'').trim(); }

async function getHistory(chatId) {
  try{return(await supaFetch('GET',`/messages?chat_id=eq.${chatId}&status=eq.completed&order=created_at.asc&limit=${CONFIG.maxHistory}`))||[];}
  catch(e){return[];}
}
function buildMsgs(history,userMsg,prevAssist,toolRes) {
  const msgs=[];
  history.forEach(h=>{
    if(h.role==='user'){msgs.push({role:'user',content:h.content});}
    else{let t=h.content;try{const p=JSON.parse(h.content);t=p.text||t;}catch(e){}msgs.push({role:'assistant',content:t});}
  });
  if(prevAssist&&toolRes){
    msgs.push({role:'user',content:userMsg});
    msgs.push({role:'assistant',content:prevAssist});
    msgs.push({role:'user',content:'--- 명령 실행 결과 ---\n'+toolRes+'\n\n위 결과를 바탕으로 다음 행동을 결정하세요. 포기하지 말고 계속 진행하세요.'});
  } else {
    msgs.push({role:'user',content:userMsg});
  }
  return msgs;
}

async function processMessage(msg) {
  const{id,chat_id,content}=msg;
  log(`Msg: "${content.slice(0,60)}${content.length>60?'...':''}"`);
  const tools=[],steps=[];
  let finalText='',totalDur=0;
  try {
    await supaFetch('PATCH','/messages?id=eq.'+id,{status:'processing'});
    await createStreamMsg(chat_id);
    await updateStreamMsg({text:'',tools:[],step:'🔄 요청 처리 시작...',loop:0,steps:['요청 처리 시작...']});
    const bridge=await checkBridge();
    log('Bridge: '+(bridge.alive?'ALIVE':'OFFLINE'));
    const history=await getHistory(chat_id);
    const sys=buildSys(bridge.alive);
    let userMsg=content;
    if(content.startsWith('[HOME]')) userMsg='[집PC작업] '+content.slice(6).trim();
    let prevText=null,toolRes=null;
    for(let loop=0;loop<CONFIG.maxLoops;loop++){
      log(`Loop ${loop+1}/${CONFIG.maxLoops}`);
      steps.push(`🧠 Claude에게 분석 요청 중... (루프 ${loop+1})`);
      await updateStreamMsg({text:finalText||'',tools,step:steps[steps.length-1],loop:loop+1,steps:steps.slice(-12)});
      const apiMsgs=buildMsgs(history,userMsg,prevText,toolRes);
      const result=await callClaude(apiMsgs,sys);
      totalDur+=parseFloat(result.duration);
      const cmds=extractCmds(result.text);
      const clean=cleanText(result.text);
      steps.push(`📝 응답 수신 (${result.duration})`);
      if(clean) steps.push(`💬 ${clean.slice(0,100)}${clean.length>100?'...':''}`);
      if(cmds.length===0){log('No cmds, final');finalText=clean||result.text;break;}
      if(!bridge.alive){
        const ok=await quickPing();
        if(!ok){tools.push({name:'bridge_offline',target:'',result:'오프라인',ok:false});finalText=(clean?clean+'\n\n':'')+'⚠️ 브리지가 오프라인입니다.';break;}
        bridge.alive=true;
      }
      steps.push(`⚡ 명령 ${cmds.length}개 실행 중...`);
      await updateStreamMsg({text:clean||'',tools,step:steps[steps.length-1],loop:loop+1,steps:steps.slice(-12)});
      const loopResults=[];
      for(let ci=0;ci<cmds.length;ci++){
        const cmd=cmds[ci];
        const desc=cmd.action+(cmd.target?' → '+cmd.target.slice(0,40):'');
        steps.push(`  🔧 [${ci+1}/${cmds.length}] ${desc}`);
        await updateStreamMsg({text:clean||'',tools,step:`🔧 ${cmd.action}...`,loop:loop+1,steps:steps.slice(-12)});
        let r=await execBridgeCmd(cmd);
        if(!r.ok){await sleep(1000);r=await execBridgeCmd(cmd);}
        const entry={name:cmd.action,target:cmd.target||(cmd.content||'').slice(0,80),result:(r.result||'').slice(0,2000),ok:r.ok};
        tools.push(entry);loopResults.push(entry);
        steps.push(`  ${r.ok?'✅':'❌'} ${cmd.action}: ${(r.result||'').slice(0,80)}`);
        await updateStreamMsg({text:clean||'',tools,step:`${r.ok?'✅':'❌'} ${cmd.action}`,loop:loop+1,steps:steps.slice(-12)});
      }
      prevText=clean;
      toolRes=loopResults.map((r,i)=>`[RESULT ${i+1}] ${r.ok?'성공':'실패'}: ${r.name}\n대상: ${r.target}\n결과:\n${r.result}`).join('\n\n');
      steps.push('🔄 결과 분석 후 다음 단계 결정...');
      await updateStreamMsg({text:clean||'',tools,step:steps[steps.length-1],loop:loop+1,steps:steps.slice(-12)});
    }
    steps.push('✅ 작업 완료');
    await finalizeStreamMsg(chat_id,id,{text:finalText,tools,duration:totalDur.toFixed(1)+'s',loops:tools.length>0?tools.length:1,steps,step:'✅ 완료'});
  } catch(error) {
    log('Error: '+error.message,'ERROR');
    steps.push('❌ '+error.message);
    try{
      await finalizeStreamMsg(chat_id,id,{text:'⚠️ 오류:\n\n'+error.message+'\n\n다시 시도해주세요.',tools,duration:'0s',loops:0,steps,step:'❌ 오류'});
    }catch(e2){
      try{
        await supaFetch('POST','/messages',{id:genId(),chat_id,role:'assistant',content:JSON.stringify({text:'⚠️ '+error.message,tools:[],steps}),status:'completed'});
        await supaFetch('PATCH','/messages?id=eq.'+id,{status:'completed'});
      }catch(e3){}
    }
  }
}

async function sendHeartbeat() {
  const now=new Date().toISOString();
  try{await supaFetch('PATCH','/commands?id=eq.relay-heartbeat',{status:'completed',result:now,content:processing?'busy':'idle'});}
  catch(e){try{await supaFetch('POST','/commands',{id:'relay-heartbeat',action:'heartbeat',target:'home-pc',content:'idle',status:'completed',result:now});}catch(e2){}}
}

async function pollLoop() {
  sendHeartbeat();
  const hb=setInterval(sendHeartbeat,30000);
  while(isRunning){
    try{
      if(!processing){
        const p=(await supaFetch('GET','/messages?role=eq.user&status=eq.pending&order=created_at.asc&limit=1'))||[];
        if(p.length>0){processing=true;await processMessage(p[0]);processing=false;}
      }
    }catch(e){log('Poll error: '+e.message,'ERROR');processing=false;}
    await sleep(CONFIG.pollInterval);
  }
  clearInterval(hb);
}

process.on('SIGINT', ()=>{ log('Shutting down...');isRunning=false;setTimeout(()=>process.exit(0),2000); });
process.on('SIGTERM',()=>{ isRunning=false;setTimeout(()=>process.exit(0),2000); });

(async()=>{
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║  Cowork Relay Worker v5.0  (Anthropic API 직접 호출) ║');
  console.log('╠══════════════════════════════════════════════════════╣');
  const keyStatus=CONFIG.anthropicApiKey?'✅ 설정됨 ('+CONFIG.anthropicApiKey.slice(0,16)+'...)':'❌ 미설정';
  console.log('║  API Key: '+keyStatus.padEnd(43)+'║');
  console.log('║  Model:   '+CONFIG.anthropicModel.padEnd(43)+'║');
  console.log('║  중지: Ctrl+C                                        ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');

  try{await supaFetch('GET','/messages?limit=1');log('Supabase: OK');}
  catch(e){console.log('\n[FATAL] Supabase 연결 실패: '+e.message);process.exit(1);}

  if(!CONFIG.anthropicApiKey){
    console.log('\n[FATAL] ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다.');
    console.log('\n설정 방법:');
    console.log('  CMD:        set ANTHROPIC_API_KEY=sk-ant-xxxxxxxx');
    console.log('  PowerShell: $env:ANTHROPIC_API_KEY="sk-ant-xxxxxxxx"');
    console.log('\nhttps://console.anthropic.com 에서 API 키를 발급받으세요.\n');
    process.exit(1);
  }

  try{
    log('Testing Anthropic API...');
    const r=await callClaude([{role:'user',content:'Say "ok".'}],'You are a test.');
    log('Anthropic API: OK ('+r.duration+')');
  }catch(e){
    console.log('\n[FATAL] Anthropic API 실패: '+e.message);
    console.log('API 키가 올바른지, 크레딧이 있는지 확인하세요.');
    process.exit(1);
  }

  const bridge=await checkBridge();
  log('Bridge: '+(bridge.alive?'ALIVE':'OFFLINE'));
  log('v5.0 ready. Waiting for messages...\n');
  pollLoop().catch(e=>{log('FATAL: '+e.message,'ERROR');process.exit(1);});
})();
