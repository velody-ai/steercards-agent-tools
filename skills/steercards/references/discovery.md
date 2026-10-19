# Discovery, scope and recovery

Search by the intended outcome, then describe only the promising tools. Calls pass the exact upstream name and arguments; use discovery for newly added features instead of assuming the toolkit lacks them. A compact search result is not a complete input schema.

## Find the target cheaply

- A known card: describe `get_card` or `get_card_by_number`. Many card tools accept `cardId` alone, or `card` as a key/number and optional `workspaceId`; parent IDs are derived. `card: 42` means a workspace card number, **not** numeric `cardId`.
- An unknown location: `list_workspaces`, then `list_projects(workspaceId)`, then `list_boards(projectId)`. There is no global switch-workspace operation. Names are not guaranteed unique.
- Search within a known workspace with `search_cards`; use its filters and small limit. `get_board` is useful when layout, grouping and property IDs matter, but does not include full card bodies.
- Return canonical card keys and URLs from the server. Old project prefixes may resolve as aliases; use the returned current key going forward.
- Use `get_workspace_plan` for the workspace's current product limits rather than assuming a tier grants every feature.

## Authorization

The key's owner membership/role, workspace restrictions, read-only setting and any selected profile's current scope all apply. A profile is selected with `agentProfileId` or `X-Agent-Profile-Id`; it does not expand the key's access. A read-only key's discovery omits writes. A write tool may be discoverable but restricted to human accounts, such as notification reassignment. Surface the server's reason instead of bypassing it.

## Recovery

| Signal | Response |
| --- | --- |
| 401 | Verify key availability, expiry or revocation without displaying the secret. |
| 403 | Inspect read-only/workspace/profile/role restrictions. Repeating the same call does not grant access. |
| 404 | Recheck identity and parent scope; inaccessible resources can look absent. |
| 409 | Read current state, compare the intended change, then explicitly reconcile. Do not replace expected revisions or confirmation names automatically. |
| 429 | Respect `Retry-After`; reduce polling and repeated discovery. |
| Lost response or 5xx on a mutation | Determine whether the change committed before retrying. `AGENT_AUDIT_UNAVAILABLE` can occur after the product write succeeded. |

For request-ID/event-ID tools, retry the same ID with the same complete payload, including its original expected revision/version. A new decision after a conflict requires a new event/request where the schema specifies it. For non-idempotent creates/comments, query actual results first.

Preserve cursor objects/strings exactly. Pagination fields vary (`nextCursor`, `nextBefore`, `nextAfterId`); use the described tool's matching input. Discard a cursor when its target or filters change.

The remote endpoint is stateless HTTP MCP at `/api/mcp`, authenticated by Bearer key. Send one JSON-RPC message per HTTP request; array batches are rejected. The SDK handles protocol negotiation. Avoid fabricating browser Origin headers or changing signed storage hosts. Server-side subscriptions are not required; product feeds use their own polling contracts.
