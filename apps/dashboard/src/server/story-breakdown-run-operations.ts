import { posix } from 'node:path';
import {
  and,
  desc,
  eq,
  phaseArtifacts,
  repositories,
  runNodeDiagnostics,
  runNodes,
  sql,
  workflowRunAssociations,
  workflowRuns,
  workflowTrees,
  workItems,
  type AlphredDatabase,
} from '@alphred/db';
import type {
  DashboardGetStoryBreakdownRunResult,
  DashboardLaunchStoryBreakdownRunRequest,
  DashboardLaunchStoryBreakdownRunResult,
  DashboardStoryBreakdownPlannerResult,
  DashboardStoryBreakdownRunError,
  DashboardWorkItemProposedBreakdownTask,
} from './dashboard-contracts';
import {
  DEFAULT_STORY_BREAKDOWN_NODE_KEY,
  DEFAULT_STORY_BREAKDOWN_TREE_KEY,
} from './dashboard-default-workflows';
import { DashboardIntegrationError } from './dashboard-errors';
import type { PreparedWorkflowRunLaunch } from './run-operations';
const STORY_BREAKDOWN_RESULT_SCHEMA_VERSION = 1;
const STORY_BREAKDOWN_RESULT_TYPE = 'story_breakdown_result';

type WithDatabase = <T>(operation: (db: AlphredDatabase) => Promise<T> | T) => Promise<T>;

export type StoryBreakdownRunOperationsDependencies = {
  prepareWorkflowRunLaunch: (
    db: AlphredDatabase,
    request: {
      treeKey: string;
      repositoryName: string;
      workItemId: number;
      executionMode: 'async';
      executionScope: 'single_node';
      nodeSelector: {
        type: 'node_key';
        nodeKey: string;
      };
    },
  ) => PreparedWorkflowRunLaunch;
  completeWorkflowRunLaunch: (
    db: AlphredDatabase,
    prepared: PreparedWorkflowRunLaunch,
  ) => Promise<{
    workflowRunId: number;
    mode: 'async' | 'sync';
    status: 'accepted' | 'completed';
    runStatus: DashboardGetStoryBreakdownRunResult['runStatus'];
  }>;
};

export type StoryBreakdownRunOperations = {
  launchStoryBreakdownRun: (request: DashboardLaunchStoryBreakdownRunRequest) => Promise<DashboardLaunchStoryBreakdownRunResult>;
  getStoryBreakdownRun: (params: {
    repositoryId: number;
    storyId: number;
    workflowRunId: number;
  }) => Promise<DashboardGetStoryBreakdownRunResult>;
};

type StoryBreakdownPlannerConfig = {
  treeKey: string;
  nodeKey: string;
};

type PlannerNodeExecutionContext = {
  nodeKey: string;
  runNodeId: number;
  attempt: number;
  reportArtifact: {
    id: number;
    contentType: string;
    content: string;
  } | null;
  failureArtifact: {
    id: number;
    content: string;
  } | null;
  diagnostics: {
    id: number;
    payload: unknown;
  } | null;
};

type ValidationFailure = {
  message: string;
  details: Record<string, unknown>;
};

type PersistedPlannerRunContext = {
  treeKey: string;
  nodeKey: string | null;
};

const STORY_BREAKDOWN_LAUNCH_CONTEXT_ARTIFACT_KIND = 'story_breakdown_launch_context_v1';

type StoryBreakdownLaunchContext = {
  storyId: number;
  title: string;
  description: string | null;
  tags: string[] | null;
  plannedFiles: string[] | null;
};

function requirePositiveInteger(value: number, fieldName: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new DashboardIntegrationError('invalid_request', `${fieldName} must be a positive integer.`, {
      status: 400,
    });
  }

  return value;
}

