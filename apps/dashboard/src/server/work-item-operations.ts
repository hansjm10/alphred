import { execFile, execFileSync } from 'node:child_process';
import { posix } from 'node:path';
import { promisify } from 'node:util';
import { validateParentChildWorkItemTypes, validateTransition } from '@alphred/core';
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  repositories,
  runWorktrees,
  sql,
  workItemEvents,
  workItemPolicies,
  workItemWorkflowRuns,
  workItems,
  workflowRuns,
  type AlphredDatabase,
  type WorkItemActorType,
  type WorkItemEventType,
} from '@alphred/db';
import { workItemStatusesByType, type WorkItemStatus, type WorkItemType } from '@alphred/shared';
import { DashboardIntegrationError } from './dashboard-errors';
import type {
  DashboardApproveStoryBreakdownRequest,
  DashboardApproveStoryBreakdownResult,
  DashboardBoardEventSnapshot,
  DashboardBoardEventsSnapshot,
  DashboardCreateWorkItemRequest,
  DashboardCreateWorkItemResult,
  DashboardWorkItemEffectivePolicySnapshot,
  DashboardGetStoryBreakdownProposalResult,
  DashboardGetWorkItemResult,
  DashboardListWorkItemsResult,
  DashboardMoveWorkItemStatusRequest,
  DashboardMoveWorkItemStatusResult,
  DashboardProposeStoryBreakdownRequest,
  DashboardProposeStoryBreakdownResult,
  DashboardRequestWorkItemReplanRequest,
  DashboardRequestWorkItemReplanResult,
  DashboardRepositoryBoardBootstrapResult,
  DashboardWorkItemLinkedRunSnapshot,
  DashboardSetWorkItemParentRequest,
  DashboardSetWorkItemParentResult,
  DashboardStoryBreakdownProposalSnapshot,
  DashboardUpdateWorkItemFieldsRequest,
  DashboardUpdateWorkItemFieldsResult,
  DashboardWorkItemPolicySnapshot,
  DashboardWorkItemSnapshot,
} from './dashboard-contracts';

type WithDatabase = <T>(operation: (db: AlphredDatabase) => Promise<T> | T) => Promise<T>;

type WorkItemRow = typeof workItems.$inferSelect;
type WorkItemEventRow = typeof workItemEvents.$inferSelect;
type WorkItemPolicyRow = typeof workItemPolicies.$inferSelect;
type WorkItemWorkflowRunRow = typeof workItemWorkflowRuns.$inferSelect;
type AlphredTransaction = Parameters<Parameters<AlphredDatabase['transaction']>[0]>[0];
type DbOrTx = AlphredDatabase | AlphredTransaction;

const MAX_BOARD_EVENT_SNAPSHOT_EVENTS = 200;
const GIT_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const TOUCHED_FILES_READ_BATCH_SIZE = 8;
const execFileAsync = promisify(execFile);

function toOptionalNonEmptyTrimmedString(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function toStringArrayOrNull(value: unknown): string[] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) return null;
  const strings: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') return null;
    strings.push(entry);
  }
  return strings;
}

function toUniqueSortedStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function parseStatusPaths(statusOutput: string): string[] {
  const entries = statusOutput.split('\u0000');
  const paths = new Set<string>();
  let skipNextEntry = false;

  for (const entry of entries) {
    if (skipNextEntry) {
      skipNextEntry = false;
      continue;
    }

    if (entry.length < 4) {
      continue;
    }

    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    const statusCodes = new Set(status);

    const renamedOrCopied = statusCodes.has('R') || statusCodes.has('C');
    if (renamedOrCopied) {
      skipNextEntry = true;
    }

    if (path.length > 0) {
      paths.add(path);
    }
  }

  return toUniqueSortedStrings([...paths]);
}

function readTouchedFilesFromWorktree(worktreePath: string): string[] | null {
  try {
    const output = execFileSync(
      'git',
      ['-C', worktreePath, 'status', '--porcelain=v1', '--untracked-files=all', '-z'],
      {
        encoding: 'utf8',
        maxBuffer: GIT_MAX_BUFFER_BYTES,
      },
    );
    return parseStatusPaths(output);
  } catch {
    return null;
  }
}

async function readTouchedFilesFromWorktreeAsync(worktreePath: string): Promise<string[] | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', worktreePath, 'status', '--porcelain=v1', '--untracked-files=all', '-z'],
      {
        encoding: 'utf8',
        maxBuffer: GIT_MAX_BUFFER_BYTES,
      },
    );
    return parseStatusPaths(stdout);
  } catch {
    return null;
  }
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

function toRepoRelativePathArrayOrNull(value: unknown): string[] | null {
  const strings = toStringArrayOrNull(value);
  if (strings === null) {
    return null;
  }

  const normalized: string[] = [];
  for (const entry of strings) {
    const path = normalizeRepoRelativePath(entry);
    if (path === null) {
      return null;
    }
    normalized.push(path);
  }

  return toUniqueSortedStrings(normalized);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type ParsedPolicyOverride = {
  allowedProviders?: string[] | null;
  allowedModels?: string[] | null;
  allowedSkillIdentifiers?: string[] | null;
  allowedMcpServerIdentifiers?: string[] | null;
  budgets?: {
    maxConcurrentTasks?: number | null;
    maxConcurrentRuns?: number | null;
  };
  requiredGates?: {
    breakdownApprovalRequired?: boolean;
  };
};

type WorkItemIdentity = {
  id: number;
  type: WorkItemType;
  parentId: number | null;
};

type PolicyResolutionContext = {
  workItemIdentityById: ReadonlyMap<number, WorkItemIdentity>;
  repositoryPolicy: { id: number; override: ParsedPolicyOverride } | null;
  epicPoliciesByEpicId: ReadonlyMap<number, { id: number; override: ParsedPolicyOverride }>;
};

function toPolicyConflictError(message: string, details?: Record<string, unknown>): DashboardIntegrationError {
  return new DashboardIntegrationError('conflict', message, {
    status: 409,
    details: {
      kind: 'work_item_policy',
      ...(details ?? {}),
    },
  });
}

function normalizeStringList(value: unknown, fieldName: string, policyId: number): string[] | null {
  if (value === null) {
    return null;
  }

  if (!Array.isArray(value)) {
    throw toPolicyConflictError(`Policy id=${policyId} field "${fieldName}" must be an array of strings or null.`);
  }

  const values: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') {
      throw toPolicyConflictError(`Policy id=${policyId} field "${fieldName}" must contain only strings.`);
    }
    const normalized = entry.trim();
    if (normalized.length === 0) {
      throw toPolicyConflictError(`Policy id=${policyId} field "${fieldName}" cannot contain empty values.`);
    }
    values.push(normalized);
  }
  return values;
}

function parseOptionalNonNegativeInteger(value: unknown, fieldName: string, policyId: number): number | null {
  if (value === null) {
    return null;
  }

  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw toPolicyConflictError(`Policy id=${policyId} field "${fieldName}" must be a non-negative integer or null.`);
  }

  return value;
}

function parsePolicyOverride(row: WorkItemPolicyRow): ParsedPolicyOverride {
  if (!isRecord(row.payload)) {
    throw toPolicyConflictError(`Policy id=${row.id} payload must be a JSON object.`);
  }

  const payload = row.payload;
  const override: ParsedPolicyOverride = {};

  if ('allowedProviders' in payload) {
    override.allowedProviders = normalizeStringList(payload.allowedProviders, 'allowedProviders', row.id);
  }
  if ('allowedModels' in payload) {
    override.allowedModels = normalizeStringList(payload.allowedModels, 'allowedModels', row.id);
  }
  if ('allowedSkillIdentifiers' in payload) {
    override.allowedSkillIdentifiers = normalizeStringList(payload.allowedSkillIdentifiers, 'allowedSkillIdentifiers', row.id);
  }
  if ('allowedMcpServerIdentifiers' in payload) {
    override.allowedMcpServerIdentifiers = normalizeStringList(payload.allowedMcpServerIdentifiers, 'allowedMcpServerIdentifiers', row.id);
  }

  if ('budgets' in payload) {
    const budgets = payload.budgets;
    if (!isRecord(budgets)) {
      throw toPolicyConflictError(`Policy id=${row.id} field "budgets" must be an object.`);
    }
    const parsedBudgets: ParsedPolicyOverride['budgets'] = {};
    if ('maxConcurrentTasks' in budgets) {
      parsedBudgets.maxConcurrentTasks = parseOptionalNonNegativeInteger(
        budgets.maxConcurrentTasks,
        'budgets.maxConcurrentTasks',
        row.id,
      );
    }
    if ('maxConcurrentRuns' in budgets) {
      parsedBudgets.maxConcurrentRuns = parseOptionalNonNegativeInteger(
        budgets.maxConcurrentRuns,
        'budgets.maxConcurrentRuns',
        row.id,
      );
    }
    override.budgets = parsedBudgets;
  }

  if ('requiredGates' in payload) {
    const requiredGates = payload.requiredGates;
    if (!isRecord(requiredGates)) {
      throw toPolicyConflictError(`Policy id=${row.id} field "requiredGates" must be an object.`);
    }
    const parsedRequiredGates: ParsedPolicyOverride['requiredGates'] = {};
    if ('breakdownApprovalRequired' in requiredGates) {
      if (typeof requiredGates.breakdownApprovalRequired !== 'boolean') {
        throw toPolicyConflictError(
          `Policy id=${row.id} field "requiredGates.breakdownApprovalRequired" must be a boolean.`,
        );
      }
      parsedRequiredGates.breakdownApprovalRequired = requiredGates.breakdownApprovalRequired;
    }
    override.requiredGates = parsedRequiredGates;
  }

  return override;
}

function createDefaultEffectivePolicy(): DashboardWorkItemPolicySnapshot {
  return {
    allowedProviders: null,
    allowedModels: null,
    allowedSkillIdentifiers: null,
    allowedMcpServerIdentifiers: null,
    budgets: {
      maxConcurrentTasks: null,
      maxConcurrentRuns: null,
    },
    requiredGates: {
      breakdownApprovalRequired: true,
    },
  };
}

function applyPolicyOverride(target: DashboardWorkItemPolicySnapshot, override: ParsedPolicyOverride | null): void {
  if (!override) {
    return;
  }

  if ('allowedProviders' in override) {
    target.allowedProviders = override.allowedProviders ?? null;
  }
  if ('allowedModels' in override) {
    target.allowedModels = override.allowedModels ?? null;
  }
  if ('allowedSkillIdentifiers' in override) {
    target.allowedSkillIdentifiers = override.allowedSkillIdentifiers ?? null;
  }
  if ('allowedMcpServerIdentifiers' in override) {
    target.allowedMcpServerIdentifiers = override.allowedMcpServerIdentifiers ?? null;
  }

  if (override.budgets) {
    if ('maxConcurrentTasks' in override.budgets) {
      target.budgets.maxConcurrentTasks = override.budgets.maxConcurrentTasks ?? null;
    }
    if ('maxConcurrentRuns' in override.budgets) {
      target.budgets.maxConcurrentRuns = override.budgets.maxConcurrentRuns ?? null;
    }
  }

  if (override.requiredGates && 'breakdownApprovalRequired' in override.requiredGates) {
    target.requiredGates.breakdownApprovalRequired = override.requiredGates.breakdownApprovalRequired ?? true;
  }
}

