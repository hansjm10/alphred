import { join, posix } from 'node:path';
import { CodexProviderError, resolveAgentProvider } from '@alphred/agents';
import {
  createSqlWorkflowExecutor,
  createSqlWorkflowPlanner,
  type PhaseProviderResolver,
} from '@alphred/core';
import {
  and,
  createDatabase,
  eq,
  migrateDatabase,
  repositories as repositoriesTable,
  workItems as workItemsTable,
  type AlphredDatabase,
} from '@alphred/db';
import {
  WorktreeManager,
  createScmProvider,
  ensureRepositoryClone,
  resolveSandboxDir,
  type ScmProviderConfig,
} from '@alphred/git';
import {
  compareStringsByCodeUnit,
  type AuthStatus,
} from '@alphred/shared';
import { createBackgroundExecutionManager } from './background-execution';
import { DashboardIntegrationError, toDashboardIntegrationError } from './dashboard-errors';
import { createRepositoryOperations } from './repository-operations';
import { createRunOperations } from './run-operations';
import { resolveDatabasePath } from './dashboard-utils';
import { createWorkItemOperations, validateMoveWorkItemStatusRequest } from './work-item-operations';
import { createWorkflowDraftOperations } from './workflow-draft-operations';
import { createWorkflowOperations } from './workflow-operations';

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

  const backgroundExecution = createBackgroundExecutionManager({
    withDatabase,
    dependencies: {
      createSqlWorkflowExecutor: dependencies.createSqlWorkflowExecutor,
      resolveProvider: dependencies.resolveProvider,
      createWorktreeManager: dependencies.createWorktreeManager,
    },
    environment,
    cwd,
  });

  const workflowOperations = createWorkflowOperations({ withDatabase });
  const workflowDraftOperations = createWorkflowDraftOperations({ withDatabase });
  const repositoryOperations = createRepositoryOperations({
    withDatabase,
    dependencies: {
      createScmProvider: dependencies.createScmProvider,
      ensureRepositoryClone: dependencies.ensureRepositoryClone,
    },
    environment,
  });
  const workItemOperations = createWorkItemOperations({ withDatabase });
  const runOperations = createRunOperations({
    withDatabase,
    dependencies: {
      createSqlWorkflowPlanner: dependencies.createSqlWorkflowPlanner,
      createSqlWorkflowExecutor: dependencies.createSqlWorkflowExecutor,
      resolveProvider: dependencies.resolveProvider,
      createWorktreeManager: dependencies.createWorktreeManager,
    },
    environment,
    cwd,
    repositoryAuthDependencies: {
      createScmProvider: dependencies.createScmProvider,
    },
    backgroundExecution,
  });

  const taskRunAutolaunchEnabled = environment.ALPHRED_DASHBOARD_TASK_RUN_AUTOLAUNCH === '1';
  const configuredTaskRunTreeKey = (environment.ALPHRED_DASHBOARD_TASK_RUN_TREE_KEY ?? 'design-implement-review').trim();
  const taskRunTreeKey = configuredTaskRunTreeKey.length > 0 ? configuredTaskRunTreeKey : 'design-implement-review';
  const breakdownPlannerActorLabel = (environment.ALPHRED_DASHBOARD_BREAKDOWN_PLANNER_LABEL ?? 'codex-breakdown-planner').trim();
  const breakdownPlannerModelRaw = (environment.ALPHRED_DASHBOARD_BREAKDOWN_MODEL ?? '').trim();
  const breakdownPlannerModel = breakdownPlannerModelRaw.length > 0 ? breakdownPlannerModelRaw : undefined;
  const breakdownPlannerTimeoutMsRaw = Number.parseInt(
    environment.ALPHRED_DASHBOARD_BREAKDOWN_TIMEOUT_MS ?? '',
    10,
  );
  const breakdownPlannerTimeoutMs = Number.isInteger(breakdownPlannerTimeoutMsRaw) && breakdownPlannerTimeoutMsRaw > 0
    ? breakdownPlannerTimeoutMsRaw
    : 90_000;
  const breakdownPlannerSystemPromptRaw = (environment.ALPHRED_DASHBOARD_BREAKDOWN_SYSTEM_PROMPT ?? '').trim();
  const breakdownPlannerSystemPrompt = breakdownPlannerSystemPromptRaw.length > 0
    ? breakdownPlannerSystemPromptRaw
    : 'You are Alphred story breakdown planner. Return only a strict JSON object. No markdown fences or prose.';

  type ProposedBreakdownDraft = Parameters<typeof workItemOperations.proposeStoryBreakdown>[0]['proposed'];
  type ProposedBreakdownTask = ProposedBreakdownDraft['tasks'][number];
  type StorySnapshot = Awaited<ReturnType<typeof workItemOperations.getWorkItem>>['workItem'];

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  function toTrimmedString(value: unknown): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  function toUniqueSortedStrings(values: readonly string[]): string[] {
    return [...new Set(values)].sort(compareStringsByCodeUnit);
  }

  function normalizeRepoRelativePath(path: string): string | null {
    const trimmed = path.trim();
    if (trimmed.length === 0) {
      return null;
    }

    const slashNormalized = trimmed.replaceAll('\\', '/');
    if (slashNormalized.startsWith('/')) {
      return null;
    }

    if (/^[A-Za-z]:\//.test(slashNormalized)) {
      return null;
    }

    const normalized = posix.normalize(slashNormalized).replace(/^(\.\/)+/, '');
    if (normalized.length === 0 || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
      return null;
    }

    return normalized;
  }

  function toOptionalStringArray(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) {
      return undefined;
    }

    const normalized = value
      .map(entry => toTrimmedString(entry))
      .filter((entry): entry is string => entry !== null);
    if (normalized.length === 0) {
      return undefined;
    }

    return toUniqueSortedStrings(normalized);
  }

  function toOptionalRepoPathArray(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) {
      return undefined;
    }

    const normalized: string[] = [];
    for (const entry of value) {
      const asString = toTrimmedString(entry);
      if (!asString) {
        continue;
      }
      const normalizedPath = normalizeRepoRelativePath(asString);
      if (!normalizedPath) {
        continue;
      }
      normalized.push(normalizedPath);
    }

    if (normalized.length === 0) {
      return undefined;
    }

    return toUniqueSortedStrings(normalized);
  }

  function extractJsonCandidates(rawResult: string): string[] {
    const candidates: string[] = [];
    const seen = new Set<string>();

    const pushCandidate = (value: string): void => {
      const trimmed = value.trim();
      if (trimmed.length === 0 || seen.has(trimmed)) {
        return;
      }
      seen.add(trimmed);
      candidates.push(trimmed);
    };

    pushCandidate(rawResult);

    const fencedPattern = /```(?:json)?\s*([\s\S]*?)```/gi;
    let fencedMatch: RegExpExecArray | null = fencedPattern.exec(rawResult);
    while (fencedMatch) {
      if (fencedMatch[1]) {
        pushCandidate(fencedMatch[1]);
      }
      fencedMatch = fencedPattern.exec(rawResult);
    }

    const firstBrace = rawResult.indexOf('{');
    const lastBrace = rawResult.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      pushCandidate(rawResult.slice(firstBrace, lastBrace + 1));
    }

    return candidates;
  }

  function parseTaskCandidate(taskRaw: unknown): ProposedBreakdownTask | null {
    if (!isRecord(taskRaw)) {
      return null;
    }

    const title = toTrimmedString(taskRaw.title);
    if (!title) {
      return null;
    }

    const task: ProposedBreakdownTask = { title };
    const description = toTrimmedString(taskRaw.description);
    if (description) {
      task.description = description;
    }
    const tags = toOptionalStringArray(taskRaw.tags);
    if (tags) {
      task.tags = tags;
    }
    const plannedFiles = toOptionalRepoPathArray(taskRaw.plannedFiles);
    if (plannedFiles) {
      task.plannedFiles = plannedFiles;
    }
    const assignees = toOptionalStringArray(taskRaw.assignees);
    if (assignees) {
      task.assignees = assignees;
    }
    if (typeof taskRaw.priority === 'number' && Number.isFinite(taskRaw.priority)) {
      task.priority = taskRaw.priority;
    }
    if (typeof taskRaw.estimate === 'number' && Number.isFinite(taskRaw.estimate)) {
      task.estimate = taskRaw.estimate;
    }
    const links = toOptionalStringArray(taskRaw.links);
    if (links) {
      task.links = links;
    }

    return task;
  }

  function coerceProposedBreakdownFromJsonObject(candidate: Record<string, unknown>): ProposedBreakdownDraft | null {
    const source = isRecord(candidate.proposed) ? candidate.proposed : candidate;
    const tasksRaw = source.tasks;
    if (!Array.isArray(tasksRaw)) {
      return null;
    }

    const tasks = tasksRaw
      .map(parseTaskCandidate)
      .filter((entry): entry is ProposedBreakdownTask => entry !== null);
    if (tasks.length === 0) {
      return null;
    }

    const proposed: ProposedBreakdownDraft = { tasks };
    const tags = toOptionalStringArray(source.tags);
    if (tags) {
      proposed.tags = tags;
    }
    const plannedFiles = toOptionalRepoPathArray(source.plannedFiles);
    if (plannedFiles) {
      proposed.plannedFiles = plannedFiles;
    }
    const links = toOptionalStringArray(source.links);
    if (links) {
      proposed.links = links;
    }

    return proposed;
  }

  function parseProposedBreakdownFromCodexResult(rawResult: string): ProposedBreakdownDraft {
    for (const candidateText of extractJsonCandidates(rawResult)) {
      try {
        const parsed = JSON.parse(candidateText) as unknown;
        if (!isRecord(parsed)) {
          continue;
        }
        const proposed = coerceProposedBreakdownFromJsonObject(parsed);
        if (proposed !== null) {
          return proposed;
        }
      } catch {
        // Ignore parse errors and continue trying the next candidate.
      }
    }

    throw new DashboardIntegrationError('conflict', 'Codex returned an invalid breakdown payload.', {
      status: 409,
      details: {
        rawOutputPreview: rawResult.slice(0, 1_000),
      },
    });
  }

  function buildStoryBreakdownPrompt(story: StorySnapshot): string {
    const storyDescription = story.description?.trim() || '(none)';
    const storyTags = story.tags && story.tags.length > 0 ? story.tags.join(', ') : '(none)';
    const storyPlannedFiles = story.plannedFiles && story.plannedFiles.length > 0 ? story.plannedFiles.join(', ') : '(none)';
    const storyAssignees = story.assignees && story.assignees.length > 0 ? story.assignees.join(', ') : '(none)';

    return [
      'Create a practical engineering breakdown for this story.',
      'Return only JSON (no markdown, no prose) with this shape:',
      '{',
      '  "tags": string[] (optional),',
      '  "plannedFiles": string[] (optional, repo-relative paths),',
      '  "links": string[] (optional),',
      '  "tasks": [',
      '    {',
      '      "title": string,',
      '      "description": string (optional),',
      '      "tags": string[] (optional),',
      '      "plannedFiles": string[] (optional, repo-relative paths),',
      '      "assignees": string[] (optional),',
      '      "priority": number (optional),',
      '      "estimate": number (optional),',
      '      "links": string[] (optional)',
      '    }',
      '  ]',
      '}',
      'Rules:',
      '- Provide 2 to 6 tasks.',
      '- Tasks should be implementation-ready and non-overlapping.',
      '- Use concise, specific titles.',
      '- plannedFiles must be repository-relative paths.',
      '',
      `Story id: ${String(story.id)}`,
      `Title: ${story.title}`,
      `Description: ${storyDescription}`,
      `Tags: ${storyTags}`,
      `Planned files: ${storyPlannedFiles}`,
      `Assignees: ${storyAssignees}`,
    ].join('\n');
  }

  function mapCodexBreakdownError(error: unknown): DashboardIntegrationError {
    if (error instanceof DashboardIntegrationError) {
      return error;
    }

    if (error instanceof CodexProviderError) {
      if (error.code === 'CODEX_AUTH_ERROR') {
        return new DashboardIntegrationError(
          'auth_required',
          'Codex authentication is required to generate a breakdown draft.',
          {
            status: 401,
            cause: error,
          },
        );
      }

      if (
        error.code === 'CODEX_TIMEOUT'
        || error.code === 'CODEX_RATE_LIMITED'
        || error.code === 'CODEX_TRANSPORT_ERROR'
      ) {
        return new DashboardIntegrationError(
          'internal_error',
          'Codex is temporarily unavailable for breakdown planning. Retry in a moment.',
          {
            status: 503,
            cause: error,
          },
        );
      }

      return new DashboardIntegrationError(
        'internal_error',
        'Codex breakdown generation failed.',
        {
          status: 500,
          details: {
            code: error.code,
            message: error.message,
          },
          cause: error,
        },
      );
    }

    return toDashboardIntegrationError(error, 'Codex breakdown generation failed.');
  }

  async function resolveRepositoryNameById(repositoryId: number): Promise<string> {
    return withDatabase(db => {
      const repository = db
        .select({
          name: repositoriesTable.name,
        })
        .from(repositoriesTable)
        .where(eq(repositoriesTable.id, repositoryId))
        .get();
      if (!repository) {
        throw new DashboardIntegrationError('not_found', `Repository id=${repositoryId} was not found.`, {
          status: 404,
        });
      }
      return repository.name;
    });
  }

  async function resolveRepositoryBreakdownContext(repositoryId: number): Promise<{
    name: string;
    localPath: string;
  }> {
    return withDatabase(db => {
      const repository = db
        .select({
          name: repositoriesTable.name,
          localPath: repositoriesTable.localPath,
          cloneStatus: repositoriesTable.cloneStatus,
        })
        .from(repositoriesTable)
        .where(eq(repositoriesTable.id, repositoryId))
        .get();
      if (!repository) {
        throw new DashboardIntegrationError('not_found', `Repository id=${repositoryId} was not found.`, {
          status: 404,
        });
      }
      if (!repository.localPath) {
        throw new DashboardIntegrationError(
          'conflict',
          `Repository "${repository.name}" is not cloned locally; run sync before generating a breakdown.`,
          {
            status: 409,
            details: {
              repositoryId,
              cloneStatus: repository.cloneStatus,
            },
          },
        );
      }
      return {
        name: repository.name,
        localPath: repository.localPath,
      };
    });
  }

  async function hasStoryChildTasks(params: { repositoryId: number; storyId: number }): Promise<boolean> {
    return withDatabase(db => {
      const existingChildTask = db
        .select({
          id: workItemsTable.id,
        })
        .from(workItemsTable)
        .where(
          and(
            eq(workItemsTable.repositoryId, params.repositoryId),
            eq(workItemsTable.parentId, params.storyId),
            eq(workItemsTable.type, 'task'),
          ),
        )
        .limit(1)
        .get();

      return existingChildTask !== undefined && existingChildTask !== null;
    });
  }

  async function generateStoryBreakdownDraftWithCodex(
    request: {
      repositoryId: number;
      storyId: number;
      expectedRevision: number;
    },
  ): Promise<Awaited<ReturnType<typeof workItemOperations.proposeStoryBreakdown>>> {
    if (!Number.isInteger(request.repositoryId) || request.repositoryId < 1) {
      throw new DashboardIntegrationError('invalid_request', 'repositoryId must be a positive integer.', {
        status: 400,
      });
    }
    if (!Number.isInteger(request.storyId) || request.storyId < 1) {
      throw new DashboardIntegrationError('invalid_request', 'storyId must be a positive integer.', {
        status: 400,
      });
    }
    if (!Number.isInteger(request.expectedRevision) || request.expectedRevision < 0) {
      throw new DashboardIntegrationError('invalid_request', 'expectedRevision must be a non-negative integer.', {
        status: 400,
      });
    }

    const storyResult = await workItemOperations.getWorkItem({
      repositoryId: request.repositoryId,
      workItemId: request.storyId,
    });
    const story = storyResult.workItem;
    if (story.type !== 'story') {
      throw new DashboardIntegrationError('invalid_request', `Work item id=${request.storyId} is not a story.`, {
        status: 400,
      });
    }
    if (story.status !== 'NeedsBreakdown') {
      throw new DashboardIntegrationError(
        'conflict',
        'Story must be in NeedsBreakdown before generating a breakdown draft.',
        {
          status: 409,
          details: {
            storyId: story.id,
            status: story.status,
          },
        },
      );
    }
    if (await hasStoryChildTasks({ repositoryId: request.repositoryId, storyId: request.storyId })) {
      throw new DashboardIntegrationError(
        'conflict',
        'Story already has child tasks. Use Request changes or edit tasks manually instead of regenerating draft.',
        {
          status: 409,
          details: {
            storyId: request.storyId,
          },
        },
      );
    }

    const repositoryContext = await resolveRepositoryBreakdownContext(request.repositoryId);

    let rawCodexResult = '';
    try {
      const provider = dependencies.resolveProvider('codex');
      const prompt = buildStoryBreakdownPrompt(story);
      let lastAssistantMessage = '';
      for await (const event of provider.run(prompt, {
        workingDirectory: repositoryContext.localPath,
        timeout: breakdownPlannerTimeoutMs,
        model: breakdownPlannerModel,
        systemPrompt: breakdownPlannerSystemPrompt,
        context: [
          `repository_name=${repositoryContext.name}`,
          `repository_id=${String(request.repositoryId)}`,
          `story_id=${String(request.storyId)}`,
        ],
      })) {
        if (event.type === 'assistant' && event.content.trim().length > 0) {
          lastAssistantMessage = event.content;
        }
        if (event.type === 'result' && event.content.trim().length > 0) {
          rawCodexResult = event.content;
        }
      }

      if (rawCodexResult.trim().length === 0) {
        rawCodexResult = lastAssistantMessage;
      }
    } catch (error) {
      throw mapCodexBreakdownError(error);
    }

    if (rawCodexResult.trim().length === 0) {
      throw new DashboardIntegrationError('conflict', 'Codex returned an empty breakdown payload.', {
        status: 409,
      });
    }

    const proposed = parseProposedBreakdownFromCodexResult(rawCodexResult);
    return workItemOperations.proposeStoryBreakdown({
      repositoryId: request.repositoryId,
      storyId: request.storyId,
      expectedRevision: request.expectedRevision,
      actorType: 'agent',
      actorLabel: breakdownPlannerActorLabel.length > 0 ? breakdownPlannerActorLabel : 'codex-breakdown-planner',
      proposed,
    });
  }

  async function moveWorkItemStatusWithTaskRunOrchestration(
    request: Parameters<typeof workItemOperations.moveWorkItemStatus>[0],
  ): Promise<Awaited<ReturnType<typeof workItemOperations.moveWorkItemStatus>>> {
    const shouldAttemptTaskRunAutolaunch =
      taskRunAutolaunchEnabled && request.toStatus === 'InProgress' && request.linkedWorkflowRunId === undefined;
    if (!shouldAttemptTaskRunAutolaunch) {
      return workItemOperations.moveWorkItemStatus(request);
    }

    validateMoveWorkItemStatusRequest(request);

    const existing = await workItemOperations.getWorkItem({
      repositoryId: request.repositoryId,
      workItemId: request.workItemId,
    });
    if (
      existing.workItem.type !== 'task'
      || existing.workItem.status !== 'Ready'
      || existing.workItem.revision !== request.expectedRevision
    ) {
      return workItemOperations.moveWorkItemStatus(request);
    }

    const repositoryName = await resolveRepositoryNameById(request.repositoryId);
    const policyConstraints =
      existing.workItem.effectivePolicy?.policy === undefined
        ? undefined
        : {
            allowedProviders: existing.workItem.effectivePolicy.policy.allowedProviders,
            allowedModels: existing.workItem.effectivePolicy.policy.allowedModels,
            allowedSkillIdentifiers: existing.workItem.effectivePolicy.policy.allowedSkillIdentifiers,
            allowedMcpServerIdentifiers: existing.workItem.effectivePolicy.policy.allowedMcpServerIdentifiers,
          };

    const launchedRun = await runOperations.launchWorkflowRun({
      treeKey: taskRunTreeKey,
      repositoryName,
      executionMode: 'async',
      policyConstraints,
    });

    try {
      return await workItemOperations.moveWorkItemStatus({
        ...request,
        linkedWorkflowRunId: launchedRun.workflowRunId,
      });
    } catch (error) {
      try {
        await runOperations.controlWorkflowRun(launchedRun.workflowRunId, 'cancel');
      } catch {
        // Best-effort cleanup if move fails after launching.
      }
      throw error;
    }
  }

  return {
    ...workflowOperations,
    ...workflowDraftOperations,
    ...repositoryOperations,
    ...workItemOperations,
    generateStoryBreakdownDraft: generateStoryBreakdownDraftWithCodex,
    moveWorkItemStatus: moveWorkItemStatusWithTaskRunOrchestration,
    ...runOperations,
  };
}
