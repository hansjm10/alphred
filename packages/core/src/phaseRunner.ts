import {
  routingDecisionSignals,
  type PhaseDefinition,
  type ProviderEvent,
  type ProviderRunOptions,
  type RoutingDecisionSource,
  type RoutingDecisionSignal,
} from '@alphred/shared';

export type PhaseRunResult = {
  success: boolean;
  report: string;
  routingDecision: RoutingDecisionSignal | null;
  routingDecisionSource: RoutingDecisionSource | null;
  events: ProviderEvent[];
  tokensUsed: number;
};

export class PhaseRunError extends Error {
  readonly events: ProviderEvent[];
  readonly tokensUsed: number;
  readonly cause: unknown;

  constructor(
    message: string,
    options: {
      events: ProviderEvent[];
      tokensUsed: number;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = 'PhaseRunError';
    this.events = options.events;
    this.tokensUsed = options.tokensUsed;
    this.cause = options.cause;
  }
}

export type PhaseProvider = {
  run(prompt: string, options: ProviderRunOptions): AsyncIterable<ProviderEvent>;
};

export type PhaseProviderResolver = (providerName: string) => PhaseProvider;

export type PhaseRunnerDependencies = {
  resolveProvider: PhaseProviderResolver;
  onEvent?: (event: ProviderEvent) => Promise<void> | void;
};

const routingDecisionSignalSet: ReadonlySet<RoutingDecisionSignal> = new Set(routingDecisionSignals);

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

function readTokenUsageFromMetadata(metadata: Record<string, unknown>): TokenUsage | undefined {
  const cumulativeTokens = readCumulativeUsage(metadata);
  if (cumulativeTokens !== undefined) {
    return {
      mode: 'cumulative',
      tokens: cumulativeTokens,
    };
  }

  const directTokens = toTokenCount(metadata.tokens);
  if (directTokens !== undefined) {
    return {
      mode: 'incremental',
      tokens: directTokens,
    };
  }

  return undefined;
}

function extractTokenUsage(event: ProviderEvent): TokenUsage | undefined {
  if (event.type !== 'usage' || !event.metadata) {
    return undefined;
  }

  const metadata = event.metadata;
  const topLevelUsage = readTokenUsageFromMetadata(metadata);
  const nestedUsage = metadata.usage;
  const nestedMetadata =
    nestedUsage && typeof nestedUsage === 'object' ? (nestedUsage as Record<string, unknown>) : undefined;
  const nestedTokenUsage = nestedMetadata ? readTokenUsageFromMetadata(nestedMetadata) : undefined;

  const cumulativeCandidates = [topLevelUsage, nestedTokenUsage]
    .filter((usage): usage is TokenUsage & { mode: 'cumulative' } => usage?.mode === 'cumulative')
    .map((usage) => usage.tokens);
  if (cumulativeCandidates.length > 0) {
    return {
      mode: 'cumulative',
      tokens: Math.max(...cumulativeCandidates),
    };
  }

  const incrementalCandidates = [topLevelUsage, nestedTokenUsage]
    .filter((usage): usage is TokenUsage & { mode: 'incremental' } => usage?.mode === 'incremental')
    .map((usage) => usage.tokens);
  if (incrementalCandidates.length > 0) {
    return {
      mode: 'incremental',
      tokens: Math.max(...incrementalCandidates),
    };
  }

  return undefined;
}

function readRoutingDecision(event: ProviderEvent): RoutingDecisionSignal | null {
  if (event.type !== 'result' || !event.metadata) {
    return null;
  }

  const routingDecision = event.metadata.routingDecision;
  if (typeof routingDecision === 'string' && routingDecisionSignalSet.has(routingDecision as RoutingDecisionSignal)) {
    return routingDecision as RoutingDecisionSignal;
  }

  return null;
}

function readRoutingDecisionSource(event: ProviderEvent): RoutingDecisionSource | null {
  if (event.type !== 'result' || !event.metadata) {
    return null;
  }

  const source = event.metadata.routingDecisionSource;
  if (source === 'provider_result_metadata' || source === 'result_content_contract_fallback') {
    return source;
  }

  return null;
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
      routingDecision: null,
      routingDecisionSource: null,
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
  let routingDecision: RoutingDecisionSignal | null = null;
  let routingDecisionSource: RoutingDecisionSource | null = null;
  let hasResultEvent = false;
  let incrementalTokensUsed = 0;
  let maxCumulativeTokensUsed = 0;
  const onEvent = dependencies.onEvent;

  try {
    for await (const event of provider.run(phase.prompt, options)) {
      events.push(event);
      if (event.type === 'result') {
        hasResultEvent = true;
        report = event.content;
        routingDecision = readRoutingDecision(event);
        routingDecisionSource =
          routingDecision === null ? null : (readRoutingDecisionSource(event) ?? 'provider_result_metadata');
      }

      const tokenUsage = extractTokenUsage(event);
      if (tokenUsage) {
        if (tokenUsage.mode === 'incremental') {
          incrementalTokensUsed += tokenUsage.tokens;
        } else {
          maxCumulativeTokensUsed = Math.max(maxCumulativeTokensUsed, tokenUsage.tokens);
        }
      }

      if (onEvent) {
        await onEvent(event);
      }
    }
  } catch (error) {
    throw new PhaseRunError(`Agent phase "${phase.name}" execution failed.`, {
      events,
      tokensUsed: Math.max(incrementalTokensUsed, maxCumulativeTokensUsed),
      cause: error,
    });
  }

  if (!hasResultEvent) {
    throw new PhaseRunError(`Agent phase "${phase.name}" completed without a result event.`, {
      events,
      tokensUsed: Math.max(incrementalTokensUsed, maxCumulativeTokensUsed),
    });
  }

  return {
    success: true,
    report,
    routingDecision,
    routingDecisionSource,
    events,
    tokensUsed: Math.max(incrementalTokensUsed, maxCumulativeTokensUsed),
  };
}
