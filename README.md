# Steercards Agent Tools

Steercards의 전체 MCP 도구를 CLI와 에이전트에서 사용할 수 있게 하는 독립형 Node.js 도구입니다. MIT 라이선스이며 Node.js 22 이상이 필요합니다.

- 원격 서버의 도구 목록·설명·입력 스키마를 실행 시 조회합니다. 도구 목록을 패키지에 고정하지 않습니다.
- 기본 `compact` 모드는 검색 → 스키마 확인 → 호출 흐름으로 초기 도구 노출을 줄입니다.
- `full` 모드는 원격 도구를 각각 노출합니다.
- 프로젝트 `.env`를 읽는 STDIO MCP 서버, 단독 CLI, 설치 가능한 Skill을 함께 제공합니다.

패키지 이름은 `@steercards/agent-tools`, 실행 명령은 `steercards`입니다. npm에서 설치하거나 소스에서 빌드해 사용할 수 있습니다.

## 소스에서 설치

소스 디렉터리에서 빌드한 뒤 `setup --local`을 실행합니다.

```sh
npm ci
npm run build
node /absolute/path/agent-tools/dist/cli.js setup --client codex-app --cwd /absolute/path/project --local
```

`setup` 한 번으로 Steercards MCP 설정과 Skill을 함께 설치합니다. 키 없이 설치할 수 있으며 `.env`를 만들거나 덮어쓰지 않습니다. 설치 뒤 프로젝트에 `.env.example`을 참고한 `.env`를 만들고 실제 Agent Key를 입력하세요.

```dotenv
STEERCARDS_AGENT_KEY=your-agent-key
# 기본값을 사용할 때는 생략합니다.
STEERCARDS_MCP_URL=https://steercards.com/api/mcp
```

프로젝트 `.gitignore`에 `.env`와 `.steercards/`를 추가하세요. `.steercards/`에는 프로젝트별 설치 기록과 Desktop용 Skill ZIP이 들어갑니다. 설치 기록은 다음 업데이트에 필요한 로컬 소유권 정보이므로 보존하세요. 절대 경로를 포함하므로 다른 프로젝트·컴퓨터로 복사하거나 프로젝트 이동 후 그대로 재사용할 수 없습니다.

클라이언트에서 필요한 MCP 승인과 재시작·다시 연결을 마친 뒤 확인합니다.

```sh
node /absolute/path/agent-tools/dist/cli.js doctor --cwd /absolute/path/project --connect
```

`doctor`는 키 값을 출력하지 않습니다. `--connect`를 추가하면 원격 서버에 연결하고 워크스페이스 목록을 조회하는 읽기 전용 검사를 수행합니다. 생략하면 로컬 설정만 확인합니다.

## npm 설치와 업데이트

처음 설치할 때와 새 버전으로 업데이트할 때 같은 명령을 사용합니다.

```sh
npx -y @steercards/agent-tools@latest setup --client codex-app --cwd /absolute/path/project
```

실행한 패키지 버전의 MCP 설정과 Skill을 함께 적용합니다. npx 기반 MCP 실행 명령은 해당 버전에 고정되므로 Skill과 같은 버전을 사용합니다. 같은 버전·옵션으로 다시 실행하면 변경 없이 성공합니다. 기존 설치에서는 생략한 실행 옵션(`--local`, `--mode`, `--url`, `--env-file`)을 설치 기록에서 유지합니다. `--local` 설치는 새 소스를 받은 뒤 `npm ci`, `npm run build`를 실행하고 같은 `setup --local` 명령을 다시 실행하세요.

소스의 `--local` 설치를 npm 실행 방식으로 전환할 때는 `--npx`를 지정합니다. 이후 MCP 설정은 실행한 패키지 버전의 npx 명령을 사용합니다.

```sh
npx -y @steercards/agent-tools@latest setup --client codex-app --cwd /absolute/path/project --npx
```

전역 설치를 선택했다면 패키지를 업데이트한 뒤 `setup`을 다시 실행합니다.

