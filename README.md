# Steercards Agent Tools

Steercards의 전체 MCP 도구를 CLI와 에이전트에서 사용할 수 있게 하는 독립형 Node.js 도구입니다. MIT 라이선스이며 Node.js 22 이상이 필요합니다. CLI도 지원 버전을 검사하며, 구버전이면 안내 오류와 함께 중단합니다.

- 원격 서버의 도구 목록·설명·입력 스키마를 실행 시 조회합니다. 도구 목록을 패키지에 고정하지 않습니다.
- 기본 `compact` 모드는 검색 → 스키마 확인 → 호출 흐름으로 초기 도구 노출을 줄입니다.
- `full` 모드는 원격 도구를 각각 노출합니다.
- 프로젝트 `.env`를 읽는 STDIO MCP 서버, 단독 CLI, 설치 가능한 Skill을 함께 제공합니다.

패키지 이름은 `@steercards/agent-tools`, 실행 명령은 `steercards`입니다. npm에서 설치하거나 소스에서 빌드해 사용할 수 있습니다.

## 일회용 프롬프트로 연결

Steercards의 Agent 연결 화면에서 Key 설정을 선택하고 설치 프롬프트를 복사해 사용할 프로젝트의 에이전트에게 전달하세요. 프롬프트에는 10분 동안 한 번 사용할 설치 코드가 들어갑니다. 에이전트는 실제 클라이언트·OS·프로젝트를 확인해 설치합니다. 설치기는 코드를 선택한 기존 Agent Key 또는 새로 발급한 Key로 교환하여 현재 프로젝트의 `.env`에만 저장하고, `.gitignore` 보호·MCP 설정·Skill 설치와 읽기 전용 연결 검사를 수행합니다. 기존 Key를 선택하면 같은 Key를 재사용하며 새 Key를 만들거나 기존 Key를 자동 폐기하지 않습니다. 장기 키를 프롬프트에 붙여넣을 필요가 없습니다.

직접 실행하는 경우 아래 코드 자리를 앱에서 발급한 설치 코드로 바꿉니다. POSIX 셸 예시:

```sh
npx -y -- @steercards/agent-tools@latest setup --client codex-app --cwd . --env-file .env --url https://steercards.com/api/mcp --setup-code-stdin --confirm-existing-key <<'STEERCARDS_SETUP_CODE'
<일회용 설치 코드>
STEERCARDS_SETUP_CODE
```

Windows PowerShell에서는 같은 코드를 here-string으로 전달합니다.

```powershell
@'
<일회용 설치 코드>
'@ | npx -y -- @steercards/agent-tools@latest setup --client codex-app --cwd . --env-file .env --url https://steercards.com/api/mcp --setup-code-stdin --confirm-existing-key
```

`--cwd .`는 실행한 현재 프로젝트를 뜻하며 생략해도 같습니다. `--client`는 선택한 클라이언트로 바꾸고, 다른 서버를 사용한다면 그 서버의 MCP URL을 명시하세요. 설치 코드와 발급된 키는 명령 인자·출력·설치 기록에 넣지 않습니다. 자동 연결 검사는 호출 프로세스의 다른 키보다 저장한 `.env`의 키를 사용합니다.

`--confirm-existing-key`는 프로젝트 `.env`에 Key가 있으면 파일을 쓰거나 코드를 교환하기 전에 `status:"confirmation-required"`, `ok:false`와 질문·선택지를 반환합니다. 종료 코드 0인 정상 대기 상태이며 설치 성공을 뜻하지 않습니다. 에이전트는 “.env에 Key가 있어요. 기존 키를 사용하시겠습니까?”를 묻고 답변을 기다립니다. 유지하면 같은 명령에 `--keep-agent-key`, 설치 코드의 Key를 사용하면 `--replace-agent-key`를 하나만 추가해 다시 실행합니다. `--keep-agent-key`는 Key가 없어졌거나 파싱이 잘못되면 중단하며 새 Key를 자동 발급하지 않습니다. 확인 흐름에서는 빈 Key 할당도 중단합니다. `.env`에 Key 변수가 없으면 질문 없이 진행합니다. 선택하는 동안 코드가 만료되면 앱에서 새 설치 프롬프트를 받아야 합니다.

