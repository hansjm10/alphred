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

type TokenUsage =
  | {
      mode: 'incremental';
      tokens: number;
    }
  | {
      mode: 'cumulative';
      tokens: number;
    };

function toTokenCount(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined;
  }

  return value;
}

function readCumulativeUsage(metadata: Record<string, unknown>): number | undefined {
  const candidates: number[] = [];

  const tokensUsed = toTokenCount(metadata.tokensUsed);
  if (tokensUsed !== undefined) {
    candidates.push(tokensUsed);
  }

  const totalTokens = toTokenCount(metadata.totalTokens);
  if (totalTokens !== undefined) {
    candidates.push(totalTokens);
  }

  const inputTokens = toTokenCount(metadata.inputTokens);
  const outputTokens = toTokenCount(metadata.outputTokens);
  if (inputTokens !== undefined && outputTokens !== undefined) {
    candidates.push(inputTokens + outputTokens);
  }

  const snakeCaseInputTokens = toTokenCount(metadata.input_tokens);
  const snakeCaseOutputTokens = toTokenCount(metadata.output_tokens);
  if (snakeCaseInputTokens !== undefined && snakeCaseOutputTokens !== undefined) {
    candidates.push(snakeCaseInputTokens + snakeCaseOutputTokens);
  }

  const snakeCaseTotalTokens = toTokenCount(metadata.total_tokens);
  if (snakeCaseTotalTokens !== undefined) {
    candidates.push(snakeCaseTotalTokens);
  }

  if (candidates.length === 0) {
    return undefined;
  }

  return Math.max(...candidates);
}

function extractTokenUsage(event: ProviderEvent): TokenUsage | undefined {
  if (event.type !== 'usage' || !event.metadata) {
    return undefined;
  }

  const metadata = event.metadata;
  const directTokens = toTokenCount(metadata.tokens);
  if (directTokens !== undefined) {
    return {
      mode: 'incremental',
      tokens: directTokens,
    };
  }

  const cumulativeTokens = readCumulativeUsage(metadata);
  if (cumulativeTokens !== undefined) {
    return {
      mode: 'cumulative',
      tokens: cumulativeTokens,
    };
  }

  const nestedUsage = metadata.usage;
  if (!nestedUsage || typeof nestedUsage !== 'object') {
    return undefined;
  }

  const usageMetadata = nestedUsage as Record<string, unknown>;
  const nestedTokens = toTokenCount(usageMetadata.tokens);
  if (nestedTokens !== undefined) {
    return {
      mode: 'incremental',
      tokens: nestedTokens,
    };
  }

  const nestedCumulativeTokens = readCumulativeUsage(usageMetadata);
  if (nestedCumulativeTokens !== undefined) {
    return {
      mode: 'cumulative',
      tokens: nestedCumulativeTokens,
    };
  }

  return undefined;
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
  let incrementalTokensUsed = 0;
  let maxCumulativeTokensUsed = 0;

  for await (const event of provider.run(phase.prompt, options)) {
    events.push(event);
    if (event.type === 'result') {
      report = event.content;
    }

    const tokenUsage = extractTokenUsage(event);
    if (!tokenUsage) {
      continue;
    }

    if (tokenUsage.mode === 'incremental') {
      incrementalTokensUsed += tokenUsage.tokens;
      continue;
    }

    maxCumulativeTokensUsed = Math.max(maxCumulativeTokensUsed, tokenUsage.tokens);
  }

  return {
    success: true,
    report,
    events,
    tokensUsed: Math.max(incrementalTokensUsed, maxCumulativeTokensUsed),
  };
}
