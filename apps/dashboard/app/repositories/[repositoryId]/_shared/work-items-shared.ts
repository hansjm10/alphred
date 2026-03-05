'use client';

import type { WorkItemStatus, WorkItemType } from '@alphred/shared';
import type {
  DashboardWorkItemEffectivePolicySnapshot,
  DashboardWorkItemLinkedRunSnapshot,
  DashboardRequestWorkItemReplanResult,
  DashboardWorkItemSnapshot,
} from '@dashboard/server/dashboard-contracts';

export type WorkItemActor = Readonly<{
  actorType: 'human' | 'agent' | 'system';
  actorLabel: string;
}>;

export type BoardEventSnapshot = Readonly<{
  id: number;
  repositoryId: number;
  workItemId: number;
  eventType: string;
  payload: unknown;
  createdAt: string;
}>;

export type BoardConnectionState = 'connecting' | 'live' | 'reconnecting' | 'stale';

type ApiErrorEnvelope = Readonly<{
  error?: {
    code?: string;
    message?: string;
  };
}>;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function parseJsonSafely(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

export function resolveApiErrorMessage(status: number, payload: unknown, fallbackPrefix: string): string {
  if (
    isRecord(payload) &&
    'error' in payload &&
    isRecord((payload as ApiErrorEnvelope).error) &&
    typeof (payload as ApiErrorEnvelope).error?.message === 'string'
  ) {
    return (payload as ApiErrorEnvelope).error?.message as string;
  }

  return `${fallbackPrefix} (HTTP ${status}).`;
}

export function toWorkItemsById(
  workItems: readonly DashboardWorkItemSnapshot[],
): Readonly<Record<number, DashboardWorkItemSnapshot>> {
  const entries: Record<number, DashboardWorkItemSnapshot> = {};
  for (const item of workItems) {
    entries[item.id] = item;
  }
  return entries;
}

export function buildParentChain(
  workItem: DashboardWorkItemSnapshot,
  workItemsById: Readonly<Record<number, DashboardWorkItemSnapshot>>,
): DashboardWorkItemSnapshot[] {
  const chain: DashboardWorkItemSnapshot[] = [];
  const visited = new Set<number>();
  let parentId = workItem.parentId;
  while (parentId !== null) {
    if (visited.has(parentId)) {
      break;
    }
    visited.add(parentId);
    const parent = workItemsById[parentId];
    if (!parent) {
      break;
    }
    chain.push(parent);
    parentId = parent.parentId;
  }
  return chain.reverse();
}

export function coerceNullableString(value: unknown, fallback: string | null): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value === 'string') {
    return value;
  }
  return fallback;
}

export function coerceNullableStringArray(value: unknown, fallback: string[] | null): string[] | null {
  if (value === null) {
    return null;
  }
  if (Array.isArray(value)) {
    return value as string[];
  }
  return fallback;
}

export function coerceNullableNumber(value: unknown, fallback: number | null): number | null {
  if (value === null) {
    return null;
  }
  if (typeof value === 'number') {
    return value;
  }
  return fallback;
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || typeof value === 'number';
}

function isNullableStringArray(value: unknown): value is string[] | null {
  return value === null || (Array.isArray(value) && value.every((entry) => typeof entry === 'string'));
}

function isLinkedWorkflowRunSnapshot(value: unknown): value is DashboardWorkItemLinkedRunSnapshot {
  if (!isRecord(value)) {
    return false;
  }

  const runStatus = value.runStatus;
  const validRunStatus =
    runStatus === 'pending'
    || runStatus === 'running'
    || runStatus === 'paused'
    || runStatus === 'completed'
    || runStatus === 'failed'
    || runStatus === 'cancelled';

  if (
    'touchedFiles' in value
    && value.touchedFiles !== undefined
    && value.touchedFiles !== null
    && (!Array.isArray(value.touchedFiles) || value.touchedFiles.some((entry) => typeof entry !== 'string'))
  ) {
    return false;
  }

  return typeof value.workflowRunId === 'number' && validRunStatus && typeof value.linkedAt === 'string';
}

