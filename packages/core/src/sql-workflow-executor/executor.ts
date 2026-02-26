import type { AlphredDatabase } from '@alphred/db';
import { runTerminalStatuses } from './constants.js';
import { executeClaimedRunnableNode } from './node-execution.js';
import { selectNextRunnableNode } from './node-selection.js';
import {
  loadEdgeRows,
  loadRunNodeExecutionRowById,
  loadRunNodeExecutionRows,
  loadWorkflowRunRow,
} from './persistence.js';
import { loadLatestArtifactsByRunNodeId, loadLatestRoutingDecisionsByRunNodeId } from './routing-selection.js';
import { applyWorkflowRunRetryControl, applyWorkflowRunStatusControl } from './run-control.js';
import {
  claimRunnableNode,
  ensureRunIsRunning,
  failRunOnIterationLimit,
  notifyRunTerminalTransition,
  resolveExecutionTerminalNotificationPreviousStatus,
  resolveNoRunnableOutcome,
  transitionRunToCurrentForExecutor,
} from './transitions.js';
import type {
  ExecuteNextRunnableNodeParams,
  ExecuteNextRunnableNodeResult,
  ExecuteSingleNodeRunParams,
  ExecuteWorkflowRunParams,
  ExecuteWorkflowRunResult,
  RunNodeExecutionRow,
  SqlWorkflowExecutor,
  SqlWorkflowExecutorDependencies,
  ValidateSingleNodeSelectionParams,
  WorkflowRunControlParams,
  WorkflowRunControlResult,
  WorkflowRunNodeSelector,
} from './types.js';
import { WorkflowRunExecutionValidationError } from './types.js';

const defaultNodeSelector: WorkflowRunNodeSelector = {
  type: 'next_runnable',
};

function normalizeNodeSelector(nodeSelector: WorkflowRunNodeSelector | undefined): WorkflowRunNodeSelector {
  if (!nodeSelector) {
    return defaultNodeSelector;
  }

  if (nodeSelector.type === 'node_key') {
    return {
      type: 'node_key',
      nodeKey: nodeSelector.nodeKey.trim(),
    };
  }

  return nodeSelector;
}

function throwSingleNodeNotExecutableError(
  workflowRunId: number,
  nodeSelector: WorkflowRunNodeSelector,
  message: string,
): never {
  throw new WorkflowRunExecutionValidationError('WORKFLOW_RUN_SINGLE_NODE_SELECTOR_NOT_EXECUTABLE', message, {
    workflowRunId,
    nodeSelector,
  });
}

function throwSingleNodeNotFoundError(workflowRunId: number, nodeSelector: WorkflowRunNodeSelector, message: string): never {
  throw new WorkflowRunExecutionValidationError('WORKFLOW_RUN_SINGLE_NODE_SELECTOR_NOT_FOUND', message, {
    workflowRunId,
    nodeSelector,
  });
}

function resolveSingleNodeTarget(params: {
  workflowRunId: number;
  nodeSelector: WorkflowRunNodeSelector;
  nextRunnableNode: RunNodeExecutionRow | null;
  latestNodeAttempts: RunNodeExecutionRow[];
  hasNoRouteDecision: boolean;
  hasUnresolvedDecision: boolean;
}): RunNodeExecutionRow {
  const nodeSelector = params.nodeSelector;
  if (nodeSelector.type === 'next_runnable') {
    if (params.nextRunnableNode) {
      return params.nextRunnableNode;
    }

    const reason =
      params.hasNoRouteDecision
        ? 'a prior node produced a no_route decision.'
        : params.hasUnresolvedDecision
          ? 'a prior node has an unresolved routing decision.'
          : 'no runnable node is currently available.';

    throwSingleNodeNotExecutableError(
      params.workflowRunId,
      nodeSelector,
      `Node selector "next_runnable" is not executable for workflow run id=${params.workflowRunId}: ${reason}`,
    );
  }

  if (nodeSelector.type !== 'node_key') {
    throwSingleNodeNotExecutableError(
      params.workflowRunId,
      nodeSelector,
      `Unsupported node selector type "${String((nodeSelector as { type?: unknown }).type)}".`,
    );
  }

  if (nodeSelector.nodeKey.length === 0) {
    throwSingleNodeNotExecutableError(
      params.workflowRunId,
      nodeSelector,
      'Node selector "node_key" requires a non-empty "nodeKey" value.',
    );
  }

  const targetNode = params.latestNodeAttempts.find(node => node.nodeKey === nodeSelector.nodeKey);
  if (!targetNode) {
    throwSingleNodeNotFoundError(
      params.workflowRunId,
      nodeSelector,
      `Node selector "node_key" did not match any node for key "${nodeSelector.nodeKey}" in workflow run id=${params.workflowRunId}.`,
    );
  }

  if (targetNode.status !== 'pending' && targetNode.status !== 'completed') {
    throwSingleNodeNotExecutableError(
      params.workflowRunId,
      nodeSelector,
      `Node selector "node_key" is not executable for key "${nodeSelector.nodeKey}" in workflow run id=${params.workflowRunId}; expected status "pending" or "completed" but found "${targetNode.status}".`,
    );
  }

  return targetNode;
}

