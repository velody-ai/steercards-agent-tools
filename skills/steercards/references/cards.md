# Cards, board structure and relationships

Describe tools before constructing writes: card references and property values support conveniences that older guides may omit. Artifact tools can still require explicit `projectId`, `boardId` and `cardId`.

## Content and layout

- For simple card finding, use `search_cards`: `query` searches both titles and bodies, with the scope/status/approval/archive filters supported by its live schema. A list is ready when its titles, relevance and links are clear.
- For several expressions, scope investigation, evidence passages or line numbers, use `explore_cards` and the [exploration guide](exploration.md). Start at a known workspace/board/path; use `ls` only to discover unknown locations or inspect directory/card-title metadata, and `find` for paths/keys only. Search `card.md` with `rg`, optionally `-C 2` for context. Preserve source URLs/actual statuses and grouped matches. Do not confirm sufficient snippets by reading the same content again with `cat`/`get_card`; read only ambiguous cards or missing passages. Detailed analysis can go deeper. Comments are secondary when bodies are insufficient or history/discussion is requested.
- Known card keys use direct lookup. `list_participant_cards` finds active board cards by exact participant kind/ID; inspect `get_board` and live schemas for other property structure.
- `get_board` returns groups, properties/options, values, card previews and operational metadata. Use `get_card` for the latest full Markdown `description`, relations and linked PRs.
- `create_card` can set initial `propertyValues` atomically. Keys may be exact property names or IDs; select/status values accept exact option names or IDs where the current schema allows them.
- `update_card` replaces each supplied title/description in full. Read the latest description and preserve other content when editing a task marker (`- [ ]` / `- [x]`). `body` is not the card-body field. Checklist progress is derived from Markdown; there are no separate checklist-item tools.
- `move_card` uses the **current grouping property**, current source group and destination group. `beforeCardId:null` means the end. Ungrouped moves use the null IDs described by the server. Multi-select destination null clears all choices; other moves can preserve choices outside the source group.
- Archive removes a card from active board results while retaining content. Use `list_archived_cards` and `restore_card` for recovery. Permanent deletion has different consequences.
- `list_card_versions` and `get_card_version` inspect immutable title/body history. `restore_card_version` uses current `expectedContentRevision`; it does not restore deleted binary files or other card fields.

## Archive several cards

Discover and describe `archive_cards` for a bulk archive. Keep the user's selected board and explicit card list; do not turn a filter, page or a range of card numbers into permission to archive more cards. Freeze the intended list before calling and split more than 100 items into explicit batches without broadening the scope.

The tool takes `boardId` and `cards` (1–100 items), with optional `projectId`, `workspaceId`, `agentProfileId` and `actorName`. Each item has exactly one reference: numeric `cardId`, or `card` as a canonical key/workspace card number. These numbers are different identities. All cards must belong to the selected board. For a claim-managed card, put its own current `claimFence:{claimId,generation,runId}` on that item, never on the whole batch or copied from another card. Resolve current ownership first; never drop a rejected fence or change profiles to bypass protection.

```sh
steercards tools archive_cards
steercards describe archive_cards
steercards call archive_cards --json '{"workspaceId":123,"boardId":19,"cards":[{"cardId":42},{"card":"WEB-43"}]}'
```

Replace these example identities with the user's actual selection. Compact MCP uses `steercards_call_tool` with `name:"archive_cards"` and the same arguments; full MCP exposes `archive_cards` directly. The JavaScript `Runtime.callTool` uses the same live tool and arguments without a dedicated helper.

Read `isError` and product `ok`/`error`, then **every** `data.results` item and `data.summary`. Even HTTP 200, `ok:true`, and CLI exit 0 can mean partial success. Each result is `archived`, `unchanged` (already archived, after permission/fence checks), or `failed` with its own `error:{code,message,status,details?}`. `summary` has `requested`, `archived`, `unchanged`, and `failed`. References resolving to the same card are processed once in first-occurrence order, so `requested` counts unique results, not necessarily input items. The response does not contain a whole updated board. Report archived, already archived and failed separately; do not describe partial success as all cards archived.

Malformed items, invalid fence shapes and a batch over 100 are rejected before writes. Other item failures can leave earlier or later items archived. After a known partial result, reconcile failed items and retry only explicitly intended, still-unarchived cards with valid current ownership. Never automatically replay the whole batch after a lost response, timeout or 5xx: read each intended card with `get_card` and inspect `archivedAt`, then decide a new call only for confirmed unfinished items. If a card's state cannot be read, keep it unresolved instead of assuming failure. Use `list_archived_cards` / `restore_card` for recovery; archive retains content and is distinct from permanent deletion.

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
