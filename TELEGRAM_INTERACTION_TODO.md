# Telegram x Codex Interaction Redesign TODO

## Goal

Make the Telegram bridge feel as close to Codex App as possible while supporting both `private chat` and `topic` usage.

## Phase 0: Baseline Confirmation

- [x] Confirm the current bridge routing for `private chat`, `private topic`, and `group topic`
- [x] Confirm Telegram API capability boundaries: where `sendMessageDraft` is available and where fallback rendering is required
- [x] Confirm current upstream event sources: `item/*`, raw events, `exec_command_begin/end`, interrupt, and approval

Acceptance criteria:

- [x] A clear `chat type -> renderer` routing table exists
- [x] Event ingestion and UI rendering are no longer coupled conceptually

## Phase 1: Unified Event Model

- [x] Normalize Codex-side events into one internal activity stream
- [x] Define internal activity states: `thinking`, `reading`, `searching`, `editing`, `running_command`, `approval_waiting`, `completed`
- [x] Define output buckets: `commentary`, `final_answer`, `tool_summary`, `error`

Acceptance criteria:

- [x] The same event stream can drive both the `private renderer` and the `topic renderer`
- [x] Renderer changes no longer require touching core event parsing

## Phase 2: Private Renderer

- [x] In `private chat` and `private topic`, choose the renderer that preserves visible stream continuity first
- [x] Keep `sendMessageDraft` as a capability boundary check, but default the private path to stable segmented live messages until draft UX is proven reliable
- [x] Ensure status text never overwrites visible body output
- [x] Keep the current status and interrupt affordance coherent once body output begins

Acceptance criteria:

- [x] No stale top status bar remains in private mode
- [x] Live body output is not replaced by generic `正在回复...` text
- [x] Interrupt controls do not require destroying visible output to stay available

## Phase 3: Topic Renderer

- [x] Keep `group topic` on normal-message rendering
- [x] Use `bottom activity card + segmented body messages` to approximate Codex App behavior
- [x] Stop editing one giant body message forever
- [x] Separate tool-action summaries from body messages

Acceptance criteria:

- [x] Topic mode no longer leaves an old status message hanging at the top
- [x] Body output lands in readable stage-based chunks

## Phase 4: Activity Card Semantics

- [x] Support Codex-App-like states such as `正在思考`, `正在浏览 2 个文件, 1 个搜索`, `已浏览 ...`
- [x] Archive each finished activity summary before moving to the next stage
- [x] Keep status cards focused on current activity, not long-form body content

Acceptance criteria:

- [x] Users can always tell what the bot is doing right now
- [x] Status transitions are continuous and understandable

## Phase 5: Tool Details And Folding

- [x] Group `Read ...`, `Searched for ...`, `Ran ...`, and `Edited ...` into tool-detail summaries
- [x] Use foldable rendering when Telegram allows it; otherwise keep summaries short and details clear
- [x] Improve edit summaries so they are closer to Codex App output

Acceptance criteria:

- [x] Users can understand what operations were performed
- [x] Tool details do not drown out the assistant body text

## Phase 6: Interrupt And Approval Semantics

- [x] Show `已请求中断` immediately after an interrupt is requested
- [x] Mark any post-interrupt residual output as partial output
- [x] Represent approval waiting separately from thinking/output states
- [x] Clean up stale buttons, stale status cards, and invalid controls

Acceptance criteria:

- [x] Users can distinguish thinking, waiting for approval, winding down, and interrupted states
- [x] The UI no longer feels frozen or semantically misleading after an interrupt

## Phase 7: Recovery And Stability

- [x] Recover activity-card and body state after transient Telegram/network failures
- [x] Restore visible active-turn state as well as possible after a bridge restart
- [x] Prevent duplicate polling, duplicate sends, and duplicate archived summaries

Acceptance criteria:

- [x] Tested transient Telegram/network failures are retried instead of silently abandoning the live UI
- [x] Service restarts retire stale live state and avoid obviously broken status sequences in the next visible turn

## Phase 8: Config, Docs, And Tests

- [x] Document the intended behavior: private chat preferred, topic fallback, capability matrix
- [x] Add regression coverage for renderer routing, activity normalization, status selection, and lock/recovery primitives
- [x] Document which effects are only achievable in private chat and which are approximations in topic mode

Acceptance criteria:

- [x] The behavior boundaries are documented
- [x] The documented guarantees match the current implementation and test scope
