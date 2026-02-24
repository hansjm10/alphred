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
1. Assembles bounded upstream artifact context from selected predecessor reports
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
- `completed` -> `pending` (loop backtrack re-queue)
- `skipped` -> `pending` (branch reactivation)
- `completed` -> `pending` increments `attempt` and clears `started_at`/`completed_at`
- `skipped` -> `pending` keeps `attempt` unchanged until the node is claimed and run

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
Shared `ProviderRunOptions` are intentionally minimal and cross-provider: required `workingDirectory`, plus optional `systemPrompt`, `context`, and `timeout`.

Each phase spawns a fresh agent session. Context from prior phases is injected via the prompt, not through conversation history.

### Upstream Artifact Context Handoff Policy (v1)

Executor-side context assembly follows a deterministic, bounded policy:
- Eligible artifacts: latest successful `report` per selected upstream run node.
- Default upstream scope: selected direct predecessors only (no transitive ancestry by default).
- Hard caps:
  - `MAX_UPSTREAM_ARTIFACTS = 4`
  - `MAX_CONTEXT_CHARS_TOTAL = 32_000`
  - `MAX_CHARS_PER_ARTIFACT = 12_000`
- Truncation: deterministic `head_tail` with persisted truncation metadata.
- Auditability: stable Context Envelope v1 entries in `options.context` and persisted downstream context-manifest metadata.

Canonical policy details live in:
- `packages/core/docs/upstream-artifact-handoff-policy-v1.md`

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
- Codex and Claude runtime bootstrap/auth preflight
- Mapping provider-specific events to shared `ProviderEvent` contract
- Provider-specific error taxonomy (`*_INVALID_OPTIONS`, `*_INVALID_EVENT`, `*_MISSING_RESULT`, plus classed runtime failures such as auth/config/timeout/rate-limit/transport/internal)

Constraint:
- SDK/client-specific code must stay in `@alphred/agents`.
- `@alphred/core` depends only on shared types and injected interfaces.

### Event Contract and Failure Semantics

Current event contract (`@alphred/shared`):
- Event types: `system`, `assistant`, `result`, `tool_use`, `tool_result`, `usage`
- Each event carries `content`, `timestamp`, and optional `metadata`
- `result` metadata may include typed routing intent (`routingDecision`: `approved` | `changes_requested` | `blocked` | `retry`)

Runtime semantics:
- Agent phase missing `provider` -> phase runner throws immediately.
- Unknown provider name -> resolver throws `UnknownAgentProviderError`.
- Claude provider validates runtime auth/config before stream execution.
- Claude provider classifies runtime failures with deterministic typed codes and retryability metadata for orchestration consumers.
- Codex provider validates runtime auth/config before stream execution.
- Codex provider classifies runtime failures with deterministic typed codes and retryability metadata for orchestration consumers.
- Adapter/provider stream must include exactly one terminal `result` event for success.
- Events after `result` are rejected by adapter runtime as invalid ordering.
- If no `result` is emitted, adapter/provider run fails deterministically.
- SQL executor routing consumes structured `result.metadata.routingDecision` only; report text is display/log output and not parsed for route selection.
- When both metadata keys are present, canonical `routingDecision` takes precedence when valid; `routing_decision` is fallback-only when canonical metadata is missing or invalid.
- Unsupported routing metadata signals are dropped by provider adapters and treated as missing by core routing, which can persist `no_route` outcomes.
- Rollout note: providers that participate in guarded routing must emit terminal `result.metadata.routingDecision`; missing metadata may yield persisted `no_route` outcomes.
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

SQL-first workflow topology and execution state are modeled with normalized tables in SQLite (via Drizzle ORM):

- `workflow_trees`
  - Versioned tree definitions (`tree_key`, `version`, `name`) and ownership root for topology rows.
  - Constraint/index rationale:
    - Unique `(tree_key, version)` prevents ambiguous template identity.
    - `created_at` index supports chronological catalog queries.
- `prompt_templates`
  - Reusable prompt references for node templates.
  - Constraint/index rationale:
    - Unique `(template_key, version)` supports immutable prompt versions.
    - `content_type` check enforces allowed prompt formats.
- `guard_definitions`
  - Reusable guard references (stored as JSON text expressions).
  - Constraint/index rationale:
    - Unique `(guard_key, version)` provides deterministic guard lookup.
- `repositories`
  - Managed repository registry (`name`, `provider`, `remote_url`, `remote_ref`, `default_branch`, `branch_template`, `local_path`, `clone_status`).
  - Constraint/index rationale:
    - Unique `name` prevents ambiguous repository aliases.
    - `provider` check enforces known SCM kinds (`github`, `azure-devops`).
    - `clone_status` check enforces lifecycle enum (`pending`, `cloned`, `error`).
    - `created_at` index supports chronological listing hot paths.
  - Write semantics:
    - `remote_ref` is stored as a provider-scoped opaque identifier. Provider-specific shape validation is deferred to SCM adapter layers.
    - `branch_template` is optional and, when set, overrides the global branch naming template for worktree branch generation.
    - Clone-status updates preserve `local_path` unless an explicit `local_path` value is supplied with the update.