function coerceLinkedWorkflowRun(
  value: unknown,
  fallback: DashboardWorkItemLinkedRunSnapshot | null | undefined,
): DashboardWorkItemLinkedRunSnapshot | null {
  if (value === null) {
    return null;
  }

  if (isLinkedWorkflowRunSnapshot(value)) {
    return value;
  }

  return fallback ?? null;
}

function mergeLinkedWorkflowRun(
  nextLinkedWorkflowRun: DashboardWorkItemLinkedRunSnapshot | null,
  previousLinkedWorkflowRun: DashboardWorkItemLinkedRunSnapshot | null | undefined,
): DashboardWorkItemLinkedRunSnapshot | null {
  if (nextLinkedWorkflowRun === null) {
    return null;
  }

  if (!previousLinkedWorkflowRun) {
    return nextLinkedWorkflowRun;
  }

  return nextLinkedWorkflowRun;
}

function isEffectivePolicySnapshot(value: unknown): value is DashboardWorkItemEffectivePolicySnapshot {
  if (!isRecord(value)) {
    return false;
  }

  if (value.appliesToType !== 'epic' && value.appliesToType !== 'task') {
    return false;
  }

  if (!isNullableNumber(value.epicWorkItemId) || !isNullableNumber(value.repositoryPolicyId) || !isNullableNumber(value.epicPolicyId)) {
    return false;
  }

  if (!isRecord(value.policy)) {
    return false;
  }

  const { policy } = value;
  if (
    !isNullableStringArray(policy.allowedProviders) ||
    !isNullableStringArray(policy.allowedModels) ||
    !isNullableStringArray(policy.allowedSkillIdentifiers) ||
    !isNullableStringArray(policy.allowedMcpServerIdentifiers)
  ) {
    return false;
  }

  if (!isRecord(policy.budgets) || !isNullableNumber(policy.budgets.maxConcurrentTasks) || !isNullableNumber(policy.budgets.maxConcurrentRuns)) {
    return false;
  }

  if (!isRecord(policy.requiredGates) || typeof policy.requiredGates.breakdownApprovalRequired !== 'boolean') {
    return false;
  }

  return true;
}

function coerceEffectivePolicy(
  value: unknown,
  fallback: DashboardWorkItemEffectivePolicySnapshot | null | undefined,
): DashboardWorkItemEffectivePolicySnapshot | null {
  if (value === null) {
    return null;
  }
  if (isEffectivePolicySnapshot(value)) {
    return value;
  }
  return fallback ?? null;
}

function applyCreatedBoardEvent(
  previous: Readonly<Record<number, DashboardWorkItemSnapshot>>,
  event: BoardEventSnapshot,
  existing: DashboardWorkItemSnapshot | undefined,
): Readonly<Record<number, DashboardWorkItemSnapshot>> {
  const payload = event.payload;
  if (!isRecord(payload) || typeof payload.type !== 'string' || typeof payload.status !== 'string' || typeof payload.title !== 'string') {
    return previous;
  }

  const next: DashboardWorkItemSnapshot = {
    id: event.workItemId,
    repositoryId: event.repositoryId,
    type: payload.type as WorkItemType,
    status: payload.status as WorkItemStatus,
    title: payload.title,
    description: null,
    parentId: typeof payload.parentId === 'number' ? payload.parentId : null,
    tags: Array.isArray(payload.tags) ? (payload.tags as string[]) : null,
    plannedFiles: Array.isArray(payload.plannedFiles) ? (payload.plannedFiles as string[]) : null,
    assignees: Array.isArray(payload.assignees) ? (payload.assignees as string[]) : null,
    priority: typeof payload.priority === 'number' ? payload.priority : null,
    estimate: typeof payload.estimate === 'number' ? payload.estimate : null,
    revision: typeof payload.revision === 'number' ? payload.revision : 0,
    createdAt: event.createdAt,
    updatedAt: event.createdAt,
    effectivePolicy: coerceEffectivePolicy(payload.effectivePolicy, existing?.effectivePolicy),
    linkedWorkflowRun: coerceLinkedWorkflowRun(payload.linkedWorkflowRun, existing?.linkedWorkflowRun),
  };

  return {
    ...previous,
    [event.workItemId]: existing ? { ...existing, ...next } : next,
  };
}

