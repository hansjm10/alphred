import { join, resolve } from 'node:path';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { UnknownAgentProviderError, resolveAgentProvider } from '@alphred/agents';
import { createSqlWorkflowExecutor, createSqlWorkflowPlanner, type PhaseProviderResolver } from '@alphred/core';
import {
  createDatabase,
  guardDefinitions,
  getRepositoryByName,
  insertRepository,
  listRepositories,
  listRunWorktreesForRun,
  migrateDatabase,
  phaseArtifacts,
  promptTemplates,
  repositories as repositoryTable,
  routingDecisions,
  runNodes,
  runWorktrees,
  treeEdges,
  treeNodes,
  transitionWorkflowRunStatus,
  workflowRuns,
  workflowTrees,
  type AlphredDatabase,
} from '@alphred/db';
import {
  WorktreeManager,
  createScmProvider,
  ensureRepositoryClone,
  resolveSandboxDir,
  type ScmProviderConfig,
} from '@alphred/git';
import type { AuthStatus, RepositoryConfig } from '@alphred/shared';
import type {
  DashboardArtifactSnapshot,
  DashboardCreateRepositoryRequest,
  DashboardCreateRepositoryResult,
  DashboardGitHubAuthStatus,
  DashboardNodeStatus,
  DashboardNodeStatusSummary,
  DashboardRepositoryState,
  DashboardRepositorySyncResult,
  DashboardRoutingDecisionSnapshot,
  DashboardRunDetail,
  DashboardRunLaunchRequest,
  DashboardRunLaunchResult,
  DashboardRunNodeSnapshot,
	  DashboardRunSummary,
	  DashboardRunWorktreeMetadata,
	  DashboardCreateWorkflowRequest,
	  DashboardCreateWorkflowResult,
	  DashboardDuplicateWorkflowRequest,
	  DashboardDuplicateWorkflowResult,
	  DashboardPublishWorkflowDraftRequest,
	  DashboardSaveWorkflowDraftRequest,
	  DashboardWorkflowCatalogItem,
	  DashboardWorkflowDraftTopology,
	  DashboardWorkflowTreeSnapshot,
  DashboardWorkflowValidationIssue,
  DashboardWorkflowValidationResult,
  DashboardWorkflowTreeSummary,
} from './dashboard-contracts';
import { DashboardIntegrationError, toDashboardIntegrationError } from './dashboard-errors';

type RunStatus = DashboardRunSummary['status'];

const BACKGROUND_RUN_STATUS: RunStatus = 'running';
const DEFAULT_GITHUB_AUTH_REPO = 'octocat/Hello-World';
const MAX_ARTIFACT_PREVIEW_LENGTH = 280;
const RECENT_SNAPSHOT_LIMIT = 30;

const backgroundRunExecutions = new Map<number, Promise<void>>();

export type DashboardServiceDependencies = {
  openDatabase: (path: string) => AlphredDatabase;
  migrateDatabase: (db: AlphredDatabase) => void;
  closeDatabase: (db: AlphredDatabase) => void;
  resolveProvider: PhaseProviderResolver;
  createScmProvider: (config: ScmProviderConfig) => {
    checkAuth: (environment?: NodeJS.ProcessEnv) => Promise<AuthStatus>;
  };
  ensureRepositoryClone: typeof ensureRepositoryClone;
  createSqlWorkflowPlanner: typeof createSqlWorkflowPlanner;
  createSqlWorkflowExecutor: typeof createSqlWorkflowExecutor;
  createWorktreeManager: (db: AlphredDatabase, environment: NodeJS.ProcessEnv) => Pick<
    WorktreeManager,
    'createRunWorktree' | 'cleanupRun'
  >;
};

const defaultDependencies: DashboardServiceDependencies = {
  openDatabase: path => createDatabase(path),
  migrateDatabase: db => migrateDatabase(db),
  closeDatabase: db => db.$client.close(),
  resolveProvider: providerName => resolveAgentProvider(providerName),
  createScmProvider: config => createScmProvider(config),
  ensureRepositoryClone: params => ensureRepositoryClone(params),
  createSqlWorkflowPlanner: db => createSqlWorkflowPlanner(db),
  createSqlWorkflowExecutor: (db, dependencies) => createSqlWorkflowExecutor(db, dependencies),
  createWorktreeManager: (db, environment) =>
    new WorktreeManager(db, {
      worktreeBase: join(resolveSandboxDir(environment), 'worktrees'),
      environment,
    }),
};

function resolveDatabasePath(environment: NodeJS.ProcessEnv, cwd: string): string {
  const configuredPath = environment.ALPHRED_DB_PATH?.trim();
  if (configuredPath && configuredPath.length > 0) {
    return resolve(cwd, configuredPath);
  }

  return resolve(cwd, 'alphred.db');
}

function summarizeNodeStatuses(nodes: readonly { status: DashboardNodeStatus }[]): DashboardNodeStatusSummary {
  const summary: DashboardNodeStatusSummary = {
    pending: 0,
    running: 0,
    completed: 0,
    failed: 0,
    skipped: 0,
    cancelled: 0,
  };

  for (const node of nodes) {
    summary[node.status] += 1;
  }

  return summary;
}

function selectLatestNodeAttempts(
  nodes: readonly {
    id: number;
    nodeKey: string;
    attempt: number;
    sequenceIndex: number;
    treeNodeId: number;
    status: string;
    startedAt: string | null;
    completedAt: string | null;
  }[],
): DashboardRunNodeSnapshot[] {
  const latestByNodeKey = new Map<string, (typeof nodes)[number]>();
  for (const node of nodes) {
    const current = latestByNodeKey.get(node.nodeKey);
    if (!current || node.attempt > current.attempt || (node.attempt === current.attempt && node.id > current.id)) {
      latestByNodeKey.set(node.nodeKey, node);
    }
  }

  return [...latestByNodeKey.values()]
    .sort((left, right) => {
      if (left.sequenceIndex !== right.sequenceIndex) {
        return left.sequenceIndex - right.sequenceIndex;
      }
      if (left.nodeKey < right.nodeKey) {
        return -1;
      }
      if (left.nodeKey > right.nodeKey) {
        return 1;
      }
      return left.id - right.id;
    })
    .map(node => ({
      id: node.id,
      treeNodeId: node.treeNodeId,
      nodeKey: node.nodeKey,
      sequenceIndex: node.sequenceIndex,
      attempt: node.attempt,
      status: node.status as DashboardNodeStatus,
      startedAt: node.startedAt,
      completedAt: node.completedAt,
      latestArtifact: null,
      latestRoutingDecision: null,
    }));
}

function toRepositoryState(repository: RepositoryConfig): DashboardRepositoryState {
  return {
    id: repository.id,
    name: repository.name,
    provider: repository.provider,
    remoteRef: repository.remoteRef,
    remoteUrl: repository.remoteUrl,
    defaultBranch: repository.defaultBranch,
    branchTemplate: repository.branchTemplate,
    cloneStatus: repository.cloneStatus,
    localPath: repository.localPath,
  };
}

function createArtifactSnapshot(
  artifact: {
    id: number;
    runNodeId: number;
    artifactType: string;
    contentType: string;
    content: string;
    createdAt: string;
  },
): DashboardArtifactSnapshot {
  return {
    id: artifact.id,
    runNodeId: artifact.runNodeId,
    artifactType: artifact.artifactType as DashboardArtifactSnapshot['artifactType'],
    contentType: artifact.contentType as DashboardArtifactSnapshot['contentType'],
    contentPreview: artifact.content.slice(0, MAX_ARTIFACT_PREVIEW_LENGTH),
    createdAt: artifact.createdAt,
  };
}

function createRoutingDecisionSnapshot(
  decision: {
    id: number;
    runNodeId: number;
    decisionType: string;
    rationale: string | null;
    createdAt: string;
  },
): DashboardRoutingDecisionSnapshot {
  return {
    id: decision.id,
    runNodeId: decision.runNodeId,
    decisionType: decision.decisionType as DashboardRoutingDecisionSnapshot['decisionType'],
    rationale: decision.rationale,
    createdAt: decision.createdAt,
  };
}

function toWorktreeMetadata(worktree: {
  id: number;
  workflowRunId: number;
  repositoryId: number;
  worktreePath: string;
  branch: string;
  commitHash: string | null;
  status: string;
  createdAt: string;
  removedAt: string | null;
}): DashboardRunWorktreeMetadata {
  return {
    id: worktree.id,
    runId: worktree.workflowRunId,
    repositoryId: worktree.repositoryId,
    path: worktree.worktreePath,
    branch: worktree.branch,
    commitHash: worktree.commitHash,
    status: worktree.status as DashboardRunWorktreeMetadata['status'],
    createdAt: worktree.createdAt,
    removedAt: worktree.removedAt,
  };
}

