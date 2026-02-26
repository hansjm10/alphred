import { transitionRunNodeStatus, type AlphredDatabase, type RunNodeStatus, type WorkflowRunStatus } from '@alphred/db';
import type {
  AgentProviderName,
  PhaseDefinition,
  ProviderEvent,
  ProviderRunOptions,
} from '@alphred/shared';
import { PhaseRunError, runPhase } from '../phaseRunner.js';
import {
  DEFAULT_ERROR_HANDLER_MODEL,
  DEFAULT_ERROR_HANDLER_MODEL_BY_PROVIDER,
  DEFAULT_ERROR_HANDLER_PROMPT,
  ERROR_HANDLER_SUMMARY_METADATA_KIND,
  MAX_ERROR_CONTEXT_CHARS,
} from './constants.js';
import { assembleUpstreamArtifactContext } from './context-assembly.js';
import { toErrorMessage } from './diagnostics-collection.js';
import {
  persistRunNodeAttemptDiagnostics,
  persistRunNodeStreamEvent,
  resolveNextRunNodeStreamSequence,
} from './diagnostics-persistence.js';
import { markUnreachablePendingNodesAsSkipped } from './node-selection.js';
import { mergeExecutionPermissions, normalizeRunNodeExecutionPermissions } from './permissions.js';
import {
  loadRunNodeExecutionRowById,
  loadRunNodeExecutionRows,
  loadWorkflowRunRow,
  persistCompletedNodeRoutingDecision,
  persistFailureArtifact,
  persistNoteArtifact,
  persistSuccessArtifact,
} from './persistence.js';
import { loadLatestArtifactsByRunNodeId, loadLatestRoutingDecisionsByRunNodeId } from './routing-selection.js';
import {
  isTerminalWorkflowRunStatus,
  reactivateSelectedTargetNode,
  resolveRunStatusFromNodes,
  shouldRetryNodeAttempt,
  transitionFailedRunNodeToPendingAttempt,
  transitionFailedRunNodeToRetryAttempt,
  transitionRunToCurrentForExecutor,
} from './transitions.js';
import { getLatestRunNodeAttempts, hashContentSha256, isRecord, truncateHeadTail } from './type-conversions.js';
import type {
  ContextHandoffManifest,
  EdgeRow,
  ExecuteNextRunnableNodeResult,
  RunNodeErrorHandlerDiagnostics,
  RunNodeExecutionRow,
  SqlWorkflowExecutorDependencies,
  StreamUsageState,
  WorkflowRunRow,
} from './types.js';

export function createExecutionPhase(node: RunNodeExecutionRow): PhaseDefinition {
  if (node.nodeType !== 'agent') {
    throw new Error(`Unsupported node type "${node.nodeType}" for run node "${node.nodeKey}".`);
  }

  return {
    name: node.nodeKey,
    type: 'agent',
    provider: (node.provider as AgentProviderName | null) ?? undefined,
    model: node.model ?? undefined,
    prompt: node.prompt ?? '',
    transitions: [],
  };
}

export type ClaimedNodeSuccess = {
  artifactId: number;
  runStatus: WorkflowRunStatus;
};

export type ClaimedNodeSuccessParams = {
  currentAttempt: number;
  contextManifest: ContextHandoffManifest;
  phaseResult: Awaited<ReturnType<typeof runPhase>>;
};

export type ClaimedNodeFailure = {
  artifactId: number;
  runStatus: WorkflowRunStatus;
  runNodeStatus: 'completed' | 'failed';
  nextAttempt: number | null;
  nextStepOutcome: Extract<ExecuteNextRunnableNodeResult, { outcome: 'blocked' | 'run_terminal' }>['outcome'] | null;
};

export type ClaimedNodeFailureParams = {
  currentAttempt: number;
  contextManifest: ContextHandoffManifest;
  failureEvents: ProviderEvent[];
  failureTokensUsed: number;
  error: unknown;
  allowRetries: boolean;
  dependencies: SqlWorkflowExecutorDependencies;
  options: ProviderRunOptions;
};

export type NodeFailureReason = 'post_completion_failure' | 'retry_scheduled' | 'retry_limit_exceeded';

