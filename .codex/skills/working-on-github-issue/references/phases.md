# Phase Definitions

All XML artifacts in this workflow must be valid single-root XML blocks. Use repeated child elements for lists rather than Markdown bullets.

## Phase 0: Pull Live Issue State

**Goal**: Resolve the issue, collect current GitHub context, and decide whether implementation should start.

**Output**:
```xml
<issue_context>
  <issue_ref>owner/repo#123</issue_ref>
  <issue_url>https://github.com/owner/repo/issues/123</issue_url>
  <title>Concise issue title</title>
  <state>OPEN</state>
  <labels>
    <label>bug</label>
    <label>dashboard</label>
  </labels>
  <blocking_signals />
  <relationship_assessment>single-pr-candidate</relationship_assessment>
  <opened_resources>
    <resource>issue body</resource>
    <resource>issue comments</resource>
  </opened_resources>
  <workability_verdict>WORKABLE</workability_verdict>
</issue_context>
```

Allowed `workability_verdict` values:

- `WORKABLE`
- `BLOCKED`
- `DUPLICATE`
- `CLOSED`
- `SPLIT_REQUIRED`
- `AMBIGUOUS`

## Phase 1A: Extract Requirements

**Goal**: Convert the issue into explicit requirements and validation targets.

**Output**:
```xml
<requirements_pack>
  <problem_statement basis="issue-read" source="issue_body">What is wrong or missing today.</problem_statement>
  <desired_outcomes>
    <outcome id="O1" basis="issue-read" source="issue_body">What should be true when the work lands.</outcome>
  </desired_outcomes>
  <acceptance_criteria>
    <criterion id="AC1" basis="issue-read" source="issue_body">Concrete behavior the implementation must satisfy.</criterion>
    <criterion id="AC2" basis="issue-read" source="issue_comment:2026-03-06T12:00:00Z">Clarified behavior from a comment.</criterion>
  </acceptance_criteria>
  <constraints>
    <constraint basis="issue-read" source="issue_body">Known technical or process constraint.</constraint>
  </constraints>
  <non_goals>
    <item basis="issue-read" source="issue_body">Explicitly out of scope.</item>
  </non_goals>
  <dependencies>
    <dependency basis="issue-read" source="issue_body">Upstream issue, API, or prerequisite.</dependency>
  </dependencies>
  <ambiguities>
    <item basis="issue-read" source="issue_comment:2026-03-06T12:00:00Z">Question that still needs clarification.</item>
  </ambiguities>
  <validation_surfaces>
    <surface>CLI behavior</surface>
    <surface>package API behavior</surface>
  </validation_surfaces>
</requirements_pack>
```

If extraction fails because the issue cannot be used as a source of truth:

```xml
<requirements_pack>
  <error>Requirements could not be extracted from the issue.</error>
</requirements_pack>
```

## Phase 1B: Research the Codebase

**Goal**: Build local implementation and testing context before planning.

**Output**:
```xml
<research_pack>
  <repo_instructions>
    <instruction source="packages/core/AGENTS.md">Package-local guidance that affects the work.</instruction>
  </repo_instructions>
  <current_behavior>
    <observation basis="code-read" citation="packages/core/src/foo.ts:10-42">Observed current behavior and its boundary.</observation>
  </current_behavior>
  <relevant_files>
    <file path="packages/core/src/foo.ts" role="implementation">Likely production touchpoint.</file>
    <file path="packages/core/src/foo.test.ts" role="test">Existing test to extend.</file>
  </relevant_files>
  <blast_radius>
    <dependency path="packages/shared/src/types.ts" relationship="contract">Shared type affected by the change.</dependency>
    <dependency path="packages/cli/src/index.ts" relationship="consumer">Caller or downstream surface.</dependency>
  </blast_radius>
  <verification_commands>
    <command>pnpm test --filter @alphred/core</command>
    <command>pnpm typecheck</command>
  </verification_commands>
</research_pack>
```

## Phase 2: Draft the Plan

**Goal**: Produce a reviewable implementation plan grounded in requirements and research.