function resolveEpicWorkItemId(
  workItemId: number,
  workItemIdentityById: ReadonlyMap<number, WorkItemIdentity>,
): number | null {
  let currentId: number | null = workItemId;
  const visited = new Set<number>();

  while (currentId !== null) {
    if (visited.has(currentId)) {
      throw toPolicyConflictError(`Detected a parent cycle while resolving work item id=${workItemId}.`);
    }
    visited.add(currentId);

    const current = workItemIdentityById.get(currentId);
    if (!current) {
      return null;
    }

    if (current.type === 'epic') {
      return current.id;
    }

    currentId = current.parentId;
  }

  return null;
}

function loadWorkItemIdentityMap(db: DbOrTx, repositoryId: number): ReadonlyMap<number, WorkItemIdentity> {
  const identityRows = db
    .select({
      id: workItems.id,
      type: workItems.type,
      parentId: workItems.parentId,
    })
    .from(workItems)
    .where(eq(workItems.repositoryId, repositoryId))
    .all();

  const workItemIdentityById = new Map<number, WorkItemIdentity>();
  for (const identityRow of identityRows) {
    workItemIdentityById.set(identityRow.id, {
      id: identityRow.id,
      type: identityRow.type as WorkItemType,
      parentId: identityRow.parentId,
    });
  }

  return workItemIdentityById;
}

function didAncestorReparentChangeDescendantPolicyContext(params: {
  existing: WorkItemRow;
  reloaded: WorkItemRow;
  workItemIdentityById: ReadonlyMap<number, WorkItemIdentity>;
}): boolean {
  if (params.reloaded.type === 'task') {
    return false;
  }

  if (params.existing.parentId === params.reloaded.parentId) {
    return false;
  }

  const currentIdentityById = new Map(params.workItemIdentityById);
  currentIdentityById.set(params.reloaded.id, {
    id: params.reloaded.id,
    type: params.reloaded.type as WorkItemType,
    parentId: params.reloaded.parentId,
  });

  const previousIdentityById = new Map(currentIdentityById);
  previousIdentityById.set(params.reloaded.id, {
    id: params.reloaded.id,
    type: params.reloaded.type as WorkItemType,
    parentId: params.existing.parentId,
  });

  const previousEpicWorkItemId = resolveEpicWorkItemId(params.reloaded.id, previousIdentityById);
  const nextEpicWorkItemId = resolveEpicWorkItemId(params.reloaded.id, currentIdentityById);
  return previousEpicWorkItemId !== nextEpicWorkItemId;
}

function loadPolicyResolutionContext(db: DbOrTx, repositoryId: number): PolicyResolutionContext {
  const workItemIdentityById = loadWorkItemIdentityMap(db, repositoryId);

  const policyRows = db
    .select()
    .from(workItemPolicies)
    .where(eq(workItemPolicies.repositoryId, repositoryId))
    .all();

  let repositoryPolicy: { id: number; override: ParsedPolicyOverride } | null = null;
  const epicPoliciesByEpicId = new Map<number, { id: number; override: ParsedPolicyOverride }>();

  for (const row of policyRows) {
    const parsedOverride = parsePolicyOverride(row);
    if (row.epicWorkItemId === null) {
      if (repositoryPolicy !== null) {
        throw toPolicyConflictError(`Repository id=${repositoryId} has multiple repo-level policies.`);
      }
      repositoryPolicy = {
        id: row.id,
        override: parsedOverride,
      };
      continue;
    }

    const target = workItemIdentityById.get(row.epicWorkItemId);
    if (!target || target.type !== 'epic') {
      throw toPolicyConflictError(`Policy id=${row.id} targets work item id=${row.epicWorkItemId}, which is not an epic.`, {
        policyId: row.id,
        epicWorkItemId: row.epicWorkItemId,
      });
    }

    if (epicPoliciesByEpicId.has(row.epicWorkItemId)) {
      throw toPolicyConflictError(
        `Repository id=${repositoryId} has multiple policy overrides for epic id=${row.epicWorkItemId}.`,
      );
    }

    epicPoliciesByEpicId.set(row.epicWorkItemId, {
      id: row.id,
      override: parsedOverride,
    });
  }

  return {
    workItemIdentityById,
    repositoryPolicy,
    epicPoliciesByEpicId,
  };
}

function loadWorkItemIdentityChain(
  db: DbOrTx,
  params: { repositoryId: number; row: WorkItemRow },
): ReadonlyMap<number, WorkItemIdentity> {
  const workItemIdentityById = new Map<number, WorkItemIdentity>();
  const initialIdentity: WorkItemIdentity = {
    id: params.row.id,
    type: params.row.type as WorkItemType,
    parentId: params.row.parentId,
  };
  workItemIdentityById.set(initialIdentity.id, initialIdentity);

  if (initialIdentity.type !== 'task') {
    return workItemIdentityById;
  }

  let parentId = initialIdentity.parentId;
  const visited = new Set<number>([initialIdentity.id]);
  while (parentId !== null) {
    if (visited.has(parentId)) {
      throw toPolicyConflictError(`Detected a parent cycle while resolving work item id=${params.row.id}.`);
    }
    visited.add(parentId);

    const parent = db
      .select({
        id: workItems.id,
        type: workItems.type,
        parentId: workItems.parentId,
      })
      .from(workItems)
      .where(and(eq(workItems.repositoryId, params.repositoryId), eq(workItems.id, parentId)))
      .get();

    if (!parent) {
      break;
    }

    const identity: WorkItemIdentity = {
      id: parent.id,
      type: parent.type as WorkItemType,
      parentId: parent.parentId,
    };
    workItemIdentityById.set(identity.id, identity);
    parentId = identity.parentId;
  }

  return workItemIdentityById;
}

function loadRepositoryPolicyOverride(
  db: DbOrTx,
  repositoryId: number,
): { id: number; override: ParsedPolicyOverride } | null {
  const repositoryPolicyRows = db
    .select()
    .from(workItemPolicies)
    .where(and(eq(workItemPolicies.repositoryId, repositoryId), sql`${workItemPolicies.epicWorkItemId} is null`))
    .limit(2)
    .all();

  if (repositoryPolicyRows.length > 1) {
    throw toPolicyConflictError(`Repository id=${repositoryId} has multiple repo-level policies.`);
  }

  const repositoryPolicyRow = repositoryPolicyRows[0];
  if (!repositoryPolicyRow) {
    return null;
  }

  return {
    id: repositoryPolicyRow.id,
    override: parsePolicyOverride(repositoryPolicyRow),
  };
}

function loadEpicPolicyOverrides(
  db: DbOrTx,
  params: {
    repositoryId: number;
    epicWorkItemId: number | null;
    workItemIdentityById: ReadonlyMap<number, WorkItemIdentity>;
  },
): ReadonlyMap<number, { id: number; override: ParsedPolicyOverride }> {
  if (params.epicWorkItemId === null) {
    return new Map();
  }

  const epicPolicyRows = db
    .select()
    .from(workItemPolicies)
    .where(
      and(
        eq(workItemPolicies.repositoryId, params.repositoryId),
        eq(workItemPolicies.epicWorkItemId, params.epicWorkItemId),
      ),
    )
    .limit(2)
    .all();

  if (epicPolicyRows.length > 1) {
    throw toPolicyConflictError(
      `Repository id=${params.repositoryId} has multiple policy overrides for epic id=${params.epicWorkItemId}.`,
    );
  }

  const epicPolicyRow = epicPolicyRows[0];
  if (!epicPolicyRow) {
    return new Map();
  }

  const target = params.workItemIdentityById.get(params.epicWorkItemId);
  if (!target || target.type !== 'epic') {
    throw toPolicyConflictError(`Policy id=${epicPolicyRow.id} targets work item id=${params.epicWorkItemId}, which is not an epic.`, {
      policyId: epicPolicyRow.id,
      epicWorkItemId: params.epicWorkItemId,
    });
  }

  const epicPoliciesByEpicId = new Map<number, { id: number; override: ParsedPolicyOverride }>();
  epicPoliciesByEpicId.set(params.epicWorkItemId, {
    id: epicPolicyRow.id,
    override: parsePolicyOverride(epicPolicyRow),
  });
  return epicPoliciesByEpicId;
}

function loadPolicyResolutionContextForWorkItem(
  db: DbOrTx,
  params: {
    repositoryId: number;
    row: WorkItemRow;
  },
): PolicyResolutionContext {
  const workItemIdentityById = loadWorkItemIdentityChain(db, {
    repositoryId: params.repositoryId,
    row: params.row,
  });
  const epicWorkItemId =
    params.row.type === 'epic'
      ? params.row.id
      : params.row.type === 'task'
        ? resolveEpicWorkItemId(params.row.id, workItemIdentityById)
        : null;

  return {
    workItemIdentityById,
    repositoryPolicy: loadRepositoryPolicyOverride(db, params.repositoryId),
    epicPoliciesByEpicId: loadEpicPolicyOverrides(db, {
      repositoryId: params.repositoryId,
      epicWorkItemId,
      workItemIdentityById,
    }),
  };
}

function resolveEffectivePolicyForWorkItem(
  row: WorkItemRow,
  context: PolicyResolutionContext,
): DashboardWorkItemEffectivePolicySnapshot | null {
  if (row.type !== 'epic' && row.type !== 'task') {
    return null;
  }

  const epicWorkItemId = row.type === 'epic' ? row.id : resolveEpicWorkItemId(row.id, context.workItemIdentityById);
  const epicPolicy = epicWorkItemId === null ? null : (context.epicPoliciesByEpicId.get(epicWorkItemId) ?? null);

  const policy = createDefaultEffectivePolicy();
  applyPolicyOverride(policy, context.repositoryPolicy?.override ?? null);
  applyPolicyOverride(policy, epicPolicy?.override ?? null);

  return {
    appliesToType: row.type,
    epicWorkItemId,
    repositoryPolicyId: context.repositoryPolicy?.id ?? null,
    epicPolicyId: epicPolicy?.id ?? null,
    policy,
  };
}

function toLinkedRunSnapshot(
  row: Pick<WorkItemWorkflowRunRow, 'workflowRunId' | 'linkedAt'> & {
    runStatus: string;
  },
  touchedFiles: string[] | null,
): DashboardWorkItemLinkedRunSnapshot {
  const snapshot: DashboardWorkItemLinkedRunSnapshot = {
    workflowRunId: row.workflowRunId,
    runStatus: row.runStatus as DashboardWorkItemLinkedRunSnapshot['runStatus'],
    linkedAt: row.linkedAt,
  };

  if (touchedFiles !== null) {
    snapshot.touchedFiles = touchedFiles;
  }

  return snapshot;
}

