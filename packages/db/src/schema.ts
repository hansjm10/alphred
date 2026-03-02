import { sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import {
  epicWorkItemStatuses,
  featureWorkItemStatuses,
  sqlEnumValues,
  storyWorkItemStatuses,
  taskWorkItemStatuses,
  workItemActorTypes,
  workItemEventTypes,
  workItemTypes,
} from './workItemEnums.js';

const utcNow = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

export const workflowTrees = sqliteTable(
  'workflow_trees',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    treeKey: text('tree_key').notNull(),
    version: integer('version').notNull(),
    status: text('status').notNull().default('published'),
    name: text('name').notNull(),
    description: text('description'),
    versionNotes: text('version_notes'),
    draftRevision: integer('draft_revision').notNull().default(0),
    createdAt: text('created_at').notNull().default(utcNow),
    updatedAt: text('updated_at').notNull().default(utcNow),
  },
  table => ({
    treeKeyVersionUnique: uniqueIndex('workflow_trees_tree_key_version_uq').on(table.treeKey, table.version),
    singleDraftPerTreeUnique: uniqueIndex('workflow_trees_tree_key_single_draft_uq')
      .on(table.treeKey)
      .where(sql`${table.status} = 'draft'`),
    statusCheck: check('workflow_trees_status_ck', sql`${table.status} in ('draft', 'published')`),
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

export const repositories = sqliteTable(
  'repositories',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    provider: text('provider').notNull(),
    remoteUrl: text('remote_url').notNull(),
    remoteRef: text('remote_ref').notNull(),
    defaultBranch: text('default_branch').notNull().default('main'),
    branchTemplate: text('branch_template'),
    localPath: text('local_path'),
    cloneStatus: text('clone_status').notNull().default('pending'),
    createdAt: text('created_at').notNull().default(utcNow),
    updatedAt: text('updated_at').notNull().default(utcNow),
  },
  table => ({
    nameUnique: uniqueIndex('repositories_name_uq').on(table.name),
    providerCheck: check('repositories_provider_ck', sql`${table.provider} in ('github', 'azure-devops')`),
    cloneStatusCheck: check('repositories_clone_status_ck', sql`${table.cloneStatus} in ('pending', 'cloned', 'error')`),
    createdAtIdx: index('repositories_created_at_idx').on(table.createdAt),
  }),
);

export const workItems = sqliteTable(
  'work_items',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    repositoryId: integer('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'restrict' }),
    type: text('type').notNull(),
    status: text('status').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    parentId: integer('parent_id'),
    tags: text('tags', { mode: 'json' }),
    plannedFiles: text('planned_files', { mode: 'json' }),
    assignees: text('assignees', { mode: 'json' }),
    priority: integer('priority'),
    estimate: integer('estimate'),
    revision: integer('revision').notNull().default(0),
    createdAt: text('created_at').notNull().default(utcNow),
    updatedAt: text('updated_at').notNull().default(utcNow),
  },
  table => ({
    parentFk: foreignKey({
      columns: [table.parentId],
      foreignColumns: [table.id],
      name: 'work_items_parent_id_fk',
    }).onDelete('cascade'),
    typeCheck: check('work_items_type_ck', sql`${table.type} in (${sqlEnumValues(workItemTypes)})`),
    statusCheck: check(
      'work_items_status_ck',
      sql`(
        (${table.type} = 'epic' and ${table.status} in (${sqlEnumValues(epicWorkItemStatuses)}))
        or (${table.type} = 'feature' and ${table.status} in (${sqlEnumValues(featureWorkItemStatuses)}))
        or (${table.type} = 'story' and ${table.status} in (${sqlEnumValues(storyWorkItemStatuses)}))
        or (${table.type} = 'task' and ${table.status} in (${sqlEnumValues(taskWorkItemStatuses)}))
      )`,
    ),
    titleNotEmptyCheck: check('work_items_title_not_empty_ck', sql`${table.title} <> ''`),
    revisionNonNegativeCheck: check('work_items_revision_non_negative_ck', sql`${table.revision} >= 0`),
    parentSelfCheck: check(
      'work_items_parent_self_ck',
      sql`${table.parentId} is null or ${table.parentId} <> ${table.id}`,
    ),
    repositoryStatusIdx: index('work_items_repository_id_status_idx').on(table.repositoryId, table.status),
    repositoryParentIdx: index('work_items_repository_id_parent_id_idx').on(table.repositoryId, table.parentId),
  }),
);

export const workItemEvents = sqliteTable(
  'work_item_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    repositoryId: integer('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'restrict' }),
    workItemId: integer('work_item_id')
      .notNull()
      .references(() => workItems.id, { onDelete: 'cascade' }),
    eventType: text('event_type').notNull(),
    actorType: text('actor_type').notNull(),
    actorLabel: text('actor_label').notNull(),
    payload: text('payload', { mode: 'json' }).notNull(),
    createdAt: text('created_at').notNull().default(utcNow),
  },
  table => ({
    eventTypeCheck: check('work_item_events_event_type_ck', sql`${table.eventType} in (${sqlEnumValues(workItemEventTypes)})`),
    actorTypeCheck: check('work_item_events_actor_type_ck', sql`${table.actorType} in (${sqlEnumValues(workItemActorTypes)})`),
    actorLabelNotEmptyCheck: check('work_item_events_actor_label_not_empty_ck', sql`${table.actorLabel} <> ''`),
    workItemCreatedAtIdx: index('work_item_events_work_item_id_created_at_idx').on(table.workItemId, table.createdAt),
    repoCreatedAtIdx: index('work_item_events_repository_id_created_at_idx').on(table.repositoryId, table.createdAt),
    createdAtIdx: index('work_item_events_created_at_idx').on(table.createdAt),
  }),
);