export function buildExecutedNodeResult(
  run: WorkflowRunRow,
  node: RunNodeExecutionRow,
  runNodeStatus: 'completed' | 'failed',
  runStatus: WorkflowRunStatus,
  artifactId: number,
): ExecuteNextRunnableNodeResult {
  return {
    outcome: 'executed',
    workflowRunId: run.id,
    runNodeId: node.runNodeId,
    nodeKey: node.nodeKey,
    runNodeStatus,
    runStatus,
    artifactId,
  };
}

export function resolveFailureReason(persistedNodeStatus: RunNodeStatus, canRetry: boolean): NodeFailureReason {
  if (persistedNodeStatus === 'completed') {
    return 'post_completion_failure';
  }

  if (canRetry) {
    return 'retry_scheduled';
  }

  return 'retry_limit_exceeded';
}

type RetryState = {
  canRetryImmediately: boolean;
  canRetry: boolean;
};

function resolveRetryState(retryEligible: boolean, runStatus: WorkflowRunStatus): RetryState {
  const canRetryImmediately = retryEligible && runStatus === 'running';

  return {
    canRetryImmediately,
    canRetry: canRetryImmediately || (retryEligible && runStatus === 'paused'),
  };
}

export type ResolvedErrorHandlerExecutionConfig = {
  provider: AgentProviderName;
  model: string;
  prompt: string;
  maxInputChars: number;
};

function isAgentProviderName(value: unknown): value is AgentProviderName {
  return value === 'codex' || value === 'claude';
}

function toOptionalNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toOptionalPositiveInteger(value: unknown): number | null {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    return null;
  }

  return value as number;
}

function resolveNodeProviderForErrorHandler(node: RunNodeExecutionRow): AgentProviderName {
  if (isAgentProviderName(node.provider)) {
    return node.provider;
  }

  return 'codex';
}

export function resolveErrorHandlerExecutionConfig(node: RunNodeExecutionRow): ResolvedErrorHandlerExecutionConfig | null {
  const defaultProvider = resolveNodeProviderForErrorHandler(node);
  const defaultModel = DEFAULT_ERROR_HANDLER_MODEL_BY_PROVIDER[defaultProvider] ?? DEFAULT_ERROR_HANDLER_MODEL;
  const rawConfig = node.errorHandlerConfig;
  if (!isRecord(rawConfig)) {
    return {
      provider: defaultProvider,
      model: defaultModel,
      prompt: DEFAULT_ERROR_HANDLER_PROMPT,
      maxInputChars: MAX_ERROR_CONTEXT_CHARS,
    };
  }

  const mode = rawConfig.mode;
  if (mode === 'disabled') {
    return null;
  }

  const customMode = mode === 'custom';
  const provider =
    customMode && isAgentProviderName(rawConfig.provider) ? rawConfig.provider : defaultProvider;
  const model =
    (customMode ? toOptionalNonEmptyString(rawConfig.model) : null) ??
    DEFAULT_ERROR_HANDLER_MODEL_BY_PROVIDER[provider] ??
    DEFAULT_ERROR_HANDLER_MODEL;
  const prompt = (customMode ? toOptionalNonEmptyString(rawConfig.prompt) : null) ?? DEFAULT_ERROR_HANDLER_PROMPT;
  const maxInputChars = (customMode ? toOptionalPositiveInteger(rawConfig.maxInputChars) : null) ?? MAX_ERROR_CONTEXT_CHARS;

  return {
    provider,
    model,
    prompt,
    maxInputChars,
  };
}

function extractPartialOutputFromFailureEvents(events: ProviderEvent[]): string | null {
  for (const event of [...events].reverse()) {
    if (event.type === 'result' && event.content.trim().length > 0) {
      return event.content;
    }
  }

  const trailingAssistantContents = events
    .filter(event => event.type === 'assistant' && event.content.trim().length > 0)
    .slice(-3)
    .map(event => event.content);
  if (trailingAssistantContents.length === 0) {
    return null;
  }

  return trailingAssistantContents.join('\n\n');
}

