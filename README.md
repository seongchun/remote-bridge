# Remote Bridge — Cowork <-> Company PC

## 구조
```
remote-bridge/
├── commands/
│   ├── pending/      <- Cowork가 명령을 넣는 곳
│   └── completed/    <- 처리 완료된 명령
├── results/          <- 회사 PC 실행 결과
├── sync/             <- 양방향 파일 동기화
└── scripts/
    ├── bridge-agent.bat      <- 회사 PC 에이전트
    ├── setup-company-pc.bat  <- 초기 설정
    └── config.json           <- 설정
```

## 빠른 시작

### 회사 PC
1. `git clone https://github.com/seongchun/remote-bridge.git C:\RemoteBridge`
2. `C:\RemoteBridge\scripts\bridge-agent.bat` 실행 (백그라운드 유지)

### Cowork (집 PC)
commands/pending/ 에 JSON 명령 파일 생성 후 push

## 명령 형식
```json
{
  "id": "cmd-001",
  "action": "read_file | write_file | list_dir | run_cmd | copy_to_repo",
  "path": "대상 경로 또는 명령어",
  "content": "write_file일 때 파일 내용",
  "timestamp": "ISO 8601"
}
```

## 지원 명령
| 명령 | 설명 |
|------|------|
| read_file | 회사 PC 파일 읽기 -> results/ |
| write_file | 회사 PC에 파일 생성/수정 |
| list_dir | 디렉토리 목록 조회 |
| run_cmd | 명령어 실행 (빌드, 테스트 등) |
| copy_to_repo | 회사 PC 파일을 sync/로 복사 |
