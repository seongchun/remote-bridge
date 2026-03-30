# ð Remote Bridge v4

> ì§ìì íì¬ PCë¥¼ Claude CLIë¡ ìê²© ì ì´íë ìì¤í

## ð êµ¬ì¡°

```
[íì¬ PC] ë¸ë¼ì°ì (cowork-clone.html) + bridge-agent
    â Supabase (relay DB)
[ì§ PC] relay-worker.js + Claude CLI
```

## ð ë¹ ë¥¸ ìì ê°ì´ë

### 1ë¨ê³: íì¬ PC ì¤ì 

**PowerShellì ê´ë¦¬ì ê¶íì¼ë¡ ì¤í** í ìë ëªë ¹ì´ ìë ¥:

```powershell
# ì¤ì¹ í´ë ìì±
mkdir C:\RemoteBridge -Force

# íì¼ ë¤ì´ë¡ë
Invoke-WebRequest -Uri "https://raw.githubusercontent.com/seongchun/remote-bridge/main/setup-company.bat" -OutFile "C:\RemoteBridge\setup-company.bat"

# ì¤ì¹ ì¤í
cd C:\RemoteBridge
.\setup-company.bat
```

ëë ìë íì¼ì ì§ì  ë¤ì´ë¡ë:

| íì¼ | ì¤ëª | ë¤ì´ë¡ë |
|------|------|----------|
| `cowork-clone.html` | ì±í UI (ë¸ë¼ì°ì ìì ì´ê¸°) | [ë¤ì´ë¡ë](https://raw.githubusercontent.com/seongchun/remote-bridge/main/cowork-clone.html) |
| `setup-company.bat` | ìí´ë¦­ ì¤ì¹ ì¤í¬ë¦½í¸ | [ë¤ì´ë¡ë](https://raw.githubusercontent.com/seongchun/remote-bridge/main/setup-company.bat) |
| `bridge-agent.ps1` | ë¸ë¦¿ì§ ìì´ì í¸ | [ë¤ì´ë¡ë](https://raw.githubusercontent.com/seongchun/remote-bridge/main/scripts/bridge-agent.ps1) |
| `bridge-watchdog.ps1` | ìë ì¬ìì ìì¹ë | [ë¤ì´ë¡ë](https://raw.githubusercontent.com/seongchun/remote-bridge/main/scripts/bridge-watchdog.ps1) |

### 2ë¨ê³: ì§ PC ì¤ì 

**ì¬ì  íì:**
- Node.js 18+ ([ë¤ì´ë¡ë](https://nodejs.org/))
- Claude CLI (`npm install -g @anthropic-ai/claude-code`)

**PowerShellìì:**

```powershell
# ì¤ì¹ í´ë ìì±
mkdir "$env:USERPROFILE\CoworkRelay" -Force

# ì¤ì¹ ì¤í¬ë¦½í¸ ë¤ì´ë¡ë
Invoke-WebRequest -Uri "https://raw.githubusercontent.com/seongchun/remote-bridge/main/setup-home.bat" -OutFile "$env:USERPROFILE\CoworkRelay\setup-home.bat"

# ì¤ì¹ ì¤í
cd "$env:USERPROFILE\CoworkRelay"
.\setup-home.bat
```

ëë ì§ì  ë¤ì´ë¡ë:

| íì¼ | ì¤ëª | ë¤ì´ë¡ë |
|------|------|----------|
| `relay-worker.js` | ë¦´ë ì´ ìì»¤ (v8.0) | [ë¤ì´ë¡ë](https://raw.githubusercontent.com/seongchun/remote-bridge/main/relay-worker.js) |
| `setup-home.bat` | ìí´ë¦­ ì¤ì¹ ì¤í¬ë¦½í¸ | [ë¤ì´ë¡ë](https://raw.githubusercontent.com/seongchun/remote-bridge/main/setup-home.bat) |

### 3ë¨ê³: ì¬ì©íê¸°

1. **íì¬ PC**: `cowork-clone.html`ì ë¸ë¼ì°ì ìì ì´ê¸°
2. **íì¬ PC**: bridge-agentê° ì¤í ì¤ì¸ì§ íì¸ (setup-company.batì´ ìë ìì)
3. **ì§ PC**: relay-worker ì¤í
   ```bash
   cd ~/CoworkRelay
   node relay-worker.js
   ```
4. **ì§ PC**: ë¸ë¼ì°ì ìì cowork-clone.html ì±íì°½ì ë©ìì§ ìë ¥íë©´ Claudeê° íì¬ PCìì ìì ìí

## ð íì¼ êµ¬ì¡°

```
remote-bridge/
âââ README.md              â ì´ íì¼
âââ cowork-clone.html      â ì±í UI (ë¤í¬ ëë§, ì¤í¸ë¦¬ë°)
âââ relay-worker.js        â ë¦¬ë ì´ ìì»¤ (ì§ PCì©)
ââ`8¥ Ù]\XÛÛ\[K]8¡¤;f£; «È;&ä;`m:é«H;!);.f¸¥'8¥ 8¥ Ù]\ZÛYK]8¡¤;)äHÈ;&ä;`m:é«H;!);.f¸¥%8¥ 8¥ ØÜ\ËÂ8¥'8¥ 8¥ YÙKXYÙ[ÌH8¡¤:î#:é¯û)à;%ä;'m;(!;b®8¥'8¥ 8¥ YÙK]Ø]ÚÙËÌH8¡¤;'¤:ãæH;'«;"ç;'¤H;&ã;.f:ãáB8¥%8¥ 8¥ ÛÛYËÛÛ8¡¤Ý\X\ÙH;!);(%BÈÈ8¦¦{î#È;(ï;&¥:®,:â©BH
»"é;"ç:¬!;,a;c!JÝ\X\ÙHX[[YH
È;cí:éàH;'m;)${feH
»"©;b®:é«:ì#H;'dzâíJÛ]YH;'dzâí{'m;"é;"ç:¬!;'/:èg;dg;"çH
»c#;'o;,ª:í 
;'m:ëî;)àúë.;!';,ª:í ;)à;&äH
»'¤:ãæH;'«;"ç;'¤JYÙK]Ø]ÚÙû'm;%ä;'m;(!;b®:¬$;"çH
ºâé;`k;ac:éâ
:â";c®;eg:âé;`kRBH
»eg:­k{%­SQJ;eg:­k{%­;'¡zè)H;&a:ì¯H;)à;&äH
»f£; «È;c#;'o;( ;'©JÛÝÛÜÈ:ë.;!';'¤{%á{"ç;f£; «È;cí:ãe;%ä;)à{($H;( ;'©BÈÈ<'å)È:ë.;(';em:¬¬;)§{ àH;em:¬¬KKKKK_KKKKK_;%ì:¬¬;%b:ä*Ý\X\ÙHTÒÑVH;fe{'n;'n;a,:á-È;%ì:¬¬;fe{'nYÙKXYÙ[;&):éfÝÙ\Ú[;"é;e¢H;(%{,aNÙ]Q^XÝ][ÛÛXÞHTØÛÜHÝ\[\Ù\[[ÝTÚYÛY[^K]ÛÜÙ\;&):éfÙKÈ:ì¡;(!;fe{'n
ÙH]
KN
È;ea;&¥Û]YHÓH;&):éfÛ]YHK]\Ú[Û;fe{'n;'«;!);.fHHYÈ[ÜXËXZKØÛ]YKXÛÙXÈÈ<'äçH:ì¡;(!H

HÝ\X\ÙH[^H;%a;`©;ac{,¦H
ÛÝÛÜËXÛÛH
H;"©;b®:é«:ì#K;c#;'o;,ª:í :âé;`k>ác:éâH
[^K]ÛÜÙ\
H;e!:èg;!.;"©;'¨:®";&ä;'¤;( H:êe;"ç;)à;,¦:é«:¬è;%a;g¤:çë