function applyUpdatedBoardEvent(
  previous: Readonly<Record<number, DashboardWorkItemSnapshot>>,
  event: BoardEventSnapshot,
  existing: DashboardWorkItemSnapshot | undefined,
): Readonly<Record<number, DashboardWorkItemSnapshot>> {
  if (!existing) {
    return previous;
  }

  const payload = event.payload;
  if (!isRecord(payload) || !isRecord(payload.changes)) {
    return previous;
  }

  const changes = payload.changes;
  const next: DashboardWorkItemSnapshot = {
    ...existing,
    title: typeof changes.title === 'string' ? changes.title : existing.title,
    description: coerceNullableString(changes.description, existing.description),
    tags: coerceNullableStringArray(changes.tags, existing.tags),
    plannedFiles: coerceNullableStringArray(changes.plannedFiles, existing.plannedFiles),
    assignees: coerceNullableStringArray(changes.assignees, existing.assignees),
    priority: coerceNullableNumber(changes.priority, existing.priority),
    estimate: coerceNullableNumber(changes.estimate, existing.estimate),
    revision: typeof payload.revision === 'number' ? payload.revision : existing.revision,
    updatedAt: event.createdAt,
    linkedWorkflowRun:
      'linkedWorkflowRun' in changes
        ? mergeLinkedWorkflowRun(
            coerceLinkedWorkflowRun(changes.linkedWorkflowRun, existing.linkedWorkflowRun),
            existing.linkedWorkflowRun,
          )
        : existing.linkedWorkflowRun ?? null,
  };

  return {
    ...previous,
    [existing.id]: next,
  };
}

function applyReparentedBoardEvent(
  previous: Readonly<Record<number, DashboardWorkItemSnapshot>>,
  event: BoardEventSnapshot,
  existing: DashboardWorkItemSnapshot | undefined,
): Readonly<Record<number, DashboardWorkItemSnapshot>> {
  if (!existing) {
    return previous;
  }

  const payload = event.payload;
  if (!isRecord(payload)) {
    return previous;
  }

  const parentIdValue = payload.toParentId;
  const parentId = typeof parentIdValue === 'number' ? parentIdValue : null;
  const next: DashboardWorkItemSnapshot = {
    ...existing,
    parentId,
    revision: typeof payload.revision === 'number' ? payload.revision : existing.revision,
    updatedAt: event.createdAt,
    effectivePolicy: coerceEffectivePolicy(payload.effectivePolicy, existing.effectivePolicy),
  };

  return { ...previous, [existing.id]: next };
}

function applyStatusChangedBoardEvent(
  previous: Readonly<Record<number, DashboardWorkItemSnapshot>>,
  event: BoardEventSnapshot,
  existing: DashboardWorkItemSnapshot | undefined,
): Readonly<Record<number, DashboardWorkItemSnapshot>> {
  if (!existing) {
    return previous;
  }

  const payload = event.payload;
  if (!isRecord(payload) || typeof payload.toStatus !== 'string') {
    return previous;
  }

  const nextStatus = payload.toStatus;
  const next: DashboardWorkItemSnapshot = {
    ...existing,
    status: nextStatus as WorkItemStatus,
    revision: typeof payload.revision === 'number' ? payload.revision : existing.revision,
    updatedAt: event.createdAt,
    linkedWorkflowRun:
      'linkedWorkflowRun' in payload
        ? mergeLinkedWorkflowRun(
            coerceLinkedWorkflowRun(payload.linkedWorkflowRun, existing.linkedWorkflowRun),
            existing.linkedWorkflowRun,
          )
        : existing.linkedWorkflowRun ?? null,
  };

  return { ...previous, [existing.id]: next };
}

