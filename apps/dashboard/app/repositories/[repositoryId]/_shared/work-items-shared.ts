'use client';

import type { WorkItemStatus, WorkItemType } from '@alphred/shared';
import type { DashboardWorkItemEffectivePolicySnapshot, DashboardWorkItemSnapshot } from '@dashboard/server/dashboard-contracts';

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

function coerceEffectivePolicy(
  value: unknown,
  fallback: DashboardWorkItemEffectivePolicySnapshot | null | undefined,
): DashboardWorkItemEffectivePolicySnapshot | null {
  if (value === null) {
    return null;
  }
  if (isRecord(value)) {
    return value as DashboardWorkItemEffectivePolicySnapshot;
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
