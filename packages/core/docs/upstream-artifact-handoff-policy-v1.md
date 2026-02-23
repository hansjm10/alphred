# Upstream Artifact Handoff Policy v1

Status: Approved for implementation (issue `#147`)
Source issue: `#146`
Epic: `#145`

## Objective

Define deterministic, bounded, auditable handoff of upstream node artifacts into downstream provider context without reintroducing unbounded prompt growth.

## Runtime Constraints

- Nodes execute in fresh provider sessions.
- Handoff must use `ProviderRunOptions.context?: string[]`.
- Context entries are rendered by provider adapters as ordered `Context:` lines (`[1] ...`, `[2] ...`).
- Persisted artifacts live in `phase_artifacts` (`artifact_type`: `report` | `note` | `log`).

## Policy Defaults (v1)

### Eligible artifacts

- Include only latest successful `report` artifact per upstream run node.
- Select the latest by `(phase_artifacts.created_at, phase_artifacts.id)` ascending scan, final row wins.
- Exclude `log` and `note` by default.

### Upstream scope

- Include selected direct predecessors only.
- A predecessor is eligible when its selected outgoing edge targets the downstream node being executed.
- Do not include transitive ancestry by default.

### Hard bounds

- `MAX_UPSTREAM_ARTIFACTS = 4`
- `MAX_CONTEXT_CHARS_TOTAL = 32_000`
- `MAX_CHARS_PER_ARTIFACT = 12_000`

Character counts use JavaScript string length (UTF-16 code units) for deterministic runtime parity with current TypeScript execution.

## Deterministic Selection and Truncation

### Stable ordering

Sort candidate artifacts by:

1. Graph distance from target node (direct predecessors first; default depth = 1).
2. Source node `sequence_index` ascending.
3. Source node `node_key` code-unit lexical ascending.
4. `run_node_id` ascending.

### Inclusion algorithm

1. Build ordered candidate list after filtering and latest-report selection.
2. Apply per-artifact truncation to `MAX_CHARS_PER_ARTIFACT`.
3. Add artifacts in stable order until hitting artifact-count or total-char cap.
4. If remaining budget can still hold meaningful content (`>= 1000` chars), apply additional deterministic head+tail truncation to fit the last included artifact.
5. If remaining budget is `< 1000`, skip additional artifacts and record budget-overflow metadata.

### Truncation method

- Method name: `head_tail`
- Include first `floor(limit / 2)` chars + last `limit - floor(limit / 2)` chars.
- Preserve deterministic boundaries; no model-based summarization in executor.

## Context Envelope v1 (Exact Entry Shape)

Each included upstream artifact is serialized as one `context[]` string entry using this exact field order:

```text
ALPHRED_UPSTREAM_ARTIFACT v1
policy_version: 1
untrusted_data: true
workflow_run_id: <int>
target_node_key: <string>
source_node_key: <string>
source_run_node_id: <int>
source_attempt: <int>
artifact_id: <int>
artifact_type: report
content_type: <text|markdown|json|diff>
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
<content>
<<<END>>>
```

Notes:

- `sha256` is computed over original (untruncated) artifact content.
- Delimiters and header/version string are fixed and case-sensitive.
- `untrusted_data: true` is a mandatory marker for prompt-injection hardening.

## Auditability and Observability Requirements

Persist context assembly metadata for every downstream node execution:

- `context_policy_version`
- `included_artifact_ids`
- `included_source_node_keys`
- `included_source_run_node_ids`
- `included_count`
- `included_chars_total`
- `truncated_artifact_ids`
- `missing_upstream_artifacts`
- `assembly_timestamp`

Persistence target for v1:

- Downstream `report` artifact metadata for successful node executions.
- Downstream `log` artifact metadata for failed node executions.

## Failure Modes and Guardrails

- No upstream artifacts found:
  - Run node execution continues with empty context.
  - Persist `missing_upstream_artifacts: true`.
- Only ineligible artifact types found:
  - Continue with empty context.
  - Persist `no_eligible_artifact_types: true`.
- Budget overflow:
  - Apply deterministic truncation policy.
  - Persist truncation and drop statistics.
- Concurrency race risk:
  - Assemble context after run-node claim and immediately before provider invocation.
  - Persist included artifact IDs and hashes from the same assembly snapshot.
- Prompt injection risk from upstream content:
  - Keep `untrusted_data: true` marker in each envelope.
  - Preserve system prompt authority; do not treat envelope text as instructions.

## Integration Checklist (Executor)

- Add `ContextHandoffPolicyV1` constants and policy schema in `@alphred/core`.
- Add context assembly function to SQL executor node execution path.
- Resolve selected direct predecessors from routing state already persisted for the run.
- Query latest eligible upstream `report` artifacts for those selected predecessors.
- Apply deterministic ordering, per-artifact cap, and total cap.
- Serialize each entry with Context Envelope v1.
- Inject assembled entries through `ProviderRunOptions.context`.
- Keep behavior deterministic across repeated runs with identical persisted inputs.

## Integration Checklist (Observability)

- Persist context manifest metadata on downstream artifacts.
- Include policy version and truncation counters.
- Include stable provenance IDs (`run_node_id`, `artifact_id`) for each included entry.
- Ensure timeline/debug views can identify when context was empty, truncated, or dropped.
- Ensure metadata shape is stable and JSON-serializable.

## Integration-Ready Test Plan

### Unit tests

- Candidate filtering includes only latest successful `report` per source node.
- Deterministic sorting is stable for tie-break keys (`sequence_index`, `node_key`, `run_node_id`).
- Per-artifact truncation computes deterministic `head_tail` slices and metadata.
- Total-budget application caps `context` deterministically.
- Envelope serialization preserves exact field order and delimiters.
- SHA-256 hash reflects original content, not truncated content.

### Integration tests

- Linear flow `Brainstorm -> Pick -> Research`:
  - `Pick` receives `Brainstorm` report envelope in `options.context`.
  - `Research` receives `Pick` report envelope in `options.context`.
- Branch/join flow:
  - Downstream join node includes only selected direct predecessors.
- Overflow flow:
  - Multiple large upstream reports trigger deterministic truncation and persisted manifest counters.
- Empty upstream flow:
  - Execution proceeds without context and records missing-context metadata.
- Determinism replay:
  - Re-running with unchanged persisted inputs yields byte-equivalent context entries.

## Out of Scope for v1

- Transitive ancestry inclusion by default.
- Model-driven summarization/compression inside executor.
- Tokenizer-specific budget enforcement.