export function applyBoardEventToWorkItems(
  previous: Readonly<Record<number, DashboardWorkItemSnapshot>>,
  repositoryId: number,
  event: BoardEventSnapshot,
): Readonly<Record<number, DashboardWorkItemSnapshot>> {
  if (event.repositoryId !== repositoryId) {
    return previous;
  }

  const existing = previous[event.workItemId];
  if (event.eventType === 'created') {
    return applyCreatedBoardEvent(previous, event, existing);
  }

  if (event.eventType === 'updated') {
    return applyUpdatedBoardEvent(previous, event, existing);
  }

  if (event.eventType === 'reparented') {
    return applyReparentedBoardEvent(previous, event, existing);
  }

  if (event.eventType === 'status_changed') {
    return applyStatusChangedBoardEvent(previous, event, existing);
  }

  if (event.eventType === 'breakdown_proposed' || event.eventType === 'breakdown_approved') {
    return applyStatusChangedBoardEvent(previous, event, existing);
  }

  return previous;
}

export function parseBoardEventSnapshot(payload: unknown): BoardEventSnapshot | null {
  if (
    !isRecord(payload) ||
    typeof payload.id !== 'number' ||
    typeof payload.repositoryId !== 'number' ||
    typeof payload.workItemId !== 'number' ||
    typeof payload.eventType !== 'string' ||
    typeof payload.createdAt !== 'string'
  ) {
    return null;
  }

  return {
    id: payload.id,
    repositoryId: payload.repositoryId,
    workItemId: payload.workItemId,
    eventType: payload.eventType,
    payload: payload.payload ?? null,
    createdAt: payload.createdAt,
  };
}

export async function fetchWorkItem(params: {
  repositoryId: number;
  workItemId: number;
}): Promise<DashboardWorkItemSnapshot> {
  const response = await fetch(
    `/api/dashboard/work-items/${params.workItemId}?repositoryId=${params.repositoryId}`,
    { method: 'GET' },
  );
  const payload = parseJsonSafely(await response.text());

  if (!response.ok) {
    throw new Error(resolveApiErrorMessage(response.status, payload, 'Unable to refresh work item'));
  }

  if (!isRecord(payload) || !isRecord(payload.workItem)) {
    throw new Error('Unable to refresh work item (malformed response).');
  }

  return payload.workItem as DashboardWorkItemSnapshot;
}

export async function createWorkItem(params: {
  repositoryId: number;
  type: WorkItemType;
  title: string;
  actor: WorkItemActor;
  status?: WorkItemStatus;
  description?: string | null;
  parentId?: number | null;
  tags?: string[] | null;
  plannedFiles?: string[] | null;
  assignees?: string[] | null;
  priority?: number | null;
  estimate?: number | null;
  errorPrefix?: string;
}): Promise<{ ok: true; workItem: DashboardWorkItemSnapshot } | { ok: false; status: number; message: string }> {
  const errorPrefix = params.errorPrefix ?? 'Unable to create work item';
  const requestBody: {
    type: WorkItemType;
    title: string;
    actorType: WorkItemActor['actorType'];
    actorLabel: WorkItemActor['actorLabel'];
    status?: WorkItemStatus;
    description?: string | null;
    parentId?: number | null;
    tags?: string[] | null;
    plannedFiles?: string[] | null;
    assignees?: string[] | null;
    priority?: number | null;
    estimate?: number | null;
  } = {
    type: params.type,
    title: params.title,
    actorType: params.actor.actorType,
    actorLabel: params.actor.actorLabel,
  };

  if (params.status !== undefined) {
    requestBody.status = params.status;
  }
  if (params.description !== undefined) {
    requestBody.description = params.description;
  }
  if (params.parentId !== undefined) {
    requestBody.parentId = params.parentId;
  }
  if (params.tags !== undefined) {
    requestBody.tags = params.tags;
  }
  if (params.plannedFiles !== undefined) {
    requestBody.plannedFiles = params.plannedFiles;
  }
  if (params.assignees !== undefined) {
    requestBody.assignees = params.assignees;
  }
  if (params.priority !== undefined) {
    requestBody.priority = params.priority;
  }
  if (params.estimate !== undefined) {
    requestBody.estimate = params.estimate;
  }

  const response = await fetch(`/api/dashboard/repositories/${params.repositoryId}/work-items`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(requestBody),
  });
  const payload = parseJsonSafely(await response.text());

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      message: resolveApiErrorMessage(response.status, payload, errorPrefix),
    };
  }

  if (!isRecord(payload) || !isRecord(payload.workItem)) {
    return { ok: false, status: 500, message: `${errorPrefix} (malformed response).` };
  }

  return { ok: true, workItem: payload.workItem as DashboardWorkItemSnapshot };
}

