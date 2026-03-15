# Gemini Integration TODO

## Fixed architecture

- [x] One bot maps to one engine.
- [x] One running instance maps to one `.env.*` file.
- [x] One topic maps to one bot.
- [x] Runtime engine switching is intentionally out of scope.
- [x] The current Telegram bridge remains the shared shell for both Codex and Gemini.

## What is already implemented

### Runtime foundations

- [x] Multi-instance config via `BRIDGE_ENGINE`, `BRIDGE_INSTANCE_ID`, and `BRIDGE_HOME`
- [x] Instance-aware store/status/log/lock paths
- [x] Instance-aware Linux/macOS service install and restart scripts
- [x] Separate Codex and Gemini instances can run on the same host

### Provider abstraction

- [x] Unified `EngineProvider` interface
- [x] `CodexEngineProvider`
- [x] `GeminiEngineProvider`
- [x] Provider capability resolution and provider-aware controller wiring
- [x] Shared runtime status now exposes `engine` and `instanceId`
- [x] Shared provider error type for unsupported features

### Gemini MVP

- [x] Gemini subprocess runner using `gemini -p --output-format stream-json`
- [x] Stream event parsing for init, message, tool use/result, result, and error
- [x] Plain-text conversation
- [x] Gemini approval mode selection via `/mode` and `/settings`
- [x] Native Gemini approval modes: `default`, `auto_edit`, `yolo`, `plan`
- [x] Interrupt
- [x] Follow-up queue
- [x] Attachment staging and next-message consumption
- [x] Session resume via stored thread binding
- [x] `/status`
- [x] `/models`

### Provider-aware UI

- [x] Slash commands are registered per engine
- [x] `/help` is engine-aware
- [x] `/status` shows engine and instance
- [x] `/settings` is capability-aware
- [x] `/where` hides unsupported capability lines
- [x] Generic attachment/interrupt copy no longer hardcodes Codex in shared paths

### Deployment

- [x] Dedicated Gemini env file can run beside the Codex env file
- [x] Dedicated Gemini user service can run beside the Codex service
- [x] Gemini bot topic binding has been configured on the live host

## Automated verification

- [x] `npm run typecheck`
- [x] `npm test`
- [x] Multi-instance service-script tests
- [x] Engine-aware command registration tests
- [x] Provider-aware status rendering tests

## Remaining work

### Real Telegram smoke

- [ ] Run a full Gemini plain-text turn in Telegram and verify streamed output quality
- [ ] Verify queued follow-up behavior in a live Gemini topic
- [ ] Verify attachment staging plus next-message consumption in a live Gemini topic
- [ ] Verify Codex and Gemini bots ignore each other's topics while both are online
- [ ] Verify `/status`, `/help`, and `/restart` on both live bots in the shared group

### Final copy cleanup

- [ ] Audit any remaining Codex-only wording in non-Codex paths during live smoke
- [ ] Decide whether thread-history assistant labels need an explicit provider-specific variant

### Cross-platform acceptance

- [ ] Re-run the macOS user-service smoke to confirm no regression after multi-instance changes

## Acceptance bar

Gemini integration is considered complete when:

- [ ] Both Codex and Gemini bots can run together on the same host
- [ ] Each bot responds only inside its own topic or allowed private scope
- [ ] Gemini users do not see misleading Codex-only capabilities
- [ ] The README alone is enough to stand up a fresh Codex or Gemini instance
