# Failure-Path Routing To Remediation Nodes Design v1

Status: Proposed for implementation (issue `#200`)  
Related issue: `#196` (retry failure summaries)  
Downstream dependency: `#195`  
Related docs: `packages/core/docs/retry-failure-summary-injection-v1.md`, `packages/core/docs/upstream-artifact-handoff-policy-v1.md`

## Summary

This design adds first-class failure-path routing so a node can transition to a remediation node when the source node fails and is no longer retryable.

Today, unrecoverable node failure always terminal-fails the run. After this change, workflows can declare `on_failure` edges, and the executor can continue by scheduling remediation nodes with deterministic, bounded failure context.

## Objective

When a node attempt fails and retries are disabled or exhausted:

1. Select an explicit failure route (if configured).
2. Schedule the remediation target node instead of immediately terminal-failing the run.
3. Keep behavior deterministic (edge ordering, context size, and route choice).
4. Inject structured failure context into the remediation node, including:
   - failure artifact/error content
   - attempt metadata
   - retry-summary artifact from `#196` when present

## Non-goals

- No parallel remediation fan-out execution in v1.
- No policy engine for dynamic recovery strategies.
- No model-driven route selection for failure edges.
- No replacement of retry behavior (`maxRetries` remains the first recovery layer).
- No automatic UI redesign beyond schema-compatible edge editing support.

## Architecture

### Current failure behavior

In `executeClaimedRunnableNode` / `handleClaimedNodeFailure`:

1. Attempt fails, failure artifact is persisted.
2. If retryable, node is requeued/retried.
3. If not retryable, run transitions to `failed` and execution stops.

There is no failure-edge evaluation path.

### Proposed failure-routing behavior

For non-retryable failures (`maxRetries = 0` or retries exhausted):

1. Persist failure artifact (existing behavior).
2. Mark source run-node attempt as `failed` (existing behavior).
3. Evaluate outgoing `on_failure` edges for the failed source node in deterministic order.
4. If a failure edge is selected:
   - reactivate/schedule the target node (`pending` or revisited attempt),
   - persist failure-route metadata in diagnostics/artifact metadata,
   - continue run lifecycle (do not force immediate terminal `failed` state).
5. If no failure edge exists, preserve current terminal failure behavior.

### Edge outcome modes

Add explicit edge outcome semantics:

- `on_success`: evaluated when source node status is `completed` (existing routing behavior).
- `on_failure`: evaluated when source node status is `failed` after non-retryable failure.

v1 constraint:

- `on_failure` edges are unconditional only (`auto = true`, no guard expression).
- Deterministic tie-break remains priority-first with existing SQL ordering.

### Deterministic selection rules

For each source node:

- `completed` source: evaluate only `on_success` edges using existing auto/guard semantics.
- `failed` source: evaluate only `on_failure` edges; select first edge by deterministic ordering.
- `pending`/`running`/`skipped` sources: no selected edge yet.

Ordering remains:

- `sourceNodeId`, then `routeOn`, then `priority`, then `targetNodeId`, then `id`.

### Run-status semantics with handled failures

A failed node with a selected `on_failure` route is treated as a handled failure for run-level resolution:

- handled failure should not by itself force terminal `runStatus = failed`.
- unhandled failed nodes preserve current terminal behavior.

This requires run-status resolution and no-runnable resolution to distinguish:

- `failed + handled_by_failure_route`
- `failed + unhandled`

## Schema And Type Changes

### `tree_edges`

Add outcome column:

- `route_on` (`text`, not null, default `'success'`)
- allowed values: `'success' | 'failure'`

Adjust constraints:

- replace unique `(source_node_id, priority)` with `(source_node_id, route_on, priority)`.
- extend transition-mode check:
  - `route_on = 'success'`: existing auto/guard rules unchanged.
  - `route_on = 'failure'`: must be auto edge (`auto = 1`) with no guard.

Migration behavior:

- existing rows default to `route_on = 'success'`.

### Planner / executor edge shape

Extend `EdgeRow` / planned edge types with:

```ts
routeOn: 'success' | 'failure';
```

### Shared and dashboard contracts

Extend transition payloads with:

```ts
routeOn?: 'success' | 'failure'; // default 'success' for backward-compatible inputs
```

Validation changes:

- `routeOn = 'failure'` rejects guard expressions in v1.
- duplicate priority check becomes source+routeOn scoped.

## Executor Changes

### Routing-selection layer

Update `buildRoutingSelection` and related helpers to:

- compute selected success edges for completed sources (existing behavior),
- compute selected failure edges for failed sources (`on_failure` only),
- expose handled/unhandled failed-source sets for lifecycle resolution.

### Runnable-node selection

Update incoming-edge satisfaction checks so a target node can become runnable when:

- incoming `on_success` edge is selected from a completed source, or
- incoming `on_failure` edge is selected from a failed source.

### Failure handler integration

In `handleClaimedNodeFailure`, after retry logic resolves non-retryable failure:

