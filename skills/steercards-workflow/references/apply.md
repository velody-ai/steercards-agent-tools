# Applying a confirmed workflow

Use available file editing and live toolkit tools; this skill does not require a new server API or its own credential store. The same rules apply to revisions and resuming partial application.

## Preflight

Recheck the files and remote resources described in the approved preview. If they changed during the conversation, compare the change before writing; do not overwrite another person's edits. Check write access to the chosen project and the current profile/key permissions. If a part cannot be applied, continue independent confirmed parts and record the missing part accurately.

Only changes in the preview are authorized. Creating profiles, linking keys, adding boards/fields, editing existing roles and changing model settings are separate effects that must be described there. Workflow authority is a collaboration preference, not a change to the client's enforced permissions.

## Documents and instruction references

1. Use the existing instruction-linked workflow when present. If several documents conflict, ask which is authoritative rather than creating another. Otherwise use `docs/steercards-workflow.md` inside the selected project.
2. Write the confirmed decisions in the user's language, with undecided items explicitly distinguished. Record selected resource names and discovered IDs/links where useful, not IDs from examples or this skill's development workspace. Never include tokens or `.env` contents.
3. Add a short relative link from `AGENTS.md` instructing agents to read the workflow when starting project work. If `AGENTS.md` is absent, create it with only this instruction. If the reference already exists, reuse it. For a custom workflow path, use the correct relative link. Preserve unrelated text, ordering and local changes.
4. Resolve the client's actual instruction entrypoint as described in `clients.md`. Use a reference/import to the same document; do not maintain duplicate workflow bodies.
5. A revision edits only the relevant decisions. Reuse the old profile/role/status/field mappings unless the approved change replaces them. Do not turn this particular project's permissions or conventions into universal defaults.

Generated workflow and role files belong to the user. Save them outside installed `skills/` folders and `.steercards/setup/` ownership manifests. Package startup synchronization must never manage them.

## Roles, profiles and boards

- Inspect before writing a role file. Reuse selected existing definitions; apply only the approved delta, preserving unrelated model/tool/permission settings. If a same-name definition is not the chosen role, ask for a different name rather than overwriting it. New roles refer to the workflow for shared policy instead of copying it in full.
- Discover `list_agent_profiles`, creation and key-linking tools through live schemas. Resolve active profiles, stable IDs and the current credential's connection; never equate a matching display name, legacy actorName, key identity or participant option with a profile.
- After creating a profile, verify its actual ID, state and key connection. The creation tool may already connect the current key; inspect before adding links. A key-link tool may replace the full list: preserve existing links and use only confirmed additions. Do not create/revoke/rotate credentials as an onboarding shortcut. If the current key cannot manage a profile, leave its binding pending and explain the needed administrator action.
- Store role → profile handle and selected scope in the workflow. At execution time agents resolve the current active connected profile ID and use `agentProfileId` for attributed actions. An identity mapping does not guarantee separate credentials, context isolation, process execution or permission enforcement.
- Read the actual board properties/options before using them. Reuse the existing status field and follow the board field plan below. Only create/alter structure included in the preview. Treat profile assignment, work claims, progress badges, business statuses and human verification as separate mechanisms. Reuse the connected toolkit's actual ownership/status/inbox contracts; do not invent automatic wakeups or pollers.

## Board field plan

The default result includes these four field purposes. Use these names when creating missing fields; a compatible existing field may keep its different name.

| Purpose / new field name | Required type and configuration |
| --- | --- |
| Assignee / `담당자` | `participant`, with `allowed: "both"` for user/profile identities and `selection: "single"` or `"multi"` according to the agreed assignment workflow. Preserve existing display settings. |
| Priority / `우선순위` | `priority`, using built-in `urgent`, `high`, `medium`, `low` values; do not create select options to imitate priority. |
| Type / `유형` | `select`, with options derived and confirmed from the interview’s actual work categories. There is no fixed option list. |
| PR / `PR` | `url`; creating the field does not authorize creating a PR or require a sample URL. |

1. Read the board’s complete properties/options/settings and existing workflow mappings. Match by purpose and compatible type/settings, not name alone. Reuse a known compatible mapping even if its name differs; where several candidates are ambiguous, resolve which to use before applying. Record the chosen actual names and IDs in the preview and workflow.
2. Classify each purpose as reuse, missing/create, or conflict/pending. A same-name field with another type, or a participant field whose allowed identities or selection differ, is a conflict rather than permission to convert or recreate it. Show the exact current → proposed delta and impact on existing values/settings; confirm any change or alternative mapping. Do not delete/recreate, force a rename, convert a field, or drop existing options/values to obtain the defaults. If unresolved, keep that part pending and apply independent confirmed parts.
3. Preserve all existing type options, IDs, ordering, colors and card values. Map matching confirmed categories to existing options and add only missing, confirmed categories through the current supported tools. Do not replace an options list with the interview proposal or prune options that were not selected. Any broader cleanup needs its own explicit delta and authorization.
4. Discover and describe `get_board`, `create_property` and any necessary option/settings tools before use. Create only missing fields from the approved preview, using the live schema for required inputs, participant settings, option colors and display choices. Do not create a duplicate merely because a compatible field has another name. A timeout requires rereading the board before retrying creation or option additions.
5. Reread the board after application and on resumption. Verify each purpose’s actual field ID/name/type, assignee allowed identities and selection, and the complete preserved-plus-added type options. Check that reused IDs/settings and existing options/card values were preserved against preflight; setup does not need to edit cards or create a test card. Record any inaccessible verification or unsupported configuration as pending, not success. Rerunning an unchanged plan reuses all four fields and existing options without additional creation.

## Partial failures and resumption

Local files and remote resources are not one transaction. Keep a brief setup status/resume section in the workflow with applied resources and remaining changes. If no local write is possible, report equivalent resume information in the conversation or supported artifact instead.

After a timeout/uncertain remote write, read actual state before retrying. In particular, list profiles to find an intended creation rather than blindly issuing another create. Preserve any request ID with its original payload for tools that provide idempotency. Do not invent request-ID support for tools without it. Recheck role files and existing instruction references to avoid duplicate creation on rerun.

Report permission/connection/model/host limitations separately. Keep successfully applied changes; do not automatically delete profiles, disconnect keys or undo board changes as a rollback. Ask for any materially changed proposal, not for permission to resume an already-confirmed unchanged step.

## Verification and closing

Check that the workflow exists at the reported destination, links resolve, unrelated instruction content remains, references are not duplicated, role files parse, and the selected remote resources actually exist with the expected connections. Verify all four board fields against the approved field plan, including preservation of existing mappings/options/values; report conflicts or missing fields individually. Distinguish configured files from client-loaded roles and usable models. Report when a reload, ZIP upload, permission change or model selection remains.

If setup was tracked on a card, the toolkit's card-work lifecycle still applies; the user's reporting preference does not disable it. Do not mark the user's first development task complete or create a test card simply to demonstrate setup. Offer a first task and wait for the user's selection.