function parseAzureRemoteRef(remoteRef: string): {
  organization: string;
  project: string;
  repository: string;
} {
  const segments = remoteRef
    .split('/')
    .map(segment => segment.trim())
    .filter(segment => segment.length > 0);

  if (segments.length !== 3) {
    throw new DashboardIntegrationError(
      'invalid_request',
      `Invalid Azure repository reference "${remoteRef}". Expected org/project/repository.`,
      { status: 400 },
    );
  }

  return {
    organization: segments[0],
    project: segments[1],
    repository: segments[2],
  };
}

function parseGitHubRemoteRef(remoteRef: string): {
  owner: string;
  repository: string;
} {
  const segments = remoteRef
    .split('/')
    .map(segment => segment.trim())
    .filter(segment => segment.length > 0);

  if (segments.length !== 2) {
    throw new DashboardIntegrationError(
      'invalid_request',
      `Invalid GitHub repository reference "${remoteRef}". Expected owner/repository.`,
      { status: 400 },
    );
  }

  return {
    owner: segments[0],
    repository: segments[1],
  };
}

function toAuthScmProviderConfig(repository: Pick<RepositoryConfig, 'provider' | 'remoteRef'>): ScmProviderConfig {
  if (repository.provider === 'github') {
    return {
      kind: 'github',
      repo: repository.remoteRef,
    };
  }

  const parsed = parseAzureRemoteRef(repository.remoteRef);
  return {
    kind: 'azure-devops',
    organization: parsed.organization,
    project: parsed.project,
    repository: parsed.repository,
  };
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function isWorkflowRunTransitionPreconditionError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('precondition failed');
}

function toBackgroundFailureTransition(
  status: RunStatus,
): { expectedFrom: 'pending' | 'running' | 'paused'; to: 'cancelled' | 'failed' } | null {
  if (status === 'pending') {
    return {
      expectedFrom: 'pending',
      to: 'cancelled',
    };
  }

  if (status === 'running') {
    return {
      expectedFrom: 'running',
      to: 'failed',
    };
  }

  if (status === 'paused') {
    return {
      expectedFrom: 'paused',
      to: 'cancelled',
    };
  }

  return null;
}

export type DashboardService = ReturnType<typeof createDashboardService>;

