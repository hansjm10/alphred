# AGENTS.md - packages/agents

## Purpose

This package owns the provider registry and provider adapter implementations.

## Architecture Boundaries

- Keep SDK/client specific code in `src/providers`.
- Export provider-agnostic APIs (`resolveAgentProvider`, `createAgentProviderResolver`) from this package.
- Do not move provider-selection logic into `@alphred/core`.

## Required Runtime Contract

- Providers implement `run(prompt, options) => AsyncIterable<ProviderEvent>`.
- Emit normalized event types only:
  `system`, `assistant`, `result`, `tool_use`, `tool_result`, `usage`.
- Emit a terminal `result` event for successful runs.
- Throw typed provider errors for invalid options/events and run failures.

## Safety Rules For Changes

1. Preserve deterministic unknown-provider behavior (`UnknownAgentProviderError`).
2. Keep default registry frozen and explicit.
3. Maintain event normalization and ordering guarantees.
4. Update tests and docs whenever adapter semantics change.
