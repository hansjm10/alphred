import { sql, type SQL } from 'drizzle-orm';

export const workItemTypes = ['epic', 'feature', 'story', 'task'] as const;
export type WorkItemType = (typeof workItemTypes)[number];

export const epicWorkItemStatuses = ['Draft', 'Approved', 'InProgress', 'Blocked', 'InReview', 'Done'] as const;
export type EpicWorkItemStatus = (typeof epicWorkItemStatuses)[number];

export const featureWorkItemStatuses = ['Draft', 'Approved', 'InProgress', 'Blocked', 'InReview', 'Done'] as const;
export type FeatureWorkItemStatus = (typeof featureWorkItemStatuses)[number];

export const storyWorkItemStatuses = [
  'Draft',
  'NeedsBreakdown',
  'BreakdownProposed',
  'Approved',
  'InProgress',
  'InReview',
  'Done',
] as const;
export type StoryWorkItemStatus = (typeof storyWorkItemStatuses)[number];

export const taskWorkItemStatuses = ['Draft', 'Ready', 'InProgress', 'Blocked', 'InReview', 'Done'] as const;
export type TaskWorkItemStatus = (typeof taskWorkItemStatuses)[number];

export const workItemActorTypes = ['human', 'agent', 'system'] as const;
export type WorkItemActorType = (typeof workItemActorTypes)[number];

export const workItemEventTypes = [
  'created',
  'updated',
  'status_changed',
  'reparented',
  'deleted',
  'breakdown_proposed',
  'breakdown_approved',
] as const;
export type WorkItemEventType = (typeof workItemEventTypes)[number];

function escapeSqlStringLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

export function sqlEnumValues(values: readonly string[]): SQL<unknown> {
  const literals = values.map(value => `'${escapeSqlStringLiteral(value)}'`).join(', ');
  return sql.raw(literals);
}
