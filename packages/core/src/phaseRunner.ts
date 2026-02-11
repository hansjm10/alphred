import type { PhaseDefinition, ProviderEvent, ProviderRunOptions } from '@alphred/shared';

export type PhaseRunResult = {
  success: boolean;
  report: string;
  events: ProviderEvent[];
  tokensUsed: number;
};

export type PhaseProvider = {
  run(prompt: string, options: ProviderRunOptions): AsyncIterable<ProviderEvent>;
};

export type PhaseProviderResolver = (providerName: string) => PhaseProvider;

export type PhaseRunnerDependencies = {
  resolveProvider: PhaseProviderResolver;
};

function extractTokenUsage(event: ProviderEvent): number {
  if (event.type !== 'usage' || !event.metadata) {
    return 0;
  }

  const tokens = event.metadata.tokens;
  if (typeof tokens === 'number') {
    return tokens;
  }

  const tokensUsed = event.metadata.tokensUsed;
  if (typeof tokensUsed === 'number') {
    return tokensUsed;
  }

  const totalTokens = event.metadata.totalTokens;
  if (typeof totalTokens === 'number') {
    return totalTokens;
  }

  const inputTokens = event.metadata.inputTokens;
  const outputTokens = event.metadata.outputTokens;
  if (typeof inputTokens === 'number' && typeof outputTokens === 'number') {
    return inputTokens + outputTokens;
  }

  return 0;
}

export async function runPhase(
  phase: PhaseDefinition,
  options: ProviderRunOptions,
  dependencies: PhaseRunnerDependencies,
): Promise<PhaseRunResult> {
  if (phase.type !== 'agent') {
    return {
      success: true,
      report: '',
      events: [],
      tokensUsed: 0,
    };
  }

  if (!phase.provider) {
    throw new Error(`Agent phase "${phase.name}" is missing a provider.`);
  }

  const provider = dependencies.resolveProvider(phase.provider);
  const events: ProviderEvent[] = [];
  let report = '';
  let tokensUsed = 0;

  for await (const event of provider.run(phase.prompt, options)) {
    events.push(event);
    if (event.type === 'result') {
      report = event.content;
    }
    tokensUsed += extractTokenUsage(event);
  }

  return {
    success: true,
    report,
    events,
    tokensUsed,
  };
}
