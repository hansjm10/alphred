import type { AgentProviderName } from '@alphred/shared';
import type { AgentProvider } from './provider.js';
import { ClaudeProvider } from './providers/claude.js';
import { CodexProvider } from './providers/codex.js';

export type AgentProviderRegistry<TName extends string = AgentProviderName> = Readonly<
  Record<TName, AgentProvider>
>;

export type AgentProviderResolver<TName extends string = AgentProviderName> = (
  providerName: TName | (string & {}),
) => AgentProvider;

export class UnknownAgentProviderError extends Error {
  readonly code = 'UNKNOWN_AGENT_PROVIDER';
  readonly providerName: string;
  readonly availableProviders: readonly string[];

  constructor(providerName: string, availableProviders: readonly string[]) {
    const sortedProviders = [...availableProviders].sort();
    const providersText = sortedProviders.length > 0 ? sortedProviders.join(', ') : '(none)';
    super(`Unknown agent provider "${providerName}". Available providers: ${providersText}.`);

    this.name = 'UnknownAgentProviderError';
    this.providerName = providerName;
    this.availableProviders = sortedProviders;
  }
}

export function createAgentProviderResolver<TName extends string>(
  registry: AgentProviderRegistry<TName>,
): AgentProviderResolver<TName> {
  const availableProviders = Object.keys(registry).sort();

  return (providerName: TName | (string & {})): AgentProvider => {
    const provider = registry[providerName as TName];

    if (!provider) {
      throw new UnknownAgentProviderError(providerName, availableProviders);
    }

    return provider;
  };
}

export const defaultAgentProviderRegistry: AgentProviderRegistry = Object.freeze({
  claude: new ClaudeProvider(),
  codex: new CodexProvider(),
});

export const resolveAgentProvider = createAgentProviderResolver(defaultAgentProviderRegistry);
