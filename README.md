# Alphred - LLM Agent Orchestrator

A phase-based workflow engine that orchestrates LLM agents (Claude and Codex) to automate software development tasks. Alphred manages multi-step workflows with retry/loop logic, sandboxed git worktrees, and integrates with GitHub and Azure DevOps.

## Architecture

Alphred is a pnpm monorepo with the following packages:

| Package | Description |
|---|---|
| `@alphred/shared` | Shared type definitions |
| `@alphred/db` | SQLite database layer (Drizzle ORM) |
| `@alphred/core` | Workflow engine, state machine, guard evaluation |
| `@alphred/agents` | Agent provider abstraction (Claude, Codex) |
| `@alphred/git` | Git worktree management, GitHub/Azure DevOps integration |
| `@alphred/cli` | CLI entry point |
| `@alphred/dashboard` | Next.js monitoring dashboard |

Architecture notes for Agent Runtime v1 (DI + adapters):
- `DESIGN.md` (runtime wiring, boundaries, failure semantics)
- `packages/agents/README.md` (registry APIs, adapter usage)
- `packages/agents/docs/claude-runtime-runbook.md` (Claude runtime setup, limits, error taxonomy, troubleshooting)
- `packages/agents/docs/codex-runtime-runbook.md` (Codex runtime setup, limits, error taxonomy, troubleshooting)
- `packages/core/README.md` (SQL workflow executor routing directive and no-route semantics)
- `packages/agents/AGENTS.md` and `packages/core/AGENTS.md` (directory-specific AI guidance)

## Prerequisites

- Node.js 22+
- pnpm 10+
- `gh` CLI (for GitHub integration)
- `az` CLI (for Azure DevOps integration)

## Getting Started

```bash
pnpm install
pnpm build
pnpm test
```

## Development

```bash
# Type checking
pnpm typecheck
pnpm typecheck:test

# Linting
pnpm lint

# Run tests
pnpm test

# Dashboard dev server (Next.js on port 8080)
pnpm dev:dashboard
```

## CLI Commands

Current CLI command contract:

```bash
alphred run --tree <tree_key>
alphred status --run <run_id>
alphred list
```

Notes:
- `alphred list` is not implemented yet and exits with code `4`.
- Set `ALPHRED_DB_PATH` to override the database path; relative paths resolve from the current working directory.

Exit codes:
- `0`: success
- `2`: usage/input error
- `3`: requested tree/run not found
- `4`: runtime failure

## Dashboard Fallback UX

The dashboard uses App Router fallback states to keep route transitions and failures explicit:

- **Loading state**: route-level loads display `Loading dashboard` with the message `Preparing workflow run data...`.
- **Error state**: route failures display `Dashboard error` and provide a `Try again` button that calls the route error boundary `reset()` callback.
- **Not found state**: unmatched routes display `Page not found` with a `Return to home` link back to `/`.

## Dashboard E2E Tests

Run dashboard e2e tests with Playwright:

```bash
pnpm test:e2e
```

Run individual suites:

```bash
pnpm test:e2e:no-test-routes
pnpm test:e2e:build-gate
```

If Playwright browsers are not installed yet:

```bash
pnpm exec playwright install chromium
```

Notes:
- `pnpm test:e2e` runs three suites on ports `18080`, `18081`, and `18082`.
- The runner uses `ALPHRED_DASHBOARD_TEST_ROUTES_BUILD` as a build-baked gate and `ALPHRED_DASHBOARD_TEST_ROUTES` as a runtime gate for `/test/*` routes.
- When `/test/*` is gated off, the dashboard proxy returns a hard `404` HTML response with `x-robots-tag: noindex` for those paths.
- A dedicated regression suite verifies runtime env overrides cannot enable `/test/*` when the build gate is off.
- If an e2e run is interrupted, a stale build lock directory can block the next run; increase the timeout via `ALPHRED_E2E_BUILD_LOCK_TIMEOUT_MS` (default `180000`) or remove `apps/dashboard/.e2e-build-lock`.

## How It Works

1. **Workflows** define a sequence of phases, each with an agent provider, prompt, and transitions
2. **Runs** execute a workflow instance in an isolated git worktree
3. **Phases** spawn fresh agent sessions - no conversation carry-over between phases
4. **Transitions** are evaluated after each phase completes, using guard expressions
5. **Retries** automatically re-run failed phases up to a configured limit
6. **Reports** from each phase are stored in SQLite and loaded as context for subsequent phases
