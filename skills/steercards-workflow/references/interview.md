# Branching interview

Ask in the user's language, 1–3 questions at a time. Offer a few meaningful choices and accept custom answers. These examples are prompts to adapt, not a required sequence or an answer form. Explain a recommendation briefly; preserve decisions already made. User confirmation of the final preview covers its enumerated setup actions, not future product work.

## Work and intake

- “주로 어떤 작업을 맡기나요?” Features, bug fixes, UI improvements, refactoring, custom; allow multiple choices. A concrete recent task can clarify an unfamiliar category.
- “일을 어떻게 시작할까요?” Create a card from a conversational request; work on cards the user names; choose the next eligible card from the selected board. For board selection, define eligible statuses, priority/dependency handling and whether the user wants to confirm the next task. Do not promise background polling.
- Choose the workspace/project/board only if actual discovery leaves ambiguity or the user needs a new one. Prefer current statuses and fields. A new board or field must be included in the final preview, not created during discovery.

## Structure and roles

- “여러 에이전트를 사용할까요?” One agent; implementer plus reviewer; a small specialist team. Recommend based on work, not an assumption that more agents are better.
- Explain: “역할별로 컨텍스트와 지침을 분리하고 다른 관점에서 검토할 수 있어요. 인수인계와 모델 사용량도 늘어나므로 필요한 역할부터 시작하는 편이 좋아요.”
- For multiple agents: “기존 에이전트를 활용할까요, 새로 구성할까요?” Show discovered candidates, allow reuse/new/mixed, and distinguish client role definitions from Steercards profile identities. One existing role can be paired with an existing or new profile without recreating the role.
- Propose responsibilities and boundaries. Typical minimal roles are implementer and reviewer/QA. Add a planner, UX or DB specialist only when useful to the user's work. Ask who dispatches: user, a coordinating role or task-by-task choice.
- Ask sequential versus parallel independent work. Parallel write tasks need ownership and separate working copies/worktrees. Define what a handoff contains: card, intent, changed artifacts, verified results, unresolved issues and next action. A profile mention sends an inbox notification, not an external AI process.
- For a single agent, use the current agent and ask only for any necessary Steercards profile selection. Do not generate unused specialist definitions.

## Planning, completion and authority

- “작업 전에 얼마나 함께 논의할까요?” Start clear small tasks; confirm plans for large/unclear tasks; confirm every task's plan. Agree what counts as large if that distinction affects execution.
- “어느 단계까지 끝나야 완료인가요?” Code and checks; PR creation; review and merge; deployment plus production QA. Identify the verifier, required evidence and who moves the card to its final status. Apply the workflow to the current board's status options.
- Ask separate action permissions for file edits, commits, PRs, merges, deployments and DB changes. Avoid an ambiguous “fully automatic” option that quietly bundles all of them. Record “ask when needed” for any high-impact action the user leaves undecided. Do not change the client's sandbox/approval settings.
- Ask whether review is self-check, another agent or a human, and whether human confirmation is part of completion. Choose meaningful checks from project commands and the actual task; do not require every available test for every change.

## Questions, failure and reporting

- “요구사항이 불명확하거나 범위가 커지면 어떻게 할까요?” Ask before continuing; make bounded assumptions and report them; proceed on clear parts and confirm scope expansion. Give a concrete example if needed.
- “검증 실패나 차단이 생기면 어떻게 할까요?” Agree a bounded retry approach and escalation point, and whether unrelated eligible tasks may proceed. Never turn a retry preference into automatic repetition of uncertain remote writes.
- Determine where a human question goes: current conversation, or Steercards human-check inbox when connected and appropriate. Human checks need a real recipient and acceptance criteria. A pending response is not a passing verification or a new status column.
- “언제 진행 상황을 알려드릴까요?” Start/blocker/completion, or additional meaningful milestones. Keep comments brief and link detailed evidence. Card work badges and ownership remain distinct from the user's reporting frequency; use the connected toolkit's working/waiting/error/clear lifecycle.

## Models

- “작업에 따른 모델·추론 강도 추천을 받을까요?” No means preserve settings/inherit for new roles, not choose a supposedly cheap default.
- If yes: quality first; speed/cost first; balanced by task. Use known supported model choices rather than asking the user to remember raw IDs. Ask for availability information only when the environment cannot expose it and the decision depends on it.
- Preview each changed role/model/effort and tradeoff; do not claim a model switch you cannot apply or verify. Unsupported controls become manual/pending steps.

## Closing and revision

Summarize the chosen workflow and exact setup changes in one preview. Confirm the preview once. After applying, report actual results and pending steps, then offer to try a user-selected first task. A revision starts with “어떤 부분을 바꿀까요?” only when the desired change is not already stated; never repeat the entire interview.
