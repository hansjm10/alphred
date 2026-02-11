import type { AgentProviderName } from '@alphred/shared';
import type { AgentProvider } from './provider.js';
import { ClaudeProvider } from './providers/claude.js';
import { CodexProvider } from './providers/codex.js';

export type AgentProviderRegistry<TName extends string = AgentProviderName> = Readonly<
  Record<TName, AgentProvider>
>;

export type AgentProviderResolver = (providerName: string) => AgentProvider;

export class UnknownAgentProviderError extends Error {
  readonly code = 'UNKNOWN_AGENT_PROVIDER';
  readonly providerName: string;
  readonly availableProviders: readonly string[];

  constructor(providerName: string, availableProviders: readonly string[]) {
    const sortedProviders = [...availableProviders].sort((a, b) => a.localeCompare(b));
    const providersText = sortedProviders.length > 0 ? sortedProviders.join(', ') : '(none)';
    super(`Unknown agent provider "${providerName}". Available providers: ${providersText}.`);

    this.name = 'UnknownAgentProviderError';
    this.providerName = providerName;
    this.availableProviders = sortedProviders;
  }
}

export function createAgentProviderResolver<TName extends string>(
  registry: AgentProviderRegistry<TName>,
): AgentProviderResolver {
  const availableProviders = Object.keys(registry).sort((a, b) => a.localeCompare(b));
  const objectHasOwn = (
    Object as unknown as { hasOwn: (object: object, property: PropertyKey) => boolean }
  ).hasOwn;

  return (providerName: string): AgentProvider => {
    if (!objectHasOwn(registry, providerName)) {
      throw new UnknownAgentProviderError(providerName, availableProviders);
    }

    return registry[providerName as TName];
  };
}

export const defaultAgentProviderRegistry: AgentProviderRegistry = Object.freeze({
  claude: new ClaudeProvider(),
  codex: new CodexProvider(),
});

export const resolveAgentProvider = createAgentProviderResolver(defaultAgentProviderRegistry);