function isReadableRunWorktreeStatus(status: string): boolean {
  return status === 'active';
}

function loadTouchedFilesByWorkflowRunId(
  db: DbOrTx,
  params: {
    repositoryId: number;
    workflowRunIds: readonly number[];
  },
): ReadonlyMap<number, string[] | null> {
  if (params.workflowRunIds.length === 0) {
    return new Map();
  }

  const rows = db
    .select({
      workflowRunId: runWorktrees.workflowRunId,
      worktreePath: runWorktrees.worktreePath,
      status: runWorktrees.status,
      id: runWorktrees.id,
    })
    .from(runWorktrees)
    .where(
      and(
        eq(runWorktrees.repositoryId, params.repositoryId),
        inArray(runWorktrees.workflowRunId, [...params.workflowRunIds]),
      ),
    )
    .all();

  const bestWorktreeByRunId = new Map<number, { worktreePath: string; status: string; id: number }>();
  for (const row of rows) {
    const existing = bestWorktreeByRunId.get(row.workflowRunId);
    if (!existing) {
      bestWorktreeByRunId.set(row.workflowRunId, {
        worktreePath: row.worktreePath,
        status: row.status,
        id: row.id,
      });
      continue;
    }

    const rowPriority = row.status === 'active' ? 2 : 1;
    const existingPriority = existing.status === 'active' ? 2 : 1;
    if (rowPriority > existingPriority || (rowPriority === existingPriority && row.id > existing.id)) {
      bestWorktreeByRunId.set(row.workflowRunId, {
        worktreePath: row.worktreePath,
        status: row.status,
        id: row.id,
      });
    }
  }

  const touchedFilesByRunId = new Map<number, string[] | null>();
  for (const workflowRunId of params.workflowRunIds) {
    const best = bestWorktreeByRunId.get(workflowRunId);
    touchedFilesByRunId.set(
      workflowRunId,
      best && isReadableRunWorktreeStatus(best.status) ? readTouchedFilesFromWorktree(best.worktreePath) : null,
    );
  }

  return touchedFilesByRunId;
}

async function loadTouchedFilesByWorkflowRunIdAsync(
  db: DbOrTx,
  params: {
    repositoryId: number;
    workflowRunIds: readonly number[];
  },
): Promise<ReadonlyMap<number, string[] | null>> {
  if (params.workflowRunIds.length === 0) {
    return new Map();
  }

  const rows = db
    .select({
      workflowRunId: runWorktrees.workflowRunId,
      worktreePath: runWorktrees.worktreePath,
      status: runWorktrees.status,
      id: runWorktrees.id,
    })
    .from(runWorktrees)
    .where(
      and(
        eq(runWorktrees.repositoryId, params.repositoryId),
        inArray(runWorktrees.workflowRunId, [...params.workflowRunIds]),
      ),
    )
    .all();

  const bestWorktreeByRunId = new Map<number, { worktreePath: string; status: string; id: number }>();
  for (const row of rows) {
    const existing = bestWorktreeByRunId.get(row.workflowRunId);
    if (!existing) {
      bestWorktreeByRunId.set(row.workflowRunId, {
        worktreePath: row.worktreePath,
        status: row.status,
        id: row.id,
      });
      continue;
    }

    const rowPriority = row.status === 'active' ? 2 : 1;
    const existingPriority = existing.status === 'active' ? 2 : 1;
    if (rowPriority > existingPriority || (rowPriority === existingPriority && row.id > existing.id)) {
      bestWorktreeByRunId.set(row.workflowRunId, {
        worktreePath: row.worktreePath,
        status: row.status,
        id: row.id,
      });
    }
  }

  const entries: (readonly [number, string[] | null])[] = [];
  for (let offset = 0; offset < params.workflowRunIds.length; offset += TOUCHED_FILES_READ_BATCH_SIZE) {
    const batch = params.workflowRunIds.slice(offset, offset + TOUCHED_FILES_READ_BATCH_SIZE);
    const batchEntries = await Promise.all(
      batch.map(async workflowRunId => {
        const best = bestWorktreeByRunId.get(workflowRunId);
        const touchedFiles =
          best && isReadableRunWorktreeStatus(best.status)
            ? await readTouchedFilesFromWorktreeAsync(best.worktreePath)
            : null;
        return [workflowRunId, touchedFiles] as const;
      }),
    );
    entries.push(...batchEntries);
  }
  return new Map(entries);
}

function loadLatestLinkedWorkflowRunsForTasks(
  db: DbOrTx,
  params: {
    repositoryId: number;
    taskWorkItemIds: readonly number[];
    includeTouchedFiles?: boolean;
  },
): ReadonlyMap<number, DashboardWorkItemLinkedRunSnapshot> {
  if (params.taskWorkItemIds.length === 0) {
    return new Map();
  }

  const rows = db
    .select({
      id: workItemWorkflowRuns.id,
      workItemId: workItemWorkflowRuns.workItemId,
      workflowRunId: workItemWorkflowRuns.workflowRunId,
      linkedAt: workItemWorkflowRuns.linkedAt,
      runStatus: workflowRuns.status,
    })
    .from(workItemWorkflowRuns)
    .innerJoin(workflowRuns, eq(workItemWorkflowRuns.workflowRunId, workflowRuns.id))
    .where(
      and(
        eq(workItemWorkflowRuns.repositoryId, params.repositoryId),
        inArray(workItemWorkflowRuns.workItemId, [...params.taskWorkItemIds]),
      ),
    )
    .orderBy(asc(workItemWorkflowRuns.workItemId), desc(workItemWorkflowRuns.linkedAt), desc(workItemWorkflowRuns.id))
    .all();

  const latestRowsByTaskId = new Map<number, typeof rows[number]>();
  for (const row of rows) {
    if (latestRowsByTaskId.has(row.workItemId)) {
      continue;
    }
    latestRowsByTaskId.set(row.workItemId, row);
  }

  const workflowRunIds = [...new Set([...latestRowsByTaskId.values()].map(row => row.workflowRunId))].sort(
    (left, right) => left - right,
  );
  const touchedFilesByRunId =
    params.includeTouchedFiles === false
      ? new Map<number, string[] | null>()
      : loadTouchedFilesByWorkflowRunId(db, {
          repositoryId: params.repositoryId,
          workflowRunIds,
        });

  const latestByTaskId = new Map<number, DashboardWorkItemLinkedRunSnapshot>();
  for (const [workItemId, row] of latestRowsByTaskId.entries()) {
    latestByTaskId.set(
      workItemId,
      toLinkedRunSnapshot(
        row,
        params.includeTouchedFiles === false ? null : (touchedFilesByRunId.get(row.workflowRunId) ?? null),
      ),
    );
  }

  return latestByTaskId;
}

async function loadLatestLinkedWorkflowRunsForTasksAsync(
  db: DbOrTx,
  params: {
    repositoryId: number;
    taskWorkItemIds: readonly number[];
    includeTouchedFiles?: boolean;
  },
): Promise<ReadonlyMap<number, DashboardWorkItemLinkedRunSnapshot>> {
  if (params.taskWorkItemIds.length === 0) {
    return new Map();
  }

  const rows = db
    .select({
      id: workItemWorkflowRuns.id,
      workItemId: workItemWorkflowRuns.workItemId,
      workflowRunId: workItemWorkflowRuns.workflowRunId,
      linkedAt: workItemWorkflowRuns.linkedAt,
      runStatus: workflowRuns.status,
    })
    .from(workItemWorkflowRuns)
    .innerJoin(workflowRuns, eq(workItemWorkflowRuns.workflowRunId, workflowRuns.id))
    .where(
      and(
        eq(workItemWorkflowRuns.repositoryId, params.repositoryId),
        inArray(workItemWorkflowRuns.workItemId, [...params.taskWorkItemIds]),
      ),
    )
    .orderBy(asc(workItemWorkflowRuns.workItemId), desc(workItemWorkflowRuns.linkedAt), desc(workItemWorkflowRuns.id))
    .all();

  const latestRowsByTaskId = new Map<number, typeof rows[number]>();
  for (const row of rows) {
    if (latestRowsByTaskId.has(row.workItemId)) {
      continue;
    }
    latestRowsByTaskId.set(row.workItemId, row);
  }

  const workflowRunIds = [...new Set([...latestRowsByTaskId.values()].map(row => row.workflowRunId))].sort(
    (left, right) => left - right,
  );
  const touchedFilesByRunId =
    params.includeTouchedFiles === false
      ? new Map<number, string[] | null>()
      : await loadTouchedFilesByWorkflowRunIdAsync(db, {
          repositoryId: params.repositoryId,
          workflowRunIds,
        });

  const latestByTaskId = new Map<number, DashboardWorkItemLinkedRunSnapshot>();
  for (const [workItemId, row] of latestRowsByTaskId.entries()) {
    latestByTaskId.set(
      workItemId,
      toLinkedRunSnapshot(
        row,
        params.includeTouchedFiles === false ? null : (touchedFilesByRunId.get(row.workflowRunId) ?? null),
      ),
    );
  }

  return latestByTaskId;
}

function toWorkItemSnapshot(
  row: WorkItemRow,
  effectivePolicy: DashboardWorkItemEffectivePolicySnapshot | null,
  linkedWorkflowRun: DashboardWorkItemLinkedRunSnapshot | null,
): DashboardWorkItemSnapshot {
  return {
    id: row.id,
    repositoryId: row.repositoryId,
    type: row.type as WorkItemType,
    status: row.status as WorkItemStatus,
    title: row.title,
    description: row.description,
    parentId: row.parentId,
    tags: toStringArrayOrNull(row.tags),
    plannedFiles: toRepoRelativePathArrayOrNull(row.plannedFiles) ?? toStringArrayOrNull(row.plannedFiles),
    assignees: toStringArrayOrNull(row.assignees),
    priority: row.priority,
    estimate: row.estimate,
    revision: row.revision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    effectivePolicy,
    linkedWorkflowRun,
  };
}

function toBoardEventSnapshot(row: WorkItemEventRow): DashboardBoardEventSnapshot {
  return {
    id: row.id,
    repositoryId: row.repositoryId,
    workItemId: row.workItemId,
    eventType: row.eventType as WorkItemEventType,
    actorType: row.actorType as WorkItemActorType,
    actorLabel: row.actorLabel,
    payload: row.payload,
    createdAt: row.createdAt,
  };
}

function requireActor(params: { actorType: WorkItemActorType; actorLabel: string }): {
  actorType: WorkItemActorType;
  actorLabel: string;
} {
  const actorLabel = params.actorLabel.trim();
  if (actorLabel.length === 0) {
    throw new DashboardIntegrationError('invalid_request', 'actorLabel cannot be empty.', {
      status: 400,
    });
  }
  return {
    actorType: params.actorType,
    actorLabel,
  };
}