function buildErrorHandlerInputContext(params: {
  workflowRunId: number;
  node: RunNodeExecutionRow;
  currentAttempt: number;
  failureArtifactId: number;
  errorMessage: string;
  failureEvents: ProviderEvent[];
  maxInputChars: number;
}): string {
  const partialOutput = extractPartialOutputFromFailureEvents(params.failureEvents) ?? 'none';
  const failureContext = [
    'ALPHRED_RETRY_ERROR_HANDLER_INPUT v1',
    `workflow_run_id: ${params.workflowRunId}`,
    `node_key: ${params.node.nodeKey}`,
    `source_attempt: ${params.currentAttempt}`,
    `target_attempt: ${params.currentAttempt + 1}`,
    `max_retries: ${params.node.maxRetries}`,
    `node_provider: ${params.node.provider ?? 'unknown'}`,
    `node_model: ${params.node.model ?? 'unknown'}`,
    `failure_artifact_id: ${params.failureArtifactId}`,
    'error_message:',
    params.errorMessage,
    'partial_output:',
    partialOutput,
    'node_prompt:',
    params.node.prompt ?? '',
  ].join('\n');

  return truncateHeadTail(failureContext, params.maxInputChars);
}

function buildSkippedErrorHandlerDiagnostics(
  sourceAttempt: number,
  targetAttempt: number | null,
): RunNodeErrorHandlerDiagnostics {
  return {
    attempted: false,
    status: 'skipped',
    summaryArtifactId: null,
    sourceAttempt,
    targetAttempt,
    provider: null,
    model: null,
    eventCount: 0,
    tokensUsed: 0,
    errorMessage: null,
  };
}

async function executeErrorHandlerForRetry(
  db: AlphredDatabase,
  params: {
    run: WorkflowRunRow;
    node: RunNodeExecutionRow;
    currentAttempt: number;
    failureArtifactId: number;
    errorMessage: string;
    failureEvents: ProviderEvent[];
    dependencies: SqlWorkflowExecutorDependencies;
    options: ProviderRunOptions;
  },
): Promise<RunNodeErrorHandlerDiagnostics> {
  const config = resolveErrorHandlerExecutionConfig(params.node);
  if (!config) {
    return buildSkippedErrorHandlerDiagnostics(params.currentAttempt, params.currentAttempt + 1);
  }

  const contextEntry = buildErrorHandlerInputContext({
    workflowRunId: params.run.id,
    node: params.node,
    currentAttempt: params.currentAttempt,
    failureArtifactId: params.failureArtifactId,
    errorMessage: params.errorMessage,
    failureEvents: params.failureEvents,
    maxInputChars: config.maxInputChars,
  });
  const phase: PhaseDefinition = {
    name: `${params.node.nodeKey}::error_handler`,
    type: 'agent',
    provider: config.provider,
    model: config.model,
    prompt: config.prompt,
    transitions: [],
  };
  const optionsWithContext: ProviderRunOptions = {
    ...params.options,
    context: [...(params.options.context ?? []), contextEntry],
  };

  try {
    const optionsWithExecutionPermissions = applyNodeExecutionPermissions(params.node, optionsWithContext);
    const phaseOptions: ProviderRunOptions = {
      ...optionsWithExecutionPermissions,
      model: config.model,
    };
    const result = await runPhase(phase, phaseOptions, {
      resolveProvider: params.dependencies.resolveProvider,
    });
    const summaryArtifactId = persistNoteArtifact(db, {
      workflowRunId: params.run.id,
      runNodeId: params.node.runNodeId,
      content: result.report,
      contentType: 'text',
      metadata: {
        kind: ERROR_HANDLER_SUMMARY_METADATA_KIND,
        sourceAttempt: params.currentAttempt,
        targetAttempt: params.currentAttempt + 1,
        failureArtifactId: params.failureArtifactId,
        errorHandler: {
          provider: config.provider,
          model: config.model,
          promptHash: hashContentSha256(config.prompt),
          maxInputChars: config.maxInputChars,
          eventCount: result.events.length,
          tokensUsed: result.tokensUsed,
        },
      },
    });

    return {
      attempted: true,
      status: 'completed',
      summaryArtifactId,
      sourceAttempt: params.currentAttempt,
      targetAttempt: params.currentAttempt + 1,
      provider: config.provider,
      model: config.model,
      eventCount: result.events.length,
      tokensUsed: result.tokensUsed,
      errorMessage: null,
    };
  } catch (error) {
    return {
      attempted: true,
      status: 'failed',
      summaryArtifactId: null,
      sourceAttempt: params.currentAttempt,
      targetAttempt: params.currentAttempt + 1,
      provider: config.provider,
      model: config.model,
      eventCount: error instanceof PhaseRunError ? error.events.length : 0,
      tokensUsed: error instanceof PhaseRunError ? error.tokensUsed : 0,
      errorMessage: toErrorMessage(error),
    };
  }
}

