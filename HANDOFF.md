# HANDOFF — mac-mini + victus dispatch repos

> 이전 세션에서 작업하다가 권한 프롬프트 누적으로 새 세션으로 핸드오프됨.
> 새 세션은 `.claude/settings.json`의 `defaultMode: "bypassPermissions"`로 자동 모드.

## 목표

핸드폰의 Claude Code 모바일 앱에서:
1. `seongchun/mac-mini` 또는 `seongchun/victus` 리포 선택 → 클라우드 세션 시작
2. `/sessions`로 해당 머신에서 진행 중인 **실제 Claude Code 대화** 목록 확인
3. `/dispatch --resume <session-id> -- <task>`로 그 대화를 이어가거나 새 작업 dispatch
4. 결과가 핸드폰으로 돌아옴

집의 Mac Mini와 Windows PC(별칭: Victus)에는 각각 launchd/NSSM 데몬으로 릴레이가 떠 있고, Supabase `commands` 테이블을 폴링한다.

## 아키텍처

```
[Phone — Claude Code 앱]
    ↓ 리포 선택 (mac-mini 또는 victus)
[Cloud container — 슬래시 명령]
    ↓ HMAC 서명된 payload를 commands 테이블에 insert
[Supabase commands 테이블]
    ↑ 3초마다 폴링
[Mac Mini relay.mjs (launchd) / Victus relay.mjs (NSSM)]
    ↓ HMAC 검증 → claude --resume <id> --dangerously-skip-permissions --print
    ↓ 결과를 commands.result에 PATCH
[Cloud 세션 1초 폴링 → 결과 → 핸드폰]
```

기존 `remote-bridge`의 `relay-worker.js`/`supabase-bridge-agent.ps1`은 **무시**. Supabase 인스턴스(URL, anon key, `commands`/`sys_log` 테이블)만 재사용.

## 현재 진행 상태 ✅

### 완료
- `mac-mini/` 전체:
  - `scripts/lib/{supa,hmac,config}.mjs` (HTTPS 클라이언트, HMAC-SHA256 서명, env 로딩)
  - `scripts/{dispatch,sessions,new-session,status,logs,cancel}.mjs`
  - `relay/{relay.mjs,install.sh,uninstall.sh,com.seongchun.mac-mini-relay.plist}`
  - `.claude/{settings.json (bypassPermissions),commands/*.md ×6,hooks/session-start.sh}`
  - `README.md`, `package.json`, `.env.example`, `.gitignore`
- `victus/` 전체:
  - 위와 동일한 구조. relay/는 `install.ps1` + `uninstall.ps1`(NSSM 기반 Windows 서비스).
  - `.claude/settings.json`도 `bypassPermissions` 적용됨.
- 현재 작업 리포(`/home/user/remote-bridge/.claude/settings.json`)도 `bypassPermissions`로 설정해서 핸드오프 후 자동 모드.

### 미완 ⚠️ — 새 세션에서 이어서 해야 할 것

**중요 보정**: 현재 `relay/relay.mjs`의 `list_sessions`/`run_claude`는 **워크스페이스 디렉토리만** 본다. 사용자 요구(`실제 맥미니 세션들을 거기에 물리게 해줘`)를 완전히 만족시키려면 **실제 Claude Code 세션 JSONL 파일**을 스캔하도록 바꿔야 한다.

#### TODO 1 — relay의 `list_sessions` 재구현 (mac-mini & victus 동일하게)

`~/.claude/projects/<encoded-cwd>/*.jsonl` 디렉토리 스캔. 각 JSONL은 한 대화 = 한 session-id.

```js
// relay.mjs에 추가/수정
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';

function listRealSessions() {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(projectsDir)) return { sessions: [] };
  const out = [];
  for (const projDir of fs.readdirSync(projectsDir)) {
    const dirPath = path.join(projectsDir, projDir);
    if (!fs.statSync(dirPath).isDirectory()) continue;
    // Claude encodes cwd by replacing / with - (verify by reading a JSONL's first msg)
    const decodedCwd = '/' + projDir.replace(/-/g, '/');
    for (const file of fs.readdirSync(dirPath)) {
      if (!file.endsWith('.jsonl')) continue;
      const sessionId = file.replace('.jsonl', '');
      const full = path.join(dirPath, file);
      const st = fs.statSync(full);
      // Read first non-empty JSON line for preview
      let firstMsg = '';
      try {
        const head = fs.readFileSync(full, 'utf8').split('\n').find(l => l.trim());
        if (head) {
          const obj = JSON.parse(head);
          firstMsg = (obj.message?.content?.[0]?.text || obj.content || '').slice(0, 80);
        }
      } catch {}
      out.push({
        sessionId,
        cwd: decodedCwd,
        lastModified: st.mtime.toISOString(),
        sizeBytes: st.size,
        firstMessagePreview: firstMsg,
      });
    }
  }
  out.sort((a, b) => b.lastModified.localeCompare(a.lastModified));
  return { sessions: out };
}
```

**검증 필요**: `~/.claude/projects/`의 디렉토리 이름이 실제로 어떤 인코딩을 쓰는지. Mac에서 `ls ~/.claude/projects/` 한 줄로 확인 후 디코딩 보정. 가능하면 첫 JSONL 메시지의 `cwd` 필드를 그대로 신뢰.

#### TODO 2 — `run_claude` 액션에 `session_id` 모드 추가

