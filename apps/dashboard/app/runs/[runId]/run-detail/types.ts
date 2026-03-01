import type { Dispatch, SetStateAction } from 'react';
import type {
  DashboardRunControlAction,
  DashboardRunControlResult,
  DashboardRepositoryState,
  DashboardRunDetail,
  DashboardRunNodeStreamEvent,
  DashboardRunSummary,
} from '../../../../src/server/dashboard-contracts';

export type TimelineCategory = 'lifecycle' | 'node' | 'artifact' | 'diagnostics' | 'routing';

export type TimelineItem = Readonly<{
  key: string;
  timestamp: Date;
  summary: string;
  relatedNodeId: number | null;
  category: TimelineCategory;
}>;

export type OperatorActionState = Readonly<{
  label: string;
  href: string | null;
  controlAction: DashboardRunControlAction | null;
  disabledReason: string | null;
}>;

export type OperatorActionSet = Readonly<{
  primary: OperatorActionState;
  secondary: OperatorActionState | null;
}>;

export type ActionFeedbackState = Readonly<{
  tone: 'info' | 'success' | 'error';
  message: string;
  runStatus: DashboardRunSummary['status'] | null;
}> | null;

export type RealtimeChannelState = 'disabled' | 'live' | 'reconnecting' | 'stale';
export type AgentStreamConnectionState = 'live' | 'reconnecting' | 'stale' | 'ended';
export type DiagnosticErrorClassification = 'provider_result_missing' | 'timeout' | 'aborted' | 'unknown';

export type AgentStreamTarget = {
  runNodeId: number;
  nodeKey: string;
  attempt: number;
};

export type ExpandablePreviewProps = Readonly<{
  value: string;
  label: string;
  previewLength?: number;
  className?: string;
  emptyLabel?: string;
}>;

export type RunDetailContentProps = Readonly<{
  initialDetail: DashboardRunDetail;
  repositories: readonly DashboardRepositoryState[];
  enableRealtime?: boolean;
  pollIntervalMs?: number;
}>;

export type ErrorEnvelope = {
  error?: {
    message?: string;
  };
};

export const RUN_STATUSES = new Set<DashboardRunSummary['status']>([
  'pending',
  'running',
  'paused',
  'completed',
  'failed',
  'cancelled',
]);

export const RUN_CONTROL_ACTIONS = new Set<DashboardRunControlAction>(['cancel', 'pause', 'resume', 'retry']);
export const RUN_CONTROL_OUTCOMES = new Set<DashboardRunControlResult['outcome']>(['applied', 'noop']);

export const NODE_STATUSES = new Set<DashboardRunDetail['nodes'][number]['status']>([
  'pending',
  'running',
  'completed',
  'failed',
  'skipped',
  'cancelled',
]);

export const ARTIFACT_TYPES = new Set<DashboardRunDetail['artifacts'][number]['artifactType']>(['report', 'note', 'log']);
export const ARTIFACT_CONTENT_TYPES = new Set<DashboardRunDetail['artifacts'][number]['contentType']>([
  'text',
  'markdown',
  'json',
  'diff',
]);

export const ROUTING_DECISION_TYPES = new Set<DashboardRunDetail['routingDecisions'][number]['decisionType']>([
  'approved',
  'changes_requested',
  'blocked',
  'retry',
  'no_route',
]);

export const DIAGNOSTIC_OUTCOMES = new Set<DashboardRunDetail['diagnostics'][number]['outcome']>(['completed', 'failed']);

export const DIAGNOSTIC_EVENT_TYPES = new Set<
  DashboardRunDetail['diagnostics'][number]['diagnostics']['events'][number]['type']
>(['system', 'assistant', 'result', 'tool_use', 'tool_result', 'usage']);

export const DIAGNOSTIC_TOOL_EVENT_TYPES = new Set<
  DashboardRunDetail['diagnostics'][number]['diagnostics']['toolEvents'][number]['type']
>(['tool_use', 'tool_result']);

export const DIAGNOSTIC_ERROR_CLASSIFICATIONS = new Set<DiagnosticErrorClassification>([
  'provider_result_missing',
  'timeout',
  'aborted',
  'unknown',
]);

export const WORKTREE_STATUSES = new Set<DashboardRunDetail['worktrees'][number]['status']>(['active', 'removed']);

