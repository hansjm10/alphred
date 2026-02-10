import type { AgentProvider } from '../provider.js';
import type { ProviderEvent, ProviderRunOptions } from '@alphred/shared';
import { createProviderEvent } from '../provider.js';

export class ClaudeProvider implements AgentProvider {
  readonly name = 'claude' as const;

  async *run(prompt: string, options: ProviderRunOptions): AsyncIterable<ProviderEvent> {
    // TODO: Integrate with @anthropic-ai/claude-code SDK
    // 1. Spawn claude-code process in options.workingDirectory
    // 2. Pass prompt and systemPrompt
    // 3. Stream events as ProviderEvent
    void options;
    yield createProviderEvent('system', `Claude provider invoked with prompt length: ${prompt.length}`);
    yield createProviderEvent('result', '');
  }
}
