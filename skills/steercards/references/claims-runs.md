# Work acceptance, run history and usage

Use these capabilities when the task calls for tracked execution or multiple agents need ownership coordination. They record coordination state; they do not launch or control an external AI process by themselves.

## Claims and fences

Describe `get_card_claim` / `acquire_card_claim`. Claim writes require a currently bound active profile and `run.write` scope. Acquire with a fresh UUID `requestId`, fresh UUID `runId` and `leaseSeconds` (30–3600). Acquisition chooses one concurrent winner and creates its run atomically. Do not also start that same run with `start_agent_run`.

Store the returned `{claimId,generation,runId}` unchanged as the fence. Claim renew/release/handoff operations call it `fence`; protected product writes call it `claimFence`. Describe each write to see its exact placement. Renew before expiry during actual work; renewal does not resurrect an expired claim.

After any claim has existed on a card, stale/fence-free agent writes remain rejected even when the lease expires or the claim is released. Acquire a fresh claim or accept an explicit handoff for a new attempt. `CARD_ALREADY_CLAIMED` reports another active owner; `CARD_CLAIM_LOST` means the previous fence no longer authorizes changes. Do not keep writing with an old fence.

`request_card_claim_handoff` records the target profile and work summary, but retains the source owner until acceptance. The recipient uses `accept_card_claim_handoff` with a fresh run ID; successful acceptance creates a new generation/run. Source work must account for losing its fence. Cancellation only cancels the pending handoff.

Uncertain responses: reuse the original request UUID and exact input or inspect `get_card_claim` / `list_card_claim_events`. A request-conflict error means the UUID was used for a different payload/actor; do not automatically invent a retry. Lease expiry/release is not evidence that the external process stopped.

## Runs

For unclaimed legacy work, `start_agent_run` records an actual attempt with new UUID run/event IDs. It does not acquire a lease or move card business status. Claim-managed attempts are created through claim acquisition/handoff instead.

Read the current run/version using `get_agent_run`. Progress, heartbeat, cancel and finish calls carry `eventId`, `expectedVersion` and a claim fence when required. Initial version is 0; successful updates advance it. On a lost response replay the **original** event ID, payload and expected version. On `AGENT_RUN_CHANGED`, read latest state and decide a new event; do not rewrite an old event to the new version.

Working heartbeat is at least every ten minutes. A claim with a shorter lease must be renewed more frequently. The visible agent-status heartbeat, run heartbeat and claim lease are different contracts.

Cancellation stages are request → external runner acknowledgment → observed termination → finish. Requesting or acknowledging cancellation does not prove termination. Record a terminal state only from an actual result. `finish_agent_run` can link a completion report but does not mark the card done. Runs/events have their own paginated inspection tools.

## Usage and cost

Discover `get_agent_run_usage`, `report_agent_run_usage` and `get_agent_run_usage_totals`. Usage has its own revision, independent of the run version and claim generation. Missing collection is null, not zero. Monetary amounts are decimal strings; preserve currency and reported/estimated distinctions.

`cumulative` replaces the snapshot, so resend dimensions to retain them. `incremental` adds observations. After `final:true`, corrections require the current revision and explicit cumulative correction flags. Reuse an event ID only with its original payload/revision. Current same-profile authorization can allow accounting for a historical run after its claim changed; usage reporting does not change ownership or execution state.

Read totals with explicit millisecond time bounds `[from,to)` based on run start. Preserve integer/decimal strings rather than rounding through JavaScript numbers. The API does not fetch provider invoices/prices or guarantee external budget enforcement.