export const workItemPolicies = sqliteTable(
  'work_item_policies',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    repositoryId: integer('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'restrict' }),
    epicWorkItemId: integer('epic_work_item_id').references(() => workItems.id, { onDelete: 'cascade' }),
    payload: text('payload', { mode: 'json' }).notNull(),
    createdAt: text('created_at').notNull().default(utcNow),
    updatedAt: text('updated_at').notNull().default(utcNow),
  },
  table => ({
    singleRepoPolicyUnique: uniqueIndex('work_item_policies_repo_single_uq')
      .on(table.repositoryId)
      .where(sql`${table.epicWorkItemId} is null`),
    singleEpicOverrideUnique: uniqueIndex('work_item_policies_repo_epic_uq')
      .on(table.repositoryId, table.epicWorkItemId)
      .where(sql`${table.epicWorkItemId} is not null`),
    repositoryEpicIdx: index('work_item_policies_repository_id_epic_work_item_id_idx').on(
      table.repositoryId,
      table.epicWorkItemId,
    ),
    repositoryIdx: index('work_item_policies_repository_id_idx').on(table.repositoryId),
  }),
);

export const agentModels = sqliteTable(
  'agent_models',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    provider: text('provider').notNull(),
    modelKey: text('model_key').notNull(),
    displayName: text('display_name').notNull(),
    sortOrder: integer('sort_order').notNull().default(100),
    isDefault: integer('is_default').notNull().default(0),
    createdAt: text('created_at').notNull().default(utcNow),
    updatedAt: text('updated_at').notNull().default(utcNow),
  },
  table => ({
    providerModelUnique: uniqueIndex('agent_models_provider_model_key_uq').on(table.provider, table.modelKey),
    defaultPerProviderUnique: uniqueIndex('agent_models_provider_default_uq')
      .on(table.provider)
      .where(sql`${table.isDefault} = 1`),
    providerCheck: check('agent_models_provider_ck', sql`${table.provider} in ('claude', 'codex')`),
    isDefaultCheck: check('agent_models_is_default_ck', sql`${table.isDefault} in (0, 1)`),
    sortOrderCheck: check('agent_models_sort_order_ck', sql`${table.sortOrder} >= 0`),
    providerSortIdx: index('agent_models_provider_sort_idx').on(table.provider, table.sortOrder, table.modelKey),
    createdAtIdx: index('agent_models_created_at_idx').on(table.createdAt),
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

export const runWorktrees = sqliteTable(
  'run_worktrees',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    workflowRunId: integer('workflow_run_id')
      .notNull()
      .references(() => workflowRuns.id, { onDelete: 'cascade' }),
    repositoryId: integer('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'restrict' }),
    worktreePath: text('worktree_path').notNull(),
    branch: text('branch').notNull(),
    commitHash: text('commit_hash'),
    status: text('status').notNull().default('active'),
    createdAt: text('created_at').notNull().default(utcNow),
    removedAt: text('removed_at'),
  },
  table => ({
    statusCheck: check('run_worktrees_status_ck', sql`${table.status} in ('active', 'removed')`),
    removalTimestampCheck: check(
      'run_worktrees_removal_timestamp_ck',
      sql`(
        ${table.status} = 'active'
        and ${table.removedAt} is null
      ) or (
        ${table.status} = 'removed'
        and ${table.removedAt} is not null
      )`,
    ),
    runStatusIdx: index('run_worktrees_run_id_status_idx').on(table.workflowRunId, table.status),
    repositoryStatusIdx: index('run_worktrees_repository_id_status_idx').on(table.repositoryId, table.status),
    createdAtIdx: index('run_worktrees_created_at_idx').on(table.createdAt),
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
    displayName: text('display_name'),
    nodeType: text('node_type').notNull(),
    provider: text('provider'),
    model: text('model'),
    executionPermissions: text('execution_permissions', { mode: 'json' }),
    errorHandlerConfig: text('error_handler_config', { mode: 'json' }),
    promptTemplateId: integer('prompt_template_id').references(() => promptTemplates.id, { onDelete: 'restrict' }),
    nodeRole: text('node_role').notNull().default('standard'),
    maxChildren: integer('max_children').notNull().default(12),
    maxRetries: integer('max_retries').notNull().default(0),
    sequenceIndex: integer('sequence_index').notNull(),
    positionX: integer('position_x'),
    positionY: integer('position_y'),
    createdAt: text('created_at').notNull().default(utcNow),
    updatedAt: text('updated_at').notNull().default(utcNow),
  },
  table => ({
    treeNodeKeyUnique: uniqueIndex('tree_nodes_tree_id_node_key_uq').on(table.workflowTreeId, table.nodeKey),
    treeSequenceUnique: uniqueIndex('tree_nodes_tree_id_sequence_uq').on(table.workflowTreeId, table.sequenceIndex),
    nodeTypeCheck: check('tree_nodes_node_type_ck', sql`${table.nodeType} in ('agent', 'human', 'tool')`),
    nodeRoleCheck: check('tree_nodes_node_role_ck', sql`${table.nodeRole} in ('standard', 'spawner', 'join')`),
    nodeRoleAgentCheck: check(
      'tree_nodes_node_role_agent_ck',
      sql`(${table.nodeRole} not in ('spawner', 'join')) or (${table.nodeType} = 'agent')`,
    ),
    providerForAgentCheck: check(
      'tree_nodes_provider_for_agent_ck',
      sql`(${table.nodeType} <> 'agent') or (${table.provider} is not null)`,
    ),
    maxChildrenCheck: check('tree_nodes_max_children_ck', sql`${table.maxChildren} >= 0`),
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
    routeOn: text('route_on').notNull().default('success'),
    priority: integer('priority').notNull(),
    auto: integer('auto').notNull().default(0),
    guardDefinitionId: integer('guard_definition_id').references(() => guardDefinitions.id, { onDelete: 'restrict' }),
    createdAt: text('created_at').notNull().default(utcNow),
  },
  table => ({
    sourcePriorityUnique: uniqueIndex('tree_edges_source_priority_uq').on(table.sourceNodeId, table.routeOn, table.priority),
    routeOnCheck: check('tree_edges_route_on_ck', sql`${table.routeOn} in ('success', 'failure')`),
    autoBooleanCheck: check('tree_edges_auto_bool_ck', sql`${table.auto} in (0, 1)`),
    priorityCheck: check('tree_edges_priority_ck', sql`${table.priority} >= 0`),
    transitionModeCheck: check(
      'tree_edges_transition_mode_ck',
      sql`(
        ${table.routeOn} = 'success' and (
          (${table.auto} = 1 and ${table.guardDefinitionId} is null)
          or
          (${table.auto} = 0 and ${table.guardDefinitionId} is not null)
        )
      ) or (
        ${table.routeOn} = 'failure' and ${table.auto} = 1 and ${table.guardDefinitionId} is null
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
    nodeRole: text('node_role').notNull().default('standard'),
    nodeType: text('node_type').notNull().default('agent'),
    provider: text('provider'),
    model: text('model'),
    prompt: text('prompt'),
    promptContentType: text('prompt_content_type').notNull().default('markdown'),
    executionPermissions: text('execution_permissions', { mode: 'json' }),
    errorHandlerConfig: text('error_handler_config', { mode: 'json' }),
    maxChildren: integer('max_children').notNull().default(12),
    maxRetries: integer('max_retries').notNull().default(0),
    spawnerNodeId: integer('spawner_node_id'),
    joinNodeId: integer('join_node_id'),
    lineageDepth: integer('lineage_depth').notNull().default(0),
    sequencePath: text('sequence_path'),
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
    runNodeSpawnerFk: foreignKey({
      columns: [table.workflowRunId, table.spawnerNodeId],
      foreignColumns: [table.workflowRunId, table.id],
      name: 'run_nodes_run_id_spawner_node_id_fk',
    }).onDelete('set null'),
    runNodeJoinFk: foreignKey({
      columns: [table.workflowRunId, table.joinNodeId],
      foreignColumns: [table.workflowRunId, table.id],
      name: 'run_nodes_run_id_join_node_id_fk',
    }).onDelete('set null'),
    nodeRoleCheck: check('run_nodes_node_role_ck', sql`${table.nodeRole} in ('standard', 'spawner', 'join')`),
    nodeTypeCheck: check('run_nodes_node_type_ck', sql`${table.nodeType} in ('agent', 'human', 'tool')`),
    promptContentTypeCheck: check(
      'run_nodes_prompt_content_type_ck',
      sql`${table.promptContentType} in ('text', 'markdown')`,
    ),
    maxRetriesCheck: check('run_nodes_max_retries_ck', sql`${table.maxRetries} >= 0`),
    maxChildrenCheck: check('run_nodes_max_children_ck', sql`${table.maxChildren} >= 0`),
    lineageDepthCheck: check('run_nodes_lineage_depth_ck', sql`${table.lineageDepth} >= 0`),
    statusCheck: check(
      'run_nodes_status_ck',
      sql`${table.status} in ('pending', 'running', 'completed', 'failed', 'skipped', 'cancelled')`,
    ),
    attemptCheck: check('run_nodes_attempt_ck', sql`${table.attempt} > 0`),
    pendingStartedAtCheck: check(
      'run_nodes_pending_started_at_ck',
      sql`(${table.status} <> 'pending') or (${table.startedAt} is null)`,
    ),
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
    runSpawnerIdx: index('run_nodes_run_id_spawner_node_idx').on(table.workflowRunId, table.spawnerNodeId),
    runJoinIdx: index('run_nodes_run_id_join_node_idx').on(table.workflowRunId, table.joinNodeId),
    nodeKeyIdx: index('run_nodes_node_key_idx').on(table.nodeKey),
    createdAtIdx: index('run_nodes_created_at_idx').on(table.createdAt),
  }),
);

export const runNodeEdges = sqliteTable(
  'run_node_edges',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    workflowRunId: integer('workflow_run_id')
      .notNull()
      .references(() => workflowRuns.id, { onDelete: 'cascade' }),
    sourceRunNodeId: integer('source_run_node_id')
      .notNull()
      .references(() => runNodes.id, { onDelete: 'cascade' }),
    targetRunNodeId: integer('target_run_node_id')
      .notNull()
      .references(() => runNodes.id, { onDelete: 'cascade' }),
    routeOn: text('route_on').notNull().default('success'),
    auto: integer('auto').notNull().default(1),
    guardExpression: text('guard_expression', { mode: 'json' }),
    priority: integer('priority').notNull().default(0),
    edgeKind: text('edge_kind').notNull().default('tree'),
    createdAt: text('created_at').notNull().default(utcNow),
  },
  table => ({
    sourceRunNodeBelongsToRunFk: foreignKey({
      columns: [table.workflowRunId, table.sourceRunNodeId],
      foreignColumns: [runNodes.workflowRunId, runNodes.id],
      name: 'run_node_edges_source_run_node_fk',
    }).onDelete('cascade'),
    targetRunNodeBelongsToRunFk: foreignKey({
      columns: [table.workflowRunId, table.targetRunNodeId],
      foreignColumns: [runNodes.workflowRunId, runNodes.id],
      name: 'run_node_edges_target_run_node_fk',
    }).onDelete('cascade'),
    routeOnCheck: check('run_node_edges_route_on_ck', sql`${table.routeOn} in ('success', 'failure', 'terminal')`),
    autoBooleanCheck: check('run_node_edges_auto_bool_ck', sql`${table.auto} in (0, 1)`),
    priorityCheck: check('run_node_edges_priority_ck', sql`${table.priority} >= 0`),
    edgeKindCheck: check(
      'run_node_edges_kind_ck',
      sql`${table.edgeKind} in ('tree', 'dynamic_spawner_to_child', 'dynamic_child_to_join')`,
    ),
    edgeUnique: uniqueIndex('run_node_edges_unique_uq').on(
      table.workflowRunId,
      table.sourceRunNodeId,
      table.routeOn,
      table.priority,
      table.targetRunNodeId,
    ),
    targetLookupIdx: index('run_node_edges_run_id_target_idx').on(table.workflowRunId, table.targetRunNodeId),
    sourceLookupIdx: index('run_node_edges_run_id_source_idx').on(table.workflowRunId, table.sourceRunNodeId),
    createdAtIdx: index('run_node_edges_created_at_idx').on(table.createdAt),
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

export const runJoinBarriers = sqliteTable(
  'run_join_barriers',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    workflowRunId: integer('workflow_run_id')
      .notNull()
      .references(() => workflowRuns.id, { onDelete: 'cascade' }),
    spawnerRunNodeId: integer('spawner_run_node_id')
      .notNull()
      .references(() => runNodes.id, { onDelete: 'cascade' }),
    joinRunNodeId: integer('join_run_node_id')
      .notNull()
      .references(() => runNodes.id, { onDelete: 'cascade' }),
    spawnSourceArtifactId: integer('spawn_source_artifact_id')
      .notNull()
      .references(() => phaseArtifacts.id, { onDelete: 'cascade' }),
    expectedChildren: integer('expected_children').notNull(),
    terminalChildren: integer('terminal_children').notNull().default(0),
    completedChildren: integer('completed_children').notNull().default(0),
    failedChildren: integer('failed_children').notNull().default(0),
    status: text('status').notNull().default('pending'),
    createdAt: text('created_at').notNull().default(utcNow),
    updatedAt: text('updated_at').notNull().default(utcNow),
    releasedAt: text('released_at'),
  },
  table => ({
    spawnerRunNodeBelongsToRunFk: foreignKey({
      columns: [table.workflowRunId, table.spawnerRunNodeId],
      foreignColumns: [runNodes.workflowRunId, runNodes.id],
      name: 'run_join_barriers_spawner_run_node_fk',
    }).onDelete('cascade'),
    joinRunNodeBelongsToRunFk: foreignKey({
      columns: [table.workflowRunId, table.joinRunNodeId],
      foreignColumns: [runNodes.workflowRunId, runNodes.id],
      name: 'run_join_barriers_join_run_node_fk',
    }).onDelete('cascade'),
    expectedChildrenCheck: check('run_join_barriers_expected_children_ck', sql`${table.expectedChildren} >= 0`),
    terminalChildrenCheck: check('run_join_barriers_terminal_children_ck', sql`${table.terminalChildren} >= 0`),
    completedChildrenCheck: check('run_join_barriers_completed_children_ck', sql`${table.completedChildren} >= 0`),
    failedChildrenCheck: check('run_join_barriers_failed_children_ck', sql`${table.failedChildren} >= 0`),
    terminalWithinExpectedCheck: check(
      'run_join_barriers_terminal_within_expected_ck',
      sql`${table.terminalChildren} <= ${table.expectedChildren}`,
    ),
    completedWithinExpectedCheck: check(
      'run_join_barriers_completed_within_expected_ck',
      sql`${table.completedChildren} <= ${table.expectedChildren}`,
    ),
    failedWithinExpectedCheck: check(
      'run_join_barriers_failed_within_expected_ck',
      sql`${table.failedChildren} <= ${table.expectedChildren}`,
    ),
    completedFailedWithinTerminalCheck: check(
      'run_join_barriers_completed_failed_within_terminal_ck',
      sql`${table.completedChildren} + ${table.failedChildren} <= ${table.terminalChildren}`,
    ),
    statusCheck: check('run_join_barriers_status_ck', sql`${table.status} in ('pending', 'ready', 'released', 'cancelled')`),
    spawnUnique: uniqueIndex('run_join_barriers_spawn_uq').on(
      table.workflowRunId,
      table.spawnerRunNodeId,
      table.spawnSourceArtifactId,
    ),
    joinStatusIdx: index('run_join_barriers_run_id_join_status_idx').on(table.workflowRunId, table.joinRunNodeId, table.status),
    createdAtIdx: index('run_join_barriers_created_at_idx').on(table.createdAt),
  }),
);

export const runNodeDiagnostics = sqliteTable(
  'run_node_diagnostics',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    workflowRunId: integer('workflow_run_id')
      .notNull()
      .references(() => workflowRuns.id, { onDelete: 'cascade' }),
    runNodeId: integer('run_node_id')
      .notNull()
      .references(() => runNodes.id, { onDelete: 'cascade' }),
    attempt: integer('attempt').notNull(),
    outcome: text('outcome').notNull(),
    eventCount: integer('event_count').notNull().default(0),
    retainedEventCount: integer('retained_event_count').notNull().default(0),
    droppedEventCount: integer('dropped_event_count').notNull().default(0),
    redacted: integer('redacted').notNull().default(0),
    truncated: integer('truncated').notNull().default(0),
    payloadChars: integer('payload_chars').notNull().default(0),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    cachedInputTokens: integer('cached_input_tokens'),
    diagnostics: text('diagnostics', { mode: 'json' }).notNull(),
    createdAt: text('created_at').notNull().default(utcNow),
  },
  table => ({
    runNodeBelongsToRunFk: foreignKey({
      columns: [table.workflowRunId, table.runNodeId],
      foreignColumns: [runNodes.workflowRunId, runNodes.id],
      name: 'run_node_diagnostics_run_id_run_node_id_fk',
    }).onDelete('cascade'),
    runNodeAttemptUnique: uniqueIndex('run_node_diagnostics_run_id_run_node_attempt_uq').on(
      table.workflowRunId,
      table.runNodeId,
      table.attempt,
    ),
    attemptCheck: check('run_node_diagnostics_attempt_ck', sql`${table.attempt} > 0`),
    outcomeCheck: check('run_node_diagnostics_outcome_ck', sql`${table.outcome} in ('completed', 'failed')`),
    eventCountCheck: check('run_node_diagnostics_event_count_ck', sql`${table.eventCount} >= 0`),
    retainedEventCountCheck: check(
      'run_node_diagnostics_retained_event_count_ck',
      sql`${table.retainedEventCount} >= 0`,
    ),
    droppedEventCountCheck: check(
      'run_node_diagnostics_dropped_event_count_ck',
      sql`${table.droppedEventCount} >= 0`,
    ),
    payloadCharsCheck: check('run_node_diagnostics_payload_chars_ck', sql`${table.payloadChars} >= 0`),
    inputTokensCheck: check(
      'run_node_diagnostics_input_tokens_ck',
      sql`${table.inputTokens} is null or ${table.inputTokens} >= 0`,
    ),
    outputTokensCheck: check(
      'run_node_diagnostics_output_tokens_ck',
      sql`${table.outputTokens} is null or ${table.outputTokens} >= 0`,
    ),
    cachedInputTokensCheck: check(
      'run_node_diagnostics_cached_input_tokens_ck',
      sql`${table.cachedInputTokens} is null or ${table.cachedInputTokens} >= 0`,
    ),
    redactedBoolCheck: check('run_node_diagnostics_redacted_bool_ck', sql`${table.redacted} in (0, 1)`),
    truncatedBoolCheck: check('run_node_diagnostics_truncated_bool_ck', sql`${table.truncated} in (0, 1)`),
    runCreatedAtIdx: index('run_node_diagnostics_run_id_created_at_idx').on(table.workflowRunId, table.createdAt),
    runNodeCreatedAtIdx: index('run_node_diagnostics_run_node_id_created_at_idx').on(table.runNodeId, table.createdAt),
    createdAtIdx: index('run_node_diagnostics_created_at_idx').on(table.createdAt),
  }),
);

export const runNodeStreamEvents = sqliteTable(
  'run_node_stream_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    workflowRunId: integer('workflow_run_id')
      .notNull()
      .references(() => workflowRuns.id, { onDelete: 'cascade' }),
    runNodeId: integer('run_node_id')
      .notNull()
      .references(() => runNodes.id, { onDelete: 'cascade' }),
    attempt: integer('attempt').notNull(),
    sequence: integer('sequence').notNull(),
    eventType: text('event_type').notNull(),
    timestamp: integer('timestamp').notNull(),
    contentChars: integer('content_chars').notNull().default(0),
    contentPreview: text('content_preview').notNull(),
    metadata: text('metadata', { mode: 'json' }),
    usageDeltaTokens: integer('usage_delta_tokens'),
    usageCumulativeTokens: integer('usage_cumulative_tokens'),
    createdAt: text('created_at').notNull().default(utcNow),
  },
  table => ({
    runNodeBelongsToRunFk: foreignKey({
      columns: [table.workflowRunId, table.runNodeId],
      foreignColumns: [runNodes.workflowRunId, runNodes.id],
      name: 'run_node_stream_events_run_id_run_node_id_fk',
    }).onDelete('cascade'),
    runNodeAttemptSequenceUnique: uniqueIndex('run_node_stream_events_run_id_run_node_attempt_seq_uq').on(
      table.workflowRunId,
      table.runNodeId,
      table.attempt,
      table.sequence,
    ),
    attemptCheck: check('run_node_stream_events_attempt_ck', sql`${table.attempt} > 0`),
    sequenceCheck: check('run_node_stream_events_sequence_ck', sql`${table.sequence} > 0`),
    eventTypeCheck: check(
      'run_node_stream_events_event_type_ck',
      sql`${table.eventType} in ('system', 'assistant', 'tool_use', 'tool_result', 'usage', 'result')`,
    ),
    contentCharsCheck: check('run_node_stream_events_content_chars_ck', sql`${table.contentChars} >= 0`),
    usageDeltaTokensCheck: check(
      'run_node_stream_events_usage_delta_tokens_ck',
      sql`${table.usageDeltaTokens} is null or ${table.usageDeltaTokens} >= 0`,
    ),
    usageCumulativeTokensCheck: check(
      'run_node_stream_events_usage_cumulative_tokens_ck',
      sql`${table.usageCumulativeTokens} is null or ${table.usageCumulativeTokens} >= 0`,
    ),
    runAttemptSequenceIdx: index('run_node_stream_events_run_id_attempt_sequence_idx').on(
      table.workflowRunId,
      table.runNodeId,
      table.attempt,
      table.sequence,
    ),
    runCreatedAtIdx: index('run_node_stream_events_run_id_created_at_idx').on(table.workflowRunId, table.createdAt),
    runNodeCreatedAtIdx: index('run_node_stream_events_run_node_id_created_at_idx').on(table.runNodeId, table.createdAt),
    createdAtIdx: index('run_node_stream_events_created_at_idx').on(table.createdAt),
  }),
);