export const STREAM_EVENT_TYPES = new Set<DashboardRunNodeStreamEvent['type']>([
  'system',
  'assistant',
  'result',
  'tool_use',
  'tool_result',
  'usage',
]);

export const RUN_DETAIL_POLL_INTERVAL_MS = 4_000;
export const RUN_DETAIL_POLL_BACKOFF_MAX_MS = 20_000;
export const RUN_DETAIL_STALE_THRESHOLD_MS = 15_000;
export const AGENT_STREAM_RECONNECT_MAX_MS = 20_000;
export const AGENT_STREAM_STALE_THRESHOLD_MS = 15_000;
export const RUN_TIMELINE_RECENT_EVENT_COUNT = 8;
export const RUN_AGENT_STREAM_RECENT_EVENT_COUNT = 8;
export const RUN_OBSERVABILITY_RECENT_ENTRY_COUNT = 2;

export type RecentPartition<T> = Readonly<{
  recent: readonly T[];
  earlier: readonly T[];
}>;

export type RecentPartitionOrder = 'oldest-first' | 'newest-first';

export type StateSetter<T> = Dispatch<SetStateAction<T>>;

export type ExecuteRunControlActionParams = {
  action: DashboardRunControlAction;
  runId: number;
  runStatus: DashboardRunSummary['status'];
  enableRealtime: boolean;
  setDetail: StateSetter<DashboardRunDetail>;
  setUpdateError: StateSetter<string | null>;
  setIsRefreshing: StateSetter<boolean>;
  setLastUpdatedAtMs: StateSetter<number>;
  setNextRetryAtMs: StateSetter<number | null>;
  setChannelState: StateSetter<RealtimeChannelState>;
  setActionFeedback: StateSetter<ActionFeedbackState>;
};

export type RunDetailPollingEffectParams = {
  enableRealtime: boolean;
  runId: number;
  runStatus: DashboardRunSummary['status'];
  pollIntervalMs: number;
  lastUpdatedAtRef: { current: number };
  setChannelState: StateSetter<RealtimeChannelState>;
  setIsRefreshing: StateSetter<boolean>;
  setNextRetryAtMs: StateSetter<number | null>;
  setUpdateError: StateSetter<string | null>;
  setDetail: StateSetter<DashboardRunDetail>;
  setLastUpdatedAtMs: StateSetter<number>;
};

export type AgentStreamLifecycleEffectParams = {
  runId: number;
  streamTarget: AgentStreamTarget | null;
  streamAutoScrollRef: { current: boolean };
  streamLastSequenceRef: { current: number };
  streamLastUpdatedAtRef: { current: number };
  setStreamEvents: StateSetter<DashboardRunNodeStreamEvent[]>;
  setStreamBufferedEvents: StateSetter<DashboardRunNodeStreamEvent[]>;
  setStreamConnectionState: StateSetter<AgentStreamConnectionState>;
  setStreamError: StateSetter<string | null>;
  setStreamNextRetryAtMs: StateSetter<number | null>;
  setStreamRetryCountdownSeconds: StateSetter<number | null>;
  setStreamLastUpdatedAtMs: StateSetter<number>;
};

export type RunObservabilityCardProps = Readonly<{
  detail: DashboardRunDetail;
}>;

export type RunOperatorFocusCardProps = Readonly<{
  detail: DashboardRunDetail;
  latestTimelineEvent: TimelineItem | null;
  hasHydrated: boolean;
  primaryAction: OperatorActionState;
  secondaryAction: OperatorActionState | null;
  pendingControlAction: DashboardRunControlAction | null;
  actionHint: string | null;
  actionHintTone: 'info' | 'success' | 'error';
  channelState: RealtimeChannelState;
  realtimeLabel: string;
  lastUpdatedAtMs: number;
  isRefreshing: boolean;
  updateError: string | null;
  onRunControlAction: (action: DashboardRunControlAction) => void;
}>;

export type RunDetailLifecycleGridProps = Readonly<{
  detail: DashboardRunDetail;
  selectedNode: DashboardRunDetail['nodes'][number] | null;
  filteredNodeId: number | null;
  highlightedNodeId: number | null;
  hasHydrated: boolean;
  visibleTimeline: readonly TimelineItem[];
  visibleTimelinePartition: RecentPartition<TimelineItem>;
  onSelectTimelineNode: (nodeId: number | null) => void;
  onClearNodeFilter: () => void;
  onToggleNodeFilter: (nodeId: number) => void;
}>;
