# Retry Failure Summary Injection Design v1

Status: Proposed for implementation (issue `#196`)  
Design issue: `#198`  
Downstream dependency: `#195`  
Related policy: `packages/core/docs/upstream-artifact-handoff-policy-v1.md`

## Summary

This design adds an implicit error-handler step to retryable node execution so each retry attempt can see a concise summary of the prior failure.

Current behavior retries with fresh sessions but no failure-aware context from the same node attempt history. This causes repeated failure patterns. The design keeps retry behavior deterministic and bounded, reuses existing `runPhase` infrastructure, and preserves the upstream artifact handoff policy.

## Objective

For nodes with retries enabled, execute an internal error-handler phase after a failed attempt and before the next attempt runs. Persist the generated summary as a tagged artifact and inject it into retry context.

## Non-goals

- No model-driven compression for upstream predecessor artifacts.
- No changes to routing semantics.
- No change to default behavior for nodes with `maxRetries = 0`.
- No requirement that operator-triggered retries execute a fresh error-handler run in `run-control.ts`.

## Architecture

### Current failure/retry path

In `executeClaimedRunnableNode` (`packages/core/src/sql-workflow-executor/node-execution.ts`):

1. Node attempt fails.
2. Failure artifact is persisted (`artifact_type = log`).
3. Diagnostics are persisted for the failed attempt.
4. Retry attempt is scheduled by transitioning `run_nodes` from `failed` to `running` (immediate) or to `pending` (deferred while paused).
5. Next attempt reassembles only direct-predecessor `report` artifacts; no prior-attempt summary from the same node is included.

### Proposed failure/retry path

For retryable failures with error handler enabled:

1. Attempt fails and failure artifact is persisted (existing behavior).
2. Internal error-handler phase executes using failure context for the failed attempt.
3. If successful, summary artifact is persisted as a tagged `note`.
4. Retry scheduling transition runs (existing behavior).
5. On next attempt, upstream context is assembled and retry summary entry is appended before provider execution.

If the error handler fails, retry proceeds without summary injection.

### Error handler execution model

The error handler is represented as a synthetic `PhaseDefinition` and executed via existing `runPhase`:

- `type: 'agent'`
- `provider`: default to failed node provider unless overridden
- `model`: cheap/fast default unless overridden
- `prompt`: default summarization prompt unless overridden
- `transitions: []`

This preserves provider resolution via `resolveProvider` and avoids introducing a second execution runtime.

### Sequence and transaction boundaries

- Persisting failure artifact and diagnostics remains in the same failure branch.
- Error-handler execution occurs between failure persistence and retry state transition.
- Error-handler artifacts are persisted independently of retry transition success/failure.
- Retry transition precondition behavior remains unchanged.

## Schema Changes

### `tree_nodes.error_handler_config`

Add nullable JSON column:

- Name: `error_handler_config`
- Type: JSON text (`mode: 'json'`)
- Null semantics: `null` means default implicit handler behavior

Suggested persisted shape:

```ts
type ErrorHandlerConfig =
  | { mode: 'disabled' }
  | {
      mode: 'custom';
      prompt?: string;
      model?: string;
      provider?: 'codex' | 'claude';
      maxInputChars?: number;
    };
```

Compatibility note for DSL/API semantics:

- Workflow definition `errorHandler: null` can map to persisted `{ mode: 'disabled' }`.
- Omitted/undefined `errorHandler` maps to persisted `null` (default enabled).

This resolves the issue-text conflict between "null means default" and "null means opt-out" by separating external API input from persisted DB shape.

### Phase artifact tagging for summaries

Use existing `phase_artifacts` schema without a new `artifact_type` enum value:

- `artifact_type = 'note'`
- `metadata.kind = 'error_handler_summary_v1'`
- `metadata.sourceAttempt = <failed attempt>`
- `metadata.targetAttempt = <next attempt>`
- `metadata.errorHandler` object with provider/model/prompt hash and execution stats

Rationale:

- Avoids broad enum/check migration churn for `phase_artifacts_artifact_type_ck`.
- Keeps summary artifacts excluded from current upstream `report`-only selection logic.
- Still provides deterministic queryability via tagged metadata.

### `run_node_diagnostics` tracking

No table shape change required in v1. Extend diagnostics payload JSON with optional section:

```ts
errorHandler?: {
  attempted: boolean;
  status: 'completed' | 'failed' | 'skipped';
  summaryArtifactId: number | null;
  sourceAttempt: number;
  targetAttempt: number | null;
  provider: string | null;
  model: string | null;
  eventCount: number;
  tokensUsed: number;
  errorMessage: string | null;
}
```

This preserves `(workflow_run_id, run_node_id, attempt)` uniqueness while recording handler behavior for each failed attempt.

## Context Assembly

### Extension strategy

Keep `assembleUpstreamArtifactContext` for predecessor reports and add a wrapper for retry-aware assembly:

1. Build upstream report context (existing policy behavior).
2. If `targetNode.attempt > 1`, lookup summary artifact tagged `error_handler_summary_v1` for `sourceAttempt = targetNode.attempt - 1`.
3. Serialize summary entry and append to context entries.
4. Merge retry-summary metadata into manifest extension fields.

### Context budget allocation

`MAX_CONTEXT_CHARS_TOTAL` remains `32_000`.

Introduce retry-summary budget reservation:

- `MAX_RETRY_SUMMARY_CONTEXT_CHARS = 4_000`
- Effective upstream budget for retry attempts: `32_000 - 4_000 = 28_000`

Rules:

- Attempt 1 uses full upstream budget (no retry summary).
- Attempt > 1 reserves retry-summary budget even if summary is absent; this keeps retry behavior deterministic.
- Retry summary content is truncated with deterministic `head_tail` strategy.

### Summary accumulation policy

Attempt `n` includes only summary from attempt `n-1`.

Rationale:

- Bounded size and stable ordering.
- Avoids compounding prompt growth across many retries.
- Encourages each summary to capture actionable delta from prior attempt.

### Retry summary envelope format

Injected as one context entry with deterministic shape:

```text
ALPHRED_RETRY_FAILURE_SUMMARY v1
policy_version: 1
untrusted_data: true
workflow_run_id: <int>
target_node_key: <string>
source_attempt: <int>
target_attempt: <int>
summary_artifact_id: <int>
failure_artifact_id: <int|null>
created_at: <ISO8601>
sha256: <hex>
truncation:
  applied: <true|false>
  method: <none|head_tail>
  original_chars: <int>
  included_chars: <int>
  dropped_chars: <int>
content:
<<<BEGIN>>>
<summary>
<<<END>>>
```

The `untrusted_data: true` marker matches upstream envelope hardening conventions.

## Error Handler Input

### Inputs provided to handler

Input context is deterministic and bounded:

1. Node metadata: `nodeKey`, provider, model, prompt hash, `attempt`, `maxRetries`
2. Failure details: normalized error message, error class
3. Partial output: extracted from `PhaseRunError.events`
4. Failure artifact content/id from the same attempt

### Partial output extraction

From `PhaseRunError.events`:

- Prefer last `result` event content if present.
- Otherwise, use concatenated trailing `assistant` events.
- Exclude tool payload details by default; include count summaries only.

### Input size limits

Add constants:

- `MAX_ERROR_CONTEXT_CHARS = 8_000` (max input passed to error handler)
- `MAX_ERROR_SUMMARY_CHARS = 4_000` (max summary injected into retry context)

All truncation uses deterministic `head_tail` to avoid nondeterministic summarization before the error handler.

## Configuration

### Defaults

Add constants in executor constants module:

- `DEFAULT_ERROR_HANDLER_PROMPT`
- `DEFAULT_ERROR_HANDLER_MODEL`
- `MAX_ERROR_CONTEXT_CHARS`

Because providers differ, v1 should also include provider-aware defaults:

```ts
const DEFAULT_ERROR_HANDLER_MODEL_BY_PROVIDER = {
  codex: 'gpt-5-codex-mini',
  claude: 'claude-3-5-haiku-latest',
} as const;
```

