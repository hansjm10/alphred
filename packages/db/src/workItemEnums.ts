import { sql, type SQL } from 'drizzle-orm';

export {
  epicWorkItemStatuses,
  featureWorkItemStatuses,
  storyWorkItemStatuses,
  taskWorkItemStatuses,
  workItemStatusesByType,
  workItemTypes,
} from '@alphred/shared';
export type {
  EpicWorkItemStatus,
  FeatureWorkItemStatus,
  StoryWorkItemStatus,
  TaskWorkItemStatus,
  WorkItemStatus,
  WorkItemStatusByType,
  WorkItemType,
} from '@alphred/shared';

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
  return value.split("'").join("''");
}

export function sqlEnumValues(values: readonly string[]): SQL<unknown> {
  const literals = values.map(value => `'${escapeSqlStringLiteral(value)}'`).join(', ');
  return sql.raw(literals);
}