function applyNodeExecutionPermissions(
  node: RunNodeExecutionRow,
  options: ProviderRunOptions,
): ProviderRunOptions {
  const nodeExecutionPermissions = normalizeRunNodeExecutionPermissions(node.executionPermissions, node.nodeKey);
  const mergedExecutionPermissions = mergeExecutionPermissions(options.executionPermissions, nodeExecutionPermissions);
  if (mergedExecutionPermissions === undefined) {
    return options;
  }

  return {
    ...options,
    executionPermissions: mergedExecutionPermissions,
  };
}

export async function executeNodePhase(
  node: RunNodeExecutionRow,
  options: ProviderRunOptions,
  upstreamContextEntries: string[],
  dependencies: SqlWorkflowExecutorDependencies,
  onEvent?: (event: ProviderEvent) => Promise<void>,
): Promise<Awaited<ReturnType<typeof runPhase>>> {
  const phase = createExecutionPhase(node);
  const optionsWithContext =
    upstreamContextEntries.length === 0
      ? options
      : {
          ...options,
          context: [...(options.context ?? []), ...upstreamContextEntries],
        };
  const optionsWithExecutionPermissions = applyNodeExecutionPermissions(node, optionsWithContext);
  const phaseOptions = phase.model
    ? { ...optionsWithExecutionPermissions, model: phase.model }
    : optionsWithExecutionPermissions;
  return runPhase(phase, phaseOptions, {
    resolveProvider: dependencies.resolveProvider,
    onEvent,
  });
}

export function handleClaimedNodeSuccess(
  db: AlphredDatabase,
  run: WorkflowRunRow,
  node: RunNodeExecutionRow,
  edgeRows: EdgeRow[],
  params: ClaimedNodeSuccessParams,
): ClaimedNodeSuccess {
  const { currentAttempt, contextManifest, phaseResult } = params;

  const artifactId = persistSuccessArtifact(db, {
    workflowRunId: run.id,
    runNodeId: node.runNodeId,
    content: phaseResult.report,
    contentType: node.promptContentType,
    metadata: {
      success: true,
      provider: node.provider,
      nodeKey: node.nodeKey,
      attempt: currentAttempt,
      maxRetries: node.maxRetries,
      retriesUsed: Math.max(currentAttempt - 1, 0),
      tokensUsed: phaseResult.tokensUsed,
      eventCount: phaseResult.events.length,
      ...contextManifest,
    },
  });

  const routingOutcome = persistCompletedNodeRoutingDecision(db, {
    workflowRunId: run.id,
    runNodeId: node.runNodeId,
    treeNodeId: node.treeNodeId,
    attempt: currentAttempt,
    routingDecision: phaseResult.routingDecision,
    edgeRows,
  });

  transitionRunNodeStatus(db, {
    runNodeId: node.runNodeId,
    expectedFrom: 'running',
    to: 'completed',
  });

  const persistedNode = loadRunNodeExecutionRowById(db, run.id, node.runNodeId);
  persistRunNodeAttemptDiagnostics(db, {
    workflowRunId: run.id,
    node,
    attempt: currentAttempt,
    outcome: 'completed',
    status: 'completed',
    runNodeSnapshot: persistedNode,
    contextManifest,
    tokensUsed: phaseResult.tokensUsed,
    events: phaseResult.events,
    routingDecision: phaseResult.routingDecision,
    error: null,
  });

  let runStatus: WorkflowRunStatus;
  if (routingOutcome.decisionType === 'no_route') {
    runStatus = transitionRunToCurrentForExecutor(db, run.id, 'failed');
  } else {
    reactivateSelectedTargetNode(db, {
      workflowRunId: run.id,
      selectedEdgeId: routingOutcome.selectedEdgeId,
      edgeRows,
    });
    markUnreachablePendingNodesAsSkipped(db, run.id, edgeRows);
    const latestAfterSuccess = getLatestRunNodeAttempts(loadRunNodeExecutionRows(db, run.id));
    const targetRunStatus = resolveRunStatusFromNodes(latestAfterSuccess);
    runStatus = transitionRunToCurrentForExecutor(db, run.id, targetRunStatus);
  }

  return {
    artifactId,
    runStatus,
  };
}

