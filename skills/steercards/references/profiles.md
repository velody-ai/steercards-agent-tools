# Identity, assignment and profile inbox

Agent Key = authentication credential. Agent profile = registered actor identity. Participant field = assignment. Claim = acceptance of actual work. These are separate resources.

## Choose and use a profile

`list_agent_profiles(workspaceId)` and `get_agent_profile` expose current stable IDs, active state, key connections and management permissions. When acting as a profile, supply `agentProfileId` or configure `X-Agent-Profile-Id`; per-call input overrides the header. Use an active profile explicitly connected to the current key and authorized in the target scope.

`actorName` is legacy display attribution and cannot replace or override a registered profile identity. Without a profile selection, the server may record legacy key attribution; do not represent it as a registered profile's activity.

Profile management tools create/update/activate/deactivate profiles and replace linked key lists. `set_agent_profile_keys` is full replacement, including an empty list to disconnect. Character/avatar edits use their own expected revision. Avatar upload is prepare → binary PUT → complete; completion rechecks the revision, and PUT uses only returned storage headers. On uncertainty reread current avatar settings before repeating a change.

## Assign work

Read the board's participant-property configuration and `list_participant_candidates`. Set a participant value with the stable `{kind,id}` pair. Display names, legacy assignee options and profile IDs are not interchangeable.

`my_next_card` currently matches select/multi-select option names and prefers in-progress work, then todo work. It can exclude blocked cards. It does **not** discover modern participant/profile assignments; use `list_participant_cards` or the profile inbox for those.

## Receive work efficiently

`list_profile_notifications` returns mentions, assignments, explicit human replies and handoffs for a profile. Keep `nextAfterId` for new receipts. To reevaluate currently pending notifications, query pending from `afterId:0`: the new-receipt cursor is not a stream of status changes.

`acknowledge_profile_notifications` keeps read and complete independent. Reuse its request ID only for the same action and notification IDs. Acknowledging a notification does not claim its card or start execution. A notification is a trigger to inspect the task and its actual authorization.

`request_profile_handoff` sends an explicit handoff notification; it does not transfer a claim or launch/stop an AI. Notification reassignment is a human owner/admin operation and is rejected for Agent Keys.

`list_profile_mentions` has its own event cursor and active/removal records; advance `mark_profile_mentions_read` only through observed events. A deleted source can be `active:false,body:null`. Legacy `list_my_mentions` follows key-ID mentions, while `list_mentions` follows display-name mentions with a separate key-specific read cursor. Choose the intended identity rather than polling all feeds.

If subscribing to both inbox creation and mention events, deduplicate the same underlying work. Neither notification receipt nor a mention grants permission beyond the user's request and current scopes.
