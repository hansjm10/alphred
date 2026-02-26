import { transitionRunNodeStatus, type AlphredDatabase, type RunNodeStatus, type WorkflowRunStatus } from '@alphred/db';
import type {
  AgentProviderName,
  PhaseDefinition,
  ProviderEvent,
  ProviderRunOptions,
} from '@alphred/shared';
import { PhaseRunError, runPhase } from '../phaseRunner.js';
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
import { getLatestRunNodeAttempts } from './type-conversions.js';
import type {
  ContextHandoffManifest,
  EdgeRow,
  ExecuteNextRunnableNodeResult,
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
  const nodeExecutionPermissions = normalizeRunNodeExecutionPermissions(node.executionPermissions, node.nodeKey);
  const mergedExecutionPermissions = mergeExecutionPermissions(
    optionsWithContext.executionPermissions,
    nodeExecutionPermissions,
  );
  const optionsWithExecutionPermissions =
    mergedExecutionPermissions === undefined
      ? optionsWithContext
      : {
          ...optionsWithContext,
          executionPermissions: mergedExecutionPermissions,
        };
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

export function handleClaimedNodeFailure(
  db: AlphredDatabase,
  run: WorkflowRunRow,
  node: RunNodeExecutionRow,
  params: ClaimedNodeFailureParams,
): ClaimedNodeFailure {
  const { currentAttempt, contextManifest, failureEvents, failureTokensUsed, error, allowRetries } = params;
  const errorMessage = toErrorMessage(error);
  const persistedNodeStatus = loadRunNodeExecutionRowById(db, run.id, node.runNodeId).status;
  const latestRunStatus = loadWorkflowRunRow(db, run.id).status;
  const retryEligible = allowRetries && persistedNodeStatus === 'running' && shouldRetryNodeAttempt(currentAttempt, node.maxRetries);
  const canRetryImmediately = retryEligible && latestRunStatus === 'running';
  const shouldDeferRetry = retryEligible && latestRunStatus === 'paused';
  const canRetry = canRetryImmediately || shouldDeferRetry;
  const retriesRemaining = Math.max(node.maxRetries - currentAttempt, 0);
  const failureReason = resolveFailureReason(persistedNodeStatus, canRetry);

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
  });

  if (canRetry) {
    const nextAttempt = currentAttempt + 1;
    if (canRetryImmediately) {
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
      const failure = handleClaimedNodeFailure(
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