export async function handleClaimedNodeFailure(
  db: AlphredDatabase,
  run: WorkflowRunRow,
  node: RunNodeExecutionRow,
  params: ClaimedNodeFailureParams,
): Promise<ClaimedNodeFailure> {
  const {
    currentAttempt,
    contextManifest,
    failureEvents,
    failureTokensUsed,
    error,
    allowRetries,
    dependencies,
    options,
  } = params;
  const errorMessage = toErrorMessage(error);
  const persistedNodeStatus = loadRunNodeExecutionRowById(db, run.id, node.runNodeId).status;
  let latestRunStatus = loadWorkflowRunRow(db, run.id).status;
  const retryEligible = allowRetries && persistedNodeStatus === 'running' && shouldRetryNodeAttempt(currentAttempt, node.maxRetries);
  let retryState = resolveRetryState(retryEligible, latestRunStatus);
  const retriesRemaining = Math.max(node.maxRetries - currentAttempt, 0);
  const failureReason = resolveFailureReason(persistedNodeStatus, retryState.canRetry);

  const artifactId = persistFailureArtifact(db, {
    workflowRunId: run.id,
    runNodeId: node.runNodeId,
    content: errorMessage,
    metadata: {
      success: false,
      provider: node.provider,
      nodeKey: node.nodeKey,
      attempt: currentAttempt,
      maxRetries: node.maxRetries,
      retriesRemaining,
      errorName: error instanceof Error ? error.name : 'Error',
      failureReason,
      nodeStatusAtFailure: persistedNodeStatus,
      ...contextManifest,
    },
  });

  if (persistedNodeStatus === 'running') {
    transitionRunNodeStatus(db, {
      runNodeId: node.runNodeId,
      expectedFrom: 'running',
      to: 'failed',
    });
  }

  let errorHandlerDiagnostics: RunNodeErrorHandlerDiagnostics | undefined;
  if (retryState.canRetry) {
    errorHandlerDiagnostics = await executeErrorHandlerForRetry(db, {
      run,
      node,
      currentAttempt,
      failureArtifactId: artifactId,
      errorMessage,
      failureEvents,
      dependencies,
      options,
    });
    latestRunStatus = loadWorkflowRunRow(db, run.id).status;
    retryState = resolveRetryState(retryEligible, latestRunStatus);
  } else if (retryEligible && isTerminalWorkflowRunStatus(latestRunStatus)) {
    errorHandlerDiagnostics = buildSkippedErrorHandlerDiagnostics(currentAttempt, null);
  }

  const persistedNode = loadRunNodeExecutionRowById(db, run.id, node.runNodeId);
  const diagnosticStatus: 'completed' | 'failed' = persistedNode.status === 'completed' ? 'completed' : 'failed';
  persistRunNodeAttemptDiagnostics(db, {
    workflowRunId: run.id,
    node,
    attempt: currentAttempt,
    outcome: 'failed',
    status: diagnosticStatus,
    runNodeSnapshot: persistedNode,
    contextManifest,
    tokensUsed: failureTokensUsed,
    events: failureEvents,
    routingDecision: null,
    error,
    errorHandler: errorHandlerDiagnostics,
  });

  if (retryState.canRetry) {
    const nextAttempt = currentAttempt + 1;
    if (retryState.canRetryImmediately) {
      transitionFailedRunNodeToRetryAttempt(db, {
        runNodeId: node.runNodeId,
        currentAttempt,
        nextAttempt,
      });
      return {
        artifactId,
        runStatus: latestRunStatus,
        runNodeStatus: 'failed',
        nextAttempt,
        nextStepOutcome: null,
      };
    }

    transitionFailedRunNodeToPendingAttempt(db, {
      runNodeId: node.runNodeId,
      currentAttempt,
      nextAttempt,
    });
    return {
      artifactId,
      runStatus: latestRunStatus,
      runNodeStatus: 'failed',
      nextAttempt: null,
      nextStepOutcome: 'blocked',
    };
  }

  if (retryEligible && isTerminalWorkflowRunStatus(latestRunStatus)) {
    return {
      artifactId,
      runStatus: latestRunStatus,
      runNodeStatus: 'failed',
      nextAttempt: null,
      nextStepOutcome: 'run_terminal',
    };
  }

  const runStatus = transitionRunToCurrentForExecutor(db, run.id, 'failed');
  let runNodeStatus: 'completed' | 'failed' = 'failed';
  if (persistedNode.status === 'completed') {
    runNodeStatus = 'completed';
  }

  return {
    artifactId,
    runStatus,
    runNodeStatus,
    nextAttempt: null,
    nextStepOutcome: null,
  };
}

