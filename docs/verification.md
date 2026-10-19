# Verification — 2026-10-19

Tested on macOS with Node.js 22.19.0. GitHub Actions is configured for Linux, macOS and Windows on Node 22 and 24; those remote matrix runs have not run yet.

- TypeScript strict checking and build passed.
- 49 automated tests passed, including real HTTP fixtures and SDK stdio child processes. Coverage includes dotenv precedence and directory boundaries, safe config generation, skill install/export, pagination, discovery after server changes, arbitrary schema/metadata preservation, HTTP diagnostics, redirect refusal, no replay after uncertain mutations, and shutdown during initialization.
- Read-only production MCP checks passed through the HTTP runtime and through stdio in both modes. Compact exposed 4 toolkit tools; full exposed the 141 tools available to the test key at verification time. Both modes successfully called `list_workspaces`. Tool counts depend on server version and key permissions.
- Claude Code 2.1.302 reported `Connected` in an isolated `claude mcp list` health check using a fixture key and the compact stdio server. Existing user MCP settings were not changed; this was a protocol health check, not a model-driven workflow.
- The packed tarball was installed in a separate directory: npm bin execution, client config generation, skill installation, ZIP export and SDK guide loading all passed.
- Unified setup was verified for Codex aliases, Claude Code, Cursor and injected macOS/Windows Desktop paths. Checks cover matching legacy install adoption, managed upgrades, comment/unrelated-setting preservation, edited-file conflicts, locks, ordinary-failure rollback and concurrent edit preservation. No real client home configuration was modified.
- Desktop ZIP install/update passed in America/Los_Angeles and Asia/Seoul timezones. Interactive client selection and dry-run were exercised in a terminal; preview created no directory.
- The new tarball was independently installed. Its setup generated Cursor configuration and a skill; an SDK stdio client launched the generated command, listed four tools and read the bundled guide. Repeating setup returned unchanged.
- Skill frontmatter and references validated with the skill-creator validator.
- npm tarball contents were inspected: compiled code, declarations, skill and documentation only; no environment files, tests, node_modules or Git data.

The production check used an inherited environment key. Dotenv loading was separately verified with isolated temporary project fixtures, without copying a real key. Production mutations were not performed to test the toolkit.

Every requested client uses supported stdio MCP configuration, but real native UI connection tests have not been completed for Claude Code, Codex app, Codex CLI, Cursor or Claude Desktop. SDK protocol tests and generated configuration checks are not substitutes for those tests. npm publication and a public GitHub repository are separate release steps.