```sh
npm install --global @steercards/agent-tools@latest
steercards setup --client codex-app --cwd /absolute/path/project
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

## 클라이언트 설치·업데이트

```sh
steercards setup --client codex-app --cwd /absolute/path/project
steercards setup --client claude-code --cwd /absolute/path/project
steercards setup --client cursor --cwd /absolute/path/project
steercards setup --client claude-desktop --cwd /absolute/path/project
```

TTY에서 `--client`를 생략하면 사용할 클라이언트를 선택합니다. CI·스크립트 등 대화형 입력을 사용할 수 없는 환경에서는 `--client`를 지정해야 합니다. `codex`, `codex-app`, `codex-cli`는 같은 Codex 설치 위치를 사용합니다.

| 클라이언트 | `--client` | MCP 설정과 Skill 설치 위치 |
| --- | --- | --- |
| Codex 앱·CLI | `codex`, `codex-app`, `codex-cli` | 프로젝트 `.codex/config.toml`과 `.agents/skills/steercards/`. 프로젝트 설정은 신뢰한 프로젝트에서 사용합니다. [공식 MCP 설정](https://developers.openai.com/codex/mcp), [Skills](https://developers.openai.com/codex/skills) |
| Claude Code | `claude-code` | 프로젝트 `.mcp.json`과 `.claude/skills/steercards/`. [공식 MCP 설정](https://code.claude.com/docs/en/mcp), [Skills](https://code.claude.com/docs/en/skills) |
| Cursor | `cursor` | 프로젝트 `.cursor/mcp.json`과 `.cursor/skills/steercards/`. [공식 MCP 설정](https://cursor.com/docs/mcp), [Skills](https://cursor.com/docs/skills) |
| Claude Desktop | `claude-desktop` | 아래 OS별 사용자 MCP 설정과 프로젝트 `.steercards/steercards-skill.zip`. [로컬 MCP 연결 안내](https://modelcontextprotocol.io/docs/develop/connect-local-servers) |

Claude Desktop 자동 설치는 macOS와 Windows를 지원합니다. MCP 설정은 macOS의 `~/Library/Application Support/Claude/claude_desktop_config.json`, Windows의 `%APPDATA%\Claude\claude_desktop_config.json`에 병합합니다. Desktop은 사용자 설정이므로 선택한 프로젝트의 `--cwd`가 연결 대상이 됩니다. 생성한 ZIP은 앱의 Skill 업로드 UI에서 직접 추가해야 하며 업데이트 후에는 새 ZIP을 다시 업로드합니다. 계정·앱의 업로드 지원 여부는 [Claude 공식 Skill 안내](https://support.claude.com/en/articles/12512180-use-skills-in-claude)를 확인하세요.

소스에서 빌드한 경우 `--local`을 사용하세요. 실제 Node 실행 파일과 `dist/cli.js`의 절대 경로를 MCP 설정에 넣으므로 해당 설치 디렉터리를 유지해야 합니다. Windows GUI에서도 실행 경로를 확실히 고정하는 이 방식을 권장합니다. `--local`을 생략한 설정은 `npx`를 사용하므로 클라이언트에서 `npx`를 실행할 수 있어야 합니다.

지원 옵션:

```sh
steercards setup [--client CLIENT] [--local | --npx] [--dry-run] [--cwd PATH] [--env-file PATH] [--url URL] [--mode compact|full]
```

`--dry-run`은 파일을 쓰지 않고 예정된 작업만 보여줍니다. 키를 출력하거나 연결 검사를 수행하지 않습니다. `setup`은 코드 클라이언트를 프로젝트 범위에 설치하며 `--global`을 지원하지 않습니다. `--env-file`, `--url`, `--mode`는 생성할 MCP 실행 옵션에도 반영됩니다. 같은 버전에서도 옵션을 바꾸면 해당 설정을 갱신합니다. `--local`과 `--npx`는 함께 사용할 수 없으며 `--npx`는 `setup` 전용 옵션입니다.

```sh
steercards setup --client cursor --cwd /absolute/path/project --dry-run
```

`setup`은 기존 설정의 Steercards MCP 항목만 병합하고 다른 서버·설정·주석과 사용자 파일은 보존합니다. `.steercards/setup/*.json`에 설치한 버전·옵션과 관리 파일의 해시를 기록하여 다음 업데이트에서 비교합니다. 관리 기록 없이 이전 `config`·`skill install` 명령으로 설치한 경우에도 현재 생성할 MCP 관리 필드와 Skill 파일이 같으면 관리 대상으로 등록합니다. Codex TOML은 이전 `config`의 정확한 출력 형식이어야 합니다. 그 외의 기존 충돌 항목이나 사용자가 수정한 관리 설정·Skill이 있으면 파일을 쓰기 전에 중단합니다. 충돌 시 수정 내용을 별도로 보관하고 기존 항목과 설치 기록을 검토한 뒤 수동 병합하거나 다시 설치하세요. 일반적인 쓰기 실패는 이전 파일로 복구하지만 전원 차단까지 포함한 원자적 저장을 보장하지 않습니다.

기본 `compact` 모드가 노출하는 도구는 다음 네 개입니다.

| 도구 | 용도 |
| --- | --- |
| `steercards_search_tools` | 필요한 원격 도구 검색 |
| `steercards_describe_tool` | 선택한 도구의 설명·입력 스키마 확인 |
| `steercards_call_tool` | 확인한 이름과 인자로 원격 도구 호출 |
| `steercards_get_guide` | Steercards 사용 가이드 조회 |

클라이언트가 개별 도구 노출을 필요로 하면 `setup`에 `--mode full`을 추가하세요.

```sh
steercards setup --client codex-app --cwd /absolute/path/project --mode full
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

## 고급: 설정 조각과 Skill 개별 설치

기본 설치·업데이트에는 `setup`을 사용하세요. 직접 설정을 관리하려면 기존 개별 명령도 사용할 수 있습니다.

```sh
steercards config codex-app --cwd /absolute/path/project
steercards config cursor --cwd /absolute/path/project --local
steercards skill install --client codex --cwd /absolute/path/project
steercards skill install --client claude-code --cwd /absolute/path/project
steercards skill install --client cursor --cwd /absolute/path/project
steercards skill export --output /absolute/path/steercards-skill.zip
```

`config`는 설정 조각만 출력하며 클라이언트 설정을 수정하지 않습니다. 출력 내용을 기존 파일에 수동 병합해야 합니다. `skill install --global`은 사용자 홈 아래의 해당 클라이언트 Skill 디렉터리에 개별 설치합니다. 개별 Skill 설치는 같은 내용이면 성공하고 변경된 기존 디렉터리는 덮어쓰지 않습니다. 이 명령들은 MCP·Skill을 함께 갱신하거나 `setup`의 관리 기록을 만들지 않습니다.

Skill은 도구 탐색 순서와 작업 요령을 제공합니다. `compact` 모드에서는 Skill을 업로드하지 않아도 `steercards_get_guide` 도구로 가이드를 읽을 수 있습니다. `full` 모드는 이 도구를 추가하지 않으며, `steercards://guide/overview`와 주제별 MCP resource를 제공합니다. Claude Desktop에서 `full` 모드를 사용할 때는 Skill ZIP을 업로드하거나, 클라이언트가 resource 읽기를 지원하는 경우 해당 resource로 가이드를 읽으세요.

## 검증 범위와 문제 해결

공통 MCP 프로토콜과 로컬 CLI·설정 생성은 로컬 fixture 자동 테스트로 검증합니다. 2026-10-19에는 MCP SDK로 실제 STDIO 서버에 연결해 `compact`의 4개 도구와 `full`의 141개 원격 도구를 확인했고, 두 모드에서 `list_workspaces` 읽기 호출이 성공했습니다. 원격 도구 수는 서버와 Agent Key 권한에 따라 달라집니다.

Claude Code, Codex 앱·CLI, Cursor, Claude Desktop 각각의 네이티브 UI 연결을 모두 검증한 것은 아닙니다. 로컬 자동 테스트·실제 STDIO 연결 검증·CI의 OS별 실행·개별 앱에서의 연결 확인은 서로 다른 검증 범위입니다.

- 인증 오류: `doctor --cwd …`로 키 탐지 여부를 확인하고 `doctor --connect`로 읽기 전용 연결을 검사하세요. 키 값은 보고서나 이슈에 붙이지 마세요.
- GUI에서만 실행 실패: Node 22 이상을 설치하고 `--local` 설정을 다시 생성해 절대 실행 경로와 `--cwd`를 확인하세요.
- 도구가 보이지 않음: MCP 서버를 다시 연결하고 `tools`로 원격 목록을 확인하세요. 특정 키에 없는 권한을 이 패키지가 추가하지는 않습니다.
- 설치 충돌: `setup --dry-run`으로 예정된 작업을 확인하고 `.steercards/setup/` 기록과 기존 Steercards 항목·Skill 수정 사항을 검토하세요. 기존 파일을 통째로 교체하거나 관리 기록만 지워서 업데이트를 강제하지 마세요.

## 개발·기여·릴리스

```sh
npm ci
npm run check
npm test
npm run build
npm pack --dry-run
```

CI는 Linux·macOS·Windows의 Node 22·24에서 같은 검사를 실행합니다. 테스트는 로컬 fixture를 사용하며 실제 Agent Key가 필요하지 않습니다. 기여 방법은 [CONTRIBUTING.md](CONTRIBUTING.md), 보안 보고는 [SECURITY.md](SECURITY.md)를 참고하세요.

공개 소스는 [velody-ai/steercards-agent-tools](https://github.com/velody-ai/steercards-agent-tools)에서 관리합니다. 안정 버전 GitHub Release를 게시하면 `publish.yml`이 태그·패키지 버전과 main 포함 여부를 확인하고 검사를 다시 실행한 뒤 npm에 게시합니다. 인증은 GitHub OIDC trusted publishing을 사용하며 공개 패키지에 provenance를 연결합니다.

최초 npm 설정, 릴리스 명령, 게시·설치 확인과 실패 대응은 [npm 릴리스 안내](docs/releases.md)를 따릅니다.

## 라이선스

[MIT](LICENSE), Copyright (c) 2026 Steercards contributors.
