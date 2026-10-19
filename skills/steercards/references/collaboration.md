# Collaboration, verification and event delivery

## Comments and feeds

Use `add_comment` for a concise plain-text note; its body is different from card `description`. Comments are not automatically deduplicated: inspect `list_comments` after an uncertain write. Deletion is limited to comments written by the same key. Registered profile mentions use `@[profile:UUID]`; discover the UUID instead of inferring it from a display name.

Use filtered `list_comments` for a narrow author/mention/time question. Use `list_activity` for simple recent changes, `list_workspace_activity` for workspace filtering, or `list_card_feed` for a unified timeline. Describe cursor/filter inputs instead of fetching all sources and concatenating them.

For `list_card_feed`, `tab:all` excludes duplicate comment-created/deleted activity; `comments`, `history` and `mine` have different semantics. `mine` is an exact mention of the key owner's **user** identity, not a profile mention. `agentOnly` filters actor kind.

Only one of `before`, `after`, `pageCursor`, `refreshKeys` is allowed per call. Preserve opaque cursors and reset them if target/filter/limit changes. Page history with `nextBefore`; sync with `syncCursor` then drain `nextAfter` before committing the new sync cursor. Refresh cursors/keys update known rows only and do not advance the sync baseline. Merge by `(type,item.id)`, apply `removedKeys`, and do not count overlap as new activity. Deleted comments may retain an empty body plus deletion metadata.

## Ask a person to verify

`request_human_check` names a real workspace member, prod/local environment and action/expected-result steps. It creates an item in the person's check inbox. Optional pass/fail business-status transitions must reflect the intended task. Query `list_human_checks` / `get_human_check` for actual verdicts and evidence. Creating the request is not a passed check, and "human check" is not a board status to invent.

Describe the live tool before constructing a request. Verification can optionally provide `resultOptions: [{id,label,description?,verdict}]`: 2–6 ordered choices shared by every step. IDs are unique ASCII letters/digits/underscore/hyphen (1–64 characters), labels are 1–120 characters and descriptions at most 500. Each verdict explicitly means `pass`, `fail` or `inconclusive`; never infer meaning from the label. Omit resultOptions to retain legacy pass/fail choices. Explicit null and mixing resultOptions with a question are invalid.

For example, use `works / Normal operation / pass`, `partial / Partly working / fail`, and `unable / Cannot verify / inconclusive`. Any failed step makes the result `failed`; otherwise any inconclusive step makes it `answered`; only all-pass becomes `passed`. A fail requires a memo. Inconclusive permits an optional memo and never means success. Verification `followUps` uses `onPassed`, `onFailed` and `onAnswered` once after aggregation. Omitted follow-ups keep the card state; inconclusive never falls back to legacy onFailStatus. For per-choice moves, use a single-selection question instead.

The assigned person chooses in the web inbox, saves each step, then explicitly submits the final response. Selection and step saving do not finalize the check or create the completion comment/webhook. Do not answer on the person's behalf. Read `steps[].selectedOptionId` and `selectedOptionSnapshot` for original ID, label, description and verdict; final `response` preserves resultOptions and steps. Processed history, comments and `human_check.completed` retain the original choice. Inspect actual `followUpResult` as current card state, permissions or workflow may block a requested move.

`set_agent_status` / `clear_agent_status` expose working/input-wait/error. A waiting question can create a pinned agent comment; it is not equivalent to a step-by-step human check. Working status needs refresh at least every ten minutes. Check claim fences when the card is claim-managed.

## Reserve shared resources

Discover `reserve_resource`, `release_resource` and `list_reservations` for shared paths, keys or sequence numbers. Exclusive key/sequence conflicts identify the existing card; overlapping path globs may be stored with warnings rather than denied. Examine the returned data's own success/conflict fields, not only the outer product envelope.

`name:next` issues a sequence above its floor; migration numbering uses the server's current migration floor. Releasing does not imply the same number will be reissued. Reservations become inactive when expired, archived or in a complete status section. A reservation coordinates edits; it does not replace a claim or lock an external filesystem.

## Webhooks

Discover list/create/update/delete, delivery inspection and resend tools. Use callbacks only when delivery is part of the authorized task. Creation returns a signing secret once; store it securely and never paste it into a comment. Lists expose a prefix only. Event names evolve: use current schema rather than a frozen list.

Verify `X-SteerCards-Signature` as SHA-256 HMAC over `timestamp + "." + rawBody` using the webhook secret. Dedupe events in the receiver; retries can repeat a delivery. Inspect recorded delivery status before explicitly resending failed entries. An excluded key can suppress self-generated events. Notifications/handoffs do not launch or stop external AI processes.
