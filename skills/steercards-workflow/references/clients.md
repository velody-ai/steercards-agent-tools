# Project client configuration

Inspect the current host and version. Read only the relevant section. Official schemas may change: verify against the current client's documentation before writing, especially model/effort fields. Do not treat a client name, an installed file or a model's public existence as proof that the running session supports it. Project settings are the default; preserve global/personal settings and unrelated project content.

## Codex app / CLI

- Project roles are standalone `.codex/agents/<name>.toml` files with `name`, `description` and `developer_instructions`. Put the role's scope, workflow reference, selected profile handle and the instruction to resolve its current connected profile ID into its instructions.
- Set `model` and `model_reasoning_effort` only when the user opted into the confirmed mapping and the current environment supports both values. For a new inherited role omit both. Preserve existing values when model recommendations were declined.
- Add the workflow reference to project `AGENTS.md`. Use relative project paths in generated instructions, not the onboarding machine's absolute paths.
- Do not change parent `mcp_servers`, provider, permissions or global agent defaults to make a role work. Confirm any necessary project-level agent enablement separately in the preview. Explain a reload/new session when required.

Official reference: https://learn.chatgpt.com/docs/agent-configuration/subagents

## Claude Code

- Project roles are `.claude/agents/<name>.md`, with YAML frontmatter `name` and `description`, then role instructions in the body. Use the current documented `model` and `effort` fields only when selected and supported. For a new inherited role omit overrides; do not erase existing choices when recommendations are declined.
- Claude Code's loading of `AGENTS.md` depends on its version/settings. Inspect its actual instruction entrypoint. If it already reads `AGENTS.md`, the shared reference suffices. Otherwise preserve `CLAUDE.md` and add an import/reference to the same workflow (for example `@docs/steercards-workflow.md`) rather than copying the workflow. Do not alter global instruction-loading settings just for onboarding.
- Existing tool restrictions, permission modes, MCP configuration and memory settings are not replaced by a generated role. Add only confirmed role settings. Mention required role reload according to the installed client.

Official references: https://code.claude.com/docs/en/sub-agents and https://code.claude.com/docs/en/memory

## Cursor

- Project roles are `.cursor/agents/<name>.md`, with YAML frontmatter `name` and `description`, followed by role instructions. New roles inherit the parent model unless a supported, confirmed override is chosen.
- Use exact supported model IDs. Some versions express model parameters inside the model string; do not invent an independent `effort` field or copy Codex/Claude settings. Verify the current syntax and leave unavailable controls manual/pending.
- Cursor can also discover compatible roles from other client directories. Inspect those before adding a duplicate. Do not assume TOML compatibility without checking the installed version's supported format.
- Project `AGENTS.md` is the shared workflow entrypoint. Preserve any existing Cursor rules. Add a separate always-applied rule only if the current environment needs it and the preview includes it; do not duplicate the workflow text.

Official references: https://cursor.com/docs/subagents and https://cursor.com/docs/rules

## Claude Desktop

- `setup` provides separate Steercards and Steercards Workflow ZIPs; the user uploads both through the supported Skills UI. A filesystem write is not a completed upload.
- Local file capabilities and persistent project instructions vary by enabled tools. When a permitted local file tool exists, save the confirmed workflow and `AGENTS.md` reference in the user's project. When it does not, provide the final files as downloadable artifacts if supported, otherwise provide their exact content and destination, and mark local application pending. Do not claim saved files without evidence.
- Do not generate Claude Code role files and call them Desktop agents. Only apply a native role/model configuration when the actual Desktop environment exposes a supported capability. Otherwise put confirmed role/model intentions in the workflow and give precise manual steps; mark executable roles and model changes pending or unsupported.
- Steercards profile creation/key linking can still be applied through authorized connected tools. Report that result independently of local documents and agent execution readiness.

## Verify without launching product work

Parse TOML/YAML with existing tooling when available and inspect the written fields. Validate that each selected role can locate the same project workflow and its identity mapping. Do not spawn agents to implement a product task as a configuration test. A client reload or harmless role-discovery check is separate from verifying model availability. Report each verified boundary and remaining manual action explicitly.
