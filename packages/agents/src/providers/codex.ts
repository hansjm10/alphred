import type { AgentProvider } from '../provider.js';
import type { ProviderEvent, ProviderRunOptions } from '@alphred/shared';
import { createProviderEvent } from '../provider.js';

export class CodexProvider implements AgentProvider {
  readonly name = 'codex' as const;

  async *run(prompt: string, options: ProviderRunOptions): AsyncIterable<ProviderEvent> {
    // TODO: Integrate with @openai/codex SDK
    // 1. Spawn codex process in options.workingDirectory
    // 2. Pass prompt with approval mode
    // 3. Stream events as ProviderEvent
    void options;
    yield createProviderEvent('system', `Codex provider invoked with prompt length: ${prompt.length}`);
    yield createProviderEvent('usage', '', { usage: { input_tokens: prompt.length, output_tokens: 0 } });
    yield createProviderEvent('result', '');
  }
}
