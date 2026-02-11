# @alphred/agents

Provider abstraction layer for Alphred agent integrations.

## Registry APIs

The package exports a default provider registry and resolver for core wiring:

- `defaultAgentProviderRegistry`
- `resolveAgentProvider(providerName)`
- `createAgentProviderResolver(registry)`
- `UnknownAgentProviderError`

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
