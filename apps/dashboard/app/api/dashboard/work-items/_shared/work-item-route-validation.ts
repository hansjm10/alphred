import type { WorkItemActorType } from '@alphred/db';
import { workItemStatusesByType, workItemTypes, type WorkItemStatus, type WorkItemType } from '@alphred/shared';
import type {
  DashboardApproveStoryBreakdownRequest,
  DashboardCreateWorkItemRequest,
  DashboardMoveWorkItemStatusRequest,
  DashboardProposeStoryBreakdownRequest,
  DashboardUpdateWorkItemFieldsRequest,
  DashboardWorkItemProposedBreakdownTask,
} from '../../../../../src/server/dashboard-contracts';
import { DashboardIntegrationError } from '../../../../../src/server/dashboard-errors';

const workItemTypeValues = new Set<WorkItemType>(workItemTypes);
const workItemActorTypeValues = new Set<WorkItemActorType>(['human', 'agent', 'system']);
const workItemStatusValues = new Set<WorkItemStatus>(
  Object.values(workItemStatusesByType).flat() as WorkItemStatus[],
);

function invalidRequest(message: string): DashboardIntegrationError {
  return new DashboardIntegrationError('invalid_request', message, {
    status: 400,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parsePositiveInteger(value: unknown, message: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw invalidRequest(message);
  }

  return value;
}

function parsePositiveIntegerFromString(value: string, message: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw invalidRequest(message);
  }

  return parsed;
}

function parseNonNegativeInteger(value: unknown, message: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw invalidRequest(message);
  }

  return value;
}

function parseString(value: unknown, message: string): string {
  if (typeof value !== 'string') {
    throw invalidRequest(message);
  }

  return value;
}

function parseActorType(value: unknown): WorkItemActorType {
  if (typeof value !== 'string' || !workItemActorTypeValues.has(value as WorkItemActorType)) {
    throw invalidRequest('Field "actorType" must be one of: human, agent, system.');
  }

  return value as WorkItemActorType;
}

function parseActorLabel(value: unknown): string {
  return parseString(value, 'Field "actorLabel" must be a string.');
}

function parseWorkItemType(value: unknown): WorkItemType {
  if (typeof value !== 'string' || !workItemTypeValues.has(value as WorkItemType)) {
    throw invalidRequest('Field "type" must be one of: epic, feature, story, task.');
  }

  return value as WorkItemType;
}

function parseWorkItemStatus(value: unknown, fieldName = 'status'): WorkItemStatus {
  if (typeof value !== 'string' || !workItemStatusValues.has(value as WorkItemStatus)) {
    throw invalidRequest(`Field "${fieldName}" must be a valid work-item status string.`);
  }

  return value as WorkItemStatus;
}

function parseOptionalStringOrNull(value: unknown, message: string): string | null {
  if (value === null) {
    return null;
  }

  return parseString(value, message);
}

function parseOptionalStringArrayOrNull(value: unknown, message: string): string[] | null {
  if (value === null) {
    return null;
  }

  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) {
    throw invalidRequest(message);
  }

  return value;
}

function parseOptionalNumberOrNull(value: unknown, message: string): number | null {
  if (value === null) {
    return null;
  }

  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw invalidRequest(message);
  }

  return value;
}

function parseOptionalPositiveIntegerOrNull(value: unknown, message: string): number | null {
  if (value === null) {
    return null;
  }

  return parsePositiveInteger(value, message);
}

function requireRecord(payload: unknown, message: string): Record<string, unknown> {
  if (!isRecord(payload)) {
    throw invalidRequest(message);
  }

  return payload;
}

export async function parseJsonObjectBody(
  request: Request,
  options: {
    invalidJsonMessage: string;
    objectMessage: string;
  },
): Promise<Record<string, unknown>> {
  const rawBody = await request.text();
  if (rawBody.trim().length === 0) {
    throw invalidRequest(options.objectMessage);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody) as unknown;
  } catch (error) {
    throw new DashboardIntegrationError('invalid_request', options.invalidJsonMessage, {
      status: 400,
      cause: error,
    });
  }

  return requireRecord(payload, options.objectMessage);
}

export function parseRepositoryIdFromPathSegment(value: string): number {
  return parsePositiveIntegerFromString(value, 'repositoryId must be a positive integer.');
}

export function parseWorkItemIdFromPathSegment(value: string): number {
  return parsePositiveIntegerFromString(value, 'workItemId must be a positive integer.');
}

export function parseRepositoryIdFromQuery(request: Request): number {
  const url = new URL(request.url);
  const rawValue = url.searchParams.get('repositoryId');
  if (rawValue === null) {
    throw invalidRequest('Query parameter "repositoryId" must be a positive integer.');
  }

  return parsePositiveIntegerFromString(rawValue, 'Query parameter "repositoryId" must be a positive integer.');
}

