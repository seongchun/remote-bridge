# victus

핸드폰의 Claude Code 모바일 앱에서 dispatch한 클라우드 세션이 집 Windows PC(Victus)의
`claude` CLI를 원격으로 실행하게 해주는 리포지토리.

## 동작 원리

```
[Phone — Claude Code 앱]
     ↓ 이 리포 선택해서 세션 시작
[Cloud container]
     ↓ /dispatch, /sessions 등 슬래시 명령
[Supabase commands 테이블 (HMAC 서명된 행 삽입)]
     ↑ 3초마다 폴링
[Victus — relay.mjs (NSSM Windows service, auto-restart)]
     ↓ HMAC 검증 → workspace 디렉토리에서 claude --print --continue 실행
     ↓ stdout을 commands.result로 PATCH
[Cloud 세션이 결과 받음 → 핸드폰에 표시]
```

세션 = `WORKSPACE_ROOT` (기본 `%USERPROFILE%\claude-workspaces`) 아래의 서브폴더.
같은 세션에 dispatch하면 `claude --continue`로 대화 컨텍스트가 이어집니다.

## 슬래시 명령

| 명령 | 설명 |
|---|---|
| `/sessions` | Victus의 워크스페이스(세션) 목록 |
| `/new-session <name>` | 새 워크스페이스 생성 |
| `/dispatch [--session <name>] [--fresh] -- <task>` | 작업 dispatch. 미지정 시 `default` 세션, `--fresh`면 대화 새로 시작 |
| `/status` | Victus 릴레이 온라인 여부 |
| `/logs [count]` | 최근 sys_log |
| `/cancel <id> \| --latest` | 진행 중 dispatch 취소 |

## 설치

### 1. 클라우드 환경 (Claude Code on the web)

이 리포에 대한 환경에 다음 env vars 등록:

- `SUPABASE_URL=https://rnnigyfzwlgojxyccgsm.supabase.co`
- `SUPABASE_ANON_KEY=sb_publishable_Nmv51BZccADB0bN5JY2URw_lLffyFgE`
- `DISPATCH_SECRET=<openssl rand -hex 32>`  ← Victus와 동일해야 함
- `DISPATCH_TARGET=victus`

네트워크 정책: `*.supabase.co:443` outbound 허용 필요.

### 2. Victus(Windows) 릴레이 설치

사전:
- Node.js 18+ 설치 (https://nodejs.org/)
- `claude` CLI 설치: `npm install -g @anthropic-ai/claude-code`, 한 번 `claude login`
- NSSM 설치: `scoop install nssm` 또는 https://nssm.cc/

**관리자 권한 PowerShell에서:**

```powershell
git clone https://github.com/seongchun/victus.git $env:USERPROFILE\victus
cd $env:USERPROFILE\victus\relay
.\install.ps1
# 대화식: SUPABASE 정보 + DISPATCH_SECRET(클라우드와 동일) 입력
```

확인:
```powershell
Get-Content $env:USERPROFILE\.config\seongchun-victus\logs\relay.out.log -Tail 30 -Wait
# 10초 안에 [OK] Supabase reachable, [Ready] 메시지 표시
```

서비스 제어:
```powershell
Stop-Service VictusRelay
Start-Service VictusRelay
Restart-Service VictusRelay
```

자동 슬립 방지: Settings → System → Power → Screen and sleep에서 Never 권장.

## 검증 (핸드폰에서)

1. `/status` → `victus: online (idle, last seen Xs ago)`
2. `/new-session myproj`
3. `/sessions` → `myproj` 포함
4. `/dispatch --session myproj -- echo hello from %COMPUTERNAME%` → 5초 내 응답
5. `/dispatch --session myproj -- 방금 뭐 했지?` → 이전 컨텍스트 기억 (--continue)
6. `/dispatch --session myproj --fresh -- 처음부터 시작` → 새 대화로 시작
7. `/logs 10` → `run_claude_start/done` 기록

## 보안 모델

- Supabase anon key는 공개 — 누구나 행 삽입 가능
- **HMAC-SHA256 + 공유 secret이 진짜 경계**
- 잘못된 sig는 `result=HMAC_REJECT:bad_sig`로 즉시 거부, sys_log에 기록
- 10분 ts freshness window (replay 방지)
- Workspace traversal(`..`) 차단

## 한계

- Claude Code **데스크탑 앱**은 자동화 API가 없음 → CLI만 지원
- 한 번에 한 작업만 직렬 처리
- 결과 50KB 초과 시 잘림 (큰 출력은 파일로 쓰고 별도 dispatch로 가져오기)
- 스트리밍 없음 (완료 후 한 번에 반환) — 긴 작업은 최대 15분 대기
