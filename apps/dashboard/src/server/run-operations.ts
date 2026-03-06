import { WorkflowRunControlError, WorkflowRunExecutionValidationError, type PhaseProviderResolver } from '@alphred/core';
import {
  and,
  asc,
  desc,
  eq,
  getRepositoryByName,
  listRunWorktreesForRun,
  phaseArtifacts,
  repositories as repositoryTable,
  runNodeDiagnostics,
  runJoinBarriers,
  runNodeStreamEvents,
  routingDecisions,
  runNodes,
  runWorktrees,
  sql,
  workflowRunAssociations,
  workItems,
  workflowRuns,
  workflowTrees,
  type AlphredDatabase,
} from '@alphred/db';
import type { WorktreeManager } from '@alphred/git';
import type { BackgroundExecutionManager, BackgroundRunExecutionSettlement } from './background-execution';
import type {
  DashboardRunControlAction,
  DashboardRunControlResult,
  DashboardRunDetail,
  DashboardRunLaunchRequest,
  DashboardRunLaunchPolicyConstraints,
  DashboardRunLaunchResult,
  DashboardFanOutGroupSnapshot,
  DashboardRunNodeDiagnosticsSnapshot,
  DashboardRunNodeSnapshot,
  DashboardRunAssociationSnapshot,
  DashboardRunSummary,
  DashboardRunNodeStreamSnapshot,
  DashboardRunNodeDiagnosticCommandOutput,
  DashboardRunWorktreeMetadata,
  DashboardRunWorktreeCleanupResult,
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
import {
  findActiveStoryBreakdownRunForStory,
  loadStoryBreakdownRunIdentity,
} from './story-breakdown-run-state';

const BACKGROUND_RUN_STATUS: RunStatus = 'running';
const RECENT_SNAPSHOT_LIMIT = 30;
const MAX_STREAM_SNAPSHOT_EVENTS = 500;
const FAILED_COMMAND_OUTPUT_ARTIFACT_KIND = 'failed_command_output_v1';
const runPolicyConstraintsByRunId = new Map<number, DashboardRunLaunchPolicyConstraints>();

type WithDatabase = <T>(operation: (db: AlphredDatabase) => Promise<T> | T) => Promise<T>;
type RunExecutionPolicyAssertion = (db: AlphredDatabase, runId: number) => Promise<void> | void;
type LaunchRepositoryContext = NonNullable<ReturnType<typeof getRepositoryByName>>;
type PersistedRunExecutionConfig = Pick<PreparedWorkflowRunLaunch, 'executionScope' | 'nodeSelector'>;

type NormalizedRunLaunchRequest = {
  treeKey: string;
  repositoryName: string | undefined;
  issueId: string | undefined;
  workItemId: number | undefined;
  executionMode: 'async' | 'sync';
  executionScope: 'full' | 'single_node';
  nodeSelector: DashboardRunLaunchRequest['nodeSelector'];
  branch: string | undefined;
  cleanupWorktree: boolean;
  policyConstraints: DashboardRunLaunchPolicyConstraints | undefined;
};

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
      assertRunExecutionAllowed?: (params: { workflowRunId: number }) => Promise<void> | void;
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
  getRunNodeDiagnosticCommandOutput: (params: {
    runId: number;
    runNodeId: number;
    attempt: number;
    eventIndex: number;
  }) => Promise<DashboardRunNodeDiagnosticCommandOutput>;
  getRunWorktrees: (runId: number) => Promise<DashboardRunWorktreeMetadata[]>;
  cleanupRunWorktree: (runId: number) => Promise<DashboardRunWorktreeCleanupResult>;
  launchWorkflowRun: (request: DashboardRunLaunchRequest) => Promise<DashboardRunLaunchResult>;
  controlWorkflowRun: (runId: number, action: DashboardRunControlAction) => Promise<DashboardRunControlResult>;
  getBackgroundExecutionCount: () => number;
  hasBackgroundExecution: (runId: number) => boolean;
};

export type PreparedWorkflowRunLaunch = {
  workflowRunId: number;
  treeKey: string;
  repository: LaunchRepositoryContext | null;
  issueId: string | undefined;
  workItemId: number | undefined;
  executionMode: 'async' | 'sync';
  executionScope: 'full' | 'single_node';
  nodeSelector: DashboardRunLaunchRequest['nodeSelector'];
  branch: string | undefined;
  cleanupWorktree: boolean;
  policyConstraints: DashboardRunLaunchPolicyConstraints | undefined;
};