function requireRepositoryId(repositoryId: number): number {
  if (!Number.isInteger(repositoryId) || repositoryId < 1) {
    throw new DashboardIntegrationError('invalid_request', 'repositoryId must be a positive integer.', {
      status: 400,
    });
  }
  return repositoryId;
}

function requireWorkItemId(workItemId: number, label = 'workItemId'): number {
  if (!Number.isInteger(workItemId) || workItemId < 1) {
    throw new DashboardIntegrationError('invalid_request', `${label} must be a positive integer.`, {
      status: 400,
    });
  }
  return workItemId;
}

function requireWorkflowRunId(workflowRunId: number): number {
  if (!Number.isInteger(workflowRunId) || workflowRunId < 1) {
    throw new DashboardIntegrationError('invalid_request', 'linkedWorkflowRunId must be a positive integer.', {
      status: 400,
    });
  }

  return workflowRunId;
}

function requireExpectedRevision(expectedRevision: number): number {
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    throw new DashboardIntegrationError('invalid_request', 'expectedRevision must be a non-negative integer.', {
      status: 400,
    });
  }
  return expectedRevision;
}

type ParsedMoveWorkItemStatusRequest = {
  repositoryId: number;
  workItemId: number;
  expectedRevision: number;
  toStatus: DashboardMoveWorkItemStatusRequest['toStatus'];
  linkedWorkflowRunId: number | null;
  actor: {
    actorType: WorkItemActorType;
    actorLabel: string;
  };
};

function parseMoveWorkItemStatusRequest(
  requestRaw: DashboardMoveWorkItemStatusRequest,
): ParsedMoveWorkItemStatusRequest {
  return {
    repositoryId: requireRepositoryId(requestRaw.repositoryId),
    workItemId: requireWorkItemId(requestRaw.workItemId),
    expectedRevision: requireExpectedRevision(requestRaw.expectedRevision),
    toStatus: requestRaw.toStatus,
    linkedWorkflowRunId:
      requestRaw.linkedWorkflowRunId === undefined ? null : requireWorkflowRunId(requestRaw.linkedWorkflowRunId),
    actor: requireActor(requestRaw),
  };
}

export function validateMoveWorkItemStatusRequest(requestRaw: DashboardMoveWorkItemStatusRequest): void {
  parseMoveWorkItemStatusRequest(requestRaw);
}

function requireLastEventId(lastEventId: number): number {
  if (!Number.isInteger(lastEventId) || lastEventId < 0) {
    throw new DashboardIntegrationError('invalid_request', 'lastEventId must be a non-negative integer.', {
      status: 400,
    });
  }
  return lastEventId;
}

function requireSnapshotLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new DashboardIntegrationError('invalid_request', 'limit must be a positive integer.', {
      status: 400,
    });
  }

  return Math.min(limit, MAX_BOARD_EVENT_SNAPSHOT_EVENTS);
}

function isValidStatusForType(type: WorkItemType, status: string): status is WorkItemStatus {
  return (workItemStatusesByType[type] as readonly string[]).includes(status);
}

function readWorkItemOrThrow(
  db: DbOrTx,
  params: { repositoryId: number; workItemId: number; notFoundMessage?: string },
): WorkItemRow {
  const row = db
    .select()
    .from(workItems)
    .where(and(eq(workItems.repositoryId, params.repositoryId), eq(workItems.id, params.workItemId)))
    .get();

  if (!row) {
    throw new DashboardIntegrationError(
      'not_found',
      params.notFoundMessage ?? `Work item id=${params.workItemId} was not found.`,
      { status: 404 },
    );
  }

  return row;
}

function readDescendantTasks(
  db: DbOrTx,
  params: {
    repositoryId: number;
    ancestorWorkItemId: number;
  },
): WorkItemRow[] {
  const rows = db.select().from(workItems).where(eq(workItems.repositoryId, params.repositoryId)).all();

  const childrenByParentId = new Map<number, WorkItemRow[]>();
  for (const row of rows) {
    if (row.parentId === null) {
      continue;
    }

    const children = childrenByParentId.get(row.parentId);
    if (children) {
      children.push(row);
      continue;
    }

    childrenByParentId.set(row.parentId, [row]);
  }

  const descendantTasks: WorkItemRow[] = [];
  const queue: number[] = [params.ancestorWorkItemId];
  const visited = new Set(queue);

  while (queue.length > 0) {
    const currentId = queue.shift();
    if (currentId === undefined) {
      continue;
    }

    const children = childrenByParentId.get(currentId) ?? [];
    for (const child of children) {
      if (visited.has(child.id)) {
        continue;
      }
      visited.add(child.id);
      queue.push(child.id);

      if (child.type === 'task') {
        descendantTasks.push(child);
      }
    }
  }

  descendantTasks.sort((left, right) => left.id - right.id);
  return descendantTasks;
}

function insertEvent(
  db: DbOrTx,
  params: {
    repositoryId: number;
    workItemId: number;
    eventType: WorkItemEventType;
    actorType: WorkItemActorType;
    actorLabel: string;
    payload: Record<string, unknown>;
    occurredAt: string;
  },
): void {
  db.insert(workItemEvents)
    .values({
      repositoryId: params.repositoryId,
      workItemId: params.workItemId,
      eventType: params.eventType,
      actorType: params.actorType,
      actorLabel: params.actorLabel,
      payload: params.payload,
      createdAt: params.occurredAt,
    })
    .run();
}

function throwRevisionConflict(params: { workItemId: number; expectedRevision: number }): never {
  throw new DashboardIntegrationError(
    'conflict',
    `Work item id=${params.workItemId} revision conflict (expected ${params.expectedRevision}).`,
    {
      status: 409,
      details: {
        workItemId: params.workItemId,
        expectedRevision: params.expectedRevision,
      },
    },
  );
}

function toTransitionConflictError(error: unknown): DashboardIntegrationError {
  const message = error instanceof Error ? error.message : String(error);
  return new DashboardIntegrationError('conflict', message, {
    status: 409,
    details: {
      kind: 'work_item_transition',
    },
    cause: error,
  });
}

function toHierarchyConflictError(error: unknown): DashboardIntegrationError {
  const message = error instanceof Error ? error.message : String(error);
  return new DashboardIntegrationError('conflict', message, {
    status: 409,
    details: {
      kind: 'work_item_hierarchy',
    },
    cause: error,
  });
}

function toWorkItemSnapshotsWithPolicies(
  db: DbOrTx,
  params: {
    repositoryId: number;
    rows: readonly WorkItemRow[];
    includeTouchedFiles?: boolean;
  },
): DashboardWorkItemSnapshot[] {
  const context = loadPolicyResolutionContext(db, params.repositoryId);
  const taskWorkItemIds = params.rows.filter(row => row.type === 'task').map(row => row.id);
  const latestLinkedRuns = loadLatestLinkedWorkflowRunsForTasks(db, {
    repositoryId: params.repositoryId,
    taskWorkItemIds,
    includeTouchedFiles: params.includeTouchedFiles ?? false,
  });
  return params.rows.map(row =>
    toWorkItemSnapshot(
      row,
      resolveEffectivePolicyForWorkItem(row, context),
      row.type === 'task' ? (latestLinkedRuns.get(row.id) ?? null) : null,
    ),
  );
}

async function toWorkItemSnapshotsWithPoliciesAsync(
  db: DbOrTx,
  params: {
    repositoryId: number;
    rows: readonly WorkItemRow[];
    includeTouchedFiles?: boolean;
  },
): Promise<DashboardWorkItemSnapshot[]> {
  const context = loadPolicyResolutionContext(db, params.repositoryId);
  const taskWorkItemIds = params.rows.filter(row => row.type === 'task').map(row => row.id);
  const latestLinkedRuns = await loadLatestLinkedWorkflowRunsForTasksAsync(db, {
    repositoryId: params.repositoryId,
    taskWorkItemIds,
    includeTouchedFiles: params.includeTouchedFiles ?? true,
  });
  return params.rows.map(row =>
    toWorkItemSnapshot(
      row,
      resolveEffectivePolicyForWorkItem(row, context),
      row.type === 'task' ? (latestLinkedRuns.get(row.id) ?? null) : null,
    ),
  );
}

function toWorkItemSnapshotWithPolicy(
  db: DbOrTx,
  params: {
    repositoryId: number;
    row: WorkItemRow;
    includeTouchedFiles?: boolean;
  },
): DashboardWorkItemSnapshot {
  const context = loadPolicyResolutionContextForWorkItem(db, params);
  const latestLinkedRuns =
    params.row.type === 'task'
      ? loadLatestLinkedWorkflowRunsForTasks(db, {
          repositoryId: params.repositoryId,
          taskWorkItemIds: [params.row.id],
          includeTouchedFiles: params.includeTouchedFiles ?? true,
        })
      : new Map<number, DashboardWorkItemLinkedRunSnapshot>();
  return toWorkItemSnapshot(
    params.row,
    resolveEffectivePolicyForWorkItem(params.row, context),
    params.row.type === 'task' ? (latestLinkedRuns.get(params.row.id) ?? null) : null,
  );
}

async function toWorkItemSnapshotWithPolicyAsync(
  db: DbOrTx,
  params: {
    repositoryId: number;
    row: WorkItemRow;
    includeTouchedFiles?: boolean;
  },
): Promise<DashboardWorkItemSnapshot> {
  const context = loadPolicyResolutionContextForWorkItem(db, params);
  const latestLinkedRuns =
    params.row.type === 'task'
      ? await loadLatestLinkedWorkflowRunsForTasksAsync(db, {
          repositoryId: params.repositoryId,
          taskWorkItemIds: [params.row.id],
          includeTouchedFiles: params.includeTouchedFiles ?? true,
        })
      : new Map<number, DashboardWorkItemLinkedRunSnapshot>();
  return toWorkItemSnapshot(
    params.row,
    resolveEffectivePolicyForWorkItem(params.row, context),
    params.row.type === 'task' ? (latestLinkedRuns.get(params.row.id) ?? null) : null,
  );
}

function resolvePlanVsActualDelta(
  plannedFiles: string[] | null,
  touchedFiles: string[] | null,
): {
  plannedButUntouched: string[];
  touchedButUnplanned: string[];
} {
  const planned = toUniqueSortedStrings(plannedFiles ?? []);
  const touched = toUniqueSortedStrings(touchedFiles ?? []);
  const touchedSet = new Set(touched);
  const plannedSet = new Set(planned);

  return {
    plannedButUntouched: planned.filter(path => !touchedSet.has(path)),
    touchedButUnplanned: touched.filter(path => !plannedSet.has(path)),
  };
}

