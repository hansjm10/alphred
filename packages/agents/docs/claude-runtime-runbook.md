# Claude Runtime Setup and Operations Runbook

This runbook documents how to operate `ClaudeProvider` in `@alphred/agents` for local development and CI.

## Scope and Source of Truth

- Runtime architecture and boundaries: `DESIGN.md`
- Provider docs and exports: `packages/agents/README.md`
- Runtime implementation: `packages/agents/src/providers/claude.ts`
- Bootstrap/auth resolution: `packages/agents/src/providers/claudeSdkBootstrap.ts`

This document reflects current implementation behavior.

## Shared vs Claude-Specific Responsibilities

Shared runtime contract (core + adapter boundary):
- `@alphred/core` orchestrates phases and consumes normalized provider events.
- `ProviderRunOptions` validation, normalized event contract, and terminal `result` semantics are enforced by adapter runtime boundaries.

Claude-specific runtime behavior (`@alphred/agents`):
- Bootstrap/auth preflight (API key resolution, auth-mode validation, model/base URL resolution).
- Claude SDK stream mapping into normalized events.
- Claude-specific typed error codes and failure classification (`auth`, `config`, `timeout`, `rate_limit`, `transport`, `internal`).

## Local Setup

1. Install prerequisites:
   - Node.js 22+
   - pnpm 10+
2. Install dependencies:
   - `pnpm install`
3. Configure API-key auth (required runtime path):
   - `CLAUDE_API_KEY` (preferred), or
   - `ANTHROPIC_API_KEY` (fallback)
4. Optional overrides:
   - `CLAUDE_MODEL`
   - `CLAUDE_BASE_URL` or `ANTHROPIC_BASE_URL`

## Supported Auth Modes and Precedence

- Auth key precedence is deterministic:
  1. `CLAUDE_API_KEY`
  2. `ANTHROPIC_API_KEY`
- Runtime auth mode is API-key only.
- `CLAUDE_AUTH_MODE=cli_session` fails fast with a typed config error in this runtime path.

## Environment Variables

| Variable | Required | Behavior |
|---|---|---|
| `CLAUDE_API_KEY` | No | Preferred API key auth value when set and non-empty. |
| `ANTHROPIC_API_KEY` | No | API key fallback when `CLAUDE_API_KEY` is unset. |
| `CLAUDE_AUTH_MODE` | No | Accepts `api_key` or `cli_session` for validation, but `cli_session` is rejected at runtime as unsupported. |
| `CLAUDE_MODEL` | No | Model override. Defaults to `claude-3-7-sonnet-latest`. |
| `CLAUDE_BASE_URL` | No | Preferred endpoint override. Must be a valid `http`/`https` URL. |
| `ANTHROPIC_BASE_URL` | No | Endpoint fallback when `CLAUDE_BASE_URL` is unset. Must be a valid `http`/`https` URL. |

## Runtime Options and Limits

`ProviderRunOptions` contract for Claude:

- `workingDirectory`: required, non-empty string.
- `systemPrompt`: optional string; trimmed; empty values ignored.
- `context`: optional string array; non-string entries are dropped.
- `timeout`: optional positive number in milliseconds, maximum `2_147_483_647`.

Current behavior notes:

- `timeout` is enforced by an `AbortController` tied to a per-run timer.
- No default timeout is applied when `timeout` is omitted.

## Stream and Result Semantics

- Provider emits normalized event types only:
  - `system`, `assistant`, `result`, `tool_use`, `tool_result`, `usage`
- SDK message mapping includes:
  - `assistant` content blocks -> `assistant`/`tool_use`/`tool_result`/`system` (thinking)
  - `tool_progress` -> `tool_use`
  - `tool_use_summary` and user `tool_use_result` -> `tool_result`
  - `result` success -> `usage` then terminal `result`
- Successful runs must emit exactly one terminal `result`.
- Events emitted after `result` fail deterministically.
- Missing terminal `result` fails deterministically.

## Error Taxonomy

