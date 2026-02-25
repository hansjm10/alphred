# Issue #163 Design: Run Detail Section Jump Navigation

## Issue Reference
- Repository issue: https://github.com/hansjm10/alphred/issues/163
- Title: Add section jump navigation for long run detail pages
- State: Open (`enhancement`)
- Opened: 2026-02-24
- Comments: none

## Problem Statement
The run detail route (`/runs/[runId]`) is long enough that operators must scroll through multiple stacked sections to reach the target area. This increases time-to-orient, especially on mobile where key controls sit above Timeline, Agent stream, and Observability.

## Logical Requirements Extracted From The Issue

### Functional Requirements (Must)
1. Provide a persistent in-page section navigation on run detail pages.
2. Operators can jump directly to each major section from that navigation.
3. Navigation works across desktop and mobile breakpoints.
4. Jump behavior is smooth (CSS `scroll-behavior` or equivalent implementation).
5. Existing accessibility flow is preserved, especially the shell-level `Skip to main content` link and landmark structure.

### Functional Requirement (Nice to Have)
1. Active section should be visually indicated while scrolling (scroll-spy behavior).

### Inferred Scope Boundaries
1. Scope is limited to `/runs/[runId]` UI and its tests/styles.
2. No backend/API contract changes are required.
3. No workflow execution behavior changes are required.

## Current Implementation Baseline
`RunDetailContent` currently renders these vertical blocks in order:
1. Page heading (`Run #<id>`)
2. Priority grid: Operator focus card + Run summary panel
3. Lifecycle grid: Timeline card + Node status panel
4. Agent stream card
5. Observability card

Relevant files:
- `apps/dashboard/app/runs/[runId]/run-detail-content.tsx`
- `apps/dashboard/app/globals.css`
- `apps/dashboard/app/runs/[runId]/run-detail-content.test.tsx`

## Proposed Design

### UX Structure
Add a sticky section jump navigation directly below the run page heading.

Planned labels and targets:
- `Focus` -> operator focus section
- `Timeline` -> lifecycle section (timeline + node status)
- `Stream` -> agent stream section
- `Observability` -> observability section

Behavior:
- Clicking a label scrolls to the target section and updates URL hash.
- Current section is highlighted in the nav (`aria-current="location"` on active link).
- Mobile uses horizontal overflow for pills; desktop keeps inline pills.

### Markup and Component Changes
In `run-detail-content.tsx`:
1. Add a section metadata constant for IDs and labels.
2. Add a compact `RunDetailSectionNav` block rendered after `.page-heading`.
3. Add stable anchor IDs to each target section container.
4. Add active-section state and observer wiring for scroll-spy.

Target IDs:
- `run-section-focus`
- `run-section-timeline`
- `run-section-stream`
- `run-section-observability`

### Scroll-Spy Strategy
Use `IntersectionObserver` to track visible section targets.

Algorithm:
1. Observe the four section targets.
2. Consider entries active when intersecting with a top-biased root margin.
3. Pick the active section by greatest intersection ratio; use DOM order as tie-breaker.
4. Fallback to first section if no target is intersecting.

Notes:
- This stays client-side and lightweight.
- If `IntersectionObserver` is unavailable, links still work as anchors; active state can default to hash or first section.

### Smooth Scroll and Sticky Offsets
1. Keep anchor links for default browser behavior.
2. Enable smooth jump behavior through CSS (`scroll-behavior: smooth`) or equivalent click handler with `scrollIntoView`.
3. Respect reduced motion (`prefers-reduced-motion: reduce` -> non-smooth behavior).
4. Apply `scroll-margin-top` to section targets so sticky shell chrome does not cover headings after jump.

### Accessibility and Semantics
1. Navigation uses a semantic `<nav aria-label="Run detail sections">`.
2. Links remain real anchors (`href="#..."`) for keyboard and no-JS support.
3. Preserve existing main landmark (`#main-content`) and skip link behavior.
4. Active link uses `aria-current="location"` for assistive tech.
5. No landmark role changes to existing cards/panels.

## CSS Plan
In `apps/dashboard/app/globals.css`, add styles for:
1. `.run-section-nav` container (sticky, subtle surface, border, spacing).
2. `.run-section-nav__list` and `.run-section-nav__link` (pill links).
3. `.run-section-nav__link--active` visual state.
4. `.run-section-anchor` with `scroll-margin-top`.
5. Mobile rule for horizontal scroll + touch-friendly min-height.
6. Reduced-motion override.

## Testing Plan

### Unit/Component Tests
Update `apps/dashboard/app/runs/[runId]/run-detail-content.test.tsx`:
1. Renders jump nav with expected links (`Focus`, `Timeline`, `Stream`, `Observability`).
2. Links point to expected anchor IDs.
3. Target sections include matching IDs.
4. Active section styling/`aria-current` updates when observer signals visibility changes (mock `IntersectionObserver`).

### E2E Coverage
Add/extend a Playwright spec in `apps/dashboard/e2e`:
1. Desktop: jump link scrolls to target and target heading is visible.
2. Mobile viewport: nav remains usable via horizontal scrolling and links still jump correctly.
3. Skip link still moves focus to `#main-content`.

## Risks and Mitigations
1. Sticky offset mismatch with shell topbar height can obscure headings.
- Mitigation: tune `scroll-margin-top` and sticky `top` with breakpoint-specific values; validate on desktop/mobile.
2. Scroll-spy flicker near section boundaries.
- Mitigation: use stable observer thresholds and deterministic tie-break logic.
3. Realtime updates changing card heights may cause active-section churn.
- Mitigation: hysteresis via root margin/threshold selection and deterministic fallback.

## Implementation Task Breakdown
1. Add section anchor model and jump nav in `RunDetailContent`.
2. Add scroll-spy state and observer lifecycle.
3. Add section anchor IDs and active link semantics.
4. Add CSS for sticky nav, pills, and anchor offsets.
5. Add/adjust unit tests for links, anchors, and active behavior.
6. Add/adjust e2e checks for desktop/mobile and skip-link compatibility.

## Acceptance Criteria Mapping
1. Persistent jump nav: satisfied by sticky `RunDetailSectionNav`.
2. Jump to major sections: satisfied by anchor links + target IDs.
3. Active section indication: satisfied by observer-driven active pill state.
4. Desktop/mobile support: satisfied by responsive nav styles and e2e validation.
5. Smooth scroll behavior: satisfied via CSS/scroll behavior implementation.
6. Skip-link/landmark compatibility: satisfied by preserving shell structure and adding compatibility tests.
