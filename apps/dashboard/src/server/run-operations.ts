import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { WorkflowRunControlError, WorkflowRunExecutionValidationError, type PhaseProviderResolver } from '@alphred/core';
import {
  getRepositoryByName,
  listRunWorktreesForRun,
  phaseArtifacts,
  repositories as repositoryTable,
  runNodeDiagnostics,
  runNodeStreamEvents,
  routingDecisions,
  runNodes,
  runWorktrees,
  workflowRuns,
  workflowTrees,
  type AlphredDatabase,
} from '@alphred/db';
import type { WorktreeManager } from '@alphred/git';
import type { BackgroundExecutionManager } from './background-execution';
import type {
  DashboardRunControlAction,
  DashboardRunControlResult,
  DashboardRunDetail,
  DashboardRunLaunchRequest,
  DashboardRunLaunchResult,
  DashboardRunNodeDiagnosticsSnapshot,
  DashboardRunNodeSnapshot,
  DashboardRunSummary,
  DashboardRunNodeStreamSnapshot,
  DashboardRunWorktreeMetadata,
  DashboardArtifactSnapshot,
  DashboardRoutingDecisionSnapshot,
  DashboardNodeStatus,
} from './dashboard-contracts';
import { DashboardIntegrationError } from './dashboard-errors';
import {
  createArtifactSnapshot,
  createRoutingDecisionSnapshot,
  createRunNodeDiagnosticsSnapshot,
  createRunNodeStreamEventSnapshot,
  toWorktreeMetadata,
} from './dashboard-snapshots';
import {
  isTerminalNodeStatus,
  selectLatestNodeAttempts,
  summarizeNodeStatuses,
  toDashboardRunControlConflictError,
  type RunStatus,
} from './dashboard-utils';
import { ensureRepositoryAuth, type RepositoryOperationsDependencies } from './repository-operations';

const BACKGROUND_RUN_STATUS: RunStatus = 'running';
const RECENT_SNAPSHOT_LIMIT = 30;
const MAX_STREAM_SNAPSHOT_EVENTS = 500;

type WithDatabase = <T>(operation: (db: AlphredDatabase) => Promise<T> | T) => Promise<T>;

type RunOperationsDependencies = {
  createSqlWorkflowPlanner: (db: AlphredDatabase) => {
    materializeRun: (params: { treeKey: string }) => {
      run: {
        id: number;
      };
    };
  };
  createSqlWorkflowExecutor: (
    db: AlphredDatabase,
    dependencies: {
      resolveProvider: PhaseProviderResolver;
    },
  ) => {
    cancelRun: (params: { workflowRunId: number }) => Promise<{
      action: string;
      outcome: string;
      workflowRunId: number;
      previousRunStatus: string;
      runStatus: string;
      retriedRunNodeIds: readonly number[];
    }>;
    pauseRun: (params: { workflowRunId: number }) => Promise<{
      action: string;
      outcome: string;
      workflowRunId: number;
      previousRunStatus: string;
      runStatus: string;
      retriedRunNodeIds: readonly number[];
    }>;
    resumeRun: (params: { workflowRunId: number }) => Promise<{
      action: string;
      outcome: string;
      workflowRunId: number;
      previousRunStatus: string;
      runStatus: string;
      retriedRunNodeIds: readonly number[];
    }>;
    retryRun: (params: { workflowRunId: number }) => Promise<{
      action: string;
      outcome: string;
      workflowRunId: number;
      previousRunStatus: string;
      runStatus: string;
      retriedRunNodeIds: readonly number[];
    }>;
  };
  resolveProvider: PhaseProviderResolver;
  createWorktreeManager: (db: AlphredDatabase, environment: NodeJS.ProcessEnv) => Pick<
    WorktreeManager,
    'createRunWorktree' | 'cleanupRun'
  >;
};