기존 `.env`의 다른 값·주석·개행을 보존합니다. 확인 옵션을 생략한 이전 명령은 기존 동작대로 Key를 유지하고 코드를 교환하지 않습니다. 교체할 때에도 이전 키를 서버에서 자동 폐기하지 않습니다. 설치 코드는 앱에서 선택한 기존 Key를 재사용할 수도 있습니다. 자동 쓰기는 프로젝트 루트 `.env`만 지원합니다. 이전 설치가 다른 env 파일을 참조하면 교환 전에 중단하므로 `--env-file .env`로 전환을 명시합니다.

설치기는 `preflight`(사전 검사), `credentials`(Key 교환·저장), `install`(MCP·Skill 설치), `connection`(연결 검사)의 시작·완료·실패를 stderr의 JSON Lines로 출력합니다. Key를 유지할 때 교환·저장 단계는 `skipped`입니다. stdout에는 최종 JSON 한 개만 출력하며, `timings.totalMs`와 `timings.stages`에 단계별 `status`·`durationMs`를 담습니다. 아직 시작하지 않은 단계는 `pending`입니다. 진행 이벤트는 `type:"steercards-setup-progress"`, `stage`, `status`, `elapsedMs`, 완료 시 `durationMs`만 포함하며 코드·키·HTTP 본문을 포함하지 않습니다. 시간은 **설치기 실행부터 보고서 반환까지**이며 앞선 npm/npx 패키지 다운로드 시간은 제외합니다. 자동 연결 검사는 한 번 수행하고 최대 15초 후 실제 HTTP 요청을 취소합니다. 성공한 뒤 별도로 `doctor --connect`를 반복할 필요는 없습니다.

`.env`가 Git에 추적되거나 파일·설정·Skill 충돌, symlink, 잠금·쓰기 문제가 있으면 교환 전에 중단합니다. `.gitignore`의 기존 negation 뒤에 보호 규칙을 보완합니다. `--dry-run`은 코드를 소비하거나 파일을 쓰지 않습니다.

키 저장 뒤 MCP·Skill 설치나 연결 검사에 실패해도 `.env`를 보존합니다. 충돌을 정리하고 코드 옵션 없이 일반 setup과 `doctor --connect`를 다시 실행하세요. 교환 응답 유실이나 키 저장 실패에서는 코드를 다시 소비하지 말고 먼저 프로젝트 `.env`에 Key가 저장됐는지 확인합니다. 저장됐다면 그 Key를 보존하고 같은 복구 절차를 따릅니다. 저장되지 않았다면 웹에서 코드 상태와 선택한 Key를 확인하세요. 재사용한 기존 Key는 보존하고, 사용 가능한 같은 Key로 새 코드를 발급합니다. 선택한 Key가 만료·폐기됐거나 접근 권한이 바뀌었다면 상태·권한을 확인한 후 사용 가능한 Key를 선택합니다. 새로 발급한 Key만 실제로 사용하지 않는지 확인한 뒤 사용자가 명시적으로 폐기할 수 있으며, 설치 실패만으로 Key를 자동 폐기하거나 교체하지 않습니다. 실패 복구를 위해 키 원문을 채팅·로그에 붙여넣지 마세요. Desktop의 Skill ZIP 업로드와 클라이언트 재연결은 아래 안내를 따릅니다.

## 소스에서 설치

소스 디렉터리에서 빌드한 뒤 `setup --local`을 실행합니다.

```sh
npm ci
npm run build
node -- /absolute/path/agent-tools/dist/cli.js setup --client codex-app --cwd /absolute/path/project --local
```