export function createDashboardService(options: {
  dependencies?: DashboardServiceDependencies;
  environment?: NodeJS.ProcessEnv;
  cwd?: string;
} = {}) {
  const dependencies = options.dependencies ?? defaultDependencies;
  const environment = options.environment ?? process.env;
  const cwd = options.cwd ?? process.cwd();

  async function withDatabase<T>(operation: (db: AlphredDatabase) => Promise<T> | T): Promise<T> {
    const db = dependencies.openDatabase(resolveDatabasePath(environment, cwd));
    let result: T | undefined;
    let caughtError: unknown = null;

    try {
      dependencies.migrateDatabase(db);
      result = await operation(db);
    } catch (error) {
      caughtError = toDashboardIntegrationError(error);
    }

    try {
      dependencies.closeDatabase(db);
    } catch (error) {
      if (caughtError === null) {
        caughtError = toDashboardIntegrationError(error, 'Dashboard integration cleanup failed.');
      }
    }

    if (caughtError !== null) {
      throw caughtError;
    }

    return result as T;
  }

  async function ensureRepositoryAuth(repository: Pick<RepositoryConfig, 'provider' | 'remoteRef'>): Promise<void> {
    const provider = dependencies.createScmProvider(toAuthScmProviderConfig(repository));
    const authStatus = await provider.checkAuth(environment);
    if (authStatus.authenticated) {
      return;
    }

    const providerLabel = repository.provider === 'github' ? 'GitHub' : 'Azure DevOps';
    throw new DashboardIntegrationError(
      'auth_required',
      authStatus.error?.trim() || `${providerLabel} authentication is required.`,
      {
        status: 401,
        details: {
          provider: repository.provider,
        },
      },
    );
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

  async function executeWorkflowRun(
    db: AlphredDatabase,
    runId: number,
    workingDirectory: string,
    worktreeManager: Pick<WorktreeManager, 'cleanupRun'> | null,
    cleanupWorktree: boolean,
  ): Promise<{
    runStatus: RunStatus;
    executionOutcome: string;
    executedNodes: number;
  }> {
    const executor = dependencies.createSqlWorkflowExecutor(db, {
      resolveProvider: dependencies.resolveProvider,
    });

    let execution: Awaited<ReturnType<typeof executor.executeRun>> | undefined;
    let executionError: unknown = null;
    try {
      execution = await executor.executeRun({
        workflowRunId: runId,
        options: {
          workingDirectory,
        },
      });
    } catch (error) {
      executionError = error;
    }

    let cleanupError: unknown = null;
    if (cleanupWorktree && worktreeManager) {
      try {
        await worktreeManager.cleanupRun(runId);
      } catch (error) {
        cleanupError = error;
      }
    }

    if (executionError !== null) {
      throw executionError;
    }

    if (cleanupError !== null) {
      throw cleanupError;
    }

    if (execution === undefined) {
      throw new DashboardIntegrationError('internal_error', 'Dashboard execution did not produce a terminal result.', {
        status: 500,
      });
    }

    return {
      runStatus: execution.finalStep.runStatus as RunStatus,
      executionOutcome: execution.finalStep.outcome,
      executedNodes: execution.executedNodes,
    };
  }

  async function markPendingRunCancelled(db: AlphredDatabase, runId: number): Promise<void> {
    try {
      transitionWorkflowRunStatus(db, {
        workflowRunId: runId,
        expectedFrom: 'pending',
        to: 'cancelled',
      });
    } catch (error) {
      if (!isWorkflowRunTransitionPreconditionError(error)) {
        throw error;
      }
    }
  }

  async function markRunTerminalAfterBackgroundFailure(runId: number, originalError: unknown): Promise<void> {
    console.error(`Run id=${runId} background execution failed: ${toErrorMessage(originalError)}`);

    try {
      await withDatabase(async db => {
        const run = db
          .select({
            status: workflowRuns.status,
          })
          .from(workflowRuns)
          .where(eq(workflowRuns.id, runId))
          .get();
        if (!run) {
          return;
        }

        const transition = toBackgroundFailureTransition(run.status as RunStatus);
        if (!transition) {
          return;
        }

        try {
          transitionWorkflowRunStatus(db, {
            workflowRunId: runId,
            expectedFrom: transition.expectedFrom,
            to: transition.to,
          });
        } catch (error) {
          if (!isWorkflowRunTransitionPreconditionError(error)) {
            throw error;
          }
        }
      });
    } catch (transitionError) {
      console.error(`Run id=${runId} background failure status update failed: ${toErrorMessage(transitionError)}`);
    }
  }

  const utcNow = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

  const workflowNodeTypes = new Set(['agent', 'human', 'tool']);
  const guardOperators = new Set(['==', '!=', '>', '<', '>=', '<=']);

  function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function isGuardExpression(value: unknown): boolean {
    if (!isRecord(value)) {
      return false;
    }

    if ('logic' in value) {
      if ((value.logic !== 'and' && value.logic !== 'or') || !Array.isArray(value.conditions)) {
        return false;
      }

      return value.conditions.every(isGuardExpression);
    }

    if (!('field' in value) || !('operator' in value) || !('value' in value)) {
      return false;
    }

    if (typeof value.field !== 'string') {
      return false;
    }

    if (typeof value.operator !== 'string' || !guardOperators.has(value.operator)) {
      return false;
    }

    return ['string', 'number', 'boolean'].includes(typeof value.value);
  }

  function normalizeWorkflowTreeKey(rawValue: unknown): string {
    if (typeof rawValue !== 'string') {
      throw new DashboardIntegrationError('invalid_request', 'Workflow tree key must be a string.', {
        status: 400,
      });
    }

    const value = rawValue.trim();
    if (value.length === 0) {
      throw new DashboardIntegrationError('invalid_request', 'Workflow tree key cannot be empty.', {
        status: 400,
      });
    }

    if (!/^[a-z0-9-]+$/.test(value)) {
      throw new DashboardIntegrationError(
        'invalid_request',
        'Workflow tree key must be lowercase and contain only a-z, 0-9, and hyphens.',
        { status: 400 },
      );
    }

    return value;
  }

  function isWorkflowTreeVersionUniqueConstraintError(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) {
      return false;
    }

    const code = 'code' in error ? (error as { code?: unknown }).code : undefined;
    if (code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return true;
    }

    const message =
      'message' in error && typeof (error as { message?: unknown }).message === 'string'
        ? (error as { message: string }).message.toLowerCase()
        : '';

    if (!message.includes('unique constraint failed')) {
      return false;
    }

    return (
      (message.includes('workflow_trees.tree_key') && message.includes('workflow_trees.version')) ||
      message.includes('workflow_trees_tree_key_version_uq')
    );
  }

  function computeInitialRunnableNodeKeys(
    nodes: readonly { nodeKey: string }[],
    edges: readonly { targetNodeKey: string }[],
  ): string[] {
    const incoming = new Set(edges.map(edge => edge.targetNodeKey));
    return nodes.filter(node => !incoming.has(node.nodeKey)).map(node => node.nodeKey);
  }

  function detectCycle(
    nodes: readonly { nodeKey: string }[],
    edges: readonly { sourceNodeKey: string; targetNodeKey: string }[],
  ): boolean {
    const adjacency = new Map<string, string[]>();
    for (const node of nodes) {
      adjacency.set(node.nodeKey, []);
    }
    for (const edge of edges) {
      adjacency.get(edge.sourceNodeKey)?.push(edge.targetNodeKey);
    }

    const visited = new Set<string>();
    const visiting = new Set<string>();

    function visit(nodeKey: string): boolean {
      if (visiting.has(nodeKey)) {
        return true;
      }
      if (visited.has(nodeKey)) {
        return false;
      }

      visiting.add(nodeKey);
      const next = adjacency.get(nodeKey) ?? [];
      for (const target of next) {
        if (visit(target)) {
          return true;
        }
      }
      visiting.delete(nodeKey);
      visited.add(nodeKey);
      return false;
    }

    for (const node of nodes) {
      if (visit(node.nodeKey)) {
        return true;
      }
    }

    return false;
  }

  function normalizeDraftTopologyKeys(
    topology: Pick<DashboardWorkflowDraftTopology, 'nodes' | 'edges'>,
  ): Pick<DashboardWorkflowDraftTopology, 'nodes' | 'edges'> {
    return {
      nodes: topology.nodes.map(node => ({ ...node, nodeKey: node.nodeKey.trim() })),
      edges: topology.edges.map(edge => ({
        ...edge,
        sourceNodeKey: edge.sourceNodeKey.trim(),
        targetNodeKey: edge.targetNodeKey.trim(),
      })),
    };
  }

  function validateDraftTopology(
    topology: Pick<DashboardWorkflowDraftTopology, 'nodes' | 'edges'>,
    mode: 'save' | 'publish',
  ): DashboardWorkflowValidationResult {
    const normalizedTopology = normalizeDraftTopologyKeys(topology);
    const errors: DashboardWorkflowValidationIssue[] = [];
    const warnings: DashboardWorkflowValidationIssue[] = [];

    if (normalizedTopology.nodes.length === 0) {
      errors.push({ code: 'no_nodes', message: 'Workflow must include at least one node.' });
    }

    const nodeKeys = new Set<string>();
    const sequenceIndexes = new Set<number>();
    for (const node of normalizedTopology.nodes) {
      if (!workflowNodeTypes.has(node.nodeType)) {
        errors.push({ code: 'node_type_invalid', message: `Node type "${node.nodeType}" is not supported.` });
        continue;
      }

      const trimmedKey = node.nodeKey.trim();
      if (trimmedKey.length === 0) {
        errors.push({ code: 'node_key_missing', message: 'Node key is required.' });
        continue;
      }
      if (nodeKeys.has(trimmedKey)) {
        errors.push({ code: 'duplicate_node_key', message: `Duplicate node key "${trimmedKey}".` });
      }
      nodeKeys.add(trimmedKey);

      if (sequenceIndexes.has(node.sequenceIndex)) {
        errors.push({
          code: 'duplicate_node_sequence_index',
          message: `Duplicate node sequence index ${node.sequenceIndex}.`,
        });
      }
      sequenceIndexes.add(node.sequenceIndex);

      const trimmedName = node.displayName.trim();
      if (trimmedName.length === 0) {
        errors.push({ code: 'node_name_missing', message: `Node "${trimmedKey}" must have a display name.` });
      }

      if (mode === 'publish' && node.nodeType !== 'agent') {
        errors.push({
          code: 'unsupported_node_type',
          message: `Node "${trimmedKey}" has unsupported type "${node.nodeType}" and cannot be published yet.`,
        });
      }

      if (node.nodeType === 'agent') {
        if (!node.provider || node.provider.trim().length === 0) {
          errors.push({ code: 'agent_provider_missing', message: `Agent node "${trimmedKey}" must have a provider.` });
        } else {
          try {
            resolveAgentProvider(node.provider);
          } catch (error) {
            const availableProviders =
              error instanceof UnknownAgentProviderError && error.availableProviders.length > 0
                ? error.availableProviders.join(', ')
                : '(none)';
            errors.push({
              code: 'agent_provider_invalid',
              message: `Agent node "${trimmedKey}" has unsupported provider value ${JSON.stringify(node.provider)}. Available providers: ${availableProviders}.`,
            });
          }
        }
        if (!node.promptTemplate || node.promptTemplate.content.trim().length === 0) {
          errors.push({ code: 'agent_prompt_missing', message: `Agent node "${trimmedKey}" must have a prompt.` });
        }
      }
    }

    const prioritiesBySource = new Map<string, Set<number>>();
    for (const edge of normalizedTopology.edges) {
      if (!nodeKeys.has(edge.sourceNodeKey)) {
        errors.push({
          code: 'edge_source_missing',
          message: `Transition source node "${edge.sourceNodeKey}" was not found.`,
        });
      }
      if (!nodeKeys.has(edge.targetNodeKey)) {
        errors.push({
          code: 'edge_target_missing',
          message: `Transition target node "${edge.targetNodeKey}" was not found.`,
        });
      }

      if (!Number.isFinite(edge.priority) || !Number.isInteger(edge.priority) || edge.priority < 0) {
        errors.push({
          code: 'transition_priority_invalid',
          message: `Transition priority ${edge.priority} from "${edge.sourceNodeKey}" must be a non-negative integer.`,
        });
      } else {
        const priorities = prioritiesBySource.get(edge.sourceNodeKey) ?? new Set<number>();
        if (priorities.has(edge.priority)) {
          errors.push({
            code: 'duplicate_transition_priority',
            message: `Duplicate transition priority ${edge.priority} from "${edge.sourceNodeKey}".`,
          });
        }
        priorities.add(edge.priority);
        prioritiesBySource.set(edge.sourceNodeKey, priorities);
      }

      if (edge.auto) {
        if (edge.guardExpression !== null) {
          errors.push({
            code: 'auto_edge_has_guard',
            message: `Auto transition ${edge.sourceNodeKey} → ${edge.targetNodeKey} must not have a guard.`,
          });
        }
      } else {
        if (edge.guardExpression === null) {
          errors.push({
            code: 'guard_missing',
            message: `Guarded transition ${edge.sourceNodeKey} → ${edge.targetNodeKey} must include a guard definition.`,
          });
        } else if (!isGuardExpression(edge.guardExpression)) {
          errors.push({
            code: 'guard_invalid',
            message: `Guard expression for ${edge.sourceNodeKey} → ${edge.targetNodeKey} must be parseable.`,
          });
        }
      }
    }

    const initialRunnableNodeKeys = computeInitialRunnableNodeKeys(normalizedTopology.nodes, normalizedTopology.edges);
    if (normalizedTopology.nodes.length > 0 && initialRunnableNodeKeys.length === 0) {
      errors.push({
        code: 'no_initial_nodes',
        message: 'Workflow must include at least one initial runnable node (a node with no incoming transitions).',
      });
    } else if (initialRunnableNodeKeys.length > 1) {
      warnings.push({
        code: 'multiple_initial_nodes',
        message: `Multiple initial runnable nodes detected: ${initialRunnableNodeKeys.join(', ')}.`,
      });
    }

    const hasCycles = detectCycle(normalizedTopology.nodes, normalizedTopology.edges);
    if (hasCycles) {
      warnings.push({ code: 'cycles_present', message: 'Cycles are present in the workflow graph.' });
    }

    const outgoingBySource = new Map<string, number>();
    for (const edge of normalizedTopology.edges) {
      outgoingBySource.set(edge.sourceNodeKey, (outgoingBySource.get(edge.sourceNodeKey) ?? 0) + 1);
    }
    for (const node of normalizedTopology.nodes) {
      if ((outgoingBySource.get(node.nodeKey) ?? 0) === 0) {
        warnings.push({
          code: 'terminal_node',
          message: `Node "${node.nodeKey}" has no outgoing transitions (terminal).`,
        });
      }
    }

    return { errors, warnings, initialRunnableNodeKeys };
  }

  function templatePrompt(template: DashboardCreateWorkflowRequest['template'], nodeKey: string): string {
    if (template !== 'design-implement-review') {
      return 'Describe what to do for this workflow phase.';
    }

    switch (nodeKey) {
      case 'design':
        return 'You are the design phase. Produce a clear design plan, constraints, and acceptance criteria.';
      case 'implement':
        return 'You are the implementation phase. Make the required code changes, run tests, and summarize the result.';
      case 'review':
        return 'You are the review phase. Audit changes for correctness, risks, and edge cases.';
      default:
        return 'Describe what to do for this workflow phase.';
    }
  }

  function loadDraftTopologyByTreeId(
    db: Pick<AlphredDatabase, 'select'>,
    treeId: number,
  ): Pick<DashboardWorkflowDraftTopology, 'nodes' | 'edges' | 'initialRunnableNodeKeys'> {
    const nodes = db
      .select({
        nodeKey: treeNodes.nodeKey,
        displayName: treeNodes.displayName,
        nodeType: treeNodes.nodeType,
        provider: treeNodes.provider,
        maxRetries: treeNodes.maxRetries,
        sequenceIndex: treeNodes.sequenceIndex,
        positionX: treeNodes.positionX,
        positionY: treeNodes.positionY,
        promptContent: promptTemplates.content,
        promptContentType: promptTemplates.contentType,
      })
      .from(treeNodes)
      .leftJoin(promptTemplates, eq(treeNodes.promptTemplateId, promptTemplates.id))
      .where(eq(treeNodes.workflowTreeId, treeId))
      .orderBy(asc(treeNodes.sequenceIndex), asc(treeNodes.nodeKey), asc(treeNodes.id))
      .all()
      .map((row) => ({
        nodeKey: row.nodeKey,
        displayName: row.displayName ?? row.nodeKey,
        nodeType: row.nodeType as 'agent' | 'human' | 'tool',
        provider: row.provider,
        maxRetries: row.maxRetries,
        sequenceIndex: row.sequenceIndex,
        position:
          row.positionX === null || row.positionY === null
            ? null
            : { x: row.positionX, y: row.positionY },
        promptTemplate:
          row.promptContent === null || row.promptContentType === null
            ? null
            : {
                content: row.promptContent,
                contentType: (row.promptContentType as 'text' | 'markdown') ?? 'markdown',
              },
      }));

    const nodeKeyById = new Map<number, string>(
      db
        .select({ id: treeNodes.id, nodeKey: treeNodes.nodeKey })
        .from(treeNodes)
        .where(eq(treeNodes.workflowTreeId, treeId))
        .all()
        .map((row) => [row.id, row.nodeKey]),
    );

    const edges = db
      .select({
        sourceNodeId: treeEdges.sourceNodeId,
        targetNodeId: treeEdges.targetNodeId,
        priority: treeEdges.priority,
        auto: treeEdges.auto,
        guardExpression: guardDefinitions.expression,
      })
      .from(treeEdges)
      .leftJoin(guardDefinitions, eq(treeEdges.guardDefinitionId, guardDefinitions.id))
      .where(eq(treeEdges.workflowTreeId, treeId))
      .orderBy(asc(treeEdges.sourceNodeId), asc(treeEdges.priority), asc(treeEdges.targetNodeId), asc(treeEdges.id))
      .all()
      .map((row) => ({
        sourceNodeKey: nodeKeyById.get(row.sourceNodeId) ?? 'unknown',
        targetNodeKey: nodeKeyById.get(row.targetNodeId) ?? 'unknown',
        priority: row.priority,
        auto: row.auto === 1,
        guardExpression: row.auto === 1 ? null : row.guardExpression,
      }));

    const initialRunnableNodeKeys = computeInitialRunnableNodeKeys(nodes, edges);
    return { nodes, edges, initialRunnableNodeKeys };
  }

  return {
    listWorkflowTrees(): Promise<DashboardWorkflowTreeSummary[]> {
      return withDatabase(async db => {
        const rows = db
          .select({
            id: workflowTrees.id,
            treeKey: workflowTrees.treeKey,
            version: workflowTrees.version,
            name: workflowTrees.name,
            description: workflowTrees.description,
          })
          .from(workflowTrees)
          .where(eq(workflowTrees.status, 'published'))
          .orderBy(asc(workflowTrees.treeKey), desc(workflowTrees.version), desc(workflowTrees.id))
          .all();

        const seen = new Set<string>();
        const workflows: DashboardWorkflowTreeSummary[] = [];
        for (const row of rows) {
          if (seen.has(row.treeKey)) {
            continue;
          }
          seen.add(row.treeKey);
          workflows.push(row);
        }

        return workflows;
      });
    },

    listWorkflowCatalog(): Promise<DashboardWorkflowCatalogItem[]> {
      return withDatabase(async db => {
        const rows = db
          .select({
            treeKey: workflowTrees.treeKey,
            version: workflowTrees.version,
            status: workflowTrees.status,
            name: workflowTrees.name,
            description: workflowTrees.description,
            updatedAt: workflowTrees.updatedAt,
          })
          .from(workflowTrees)
          .orderBy(asc(workflowTrees.treeKey), desc(workflowTrees.version), desc(workflowTrees.id))
          .all();

        const catalogByKey = new Map<string, DashboardWorkflowCatalogItem>();
        for (const row of rows) {
          const existing = catalogByKey.get(row.treeKey);
          if (!existing) {
            catalogByKey.set(row.treeKey, {
              treeKey: row.treeKey,
              name: row.name,
              description: row.description,
              publishedVersion: row.status === 'published' ? row.version : null,
              draftVersion: row.status === 'draft' ? row.version : null,
              updatedAt: row.updatedAt,
            });
            continue;
          }

          if (existing.publishedVersion === null && row.status === 'published') {
            existing.publishedVersion = row.version;
          }
          if (existing.draftVersion === null && row.status === 'draft') {
            existing.draftVersion = row.version;
            existing.updatedAt = row.updatedAt;
          }
        }

        return [...catalogByKey.values()];
      });
    },

	    async getWorkflowTreeSnapshot(treeKeyRaw: string): Promise<DashboardWorkflowTreeSnapshot> {
	      const treeKey = normalizeWorkflowTreeKey(treeKeyRaw);

	      return withDatabase(async db => {
	        const draft = db
	          .select({
	            id: workflowTrees.id,
	            version: workflowTrees.version,
	            status: workflowTrees.status,
	            name: workflowTrees.name,
	            description: workflowTrees.description,
              versionNotes: workflowTrees.versionNotes,
              draftRevision: workflowTrees.draftRevision,
	          })
	          .from(workflowTrees)
	          .where(and(eq(workflowTrees.treeKey, treeKey), eq(workflowTrees.status, 'draft')))
	          .orderBy(desc(workflowTrees.version), desc(workflowTrees.id))
	          .get();

        const published = draft
          ? null
          : db
	              .select({
	                id: workflowTrees.id,
	                version: workflowTrees.version,
	                status: workflowTrees.status,
	                name: workflowTrees.name,
	                description: workflowTrees.description,
                  versionNotes: workflowTrees.versionNotes,
                  draftRevision: workflowTrees.draftRevision,
	              })
	              .from(workflowTrees)
	              .where(and(eq(workflowTrees.treeKey, treeKey), eq(workflowTrees.status, 'published')))
	              .orderBy(desc(workflowTrees.version), desc(workflowTrees.id))
	              .get();

        const record = draft ?? published;
        if (!record) {
          throw new DashboardIntegrationError('not_found', `Workflow tree "${treeKey}" was not found.`, {
            status: 404,
          });
        }

	        const topology = loadDraftTopologyByTreeId(db, record.id);
	        return {
	          status: record.status as 'draft' | 'published',
	          treeKey,
	          version: record.version,
            draftRevision: record.draftRevision,
	          name: record.name,
	          description: record.description,
            versionNotes: record.versionNotes,
	          ...topology,
	        };
	      });
	    },

    async getWorkflowTreeVersionSnapshot(treeKeyRaw: string, version: number): Promise<DashboardWorkflowTreeSnapshot> {
      const treeKey = normalizeWorkflowTreeKey(treeKeyRaw);
      if (!Number.isInteger(version) || version < 1) {
        throw new DashboardIntegrationError('invalid_request', 'Workflow version must be a positive integer.', {
          status: 400,
        });
      }

	      return withDatabase(async db => {
	        const record = db
	          .select({
	            id: workflowTrees.id,
	            version: workflowTrees.version,
	            status: workflowTrees.status,
	            name: workflowTrees.name,
	            description: workflowTrees.description,
              versionNotes: workflowTrees.versionNotes,
              draftRevision: workflowTrees.draftRevision,
	          })
	          .from(workflowTrees)
	          .where(and(eq(workflowTrees.treeKey, treeKey), eq(workflowTrees.version, version)))
	          .get();

        if (!record) {
          throw new DashboardIntegrationError('not_found', `Workflow tree "${treeKey}" v${version} was not found.`, {
            status: 404,
          });
        }

	        const topology = loadDraftTopologyByTreeId(db, record.id);
	        return {
	          status: record.status as 'draft' | 'published',
	          treeKey,
	          version: record.version,
            draftRevision: record.draftRevision,
	          name: record.name,
	          description: record.description,
            versionNotes: record.versionNotes,
	          ...topology,
	        };
	      });
	    },

	    async createWorkflowDraft(request: DashboardCreateWorkflowRequest): Promise<DashboardCreateWorkflowResult> {
	      const name = request.name.trim();
	      if (name.length === 0) {
	        throw new DashboardIntegrationError('invalid_request', 'Workflow name cannot be empty.', { status: 400 });
	      }

      const treeKey = normalizeWorkflowTreeKey(request.treeKey);
      const description = request.description?.trim() ?? null;

      return withDatabase(async db =>
        db.transaction((tx) => {
          const existing = tx
            .select({ id: workflowTrees.id })
            .from(workflowTrees)
            .where(eq(workflowTrees.treeKey, treeKey))
            .get();
          if (existing) {
            throw new DashboardIntegrationError('conflict', `Workflow tree "${treeKey}" already exists.`, { status: 409 });
          }

	          const tree = tx
	            .insert(workflowTrees)
	            .values({
	              treeKey,
	              version: 1,
	              status: 'draft',
	              name,
	              description,
                versionNotes: null,
                draftRevision: 0,
	            })
	            .returning({ id: workflowTrees.id })
	            .get();

          if (request.template === 'design-implement-review') {
            const nodeSpecs: {
              nodeKey: string;
              displayName: string;
              position: { x: number; y: number };
              sequenceIndex: number;
            }[] = [
              { nodeKey: 'design', displayName: 'Design', position: { x: 0, y: 0 }, sequenceIndex: 10 },
              { nodeKey: 'implement', displayName: 'Implement', position: { x: 320, y: 0 }, sequenceIndex: 20 },
              { nodeKey: 'review', displayName: 'Review', position: { x: 640, y: 0 }, sequenceIndex: 30 },
            ];

            const promptTemplateIdByNodeKey = new Map<string, number>();
            for (const spec of nodeSpecs) {
              const prompt = tx
                .insert(promptTemplates)
                .values({
                  templateKey: `${treeKey}/v1/${spec.nodeKey}/prompt`,
                  version: 1,
                  content: templatePrompt(request.template, spec.nodeKey),
                  contentType: 'markdown',
                })
                .returning({ id: promptTemplates.id })
                .get();
              promptTemplateIdByNodeKey.set(spec.nodeKey, prompt.id);
            }

            const nodeIdByKey = new Map<string, number>();
            for (const spec of nodeSpecs) {
              const node = tx
                .insert(treeNodes)
                .values({
                  workflowTreeId: tree.id,
                  nodeKey: spec.nodeKey,
                  displayName: spec.displayName,
                  nodeType: 'agent',
                  provider: 'codex',
                  promptTemplateId: promptTemplateIdByNodeKey.get(spec.nodeKey) ?? null,
                  maxRetries: 0,
                  sequenceIndex: spec.sequenceIndex,
                  positionX: spec.position.x,
                  positionY: spec.position.y,
                })
                .returning({ id: treeNodes.id })
                .get();
              nodeIdByKey.set(spec.nodeKey, node.id);
            }

            const designId = nodeIdByKey.get('design');
            const implementId = nodeIdByKey.get('implement');
            const reviewId = nodeIdByKey.get('review');
            if (!designId || !implementId || !reviewId) {
              throw new DashboardIntegrationError('internal_error', 'Failed to seed template node IDs.', { status: 500 });
            }

            const reviseGuard = tx
              .insert(guardDefinitions)
              .values({
                guardKey: `${treeKey}/v1/review->implement/priority-10`,
                version: 1,
                expression: { field: 'decision', operator: '==', value: 'changes_requested' },
                description: 'Loop back when changes are requested.',
              })
              .returning({ id: guardDefinitions.id })
              .get();

            tx.insert(treeEdges)
              .values({
                workflowTreeId: tree.id,
                sourceNodeId: designId,
                targetNodeId: implementId,
                priority: 100,
                auto: 1,
                guardDefinitionId: null,
              })
              .run();

            tx.insert(treeEdges)
              .values({
                workflowTreeId: tree.id,
                sourceNodeId: reviewId,
                targetNodeId: implementId,
                priority: 10,
                auto: 0,
                guardDefinitionId: reviseGuard.id,
              })
              .run();

            tx.insert(treeEdges)
              .values({
                workflowTreeId: tree.id,
                sourceNodeId: implementId,
                targetNodeId: reviewId,
                priority: 100,
                auto: 1,
                guardDefinitionId: null,
              })
              .run();
          }

          return { treeKey, draftVersion: 1 };
        }),
	      );
	    },

	    async duplicateWorkflowTree(
	      sourceTreeKeyRaw: string,
	      request: DashboardDuplicateWorkflowRequest,
	    ): Promise<DashboardDuplicateWorkflowResult> {
	      const sourceTreeKey = normalizeWorkflowTreeKey(sourceTreeKeyRaw);

	      const name = request.name.trim();
	      if (name.length === 0) {
	        throw new DashboardIntegrationError('invalid_request', 'Workflow name cannot be empty.', { status: 400 });
	      }

	      const treeKey = normalizeWorkflowTreeKey(request.treeKey);
	      const description = request.description?.trim() ?? null;

	      return withDatabase(async db =>
	        db.transaction((tx) => {
	          const existing = tx
	            .select({ id: workflowTrees.id })
	            .from(workflowTrees)
	            .where(eq(workflowTrees.treeKey, treeKey))
	            .get();
	          if (existing) {
	            throw new DashboardIntegrationError('conflict', `Workflow tree "${treeKey}" already exists.`, { status: 409 });
	          }

	          const draftSource = tx
	            .select({ id: workflowTrees.id })
	            .from(workflowTrees)
	            .where(and(eq(workflowTrees.treeKey, sourceTreeKey), eq(workflowTrees.status, 'draft')))
	            .orderBy(desc(workflowTrees.version), desc(workflowTrees.id))
	            .get();

	          const publishedSource = draftSource
	            ? null
	            : tx
	                .select({ id: workflowTrees.id })
	                .from(workflowTrees)
	                .where(and(eq(workflowTrees.treeKey, sourceTreeKey), eq(workflowTrees.status, 'published')))
	                .orderBy(desc(workflowTrees.version), desc(workflowTrees.id))
	                .get();

	          const sourceRecord = draftSource ?? publishedSource;
	          if (!sourceRecord) {
	            throw new DashboardIntegrationError('not_found', `Workflow tree "${sourceTreeKey}" was not found.`, {
	              status: 404,
	            });
	          }

	          const topology = loadDraftTopologyByTreeId(tx, sourceRecord.id);

	          const insertedTree = tx
	            .insert(workflowTrees)
	            .values({
	              treeKey,
	              version: 1,
	              status: 'draft',
	              name,
	              description,
	              versionNotes: null,
	              draftRevision: 0,
	            })
	            .returning({ id: workflowTrees.id })
	            .get();

	          const promptTemplateIdByNodeKey = new Map<string, number>();
	          for (const node of topology.nodes) {
	            if (!node.promptTemplate) {
	              continue;
	            }
	            const inserted = tx
	              .insert(promptTemplates)
	              .values({
	                templateKey: `${treeKey}/v1/${node.nodeKey}/prompt`,
	                version: 1,
	                content: node.promptTemplate.content,
	                contentType: node.promptTemplate.contentType,
	              })
	              .returning({ id: promptTemplates.id })
	              .get();
	            promptTemplateIdByNodeKey.set(node.nodeKey, inserted.id);
	          }

	          const nodeIdByKey = new Map<string, number>();
	          for (const node of topology.nodes) {
	            const inserted = tx
	              .insert(treeNodes)
	              .values({
	                workflowTreeId: insertedTree.id,
	                nodeKey: node.nodeKey,
	                displayName: node.displayName,
	                nodeType: node.nodeType,
	                provider: node.provider,
	                promptTemplateId: promptTemplateIdByNodeKey.get(node.nodeKey) ?? null,
	                maxRetries: node.maxRetries,
	                sequenceIndex: node.sequenceIndex,
	                positionX: node.position?.x ?? null,
	                positionY: node.position?.y ?? null,
	              })
	              .returning({ id: treeNodes.id })
	              .get();
	            nodeIdByKey.set(node.nodeKey, inserted.id);
	          }

	          const guardDefinitionIdByKey = new Map<string, number>();
	          for (const edge of topology.edges) {
	            if (edge.auto || edge.guardExpression === null) {
	              continue;
	            }
	            const key = `${edge.sourceNodeKey}->${edge.targetNodeKey}/priority-${edge.priority}`;
	            const inserted = tx
	              .insert(guardDefinitions)
	              .values({
	                guardKey: `${treeKey}/v1/${key}`,
	                version: 1,
	                expression: edge.guardExpression,
	                description: null,
	              })
	              .returning({ id: guardDefinitions.id })
	              .get();
	            guardDefinitionIdByKey.set(key, inserted.id);
	          }

	          for (const edge of topology.edges) {
	            const sourceNodeId = nodeIdByKey.get(edge.sourceNodeKey);
	            const targetNodeId = nodeIdByKey.get(edge.targetNodeKey);
	            if (!sourceNodeId || !targetNodeId) {
	              throw new DashboardIntegrationError(
	                'internal_error',
	                `Failed to resolve node IDs for transition ${edge.sourceNodeKey} → ${edge.targetNodeKey}.`,
	                {
	                  status: 500,
	                  details: { sourceNodeKey: edge.sourceNodeKey, targetNodeKey: edge.targetNodeKey },
	                },
	              );
	            }

	            const key = `${edge.sourceNodeKey}->${edge.targetNodeKey}/priority-${edge.priority}`;
	            if (!edge.auto && !guardDefinitionIdByKey.has(key)) {
	              throw new DashboardIntegrationError(
	                'internal_error',
	                `Failed to resolve guard definition for transition ${edge.sourceNodeKey} → ${edge.targetNodeKey} (priority ${edge.priority}).`,
	                {
	                  status: 500,
	                  details: { transitionKey: key },
	                },
	              );
	            }

	            tx.insert(treeEdges)
	              .values({
	                workflowTreeId: insertedTree.id,
	                sourceNodeId,
	                targetNodeId,
	                priority: edge.priority,
	                auto: edge.auto ? 1 : 0,
	                guardDefinitionId: edge.auto ? null : (guardDefinitionIdByKey.get(key) ?? null),
	              })
	              .run();
	          }

	          return { treeKey, draftVersion: 1 };
	        }),
	      );
	    },

    async getOrCreateWorkflowDraft(treeKeyRaw: string): Promise<DashboardWorkflowDraftTopology> {
      const treeKey = normalizeWorkflowTreeKey(treeKeyRaw);

      return withDatabase(async db => {
        const loadLatestDraft = () =>
          db
            .select({
              id: workflowTrees.id,
              version: workflowTrees.version,
              name: workflowTrees.name,
              description: workflowTrees.description,
              versionNotes: workflowTrees.versionNotes,
              draftRevision: workflowTrees.draftRevision,
            })
            .from(workflowTrees)
            .where(and(eq(workflowTrees.treeKey, treeKey), eq(workflowTrees.status, 'draft')))
            .orderBy(desc(workflowTrees.version), desc(workflowTrees.id))
            .get();

        const toDraftTopology = (
          draftRecord: {
            id: number;
            version: number;
            name: string;
            description: string | null;
            versionNotes: string | null;
            draftRevision: number;
          },
        ): DashboardWorkflowDraftTopology => {
          const topology = loadDraftTopologyByTreeId(db, draftRecord.id);
          return {
            treeKey,
            version: draftRecord.version,
            draftRevision: draftRecord.draftRevision,
            name: draftRecord.name,
            description: draftRecord.description,
            versionNotes: draftRecord.versionNotes,
            ...topology,
          };
        };

        const existingDraft = loadLatestDraft();
        if (existingDraft) {
          return toDraftTopology(existingDraft);
        }

        const published = db
          .select({
            id: workflowTrees.id,
            version: workflowTrees.version,
            name: workflowTrees.name,
            description: workflowTrees.description,
          })
          .from(workflowTrees)
          .where(and(eq(workflowTrees.treeKey, treeKey), eq(workflowTrees.status, 'published')))
          .orderBy(desc(workflowTrees.version), desc(workflowTrees.id))
          .get();
        if (!published) {
          throw new DashboardIntegrationError('not_found', `Workflow tree "${treeKey}" was not found.`, {
            status: 404,
          });
        }

        const draftVersion = published.version + 1;
        const createDraftFromPublished = () =>
          db.transaction((tx) => {
            const insertedDraft = tx
              .insert(workflowTrees)
              .values({
                treeKey,
                version: draftVersion,
                status: 'draft',
                name: published.name,
                description: published.description,
                versionNotes: null,
                draftRevision: 0,
              })
              .returning({ id: workflowTrees.id })
              .get();
            const draftTreeId = insertedDraft.id;

            const publishedNodes = tx
              .select({
                id: treeNodes.id,
                nodeKey: treeNodes.nodeKey,
                displayName: treeNodes.displayName,
                nodeType: treeNodes.nodeType,
                provider: treeNodes.provider,
                maxRetries: treeNodes.maxRetries,
                sequenceIndex: treeNodes.sequenceIndex,
                positionX: treeNodes.positionX,
                positionY: treeNodes.positionY,
                promptTemplateId: treeNodes.promptTemplateId,
              })
              .from(treeNodes)
              .where(eq(treeNodes.workflowTreeId, published.id))
              .orderBy(asc(treeNodes.sequenceIndex), asc(treeNodes.id))
              .all();

            const promptTemplateIds = publishedNodes
              .map(node => node.promptTemplateId)
              .filter((id): id is number => typeof id === 'number');
            const promptTemplateRows =
              promptTemplateIds.length === 0
                ? []
                : tx
                    .select({
                      id: promptTemplates.id,
                      content: promptTemplates.content,
                      contentType: promptTemplates.contentType,
                    })
                    .from(promptTemplates)
                    .where(inArray(promptTemplates.id, promptTemplateIds))
                    .all();

            const promptTemplateById = new Map(promptTemplateRows.map(row => [row.id, row]));
            const promptTemplateCloneById = new Map<number, number>();
            for (const templateId of promptTemplateIds) {
              if (promptTemplateCloneById.has(templateId)) {
                continue;
              }
              const template = promptTemplateById.get(templateId);
              if (!template) {
                continue;
              }
              const inserted = tx
                .insert(promptTemplates)
                .values({
                  templateKey: `${treeKey}/v${draftVersion}/prompt-template/${templateId}`,
                  version: 1,
                  content: template.content,
                  contentType: template.contentType,
                })
                .returning({ id: promptTemplates.id })
                .get();
              promptTemplateCloneById.set(templateId, inserted.id);
            }

            const nodeIdCloneById = new Map<number, number>();
            for (const node of publishedNodes) {
              const inserted = tx
                .insert(treeNodes)
                .values({
                  workflowTreeId: draftTreeId,
                  nodeKey: node.nodeKey,
                  displayName: node.displayName,
                  nodeType: node.nodeType,
                  provider: node.provider,
                  promptTemplateId:
                    node.promptTemplateId === null ? null : (promptTemplateCloneById.get(node.promptTemplateId) ?? null),
                  maxRetries: node.maxRetries,
                  sequenceIndex: node.sequenceIndex,
                  positionX: node.positionX,
                  positionY: node.positionY,
                })
                .returning({ id: treeNodes.id })
                .get();
              nodeIdCloneById.set(node.id, inserted.id);
            }

            const publishedEdges = tx
              .select({
                sourceNodeId: treeEdges.sourceNodeId,
                targetNodeId: treeEdges.targetNodeId,
                priority: treeEdges.priority,
                auto: treeEdges.auto,
                guardDefinitionId: treeEdges.guardDefinitionId,
              })
              .from(treeEdges)
              .where(eq(treeEdges.workflowTreeId, published.id))
              .orderBy(asc(treeEdges.sourceNodeId), asc(treeEdges.priority), asc(treeEdges.id))
              .all();

            const guardDefinitionIds = publishedEdges
              .map(edge => edge.guardDefinitionId)
              .filter((id): id is number => typeof id === 'number');
            const guardRows =
              guardDefinitionIds.length === 0
                ? []
                : tx
                    .select({
                      id: guardDefinitions.id,
                      expression: guardDefinitions.expression,
                      description: guardDefinitions.description,
                    })
                    .from(guardDefinitions)
                    .where(inArray(guardDefinitions.id, guardDefinitionIds))
                    .all();
            const guardById = new Map(guardRows.map(row => [row.id, row]));
            const guardCloneById = new Map<number, number>();
            for (const guardId of guardDefinitionIds) {
              if (guardCloneById.has(guardId)) {
                continue;
              }
              const guard = guardById.get(guardId);
              if (!guard) {
                continue;
              }
              const inserted = tx
                .insert(guardDefinitions)
                .values({
                  guardKey: `${treeKey}/v${draftVersion}/guard/${guardId}`,
                  version: 1,
                  expression: guard.expression,
                  description: guard.description,
                })
                .returning({ id: guardDefinitions.id })
                .get();
              guardCloneById.set(guardId, inserted.id);
            }

            for (const edge of publishedEdges) {
              const sourceNodeId = nodeIdCloneById.get(edge.sourceNodeId);
              const targetNodeId = nodeIdCloneById.get(edge.targetNodeId);
              if (!sourceNodeId || !targetNodeId) {
                continue;
              }
              tx.insert(treeEdges)
                .values({
                  workflowTreeId: draftTreeId,
                  sourceNodeId,
                  targetNodeId,
                  priority: edge.priority,
                  auto: edge.auto,
                  guardDefinitionId:
                    edge.guardDefinitionId === null ? null : (guardCloneById.get(edge.guardDefinitionId) ?? null),
                })
                .run();
            }

            const topology = loadDraftTopologyByTreeId(tx, draftTreeId);
            return {
              treeKey,
              version: draftVersion,
              draftRevision: 0,
              name: published.name,
              description: published.description,
              versionNotes: null,
              ...topology,
            };
          });

        try {
          return createDraftFromPublished();
        } catch (error) {
          if (!isWorkflowTreeVersionUniqueConstraintError(error)) {
            throw error;
          }

          const concurrentDraft = loadLatestDraft();
          if (!concurrentDraft) {
            throw error;
          }
          return toDraftTopology(concurrentDraft);
        }
      });
    },

	    async saveWorkflowDraft(
	      treeKeyRaw: string,
	      version: number,
	      request: DashboardSaveWorkflowDraftRequest,
	    ): Promise<DashboardWorkflowDraftTopology> {
	      const treeKey = normalizeWorkflowTreeKey(treeKeyRaw);
	      if (!Number.isInteger(version) || version < 1) {
	        throw new DashboardIntegrationError('invalid_request', 'Workflow version must be a positive integer.', {
	          status: 400,
	        });
	      }

	      const name = request.name.trim();
	      if (name.length === 0) {
	        throw new DashboardIntegrationError('invalid_request', 'Workflow name cannot be empty.', { status: 400 });
	      }

	      if (!Number.isInteger(request.draftRevision) || request.draftRevision < 1) {
	        throw new DashboardIntegrationError('invalid_request', 'Draft revision must be a positive integer.', {
	          status: 400,
	        });
	      }

	      const normalizedTopology = normalizeDraftTopologyKeys({ nodes: request.nodes, edges: request.edges });
	      const draftValidation = validateDraftTopology(normalizedTopology, 'save');
	      if (draftValidation.errors.length > 0) {
	        throw new DashboardIntegrationError('invalid_request', 'Draft workflow failed validation and cannot be saved.', {
	          status: 400,
	          details: draftValidation as unknown as Record<string, unknown>,
	        });
	      }

	      const description = request.description?.trim() ?? null;
	      const versionNotes = request.versionNotes?.trim() ?? null;

	      return withDatabase(async db =>
	        db.transaction((tx) => {
	          const tree = tx
	            .select({
	              id: workflowTrees.id,
	              draftRevision: workflowTrees.draftRevision,
	            })
	            .from(workflowTrees)
	            .where(and(eq(workflowTrees.treeKey, treeKey), eq(workflowTrees.version, version), eq(workflowTrees.status, 'draft')))
	            .get();
	          if (!tree) {
	            throw new DashboardIntegrationError('not_found', `Draft workflow tree "${treeKey}" v${version} was not found.`, {
	              status: 404,
	            });
	          }

	          const expectedDraftRevision = tree.draftRevision + 1;
	          if (request.draftRevision !== expectedDraftRevision) {
	            throw new DashboardIntegrationError(
	              'conflict',
	              'Draft workflow is out of date. Refresh the editor before saving again.',
	              {
	                status: 409,
	                details: {
	                  currentDraftRevision: tree.draftRevision,
	                  receivedDraftRevision: request.draftRevision,
	                  expectedDraftRevision,
	                  expectedMinDraftRevision: expectedDraftRevision,
	                },
	              },
	            );
	          }

	          const saveUpdate = tx.update(workflowTrees)
	            .set({ name, description, versionNotes, draftRevision: request.draftRevision, updatedAt: utcNow })
	            .where(
	              and(
	                eq(workflowTrees.id, tree.id),
	                eq(workflowTrees.status, 'draft'),
	                eq(workflowTrees.draftRevision, tree.draftRevision),
	              ),
	            )
	            .run();
	          if (saveUpdate.changes !== 1) {
	            throw new DashboardIntegrationError(
	              'conflict',
	              'Draft workflow changed while saving. Refresh the editor before saving again.',
	              {
	                status: 409,
	                details: {
	                  expectedPreviousDraftRevision: tree.draftRevision,
	                  receivedDraftRevision: request.draftRevision,
	                  expectedDraftRevision,
	                },
	              },
	            );
	          }

          const existingPromptTemplateIds = tx
            .select({ id: treeNodes.promptTemplateId })
            .from(treeNodes)
            .where(eq(treeNodes.workflowTreeId, tree.id))
            .all()
            .map(row => row.id)
            .filter((id): id is number => typeof id === 'number');

          const existingGuardDefinitionIds = tx
            .select({ id: treeEdges.guardDefinitionId })
            .from(treeEdges)
            .where(eq(treeEdges.workflowTreeId, tree.id))
            .all()
            .map(row => row.id)
            .filter((id): id is number => typeof id === 'number');

          tx.delete(treeEdges).where(eq(treeEdges.workflowTreeId, tree.id)).run();
          tx.delete(treeNodes).where(eq(treeNodes.workflowTreeId, tree.id)).run();

          if (existingPromptTemplateIds.length > 0) {
            tx.delete(promptTemplates).where(inArray(promptTemplates.id, existingPromptTemplateIds)).run();
          }
          if (existingGuardDefinitionIds.length > 0) {
            tx.delete(guardDefinitions).where(inArray(guardDefinitions.id, existingGuardDefinitionIds)).run();
          }

	          const promptTemplateIdByNodeKey = new Map<string, number>();
	          for (const node of normalizedTopology.nodes) {
	            if (!node.promptTemplate) {
	              continue;
	            }
            const inserted = tx
              .insert(promptTemplates)
              .values({
                templateKey: `${treeKey}/v${version}/${node.nodeKey}/prompt`,
                version: 1,
                content: node.promptTemplate.content,
                contentType: node.promptTemplate.contentType,
              })
              .returning({ id: promptTemplates.id })
              .get();
            promptTemplateIdByNodeKey.set(node.nodeKey, inserted.id);
	          }

	          const nodeIdByKey = new Map<string, number>();
	          for (const node of normalizedTopology.nodes) {
	            const inserted = tx
	              .insert(treeNodes)
	              .values({
                workflowTreeId: tree.id,
                nodeKey: node.nodeKey,
                displayName: node.displayName,
                nodeType: node.nodeType,
                provider: node.provider,
                promptTemplateId: promptTemplateIdByNodeKey.get(node.nodeKey) ?? null,
                maxRetries: node.maxRetries,
                sequenceIndex: node.sequenceIndex,
                positionX: node.position?.x ?? null,
                positionY: node.position?.y ?? null,
              })
              .returning({ id: treeNodes.id })
              .get();
            nodeIdByKey.set(node.nodeKey, inserted.id);
	          }

	          const guardDefinitionIdByKey = new Map<string, number>();
	          for (const edge of normalizedTopology.edges) {
	            if (edge.auto || edge.guardExpression === null) {
	              continue;
	            }
            const key = `${edge.sourceNodeKey}->${edge.targetNodeKey}/priority-${edge.priority}`;
            const inserted = tx
              .insert(guardDefinitions)
              .values({
                guardKey: `${treeKey}/v${version}/${key}`,
                version: 1,
                expression: edge.guardExpression,
                description: null,
              })
              .returning({ id: guardDefinitions.id })
              .get();
	            guardDefinitionIdByKey.set(key, inserted.id);
	          }

		          for (const edge of normalizedTopology.edges) {
		            const sourceNodeId = nodeIdByKey.get(edge.sourceNodeKey);
		            const targetNodeId = nodeIdByKey.get(edge.targetNodeKey);
		            if (!sourceNodeId || !targetNodeId) {
	              throw new DashboardIntegrationError(
	                'internal_error',
	                `Failed to resolve node IDs for transition ${edge.sourceNodeKey} → ${edge.targetNodeKey}.`,
	                {
	                  status: 500,
	                  details: { sourceNodeKey: edge.sourceNodeKey, targetNodeKey: edge.targetNodeKey },
	                },
	              );
	            }

	            const key = `${edge.sourceNodeKey}->${edge.targetNodeKey}/priority-${edge.priority}`;
	            if (!edge.auto && !guardDefinitionIdByKey.has(key)) {
	              throw new DashboardIntegrationError(
	                'internal_error',
	                `Failed to resolve guard definition for transition ${edge.sourceNodeKey} → ${edge.targetNodeKey} (priority ${edge.priority}).`,
	                {
	                  status: 500,
	                  details: { transitionKey: key },
	                },
	              );
	            }
	            tx.insert(treeEdges)
	              .values({
	                workflowTreeId: tree.id,
	                sourceNodeId,
	                targetNodeId,
	                priority: edge.priority,
	                auto: edge.auto ? 1 : 0,
	                guardDefinitionId: edge.auto ? null : (guardDefinitionIdByKey.get(key) ?? null),
	              })
	              .run();
	          }

	          const topology = loadDraftTopologyByTreeId(tx, tree.id);
	          return {
	            treeKey,
	            version,
	            draftRevision: request.draftRevision,
	            name,
	            description,
	            versionNotes,
	            ...topology,
	          };
	        }),
	      );
	    },

    async validateWorkflowDraft(treeKeyRaw: string, version: number): Promise<DashboardWorkflowValidationResult> {
      const treeKey = normalizeWorkflowTreeKey(treeKeyRaw);
      if (!Number.isInteger(version) || version < 1) {
        throw new DashboardIntegrationError('invalid_request', 'Workflow version must be a positive integer.', {
          status: 400,
        });
      }

      return withDatabase(async db => {
        const tree = db
          .select({ id: workflowTrees.id })
          .from(workflowTrees)
          .where(and(eq(workflowTrees.treeKey, treeKey), eq(workflowTrees.version, version), eq(workflowTrees.status, 'draft')))
          .get();
        if (!tree) {
          throw new DashboardIntegrationError('not_found', `Draft workflow tree "${treeKey}" v${version} was not found.`, {
            status: 404,
          });
        }

        const topology = loadDraftTopologyByTreeId(db, tree.id);
        return validateDraftTopology({ nodes: topology.nodes, edges: topology.edges }, 'publish');
      });
    },

	    async publishWorkflowDraft(
	      treeKeyRaw: string,
	      version: number,
	      request: DashboardPublishWorkflowDraftRequest,
	    ): Promise<DashboardWorkflowTreeSummary> {
	      const treeKey = normalizeWorkflowTreeKey(treeKeyRaw);
	      if (!Number.isInteger(version) || version < 1) {
	        throw new DashboardIntegrationError('invalid_request', 'Workflow version must be a positive integer.', {
          status: 400,
        });
      }

      return withDatabase(async db => {
        const tree = db
          .select({
            id: workflowTrees.id,
            name: workflowTrees.name,
            description: workflowTrees.description,
            draftRevision: workflowTrees.draftRevision,
          })
          .from(workflowTrees)
          .where(and(eq(workflowTrees.treeKey, treeKey), eq(workflowTrees.version, version), eq(workflowTrees.status, 'draft')))
          .get();
        if (!tree) {
          throw new DashboardIntegrationError('not_found', `Draft workflow tree "${treeKey}" v${version} was not found.`, {
            status: 404,
          });
        }

        const topology = loadDraftTopologyByTreeId(db, tree.id);
        const validation = validateDraftTopology({ nodes: topology.nodes, edges: topology.edges }, 'publish');
        if (validation.errors.length > 0) {
          throw new DashboardIntegrationError('invalid_request', 'Draft workflow failed validation and cannot be published.', {
            status: 400,
            details: validation as unknown as Record<string, unknown>,
          });
        }

	        const nextVersionNotes =
	          request.versionNotes === undefined ? undefined : (request.versionNotes.trim().length > 0 ? request.versionNotes.trim() : null);

	        const publishUpdate = db.update(workflowTrees)
	          .set({
	            status: 'published',
	            updatedAt: utcNow,
	            draftRevision: 0,
	            ...(nextVersionNotes === undefined ? {} : { versionNotes: nextVersionNotes }),
	          })
	          .where(
	            and(
	              eq(workflowTrees.id, tree.id),
	              eq(workflowTrees.status, 'draft'),
	              eq(workflowTrees.draftRevision, tree.draftRevision),
	            ),
	          )
	          .run();
	        if (publishUpdate.changes !== 1) {
	          throw new DashboardIntegrationError(
	            'conflict',
	            'Draft workflow changed while publishing. Refresh the editor and try publishing again.',
	            {
	              status: 409,
	              details: {
	                expectedDraftRevision: tree.draftRevision,
	              },
	            },
	          );
	        }

        return {
          id: tree.id,
          treeKey,
          version,
          name: tree.name,
          description: tree.description,
        };
      });
    },

    listRepositories(): Promise<DashboardRepositoryState[]> {
      return withDatabase(async db => listRepositories(db).map(toRepositoryState));
    },

    async createRepository(request: DashboardCreateRepositoryRequest): Promise<DashboardCreateRepositoryResult> {
      const trimmedName = request.name.trim();
      if (trimmedName.length === 0) {
        throw new DashboardIntegrationError('invalid_request', 'Repository name cannot be empty.', {
          status: 400,
        });
      }

      const trimmedRemoteRef = request.remoteRef.trim();
      if (trimmedRemoteRef.length === 0) {
        throw new DashboardIntegrationError('invalid_request', 'Repository remoteRef cannot be empty.', {
          status: 400,
        });
      }

      return withDatabase(async db => {
        const existing = getRepositoryByName(db, trimmedName);
        if (existing) {
          throw new DashboardIntegrationError('conflict', `Repository "${trimmedName}" already exists.`, {
            status: 409,
          });
        }

        const parsedRemoteRef = parseGitHubRemoteRef(trimmedRemoteRef);
        const inserted = insertRepository(db, {
          name: trimmedName,
          provider: request.provider,
          remoteRef: `${parsedRemoteRef.owner}/${parsedRemoteRef.repository}`,
          remoteUrl: `https://github.com/${parsedRemoteRef.owner}/${parsedRemoteRef.repository}.git`,
        });

        return {
          repository: toRepositoryState(inserted),
        };
      });
    },

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

        const nodes: DashboardRunNodeSnapshot[] = latestNodes.map(node => ({
          ...node,
          latestArtifact: latestArtifactByRunNodeId.get(node.id) ?? null,
          latestRoutingDecision: latestDecisionByRunNodeId.get(node.id) ?? null,
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
          worktrees: allRunWorktrees.map(toWorktreeMetadata),
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

    checkGitHubAuth(): Promise<DashboardGitHubAuthStatus> {
      return withDatabase(async db => {
        const githubRepo = listRepositories(db).find(repository => repository.provider === 'github');
        const provider = dependencies.createScmProvider({
          kind: 'github',
          repo: githubRepo?.remoteRef ?? environment.ALPHRED_DASHBOARD_GITHUB_AUTH_REPO ?? DEFAULT_GITHUB_AUTH_REPO,
        });
        const auth = await provider.checkAuth(environment);

        return {
          authenticated: auth.authenticated,
          user: auth.user ?? null,
          scopes: auth.scopes ?? [],
          error: auth.error ?? null,
        };
      });
    },

    syncRepository(repositoryName: string): Promise<DashboardRepositorySyncResult> {
      const trimmedRepositoryName = repositoryName.trim();
      if (trimmedRepositoryName.length === 0) {
        throw new DashboardIntegrationError('invalid_request', 'Repository name cannot be empty.', {
          status: 400,
        });
      }

      return withDatabase(async db => {
        const repository = getRepositoryByName(db, trimmedRepositoryName);
        if (!repository) {
          throw new DashboardIntegrationError('not_found', `Repository "${trimmedRepositoryName}" was not found.`, {
            status: 404,
          });
        }

        await ensureRepositoryAuth(repository);

        const cloned = await dependencies.ensureRepositoryClone({
          db,
          repository: {
            name: repository.name,
            provider: repository.provider,
            remoteUrl: repository.remoteUrl,
            remoteRef: repository.remoteRef,
            defaultBranch: repository.defaultBranch,
          },
          environment,
        });

        return {
          action: cloned.action,
          repository: toRepositoryState(cloned.repository),
        };
      });
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

            await ensureRepositoryAuth(repository);

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
            const execution = await executeWorkflowRun(
              db,
              runId,
              workingDirectory,
              worktreeManager,
              request.cleanupWorktree ?? false,
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

          const executionPromise = withDatabase(async backgroundDb => {
            const backgroundWorktreeManager = worktreeManager
              ? dependencies.createWorktreeManager(backgroundDb, environment)
              : null;
            await executeWorkflowRun(
              backgroundDb,
              runId,
              workingDirectory,
              backgroundWorktreeManager,
              request.cleanupWorktree ?? false,
            );
          })
            .then(() => undefined)
            .catch(async (error: unknown) => {
              await markRunTerminalAfterBackgroundFailure(runId, error);
            })
            .finally(() => {
              backgroundRunExecutions.delete(runId);
            });

          backgroundRunExecutions.set(runId, executionPromise);

          return {
            workflowRunId,
            mode: 'async',
            status: 'accepted',
            runStatus: BACKGROUND_RUN_STATUS,
            executionOutcome: null,
            executedNodes: null,
          };
        } catch (error) {
          await markPendingRunCancelled(db, workflowRunId);
          throw error;
        }
      });
    },

    getBackgroundExecutionCount(): number {
      return backgroundRunExecutions.size;
    },

    hasBackgroundExecution(runId: number): boolean {
      return backgroundRunExecutions.has(runId);
    },
  };
}
