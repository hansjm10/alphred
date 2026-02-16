# @alphred/agents

Provider abstraction layer for Alphred agent integrations.

## Registry APIs

The package exports a default provider registry and resolver for core wiring:

- `defaultAgentProviderRegistry`
- `resolveAgentProvider(providerName)`
- `createAgentProviderResolver(registry)`
- `UnknownAgentProviderError`

Resolver lookups use only own registry keys. Inherited names such as `toString`,
`constructor`, and `__proto__` are treated as unknown providers and throw
`UnknownAgentProviderError`.

### Default registry usage

```ts
import { resolveAgentProvider, UnknownAgentProviderError } from '@alphred/agents';

try {
  const provider = resolveAgentProvider('claude');
  // provider.run(...)
} catch (error) {
  if (error instanceof UnknownAgentProviderError) {
    console.error(error.code); // UNKNOWN_AGENT_PROVIDER
    console.error(error.availableProviders);
  }
  throw error;
}
```

### Custom registry usage

```ts
import {
  createAgentProviderResolver,
  ClaudeProvider,
  CodexProvider,
} from '@alphred/agents';

const resolveProvider = createAgentProviderResolver({
  claude: new ClaudeProvider(),
  codex: new CodexProvider(),
});

const provider = resolveProvider('codex');
```

## Runtime Boundary

- `@alphred/core` receives provider resolution through dependency injection (`resolveProvider`).
- `@alphred/agents` owns provider registry construction and adapter implementations.
- Core must not import provider SDK/client code directly.

## Claude Runtime Runbook

- Full setup + operations guide: `packages/agents/docs/claude-runtime-runbook.md`
- Use this runbook for:
  - local runtime setup
  - CI runtime setup
  - auth/config troubleshooting
  - stream/failure troubleshooting

## Codex Runtime Runbook

- Full setup + operations guide: `packages/agents/docs/codex-runtime-runbook.md`
- Use this runbook for:
  - local runtime setup
  - CI runtime setup
  - auth/config troubleshooting
  - stream/failure troubleshooting

## Event + Failure Contract

- Adapters emit shared `ProviderEvent` values with types:
  `system`, `assistant`, `result`, `tool_use`, `tool_result`, `usage`.
- Providers can emit structured routing metadata on terminal results via
  `result.metadata.routingDecision` (`approved`, `changes_requested`, `blocked`, `retry`).
- Canonical provider output contract for guarded routing is:
  - key: `result.metadata.routingDecision`
  - value: one of `approved`, `changes_requested`, `blocked`, `retry`
- Compatibility parsing may accept legacy key variants (for example,
  `routing_decision`) as input, but providers should emit canonical
  `routingDecision`.
- If both keys are present, providers prefer canonical `routingDecision` when it
  contains a supported signal; legacy `routing_decision` is used only as
  fallback when canonical metadata is missing or invalid.
- Unsupported routing metadata values are not emitted on terminal `result`
  events.
- Providers that are used by guarded workflow routes should emit terminal
  `result.metadata.routingDecision`; legacy report text is not used by core routing.
- Unknown provider names throw `UnknownAgentProviderError` with deterministic
  `availableProviders` ordering.
- Adapter runs fail deterministically when:
  - claude runtime auth/config bootstrap is invalid or missing
  - codex runtime auth/config bootstrap is invalid or missing
  - options are invalid
  - an unsupported event type is emitted
  - events are emitted after `result`
  - no `result` event is emitted

### Claude SDK bootstrap

- `ClaudeProvider` validates runtime configuration before stream execution.
- `ClaudeProvider` default runtime path uses the Claude Agent SDK stream (`query(...)`) rather than the adapter stub runner.
- `timeout` is bridged into SDK cancellation via `abortController`.
- SDK stream message mapping into shared provider events:
  - `assistant` text blocks -> `assistant`
  - assistant `tool_use` blocks and `tool_progress` -> `tool_use` (first-seen `tool_use_id` is emitted; duplicates are dropped)
  - assistant `tool_result` blocks, `user.tool_use_result`, and `tool_use_summary` -> `tool_result`
  - unsupported assistant content block types fail with typed `CLAUDE_INVALID_EVENT`
  - `result` success -> `usage` then terminal `result`
  - unsupported message types fail with typed `CLAUDE_INVALID_EVENT`
- Failure classification precedence is deterministic: auth (401/403/auth text) -> rate limit (429/quota/throttle text) -> timeout (408/504/timeout text) -> transport (network/socket codes/text) -> internal.
- Auth precedence is deterministic:
  1. `CLAUDE_API_KEY`
  2. `ANTHROPIC_API_KEY`
- `CLAUDE_AUTH_MODE=cli_session` fails fast with a typed config error because CLI-session auth is not supported in this runtime path.
- Endpoint override uses `CLAUDE_BASE_URL` when set, otherwise `ANTHROPIC_BASE_URL`; both are validated as `http`/`https` URLs.
- Model default uses `CLAUDE_MODEL` when set, otherwise `claude-3-7-sonnet-latest`.

#### Claude live smoke test (local only)

- Live smoke test file: `packages/agents/src/providers/claude.live.integration.test.ts`.
- This test is skipped by default and in CI (`CI=true` or `GITHUB_ACTIONS=true`).
- To run locally:

```bash
CLAUDE_LIVE_SMOKE=1 pnpm vitest run packages/agents/src/providers/claude.live.integration.test.ts
```

- Auth path for this test uses an existing Claude CLI login session (it does not require exporting API keys).
- Model selection is injected by the test:
  - explicit override: pass CLI arg `--claude-live-model=<value>` (for example `sonnet`, `default`, `haiku`)
  - example: `CLAUDE_LIVE_SMOKE=1 pnpm vitest run packages/agents/src/providers/claude.live.integration.test.ts -- --claude-live-model=sonnet`
  - otherwise, the test queries SDK-supported models and picks the first available in this priority: `sonnet` -> `default` -> `haiku`

### Codex SDK bootstrap

- `CodexProvider` validates runtime configuration before stream execution.
- Auth precedence is deterministic:
  1. `CODEX_API_KEY`
  2. `OPENAI_API_KEY`
  3. existing Codex CLI login session (`codex login status`)
- Endpoint override (`OPENAI_BASE_URL`) is validated when set.
- Model default uses `CODEX_MODEL` when set, otherwise `gpt-5-codex`.
- `timeout` is enforced through `AbortSignal.timeout(timeout)`.

#### Codex live smoke test (optional)

- Live smoke test file: `packages/agents/src/providers/codex.live.integration.test.ts`.
- This test is skipped by default unless `CODEX_LIVE_SMOKE=1`.
- To run locally:

```bash
CODEX_LIVE_SMOKE=1 pnpm vitest run packages/agents/src/providers/codex.live.integration.test.ts
```

- Use this in credentialed environments only (for example local development with API key auth or an existing Codex CLI login session).
- This test is not part of the default CI workflow.
- Failure output is surfaced with deterministic provider diagnostics:
  - `code`
  - `details.classification`
  - `retryable`
  - `details.statusCode`
  - `details.failureCode`

## Add a Provider Checklist

1. Add provider name to `AgentProviderName` in `@alphred/shared`.
2. Implement provider in `src/providers` using adapter core helpers.
3. Register provider in `defaultAgentProviderRegistry`.
4. Add/extend tests:
   - `src/registry.test.ts`
   - provider adapter tests
   - `packages/core/src/phaseRunner.test.ts` coverage for propagation semantics
5. Update docs in `DESIGN.md` and this README.
