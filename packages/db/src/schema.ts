import { sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

const utcNow = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

export const workflowTrees = sqliteTable(
  'workflow_trees',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    treeKey: text('tree_key').notNull(),
    version: integer('version').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    createdAt: text('created_at').notNull().default(utcNow),
    updatedAt: text('updated_at').notNull().default(utcNow),
  },
  table => ({
    treeKeyVersionUnique: uniqueIndex('workflow_trees_tree_key_version_uq').on(table.treeKey, table.version),
    createdAtIdx: index('workflow_trees_created_at_idx').on(table.createdAt),
  }),
);

export const promptTemplates = sqliteTable(
  'prompt_templates',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    templateKey: text('template_key').notNull(),
    version: integer('version').notNull().default(1),
    content: text('content').notNull(),
    contentType: text('content_type').notNull().default('markdown'),
    metadata: text('metadata', { mode: 'json' }),
    createdAt: text('created_at').notNull().default(utcNow),
    updatedAt: text('updated_at').notNull().default(utcNow),
  },
  table => ({
    templateKeyVersionUnique: uniqueIndex('prompt_templates_template_key_version_uq').on(table.templateKey, table.version),
    contentTypeCheck: check(
      'prompt_templates_content_type_ck',
      sql`${table.contentType} in ('text', 'markdown')`,
    ),
    createdAtIdx: index('prompt_templates_created_at_idx').on(table.createdAt),
  }),
);

export const guardDefinitions = sqliteTable(
  'guard_definitions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    guardKey: text('guard_key').notNull(),
    version: integer('version').notNull().default(1),
    expression: text('expression', { mode: 'json' }).notNull(),
    description: text('description'),
    createdAt: text('created_at').notNull().default(utcNow),
    updatedAt: text('updated_at').notNull().default(utcNow),
  },
  table => ({
    guardKeyVersionUnique: uniqueIndex('guard_definitions_guard_key_version_uq').on(table.guardKey, table.version),
    createdAtIdx: index('guard_definitions_created_at_idx').on(table.createdAt),
  }),
);

export const workflowRuns = sqliteTable(
  'workflow_runs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    workflowTreeId: integer('workflow_tree_id')
      .notNull()
      .references(() => workflowTrees.id, { onDelete: 'restrict' }),
    status: text('status').notNull().default('pending'),
    startedAt: text('started_at'),
    completedAt: text('completed_at'),
    createdAt: text('created_at').notNull().default(utcNow),
    updatedAt: text('updated_at').notNull().default(utcNow),
  },
  table => ({
    statusCheck: check(
      'workflow_runs_status_ck',
      sql`${table.status} in ('pending', 'running', 'paused', 'completed', 'failed', 'cancelled')`,
    ),
    completionTimestampCheck: check(
      'workflow_runs_completion_timestamp_ck',
      sql`(
        ${table.status} in ('pending', 'running', 'paused')
        and ${table.completedAt} is null
      ) or (
        ${table.status} in ('completed', 'failed', 'cancelled')
        and ${table.completedAt} is not null
      )`,
    ),
    createdAtIdx: index('workflow_runs_created_at_idx').on(table.createdAt),
  }),
);

