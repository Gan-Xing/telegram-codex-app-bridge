# Guided Plan Session TODO

This file used to contain the original implementation checklist. The code has already moved far past that draft, so this document is now a status snapshot instead of a stale phase-by-phase backlog.

## Scope covered

- Plan confirmation gate before execution
- Streaming plan updates and version tracking
- Review/back/cancel for structured user input
- FIFO message queue during active turns
- Richer approval cards
- Unified `/settings` home
- Startup recovery and bounded plan-history retention

## Implementation status

- [x] Plan mode turns can be drafted before execution.
- [x] Telegram shows a plan card with confirm, revise, and cancel actions.
- [x] `item/plan/delta` and `turn/plan/updated` feed the live plan card.
- [x] Structured input cards support recommended-first options, back, review, submit, and cancel.
- [x] Running turns queue later messages instead of dropping them.
- [x] Approval cards expose summary, risk, and detail/back views.
- [x] `/settings` centralizes model, mode, access, queue, and plan-history controls.
- [x] Restart recovery restores pending plan, approval, input, and queue state.
- [x] Resolved plan history is pruned by age and per-chat limits.

## Automated verification

- [x] TypeScript typecheck passes.
- [x] Automated tests cover the guided-plan control flow.
- [x] Restart recovery paths have test coverage.

## Remaining work

Only manual Telegram smoke remains:

- [ ] Confirm a drafted plan and continue into execution.
- [ ] Revise a drafted plan and confirm the next version.
- [ ] Cancel a drafted plan and verify the old card is inert.
- [ ] Walk through structured input review/back/cancel on a real chat surface.
- [ ] Verify approval detail/back cards in Telegram.
- [ ] Verify queue recovery after a bridge restart in a real session.

## Notes

- The canonical architecture rationale lives in [GUIDED_PLAN_ARCHITECTURE.md](./GUIDED_PLAN_ARCHITECTURE.md).
- If new guided-plan features are added later, open a fresh TODO section instead of restoring the old stale phase list.