function requireNonNegativeInteger(value: number, fieldName: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new DashboardIntegrationError('invalid_request', `${fieldName} must be a non-negative integer.`, {
      status: 400,
    });
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeConfiguredValue(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : fallback;
}

function resolvePlannerConfig(environment: NodeJS.ProcessEnv): StoryBreakdownPlannerConfig {
  return {
    treeKey: normalizeConfiguredValue(
      environment.ALPHRED_DASHBOARD_STORY_BREAKDOWN_TREE_KEY,
      DEFAULT_STORY_BREAKDOWN_TREE_KEY,
    ),
    nodeKey: normalizeConfiguredValue(
      environment.ALPHRED_DASHBOARD_STORY_BREAKDOWN_NODE_KEY,
      DEFAULT_STORY_BREAKDOWN_NODE_KEY,
    ),
  };
}

function runInImmediateTransaction<T>(db: AlphredDatabase, operation: () => T): T {
  const transaction = db.$client.transaction(operation);
  return transaction.immediate();
}

function toOptionalStringArray(value: unknown, fieldPath: string, validationErrors: string[]): string[] | null {
  if (value === null) {
    return null;
  }

  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) {
    validationErrors.push(`${fieldPath} must be an array of strings or null.`);
    return null;
  }

  return [...value];
}

function toUniqueSortedStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
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

function toOptionalRepoRelativePathArray(value: unknown, fieldPath: string, validationErrors: string[]): string[] | null {
  if (value === null) {
    return null;
  }

  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) {
    validationErrors.push(`${fieldPath} must be an array of repo-relative file paths or null.`);
    return null;
  }

  const normalized: string[] = [];
  for (const entry of value) {
    const normalizedPath = normalizeRepoRelativePath(entry);
    if (normalizedPath === null) {
      validationErrors.push(`${fieldPath} must be an array of repo-relative file paths or null.`);
      return null;
    }
    normalized.push(normalizedPath);
  }

  return toUniqueSortedStrings(normalized);
}

function toOptionalFiniteNumber(value: unknown, fieldPath: string, validationErrors: string[]): number | null {
  if (value === null) {
    return null;
  }

  if (typeof value !== 'number' || !Number.isFinite(value)) {
    validationErrors.push(`${fieldPath} must be a finite number or null.`);
    return null;
  }

  return value;
}

function toStoredStringArrayOrNull(value: unknown): string[] | null {
  if (value === null) {
    return null;
  }

  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) {
    return null;
  }

  return [...value];
}

function buildStoryBreakdownPromptContextJson(context: StoryBreakdownLaunchContext): string {
  return JSON.stringify(
    {
      storyId: context.storyId,
      title: context.title,
      description: context.description,
      tags: context.tags,
      plannedFiles: context.plannedFiles,
    },
    null,
    2,
  );
}

function appendStoryBreakdownPromptContext(prompt: string, context: StoryBreakdownLaunchContext): string {
  return [
    prompt.trimEnd(),
    '',
    'STORY_CONTEXT_JSON:',
    buildStoryBreakdownPromptContextJson(context),
    '',
    'Use STORY_CONTEXT_JSON as the source of truth for the proposed breakdown.',
  ].join('\n');
}

function persistStoryBreakdownLaunchContext(params: {
  db: AlphredDatabase;
  workflowRunId: number;
  plannerNodeKey: string;
  context: StoryBreakdownLaunchContext;
}): void {
  const plannerNode = params.db
    .select({
      runNodeId: runNodes.id,
      prompt: runNodes.prompt,
    })
    .from(runNodes)
    .where(and(eq(runNodes.workflowRunId, params.workflowRunId), eq(runNodes.nodeKey, params.plannerNodeKey)))
    .orderBy(desc(runNodes.attempt), desc(runNodes.id))
    .get();

  if (!plannerNode || plannerNode.prompt === null || plannerNode.prompt.trim().length === 0) {
    throw new DashboardIntegrationError(
      'internal_error',
      `Story breakdown planner node "${params.plannerNodeKey}" is missing prompt context for run id=${params.workflowRunId}.`,
      {
        status: 500,
      },
    );
  }

  params.db
    .update(runNodes)
    .set({
      prompt: appendStoryBreakdownPromptContext(plannerNode.prompt, params.context),
    })
    .where(eq(runNodes.id, plannerNode.runNodeId))
    .run();

  params.db.insert(phaseArtifacts)
    .values({
      workflowRunId: params.workflowRunId,
      runNodeId: plannerNode.runNodeId,
      artifactType: 'note',
      contentType: 'json',
      content: JSON.stringify(
        {
          schemaVersion: 1,
          kind: STORY_BREAKDOWN_LAUNCH_CONTEXT_ARTIFACT_KIND,
          story: {
            id: params.context.storyId,
            title: params.context.title,
            description: params.context.description,
            tags: params.context.tags,
            plannedFiles: params.context.plannedFiles,
          },
        },
        null,
        2,
      ),
      metadata: {
        kind: STORY_BREAKDOWN_LAUNCH_CONTEXT_ARTIFACT_KIND,
        storyId: params.context.storyId,
      },
    })
    .run();
}

