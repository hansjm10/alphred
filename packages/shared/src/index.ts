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

// SCM providers
export type ScmProviderKind = 'github' | 'azure-devops';

// Normalized SCM work item
export type WorkItem = {
  id: string;
  title: string;
  body: string;
  labels: string[];
  provider: ScmProviderKind;
};

// Normalized pull request creation params
export type CreatePrParams = {
  title: string;
  body: string;
  sourceBranch: string;
  targetBranch?: string;
};

// Normalized pull request creation result
export type PullRequestResult = {
  id: string;
  url?: string;
  provider: ScmProviderKind;
};

// SCM auth status
export type AuthStatus = {
  authenticated: boolean;
  user?: string;
  scopes?: string[];
  error?: string;
};

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

export const routingDecisionSignals = ['approved', 'changes_requested', 'blocked', 'retry'] as const;
export type RoutingDecisionSignal = (typeof routingDecisionSignals)[number];
export type RoutingDecisionType = RoutingDecisionSignal | 'no_route';

// Agent provider event types
export type ProviderEventType = 'system' | 'assistant' | 'result' | 'tool_use' | 'tool_result' | 'usage';

export type ProviderEvent = {
  type: ProviderEventType;
  content: string;
  timestamp: number;
  metadata?: Record<string, unknown> & {
    routingDecision?: RoutingDecisionSignal;
  };
};

export type ProviderRunOptions = {
  workingDirectory: string;
  systemPrompt?: string;
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
