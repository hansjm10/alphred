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

## Event + Failure Contract

- Adapters emit shared `ProviderEvent` values with types:
  `system`, `assistant`, `result`, `tool_use`, `tool_result`, `usage`.
- Unknown provider names throw `UnknownAgentProviderError` with deterministic
  `availableProviders` ordering.
- Adapter runs fail deterministically when:
  - options are invalid
  - an unsupported event type is emitted
  - events are emitted after `result`
  - no `result` event is emitted

## Add a Provider Checklist

1. Add provider name to `AgentProviderName` in `@alphred/shared`.
2. Implement provider in `src/providers` using adapter core helpers.
3. Register provider in `defaultAgentProviderRegistry`.
4. Add/extend tests:
   - `src/registry.test.ts`
   - provider adapter tests
   - `packages/core/src/phaseRunner.test.ts` coverage for propagation semantics
5. Update docs in `DESIGN.md` and this README.
