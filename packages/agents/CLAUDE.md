# CLAUDE.md - packages/agents

## Scope

This directory contains agent provider adapters and registry wiring.

## Implementation Guidance

- Keep provider integration details in `src/providers`.
- Normalize raw provider events to shared `ProviderEvent` types.
- Ensure every successful provider run emits a `result` event.
- Preserve deterministic error behavior for unknown providers and malformed adapter streams.

## Checklist Before Submitting Changes

1. Verify registry resolution behavior and unknown-provider errors.
2. Verify provider usage metadata remains parseable by core token accounting.
3. Add or update adapter tests and registry tests.
4. Update `DESIGN.md` and `packages/agents/README.md` if contracts change.