**Output**:
```xml
<draft_plan>
  <outcome>High-level intended outcome for the issue.</outcome>
  <scope_summary>What will change and what will stay out of scope.</scope_summary>
  <touched_modules>
    <module path="packages/core/src/foo.ts">Why this module is involved.</module>
    <module path="packages/core/src/foo.test.ts">Why this test file is involved.</module>
  </touched_modules>
  <implementation_steps>
    <step id="1">
      <title>Short step title</title>
      <goal>One observable behavior change or protection.</goal>
      <acceptance_criteria_refs>
        <criterion_ref>AC1</criterion_ref>
      </acceptance_criteria_refs>
      <planned_touchpoints>
        <file path="packages/core/src/foo.ts" />
        <file path="packages/core/src/foo.test.ts" />
      </planned_touchpoints>
    </step>
  </implementation_steps>
  <test_strategy>
    <behavior id="B1">
      <step_ref>1</step_ref>
      <boundary>Exported workflow API</boundary>
      <proof>Test or deterministic reproduction that proves the behavior.</proof>
    </behavior>
  </test_strategy>
  <risks>
    <risk severity="medium">Main implementation or regression risk.</risk>
  </risks>
  <non_goals>
    <item>Explicitly excluded work.</item>
  </non_goals>
  <single_pr_assessment>REVIEWABLE</single_pr_assessment>
  <reviewability_rationale>Why this still fits into one clean PR.</reviewability_rationale>
</draft_plan>
```

Allowed `single_pr_assessment` values:

- `REVIEWABLE`
- `SPLIT_REQUIRED`

## Phase 3: Review the Plan

**Goal**: Audit the plan before implementation begins.

**Output**:
```xml
<plan_review>
  <review_summary basis="review-read">Short summary of overall plan quality.</review_summary>
  <acceptance_coverage>
    <coverage criterion_ref="AC1">
      <status>COVERED</status>
      <notes basis="review-read">Mapped to step 1.</notes>
    </coverage>
  </acceptance_coverage>
  <sequencing_findings>
    <finding severity="medium" basis="review-read">Sequencing issue or confirmation.</finding>
  </sequencing_findings>
  <test_strategy_findings>
    <finding severity="high" basis="review-read">Weak behavioral proof or missing boundary.</finding>
  </test_strategy_findings>
  <scope_findings>
    <finding severity="medium" basis="review-read">Possible overscope or missing cleanup.</finding>
  </scope_findings>
  <required_edits>
    <edit id="1">Specific change required before coding starts.</edit>
  </required_edits>
  <optional_improvements>
    <item>Non-blocking improvement.</item>
  </optional_improvements>
  <split_recommendation>NO_SPLIT</split_recommendation>
  <approval_status>APPROVE_PLAN</approval_status>
</plan_review>
```

Allowed `status` values inside `<coverage>`:

- `COVERED`
- `PARTIAL`
- `MISSING`

Allowed `split_recommendation` values:

- `NO_SPLIT`
- `SPLIT_RECOMMENDED`
- `SPLIT_REQUIRED`

Allowed `approval_status` values:

- `APPROVE_PLAN`
- `REVISE_PLAN`
- `SPLIT_ISSUE`

## Phase 4: Finalize the Execution Plan

**Goal**: Turn the approved plan into explicit implementation steps and branch naming.

**Output**:
```xml
<execution_plan>
  <branch_plan>
    <branch_type>fix</branch_type>
    <branch_name>fix/issue-123-short-description</branch_name>
  </branch_plan>
  <ordered_steps>
    <step id="1">
      <title>Short step title</title>
      <goal>One observable behavior change or protection.</goal>
      <behavior_change>What the user or system will observe after this step.</behavior_change>
      <first_failing_proof>Test or deterministic repro to write first.</first_failing_proof>
      <target_tests>
        <test path="packages/core/src/foo.test.ts">Behavioral test to add or change.</test>
      </target_tests>
      <expected_touchpoints>
        <file path="packages/core/src/foo.ts" />
        <file path="packages/core/src/foo.test.ts" />
      </expected_touchpoints>
      <step_verification>
        <command>pnpm test --filter @alphred/core</command>
      </step_verification>
      <review_focus>What the post-step review should scrutinize.</review_focus>
    </step>
  </ordered_steps>
</execution_plan>
```

## Phase 5A: Execute a Step

**Goal**: Record red-phase, green-phase, and refactor evidence for one execution step.

**Output**:
```xml
<step_execution step="1">
  <goal_ref>Execution step 1</goal_ref>
  <red_phase>
    <test_or_repro>Behavioral proof written before the production change.</test_or_repro>
    <result basis="tests-run">FAILS_AS_EXPECTED</result>
    <failure_reason>The failure proves the missing or incorrect behavior.</failure_reason>
  </red_phase>
  <green_phase>
    <implementation_summary basis="code-read">Minimal production change made.</implementation_summary>
    <verification>
      <command>pnpm test --filter @alphred/core</command>
      <result basis="tests-run">PASSED</result>
    </verification>
  </green_phase>
  <refactor_phase>
    <changes basis="code-read">Cleanup performed while preserving behavior.</changes>
    <safety_checks>
      <check basis="tests-run">Targeted test suite rerun after refactor.</check>
    </safety_checks>
  </refactor_phase>
  <files_touched>
    <file path="packages/core/src/foo.ts">Production change.</file>
    <file path="packages/core/src/foo.test.ts">Behavioral proof.</file>
  </files_touched>
  <step_status>READY_FOR_REVIEW</step_status>
</step_execution>
```

