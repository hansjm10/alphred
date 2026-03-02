import { sql, type SQL } from 'drizzle-orm';

export const workItemTypes = ['epic', 'feature', 'story', 'task'] as const;
export type WorkItemType = (typeof workItemTypes)[number];

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
