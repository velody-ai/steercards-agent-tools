# Cards, board structure and relationships

Describe tools before constructing writes: card references and property values support conveniences that older guides may omit. Artifact tools can still require explicit `projectId`, `boardId` and `cardId`.

## Content and layout

- To find related cards, start with `explore_cards`: `ls` shows directories and card-title metadata, while `find` shows file paths/keys only. Search card titles/bodies with `rg -g card.md`, then read promising `card.md` files with `cat`/line ranges and progressively decide which cards or narrower paths to inspect next. Comments have lower priority; read them when bodies are insufficient or the user asks about history/discussion. Deduplicate by stable card ID/current key and report supporting lines plus scope/cursor limits as described in the [exploration guide](exploration.md). Known-key and filter-only lookups use their direct tools.
- For unfamiliar card text, use `explore_cards` with a selected workspace and the [exploration guide](exploration.md). Its virtual files live under `/projects/<projectId>/boards/<boardId>/cards/<currentKey>/`; read `card.md` after narrowing a listing or title/body search. `comments.md` is secondary when the body is insufficient or history/discussion is requested. A known card key still uses exact lookup. Use `search_cards` for status/approval filters and archived-card inclusion, `list_participant_cards` for active board cards by exact participant kind/ID, and `get_board` plus current tool schemas for other property structure.
- `get_board` returns groups, properties/options, values, card previews and operational metadata. Use `get_card` for the latest full Markdown `description`, relations and linked PRs.
- `create_card` can set initial `propertyValues` atomically. Keys may be exact property names or IDs; select/status values accept exact option names or IDs where the current schema allows them.
- `update_card` replaces each supplied title/description in full. Read the latest description and preserve other content when editing a task marker (`- [ ]` / `- [x]`). `body` is not the card-body field. Checklist progress is derived from Markdown; there are no separate checklist-item tools.
- `move_card` uses the **current grouping property**, current source group and destination group. `beforeCardId:null` means the end. Ungrouped moves use the null IDs described by the server. Multi-select destination null clears all choices; other moves can preserve choices outside the source group.
- Archive removes a card from active board results while retaining content. Use `list_archived_cards` and `restore_card` for recovery. Permanent deletion has different consequences.
- `list_card_versions` and `get_card_version` inspect immutable title/body history. `restore_card_version` uses current `expectedContentRevision`; it does not restore deleted binary files or other card fields.

## Properties and status

Read the board before modifying properties/options or grouping. Status lives in a status property's value, not a legacy `statusId`. Grouping may be independent of the first status property.

Property names and option IDs are board data. `set_card_property_value` replaces one whole value; arrays are not patches. Participant values use `[{"kind":"user" or "profile","id":"stable ID"}]`; fetch candidates rather than matching display names. Find assigned cards with `list_participant_cards`. A null target filters unassigned cards.

`create_property` can include initial options when supported. Property type changes retain recoverable values by type. Deprecated `clearOptions:true` does not erase options. Changing/deleting the grouping property requires the explicit current/replacement grouping contract. Status-option deletion requires a replacement and cannot remove the last option.

For legacy select-to-participant migration, use `preview_participant_mapping`, review unmapped used options and fingerprint, then `copy_participant_mapping` with the same mapping and fingerprint. It copies into an empty participant property; it does not infer identities by name.

Respect workflow transition errors and approval requirements. `proceedUnapproved`, when supported, is an explicit recorded bypass; do not silently add it to resolve a conflict.

`start_card` and `submit_card` are convenience business-status tools: they choose the first status property, use named/fallback status options, and submission also stores a PR URL. Inspect board configuration if that differs from the user's intended workflow. Neither tool acquires work ownership or starts an external process.

## Related capabilities

Search/describe `link_cards`, `unlink_cards`, `list_relations` for parents, children, blockers and related cards. Relationship types, cycle checks and dependency constraints come from live schemas. Read child/blocker progress before treating related work as finished.

Spec utilities (`get_spec`, `list_specs`, `export_spec_markdown`, `update_spec_section`) operate on cards. Prefer a section update with `expectedUpdatedAt` for a focused document edit; ambiguous headings and stale timestamps require reconciliation. These utilities do not impose an approval or development methodology.

Workspace/project/board create, rename and delete tools are also discovered here. Workspace deletion requires the exact current confirmation name and permanently removes descendants. A lost delete response is resolved by rereading the listing. Renaming project prefixes can be rate limited and old aliases are finite; use current canonical keys.