`DEFAULT_ERROR_HANDLER_MODEL` can remain as the codex default for compatibility and tests, while runtime selection should use provider-aware mapping.

### Override behavior

`error_handler_config` override precedence:

1. `mode: 'disabled'` -> skip error handler
2. `mode: 'custom'` with explicit prompt/model/provider -> use custom values, fallback missing fields to defaults
3. `null` -> default implicit behavior

### Opt-out behavior

Nodes with `error_handler_config.mode = 'disabled'` skip handler execution and retry without summary.

## Edge Cases

### Error handler failure

- Retry is not blocked.
- No summary artifact is persisted.
- Diagnostics capture handler failure metadata.
- Retry attempt proceeds with upstream context only.

### Node with `maxRetries = 0`

- Error handler is never invoked.
- Existing failure path remains unchanged.

### Paused run during retryable failure

- If retry is deferred (`run` status `paused`), handler can still run before node is requeued to `pending`.
- Attempt increments as today; summary for previous attempt is available when run resumes.

### Cancelled/terminal run during failure

- No retry scheduling; skip handler execution.
- Preserve current terminal semantics.

### Operator-triggered retry (`run-control.ts`)

`retryRun` currently requeues failed nodes and increments attempt without executing node logic at requeue time.

v1 behavior:

- `retryRun` does not execute a fresh error handler.
- Retries include summary from prior attempt only if it was already generated during a previous failure path.
- If no summary exists, retry proceeds without it.

Future enhancement can add explicit handler execution during control-plane retry transitions if needed.

## Testing Strategy

### Unit tests

- Error handler executes on retryable failure (`maxRetries > 0`, handler enabled).
- Disabled config skips handler.
- Custom config uses overridden prompt/model/provider.
- Handler failure does not block retry transition.
- Summary selection loads only prior attempt (`attempt - 1`) and only tagged summary artifacts.
- Summary envelope serialization is deterministic and bounded.
- Budget logic reserves retry-summary chars and respects total cap.

### Integration tests (`packages/core/src/sqlWorkflowExecutor.test.ts`)

- Attempt 2 includes attempt 1 summary in context.
- Attempt 3 includes attempt 2 summary only.
- `maxRetries = 0` never invokes handler.
- Pause/cancel retry edge cases preserve current run/node transitions with new summary behavior.
- `executeSingleNode` still performs one failed attempt with no automatic retry loop.
- Retry control (`retryRun`) behavior remains deterministic and backward compatible.

### DB/schema tests (`packages/db/src/schema.test.ts`)

- `tree_nodes.error_handler_config` persists JSON and allows null.
- Summary artifact tagging conventions validated in executor tests (no artifact-type enum expansion required).

## Risks And Mitigations

### Risk: prompt budget regressions on retry attempts

Mitigation: explicit reserved budget and deterministic truncation.

### Risk: provider/model mismatch for default handler model

Mitigation: provider-aware default model mapping with fallback.

### Risk: hidden failure of error handler reducing observability

Mitigation: persist handler status in diagnostics payload and failure artifact metadata.

### Risk: semantics ambiguity around null config

Mitigation: canonical persisted tri-state (`null`, `disabled`, `custom`) with explicit DSL-to-DB mapping.

## Dependencies And Rollout

- `#196` implementation consumes this design.
- `#195` depends on retry summaries for robust fan-out retry context.
- Dashboard/editor schema support for custom/disabled error handler config can be phased:
  - Phase 1: runtime default behavior with internal config support
  - Phase 2: authoring UI/API exposure for custom and disabled modes

## Acceptance Checklist For `#198`

- Architecture integration with `executeClaimedRunnableNode` is defined.
- Error handler reuse of `runPhase`/`PhaseDefinition` is defined.
- Schema updates and diagnostics strategy are defined.
- Context assembly and budget allocation are defined.
- Error-handler input and truncation rules are defined.
- Defaults, overrides, and opt-out are defined.
- Required edge cases are explicitly handled.
- Test plan is concrete and implementation-ready.
