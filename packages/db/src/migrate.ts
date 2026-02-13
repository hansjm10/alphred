import type { AlphredDatabase } from './connection.js';
import { sql } from 'drizzle-orm';

export function migrateDatabase(db: AlphredDatabase): void {
  db.run(sql`DROP TABLE IF EXISTS phase_artifacts`);
  db.run(sql`DROP TABLE IF EXISTS routing_decisions`);
  db.run(sql`DROP TABLE IF EXISTS run_nodes`);
  db.run(sql`DROP TABLE IF EXISTS tree_edges`);
  db.run(sql`DROP TABLE IF EXISTS tree_nodes`);
  db.run(sql`DROP TABLE IF EXISTS workflow_runs`);
  db.run(sql`DROP TABLE IF EXISTS guard_definitions`);
  db.run(sql`DROP TABLE IF EXISTS prompt_templates`);
  db.run(sql`DROP TABLE IF EXISTS workflow_trees`);

  db.run(sql`DROP TABLE IF EXISTS agent_events`);
  db.run(sql`DROP TABLE IF EXISTS agent_sessions`);
  db.run(sql`DROP TABLE IF EXISTS phase_reports`);
  db.run(sql`DROP TABLE IF EXISTS run_logs`);
  db.run(sql`DROP TABLE IF EXISTS state_snapshots`);
  db.run(sql`DROP TABLE IF EXISTS phases`);
  db.run(sql`DROP TABLE IF EXISTS runs`);
  db.run(sql`DROP TABLE IF EXISTS workflows`);

  db.run(sql`CREATE TABLE workflow_trees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tree_key TEXT NOT NULL,
    version INTEGER NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`);
  db.run(sql`CREATE UNIQUE INDEX workflow_trees_tree_key_version_uq
    ON workflow_trees(tree_key, version)`);
  db.run(sql`CREATE INDEX workflow_trees_created_at_idx
    ON workflow_trees(created_at)`);

  db.run(sql`CREATE TABLE prompt_templates (
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
  db.run(sql`CREATE UNIQUE INDEX prompt_templates_template_key_version_uq
    ON prompt_templates(template_key, version)`);
  db.run(sql`CREATE INDEX prompt_templates_created_at_idx
    ON prompt_templates(created_at)`);

  db.run(sql`CREATE TABLE guard_definitions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guard_key TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    expression TEXT NOT NULL,
    description TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`);
  db.run(sql`CREATE UNIQUE INDEX guard_definitions_guard_key_version_uq
    ON guard_definitions(guard_key, version)`);
  db.run(sql`CREATE INDEX guard_definitions_created_at_idx
    ON guard_definitions(created_at)`);

  db.run(sql`CREATE TABLE workflow_runs (
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
  db.run(sql`CREATE INDEX workflow_runs_created_at_idx
    ON workflow_runs(created_at)`);

  db.run(sql`CREATE TABLE tree_nodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_tree_id INTEGER NOT NULL REFERENCES workflow_trees(id) ON DELETE CASCADE,
    node_key TEXT NOT NULL,
    node_type TEXT NOT NULL,
    provider TEXT,
    prompt_template_id INTEGER REFERENCES prompt_templates(id) ON DELETE RESTRICT,
    max_retries INTEGER NOT NULL DEFAULT 0,
    sequence_index INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    CONSTRAINT tree_nodes_node_type_ck
      CHECK (node_type IN ('agent', 'human', 'tool')),
    CONSTRAINT tree_nodes_provider_for_agent_ck
      CHECK ((node_type <> 'agent') OR (provider IS NOT NULL)),
    CONSTRAINT tree_nodes_max_retries_ck
      CHECK (max_retries >= 0)
  )`);
  db.run(sql`CREATE UNIQUE INDEX tree_nodes_tree_id_node_key_uq
    ON tree_nodes(workflow_tree_id, node_key)`);
  db.run(sql`CREATE UNIQUE INDEX tree_nodes_tree_id_sequence_uq
    ON tree_nodes(workflow_tree_id, sequence_index)`);
  db.run(sql`CREATE INDEX tree_nodes_node_key_idx
    ON tree_nodes(node_key)`);
  db.run(sql`CREATE INDEX tree_nodes_created_at_idx
    ON tree_nodes(created_at)`);

  db.run(sql`CREATE TABLE tree_edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_tree_id INTEGER NOT NULL REFERENCES workflow_trees(id) ON DELETE CASCADE,
    source_node_id INTEGER NOT NULL REFERENCES tree_nodes(id) ON DELETE CASCADE,
    target_node_id INTEGER NOT NULL REFERENCES tree_nodes(id) ON DELETE CASCADE,
    priority INTEGER NOT NULL,
    auto INTEGER NOT NULL DEFAULT 0,
    guard_definition_id INTEGER REFERENCES guard_definitions(id) ON DELETE RESTRICT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    CONSTRAINT tree_edges_auto_bool_ck
      CHECK (auto IN (0, 1)),
    CONSTRAINT tree_edges_priority_ck
      CHECK (priority >= 0),
    CONSTRAINT tree_edges_transition_mode_ck
      CHECK (
        (auto = 1 AND guard_definition_id IS NULL)
        OR
        (auto = 0 AND guard_definition_id IS NOT NULL)
      )
  )`);
  db.run(sql`CREATE UNIQUE INDEX tree_edges_source_priority_uq
    ON tree_edges(source_node_id, priority)`);
  db.run(sql`CREATE INDEX tree_edges_source_node_idx
    ON tree_edges(source_node_id)`);
  db.run(sql`CREATE INDEX tree_edges_created_at_idx
    ON tree_edges(created_at)`);

  db.run(sql`CREATE TABLE run_nodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_run_id INTEGER NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
    tree_node_id INTEGER NOT NULL REFERENCES tree_nodes(id) ON DELETE RESTRICT,
    node_key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    sequence_index INTEGER NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 1,
    started_at TEXT,
    completed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    CONSTRAINT run_nodes_status_ck
      CHECK (status IN ('pending', 'running', 'completed', 'failed', 'skipped', 'cancelled')),
    CONSTRAINT run_nodes_attempt_ck
      CHECK (attempt > 0),
    CONSTRAINT run_nodes_running_started_at_ck
      CHECK ((status <> 'running') OR (started_at IS NOT NULL)),
    CONSTRAINT run_nodes_completion_timestamp_ck
      CHECK (
        (status IN ('pending', 'running') AND completed_at IS NULL)
        OR
        (status IN ('completed', 'failed', 'skipped', 'cancelled') AND completed_at IS NOT NULL)
      )
  )`);
  db.run(sql`CREATE UNIQUE INDEX run_nodes_run_id_sequence_uq
    ON run_nodes(workflow_run_id, sequence_index)`);
  db.run(sql`CREATE UNIQUE INDEX run_nodes_run_id_node_attempt_uq
    ON run_nodes(workflow_run_id, node_key, attempt)`);
  db.run(sql`CREATE INDEX run_nodes_run_id_status_idx
    ON run_nodes(workflow_run_id, status)`);
  db.run(sql`CREATE INDEX run_nodes_run_id_sequence_idx
    ON run_nodes(workflow_run_id, sequence_index)`);
  db.run(sql`CREATE INDEX run_nodes_node_key_idx
    ON run_nodes(node_key)`);
  db.run(sql`CREATE INDEX run_nodes_created_at_idx
    ON run_nodes(created_at)`);

  db.run(sql`CREATE TABLE routing_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_run_id INTEGER NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
    run_node_id INTEGER NOT NULL REFERENCES run_nodes(id) ON DELETE CASCADE,
    decision_type TEXT NOT NULL,
    rationale TEXT,
    raw_output TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    CONSTRAINT routing_decisions_decision_type_ck
      CHECK (decision_type IN ('approved', 'changes_requested', 'blocked', 'retry', 'no_route'))
  )`);
  db.run(sql`CREATE INDEX routing_decisions_run_id_created_at_idx
    ON routing_decisions(workflow_run_id, created_at)`);
  db.run(sql`CREATE INDEX routing_decisions_created_at_idx
    ON routing_decisions(created_at)`);

  db.run(sql`CREATE TABLE phase_artifacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_run_id INTEGER NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
    run_node_id INTEGER NOT NULL REFERENCES run_nodes(id) ON DELETE CASCADE,
    artifact_type TEXT NOT NULL DEFAULT 'report',
    content_type TEXT NOT NULL,
    content TEXT NOT NULL,
    metadata TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    CONSTRAINT phase_artifacts_artifact_type_ck
      CHECK (artifact_type IN ('report', 'note', 'log')),
    CONSTRAINT phase_artifacts_content_type_ck
      CHECK (content_type IN ('text', 'markdown', 'json', 'diff'))
  )`);
  db.run(sql`CREATE INDEX phase_artifacts_run_id_created_at_idx
    ON phase_artifacts(workflow_run_id, created_at)`);
  db.run(sql`CREATE INDEX phase_artifacts_created_at_idx
    ON phase_artifacts(created_at)`);
}