export function createSqlWorkflowExecutor(
  db: AlphredDatabase,
  dependencies: SqlWorkflowExecutorDependencies,
): SqlWorkflowExecutor {
  return {
    validateSingleNodeSelection(params: ValidateSingleNodeSelectionParams): void {
      const nodeSelector = normalizeNodeSelector(params.nodeSelector);
      const run = loadWorkflowRunRow(db, params.workflowRunId);

      if (runTerminalStatuses.has(run.status)) {
        throwSingleNodeNotExecutableError(
          run.id,
          nodeSelector,
          `Workflow run id=${run.id} is already terminal with status "${run.status}".`,
        );
      }

      if (run.status === 'paused') {
        throwSingleNodeNotExecutableError(
          run.id,
          nodeSelector,
          `Workflow run id=${run.id} is paused and cannot execute a single node until resumed.`,
        );
      }

      const runNodeRows = loadRunNodeExecutionRows(db, run.id);
      const edgeRows = loadEdgeRows(db, run.workflowTreeId);
      const routingDecisionSelection = loadLatestRoutingDecisionsByRunNodeId(db, run.id);
      const latestArtifactsByRunNodeId = loadLatestArtifactsByRunNodeId(db, run.id);
      const { nextRunnableNode, latestNodeAttempts, hasNoRouteDecision, hasUnresolvedDecision } = selectNextRunnableNode(
        runNodeRows,
        edgeRows,
        routingDecisionSelection.latestByRunNodeId,
        latestArtifactsByRunNodeId,
      );

      resolveSingleNodeTarget({
        workflowRunId: run.id,
        nodeSelector,
        nextRunnableNode,
        latestNodeAttempts,
        hasNoRouteDecision,
        hasUnresolvedDecision,
      });
    },

    async executeSingleNode(params: ExecuteSingleNodeRunParams): Promise<ExecuteWorkflowRunResult> {
      const nodeSelector = normalizeNodeSelector(params.nodeSelector);
      const initialRun = loadWorkflowRunRow(db, params.workflowRunId);
      if (runTerminalStatuses.has(initialRun.status)) {
        return {
          workflowRunId: initialRun.id,
          executedNodes: 0,
          finalStep: {
            outcome: 'run_terminal',
            workflowRunId: initialRun.id,
            runStatus: initialRun.status,
          },
        };
      }

      const runNodeRows = loadRunNodeExecutionRows(db, initialRun.id);
      const edgeRows = loadEdgeRows(db, initialRun.workflowTreeId);
      const routingDecisionSelection = loadLatestRoutingDecisionsByRunNodeId(db, initialRun.id);
      const latestArtifactsByRunNodeId = loadLatestArtifactsByRunNodeId(db, initialRun.id);
      const { nextRunnableNode, latestNodeAttempts, hasNoRouteDecision, hasUnresolvedDecision } = selectNextRunnableNode(
        runNodeRows,
        edgeRows,
        routingDecisionSelection.latestByRunNodeId,
        latestArtifactsByRunNodeId,
      );

      const selectedNode = resolveSingleNodeTarget({
        workflowRunId: initialRun.id,
        nodeSelector,
        nextRunnableNode,
        latestNodeAttempts,
        hasNoRouteDecision,
        hasUnresolvedDecision,
      });

      const currentRun = loadWorkflowRunRow(db, initialRun.id);
      if (runTerminalStatuses.has(currentRun.status)) {
        const runTerminalResult: ExecuteNextRunnableNodeResult = {
          outcome: 'run_terminal',
          workflowRunId: currentRun.id,
          runStatus: currentRun.status,
        };
        await notifyRunTerminalTransition(dependencies, {
          workflowRunId: currentRun.id,
          previousRunStatus: resolveExecutionTerminalNotificationPreviousStatus(initialRun.status, runTerminalResult.runStatus),
          nextRunStatus: runTerminalResult.runStatus,
        });

        return {
          workflowRunId: currentRun.id,
          executedNodes: 0,
          finalStep: runTerminalResult,
        };
      }

      if (currentRun.status === 'paused') {
        throwSingleNodeNotExecutableError(
          currentRun.id,
          nodeSelector,
          `Workflow run id=${currentRun.id} is paused and cannot execute a single node until resumed.`,
        );
      }

      const runStatus = ensureRunIsRunning(db, currentRun);
      if (runStatus === 'paused') {
        return {
          workflowRunId: currentRun.id,
          executedNodes: 0,
          finalStep: {
            outcome: 'blocked',
            workflowRunId: currentRun.id,
            runStatus,
          },
        };
      }

      if (runTerminalStatuses.has(runStatus)) {
        const runTerminalResult: ExecuteNextRunnableNodeResult = {
          outcome: 'run_terminal',
          workflowRunId: currentRun.id,
          runStatus,
        };
        await notifyRunTerminalTransition(dependencies, {
          workflowRunId: currentRun.id,
          previousRunStatus: resolveExecutionTerminalNotificationPreviousStatus(
            currentRun.status,
            runTerminalResult.runStatus,
          ),
          nextRunStatus: runTerminalResult.runStatus,
        });

        return {
          workflowRunId: currentRun.id,
          executedNodes: 0,
          finalStep: runTerminalResult,
        };
      }

      const claimResult = claimRunnableNode(db, currentRun, selectedNode);
      if (claimResult) {
        if (claimResult.outcome === 'executed') {
          throw new Error('Internal error: claimRunnableNode cannot return outcome "executed".');
        }

        await notifyRunTerminalTransition(dependencies, {
          workflowRunId: currentRun.id,
          previousRunStatus: resolveExecutionTerminalNotificationPreviousStatus(currentRun.status, claimResult.runStatus),
          nextRunStatus: claimResult.runStatus,
        });

        return {
          workflowRunId: currentRun.id,
          executedNodes: 0,
          finalStep: claimResult,
        };
      }

      const claimedNode = loadRunNodeExecutionRowById(db, currentRun.id, selectedNode.runNodeId);
      const stepResult = await executeClaimedRunnableNode(
        db,
        dependencies,
        currentRun,
        claimedNode,
        edgeRows,
        params.options,
        runStatus,
        {
          allowRetries: false,
        },
      );

      if (stepResult.outcome !== 'executed') {
        await notifyRunTerminalTransition(dependencies, {
          workflowRunId: currentRun.id,
          previousRunStatus: resolveExecutionTerminalNotificationPreviousStatus(currentRun.status, stepResult.runStatus),
          nextRunStatus: stepResult.runStatus,
        });

        return {
          workflowRunId: currentRun.id,
          executedNodes: 0,
          finalStep: stepResult,
        };
      }

      const terminalStatus = transitionRunToCurrentForExecutor(
        db,
        currentRun.id,
        stepResult.runNodeStatus === 'failed' ? 'failed' : 'completed',
      );
      const finalStep: ExecuteWorkflowRunResult['finalStep'] = {
        outcome: 'run_terminal',
        workflowRunId: currentRun.id,
        runStatus: terminalStatus,
      };

      await notifyRunTerminalTransition(dependencies, {
        workflowRunId: currentRun.id,
        previousRunStatus: resolveExecutionTerminalNotificationPreviousStatus(currentRun.status, terminalStatus),
        nextRunStatus: terminalStatus,
      });

      return {
        workflowRunId: currentRun.id,
        executedNodes: 1,
        finalStep,
      };
    },

    async executeNextRunnableNode(params: ExecuteNextRunnableNodeParams): Promise<ExecuteNextRunnableNodeResult> {
      const initialRun = loadWorkflowRunRow(db, params.workflowRunId);
      if (runTerminalStatuses.has(initialRun.status)) {
        return {
          outcome: 'run_terminal',
          workflowRunId: initialRun.id,
          runStatus: initialRun.status,
        };
      }

      const runNodeRows = loadRunNodeExecutionRows(db, initialRun.id);
      const edgeRows = loadEdgeRows(db, initialRun.workflowTreeId);
      const routingDecisionSelection = loadLatestRoutingDecisionsByRunNodeId(db, initialRun.id);
      const latestArtifactsByRunNodeId = loadLatestArtifactsByRunNodeId(db, initialRun.id);
      const { nextRunnableNode, latestNodeAttempts, hasNoRouteDecision, hasUnresolvedDecision } = selectNextRunnableNode(
        runNodeRows,
        edgeRows,
        routingDecisionSelection.latestByRunNodeId,
        latestArtifactsByRunNodeId,
      );

      const currentRun = loadWorkflowRunRow(db, initialRun.id);
      if (runTerminalStatuses.has(currentRun.status)) {
        const runTerminalResult: ExecuteNextRunnableNodeResult = {
          outcome: 'run_terminal',
          workflowRunId: currentRun.id,
          runStatus: currentRun.status,
        };
        await notifyRunTerminalTransition(dependencies, {
          workflowRunId: currentRun.id,
          previousRunStatus: resolveExecutionTerminalNotificationPreviousStatus(
            initialRun.status,
            runTerminalResult.runStatus,
          ),
          nextRunStatus: runTerminalResult.runStatus,
        });
        return runTerminalResult;
      }

      if (nextRunnableNode && currentRun.status === 'paused') {
        return {
          outcome: 'blocked',
          workflowRunId: currentRun.id,
          runStatus: currentRun.status,
        };
      }

      if (!nextRunnableNode) {
        const result = resolveNoRunnableOutcome(
          db,
          currentRun,
          latestNodeAttempts,
          hasNoRouteDecision,
          hasUnresolvedDecision,
        );
        await notifyRunTerminalTransition(dependencies, {
          workflowRunId: currentRun.id,
          previousRunStatus: resolveExecutionTerminalNotificationPreviousStatus(currentRun.status, result.runStatus),
          nextRunStatus: result.runStatus,
        });
        return result;
      }

      const runStatus = ensureRunIsRunning(db, currentRun);
      if (runStatus === 'paused') {
        return {
          outcome: 'blocked',
          workflowRunId: currentRun.id,
          runStatus,
        };
      }

      if (runTerminalStatuses.has(runStatus)) {
        const runTerminalResult: ExecuteNextRunnableNodeResult = {
          outcome: 'run_terminal',
          workflowRunId: currentRun.id,
          runStatus,
        };
        await notifyRunTerminalTransition(dependencies, {
          workflowRunId: currentRun.id,
          previousRunStatus: resolveExecutionTerminalNotificationPreviousStatus(
            currentRun.status,
            runTerminalResult.runStatus,
          ),
          nextRunStatus: runTerminalResult.runStatus,
        });
        return runTerminalResult;
      }

      const claimResult = claimRunnableNode(db, currentRun, nextRunnableNode);
      if (claimResult) {
        await notifyRunTerminalTransition(dependencies, {
          workflowRunId: currentRun.id,
          previousRunStatus: resolveExecutionTerminalNotificationPreviousStatus(currentRun.status, claimResult.runStatus),
          nextRunStatus: claimResult.runStatus,
        });
        return claimResult;
      }

      const claimedNode = loadRunNodeExecutionRowById(db, currentRun.id, nextRunnableNode.runNodeId);
      const result = await executeClaimedRunnableNode(
        db,
        dependencies,
        currentRun,
        claimedNode,
        edgeRows,
        params.options,
        runStatus,
      );
      await notifyRunTerminalTransition(dependencies, {
        workflowRunId: currentRun.id,
        previousRunStatus: resolveExecutionTerminalNotificationPreviousStatus(currentRun.status, result.runStatus),
        nextRunStatus: result.runStatus,
      });
      return result;
    },

    async executeRun(params: ExecuteWorkflowRunParams): Promise<ExecuteWorkflowRunResult> {
      const maxSteps = params.maxSteps ?? 1000;
      if (maxSteps <= 0) {
        throw new Error('maxSteps must be greater than zero.');
      }

      let executedNodes = 0;
      while (executedNodes < maxSteps) {
        const stepResult = await this.executeNextRunnableNode({
          workflowRunId: params.workflowRunId,
          options: params.options,
        });

        if (stepResult.outcome !== 'executed') {
          return {
            workflowRunId: params.workflowRunId,
            executedNodes,
            finalStep: stepResult,
          };
        }

        executedNodes += 1;
        if (runTerminalStatuses.has(stepResult.runStatus) || stepResult.runNodeStatus !== 'completed') {
          const finalOutcome: ExecuteWorkflowRunResult['finalStep'] = {
            outcome: 'run_terminal',
            workflowRunId: params.workflowRunId,
            runStatus: stepResult.runStatus,
          };
          return {
            workflowRunId: params.workflowRunId,
            executedNodes,
            finalStep: finalOutcome,
          };
        }
      }

      const run = loadWorkflowRunRow(db, params.workflowRunId);
      const runStatus = failRunOnIterationLimit(db, run, {
        maxSteps,
        executedNodes,
      });
      return {
        workflowRunId: params.workflowRunId,
        executedNodes,
        finalStep: {
          outcome: 'run_terminal',
          workflowRunId: params.workflowRunId,
          runStatus,
        },
      };
    },

    async cancelRun(params: WorkflowRunControlParams): Promise<WorkflowRunControlResult> {
      const result = applyWorkflowRunStatusControl(db, {
        action: 'cancel',
        workflowRunId: params.workflowRunId,
        targetStatus: 'cancelled',
        allowedFrom: new Set(['pending', 'running', 'paused']),
        noopStatuses: new Set(['cancelled']),
        invalidTransitionMessage: status =>
          `Cannot cancel workflow run id=${params.workflowRunId} from status "${status}". Expected pending, running, or paused.`,
      });
      await notifyRunTerminalTransition(dependencies, {
        workflowRunId: result.workflowRunId,
        previousRunStatus: result.previousRunStatus,
        nextRunStatus: result.runStatus,
      });
      return result;
    },

    async pauseRun(params: WorkflowRunControlParams): Promise<WorkflowRunControlResult> {
      return applyWorkflowRunStatusControl(db, {
        action: 'pause',
        workflowRunId: params.workflowRunId,
        targetStatus: 'paused',
        allowedFrom: new Set(['running']),
        noopStatuses: new Set(['paused']),
        invalidTransitionMessage: status =>
          `Cannot pause workflow run id=${params.workflowRunId} from status "${status}". Expected status "running".`,
      });
    },

    async resumeRun(params: WorkflowRunControlParams): Promise<WorkflowRunControlResult> {
      return applyWorkflowRunStatusControl(db, {
        action: 'resume',
        workflowRunId: params.workflowRunId,
        targetStatus: 'running',
        allowedFrom: new Set(['paused']),
        noopStatuses: new Set(['running']),
        invalidTransitionMessage: status =>
          `Cannot resume workflow run id=${params.workflowRunId} from status "${status}". Expected status "paused".`,
      });
    },

    async retryRun(params: WorkflowRunControlParams): Promise<WorkflowRunControlResult> {
      return applyWorkflowRunRetryControl(db, params);
    },
  };
}
