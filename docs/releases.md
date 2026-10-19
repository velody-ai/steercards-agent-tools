# npm 릴리스

공개 패키지는 [`@steercards/agent-tools`](https://www.npmjs.com/package/@steercards/agent-tools), 소스는 [`velody-ai/steercards-agent-tools`](https://github.com/velody-ai/steercards-agent-tools)에서 관리합니다. 일반 CI는 검증을 수행하고, 안정 버전의 GitHub Release를 게시하면 `.github/workflows/publish.yml`이 npm에 게시합니다. 태그 push나 main 병합만으로는 게시하지 않습니다.

## 최초 설정

1. npm의 `steercards` 조직과 패키지 쓰기 권한을 확인합니다. 아직 존재하지 않는 패키지에는 일반 trusted publisher 설정을 추가할 수 없습니다. 첫 버전부터 GitHub Actions로 게시하려면 npm 11.15.0 이상에서 로그인하고 검증한 소스를 `npm stage publish --access public`로 준비합니다. [staged publishing](https://docs.npmjs.com/staged-publishing/)은 새 패키지에 공개 placeholder `0.0.0-stage`를 생성합니다. 실제 `0.1.0`은 승인 전까지 설치할 수 없습니다.
2. GitHub 저장소의 Settings → Environments에 `npm` 환경을 만듭니다. 릴리스 권한을 가진 유지관리자만 릴리스 태그를 만들 수 있도록 저장소 ruleset과 환경 보호 규칙을 관리합니다.
3. npm 패키지 Settings → Trusted Publisher에 아래 값을 등록합니다. 환경 이름까지 대소문자를 정확히 맞춥니다.

   | 항목 | 값 |
   | --- | --- |
   | Provider | GitHub Actions |
   | Organization or user | `velody-ai` |
   | Repository | `steercards-agent-tools` |
   | Workflow filename | `publish.yml` |
   | Environment name | `npm` |
   | Allowed actions | `npm publish` 허용 |

   신규 설정은 staged publish만 기본 허용할 수 있으므로 직접 게시 권한을 명시적으로 켭니다. 워크플로는 장기 npm 토큰 없이 GitHub OIDC로 인증합니다. `NPM_TOKEN`·`NODE_AUTH_TOKEN` secret은 추가하지 않습니다.
4. placeholder로 시작했다면 npm staged packages 화면이나 `npm stage` 명령으로 준비한 `0.1.0`을 reject합니다. staged 버전 제거와 `npm view @steercards/agent-tools@0.1.0`의 미게시 상태를 확인한 뒤 아래 GitHub Release 절차를 진행합니다. 같은 버전의 staged → reject → OIDC 직접 게시 전환은 최초 설정에서 실제 레지스트리 상태로 확인해야 합니다. staged 버전을 먼저 approve하면 같은 버전을 Actions에서 다시 게시할 수 없습니다. 새 trusted publisher는 등록 후 2일 안에 첫 게시를 성공해야 검증되므로 실제 게시를 바로 이어갈 때 등록합니다. 토큰 게시를 제한하려면 OIDC 확인 후 npm 패키지의 Publishing access를 **Require two-factor authentication and disallow tokens**로 설정합니다.

## 새 버전 게시

1. 버전 변경은 별도 PR로 검토합니다. `npm version patch --no-git-tag-version`(또는 `minor`/`major`)으로 `package.json`과 `package-lock.json`의 버전을 함께 올리고 main에 병합합니다. 첫 게시 시 이미 선언된 `0.1.0`을 사용할 수 있습니다.
2. README의 개발 검사를 실행하고 `npm pack --dry-run`의 포함 파일을 확인합니다. `.env`, 키, 테스트 데이터가 없어야 하며 `dist`, Skill, README, LICENSE가 포함되어야 합니다. 실제 tarball을 별도 디렉터리에 설치해 CLI와 `setup`도 확인합니다.
3. 통과한 main 커밋을 대상으로 `v<package.json 버전>` 태그의 안정 버전 GitHub Release를 게시합니다. CLI 예시:

   ```sh
   gh release create v0.1.0 --repo velody-ai/steercards-agent-tools --target <검증한-main-커밋-SHA> --title v0.1.0 --generate-notes
   ```

   예시 버전과 SHA는 실제 릴리스에 맞춥니다. 초안 저장만으로는 게시하지 않으며 prerelease는 건너뜁니다. `latest` 외의 배포 태그는 현재 워크플로의 지원 범위에 없습니다.
4. Actions의 **Publish to npm** 실행 성공을 확인합니다. 워크플로는 태그·버전 일치와 main 포함 여부를 확인한 뒤 Node 24/npm 11.5.1 이상에서 설치·타입 검사·테스트·빌드·패키지 목록 검사를 다시 실행합니다. 게시 빌드는 의존성 캐시를 사용하지 않고, 검증한 `dist`를 공개 접근·provenance와 함께 게시합니다.
5. `npm view @steercards/agent-tools@<버전> version dist.integrity dist.attestations`로 버전과 출처 증명을 확인합니다. 임시 프로젝트에서 정확한 게시 버전의 `--help`, `setup --dry-run`, 실제 설치와 재실행을 확인합니다. 이 QA 후 작업을 완료합니다.

## 실패와 재실행

- OIDC 인증 오류: npm 설정의 저장소·workflow 파일명·`npm` 환경·직접 게시 권한을 확인합니다. GitHub-hosted runner와 npm 최소 버전도 확인합니다. 임시 해결용 토큰을 추가하지 않습니다.
- 태그·버전 또는 main 포함 검사 실패: 릴리스가 가리키는 커밋과 버전 변경 PR을 확인합니다. 이미 게시된 npm 버전은 덮어쓰지 않습니다.
- 게시 후 후속 단계가 실패했다면 먼저 `npm view`로 게시 여부를 확인합니다. 미게시일 때만 실패한 Actions 작업을 재실행합니다. 이미 게시된 버전에 다시 `npm publish`하면 오류가 납니다.

근거: [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/), [npm provenance](https://docs.npmjs.com/generating-provenance-statements/), [npm trust 전제 조건](https://docs.npmjs.com/cli/v11/commands/npm-trust/).
