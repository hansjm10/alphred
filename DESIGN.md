# Alphred Design Document

## Overview

Alphred is a phase-based LLM agent orchestrator. It executes multi-step workflows where each phase invokes an LLM agent (Claude or Codex) in a sandboxed git worktree.

## Workflow Model

A workflow is a directed graph of phases with conditional transitions:

```
[design] --(auto)--> [implement] --(needs_revision==true)--> [design]
                          |
                     (auto, lower priority)
                          v
                      [review]
```

### Phase Execution

Each phase:
1. Loads prior phase reports from the database as context
2. Creates a new agent session (no conversation carry-over)
3. Invokes the configured agent provider with the prompt + context
4. Collects streaming events and stores the final report
5. Evaluates transitions to determine the next phase

### State Machine

**Run states:**
- `pending` -> `running` -> `completed` | `failed` | `cancelled`
- `running` <-> `paused`

**Phase states:**
- `pending` -> `running` -> `completed` | `failed`
- `pending` -> `skipped`
- `failed` -> `running` (retry)

### Transition Evaluation

1. Transitions are sorted by priority (ascending)
2. `auto: true` transitions fire immediately (unconditional)
3. `when` guard expressions are evaluated against the phase report context
4. First matching transition wins
5. If no transition matches, the run completes

### Guard Expressions

Guards support:
- Dotted field paths: `report.quality.score`
- Comparison operators: `==`, `!=`, `>`, `<`, `>=`, `<=`
- Logical operators: `and`, `or` (nested)

### Retry Logic

- Phase fails -> check `retryCount < maxRetries`
- If retriable: transition phase back to `running`, create new agent session
- If exhausted: run transitions to `failed`

## Agent Abstraction

Both providers implement:

```typescript
interface AgentProvider {
  readonly name: string;
  run(prompt: string, options: ProviderRunOptions): AsyncIterable<ProviderEvent>;
}
```

Streamed event types: `system`, `assistant`, `result`, `tool_use`, `tool_result`, `usage`.

Each phase spawns a fresh agent session. Context from prior phases is injected via the prompt, not through conversation history.

## Agent Runtime v1 (DI + Adapters)

This section defines the runtime boundary between `@alphred/core` and `@alphred/agents`.

### DI Wiring Pattern

- `@alphred/core` does not import provider classes directly.
- `runPhase` receives a dependency object with `resolveProvider(providerName)`.
- The resolver is injected by the caller (composition root) and can come from:
  - `resolveAgentProvider` (default registry in `@alphred/agents`)
  - `createAgentProviderResolver(customRegistry)` (custom wiring)

Runtime flow for agent phases:
1. Core reads `phase.provider` from workflow configuration.
2. Core resolves provider via injected resolver.
3. Core executes `provider.run(phase.prompt, options)`.
4. Core stores streamed events and final `result` content in `PhaseRunResult`.
5. Core derives `tokensUsed` from usage metadata.

### Provider Registry Responsibilities

`@alphred/agents` owns provider registration and unknown-provider behavior:
- `defaultAgentProviderRegistry` is frozen and includes `claude` and `codex`.
- `createAgentProviderResolver(registry)` resolves only own keys (not inherited keys).
- Unknown providers throw `UnknownAgentProviderError` with:
  - `code = UNKNOWN_AGENT_PROVIDER`
  - requested `providerName`
  - deterministic, sorted `availableProviders`

### Adapter Boundaries (Core vs SDK-Specific Code)

`@alphred/core` responsibilities:
- Workflow/phase orchestration
- Provider resolution through DI
- Event collection and `result` extraction
- Token usage aggregation across provider usage payload variants
- Deterministic runtime errors when provider is missing or result event is missing

`@alphred/agents` responsibilities:
- Provider adapters (`ClaudeProvider`, `CodexProvider`)
- SDK/process integration and raw event normalization
- Codex SDK bootstrap/auth preflight (API key or CLI session)
- Mapping provider-specific events to shared `ProviderEvent` contract
- Provider-specific error taxonomy (`*_INVALID_OPTIONS`, `*_INVALID_EVENT`, `*_MISSING_RESULT`, plus classed runtime failures such as auth/config/timeout/rate-limit/transport/internal)

Constraint:
- SDK/client-specific code must stay in `@alphred/agents`.
- `@alphred/core` depends only on shared types and injected interfaces.

### Event Contract and Failure Semantics

Current event contract (`@alphred/shared`):
- Event types: `system`, `assistant`, `result`, `tool_use`, `tool_result`, `usage`
- Each event carries `content`, `timestamp`, and optional `metadata`

Runtime semantics:
- Agent phase missing `provider` -> phase runner throws immediately.
- Unknown provider name -> resolver throws `UnknownAgentProviderError`.
- Codex provider validates runtime auth/config before stream execution.
- Codex provider classifies runtime failures with deterministic typed codes and retryability metadata for orchestration consumers.
- Adapter/provider stream must include exactly one terminal `result` event for success.
- Events after `result` are rejected by adapter runtime as invalid ordering.
- If no `result` is emitted, adapter/provider run fails deterministically.
- Phase runner token accounting:
  - Sums incremental `tokens` values.
  - Tracks max cumulative values (`tokensUsed`, `totalTokens`, `total_tokens`, `input+output` variants).
  - Uses the higher of incremental total vs max cumulative value.

### Adding a New Provider Adapter Safely

1. Extend provider name types:
  - Add provider name to `AgentProviderName` in `@alphred/shared`.
2. Implement adapter in `@alphred/agents/src/providers`:
  - Define provider error codes and typed error class.
  - Use adapter core (`runAdapterProvider`) to normalize events/options.
3. Register provider:
  - Add instance to `defaultAgentProviderRegistry`.
4. Verify tests:
  - Registry resolution and unknown-provider path.
  - Adapter event normalization and failure semantics.
  - Phase runner event propagation and token accounting.
5. Update docs:
  - `DESIGN.md`
  - `packages/agents/README.md`
  - directory-scoped `AGENTS.md` and `CLAUDE.md` guidance where relevant.

## Database Schema

Eight SQLite tables managed via Drizzle ORM:

- `workflows` - Template definitions (JSON workflow spec)
- `runs` - Execution instances with status tracking
- `phases` - Individual phase records within a run
- `phase_reports` - Output artifacts from phase execution
- `agent_sessions` - Individual agent invocations with token/cost tracking
- `agent_events` - Streaming event log
- `run_logs` - Structured application logs
- `state_snapshots` - Persistent key-value state between phases

## Git Integration

Each run operates in an isolated git worktree:
1. Create worktree from the target branch
2. Agent operates within the worktree directory
3. On completion, create PR via `gh` or `az` CLI
4. Clean up worktree after PR creation
