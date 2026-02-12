# AGENTS.md - packages/agents/docs

## Purpose

This directory contains operational documentation for the `@alphred/agents` package.

## Documentation Boundaries

- Keep runtime behavior claims aligned with implementation in `packages/agents/src/providers`.
- Keep architecture/boundary statements aligned with `DESIGN.md`.
- Avoid documenting speculative behavior not represented in code or tests.

## Required Content Expectations

- Document Codex auth precedence and bootstrap behavior exactly.
- Document deterministic event contract and terminal-result semantics.
- Document provider error codes and retryability guidance without weakening typed guarantees.
- Include local and CI operator guidance when runtime setup changes.

## Safety Rules For Changes

1. Update docs when provider runtime behavior changes.
2. Cross-check claims against tests in `packages/agents/src/providers/*.test.ts`.
3. Flag known gaps/assumptions explicitly instead of implying support.
4. Keep troubleshooting steps action-oriented and tied to error codes.
