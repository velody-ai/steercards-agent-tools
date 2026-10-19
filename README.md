# Steercards Agent Tools

Steercards의 전체 MCP 도구를 CLI와 에이전트에서 사용할 수 있게 하는 독립형 Node.js 도구입니다. MIT 라이선스이며 Node.js 22 이상이 필요합니다.

- 원격 서버의 도구 목록·설명·입력 스키마를 실행 시 조회합니다. 도구 목록을 패키지에 고정하지 않습니다.
- 기본 `compact` 모드는 검색 → 스키마 확인 → 호출 흐름으로 초기 도구 노출을 줄입니다.
- `full` 모드는 원격 도구를 각각 노출합니다.
- 프로젝트 `.env`를 읽는 STDIO MCP 서버, 단독 CLI, 설치 가능한 Skill을 함께 제공합니다.

패키지 이름은 `@steercards/agent-tools`, 실행 명령은 `steercards`입니다. 아래 npm 명령은 **0.1.0을 게시한 뒤** 사용할 수 있습니다. 게시 전에는 소스에서 빌드하는 방법을 사용하세요.

## 게시 전: 소스에서 실행

이 저장소를 받은 디렉터리에서 실행합니다.

```sh
npm ci
npm run build
node dist/cli.js --help
```

사용할 프로젝트에 `.env.example`을 참고하여 `.env`를 만듭니다. 실제 키를 Git에 커밋하지 않도록 프로젝트의 `.gitignore`에 `.env`를 추가하세요.

```dotenv
STEERCARDS_AGENT_KEY=your-agent-key
# 기본값을 사용할 때는 생략합니다.
STEERCARDS_MCP_URL=https://steercards.com/api/mcp
```

```sh
node /absolute/path/agent-tools/dist/cli.js doctor --cwd /absolute/path/project
node /absolute/path/agent-tools/dist/cli.js doctor --cwd /absolute/path/project --connect
node /absolute/path/agent-tools/dist/cli.js tools --cwd /absolute/path/project
```

`doctor`는 키 값을 출력하지 않고 탐지 여부와 로컬 설정을 확인합니다. `--connect`를 추가하면 원격 서버에 연결하고 워크스페이스 목록을 조회하는 읽기 전용 검사를 수행합니다.

## npm 게시 후: 빠른 시작

```sh
npx -y @steercards/agent-tools@0.1.0 doctor --cwd /absolute/path/project --connect
npx -y @steercards/agent-tools@0.1.0 tools cards --cwd /absolute/path/project
```

전역 설치도 가능합니다.

```sh
npm install --global @steercards/agent-tools@0.1.0
steercards --help
```

이하 `steercards` 명령은 전역 설치를 기준으로 합니다. 소스 빌드 사용자는 `node /absolute/path/agent-tools/dist/cli.js`로 대체하면 됩니다.

## 환경 설정

| 설정 | 동작 |
| --- | --- |
| `STEERCARDS_AGENT_KEY` | Steercards Agent Key. 원격 요청에 필요합니다. |
| `STEERCARDS_MCP_URL` | 선택 사항. 기본값은 `https://steercards.com/api/mcp`입니다. |
| `--cwd PATH` | 프로젝트 디렉터리를 고정합니다. 생략하면 프로세스의 현재 디렉터리를 사용합니다. |
| `--env-file PATH` | 기본 `.env` 대신 읽을 파일입니다. 상대 경로는 `--cwd` 기준입니다. |
| `--url URL` | 이번 실행의 MCP URL을 지정합니다. 환경 변수보다 우선합니다. |

이미 설정된 프로세스 환경 변수가 `.env`보다 우선합니다. 기본 `.env`는 지정한 디렉터리에서만 찾으며 상위 디렉터리를 탐색하지 않습니다. dotenv 값에 셸 명령이나 `${VARIABLE}` 확장을 수행하지 않습니다. 원격 URL은 HTTPS를 사용하며 로컬 개발용 loopback 주소만 HTTP를 허용합니다. URL의 인증 정보·쿼리·fragment는 허용하지 않습니다.

