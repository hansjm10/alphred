# @alphred/core

Provider-agnostic workflow runtime behavior.

## SQL Workflow Executor Routing Contract

The SQL workflow executor parses routing intent from phase reports and resolves outgoing edges deterministically.

### Decision Directive Grammar

- Accepted format: a full line containing `decision: <signal>`.
- Keyword matching is ASCII case-insensitive (`decision`, `DeCiSion`, etc.).
- Leading/trailing ASCII whitespace is allowed.
- `<signal>` must be one of:
  - `approved`
  - `changes_requested`
  - `blocked`
  - `retry`
- Extra non-whitespace tokens on the directive line are rejected.
  - Example: `decision: approved.` is not accepted.

### Edge Selection Semantics

- Outgoing edges are evaluated in deterministic SQL order:
  - `sourceNodeId`, then `priority`, then `targetNodeId`, then `id`
- The first matching outgoing edge is selected.
- Schema enforces unique sibling priority per source node (`sourceNodeId + priority`), so equal-priority sibling edge tie-breaks are rejected at write time.
- Edge matching rules:
  - `auto = 1`: always matches
  - guarded edge: requires a non-null, non-`no_route` decision and a valid guard expression

### Routing Decision Persistence

- A `routing_decisions` row is persisted for completed nodes when routing metadata is produced.
- If no outgoing edge matches, `decisionType = no_route` is persisted with rationale and raw output metadata.

### No-Route and Unresolved Behavior

- A persisted `no_route` for completed nodes with outgoing edges is treated as terminal failure (`runStatus = failed`).
- Completed guarded nodes that have outgoing edges but no persisted routing decision are treated as unresolved routing state and also fail the run to avoid indefinite `running` + `blocked` deadlocks.

## Retry and Iteration Limits

- Node retries are enforced from `tree_nodes.max_retries`, using `run_nodes.attempt` as the persisted attempt counter.
- Retry attempts use lifecycle-guarded transitions (`running -> failed -> running`) before re-running the same node.
- Failed attempts persist `phase_artifacts` log rows with retry metadata, including whether a retry was scheduled or the retry limit was exhausted.
- `executeRun` enforces a run-level `maxSteps` ceiling; when exceeded, the run is terminalized as `failed` and the limit-exceeded reason is persisted in artifact metadata.
