import type { PhaseDefinition, ProviderEvent } from '@alphred/shared';

export type PhaseRunResult = {
  success: boolean;
  report: string;
  events: ProviderEvent[];
  tokensUsed: number;
};

// Placeholder: will be implemented to orchestrate agent sessions per phase
export async function runPhase(_phase: PhaseDefinition, _context: Record<string, unknown>): Promise<PhaseRunResult> {
  // TODO: Implement phase execution
  // 1. Load prior phase reports from DB as context
  // 2. Create agent session
  // 3. Invoke agent provider with prompt + context
  // 4. Collect streaming events
  // 5. Store report and return result
  return {
    success: true,
    report: '',
    events: [],
    tokensUsed: 0,
  };
}
