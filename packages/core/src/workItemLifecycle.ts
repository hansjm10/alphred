import {
  epicWorkItemStatuses,
  featureWorkItemStatuses,
  storyWorkItemStatuses,
  taskWorkItemStatuses,
  workItemStatusesByType,
  type WorkItemStatusByType,
  type WorkItemType,
} from '@alphred/shared';

export type WorkItemTransitionErrorCode = 'WORK_ITEM_UNKNOWN_STATUS' | 'WORK_ITEM_INVALID_TRANSITION';

export class WorkItemTransitionError extends Error {
  readonly code: WorkItemTransitionErrorCode;
  readonly type: WorkItemType;
  readonly from: string;
  readonly to: string;

  constructor(
    code: WorkItemTransitionErrorCode,
    message: string,
    options: { type: WorkItemType; from: string; to: string; cause?: unknown },
  ) {
    super(message);
    this.name = 'WorkItemTransitionError';
    this.code = code;
    this.type = options.type;
    this.from = options.from;
    this.to = options.to;
    if (options.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

export type WorkItemHierarchyErrorCode = 'WORK_ITEM_INVALID_PARENT_CHILD_TYPES';

export class WorkItemHierarchyError extends Error {
  readonly code: WorkItemHierarchyErrorCode;
  readonly parentType: WorkItemType;
  readonly childType: WorkItemType;

  constructor(message: string, options: { parentType: WorkItemType; childType: WorkItemType; cause?: unknown }) {
    super(message);
    this.name = 'WorkItemHierarchyError';
    this.code = 'WORK_ITEM_INVALID_PARENT_CHILD_TYPES';
    this.parentType = options.parentType;
    this.childType = options.childType;
    if (options.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

export const workItemAllowedParentTypesByChildType = {
  epic: [] as const,
  feature: ['epic'] as const,
  story: ['feature'] as const,
  task: ['story'] as const,
} as const satisfies Record<WorkItemType, readonly WorkItemType[]>;

export function canParentChildWorkItemTypes(parentType: WorkItemType, childType: WorkItemType): boolean {
  return (workItemAllowedParentTypesByChildType[childType] as readonly WorkItemType[]).includes(parentType);
}

export function validateParentChildWorkItemTypes(parentType: WorkItemType, childType: WorkItemType): void {
  if (!canParentChildWorkItemTypes(parentType, childType)) {
    throw new WorkItemHierarchyError(`Invalid work item parent/child types: ${parentType} -> ${childType}`, {
      parentType,
      childType,
    });
  }
}

export type WorkItemStatusTransition<T extends WorkItemType> = {
  from: WorkItemStatusByType[T];
  to: WorkItemStatusByType[T];
};

export const workItemTransitionsByType = {
  epic: [
    { from: epicWorkItemStatuses[0], to: 'Approved' },
    { from: 'Approved', to: 'InProgress' },
    { from: 'InProgress', to: 'Blocked' },
    { from: 'Blocked', to: 'InProgress' },
    { from: 'InProgress', to: 'InReview' },
    { from: 'InReview', to: 'InProgress' },
    { from: 'InReview', to: 'Done' },
  ],
  feature: [
    { from: featureWorkItemStatuses[0], to: 'Approved' },
    { from: 'Approved', to: 'InProgress' },
    { from: 'InProgress', to: 'Blocked' },
    { from: 'Blocked', to: 'InProgress' },
    { from: 'InProgress', to: 'InReview' },
    { from: 'InReview', to: 'InProgress' },
    { from: 'InReview', to: 'Done' },
  ],
  story: [
    { from: storyWorkItemStatuses[0], to: 'NeedsBreakdown' },
    { from: 'NeedsBreakdown', to: 'BreakdownProposed' },
    { from: 'BreakdownProposed', to: 'Approved' },
    { from: 'Approved', to: 'InProgress' },
    { from: 'InProgress', to: 'InReview' },
    { from: 'InReview', to: 'InProgress' },
    { from: 'InReview', to: 'Done' },
  ],
  task: [
    { from: taskWorkItemStatuses[0], to: 'Ready' },
    { from: 'Ready', to: 'InProgress' },
    { from: 'InProgress', to: 'Blocked' },
    { from: 'Blocked', to: 'InProgress' },
    { from: 'InProgress', to: 'InReview' },
    { from: 'InReview', to: 'InProgress' },
    { from: 'InReview', to: 'Done' },
  ],
} as const satisfies {
  [K in WorkItemType]: readonly WorkItemStatusTransition<K>[];
};

function edgeKey(from: string, to: string): string {
  return `${from}::${to}`;
}

const transitionEdgesByType: Record<WorkItemType, ReadonlySet<string>> = {
  epic: new Set(workItemTransitionsByType.epic.map(t => edgeKey(t.from, t.to))),
  feature: new Set(workItemTransitionsByType.feature.map(t => edgeKey(t.from, t.to))),
  story: new Set(workItemTransitionsByType.story.map(t => edgeKey(t.from, t.to))),
  task: new Set(workItemTransitionsByType.task.map(t => edgeKey(t.from, t.to))),
};

export function isWorkItemStatusForType(type: WorkItemType, status: string): boolean {
  return (workItemStatusesByType[type] as readonly string[]).includes(status);
}

export function canTransitionWorkItem(params: { type: WorkItemType; from: string; to: string }): boolean {
  const { type, from, to } = params;
  if (from === to) return false;
  if (!isWorkItemStatusForType(type, from)) return false;
  if (!isWorkItemStatusForType(type, to)) return false;
  return transitionEdgesByType[type].has(edgeKey(from, to));
}

export function validateTransition(params: { type: WorkItemType; from: string; to: string }): void {
  const { type, from, to } = params;

  if (!isWorkItemStatusForType(type, from)) {
    throw new WorkItemTransitionError(
      'WORK_ITEM_UNKNOWN_STATUS',
      `Unknown work item status for type "${type}": from="${from}"`,
      { type, from, to },
    );
  }

  if (!isWorkItemStatusForType(type, to)) {
    throw new WorkItemTransitionError(
      'WORK_ITEM_UNKNOWN_STATUS',
      `Unknown work item status for type "${type}": to="${to}"`,
      { type, from, to },
    );
  }

  if (from === to || !transitionEdgesByType[type].has(edgeKey(from, to))) {
    throw new WorkItemTransitionError(
      'WORK_ITEM_INVALID_TRANSITION',
      `Invalid work item transition for type "${type}": ${from} -> ${to}`,
      { type, from, to },
    );
  }
}