type StoryBreakdownMutationResult =
  | { ok: true; story: DashboardWorkItemSnapshot; tasks: DashboardWorkItemSnapshot[] }
  | { ok: false; status: number; message: string };

export async function generateStoryBreakdownDraft(params: {
  repositoryId: number;
  storyId: number;
  expectedRevision: number;
  errorPrefix?: string;
}): Promise<StoryBreakdownMutationResult> {
  const errorPrefix = params.errorPrefix ?? 'Unable to generate breakdown';
  const response = await fetch(`/api/dashboard/work-items/${params.storyId}/actions/generate-breakdown`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      repositoryId: params.repositoryId,
      expectedRevision: params.expectedRevision,
    }),
  });
  const payload = parseJsonSafely(await response.text());

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      message: resolveApiErrorMessage(response.status, payload, errorPrefix),
    };
  }

  if (!isRecord(payload) || !isRecord(payload.story) || !Array.isArray(payload.tasks)) {
    return { ok: false, status: 500, message: `${errorPrefix} (malformed response).` };
  }

  return {
    ok: true,
    story: payload.story as DashboardWorkItemSnapshot,
    tasks: payload.tasks as DashboardWorkItemSnapshot[],
  };
}

export async function approveStoryBreakdown(params: {
  repositoryId: number;
  storyId: number;
  expectedRevision: number;
  actor: WorkItemActor;
  errorPrefix?: string;
}): Promise<StoryBreakdownMutationResult> {
  const errorPrefix = params.errorPrefix ?? 'Unable to approve breakdown';
  const response = await fetch(`/api/dashboard/work-items/${params.storyId}/actions/approve-breakdown`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      repositoryId: params.repositoryId,
      expectedRevision: params.expectedRevision,
      actorType: params.actor.actorType,
      actorLabel: params.actor.actorLabel,
    }),
  });
  const payload = parseJsonSafely(await response.text());

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      message: resolveApiErrorMessage(response.status, payload, errorPrefix),
    };
  }

  if (!isRecord(payload) || !isRecord(payload.story) || !Array.isArray(payload.tasks)) {
    return { ok: false, status: 500, message: `${errorPrefix} (malformed response).` };
  }

  return {
    ok: true,
    story: payload.story as DashboardWorkItemSnapshot,
    tasks: payload.tasks as DashboardWorkItemSnapshot[],
  };
}

