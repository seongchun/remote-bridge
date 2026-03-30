# Remote Bridge v4

> 집에서 회사 PC를 Claude CLI로 원격 제어하는 시스템

## 구조

```
[회사 PC] 브라우저(cowork-clone.html) + bridge-agent
    ↕ Supabase (relay DB)
[집 PC] relay-worker.js + Claude CLI
```

## 빠른 시작 가이드

### 1단계: 회사 PC 설정

**PowerShell을 관리자 권한으로 실행** 후 아래 명령어 입력:

```powershell
# 설치 폴더 생성
mkdir C:\RemoteBridge -Force

# 파일 다운로드
Invoke-WebRequest -Uri "https://raw.githubusercontent.com/seongchun/remote-bridge/main/setup-company.bat" -OutFile "C:\RemoteBridge\setup-company.bat"

# 설치 실행
cd C:\RemoteBridge
.\setup-company.bat
```

또는 아래 파일을 직접 다운로드:

| 파일 | 설명 | 다운로드 |
|------|------|----------|
| `cowork-clone.html` | 채팅 UI (브라우저에서 열기) | [다운로드](https://raw.githubusercontent.com/seongchun/remote-bridge/main/cowork-clone.html) |
| `setup-company.bat` | 원클릭 설치 스크립트 | [다운로드](https://raw.githubusercontent.com/seongchun/remote-bridge/main/setup-company.bat) |
| `bridge-agent.ps1` | 브릿지 에이전트 | [다운로드](https://raw.githubusercontent.com/seongchun/remote-bridge/main/scripts/bridge-agent.ps1) |
| `bridge-watchdog.ps1` | 자동 재시작 워치독 | [다운로드](https://raw.githubusercontent.com/seongchun/remote-bridge/main/scripts/bridge-watchdog.ps1) |

### 2단계: 집 PC 설정

**사전 필요:**
- Node.js 18+ ([다운로드](https://nodejs.org/))
- Claude CLI (`npm install -g @anthropic-ai/claude-code`)

**PowerShell에서:**

```powershell
# 설치 폴더 생성
mkdir "$env:USERPROFILE\CoworkRelay" -Force

# 설치 스크립트 다운로드
Invoke-WebRequest -Uri "https://raw.githubusercontent.com/seongchun/remote-bridge/main/setup-home.bat" -OutFile "$env:USERPROFILE\CoworkRelay\setup-home.bat"

# 설치 실행
cd "$env:USERPROFILE\CoworkRelay"
.\setup-home.bat
```

또는 직접 다운로드:

| 파일 | 설명 | 다운로드 |
|------|------|----------|
| `relay-worker.js` | 릴레이 워커 (v8.0) | [다운로드](https://raw.githubusercontent.com/seongchun/remote-bridge/main/relay-worker.js) |
| `setup-home.bat` | 원클릭 설치 스크립트 | [다운로드](https://raw.githubusercontent.com/seongchun/remote-bridge/main/setup-home.bat) |

### 3단계: 사용하기

1. **회사 PC**: `cowork-clone.html`을 브라우저에서 열기
2. **회사 PC**: bridge-agent가 실행 중인지 확인 (setup-company.bat이 자동 시작)
3. **집 PC**: relay-worker 실행
   ```bash
   cd ~/CoworkRelay
   node relay-worker.js
   ```
4. **집 PC**: 브라우저에서 cowork-clone.html 채팅창에 메시지 입력하면 Claude가 회사 PC에서 작업 수행

## 파일 구조

```
remote-bridge/
├── README.md              ← 이 파일
├── cowork-clone.html      ← 채팅 UI (다크테마, 스트리밍)
├── relay-worker.js        ← 릴레이 워커 (집 PC용)
├── setup-company.bat      ← 회사 PC 원클릭 설치
├── setup-home.bat         ← 집 PC 원클릭 설치
└── scripts/
    ├── bridge-agent.ps1       ← 브릿지 에이전트
    ├── bridge-watchdog.ps1    ← 자동 재시작 워치독
    └── config.json            ← Supabase 설정
```

## 주요 기능

- **실시간 채팅**: Supabase Realtime + 폴링 이중화
- **스트리밍 응답**: Claude 응답이 실시간으로 표시
- **파일 첨부**: 이미지/문서 첨부 지원
- **자동 재시작**: bridge-watchdog이 에이전트 감시
- **다크 테마**: 눈 편한 다크 UI
- **한국어 IME**: 한국어 입력 완벽 지원
- **회사 PC 파일 저장**: Cowork 문서 작업시 회사 PC 폴더에 직접 저장

## 문제 해결

| 증상 | 해결 |
|------|------|
| 연결 안 됨 | Supabase URL/KEY 확인, 인터넷 연결 확인 |
| bridge-agent 오류 | PowerShell 실행 정책: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` |
| relay-worker 오류 | Node.js 버전 확인 (`node -v`), 18+ 필요 |
| Claude CLI 오류 | `claude --version` 확인, 재설치: `npm i -g @anthropic-ai/claude-code` |

## 버전

- **v4.0** - Supabase relay 아키텍처
- **cowork-clone v8** - 스트리밍, 파일첨부, 다크테마
- **relay-worker v8** - 프로세스 잠금, 원자적 메시지 처리, 고아 힐러
