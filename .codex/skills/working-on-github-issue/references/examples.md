# Examples and Prompting Patterns

Use these examples to keep the issue workflow structured and evidence-bound.

## XML Structure

Bad:

```xml
<plan_review>
  - step 1 looks fine
  - maybe add a test
</plan_review>
```

Good:

```xml
<plan_review>
  <review_summary basis="review-read">The plan is close but misses a behavioral proof for AC2.</review_summary>
  <required_edits>
    <edit id="1">Add a public-boundary test for AC2 before implementation starts.</edit>
  </required_edits>
  <approval_status>REVISE_PLAN</approval_status>
</plan_review>
```

## Requirements Mapping

Good:

```xml
<acceptance_criteria>
  <criterion id="AC1" basis="issue-read" source="issue_body">Reject invalid guard expressions with a clear CLI error.</criterion>
  <criterion id="AC2" basis="issue-read" source="issue_comment:2026-03-06T12:00:00Z">Preserve valid dotted-path expressions.</criterion>
</acceptance_criteria>
```

Carry those IDs forward into the plan and delivery review.

## Behavior-First TDD Evidence

Bad:

```xml
<step_execution step="1">
  <green_phase>
    <implementation_summary>Implemented the fix and tests pass.</implementation_summary>
  </green_phase>
</step_execution>
```

Good:

```xml
<step_execution step="1">
  <red_phase>
    <test_or_repro>Add a CLI test that submits an invalid guard expression.</test_or_repro>
    <result basis="tests-run">FAILS_AS_EXPECTED</result>
    <failure_reason>The command currently exits 0 and accepts the invalid expression.</failure_reason>
  </red_phase>
  <green_phase>
    <implementation_summary basis="code-read">Validate the expression before workflow execution and surface a CLI error.</implementation_summary>
    <verification>
      <command>pnpm test --filter @alphred/cli</command>
      <result basis="tests-run">PASSED</result>
    </verification>
  </green_phase>
  <step_status>READY_FOR_REVIEW</step_status>
</step_execution>
```

## Step Review Gate

Good:

```xml
<step_review step="1">
  <review_summary basis="review-read">The step fixes AC1, but it also changes shared parser behavior without coverage.</review_summary>
  <required_fixes>
    <fix id="1">Add or update a parser-level test to prove valid dotted-path expressions still work.</fix>
  </required_fixes>
  <step_status>REVISE_STEP</step_status>
</step_review>
```

Do not start the next step until required fixes are resolved.

## Delivery Review Evidence

Good:

```xml
<delivery_review>
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
  <pr_readiness>READY</pr_readiness>
</delivery_review>
```

Bad:

```xml
<delivery_review>
  <verification_results>Everything passes.</verification_results>
</delivery_review>
```

## Review Language

- Prefer “covers AC1 via step 1” over “fully handles the issue” unless every acceptance criterion is explicitly mapped.
- Prefer “tests assert expected behavior” unless the tests actually ran.
- Prefer “remove obsolete path” over “keep backward compatibility” unless the issue explicitly requires compatibility.
- Prefer specific blockers and edits over vague suggestions like “tighten this up”.
