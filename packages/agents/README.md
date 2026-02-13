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
- Auth precedence is deterministic:
  1. `CLAUDE_API_KEY`
  2. `ANTHROPIC_API_KEY`
- `CLAUDE_AUTH_MODE=cli_session` fails fast with a typed config error because CLI-session auth is not supported in this runtime path.
- Endpoint override uses `CLAUDE_BASE_URL` when set, otherwise `ANTHROPIC_BASE_URL`; both are validated as `http`/`https` URLs.
- Model default uses `CLAUDE_MODEL` when set, otherwise `claude-3-7-sonnet-latest`.

### Codex SDK bootstrap

- `CodexProvider` validates runtime configuration before stream execution.
- Auth precedence is deterministic:
  1. `CODEX_API_KEY`
  2. `OPENAI_API_KEY`
  3. existing Codex CLI login session (`codex login status`)
- Endpoint override (`OPENAI_BASE_URL`) is validated when set.
- Model default uses `CODEX_MODEL` when set, otherwise `gpt-5-codex`.
- `timeout` is enforced through `AbortSignal.timeout(timeout)`.
- `maxTokens` is validated by provider options but is not currently forwarded to the Codex SDK turn call.

## Add a Provider Checklist

1. Add provider name to `AgentProviderName` in `@alphred/shared`.
2. Implement provider in `src/providers` using adapter core helpers.
3. Register provider in `defaultAgentProviderRegistry`.
4. Add/extend tests:
   - `src/registry.test.ts`
   - provider adapter tests
   - `packages/core/src/phaseRunner.test.ts` coverage for propagation semantics
5. Update docs in `DESIGN.md` and this README.
