# AGENTS.md - packages/core

## Purpose

This package owns provider-agnostic workflow runtime behavior.

## Architecture Boundaries

- Resolve providers only through injected dependencies.
- Do not import provider SDK/client implementations directly.
- Keep phase execution logic generic across provider names.

## Required Runtime Contract

- `runPhase` resolves the configured provider for agent phases.
- Provider events are collected and returned in `PhaseRunResult.events`.
- A missing `result` event is a deterministic failure.
- Token accounting must support both incremental and cumulative usage metadata.

## Safety Rules For Changes

1. Preserve DI seam (`resolveProvider`) in phase execution.
2. Preserve deterministic error propagation from resolver/provider.
3. Preserve compatibility with shared `ProviderEvent` contract.
4. Update tests in `phaseRunner.test.ts` when semantics change.
