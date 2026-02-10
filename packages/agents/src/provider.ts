import type { ProviderEvent, ProviderRunOptions } from '@alphred/shared';

export interface AgentProvider {
  readonly name: string;
  run(prompt: string, options: ProviderRunOptions): AsyncIterable<ProviderEvent>;
}

export function createProviderEvent(
  type: ProviderEvent['type'],
  content: string,
  metadata?: Record<string, unknown>,
): ProviderEvent {
  return {
    type,
    content,
    timestamp: Date.now(),
    metadata,
  };
}