```js
// 현재
const flagContinue = fresh ? '' : '--continue ';
const cmd = `"${cfg.claudePath}" ${flagContinue}--print < "${tmpFile}"`;

// 개선
let resumeFlag = '';
let cwd;
if (payload.session_id) {
  // 진짜 session-id로 그 대화 이어감
  resumeFlag = `--resume ${payload.session_id} `;
  cwd = findCwdForSession(payload.session_id);  // ~/.claude/projects/* 스캔으로
} else {
  // 워크스페이스 디렉토리 모드 (기존)
  cwd = resolveWorkspace(payload.session);
  resumeFlag = payload.fresh ? '' : '--continue ';
}
const cmd = `"${cfg.claudePath}" ${resumeFlag}--dangerously-skip-permissions --print < "${tmpFile}"`;
```

`--dangerously-skip-permissions` 플래그도 같이 추가 (사용자 요구: 모든 권한 자동 승인).

#### TODO 3 — 클라우드 진입점 갱신

- `scripts/dispatch.mjs`: `--resume <session-id>` 플래그 추가. payload에 `session_id` 필드 포함.
- `scripts/sessions.mjs`: 새 출력 포맷 — `[idx] <id-prefix> <last-modified> <cwd-basename>: <first-msg>`. 사용자가 idx 번호나 id-prefix로 `/dispatch --resume`에 넘길 수 있게.
- `scripts/lib/hmac.mjs`: `canonical()`의 필드에 `session_id` 추가.

#### TODO 4 — 슬래시 명령어 hint 업데이트

`.claude/commands/dispatch.md`의 `argument-hint`를 `[--resume <session-id> | --session <name>] [--fresh] -- <task>`로 변경.

#### TODO 5 — 커밋·푸시·draft PR

브랜치: `claude/check-session-status-nQcSp`

```bash
git add .claude mac-mini victus HANDOFF.md
git commit -m "mac-mini + victus dispatch repos (phone → cloud → home machines)"
git push -u origin claude/check-session-status-nQcSp
# draft PR via mcp__github__create_pull_request
```

## 핵심 파일 빠른 참조

| 경로 | 역할 |
|---|---|
| `mac-mini/relay/relay.mjs` | macOS launchd 워커. 보정 대상 (TODO 1, 2). |
| `victus/relay/relay.mjs` | Windows NSSM 워커. 동일 보정. |
| `mac-mini/scripts/dispatch.mjs`, `victus/scripts/dispatch.mjs` | 클라우드 디스패처. `--resume` 추가 (TODO 3). |
| `mac-mini/scripts/sessions.mjs`, `victus/scripts/sessions.mjs` | 세션 목록. 출력 포맷 갱신 (TODO 3). |
| `mac-mini/scripts/lib/hmac.mjs`, `victus/scripts/lib/hmac.mjs` | 캐노니컬에 `session_id` 추가 (TODO 3). |
| `*/.claude/settings.json` | `bypassPermissions` 이미 설정됨. |
| `/home/user/remote-bridge/.claude/settings.json` | 현재 리포 자체도 `bypassPermissions` (핸드오프 후 자동). |

## Supabase 인프라 (변경 없음, 재사용)

- URL: `https://rnnigyfzwlgojxyccgsm.supabase.co`
- Anon key: `sb_publishable_Nmv51BZccADB0bN5JY2URw_lLffyFgE`
- 사용 테이블: `commands`(id, action, target, content, status, result, created_at), `sys_log`
- 새 action 값: `run_claude`, `list_sessions`, `new_session` (target=`mac-mini` 또는 `victus`)

## 권한 자동 승인 (사용자가 가장 답답해했던 부분)

- 클라우드 세션: `.claude/settings.json`의 `defaultMode: "bypassPermissions"`로 처리됨 (mac-mini, victus, 그리고 이 remote-bridge 리포 자체).
- 머신 측 claude CLI: `--dangerously-skip-permissions` 플래그 추가 필요 (TODO 2).
- **현재 활성 세션의 권한 모드**: 하네스/UI 레벨이라 settings.json으로 바꿀 수 없음. 사용자가 직접 모바일/웹 앱에서 권한 모드 토글 (또는 데스크탑에서 Shift+Tab).

## GitHub 리포 분리

내 GitHub MCP 권한이 `seongchun/remote-bridge`로 제한되어 새 리포 생성 불가. PR 머지 후 사용자가:

```bash
# 사용자 로컬에서
git clone https://github.com/seongchun/remote-bridge.git tmp
cd tmp
git subtree split -P mac-mini -b mac-mini-only
git subtree split -P victus -b victus-only

# 새 리포 두 개 생성 (GitHub UI 또는 gh)
gh repo create seongchun/mac-mini --public --source=. --remote=origin-mac
gh repo create seongchun/victus   --public --source=. --remote=origin-victus

# 푸시
git push origin-mac mac-mini-only:main
git push origin-victus victus-only:main
```

또는 단순히 `mac-mini/`, `victus/` 폴더 내용을 직접 새 빈 리포에 복사·푸시.

## 검증 (모든 보정 끝나고)

핸드폰에서:
1. `seongchun/mac-mini` 리포로 새 세션 → `/status` → `mac-mini: online`
2. `/sessions` → Mac Mini의 실제 Claude 대화 N개 목록 (id-prefix + cwd + 첫 메시지)
3. `/dispatch --resume <id-prefix> -- "지금 어디까지 했지?"` → 그 대화의 컨텍스트로 응답
4. Mac에서 `cat ~/.claude/projects/<encoded>/<id>.jsonl` 마지막 줄 보면 새 메시지 append 확인
5. HMAC 위조 행 수동 insert → `result=HMAC_REJECT:bad_sig` (보안 경계)
6. `seongchun/victus` 리포로도 동일 시나리오 확인