| Error code | Class | Retryable | Typical triggers |
|---|---|---|---|
| `CLAUDE_AUTH_ERROR` | auth | No | Missing API key auth, unauthorized/forbidden responses, authentication or billing failures. |
| `CLAUDE_INVALID_CONFIG` | config | No | Invalid env config, malformed auth mode/base URL/model values, unsupported CLI-session auth mode. |
| `CLAUDE_INVALID_OPTIONS` | config | No | Invalid `ProviderRunOptions` (missing working directory, malformed timeout/context/systemPrompt). |
| `CLAUDE_INVALID_EVENT` | config | No | Unsupported/malformed SDK stream events or invalid event ordering. |
| `CLAUDE_MISSING_RESULT` | config | No | Stream ended without terminal `result`. |
| `CLAUDE_TIMEOUT` | timeout | Yes | Timeout/deadline patterns and timeout-like status/failure codes. |
| `CLAUDE_RATE_LIMITED` | rate_limit | Yes | 429 and rate-limit or quota/throttle signals. |
| `CLAUDE_TRANSPORT_ERROR` | transport | Yes | Network/connection failures (for example `ECONNRESET`, `ENOTFOUND`). |
| `CLAUDE_INTERNAL_ERROR` | internal | Mixed | Unexpected runtime failures; retryability depends on classification details (for example 5xx is retryable). |

Failure classification precedence is deterministic:
1. auth
2. rate_limit
3. timeout
4. transport
5. internal

## Troubleshooting Playbook

### Auth failures (`CLAUDE_AUTH_ERROR`)

Checks:
- Confirm one API key env var is configured and non-empty:
  - `CLAUDE_API_KEY`, or
  - `ANTHROPIC_API_KEY`
- Confirm the key is valid for the target endpoint/model.

Actions:
- Set or rotate API keys.
- Remove unsupported `CLAUDE_AUTH_MODE=cli_session` settings from runtime environments.
- Re-run with known-good credentials.

### Config failures (`CLAUDE_INVALID_CONFIG`)

Checks:
- Verify `CLAUDE_AUTH_MODE` is not set to `cli_session` for runtime execution.
- Verify `CLAUDE_BASE_URL`/`ANTHROPIC_BASE_URL` are valid `http`/`https` URLs when set.
- Verify `CLAUDE_MODEL` is a non-empty string when overridden.

Actions:
- Correct malformed env values.
- Prefer provider-specific vars (`CLAUDE_*`) when both provider and fallback vars are present.

### Options and stream contract failures (`CLAUDE_INVALID_OPTIONS`, `CLAUDE_INVALID_EVENT`, `CLAUDE_MISSING_RESULT`)

Checks:
- Validate `ProviderRunOptions` payload shape (`workingDirectory`, `timeout`, `context`, `systemPrompt`).
- Confirm SDK stream event shapes and message types are supported.
- Confirm exactly one terminal completion path emits `result`.

Actions:
- Treat as adapter/SDK contract mismatch when stream shape drifts.
- Capture failing fixture and add/extend regression coverage.

### Timeout/rate limit/transport (`CLAUDE_TIMEOUT`, `CLAUDE_RATE_LIMITED`, `CLAUDE_TRANSPORT_ERROR`)

Checks:
- Review timeout setting against upstream latency.
- Inspect status/failure codes and classifier details.
- Check network reliability, DNS, and proxy configuration.

Actions:
- Retry with backoff for retryable classes.
- Increase `timeout` where appropriate.
- Reduce concurrency/load for rate-limit conditions.

### Internal failures (`CLAUDE_INTERNAL_ERROR`)

Checks:
- Inspect `details.classification`, `statusCode`, and `failureCode` when present.
- Distinguish retryable internal failures (for example 5xx) from non-retryable unknowns.

Actions:
- Retry only when `retryable === true`.
- Escalate non-retryable internal failures with diagnostics.

## CI Guidance

Current repository CI uses mocked Claude stream tests and does not require live Claude credentials.

If a live Claude runtime CI job is introduced:

1. Provide one secret auth variable:
   - `CLAUDE_API_KEY` or `ANTHROPIC_API_KEY`
2. Optionally configure:
   - `CLAUDE_MODEL`
   - `CLAUDE_BASE_URL` or `ANTHROPIC_BASE_URL`
3. Keep retries/backoff policy aligned to `ClaudeProviderError.retryable`.
4. Keep deterministic failure handling by branching on `code` and `details.classification`.
5. Do not depend on `CLAUDE_AUTH_MODE=cli_session` for runtime execution.

## Local Live Smoke Test (Optional)

The live smoke test is local-only and skipped in CI by default. It uses a test-only runtime wrapper and can exercise an existing Claude CLI session.

```bash
CLAUDE_LIVE_SMOKE=1 pnpm vitest run packages/agents/src/providers/claude.live.integration.test.ts
```