export const treeNodes = sqliteTable(
  'tree_nodes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    workflowTreeId: integer('workflow_tree_id')
      .notNull()
      .references(() => workflowTrees.id, { onDelete: 'cascade' }),
    nodeKey: text('node_key').notNull(),
    nodeType: text('node_type').notNull(),
    provider: text('provider'),
    promptTemplateId: integer('prompt_template_id').references(() => promptTemplates.id, { onDelete: 'restrict' }),
    maxRetries: integer('max_retries').notNull().default(0),
    sequenceIndex: integer('sequence_index').notNull(),
    createdAt: text('created_at').notNull().default(utcNow),
    updatedAt: text('updated_at').notNull().default(utcNow),
  },
  table => ({
    treeNodeKeyUnique: uniqueIndex('tree_nodes_tree_id_node_key_uq').on(table.workflowTreeId, table.nodeKey),
    treeSequenceUnique: uniqueIndex('tree_nodes_tree_id_sequence_uq').on(table.workflowTreeId, table.sequenceIndex),
    nodeTypeCheck: check('tree_nodes_node_type_ck', sql`${table.nodeType} in ('agent', 'human', 'tool')`),
    providerForAgentCheck: check(
      'tree_nodes_provider_for_agent_ck',
      sql`(${table.nodeType} <> 'agent') or (${table.provider} is not null)`,
    ),
    maxRetriesCheck: check('tree_nodes_max_retries_ck', sql`${table.maxRetries} >= 0`),
    nodeKeyIdx: index('tree_nodes_node_key_idx').on(table.nodeKey),
    createdAtIdx: index('tree_nodes_created_at_idx').on(table.createdAt),
  }),
);

export const treeEdges = sqliteTable(
  'tree_edges',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    workflowTreeId: integer('workflow_tree_id')
      .notNull()
      .references(() => workflowTrees.id, { onDelete: 'cascade' }),
    sourceNodeId: integer('source_node_id')
      .notNull()
      .references(() => treeNodes.id, { onDelete: 'cascade' }),
    targetNodeId: integer('target_node_id')
      .notNull()
      .references(() => treeNodes.id, { onDelete: 'cascade' }),
    priority: integer('priority').notNull(),
    auto: integer('auto').notNull().default(0),
    guardDefinitionId: integer('guard_definition_id').references(() => guardDefinitions.id, { onDelete: 'restrict' }),
    createdAt: text('created_at').notNull().default(utcNow),
  },
  table => ({
    sourcePriorityUnique: uniqueIndex('tree_edges_source_priority_uq').on(table.sourceNodeId, table.priority),
    autoBooleanCheck: check('tree_edges_auto_bool_ck', sql`${table.auto} in (0, 1)`),
    priorityCheck: check('tree_edges_priority_ck', sql`${table.priority} >= 0`),
    transitionModeCheck: check(
      'tree_edges_transition_mode_ck',
      sql`(
        ${table.auto} = 1 and ${table.guardDefinitionId} is null
      ) or (
        ${table.auto} = 0 and ${table.guardDefinitionId} is not null
      )`,
    ),
    sourceNodeIdx: index('tree_edges_source_node_idx').on(table.sourceNodeId),
    createdAtIdx: index('tree_edges_created_at_idx').on(table.createdAt),
  }),
);

export const runNodes = sqliteTable(
  'run_nodes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    workflowRunId: integer('workflow_run_id')
      .notNull()
      .references(() => workflowRuns.id, { onDelete: 'cascade' }),
    treeNodeId: integer('tree_node_id')
      .notNull()
      .references(() => treeNodes.id, { onDelete: 'restrict' }),
    nodeKey: text('node_key').notNull(),
    status: text('status').notNull().default('pending'),
    sequenceIndex: integer('sequence_index').notNull(),
    attempt: integer('attempt').notNull().default(1),
    startedAt: text('started_at'),
    completedAt: text('completed_at'),
    createdAt: text('created_at').notNull().default(utcNow),
    updatedAt: text('updated_at').notNull().default(utcNow),
  },
  table => ({
    runSequenceUnique: uniqueIndex('run_nodes_run_id_sequence_uq').on(table.workflowRunId, table.sequenceIndex),
    runNodeAttemptUnique: uniqueIndex('run_nodes_run_id_node_attempt_uq').on(
      table.workflowRunId,
      table.nodeKey,
      table.attempt,
    ),
    runIdIdUnique: uniqueIndex('run_nodes_run_id_id_uq').on(table.workflowRunId, table.id),
    statusCheck: check(
      'run_nodes_status_ck',
      sql`${table.status} in ('pending', 'running', 'completed', 'failed', 'skipped', 'cancelled')`,
    ),
    attemptCheck: check('run_nodes_attempt_ck', sql`${table.attempt} > 0`),
    runningStartedAtCheck: check(
      'run_nodes_running_started_at_ck',
      sql`(${table.status} <> 'running') or (${table.startedAt} is not null)`,
    ),
    completionTimestampCheck: check(
      'run_nodes_completion_timestamp_ck',
      sql`(
        ${table.status} in ('pending', 'running')
        and ${table.completedAt} is null
      ) or (
        ${table.status} in ('completed', 'failed', 'skipped', 'cancelled')
        and ${table.completedAt} is not null
      )`,
    ),
    runStatusIdx: index('run_nodes_run_id_status_idx').on(table.workflowRunId, table.status),
    runSequenceIdx: index('run_nodes_run_id_sequence_idx').on(table.workflowRunId, table.sequenceIndex),
    nodeKeyIdx: index('run_nodes_node_key_idx').on(table.nodeKey),
    createdAtIdx: index('run_nodes_created_at_idx').on(table.createdAt),
  }),
);

