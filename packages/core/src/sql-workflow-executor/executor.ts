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
} from './transitions.js';
import type {
  ExecuteNextRunnableNodeParams,
  ExecuteNextRunnableNodeResult,
  ExecuteWorkflowRunParams,
  ExecuteWorkflowRunResult,
  SqlWorkflowExecutor,
  SqlWorkflowExecutorDependencies,
  WorkflowRunControlParams,
  WorkflowRunControlResult,
} from './types.js';

export function createSqlWorkflowExecutor(
  db: AlphredDatabase,
  dependencies: SqlWorkflowExecutorDependencies,
): SqlWorkflowExecutor {
  return {
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
          previousRunStatus: resolveExecutionTerminalNotificationPreviousStatus(
            currentRun.status,
            result.runStatus,
          ),
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
          previousRunStatus: resolveExecutionTerminalNotificationPreviousStatus(
            currentRun.status,
            claimResult.runStatus,
          ),
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
        previousRunStatus: resolveExecutionTerminalNotificationPreviousStatus(
          currentRun.status,
          result.runStatus,
        ),
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