export type WorkflowRunLaunchCoordinator = {
  prepareWorkflowRunLaunch: (db: AlphredDatabase, request: DashboardRunLaunchRequest) => PreparedWorkflowRunLaunch;
  completeWorkflowRunLaunch: (
    db: AlphredDatabase,
    prepared: PreparedWorkflowRunLaunch,
  ) => Promise<DashboardRunLaunchResult>;
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

function serializeRunNodeSelector(nodeSelector: DashboardRunLaunchRequest['nodeSelector']): string | null {
  return nodeSelector === undefined ? null : JSON.stringify(nodeSelector);
}

function resolveRunExecutionConfig(
  db: Pick<AlphredDatabase, 'select'>,
  runId: number,
): PersistedRunExecutionConfig {
  const row = db
    .select({
      executionScope: workflowRuns.executionScope,
      nodeSelector: workflowRuns.nodeSelector,
    })
    .from(workflowRuns)
    .where(eq(workflowRuns.id, runId))
    .get();

  if (!row) {
    throw new DashboardIntegrationError('not_found', `Workflow run id=${runId} was not found.`, {
      status: 404,
    });
  }

  let parsedNodeSelector: DashboardRunLaunchRequest['nodeSelector'];
  if (row.nodeSelector === null) {
    parsedNodeSelector = undefined;
  } else {
    try {
      parsedNodeSelector = JSON.parse(row.nodeSelector) as DashboardRunLaunchRequest['nodeSelector'];
    } catch (error) {
      throw new DashboardIntegrationError('internal_error', `Workflow run id=${runId} has invalid node selector state.`, {
        status: 500,
        cause: error,
      });
    }
  }

  const executionScope = row.executionScope === 'single_node' ? 'single_node' : 'full';
  return {
    executionScope,
    nodeSelector: normalizeLaunchNodeSelector(executionScope, parsedNodeSelector),
  };
}

function persistRunExecutionConfig(
  db: Pick<AlphredDatabase, 'update'>,
  runId: number,
  config: PersistedRunExecutionConfig,
): void {
  db.update(workflowRuns)
    .set({
      executionScope: config.executionScope,
      nodeSelector: serializeRunNodeSelector(config.nodeSelector),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(workflowRuns.id, runId))
    .run();
}

function assertStoryBreakdownRetryExclusivity(db: AlphredDatabase, runId: number): void {
  const targetRun = loadStoryBreakdownRunIdentity(db, runId);
  if (!targetRun) {
    return;
  }

  const activeRun = findActiveStoryBreakdownRunForStory(db, {
    repositoryId: targetRun.repositoryId,
    storyId: targetRun.storyId,
    excludeWorkflowRunId: runId,
  });
  if (!activeRun) {
    return;
  }

  throw new DashboardIntegrationError('conflict', 'Story breakdown planner run is already active for this story.', {
    status: 409,
    details: {
      workflowRunId: activeRun.workflowRunId,
      runStatus: activeRun.runStatus,
      treeKey: activeRun.treeKey,
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toExecutionPermissionStringList(
  value: unknown,
  key: 'allowedSkillIdentifiers' | 'allowedMcpServerIdentifiers',
): string[] {
  if (!isRecord(value)) {
    return [];
  }

  const candidate = value[key];
  if (!Array.isArray(candidate)) {
    return [];
  }

  return candidate.filter((entry): entry is string => typeof entry === 'string');
}

function assertLaunchPolicyAllowlists(
  db: AlphredDatabase,
  params: {
    runId: number;
    policyConstraints: DashboardRunLaunchPolicyConstraints;
  },
): void {
  const { policyConstraints } = params;
  const hasAnyConstraint =
    policyConstraints.allowedProviders !== null
    || policyConstraints.allowedModels !== null
    || policyConstraints.allowedSkillIdentifiers !== null
    || policyConstraints.allowedMcpServerIdentifiers !== null;

  if (!hasAnyConstraint) {
    return;
  }

  const agentNodes = db
    .select({
      nodeKey: runNodes.nodeKey,
      provider: runNodes.provider,
      model: runNodes.model,
      executionPermissions: runNodes.executionPermissions,
    })
    .from(runNodes)
    .where(and(eq(runNodes.workflowRunId, params.runId), eq(runNodes.nodeType, 'agent')))
    .all();

  if (policyConstraints.allowedProviders !== null) {
    const allowedProviders = new Set(policyConstraints.allowedProviders);
    for (const node of agentNodes) {
      if (node.provider === null || !allowedProviders.has(node.provider)) {
        throw new DashboardIntegrationError(
          'conflict',
          `Run launch blocked by policy: provider "${node.provider ?? 'null'}" is not allowed for node "${node.nodeKey}".`,
          {
            status: 409,
            details: {
              kind: 'work_item_policy_launch',
              workflowRunId: params.runId,
              nodeKey: node.nodeKey,
              provider: node.provider,
            },
          },
        );
      }
    }
  }

  if (policyConstraints.allowedModels !== null) {
    const allowedModels = new Set(policyConstraints.allowedModels);
    for (const node of agentNodes) {
      if (node.model === null || !allowedModels.has(node.model)) {
        throw new DashboardIntegrationError(
          'conflict',
          `Run launch blocked by policy: model "${node.model ?? 'null'}" is not allowed for node "${node.nodeKey}".`,
          {
            status: 409,
            details: {
              kind: 'work_item_policy_launch',
              workflowRunId: params.runId,
              nodeKey: node.nodeKey,
              model: node.model,
            },
          },
        );
      }
    }
  }

  if (policyConstraints.allowedSkillIdentifiers !== null) {
    const allowedSkillIdentifiers = new Set(policyConstraints.allowedSkillIdentifiers);
    for (const node of agentNodes) {
      const requestedSkillIdentifiers = toExecutionPermissionStringList(
        node.executionPermissions,
        'allowedSkillIdentifiers',
      );
      for (const skillIdentifier of requestedSkillIdentifiers) {
        if (!allowedSkillIdentifiers.has(skillIdentifier)) {
          throw new DashboardIntegrationError(
            'conflict',
            `Run launch blocked by policy: skill "${skillIdentifier}" is not allowed for node "${node.nodeKey}".`,
            {
              status: 409,
              details: {
                kind: 'work_item_policy_launch',
                workflowRunId: params.runId,
                nodeKey: node.nodeKey,
                skillIdentifier,
              },
            },
          );
        }
      }
    }
  }

  if (policyConstraints.allowedMcpServerIdentifiers !== null) {
    const allowedMcpServerIdentifiers = new Set(policyConstraints.allowedMcpServerIdentifiers);
    for (const node of agentNodes) {
      const requestedMcpServerIdentifiers = toExecutionPermissionStringList(
        node.executionPermissions,
        'allowedMcpServerIdentifiers',
      );
      for (const mcpServerIdentifier of requestedMcpServerIdentifiers) {
        if (!allowedMcpServerIdentifiers.has(mcpServerIdentifier)) {
          throw new DashboardIntegrationError(
            'conflict',
            `Run launch blocked by policy: MCP server "${mcpServerIdentifier}" is not allowed for node "${node.nodeKey}".`,
            {
              status: 409,
              details: {
                kind: 'work_item_policy_launch',
                workflowRunId: params.runId,
                nodeKey: node.nodeKey,
                mcpServerIdentifier,
              },
            },
          );
        }
      }
    }
  }
}

function cloneLaunchPolicyConstraints(
  policyConstraints: DashboardRunLaunchPolicyConstraints,
): DashboardRunLaunchPolicyConstraints {
  return {
    allowedProviders: policyConstraints.allowedProviders === null ? null : [...policyConstraints.allowedProviders],
    allowedModels: policyConstraints.allowedModels === null ? null : [...policyConstraints.allowedModels],
    allowedSkillIdentifiers:
      policyConstraints.allowedSkillIdentifiers === null ? null : [...policyConstraints.allowedSkillIdentifiers],
    allowedMcpServerIdentifiers:
      policyConstraints.allowedMcpServerIdentifiers === null ? null : [...policyConstraints.allowedMcpServerIdentifiers],
  };
}

function hasLaunchPolicyConstraints(policyConstraints: DashboardRunLaunchPolicyConstraints): boolean {
  return (
    policyConstraints.allowedProviders !== null
    || policyConstraints.allowedModels !== null
    || policyConstraints.allowedSkillIdentifiers !== null
    || policyConstraints.allowedMcpServerIdentifiers !== null
  );
}

function normalizeRunLaunchRequest(request: DashboardRunLaunchRequest): NormalizedRunLaunchRequest {
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

  const issueId = request.issueId?.trim();
  if (request.issueId !== undefined && issueId?.length === 0) {
    throw new DashboardIntegrationError('invalid_request', 'issueId cannot be empty when provided.', {
      status: 400,
    });
  }

  const workItemId = request.workItemId;
  if (workItemId !== undefined && (!Number.isInteger(workItemId) || workItemId < 1)) {
    throw new DashboardIntegrationError('invalid_request', 'workItemId must be a positive integer when provided.', {
      status: 400,
    });
  }
  if (workItemId !== undefined && repositoryName === undefined) {
    throw new DashboardIntegrationError(
      'invalid_request',
      'workItemId requires repositoryName so run association can be validated.',
      {
        status: 400,
      },
    );
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

  return {
    treeKey,
    repositoryName,
    issueId,
    workItemId,
    executionMode,
    executionScope,
    nodeSelector: normalizeLaunchNodeSelector(executionScope, request.nodeSelector),
    branch: request.branch?.trim() || undefined,
    cleanupWorktree: request.cleanupWorktree ?? false,
    policyConstraints:
      request.policyConstraints === undefined ? undefined : cloneLaunchPolicyConstraints(request.policyConstraints),
  };
}

function isTerminalRunStatus(status: RunStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function createRunExecutionPolicyAssertion(
  policyConstraints: DashboardRunLaunchPolicyConstraints | undefined,
): RunExecutionPolicyAssertion | undefined {
  if (policyConstraints === undefined || !hasLaunchPolicyConstraints(policyConstraints)) {
    return undefined;
  }

  return (db, runId) =>
    assertLaunchPolicyAllowlists(db, {
      runId,
      policyConstraints,
    });
}

function toOptionalNonNegativeInteger(value: unknown): number | null {
  if (!Number.isInteger(value) || (value as number) < 0) {
    return null;
  }

  return value as number;
}

function toOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  return value;
}

function parseFailedCommandOutputContent(
  content: string,
): {
  output: string;
  stdout: string | null;
  stderr: string | null;
  command: string | null;
  exitCode: number | null;
  outputChars: number | null;
} {
  let parsed: Record<string, unknown> | null = null;
  try {
    const candidate = JSON.parse(content) as unknown;
    parsed = isRecord(candidate) ? candidate : null;
  } catch {
    parsed = null;
  }

  if (!parsed) {
    return {
      output: content,
      stdout: null,
      stderr: null,
      command: null,
      exitCode: null,
      outputChars: null,
    };
  }

  const output = toOptionalString(parsed.output) ?? content;
  return {
    output,
    stdout: toOptionalString(parsed.stdout),
    stderr: toOptionalString(parsed.stderr),
    command: toOptionalString(parsed.command),
    exitCode: Number.isInteger(parsed.exitCode) ? (parsed.exitCode as number) : null,
    outputChars: toOptionalNonNegativeInteger(parsed.outputChars),
  };
}

function clearRunPolicyConstraintsOnSettlement({ runId, runStatus }: BackgroundRunExecutionSettlement): void {
  if (runStatus !== null && isTerminalRunStatus(runStatus)) {
    runPolicyConstraintsByRunId.delete(runId);
  }
}

function loadRunAssociationSnapshot(
  db: AlphredDatabase,
  runId: number,
): DashboardRunAssociationSnapshot | null {
  const association = db
    .select({
      repositoryId: workflowRunAssociations.repositoryId,
      issueId: workflowRunAssociations.issueId,
      workItemId: workflowRunAssociations.workItemId,
      workItemType: workItems.type,
      workItemTitle: workItems.title,
    })
    .from(workflowRunAssociations)
    .leftJoin(workItems, eq(workflowRunAssociations.workItemId, workItems.id))
    .where(eq(workflowRunAssociations.workflowRunId, runId))
    .get();

  if (!association) {
    return null;
  }

  if (association.workItemId === null || association.workItemType === null || association.workItemTitle === null) {
    return {
      repositoryId: association.repositoryId,
      issueId: association.issueId,
      workItem: null,
    };
  }

  return {
    repositoryId: association.repositoryId,
    issueId: association.issueId,
    workItem: {
      id: association.workItemId,
      type: association.workItemType as NonNullable<DashboardRunAssociationSnapshot['workItem']>['type'],
      title: association.workItemTitle,
    },
  };
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
      nodeRole: runNodes.nodeRole,
      spawnerNodeId: runNodes.spawnerNodeId,
      joinNodeId: runNodes.joinNodeId,
      lineageDepth: runNodes.lineageDepth,
      sequencePath: runNodes.sequencePath,
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
  const association = loadRunAssociationSnapshot(db, run.id);

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
    association,
  };
}

export function createWorkflowRunLaunchCoordinator(params: {
  dependencies: RunOperationsDependencies;
  backgroundExecution: BackgroundExecutionManager;
  environment: NodeJS.ProcessEnv;
  cwd: string;
  repositoryAuthDependencies: Pick<RepositoryOperationsDependencies, 'createScmProvider'>;
}): WorkflowRunLaunchCoordinator {
  const {
    dependencies,
    backgroundExecution,
    environment,
    cwd,
    repositoryAuthDependencies,
  } = params;

  function prepareWorkflowRunLaunch(
    db: AlphredDatabase,
    request: DashboardRunLaunchRequest,
  ): PreparedWorkflowRunLaunch {
    const normalizedRequest = normalizeRunLaunchRequest(request);
    try {
      return db.transaction(() => {
        const planner = dependencies.createSqlWorkflowPlanner(db);
        const materializedRun = planner.materializeRun({ treeKey: normalizedRequest.treeKey });
        const workflowRunId = materializedRun.run.id;
        const assertRunExecutionAllowed = createRunExecutionPolicyAssertion(normalizedRequest.policyConstraints);

        if (assertRunExecutionAllowed !== undefined) {
          assertRunExecutionAllowed(db, workflowRunId);
        }

        let repository: LaunchRepositoryContext | null = null;
        if (normalizedRequest.repositoryName !== undefined) {
          repository = getRepositoryByName(db, normalizedRequest.repositoryName, { includeArchived: true });
          if (!repository) {
            throw new DashboardIntegrationError(
              'not_found',
              `Repository "${normalizedRequest.repositoryName}" was not found.`,
              { status: 404 },
            );
          }
          if (repository.archivedAt !== null) {
            throw new DashboardIntegrationError(
              'conflict',
              `Repository "${normalizedRequest.repositoryName}" is archived. Restore it before launching runs.`,
              {
                status: 409,
                details: {
                  archivedAt: repository.archivedAt,
                },
              },
            );
          }

          if (normalizedRequest.workItemId !== undefined) {
            const linkedWorkItem = db
              .select({
                id: workItems.id,
                repositoryId: workItems.repositoryId,
              })
              .from(workItems)
              .where(eq(workItems.id, normalizedRequest.workItemId))
              .get();
            if (!linkedWorkItem) {
              throw new DashboardIntegrationError(
                'not_found',
                `Work item id=${normalizedRequest.workItemId} was not found.`,
                {
                  status: 404,
                },
              );
            }
            if (linkedWorkItem.repositoryId !== repository.id) {
              throw new DashboardIntegrationError(
                'conflict',
                `Work item id=${normalizedRequest.workItemId} does not belong to repository "${repository.name}".`,
                {
                  status: 409,
                  details: {
                    workItemId: normalizedRequest.workItemId,
                    workItemRepositoryId: linkedWorkItem.repositoryId,
                    repositoryId: repository.id,
                  },
                },
              );
            }
          }
        }

        if (normalizedRequest.workItemId !== undefined || normalizedRequest.issueId !== undefined) {
          db.insert(workflowRunAssociations)
            .values({
              workflowRunId,
              repositoryId: repository?.id ?? null,
              workItemId: normalizedRequest.workItemId ?? null,
              issueId: normalizedRequest.issueId ?? null,
            })
            .run();
        }

        if (normalizedRequest.executionScope === 'single_node') {
          backgroundExecution.validateSingleNodeSelection(db, workflowRunId, normalizedRequest.nodeSelector);
        }
        persistRunExecutionConfig(db, workflowRunId, {
          executionScope: normalizedRequest.executionScope,
          nodeSelector: normalizedRequest.nodeSelector,
        });

        return {
          workflowRunId,
          treeKey: normalizedRequest.treeKey,
          repository,
          issueId: normalizedRequest.issueId,
          workItemId: normalizedRequest.workItemId,
          executionMode: normalizedRequest.executionMode,
          executionScope: normalizedRequest.executionScope,
          nodeSelector: normalizedRequest.nodeSelector,
          branch: normalizedRequest.branch,
          cleanupWorktree: normalizedRequest.cleanupWorktree,
          policyConstraints: normalizedRequest.policyConstraints,
        };
      });
    } catch (error) {
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
  }

  async function completeWorkflowRunLaunch(
    db: AlphredDatabase,
    prepared: PreparedWorkflowRunLaunch,
  ): Promise<DashboardRunLaunchResult> {
    const runId = prepared.workflowRunId;
    let workingDirectory = cwd;
    let worktreeManager: Pick<WorktreeManager, 'createRunWorktree' | 'cleanupRun'> | null = null;

    if (prepared.policyConstraints !== undefined && hasLaunchPolicyConstraints(prepared.policyConstraints)) {
      runPolicyConstraintsByRunId.set(runId, prepared.policyConstraints);
    }

    try {
      if (prepared.repository !== null) {
        await ensureRepositoryAuth(prepared.repository, repositoryAuthDependencies, environment);

        worktreeManager = dependencies.createWorktreeManager(db, environment);
        const createdWorktree = await worktreeManager.createRunWorktree({
          repoName: prepared.repository.name,
          treeKey: prepared.treeKey,
          runId,
          branch: prepared.branch,
          issueId: prepared.issueId,
        });
        workingDirectory = createdWorktree.path;
      }

      if (prepared.executionMode === 'sync') {
        const execution = await backgroundExecution.executeWorkflowRun(
          db,
          runId,
          workingDirectory,
          worktreeManager,
          prepared.cleanupWorktree,
          prepared.executionScope,
          prepared.nodeSelector,
          createRunExecutionPolicyAssertion(prepared.policyConstraints),
        );

        if (isTerminalRunStatus(execution.runStatus)) {
          runPolicyConstraintsByRunId.delete(runId);
        }

        return {
          workflowRunId: runId,
          mode: 'sync',
          status: 'completed',
          runStatus: execution.runStatus,
          executionOutcome: execution.executionOutcome,
          executedNodes: execution.executedNodes,
        };
      }

      backgroundExecution.enqueueBackgroundRunExecution({
        runId,
        workingDirectory,
        hasManagedWorktree: worktreeManager !== null,
        cleanupWorktree: prepared.cleanupWorktree,
        executionScope: prepared.executionScope,
        nodeSelector: prepared.nodeSelector,
        assertRunExecutionAllowed: createRunExecutionPolicyAssertion(prepared.policyConstraints),
        onBackgroundExecutionSettled: clearRunPolicyConstraintsOnSettlement,
      });

      return {
        workflowRunId: runId,
        mode: 'async',
        status: 'accepted',
        runStatus: BACKGROUND_RUN_STATUS,
        executionOutcome: null,
        executedNodes: null,
      };
    } catch (error) {
      runPolicyConstraintsByRunId.delete(runId);
      try {
        const executor = dependencies.createSqlWorkflowExecutor(db, {
          resolveProvider: dependencies.resolveProvider,
        });
        await executor.cancelRun({ workflowRunId: runId });
      } catch (cancelError) {
        if (!(cancelError instanceof WorkflowRunControlError)) {
          throw cancelError;
        }
      }
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
  }

  return {
    prepareWorkflowRunLaunch,
    completeWorkflowRunLaunch,
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
  const workflowRunLaunchCoordinator = createWorkflowRunLaunchCoordinator({
    dependencies,
    backgroundExecution,
    environment,
    cwd,
    repositoryAuthDependencies,
  });

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
            nodeRole: runNodes.nodeRole,
            spawnerNodeId: runNodes.spawnerNodeId,
            joinNodeId: runNodes.joinNodeId,
            lineageDepth: runNodes.lineageDepth,
            sequencePath: runNodes.sequencePath,
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
        const fanOutBarrierRows = db
          .select({
            spawnerNodeId: runJoinBarriers.spawnerRunNodeId,
            joinNodeId: runJoinBarriers.joinRunNodeId,
            spawnSourceArtifactId: runJoinBarriers.spawnSourceArtifactId,
            expectedChildren: runJoinBarriers.expectedChildren,
            terminalChildren: runJoinBarriers.terminalChildren,
            completedChildren: runJoinBarriers.completedChildren,
            failedChildren: runJoinBarriers.failedChildren,
            status: runJoinBarriers.status,
          })
          .from(runJoinBarriers)
          .where(eq(runJoinBarriers.workflowRunId, runId))
          .orderBy(asc(runJoinBarriers.id))
          .all();

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
          .where(
            and(
              eq(phaseArtifacts.workflowRunId, runId),
              sql`coalesce(json_extract(${phaseArtifacts.metadata}, '$.kind'), '') <> ${FAILED_COMMAND_OUTPUT_ARTIFACT_KIND}`,
            ),
          )
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

        const fanOutChildNodesByPair = new Map<string, DashboardRunNodeSnapshot[]>();
        for (const node of nodes) {
          if (node.spawnerNodeId === null || node.joinNodeId === null) {
            continue;
          }
          const pairKey = `${String(node.spawnerNodeId)}:${String(node.joinNodeId)}`;
          const existing = fanOutChildNodesByPair.get(pairKey) ?? [];
          existing.push(node);
          fanOutChildNodesByPair.set(pairKey, existing);
        }
        for (const childNodes of fanOutChildNodesByPair.values()) {
          childNodes.sort((left, right) => {
            if (left.sequenceIndex !== right.sequenceIndex) {
              return left.sequenceIndex - right.sequenceIndex;
            }
            return left.id - right.id;
          });
        }
        const fanOutConsumedChildrenByPair = new Map<string, number>();

        const fanOutGroups: DashboardFanOutGroupSnapshot[] = [];
        for (const row of fanOutBarrierRows) {
          const pairKey = `${String(row.spawnerNodeId)}:${String(row.joinNodeId)}`;
          const pairChildren = fanOutChildNodesByPair.get(pairKey) ?? [];
          const nextChildOffset = fanOutConsumedChildrenByPair.get(pairKey) ?? 0;
          const expectedChildren = Math.max(row.expectedChildren, 0);
          const childNodeIds = pairChildren.slice(nextChildOffset, nextChildOffset + expectedChildren).map(node => node.id);
          fanOutConsumedChildrenByPair.set(pairKey, nextChildOffset + expectedChildren);

          fanOutGroups.push({
            spawnerNodeId: row.spawnerNodeId,
            joinNodeId: row.joinNodeId,
            spawnSourceArtifactId: row.spawnSourceArtifactId,
            expectedChildren: row.expectedChildren,
            terminalChildren: row.terminalChildren,
            completedChildren: row.completedChildren,
            failedChildren: row.failedChildren,
            status: row.status as DashboardFanOutGroupSnapshot['status'],
            childNodeIds,
          });
        }

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
          fanOutGroups,
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

    getRunNodeDiagnosticCommandOutput(params: {
      runId: number;
      runNodeId: number;
      attempt: number;
      eventIndex: number;
    }): Promise<DashboardRunNodeDiagnosticCommandOutput> {
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

      if (!Number.isInteger(params.eventIndex) || params.eventIndex < 0) {
        throw new DashboardIntegrationError('invalid_request', 'eventIndex must be a non-negative integer.', {
          status: 400,
        });
      }

      return withDatabase(async db => {
        const run = db
          .select({
            id: workflowRuns.id,
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

        const matchingArtifact = db
          .select({
            id: phaseArtifacts.id,
            contentType: phaseArtifacts.contentType,
            content: phaseArtifacts.content,
            metadata: phaseArtifacts.metadata,
            createdAt: phaseArtifacts.createdAt,
          })
          .from(phaseArtifacts)
          .where(
            and(
              eq(phaseArtifacts.workflowRunId, params.runId),
              eq(phaseArtifacts.runNodeId, params.runNodeId),
              eq(phaseArtifacts.artifactType, 'log'),
              sql`coalesce(json_extract(${phaseArtifacts.metadata}, '$.kind'), '') = ${FAILED_COMMAND_OUTPUT_ARTIFACT_KIND}`,
              sql`json_extract(${phaseArtifacts.metadata}, '$.attempt') = ${params.attempt}`,
              sql`json_extract(${phaseArtifacts.metadata}, '$.eventIndex') = ${params.eventIndex}`,
            ),
          )
          .orderBy(desc(phaseArtifacts.id))
          .limit(1)
          .get();

        if (!matchingArtifact) {
          throw new DashboardIntegrationError(
            'not_found',
            `No failed command output was found for run ${params.runId}, node ${params.runNodeId}, attempt ${params.attempt}, eventIndex ${params.eventIndex}.`,
            { status: 404 },
          );
        }

        const metadata = isRecord(matchingArtifact.metadata) ? matchingArtifact.metadata : null;
        const parsedOutput = parseFailedCommandOutputContent(matchingArtifact.content);
        const sequence = toOptionalNonNegativeInteger(metadata?.sequence) ?? (params.eventIndex + 1);
        const outputChars =
          toOptionalNonNegativeInteger(metadata?.outputChars)
          ?? parsedOutput.outputChars
          ?? parsedOutput.output.length;
        const metadataExitCode = metadata && Number.isInteger(metadata.exitCode) ? (metadata.exitCode as number) : null;

        return {
          workflowRunId: params.runId,
          runNodeId: params.runNodeId,
          attempt: params.attempt,
          eventIndex: params.eventIndex,
          sequence,
          artifactId: matchingArtifact.id,
          command: toOptionalString(metadata?.command) ?? parsedOutput.command,
          exitCode: metadataExitCode ?? parsedOutput.exitCode,
          outputChars,
          output: parsedOutput.output,
          stdout: parsedOutput.stdout,
          stderr: parsedOutput.stderr,
          createdAt: matchingArtifact.createdAt,
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

    cleanupRunWorktree(runId: number): Promise<DashboardRunWorktreeCleanupResult> {
      if (!Number.isInteger(runId) || runId < 1) {
        throw new DashboardIntegrationError('invalid_request', 'Run id must be a positive integer.', {
          status: 400,
        });
      }

      return withDatabase(async db => {
        const run = db
          .select({
            status: workflowRuns.status,
          })
          .from(workflowRuns)
          .where(eq(workflowRuns.id, runId))
          .get();

        if (!run) {
          throw new DashboardIntegrationError('not_found', `Workflow run id=${runId} was not found.`, {
            status: 404,
          });
        }

        const runStatus = run.status as RunStatus;
        if (!isTerminalRunStatus(runStatus)) {
          throw new DashboardIntegrationError(
            'conflict',
            `Workflow run id=${runId} must be terminal before worktree cleanup; current status is "${run.status}".`,
            {
              status: 409,
              details: {
                workflowRunId: runId,
                runStatus: run.status,
                allowedRunStatuses: ['completed', 'failed', 'cancelled'],
              },
            },
          );
        }

        const worktreeManager = dependencies.createWorktreeManager(db, environment);
        await worktreeManager.cleanupRun(runId);

        return {
          worktrees: listRunWorktreesForRun(db, runId).map(toWorktreeMetadata),
        };
      });
    },

    launchWorkflowRun(request: DashboardRunLaunchRequest): Promise<DashboardRunLaunchResult> {
      return withDatabase(async db => {
        const prepared = workflowRunLaunchCoordinator.prepareWorkflowRunLaunch(db, request);
        return workflowRunLaunchCoordinator.completeWorkflowRunLaunch(db, prepared);
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
              assertStoryBreakdownRetryExclusivity(db, runId);
              controlResult = await executor.retryRun({ workflowRunId: runId });
              break;
          }
        } catch (error) {
          if (error instanceof WorkflowRunControlError) {
            throw toDashboardRunControlConflictError(error);
          }

          throw error;
        }

        if (isTerminalRunStatus(controlResult.runStatus as RunStatus)) {
          runPolicyConstraintsByRunId.delete(runId);
        }

        if ((action === 'resume' || action === 'retry') && controlResult.runStatus === 'running') {
          const executionContext = backgroundExecution.resolveRunExecutionContext(db, runId);
          const executionConfig = resolveRunExecutionConfig(db, runId);
          const policyConstraints = runPolicyConstraintsByRunId.get(runId);
          backgroundExecution.ensureBackgroundRunExecution({
            runId,
            workingDirectory: executionContext.workingDirectory,
            hasManagedWorktree: executionContext.hasManagedWorktree,
            cleanupWorktree: false,
            executionScope: executionConfig.executionScope,
            nodeSelector: executionConfig.nodeSelector,
            assertRunExecutionAllowed: createRunExecutionPolicyAssertion(policyConstraints),
            onBackgroundExecutionSettled: clearRunPolicyConstraintsOnSettlement,
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
