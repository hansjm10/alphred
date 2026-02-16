# @alphred/core

Provider-agnostic workflow runtime behavior.

## SQL Workflow Executor Routing Contract

The SQL workflow executor reads routing intent from structured provider result metadata and resolves outgoing edges deterministically.

### Structured Routing Metadata

- Terminal `result` events may include `metadata.routingDecision`.
- Supported routing decision signals:
  - `approved`
  - `changes_requested`
  - `blocked`
  - `retry`
- Canonical routing metadata contract is `metadata.routingDecision` with one of
  the supported lowercase signal values above.
- Missing or invalid routing metadata is treated as no structured decision signal.
- Unsupported routing signal values are treated as invalid metadata and follow
  the same `no_route` behavior.
- Report text directives (for example, `decision: approved`) are not parsed for routing.
- Providers that drive guarded routing must emit terminal
  `result.metadata.routingDecision`; otherwise guarded paths can persist
  `no_route` outcomes.

### Edge Selection Semantics

- Outgoing edges are evaluated in deterministic SQL order:
  - `sourceNodeId`, then `priority`, then `targetNodeId`, then `id`
- The first matching outgoing edge is selected.
- Schema enforces unique sibling priority per source node (`sourceNodeId + priority`), so equal-priority sibling edge tie-breaks are rejected at write time.
- Edge matching rules:
  - `auto = 1`: always matches
  - guarded edge: requires a non-null, non-`no_route` decision and a valid guard expression

### Routing Decision Persistence

- A `routing_decisions` row is persisted for completed nodes when a valid structured routing signal is produced.
- If no outgoing edge matches, `decisionType = no_route` is persisted with rationale and raw output metadata.
- Missing or invalid routing metadata follows the same deterministic path by
  persisting `decisionType = no_route` when guarded routing cannot be evaluated.
- For metadata-derived rows, `rawOutput.source = provider_result_metadata` and `rawOutput.routingDecision` stores the structured signal (or `null` for `no_route`).
- `rawOutput.attempt` is persisted for all metadata-derived decisions.
- `rawOutput.selectedEdgeId` is included when a matching edge is selected.
- `rawOutput.outgoingEdgeIds` is included for `no_route` rows to record evaluated candidates.

### No-Route and Unresolved Behavior

- A persisted `no_route` for completed nodes with outgoing edges is treated as terminal failure (`runStatus = failed`).
- Completed guarded nodes that have outgoing edges but no persisted routing decision are treated as unresolved routing state and also fail the run to avoid indefinite `running` + `blocked` deadlocks.

## Retry and Iteration Limits

- Node retries are enforced from `tree_nodes.max_retries`, using `run_nodes.attempt` as the persisted attempt counter.
- Retry attempts use lifecycle-guarded transitions (`running -> failed -> running`) before re-running the same node.
- Backtracking routes can re-queue already terminalized nodes with lifecycle-guarded transitions (`completed -> pending`, `skipped -> pending`).
- Re-queue semantics are asymmetric by design: `completed -> pending` increments `attempt` immediately, while `skipped -> pending` preserves `attempt` until execution is claimed.
- Failed attempts persist `phase_artifacts` log rows with retry metadata, including whether a retry was scheduled or the retry limit was exhausted.
- `maxSteps` counts `executeRun` loop iterations (claimed node executions), not per-attempt retries inside a single node execution.
- `executeRun` enforces a run-level `maxSteps` ceiling; when exceeded, the run is terminalized as `failed` and the limit-exceeded reason is persisted in artifact metadata.