export type RunOperations = {
  listWorkflowRuns: (limit?: number) => Promise<DashboardRunSummary[]>;
  getWorkflowRunDetail: (runId: number) => Promise<DashboardRunDetail>;
  getRunNodeStreamSnapshot: (params: {
    runId: number;
    runNodeId: number;
    attempt: number;
    lastEventSequence?: number;
    limit?: number;
  }) => Promise<DashboardRunNodeStreamSnapshot>;
  getRunWorktrees: (runId: number) => Promise<DashboardRunWorktreeMetadata[]>;
  launchWorkflowRun: (request: DashboardRunLaunchRequest) => Promise<DashboardRunLaunchResult>;
  controlWorkflowRun: (runId: number, action: DashboardRunControlAction) => Promise<DashboardRunControlResult>;
  getBackgroundExecutionCount: () => number;
  hasBackgroundExecution: (runId: number) => boolean;
};

function normalizeLaunchNodeSelector(
  executionScope: DashboardRunLaunchRequest['executionScope'],
  nodeSelector: DashboardRunLaunchRequest['nodeSelector'],
): DashboardRunLaunchRequest['nodeSelector'] {
  if (nodeSelector === undefined) {
    return undefined;
  }

  if (executionScope !== 'single_node') {
    throw new DashboardIntegrationError('invalid_request', 'nodeSelector requires executionScope "single_node".', {
      status: 400,
    });
  }

  if (nodeSelector.type === 'next_runnable') {
    return { type: 'next_runnable' };
  }

  if (nodeSelector.type === 'node_key') {
    const normalizedNodeKey = nodeSelector.nodeKey.trim();
    if (normalizedNodeKey.length === 0) {
      throw new DashboardIntegrationError('invalid_request', 'nodeSelector.nodeKey cannot be empty.', {
        status: 400,
      });
    }
    return {
      type: 'node_key',
      nodeKey: normalizedNodeKey,
    };
  }

  throw new DashboardIntegrationError('invalid_request', 'nodeSelector.type must be "next_runnable" or "node_key".', {
    status: 400,
  });
}

async function loadRunSummary(db: AlphredDatabase, runId: number): Promise<DashboardRunSummary> {
  const run = db
    .select({
      id: workflowRuns.id,
      workflowTreeId: workflowRuns.workflowTreeId,
      status: workflowRuns.status,
      startedAt: workflowRuns.startedAt,
      completedAt: workflowRuns.completedAt,
      createdAt: workflowRuns.createdAt,
    })
    .from(workflowRuns)
    .where(eq(workflowRuns.id, runId))
    .get();

  if (!run) {
    throw new DashboardIntegrationError('not_found', `Workflow run id=${runId} was not found.`, {
      status: 404,
    });
  }

  const tree = db
    .select({
      id: workflowTrees.id,
      treeKey: workflowTrees.treeKey,
      version: workflowTrees.version,
      name: workflowTrees.name,
    })
    .from(workflowTrees)
    .where(eq(workflowTrees.id, run.workflowTreeId))
    .get();

  if (!tree) {
    throw new DashboardIntegrationError(
      'internal_error',
      `Workflow tree id=${run.workflowTreeId} referenced by run id=${run.id} was not found.`,
      { status: 500 },
    );
  }

  const runNodeRows = db
    .select({
      id: runNodes.id,
      nodeKey: runNodes.nodeKey,
      attempt: runNodes.attempt,
      sequenceIndex: runNodes.sequenceIndex,
      treeNodeId: runNodes.treeNodeId,
      status: runNodes.status,
      startedAt: runNodes.startedAt,
      completedAt: runNodes.completedAt,
    })
    .from(runNodes)
    .where(eq(runNodes.workflowRunId, run.id))
    .orderBy(asc(runNodes.sequenceIndex), asc(runNodes.id))
    .all();

  const latestNodes = selectLatestNodeAttempts(runNodeRows);
  const repositoryContextRows = db
    .select({
      repositoryId: runWorktrees.repositoryId,
      repositoryName: repositoryTable.name,
      worktreeStatus: runWorktrees.status,
    })
    .from(runWorktrees)
    .innerJoin(repositoryTable, eq(runWorktrees.repositoryId, repositoryTable.id))
    .where(eq(runWorktrees.workflowRunId, run.id))
    .orderBy(asc(runWorktrees.createdAt), asc(runWorktrees.id))
    .all();

  const repositoryContext =
    repositoryContextRows.find(row => row.worktreeStatus === 'active') ??
    repositoryContextRows[repositoryContextRows.length - 1];

  return {
    id: run.id,
    tree,
    repository: repositoryContext
      ? {
          id: repositoryContext.repositoryId,
          name: repositoryContext.repositoryName,
        }
      : null,
    status: run.status as RunStatus,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    createdAt: run.createdAt,
    nodeSummary: summarizeNodeStatuses(latestNodes),
  };
}