Allowed `result` values:

- `FAILS_AS_EXPECTED`
- `FAILED_FOR_UNRELATED_REASON`
- `PASSED`

Allowed `step_status` values:

- `READY_FOR_REVIEW`
- `BLOCKED`

## Phase 5B: Review a Step

**Goal**: Decide whether the current step is correct and scoped well enough to proceed.

**Output**:
```xml
<step_review step="1">
  <goal_ref>Execution step 1</goal_ref>
  <review_summary basis="review-read">Short summary of the step review.</review_summary>
  <correctness_findings>
    <finding severity="high" basis="review-read">Behavioral correctness issue or confirmation.</finding>
  </correctness_findings>
  <scope_findings>
    <finding severity="medium" basis="review-read">Scope creep, missing cleanup, or sequencing impact.</finding>
  </scope_findings>
  <test_findings>
    <finding severity="medium" basis="review-read">Coverage gap or strength of the proof.</finding>
  </test_findings>
  <required_fixes>
    <fix id="1">Blocking fix before the next step.</fix>
  </required_fixes>
  <follow_ups>
    <item>Non-blocking note or deferred follow-up.</item>
  </follow_ups>
  <step_status>APPROVED</step_status>
</step_review>
```

Allowed `step_status` values:

- `APPROVED`
- `REVISE_STEP`

## Phase 6: Delivery Review

**Goal**: Confirm the branch is coherent, verified, and ready for packaging.

**Output**:
```xml
<delivery_review>
  <delivered_behavior>
    <item criterion_ref="AC1">Delivered behavior mapped back to the issue.</item>
  </delivered_behavior>
  <verification_results>
    <result basis="tests-run">
      <command>pnpm lint</command>
      <status>PASSED</status>
    </result>
    <result basis="tests-run">
      <command>pnpm test</command>
      <status>PASSED</status>
    </result>
  </verification_results>
  <cleanup_check>
    <stale_code_removed>yes</stale_code_removed>
    <stale_tests_removed>yes</stale_tests_removed>
    <notes>Any remaining cleanup note.</notes>
  </cleanup_check>
  <residual_risks>
    <risk basis="code-read">Known remaining risk or empty element if none.</risk>
  </residual_risks>
  <follow_ups>
    <item>Explicit follow-up work outside this PR.</item>
  </follow_ups>
  <pr_readiness>READY</pr_readiness>
</delivery_review>
```

Allowed `status` values inside `<verification_results>`:

- `PASSED`
- `FAILED`
- `SKIPPED`

Allowed `pr_readiness` values:

- `READY`
- `BLOCKED`

## Phase 7: Package the PR

**Goal**: Record the exact branch, commit, validation summary, and PR creation result.

**Output**:
```xml
<pr_package>
  <branch_name>fix/issue-123-short-description</branch_name>
  <commit_sha>abcdef1234567890</commit_sha>
  <pr_title>fix(core): concise summary</pr_title>
  <issue_linkage>Fixes #123</issue_linkage>
  <testing_summary>
    <command status="PASSED">pnpm lint</command>
    <command status="PASSED">pnpm test</command>
  </testing_summary>
  <pr_status>CREATED</pr_status>
  <pr_url>https://github.com/owner/repo/pull/456</pr_url>
</pr_package>
```

If PR creation is skipped:

```xml
<pr_package>
  <branch_name>fix/issue-123-short-description</branch_name>
  <commit_sha>abcdef1234567890</commit_sha>
  <pr_status>SKIPPED</pr_status>
</pr_package>
```

If PR creation fails:

```xml
<pr_package>
  <branch_name>fix/issue-123-short-description</branch_name>
  <commit_sha>abcdef1234567890</commit_sha>
  <pr_status>FAILED</pr_status>
  <error>gh pr create returned a non-zero exit status.</error>
</pr_package>
```

Allowed `pr_status` values:

- `CREATED`
- `SKIPPED`
- `FAILED`

## Phase 8: Final Summary

**Goal**: Produce a short XML summary that can be converted into the final human response.

**Output**:
```xml
<delivery_summary>
  <behavior_delivered>One-paragraph summary of what changed.</behavior_delivered>
  <validations_run>
    <validation>pnpm lint</validation>
    <validation>pnpm test</validation>
  </validations_run>
  <pr_status_ref>CREATED</pr_status_ref>
  <pr_url>https://github.com/owner/repo/pull/456</pr_url>
  <residual_risks>
    <risk>Short note on remaining risk or follow-up.</risk>
  </residual_risks>
</delivery_summary>
```
