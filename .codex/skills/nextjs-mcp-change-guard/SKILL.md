---
name: nextjs-mcp-change-guard
description: Run a pre-merge safety check for Next.js frontend and server-logic changes using Next.js MCP plus Playwright MCP. Use when editing App Router UI files (page/layout/loading/error/not-found, components used by routes) or server-side logic (route handlers, server actions, data fetching, auth/cookies/headers) where regressions can introduce runtime, build, or browser-console errors.
allowed-tools: Read, Grep, Bash, mcp__next-devtools__init, mcp__next-devtools__nextjs_index, mcp__next-devtools__nextjs_call, mcp__playwright__browser_resize, mcp__playwright__browser_navigate, mcp__playwright__browser_snapshot, mcp__playwright__browser_console_messages, mcp__playwright__browser_take_screenshot, mcp__playwright__browser_close
---

# Next.js MCP Change Guard

## Overview

Run an evidence-based runtime gate after Next.js UI or server edits.
Always combine Next.js MCP (`init/index/call`) with live browser checks from Playwright before declaring changes safe.

**Route input:** `$ARGUMENTS` as comma-separated routes (example: `/,/runs,/settings/integrations`).

## Step 1: Initialize Runtime Context

1. Call `mcp__next-devtools__init` first. Use `project_path` when obvious (for Alphred dashboard: `/work/alphred/apps/dashboard`).
2. Call `mcp__next-devtools__nextjs_index`.
3. If no server is discovered, stop and report that the Next.js dev server must be started.
4. Select the active server port and call `mcp__next-devtools__nextjs_call` for:
- `get_project_metadata`
- `get_routes`
- `get_errors`
- `get_logs`
5. Record baseline runtime errors before route probing.

## Step 2: Build Probe Routes

Choose routes in this order:
1. Use `$ARGUMENTS` when provided.
2. If empty, derive likely impacted routes from changed files:
```bash
git diff --name-only | rg 'app/.*/(page|layout|loading|error|not-found)\.(ts|tsx)$|app/api/.*/route\.ts$|app/.*/actions?\.ts$'
```
3. Map common patterns:
- `app/page.tsx` -> `/`
- `app/**/page.tsx` -> route path from folder segments
- `app/**/(layout|loading|error|not-found).tsx` -> parent segment route
- `app/api/**/route.ts` -> `/api/...`
4. If still empty, default to `/`.

Prefer at least one UI route and one API route when server logic changed.

## Step 3: Execute Combined MCP + Browser Checks

1. Read `LOG_PATH` from `get_logs`.
2. Record `LOG_OFFSET_BEFORE`:
```bash
LOG_OFFSET_BEFORE="$(wc -c < "$LOG_PATH" 2>/dev/null || echo 0)"
```
3. For each UI route:
- Resize viewport to `1280x900`.
- Navigate with `mcp__playwright__browser_navigate`.
- Capture `mcp__playwright__browser_snapshot`.
- Capture `mcp__playwright__browser_console_messages` at `level: "error"`.
- While browser is open, call `get_errors` again via `nextjs_call`.
4. For each API route:
- Probe with curl and capture status code.
```bash
curl -sS -o /tmp/nextjs-change-guard-api.out -w "%{http_code}" "http://localhost:${PORT}${API_ROUTE}"
```
5. Capture current log delta:
```bash
tail -c "+$((LOG_OFFSET_BEFORE + 1))" "$LOG_PATH" > /tmp/nextjs-change-guard-log-delta.log 2>/dev/null || true
```
6. Close Playwright session at the end.

## Step 4: Verdict Rules

Set `BLOCKED` when any of these occur:
- `get_errors` reports active build/runtime errors.
- `get_errors` reports no connected browser session during the run.
- Any probed route returns HTTP `>= 500` or `000`.
- Browser console shows uncaught exceptions or hydration/runtime errors.
- Log delta includes new server errors tied to touched routes or shared app entrypoints.

Set `NEEDS_ATTENTION` when:
- No hard failures, but warnings or recoverable issues appear in logs/console.

Set `PASS` when:
- Runtime/build errors are clean, probed routes succeed, and console is clean.

## Report Format

Return:

```markdown
## Next.js Change Guard

### Scope
- Routes checked: {list}
- Trigger reason: {frontend edit | server logic edit | both}

### Runtime (Next.js MCP)
- Server: {url and port}
- Baseline errors: {none | summary}
- Post-check errors: {none | summary}

### Browser (Playwright)
- UI routes visited: {list}
- Console errors: {none | summary}
- Snapshot/screenshots: {captured | skipped (reason)}

### Server Evidence
- Log file: {path}
- New relevant log lines: {summary from delta only}

### Verdict
- Status: {PASS | NEEDS_ATTENTION | BLOCKED}
- Next step: {ship | fix issues and re-run}
```

Keep conclusions evidence-based and tied to this run only.

## Pairing Guidance

- Use this skill as the runtime quality gate after implementing frontend/server changes.
- If `PASS`, optionally run deeper UX audit with `$visual-check`.
- If `BLOCKED`, fix runtime/server errors first before visual polish.