export type WorkItemOperations = {
  listWorkItems: (repositoryId: number) => Promise<DashboardListWorkItemsResult>;
  getRepositoryBoardBootstrap: (params: { repositoryId: number }) => Promise<DashboardRepositoryBoardBootstrapResult>;
  getRepositoryBoardEventsSnapshot: (params: {
    repositoryId: number;
    lastEventId?: number;
    limit?: number;
  }) => Promise<DashboardBoardEventsSnapshot>;
  getWorkItem: (params: { repositoryId: number; workItemId: number }) => Promise<DashboardGetWorkItemResult>;
  getStoryBreakdownProposal: (params: { repositoryId: number; storyId: number }) => Promise<DashboardGetStoryBreakdownProposalResult>;
  createWorkItem: (request: DashboardCreateWorkItemRequest) => Promise<DashboardCreateWorkItemResult>;
  updateWorkItemFields: (request: DashboardUpdateWorkItemFieldsRequest) => Promise<DashboardUpdateWorkItemFieldsResult>;
  moveWorkItemStatus: (request: DashboardMoveWorkItemStatusRequest) => Promise<DashboardMoveWorkItemStatusResult>;
  requestWorkItemReplan: (request: DashboardRequestWorkItemReplanRequest) => Promise<DashboardRequestWorkItemReplanResult>;
  setWorkItemParent: (request: DashboardSetWorkItemParentRequest) => Promise<DashboardSetWorkItemParentResult>;
  proposeStoryBreakdown: (request: DashboardProposeStoryBreakdownRequest) => Promise<DashboardProposeStoryBreakdownResult>;
  approveStoryBreakdown: (request: DashboardApproveStoryBreakdownRequest) => Promise<DashboardApproveStoryBreakdownResult>;
};