- `tree_nodes`
  - Phase template nodes (`node_key`, `node_type`, `provider`, `prompt_template_id`, retry policy).
  - Constraint/index rationale:
    - Unique `(workflow_tree_id, node_key)` enforces node identity within a tree version.
    - Unique `(workflow_tree_id, sequence_index)` enforces deterministic ordering.
    - `node_type` check and `provider`-required-for-agent check harden topology validity.
    - `node_key` and `created_at` indexes support lookup and listing hot paths.
- `tree_edges`
  - Directed transitions (`source_node_id`, `target_node_id`, `priority`, `guard_definition_id`, `auto`).
  - Constraint/index rationale:
    - Unique `(source_node_id, priority)` enforces deterministic transition precedence.
    - `auto` boolean and transition-mode checks enforce unconditional-vs-guarded edge semantics.
- `workflow_runs`
  - Execution instances bound to a specific workflow tree version.
  - Constraint/index rationale:
    - Run status check enforces lifecycle enum.
    - Completion timestamp check ensures terminal states have `completed_at`.
- `run_nodes`
  - Materialized node execution records per run.
  - Constraint/index rationale:
    - Unique `(workflow_run_id, sequence_index)` enforces deterministic run order.
    - Unique `(workflow_run_id, node_key, attempt)` prevents duplicate attempt identity.
    - Status and timestamp checks enforce lifecycle integrity at DB boundary.
    - Required hot-path indexes: `(workflow_run_id, status)`, `(workflow_run_id, sequence_index)`, `node_key`, `created_at`.
- `routing_decisions`
  - Typed routing outcomes (`approved`, `changes_requested`, `blocked`, `retry`, `no_route`) stored separately from model output text.
  - Constraint/index rationale:
    - `decision_type` check enforces allowed decision taxonomy.
    - `(workflow_run_id, created_at)` and `created_at` indexes support timeline queries.
- `phase_artifacts`
  - Free-form phase outputs (text/markdown/json/diff) and metadata.
  - Constraint/index rationale:
    - Content/artifact type checks enforce valid storage classes.
    - `(workflow_run_id, created_at)` and `created_at` indexes support artifact retrieval patterns.
- `run_node_diagnostics`
  - Immutable per-node/per-attempt diagnostics snapshots for operator inspection.
  - Constraint/index rationale:
    - Unique `(workflow_run_id, run_node_id, attempt)` enforces one persisted diagnostics payload per completed attempt.
    - `outcome` check (`completed`/`failed`) and non-negative count checks harden audit metadata integrity.
    - `(workflow_run_id, created_at)`, `(run_node_id, created_at)`, and `created_at` indexes support run timeline and node drill-down queries.
  - Runtime boundary:
    - Diagnostics are inspection-only by default and are not re-injected into downstream execution context.
- `run_node_stream_events`
  - Append-only per-node/per-attempt provider stream events for live operator monitoring.
  - Constraint/index rationale:
    - Unique `(workflow_run_id, run_node_id, attempt, sequence)` enforces deterministic, gap-free ordering identity per attempt.
    - `event_type` check enforces normalized provider event taxonomy (`system`, `assistant`, `tool_use`, `tool_result`, `usage`, `result`).
    - Non-negative bounds on token/size counters protect stream payload integrity.
    - `(workflow_run_id, run_node_id, attempt, sequence)` and chronological indexes support snapshot+resume and timeline drill-down.
  - Runtime boundary:
    - Stream payloads reuse diagnostics redaction/truncation policy before persistence.

FK behavior is explicit:
- Template topology rows cascade from `workflow_trees`.
- Execution rows cascade from `workflow_runs` and `run_nodes`.
- Composite FKs bind `routing_decisions`/`phase_artifacts`/`run_node_diagnostics`/`run_node_stream_events` to the same `(workflow_run_id, run_node_id)` tuple from `run_nodes`.
- Shared references (`prompt_templates`, `guard_definitions`) use `RESTRICT` to prevent dangling refs.
- Trigger guards enforce cross-row invariants not representable as a single-column FK:
  - `tree_edges.workflow_tree_id` must match both endpoint node tree IDs.
  - `run_nodes.workflow_run_id` and `run_nodes.tree_node_id` must resolve to the same tree.

Run-node state transitions are additionally guarded in the DB package write path to reject invalid status moves (`pending -> running/skipped/cancelled`, `running -> completed/failed/cancelled`, `failed -> running`, `completed -> pending`, `skipped -> pending`).

Schema migration reruns are idempotent (`CREATE ... IF NOT EXISTS`), so repeated runs do not drop previously persisted rows in the migrated schema.
For this transition, treat any optional one-time legacy-schema replacement during initial adoption as a destructive cutover decision; rerunning the current migration after that cutover is non-destructive.

## Git Integration

Each run operates in an isolated git worktree:
1. Create worktree from the target branch
2. Agent operates within the worktree directory
3. On completion, create PR via `gh` or `az` CLI
4. Clean up worktree after PR creation

Branch naming for worktrees is template-driven:
- Template precedence: explicit per-run branch value, repository `branch_template`, `ALPHRED_BRANCH_TEMPLATE`, then default `alphred/{tree-key}/{run-id}`.
- Supported template tokens: `{tree-key}`, `{run-id}`, `{node-key}`, `{issue-id}`, `{timestamp}`, `{short-hash}`, `{date}`.
- Generated branch names are sanitized to avoid invalid git ref characters and invalid trailing segments.
