# Collaboration, verification and event delivery

## Comments that explain the work

Follow [Keep people informed through card comments](../SKILL.md#keep-people-informed-through-card-comments) throughout actual card work. Record the intent before consequential actions and the useful facts as the work develops, so a person can follow the sequence without reading your chat or tool calls.

Use `add_comment` for a plain-text note; its `body` is different from card `description`. Describe the live schema and supply your connected `agentProfileId` when acting as a registered profile. After an uncertain write, inspect `list_comments` before retrying: comments are not automatically deduplicated. Deletion is limited to comments written by the same key.

For an agent teammate, resolve the active profile with `list_agent_profiles(workspaceId)` and put `@[profile:UUID]` in the body, replacing UUID with the actual profile ID. A display name or plain `@handle` does not substitute for a profile-inbox mention. Include the finding they need or the specific next action, rather than tagging someone without context. Receiving a mention does not start an external agent process or expand its authorized work.

Examples below show natural wording, not a required template. `@qa-guy` is a readable example of the rendered mention; resolve the actual profile token before posting.

- Starting: “저장 후 새로고침할 때 값이 사라지는 흐름부터 재현해 보겠습니다.”
- Before splitting work: “DB 변경이 먼저 필요해서 하위 카드로 나누겠습니다.”
- After creating the child: “하위 카드 SC-123을 만들었습니다. 여기서는 화면 작업을 이어가겠습니다.”
- Useful progress: “저장 요청에는 값이 들어가는데 조회 응답에서 빠지고 있어요. 응답 변환 부분을 확인하고 있습니다.”
- Blocker and next step: “테스트 계정 권한이 없어 운영 확인이 막혔어요. 로컬 재현은 확인했고, 권한이 준비되면 운영에서도 검증하겠습니다.”
- Changed plan: “서버 응답은 정상이어서 하위 카드는 만들지 않겠습니다. 화면에서 값을 덮어쓰는 부분을 수정할게요.”
- Result and handoff: “수정했고 로컬에서 저장·재조회까지 확인했습니다. @qa-guy 배포 후 같은 흐름을 확인해 주세요.”

Only claim observed results. Keep the relevant card or evidence link when it helps, and skip a second note if a tool already posted the same question or result. A routine status refresh or unchanged wait does not need another comment.

## Read comments and feeds

Use filtered `list_comments` for a narrow author/mention/time question. Use `list_activity` for simple recent changes, `list_workspace_activity` for workspace filtering, or `list_card_feed` for a unified timeline. Describe cursor/filter inputs instead of fetching all sources and concatenating them.

For `list_card_feed`, `tab:all` excludes duplicate comment-created/deleted activity; `comments`, `history` and `mine` have different semantics. `mine` is an exact mention of the key owner's **user** identity, not a profile mention. `agentOnly` filters actor kind.

Only one of `before`, `after`, `pageCursor`, `refreshKeys` is allowed per call. Preserve opaque cursors and reset them if target/filter/limit changes. Page history with `nextBefore`; sync with `syncCursor` then drain `nextAfter` before committing the new sync cursor. Refresh cursors/keys update known rows only and do not advance the sync baseline. Merge by `(type,item.id)`, apply `removedKeys`, and do not count overlap as new activity. Deleted comments may retain an empty body plus deletion metadata.

## Ask a person to verify

`request_human_check` names a real workspace member, prod/local environment and action/expected-result steps. It creates an item in the person's check inbox. Optional pass/fail business-status transitions must reflect the intended task. Query `list_human_checks` / `get_human_check` for actual verdicts and evidence. Creating the request is not a passed check, and "human check" is not a board status to invent.

Keep request and step titles concise. For verification, the first `steps[].action` also titles the request, and each `action` is shown as a step heading: write a short, concrete action the person can carry out. Put observable expected results in `steps[].expected`, and detailed background, prerequisites or supporting procedures in the linked card body. For questions, write a concise `question.prompt` as the request title and put context or detailed instructions in `question.description`. There is no separate title field; follow the live schema without introducing stricter length limits.

Describe the live tool before constructing a request. Verification can optionally provide `resultOptions: [{id,label,description?,verdict}]`: 2–6 ordered choices shared by every step. IDs are unique ASCII letters/digits/underscore/hyphen (1–64 characters), labels are 1–120 characters and descriptions at most 500. Each verdict explicitly means `pass`, `fail` or `inconclusive`; never infer meaning from the label. Omit resultOptions to retain legacy pass/fail choices. Explicit null and mixing resultOptions with a question are invalid.

For example, use `works / Normal operation / pass`, `partial / Partly working / fail`, and `unable / Cannot verify / inconclusive`. Any failed step makes the result `failed`; otherwise any inconclusive step makes it `answered`; only all-pass becomes `passed`. A fail requires a memo. Inconclusive permits an optional memo and never means success. Verification `followUps` uses `onPassed`, `onFailed` and `onAnswered` once after aggregation. Omitted follow-ups keep the card state; inconclusive never falls back to legacy onFailStatus. For per-choice moves, use a single-selection question instead.

The assigned person chooses in the web inbox, saves each step, then explicitly submits the final response. Selection and step saving do not finalize the check or create the completion comment/webhook. Do not answer on the person's behalf. Read `steps[].selectedOptionId` and `selectedOptionSnapshot` for original ID, label, description and verdict; final `response` preserves resultOptions and steps. Processed history, comments and `human_check.completed` retain the original choice. Inspect actual `followUpResult` as current card state, permissions or workflow may block a requested move.

## Card work badges

Follow [Keep card work visible](../SKILL.md#keep-card-work-visible) for every actual card-work attempt, including work without run tracking. Describe `set_agent_status` / `clear_agent_status`, set `status:"working"` before starting and refresh every **5 minutes**, before the **10-minute** stale threshold. Read-only lookups and assignment alone do not create a badge.

Set `status:"waiting_for_input"` with the actual `question` while a person's answer blocks the work; it can create a pinned agent comment. Use `status:"error"` for a blocking error and return to `working` when resuming. Keep the waiting/error badge while awaiting the answer or resolution, even if the current turn ends; do not clear it unconditionally in `finally`. A waiting question is separate from a step-by-step human check: use `request_human_check` when a person needs to verify results, and reflect the wait in the badge when that verification blocks your work.

Call `clear_agent_status` before completing, abandoning or handing off the attempt. On a claim-managed card include the current `claimFence` and clear before releasing or transferring the valid claim. After fence loss, stop writing and do not clear another owner's status. A badge is transient display state: it does not move card business status, renew a claim or update run history/heartbeats.

## Reserve shared resources

Discover `reserve_resource`, `release_resource` and `list_reservations` for shared paths, keys or sequence numbers. Exclusive key/sequence conflicts identify the existing card; overlapping path globs may be stored with warnings rather than denied. Examine the returned data's own success/conflict fields, not only the outer product envelope.

`name:next` issues a sequence above its floor; migration numbering uses the server's current migration floor. Releasing does not imply the same number will be reissued. Reservations become inactive when expired, archived or in a complete status section. A reservation coordinates edits; it does not replace a claim or lock an external filesystem.

## Webhooks

Discover list/create/update/delete, delivery inspection and resend tools. Use callbacks only when delivery is part of the authorized task. Creation returns a signing secret once; store it securely and never paste it into a comment. Lists expose a prefix only. Event names evolve: use current schema rather than a frozen list.

Verify `X-SteerCards-Signature` as SHA-256 HMAC over `timestamp + "." + rawBody` using the webhook secret. Dedupe events in the receiver; retries can repeat a delivery. Inspect recorded delivery status before explicitly resending failed entries. An excluded key can suppress self-generated events. Notifications/handoffs do not launch or stop external AI processes.