function normalizeBreakdownTask(
  value: unknown,
  fieldPath: string,
  validationErrors: string[],
): DashboardWorkItemProposedBreakdownTask | null {
  if (!isRecord(value)) {
    validationErrors.push(`${fieldPath} must be an object.`);
    return null;
  }

  const rawTitle = value.title;
  if (typeof rawTitle !== 'string' || rawTitle.trim().length === 0) {
    validationErrors.push(`${fieldPath}.title must be a non-empty string.`);
    return null;
  }

  const task: DashboardWorkItemProposedBreakdownTask = {
    title: rawTitle.trim(),
  };

  if ('description' in value) {
    if (value.description !== null && typeof value.description !== 'string') {
      validationErrors.push(`${fieldPath}.description must be a string or null.`);
    } else {
      task.description = value.description as string | null;
    }
  }

  if ('tags' in value) {
    task.tags = toOptionalStringArray(value.tags, `${fieldPath}.tags`, validationErrors);
  }

  if ('plannedFiles' in value) {
    task.plannedFiles = toOptionalRepoRelativePathArray(value.plannedFiles, `${fieldPath}.plannedFiles`, validationErrors);
  }

  if ('assignees' in value) {
    task.assignees = toOptionalStringArray(value.assignees, `${fieldPath}.assignees`, validationErrors);
  }

  if ('priority' in value) {
    task.priority = toOptionalFiniteNumber(value.priority, `${fieldPath}.priority`, validationErrors);
  }

  if ('estimate' in value) {
    task.estimate = toOptionalFiniteNumber(value.estimate, `${fieldPath}.estimate`, validationErrors);
  }

  if ('links' in value) {
    task.links = toOptionalStringArray(value.links, `${fieldPath}.links`, validationErrors);
  }

  return task;
}

