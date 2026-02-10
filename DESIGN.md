# Alphred Design Document

## Overview

Alphred is a phase-based LLM agent orchestrator. It executes multi-step workflows where each phase invokes an LLM agent (Claude or Codex) in a sandboxed git worktree.

## Workflow Model

A workflow is a directed graph of phases with conditional transitions:

```
[design] --(auto)--> [implement] --(needs_revision==true)--> [design]
                          |
                     (auto, lower priority)
                          v
                      [review]
```

### Phase Execution

Each phase:
1. Loads prior phase reports from the database as context
2. Creates a new agent session (no conversation carry-over)
3. Invokes the configured agent provider with the prompt + context
4. Collects streaming events and stores the final report
5. Evaluates transitions to determine the next phase

### State Machine

**Run states:**
- `pending` -> `running` -> `completed` | `failed` | `cancelled`
- `running` <-> `paused`

**Phase states:**
- `pending` -> `running` -> `completed` | `failed`
- `pending` -> `skipped`
- `failed` -> `running` (retry)

### Transition Evaluation

1. Transitions are sorted by priority (ascending)
2. `auto: true` transitions fire immediately (unconditional)
3. `when` guard expressions are evaluated against the phase report context
4. First matching transition wins
5. If no transition matches, the run completes

### Guard Expressions

Guards support:
- Dotted field paths: `report.quality.score`
- Comparison operators: `==`, `!=`, `>`, `<`, `>=`, `<=`
- Logical operators: `and`, `or` (nested)

### Retry Logic

- Phase fails -> check `retryCount < maxRetries`
- If retriable: transition phase back to `running`, create new agent session
- If exhausted: run transitions to `failed`

## Agent Abstraction

Both providers implement:

```typescript
interface AgentProvider {
  readonly name: string;
  run(prompt: string, options: ProviderRunOptions): AsyncIterable<ProviderEvent>;
}
```

Streamed event types: `system`, `assistant`, `result`, `tool_use`, `tool_result`, `usage`.

Each phase spawns a fresh agent session. Context from prior phases is injected via the prompt, not through conversation history.

## Database Schema

Eight SQLite tables managed via Drizzle ORM:

- `workflows` - Template definitions (JSON workflow spec)
- `runs` - Execution instances with status tracking
- `phases` - Individual phase records within a run
- `phase_reports` - Output artifacts from phase execution
- `agent_sessions` - Individual agent invocations with token/cost tracking
- `agent_events` - Streaming event log
- `run_logs` - Structured application logs
- `state_snapshots` - Persistent key-value state between phases

## Git Integration

Each run operates in an isolated git worktree:
1. Create worktree from the target branch
2. Agent operates within the worktree directory
3. On completion, create PR via `gh` or `az` CLI
4. Clean up worktree after PR creation
