# Contributing

작은 수정과 버그 보고도 환영합니다. 이 도구는 원격 Steercards MCP 서버에 연결하는 독립형 패키지입니다. 서버 기능과 도구 목록을 클라이언트에 고정하지 않는 설계를 유지하세요.

## 로컬 개발

Node.js 22 이상에서 실행합니다.

```sh
npm ci
npm run check
npm test
npm run build
npm pack --dry-run
```

테스트는 로컬 fixture를 사용합니다. 실제 키, 개인 워크스페이스 데이터, 네트워크 연결을 기본 테스트에 추가하지 마세요. 연결 테스트가 필요한 변경은 별도 테스트 계정과 최소한의 읽기 작업으로 확인하고 실행 범위를 PR에 기록하세요.

## 변경 제안

- 버그 보고에는 패키지·Node·OS·클라이언트 버전, 재현 명령과 예상·실제 결과를 적습니다. 키와 개인정보는 제거합니다.
- PR에는 사용자가 겪는 문제, 변경 후 동작, 수행한 검사와 아직 확인하지 않은 클라이언트를 적습니다.
- 도구 탐색·호출 변경은 로컬 MCP fixture로 검증합니다. 설정·파일 경로 변경은 Windows 경로와 공백이 있는 경로도 고려합니다.
- CLI 플래그, 환경 변수, 설치 경로가 바뀌면 README와 Skill을 함께 갱신합니다.
- `serve`의 stdout은 MCP 메시지 전용입니다. 진단 로그는 stderr로 출력하고 키를 노출하지 않습니다.
- `setup`은 MCP 설정과 Skill을 함께 설치·업데이트합니다. Steercards 외 설정·주석·사용자 파일은 보존하고 관리 항목에 사용자 수정이 있으면 쓰기 전에 중단합니다. 임시 프로젝트와 격리한 홈 디렉터리에서 첫 설치, 재실행, 이전 버전 업데이트, 충돌, dry run과 쓰기 실패 복구를 검증하세요.
- `.steercards/setup/` 기록의 버전·옵션·해시를 다음 업데이트의 기준으로 사용합니다. 실제 개인 설치 기록과 ZIP은 테스트 fixture나 커밋에 넣지 마세요.
- `setup`은 키 없이 실행하고 `.env`를 생성·변경하지 않습니다. `config`는 설정 조각만 출력하며 개별 `skill install`은 사용자 수정 파일을 덮어쓰지 않습니다.

변경 제안은 [공개 저장소](https://github.com/velody-ai/steercards-agent-tools)에 PR로 올려주세요. 보안 문제는 공개 이슈에 올리지 말고 [SECURITY.md](SECURITY.md)를 따릅니다.

## 릴리스

릴리스 담당자는 [npm 릴리스 안내](docs/releases.md)를 따릅니다. 버전 변경 PR을 main에 병합하고 실제 tarball을 검사한 뒤 일치하는 태그의 안정 버전 GitHub Release를 게시합니다. 일반 CI와 main 병합은 검증을 수행하고, Release 게시 이벤트가 npm trusted publishing을 실행합니다.