export function parseCreateWorkItemRequest(
  payload: Record<string, unknown>,
  repositoryId: number,
): DashboardCreateWorkItemRequest {
  const type = parseWorkItemType(payload.type);
  const title = parseString(payload.title, 'Field "title" must be a string.');
  const actorType = parseActorType(payload.actorType);
  const actorLabel = parseActorLabel(payload.actorLabel);

  const request: DashboardCreateWorkItemRequest = {
    repositoryId,
    type,
    title,
    actorType,
    actorLabel,
  };

  if ('status' in payload) {
    request.status = parseWorkItemStatus(payload.status);
  }

  if ('description' in payload) {
    request.description = parseOptionalStringOrNull(payload.description, 'Field "description" must be a string or null.');
  }

  if ('parentId' in payload) {
    request.parentId = parseOptionalPositiveIntegerOrNull(payload.parentId, 'Field "parentId" must be a positive integer or null.');
  }

  if ('tags' in payload) {
    request.tags = parseOptionalStringArrayOrNull(payload.tags, 'Field "tags" must be an array of strings or null.');
  }

  if ('plannedFiles' in payload) {
    request.plannedFiles = parseOptionalStringArrayOrNull(
      payload.plannedFiles,
      'Field "plannedFiles" must be an array of strings or null.',
    );
  }

  if ('assignees' in payload) {
    request.assignees = parseOptionalStringArrayOrNull(
      payload.assignees,
      'Field "assignees" must be an array of strings or null.',
    );
  }

  if ('priority' in payload) {
    request.priority = parseOptionalNumberOrNull(payload.priority, 'Field "priority" must be a number or null.');
  }

  if ('estimate' in payload) {
    request.estimate = parseOptionalNumberOrNull(payload.estimate, 'Field "estimate" must be a number or null.');
  }

  return request;
}

export function parseUpdateWorkItemFieldsRequest(
  payload: Record<string, unknown>,
  workItemId: number,
): DashboardUpdateWorkItemFieldsRequest {
  const repositoryId = parsePositiveInteger(payload.repositoryId, 'Field "repositoryId" must be a positive integer.');
  const expectedRevision = parseNonNegativeInteger(
    payload.expectedRevision,
    'Field "expectedRevision" must be a non-negative integer.',
  );
  const actorType = parseActorType(payload.actorType);
  const actorLabel = parseActorLabel(payload.actorLabel);

  const request: DashboardUpdateWorkItemFieldsRequest = {
    repositoryId,
    workItemId,
    expectedRevision,
    actorType,
    actorLabel,
  };

  let hasUpdate = false;

  if ('title' in payload) {
    request.title = parseString(payload.title, 'Field "title" must be a string when provided.');
    hasUpdate = true;
  }

  if ('description' in payload) {
    request.description = parseOptionalStringOrNull(payload.description, 'Field "description" must be a string or null.');
    hasUpdate = true;
  }

  if ('tags' in payload) {
    request.tags = parseOptionalStringArrayOrNull(payload.tags, 'Field "tags" must be an array of strings or null.');
    hasUpdate = true;
  }

  if ('plannedFiles' in payload) {
    request.plannedFiles = parseOptionalStringArrayOrNull(
      payload.plannedFiles,
      'Field "plannedFiles" must be an array of strings or null.',
    );
    hasUpdate = true;
  }

  if ('assignees' in payload) {
    request.assignees = parseOptionalStringArrayOrNull(
      payload.assignees,
      'Field "assignees" must be an array of strings or null.',
    );
    hasUpdate = true;
  }

  if ('priority' in payload) {
    request.priority = parseOptionalNumberOrNull(payload.priority, 'Field "priority" must be a number or null.');
    hasUpdate = true;
  }

  if ('estimate' in payload) {
    request.estimate = parseOptionalNumberOrNull(payload.estimate, 'Field "estimate" must be a number or null.');
    hasUpdate = true;
  }

  if (!hasUpdate) {
    throw invalidRequest('Work item update requires at least one updatable field.');
  }

  return request;
}

export function parseMoveWorkItemStatusRequest(
  payload: Record<string, unknown>,
  workItemId: number,
): DashboardMoveWorkItemStatusRequest {
  const repositoryId = parsePositiveInteger(payload.repositoryId, 'Field "repositoryId" must be a positive integer.');
  const expectedRevision = parseNonNegativeInteger(
    payload.expectedRevision,
    'Field "expectedRevision" must be a non-negative integer.',
  );
  const toStatus = parseWorkItemStatus(payload.toStatus, 'toStatus');
  const actorType = parseActorType(payload.actorType);
  const actorLabel = parseActorLabel(payload.actorLabel);

  return {
    repositoryId,
    workItemId,
    expectedRevision,
    toStatus,
    actorType,
    actorLabel,
  };
}