코드 옵션 없는 `setup`은 Steercards MCP 설정과 Skill을 키 없이 설치하며 `.env`를 변경하지 않습니다. 수동 연결에서는 설치 뒤 프로젝트에 `.env.example`을 참고한 `.env`를 만들고 실제 Agent Key를 입력하세요.

```dotenv
STEERCARDS_AGENT_KEY=your-agent-key
# 기본값을 사용할 때는 생략합니다.
STEERCARDS_MCP_URL=https://steercards.com/api/mcp
```

프로젝트 `.gitignore`에 `.env`와 `.steercards/`를 추가하세요. `.steercards/`에는 프로젝트별 설치 기록과 Desktop용 Skill ZIP이 들어갑니다. 설치 기록은 다음 업데이트에 필요한 로컬 소유권 정보이므로 보존하세요. 절대 경로를 포함하므로 다른 프로젝트·컴퓨터로 복사하거나 프로젝트 이동 후 그대로 재사용할 수 없습니다.

클라이언트에서 필요한 MCP 승인과 재시작·다시 연결을 마친 뒤 확인합니다.

```sh
node -- /absolute/path/agent-tools/dist/cli.js doctor --cwd /absolute/path/project --connect
```

`doctor`는 키 값을 출력하지 않습니다. `--connect`를 추가하면 원격 서버에 연결하고 워크스페이스 목록을 조회하는 읽기 전용 검사를 수행합니다. 생략하면 로컬 설정만 확인합니다.

## npm 설치와 업데이트

처음 설치하거나 이전 버전 고정 설치를 자동 갱신 방식으로 전환할 때 실행합니다.

```sh
npx -y -- @steercards/agent-tools@latest setup --client codex-app --cwd /absolute/path/project
```