export function createWorkItemOperations(params: { withDatabase: WithDatabase }): WorkItemOperations {
  const { withDatabase } = params;

  return {
    listWorkItems(repositoryIdRaw): Promise<DashboardListWorkItemsResult> {
      const repositoryId = requireRepositoryId(repositoryIdRaw);
      return withDatabase(async db => {
        const repository = db
          .select({ id: repositories.id })
          .from(repositories)
          .where(eq(repositories.id, repositoryId))
          .get();
        if (!repository) {
          throw new DashboardIntegrationError('not_found', `Repository id=${repositoryId} was not found.`, {
            status: 404,
          });
        }

        const rows = db.select().from(workItems).where(eq(workItems.repositoryId, repositoryId)).all();
        return {
          workItems: await toWorkItemSnapshotsWithPoliciesAsync(db, {
            repositoryId,
            rows,
          }),
        };
      });
    },

    getRepositoryBoardBootstrap(paramsRaw): Promise<DashboardRepositoryBoardBootstrapResult> {
      const repositoryId = requireRepositoryId(paramsRaw.repositoryId);

      return withDatabase(async db => {
        const repository = db
          .select({ id: repositories.id })
          .from(repositories)
          .where(eq(repositories.id, repositoryId))
          .get();
        if (!repository) {
          throw new DashboardIntegrationError('not_found', `Repository id=${repositoryId} was not found.`, {
            status: 404,
          });
        }

        const { rows, latestEventId } = db.transaction(tx => {
          const latestEvent = tx
            .select({ id: workItemEvents.id })
            .from(workItemEvents)
            .where(eq(workItemEvents.repositoryId, repositoryId))
            .orderBy(desc(workItemEvents.id))
            .limit(1)
            .get();
          const rows = tx.select().from(workItems).where(eq(workItems.repositoryId, repositoryId)).all();
          return {
            rows,
            latestEventId: latestEvent?.id ?? 0,
          };
        });

        return {
          repositoryId,
          latestEventId,
          workItems: await toWorkItemSnapshotsWithPoliciesAsync(db, {
            repositoryId,
            rows,
          }),
        };
      });
    },

    getRepositoryBoardEventsSnapshot(paramsRaw): Promise<DashboardBoardEventsSnapshot> {
      const repositoryId = requireRepositoryId(paramsRaw.repositoryId);
      const lastEventId = requireLastEventId(paramsRaw.lastEventId ?? 0);
      const limit = requireSnapshotLimit(paramsRaw.limit ?? MAX_BOARD_EVENT_SNAPSHOT_EVENTS);

      return withDatabase(db => {
        const repository = db
          .select({ id: repositories.id })
          .from(repositories)
          .where(eq(repositories.id, repositoryId))
          .get();
        if (!repository) {
          throw new DashboardIntegrationError('not_found', `Repository id=${repositoryId} was not found.`, {
            status: 404,
          });
        }

        const events = db
          .select()
          .from(workItemEvents)
          .where(
            and(
              eq(workItemEvents.repositoryId, repositoryId),
              sql`${workItemEvents.id} > ${lastEventId}`,
            ),
          )
          .orderBy(asc(workItemEvents.id))
          .limit(limit)
          .all();

        const latestEvent = db
          .select({ id: workItemEvents.id })
          .from(workItemEvents)
          .where(eq(workItemEvents.repositoryId, repositoryId))
          .orderBy(desc(workItemEvents.id))
          .limit(1)
          .get();

        return {
          repositoryId,
          latestEventId: latestEvent?.id ?? 0,
          events: events.map(toBoardEventSnapshot),
        };
      });
    },

    getWorkItem(paramsRaw): Promise<DashboardGetWorkItemResult> {
      const repositoryId = requireRepositoryId(paramsRaw.repositoryId);
      const workItemId = requireWorkItemId(paramsRaw.workItemId);
      return withDatabase(async db => {
        const row = readWorkItemOrThrow(db, { repositoryId, workItemId });
        return {
          workItem: await toWorkItemSnapshotWithPolicyAsync(db, {
            repositoryId,
            row,
          }),
        };
      });
    },

    getStoryBreakdownProposal(paramsRaw): Promise<DashboardGetStoryBreakdownProposalResult> {
      const repositoryId = requireRepositoryId(paramsRaw.repositoryId);
      const storyId = requireWorkItemId(paramsRaw.storyId, 'storyId');

      return withDatabase(db =>
        db.transaction(tx => {
          const story = readWorkItemOrThrow(tx, {
            repositoryId,
            workItemId: storyId,
            notFoundMessage: `Story id=${storyId} was not found.`,
          });
          if (story.type !== 'story') {
            throw new DashboardIntegrationError('invalid_request', `Work item id=${storyId} is not a story.`, {
              status: 400,
            });
          }

          const event = tx
            .select({ id: workItemEvents.id, payload: workItemEvents.payload, createdAt: workItemEvents.createdAt })
            .from(workItemEvents)
            .where(
              and(
                eq(workItemEvents.repositoryId, repositoryId),
                eq(workItemEvents.workItemId, storyId),
                eq(workItemEvents.eventType, 'breakdown_proposed'),
              ),
            )
            .orderBy(desc(workItemEvents.id))
            .limit(1)
            .get();

          if (!event) {
            return { proposal: null };
          }

          const payload = event.payload as unknown;
          if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
            return { proposal: null };
          }

          const payloadRecord = payload as Record<string, unknown>;
          const proposedRaw = payloadRecord.proposed;
          if (proposedRaw === null || typeof proposedRaw !== 'object' || Array.isArray(proposedRaw)) {
            return { proposal: null };
          }

          const proposedRecord = proposedRaw as Record<string, unknown>;
          const tasksRaw = proposedRecord.tasks;
          if (!Array.isArray(tasksRaw) || tasksRaw.length === 0) {
            return { proposal: null };
          }

          const coerceStringArrayOrNull = (value: unknown): string[] | null => {
            return toStringArrayOrNull(value);
          };

          const tasks = tasksRaw
            .map((task): DashboardStoryBreakdownProposalSnapshot['proposed']['tasks'][number] | null => {
              if (task === null || typeof task !== 'object' || Array.isArray(task)) {
                return null;
              }
              const record = task as Record<string, unknown>;
              if (typeof record.title !== 'string' || record.title.trim().length === 0) {
                return null;
              }

              const parsed: DashboardStoryBreakdownProposalSnapshot['proposed']['tasks'][number] = {
                title: record.title,
              };

              if ('description' in record) {
                parsed.description = typeof record.description === 'string' ? record.description : record.description === null ? null : undefined;
              }
              if ('tags' in record) {
                parsed.tags = coerceStringArrayOrNull(record.tags);
              }
              if ('plannedFiles' in record) {
                parsed.plannedFiles = coerceStringArrayOrNull(record.plannedFiles);
              }
              if ('assignees' in record) {
                parsed.assignees = coerceStringArrayOrNull(record.assignees);
              }
              if ('priority' in record) {
                parsed.priority = typeof record.priority === 'number' ? record.priority : record.priority === null ? null : undefined;
              }
              if ('estimate' in record) {
                parsed.estimate = typeof record.estimate === 'number' ? record.estimate : record.estimate === null ? null : undefined;
              }
              if ('links' in record) {
                parsed.links = coerceStringArrayOrNull(record.links);
              }

              return parsed;
            })
            .filter((entry): entry is DashboardStoryBreakdownProposalSnapshot['proposed']['tasks'][number] => entry !== null);

          if (tasks.length === 0) {
            return { proposal: null };
          }

          const createdTaskIds = Array.isArray(payloadRecord.createdTaskIds)
            ? payloadRecord.createdTaskIds.filter((entry): entry is number => typeof entry === 'number' && Number.isInteger(entry) && entry > 0)
            : [];

          return {
            proposal: {
              eventId: event.id,
              createdAt: event.createdAt,
              createdTaskIds,
              proposed: {
                tags: coerceStringArrayOrNull(proposedRecord.tags),
                plannedFiles: coerceStringArrayOrNull(proposedRecord.plannedFiles),
                links: coerceStringArrayOrNull(proposedRecord.links),
                tasks,
              },
            },
          };
        }),
      );
    },

    createWorkItem(requestRaw): Promise<DashboardCreateWorkItemResult> {
      const repositoryId = requireRepositoryId(requestRaw.repositoryId);
      const type = requestRaw.type;
      const title = requestRaw.title.trim();
      if (title.length === 0) {
        throw new DashboardIntegrationError('invalid_request', 'title cannot be empty.', { status: 400 });
      }

      const status = requestRaw.status ?? 'Draft';
      if (!isValidStatusForType(type, status)) {
        throw new DashboardIntegrationError('invalid_request', `Invalid status "${status}" for type "${type}".`, {
          status: 400,
        });
      }

      const actor = requireActor(requestRaw);

      const description = toOptionalNonEmptyTrimmedString(requestRaw.description ?? null);
      const tags = requestRaw.tags ?? null;
      const plannedFilesRaw = requestRaw.plannedFiles ?? null;
      const assignees = requestRaw.assignees ?? null;
      const priority = requestRaw.priority ?? null;
      const estimate = requestRaw.estimate ?? null;
      const parentIdRaw = requestRaw.parentId ?? null;

      if (tags !== null && toStringArrayOrNull(tags) === null) {
        throw new DashboardIntegrationError('invalid_request', 'tags must be an array of strings when provided.', {
          status: 400,
        });
      }
      const plannedFiles = plannedFilesRaw === null ? null : toRepoRelativePathArrayOrNull(plannedFilesRaw);
      if (plannedFilesRaw !== null && plannedFiles === null) {
        throw new DashboardIntegrationError(
          'invalid_request',
          'plannedFiles must be an array of repo-relative file paths when provided.',
          {
            status: 400,
          },
        );
      }
      if (assignees !== null && toStringArrayOrNull(assignees) === null) {
        throw new DashboardIntegrationError('invalid_request', 'assignees must be an array of strings when provided.', {
          status: 400,
        });
      }

      const occurredAt = new Date().toISOString();

      return withDatabase(db =>
        db.transaction(tx => {
          const repository = tx
            .select({ id: repositories.id })
            .from(repositories)
            .where(eq(repositories.id, repositoryId))
            .get();
          if (!repository) {
            throw new DashboardIntegrationError('not_found', `Repository id=${repositoryId} was not found.`, {
              status: 404,
            });
          }

          let parentId: number | null = null;
          if (parentIdRaw !== null) {
            parentId = requireWorkItemId(parentIdRaw, 'parentId');
            const parent = readWorkItemOrThrow(tx, {
              repositoryId,
              workItemId: parentId,
              notFoundMessage: `Parent work item id=${parentId} was not found.`,
            });
            try {
              validateParentChildWorkItemTypes(parent.type as WorkItemType, type);
            } catch (error) {
              throw toHierarchyConflictError(error);
            }
          }

          const insertResult = tx
            .insert(workItems)
            .values({
              repositoryId,
              type,
              status,
              title,
              description,
              parentId,
              tags,
              plannedFiles,
              assignees,
              priority,
              estimate,
              revision: 0,
              createdAt: occurredAt,
              updatedAt: occurredAt,
            })
            .run();
          const workItemId = Number(insertResult.lastInsertRowid);
          const inserted = readWorkItemOrThrow(tx, { repositoryId, workItemId });
          const insertedSnapshot = toWorkItemSnapshotWithPolicy(tx, {
            repositoryId,
            row: inserted,
          });

          insertEvent(tx, {
            repositoryId,
            workItemId,
            eventType: 'created',
            actorType: actor.actorType,
            actorLabel: actor.actorLabel,
            occurredAt,
            payload: {
              type,
              status,
              title,
              parentId,
              tags,
              plannedFiles,
              assignees,
              priority,
              estimate,
              revision: 0,
              effectivePolicy: insertedSnapshot.effectivePolicy ?? null,
            },
          });

          return {
            workItem: insertedSnapshot,
          };
        }),
      );
    },

    updateWorkItemFields(requestRaw): Promise<DashboardUpdateWorkItemFieldsResult> {
      const repositoryId = requireRepositoryId(requestRaw.repositoryId);
      const workItemId = requireWorkItemId(requestRaw.workItemId);
      const expectedRevision = requireExpectedRevision(requestRaw.expectedRevision);
      const actor = requireActor(requestRaw);

      const title = requestRaw.title !== undefined ? requestRaw.title.trim() : undefined;
      if (title !== undefined && title.length === 0) {
        throw new DashboardIntegrationError('invalid_request', 'title cannot be empty when provided.', { status: 400 });
      }

      const description = requestRaw.description !== undefined ? toOptionalNonEmptyTrimmedString(requestRaw.description) : undefined;
      const tags = requestRaw.tags !== undefined ? requestRaw.tags : undefined;
      const plannedFilesRaw = requestRaw.plannedFiles !== undefined ? requestRaw.plannedFiles : undefined;
      const assignees = requestRaw.assignees !== undefined ? requestRaw.assignees : undefined;
      const priority = requestRaw.priority !== undefined ? requestRaw.priority : undefined;
      const estimate = requestRaw.estimate !== undefined ? requestRaw.estimate : undefined;

      if (tags !== undefined && tags !== null && toStringArrayOrNull(tags) === null) {
        throw new DashboardIntegrationError('invalid_request', 'tags must be an array of strings when provided.', {
          status: 400,
        });
      }
      const plannedFiles =
        plannedFilesRaw === undefined || plannedFilesRaw === null
          ? plannedFilesRaw
          : toRepoRelativePathArrayOrNull(plannedFilesRaw);
      if (plannedFilesRaw !== undefined && plannedFilesRaw !== null && plannedFiles === null) {
        throw new DashboardIntegrationError(
          'invalid_request',
          'plannedFiles must be an array of repo-relative file paths when provided.',
          {
            status: 400,
          },
        );
      }
      if (assignees !== undefined && assignees !== null && toStringArrayOrNull(assignees) === null) {
        throw new DashboardIntegrationError('invalid_request', 'assignees must be an array of strings when provided.', {
          status: 400,
        });
      }

      const hasUpdate =
        title !== undefined ||
        description !== undefined ||
        tags !== undefined ||
        plannedFiles !== undefined ||
        assignees !== undefined ||
        priority !== undefined ||
        estimate !== undefined;
      if (!hasUpdate) {
        throw new DashboardIntegrationError('invalid_request', 'No updatable fields were provided.', { status: 400 });
      }

      const occurredAt = new Date().toISOString();

      return withDatabase(db =>
        db.transaction(tx => {
          const existing = readWorkItemOrThrow(tx, { repositoryId, workItemId });
          if (existing.revision !== expectedRevision) {
            throwRevisionConflict({ workItemId, expectedRevision });
          }

          const nextRevision = expectedRevision + 1;
          const updateValues: Partial<typeof workItems.$inferInsert> = {
            updatedAt: occurredAt,
            revision: nextRevision,
          };
          if (title !== undefined) updateValues.title = title;
          if (description !== undefined) updateValues.description = description;
          if (tags !== undefined) updateValues.tags = tags;
          if (plannedFiles !== undefined) updateValues.plannedFiles = plannedFiles;
          if (assignees !== undefined) updateValues.assignees = assignees;
          if (priority !== undefined) updateValues.priority = priority;
          if (estimate !== undefined) updateValues.estimate = estimate;

          const updated = tx
            .update(workItems)
            .set(updateValues)
            .where(
              and(
                eq(workItems.repositoryId, repositoryId),
                eq(workItems.id, workItemId),
                eq(workItems.revision, expectedRevision),
              ),
            )
            .run();

          if (updated.changes !== 1) {
            throwRevisionConflict({ workItemId, expectedRevision });
          }

          insertEvent(tx, {
            repositoryId,
            workItemId,
            eventType: 'updated',
            actorType: actor.actorType,
            actorLabel: actor.actorLabel,
            occurredAt,
            payload: {
              expectedRevision,
              revision: nextRevision,
              changes: {
                ...(title !== undefined ? { title } : {}),
                ...(description !== undefined ? { description } : {}),
                ...(tags !== undefined ? { tags } : {}),
                ...(plannedFiles !== undefined ? { plannedFiles } : {}),
                ...(assignees !== undefined ? { assignees } : {}),
                ...(priority !== undefined ? { priority } : {}),
                ...(estimate !== undefined ? { estimate } : {}),
              },
            },
          });

          const reloaded = readWorkItemOrThrow(tx, { repositoryId, workItemId });
          return {
            workItem: toWorkItemSnapshotWithPolicy(tx, {
              repositoryId,
              row: reloaded,
            }),
          };
        }),
      );
    },

    moveWorkItemStatus(requestRaw): Promise<DashboardMoveWorkItemStatusResult> {
      const { repositoryId, workItemId, expectedRevision, toStatus, linkedWorkflowRunId, actor } =
        parseMoveWorkItemStatusRequest(requestRaw);

      const occurredAt = new Date().toISOString();

      return withDatabase(db =>
        db.transaction(tx => {
          const existing = readWorkItemOrThrow(tx, { repositoryId, workItemId });
          if (existing.revision !== expectedRevision) {
            throwRevisionConflict({ workItemId, expectedRevision });
          }

          const type = existing.type as WorkItemType;
          const fromStatus = existing.status;
          try {
            validateTransition({ type, from: fromStatus, to: toStatus });
          } catch (error) {
            throw toTransitionConflictError(error);
          }

          if (
            linkedWorkflowRunId !== null
            && (type !== 'task' || fromStatus !== 'Ready' || toStatus !== 'InProgress')
          ) {
            throw new DashboardIntegrationError(
              'invalid_request',
              'linkedWorkflowRunId can only be set for task Ready -> InProgress transitions.',
              { status: 400 },
            );
          }

          const nextRevision = expectedRevision + 1;
          const updated = tx
            .update(workItems)
            .set({ status: toStatus, updatedAt: occurredAt, revision: nextRevision })
            .where(
              and(
                eq(workItems.repositoryId, repositoryId),
                eq(workItems.id, workItemId),
                eq(workItems.revision, expectedRevision),
              ),
            )
            .run();

          if (updated.changes !== 1) {
            throwRevisionConflict({ workItemId, expectedRevision });
          }

          if (linkedWorkflowRunId !== null) {
            const linkedRun = tx
              .select({
                id: workflowRuns.id,
                status: workflowRuns.status,
              })
              .from(workflowRuns)
              .where(eq(workflowRuns.id, linkedWorkflowRunId))
              .get();

            if (!linkedRun) {
              throw new DashboardIntegrationError(
                'not_found',
                `Workflow run id=${linkedWorkflowRunId} was not found for task linking.`,
                { status: 404 },
              );
            }

            tx.insert(workItemWorkflowRuns)
              .values({
                repositoryId,
                workItemId,
                workflowRunId: linkedRun.id,
                linkedAt: occurredAt,
              })
              .onConflictDoNothing()
              .run();
          }

          const reloaded = readWorkItemOrThrow(tx, { repositoryId, workItemId });
          const reloadedSnapshot = toWorkItemSnapshotWithPolicy(tx, {
            repositoryId,
            row: reloaded,
          });

          insertEvent(tx, {
            repositoryId,
            workItemId,
            eventType: 'status_changed',
            actorType: actor.actorType,
            actorLabel: actor.actorLabel,
            occurredAt,
            payload: {
              type,
              fromStatus,
              toStatus,
              expectedRevision,
              revision: nextRevision,
              linkedWorkflowRun: reloadedSnapshot.linkedWorkflowRun ?? null,
            },
          });

          return {
            workItem: reloadedSnapshot,
          };
        }),
      );
    },

    requestWorkItemReplan(requestRaw): Promise<DashboardRequestWorkItemReplanResult> {
      const repositoryId = requireRepositoryId(requestRaw.repositoryId);
      const workItemId = requireWorkItemId(requestRaw.workItemId);
      const actor = requireActor(requestRaw);
      const occurredAt = new Date().toISOString();

      return withDatabase(async db => {
        const targetWorkItem = readWorkItemOrThrow(db, { repositoryId, workItemId });
        if (targetWorkItem.type !== 'task') {
          throw new DashboardIntegrationError('invalid_request', `Work item id=${workItemId} is not a task.`, {
            status: 400,
          });
        }

        const latestLinkedRuns = loadLatestLinkedWorkflowRunsForTasks(db, {
          repositoryId,
          taskWorkItemIds: [workItemId],
          includeTouchedFiles: false,
        });
        const initialLinkedRun = latestLinkedRuns.get(workItemId) ?? null;
        if (initialLinkedRun === null) {
          throw new DashboardIntegrationError(
            'conflict',
            `Task id=${workItemId} is not linked to a workflow run. Replanning requires linked run context.`,
            {
              status: 409,
              details: {
                kind: 'work_item_replan',
                reason: 'missing_linked_run',
                workItemId,
              },
            },
          );
        }

        const touchedFilesByRunId = await loadTouchedFilesByWorkflowRunIdAsync(db, {
          repositoryId,
          workflowRunIds: [initialLinkedRun.workflowRunId],
        });
        const touchedFiles = touchedFilesByRunId.get(initialLinkedRun.workflowRunId) ?? null;
        if (touchedFiles === null) {
          throw new DashboardIntegrationError(
            'conflict',
            `Task id=${workItemId} touched files are unavailable because the linked run worktree is unavailable.`,
            {
              status: 409,
              details: {
                kind: 'work_item_replan',
                reason: 'missing_touched_files',
                workItemId,
                workflowRunId: initialLinkedRun.workflowRunId,
              },
            },
          );
        }

        return db.transaction(tx => {
          const existing = readWorkItemOrThrow(tx, { repositoryId, workItemId });
          if (existing.type !== 'task') {
            throw new DashboardIntegrationError('invalid_request', `Work item id=${workItemId} is not a task.`, {
              status: 400,
            });
          }

          const latestLinkedRun = loadLatestLinkedWorkflowRunsForTasks(tx, {
            repositoryId,
            taskWorkItemIds: [workItemId],
            includeTouchedFiles: false,
          }).get(workItemId);

          if (!latestLinkedRun) {
            throw new DashboardIntegrationError(
              'conflict',
              `Task id=${workItemId} is not linked to a workflow run. Replanning requires linked run context.`,
              {
                status: 409,
                details: {
                  kind: 'work_item_replan',
                  reason: 'missing_linked_run',
                  workItemId,
                },
              },
            );
          }

          if (latestLinkedRun.workflowRunId !== initialLinkedRun.workflowRunId) {
            throw new DashboardIntegrationError(
              'conflict',
              `Task id=${workItemId} linked workflow run changed while preparing replan. Please retry.`,
              {
                status: 409,
                details: {
                  kind: 'work_item_replan',
                  reason: 'linked_run_changed',
                  workItemId,
                  expectedWorkflowRunId: initialLinkedRun.workflowRunId,
                  actualWorkflowRunId: latestLinkedRun.workflowRunId,
                },
              },
            );
          }

          const plannedFiles =
            toRepoRelativePathArrayOrNull(existing.plannedFiles) ?? toStringArrayOrNull(existing.plannedFiles) ?? [];
          const delta = resolvePlanVsActualDelta(plannedFiles, touchedFiles);

          const eventResult = tx
            .insert(workItemEvents)
            .values({
              repositoryId,
              workItemId,
              eventType: 'updated',
              actorType: actor.actorType,
              actorLabel: actor.actorLabel,
              payload: {
                expectedRevision: existing.revision,
                revision: existing.revision,
                changes: {},
                replanRequest: {
                  requestedAt: occurredAt,
                  workflowRunId: latestLinkedRun.workflowRunId,
                  plannedFiles,
                  touchedFiles,
                  plannedButUntouched: delta.plannedButUntouched,
                  touchedButUnplanned: delta.touchedButUnplanned,
                },
              },
              createdAt: occurredAt,
            })
            .run();
          const eventId = Number(eventResult.lastInsertRowid);

          return {
            repositoryId,
            workItemId,
            workflowRunId: latestLinkedRun.workflowRunId,
            eventId,
            requestedAt: occurredAt,
            plannedButUntouched: delta.plannedButUntouched,
            touchedButUnplanned: delta.touchedButUnplanned,
          };
        });
      });
    },

    setWorkItemParent(requestRaw): Promise<DashboardSetWorkItemParentResult> {
      const repositoryId = requireRepositoryId(requestRaw.repositoryId);
      const workItemId = requireWorkItemId(requestRaw.workItemId);
      const expectedRevision = requireExpectedRevision(requestRaw.expectedRevision);
      const actor = requireActor(requestRaw);

      const parentId = requestRaw.parentId === null ? null : requireWorkItemId(requestRaw.parentId, 'parentId');
      const occurredAt = new Date().toISOString();

      return withDatabase(db =>
        db.transaction(tx => {
          const existing = readWorkItemOrThrow(tx, { repositoryId, workItemId });
          if (existing.revision !== expectedRevision) {
            throwRevisionConflict({ workItemId, expectedRevision });
          }

          let parent: WorkItemRow | null = null;
          if (parentId !== null) {
            parent = readWorkItemOrThrow(tx, {
              repositoryId,
              workItemId: parentId,
              notFoundMessage: `Parent work item id=${parentId} was not found.`,
            });
            try {
              validateParentChildWorkItemTypes(parent.type as WorkItemType, existing.type as WorkItemType);
            } catch (error) {
              throw toHierarchyConflictError(error);
            }
          }

          const nextRevision = expectedRevision + 1;
          const updated = tx
            .update(workItems)
            .set({
              parentId,
              updatedAt: occurredAt,
              revision: nextRevision,
            })
            .where(
              and(
                eq(workItems.repositoryId, repositoryId),
                eq(workItems.id, workItemId),
                eq(workItems.revision, expectedRevision),
              ),
            )
            .run();

          if (updated.changes !== 1) {
            throwRevisionConflict({ workItemId, expectedRevision });
          }

          const reloaded = readWorkItemOrThrow(tx, { repositoryId, workItemId });
          const reloadedSnapshot = toWorkItemSnapshotWithPolicy(tx, {
            repositoryId,
            row: reloaded,
          });

          insertEvent(tx, {
            repositoryId,
            workItemId,
            eventType: 'reparented',
            actorType: actor.actorType,
            actorLabel: actor.actorLabel,
            occurredAt,
            payload: {
              fromParentId: existing.parentId,
              toParentId: parentId,
              parentType: parent?.type ?? null,
              childType: existing.type,
              expectedRevision,
              revision: nextRevision,
              effectivePolicy: reloadedSnapshot.effectivePolicy ?? null,
            },
          });

          if (reloaded.type !== 'task') {
            const workItemIdentityById = loadWorkItemIdentityMap(tx, repositoryId);
            const shouldEmitDescendantReparentEvents = didAncestorReparentChangeDescendantPolicyContext({
              existing,
              reloaded,
              workItemIdentityById,
            });
            if (shouldEmitDescendantReparentEvents) {
              const descendantTasks = readDescendantTasks(tx, {
                repositoryId,
                ancestorWorkItemId: reloaded.id,
              });
              if (descendantTasks.length > 0) {
                const descendantSnapshots = toWorkItemSnapshotsWithPolicies(tx, {
                  repositoryId,
                  rows: descendantTasks,
                });
                const descendantSnapshotById = new Map(descendantSnapshots.map(snapshot => [snapshot.id, snapshot]));

                for (const descendantTask of descendantTasks) {
                  const descendantSnapshot = descendantSnapshotById.get(descendantTask.id);
                  if (!descendantSnapshot) {
                    throw new DashboardIntegrationError(
                      'internal_error',
                      `Task id=${descendantTask.id} could not be reloaded after ancestor reparent.`,
                      { status: 500 },
                    );
                  }

                  insertEvent(tx, {
                    repositoryId,
                    workItemId: descendantTask.id,
                    eventType: 'reparented',
                    actorType: actor.actorType,
                    actorLabel: actor.actorLabel,
                    occurredAt,
                    payload: {
                      fromParentId: descendantTask.parentId,
                      toParentId: descendantTask.parentId,
                      parentType: null,
                      childType: descendantTask.type,
                      expectedRevision: descendantTask.revision,
                      revision: descendantTask.revision,
                      effectivePolicy: descendantSnapshot.effectivePolicy ?? null,
                      reason: 'ancestor_reparent',
                      ancestorWorkItemId: reloaded.id,
                    },
                  });
                }
              }
            }
          }

          return {
            workItem: reloadedSnapshot,
          };
        }),
      );
    },

    proposeStoryBreakdown(requestRaw): Promise<DashboardProposeStoryBreakdownResult> {
      const repositoryId = requireRepositoryId(requestRaw.repositoryId);
      const storyId = requireWorkItemId(requestRaw.storyId, 'storyId');
      const expectedRevision = requireExpectedRevision(requestRaw.expectedRevision);
      const actor = requireActor(requestRaw);

      const proposed = requestRaw.proposed;
      if (proposed.tasks.length === 0) {
        throw new DashboardIntegrationError('invalid_request', 'proposed.tasks cannot be empty.', { status: 400 });
      }

      const normalizedTasks = proposed.tasks.map((task, idx) => {
        const taskTitle = task.title.trim();
        if (taskTitle.length === 0) {
          throw new DashboardIntegrationError('invalid_request', `proposed.tasks[${idx}].title cannot be empty.`, {
            status: 400,
          });
        }
        if (task.tags !== undefined && task.tags !== null && toStringArrayOrNull(task.tags) === null) {
          throw new DashboardIntegrationError(
            'invalid_request',
            `proposed.tasks[${idx}].tags must be an array of strings when provided.`,
            { status: 400 },
          );
        }
        const normalizedPlannedFiles =
          task.plannedFiles === undefined || task.plannedFiles === null
            ? null
            : toRepoRelativePathArrayOrNull(task.plannedFiles);
        if (task.plannedFiles !== undefined && task.plannedFiles !== null && normalizedPlannedFiles === null) {
          throw new DashboardIntegrationError(
            'invalid_request',
            `proposed.tasks[${idx}].plannedFiles must be an array of repo-relative file paths when provided.`,
            { status: 400 },
          );
        }
        if (task.assignees !== undefined && task.assignees !== null && toStringArrayOrNull(task.assignees) === null) {
          throw new DashboardIntegrationError(
            'invalid_request',
            `proposed.tasks[${idx}].assignees must be an array of strings when provided.`,
            { status: 400 },
          );
        }
        if (task.links !== undefined && task.links !== null && toStringArrayOrNull(task.links) === null) {
          throw new DashboardIntegrationError(
            'invalid_request',
            `proposed.tasks[${idx}].links must be an array of strings when provided.`,
            { status: 400 },
          );
        }

        return {
          title: taskTitle,
          description: toOptionalNonEmptyTrimmedString(task.description ?? null),
          tags: task.tags ?? null,
          plannedFiles: normalizedPlannedFiles,
          assignees: task.assignees ?? null,
          priority: task.priority ?? null,
          estimate: task.estimate ?? null,
          links: task.links ?? null,
        };
      });

      if (proposed.tags !== undefined && proposed.tags !== null && toStringArrayOrNull(proposed.tags) === null) {
        throw new DashboardIntegrationError('invalid_request', 'proposed.tags must be an array of strings when provided.', {
          status: 400,
        });
      }
      const normalizedProposedPlannedFiles =
        proposed.plannedFiles === undefined || proposed.plannedFiles === null
          ? null
          : toRepoRelativePathArrayOrNull(proposed.plannedFiles);
      if (proposed.plannedFiles !== undefined && proposed.plannedFiles !== null && normalizedProposedPlannedFiles === null) {
        throw new DashboardIntegrationError(
          'invalid_request',
          'proposed.plannedFiles must be an array of repo-relative file paths when provided.',
          { status: 400 },
        );
      }
      if (proposed.links !== undefined && proposed.links !== null && toStringArrayOrNull(proposed.links) === null) {
        throw new DashboardIntegrationError('invalid_request', 'proposed.links must be an array of strings when provided.', {
          status: 400,
        });
      }

      const occurredAt = new Date().toISOString();

      return withDatabase(db =>
        db.transaction(tx => {
          const story = readWorkItemOrThrow(tx, {
            repositoryId,
            workItemId: storyId,
            notFoundMessage: `Story id=${storyId} was not found.`,
          });
          if (story.type !== 'story') {
            throw new DashboardIntegrationError('invalid_request', `Work item id=${storyId} is not a story.`, {
              status: 400,
            });
          }
          if (story.revision !== expectedRevision) {
            throwRevisionConflict({ workItemId: storyId, expectedRevision });
          }

          try {
            validateTransition({ type: 'story', from: story.status, to: 'BreakdownProposed' });
          } catch (error) {
            throw toTransitionConflictError(error);
          }

          const insertedTasks: WorkItemRow[] = [];
          const createdTaskIds: number[] = [];
          for (const task of normalizedTasks) {
            const insertResult = tx
              .insert(workItems)
              .values({
                repositoryId,
                type: 'task',
                status: 'Draft',
                title: task.title,
                description: task.description,
                parentId: storyId,
                tags: task.tags ?? null,
                plannedFiles: task.plannedFiles ?? null,
                assignees: task.assignees ?? null,
                priority: task.priority ?? null,
                estimate: task.estimate ?? null,
                revision: 0,
                createdAt: occurredAt,
                updatedAt: occurredAt,
              })
              .run();

            const insertedId = Number(insertResult.lastInsertRowid);
            const inserted = readWorkItemOrThrow(tx, { repositoryId, workItemId: insertedId });
            const insertedSnapshot = toWorkItemSnapshotWithPolicy(tx, {
              repositoryId,
              row: inserted,
            });

            insertedTasks.push(inserted);
            createdTaskIds.push(insertedId);

            insertEvent(tx, {
              repositoryId,
              workItemId: insertedId,
              eventType: 'created',
              actorType: actor.actorType,
              actorLabel: actor.actorLabel,
              occurredAt,
              payload: {
                type: 'task',
                status: 'Draft',
                title: inserted.title,
                parentId: storyId,
                tags: inserted.tags,
                plannedFiles: inserted.plannedFiles,
                assignees: inserted.assignees,
                priority: inserted.priority,
                estimate: inserted.estimate,
                revision: 0,
                links: task.links ?? null,
                effectivePolicy: insertedSnapshot.effectivePolicy ?? null,
              },
            });
          }

          const storyNextRevision = expectedRevision + 1;
          const updatedStory = tx
            .update(workItems)
            .set({
              status: 'BreakdownProposed',
              updatedAt: occurredAt,
              revision: storyNextRevision,
            })
            .where(and(eq(workItems.repositoryId, repositoryId), eq(workItems.id, storyId), eq(workItems.revision, expectedRevision)))
            .run();
          if (updatedStory.changes !== 1) {
            throwRevisionConflict({ workItemId: storyId, expectedRevision });
          }

          insertEvent(tx, {
            repositoryId,
            workItemId: storyId,
            eventType: 'breakdown_proposed',
            actorType: actor.actorType,
            actorLabel: actor.actorLabel,
            occurredAt,
            payload: {
              fromStatus: story.status,
              toStatus: 'BreakdownProposed',
              expectedRevision,
              revision: storyNextRevision,
              createdTaskIds,
              proposed: {
                tags: proposed.tags ?? null,
                plannedFiles: normalizedProposedPlannedFiles,
                links: proposed.links ?? null,
                tasks: normalizedTasks.map(task => ({
                  title: task.title,
                  description: task.description,
                  tags: task.tags ?? null,
                  plannedFiles: task.plannedFiles ?? null,
                  assignees: task.assignees ?? null,
                  priority: task.priority ?? null,
                  estimate: task.estimate ?? null,
                  links: task.links ?? null,
                })),
              },
            },
          });

          const reloadedStory = readWorkItemOrThrow(tx, { repositoryId, workItemId: storyId });
          const workItemSnapshots = toWorkItemSnapshotsWithPolicies(tx, {
            repositoryId,
            rows: [reloadedStory, ...insertedTasks],
          });
          const storySnapshot = workItemSnapshots.find(item => item.id === reloadedStory.id);
          const taskSnapshots = workItemSnapshots.filter(item => item.type === 'task' && item.parentId === storyId);
          if (!storySnapshot) {
            throw new DashboardIntegrationError('internal_error', `Story id=${storyId} could not be reloaded after breakdown proposal.`, {
              status: 500,
            });
          }
          return {
            story: storySnapshot,
            tasks: taskSnapshots,
          };
        }),
      );
    },

    approveStoryBreakdown(requestRaw): Promise<DashboardApproveStoryBreakdownResult> {
      const repositoryId = requireRepositoryId(requestRaw.repositoryId);
      const storyId = requireWorkItemId(requestRaw.storyId, 'storyId');
      const expectedRevision = requireExpectedRevision(requestRaw.expectedRevision);
      const actor = requireActor(requestRaw);

      const occurredAt = new Date().toISOString();

      return withDatabase(db =>
        db.transaction(tx => {
          const story = readWorkItemOrThrow(tx, {
            repositoryId,
            workItemId: storyId,
            notFoundMessage: `Story id=${storyId} was not found.`,
          });
          if (story.type !== 'story') {
            throw new DashboardIntegrationError('invalid_request', `Work item id=${storyId} is not a story.`, {
              status: 400,
            });
          }
          if (story.revision !== expectedRevision) {
            throwRevisionConflict({ workItemId: storyId, expectedRevision });
          }

          try {
            validateTransition({ type: 'story', from: story.status, to: 'Approved' });
          } catch (error) {
            throw toTransitionConflictError(error);
          }

          const children = tx
            .select()
            .from(workItems)
            .where(
              and(
                eq(workItems.repositoryId, repositoryId),
                eq(workItems.parentId, storyId),
                eq(workItems.type, 'task'),
              ),
            )
            .all();

          if (children.length === 0) {
            throw new DashboardIntegrationError('conflict', 'Cannot approve breakdown without child tasks.', {
              status: 409,
              details: {
                storyId,
              },
            });
          }

          const invalidChildren = children.filter(child => child.status !== 'Draft');
          if (invalidChildren.length > 0) {
            throw new DashboardIntegrationError(
              'conflict',
              'Cannot approve breakdown while child tasks are not in Draft.',
              {
                status: 409,
                details: {
                  childTaskIds: invalidChildren.map(child => child.id),
                },
              },
            );
          }

          const storyNextRevision = expectedRevision + 1;
          const storyUpdate = tx
            .update(workItems)
            .set({
              status: 'Approved',
              updatedAt: occurredAt,
              revision: storyNextRevision,
            })
            .where(and(eq(workItems.repositoryId, repositoryId), eq(workItems.id, storyId), eq(workItems.revision, expectedRevision)))
            .run();
          if (storyUpdate.changes !== 1) {
            throwRevisionConflict({ workItemId: storyId, expectedRevision });
          }

          insertEvent(tx, {
            repositoryId,
            workItemId: storyId,
            eventType: 'breakdown_approved',
            actorType: actor.actorType,
            actorLabel: actor.actorLabel,
            occurredAt,
            payload: {
              fromStatus: story.status,
              toStatus: 'Approved',
              expectedRevision,
              revision: storyNextRevision,
              childTaskIds: children.map(child => child.id),
            },
          });

          const updatedTasks: WorkItemRow[] = [];
          for (const child of children) {
            try {
              validateTransition({ type: 'task', from: child.status, to: 'Ready' });
            } catch (error) {
              throw toTransitionConflictError(error);
            }

            const childNextRevision = child.revision + 1;
            const updated = tx
              .update(workItems)
              .set({
                status: 'Ready',
                updatedAt: occurredAt,
                revision: childNextRevision,
              })
              .where(
                and(
                  eq(workItems.repositoryId, repositoryId),
                  eq(workItems.id, child.id),
                  eq(workItems.revision, child.revision),
                ),
              )
              .run();
            if (updated.changes !== 1) {
              throw new DashboardIntegrationError(
                'conflict',
                `Work item id=${child.id} revision conflict while approving breakdown.`,
                {
                  status: 409,
                  details: {
                    workItemId: child.id,
                    expectedRevision: child.revision,
                  },
                },
              );
            }

            insertEvent(tx, {
              repositoryId,
              workItemId: child.id,
              eventType: 'status_changed',
              actorType: actor.actorType,
              actorLabel: actor.actorLabel,
              occurredAt,
              payload: {
                type: 'task',
                fromStatus: child.status,
                toStatus: 'Ready',
                expectedRevision: child.revision,
                revision: childNextRevision,
                approvedStoryId: storyId,
              },
            });

            const reloaded = readWorkItemOrThrow(tx, { repositoryId, workItemId: child.id });
            updatedTasks.push(reloaded);
          }

          const reloadedStory = readWorkItemOrThrow(tx, { repositoryId, workItemId: storyId });
          const workItemSnapshots = toWorkItemSnapshotsWithPolicies(tx, {
            repositoryId,
            rows: [reloadedStory, ...updatedTasks],
          });
          const storySnapshot = workItemSnapshots.find(item => item.id === reloadedStory.id);
          const taskSnapshots = workItemSnapshots.filter(item => item.type === 'task' && item.parentId === storyId);
          if (!storySnapshot) {
            throw new DashboardIntegrationError('internal_error', `Story id=${storyId} could not be reloaded after breakdown approval.`, {
              status: 500,
            });
          }
          return {
            story: storySnapshot,
            tasks: taskSnapshots,
          };
        }),
      );
    },
  };
}