export async function moveWorkItemStatus<TStatus extends string>(params: {
  repositoryId: number;
  workItemId: number;
  expectedRevision: number;
  toStatus: TStatus;
  actor: WorkItemActor;
  errorPrefix?: string;
}): Promise<{ ok: true; workItem: DashboardWorkItemSnapshot } | { ok: false; status: number; message: string }> {
  const errorPrefix = params.errorPrefix ?? 'Unable to move work item';
  const response = await fetch(`/api/dashboard/work-items/${params.workItemId}/actions/move`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      repositoryId: params.repositoryId,
      expectedRevision: params.expectedRevision,
      toStatus: params.toStatus,
      actorType: params.actor.actorType,
      actorLabel: params.actor.actorLabel,
    }),
  });

  const payload = parseJsonSafely(await response.text());

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      message: resolveApiErrorMessage(response.status, payload, errorPrefix),
    };
  }

  if (!isRecord(payload) || !isRecord(payload.workItem)) {
    return { ok: false, status: 500, message: `${errorPrefix} (malformed response).` };
  }

  return { ok: true, workItem: payload.workItem as DashboardWorkItemSnapshot };
}

export async function updateWorkItemFields(params: {
  repositoryId: number;
  workItemId: number;
  expectedRevision: number;
  actor: WorkItemActor;
  plannedFiles?: string[] | null;
  assignees?: string[] | null;
  errorPrefix?: string;
}): Promise<{ ok: true; workItem: DashboardWorkItemSnapshot } | { ok: false; status: number; message: string }> {
  const errorPrefix = params.errorPrefix ?? 'Unable to save work item';
  const requestBody: {
    repositoryId: number;
    expectedRevision: number;
    actorType: WorkItemActor['actorType'];
    actorLabel: WorkItemActor['actorLabel'];
    plannedFiles?: string[] | null;
    assignees?: string[] | null;
  } = {
    repositoryId: params.repositoryId,
    expectedRevision: params.expectedRevision,
    actorType: params.actor.actorType,
    actorLabel: params.actor.actorLabel,
  };
  if (params.plannedFiles !== undefined) {
    requestBody.plannedFiles = params.plannedFiles;
  }
  if (params.assignees !== undefined) {
    requestBody.assignees = params.assignees;
  }

  const response = await fetch(`/api/dashboard/work-items/${params.workItemId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(requestBody),
  });

  const payload = parseJsonSafely(await response.text());

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      message: resolveApiErrorMessage(response.status, payload, errorPrefix),
    };
  }

  if (!isRecord(payload) || !isRecord(payload.workItem)) {
    return { ok: false, status: 500, message: `${errorPrefix} (malformed response).` };
  }

  return { ok: true, workItem: payload.workItem as DashboardWorkItemSnapshot };
}

export async function requestWorkItemReplan(params: {
  repositoryId: number;
  workItemId: number;
  actor: WorkItemActor;
  errorPrefix?: string;
}): Promise<{ ok: true; result: DashboardRequestWorkItemReplanResult } | { ok: false; status: number; message: string }> {
  const errorPrefix = params.errorPrefix ?? 'Unable to request replanning';
  const response = await fetch(
    `/api/dashboard/repositories/${params.repositoryId}/work-items/${params.workItemId}/actions/request-replan`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        actorType: params.actor.actorType,
        actorLabel: params.actor.actorLabel,
      }),
    },
  );

  const payload = parseJsonSafely(await response.text());

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      message: resolveApiErrorMessage(response.status, payload, errorPrefix),
    };
  }

  if (
    !isRecord(payload)
    || typeof payload.repositoryId !== 'number'
    || typeof payload.workItemId !== 'number'
    || typeof payload.workflowRunId !== 'number'
    || typeof payload.eventId !== 'number'
    || typeof payload.requestedAt !== 'string'
    || !Array.isArray(payload.plannedButUntouched)
    || !Array.isArray(payload.touchedButUnplanned)
    || payload.plannedButUntouched.some((entry) => typeof entry !== 'string')
    || payload.touchedButUnplanned.some((entry) => typeof entry !== 'string')
  ) {
    return { ok: false, status: 500, message: `${errorPrefix} (malformed response).` };
  }

  return {
    ok: true,
    result: payload as DashboardRequestWorkItemReplanResult,
  };
}