최초 설치는 실행한 패키지의 MCP 설정과 Skill을 함께 적용합니다. npm 기반 MCP 명령은 `npx -y -- @steercards/agent-tools@latest serve --client <클라이언트> ...`를 사용합니다. 다음 MCP 프로세스 시작 때 npm의 `latest` 태그와 캐시 정책에 따라 패키지를 선택하며, 이미 실행 중인 프로세스를 교체하지 않습니다. 네트워크·캐시 상태에 따라 반영 시점이 달라질 수 있으므로 게시 즉시 모든 설치가 바뀐다는 의미는 아닙니다. [npm exec 캐시 안내](https://docs.npmjs.com/cli/commands/npm-exec/#a-note-on-caching)를 참고하세요.

시작한 패키지가 설치 기록보다 새 안정 버전이면, 유효한 `.steercards/setup/` 관리 기록과 같은 클라이언트·프로젝트·실행 옵션의 npm 설정에 한해 관리된 Skill과 설정을 갱신합니다. 기존 해시·잠금·롤백 검사를 사용하며 사용자 수정·삭제·권한·잠금·경합 문제가 있으면 자동 덮어쓰기를 막고 stderr에 안내한 뒤 MCP 시작을 계속합니다. 더 새 버전의 관리 파일을 이전 프로세스가 되돌리지 않습니다. 자격증명 교환·변경이나 추가 연결 검사는 수행하지 않습니다. 앞단의 npx 다운로드 자체가 실패하면 패키지가 시작되지 않으므로 이 연결 유지 범위에 포함되지 않습니다.

기존 버전 고정 MCP 설정은 스스로 바뀔 수 없으므로 위 최신 `setup`을 **한 번** 실행하고 MCP를 재연결해야 합니다. 이후 관리 설치는 MCP 재시작으로 갱신하며, 이미 대화에 로드한 Skill은 다음 세션이나 클라이언트 새로고침 후 반영됩니다. 수동 `config` 조각이나 개별 `skill install`만 사용한 미관리 설치는 시작할 때 새로 설치하거나 관리 대상으로 채택하지 않습니다. Claude Desktop의 관리 ZIP도 갱신하지만 앱에 올린 Skill을 교체할 수는 없으므로 새 ZIP 업로드는 수동입니다.

같은 버전·옵션의 `setup`은 변경 없이 성공합니다. 기존 설치에서는 생략한 실행 옵션(`--local`, `--mode`, `--url`, `--env-file`)을 설치 기록에서 유지합니다. `--local`은 npm 자동 갱신으로 전환하지 않습니다. 새 소스를 받은 뒤 `npm ci`, `npm run build`와 같은 `setup --local` 명령을 실행하세요.

소스의 `--local` 설치를 npm 자동 갱신 방식으로 전환할 때는 `--npx`를 지정합니다. 이후 MCP 설정은 `@latest` npx 명령을 사용합니다.

```sh
npx -y -- @steercards/agent-tools@latest setup --client codex-app --cwd /absolute/path/project --npx
```

전역 CLI 설치와 `skill install --global`로 복사한 스킬은 수동으로 갱신합니다. 전역 CLI를 갱신하고 `setup`을 실행하면 해당 프로젝트에는 위 npm 자동 갱신 설정을 적용합니다.

```sh
npm install --global @steercards/agent-tools@latest
steercards setup --client codex-app --cwd /absolute/path/project
```

이하 `steercards` 명령은 전역 설치를 기준으로 합니다. 소스 빌드 사용자는 `node -- /absolute/path/agent-tools/dist/cli.js`로 대체하면 됩니다.

## 환경 설정

| 설정 | 동작 |
| --- | --- |
| `STEERCARDS_AGENT_KEY` | Steercards Agent Key. 원격 요청에 필요합니다. |
| `STEERCARDS_MCP_URL` | 선택 사항. 기본값은 `https://steercards.com/api/mcp`입니다. |
| `--cwd PATH` | 프로젝트 디렉터리를 고정합니다. 생략하면 프로세스의 현재 디렉터리를 사용합니다. |
| `--env-file PATH` | 기본 `.env` 대신 읽을 파일입니다. 상대 경로는 `--cwd` 기준입니다. |
| `--url URL` | 이번 실행의 MCP URL을 지정합니다. 환경 변수보다 우선합니다. |

이미 설정된 프로세스 환경 변수가 `.env`보다 우선합니다. 기본 `.env`는 지정한 디렉터리에서만 찾으며 상위 디렉터리를 탐색하지 않습니다. dotenv 값에 셸 명령이나 `${VARIABLE}` 확장을 수행하지 않습니다. 원격 URL은 HTTPS를 사용하며 로컬 개발용 loopback 주소만 HTTP를 허용합니다. URL의 인증 정보·쿼리·fragment는 허용하지 않습니다.

프로젝트 밖에서도 상대 파일을 선택할 수 있습니다.

```sh
steercards doctor --cwd /absolute/path/project --env-file alternate.env
npx -y -- @steercards/agent-tools@latest doctor --cwd /absolute/path/project --env-file alternate.env
```

`npx`에서는 패키지 이름 앞의 `--`를 유지하세요. Node 22 일부 버전은 프로그램 뒤의 `--env-file`도 시작 전에 검사하므로 이 경계가 필요합니다. 직접 Node로 실행할 때도 위 예시처럼 스크립트 경로 앞에 `--`를 넣습니다. 설치된 `steercards`와 새로 생성한 MCP 설정은 이 경계를 포함합니다. 기존 MCP 설정은 업데이트 후 `setup`을 다시 실행해 갱신하세요. Windows에서는 Node 22·24에 포함된 npm의 CMD·PowerShell shim을 사용합니다.

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
  [--setup-code-stdin] [--replace-agent-key]
```

`--dry-run`은 파일을 쓰지 않고 예정된 작업만 보여줍니다. 키를 출력하거나 연결 검사를 수행하지 않습니다. `setup`은 코드 클라이언트를 프로젝트 범위에 설치하며 `--global`을 지원하지 않습니다. `--env-file`, `--url`, `--mode`는 생성할 MCP 실행 옵션에도 반영됩니다. 같은 버전에서도 옵션을 바꾸면 해당 설정을 갱신합니다. `--local`과 `--npx`는 함께 사용할 수 없으며 `--npx`는 `setup` 전용 옵션입니다.

```sh
steercards setup --client cursor --cwd /absolute/path/project --dry-run
```

`setup`은 기존 설정의 Steercards MCP 항목만 병합하고 다른 서버·설정·주석과 사용자 파일은 보존합니다. `.steercards/setup/*.json`에 설치한 버전·옵션과 관리 파일의 해시를 기록하여 다음 업데이트에서 비교합니다. 관리 기록 없이 이전 `config`·`skill install` 명령으로 설치한 경우에도 현재 생성할 MCP 관리 필드와 Skill 파일이 같으면 관리 대상으로 등록합니다. Codex TOML은 이전 `config`의 정확한 출력 형식이어야 합니다. 그 외의 기존 충돌 항목이나 사용자가 수정한 관리 설정·Skill이 있으면 파일을 쓰기 전에 중단합니다. 충돌 시 수정 내용을 별도로 보관하고 기존 항목과 설치 기록을 검토한 뒤 수동 병합하거나 다시 설치하세요. 일반적인 쓰기 실패는 이전 파일로 복구하지만 전원 차단까지 포함한 원자적 저장을 보장하지 않습니다.

`Managed skill file was changed or removed`가 나오면 로컬 수정본을 먼저 백업하고 최신 패키지의 `skills/steercards/`와 직접 비교·병합하세요. 기존 설치 해시와 달라도 현재 관리 파일이 새 배포본의 같은 파일과 **byte 단위로 완전히 같으면**, 이미 병합된 파일로 인정하므로 `setup`을 다시 실행할 수 있습니다. 나머지 관리 파일은 기존 보호 검사 후 갱신하며 설정·키는 보존합니다. 새 배포본과 다른 고유 사용자 수정이나 누락된 관리 파일은 계속 충돌로 보호합니다. 사용자 고유 내용까지 자동 병합하지 않으며, 설치 기록을 삭제하거나 해시를 바꿔 강제 적용하지 마세요.

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

## 카드 작업 배지

카드의 실제 작업을 시작하기 전에 `set_agent_status`로 `working`을 표시하고 5분마다 갱신합니다. 10분이 지나면 응답 없음으로 보이므로 그 전에 갱신합니다. 사람의 답을 기다릴 때는 `waiting_for_input`과 `question`, 작업을 막는 오류는 `error`, 재개할 때는 `working`을 사용합니다. 답이나 오류 해결을 기다리는 동안은 턴이 끝나도 해당 배지를 유지하고, 실제 완료·중단·인계 전에는 `clear_agent_status`로 정리합니다. `finally`에서 무조건 지우지 않습니다. 조회나 단순 배정만으로는 배지를 만들지 않습니다.

claim이 관리하는 카드에서는 상태 쓰기에 현재 `claimFence`를 전달하고 claim을 반납·이전하기 전에 유효한 fence로 정리합니다. 소유권을 잃은 뒤에는 쓰기를 중단하고 다른 담당자의 배지를 지우지 않습니다. 배지는 카드 업무 상태·claim lease·run heartbeat와 별개이며 이를 자동으로 변경하거나 갱신하지 않습니다. 입력은 항상 현재 원격 스키마로 확인합니다.

이 기본 흐름은 MCP 초기 instructions, compact 호출 도구 설명과 배포 Skill 첫 부분에 포함됩니다. 이전 Skill을 쓰거나 초기 instructions를 표시하지 않는 호스트에서도 최신 MCP의 호출 도구 설명으로 확인할 수 있습니다. 이전 설치는 최신 `setup`을 한 번 실행한 뒤 위 [자동 갱신 흐름](#npm-설치와-업데이트)을 따릅니다. 사용자가 수정했거나 관리 기록 없이 내용이 다른 Skill은 보존하고 충돌 내용을 검토해 수동 병합합니다. `skill install` 단독 명령은 내용이 다른 기존 Skill을 덮어쓰지 않습니다. Claude Desktop에 업로드한 Skill은 새 ZIP을 다시 업로드합니다.

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

## 카드 본문을 디렉터리처럼 탐색

단순 카드 찾기는 `search_cards`를 사용합니다. `query`는 **제목과 본문을 모두 검색**하며 현재 스키마가 지원하는 범위·상태·승인·보관 필터를 결합할 수 있습니다. 여러 표현·범위를 조사하거나 근거 구절·줄 번호가 필요하면 `explore_cards`를 사용합니다. `explore` CLI는 선택한 워크스페이스의 카드 본문·댓글을 가상 파일로 읽고 검색하며, 실제 셸이나 벡터 검색을 실행하지 않습니다. 원격 서버가 해당 도구를 제공해야 합니다.

이미 아는 workspace/board/path에서 바로 시작합니다. 위치를 모를 때만 `ls`로 필요한 디렉터리·카드 제목을 확인하고, `find`는 경로·키만 찾는 데 사용합니다. 목록 요청은 검색 결과의 제목·관련성·링크가 충분하면 종료합니다. 충분한 snippets를 확인하려고 같은 본문을 `cat`/`get_card`로 다시 읽거나 `ls`를 반복하지 않습니다. 모호한 카드나 부족한 구절만 추가로 읽고, 상세 분석을 요청했을 때 깊이 조사합니다.

```sh
steercards describe explore_cards
# 알려진 보드에서 검색 한 번 → 모호한 카드만 추가 확인 → 목록 반환
steercards explore --workspace 123 --board 19 'rg -n -i -C 2 -g card.md "session|login" /projects/7/boards/19/cards'
# 검색 결과만으로 부족한 구절이 있을 때:
steercards explore --workspace 123 "sed -n '20,40p' /projects/7/boards/19/cards/SC-42/card.md"
```

예시 ID·키는 이미 확인한 값으로 바꿉니다. 경로는 `/projects/<projectId>/boards/<boardId>/cards/<현재 카드 키>/card.md`와 `comments.md`입니다. 댓글은 본문만으로 부족하거나 이력·논의를 요청할 때 보조로 읽습니다. 알려진 카드 키는 직접 조회하고, 참여자로 보드의 활성 카드를 찾을 때는 `list_participant_cards`를 사용합니다. 다른 속성 구조는 `get_board`와 현재 도구 스키마로 확인합니다.

`--board ID`, 반복 가능한 `--status VALUE`(최대 20개), `--archived active|archived|all`, `--include-relations`로 검색 범위와 메타데이터를 결합합니다. 숫자 상태는 양의 옵션 ID, 나머지는 정확한 옵션 이름으로 전달합니다. 보관 기본값은 서버의 `all`, 관계 기본값은 `false`입니다. 서버의 새 필터 배포가 선행되어야 하며, 다른 입력은 일반 `call explore_cards --json`/`--file`/`--stdin`으로 전달할 수 있습니다.

```sh
steercards explore --workspace 123 --board 19 --status 'In progress' --status 456 --archived active --include-relations 'rg -n -i -C 2 -g card.md "session|login" /projects/7/boards/19/cards'
```

출처 `sources`의 URL·실제 상태 속성과 카드별 `matches`의 문맥 묶음을 활용하면 추가 본문 조회 없이 목록을 작성할 수 있습니다. `matches[].snippets`는 시작·종료 줄, 실제 일치 줄, `outputStart`/`outputEnd`로 원본 `output`을 참조하며 텍스트를 복제하지 않습니다. offset은 JavaScript `String.slice`의 UTF-16 기준입니다. 상태 속성은 최대 20개로 제한되므로 `statusesComplete:false`이면 추가 상태가 생략될 수 있습니다. 선택 관계 요약은 부모·최대 10개의 접근 가능한 자식과 `childCount`/`childrenComplete`를 포함하며, 개수도 접근 가능한 관계만 집계합니다. 같은 카드는 안정적인 ID/현재 키로 합치고, 관련 이유·근거 줄·실제 검색 범위와 한계를 보고합니다. 의미 검색이나 모든 카드 검색을 보장하는 기능은 아닙니다.

명령 전체를 **하나의 따옴표 인자**로 전달하세요. `ls`, `find`, `rg`, `grep`, `cat`, `sed -n`, `head`, `tail`의 제한된 문법만 지원하며 정확한 옵션은 `help`를 따릅니다. 파이프·리다이렉션·확장·명령 연결·파일 쓰기는 지원하지 않습니다.

일반 `call`과 같은 전체 MCP JSON을 출력하여 제품 응답의 `workspaceId`, `output`, `complete`, `nextCursor`, `stopReason`, `exitCode`, `sources`, `matches`를 보존합니다. 더 읽어야 하고 `complete:false`이면 **같은 workspace·명령·모든 옵션**(보드·상태·보관·관계·maxChars 포함)으로 반환된 정확한 `nextCursor`를 전달합니다. `--max-chars`는 페이지당 1–16000자입니다.

```sh
steercards explore --workspace 123 --board 19 --archived active --max-chars 2000 'rg -n -C 2 -g card.md "session expired" /projects/7/boards/19/cards'
# 추가 근거가 필요할 때만 같은 옵션으로 이어갑니다.
steercards explore --workspace 123 --board 19 --archived active --max-chars 2000 --cursor '<nextCursor>' 'rg -n -C 2 -g card.md "session expired" /projects/7/boards/19/cards'
```

빈 출력도 `complete:false`이면 미완료입니다. 근거가 충분하면 이어보기를 멈추고 부분 결과임을 알립니다. 완료된 검색의 `exitCode:1`은 일치 없음이고, 제품 오류와 달리 CLI 프로세스는 0으로 종료합니다. 무효·만료·변경 충돌 커서는 버리고 처음부터 다시 읽습니다. [탐색 가이드](skills/steercards/references/exploration.md)에 자세한 흐름이 있으며 compact/full MCP, 설치 Skill과 ZIP에서도 같은 안내를 제공합니다.

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
npm run test:package
npm pack --dry-run
```

CI는 Linux·macOS·Windows의 Node 22·24에서 같은 검사를 실행합니다. `test:package`는 빌드한 tarball을 별도 프로젝트에 설치하고 실제 bin·npx 및 생성된 MCP 명령을 실행합니다. Windows에서는 CMD와 PowerShell shim도 검사합니다. 의존성은 lockfile과 `npm ci`의 캐시를 재사용하며 실제 Agent Key가 필요하지 않습니다. 기여 방법은 [CONTRIBUTING.md](CONTRIBUTING.md), 보안 보고는 [SECURITY.md](SECURITY.md)를 참고하세요.

공개 소스는 [velody-ai/steercards-agent-tools](https://github.com/velody-ai/steercards-agent-tools)에서 관리합니다. 안정 버전 GitHub Release를 게시하면 `publish.yml`이 태그·패키지 버전과 main 포함 여부를 확인하고 검사를 다시 실행한 뒤 npm에 게시합니다. 인증은 GitHub OIDC trusted publishing을 사용하며 공개 패키지에 provenance를 연결합니다.

최초 npm 설정, 릴리스 명령, 게시·설치 확인과 실패 대응은 [npm 릴리스 안내](docs/releases.md)를 따릅니다.

## 라이선스

[MIT](LICENSE), Copyright (c) 2026 Steercards contributors.