1. if run is terminal (`cancelled`/already terminal), keep current terminal semantics.
2. evaluate failure route for source node.
3. when selected:
   - reactivate selected remediation target,
   - persist failure-route metadata in diagnostics payload and failure artifact metadata,
   - keep run active (`running`) or paused (`paused`) based on current lifecycle state.
4. when absent: keep current terminal failure path.

### Diagnostics extension (no table shape change)

Extend run-node diagnostics JSON with:

```ts
failureRoute?: {
  attempted: boolean;
  selectedEdgeId: number | null;
  targetNodeId: number | null;
  targetNodeKey: string | null;
  status: 'selected' | 'no_route' | 'skipped_terminal';
};
```

## Failure Context Handoff

### Context objective

When a node is executed because of an `on_failure` route, inject deterministic, bounded failure context from the failed source node.

### Context entry format

Add envelope:

```text
ALPHRED_FAILURE_ROUTE_CONTEXT v1
policy_version: 1
untrusted_data: true
workflow_run_id: <int>
target_node_key: <string>
source_node_key: <string>
source_run_node_id: <int>
source_attempt: <int>
failure_artifact_id: <int|null>
retry_summary_artifact_id: <int|null>
created_at: <ISO8601>
truncation:
  applied: <true|false>
  method: <none|head_tail>
  original_chars: <int>
  included_chars: <int>
  dropped_chars: <int>
content:
<<<BEGIN>>>
<bounded failure context payload>
<<<END>>>
```

### Failure context payload contents

Include:

1. source attempt metadata (`attempt`, `maxRetries`, retry exhaustion reason)
2. failure artifact content/error message (bounded)
3. `#196` summary artifact content for the failing attempt when present (bounded)

### Budget policy

Keep total context cap at `MAX_CONTEXT_CHARS_TOTAL = 32_000`.

Add dedicated reservation:

- `MAX_FAILURE_ROUTE_CONTEXT_CHARS = 6_000`

For failure-routed executions:

- reserve failure-route budget first,
- apply existing upstream artifact assembly to remaining budget,
- use deterministic `head_tail` truncation only.

## Edge Cases

### Retries enabled and not exhausted

- Existing retry path is unchanged.
- Failure-route evaluation only occurs once attempt is no longer retryable.

### No failure route

- Preserve current behavior: non-retryable failure terminal-fails run.

### Paused run

- Failure-route selection may still reactivate target node to `pending`.
- Run status remains `paused` until explicit resume.

### Cancelled/terminal run

- Skip failure-route scheduling and preserve terminal semantics.

### Multiple failure edges

- Deterministic first-match by priority/order.
- Same-priority ambiguity prevented by DB uniqueness per `(source, routeOn, priority)`.

### `executeSingleNode`

- Single-node mode still executes exactly one attempt.
- Failure-route metadata may be recorded, but execution scope remains one-node-only.

### Operator retry control (`retryRun`)

- Existing `retryRun` contract remains unchanged.
- Retried nodes may later traverse failure routes if they fail again non-retryably.

## Testing Strategy

### DB/schema tests (`packages/db/src/schema.test.ts`)

- `route_on` default/backfill behavior is valid.
- transition-mode checks enforce failure-edge constraints.
- uniqueness is scoped by `(source_node_id, route_on, priority)`.

### Executor unit/integration tests (`packages/core/src/sqlWorkflowExecutor.test.ts`)

- `maxRetries = 0` + failure edge schedules remediation target.
- exhausted retries + failure edge schedules remediation target.
- no failure edge preserves terminal run failure.
- paused run retains paused status while scheduling remediation target.
- cancelled run skips failure-route scheduling.
- deterministic selection among multiple failure edges by priority.
- remediation node receives bounded failure context envelope.
- remediation context includes retry-summary artifact when present.

### Dashboard/service tests

- draft API accepts `routeOn`.
- validation rejects guard expressions on `routeOn = 'failure'`.
- persistence round-trips `routeOn` across save/load/publish paths.

## Risks And Mitigations

### Risk: status-resolution regressions with failed-but-routed nodes

Mitigation: centralize handled-failure computation in routing-selection and consume it consistently in run-status/no-runnable resolution.

### Risk: context budget regressions

Mitigation: explicit failure-route reservation and deterministic truncation metadata.

### Risk: semantic confusion between success and failure transitions

Mitigation: explicit `routeOn` field everywhere (schema, contracts, UI labels, validation).

### Risk: hidden coupling with `#196` summaries

Mitigation: summary inclusion is opportunistic; missing summary does not block remediation routing.

## Dependencies And Rollout

1. Ship DB + type-contract changes (`routeOn`).
2. Ship core executor routing/status updates.
3. Ship failure-context handoff and diagnostics fields.
4. Ship dashboard draft/editor support for failure edges.
5. Update `DESIGN.md` and package READMEs to document new edge outcome semantics.

## Acceptance Checklist For `#200`

- Workflow definitions can declare failure route edges (`on_failure`).
- Non-retryable failure schedules remediation target when failure route exists.
- Nodes without failure routes preserve current terminal-failure behavior.
- Remediation node receives deterministic, bounded failure context.
- Retry interaction, no-route behavior, paused/cancelled cases, and deterministic selection are covered by tests.
