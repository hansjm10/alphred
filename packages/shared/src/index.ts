// Run statuses
export type RunStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';

// Phase statuses
export type PhaseStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

// Agent provider names
export type AgentProviderName = 'claude' | 'codex';

// Phase types
export type PhaseType = 'agent' | 'human' | 'tool';

// Content types for phase reports
export type ContentType = 'text' | 'markdown' | 'json' | 'diff';

// Log levels
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

// Trigger sources
export type TriggerSource = 'manual' | 'github' | 'azure-devops' | 'schedule';

// Guard operator types
export type GuardOperator = '==' | '!=' | '>' | '<' | '>=' | '<=';
export type GuardLogical = 'and' | 'or';

// Guard expression: a single condition or a logical combination
export type GuardCondition = {
  field: string;
  operator: GuardOperator;
  value: string | number | boolean;
};

export type GuardExpression =
  | GuardCondition
  | { logic: GuardLogical; conditions: GuardExpression[] };

// Transition definition
export type Transition = {
  target: string;
  priority: number;
  auto?: boolean;
  when?: GuardExpression;
};

// Phase definition within a workflow
export type PhaseDefinition = {
  name: string;
  type: PhaseType;
  provider?: AgentProviderName;
  prompt: string;
  maxRetries?: number;
  transitions: Transition[];
};

// Workflow definition
export type WorkflowDefinition = {
  name: string;
  version: number;
  phases: PhaseDefinition[];
};

// Agent provider event types
export type ProviderEventType = 'system' | 'assistant' | 'result' | 'tool_use' | 'tool_result' | 'usage';

export type ProviderEvent = {
  type: ProviderEventType;
  content: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
};

export type ProviderRunOptions = {
  workingDirectory: string;
  systemPrompt?: string;
  maxTokens?: number;
  timeout?: number;
  context?: string[];
};

/**
 * Compares strings in locale-independent code-unit order.
 * Useful when deterministic ordering must not vary by runtime locale.
 */
export function compareStringsByCodeUnit(a: string, b: string): number {
  if (a < b) {
    return -1;
  }

  if (a > b) {
    return 1;
  }

  return 0;
}
