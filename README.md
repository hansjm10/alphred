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

# Linting
pnpm lint

# Run tests
pnpm test

# Dashboard dev server (Next.js on port 8080)
pnpm dev:dashboard
```

## Dashboard Fallback UX

The dashboard uses App Router fallback states to keep route transitions and failures explicit:

- **Loading state**: route-level loads display `Loading dashboard` with the message `Preparing workflow run data...`.
- **Error state**: route failures display `Dashboard error` and provide a `Try again` button that calls the route error boundary `reset()` callback.
- **Not found state**: unmatched routes display `Page not found` with a `Return to home` link back to `/`.

## How It Works

1. **Workflows** define a sequence of phases, each with an agent provider, prompt, and transitions
2. **Runs** execute a workflow instance in an isolated git worktree
3. **Phases** spawn fresh agent sessions - no conversation carry-over between phases
4. **Transitions** are evaluated after each phase completes, using guard expressions
5. **Retries** automatically re-run failed phases up to a configured limit
6. **Reports** from each phase are stored in SQLite and loaded as context for subsequent phases
