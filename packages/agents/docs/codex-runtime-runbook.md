# Codex Runtime Setup and Operations Runbook

This runbook documents how to operate `CodexProvider` in `@alphred/agents` for local development and CI.

## Scope and Source of Truth

- Runtime architecture and boundaries: `DESIGN.md`
- Provider docs and exports: `packages/agents/README.md`
- Runtime implementation: `packages/agents/src/providers/codex.ts`
- Bootstrap/auth resolution: `packages/agents/src/providers/codexSdkBootstrap.ts`

This document reflects current implementation behavior.

## Local Setup

1. Install prerequisites:
   - Node.js 22+
   - pnpm 10+
2. Install dependencies:
   - `pnpm install`
3. Choose one auth mode.

### Auth Mode A: API Key

Set one of:
- `CODEX_API_KEY` (preferred)
- `OPENAI_API_KEY` (fallback)

If both are set, `CODEX_API_KEY` wins.

### Auth Mode B: Existing Codex CLI Login Session

Use CLI login if API keys are not set:

1. Run `codex login`
2. Confirm session with `codex login status`

When CLI auth is used, the provider checks login state via the bundled Codex binary before execution.

## Environment Variables

| Variable | Required | Behavior |
|---|---|---|
| `CODEX_API_KEY` | No | Preferred API key auth value when set and non-empty. |
| `OPENAI_API_KEY` | No | API key fallback when `CODEX_API_KEY` is unset. |
| `CODEX_MODEL` | No | Model override. Defaults to `gpt-5-codex`. |
| `OPENAI_BASE_URL` | No | Optional endpoint override. Must be a valid `http`/`https` URL. |
| `CODEX_HOME` | No | Codex auth/config directory. Defaults to `$HOME/.codex`. |

## Runtime Options and Limits

`ProviderRunOptions` contract for Codex:

- `workingDirectory`: required, non-empty string.
- `systemPrompt`: optional string; trimmed; empty values ignored.
- `context`: optional string array; non-string entries are dropped.
- `timeout`: optional positive number in milliseconds, maximum `2_147_483_647`.

Current behavior notes:

- `timeout` is enforced by `AbortSignal.timeout(timeout)`.
- No default timeout is applied when `timeout` is omitted.

## Stream and Result Semantics

- Provider emits normalized event types only:
  - `system`, `assistant`, `result`, `tool_use`, `tool_result`, `usage`
- Successful runs must emit exactly one terminal `result`.
- Events emitted after `result` fail deterministically.
- Missing terminal `result` fails deterministically.

## Error Taxonomy

| Error code | Class | Retryable | Typical triggers |
|---|---|---|---|
| `CODEX_AUTH_ERROR` | auth | No | Missing auth, invalid key, unauthorized/forbidden responses, no CLI login session. |
| `CODEX_INVALID_CONFIG` | config | No | Invalid env config, invalid URL/protocol, unsupported platform/arch, CLI status-check failures, missing bundled binary. |
| `CODEX_INVALID_OPTIONS` | config | No | Invalid `ProviderRunOptions` (missing working directory, malformed timeout/context/systemPrompt). |
| `CODEX_INVALID_EVENT` | config | No | Unsupported/malformed SDK stream events or invalid event ordering. |
| `CODEX_MISSING_RESULT` | config | No | Stream ended without terminal `result`. |
| `CODEX_TIMEOUT` | timeout | Yes | Timeout/deadline patterns and timeout-like status/failure codes. |
| `CODEX_RATE_LIMITED` | rate_limit | Yes | 429 and rate-limit or quota/throttle signals. |
| `CODEX_TRANSPORT_ERROR` | transport | Yes | Network/connection failures (for example `ECONNRESET`, `ENOTFOUND`). |
| `CODEX_INTERNAL_ERROR` | internal | Mixed | Unexpected runtime failures; retryability depends on classification details (for example 5xx is retryable). |

## Troubleshooting Playbook

### Auth failures (`CODEX_AUTH_ERROR`)

Checks:
- Confirm one auth mode is available:
  - API key set, or
  - valid CLI login session (`codex login status`)
- Ensure configured key env values are non-empty strings.

Actions:
- Re-authenticate CLI (`codex login`) or correct key configuration.
- In CI, provide a secret for one API key env var.

### Config failures (`CODEX_INVALID_CONFIG`)

Checks:
- Verify `OPENAI_BASE_URL` is a valid `http`/`https` URL.
- Verify platform/arch is supported by bundled Codex binary.
- Verify `CODEX_HOME` points to a valid path when overridden.

Actions:
- Correct env formatting and URL protocol.
- Run on a supported runner architecture.
- Reinstall dependencies if bundled binary resolution fails.

### Timeout/rate limit/transport (`CODEX_TIMEOUT`, `CODEX_RATE_LIMITED`, `CODEX_TRANSPORT_ERROR`)

Checks:
- Review timeout setting and upstream latency.
- Inspect response status/failure code patterns.
- Check network reliability and proxy settings.

Actions:
- Retry with backoff for retryable classes.
- Increase `timeout` where appropriate.
- Reduce concurrency/load for rate-limited runs.

### Stream contract failures (`CODEX_INVALID_EVENT`, `CODEX_MISSING_RESULT`)

Checks:
- Confirm stream emits valid SDK event shapes.
- Confirm exactly one terminal completion path exists.

Actions:
- Treat as adapter/SDK contract mismatch.
- Capture failing fixture and add regression coverage.

### Internal failures (`CODEX_INTERNAL_ERROR`)

Checks:
- Inspect `details.classification`, `statusCode`, and `failureCode` when present.
- Distinguish retryable internal failures (for example 5xx) from non-retryable unknowns.

Actions:
- Retry only when `retryable === true`.
- Escalate non-retryable internal failures with diagnostics.

## CI Guidance

Repository CI keeps mocked Codex stream coverage as the deterministic baseline in `pnpm test:coverage`.

Live runtime smoke is optional and is not part of the default CI workflow.
Use it manually in credentialed environments and keep deterministic failure handling by branching on `code` and `details.classification`.
Keep retries/backoff policy aligned to `CodexProviderError.retryable`.

## Live Smoke Test (Optional)

This test validates at least one successful live Codex runtime path and is skipped by default.

```bash
CODEX_LIVE_SMOKE=1 pnpm vitest run packages/agents/src/providers/codex.live.integration.test.ts
```

Required for runtime auth:

- `CODEX_API_KEY` or `OPENAI_API_KEY`, or
- existing Codex CLI login session (`codex login status`)

Optional runtime env:

- `CODEX_MODEL`
- `OPENAI_BASE_URL`
- `CODEX_HOME`

Failure output includes actionable diagnostics:

- `code`
- `details.classification`
- `retryable`
- `details.statusCode`
- `details.failureCode`