function validatePlannerResult(content: string): { ok: true; value: DashboardStoryBreakdownPlannerResult } | { ok: false; error: ValidationFailure } {
  let payload: unknown;
  try {
    payload = JSON.parse(content) as unknown;
  } catch (error) {
    return {
      ok: false,
      error: {
        message: 'Planner report must be valid JSON.',
        details: {
          reason: 'invalid_json',
          cause: error instanceof Error ? error.message : String(error),
        },
      },
    };
  }

  if (!isRecord(payload)) {
    return {
      ok: false,
      error: {
        message: 'Planner report must be a JSON object.',
        details: {
          reason: 'non_object_payload',
        },
      },
    };
  }

  const validationErrors: string[] = [];

  if (payload.schemaVersion !== STORY_BREAKDOWN_RESULT_SCHEMA_VERSION) {
    validationErrors.push(`schemaVersion must equal ${String(STORY_BREAKDOWN_RESULT_SCHEMA_VERSION)}.`);
  }

  if (payload.resultType !== STORY_BREAKDOWN_RESULT_TYPE) {
    validationErrors.push(`resultType must equal "${STORY_BREAKDOWN_RESULT_TYPE}".`);
  }

  const proposed = payload.proposed;
  if (!isRecord(proposed)) {
    validationErrors.push('proposed must be an object.');
  }

  const normalizedProposed = isRecord(proposed) ? proposed : {};
  const tags = 'tags' in normalizedProposed
    ? toOptionalStringArray(normalizedProposed.tags, 'proposed.tags', validationErrors)
    : (validationErrors.push('proposed.tags is required.'), null);
  const plannedFiles = 'plannedFiles' in normalizedProposed
    ? toOptionalRepoRelativePathArray(normalizedProposed.plannedFiles, 'proposed.plannedFiles', validationErrors)
    : (validationErrors.push('proposed.plannedFiles is required.'), null);
  const links = 'links' in normalizedProposed
    ? toOptionalStringArray(normalizedProposed.links, 'proposed.links', validationErrors)
    : (validationErrors.push('proposed.links is required.'), null);

  let tasks: DashboardWorkItemProposedBreakdownTask[] = [];
  if (!('tasks' in normalizedProposed)) {
    validationErrors.push('proposed.tasks is required.');
  } else if (!Array.isArray(normalizedProposed.tasks)) {
    validationErrors.push('proposed.tasks must be an array.');
  } else if (normalizedProposed.tasks.length === 0) {
    validationErrors.push('proposed.tasks must contain at least one task.');
  } else {
    tasks = normalizedProposed.tasks
      .map((task, index) => normalizeBreakdownTask(task, `proposed.tasks[${String(index)}]`, validationErrors))
      .filter((task): task is DashboardWorkItemProposedBreakdownTask => task !== null);
  }

  if (validationErrors.length > 0) {
    return {
      ok: false,
      error: {
        message: 'Planner output does not match the story_breakdown_result schema.',
        details: {
          reason: 'schema_validation_failed',
          validationErrors,
        },
      },
    };
  }

  return {
    ok: true,
    value: {
      schemaVersion: STORY_BREAKDOWN_RESULT_SCHEMA_VERSION,
      resultType: STORY_BREAKDOWN_RESULT_TYPE,
      proposed: {
        tags,
        plannedFiles,
        links,
        tasks,
      },
    },
  };
}

function createLifecycleError(
  code: DashboardStoryBreakdownRunError['code'],
  message: string,
  retryable: boolean,
  details: Record<string, unknown>,
): DashboardStoryBreakdownRunError {
  return {
    code,
    message,
    retryable,
    details,
  };
}

function readDiagnosticError(payload: unknown): {
  classification: string | null;
  message: string | null;
  name: string | null;
} | null {
  if (!isRecord(payload) || !isRecord(payload.error)) {
    return null;
  }

  return {
    classification: typeof payload.error.classification === 'string' ? payload.error.classification : null,
    message: typeof payload.error.message === 'string' ? payload.error.message : null,
    name: typeof payload.error.name === 'string' ? payload.error.name : null,
  };
}