export const routingDecisions = sqliteTable(
  'routing_decisions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    workflowRunId: integer('workflow_run_id')
      .notNull()
      .references(() => workflowRuns.id, { onDelete: 'cascade' }),
    runNodeId: integer('run_node_id')
      .notNull()
      .references(() => runNodes.id, { onDelete: 'cascade' }),
    decisionType: text('decision_type').notNull(),
    rationale: text('rationale'),
    rawOutput: text('raw_output', { mode: 'json' }),
    createdAt: text('created_at').notNull().default(utcNow),
  },
  table => ({
    runNodeBelongsToRunFk: foreignKey({
      columns: [table.workflowRunId, table.runNodeId],
      foreignColumns: [runNodes.workflowRunId, runNodes.id],
      name: 'routing_decisions_run_id_run_node_id_fk',
    }).onDelete('cascade'),
    decisionTypeCheck: check(
      'routing_decisions_decision_type_ck',
      sql`${table.decisionType} in ('approved', 'changes_requested', 'blocked', 'retry', 'no_route')`,
    ),
    runCreatedAtIdx: index('routing_decisions_run_id_created_at_idx').on(table.workflowRunId, table.createdAt),
    createdAtIdx: index('routing_decisions_created_at_idx').on(table.createdAt),
  }),
);

export const phaseArtifacts = sqliteTable(
  'phase_artifacts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    workflowRunId: integer('workflow_run_id')
      .notNull()
      .references(() => workflowRuns.id, { onDelete: 'cascade' }),
    runNodeId: integer('run_node_id')
      .notNull()
      .references(() => runNodes.id, { onDelete: 'cascade' }),
    artifactType: text('artifact_type').notNull().default('report'),
    contentType: text('content_type').notNull(),
    content: text('content').notNull(),
    metadata: text('metadata', { mode: 'json' }),
    createdAt: text('created_at').notNull().default(utcNow),
  },
  table => ({
    runNodeBelongsToRunFk: foreignKey({
      columns: [table.workflowRunId, table.runNodeId],
      foreignColumns: [runNodes.workflowRunId, runNodes.id],
      name: 'phase_artifacts_run_id_run_node_id_fk',
    }).onDelete('cascade'),
    artifactTypeCheck: check('phase_artifacts_artifact_type_ck', sql`${table.artifactType} in ('report', 'note', 'log')`),
    contentTypeCheck: check(
      'phase_artifacts_content_type_ck',
      sql`${table.contentType} in ('text', 'markdown', 'json', 'diff')`,
    ),
    runCreatedAtIdx: index('phase_artifacts_run_id_created_at_idx').on(table.workflowRunId, table.createdAt),
    createdAtIdx: index('phase_artifacts_created_at_idx').on(table.createdAt),
  }),
);
