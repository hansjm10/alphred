# CLAUDE.md - packages/core

## Scope

This directory implements core workflow execution and phase transition logic.

## Implementation Guidance

- Keep core provider-agnostic through dependency injection.
- Treat provider outputs as `ProviderEvent` streams.
- Require deterministic phase-runner failure semantics.
- Keep guard evaluation and transition behavior independent from adapter internals.

## Checklist Before Submitting Changes

1. Verify `runPhase` behavior for provider selection and missing-result failures.
2. Verify event propagation and token usage aggregation behavior.
3. Verify non-agent phases do not attempt provider resolution.
4. Update `DESIGN.md` if runtime contracts or boundaries change.