function classifyTerminalFailure(params: {
  runStatus: DashboardGetStoryBreakdownRunResult['runStatus'];
  plannerRunContext: PersistedPlannerRunContext;
  execution: PlannerNodeExecutionContext | null;
}): DashboardStoryBreakdownRunError {
  const diagnosticError = readDiagnosticError(params.execution?.diagnostics?.payload ?? null);
  const sourceMessages = [
    diagnosticError?.message ?? null,
    params.execution?.failureArtifact?.content ?? null,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
  const message = sourceMessages[0]
    ?? (params.runStatus === 'cancelled'
      ? 'Planner run was cancelled before producing a story breakdown result.'
      : 'Planner run failed before producing a valid story breakdown result.');
  const corpus = sourceMessages.join('\n').toLowerCase();
  const details: Record<string, unknown> = {
    kind: 'planner_run_failure',
    treeKey: params.plannerRunContext.treeKey,
    nodeKey: params.plannerRunContext.nodeKey,
    runStatus: params.runStatus,
    runNodeId: params.execution?.runNodeId ?? null,
    attempt: params.execution?.attempt ?? null,
    diagnosticId: params.execution?.diagnostics?.id ?? null,
    failureArtifactId: params.execution?.failureArtifact?.id ?? null,
    diagnosticClassification: diagnosticError?.classification ?? null,
    diagnosticName: diagnosticError?.name ?? null,
  };

  if (
    params.runStatus === 'cancelled'
    || diagnosticError?.classification === 'aborted'
    || /\b(cancelled|canceled|aborted)\b/.test(corpus)
  ) {
    return createLifecycleError('conflict', message, true, {
      ...details,
      kind: 'planner_run_cancelled',
    });
  }

  if (/\b(authentication|auth|unauthorized|forbidden|not logged in|permission denied)\b/.test(corpus)) {
    return createLifecycleError('auth', message, false, {
      ...details,
      kind: 'planner_auth_failure',
    });
  }

  if (
    corpus.includes('spawner_output_invalid')
    || corpus.includes('story_breakdown_result')
    || corpus.includes('schema validation')
    || corpus.includes('must be valid json')
    || corpus.includes('must be a json object')
  ) {
    return createLifecycleError('invalid_output', message, false, {
      ...details,
      kind: 'planner_invalid_output',
    });
  }

  if (/\b(conflict|precondition failed|already exists|revision conflict)\b/.test(corpus)) {
    return createLifecycleError('conflict', message, false, {
      ...details,
      kind: 'planner_conflict',
    });
  }

  const isTransientFailure =
    diagnosticError?.classification === 'timeout'
    || /\b(timeout|timed out|rate limit|rate-limited|too many requests|quota|throttle|network|socket|econnreset|transport)\b/.test(
      corpus,
    );

  return createLifecycleError('transient', message, isTransientFailure, {
    ...details,
    kind: isTransientFailure ? 'planner_transient_failure' : 'planner_runtime_failure',
  });
}

function findPlannerNodeExecutionTarget(
  db: AlphredDatabase,
  workflowRunId: number,
): Pick<PlannerNodeExecutionContext, 'nodeKey' | 'runNodeId' | 'attempt'> | null {
  const reportNode = db
    .select({
      nodeKey: runNodes.nodeKey,
      runNodeId: runNodes.id,
      attempt: runNodes.attempt,
    })
    .from(phaseArtifacts)
    .innerJoin(runNodes, eq(phaseArtifacts.runNodeId, runNodes.id))
    .where(and(eq(phaseArtifacts.workflowRunId, workflowRunId), eq(phaseArtifacts.artifactType, 'report')))
    .orderBy(desc(phaseArtifacts.createdAt), desc(phaseArtifacts.id))
    .get();
  if (reportNode) {
    return reportNode;
  }

  const failureNode = db
    .select({
      nodeKey: runNodes.nodeKey,
      runNodeId: runNodes.id,
      attempt: runNodes.attempt,
    })
    .from(phaseArtifacts)
    .innerJoin(runNodes, eq(phaseArtifacts.runNodeId, runNodes.id))
    .where(and(eq(phaseArtifacts.workflowRunId, workflowRunId), eq(phaseArtifacts.artifactType, 'log')))
    .orderBy(desc(phaseArtifacts.createdAt), desc(phaseArtifacts.id))
    .get();
  if (failureNode) {
    return failureNode;
  }

  const diagnosticNode = db
    .select({
      nodeKey: runNodes.nodeKey,
      runNodeId: runNodes.id,
      attempt: runNodes.attempt,
    })
    .from(runNodeDiagnostics)
    .innerJoin(runNodes, eq(runNodeDiagnostics.runNodeId, runNodes.id))
    .where(eq(runNodeDiagnostics.workflowRunId, workflowRunId))
    .orderBy(desc(runNodeDiagnostics.attempt), desc(runNodeDiagnostics.id))
    .get();
  if (diagnosticNode) {
    return diagnosticNode;
  }

  const activeNode = db
    .select({
      nodeKey: runNodes.nodeKey,
      runNodeId: runNodes.id,
      attempt: runNodes.attempt,
    })
    .from(runNodes)
    .where(and(eq(runNodes.workflowRunId, workflowRunId), sql`${runNodes.status} <> 'pending'`))
    .orderBy(desc(runNodes.attempt), desc(runNodes.id))
    .get();
  if (activeNode) {
    return activeNode;
  }

  return db
    .select({
      nodeKey: runNodes.nodeKey,
      runNodeId: runNodes.id,
      attempt: runNodes.attempt,
    })
    .from(runNodes)
    .where(eq(runNodes.workflowRunId, workflowRunId))
    .orderBy(desc(runNodes.attempt), desc(runNodes.id))
    .get() ?? null;
}

function loadPlannerNodeExecutionContext(
  db: AlphredDatabase,
  workflowRunId: number,
): PlannerNodeExecutionContext | null {
  const plannerNode = findPlannerNodeExecutionTarget(db, workflowRunId);

  if (!plannerNode) {
    return null;
  }

  const reportArtifact = db
    .select({
      id: phaseArtifacts.id,
      contentType: phaseArtifacts.contentType,
      content: phaseArtifacts.content,
    })
    .from(phaseArtifacts)
    .where(
      and(
        eq(phaseArtifacts.workflowRunId, workflowRunId),
        eq(phaseArtifacts.runNodeId, plannerNode.runNodeId),
        eq(phaseArtifacts.artifactType, 'report'),
      ),
    )
    .orderBy(desc(phaseArtifacts.createdAt), desc(phaseArtifacts.id))
    .get();

  const failureArtifact = db
    .select({
      id: phaseArtifacts.id,
      content: phaseArtifacts.content,
    })
    .from(phaseArtifacts)
    .where(
      and(
        eq(phaseArtifacts.workflowRunId, workflowRunId),
        eq(phaseArtifacts.runNodeId, plannerNode.runNodeId),
        eq(phaseArtifacts.artifactType, 'log'),
      ),
    )
    .orderBy(desc(phaseArtifacts.createdAt), desc(phaseArtifacts.id))
    .get();

  const diagnostics = db
    .select({
      id: runNodeDiagnostics.id,
      diagnostics: runNodeDiagnostics.diagnostics,
    })
    .from(runNodeDiagnostics)
    .where(
      and(eq(runNodeDiagnostics.workflowRunId, workflowRunId), eq(runNodeDiagnostics.runNodeId, plannerNode.runNodeId)),
    )
    .orderBy(desc(runNodeDiagnostics.attempt), desc(runNodeDiagnostics.id))
    .get();

  return {
    nodeKey: plannerNode.nodeKey,
    runNodeId: plannerNode.runNodeId,
    attempt: plannerNode.attempt,
    reportArtifact: reportArtifact
      ? {
          id: reportArtifact.id,
          contentType: reportArtifact.contentType,
          content: reportArtifact.content,
        }
      : null,
    failureArtifact: failureArtifact
      ? {
          id: failureArtifact.id,
          content: failureArtifact.content,
        }
      : null,
    diagnostics: diagnostics
      ? {
          id: diagnostics.id,
          payload: diagnostics.diagnostics,
        }
      : null,
  };
}

function createCompletedInvalidOutputResult(params: {
  workflowRunId: number;
  execution: PlannerNodeExecutionContext | null;
  plannerRunContext: PersistedPlannerRunContext;
  validationFailure: ValidationFailure;
}): DashboardGetStoryBreakdownRunResult {
  return {
    workflowRunId: params.workflowRunId,
    runStatus: 'completed',
    result: null,
    error: createLifecycleError('invalid_output', params.validationFailure.message, false, {
      ...params.validationFailure.details,
      treeKey: params.plannerRunContext.treeKey,
      nodeKey: params.plannerRunContext.nodeKey,
      runNodeId: params.execution?.runNodeId ?? null,
      attempt: params.execution?.attempt ?? null,
      reportArtifactId: params.execution?.reportArtifact?.id ?? null,
      artifactContentType: params.execution?.reportArtifact?.contentType ?? null,
    }),
  };
}

export function createStoryBreakdownRunOperations(params: {
  withDatabase: WithDatabase;
  dependencies: StoryBreakdownRunOperationsDependencies;
  environment: NodeJS.ProcessEnv;
}): StoryBreakdownRunOperations {
  const { withDatabase, dependencies, environment } = params;

  return {
    async launchStoryBreakdownRun(
      request: DashboardLaunchStoryBreakdownRunRequest,
    ): Promise<DashboardLaunchStoryBreakdownRunResult> {
      const repositoryId = requirePositiveInteger(request.repositoryId, 'repositoryId');
      const storyId = requirePositiveInteger(request.storyId, 'storyId');
      const expectedRevision = requireNonNegativeInteger(request.expectedRevision, 'expectedRevision');
      const plannerConfig = resolvePlannerConfig(environment);

      const preparedLaunch = await withDatabase(db =>
        runInImmediateTransaction(db, () => {
          const story = db
            .select({
              repositoryName: repositories.name,
              type: workItems.type,
              revision: workItems.revision,
              title: workItems.title,
              description: workItems.description,
              tags: workItems.tags,
              plannedFiles: workItems.plannedFiles,
            })
            .from(workItems)
            .innerJoin(repositories, eq(workItems.repositoryId, repositories.id))
            .where(and(eq(workItems.repositoryId, repositoryId), eq(workItems.id, storyId)))
            .get();

          if (!story) {
            throw new DashboardIntegrationError('not_found', `Story id=${storyId} was not found.`, {
              status: 404,
            });
          }

          if (story.type !== 'story') {
            throw new DashboardIntegrationError('invalid_request', `Work item id=${storyId} is not a story.`, {
              status: 400,
            });
          }

          if (story.revision !== expectedRevision) {
            throw new DashboardIntegrationError(
              'conflict',
              `Work item id=${storyId} revision conflict (expected ${String(expectedRevision)}).`,
              {
                status: 409,
                details: {
                  workItemId: storyId,
                  expectedRevision,
                  currentRevision: story.revision,
                },
              },
            );
          }

          const activeRun = db
            .select({
              workflowRunId: workflowRuns.id,
              runStatus: workflowRuns.status,
              treeKey: workflowTrees.treeKey,
            })
            .from(workflowRunAssociations)
            .innerJoin(workflowRuns, eq(workflowRunAssociations.workflowRunId, workflowRuns.id))
            .innerJoin(workflowTrees, eq(workflowRuns.workflowTreeId, workflowTrees.id))
            .where(
              and(
                eq(workflowRunAssociations.repositoryId, repositoryId),
                eq(workflowRunAssociations.workItemId, storyId),
                sql`${workflowRuns.status} in ('pending', 'running', 'paused')`,
              ),
            )
            .orderBy(desc(workflowRuns.id))
            .get();

          if (activeRun) {
            throw new DashboardIntegrationError('conflict', 'Story breakdown planner run is already active for this story.', {
              status: 409,
              details: {
                workflowRunId: activeRun.workflowRunId,
                runStatus: activeRun.runStatus,
                treeKey: activeRun.treeKey,
                nodeKey: plannerConfig.nodeKey,
              },
            });
          }

          const preparedLaunch = dependencies.prepareWorkflowRunLaunch(db, {
            treeKey: plannerConfig.treeKey,
            repositoryName: story.repositoryName,
            workItemId: storyId,
            executionMode: 'async',
            executionScope: 'single_node',
            nodeSelector: {
              type: 'node_key',
              nodeKey: plannerConfig.nodeKey,
            },
          });

          persistStoryBreakdownLaunchContext({
            db,
            workflowRunId: preparedLaunch.workflowRunId,
            plannerNodeKey: plannerConfig.nodeKey,
            context: {
              storyId,
              title: story.title,
              description: story.description,
              tags: toStoredStringArrayOrNull(story.tags),
              plannedFiles: toStoredStringArrayOrNull(story.plannedFiles),
            },
          });

          return preparedLaunch;
        }),
      );

      const launch = await withDatabase(db => dependencies.completeWorkflowRunLaunch(db, preparedLaunch));

      return {
        workflowRunId: launch.workflowRunId,
        mode: 'async',
        status: 'accepted',
        runStatus: launch.runStatus,
        result: null,
        error: null,
      };
    },

    getStoryBreakdownRun(paramsRaw: {
      repositoryId: number;
      storyId: number;
      workflowRunId: number;
    }): Promise<DashboardGetStoryBreakdownRunResult> {
      const repositoryId = requirePositiveInteger(paramsRaw.repositoryId, 'repositoryId');
      const storyId = requirePositiveInteger(paramsRaw.storyId, 'storyId');
      const workflowRunId = requirePositiveInteger(paramsRaw.workflowRunId, 'workflowRunId');

      return withDatabase(db => {
        const run = db
          .select({
            workflowRunId: workflowRuns.id,
            runStatus: workflowRuns.status,
            treeKey: workflowTrees.treeKey,
            associationRepositoryId: workflowRunAssociations.repositoryId,
            associationWorkItemId: workflowRunAssociations.workItemId,
          })
          .from(workflowRuns)
          .innerJoin(workflowTrees, eq(workflowRuns.workflowTreeId, workflowTrees.id))
          .leftJoin(workflowRunAssociations, eq(workflowRunAssociations.workflowRunId, workflowRuns.id))
          .where(eq(workflowRuns.id, workflowRunId))
          .get();

        if (!run) {
          throw new DashboardIntegrationError('not_found', `Workflow run id=${workflowRunId} was not found.`, {
            status: 404,
          });
        }

        if (run.associationRepositoryId !== repositoryId || run.associationWorkItemId !== storyId) {
          throw new DashboardIntegrationError(
            'not_found',
            `Story breakdown run id=${workflowRunId} was not found for story id=${storyId}.`,
            {
              status: 404,
            },
          );
        }

        const launchContextArtifact = db
          .select({ id: phaseArtifacts.id })
          .from(phaseArtifacts)
          .where(
            and(
              eq(phaseArtifacts.workflowRunId, workflowRunId),
              sql`coalesce(json_extract(${phaseArtifacts.metadata}, '$.kind'), '') = ${STORY_BREAKDOWN_LAUNCH_CONTEXT_ARTIFACT_KIND}`,
            ),
          )
          .orderBy(desc(phaseArtifacts.createdAt), desc(phaseArtifacts.id))
          .get();
        if (!launchContextArtifact) {
          throw new DashboardIntegrationError(
            'not_found',
            `Story breakdown run id=${workflowRunId} was not found for story id=${storyId}.`,
            {
              status: 404,
            },
          );
        }

        const runStatus = run.runStatus as DashboardGetStoryBreakdownRunResult['runStatus'];
        if (runStatus === 'pending' || runStatus === 'running' || runStatus === 'paused') {
          return {
            workflowRunId,
            runStatus,
            result: null,
            error: null,
          };
        }

        const execution = loadPlannerNodeExecutionContext(db, workflowRunId);
        const plannerRunContext: PersistedPlannerRunContext = {
          treeKey: run.treeKey,
          nodeKey: execution?.nodeKey ?? null,
        };

        if (runStatus === 'completed') {
          if (!execution?.reportArtifact) {
            return createCompletedInvalidOutputResult({
              workflowRunId,
              execution,
              plannerRunContext,
              validationFailure: {
                message: 'Planner report artifact is missing for the completed breakdown run.',
                details: {
                  reason: 'missing_report_artifact',
                },
              },
            });
          }

          const validation = validatePlannerResult(execution.reportArtifact.content);
          if (!validation.ok) {
            return createCompletedInvalidOutputResult({
              workflowRunId,
              execution,
              plannerRunContext,
              validationFailure: validation.error,
            });
          }

          return {
            workflowRunId,
            runStatus,
            result: validation.value,
            error: null,
          };
        }

        return {
          workflowRunId,
          runStatus,
          result: null,
          error: classifyTerminalFailure({
            runStatus,
            plannerRunContext,
            execution,
          }),
        };
      });
    },
  };
}