function parseBreakdownTask(rawTask: unknown, index: number): DashboardWorkItemProposedBreakdownTask {
  const task = requireRecord(rawTask, `Field "proposed.tasks[${index}]" must be an object.`);
  const title = parseString(task.title, `Field "proposed.tasks[${index}].title" must be a string.`);

  const parsedTask: DashboardWorkItemProposedBreakdownTask = {
    title,
  };

  if ('description' in task) {
    parsedTask.description = parseOptionalStringOrNull(
      task.description,
      `Field "proposed.tasks[${index}].description" must be a string or null.`,
    );
  }

  if ('tags' in task) {
    parsedTask.tags = parseOptionalStringArrayOrNull(
      task.tags,
      `Field "proposed.tasks[${index}].tags" must be an array of strings or null.`,
    );
  }

  if ('plannedFiles' in task) {
    parsedTask.plannedFiles = parseOptionalStringArrayOrNull(
      task.plannedFiles,
      `Field "proposed.tasks[${index}].plannedFiles" must be an array of strings or null.`,
    );
  }

  if ('assignees' in task) {
    parsedTask.assignees = parseOptionalStringArrayOrNull(
      task.assignees,
      `Field "proposed.tasks[${index}].assignees" must be an array of strings or null.`,
    );
  }

  if ('priority' in task) {
    parsedTask.priority = parseOptionalNumberOrNull(
      task.priority,
      `Field "proposed.tasks[${index}].priority" must be a number or null.`,
    );
  }

  if ('estimate' in task) {
    parsedTask.estimate = parseOptionalNumberOrNull(
      task.estimate,
      `Field "proposed.tasks[${index}].estimate" must be a number or null.`,
    );
  }

  if ('links' in task) {
    parsedTask.links = parseOptionalStringArrayOrNull(
      task.links,
      `Field "proposed.tasks[${index}].links" must be an array of strings or null.`,
    );
  }

  return parsedTask;
}

export function parseProposeStoryBreakdownRequest(
  payload: Record<string, unknown>,
  storyId: number,
): DashboardProposeStoryBreakdownRequest {
  const repositoryId = parsePositiveInteger(payload.repositoryId, 'Field "repositoryId" must be a positive integer.');
  const expectedRevision = parseNonNegativeInteger(
    payload.expectedRevision,
    'Field "expectedRevision" must be a non-negative integer.',
  );
  const actorType = parseActorType(payload.actorType);
  const actorLabel = parseActorLabel(payload.actorLabel);

  const proposed = requireRecord(payload.proposed, 'Field "proposed" must be an object.');
  if (!Array.isArray(proposed.tasks)) {
    throw invalidRequest('Field "proposed.tasks" must be an array.');
  }

  const tasks = proposed.tasks.map((task, index) => parseBreakdownTask(task, index));
  if (tasks.length === 0) {
    throw invalidRequest('proposed.tasks cannot be empty.');
  }

  const request: DashboardProposeStoryBreakdownRequest = {
    repositoryId,
    storyId,
    expectedRevision,
    actorType,
    actorLabel,
    proposed: {
      tasks,
    },
  };

  if ('tags' in proposed) {
    request.proposed.tags = parseOptionalStringArrayOrNull(
      proposed.tags,
      'Field "proposed.tags" must be an array of strings or null.',
    );
  }

  if ('plannedFiles' in proposed) {
    request.proposed.plannedFiles = parseOptionalStringArrayOrNull(
      proposed.plannedFiles,
      'Field "proposed.plannedFiles" must be an array of strings or null.',
    );
  }

  if ('links' in proposed) {
    request.proposed.links = parseOptionalStringArrayOrNull(
      proposed.links,
      'Field "proposed.links" must be an array of strings or null.',
    );
  }

  return request;
}

export function parseApproveStoryBreakdownRequest(
  payload: Record<string, unknown>,
  storyId: number,
): DashboardApproveStoryBreakdownRequest {
  const repositoryId = parsePositiveInteger(payload.repositoryId, 'Field "repositoryId" must be a positive integer.');
  const expectedRevision = parseNonNegativeInteger(
    payload.expectedRevision,
    'Field "expectedRevision" must be a non-negative integer.',
  );
  const actorType = parseActorType(payload.actorType);
  const actorLabel = parseActorLabel(payload.actorLabel);

  return {
    repositoryId,
    storyId,
    expectedRevision,
    actorType,
    actorLabel,
  };
}