export async function executeClaimedRunnableNode(
  params: {
    db: AlphredDatabase;
    dependencies: SqlWorkflowExecutorDependencies;
    run: WorkflowRunRow;
    node: RunNodeExecutionRow;
    edgeRows: EdgeRow[];
    options: ProviderRunOptions;
    runStatus: WorkflowRunStatus;
    executionOptions?: {
      allowRetries?: boolean;
    };
  },
): Promise<ExecuteNextRunnableNodeResult> {
  const {
    db,
    dependencies,
    run,
    node,
    edgeRows,
    options,
    runStatus,
    executionOptions = {},
  } = params;
  let currentRunStatus = runStatus;
  let currentAttempt = node.attempt;
  const allowRetries = executionOptions.allowRetries ?? true;

  while (true) {
    const latestNodeAttemptsForContext = getLatestRunNodeAttempts(loadRunNodeExecutionRows(db, run.id));
    const latestRoutingDecisionsForContext = loadLatestRoutingDecisionsByRunNodeId(db, run.id);
    const latestArtifactsForContext = loadLatestArtifactsByRunNodeId(db, run.id);
    const contextAssembly = assembleUpstreamArtifactContext(db, {
      workflowRunId: run.id,
      targetNode: node,
      targetAttempt: currentAttempt,
      latestNodeAttempts: latestNodeAttemptsForContext,
      edgeRows,
      latestRoutingDecisionsByRunNodeId: latestRoutingDecisionsForContext.latestByRunNodeId,
      latestArtifactsByRunNodeId: latestArtifactsForContext,
    });
    let nextEventSequence = resolveNextRunNodeStreamSequence(db, {
      workflowRunId: run.id,
      runNodeId: node.runNodeId,
      attempt: currentAttempt,
    });
    const streamUsageState: StreamUsageState = {
      cumulativeTokens: null,
    };

    try {
      const phaseResult = await executeNodePhase(
        node,
        options,
        contextAssembly.contextEntries,
        dependencies,
        async (event) => {
          const sequence = nextEventSequence;
          nextEventSequence += 1;
          persistRunNodeStreamEvent(db, {
            workflowRunId: run.id,
            runNodeId: node.runNodeId,
            attempt: currentAttempt,
            sequence,
            event,
            usageState: streamUsageState,
          });
        },
      );
      const success = handleClaimedNodeSuccess(
        db,
        run,
        node,
        edgeRows,
        {
          currentAttempt,
          contextManifest: contextAssembly.manifest,
          phaseResult,
        },
      );
      currentRunStatus = success.runStatus;
      return buildExecutedNodeResult(run, node, 'completed', currentRunStatus, success.artifactId);
    } catch (error) {
      const failureEvents = error instanceof PhaseRunError ? error.events : [];
      const failureTokensUsed = error instanceof PhaseRunError ? error.tokensUsed : 0;
      const failure = await handleClaimedNodeFailure(
        db,
        run,
        node,
        {
          currentAttempt,
          contextManifest: contextAssembly.manifest,
          failureEvents,
          failureTokensUsed,
          error,
          allowRetries,
          dependencies,
          options,
        },
      );
      if (failure.nextAttempt !== null) {
        currentAttempt = failure.nextAttempt;
        continue;
      }

      if (failure.nextStepOutcome !== null) {
        return {
          outcome: failure.nextStepOutcome,
          workflowRunId: run.id,
          runStatus: failure.runStatus,
        };
      }

      currentRunStatus = failure.runStatus;
      return buildExecutedNodeResult(run, node, failure.runNodeStatus, currentRunStatus, failure.artifactId);
    }
  }
}
