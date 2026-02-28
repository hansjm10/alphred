import type { AlphredDatabase } from './connection.js';
import { sql } from 'drizzle-orm';

export function migrateDatabase(db: AlphredDatabase): void {
  db.transaction((tx) => {
    tx.run(sql`CREATE TABLE IF NOT EXISTS workflow_trees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tree_key TEXT NOT NULL,
    version INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'published',
    name TEXT NOT NULL,
    description TEXT,
    version_notes TEXT,
    draft_revision INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    CONSTRAINT workflow_trees_status_ck
      CHECK (status IN ('draft', 'published'))
  )`);
  const hasWorkflowTreeStatusColumn =
    tx.get<{ count: number }>(
      sql`SELECT COUNT(*) AS count FROM pragma_table_info('workflow_trees') WHERE name = 'status'`,
    )?.count ?? 0;
  if (hasWorkflowTreeStatusColumn === 0) {
    tx.run(sql`ALTER TABLE workflow_trees ADD COLUMN status TEXT NOT NULL DEFAULT 'published'`);
  }
  const hasWorkflowTreeVersionNotesColumn =
    tx.get<{ count: number }>(
      sql`SELECT COUNT(*) AS count FROM pragma_table_info('workflow_trees') WHERE name = 'version_notes'`,
    )?.count ?? 0;
  if (hasWorkflowTreeVersionNotesColumn === 0) {
    tx.run(sql`ALTER TABLE workflow_trees ADD COLUMN version_notes TEXT`);
  }
  const hasWorkflowTreeDraftRevisionColumn =
    tx.get<{ count: number }>(
      sql`SELECT COUNT(*) AS count FROM pragma_table_info('workflow_trees') WHERE name = 'draft_revision'`,
    )?.count ?? 0;
  if (hasWorkflowTreeDraftRevisionColumn === 0) {
    tx.run(sql`ALTER TABLE workflow_trees ADD COLUMN draft_revision INTEGER NOT NULL DEFAULT 0`);
  }
  tx.run(sql`CREATE UNIQUE INDEX IF NOT EXISTS workflow_trees_tree_key_version_uq
    ON workflow_trees(tree_key, version)`);
  tx.run(sql`CREATE UNIQUE INDEX IF NOT EXISTS workflow_trees_tree_key_single_draft_uq
    ON workflow_trees(tree_key)
    WHERE status = 'draft'`);
  tx.run(sql`CREATE INDEX IF NOT EXISTS workflow_trees_created_at_idx
    ON workflow_trees(created_at)`);

  tx.run(sql`CREATE TABLE IF NOT EXISTS prompt_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    template_key TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    content TEXT NOT NULL,
    content_type TEXT NOT NULL DEFAULT 'markdown',
    metadata TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    CONSTRAINT prompt_templates_content_type_ck
      CHECK (content_type IN ('text', 'markdown'))
  )`);
  tx.run(sql`CREATE UNIQUE INDEX IF NOT EXISTS prompt_templates_template_key_version_uq
    ON prompt_templates(template_key, version)`);
  tx.run(sql`CREATE INDEX IF NOT EXISTS prompt_templates_created_at_idx
    ON prompt_templates(created_at)`);

  tx.run(sql`CREATE TABLE IF NOT EXISTS guard_definitions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guard_key TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    expression TEXT NOT NULL,
    description TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`);
  tx.run(sql`CREATE UNIQUE INDEX IF NOT EXISTS guard_definitions_guard_key_version_uq
    ON guard_definitions(guard_key, version)`);
  tx.run(sql`CREATE INDEX IF NOT EXISTS guard_definitions_created_at_idx
    ON guard_definitions(created_at)`);

  tx.run(sql`CREATE TABLE IF NOT EXISTS repositories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    provider TEXT NOT NULL,
    remote_url TEXT NOT NULL,
    remote_ref TEXT NOT NULL,
    default_branch TEXT NOT NULL DEFAULT 'main',
    branch_template TEXT,
    local_path TEXT,
    clone_status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    CONSTRAINT repositories_provider_ck
      CHECK (provider IN ('github', 'azure-devops')),
    CONSTRAINT repositories_clone_status_ck
      CHECK (clone_status IN ('pending', 'cloned', 'error'))
  )`);
  const hasBranchTemplateColumn =
    tx.get<{ count: number }>(
      sql`SELECT COUNT(*) AS count FROM pragma_table_info('repositories') WHERE name = 'branch_template'`,
    )?.count ?? 0;
  if (hasBranchTemplateColumn === 0) {
    tx.run(sql`ALTER TABLE repositories ADD COLUMN branch_template TEXT`);
  }
  tx.run(sql`CREATE UNIQUE INDEX IF NOT EXISTS repositories_name_uq
    ON repositories(name)`);
  tx.run(sql`DROP INDEX IF EXISTS repositories_name_idx`);
  tx.run(sql`CREATE INDEX IF NOT EXISTS repositories_created_at_idx
    ON repositories(created_at)`);

  tx.run(sql`CREATE TABLE IF NOT EXISTS agent_models (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL,
    model_key TEXT NOT NULL,
    display_name TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 100,
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    CONSTRAINT agent_models_provider_ck
      CHECK (provider IN ('claude', 'codex')),
    CONSTRAINT agent_models_is_default_ck
      CHECK (is_default IN (0, 1)),
    CONSTRAINT agent_models_sort_order_ck
      CHECK (sort_order >= 0)
  )`);
  tx.run(sql`CREATE UNIQUE INDEX IF NOT EXISTS agent_models_provider_model_key_uq
    ON agent_models(provider, model_key)`);
  tx.run(sql`CREATE UNIQUE INDEX IF NOT EXISTS agent_models_provider_default_uq
    ON agent_models(provider)
    WHERE is_default = 1`);
  tx.run(sql`CREATE INDEX IF NOT EXISTS agent_models_provider_sort_idx
    ON agent_models(provider, sort_order, model_key)`);
  tx.run(sql`CREATE INDEX IF NOT EXISTS agent_models_created_at_idx
    ON agent_models(created_at)`);
  tx.run(sql`UPDATE agent_models
    SET is_default = 0,
        updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    WHERE provider IN ('codex', 'claude')`);
  tx.run(sql`INSERT INTO agent_models(provider, model_key, display_name, sort_order, is_default)
    VALUES
      ('codex', 'gpt-5.3-codex', 'GPT-5.3-Codex', 10, 1),
      ('codex', 'gpt-5-codex', 'GPT-5-Codex', 20, 0),
      ('codex', 'gpt-5-codex-mini', 'GPT-5-Codex-Mini', 30, 0),
      ('claude', 'claude-3-7-sonnet-latest', 'Claude 3.7 Sonnet (Latest)', 10, 1),
      ('claude', 'claude-3-5-haiku-latest', 'Claude 3.5 Haiku (Latest)', 20, 0)
    ON CONFLICT(provider, model_key) DO UPDATE SET
      display_name = excluded.display_name,
      sort_order = excluded.sort_order,
      is_default = excluded.is_default,
      updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ','now'))`);

  tx.run(sql`CREATE TABLE IF NOT EXISTS workflow_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_tree_id INTEGER NOT NULL REFERENCES workflow_trees(id) ON DELETE RESTRICT,
    status TEXT NOT NULL DEFAULT 'pending',
    started_at TEXT,
    completed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    CONSTRAINT workflow_runs_status_ck
      CHECK (status IN ('pending', 'running', 'paused', 'completed', 'failed', 'cancelled')),
    CONSTRAINT workflow_runs_completion_timestamp_ck
      CHECK (
        (status IN ('pending', 'running', 'paused') AND completed_at IS NULL)
        OR
        (status IN ('completed', 'failed', 'cancelled') AND completed_at IS NOT NULL)
      )
  )`);
  tx.run(sql`CREATE INDEX IF NOT EXISTS workflow_runs_created_at_idx
    ON workflow_runs(created_at)`);

  tx.run(sql`CREATE TABLE IF NOT EXISTS run_worktrees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_run_id INTEGER NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
    repository_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE RESTRICT,
    worktree_path TEXT NOT NULL,
    branch TEXT NOT NULL,
    commit_hash TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    removed_at TEXT,
    CONSTRAINT run_worktrees_status_ck
      CHECK (status IN ('active', 'removed')),
    CONSTRAINT run_worktrees_removal_timestamp_ck
      CHECK (
        (status = 'active' AND removed_at IS NULL)
        OR
        (status = 'removed' AND removed_at IS NOT NULL)
      )
  )`);
  tx.run(sql`CREATE INDEX IF NOT EXISTS run_worktrees_run_id_status_idx
    ON run_worktrees(workflow_run_id, status)`);
  tx.run(sql`CREATE INDEX IF NOT EXISTS run_worktrees_repository_id_status_idx
    ON run_worktrees(repository_id, status)`);
  tx.run(sql`CREATE INDEX IF NOT EXISTS run_worktrees_created_at_idx
    ON run_worktrees(created_at)`);

  tx.run(sql`CREATE TABLE IF NOT EXISTS tree_nodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_tree_id INTEGER NOT NULL REFERENCES workflow_trees(id) ON DELETE CASCADE,
    node_key TEXT NOT NULL,
    display_name TEXT,
    node_type TEXT NOT NULL,
    provider TEXT,
    model TEXT,
    execution_permissions TEXT,
    error_handler_config TEXT,
    prompt_template_id INTEGER REFERENCES prompt_templates(id) ON DELETE RESTRICT,
    node_role TEXT NOT NULL DEFAULT 'standard',
    max_children INTEGER NOT NULL DEFAULT 12,
    max_retries INTEGER NOT NULL DEFAULT 0,
    sequence_index INTEGER NOT NULL,
    position_x INTEGER,
    position_y INTEGER,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    CONSTRAINT tree_nodes_node_type_ck
      CHECK (node_type IN ('agent', 'human', 'tool')),
    CONSTRAINT tree_nodes_node_role_ck
      CHECK (node_role IN ('standard', 'spawner', 'join')),
    CONSTRAINT tree_nodes_node_role_agent_ck
      CHECK ((node_role NOT IN ('spawner', 'join')) OR (node_type = 'agent')),
    CONSTRAINT tree_nodes_provider_for_agent_ck
      CHECK ((node_type <> 'agent') OR (provider IS NOT NULL)),
    CONSTRAINT tree_nodes_max_children_ck
      CHECK (max_children >= 0),
    CONSTRAINT tree_nodes_max_retries_ck
      CHECK (max_retries >= 0)
  )`);
  const hasTreeNodesDisplayNameColumn =
    tx.get<{ count: number }>(
      sql`SELECT COUNT(*) AS count FROM pragma_table_info('tree_nodes') WHERE name = 'display_name'`,
    )?.count ?? 0;
  if (hasTreeNodesDisplayNameColumn === 0) {
    tx.run(sql`ALTER TABLE tree_nodes ADD COLUMN display_name TEXT`);
  }
  const hasTreeNodesPositionXColumn =
    tx.get<{ count: number }>(
      sql`SELECT COUNT(*) AS count FROM pragma_table_info('tree_nodes') WHERE name = 'position_x'`,
    )?.count ?? 0;
  if (hasTreeNodesPositionXColumn === 0) {
    tx.run(sql`ALTER TABLE tree_nodes ADD COLUMN position_x INTEGER`);
  }
  const hasTreeNodesPositionYColumn =
    tx.get<{ count: number }>(
      sql`SELECT COUNT(*) AS count FROM pragma_table_info('tree_nodes') WHERE name = 'position_y'`,
    )?.count ?? 0;
  if (hasTreeNodesPositionYColumn === 0) {
    tx.run(sql`ALTER TABLE tree_nodes ADD COLUMN position_y INTEGER`);
  }
  const hasTreeNodesModelColumn =
    tx.get<{ count: number }>(
      sql`SELECT COUNT(*) AS count FROM pragma_table_info('tree_nodes') WHERE name = 'model'`,
    )?.count ?? 0;
  if (hasTreeNodesModelColumn === 0) {
    tx.run(sql`ALTER TABLE tree_nodes ADD COLUMN model TEXT`);
  }
  const hasTreeNodesExecutionPermissionsColumn =
    tx.get<{ count: number }>(
      sql`SELECT COUNT(*) AS count FROM pragma_table_info('tree_nodes') WHERE name = 'execution_permissions'`,
    )?.count ?? 0;
  if (hasTreeNodesExecutionPermissionsColumn === 0) {
    tx.run(sql`ALTER TABLE tree_nodes ADD COLUMN execution_permissions TEXT`);
  }
  const hasTreeNodesErrorHandlerConfigColumn =
    tx.get<{ count: number }>(
      sql`SELECT COUNT(*) AS count FROM pragma_table_info('tree_nodes') WHERE name = 'error_handler_config'`,
    )?.count ?? 0;
  if (hasTreeNodesErrorHandlerConfigColumn === 0) {
    tx.run(sql`ALTER TABLE tree_nodes ADD COLUMN error_handler_config TEXT`);
  }
  const hasTreeNodesNodeRoleColumn =
    tx.get<{ count: number }>(
      sql`SELECT COUNT(*) AS count FROM pragma_table_info('tree_nodes') WHERE name = 'node_role'`,
    )?.count ?? 0;
  if (hasTreeNodesNodeRoleColumn === 0) {
    tx.run(sql`ALTER TABLE tree_nodes ADD COLUMN node_role TEXT NOT NULL DEFAULT 'standard'`);
  }
  const hasTreeNodesMaxChildrenColumn =
    tx.get<{ count: number }>(
      sql`SELECT COUNT(*) AS count FROM pragma_table_info('tree_nodes') WHERE name = 'max_children'`,
    )?.count ?? 0;
  if (hasTreeNodesMaxChildrenColumn === 0) {
    tx.run(sql`ALTER TABLE tree_nodes ADD COLUMN max_children INTEGER NOT NULL DEFAULT 12`);
  }
  tx.run(sql`UPDATE tree_nodes
    SET node_role = COALESCE(node_role, 'standard'),
        max_children = COALESCE(max_children, 12)`);
  tx.run(sql`UPDATE tree_nodes
    SET model = (
      SELECT agent_models.model_key
      FROM agent_models
      WHERE agent_models.provider = tree_nodes.provider
        AND agent_models.is_default = 1
      LIMIT 1
    )
    WHERE node_type = 'agent'
      AND model IS NULL
      AND provider IS NOT NULL`);
  tx.run(sql`CREATE UNIQUE INDEX IF NOT EXISTS tree_nodes_tree_id_node_key_uq
    ON tree_nodes(workflow_tree_id, node_key)`);
  tx.run(sql`CREATE UNIQUE INDEX IF NOT EXISTS tree_nodes_tree_id_sequence_uq
    ON tree_nodes(workflow_tree_id, sequence_index)`);
  tx.run(sql`CREATE INDEX IF NOT EXISTS tree_nodes_node_key_idx
    ON tree_nodes(node_key)`);
  tx.run(sql`CREATE INDEX IF NOT EXISTS tree_nodes_created_at_idx
    ON tree_nodes(created_at)`);

  tx.run(sql`CREATE TABLE IF NOT EXISTS tree_edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_tree_id INTEGER NOT NULL REFERENCES workflow_trees(id) ON DELETE CASCADE,
    source_node_id INTEGER NOT NULL REFERENCES tree_nodes(id) ON DELETE CASCADE,
    target_node_id INTEGER NOT NULL REFERENCES tree_nodes(id) ON DELETE CASCADE,
    route_on TEXT NOT NULL DEFAULT 'success',
    priority INTEGER NOT NULL,
    auto INTEGER NOT NULL DEFAULT 0,
    guard_definition_id INTEGER REFERENCES guard_definitions(id) ON DELETE RESTRICT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    CONSTRAINT tree_edges_route_on_ck
      CHECK (route_on IN ('success', 'failure')),
    CONSTRAINT tree_edges_auto_bool_ck
      CHECK (auto IN (0, 1)),
    CONSTRAINT tree_edges_priority_ck
      CHECK (priority >= 0),
    CONSTRAINT tree_edges_transition_mode_ck
      CHECK (
        (
          route_on = 'success'
          AND (
            (auto = 1 AND guard_definition_id IS NULL)
            OR
            (auto = 0 AND guard_definition_id IS NOT NULL)
          )
        )
        OR
        (
          route_on = 'failure'
          AND auto = 1
          AND guard_definition_id IS NULL
        )
      )
  )`);
  tx.run(sql`CREATE UNIQUE INDEX IF NOT EXISTS tree_edges_source_priority_uq
    ON tree_edges(source_node_id, route_on, priority)`);
  tx.run(sql`CREATE INDEX IF NOT EXISTS tree_edges_source_node_idx
    ON tree_edges(source_node_id)`);
  tx.run(sql`CREATE INDEX IF NOT EXISTS tree_edges_created_at_idx
    ON tree_edges(created_at)`);

  tx.run(sql`CREATE TRIGGER IF NOT EXISTS tree_edges_same_tree_insert_ck
    BEFORE INSERT ON tree_edges
    FOR EACH ROW
    WHEN (
      (SELECT workflow_tree_id FROM tree_nodes WHERE id = NEW.source_node_id) <> NEW.workflow_tree_id
      OR
      (SELECT workflow_tree_id FROM tree_nodes WHERE id = NEW.target_node_id) <> NEW.workflow_tree_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'tree_edges must reference source and target nodes from the same workflow_tree_id');
    END`);

  tx.run(sql`CREATE TRIGGER IF NOT EXISTS tree_edges_same_tree_update_ck
    BEFORE UPDATE OF workflow_tree_id, source_node_id, target_node_id ON tree_edges
    FOR EACH ROW
    WHEN (
      (SELECT workflow_tree_id FROM tree_nodes WHERE id = NEW.source_node_id) <> NEW.workflow_tree_id
      OR
      (SELECT workflow_tree_id FROM tree_nodes WHERE id = NEW.target_node_id) <> NEW.workflow_tree_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'tree_edges must reference source and target nodes from the same workflow_tree_id');
    END`);

  tx.run(sql`CREATE TRIGGER IF NOT EXISTS tree_nodes_edge_same_tree_update_ck
    BEFORE UPDATE OF workflow_tree_id ON tree_nodes
    FOR EACH ROW
    WHEN (
      NEW.workflow_tree_id <> OLD.workflow_tree_id
      AND EXISTS (
        SELECT 1
        FROM tree_edges
        WHERE
          (source_node_id = NEW.id OR target_node_id = NEW.id)
          AND workflow_tree_id <> NEW.workflow_tree_id
      )
    )
    BEGIN
      SELECT RAISE(ABORT, 'tree_nodes.workflow_tree_id must match workflow_tree_id for connected tree_edges');
    END`);

  tx.run(sql`CREATE TRIGGER IF NOT EXISTS tree_nodes_run_nodes_same_tree_update_ck
    BEFORE UPDATE OF workflow_tree_id ON tree_nodes
    FOR EACH ROW
    WHEN (
      NEW.workflow_tree_id <> OLD.workflow_tree_id
      AND EXISTS (
        SELECT 1
        FROM run_nodes
        INNER JOIN workflow_runs ON workflow_runs.id = run_nodes.workflow_run_id
        WHERE
          run_nodes.tree_node_id = NEW.id
          AND workflow_runs.workflow_tree_id <> NEW.workflow_tree_id
      )
    )
    BEGIN
      SELECT RAISE(ABORT, 'tree_nodes.workflow_tree_id must match workflow_tree_id for linked run_nodes');
    END`);

  tx.run(sql`CREATE TABLE IF NOT EXISTS run_nodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_run_id INTEGER NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
    tree_node_id INTEGER NOT NULL REFERENCES tree_nodes(id) ON DELETE RESTRICT,
    node_key TEXT NOT NULL,
    node_role TEXT NOT NULL DEFAULT 'standard',
    node_type TEXT NOT NULL DEFAULT 'agent',
    provider TEXT,
    model TEXT,
    prompt TEXT,
    prompt_content_type TEXT NOT NULL DEFAULT 'markdown',
    execution_permissions TEXT,
    error_handler_config TEXT,
    max_children INTEGER NOT NULL DEFAULT 12,
    max_retries INTEGER NOT NULL DEFAULT 0,
    spawner_node_id INTEGER,
    join_node_id INTEGER,
    lineage_depth INTEGER NOT NULL DEFAULT 0,
    sequence_path TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    sequence_index INTEGER NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 1,
    started_at TEXT,
    completed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    CONSTRAINT run_nodes_run_id_spawner_node_id_fk
      FOREIGN KEY (workflow_run_id, spawner_node_id)
      REFERENCES run_nodes(workflow_run_id, id)
      ON DELETE SET NULL,
    CONSTRAINT run_nodes_run_id_join_node_id_fk
      FOREIGN KEY (workflow_run_id, join_node_id)
      REFERENCES run_nodes(workflow_run_id, id)
      ON DELETE SET NULL,
    CONSTRAINT run_nodes_node_role_ck
      CHECK (node_role IN ('standard', 'spawner', 'join')),
    CONSTRAINT run_nodes_node_type_ck
      CHECK (node_type IN ('agent', 'human', 'tool')),
    CONSTRAINT run_nodes_prompt_content_type_ck
      CHECK (prompt_content_type IN ('text', 'markdown')),
    CONSTRAINT run_nodes_max_children_ck
      CHECK (max_children >= 0),
    CONSTRAINT run_nodes_max_retries_ck
      CHECK (max_retries >= 0),
    CONSTRAINT run_nodes_lineage_depth_ck
      CHECK (lineage_depth >= 0),
    CONSTRAINT run_nodes_status_ck
      CHECK (status IN ('pending', 'running', 'completed', 'failed', 'skipped', 'cancelled')),
    CONSTRAINT run_nodes_attempt_ck
      CHECK (attempt > 0),
    CONSTRAINT run_nodes_pending_started_at_ck
      CHECK ((status <> 'pending') OR (started_at IS NULL)),
    CONSTRAINT run_nodes_running_started_at_ck
      CHECK ((status <> 'running') OR (started_at IS NOT NULL)),
    CONSTRAINT run_nodes_completion_timestamp_ck
      CHECK (
        (status IN ('pending', 'running') AND completed_at IS NULL)
        OR
        (status IN ('completed', 'failed', 'skipped', 'cancelled') AND completed_at IS NOT NULL)
      )
  )`);
  tx.run(sql`CREATE UNIQUE INDEX IF NOT EXISTS run_nodes_run_id_sequence_uq
    ON run_nodes(workflow_run_id, sequence_index)`);
  tx.run(sql`CREATE UNIQUE INDEX IF NOT EXISTS run_nodes_run_id_node_attempt_uq
    ON run_nodes(workflow_run_id, node_key, attempt)`);
  tx.run(sql`CREATE UNIQUE INDEX IF NOT EXISTS run_nodes_run_id_id_uq
    ON run_nodes(workflow_run_id, id)`);
  tx.run(sql`CREATE INDEX IF NOT EXISTS run_nodes_run_id_status_idx
    ON run_nodes(workflow_run_id, status)`);
  tx.run(sql`CREATE INDEX IF NOT EXISTS run_nodes_run_id_sequence_idx
    ON run_nodes(workflow_run_id, sequence_index)`);
  tx.run(sql`CREATE INDEX IF NOT EXISTS run_nodes_node_key_idx
    ON run_nodes(node_key)`);
  tx.run(sql`CREATE INDEX IF NOT EXISTS run_nodes_created_at_idx
    ON run_nodes(created_at)`);
  const hasRunNodesNodeRoleColumn =
    tx.get<{ count: number }>(
      sql`SELECT COUNT(*) AS count FROM pragma_table_info('run_nodes') WHERE name = 'node_role'`,
    )?.count ?? 0;
  const addedRunNodesNodeRoleColumn = hasRunNodesNodeRoleColumn === 0;
  if (addedRunNodesNodeRoleColumn) {
    tx.run(sql`ALTER TABLE run_nodes ADD COLUMN node_role TEXT NOT NULL DEFAULT 'standard'`);
  }
  const hasRunNodesNodeTypeColumn =
    tx.get<{ count: number }>(
      sql`SELECT COUNT(*) AS count FROM pragma_table_info('run_nodes') WHERE name = 'node_type'`,
    )?.count ?? 0;
  const addedRunNodesNodeTypeColumn = hasRunNodesNodeTypeColumn === 0;
  if (addedRunNodesNodeTypeColumn) {
    tx.run(sql`ALTER TABLE run_nodes ADD COLUMN node_type TEXT NOT NULL DEFAULT 'agent'`);
  }
  const hasRunNodesProviderColumn =
    tx.get<{ count: number }>(
      sql`SELECT COUNT(*) AS count FROM pragma_table_info('run_nodes') WHERE name = 'provider'`,
    )?.count ?? 0;
  if (hasRunNodesProviderColumn === 0) {
    tx.run(sql`ALTER TABLE run_nodes ADD COLUMN provider TEXT`);
  }
  const hasRunNodesModelColumn =
    tx.get<{ count: number }>(
      sql`SELECT COUNT(*) AS count FROM pragma_table_info('run_nodes') WHERE name = 'model'`,
    )?.count ?? 0;
  if (hasRunNodesModelColumn === 0) {
    tx.run(sql`ALTER TABLE run_nodes ADD COLUMN model TEXT`);
  }
  const hasRunNodesPromptColumn =
    tx.get<{ count: number }>(
      sql`SELECT COUNT(*) AS count FROM pragma_table_info('run_nodes') WHERE name = 'prompt'`,
    )?.count ?? 0;
  if (hasRunNodesPromptColumn === 0) {
    tx.run(sql`ALTER TABLE run_nodes ADD COLUMN prompt TEXT`);
  }
  const hasRunNodesPromptContentTypeColumn =
    tx.get<{ count: number }>(
      sql`SELECT COUNT(*) AS count FROM pragma_table_info('run_nodes') WHERE name = 'prompt_content_type'`,
    )?.count ?? 0;
  const addedRunNodesPromptContentTypeColumn = hasRunNodesPromptContentTypeColumn === 0;
  if (addedRunNodesPromptContentTypeColumn) {
    tx.run(sql`ALTER TABLE run_nodes ADD COLUMN prompt_content_type TEXT NOT NULL DEFAULT 'markdown'`);
  }
  const hasRunNodesExecutionPermissionsColumn =
    tx.get<{ count: number }>(
      sql`SELECT COUNT(*) AS count FROM pragma_table_info('run_nodes') WHERE name = 'execution_permissions'`,
    )?.count ?? 0;
  if (hasRunNodesExecutionPermissionsColumn === 0) {
    tx.run(sql`ALTER TABLE run_nodes ADD COLUMN execution_permissions TEXT`);
  }
  const hasRunNodesErrorHandlerConfigColumn =
    tx.get<{ count: number }>(
      sql`SELECT COUNT(*) AS count FROM pragma_table_info('run_nodes') WHERE name = 'error_handler_config'`,
    )?.count ?? 0;
  if (hasRunNodesErrorHandlerConfigColumn === 0) {
    tx.run(sql`ALTER TABLE run_nodes ADD COLUMN error_handler_config TEXT`);
  }
  const hasRunNodesMaxChildrenColumn =
    tx.get<{ count: number }>(
      sql`SELECT COUNT(*) AS count FROM pragma_table_info('run_nodes') WHERE name = 'max_children'`,
    )?.count ?? 0;
  const addedRunNodesMaxChildrenColumn = hasRunNodesMaxChildrenColumn === 0;
  if (addedRunNodesMaxChildrenColumn) {
    tx.run(sql`ALTER TABLE run_nodes ADD COLUMN max_children INTEGER NOT NULL DEFAULT 12`);
  }
  const hasRunNodesMaxRetriesColumn =
    tx.get<{ count: number }>(
      sql`SELECT COUNT(*) AS count FROM pragma_table_info('run_nodes') WHERE name = 'max_retries'`,
    )?.count ?? 0;
  const addedRunNodesMaxRetriesColumn = hasRunNodesMaxRetriesColumn === 0;
  if (addedRunNodesMaxRetriesColumn) {
    tx.run(sql`ALTER TABLE run_nodes ADD COLUMN max_retries INTEGER NOT NULL DEFAULT 0`);
  }
  const hasRunNodesSpawnerNodeIdColumn =
    tx.get<{ count: number }>(
      sql`SELECT COUNT(*) AS count FROM pragma_table_info('run_nodes') WHERE name = 'spawner_node_id'`,
    )?.count ?? 0;
  if (hasRunNodesSpawnerNodeIdColumn === 0) {
    tx.run(sql`ALTER TABLE run_nodes ADD COLUMN spawner_node_id INTEGER`);
  }
  const hasRunNodesJoinNodeIdColumn =
    tx.get<{ count: number }>(
      sql`SELECT COUNT(*) AS count FROM pragma_table_info('run_nodes') WHERE name = 'join_node_id'`,
    )?.count ?? 0;
  if (hasRunNodesJoinNodeIdColumn === 0) {
    tx.run(sql`ALTER TABLE run_nodes ADD COLUMN join_node_id INTEGER`);
  }
  const hasRunNodesLineageDepthColumn =
    tx.get<{ count: number }>(
      sql`SELECT COUNT(*) AS count FROM pragma_table_info('run_nodes') WHERE name = 'lineage_depth'`,
    )?.count ?? 0;
  if (hasRunNodesLineageDepthColumn === 0) {
    tx.run(sql`ALTER TABLE run_nodes ADD COLUMN lineage_depth INTEGER NOT NULL DEFAULT 0`);
  }
  const hasRunNodesSequencePathColumn =
    tx.get<{ count: number }>(
      sql`SELECT COUNT(*) AS count FROM pragma_table_info('run_nodes') WHERE name = 'sequence_path'`,
    )?.count ?? 0;
  if (hasRunNodesSequencePathColumn === 0) {
    tx.run(sql`ALTER TABLE run_nodes ADD COLUMN sequence_path TEXT`);
  }
  // SQLite exposes DEFAULT values for historical rows after ALTER TABLE ADD COLUMN,
  // so explicitly backfill newly-added NOT NULL columns from source records.
  if (addedRunNodesNodeRoleColumn) {
    tx.run(sql`UPDATE run_nodes
      SET node_role = COALESCE((
            SELECT tree_nodes.node_role
            FROM tree_nodes
            WHERE tree_nodes.id = run_nodes.tree_node_id
          ), 'standard')`);
  }
  if (addedRunNodesNodeTypeColumn) {
    tx.run(sql`UPDATE run_nodes
      SET node_type = COALESCE((
            SELECT tree_nodes.node_type
            FROM tree_nodes
            WHERE tree_nodes.id = run_nodes.tree_node_id
          ), 'agent')`);
  }
  if (addedRunNodesPromptContentTypeColumn) {
    tx.run(sql`UPDATE run_nodes
      SET prompt_content_type = COALESCE((
            SELECT prompt_templates.content_type
            FROM tree_nodes
            LEFT JOIN prompt_templates ON prompt_templates.id = tree_nodes.prompt_template_id
            WHERE tree_nodes.id = run_nodes.tree_node_id
          ), 'markdown')`);
  }
  if (addedRunNodesMaxChildrenColumn) {
    tx.run(sql`UPDATE run_nodes
      SET max_children = COALESCE((
            SELECT tree_nodes.max_children
            FROM tree_nodes
            WHERE tree_nodes.id = run_nodes.tree_node_id
          ), 12)`);
  }
  if (addedRunNodesMaxRetriesColumn) {
    tx.run(sql`UPDATE run_nodes
      SET max_retries = COALESCE((
            SELECT tree_nodes.max_retries
            FROM tree_nodes
            WHERE tree_nodes.id = run_nodes.tree_node_id
          ), 0)`);
  }
  tx.run(sql`UPDATE run_nodes
    SET node_role = COALESCE(node_role, (
          SELECT tree_nodes.node_role
          FROM tree_nodes
          WHERE tree_nodes.id = run_nodes.tree_node_id
        ), 'standard'),
        node_type = COALESCE(node_type, (
          SELECT tree_nodes.node_type
          FROM tree_nodes
          WHERE tree_nodes.id = run_nodes.tree_node_id
        ), 'agent'),
        provider = COALESCE(provider, (
          SELECT tree_nodes.provider
          FROM tree_nodes
          WHERE tree_nodes.id = run_nodes.tree_node_id
        )),
        model = COALESCE(model, (
          SELECT tree_nodes.model
          FROM tree_nodes
          WHERE tree_nodes.id = run_nodes.tree_node_id
        )),
        prompt = COALESCE(prompt, (
          SELECT prompt_templates.content
          FROM tree_nodes
          LEFT JOIN prompt_templates ON prompt_templates.id = tree_nodes.prompt_template_id
          WHERE tree_nodes.id = run_nodes.tree_node_id
        )),
        prompt_content_type = COALESCE(prompt_content_type, (
          SELECT COALESCE(prompt_templates.content_type, 'markdown')
          FROM tree_nodes
          LEFT JOIN prompt_templates ON prompt_templates.id = tree_nodes.prompt_template_id
          WHERE tree_nodes.id = run_nodes.tree_node_id
        ), 'markdown'),
        execution_permissions = COALESCE(execution_permissions, (
          SELECT tree_nodes.execution_permissions
          FROM tree_nodes
          WHERE tree_nodes.id = run_nodes.tree_node_id
        )),
        error_handler_config = COALESCE(error_handler_config, (
          SELECT tree_nodes.error_handler_config
          FROM tree_nodes
          WHERE tree_nodes.id = run_nodes.tree_node_id
        )),
        max_children = COALESCE(max_children, (
          SELECT tree_nodes.max_children
          FROM tree_nodes
          WHERE tree_nodes.id = run_nodes.tree_node_id
        ), 12),
        max_retries = COALESCE(max_retries, (
          SELECT tree_nodes.max_retries
          FROM tree_nodes
          WHERE tree_nodes.id = run_nodes.tree_node_id
        ), 0),
        lineage_depth = COALESCE(lineage_depth, 0),
        sequence_path = COALESCE(sequence_path, CAST(sequence_index AS TEXT))`);
  tx.run(sql`CREATE INDEX IF NOT EXISTS run_nodes_run_id_spawner_node_idx
    ON run_nodes(workflow_run_id, spawner_node_id)`);
  tx.run(sql`CREATE INDEX IF NOT EXISTS run_nodes_run_id_join_node_idx
    ON run_nodes(workflow_run_id, join_node_id)`);

  // Refresh this trigger on every migration run so upgraded databases pick up
  // newly allowed status transitions.
  tx.run(sql`DROP TRIGGER IF EXISTS run_nodes_status_transition_update_ck`);
  tx.run(sql`CREATE TRIGGER run_nodes_status_transition_update_ck
    BEFORE UPDATE OF status ON run_nodes
    FOR EACH ROW
    WHEN (
      NEW.status <> OLD.status
      AND NOT (
        (OLD.status = 'pending' AND NEW.status IN ('running', 'skipped', 'cancelled'))
        OR
        (OLD.status = 'running' AND NEW.status IN ('completed', 'failed', 'cancelled'))
        OR
        (OLD.status = 'completed' AND NEW.status = 'pending')
        OR
        (OLD.status = 'failed' AND NEW.status IN ('running', 'pending'))
        OR
        (OLD.status = 'skipped' AND NEW.status = 'pending')
      )
    )
    BEGIN
      SELECT RAISE(ABORT, 'run_nodes status transition is not allowed');
    END`);

  tx.run(sql`CREATE TRIGGER IF NOT EXISTS run_nodes_initial_state_insert_ck
    BEFORE INSERT ON run_nodes
    FOR EACH ROW
    WHEN (
      NEW.status <> 'pending'
      OR NEW.started_at IS NOT NULL
      OR NEW.completed_at IS NOT NULL
    )
    BEGIN
      SELECT RAISE(ABORT, 'run_nodes must be inserted in pending state with null started_at/completed_at');
    END`);

  // Refresh this trigger on every migration run so upgraded databases drop
  // legacy definitions that blocked fan-out children on insert.
  tx.run(sql`DROP TRIGGER IF EXISTS run_nodes_node_key_matches_tree_node_insert_ck`);
  tx.run(sql`CREATE TRIGGER run_nodes_node_key_matches_tree_node_insert_ck
    BEFORE INSERT ON run_nodes
    FOR EACH ROW
    WHEN (
      NEW.spawner_node_id IS NULL
      AND
      NEW.node_key <> (SELECT node_key FROM tree_nodes WHERE id = NEW.tree_node_id)
    )
    BEGIN
      SELECT RAISE(ABORT, 'run_nodes.node_key must match tree_nodes.node_key for run_nodes.tree_node_id');
    END`);

  // Refresh this trigger on every migration run so upgraded databases drop
  // the legacy definition that fired during spawner_node_id nullification.
  tx.run(sql`DROP TRIGGER IF EXISTS run_nodes_node_key_matches_tree_node_update_ck`);
  tx.run(sql`CREATE TRIGGER run_nodes_node_key_matches_tree_node_update_ck
    BEFORE UPDATE OF tree_node_id, node_key ON run_nodes
    FOR EACH ROW
    WHEN (
      NEW.spawner_node_id IS NULL
      AND
      NEW.node_key <> (SELECT node_key FROM tree_nodes WHERE id = NEW.tree_node_id)
    )
    BEGIN
      SELECT RAISE(ABORT, 'run_nodes.node_key must match tree_nodes.node_key for run_nodes.tree_node_id');
    END`);

  tx.run(sql`CREATE TRIGGER IF NOT EXISTS run_nodes_same_tree_insert_ck
    BEFORE INSERT ON run_nodes
    FOR EACH ROW
    WHEN (
      (SELECT workflow_tree_id FROM workflow_runs WHERE id = NEW.workflow_run_id) <> (SELECT workflow_tree_id FROM tree_nodes WHERE id = NEW.tree_node_id)
    )
    BEGIN
      SELECT RAISE(ABORT, 'run_nodes.workflow_run_id and run_nodes.tree_node_id must share workflow_tree_id');
    END`);

  tx.run(sql`CREATE TRIGGER IF NOT EXISTS run_nodes_same_tree_update_ck
    BEFORE UPDATE OF workflow_run_id, tree_node_id ON run_nodes
    FOR EACH ROW
    WHEN (
      (SELECT workflow_tree_id FROM workflow_runs WHERE id = NEW.workflow_run_id) <> (SELECT workflow_tree_id FROM tree_nodes WHERE id = NEW.tree_node_id)
    )
    BEGIN
      SELECT RAISE(ABORT, 'run_nodes.workflow_run_id and run_nodes.tree_node_id must share workflow_tree_id');
    END`);

  tx.run(sql`DROP TRIGGER IF EXISTS run_nodes_spawner_same_run_insert_ck`);
  tx.run(sql`CREATE TRIGGER run_nodes_spawner_same_run_insert_ck
    BEFORE INSERT ON run_nodes
    FOR EACH ROW
    WHEN (
      NEW.spawner_node_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM run_nodes
        WHERE id = NEW.spawner_node_id
          AND workflow_run_id = NEW.workflow_run_id
      )
    )
    BEGIN
      SELECT RAISE(ABORT, 'run_nodes.spawner_node_id must reference a run node in the same workflow_run_id');
    END`);

  tx.run(sql`DROP TRIGGER IF EXISTS run_nodes_spawner_same_run_update_ck`);
  tx.run(sql`CREATE TRIGGER run_nodes_spawner_same_run_update_ck
    BEFORE UPDATE OF workflow_run_id, spawner_node_id ON run_nodes
    FOR EACH ROW
    WHEN (
      NEW.spawner_node_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM run_nodes
        WHERE id = NEW.spawner_node_id
          AND workflow_run_id = NEW.workflow_run_id
      )
    )
    BEGIN
      SELECT RAISE(ABORT, 'run_nodes.spawner_node_id must reference a run node in the same workflow_run_id');
    END`);

  tx.run(sql`DROP TRIGGER IF EXISTS run_nodes_join_same_run_insert_ck`);
  tx.run(sql`CREATE TRIGGER run_nodes_join_same_run_insert_ck
    BEFORE INSERT ON run_nodes
    FOR EACH ROW
    WHEN (
      NEW.join_node_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM run_nodes
        WHERE id = NEW.join_node_id
          AND workflow_run_id = NEW.workflow_run_id
      )
    )
    BEGIN
      SELECT RAISE(ABORT, 'run_nodes.join_node_id must reference a run node in the same workflow_run_id');
    END`);

  tx.run(sql`DROP TRIGGER IF EXISTS run_nodes_join_same_run_update_ck`);
  tx.run(sql`CREATE TRIGGER run_nodes_join_same_run_update_ck
    BEFORE UPDATE OF workflow_run_id, join_node_id ON run_nodes
    FOR EACH ROW
    WHEN (
      NEW.join_node_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM run_nodes
        WHERE id = NEW.join_node_id
          AND workflow_run_id = NEW.workflow_run_id
      )
    )
    BEGIN
      SELECT RAISE(ABORT, 'run_nodes.join_node_id must reference a run node in the same workflow_run_id');
    END`);

  // Clear self-referential links before deleting a parent node so composite
  // SET NULL FKs do not attempt to null workflow_run_id (which is NOT NULL).
  tx.run(sql`CREATE TRIGGER IF NOT EXISTS run_nodes_clear_parent_links_before_delete_ck
    BEFORE DELETE ON run_nodes
    FOR EACH ROW
    BEGIN
      UPDATE run_nodes
      SET spawner_node_id = NULL
      WHERE workflow_run_id = OLD.workflow_run_id
        AND spawner_node_id = OLD.id;

      UPDATE run_nodes
      SET join_node_id = NULL
      WHERE workflow_run_id = OLD.workflow_run_id
        AND join_node_id = OLD.id;
    END`);

  tx.run(sql`CREATE TRIGGER IF NOT EXISTS tree_nodes_node_key_update_referenced_by_run_nodes_ck
    BEFORE UPDATE OF node_key ON tree_nodes
    FOR EACH ROW
    WHEN (
      NEW.node_key <> OLD.node_key
      AND EXISTS (
        SELECT 1
        FROM run_nodes
        WHERE run_nodes.tree_node_id = NEW.id
      )
    )
    BEGIN
      SELECT RAISE(ABORT, 'tree_nodes.node_key cannot change while referenced by run_nodes');
    END`);

  tx.run(sql`CREATE TRIGGER IF NOT EXISTS workflow_runs_run_nodes_same_tree_update_ck
    BEFORE UPDATE OF workflow_tree_id ON workflow_runs
    FOR EACH ROW
    WHEN (
      NEW.workflow_tree_id <> OLD.workflow_tree_id
      AND EXISTS (
        SELECT 1
        FROM run_nodes
        INNER JOIN tree_nodes ON tree_nodes.id = run_nodes.tree_node_id
        WHERE
          run_nodes.workflow_run_id = NEW.id
          AND tree_nodes.workflow_tree_id <> NEW.workflow_tree_id
      )
    )
    BEGIN
      SELECT RAISE(ABORT, 'workflow_runs.workflow_tree_id must match workflow_tree_id for linked run_nodes');
    END`);

  tx.run(sql`CREATE TABLE IF NOT EXISTS run_node_edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_run_id INTEGER NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
    source_run_node_id INTEGER NOT NULL REFERENCES run_nodes(id) ON DELETE CASCADE,
    target_run_node_id INTEGER NOT NULL REFERENCES run_nodes(id) ON DELETE CASCADE,
    route_on TEXT NOT NULL DEFAULT 'success',
    auto INTEGER NOT NULL DEFAULT 1,
    guard_expression TEXT,
    priority INTEGER NOT NULL DEFAULT 0,
    edge_kind TEXT NOT NULL DEFAULT 'tree',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    CONSTRAINT run_node_edges_source_run_node_fk
      FOREIGN KEY (workflow_run_id, source_run_node_id)
      REFERENCES run_nodes(workflow_run_id, id)
      ON DELETE CASCADE,
    CONSTRAINT run_node_edges_target_run_node_fk
      FOREIGN KEY (workflow_run_id, target_run_node_id)
      REFERENCES run_nodes(workflow_run_id, id)
      ON DELETE CASCADE,
    CONSTRAINT run_node_edges_route_on_ck
      CHECK (route_on IN ('success', 'failure', 'terminal')),
    CONSTRAINT run_node_edges_auto_bool_ck
      CHECK (auto IN (0, 1)),
    CONSTRAINT run_node_edges_priority_ck
      CHECK (priority >= 0),
    CONSTRAINT run_node_edges_kind_ck
      CHECK (edge_kind IN ('tree', 'dynamic_spawner_to_child', 'dynamic_child_to_join'))
  )`);
  const hasRunNodeEdgesAutoColumn =
    tx.get<{ count: number }>(
      sql`SELECT COUNT(*) AS count FROM pragma_table_info('run_node_edges') WHERE name = 'auto'`,
    )?.count ?? 0;
  if (hasRunNodeEdgesAutoColumn === 0) {
    tx.run(sql`ALTER TABLE run_node_edges ADD COLUMN auto INTEGER NOT NULL DEFAULT 1`);
  }
  const hasRunNodeEdgesGuardExpressionColumn =
    tx.get<{ count: number }>(
      sql`SELECT COUNT(*) AS count FROM pragma_table_info('run_node_edges') WHERE name = 'guard_expression'`,
    )?.count ?? 0;
  if (hasRunNodeEdgesGuardExpressionColumn === 0) {
    tx.run(sql`ALTER TABLE run_node_edges ADD COLUMN guard_expression TEXT`);
  }
  tx.run(sql`CREATE UNIQUE INDEX IF NOT EXISTS run_node_edges_unique_uq
    ON run_node_edges(workflow_run_id, source_run_node_id, route_on, priority, target_run_node_id)`);
  tx.run(sql`CREATE INDEX IF NOT EXISTS run_node_edges_run_id_target_idx
    ON run_node_edges(workflow_run_id, target_run_node_id)`);
  tx.run(sql`CREATE INDEX IF NOT EXISTS run_node_edges_run_id_source_idx
    ON run_node_edges(workflow_run_id, source_run_node_id)`);
  tx.run(sql`CREATE INDEX IF NOT EXISTS run_node_edges_created_at_idx
    ON run_node_edges(created_at)`);
  // Backfill runtime edges for pre-existing runs so upgraded in-flight runs keep
  // dependency ordering when edge loading switches to run_node_edges.
  tx.run(sql`INSERT OR IGNORE INTO run_node_edges (
      workflow_run_id,
      source_run_node_id,
      target_run_node_id,
      route_on,
      auto,
      guard_expression,
      priority,
      edge_kind
    )
    SELECT
      source_nodes.workflow_run_id,
      source_nodes.id,
      target_nodes.id,
      tree_edges.route_on,
      tree_edges.auto,
      guard_definitions.expression,
      tree_edges.priority,
      'tree'
    FROM run_nodes AS source_nodes
    INNER JOIN run_nodes AS target_nodes
      ON target_nodes.workflow_run_id = source_nodes.workflow_run_id
    INNER JOIN workflow_runs
      ON workflow_runs.id = source_nodes.workflow_run_id
    INNER JOIN tree_edges
      ON tree_edges.workflow_tree_id = workflow_runs.workflow_tree_id
      AND tree_edges.source_node_id = source_nodes.tree_node_id
      AND tree_edges.target_node_id = target_nodes.tree_node_id
    LEFT JOIN guard_definitions
      ON guard_definitions.id = tree_edges.guard_definition_id
    WHERE
      source_nodes.spawner_node_id IS NULL
      AND target_nodes.spawner_node_id IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM run_nodes AS newer_source
        WHERE
          newer_source.workflow_run_id = source_nodes.workflow_run_id
          AND newer_source.tree_node_id = source_nodes.tree_node_id
          AND newer_source.spawner_node_id IS NULL
          AND (
            newer_source.attempt > source_nodes.attempt
            OR (
              newer_source.attempt = source_nodes.attempt
              AND newer_source.id > source_nodes.id
            )
          )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM run_nodes AS newer_target
        WHERE
          newer_target.workflow_run_id = target_nodes.workflow_run_id
          AND newer_target.tree_node_id = target_nodes.tree_node_id
          AND newer_target.spawner_node_id IS NULL
          AND (
            newer_target.attempt > target_nodes.attempt
            OR (
              newer_target.attempt = target_nodes.attempt
              AND newer_target.id > target_nodes.id
            )
          )
      )`);
  tx.run(sql`INSERT OR IGNORE INTO run_node_edges (
      workflow_run_id,
      source_run_node_id,
      target_run_node_id,
      route_on,
      auto,
      guard_expression,
      priority,
      edge_kind
    )
    SELECT
      child_nodes.workflow_run_id,
      child_nodes.spawner_node_id,
      child_nodes.id,
      'success',
      1,
      NULL,
      (
        SELECT COUNT(*)
        FROM run_nodes AS earlier_child
        WHERE
          earlier_child.workflow_run_id = child_nodes.workflow_run_id
          AND earlier_child.spawner_node_id = child_nodes.spawner_node_id
          AND (
            earlier_child.sequence_index < child_nodes.sequence_index
            OR (
              earlier_child.sequence_index = child_nodes.sequence_index
              AND earlier_child.id < child_nodes.id
            )
          )
      ),
      'dynamic_spawner_to_child'
    FROM run_nodes AS child_nodes
    WHERE child_nodes.spawner_node_id IS NOT NULL`);
  tx.run(sql`INSERT OR IGNORE INTO run_node_edges (
      workflow_run_id,
      source_run_node_id,
      target_run_node_id,
      route_on,
      auto,
      guard_expression,
      priority,
      edge_kind
    )
    SELECT
      child_nodes.workflow_run_id,
      child_nodes.id,
      child_nodes.join_node_id,
      'terminal',
      1,
      NULL,
      0,
      'dynamic_child_to_join'
    FROM run_nodes AS child_nodes
    WHERE child_nodes.join_node_id IS NOT NULL`);

  tx.run(sql`CREATE TABLE IF NOT EXISTS routing_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_run_id INTEGER NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
    run_node_id INTEGER NOT NULL REFERENCES run_nodes(id) ON DELETE CASCADE,
    decision_type TEXT NOT NULL,
    rationale TEXT,
    raw_output TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    CONSTRAINT routing_decisions_run_id_run_node_id_fk
      FOREIGN KEY (workflow_run_id, run_node_id)
      REFERENCES run_nodes(workflow_run_id, id)
      ON DELETE CASCADE,
    CONSTRAINT routing_decisions_decision_type_ck
      CHECK (decision_type IN ('approved', 'changes_requested', 'blocked', 'retry', 'no_route'))
  )`);
  tx.run(sql`CREATE INDEX IF NOT EXISTS routing_decisions_run_id_created_at_idx
    ON routing_decisions(workflow_run_id, created_at)`);
  tx.run(sql`CREATE INDEX IF NOT EXISTS routing_decisions_created_at_idx
    ON routing_decisions(created_at)`);

  tx.run(sql`CREATE TABLE IF NOT EXISTS phase_artifacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_run_id INTEGER NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
    run_node_id INTEGER NOT NULL REFERENCES run_nodes(id) ON DELETE CASCADE,
    artifact_type TEXT NOT NULL DEFAULT 'report',
    content_type TEXT NOT NULL,
    content TEXT NOT NULL,
    metadata TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    CONSTRAINT phase_artifacts_run_id_run_node_id_fk
      FOREIGN KEY (workflow_run_id, run_node_id)
      REFERENCES run_nodes(workflow_run_id, id)
      ON DELETE CASCADE,
    CONSTRAINT phase_artifacts_artifact_type_ck
      CHECK (artifact_type IN ('report', 'note', 'log')),
    CONSTRAINT phase_artifacts_content_type_ck
      CHECK (content_type IN ('text', 'markdown', 'json', 'diff'))
  )`);
  tx.run(sql`CREATE INDEX IF NOT EXISTS phase_artifacts_run_id_created_at_idx
    ON phase_artifacts(workflow_run_id, created_at)`);
  tx.run(sql`CREATE INDEX IF NOT EXISTS phase_artifacts_created_at_idx
    ON phase_artifacts(created_at)`);

  tx.run(sql`CREATE TABLE IF NOT EXISTS run_join_barriers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_run_id INTEGER NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
    spawner_run_node_id INTEGER NOT NULL REFERENCES run_nodes(id) ON DELETE CASCADE,
    join_run_node_id INTEGER NOT NULL REFERENCES run_nodes(id) ON DELETE CASCADE,
    spawn_source_artifact_id INTEGER NOT NULL REFERENCES phase_artifacts(id) ON DELETE CASCADE,
    expected_children INTEGER NOT NULL,
    terminal_children INTEGER NOT NULL DEFAULT 0,
    completed_children INTEGER NOT NULL DEFAULT 0,
    failed_children INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    released_at TEXT,
    CONSTRAINT run_join_barriers_spawner_run_node_fk
      FOREIGN KEY (workflow_run_id, spawner_run_node_id)
      REFERENCES run_nodes(workflow_run_id, id)
      ON DELETE CASCADE,
    CONSTRAINT run_join_barriers_join_run_node_fk
      FOREIGN KEY (workflow_run_id, join_run_node_id)
      REFERENCES run_nodes(workflow_run_id, id)
      ON DELETE CASCADE,
    CONSTRAINT run_join_barriers_expected_children_ck
      CHECK (expected_children >= 0),
    CONSTRAINT run_join_barriers_terminal_children_ck
      CHECK (terminal_children >= 0),
    CONSTRAINT run_join_barriers_completed_children_ck
      CHECK (completed_children >= 0),
    CONSTRAINT run_join_barriers_failed_children_ck
      CHECK (failed_children >= 0),
    CONSTRAINT run_join_barriers_terminal_within_expected_ck
      CHECK (terminal_children <= expected_children),
    CONSTRAINT run_join_barriers_completed_within_expected_ck
      CHECK (completed_children <= expected_children),
    CONSTRAINT run_join_barriers_failed_within_expected_ck
      CHECK (failed_children <= expected_children),
    CONSTRAINT run_join_barriers_completed_failed_within_terminal_ck
      CHECK ((completed_children + failed_children) <= terminal_children),
    CONSTRAINT run_join_barriers_status_ck
      CHECK (status IN ('pending', 'ready', 'released', 'cancelled'))
  )`);
  tx.run(sql`CREATE UNIQUE INDEX IF NOT EXISTS run_join_barriers_spawn_uq
    ON run_join_barriers(workflow_run_id, spawner_run_node_id, spawn_source_artifact_id)`);
  tx.run(sql`CREATE INDEX IF NOT EXISTS run_join_barriers_run_id_join_status_idx
    ON run_join_barriers(workflow_run_id, join_run_node_id, status)`);
  tx.run(sql`CREATE INDEX IF NOT EXISTS run_join_barriers_created_at_idx
    ON run_join_barriers(created_at)`);

  tx.run(sql`CREATE TRIGGER IF NOT EXISTS run_join_barriers_source_artifact_same_run_insert_ck
    BEFORE INSERT ON run_join_barriers
    FOR EACH ROW
    WHEN (
      (SELECT workflow_run_id FROM phase_artifacts WHERE id = NEW.spawn_source_artifact_id) <> NEW.workflow_run_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'run_join_barriers.spawn_source_artifact_id must reference a phase artifact in the same workflow_run_id');
    END`);

  tx.run(sql`CREATE TRIGGER IF NOT EXISTS run_join_barriers_source_artifact_same_run_update_ck
    BEFORE UPDATE OF workflow_run_id, spawn_source_artifact_id ON run_join_barriers
    FOR EACH ROW
    WHEN (
      (SELECT workflow_run_id FROM phase_artifacts WHERE id = NEW.spawn_source_artifact_id) <> NEW.workflow_run_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'run_join_barriers.spawn_source_artifact_id must reference a phase artifact in the same workflow_run_id');
    END`);

  tx.run(sql`CREATE TABLE IF NOT EXISTS run_node_diagnostics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_run_id INTEGER NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
    run_node_id INTEGER NOT NULL REFERENCES run_nodes(id) ON DELETE CASCADE,
    attempt INTEGER NOT NULL,
    outcome TEXT NOT NULL,
    event_count INTEGER NOT NULL DEFAULT 0,
    retained_event_count INTEGER NOT NULL DEFAULT 0,
    dropped_event_count INTEGER NOT NULL DEFAULT 0,
    redacted INTEGER NOT NULL DEFAULT 0,
    truncated INTEGER NOT NULL DEFAULT 0,
    payload_chars INTEGER NOT NULL DEFAULT 0,
    diagnostics TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    CONSTRAINT run_node_diagnostics_run_id_run_node_id_fk
      FOREIGN KEY (workflow_run_id, run_node_id)
      REFERENCES run_nodes(workflow_run_id, id)
      ON DELETE CASCADE,
    CONSTRAINT run_node_diagnostics_attempt_ck
      CHECK (attempt > 0),
    CONSTRAINT run_node_diagnostics_outcome_ck
      CHECK (outcome IN ('completed', 'failed')),
    CONSTRAINT run_node_diagnostics_event_count_ck
      CHECK (event_count >= 0),
    CONSTRAINT run_node_diagnostics_retained_event_count_ck
      CHECK (retained_event_count >= 0),
    CONSTRAINT run_node_diagnostics_dropped_event_count_ck
      CHECK (dropped_event_count >= 0),
    CONSTRAINT run_node_diagnostics_redacted_bool_ck
      CHECK (redacted IN (0, 1)),
    CONSTRAINT run_node_diagnostics_truncated_bool_ck
      CHECK (truncated IN (0, 1)),
    CONSTRAINT run_node_diagnostics_payload_chars_ck
      CHECK (payload_chars >= 0)
  )`);
  tx.run(sql`CREATE UNIQUE INDEX IF NOT EXISTS run_node_diagnostics_run_id_run_node_attempt_uq
    ON run_node_diagnostics(workflow_run_id, run_node_id, attempt)`);
  tx.run(sql`CREATE INDEX IF NOT EXISTS run_node_diagnostics_run_id_created_at_idx
    ON run_node_diagnostics(workflow_run_id, created_at)`);
  tx.run(sql`CREATE INDEX IF NOT EXISTS run_node_diagnostics_run_node_id_created_at_idx
    ON run_node_diagnostics(run_node_id, created_at)`);
  tx.run(sql`CREATE INDEX IF NOT EXISTS run_node_diagnostics_created_at_idx
    ON run_node_diagnostics(created_at)`);

  tx.run(sql`CREATE TABLE IF NOT EXISTS run_node_stream_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_run_id INTEGER NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
    run_node_id INTEGER NOT NULL REFERENCES run_nodes(id) ON DELETE CASCADE,
    attempt INTEGER NOT NULL,
    sequence INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    content_chars INTEGER NOT NULL DEFAULT 0,
    content_preview TEXT NOT NULL,
    metadata TEXT,
    usage_delta_tokens INTEGER,
    usage_cumulative_tokens INTEGER,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    CONSTRAINT run_node_stream_events_run_id_run_node_id_fk
      FOREIGN KEY (workflow_run_id, run_node_id)
      REFERENCES run_nodes(workflow_run_id, id)
      ON DELETE CASCADE,
    CONSTRAINT run_node_stream_events_attempt_ck
      CHECK (attempt > 0),
    CONSTRAINT run_node_stream_events_sequence_ck
      CHECK (sequence > 0),
    CONSTRAINT run_node_stream_events_event_type_ck
      CHECK (event_type IN ('system', 'assistant', 'tool_use', 'tool_result', 'usage', 'result')),
    CONSTRAINT run_node_stream_events_content_chars_ck
      CHECK (content_chars >= 0),
    CONSTRAINT run_node_stream_events_usage_delta_tokens_ck
      CHECK (usage_delta_tokens IS NULL OR usage_delta_tokens >= 0),
    CONSTRAINT run_node_stream_events_usage_cumulative_tokens_ck
      CHECK (usage_cumulative_tokens IS NULL OR usage_cumulative_tokens >= 0)
  )`);
  tx.run(sql`CREATE UNIQUE INDEX IF NOT EXISTS run_node_stream_events_run_id_run_node_attempt_seq_uq
    ON run_node_stream_events(workflow_run_id, run_node_id, attempt, sequence)`);
  tx.run(sql`CREATE INDEX IF NOT EXISTS run_node_stream_events_run_id_attempt_sequence_idx
    ON run_node_stream_events(workflow_run_id, run_node_id, attempt, sequence)`);
  tx.run(sql`CREATE INDEX IF NOT EXISTS run_node_stream_events_run_id_created_at_idx
    ON run_node_stream_events(workflow_run_id, created_at)`);
  tx.run(sql`CREATE INDEX IF NOT EXISTS run_node_stream_events_run_node_id_created_at_idx
    ON run_node_stream_events(run_node_id, created_at)`);
  tx.run(sql`CREATE INDEX IF NOT EXISTS run_node_stream_events_created_at_idx
    ON run_node_stream_events(created_at)`);
  });
}