GUI 앱은 터미널과 다른 디렉터리·환경에서 시작될 수 있습니다. 설정을 생성할 때 `--cwd`에 실제 프로젝트의 절대 경로를 지정하세요. 여러 프로젝트를 사용하면 서버 이름과 `--cwd`를 프로젝트별로 구분하세요. 키는 MCP 설정에 복사하지 않고 해당 프로젝트의 `.env`에 둡니다.

## MCP 클라이언트 연결

`config`는 **설정 조각을 출력**합니다. 기존 클라이언트 설정 파일을 수정하지 않습니다. 출력 내용을 기존 설정에 병합한 뒤 클라이언트를 다시 시작하거나 MCP 서버를 다시 연결하세요.

게시 전 또는 GUI 실행 경로를 확실히 고정하려면 빌드한 소스에서 `--local`로 생성합니다. 실제 사용 중인 Node 실행 파일과 패키지의 `dist/cli.js` 절대 경로를 출력하므로 해당 설치 디렉터리를 유지해야 합니다. Windows에서도 이 방식을 권장합니다.

```sh
node /absolute/path/agent-tools/dist/cli.js config codex-app --cwd /absolute/path/project --local
node /absolute/path/agent-tools/dist/cli.js config claude-code --cwd /absolute/path/project --local
node /absolute/path/agent-tools/dist/cli.js config cursor --cwd /absolute/path/project --local
node /absolute/path/agent-tools/dist/cli.js config claude-desktop --cwd /absolute/path/project --local
```

게시 후에는 `--local`을 생략해 `npx -y @steercards/agent-tools@0.1.0` 기반 설정을 생성할 수 있습니다. 이 경우 클라이언트에서 `npx`를 실행할 수 있어야 합니다.

```sh
steercards config codex --cwd /absolute/path/project
steercards config claude-code --cwd /absolute/path/project
steercards config cursor --cwd /absolute/path/project
steercards config claude-desktop --cwd /absolute/path/project
```