export function createRunOperations(params: {
  withDatabase: WithDatabase;
  dependencies: RunOperationsDependencies;
  environment: NodeJS.ProcessEnv;
  cwd: string;
  repositoryAuthDependencies: Pick<RepositoryOperationsDependencies, 'createScmProvider'>;
  backgroundExecution: BackgroundExecutionManager;
}): RunOperations {
  const {
    withDatabase,
    dependencies,
    environment,
    cwd,
    repositoryAuthDependencies,
    backgroundExecution,
  } = params;

  return {
    listWorkflowRuns(limit = 20): Promise<DashboardRunSummary[]> {
      if (!Number.isInteger(limit) || limit < 1) {
        throw new DashboardIntegrationError('invalid_request', 'Limit must be a positive integer.', {
          status: 400,
        });
      }

      return withDatabase(async db => {
        const runIds = db
          .select({ id: workflowRuns.id })
          .from(workflowRuns)
          .orderBy(desc(workflowRuns.id))
          .limit(limit)
          .all();

        const summaries: DashboardRunSummary[] = [];
        for (const run of runIds) {
          summaries.push(await loadRunSummary(db, run.id));
        }

        return summaries;
      });
    },

    getWorkflowRunDetail(runId: number): Promise<DashboardRunDetail> {
      if (!Number.isInteger(runId) || runId < 1) {
        throw new DashboardIntegrationError('invalid_request', 'Run id must be a positive integer.', {
          status: 400,
        });
      }

      return withDatabase(async db => {
        const summary = await loadRunSummary(db, runId);
        const runNodeRows = db
          .select({
            id: runNodes.id,
            nodeKey: runNodes.nodeKey,
            attempt: runNodes.attempt,
            sequenceIndex: runNodes.sequenceIndex,
            treeNodeId: runNodes.treeNodeId,
            status: runNodes.status,
            startedAt: runNodes.startedAt,
            completedAt: runNodes.completedAt,
          })
          .from(runNodes)
          .where(eq(runNodes.workflowRunId, runId))
          .orderBy(asc(runNodes.sequenceIndex), asc(runNodes.id))
          .all();

        const latestNodes = selectLatestNodeAttempts(runNodeRows);

        const recentArtifacts = db
          .select({
            id: phaseArtifacts.id,
            runNodeId: phaseArtifacts.runNodeId,
            artifactType: phaseArtifacts.artifactType,
            contentType: phaseArtifacts.contentType,
            content: phaseArtifacts.content,
            createdAt: phaseArtifacts.createdAt,
          })
          .from(phaseArtifacts)
          .where(eq(phaseArtifacts.workflowRunId, runId))
          .orderBy(desc(phaseArtifacts.createdAt), desc(phaseArtifacts.id))
          .limit(RECENT_SNAPSHOT_LIMIT)
          .all();

        const recentDecisions = db
          .select({
            id: routingDecisions.id,
            runNodeId: routingDecisions.runNodeId,
            decisionType: routingDecisions.decisionType,
            rationale: routingDecisions.rationale,
            createdAt: routingDecisions.createdAt,
          })
          .from(routingDecisions)
          .where(eq(routingDecisions.workflowRunId, runId))
          .orderBy(desc(routingDecisions.createdAt), desc(routingDecisions.id))
          .limit(RECENT_SNAPSHOT_LIMIT)
          .all();

        const recentDiagnostics = db
          .select({
            id: runNodeDiagnostics.id,
            workflowRunId: runNodeDiagnostics.workflowRunId,
            runNodeId: runNodeDiagnostics.runNodeId,
            attempt: runNodeDiagnostics.attempt,
            outcome: runNodeDiagnostics.outcome,
            eventCount: runNodeDiagnostics.eventCount,
            retainedEventCount: runNodeDiagnostics.retainedEventCount,
            droppedEventCount: runNodeDiagnostics.droppedEventCount,
            redacted: runNodeDiagnostics.redacted,
            truncated: runNodeDiagnostics.truncated,
            payloadChars: runNodeDiagnostics.payloadChars,
            diagnostics: runNodeDiagnostics.diagnostics,
            createdAt: runNodeDiagnostics.createdAt,
          })
          .from(runNodeDiagnostics)
          .where(eq(runNodeDiagnostics.workflowRunId, runId))
          .orderBy(desc(runNodeDiagnostics.createdAt), desc(runNodeDiagnostics.id))
          .limit(RECENT_SNAPSHOT_LIMIT)
          .all();

        const latestArtifactByRunNodeId = new Map<number, DashboardArtifactSnapshot>();
        for (const artifact of recentArtifacts) {
          if (!latestArtifactByRunNodeId.has(artifact.runNodeId)) {
            latestArtifactByRunNodeId.set(artifact.runNodeId, createArtifactSnapshot(artifact));
          }
        }

        const latestDecisionByRunNodeId = new Map<number, DashboardRoutingDecisionSnapshot>();
        for (const decision of recentDecisions) {
          if (!latestDecisionByRunNodeId.has(decision.runNodeId)) {
            latestDecisionByRunNodeId.set(decision.runNodeId, createRoutingDecisionSnapshot(decision));
          }
        }

        const recentDiagnosticsSnapshots = recentDiagnostics.map(createRunNodeDiagnosticsSnapshot);
        const latestDiagnosticsByRunNodeId = new Map<number, DashboardRunNodeDiagnosticsSnapshot>();
        for (const diagnostics of recentDiagnosticsSnapshots) {
          if (!latestDiagnosticsByRunNodeId.has(diagnostics.runNodeId)) {
            latestDiagnosticsByRunNodeId.set(diagnostics.runNodeId, diagnostics);
          }
        }

        const nodes: DashboardRunNodeSnapshot[] = latestNodes.map(node => ({
          ...node,
          latestArtifact: latestArtifactByRunNodeId.get(node.id) ?? null,
          latestRoutingDecision: latestDecisionByRunNodeId.get(node.id) ?? null,
          latestDiagnostics: latestDiagnosticsByRunNodeId.get(node.id) ?? null,
        }));

        const allRunWorktrees = db
          .select({
            id: runWorktrees.id,
            workflowRunId: runWorktrees.workflowRunId,
            repositoryId: runWorktrees.repositoryId,
            worktreePath: runWorktrees.worktreePath,
            branch: runWorktrees.branch,
            commitHash: runWorktrees.commitHash,
            status: runWorktrees.status,
            createdAt: runWorktrees.createdAt,
            removedAt: runWorktrees.removedAt,
          })
          .from(runWorktrees)
          .where(eq(runWorktrees.workflowRunId, runId))
          .orderBy(asc(runWorktrees.createdAt), asc(runWorktrees.id))
          .all();

        return {
          run: summary,
          nodes,
          artifacts: recentArtifacts.map(createArtifactSnapshot),
          routingDecisions: recentDecisions.map(createRoutingDecisionSnapshot),
          diagnostics: recentDiagnosticsSnapshots,
          worktrees: allRunWorktrees.map(toWorktreeMetadata),
        };
      });
    },

    getRunNodeStreamSnapshot(params: {
      runId: number;
      runNodeId: number;
      attempt: number;
      lastEventSequence?: number;
      limit?: number;
    }): Promise<DashboardRunNodeStreamSnapshot> {
      if (!Number.isInteger(params.runId) || params.runId < 1) {
        throw new DashboardIntegrationError('invalid_request', 'Run id must be a positive integer.', {
          status: 400,
        });
      }

      if (!Number.isInteger(params.runNodeId) || params.runNodeId < 1) {
        throw new DashboardIntegrationError('invalid_request', 'Run node id must be a positive integer.', {
          status: 400,
        });
      }

      if (!Number.isInteger(params.attempt) || params.attempt < 1) {
        throw new DashboardIntegrationError('invalid_request', 'Attempt must be a positive integer.', {
          status: 400,
        });
      }

      const resumeFromSequence = params.lastEventSequence ?? 0;
      if (!Number.isInteger(resumeFromSequence) || resumeFromSequence < 0) {
        throw new DashboardIntegrationError('invalid_request', 'lastEventSequence must be a non-negative integer.', {
          status: 400,
        });
      }

      const limit = params.limit ?? MAX_STREAM_SNAPSHOT_EVENTS;
      if (!Number.isInteger(limit) || limit < 1) {
        throw new DashboardIntegrationError('invalid_request', 'Limit must be a positive integer.', {
          status: 400,
        });
      }

      const boundedLimit = Math.min(limit, MAX_STREAM_SNAPSHOT_EVENTS);

      return withDatabase(async db => {
        const run = db
          .select({
            id: workflowRuns.id,
            status: workflowRuns.status,
          })
          .from(workflowRuns)
          .where(eq(workflowRuns.id, params.runId))
          .get();

        if (!run) {
          throw new DashboardIntegrationError('not_found', `Workflow run ${params.runId} was not found.`, {
            status: 404,
          });
        }

        const runNode = db
          .select({
            id: runNodes.id,
            status: runNodes.status,
            attempt: runNodes.attempt,
          })
          .from(runNodes)
          .where(and(eq(runNodes.id, params.runNodeId), eq(runNodes.workflowRunId, params.runId)))
          .get();

        if (!runNode) {
          throw new DashboardIntegrationError(
            'not_found',
            `Run node ${params.runNodeId} was not found in run ${params.runId}.`,
            { status: 404 },
          );
        }

        if (params.attempt > runNode.attempt) {
          throw new DashboardIntegrationError(
            'not_found',
            `Run node ${params.runNodeId} does not have attempt ${params.attempt}.`,
            { status: 404 },
          );
        }

        let nodeStatus: DashboardNodeStatus;
        if (params.attempt === runNode.attempt) {
          nodeStatus = runNode.status as DashboardNodeStatus;
        } else {
          const historicalAttempt = db
            .select({
              status: runNodeDiagnostics.outcome,
            })
            .from(runNodeDiagnostics)
            .where(
              and(
                eq(runNodeDiagnostics.workflowRunId, params.runId),
                eq(runNodeDiagnostics.runNodeId, params.runNodeId),
                eq(runNodeDiagnostics.attempt, params.attempt),
              ),
            )
            .orderBy(desc(runNodeDiagnostics.createdAt), desc(runNodeDiagnostics.id))
            .limit(1)
            .get();
          nodeStatus = (historicalAttempt?.status as DashboardNodeStatus | undefined) ?? 'failed';
        }

        const latestEvent = db
          .select({
            sequence: runNodeStreamEvents.sequence,
          })
          .from(runNodeStreamEvents)
          .where(
            and(
              eq(runNodeStreamEvents.workflowRunId, params.runId),
              eq(runNodeStreamEvents.runNodeId, params.runNodeId),
              eq(runNodeStreamEvents.attempt, params.attempt),
            ),
          )
          .orderBy(desc(runNodeStreamEvents.sequence), desc(runNodeStreamEvents.id))
          .limit(1)
          .get();

        const events = db
          .select({
            id: runNodeStreamEvents.id,
            workflowRunId: runNodeStreamEvents.workflowRunId,
            runNodeId: runNodeStreamEvents.runNodeId,
            attempt: runNodeStreamEvents.attempt,
            sequence: runNodeStreamEvents.sequence,
            eventType: runNodeStreamEvents.eventType,
            timestamp: runNodeStreamEvents.timestamp,
            contentChars: runNodeStreamEvents.contentChars,
            contentPreview: runNodeStreamEvents.contentPreview,
            metadata: runNodeStreamEvents.metadata,
            usageDeltaTokens: runNodeStreamEvents.usageDeltaTokens,
            usageCumulativeTokens: runNodeStreamEvents.usageCumulativeTokens,
            createdAt: runNodeStreamEvents.createdAt,
          })
          .from(runNodeStreamEvents)
          .where(
            and(
              eq(runNodeStreamEvents.workflowRunId, params.runId),
              eq(runNodeStreamEvents.runNodeId, params.runNodeId),
              eq(runNodeStreamEvents.attempt, params.attempt),
              sql`${runNodeStreamEvents.sequence} > ${resumeFromSequence}`,
            ),
          )
          .orderBy(asc(runNodeStreamEvents.sequence), asc(runNodeStreamEvents.id))
          .limit(boundedLimit)
          .all()
          .map(createRunNodeStreamEventSnapshot);

        const runIsTerminal = run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled';
        const ended =
          params.attempt < runNode.attempt || isTerminalNodeStatus(nodeStatus) || (runIsTerminal && nodeStatus !== 'running');

        return {
          workflowRunId: params.runId,
          runNodeId: params.runNodeId,
          attempt: params.attempt,
          nodeStatus,
          ended,
          latestSequence: latestEvent?.sequence ?? 0,
          events,
        };
      });
    },

    getRunWorktrees(runId: number): Promise<DashboardRunWorktreeMetadata[]> {
      if (!Number.isInteger(runId) || runId < 1) {
        throw new DashboardIntegrationError('invalid_request', 'Run id must be a positive integer.', {
          status: 400,
        });
      }

      return withDatabase(async db => listRunWorktreesForRun(db, runId).map(toWorktreeMetadata));
    },

    launchWorkflowRun(request: DashboardRunLaunchRequest): Promise<DashboardRunLaunchResult> {
      const treeKey = request.treeKey.trim();
      if (treeKey.length === 0) {
        throw new DashboardIntegrationError('invalid_request', 'treeKey cannot be empty.', {
          status: 400,
        });
      }

      const repositoryName = request.repositoryName?.trim();
      if (request.repositoryName !== undefined && repositoryName?.length === 0) {
        throw new DashboardIntegrationError('invalid_request', 'repositoryName cannot be empty when provided.', {
          status: 400,
        });
      }

      const executionMode = request.executionMode ?? 'async';
      if (executionMode !== 'async' && executionMode !== 'sync') {
        throw new DashboardIntegrationError('invalid_request', 'executionMode must be "async" or "sync".', {
          status: 400,
        });
      }

      const executionScope = request.executionScope ?? 'full';
      if (executionScope !== 'full' && executionScope !== 'single_node') {
        throw new DashboardIntegrationError('invalid_request', 'executionScope must be "full" or "single_node".', {
          status: 400,
        });
      }
      const nodeSelector = normalizeLaunchNodeSelector(executionScope, request.nodeSelector);

      return withDatabase(async db => {
        const planner = dependencies.createSqlWorkflowPlanner(db);
        const materializedRun = planner.materializeRun({ treeKey });

        const workflowRunId = materializedRun.run.id;
        const runId = workflowRunId;
        let workingDirectory = cwd;
        let worktreeManager: Pick<WorktreeManager, 'createRunWorktree' | 'cleanupRun'> | null = null;

        try {
          if (repositoryName !== undefined) {
            const repository = getRepositoryByName(db, repositoryName);
            if (!repository) {
              throw new DashboardIntegrationError(
                'not_found',
                `Repository "${repositoryName}" was not found.`,
                { status: 404 },
              );
            }

            await ensureRepositoryAuth(repository, repositoryAuthDependencies, environment);

            worktreeManager = dependencies.createWorktreeManager(db, environment);
            const createdWorktree = await worktreeManager.createRunWorktree({
              repoName: repository.name,
              treeKey,
              runId,
              branch: request.branch?.trim() || undefined,
            });
            workingDirectory = createdWorktree.path;
          }

          if (executionMode === 'sync') {
            const execution = await backgroundExecution.executeWorkflowRun(
              db,
              runId,
              workingDirectory,
              worktreeManager,
              request.cleanupWorktree ?? false,
              executionScope,
              nodeSelector,
            );

            return {
              workflowRunId,
              mode: 'sync',
              status: 'completed',
              runStatus: execution.runStatus,
              executionOutcome: execution.executionOutcome,
              executedNodes: execution.executedNodes,
            };
          }

          if (executionScope === 'single_node') {
            backgroundExecution.validateSingleNodeSelection(db, runId, nodeSelector);
          }

          backgroundExecution.enqueueBackgroundRunExecution({
            runId,
            workingDirectory,
            hasManagedWorktree: worktreeManager !== null,
            cleanupWorktree: request.cleanupWorktree ?? false,
            executionScope,
            nodeSelector,
          });

          return {
            workflowRunId,
            mode: 'async',
            status: 'accepted',
            runStatus: BACKGROUND_RUN_STATUS,
            executionOutcome: null,
            executedNodes: null,
          };
        } catch (error) {
          await backgroundExecution.markPendingRunCancelled(db, workflowRunId);
          if (error instanceof WorkflowRunExecutionValidationError) {
            throw new DashboardIntegrationError('invalid_request', error.message, {
              status: 400,
              details: {
                code: error.code,
                nodeSelector: error.nodeSelector,
              },
              cause: error,
            });
          }
          throw error;
        }
      });
    },

    controlWorkflowRun(runId: number, action: DashboardRunControlAction): Promise<DashboardRunControlResult> {
      if (!Number.isInteger(runId) || runId < 1) {
        throw new DashboardIntegrationError('invalid_request', 'Run id must be a positive integer.', {
          status: 400,
        });
      }

      return withDatabase(async db => {
        const executor = dependencies.createSqlWorkflowExecutor(db, {
          resolveProvider: dependencies.resolveProvider,
        });

        let controlResult: Awaited<ReturnType<typeof executor.cancelRun>>;
        try {
          switch (action) {
            case 'cancel':
              controlResult = await executor.cancelRun({ workflowRunId: runId });
              break;
            case 'pause':
              controlResult = await executor.pauseRun({ workflowRunId: runId });
              break;
            case 'resume':
              controlResult = await executor.resumeRun({ workflowRunId: runId });
              break;
            case 'retry':
              controlResult = await executor.retryRun({ workflowRunId: runId });
              break;
          }
        } catch (error) {
          if (error instanceof WorkflowRunControlError) {
            throw toDashboardRunControlConflictError(error);
          }

          throw error;
        }

        if ((action === 'resume' || action === 'retry') && controlResult.runStatus === 'running') {
          const executionContext = backgroundExecution.resolveRunExecutionContext(db, runId);
          backgroundExecution.ensureBackgroundRunExecution({
            runId,
            workingDirectory: executionContext.workingDirectory,
            hasManagedWorktree: executionContext.hasManagedWorktree,
            cleanupWorktree: false,
          });
        }

        return {
          action: controlResult.action as DashboardRunControlAction,
          outcome: controlResult.outcome as DashboardRunControlResult['outcome'],
          workflowRunId: controlResult.workflowRunId,
          previousRunStatus: controlResult.previousRunStatus as DashboardRunControlResult['previousRunStatus'],
          runStatus: controlResult.runStatus as DashboardRunControlResult['runStatus'],
          retriedRunNodeIds: [...controlResult.retriedRunNodeIds],
        };
      });
    },

    getBackgroundExecutionCount(): number {
      return backgroundExecution.getBackgroundExecutionCount();
    },

    hasBackgroundExecution(runId: number): boolean {
      return backgroundExecution.hasBackgroundExecution(runId);
    },
  };
}
