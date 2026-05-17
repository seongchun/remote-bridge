# mac-mini

핸드폰의 Claude Code 모바일 앱에서 dispatch한 클라우드 세션이 집 Mac Mini의 `claude` CLI를
원격으로 실행하게 해주는 리포지토리.

## 동작 원리

```
[Phone — Claude Code 앱]
     ↓ 이 리포 선택해서 세션 시작
[Cloud container]
     ↓ /dispatch, /sessions 등 슬래시 명령
[Supabase commands 테이블 (HMAC 서명된 행 삽입)]
     ↑ 3초마다 폴링
[Mac Mini — relay.mjs (launchd KeepAlive=true)]
     ↓ HMAC 검증 → workspace 디렉토리에서 claude --print --continue 실행
     ↓ stdout을 commands.result로 PATCH
[Cloud 세션이 결과 받음 → 핸드폰에 표시]
```

세션 = `WORKSPACE_ROOT` (기본 `~/claude-workspaces`) 아래의 서브폴더.
같은 세션에 dispatch하면 `claude --continue`로 대화 컨텍스트가 이어집니다.

## 슬래시 명령

| 명령 | 설명 |
|---|---|
| `/sessions` | Mac Mini의 워크스페이스(세션) 목록 |
| `/new-session <name>` | 새 워크스페이스 생성 |
| `/dispatch [--session <name>] [--fresh] -- <task>` | 작업 dispatch. 미지정 시 `default` 세션, `--fresh`면 대화 새로 시작 |
| `/status` | Mac Mini 릴레이 온라인 여부 |
| `/logs [count]` | 최근 sys_log |
| `/cancel <id> \| --latest` | 진행 중 dispatch 취소 |

## 설치

### 1. 클라우드 환경 (Claude Code on the web)

이 리포에 대한 환경에 다음 env vars 등록:

- `SUPABASE_URL=https://rnnigyfzwlgojxyccgsm.supabase.co`
- `SUPABASE_ANON_KEY=sb_publishable_Nmv51BZccADB0bN5JY2URw_lLffyFgE`
- `DISPATCH_SECRET=<openssl rand -hex 32>`  ← 양쪽이 동일해야 함
- `DISPATCH_TARGET=mac-mini`

네트워크 정책: `*.supabase.co:443` outbound 허용 필요.

### 2. Mac Mini 릴레이 설치

```bash
brew install node                              # Node 18+
npm i -g @anthropic-ai/claude-code             # claude CLI
claude login                                   # 한 번만

git clone https://github.com/seongchun/mac-mini.git ~/mac-mini
cd ~/mac-mini/relay
bash install.sh                                # 대화식: env 값 입력
                                              # DISPATCH_SECRET은 클라우드와 동일하게
```

확인:
```bash
tail -f ~/Library/Logs/mac-mini-relay.out.log
# 10초 안에 [OK] Supabase reachable, [Ready] 메시지 표시
```

서비스 제어:
```bash
launchctl unload ~/Library/LaunchAgents/com.seongchun.mac-mini-relay.plist   # 정지
launchctl load   ~/Library/LaunchAgents/com.seongchun.mac-mini-relay.plist   # 시작
launchctl kickstart -k gui/$(id -u)/com.seongchun.mac-mini-relay              # 재시작
```

자동 슬립 방지: System Settings → Energy → Prevent automatic sleeping 권장.

## 검증 (핸드폰에서)

1. `/status` → `mac-mini: online (idle, last seen Xs ago)`
2. `/new-session myproj`
3. `/sessions` → `myproj` 포함
4. `/dispatch --session myproj -- echo hello from $(hostname)` → 5초 내 Mac 호스트네임 응답
5. `/dispatch --session myproj -- what did I just ask you to do?` → 이전 컨텍스트 기억 (--continue)
6. `/dispatch --session myproj --fresh -- ignore everything before` → 새 대화로 시작
7. `/logs 10` → `run_claude_start/done` 기록

## 보안 모델

- Supabase anon key는 공개 — 누구나 행 삽입 가능
- **HMAC-SHA256 + 공유 secret이 진짜 경계**
- 잘못된 sig는 `result=HMAC_REJECT:bad_sig`로 즉시 거부, sys_log에 기록
- 10분 ts freshness window (replay 방지)
- Workspace traversal(`..`) 차단

## 한계

- Claude Code **데스크탑 앱**은 자동화 API가 없음 → CLI만 지원
- 한 번에 한 작업만 직렬 처리 (Mac 부담 방지)
- 결과 50KB 초과 시 잘림 (큰 출력은 파일로 쓰고 별도 dispatch로 가져오기)
- 스트리밍 없음 (완료 후 한 번에 반환) — 긴 작업은 최대 15분 대기