| 클라이언트 | `config` 이름 | 출력할 설정의 위치·참고 자료 |
| --- | --- | --- |
| Codex 앱·CLI | `codex`, `codex-app`, `codex-cli` | `~/.codex/config.toml` 또는 신뢰한 프로젝트의 `.codex/config.toml`. 같은 호스트의 MCP 설정을 공유합니다. [공식 MCP 설정](https://developers.openai.com/codex/mcp) |
| Claude Code | `claude-code` | 프로젝트 `.mcp.json`. [공식 MCP 설정](https://code.claude.com/docs/en/mcp) |
| Cursor | `cursor` | 프로젝트 `.cursor/mcp.json` 또는 `~/.cursor/mcp.json`. [공식 MCP 설정](https://cursor.com/docs/mcp) |
| Claude Desktop | `claude-desktop` | macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`, Windows: `%APPDATA%\Claude\claude_desktop_config.json`. [로컬 MCP 연결 안내](https://modelcontextprotocol.io/docs/develop/connect-local-servers) |

기본 `compact` 모드가 노출하는 도구는 다음 네 개입니다.

| 도구 | 용도 |
| --- | --- |
| `steercards_search_tools` | 필요한 원격 도구 검색 |
| `steercards_describe_tool` | 선택한 도구의 설명·입력 스키마 확인 |
| `steercards_call_tool` | 확인한 이름과 인자로 원격 도구 호출 |
| `steercards_get_guide` | Steercards 사용 가이드 조회 |

클라이언트가 개별 도구 노출을 필요로 하면 설정 생성 시 `--mode full`을 추가하세요.

```sh
steercards config codex-app --cwd /absolute/path/project --mode full
steercards serve --cwd /absolute/path/project --mode full
```

`compact` 모드의 호출 도구는 여러 종류의 쓰기 작업도 실행할 수 있습니다. 도구 수를 줄이는 기능이며 접근 권한을 제한하지 않습니다. `full` 모드는 원격 도구 이름·스키마·메타데이터를 직접 노출하므로 클라이언트에서 개별 도구를 다루기 쉽습니다. 원격 도구의 메타데이터와 호출 결과의 `isError`·`structuredContent` 오류 신호를 보존합니다. 실제 사용 범위는 Agent Key의 서버 권한으로 결정됩니다.

## CLI로 도구 사용

먼저 검색 결과에서 정확한 도구 이름을 찾고 스키마를 확인한 뒤 호출합니다. 이름·필수 인자·사용 가능한 기능은 연결한 서버에서 조회한 결과를 따릅니다.

```sh
steercards tools workspace --limit 10 --cwd /absolute/path/project
steercards describe <tool-name> --cwd /absolute/path/project
steercards call <tool-name> --json '{"workspaceId":1}' --cwd /absolute/path/project
steercards call <tool-name> --file ./arguments.json --cwd /absolute/path/project
steercards call <tool-name> --stdin --cwd /absolute/path/project < arguments.json
```

`<tool-name>`과 JSON은 조회한 스키마에 맞게 바꿉니다. `--json`, `--file`, `--stdin`은 하나만 사용하며 모두 생략하면 `{}`를 전달합니다. 셸 기록에 남길 수 없는 내용은 파일 또는 표준 입력으로 전달하세요. 호출 결과에는 실제 워크스페이스 데이터가 포함될 수 있습니다. CLI는 JSON 결과를 출력하고 프로토콜·제품 오류 시 0이 아닌 종료 코드를 반환합니다. 쓰기 요청은 자동 재시도하지 않습니다.

`serve`는 MCP STDIO 연결용입니다. 터미널에서 직접 실행하면 클라이언트 입력을 기다리는 것이 정상입니다.

## Skill 설치

Skill은 에이전트에게 도구 탐색 순서와 Steercards 작업 요령을 제공합니다. MCP 연결과 Agent Key 설정은 별도로 필요합니다.

```sh
steercards skill install --client codex --cwd /absolute/path/project
steercards skill install --client claude-code --cwd /absolute/path/project
steercards skill install --client cursor --cwd /absolute/path/project
```

| 클라이언트 | 프로젝트 설치 위치 | 공식 안내 |
| --- | --- | --- |
| Codex | `.agents/skills/steercards/` | [Codex Skills](https://developers.openai.com/codex/skills) |
| Claude Code | `.claude/skills/steercards/` | [Claude Code Skills](https://code.claude.com/docs/en/skills) |
| Cursor | `.cursor/skills/steercards/` | [Cursor Skills](https://cursor.com/docs/skills) |

`--global`을 추가하면 위 상대 경로를 사용자 홈 아래에 적용합니다(예: Codex의 `~/.agents/skills/steercards/`). 같은 내용의 재설치는 성공하며 직접 수정한 파일을 덮어쓰려 하면 중단합니다. 업데이트 전에 변경한 파일을 백업하거나 병합하세요.

Claude Desktop은 로컬 Skill 폴더 설치 대신 ZIP을 만들어 앱의 Skill 업로드 UI로 추가합니다. 업로드 지원 여부는 계정·앱 설정에 따라 달라집니다. [Claude 공식 Skill 업로드 안내](https://support.claude.com/en/articles/12512180-use-skills-in-claude)를 확인하세요.

```sh
steercards skill export --output /absolute/path/steercards-skill.zip
```

`compact` 모드에서는 Skill을 업로드하지 않아도 `steercards_get_guide` 도구로 가이드를 읽을 수 있습니다. `full` 모드는 이 도구를 추가하지 않으며, `steercards://guide/overview`와 주제별 MCP resource를 제공합니다. Claude Desktop에서 `full` 모드를 사용할 때는 Skill ZIP을 업로드하거나, 클라이언트가 resource 읽기를 지원하는 경우 해당 resource로 가이드를 읽으세요.

## 검증 범위와 문제 해결

공통 MCP 프로토콜과 로컬 CLI·설정 생성은 로컬 fixture 자동 테스트로 검증합니다. 2026-10-19에는 MCP SDK로 실제 STDIO 서버에 연결해 `compact`의 4개 도구와 `full`의 141개 원격 도구를 확인했고, 두 모드에서 `list_workspaces` 읽기 호출이 성공했습니다. 원격 도구 수는 서버와 Agent Key 권한에 따라 달라집니다.

Claude Code, Codex 앱·CLI, Cursor, Claude Desktop 각각의 네이티브 UI 연결을 모두 검증한 것은 아닙니다. 로컬 자동 테스트·실제 STDIO 연결 검증·CI의 OS별 실행·개별 앱에서의 연결 확인은 서로 다른 검증 범위입니다.

- 인증 오류: `doctor --cwd …`로 키 탐지 여부를 확인하고 `doctor --connect`로 읽기 전용 연결을 검사하세요. 키 값은 보고서나 이슈에 붙이지 마세요.
- GUI에서만 실행 실패: Node 22 이상을 설치하고 `--local` 설정을 다시 생성해 절대 실행 경로와 `--cwd`를 확인하세요.
- 도구가 보이지 않음: MCP 서버를 다시 연결하고 `tools`로 원격 목록을 확인하세요. 특정 키에 없는 권한을 이 패키지가 추가하지는 않습니다.
- 설정 충돌: 출력 전체로 기존 파일을 덮어쓰지 말고 `steercards` 서버 항목만 병합하세요. TOML에서는 같은 테이블을 중복 선언하지 마세요.

## 개발·기여·릴리스

```sh
npm ci
npm run check
npm test
npm run build
npm pack --dry-run
```

CI는 Linux·macOS·Windows의 Node 22·24에서 같은 검사를 실행합니다. 테스트는 로컬 fixture를 사용하며 실제 Agent Key가 필요하지 않습니다. 기여 방법은 [CONTRIBUTING.md](CONTRIBUTING.md), 보안 보고는 [SECURITY.md](SECURITY.md)를 참고하세요.

실제 공개 저장소 주소와 npm scope 소유권은 첫 게시 전에 확정해야 합니다. 아직 존재하지 않는 저장소 주소나 배지를 문서에 넣지 않습니다.

첫 릴리스 전 체크리스트:

1. 공개 저장소를 확정하고 `package.json`의 `repository`, `bugs`, `homepage`를 실제 주소로 추가합니다.
2. npm의 `@steercards` scope 권한과 이름·버전 사용 가능 여부를 확인합니다. `npm whoami`, `npm view @steercards/agent-tools`로 계정과 기존 배포를 확인합니다.
3. 위 검사를 실행하고 `npm pack --dry-run`의 파일 목록을 검사합니다. `.env`, 키, fixture 비밀이 포함되지 않아야 하며 `dist`, Skill, README, LICENSE가 포함되어야 합니다.
4. `npm pack`으로 tarball을 만들고 별도 디렉터리에서 설치·`--help`·설정 생성·Skill ZIP을 확인합니다. 테스트용 계정으로 읽기 전용 실제 MCP 연결과 사용할 각 앱의 연결을 확인합니다.
5. [npm 공식 게시 안내](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages)에 따라 인증·2FA 또는 trusted publishing을 구성합니다. 지원되는 CI에서 공개 저장소와 출처 증명을 연결할 때는 [npm provenance 안내](https://docs.npmjs.com/generating-provenance-statements)를 따릅니다. 검토가 끝난 릴리스만 `npm publish --access public`로 게시합니다.

이 저장소의 CI는 검증만 수행하며 npm에 자동 게시하지 않습니다.

## 라이선스

[MIT](LICENSE), Copyright (c) 2026 Steercards contributors.
