import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const workflows = sqliteTable('workflows', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  version: integer('version').notNull().default(1),
  definition: text('definition', { mode: 'json' }).notNull(),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at').notNull().$defaultFn(() => new Date().toISOString()),
});

export const runs = sqliteTable('runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  workflowId: integer('workflow_id').notNull().references(() => workflows.id),
  status: text('status').notNull().default('pending'),
  triggerSource: text('trigger_source').notNull().default('manual'),
  worktreeDir: text('worktree_dir'),
  branch: text('branch'),
  retryCount: integer('retry_count').notNull().default(0),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at').notNull().$defaultFn(() => new Date().toISOString()),
});

export const phases = sqliteTable('phases', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  runId: integer('run_id').notNull().references(() => runs.id),
  name: text('name').notNull(),
  type: text('type').notNull().default('agent'),
  status: text('status').notNull().default('pending'),
  sequenceIndex: integer('sequence_index').notNull(),
  provider: text('provider'),
  prompt: text('prompt').notNull(),
  maxRetries: integer('max_retries').notNull().default(0),
  retryCount: integer('retry_count').notNull().default(0),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at').notNull().$defaultFn(() => new Date().toISOString()),
});

export const phaseReports = sqliteTable('phase_reports', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  phaseId: integer('phase_id').notNull().references(() => phases.id),
  runId: integer('run_id').notNull().references(() => runs.id),
  content: text('content').notNull(),
  contentType: text('content_type').notNull().default('text'),
  metadata: text('metadata', { mode: 'json' }),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
});

export const agentSessions = sqliteTable('agent_sessions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  phaseId: integer('phase_id').notNull().references(() => phases.id),
  provider: text('provider').notNull(),
  status: text('status').notNull().default('pending'),
  prompt: text('prompt').notNull(),
  result: text('result'),
  tokens: integer('tokens'),
  cost: integer('cost'),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at').notNull().$defaultFn(() => new Date().toISOString()),
});

export const agentEvents = sqliteTable('agent_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sessionId: integer('session_id').notNull().references(() => agentSessions.id),
  type: text('type').notNull(),
  content: text('content').notNull(),
  timestamp: text('timestamp').notNull().$defaultFn(() => new Date().toISOString()),
});

export const runLogs = sqliteTable('run_logs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  runId: integer('run_id').notNull().references(() => runs.id),
  level: text('level').notNull().default('info'),
  source: text('source').notNull(),
  message: text('message').notNull(),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
});

export const stateSnapshots = sqliteTable('state_snapshots', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  runId: integer('run_id').notNull().references(() => runs.id),
  scope: text('scope').notNull(),
  key: text('key').notNull(),
  value: text('value', { mode: 'json' }).notNull(),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at').notNull().$defaultFn(() => new Date().toISOString()),
});
