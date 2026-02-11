# CLAUDE.md - Alphred Project Guide

## Project Structure

This is a pnpm monorepo with TypeScript (strict, NodeNext modules).

Packages:
- `packages/shared` - Shared types (@alphred/shared)
- `packages/db` - Database layer with Drizzle ORM + SQLite (@alphred/db)
- `packages/core` - Workflow engine, state machine, guards (@alphred/core)
- `packages/agents` - Agent provider abstraction (@alphred/agents)
- `packages/git` - Git worktree and issue tracker integration (@alphred/git)
- `packages/cli` - CLI entry point (@alphred/cli)
- `apps/dashboard` - Next.js monitoring UI (@alphred/dashboard)

## Commands

```bash
pnpm install          # Install dependencies
pnpm build            # Build all packages (tsc -b)
pnpm typecheck        # Type check all packages
pnpm typecheck:test   # Type check test TS configs
pnpm lint             # ESLint with zero warnings
pnpm test             # Run all tests with vitest
pnpm test:e2e         # Run all dashboard e2e suites (Playwright)
pnpm test:e2e:no-test-routes  # Run dashboard e2e tests with /test/* routes disabled
pnpm test:e2e:build-gate  # Verify runtime env cannot bypass build-time /test/* gate
pnpm dev:dashboard    # Start dashboard dev server on port 8080
```

If e2e lock acquisition times out, raise `ALPHRED_E2E_BUILD_LOCK_TIMEOUT_MS` or remove `apps/dashboard/.e2e-build-lock`.

## Conventions

- Core packages use ESM (`"type": "module"`)
- Imports must include `.js` extension (NodeNext resolution)
- Use `type` keyword for type-only imports/exports
- Tests must run in clean checkouts without prebuilt `packages/*/dist`; avoid new runtime workspace imports that require built artifacts, or add explicit Vitest source aliasing.
- Tests are co-located with source files (`*.test.ts`)
- Next.js App Router tests are co-located in `app/` (`*.test.tsx`)
- UI tests should verify behavior and accessibility semantics over styling details
- Database uses Drizzle ORM with better-sqlite3
- State machine transitions are validated - invalid transitions throw
- Each agent phase gets a fresh session (no conversation carry-over)
- Guard expressions support dotted paths and logical operators

## Key Design Decisions

- **Fresh agent contexts**: Each phase spawns a new agent session. Prior phase reports are loaded from DB and injected as prompt context.
- **Guard-based transitions**: Phase transitions use a priority-sorted guard system. Auto transitions fire unconditionally; guarded transitions evaluate expressions against phase report data.
- **Isolated worktrees**: Each run operates in its own git worktree for sandboxing.
