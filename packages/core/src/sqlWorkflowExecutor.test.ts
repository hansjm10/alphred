import { execFile } from 'node:child_process';
import { access, mkdtemp, rename, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import {
  routingDecisionContractLinePrefix,
  routingDecisionContractSentinel,
  type ProviderEvent,
  type ProviderRunOptions,
} from '@alphred/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  createDatabase,
  guardDefinitions,
  materializeWorkflowRunFromTree,
  migrateDatabase,
  phaseArtifacts,
  promptTemplates,
  runNodeDiagnostics,
  runNodeEdges,
  runNodeStreamEvents,
  runJoinBarriers,
  runNodes,
  routingDecisions,
  transitionRunNodeStatus,
  transitionWorkflowRunStatus,
  treeEdges,
  treeNodes,
  workflowRuns,
  workflowTrees,
} from '@alphred/db';
import { MAX_CONTEXT_CHARS_TOTAL } from './sql-workflow-executor/constants.js';
import { createSqlWorkflowExecutor } from './sql-workflow-executor/index.js';

const coreSourceDirectory = fileURLToPath(new URL('.', import.meta.url));
const corePackageRoot = resolve(coreSourceDirectory, '..');
const workspaceRoot = resolve(corePackageRoot, '../..');
const execFileAsync = promisify(execFile);
const workflowRunStatusAudit = sqliteTable('workflow_run_status_audit', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  oldStatus: text('old_status').notNull(),
  newStatus: text('new_status').notNull(),
});

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function withDistDirectoriesTemporarilyHidden<T>(
  distDirectories: readonly string[],
  run: () => Promise<T>,
): Promise<T> {
  const hiddenRootDirectory = await mkdtemp(resolve(corePackageRoot, '.tmp-no-dist-'));
  const movedDirectories: { originalPath: string; hiddenPath: string }[] = [];

  try {
    for (const [index, distDirectory] of distDirectories.entries()) {
      const originalPath = resolve(distDirectory);
      if (!(await pathExists(originalPath))) {
        continue;
      }

      const hiddenPath = resolve(hiddenRootDirectory, `hidden-${index}`);
      await rename(originalPath, hiddenPath);
      movedDirectories.push({ originalPath, hiddenPath });
    }

    return await run();
  } finally {
    for (const movedDirectory of [...movedDirectories].reverse()) {
      if (await pathExists(movedDirectory.hiddenPath)) {
        await rename(movedDirectory.hiddenPath, movedDirectory.originalPath);
      }
    }
    await rm(hiddenRootDirectory, { recursive: true, force: true });
  }
}

async function runVitestSubprocess(args: readonly string[]): Promise<void> {
  const vitestEntrypoint = resolve(workspaceRoot, 'node_modules/vitest/vitest.mjs');

  try {
    await execFileAsync(
      process.execPath,
      [vitestEntrypoint, 'run', ...args],
      {
        cwd: workspaceRoot,
        maxBuffer: 10 * 1024 * 1024,
      },
    );
  } catch (error) {
    if (error instanceof Error && 'stdout' in error && 'stderr' in error) {
      const stdout = String((error as { stdout?: unknown }).stdout ?? '').trim();
      const stderr = String((error as { stderr?: unknown }).stderr ?? '').trim();
      const output = [stdout, stderr].filter(part => part.length > 0).join('\n');
      throw new Error(`Child vitest run failed while dist directories were hidden.\n${output}`);
    }

    throw error;
  }
}

function createProvider(events: ProviderEvent[]) {
  return {
    async *run(_prompt: string, _options: ProviderRunOptions): AsyncIterable<ProviderEvent> {
      for (const event of events) {
        yield event;
      }
    },
  };
}

function seedSingleAgentRun(
  promptContentType: 'markdown' | 'text' = 'markdown',
  maxRetries = 0,
) {
  const db = createDatabase(':memory:');
  migrateDatabase(db);

  const tree = db
    .insert(workflowTrees)
    .values({
      treeKey: 'design_tree',
      version: 1,
      name: 'Design Tree',
    })
    .returning({ id: workflowTrees.id })
    .get();

  const prompt = db
    .insert(promptTemplates)
    .values({
      templateKey: 'design_prompt',
      version: 1,
      content: 'Create a design report',
      contentType: promptContentType,
    })
    .returning({ id: promptTemplates.id })
    .get();

  db.insert(treeNodes)
    .values({
      workflowTreeId: tree.id,
      nodeKey: 'design',
      nodeType: 'agent',
      provider: 'codex',
      promptTemplateId: prompt.id,
      maxRetries,
      sequenceIndex: 1,
    })
    .run();

  const materialized = materializeWorkflowRunFromTree(db, { treeKey: 'design_tree' });
  return {
    db,
    runId: materialized.run.id,
    runNodeId: materialized.runNodes[0].id,
  };
}

function seedTwoRootAgentRun() {
  const db = createDatabase(':memory:');
  migrateDatabase(db);

  const tree = db
    .insert(workflowTrees)
    .values({
      treeKey: 'two_root_tree',
      version: 1,
      name: 'Two Root Tree',
    })
    .returning({ id: workflowTrees.id })
    .get();

  const prompt = db
    .insert(promptTemplates)
    .values({
      templateKey: 'two_root_prompt',
      version: 1,
      content: 'Create report',
      contentType: 'markdown',
    })
    .returning({ id: promptTemplates.id })
    .get();

  db.insert(treeNodes)
    .values([
      {
        workflowTreeId: tree.id,
        nodeKey: 'a',
        nodeType: 'agent',
        provider: 'codex',
        promptTemplateId: prompt.id,
        sequenceIndex: 1,
      },
      {
        workflowTreeId: tree.id,
        nodeKey: 'b',
        nodeType: 'agent',
        provider: 'codex',
        promptTemplateId: prompt.id,
        sequenceIndex: 2,
      },
    ])
    .run();

  const materialized = materializeWorkflowRunFromTree(db, { treeKey: 'two_root_tree' });
  const nodeRows = db
    .select({
      id: runNodes.id,
      nodeKey: runNodes.nodeKey,
    })
    .from(runNodes)
    .where(eq(runNodes.workflowRunId, materialized.run.id))
    .all();

  const firstNode = nodeRows.find(node => node.nodeKey === 'a');
  const secondNode = nodeRows.find(node => node.nodeKey === 'b');
  if (!firstNode || !secondNode) {
    throw new Error('Expected both root run-nodes to be materialized.');
  }

  return {
    db,
    runId: materialized.run.id,
    firstRunNodeId: firstNode.id,
    secondRunNodeId: secondNode.id,
  };
}

function seedLinearAutoRun() {
  const db = createDatabase(':memory:');
  migrateDatabase(db);

  const tree = db
    .insert(workflowTrees)
    .values({
      treeKey: 'linear_auto_tree',
      version: 1,
      name: 'Linear Auto Tree',
    })
    .returning({ id: workflowTrees.id })
    .get();

  const prompt = db
    .insert(promptTemplates)
    .values({
      templateKey: 'linear_auto_prompt',
      version: 1,
      content: 'Create report',
      contentType: 'markdown',
    })
    .returning({ id: promptTemplates.id })
    .get();

  const sourceNode = db
    .insert(treeNodes)
    .values({
      workflowTreeId: tree.id,
      nodeKey: 'source',
      nodeType: 'agent',
      provider: 'codex',
      promptTemplateId: prompt.id,
      sequenceIndex: 1,
    })
    .returning({ id: treeNodes.id })
    .get();

  const targetNode = db
    .insert(treeNodes)
    .values({
      workflowTreeId: tree.id,
      nodeKey: 'target',
      nodeType: 'agent',
      provider: 'codex',
      promptTemplateId: prompt.id,
      sequenceIndex: 2,
    })
    .returning({ id: treeNodes.id })
    .get();

  db.insert(treeEdges)
    .values({
      workflowTreeId: tree.id,
      sourceNodeId: sourceNode.id,
      targetNodeId: targetNode.id,
      priority: 0,
      auto: 1,
    })
    .run();

  const materialized = materializeWorkflowRunFromTree(db, { treeKey: 'linear_auto_tree' });
  const nodeRows = db
    .select({
      id: runNodes.id,
      nodeKey: runNodes.nodeKey,
    })
    .from(runNodes)
    .where(eq(runNodes.workflowRunId, materialized.run.id))
    .all();

  const sourceRunNode = nodeRows.find(node => node.nodeKey === 'source');
  const targetRunNode = nodeRows.find(node => node.nodeKey === 'target');
  if (!sourceRunNode || !targetRunNode) {
    throw new Error('Expected linear auto run-nodes to be materialized.');
  }

  return {
    db,
    runId: materialized.run.id,
    sourceRunNodeId: sourceRunNode.id,
    targetRunNodeId: targetRunNode.id,
  };
}

function seedFailureRoutingRun(params: {
  sourceMaxRetries?: number;
  failureTargets?: readonly {
    nodeKey: string;
    priority: number;
  }[];
} = {}) {
  const sourceMaxRetries = params.sourceMaxRetries ?? 0;
  const failureTargets = params.failureTargets ?? [{ nodeKey: 'remediation', priority: 0 }];
  const db = createDatabase(':memory:');
  migrateDatabase(db);

  const tree = db
    .insert(workflowTrees)
    .values({
      treeKey: 'failure_routing_tree',
      version: 1,
      name: 'Failure Routing Tree',
    })
    .returning({ id: workflowTrees.id })
    .get();

  const prompt = db
    .insert(promptTemplates)
    .values({
      templateKey: 'failure_routing_prompt',
      version: 1,
      content: 'Handle node work',
      contentType: 'markdown',
    })
    .returning({ id: promptTemplates.id })
    .get();

  const sourceNode = db
    .insert(treeNodes)
    .values({
      workflowTreeId: tree.id,
      nodeKey: 'source',
      nodeType: 'agent',
      provider: 'codex',
      promptTemplateId: prompt.id,
      maxRetries: sourceMaxRetries,
      sequenceIndex: 10,
    })
    .returning({ id: treeNodes.id })
    .get();

  const failureTargetRows = failureTargets.map((target, index) => ({
    target,
    node: db
      .insert(treeNodes)
      .values({
        workflowTreeId: tree.id,
        nodeKey: target.nodeKey,
        nodeType: 'agent',
        provider: 'codex',
        promptTemplateId: prompt.id,
        sequenceIndex: 20 + (index * 10),
      })
      .returning({ id: treeNodes.id })
      .get(),
  }));

  const targetByTreeNodeId = new Map(
    failureTargetRows.map(({ target, node }) => [node.id, target]),
  );

  const failureEdges = failureTargetRows.length === 0
    ? []
    : db
      .insert(treeEdges)
      .values(
        failureTargetRows.map(({ target, node }) => ({
          workflowTreeId: tree.id,
          sourceNodeId: sourceNode.id,
          targetNodeId: node.id,
          routeOn: 'failure',
          priority: target.priority,
          auto: 1,
        })),
      )
      .returning({
        id: treeEdges.id,
        targetNodeId: treeEdges.targetNodeId,
      })
      .all();

  const materialized = materializeWorkflowRunFromTree(db, { treeKey: 'failure_routing_tree' });
  const runNodeRows = db
    .select({
      id: runNodes.id,
      nodeKey: runNodes.nodeKey,
    })
    .from(runNodes)
    .where(eq(runNodes.workflowRunId, materialized.run.id))
    .all();
  const runNodeIdByKey = new Map(runNodeRows.map(row => [row.nodeKey, row.id]));
  const sourceRunNodeId = runNodeIdByKey.get('source');
  if (!sourceRunNodeId) {
    throw new Error('Expected source run-node to be materialized.');
  }

  const failureEdgeIdByTargetKey = new Map<string, number>(
    failureEdges.map((edge) => {
      const target = targetByTreeNodeId.get(edge.targetNodeId);
      if (!target) {
        throw new Error(`Expected failure target for tree_node_id=${edge.targetNodeId}.`);
      }

      return [target.nodeKey, edge.id];
    }),
  );

  return {
    db,
    runId: materialized.run.id,
    sourceRunNodeId,
    runNodeIdByKey,
    failureEdgeIdByTargetKey,
  };
}

function seedFailureRouteWithPreFailedRemediationTargetRun() {
  const db = createDatabase(':memory:');
  migrateDatabase(db);

  const tree = db
    .insert(workflowTrees)
    .values({
      treeKey: 'failure_route_with_prefailed_target_tree',
      version: 1,
      name: 'Failure Route With Prefailed Target Tree',
    })
    .returning({ id: workflowTrees.id })
    .get();

  const prompt = db
    .insert(promptTemplates)
    .values({
      templateKey: 'failure_route_with_prefailed_target_prompt',
      version: 1,
      content: 'Handle failure routing edge cases',
      contentType: 'markdown',
    })
    .returning({ id: promptTemplates.id })
    .get();

  const sourceNode = db
    .insert(treeNodes)
    .values({
      workflowTreeId: tree.id,
      nodeKey: 'source',
      nodeType: 'agent',
      provider: 'codex',
      promptTemplateId: prompt.id,
      maxRetries: 0,
      sequenceIndex: 10,
    })
    .returning({ id: treeNodes.id })
    .get();

  const remediationNode = db
    .insert(treeNodes)
    .values({
      workflowTreeId: tree.id,
      nodeKey: 'remediation',
      nodeType: 'agent',
      provider: 'codex',
      promptTemplateId: prompt.id,
      sequenceIndex: 20,
    })
    .returning({ id: treeNodes.id })
    .get();

  const fallbackNode = db
    .insert(treeNodes)
    .values({
      workflowTreeId: tree.id,
      nodeKey: 'fallback',
      nodeType: 'agent',
      provider: 'codex',
      promptTemplateId: prompt.id,
      sequenceIndex: 30,
    })
    .returning({ id: treeNodes.id })
    .get();

  db.insert(treeEdges)
    .values([
      {
        workflowTreeId: tree.id,
        sourceNodeId: sourceNode.id,
        targetNodeId: remediationNode.id,
        routeOn: 'failure',
        priority: 0,
        auto: 1,
      },
      {
        workflowTreeId: tree.id,
        sourceNodeId: remediationNode.id,
        targetNodeId: fallbackNode.id,
        routeOn: 'failure',
        priority: 0,
        auto: 1,
      },
    ])
    .run();

  const materialized = materializeWorkflowRunFromTree(db, { treeKey: 'failure_route_with_prefailed_target_tree' });
  const runNodeRows = db
    .select({
      id: runNodes.id,
      nodeKey: runNodes.nodeKey,
    })
    .from(runNodes)
    .where(eq(runNodes.workflowRunId, materialized.run.id))
    .all();
  const runNodeIdByKey = new Map(runNodeRows.map(row => [row.nodeKey, row.id]));

  const sourceRunNodeId = runNodeIdByKey.get('source');
  const remediationRunNodeId = runNodeIdByKey.get('remediation');
  const fallbackRunNodeId = runNodeIdByKey.get('fallback');
  if (!sourceRunNodeId || !remediationRunNodeId || !fallbackRunNodeId) {
    throw new Error('Expected source, remediation, and fallback run-nodes to be materialized.');
  }

  transitionRunNodeStatus(db, {
    runNodeId: remediationRunNodeId,
    expectedFrom: 'pending',
    to: 'running',
  });
  transitionRunNodeStatus(db, {
    runNodeId: remediationRunNodeId,
    expectedFrom: 'running',
    to: 'failed',
  });
  transitionRunNodeStatus(db, {
    runNodeId: fallbackRunNodeId,
    expectedFrom: 'pending',
    to: 'running',
  });
  transitionRunNodeStatus(db, {
    runNodeId: fallbackRunNodeId,
    expectedFrom: 'running',
    to: 'completed',
  });

  return {
    db,
    runId: materialized.run.id,
    sourceRunNodeId,
    remediationRunNodeId,
    fallbackRunNodeId,
  };
}

function seedConvergingFailureRouteContextRun() {
  const db = createDatabase(':memory:');
  migrateDatabase(db);

  const tree = db
    .insert(workflowTrees)
    .values({
      treeKey: 'converging_failure_route_context_tree',
      version: 1,
      name: 'Converging Failure Route Context Tree',
    })
    .returning({ id: workflowTrees.id })
    .get();

  const prompt = db
    .insert(promptTemplates)
    .values({
      templateKey: 'converging_failure_route_context_prompt',
      version: 1,
      content: 'Handle failure remediation',
      contentType: 'markdown',
    })
    .returning({ id: promptTemplates.id })
    .get();

  const sourceANode = db
    .insert(treeNodes)
    .values({
      workflowTreeId: tree.id,
      nodeKey: 'source_a',
      nodeType: 'agent',
      provider: 'codex',
      promptTemplateId: prompt.id,
      sequenceIndex: 10,
    })
    .returning({ id: treeNodes.id })
    .get();

  const remediationNode = db
    .insert(treeNodes)
    .values({
      workflowTreeId: tree.id,
      nodeKey: 'remediation',
      nodeType: 'agent',
      provider: 'codex',
      promptTemplateId: prompt.id,
      sequenceIndex: 20,
    })
    .returning({ id: treeNodes.id })
    .get();

  const sourceBNode = db
    .insert(treeNodes)
    .values({
      workflowTreeId: tree.id,
      nodeKey: 'source_b',
      nodeType: 'agent',
      provider: 'codex',
      promptTemplateId: prompt.id,
      sequenceIndex: 30,
    })
    .returning({ id: treeNodes.id })
    .get();

  db.insert(treeEdges)
    .values([
      {
        workflowTreeId: tree.id,
        sourceNodeId: sourceANode.id,
        targetNodeId: remediationNode.id,
        routeOn: 'failure',
        priority: 0,
        auto: 1,
      },
      {
        workflowTreeId: tree.id,
        sourceNodeId: remediationNode.id,
        targetNodeId: sourceBNode.id,
        priority: 0,
        auto: 1,
      },
      {
        workflowTreeId: tree.id,
        sourceNodeId: sourceBNode.id,
        targetNodeId: remediationNode.id,
        routeOn: 'failure',
        priority: 0,
        auto: 1,
      },
    ])
    .run();

  const materialized = materializeWorkflowRunFromTree(db, {
    treeKey: 'converging_failure_route_context_tree',
  });
  const runNodeRows = db
    .select({
      id: runNodes.id,
      nodeKey: runNodes.nodeKey,
    })
    .from(runNodes)
    .where(eq(runNodes.workflowRunId, materialized.run.id))
    .all();
  const runNodeIdByKey = new Map(runNodeRows.map(row => [row.nodeKey, row.id]));

  return {
    db,
    runId: materialized.run.id,
    runNodeIdByKey,
  };
}

function seedMixedRoutingRevisitRun() {
  const db = createDatabase(':memory:');
  migrateDatabase(db);

  const tree = db
    .insert(workflowTrees)
    .values({
      treeKey: 'mixed_routing_revisit_tree',
      version: 1,
      name: 'Mixed Routing Revisit Tree',
    })
    .returning({ id: workflowTrees.id })
    .get();

  const prompt = db
    .insert(promptTemplates)
    .values({
      templateKey: 'mixed_routing_revisit_prompt',
      version: 1,
      content: 'Generate workflow output',
      contentType: 'markdown',
    })
    .returning({ id: promptTemplates.id })
    .get();

  const approvedGuard = db
    .insert(guardDefinitions)
    .values({
      guardKey: 'mixed_routing_revisit_approved',
      version: 1,
      expression: {
        field: 'decision',
        operator: '==',
        value: 'approved',
      },
    })
    .returning({ id: guardDefinitions.id })
    .get();

  const sourceNode = db
    .insert(treeNodes)
    .values({
      workflowTreeId: tree.id,
      nodeKey: 'source',
      nodeType: 'agent',
      provider: 'codex',
      promptTemplateId: prompt.id,
      sequenceIndex: 10,
    })
    .returning({ id: treeNodes.id })
    .get();

  const reviewNode = db
    .insert(treeNodes)
    .values({
      workflowTreeId: tree.id,
      nodeKey: 'review',
      nodeType: 'agent',
      provider: 'codex',
      promptTemplateId: prompt.id,
      sequenceIndex: 20,
    })
    .returning({ id: treeNodes.id })
    .get();

  const approvedNode = db
    .insert(treeNodes)
    .values({
      workflowTreeId: tree.id,
      nodeKey: 'approved_target',
      nodeType: 'agent',
      provider: 'codex',
      promptTemplateId: prompt.id,
      sequenceIndex: 30,
    })
    .returning({ id: treeNodes.id })
    .get();

  const fallbackNode = db
    .insert(treeNodes)
    .values({
      workflowTreeId: tree.id,
      nodeKey: 'fallback_target',
      nodeType: 'agent',
      provider: 'codex',
      promptTemplateId: prompt.id,
      sequenceIndex: 40,
    })
    .returning({ id: treeNodes.id })
    .get();

  db.insert(treeEdges)
    .values([
      {
        workflowTreeId: tree.id,
        sourceNodeId: sourceNode.id,
        targetNodeId: reviewNode.id,
        priority: 0,
        auto: 1,
      },
      {
        workflowTreeId: tree.id,
        sourceNodeId: reviewNode.id,
        targetNodeId: approvedNode.id,
        priority: 0,
        auto: 0,
        guardDefinitionId: approvedGuard.id,
      },
      {
        workflowTreeId: tree.id,
        sourceNodeId: reviewNode.id,
        targetNodeId: fallbackNode.id,
        priority: 1,
        auto: 1,
      },
    ])
    .run();

  const materialized = materializeWorkflowRunFromTree(db, {
    treeKey: 'mixed_routing_revisit_tree',
  });

  const runNodeRows = db
    .select({
      id: runNodes.id,
      nodeKey: runNodes.nodeKey,
    })
    .from(runNodes)
    .where(eq(runNodes.workflowRunId, materialized.run.id))
    .all();

  const runNodeIdByKey = new Map(runNodeRows.map(node => [node.nodeKey, node.id]));
  return {
    db,
    runId: materialized.run.id,
    sourceRunNodeId: runNodeIdByKey.get('source'),
    reviewRunNodeId: runNodeIdByKey.get('review'),
    approvedRunNodeId: runNodeIdByKey.get('approved_target'),
    fallbackRunNodeId: runNodeIdByKey.get('fallback_target'),
  };
}

function seedConvergingAutoRun() {
  const db = createDatabase(':memory:');
  migrateDatabase(db);

  const tree = db
    .insert(workflowTrees)
    .values({
      treeKey: 'converging_auto_tree',
      version: 1,
      name: 'Converging Auto Tree',
    })
    .returning({ id: workflowTrees.id })
    .get();

  const prompt = db
    .insert(promptTemplates)
    .values({
      templateKey: 'converging_auto_prompt',
      version: 1,
      content: 'Create report',
      contentType: 'markdown',
    })
    .returning({ id: promptTemplates.id })
    .get();

  const sourceA = db
    .insert(treeNodes)
    .values({
      workflowTreeId: tree.id,
      nodeKey: 'source_a',
      nodeType: 'agent',
      provider: 'codex',
      promptTemplateId: prompt.id,
      sequenceIndex: 1,
    })
    .returning({ id: treeNodes.id })
    .get();

  const sourceB = db
    .insert(treeNodes)
    .values({
      workflowTreeId: tree.id,
      nodeKey: 'source_b',
      nodeType: 'agent',
      provider: 'codex',
      promptTemplateId: prompt.id,
      sequenceIndex: 2,
    })
    .returning({ id: treeNodes.id })
    .get();

  const target = db
    .insert(treeNodes)
    .values({
      workflowTreeId: tree.id,
      nodeKey: 'target',
      nodeType: 'agent',
      provider: 'codex',
      promptTemplateId: prompt.id,
      sequenceIndex: 3,
    })
    .returning({ id: treeNodes.id })
    .get();

  db.insert(treeEdges)
    .values([
      {
        workflowTreeId: tree.id,
        sourceNodeId: sourceA.id,
        targetNodeId: target.id,
        priority: 0,
        auto: 1,
      },
      {
        workflowTreeId: tree.id,
        sourceNodeId: sourceB.id,
        targetNodeId: target.id,
        priority: 1,
        auto: 1,
      },
    ])
    .run();

  const materialized = materializeWorkflowRunFromTree(db, { treeKey: 'converging_auto_tree' });
  const nodeRows = db
    .select({
      id: runNodes.id,
      nodeKey: runNodes.nodeKey,
    })
    .from(runNodes)
    .where(eq(runNodes.workflowRunId, materialized.run.id))
    .all();

  const sourceARunNode = nodeRows.find(node => node.nodeKey === 'source_a');
  const sourceBRunNode = nodeRows.find(node => node.nodeKey === 'source_b');
  const targetRunNode = nodeRows.find(node => node.nodeKey === 'target');
  if (!sourceARunNode || !sourceBRunNode || !targetRunNode) {
    throw new Error('Expected converging auto run-nodes to be materialized.');
  }

  return {
    db,
    runId: materialized.run.id,
    sourceARunNodeId: sourceARunNode.id,
    sourceBRunNodeId: sourceBRunNode.id,
    targetRunNodeId: targetRunNode.id,
  };
}

function seedBrainstormPickResearchRun() {
  const db = createDatabase(':memory:');
  migrateDatabase(db);

  const tree = db
    .insert(workflowTrees)
    .values({
      treeKey: 'brainstorm_pick_research_tree',
      version: 1,
      name: 'Brainstorm Pick Research Tree',
    })
    .returning({ id: workflowTrees.id })
    .get();

  const prompt = db
    .insert(promptTemplates)
    .values({
      templateKey: 'brainstorm_pick_research_prompt',
      version: 1,
      content: 'Generate phase output',
      contentType: 'markdown',
    })
    .returning({ id: promptTemplates.id })
    .get();

  const brainstormNode = db
    .insert(treeNodes)
    .values({
      workflowTreeId: tree.id,
      nodeKey: 'brainstorm',
      nodeType: 'agent',
      provider: 'codex',
      promptTemplateId: prompt.id,
      sequenceIndex: 1,
    })
    .returning({ id: treeNodes.id })
    .get();

  const pickNode = db
    .insert(treeNodes)
    .values({
      workflowTreeId: tree.id,
      nodeKey: 'pick',
      nodeType: 'agent',
      provider: 'codex',
      promptTemplateId: prompt.id,
      sequenceIndex: 2,
    })
    .returning({ id: treeNodes.id })
    .get();

  const researchNode = db
    .insert(treeNodes)
    .values({
      workflowTreeId: tree.id,
      nodeKey: 'research',
      nodeType: 'agent',
      provider: 'codex',
      promptTemplateId: prompt.id,
      sequenceIndex: 3,
    })
    .returning({ id: treeNodes.id })
    .get();

  db.insert(treeEdges)
    .values([
      {
        workflowTreeId: tree.id,
        sourceNodeId: brainstormNode.id,
        targetNodeId: pickNode.id,
        priority: 0,
        auto: 1,
      },
      {
        workflowTreeId: tree.id,
        sourceNodeId: pickNode.id,
        targetNodeId: researchNode.id,
        priority: 0,
        auto: 1,
      },
    ])
    .run();

  const materialized = materializeWorkflowRunFromTree(db, {
    treeKey: 'brainstorm_pick_research_tree',
  });

  const nodeRows = db
    .select({
      id: runNodes.id,
      nodeKey: runNodes.nodeKey,
    })
    .from(runNodes)
    .where(eq(runNodes.workflowRunId, materialized.run.id))
    .all();

  const runNodeIdByKey = new Map(nodeRows.map(node => [node.nodeKey, node.id]));
  return {
    db,
    runId: materialized.run.id,
    runNodeIdByKey,
  };
}

function seedFiveSourceConvergingRun() {
  const db = createDatabase(':memory:');
  migrateDatabase(db);

  const tree = db
    .insert(workflowTrees)
    .values({
      treeKey: 'five_source_converging_tree',
      version: 1,
      name: 'Five Source Converging Tree',
    })
    .returning({ id: workflowTrees.id })
    .get();

  const prompt = db
    .insert(promptTemplates)
    .values({
      templateKey: 'five_source_converging_prompt',
      version: 1,
      content: 'Generate phase output',
      contentType: 'markdown',
    })
    .returning({ id: promptTemplates.id })
    .get();

  const sourceNodeIds: number[] = [];
  for (const [index, sourceKey] of ['source_a', 'source_b', 'source_c', 'source_d', 'source_e'].entries()) {
    const sourceNode = db
      .insert(treeNodes)
      .values({
        workflowTreeId: tree.id,
        nodeKey: sourceKey,
        nodeType: 'agent',
        provider: 'codex',
        promptTemplateId: prompt.id,
        sequenceIndex: index + 1,
      })
      .returning({ id: treeNodes.id })
      .get();
    sourceNodeIds.push(sourceNode.id);
  }

  const targetNode = db
    .insert(treeNodes)
    .values({
      workflowTreeId: tree.id,
      nodeKey: 'target',
      nodeType: 'agent',
      provider: 'codex',
      promptTemplateId: prompt.id,
      sequenceIndex: 6,
    })
    .returning({ id: treeNodes.id })
    .get();

  db.insert(treeEdges)
    .values(
      sourceNodeIds.map((sourceNodeId, index) => ({
        workflowTreeId: tree.id,
        sourceNodeId,
        targetNodeId: targetNode.id,
        priority: index,
        auto: 1,
      })),
    )
    .run();

  const materialized = materializeWorkflowRunFromTree(db, { treeKey: 'five_source_converging_tree' });
  const nodeRows = db
    .select({
      id: runNodes.id,
      nodeKey: runNodes.nodeKey,
    })
    .from(runNodes)
    .where(eq(runNodes.workflowRunId, materialized.run.id))
    .all();

  return {
    db,
    runId: materialized.run.id,
    runNodeIdByKey: new Map(nodeRows.map(node => [node.nodeKey, node.id])),
  };
}

function seedSingleAgentRunWithoutPromptTemplate() {
  const db = createDatabase(':memory:');
  migrateDatabase(db);

  const tree = db
    .insert(workflowTrees)
    .values({
      treeKey: 'design_tree_without_prompt',
      version: 1,
      name: 'Design Tree Without Prompt',
    })
    .returning({ id: workflowTrees.id })
    .get();

  db.insert(treeNodes)
    .values({
      workflowTreeId: tree.id,
      nodeKey: 'design',
      nodeType: 'agent',
      provider: 'codex',
      sequenceIndex: 1,
    })
    .run();

  const materialized = materializeWorkflowRunFromTree(db, {
    treeKey: 'design_tree_without_prompt',
  });

  return {
    db,
    runId: materialized.run.id,
    runNodeId: materialized.runNodes[0].id,
  };
}

function seedSingleHumanNodeRun() {
  const db = createDatabase(':memory:');
  migrateDatabase(db);

  const tree = db
    .insert(workflowTrees)
    .values({
      treeKey: 'human_tree',
      version: 1,
      name: 'Human Tree',
    })
    .returning({ id: workflowTrees.id })
    .get();

  db.insert(treeNodes)
    .values({
      workflowTreeId: tree.id,
      nodeKey: 'human_review',
      nodeType: 'human',
      sequenceIndex: 1,
    })
    .run();

  const materialized = materializeWorkflowRunFromTree(db, {
    treeKey: 'human_tree',
  });

  return {
    db,
    runId: materialized.run.id,
    runNodeId: materialized.runNodes[0].id,
  };
}

function seedGuardedCycleRun() {
  const db = createDatabase(':memory:');
  migrateDatabase(db);

  const tree = db
    .insert(workflowTrees)
    .values({
      treeKey: 'guarded_cycle_tree',
      version: 1,
      name: 'Guarded Cycle Tree',
    })
    .returning({ id: workflowTrees.id })
    .get();

  const prompt = db
    .insert(promptTemplates)
    .values({
      templateKey: 'guarded_cycle_prompt',
      version: 1,
      content: 'Draft report',
      contentType: 'markdown',
    })
    .returning({ id: promptTemplates.id })
    .get();

  const guard = db
    .insert(guardDefinitions)
    .values({
      guardKey: 'always_true',
      version: 1,
      expression: { operator: 'literal', value: true },
      description: 'Test guard for non-auto transition',
    })
    .returning({ id: guardDefinitions.id })
    .get();

  const nodeA = db
    .insert(treeNodes)
    .values({
      workflowTreeId: tree.id,
      nodeKey: 'a',
      nodeType: 'agent',
      provider: 'codex',
      promptTemplateId: prompt.id,
      sequenceIndex: 1,
    })
    .returning({ id: treeNodes.id })
    .get();

  const nodeB = db
    .insert(treeNodes)
    .values({
      workflowTreeId: tree.id,
      nodeKey: 'b',
      nodeType: 'agent',
      provider: 'codex',
      promptTemplateId: prompt.id,
      sequenceIndex: 2,
    })
    .returning({ id: treeNodes.id })
    .get();

  db.insert(treeEdges)
    .values([
      {
        workflowTreeId: tree.id,
        sourceNodeId: nodeA.id,
        targetNodeId: nodeB.id,
        priority: 0,
        auto: 0,
        guardDefinitionId: guard.id,
      },
      {
        workflowTreeId: tree.id,
        sourceNodeId: nodeB.id,
        targetNodeId: nodeA.id,
        priority: 0,
        auto: 0,
        guardDefinitionId: guard.id,
      },
    ])
    .run();

  const materialized = materializeWorkflowRunFromTree(db, {
    treeKey: 'guarded_cycle_tree',
  });

  return {
    db,
    runId: materialized.run.id,
  };
}

function seedDecisionRoutingRun(
  options: {
    approvedGuardOperator?: '==' | '!=';
    approvedGuardValue?: string;
    changesRequestedGuardOperator?: '==' | '!=';
    changesRequestedGuardValue?: string;
    reviewPromptContent?: string;
  } = {},
) {
  const db = createDatabase(':memory:');
  migrateDatabase(db);

  const tree = db
    .insert(workflowTrees)
    .values({
      treeKey: 'decision_routing_tree',
      version: 1,
      name: 'Decision Routing Tree',
    })
    .returning({ id: workflowTrees.id })
    .get();

  const prompt = db
    .insert(promptTemplates)
    .values({
      templateKey: 'decision_routing_prompt',
      version: 1,
      content: options.reviewPromptContent ?? 'Produce route decision',
      contentType: 'markdown',
    })
    .returning({ id: promptTemplates.id })
    .get();

  const approvedGuard = db
    .insert(guardDefinitions)
    .values({
      guardKey: 'route_approved',
      version: 1,
      expression: {
        field: 'decision',
        operator: options.approvedGuardOperator ?? '==',
        value: options.approvedGuardValue ?? 'approved',
      },
    })
    .returning({ id: guardDefinitions.id })
    .get();

  const changesRequestedGuard = db
    .insert(guardDefinitions)
    .values({
      guardKey: 'route_changes_requested',
      version: 1,
      expression: {
        field: 'decision',
        operator: options.changesRequestedGuardOperator ?? '==',
        value: options.changesRequestedGuardValue ?? 'changes_requested',
      },
    })
    .returning({ id: guardDefinitions.id })
    .get();

  const reviewNode = db
    .insert(treeNodes)
    .values({
      workflowTreeId: tree.id,
      nodeKey: 'review',
      nodeType: 'agent',
      provider: 'codex',
      promptTemplateId: prompt.id,
      sequenceIndex: 1,
    })
    .returning({ id: treeNodes.id })
    .get();

  const approvedNode = db
    .insert(treeNodes)
    .values({
      workflowTreeId: tree.id,
      nodeKey: 'approved_target',
      nodeType: 'agent',
      provider: 'codex',
      promptTemplateId: prompt.id,
      sequenceIndex: 2,
    })
    .returning({ id: treeNodes.id })
    .get();

  const reviseNode = db
    .insert(treeNodes)
    .values({
      workflowTreeId: tree.id,
      nodeKey: 'revise_target',
      nodeType: 'agent',
      provider: 'codex',
      promptTemplateId: prompt.id,
      sequenceIndex: 3,
    })
    .returning({ id: treeNodes.id })
    .get();

  db.insert(treeEdges)
    .values([
      {
        workflowTreeId: tree.id,
        sourceNodeId: reviewNode.id,
        targetNodeId: approvedNode.id,
        priority: 0,
        auto: 0,
        guardDefinitionId: approvedGuard.id,
      },
      {
        workflowTreeId: tree.id,
        sourceNodeId: reviewNode.id,
        targetNodeId: reviseNode.id,
        priority: 1,
        auto: 0,
        guardDefinitionId: changesRequestedGuard.id,
      },
    ])
    .run();

  const materialized = materializeWorkflowRunFromTree(db, {
    treeKey: 'decision_routing_tree',
  });

  const nodeRows = db
    .select({
      id: runNodes.id,
      nodeKey: runNodes.nodeKey,
    })
    .from(runNodes)
    .where(eq(runNodes.workflowRunId, materialized.run.id))
    .all();

  const reviewRunNode = nodeRows.find(node => node.nodeKey === 'review');
  const approvedRunNode = nodeRows.find(node => node.nodeKey === 'approved_target');
  const reviseRunNode = nodeRows.find(node => node.nodeKey === 'revise_target');
  if (!reviewRunNode || !approvedRunNode || !reviseRunNode) {
    throw new Error('Expected decision-routing run-nodes to be materialized.');
  }

  return {
    db,
    runId: materialized.run.id,
    reviewRunNodeId: reviewRunNode.id,
    approvedRunNodeId: approvedRunNode.id,
    reviseRunNodeId: reviseRunNode.id,
  };
}

function seedDesignTreeIntegrationRun() {
  const db = createDatabase(':memory:');
  migrateDatabase(db);

  const tree = db
    .insert(workflowTrees)
    .values({
      treeKey: 'design_tree',
      version: 1,
      name: 'Design Tree Integration',
    })
    .returning({ id: workflowTrees.id })
    .get();

  const researchPrompt = db
    .insert(promptTemplates)
    .values({
      templateKey: 'research_prompt',
      version: 1,
      content: 'Research the problem space.',
      contentType: 'markdown',
    })
    .returning({ id: promptTemplates.id })
    .get();

  const creationPrompt = db
    .insert(promptTemplates)
    .values({
      templateKey: 'creation_prompt',
      version: 1,
      content: 'Create an initial design.',
      contentType: 'markdown',
    })
    .returning({ id: promptTemplates.id })
    .get();

  const reviewPrompt = db
    .insert(promptTemplates)
    .values({
      templateKey: 'review_prompt',
      version: 1,
      content: 'Review and route with a decision directive.',
      contentType: 'markdown',
    })
    .returning({ id: promptTemplates.id })
    .get();

  const approvalPrompt = db
    .insert(promptTemplates)
    .values({
      templateKey: 'approval_prompt',
      version: 1,
      content: 'Record final approval.',
      contentType: 'markdown',
    })
    .returning({ id: promptTemplates.id })
    .get();

  const approvedGuard = db
    .insert(guardDefinitions)
    .values({
      guardKey: 'design_tree_approved',
      version: 1,
      expression: {
        field: 'decision',
        operator: '==',
        value: 'approved',
      },
    })
    .returning({ id: guardDefinitions.id })
    .get();

  const reviseGuard = db
    .insert(guardDefinitions)
    .values({
      guardKey: 'design_tree_revise',
      version: 1,
      expression: {
        field: 'decision',
        operator: '==',
        value: 'changes_requested',
      },
    })
    .returning({ id: guardDefinitions.id })
    .get();

  const researchNode = db
    .insert(treeNodes)
    .values({
      workflowTreeId: tree.id,
      nodeKey: 'research',
      nodeType: 'agent',
      provider: 'codex',
      promptTemplateId: researchPrompt.id,
      sequenceIndex: 10,
    })
    .returning({ id: treeNodes.id })
    .get();

  const creationNode = db
    .insert(treeNodes)
    .values({
      workflowTreeId: tree.id,
      nodeKey: 'creation',
      nodeType: 'agent',
      provider: 'codex',
      promptTemplateId: creationPrompt.id,
      sequenceIndex: 20,
    })
    .returning({ id: treeNodes.id })
    .get();

  const reviewNode = db
    .insert(treeNodes)
    .values({
      workflowTreeId: tree.id,
      nodeKey: 'review',
      nodeType: 'agent',
      provider: 'codex',
      promptTemplateId: reviewPrompt.id,
      sequenceIndex: 30,
    })
    .returning({ id: treeNodes.id })
    .get();

  const approvedNode = db
    .insert(treeNodes)
    .values({
      workflowTreeId: tree.id,
      nodeKey: 'approved',
      nodeType: 'agent',
      provider: 'codex',
      promptTemplateId: approvalPrompt.id,
      sequenceIndex: 40,
    })
    .returning({ id: treeNodes.id })
    .get();

  db.insert(treeEdges)
    .values([
      {
        workflowTreeId: tree.id,
        sourceNodeId: researchNode.id,
        targetNodeId: creationNode.id,
        priority: 0,
        auto: 1,
      },
      {
        workflowTreeId: tree.id,
        sourceNodeId: creationNode.id,
        targetNodeId: reviewNode.id,
        priority: 0,
        auto: 1,
      },
      {
        workflowTreeId: tree.id,
        sourceNodeId: reviewNode.id,
        targetNodeId: approvedNode.id,
        priority: 0,
        auto: 0,
        guardDefinitionId: approvedGuard.id,
      },
      {
        workflowTreeId: tree.id,
        sourceNodeId: reviewNode.id,
        targetNodeId: creationNode.id,
        priority: 1,
        auto: 0,
        guardDefinitionId: reviseGuard.id,
      },
    ])
    .run();

  const materialized = materializeWorkflowRunFromTree(db, {
    treeKey: 'design_tree',
  });

  const runNodeRows = db
    .select({
      id: runNodes.id,
      nodeKey: runNodes.nodeKey,
    })
    .from(runNodes)
    .where(eq(runNodes.workflowRunId, materialized.run.id))
    .all();

  const runNodeIdByKey = new Map(runNodeRows.map(node => [node.nodeKey, node.id]));
  return {
    db,
    runId: materialized.run.id,
    runNodeIdByKey,
  };
}

function seedDynamicFanOutIssue163Run() {
  const db = createDatabase(':memory:');
  migrateDatabase(db);

  const tree = db
    .insert(workflowTrees)
    .values({
      treeKey: 'issue-163-dynamic-fanout',
      version: 1,
      name: 'Issue 163 Dynamic Fan-Out',
    })
    .returning({ id: workflowTrees.id })
    .get();

  const designPrompt = db
    .insert(promptTemplates)
    .values({
      templateKey: 'issue_163_design_prompt',
      version: 1,
      content: 'Create an implementation design for issue 163.',
      contentType: 'markdown',
    })
    .returning({ id: promptTemplates.id })
    .get();

  const breakdownPrompt = db
    .insert(promptTemplates)
    .values({
      templateKey: 'issue_163_breakdown_prompt',
      version: 1,
      content: 'Break issue 163 into independent subtasks.',
      contentType: 'markdown',
    })
    .returning({ id: promptTemplates.id })
    .get();

  const finalReviewPrompt = db
    .insert(promptTemplates)
    .values({
      templateKey: 'issue_163_final_review_prompt',
      version: 1,
      content: 'Review all issue 163 work items together.',
      contentType: 'markdown',
    })
    .returning({ id: promptTemplates.id })
    .get();

  const createPrPrompt = db
    .insert(promptTemplates)
    .values({
      templateKey: 'issue_163_create_pr_prompt',
      version: 1,
      content: 'Prepare a PR summary for issue 163.',
      contentType: 'markdown',
    })
    .returning({ id: promptTemplates.id })
    .get();

  const insertedNodes = db
    .insert(treeNodes)
    .values([
      {
        workflowTreeId: tree.id,
        nodeKey: 'design',
        nodeType: 'agent',
        provider: 'codex',
        promptTemplateId: designPrompt.id,
        sequenceIndex: 10,
      },
      {
        workflowTreeId: tree.id,
        nodeKey: 'breakdown',
        nodeType: 'agent',
        nodeRole: 'spawner',
        provider: 'codex',
        promptTemplateId: breakdownPrompt.id,
        sequenceIndex: 20,
        maxChildren: 8,
      },
      {
        workflowTreeId: tree.id,
        nodeKey: 'final-review',
        nodeType: 'agent',
        nodeRole: 'join',
        provider: 'codex',
        promptTemplateId: finalReviewPrompt.id,
        sequenceIndex: 30,
      },
      {
        workflowTreeId: tree.id,
        nodeKey: 'create-pr',
        nodeType: 'agent',
        provider: 'codex',
        promptTemplateId: createPrPrompt.id,
        sequenceIndex: 40,
      },
    ])
    .returning({
      id: treeNodes.id,
      nodeKey: treeNodes.nodeKey,
    })
    .all();

  const nodeIdByKey = new Map(insertedNodes.map(node => [node.nodeKey, node.id]));
  const designNodeId = nodeIdByKey.get('design');
  const breakdownNodeId = nodeIdByKey.get('breakdown');
  const finalReviewNodeId = nodeIdByKey.get('final-review');
  const createPrNodeId = nodeIdByKey.get('create-pr');
  if (!designNodeId || !breakdownNodeId || !finalReviewNodeId || !createPrNodeId) {
    throw new Error('Expected dynamic fan-out tree nodes to be seeded.');
  }

  db.insert(treeEdges)
    .values([
      {
        workflowTreeId: tree.id,
        sourceNodeId: designNodeId,
        targetNodeId: breakdownNodeId,
        routeOn: 'success',
        priority: 0,
        auto: 1,
      },
      {
        workflowTreeId: tree.id,
        sourceNodeId: breakdownNodeId,
        targetNodeId: finalReviewNodeId,
        routeOn: 'success',
        priority: 0,
        auto: 1,
      },
      {
        workflowTreeId: tree.id,
        sourceNodeId: finalReviewNodeId,
        targetNodeId: createPrNodeId,
        routeOn: 'success',
        priority: 0,
        auto: 1,
      },
    ])
    .run();

  const materialized = materializeWorkflowRunFromTree(db, {
    treeKey: 'issue-163-dynamic-fanout',
  });

  const runNodeRows = db
    .select({
      id: runNodes.id,
      nodeKey: runNodes.nodeKey,
    })
    .from(runNodes)
    .where(eq(runNodes.workflowRunId, materialized.run.id))
    .all();

  const runNodeIdByKey = new Map(runNodeRows.map(node => [node.nodeKey, node.id]));
  return {
    db,
    runId: materialized.run.id,
    runNodeIdByKey,
  };
}

function seedGuardedDynamicFanOutNoRouteRun() {
  const db = createDatabase(':memory:');
  migrateDatabase(db);

  const tree = db
    .insert(workflowTrees)
    .values({
      treeKey: 'guarded-dynamic-fanout-no-route',
      version: 1,
      name: 'Guarded Dynamic Fan-Out No Route',
    })
    .returning({ id: workflowTrees.id })
    .get();

  const spawnerPrompt = db
    .insert(promptTemplates)
    .values({
      templateKey: 'guarded_dynamic_fanout_no_route_spawner_prompt',
      version: 1,
      content: 'Break issue into independent subtasks.',
      contentType: 'markdown',
    })
    .returning({ id: promptTemplates.id })
    .get();

  const joinPrompt = db
    .insert(promptTemplates)
    .values({
      templateKey: 'guarded_dynamic_fanout_no_route_join_prompt',
      version: 1,
      content: 'Aggregate subtask outcomes.',
      contentType: 'markdown',
    })
    .returning({ id: promptTemplates.id })
    .get();

  const approvedGuard = db
    .insert(guardDefinitions)
    .values({
      guardKey: 'guarded_dynamic_fanout_no_route_approved',
      version: 1,
      expression: {
        field: 'decision',
        operator: '==',
        value: 'approved',
      },
    })
    .returning({ id: guardDefinitions.id })
    .get();

  const insertedNodes = db
    .insert(treeNodes)
    .values([
      {
        workflowTreeId: tree.id,
        nodeKey: 'breakdown',
        nodeType: 'agent',
        nodeRole: 'spawner',
        provider: 'codex',
        promptTemplateId: spawnerPrompt.id,
        sequenceIndex: 10,
        maxChildren: 8,
      },
      {
        workflowTreeId: tree.id,
        nodeKey: 'final-review',
        nodeType: 'agent',
        nodeRole: 'join',
        provider: 'codex',
        promptTemplateId: joinPrompt.id,
        sequenceIndex: 20,
      },
    ])
    .returning({
      id: treeNodes.id,
      nodeKey: treeNodes.nodeKey,
    })
    .all();

  const nodeIdByKey = new Map(insertedNodes.map(node => [node.nodeKey, node.id]));
  const breakdownNodeId = nodeIdByKey.get('breakdown');
  const finalReviewNodeId = nodeIdByKey.get('final-review');
  if (!breakdownNodeId || !finalReviewNodeId) {
    throw new Error('Expected guarded dynamic fan-out tree nodes to be seeded.');
  }

  db.insert(treeEdges)
    .values({
      workflowTreeId: tree.id,
      sourceNodeId: breakdownNodeId,
      targetNodeId: finalReviewNodeId,
      routeOn: 'success',
      priority: 0,
      auto: 0,
      guardDefinitionId: approvedGuard.id,
    })
    .run();

  const materialized = materializeWorkflowRunFromTree(db, {
    treeKey: 'guarded-dynamic-fanout-no-route',
  });

  const runNodeRows = db
    .select({
      id: runNodes.id,
      nodeKey: runNodes.nodeKey,
    })
    .from(runNodes)
    .where(eq(runNodes.workflowRunId, materialized.run.id))
    .all();

  const runNodeIdByKey = new Map(runNodeRows.map(node => [node.nodeKey, node.id]));
  return {
    db,
    runId: materialized.run.id,
    runNodeIdByKey,
  };
}

describe('createSqlWorkflowExecutor', () => {
  it('executes runnable nodes, persists artifacts, and completes the run on success', async () => {
    const { db, runId, runNodeId } = seedSingleAgentRun();
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () =>
        createProvider([
          { type: 'system', content: 'start', timestamp: 100 },
          { type: 'usage', content: '', timestamp: 101, metadata: { totalTokens: 42 } },
          { type: 'result', content: 'Design report body', timestamp: 102 },
        ]),
    });

    const result = await executor.executeRun({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(result.executedNodes).toBe(1);
    expect(result.finalStep).toEqual({
      outcome: 'run_terminal',
      workflowRunId: runId,
      runStatus: 'completed',
    });

    const persistedRun = db
      .select({
        status: workflowRuns.status,
        startedAt: workflowRuns.startedAt,
        completedAt: workflowRuns.completedAt,
      })
      .from(workflowRuns)
      .where(eq(workflowRuns.id, runId))
      .get();

    expect(persistedRun).toBeDefined();
    if (!persistedRun) {
      throw new Error('Expected persisted workflow run row.');
    }

    expect(persistedRun.status).toBe('completed');
    expect(persistedRun.startedAt).not.toBeNull();
    expect(persistedRun.completedAt).not.toBeNull();

    const persistedRunNode = db
      .select({
        status: runNodes.status,
        startedAt: runNodes.startedAt,
        completedAt: runNodes.completedAt,
      })
      .from(runNodes)
      .where(eq(runNodes.id, runNodeId))
      .get();

    expect(persistedRunNode).toBeDefined();
    if (!persistedRunNode) {
      throw new Error('Expected persisted run-node row.');
    }

    expect(persistedRunNode.status).toBe('completed');
    expect(persistedRunNode.startedAt).not.toBeNull();
    expect(persistedRunNode.completedAt).not.toBeNull();

    const artifacts = db
      .select({
        artifactType: phaseArtifacts.artifactType,
        contentType: phaseArtifacts.contentType,
        content: phaseArtifacts.content,
      })
      .from(phaseArtifacts)
      .where(eq(phaseArtifacts.runNodeId, runNodeId))
      .all();

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toEqual({
      artifactType: 'report',
      contentType: 'markdown',
      content: 'Design report body',
    });
  });

  it('persists diagnostics for each executed node attempt in a multi-node run', async () => {
    const seeded = seedBrainstormPickResearchRun();
    let invocation = 0;
    const executor = createSqlWorkflowExecutor(seeded.db, {
      resolveProvider: () => ({
        async *run(): AsyncIterable<ProviderEvent> {
          invocation += 1;
          yield { type: 'system', content: `node invocation ${invocation}`, timestamp: invocation * 10 };
          yield { type: 'result', content: `result ${invocation}`, timestamp: invocation * 10 + 1 };
        },
      }),
    });

    const result = await executor.executeRun({
      workflowRunId: seeded.runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(result.finalStep).toEqual({
      outcome: 'run_terminal',
      workflowRunId: seeded.runId,
      runStatus: 'completed',
    });
    expect(result.executedNodes).toBe(3);

    const diagnosticsRows = seeded.db
      .select({
        runNodeId: runNodeDiagnostics.runNodeId,
        attempt: runNodeDiagnostics.attempt,
        outcome: runNodeDiagnostics.outcome,
      })
      .from(runNodeDiagnostics)
      .where(eq(runNodeDiagnostics.workflowRunId, seeded.runId))
      .orderBy(asc(runNodeDiagnostics.runNodeId), asc(runNodeDiagnostics.attempt), asc(runNodeDiagnostics.id))
      .all();

    expect(diagnosticsRows).toHaveLength(3);
    expect(new Set(diagnosticsRows.map(row => row.runNodeId))).toEqual(
      new Set([
        seeded.runNodeIdByKey.get('brainstorm'),
        seeded.runNodeIdByKey.get('pick'),
        seeded.runNodeIdByKey.get('research'),
      ]),
    );
    expect(diagnosticsRows.every(row => row.attempt === 1)).toBe(true);
    expect(diagnosticsRows.every(row => row.outcome === 'completed')).toBe(true);
  });

  it('captures tool events with deterministic ordering metadata in diagnostics payloads', async () => {
    const { db, runId, runNodeId } = seedSingleAgentRun();
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () =>
        createProvider([
          { type: 'system', content: 'start', timestamp: 100 },
          {
            type: 'tool_use',
            content: 'query issues',
            timestamp: 101,
            metadata: { toolName: 'github_search', args: { q: 'issue 150' } },
          },
          {
            type: 'tool_result',
            content: 'found issue',
            timestamp: 102,
            metadata: { toolName: 'github_search', resultCount: 1 },
          },
          { type: 'usage', content: '', timestamp: 103, metadata: { totalTokens: 19 } },
          { type: 'result', content: 'Design report body', timestamp: 104 },
        ]),
    });

    await executor.executeRun({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    const diagnostics = db
      .select({
        attempt: runNodeDiagnostics.attempt,
        outcome: runNodeDiagnostics.outcome,
        diagnostics: runNodeDiagnostics.diagnostics,
      })
      .from(runNodeDiagnostics)
      .where(eq(runNodeDiagnostics.runNodeId, runNodeId))
      .orderBy(asc(runNodeDiagnostics.id))
      .all();

    expect(diagnostics).toHaveLength(1);
    const payload = diagnostics[0]?.diagnostics as {
      events: { eventIndex: number; timestamp: number; type: string }[];
      toolEvents: { type: string; toolName: string | null }[];
      summary: { tokensUsed: number };
    };
    expect(diagnostics[0]?.attempt).toBe(1);
    expect(diagnostics[0]?.outcome).toBe('completed');
    expect(payload.events.map(event => event.eventIndex)).toEqual([0, 1, 2, 3, 4]);
    expect(payload.events.map(event => event.type)).toEqual(['system', 'tool_use', 'tool_result', 'usage', 'result']);
    expect(payload.events.map(event => event.timestamp)).toEqual([100, 101, 102, 103, 104]);
    expect(payload.toolEvents).toHaveLength(2);
    expect(payload.toolEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'tool_use',
          toolName: 'github_search',
        }),
        expect.objectContaining({
          type: 'tool_result',
          toolName: 'github_search',
        }),
      ]),
    );
    expect(payload.summary.tokensUsed).toBe(19);
  });

  it('persists per-attempt stream events with deterministic sequence ordering and normalized redaction', async () => {
    const { db, runId, runNodeId } = seedSingleAgentRun();
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () =>
        createProvider([
          { type: 'system', content: 'starting', timestamp: 100 },
          {
            type: 'tool_use',
            content: 'Bearer ABCDEFGHIJKLMNOP',
            timestamp: 101,
            metadata: { authorization: 'Bearer SECRET-TOKEN', toolName: 'search' },
          },
          { type: 'usage', content: '', timestamp: 102, metadata: { tokens: 9 } },
          { type: 'result', content: 'Design report body', timestamp: 103 },
        ]),
    });

    await executor.executeRun({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    const streamEvents = db
      .select({
        attempt: runNodeStreamEvents.attempt,
        sequence: runNodeStreamEvents.sequence,
        eventType: runNodeStreamEvents.eventType,
        timestamp: runNodeStreamEvents.timestamp,
        contentPreview: runNodeStreamEvents.contentPreview,
        metadata: runNodeStreamEvents.metadata,
        usageDeltaTokens: runNodeStreamEvents.usageDeltaTokens,
        usageCumulativeTokens: runNodeStreamEvents.usageCumulativeTokens,
      })
      .from(runNodeStreamEvents)
      .where(eq(runNodeStreamEvents.runNodeId, runNodeId))
      .orderBy(asc(runNodeStreamEvents.sequence), asc(runNodeStreamEvents.id))
      .all();

    expect(streamEvents).toHaveLength(4);
    expect(streamEvents.map(event => event.attempt)).toEqual([1, 1, 1, 1]);
    expect(streamEvents.map(event => event.sequence)).toEqual([1, 2, 3, 4]);
    expect(streamEvents.map(event => event.eventType)).toEqual(['system', 'tool_use', 'usage', 'result']);
    expect(streamEvents.map(event => event.timestamp)).toEqual([100, 101, 102, 103]);
    expect(streamEvents[1]?.contentPreview).toBe('[REDACTED]');
    expect(streamEvents[1]?.metadata).toMatchObject({
      authorization: '[REDACTED]',
      toolName: 'search',
    });
    expect(streamEvents[2]?.usageDeltaTokens).toBe(9);
    expect(streamEvents[2]?.usageCumulativeTokens).toBe(9);
    expect(streamEvents[3]?.usageDeltaTokens).toBeNull();
    expect(streamEvents[3]?.usageCumulativeTokens).toBeNull();
  });

  it('captures structured failure diagnostics when an attempt fails', async () => {
    const { db, runId, runNodeId } = seedSingleAgentRun();
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () =>
        createProvider([
          { type: 'system', content: 'start', timestamp: 100 },
          { type: 'assistant', content: 'partial response', timestamp: 101 },
        ]),
    });

    await executor.executeRun({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    const diagnostics = db
      .select({
        outcome: runNodeDiagnostics.outcome,
        diagnostics: runNodeDiagnostics.diagnostics,
      })
      .from(runNodeDiagnostics)
      .where(eq(runNodeDiagnostics.runNodeId, runNodeId))
      .orderBy(asc(runNodeDiagnostics.id))
      .all();

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.outcome).toBe('failed');
    const payload = diagnostics[0]?.diagnostics as {
      status: string;
      error: { classification: string; message: string } | null;
      summary: { eventCount: number; droppedEventCount: number };
    };
    expect(payload.status).toBe('failed');
    expect(payload.error?.classification).toBe('provider_result_missing');
    expect(payload.error?.message).toContain('without a result event');
    expect(payload.summary.eventCount).toBe(2);
    expect(payload.summary.droppedEventCount).toBe(0);
  });

  it('persists full failed command output with deterministic diagnostics retrieval references', async () => {
    const { db, runId, runNodeId } = seedSingleAgentRun();
    const longOutput = `config.webServer failed to launch.\n${'stderr-line\n'.repeat(800)}`;
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () =>
        createProvider([
          { type: 'system', content: 'start', timestamp: 100 },
          { type: 'tool_use', content: 'pnpm test:e2e', timestamp: 101, metadata: { itemType: 'command_execution' } },
          {
            type: 'tool_result',
            content: JSON.stringify({
              command: 'pnpm test:e2e',
              output: longOutput,
              exit_code: 1,
            }),
            timestamp: 102,
            metadata: { itemType: 'command_execution' },
          },
        ]),
    });

    const execution = await executor.executeRun({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(execution.finalStep).toEqual({
      outcome: 'run_terminal',
      workflowRunId: runId,
      runStatus: 'failed',
    });

    const diagnosticsRow = db
      .select({
        diagnostics: runNodeDiagnostics.diagnostics,
      })
      .from(runNodeDiagnostics)
      .where(eq(runNodeDiagnostics.runNodeId, runNodeId))
      .orderBy(asc(runNodeDiagnostics.id))
      .limit(1)
      .get();
    const diagnosticsPayload = diagnosticsRow?.diagnostics as
      | {
          failedCommandOutputs?: {
            eventIndex: number;
            sequence: number;
            command: string | null;
            exitCode: number | null;
            outputChars: number;
            path: string;
          }[];
          events: { type: string; contentPreview: string }[];
        }
      | undefined;

    expect(diagnosticsPayload?.failedCommandOutputs).toEqual([
      expect.objectContaining({
        eventIndex: 2,
        sequence: 3,
        command: 'pnpm test:e2e',
        exitCode: 1,
        outputChars: longOutput.length,
        path: `/api/dashboard/runs/${runId}/nodes/${runNodeId}/diagnostics/1/commands/2`,
      }),
    ]);
    const toolResultEvent = diagnosticsPayload?.events.find(event => event.type === 'tool_result');
    expect(toolResultEvent?.contentPreview.length).toBeLessThanOrEqual(600);

    const logArtifacts = db
      .select({
        id: phaseArtifacts.id,
        contentType: phaseArtifacts.contentType,
        content: phaseArtifacts.content,
        metadata: phaseArtifacts.metadata,
      })
      .from(phaseArtifacts)
      .where(and(eq(phaseArtifacts.runNodeId, runNodeId), eq(phaseArtifacts.artifactType, 'log')))
      .orderBy(asc(phaseArtifacts.id))
      .all();
    const commandOutputArtifact = logArtifacts.find((artifact) => {
      const metadata = artifact.metadata as Record<string, unknown> | null;
      return metadata?.kind === 'failed_command_output_v1';
    });
    expect(commandOutputArtifact).toBeDefined();
    if (!commandOutputArtifact) {
      throw new Error('Expected failed command output artifact to be persisted.');
    }

    expect(commandOutputArtifact.contentType).toBe('json');
    const commandOutputPayload = JSON.parse(commandOutputArtifact.content) as {
      output: string;
      outputChars: number;
      eventIndex: number;
      sequence: number;
    };
    expect(commandOutputPayload.output).toBe(longOutput);
    expect(commandOutputPayload.outputChars).toBe(longOutput.length);
    expect(commandOutputPayload.eventIndex).toBe(2);
    expect(commandOutputPayload.sequence).toBe(3);
  });

  it('persists failed command output diagnostics when an attempt completes successfully', async () => {
    const { db, runId, runNodeId } = seedSingleAgentRun();
    const longOutput = `command failed but run recovered.\n${'stderr-line\n'.repeat(400)}`;
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () =>
        createProvider([
          { type: 'system', content: 'start', timestamp: 100 },
          { type: 'tool_use', content: 'pnpm test:e2e', timestamp: 101, metadata: { itemType: 'command_execution' } },
          {
            type: 'tool_result',
            content: JSON.stringify({
              command: 'pnpm test:e2e',
              output: longOutput,
              exit_code: 1,
            }),
            timestamp: 102,
            metadata: { itemType: 'command_execution' },
          },
          { type: 'result', content: 'Recovered after command failure', timestamp: 103 },
        ]),
    });

    const execution = await executor.executeRun({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(execution.finalStep).toEqual({
      outcome: 'run_terminal',
      workflowRunId: runId,
      runStatus: 'completed',
    });

    const diagnosticsRow = db
      .select({
        diagnostics: runNodeDiagnostics.diagnostics,
      })
      .from(runNodeDiagnostics)
      .where(eq(runNodeDiagnostics.runNodeId, runNodeId))
      .orderBy(asc(runNodeDiagnostics.id))
      .limit(1)
      .get();
    const diagnosticsPayload = diagnosticsRow?.diagnostics as
      | {
          failedCommandOutputs?: {
            eventIndex: number;
            sequence: number;
            command: string | null;
            exitCode: number | null;
            outputChars: number;
            path: string;
          }[];
        }
      | undefined;

    expect(diagnosticsPayload?.failedCommandOutputs).toEqual([
      expect.objectContaining({
        eventIndex: 2,
        sequence: 3,
        command: 'pnpm test:e2e',
        exitCode: 1,
        outputChars: longOutput.length,
        path: `/api/dashboard/runs/${runId}/nodes/${runNodeId}/diagnostics/1/commands/2`,
      }),
    ]);

    const logArtifacts = db
      .select({
        content: phaseArtifacts.content,
        metadata: phaseArtifacts.metadata,
      })
      .from(phaseArtifacts)
      .where(and(eq(phaseArtifacts.runNodeId, runNodeId), eq(phaseArtifacts.artifactType, 'log')))
      .orderBy(asc(phaseArtifacts.id))
      .all();
    const commandOutputArtifact = logArtifacts.find((artifact) => {
      const metadata = artifact.metadata as Record<string, unknown> | null;
      return metadata?.kind === 'failed_command_output_v1';
    });
    expect(commandOutputArtifact).toBeDefined();
    if (!commandOutputArtifact) {
      throw new Error('Expected failed command output artifact to be persisted.');
    }

    const commandOutputPayload = JSON.parse(commandOutputArtifact.content) as {
      output: string;
      outputChars: number;
      eventIndex: number;
      sequence: number;
    };
    expect(commandOutputPayload.output).toBe(longOutput);
    expect(commandOutputPayload.outputChars).toBe(longOutput.length);
    expect(commandOutputPayload.eventIndex).toBe(2);
    expect(commandOutputPayload.sequence).toBe(3);
  });

  it('retains partial stream history and diagnostics payload events when a node fails mid-stream', async () => {
    const { db, runId, runNodeId } = seedSingleAgentRun();
    const timeoutError = new Error('provider timeout while awaiting result');
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () => ({
        async *run(): AsyncIterable<ProviderEvent> {
          yield { type: 'system', content: 'started', timestamp: 100 };
          yield { type: 'assistant', content: 'partial response', timestamp: 101 };
          yield { type: 'usage', content: '', timestamp: 102, metadata: { tokens: 7 } };
          throw timeoutError;
        },
      }),
    });

    const result = await executor.executeRun({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(result.finalStep).toEqual({
      outcome: 'run_terminal',
      workflowRunId: runId,
      runStatus: 'failed',
    });

    const streamEvents = db
      .select({
        sequence: runNodeStreamEvents.sequence,
        eventType: runNodeStreamEvents.eventType,
        timestamp: runNodeStreamEvents.timestamp,
      })
      .from(runNodeStreamEvents)
      .where(eq(runNodeStreamEvents.runNodeId, runNodeId))
      .orderBy(asc(runNodeStreamEvents.sequence), asc(runNodeStreamEvents.id))
      .all();

    expect(streamEvents).toEqual([
      { sequence: 1, eventType: 'system', timestamp: 100 },
      { sequence: 2, eventType: 'assistant', timestamp: 101 },
      { sequence: 3, eventType: 'usage', timestamp: 102 },
    ]);

    const diagnostics = db
      .select({
        diagnostics: runNodeDiagnostics.diagnostics,
      })
      .from(runNodeDiagnostics)
      .where(eq(runNodeDiagnostics.runNodeId, runNodeId))
      .orderBy(asc(runNodeDiagnostics.id))
      .all();

    expect(diagnostics).toHaveLength(1);
    const payload = diagnostics[0]?.diagnostics as {
      summary: { eventCount: number; retainedEventCount: number; droppedEventCount: number; tokensUsed: number };
      error: { classification: string } | null;
      events: { type: string; timestamp: number }[];
    };
    expect(payload.summary.eventCount).toBe(3);
    expect(payload.summary.retainedEventCount).toBe(3);
    expect(payload.summary.droppedEventCount).toBe(0);
    expect(payload.summary.tokensUsed).toBe(7);
    expect(payload.error?.classification).toBe('timeout');
    expect(payload.events.map(event => event.type)).toEqual(['system', 'assistant', 'usage']);
    expect(payload.events.map(event => event.timestamp)).toEqual([100, 101, 102]);
  });

  it('applies deterministic redaction and truncation bounds to diagnostics payloads', async () => {
    const { db, runId, runNodeId } = seedSingleAgentRun();
    const longPayload = 'x'.repeat(2_000);
    const noisyEvents: ProviderEvent[] = [
      {
        type: 'tool_use',
        content: longPayload,
        timestamp: 1,
        metadata: {
          toolName: 'lookup',
          apiKey: 'sk-secret-key-value',
          authorization: 'Bearer abcdefghijklmnop',
        },
      },
      ...Array.from({ length: 125 }, (_, index) => ({
        type: 'assistant' as const,
        content: `step-${index}`,
        timestamp: index + 2,
      })),
      {
        type: 'result',
        content: 'final report',
        timestamp: 200,
      },
    ];

    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () => createProvider(noisyEvents),
    });

    await executor.executeRun({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    const diagnostics = db
      .select({
        redacted: runNodeDiagnostics.redacted,
        truncated: runNodeDiagnostics.truncated,
        diagnostics: runNodeDiagnostics.diagnostics,
      })
      .from(runNodeDiagnostics)
      .where(eq(runNodeDiagnostics.runNodeId, runNodeId))
      .orderBy(asc(runNodeDiagnostics.id))
      .all();

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.redacted).toBe(1);
    expect(diagnostics[0]?.truncated).toBe(1);

    const payload = diagnostics[0]?.diagnostics as {
      summary: { retainedEventCount: number; droppedEventCount: number; truncated: boolean; redacted: boolean };
      events: { contentPreview: string; metadata: Record<string, unknown> | null }[];
    };

    expect(payload.summary.redacted).toBe(true);
    expect(payload.summary.truncated).toBe(true);
    expect(payload.summary.retainedEventCount).toBe(120);
    expect(payload.summary.droppedEventCount).toBe(7);
    expect(payload.events[0]?.contentPreview.length).toBeLessThanOrEqual(600);
    expect(payload.events[0]?.metadata).toMatchObject({
      apiKey: '[REDACTED]',
      authorization: '[REDACTED]',
    });
  });

  it('normalizes diagnostics usage variants and tool summary fallbacks deterministically', async () => {
    const { db, runId, runNodeId } = seedSingleAgentRun();
    const deeplyNestedMetadata: Record<string, unknown> = {
      level1: {
        level2: {
          level3: {
            level4: {
              level5: {
                level6: {
                  value: 'too-deep',
                },
              },
            },
          },
        },
      },
    };
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () =>
        createProvider([
          {
            type: 'system',
            content: 'Bearer abc123TOKEN',
            timestamp: 1,
            metadata: {
              notes: 'n'.repeat(2_500),
              nested: deeplyNestedMetadata,
              values: Array.from({ length: 30 }, (_value, index) => index),
              weird: Symbol('diagnostic-symbol'),
            },
          },
          { type: 'usage', content: 'no usage fields', timestamp: 2, metadata: {} },
          { type: 'usage', content: 'top-level incremental', timestamp: 3, metadata: { tokens: 3 } },
          { type: 'usage', content: 'nested incremental', timestamp: 4, metadata: { usage: { tokens: 5 } } },
          { type: 'usage', content: 'tokens-used cumulative', timestamp: 5, metadata: { tokensUsed: 11 } },
          {
            type: 'usage',
            content: 'camel-case in/out cumulative',
            timestamp: 6,
            metadata: { inputTokens: 7, outputTokens: 8 },
          },
          {
            type: 'usage',
            content: 'snake-case in/out cumulative',
            timestamp: 7,
            metadata: { input_tokens: 9, output_tokens: 10 },
          },
          { type: 'usage', content: 'snake total cumulative', timestamp: 8, metadata: { total_tokens: 30 } },
          { type: 'tool_use', content: '   ', timestamp: 9, metadata: { tool_name: 'gh_search' } },
          { type: 'tool_result', content: '', timestamp: 10, metadata: {} },
          { type: 'tool_use', content: ' ', timestamp: 11 },
          { type: 'result', content: 'Design report body', timestamp: 12 },
        ]),
    });

    await executor.executeRun({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    const diagnostics = db
      .select({
        diagnostics: runNodeDiagnostics.diagnostics,
      })
      .from(runNodeDiagnostics)
      .where(eq(runNodeDiagnostics.runNodeId, runNodeId))
      .orderBy(asc(runNodeDiagnostics.id))
      .all();

    expect(diagnostics).toHaveLength(1);
    const payload = diagnostics[0]?.diagnostics as {
      summary: { redacted: boolean; truncated: boolean; tokensUsed: number };
      events: {
        type: string;
        contentPreview: string;
        metadata: Record<string, unknown> | null;
        usage: { deltaTokens: number | null; cumulativeTokens: number | null } | null;
      }[];
      toolEvents: { type: string; toolName: string | null; summary: string }[];
    };

    expect(payload.summary.tokensUsed).toBe(30);
    expect(payload.summary.redacted).toBe(true);
    expect(payload.summary.truncated).toBe(true);
    expect(payload.events[0]?.contentPreview).toBe('[REDACTED]');
    expect(payload.events[0]?.metadata).toMatchObject({
      truncated: true,
    });

    const usageEvents = payload.events.filter(event => event.type === 'usage');
    expect(usageEvents.map(event => event.usage)).toEqual([
      null,
      { deltaTokens: 3, cumulativeTokens: 3 },
      { deltaTokens: 5, cumulativeTokens: 8 },
      { deltaTokens: 3, cumulativeTokens: 11 },
      { deltaTokens: 4, cumulativeTokens: 15 },
      { deltaTokens: 4, cumulativeTokens: 19 },
      { deltaTokens: 11, cumulativeTokens: 30 },
    ]);

    expect(payload.toolEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'tool_use',
          toolName: 'gh_search',
          summary: 'tool_use event for gh_search',
        }),
        expect.objectContaining({
          type: 'tool_result',
          toolName: null,
          summary: 'tool_result event',
        }),
        expect.objectContaining({
          type: 'tool_use',
          toolName: null,
          summary: 'tool_use event',
        }),
      ]),
    );
  });

  it('drops retained diagnostics events when payload size exceeds limit', async () => {
    const { db, runId, runNodeId } = seedSingleAgentRun();
    const bulkyContent = 'z'.repeat(600);
    const noisyEvents: ProviderEvent[] = [
      { type: 'system', content: bulkyContent, timestamp: 1 },
      ...Array.from({ length: 124 }, (_value, index) => ({
        type: 'assistant' as const,
        content: bulkyContent,
        timestamp: index + 2,
      })),
      { type: 'result', content: 'Design report body', timestamp: 200 },
    ];
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () => createProvider(noisyEvents),
    });

    await executor.executeRun({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    const diagnostics = db
      .select({
        diagnostics: runNodeDiagnostics.diagnostics,
      })
      .from(runNodeDiagnostics)
      .where(eq(runNodeDiagnostics.runNodeId, runNodeId))
      .orderBy(asc(runNodeDiagnostics.id))
      .all();

    expect(diagnostics).toHaveLength(1);
    const payload = diagnostics[0]?.diagnostics as {
      summary: {
        eventCount: number;
        retainedEventCount: number;
        droppedEventCount: number;
        truncated: boolean;
      };
    };

    expect(payload.summary.eventCount).toBe(noisyEvents.length);
    expect(payload.summary.truncated).toBe(true);
    expect(payload.summary.retainedEventCount).toBeLessThan(120);
    expect(payload.summary.droppedEventCount).toBeGreaterThan(noisyEvents.length - 120);
  });

  it('classifies timeout failures and drops stack preview when diagnostics payload remains oversized', async () => {
    const { db, runId, runNodeId } = seedSingleAgentRun();
    const oversizedTimeoutError = new Error(`provider timeout: ${'x'.repeat(60_000)}`);
    oversizedTimeoutError.stack = `Error: provider timeout\n${'at provider (/tmp/file.ts:1:1)\n'.repeat(900)}`;
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () => ({
        async *run(): AsyncIterable<ProviderEvent> {
          yield { type: 'system', content: 'before-timeout', timestamp: 1 };
          throw oversizedTimeoutError;
        },
      }),
    });

    await executor.executeRun({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    const diagnostics = db
      .select({
        diagnostics: runNodeDiagnostics.diagnostics,
      })
      .from(runNodeDiagnostics)
      .where(eq(runNodeDiagnostics.runNodeId, runNodeId))
      .orderBy(asc(runNodeDiagnostics.id))
      .all();

    expect(diagnostics).toHaveLength(1);
    const payload = diagnostics[0]?.diagnostics as {
      summary: { truncated: boolean };
      error: { classification: string; stackPreview: string | null } | null;
    };

    expect(payload.summary.truncated).toBe(true);
    expect(payload.error?.classification).toBe('timeout');
    expect(payload.error?.stackPreview).toBeNull();
  });

  it('classifies aborted failures in run-node diagnostics', async () => {
    const { db, runId, runNodeId } = seedSingleAgentRun();
    const abortedError = new Error('request was cancelled');
    abortedError.name = 'AbortError';
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () => ({
        async *run(): AsyncIterable<ProviderEvent> {
          yield { type: 'system', content: 'before-abort', timestamp: 1 };
          throw abortedError;
        },
      }),
    });

    await executor.executeRun({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    const diagnostics = db
      .select({
        diagnostics: runNodeDiagnostics.diagnostics,
      })
      .from(runNodeDiagnostics)
      .where(eq(runNodeDiagnostics.runNodeId, runNodeId))
      .orderBy(asc(runNodeDiagnostics.id))
      .all();

    expect(diagnostics).toHaveLength(1);
    const payload = diagnostics[0]?.diagnostics as {
      error: { classification: string } | null;
    };

    expect(payload.error?.classification).toBe('aborted');
  });

  it('fails deterministically when provider stream misses a result event and persists failure state', async () => {
    const { db, runId, runNodeId } = seedSingleAgentRun();
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () =>
        createProvider([
          { type: 'system', content: 'start', timestamp: 100 },
          { type: 'assistant', content: 'partial response', timestamp: 101 },
        ]),
    });

    const result = await executor.executeRun({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(result.executedNodes).toBe(1);
    expect(result.finalStep).toEqual({
      outcome: 'run_terminal',
      workflowRunId: runId,
      runStatus: 'failed',
    });

    const persistedRun = db
      .select({
        status: workflowRuns.status,
        completedAt: workflowRuns.completedAt,
      })
      .from(workflowRuns)
      .where(eq(workflowRuns.id, runId))
      .get();

    expect(persistedRun).toBeDefined();
    if (!persistedRun) {
      throw new Error('Expected persisted workflow run row.');
    }

    expect(persistedRun.status).toBe('failed');
    expect(persistedRun.completedAt).not.toBeNull();

    const persistedRunNode = db
      .select({
        status: runNodes.status,
        completedAt: runNodes.completedAt,
      })
      .from(runNodes)
      .where(eq(runNodes.id, runNodeId))
      .get();

    expect(persistedRunNode).toBeDefined();
    if (!persistedRunNode) {
      throw new Error('Expected persisted run-node row.');
    }

    expect(persistedRunNode.status).toBe('failed');
    expect(persistedRunNode.completedAt).not.toBeNull();

    const artifacts = db
      .select({
        artifactType: phaseArtifacts.artifactType,
        contentType: phaseArtifacts.contentType,
        content: phaseArtifacts.content,
      })
      .from(phaseArtifacts)
      .where(eq(phaseArtifacts.runNodeId, runNodeId))
      .all();

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].artifactType).toBe('log');
    expect(artifacts[0].contentType).toBe('text');
    expect(artifacts[0].content).toContain('without a result event');
  });

  it('retries a failed node within max_retries and completes the run on a later attempt', async () => {
    const { db, runId, runNodeId } = seedSingleAgentRun('markdown', 1);
    let invocation = 0;
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () => ({
        async *run(): AsyncIterable<ProviderEvent> {
          invocation += 1;
          if (invocation === 1) {
            throw new Error('Transient failure on first attempt');
          }

          yield { type: 'result', content: 'Recovered successfully', timestamp: 20 };
        },
      }),
    });

    const result = await executor.executeRun({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(result).toEqual({
      workflowRunId: runId,
      executedNodes: 1,
      finalStep: {
        outcome: 'run_terminal',
        workflowRunId: runId,
        runStatus: 'completed',
      },
    });

    const persistedRunNode = db
      .select({
        status: runNodes.status,
        attempt: runNodes.attempt,
      })
      .from(runNodes)
      .where(eq(runNodes.id, runNodeId))
      .get();

    expect(persistedRunNode).toEqual({
      status: 'completed',
      attempt: 2,
    });

    const artifacts = db
      .select({
        artifactType: phaseArtifacts.artifactType,
        metadata: phaseArtifacts.metadata,
      })
      .from(phaseArtifacts)
      .where(eq(phaseArtifacts.runNodeId, runNodeId))
      .orderBy(asc(phaseArtifacts.id))
      .all();

    expect(artifacts).toHaveLength(3);
    expect(artifacts[0]).toEqual({
      artifactType: 'log',
      metadata: expect.objectContaining({
        failureReason: 'retry_scheduled',
        attempt: 1,
        maxRetries: 1,
      }),
    });
    expect(artifacts[1]).toEqual({
      artifactType: 'note',
      metadata: expect.objectContaining({
        kind: 'error_handler_summary_v1',
        sourceAttempt: 1,
        targetAttempt: 2,
      }),
    });
    expect(artifacts[2]).toEqual({
      artifactType: 'report',
      metadata: expect.objectContaining({
        attempt: 2,
        maxRetries: 1,
        retriesUsed: 1,
      }),
    });
  });

  it('fails after exhausting max_retries and persists retry-limit metadata', async () => {
    const { db, runId, runNodeId } = seedSingleAgentRun('markdown', 1);
    let invocation = 0;
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () => ({
        async *run(): AsyncIterable<ProviderEvent> {
          invocation += 1;
          yield { type: 'system', content: `attempt ${invocation}`, timestamp: invocation };
          throw new Error(`Attempt ${invocation} failed`);
        },
      }),
    });

    const result = await executor.executeRun({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(result).toEqual({
      workflowRunId: runId,
      executedNodes: 1,
      finalStep: {
        outcome: 'run_terminal',
        workflowRunId: runId,
        runStatus: 'failed',
      },
    });

    const persistedRunNode = db
      .select({
        status: runNodes.status,
        attempt: runNodes.attempt,
      })
      .from(runNodes)
      .where(eq(runNodes.id, runNodeId))
      .get();

    expect(persistedRunNode).toEqual({
      status: 'failed',
      attempt: 2,
    });

    const artifacts = db
      .select({
        artifactType: phaseArtifacts.artifactType,
        metadata: phaseArtifacts.metadata,
      })
      .from(phaseArtifacts)
      .where(eq(phaseArtifacts.runNodeId, runNodeId))
      .orderBy(asc(phaseArtifacts.id))
      .all();

    expect(artifacts).toHaveLength(2);
    expect(artifacts[0]).toEqual({
      artifactType: 'log',
      metadata: expect.objectContaining({
        failureReason: 'retry_scheduled',
        attempt: 1,
      }),
    });
    expect(artifacts[1]).toEqual({
      artifactType: 'log',
      metadata: expect.objectContaining({
        failureReason: 'retry_limit_exceeded',
        attempt: 2,
        retriesRemaining: 0,
        failureRoute: expect.objectContaining({
          attempted: true,
          status: 'no_route',
          selectedEdgeId: null,
          targetNodeId: null,
          targetNodeKey: null,
        }),
      }),
    });

    const diagnosticsRow = db
      .select({
        diagnostics: runNodeDiagnostics.diagnostics,
      })
      .from(runNodeDiagnostics)
      .where(and(eq(runNodeDiagnostics.runNodeId, runNodeId), eq(runNodeDiagnostics.attempt, 2)))
      .get();
    const diagnostics = diagnosticsRow?.diagnostics as {
      failureRoute?: Record<string, unknown>;
    } | null;
    expect(diagnostics?.failureRoute).toEqual(
      expect.objectContaining({
        attempted: true,
        status: 'no_route',
        selectedEdgeId: null,
      }),
    );
  });

  it('routes non-retryable failures to remediation targets and injects failure-route context', async () => {
    const {
      db,
      runId,
      sourceRunNodeId,
      runNodeIdByKey,
    } = seedFailureRoutingRun({
      sourceMaxRetries: 0,
    });
    const remediationRunNodeId = runNodeIdByKey.get('remediation');
    if (!remediationRunNodeId) {
      throw new Error('Expected remediation run-node to be materialized.');
    }

    const contextsByInvocation: (string[] | undefined)[] = [];
    let invocation = 0;
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () => ({
        async *run(_prompt: string, options: ProviderRunOptions): AsyncIterable<ProviderEvent> {
          invocation += 1;
          contextsByInvocation.push(options.context);
          if (invocation === 1) {
            throw new Error('non-retryable-source-failure');
          }

          yield { type: 'result', content: 'remediation complete', timestamp: 20 };
        },
      }),
    });

    const firstStep = await executor.executeNextRunnableNode({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(firstStep).toEqual({
      workflowRunId: runId,
      outcome: 'executed',
      runNodeId: sourceRunNodeId,
      nodeKey: 'source',
      runNodeStatus: 'failed',
      runStatus: 'running',
      artifactId: expect.any(Number),
    });

    const secondStep = await executor.executeNextRunnableNode({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });
    expect(secondStep).toEqual({
      workflowRunId: runId,
      outcome: 'executed',
      runNodeId: remediationRunNodeId,
      nodeKey: 'remediation',
      runNodeStatus: 'completed',
      runStatus: 'completed',
      artifactId: expect.any(Number),
    });

    expect(invocation).toBe(2);

    const remediationContext = contextsByInvocation[1];
    expect(remediationContext).toHaveLength(1);
    expect(remediationContext?.[0]).toContain('ALPHRED_FAILURE_ROUTE_CONTEXT v1');
    expect(remediationContext?.[0]).toContain('source_node_key: source');
    expect(remediationContext?.[0]).toContain('target_node_key: remediation');
    expect(remediationContext?.[0]).toContain('retry_summary_artifact_id: null');
    expect(remediationContext?.[0]).toContain('failure_reason: retry_limit_exceeded');

    const persistedRunNodes = db
      .select({
        runNodeId: runNodes.id,
        nodeKey: runNodes.nodeKey,
        status: runNodes.status,
      })
      .from(runNodes)
      .where(eq(runNodes.workflowRunId, runId))
      .all();
    expect(persistedRunNodes).toEqual(
      expect.arrayContaining([
        { runNodeId: sourceRunNodeId, nodeKey: 'source', status: 'failed' },
        { runNodeId: remediationRunNodeId, nodeKey: 'remediation', status: 'completed' },
      ]),
    );

    const sourceDiagnosticsRow = db
      .select({
        diagnostics: runNodeDiagnostics.diagnostics,
      })
      .from(runNodeDiagnostics)
      .where(and(eq(runNodeDiagnostics.runNodeId, sourceRunNodeId), eq(runNodeDiagnostics.attempt, 1)))
      .get();
    const sourceDiagnostics = sourceDiagnosticsRow?.diagnostics as {
      failureRoute?: Record<string, unknown>;
    } | null;
    expect(sourceDiagnostics?.failureRoute).toEqual(
      expect.objectContaining({
        attempted: true,
        status: 'selected',
        targetNodeKey: 'remediation',
      }),
    );

    const remediationReportArtifact = db
      .select({
        metadata: phaseArtifacts.metadata,
      })
      .from(phaseArtifacts)
      .where(
        and(
          eq(phaseArtifacts.runNodeId, remediationRunNodeId),
          eq(phaseArtifacts.artifactType, 'report'),
        ),
      )
      .get();
    const remediationContextMetadata = remediationReportArtifact?.metadata as Record<string, unknown> | null;
    expect(remediationContextMetadata).toEqual(
      expect.objectContaining({
        failure_route_context_included: true,
        failure_route_source_node_key: 'source',
        failure_route_source_run_node_id: sourceRunNodeId,
        failure_route_retry_summary_artifact_id: null,
      }),
    );
  });

  it('keeps run failed when failure routing selects a pre-failed target', async () => {
    const {
      db,
      runId,
      sourceRunNodeId,
      remediationRunNodeId,
      fallbackRunNodeId,
    } = seedFailureRouteWithPreFailedRemediationTargetRun();

    let invocation = 0;
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () => ({
        async *run(): AsyncIterable<ProviderEvent> {
          invocation += 1;
          if (invocation === 1) {
            throw new Error('source-fails-after-remediation-is-already-failed');
          }

          yield { type: 'result', content: 'unexpected-extra-run', timestamp: 2 };
        },
      }),
    });

    const firstStep = await executor.executeNextRunnableNode({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(firstStep).toEqual({
      workflowRunId: runId,
      outcome: 'executed',
      runNodeId: sourceRunNodeId,
      nodeKey: 'source',
      runNodeStatus: 'failed',
      runStatus: 'failed',
      artifactId: expect.any(Number),
    });
    expect(invocation).toBe(1);

    const persistedRun = db
      .select({
        status: workflowRuns.status,
      })
      .from(workflowRuns)
      .where(eq(workflowRuns.id, runId))
      .get();
    expect(persistedRun?.status).toBe('failed');

    const persistedNodes = db
      .select({
        runNodeId: runNodes.id,
        status: runNodes.status,
      })
      .from(runNodes)
      .where(eq(runNodes.workflowRunId, runId))
      .all();
    expect(persistedNodes).toEqual(
      expect.arrayContaining([
        { runNodeId: sourceRunNodeId, status: 'failed' },
        { runNodeId: remediationRunNodeId, status: 'failed' },
        { runNodeId: fallbackRunNodeId, status: 'completed' },
      ]),
    );
  });

  it('continues full-run execution after a routed failure until the run is terminal', async () => {
    const { db, runId, sourceRunNodeId, runNodeIdByKey } = seedFailureRoutingRun({
      sourceMaxRetries: 0,
    });
    const remediationRunNodeId = runNodeIdByKey.get('remediation');
    if (!remediationRunNodeId) {
      throw new Error('Expected remediation run-node to be materialized.');
    }

    let invocation = 0;
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () => ({
        async *run(): AsyncIterable<ProviderEvent> {
          invocation += 1;
          if (invocation === 1) {
            throw new Error('source-fails-before-remediation');
          }

          yield { type: 'result', content: 'remediation-completes', timestamp: 2 };
        },
      }),
    });

    const result = await executor.executeRun({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(result).toEqual({
      workflowRunId: runId,
      executedNodes: 2,
      finalStep: {
        outcome: 'run_terminal',
        workflowRunId: runId,
        runStatus: 'completed',
      },
    });
    expect(invocation).toBe(2);

    const persistedNodes = db
      .select({
        runNodeId: runNodes.id,
        status: runNodes.status,
      })
      .from(runNodes)
      .where(eq(runNodes.workflowRunId, runId))
      .all();
    expect(persistedNodes).toEqual(
      expect.arrayContaining([
        { runNodeId: sourceRunNodeId, status: 'failed' },
        { runNodeId: remediationRunNodeId, status: 'completed' },
      ]),
    );
  });

  it('selects failure-route context from the newest failed source when routes converge', async () => {
    const { db, runId, runNodeIdByKey } = seedConvergingFailureRouteContextRun();
    const remediationRunNodeId = runNodeIdByKey.get('remediation');
    if (!remediationRunNodeId) {
      throw new Error('Expected remediation run-node to be materialized.');
    }

    const contextsByInvocation: (string[] | undefined)[] = [];
    let invocation = 0;
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () => ({
        async *run(_prompt: string, options: ProviderRunOptions): AsyncIterable<ProviderEvent> {
          invocation += 1;
          contextsByInvocation.push(options.context);

          if (invocation === 1) {
            throw new Error('source-a-fails-first');
          }

          if (invocation === 3) {
            throw new Error('source-b-fails-later');
          }

          yield {
            type: 'result',
            content: `remediation-attempt-${invocation}`,
            timestamp: invocation,
          };
        },
      }),
    });

    const result = await executor.executeRun({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
      maxSteps: 10,
    });

    expect(result).toEqual({
      workflowRunId: runId,
      executedNodes: 4,
      finalStep: {
        outcome: 'run_terminal',
        workflowRunId: runId,
        runStatus: 'completed',
      },
    });
    expect(invocation).toBe(4);

    const firstRemediationContext = contextsByInvocation[1];
    expect(firstRemediationContext).toHaveLength(1);
    expect(firstRemediationContext?.[0]).toContain('source_node_key: source_a');

    const secondRemediationContext = contextsByInvocation[3];
    expect(secondRemediationContext).toHaveLength(1);
    expect(secondRemediationContext?.[0]).toContain('source_node_key: source_b');
    expect(secondRemediationContext?.[0]).toContain('target_node_key: remediation');

    const remediationReportArtifacts = db
      .select({
        metadata: phaseArtifacts.metadata,
      })
      .from(phaseArtifacts)
      .where(
        and(
          eq(phaseArtifacts.runNodeId, remediationRunNodeId),
          eq(phaseArtifacts.artifactType, 'report'),
        ),
      )
      .orderBy(asc(phaseArtifacts.id))
      .all();
    const latestRemediationMetadata =
      (remediationReportArtifacts.at(-1)?.metadata as Record<string, unknown> | null) ?? null;
    expect(latestRemediationMetadata).toEqual(
      expect.objectContaining({
        failure_route_source_node_key: 'source_b',
      }),
    );
  });

  it('routes exhausted retries to remediation targets and includes retry summaries in failure-route context', async () => {
    const {
      db,
      runId,
      sourceRunNodeId,
      runNodeIdByKey,
    } = seedFailureRoutingRun({
      sourceMaxRetries: 1,
    });
    const remediationRunNodeId = runNodeIdByKey.get('remediation');
    if (!remediationRunNodeId) {
      throw new Error('Expected remediation run-node to be materialized.');
    }

    const contextsByInvocation: (string[] | undefined)[] = [];
    let sourceAttempt = 0;
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () => ({
        async *run(prompt: string, options: ProviderRunOptions): AsyncIterable<ProviderEvent> {
          if (prompt.startsWith('Analyze the following node execution failure.')) {
            yield { type: 'result', content: 'retry guidance for source node', timestamp: 50 };
            return;
          }

          sourceAttempt += 1;
          contextsByInvocation.push(options.context);
          if (sourceAttempt <= 2) {
            throw new Error(`source-attempt-${sourceAttempt}-failed`);
          }

          yield { type: 'result', content: 'remediation after retries complete', timestamp: 90 };
        },
      }),
    });

    const firstStep = await executor.executeNextRunnableNode({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(firstStep).toEqual({
      workflowRunId: runId,
      outcome: 'executed',
      runNodeId: sourceRunNodeId,
      nodeKey: 'source',
      runNodeStatus: 'failed',
      runStatus: 'running',
      artifactId: expect.any(Number),
    });

    const secondStep = await executor.executeNextRunnableNode({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });
    expect(secondStep).toEqual({
      workflowRunId: runId,
      outcome: 'executed',
      runNodeId: remediationRunNodeId,
      nodeKey: 'remediation',
      runNodeStatus: 'completed',
      runStatus: 'completed',
      artifactId: expect.any(Number),
    });
    expect(sourceAttempt).toBe(3);
    expect(contextsByInvocation[1]).toHaveLength(1);
    expect(contextsByInvocation[1]?.[0]).toContain('ALPHRED_RETRY_FAILURE_SUMMARY v1');

    const remediationContext = contextsByInvocation[2];
    expect(remediationContext).toHaveLength(1);
    expect(remediationContext?.[0]).toContain('ALPHRED_FAILURE_ROUTE_CONTEXT v1');
    expect(remediationContext?.[0]).toContain('retry_summary_artifact_id:');
    expect(remediationContext?.[0]).not.toContain('retry_summary_artifact_id: null');
    expect(remediationContext?.[0]).toContain('retry_summary_artifact:');
    expect(remediationContext?.[0]).toContain('source_attempt: 1');
    expect(remediationContext?.[0]).toContain('target_attempt: 2');

    const sourceDiagnosticsRow = db
      .select({
        diagnostics: runNodeDiagnostics.diagnostics,
      })
      .from(runNodeDiagnostics)
      .where(and(eq(runNodeDiagnostics.runNodeId, sourceRunNodeId), eq(runNodeDiagnostics.attempt, 2)))
      .get();
    const sourceDiagnostics = sourceDiagnosticsRow?.diagnostics as {
      failureRoute?: Record<string, unknown>;
    } | null;
    expect(sourceDiagnostics?.failureRoute).toEqual(
      expect.objectContaining({
        attempted: true,
        status: 'selected',
        targetNodeKey: 'remediation',
      }),
    );

    const remediationReportArtifact = db
      .select({
        metadata: phaseArtifacts.metadata,
      })
      .from(phaseArtifacts)
      .where(
        and(
          eq(phaseArtifacts.runNodeId, remediationRunNodeId),
          eq(phaseArtifacts.artifactType, 'report'),
        ),
      )
      .get();
    const remediationContextMetadata = remediationReportArtifact?.metadata as Record<string, unknown> | null;
    expect(remediationContextMetadata).toEqual(
      expect.objectContaining({
        failure_route_context_included: true,
        failure_route_retry_summary_artifact_id: expect.any(Number),
      }),
    );
  });

  it('keeps run paused while scheduling remediation after non-retryable failure', async () => {
    const { db, runId, sourceRunNodeId, runNodeIdByKey } = seedFailureRoutingRun();
    const remediationRunNodeId = runNodeIdByKey.get('remediation');
    if (!remediationRunNodeId) {
      throw new Error('Expected remediation run-node to be materialized.');
    }

    let invocation = 0;
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () => ({
        async *run(): AsyncIterable<ProviderEvent> {
          invocation += 1;
          if (invocation === 1) {
            await executor.pauseRun({
              workflowRunId: runId,
            });
            throw new Error('pause-while-source-fails');
          }

          yield { type: 'result', content: 'unexpected-remediation-run', timestamp: 1 };
        },
      }),
    });

    const firstStep = await executor.executeNextRunnableNode({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(firstStep).toEqual({
      workflowRunId: runId,
      outcome: 'executed',
      runNodeId: sourceRunNodeId,
      nodeKey: 'source',
      runNodeStatus: 'failed',
      runStatus: 'paused',
      artifactId: expect.any(Number),
    });
    const secondStep = await executor.executeNextRunnableNode({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });
    expect(secondStep).toEqual({
      workflowRunId: runId,
      outcome: 'blocked',
      runStatus: 'paused',
    });
    expect(invocation).toBe(1);

    const persistedRun = db
      .select({
        status: workflowRuns.status,
      })
      .from(workflowRuns)
      .where(eq(workflowRuns.id, runId))
      .get();
    expect(persistedRun?.status).toBe('paused');

    const persistedNodes = db
      .select({
        runNodeId: runNodes.id,
        status: runNodes.status,
      })
      .from(runNodes)
      .where(eq(runNodes.workflowRunId, runId))
      .all();
    expect(persistedNodes).toEqual(
      expect.arrayContaining([
        { runNodeId: sourceRunNodeId, status: 'failed' },
        { runNodeId: remediationRunNodeId, status: 'pending' },
      ]),
    );
  });

  it('skips failure-route scheduling when run is cancelled during non-retryable failure', async () => {
    const { db, runId, sourceRunNodeId, runNodeIdByKey } = seedFailureRoutingRun();
    const remediationRunNodeId = runNodeIdByKey.get('remediation');
    if (!remediationRunNodeId) {
      throw new Error('Expected remediation run-node to be materialized.');
    }

    let invocation = 0;
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () => ({
        async *run(): AsyncIterable<ProviderEvent> {
          invocation += 1;
          if (invocation === 1) {
            await executor.cancelRun({
              workflowRunId: runId,
            });
            throw new Error('cancel-while-source-fails');
          }

          yield { type: 'result', content: 'unexpected-remediation-run', timestamp: 1 };
        },
      }),
    });

    const result = await executor.executeRun({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(result).toEqual({
      workflowRunId: runId,
      executedNodes: 1,
      finalStep: {
        outcome: 'run_terminal',
        workflowRunId: runId,
        runStatus: 'cancelled',
      },
    });
    expect(invocation).toBe(1);

    const persistedRun = db
      .select({
        status: workflowRuns.status,
      })
      .from(workflowRuns)
      .where(eq(workflowRuns.id, runId))
      .get();
    expect(persistedRun?.status).toBe('cancelled');

    const persistedNodes = db
      .select({
        runNodeId: runNodes.id,
        status: runNodes.status,
      })
      .from(runNodes)
      .where(eq(runNodes.workflowRunId, runId))
      .all();
    expect(persistedNodes).toEqual(
      expect.arrayContaining([
        { runNodeId: sourceRunNodeId, status: 'failed' },
        { runNodeId: remediationRunNodeId, status: 'pending' },
      ]),
    );

    const sourceDiagnosticsRow = db
      .select({
        diagnostics: runNodeDiagnostics.diagnostics,
      })
      .from(runNodeDiagnostics)
      .where(and(eq(runNodeDiagnostics.runNodeId, sourceRunNodeId), eq(runNodeDiagnostics.attempt, 1)))
      .get();
    const sourceDiagnostics = sourceDiagnosticsRow?.diagnostics as {
      failureRoute?: Record<string, unknown>;
    } | null;
    expect(sourceDiagnostics?.failureRoute).toEqual(
      expect.objectContaining({
        attempted: true,
        status: 'skipped_terminal',
        targetNodeKey: 'remediation',
      }),
    );
  });

  it('selects failure routes deterministically by priority when multiple routes exist', async () => {
    const {
      db,
      runId,
      sourceRunNodeId,
      runNodeIdByKey,
      failureEdgeIdByTargetKey,
    } = seedFailureRoutingRun({
      sourceMaxRetries: 0,
      failureTargets: [
        { nodeKey: 'remediation_primary', priority: 10 },
        { nodeKey: 'remediation_fallback', priority: 20 },
      ],
    });
    const primaryRunNodeId = runNodeIdByKey.get('remediation_primary');
    const fallbackRunNodeId = runNodeIdByKey.get('remediation_fallback');
    if (!primaryRunNodeId || !fallbackRunNodeId) {
      throw new Error('Expected remediation run-nodes to be materialized.');
    }

    let invocation = 0;
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () => ({
        async *run(): AsyncIterable<ProviderEvent> {
          invocation += 1;
          if (invocation === 1) {
            throw new Error('source-fails-for-deterministic-route-test');
          }

          yield { type: 'result', content: 'primary remediation complete', timestamp: 2 };
        },
      }),
    });

    const firstStep = await executor.executeNextRunnableNode({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(firstStep).toEqual({
      workflowRunId: runId,
      outcome: 'executed',
      runNodeId: sourceRunNodeId,
      nodeKey: 'source',
      runNodeStatus: 'failed',
      runStatus: 'running',
      artifactId: expect.any(Number),
    });

    const secondStep = await executor.executeNextRunnableNode({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });
    expect(secondStep).toEqual({
      workflowRunId: runId,
      outcome: 'executed',
      runNodeId: primaryRunNodeId,
      nodeKey: 'remediation_primary',
      runNodeStatus: 'completed',
      runStatus: 'completed',
      artifactId: expect.any(Number),
    });

    const persistedNodes = db
      .select({
        runNodeId: runNodes.id,
        nodeKey: runNodes.nodeKey,
        status: runNodes.status,
      })
      .from(runNodes)
      .where(eq(runNodes.workflowRunId, runId))
      .all();
    expect(persistedNodes).toEqual(
      expect.arrayContaining([
        { runNodeId: sourceRunNodeId, nodeKey: 'source', status: 'failed' },
        { runNodeId: primaryRunNodeId, nodeKey: 'remediation_primary', status: 'completed' },
        { runNodeId: fallbackRunNodeId, nodeKey: 'remediation_fallback', status: 'skipped' },
      ]),
    );

    const sourceDiagnosticsRow = db
      .select({
        diagnostics: runNodeDiagnostics.diagnostics,
      })
      .from(runNodeDiagnostics)
      .where(and(eq(runNodeDiagnostics.runNodeId, sourceRunNodeId), eq(runNodeDiagnostics.attempt, 1)))
      .get();
    const sourceDiagnostics = sourceDiagnosticsRow?.diagnostics as {
      failureRoute?: {
        selectedEdgeId?: number | null;
        targetNodeKey?: string | null;
      };
    } | null;
    expect(sourceDiagnostics?.failureRoute).toEqual(
      expect.objectContaining({
        selectedEdgeId: failureEdgeIdByTargetKey.get('remediation_primary'),
        targetNodeKey: 'remediation_primary',
      }),
    );
  });

  it('retries up to max_retries and succeeds on the final allowed retry attempt', async () => {
    const { db, runId, runNodeId } = seedSingleAgentRun('markdown', 2);
    let invocation = 0;
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () => ({
        async *run(prompt: string): AsyncIterable<ProviderEvent> {
          if (prompt.startsWith('Analyze the following node execution failure.')) {
            yield { type: 'result', content: 'retry-summary', timestamp: 25 };
            return;
          }
          invocation += 1;
          if (invocation <= 2) {
            throw new Error(`Attempt ${invocation} failed`);
          }
          yield { type: 'result', content: 'Recovered on final retry', timestamp: 30 };
        },
      }),
    });

    const result = await executor.executeRun({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(result).toEqual({
      workflowRunId: runId,
      executedNodes: 1,
      finalStep: {
        outcome: 'run_terminal',
        workflowRunId: runId,
        runStatus: 'completed',
      },
    });

    const persistedRunNode = db
      .select({
        status: runNodes.status,
        attempt: runNodes.attempt,
      })
      .from(runNodes)
      .where(eq(runNodes.id, runNodeId))
      .get();

    expect(persistedRunNode).toEqual({
      status: 'completed',
      attempt: 3,
    });

    const artifacts = db
      .select({
        artifactType: phaseArtifacts.artifactType,
        metadata: phaseArtifacts.metadata,
      })
      .from(phaseArtifacts)
      .where(eq(phaseArtifacts.runNodeId, runNodeId))
      .orderBy(asc(phaseArtifacts.id))
      .all();

    expect(artifacts).toHaveLength(5);
    expect(artifacts[0]).toEqual({
      artifactType: 'log',
      metadata: expect.objectContaining({
        failureReason: 'retry_scheduled',
        attempt: 1,
        maxRetries: 2,
      }),
    });
    expect(artifacts[1]).toEqual({
      artifactType: 'note',
      metadata: expect.objectContaining({
        kind: 'error_handler_summary_v1',
        sourceAttempt: 1,
        targetAttempt: 2,
      }),
    });
    expect(artifacts[2]).toEqual({
      artifactType: 'log',
      metadata: expect.objectContaining({
        failureReason: 'retry_scheduled',
        attempt: 2,
        maxRetries: 2,
      }),
    });
    expect(artifacts[3]).toEqual({
      artifactType: 'note',
      metadata: expect.objectContaining({
        kind: 'error_handler_summary_v1',
        sourceAttempt: 2,
        targetAttempt: 3,
      }),
    });
    expect(artifacts[4]).toEqual({
      artifactType: 'report',
      metadata: expect.objectContaining({
        attempt: 3,
        maxRetries: 2,
        retriesUsed: 2,
      }),
    });
  });

  it('injects a prior-attempt failure summary into retry context by default', async () => {
    const { db, runId } = seedSingleAgentRun('markdown', 1);
    const nodeAttemptContexts: (string[] | undefined)[] = [];
    const errorHandlerContexts: (string[] | undefined)[] = [];
    let nodeAttempt = 0;

    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () => ({
        async *run(prompt: string, options: ProviderRunOptions): AsyncIterable<ProviderEvent> {
          if (prompt.startsWith('Analyze the following node execution failure.')) {
            errorHandlerContexts.push(options.context);
            yield {
              type: 'result',
              content: 'Try a narrower approach and validate assumptions first.',
              timestamp: 11,
            };
            return;
          }

          nodeAttempt += 1;
          nodeAttemptContexts.push(options.context);
          if (nodeAttempt === 1) {
            throw new Error('first-attempt-failure');
          }
          yield {
            type: 'result',
            content: 'Recovered after retry summary',
            timestamp: 20,
          };
        },
      }),
    });

    const result = await executor.executeRun({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(result.finalStep).toEqual({
      outcome: 'run_terminal',
      workflowRunId: runId,
      runStatus: 'completed',
    });
    expect(errorHandlerContexts).toHaveLength(1);
    expect(errorHandlerContexts[0]).toHaveLength(1);
    expect(errorHandlerContexts[0]?.[0]).toContain('ALPHRED_RETRY_ERROR_HANDLER_INPUT v1');
    expect(nodeAttemptContexts[0]).toBeUndefined();
    expect(nodeAttemptContexts[1]).toHaveLength(1);
    expect(nodeAttemptContexts[1]?.[0]).toContain('ALPHRED_RETRY_FAILURE_SUMMARY v1');
    expect(nodeAttemptContexts[1]?.[0]).toContain('source_attempt: 1');
    expect(nodeAttemptContexts[1]?.[0]).toContain('target_attempt: 2');
    expect(nodeAttemptContexts[1]?.[0]).toContain('Try a narrower approach and validate assumptions first.');
  });

  it('skips error handler execution when tree_nodes.error_handler_config disables it', async () => {
    const { db, runId, runNodeId } = seedSingleAgentRun('markdown', 1);
    db.update(runNodes)
      .set({
        errorHandlerConfig: {
          mode: 'disabled',
        },
      })
      .where(eq(runNodes.id, runNodeId))
      .run();

    const contexts: (string[] | undefined)[] = [];
    let invocationCount = 0;
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () => ({
        async *run(_prompt: string, options: ProviderRunOptions): AsyncIterable<ProviderEvent> {
          invocationCount += 1;
          contexts.push(options.context);
          if (invocationCount === 1) {
            throw new Error('first-attempt-failure');
          }
          yield { type: 'result', content: 'recovered', timestamp: 20 };
        },
      }),
    });

    const result = await executor.executeRun({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(result.finalStep).toEqual({
      outcome: 'run_terminal',
      workflowRunId: runId,
      runStatus: 'completed',
    });
    expect(invocationCount).toBe(2);
    expect(contexts[0]).toBeUndefined();
    expect(contexts[1]).toBeUndefined();

    const summaryArtifacts = db
      .select({
        artifactType: phaseArtifacts.artifactType,
      })
      .from(phaseArtifacts)
      .where(and(eq(phaseArtifacts.runNodeId, runNodeId), eq(phaseArtifacts.artifactType, 'note')))
      .all();
    expect(summaryArtifacts).toHaveLength(0);
  });

  it('uses custom error handler provider, model, and prompt overrides when configured', async () => {
    const { db, runId, runNodeId } = seedSingleAgentRun('markdown', 1);
    db.update(runNodes)
      .set({
        errorHandlerConfig: {
          mode: 'custom',
          provider: 'claude',
          model: 'claude-3-5-haiku-latest',
          prompt: 'Custom retry-analysis prompt',
          maxInputChars: 1200,
        },
      })
      .where(eq(runNodes.id, runNodeId))
      .run();

    const nodeAttemptContexts: (string[] | undefined)[] = [];
    const customHandlerCalls: { prompt: string; options: ProviderRunOptions }[] = [];
    let codexAttempt = 0;
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: (providerName) => {
        if (providerName === 'codex') {
          return {
            async *run(_prompt: string, options: ProviderRunOptions): AsyncIterable<ProviderEvent> {
              codexAttempt += 1;
              nodeAttemptContexts.push(options.context);
              if (codexAttempt === 1) {
                throw new Error('first-attempt-failure');
              }
              yield { type: 'result', content: 'codex recovered', timestamp: 20 };
            },
          };
        }

        if (providerName === 'claude') {
          return {
            async *run(prompt: string, options: ProviderRunOptions): AsyncIterable<ProviderEvent> {
              customHandlerCalls.push({ prompt, options });
              yield { type: 'result', content: 'custom handler summary', timestamp: 12 };
            },
          };
        }

        throw new Error(`Unexpected provider ${providerName}.`);
      },
    });

    const result = await executor.executeRun({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(result.finalStep).toEqual({
      outcome: 'run_terminal',
      workflowRunId: runId,
      runStatus: 'completed',
    });
    expect(customHandlerCalls).toHaveLength(1);
    expect(customHandlerCalls[0]?.prompt).toBe('Custom retry-analysis prompt');
    expect(customHandlerCalls[0]?.options.model).toBe('claude-3-5-haiku-latest');
    expect(customHandlerCalls[0]?.options.context).toHaveLength(1);
    expect(customHandlerCalls[0]?.options.context?.[0]).toContain('ALPHRED_RETRY_ERROR_HANDLER_INPUT v1');
    expect(nodeAttemptContexts[1]).toHaveLength(1);
    expect(nodeAttemptContexts[1]?.[0]).toContain('custom handler summary');

    const summaryArtifact = db
      .select({
        metadata: phaseArtifacts.metadata,
      })
      .from(phaseArtifacts)
      .where(and(eq(phaseArtifacts.runNodeId, runNodeId), eq(phaseArtifacts.artifactType, 'note')))
      .get();
    expect(summaryArtifact?.metadata).toEqual(
      expect.objectContaining({
        kind: 'error_handler_summary_v1',
        errorHandler: expect.objectContaining({
          provider: 'claude',
          model: 'claude-3-5-haiku-latest',
        }),
      }),
    );
  });

  it('continues retry execution when the error handler itself fails', async () => {
    const { db, runId, runNodeId } = seedSingleAgentRun('markdown', 1);
    const nodeAttemptContexts: (string[] | undefined)[] = [];
    let nodeAttempt = 0;

    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () => ({
        async *run(prompt: string, options: ProviderRunOptions): AsyncIterable<ProviderEvent> {
          if (prompt.startsWith('Analyze the following node execution failure.')) {
            throw new Error('error-handler-failed sk-ABCDEF1234567890');
          }

          nodeAttempt += 1;
          nodeAttemptContexts.push(options.context);
          if (nodeAttempt === 1) {
            throw new Error('primary-attempt-failed');
          }
          yield { type: 'result', content: 'recovered anyway', timestamp: 20 };
        },
      }),
    });

    const result = await executor.executeRun({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(result.finalStep).toEqual({
      outcome: 'run_terminal',
      workflowRunId: runId,
      runStatus: 'completed',
    });
    expect(nodeAttemptContexts[1]).toBeUndefined();

    const summaryArtifacts = db
      .select({
        id: phaseArtifacts.id,
      })
      .from(phaseArtifacts)
      .where(and(eq(phaseArtifacts.runNodeId, runNodeId), eq(phaseArtifacts.artifactType, 'note')))
      .all();
    expect(summaryArtifacts).toHaveLength(0);

    const failureDiagnostics = db
      .select({
        diagnostics: runNodeDiagnostics.diagnostics,
      })
      .from(runNodeDiagnostics)
      .where(and(eq(runNodeDiagnostics.runNodeId, runNodeId), eq(runNodeDiagnostics.attempt, 1)))
      .get();
    const payload = failureDiagnostics?.diagnostics as {
      summary?: { redacted: boolean };
      errorHandler?: Record<string, unknown>;
    } | null;
    expect(payload?.summary?.redacted).toBe(true);
    expect(payload?.errorHandler).toEqual(
      expect.objectContaining({
        attempted: true,
        status: 'failed',
        sourceAttempt: 1,
        targetAttempt: 2,
        errorMessage: '[REDACTED]',
      }),
    );
  });

  it('includes only the immediately prior attempt summary on each retry', async () => {
    const { db, runId } = seedSingleAgentRun('markdown', 2);
    const nodeAttemptContexts: (string[] | undefined)[] = [];
    let nodeAttempt = 0;

    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () => ({
        async *run(prompt: string, options: ProviderRunOptions): AsyncIterable<ProviderEvent> {
          if (prompt.startsWith('Analyze the following node execution failure.')) {
            const sourceAttemptMatch = options.context?.[0]?.match(/source_attempt:\s*(\d+)/);
            const sourceAttempt = sourceAttemptMatch ? Number(sourceAttemptMatch[1]) : -1;
            yield {
              type: 'result',
              content: `summary-for-attempt-${sourceAttempt}`,
              timestamp: 12,
            };
            return;
          }

          nodeAttempt += 1;
          nodeAttemptContexts.push(options.context);
          if (nodeAttempt <= 2) {
            throw new Error(`primary-attempt-${nodeAttempt}-failed`);
          }
          yield { type: 'result', content: 'third attempt succeeded', timestamp: 20 };
        },
      }),
    });

    const result = await executor.executeRun({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(result.finalStep).toEqual({
      outcome: 'run_terminal',
      workflowRunId: runId,
      runStatus: 'completed',
    });
    expect(nodeAttemptContexts[1]).toHaveLength(1);
    expect(nodeAttemptContexts[2]).toHaveLength(1);
    expect(nodeAttemptContexts[1]?.[0]).toContain('summary-for-attempt-1');
    expect(nodeAttemptContexts[2]?.[0]).toContain('summary-for-attempt-2');
    expect(nodeAttemptContexts[2]?.[0]).not.toContain('summary-for-attempt-1');
  });

  it('returns blocked when pending nodes exist but none are runnable', async () => {
    const { db, runId } = seedGuardedCycleRun();
    const resolveProvider = vi.fn(() => createProvider([]));
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider,
    });

    const step = await executor.executeNextRunnableNode({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(step).toEqual({
      outcome: 'blocked',
      workflowRunId: runId,
      runStatus: 'running',
    });
    expect(resolveProvider).not.toHaveBeenCalled();

    const persistedRun = db
      .select({
        status: workflowRuns.status,
        startedAt: workflowRuns.startedAt,
        completedAt: workflowRuns.completedAt,
      })
      .from(workflowRuns)
      .where(eq(workflowRuns.id, runId))
      .get();

    expect(persistedRun).toBeDefined();
    if (!persistedRun) {
      throw new Error('Expected persisted workflow run row.');
    }

    expect(persistedRun.status).toBe('running');
    expect(persistedRun.startedAt).not.toBeNull();
    expect(persistedRun.completedAt).toBeNull();

    const pendingNodes = db
      .select({
        status: runNodes.status,
      })
      .from(runNodes)
      .where(eq(runNodes.workflowRunId, runId))
      .all();

    expect(pendingNodes).toHaveLength(2);
    expect(pendingNodes.every((node) => node.status === 'pending')).toBe(true);
  });

  it('persists decision output for a completed leaf node without outgoing edges', async () => {
    const { db, runId, runNodeId } = seedSingleAgentRun();
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () =>
        createProvider([
          {
            type: 'result',
            content: 'decision: retry\nRe-run after updates.',
            timestamp: 10,
            metadata: { routingDecision: 'retry' },
          },
        ]),
    });

    const result = await executor.executeRun({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(result.finalStep).toEqual({
      outcome: 'run_terminal',
      workflowRunId: runId,
      runStatus: 'completed',
    });

    const persistedDecision = db
      .select({
        decisionType: routingDecisions.decisionType,
        rawOutput: routingDecisions.rawOutput,
      })
      .from(routingDecisions)
      .where(eq(routingDecisions.runNodeId, runNodeId))
      .get();

    expect(persistedDecision).toEqual({
      decisionType: 'retry',
      rawOutput: {
        source: 'provider_result_metadata',
        routingDecision: 'retry',
        attempt: 1,
      },
    });
  });

  it('routes to the approved branch and persists an approved decision', async () => {
    const { db, runId, reviewRunNodeId, approvedRunNodeId, reviseRunNodeId } = seedDecisionRoutingRun();
    let runInvocation = 0;
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () => ({
        async *run(): AsyncIterable<ProviderEvent> {
          runInvocation += 1;
          if (runInvocation === 1) {
            yield {
              type: 'result',
              content: 'decision: approved\nShip it.',
              timestamp: 10,
              metadata: { routingDecision: 'approved' },
            };
            return;
          }

          yield { type: 'result', content: `Executed node ${runInvocation}.`, timestamp: 20 };
        },
      }),
    });

    const firstStep = await executor.executeNextRunnableNode({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(firstStep).toEqual({
      outcome: 'executed',
      workflowRunId: runId,
      runNodeId: reviewRunNodeId,
      nodeKey: 'review',
      runNodeStatus: 'completed',
      runStatus: 'running',
      artifactId: expect.any(Number),
    });

    const persistedReviewDecision = db
      .select({
        decisionType: routingDecisions.decisionType,
      })
      .from(routingDecisions)
      .where(eq(routingDecisions.runNodeId, reviewRunNodeId))
      .get();

    expect(persistedReviewDecision).toEqual({
      decisionType: 'approved',
    });

    const secondStep = await executor.executeNextRunnableNode({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(secondStep).toEqual({
      outcome: 'executed',
      workflowRunId: runId,
      runNodeId: approvedRunNodeId,
      nodeKey: 'approved_target',
      runNodeStatus: 'completed',
      runStatus: 'completed',
      artifactId: expect.any(Number),
    });

    const reviseStatus = db
      .select({
        status: runNodes.status,
      })
      .from(runNodes)
      .where(eq(runNodes.id, reviseRunNodeId))
      .get();

    expect(reviseStatus).toEqual({
      status: 'skipped',
    });

    const thirdStep = await executor.executeNextRunnableNode({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(thirdStep).toEqual({
      outcome: 'run_terminal',
      workflowRunId: runId,
      runStatus: 'completed',
    });
    expect(runInvocation).toBe(2);
  });

  it('injects routing metadata contract into prompts for guarded-success nodes', async () => {
    const { db, runId, reviewRunNodeId } = seedDecisionRoutingRun();
    let observedPrompt = '';
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () => ({
        async *run(prompt: string): AsyncIterable<ProviderEvent> {
          observedPrompt = prompt;
          yield {
            type: 'result',
            content: 'Decision captured.',
            timestamp: 10,
            metadata: { routingDecision: 'approved' },
          };
        },
      }),
    });

    const firstStep = await executor.executeNextRunnableNode({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(firstStep).toEqual({
      outcome: 'executed',
      workflowRunId: runId,
      runNodeId: reviewRunNodeId,
      nodeKey: 'review',
      runNodeStatus: 'completed',
      runStatus: 'running',
      artifactId: expect.any(Number),
    });
    expect(observedPrompt).toContain('Produce route decision');
    expect(observedPrompt).toContain(routingDecisionContractSentinel);
    expect(observedPrompt).toContain('result.metadata.routingDecision');
    expect(observedPrompt).toContain(`${routingDecisionContractLinePrefix} <approved|changes_requested|blocked|retry>`);
    expect(observedPrompt).toContain('`changes_requested`');
  });

  it('does not duplicate routing metadata contract when prompt already includes the contract sentinel', async () => {
    const { db, runId, reviewRunNodeId } = seedDecisionRoutingRun({
      reviewPromptContent: [
        'Produce route decision',
        routingDecisionContractSentinel,
        `Example contract line: ${routingDecisionContractLinePrefix} approved`,
      ].join('\n'),
    });
    let observedPrompt = '';
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () => ({
        async *run(prompt: string): AsyncIterable<ProviderEvent> {
          observedPrompt = prompt;
          yield {
            type: 'result',
            content: 'Decision captured.',
            timestamp: 10,
            metadata: { routingDecision: 'approved' },
          };
        },
      }),
    });

    const firstStep = await executor.executeNextRunnableNode({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(firstStep).toEqual({
      outcome: 'executed',
      workflowRunId: runId,
      runNodeId: reviewRunNodeId,
      nodeKey: 'review',
      runNodeStatus: 'completed',
      runStatus: 'running',
      artifactId: expect.any(Number),
    });
    expect(observedPrompt).toContain(routingDecisionContractSentinel);
    expect(observedPrompt.split(routingDecisionContractSentinel).length - 1).toBe(1);
  });

  it('routes using structured metadata even when report text resembles a decision directive', async () => {
    const { db, runId, reviewRunNodeId, approvedRunNodeId } = seedDecisionRoutingRun();
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () => ({
        async *run(): AsyncIterable<ProviderEvent> {
          yield {
            type: 'result',
            content: 'Model summary\r\n\tDeCiSion \t:\t ApPrOvEd  \r\nShip it.',
            timestamp: 10,
            metadata: { routingDecision: 'approved' },
          };
        },
      }),
    });

    const firstStep = await executor.executeNextRunnableNode({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(firstStep).toEqual({
      outcome: 'executed',
      workflowRunId: runId,
      runNodeId: reviewRunNodeId,
      nodeKey: 'review',
      runNodeStatus: 'completed',
      runStatus: 'running',
      artifactId: expect.any(Number),
    });

    const persistedReviewDecision = db
      .select({
        decisionType: routingDecisions.decisionType,
      })
      .from(routingDecisions)
      .where(eq(routingDecisions.runNodeId, reviewRunNodeId))
      .get();

    expect(persistedReviewDecision).toEqual({
      decisionType: 'approved',
    });

    const secondStep = await executor.executeNextRunnableNode({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(secondStep).toEqual({
      outcome: 'executed',
      workflowRunId: runId,
      runNodeId: approvedRunNodeId,
      nodeKey: 'approved_target',
      runNodeStatus: 'completed',
      runStatus: 'completed',
      artifactId: expect.any(Number),
    });
  });

  it('routes from structured metadata even when report content is very large', async () => {
    const { db, runId, reviewRunNodeId, reviseRunNodeId } = seedDecisionRoutingRun();
    const largePrefix = 'Context line without an explicit route.\n'.repeat(10_000);
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () => ({
        async *run(): AsyncIterable<ProviderEvent> {
          yield {
            type: 'result',
            content: `${largePrefix}Needs another pass.`,
            timestamp: 10,
            metadata: { routingDecision: 'changes_requested' },
          };
        },
      }),
    });

    const firstStep = await executor.executeNextRunnableNode({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(firstStep).toEqual({
      outcome: 'executed',
      workflowRunId: runId,
      runNodeId: reviewRunNodeId,
      nodeKey: 'review',
      runNodeStatus: 'completed',
      runStatus: 'running',
      artifactId: expect.any(Number),
    });

    const persistedReviewDecision = db
      .select({
        decisionType: routingDecisions.decisionType,
      })
      .from(routingDecisions)
      .where(eq(routingDecisions.runNodeId, reviewRunNodeId))
      .get();

    expect(persistedReviewDecision).toEqual({
      decisionType: 'changes_requested',
    });

    const secondStep = await executor.executeNextRunnableNode({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(secondStep).toEqual({
      outcome: 'executed',
      workflowRunId: runId,
      runNodeId: reviseRunNodeId,
      nodeKey: 'revise_target',
      runNodeStatus: 'completed',
      runStatus: 'completed',
      artifactId: expect.any(Number),
    });
  });

  it('persists no_route for large reports when structured routing metadata is missing', async () => {
    const { db, runId, reviewRunNodeId } = seedDecisionRoutingRun();
    const largeMalformedPrefix = '  decision:: blocked ???\n'.repeat(8_000);
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () => ({
        async *run(): AsyncIterable<ProviderEvent> {
          yield {
            type: 'result',
            content: `${largeMalformedPrefix}No valid route directive was produced.`,
            timestamp: 10,
          };
        },
      }),
    });

    const firstStep = await executor.executeNextRunnableNode({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(firstStep).toEqual({
      outcome: 'executed',
      workflowRunId: runId,
      runNodeId: reviewRunNodeId,
      nodeKey: 'review',
      runNodeStatus: 'completed',
      runStatus: 'failed',
      artifactId: expect.any(Number),
    });

    const persistedReviewDecision = db
      .select({
        decisionType: routingDecisions.decisionType,
        rationale: routingDecisions.rationale,
        rawOutput: routingDecisions.rawOutput,
      })
      .from(routingDecisions)
      .where(eq(routingDecisions.runNodeId, reviewRunNodeId))
      .get();

    expect(persistedReviewDecision).toEqual({
      decisionType: 'no_route',
      rationale: expect.stringContaining('did not emit a valid result.metadata.routingDecision'),
      rawOutput: {
        source: 'provider_result_metadata',
        routingDecision: null,
        outgoingEdgeIds: expect.arrayContaining([expect.any(Number)]),
        attempt: 1,
      },
    });
  });

  it('does not persist fan-out children or barriers when guarded spawner routing resolves to no_route', async () => {
    const { db, runId, runNodeIdByKey } = seedGuardedDynamicFanOutNoRouteRun();
    const breakdownRunNodeId = runNodeIdByKey.get('breakdown');
    if (!breakdownRunNodeId) {
      throw new Error('Expected breakdown run node to exist.');
    }

    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () => ({
        async *run(): AsyncIterable<ProviderEvent> {
          yield {
            type: 'result',
            content: JSON.stringify({
              schemaVersion: 1,
              subtasks: [
                {
                  nodeKey: 'should-not-persist',
                  title: 'Should not persist',
                  prompt: 'This fan-out child should not be created.',
                },
              ],
            }),
            timestamp: 10,
          };
        },
      }),
    });

    const firstStep = await executor.executeNextRunnableNode({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(firstStep).toEqual({
      outcome: 'executed',
      workflowRunId: runId,
      runNodeId: breakdownRunNodeId,
      nodeKey: 'breakdown',
      runNodeStatus: 'completed',
      runStatus: 'failed',
      artifactId: expect.any(Number),
    });

    const persistedDecision = db
      .select({
        decisionType: routingDecisions.decisionType,
      })
      .from(routingDecisions)
      .where(eq(routingDecisions.runNodeId, breakdownRunNodeId))
      .get();
    expect(persistedDecision).toEqual({
      decisionType: 'no_route',
    });

    const dynamicChildCountRow = db
      .select({
        count: sql<number>`count(*)`,
      })
      .from(runNodes)
      .where(and(eq(runNodes.workflowRunId, runId), eq(runNodes.spawnerNodeId, breakdownRunNodeId)))
      .get();
    expect(dynamicChildCountRow?.count ?? 0).toBe(0);

    const joinBarrierCountRow = db
      .select({
        count: sql<number>`count(*)`,
      })
      .from(runJoinBarriers)
      .where(eq(runJoinBarriers.workflowRunId, runId))
      .get();
    expect(joinBarrierCountRow?.count ?? 0).toBe(0);

    const dynamicEdgeCountRow = db
      .select({
        count: sql<number>`count(*)`,
      })
      .from(runNodeEdges)
      .where(
        and(
          eq(runNodeEdges.workflowRunId, runId),
          inArray(runNodeEdges.edgeKind, ['dynamic_spawner_to_child', 'dynamic_child_to_join']),
        ),
      )
      .get();
    expect(dynamicEdgeCountRow?.count ?? 0).toBe(0);
  });

  it('persists fallback routing decision source when provider emits contract-parsed metadata', async () => {
    const { db, runId, reviewRunNodeId, reviseRunNodeId } = seedDecisionRoutingRun();
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () => ({
        async *run(): AsyncIterable<ProviderEvent> {
          yield {
            type: 'result',
            content: 'Findings complete.\nresult.metadata.routingDecision: changes_requested',
            timestamp: 10,
            metadata: {
              routingDecision: 'changes_requested',
              routingDecisionSource: 'result_content_contract_fallback',
            },
          };
        },
      }),
    });

    const firstStep = await executor.executeNextRunnableNode({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(firstStep).toEqual({
      outcome: 'executed',
      workflowRunId: runId,
      runNodeId: reviewRunNodeId,
      nodeKey: 'review',
      runNodeStatus: 'completed',
      runStatus: 'running',
      artifactId: expect.any(Number),
    });

    const persistedReviewDecision = db
      .select({
        decisionType: routingDecisions.decisionType,
        rawOutput: routingDecisions.rawOutput,
      })
      .from(routingDecisions)
      .where(eq(routingDecisions.runNodeId, reviewRunNodeId))
      .get();

    expect(persistedReviewDecision).toEqual({
      decisionType: 'changes_requested',
      rawOutput: {
        source: 'result_content_contract_fallback',
        routingDecision: 'changes_requested',
        selectedEdgeId: expect.any(Number),
        attempt: 1,
      },
    });

    const secondStep = await executor.executeNextRunnableNode({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(secondStep).toEqual({
      outcome: 'executed',
      workflowRunId: runId,
      runNodeId: reviseRunNodeId,
      nodeKey: 'revise_target',
      runNodeStatus: 'completed',
      runStatus: 'completed',
      artifactId: expect.any(Number),
    });
  });

  it('routes to the revise branch and persists a changes_requested decision', async () => {
    const { db, runId, reviewRunNodeId, approvedRunNodeId, reviseRunNodeId } = seedDecisionRoutingRun();
    let runInvocation = 0;
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () => ({
        async *run(): AsyncIterable<ProviderEvent> {
          runInvocation += 1;
          if (runInvocation === 1) {
            yield {
              type: 'result',
              content: 'decision: changes_requested\nNeeds another pass.',
              timestamp: 10,
              metadata: { routingDecision: 'changes_requested' },
            };
            return;
          }

          yield { type: 'result', content: `Executed node ${runInvocation}.`, timestamp: 20 };
        },
      }),
    });

    const firstStep = await executor.executeNextRunnableNode({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(firstStep).toEqual({
      outcome: 'executed',
      workflowRunId: runId,
      runNodeId: reviewRunNodeId,
      nodeKey: 'review',
      runNodeStatus: 'completed',
      runStatus: 'running',
      artifactId: expect.any(Number),
    });

    const persistedReviewDecision = db
      .select({
        decisionType: routingDecisions.decisionType,
      })
      .from(routingDecisions)
      .where(eq(routingDecisions.runNodeId, reviewRunNodeId))
      .get();

    expect(persistedReviewDecision).toEqual({
      decisionType: 'changes_requested',
    });

    const secondStep = await executor.executeNextRunnableNode({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(secondStep).toEqual({
      outcome: 'executed',
      workflowRunId: runId,
      runNodeId: reviseRunNodeId,
      nodeKey: 'revise_target',
      runNodeStatus: 'completed',
      runStatus: 'completed',
      artifactId: expect.any(Number),
    });

    const approvedStatus = db
      .select({
        status: runNodes.status,
      })
      .from(runNodes)
      .where(eq(runNodes.id, approvedRunNodeId))
      .get();

    expect(approvedStatus).toEqual({
      status: 'skipped',
    });

    const thirdStep = await executor.executeNextRunnableNode({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(thirdStep).toEqual({
      outcome: 'run_terminal',
      workflowRunId: runId,
      runStatus: 'completed',
    });
    expect(runInvocation).toBe(2);
  });

  it('persists no_route and fails the run when no guarded edge matches', async () => {
    const { db, runId, reviewRunNodeId } = seedDecisionRoutingRun();
    const resolveProvider = vi.fn(() => ({
      async *run(): AsyncIterable<ProviderEvent> {
        yield {
          type: 'result',
          content: 'decision: blocked\nCannot proceed yet.',
          timestamp: 10,
          metadata: { routingDecision: 'blocked' },
        };
      },
    }));
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider,
    });

    const firstStep = await executor.executeNextRunnableNode({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(firstStep).toEqual({
      outcome: 'executed',
      workflowRunId: runId,
      runNodeId: reviewRunNodeId,
      nodeKey: 'review',
      runNodeStatus: 'completed',
      runStatus: 'failed',
      artifactId: expect.any(Number),
    });

    const persistedReviewDecision = db
      .select({
        decisionType: routingDecisions.decisionType,
        rationale: routingDecisions.rationale,
      })
      .from(routingDecisions)
      .where(eq(routingDecisions.runNodeId, reviewRunNodeId))
      .get();

    expect(persistedReviewDecision).toEqual({
      decisionType: 'no_route',
      rationale: expect.stringContaining('routingDecision="blocked"'),
    });

    const secondStep = await executor.executeNextRunnableNode({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(secondStep).toEqual({
      outcome: 'run_terminal',
      workflowRunId: runId,
      runStatus: 'failed',
    });
    expect(resolveProvider).toHaveBeenCalledTimes(1);
  });

  it('persists no_route and fails when decision output is missing even with != guards', async () => {
    const { db, runId, reviewRunNodeId } = seedDecisionRoutingRun({
      approvedGuardOperator: '!=',
      approvedGuardValue: 'approved',
      changesRequestedGuardOperator: '!=',
      changesRequestedGuardValue: 'changes_requested',
    });
    const resolveProvider = vi.fn(() => ({
      async *run(): AsyncIterable<ProviderEvent> {
        yield {
          type: 'result',
          content: 'Route analysis complete. No explicit decision line was provided.',
          timestamp: 10,
        };
      },
    }));
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider,
    });

    const firstStep = await executor.executeNextRunnableNode({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(firstStep).toEqual({
      outcome: 'executed',
      workflowRunId: runId,
      runNodeId: reviewRunNodeId,
      nodeKey: 'review',
      runNodeStatus: 'completed',
      runStatus: 'failed',
      artifactId: expect.any(Number),
    });

    const persistedReviewDecision = db
      .select({
        decisionType: routingDecisions.decisionType,
      })
      .from(routingDecisions)
      .where(eq(routingDecisions.runNodeId, reviewRunNodeId))
      .get();

    expect(persistedReviewDecision).toEqual({
      decisionType: 'no_route',
    });

    const secondStep = await executor.executeNextRunnableNode({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(secondStep).toEqual({
      outcome: 'run_terminal',
      workflowRunId: runId,
      runStatus: 'failed',
    });
    expect(resolveProvider).toHaveBeenCalledTimes(1);
  });

  it('persists no_route when routing decision metadata is unknown', async () => {
    const { db, runId, reviewRunNodeId } = seedDecisionRoutingRun();
    const resolveProvider = vi.fn(() => ({
      async *run(): AsyncIterable<ProviderEvent> {
        yield {
          type: 'result',
          content: 'decision: unknown_signal\nNo matching route.',
          timestamp: 10,
          metadata: { routingDecision: 'unknown_signal' } as unknown as ProviderEvent['metadata'],
        };
      },
    }));
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider,
    });

    const firstStep = await executor.executeNextRunnableNode({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(firstStep).toEqual({
      outcome: 'executed',
      workflowRunId: runId,
      runNodeId: reviewRunNodeId,
      nodeKey: 'review',
      runNodeStatus: 'completed',
      runStatus: 'failed',
      artifactId: expect.any(Number),
    });

    const persistedReviewDecision = db
      .select({
        decisionType: routingDecisions.decisionType,
        rationale: routingDecisions.rationale,
        rawOutput: routingDecisions.rawOutput,
      })
      .from(routingDecisions)
      .where(eq(routingDecisions.runNodeId, reviewRunNodeId))
      .get();

    expect(persistedReviewDecision).toEqual({
      decisionType: 'no_route',
      rationale: expect.stringContaining('did not emit a valid result.metadata.routingDecision'),
      rawOutput: {
        source: 'provider_result_metadata',
        routingDecision: null,
        outgoingEdgeIds: expect.arrayContaining([expect.any(Number)]),
        attempt: 1,
      },
    });
    expect(resolveProvider).toHaveBeenCalledTimes(1);
  });

  it('does not route using legacy routing_decision when canonical routingDecision is unknown', async () => {
    const { db, runId, reviewRunNodeId } = seedDecisionRoutingRun();
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () => ({
        async *run(): AsyncIterable<ProviderEvent> {
          yield {
            type: 'result',
            content: 'Route using mixed metadata keys.',
            timestamp: 10,
            metadata: {
              routingDecision: 'unknown_signal',
              routing_decision: 'approved',
            } as unknown as ProviderEvent['metadata'],
          };
        },
      }),
    });

    const firstStep = await executor.executeNextRunnableNode({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(firstStep).toEqual({
      outcome: 'executed',
      workflowRunId: runId,
      runNodeId: reviewRunNodeId,
      nodeKey: 'review',
      runNodeStatus: 'completed',
      runStatus: 'failed',
      artifactId: expect.any(Number),
    });

    const persistedReviewDecision = db
      .select({
        decisionType: routingDecisions.decisionType,
        rawOutput: routingDecisions.rawOutput,
      })
      .from(routingDecisions)
      .where(eq(routingDecisions.runNodeId, reviewRunNodeId))
      .get();

    expect(persistedReviewDecision).toEqual({
      decisionType: 'no_route',
      rawOutput: {
        source: 'provider_result_metadata',
        routingDecision: null,
        outgoingEdgeIds: expect.arrayContaining([expect.any(Number)]),
        attempt: 1,
      },
    });

    const secondStep = await executor.executeNextRunnableNode({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(secondStep).toEqual({
      outcome: 'run_terminal',
      workflowRunId: runId,
      runStatus: 'failed',
    });
  });

  it('uses canonical routingDecision when both canonical and legacy keys are present', async () => {
    const { db, runId, reviewRunNodeId, reviseRunNodeId } = seedDecisionRoutingRun();
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () => ({
        async *run(): AsyncIterable<ProviderEvent> {
          yield {
            type: 'result',
            content: 'Route using conflicting mixed metadata keys.',
            timestamp: 10,
            metadata: {
              routingDecision: 'changes_requested',
              routing_decision: 'approved',
            } as unknown as ProviderEvent['metadata'],
          };
        },
      }),
    });

    const firstStep = await executor.executeNextRunnableNode({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(firstStep).toEqual({
      outcome: 'executed',
      workflowRunId: runId,
      runNodeId: reviewRunNodeId,
      nodeKey: 'review',
      runNodeStatus: 'completed',
      runStatus: 'running',
      artifactId: expect.any(Number),
    });

    const persistedReviewDecision = db
      .select({
        decisionType: routingDecisions.decisionType,
        rawOutput: routingDecisions.rawOutput,
      })
      .from(routingDecisions)
      .where(eq(routingDecisions.runNodeId, reviewRunNodeId))
      .get();

    expect(persistedReviewDecision).toEqual({
      decisionType: 'changes_requested',
      rawOutput: {
        source: 'provider_result_metadata',
        routingDecision: 'changes_requested',
        selectedEdgeId: expect.any(Number),
        attempt: 1,
      },
    });

    const secondStep = await executor.executeNextRunnableNode({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(secondStep).toEqual({
      outcome: 'executed',
      workflowRunId: runId,
      runNodeId: reviseRunNodeId,
      nodeKey: 'revise_target',
      runNodeStatus: 'completed',
      runStatus: 'completed',
      artifactId: expect.any(Number),
    });
  });

  it('routes across auto edges without persisting a decision when no decision line is present', async () => {
    const { db, runId, sourceRunNodeId, targetRunNodeId } = seedLinearAutoRun();
    let runInvocation = 0;
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () => ({
        async *run(): AsyncIterable<ProviderEvent> {
          runInvocation += 1;
          if (runInvocation === 1) {
            yield { type: 'result', content: 'No explicit routing directive.', timestamp: 10 };
            return;
          }

          yield { type: 'result', content: 'Reached target node.', timestamp: 20 };
        },
      }),
    });

    const firstStep = await executor.executeNextRunnableNode({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(firstStep).toEqual({
      outcome: 'executed',
      workflowRunId: runId,
      runNodeId: sourceRunNodeId,
      nodeKey: 'source',
      runNodeStatus: 'completed',
      runStatus: 'running',
      artifactId: expect.any(Number),
    });

    const persistedDecision = db
      .select({
        decisionType: routingDecisions.decisionType,
      })
      .from(routingDecisions)
      .where(eq(routingDecisions.runNodeId, sourceRunNodeId))
      .get();

    expect(persistedDecision).toBeUndefined();

    const secondStep = await executor.executeNextRunnableNode({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(secondStep).toEqual({
      outcome: 'executed',
      workflowRunId: runId,
      runNodeId: targetRunNodeId,
      nodeKey: 'target',
      runNodeStatus: 'completed',
      runStatus: 'completed',
      artifactId: expect.any(Number),
    });
  });

  it('returns blocked and fails when a completed node already has a no_route decision with no runnable successors', async () => {
    const { db, runId, reviewRunNodeId } = seedDecisionRoutingRun();
    transitionRunNodeStatus(db, {
      runNodeId: reviewRunNodeId,
      expectedFrom: 'pending',
      to: 'running',
      occurredAt: '2026-01-01T00:00:00.000Z',
    });
    transitionRunNodeStatus(db, {
      runNodeId: reviewRunNodeId,
      expectedFrom: 'running',
      to: 'completed',
      occurredAt: '2026-01-01T00:01:00.000Z',
    });
    db.insert(routingDecisions)
      .values({
        workflowRunId: runId,
        runNodeId: reviewRunNodeId,
        decisionType: 'no_route',
        rationale: 'Seeded for blocked-path coverage.',
        rawOutput: {
          source: 'test',
        },
      })
      .run();

    const resolveProvider = vi.fn(() => createProvider([]));
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider,
    });

    const result = await executor.executeNextRunnableNode({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(result).toEqual({
      outcome: 'blocked',
      workflowRunId: runId,
      runStatus: 'failed',
    });
    expect(resolveProvider).not.toHaveBeenCalled();
  });

  it('fails a guarded spawner no_route attempt even when older dynamic fan-out edges still exist', async () => {
    const { db, runId, runNodeIdByKey } = seedGuardedDynamicFanOutNoRouteRun();
    const breakdownRunNodeId = runNodeIdByKey.get('breakdown');
    const finalReviewRunNodeId = runNodeIdByKey.get('final-review');
    if (!breakdownRunNodeId || !finalReviewRunNodeId) {
      throw new Error('Expected guarded dynamic fan-out run nodes to include breakdown and final-review.');
    }

    transitionWorkflowRunStatus(db, {
      workflowRunId: runId,
      expectedFrom: 'pending',
      to: 'running',
      occurredAt: '2026-01-01T00:00:00.000Z',
    });
    transitionRunNodeStatus(db, {
      runNodeId: breakdownRunNodeId,
      expectedFrom: 'pending',
      to: 'running',
      occurredAt: '2026-01-01T00:01:00.000Z',
    });
    transitionRunNodeStatus(db, {
      runNodeId: breakdownRunNodeId,
      expectedFrom: 'running',
      to: 'completed',
      occurredAt: '2026-01-01T00:02:00.000Z',
    });
    transitionRunNodeStatus(db, {
      runNodeId: finalReviewRunNodeId,
      expectedFrom: 'pending',
      to: 'skipped',
      occurredAt: '2026-01-01T00:02:30.000Z',
    });

    const spawnerNode = db
      .select({
        treeNodeId: runNodes.treeNodeId,
      })
      .from(runNodes)
      .where(eq(runNodes.id, breakdownRunNodeId))
      .get();
    if (!spawnerNode) {
      throw new Error('Expected breakdown run node to exist.');
    }

    const dynamicChildRunNodeId = Number(
      db
        .insert(runNodes)
        .values({
          workflowRunId: runId,
          treeNodeId: spawnerNode.treeNodeId,
          nodeKey: 'stale-dynamic-child',
          nodeRole: 'standard',
          nodeType: 'agent',
          provider: 'codex',
          model: null,
          prompt: 'Previously spawned child.',
          promptContentType: 'markdown',
          executionPermissions: null,
          errorHandlerConfig: null,
          maxChildren: 0,
          maxRetries: 0,
          spawnerNodeId: breakdownRunNodeId,
          joinNodeId: finalReviewRunNodeId,
          lineageDepth: 1,
          sequencePath: '10.1',
          status: 'pending',
          sequenceIndex: 15,
          attempt: 1,
          startedAt: null,
          completedAt: null,
          createdAt: '2026-01-01T00:01:10.000Z',
          updatedAt: '2026-01-01T00:01:10.000Z',
        })
        .run().lastInsertRowid,
    );

    db.insert(runNodeEdges)
      .values([
        {
          workflowRunId: runId,
          sourceRunNodeId: breakdownRunNodeId,
          targetRunNodeId: dynamicChildRunNodeId,
          routeOn: 'success',
          auto: 1,
          guardExpression: null,
          priority: 1,
          edgeKind: 'dynamic_spawner_to_child',
        },
        {
          workflowRunId: runId,
          sourceRunNodeId: dynamicChildRunNodeId,
          targetRunNodeId: finalReviewRunNodeId,
          routeOn: 'terminal',
          auto: 1,
          guardExpression: null,
          priority: 0,
          edgeKind: 'dynamic_child_to_join',
        },
      ])
      .run();

    transitionRunNodeStatus(db, {
      runNodeId: dynamicChildRunNodeId,
      expectedFrom: 'pending',
      to: 'running',
      occurredAt: '2026-01-01T00:01:30.000Z',
    });
    transitionRunNodeStatus(db, {
      runNodeId: dynamicChildRunNodeId,
      expectedFrom: 'running',
      to: 'completed',
      occurredAt: '2026-01-01T00:01:45.000Z',
    });

    db.insert(phaseArtifacts)
      .values([
        {
          workflowRunId: runId,
          runNodeId: breakdownRunNodeId,
          artifactType: 'report',
          contentType: 'json',
          content: '{"schemaVersion":1,"subtasks":[{"nodeKey":"batch-1-child","title":"Batch 1 Child","prompt":"Do work."}]}',
          metadata: {
            routingDecision: 'approved',
          },
          createdAt: '2026-01-01T00:02:05.000Z',
        },
        {
          workflowRunId: runId,
          runNodeId: dynamicChildRunNodeId,
          artifactType: 'report',
          contentType: 'markdown',
          content: 'Child artifact from batch 1.',
          metadata: {
            success: true,
          },
          createdAt: '2026-01-01T00:02:10.000Z',
        },
      ])
      .run();

    db.insert(routingDecisions)
      .values({
        workflowRunId: runId,
        runNodeId: breakdownRunNodeId,
        decisionType: 'approved',
        rawOutput: {
          source: 'test',
          routingDecision: 'approved',
          attempt: 1,
        },
        createdAt: '2026-01-01T00:02:15.000Z',
      })
      .run();

    db.update(runNodes)
      .set({
        attempt: 2,
        startedAt: '2026-01-01T00:03:00.000Z',
        completedAt: '2026-01-01T00:03:10.000Z',
        updatedAt: '2026-01-01T00:03:10.000Z',
      })
      .where(eq(runNodes.id, breakdownRunNodeId))
      .run();

    db.insert(phaseArtifacts)
      .values({
        workflowRunId: runId,
        runNodeId: breakdownRunNodeId,
        artifactType: 'report',
        contentType: 'json',
        content: '{"schemaVersion":1,"subtasks":[{"nodeKey":"batch-2-child","title":"Batch 2 Child","prompt":"Do work."}]}',
        metadata: {
          routingDecision: null,
        },
        createdAt: '2026-01-01T00:03:15.000Z',
      })
      .run();

    db.insert(routingDecisions)
      .values({
        workflowRunId: runId,
        runNodeId: breakdownRunNodeId,
        decisionType: 'no_route',
        rationale: 'Seeded stale dynamic-edge regression.',
        rawOutput: {
          source: 'test',
          routingDecision: null,
          attempt: 2,
        },
        createdAt: '2026-01-01T00:03:20.000Z',
      })
      .run();

    const resolveProvider = vi.fn(() => createProvider([]));
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider,
    });

    const result = await executor.executeNextRunnableNode({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(result).toEqual({
      outcome: 'blocked',
      workflowRunId: runId,
      runStatus: 'failed',
    });
    expect(resolveProvider).not.toHaveBeenCalled();

    const dynamicChild = db
      .select({
        status: runNodes.status,
        attempt: runNodes.attempt,
      })
      .from(runNodes)
      .where(eq(runNodes.id, dynamicChildRunNodeId))
      .get();
    expect(dynamicChild).toEqual({
      status: 'completed',
      attempt: 1,
    });
  });

  it('returns blocked and fails when a completed guarded node has no persisted routing decision', async () => {
    const { db, runId, reviewRunNodeId, approvedRunNodeId, reviseRunNodeId } = seedDecisionRoutingRun();
    transitionRunNodeStatus(db, {
      runNodeId: reviewRunNodeId,
      expectedFrom: 'pending',
      to: 'running',
      occurredAt: '2026-01-01T00:00:00.000Z',
    });
    transitionRunNodeStatus(db, {
      runNodeId: reviewRunNodeId,
      expectedFrom: 'running',
      to: 'completed',
      occurredAt: '2026-01-01T00:01:00.000Z',
    });

    const resolveProvider = vi.fn(() => createProvider([]));
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider,
    });

    const result = await executor.executeNextRunnableNode({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(result).toEqual({
      outcome: 'blocked',
      workflowRunId: runId,
      runStatus: 'failed',
    });
    expect(resolveProvider).not.toHaveBeenCalled();

    const persistedRun = db
      .select({
        status: workflowRuns.status,
      })
      .from(workflowRuns)
      .where(eq(workflowRuns.id, runId))
      .get();

    expect(persistedRun).toEqual({
      status: 'failed',
    });

    const branchStatuses = db
      .select({
        id: runNodes.id,
        status: runNodes.status,
      })
      .from(runNodes)
      .where(
        inArray(runNodes.id, [approvedRunNodeId, reviseRunNodeId]),
      )
      .all()
      .sort((a, b) => a.id - b.id);

    expect(branchStatuses).toEqual([
      {
        id: approvedRunNodeId,
        status: 'pending',
      },
      {
        id: reviseRunNodeId,
        status: 'pending',
      },
    ]);
  });

  it('fails execution when guarded-edge expressions are invalid', async () => {
    const { db, runId, reviewRunNodeId } = seedDecisionRoutingRun();
    const guardedEdge = db
      .select({ id: runNodeEdges.id })
      .from(runNodeEdges)
      .where(
        and(
          eq(runNodeEdges.workflowRunId, runId),
          eq(runNodeEdges.sourceRunNodeId, reviewRunNodeId),
          eq(runNodeEdges.routeOn, 'success'),
          eq(runNodeEdges.priority, 0),
          eq(runNodeEdges.edgeKind, 'tree'),
        ),
      )
      .get();
    if (!guardedEdge) {
      throw new Error('Expected guarded run edge for decision-routing review node.');
    }

    db.update(runNodeEdges)
      .set({
        guardExpression: {
          logic: 'and',
          conditions: 'invalid',
        },
      })
      .where(eq(runNodeEdges.id, guardedEdge.id))
      .run();

    const resolveProvider = vi.fn(() => ({
      async *run(): AsyncIterable<ProviderEvent> {
        yield {
          type: 'result',
          content: 'decision: approved\nAttempt route.',
          timestamp: 10,
          metadata: { routingDecision: 'approved' },
        };
      },
    }));
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider,
    });

    const firstStep = await executor.executeNextRunnableNode({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(firstStep).toEqual({
      outcome: 'executed',
      workflowRunId: runId,
      runNodeId: reviewRunNodeId,
      nodeKey: 'review',
      runNodeStatus: 'failed',
      runStatus: 'failed',
      artifactId: expect.any(Number),
    });

    const artifacts = db
      .select({
        artifactType: phaseArtifacts.artifactType,
        content: phaseArtifacts.content,
      })
      .from(phaseArtifacts)
      .where(eq(phaseArtifacts.runNodeId, reviewRunNodeId))
      .all();

    expect(artifacts).toEqual(
      expect.arrayContaining([
        {
          artifactType: 'log',
          content: expect.stringContaining('Invalid guard expression for tree edge id='),
        },
      ]),
    );
    expect(resolveProvider).toHaveBeenCalledTimes(1);
  });

  it('uses priority order when multiple guarded branches match the same decision', async () => {
    const { db, runId, reviewRunNodeId, approvedRunNodeId, reviseRunNodeId } = seedDecisionRoutingRun({
      approvedGuardOperator: '!=',
      approvedGuardValue: 'retry',
      changesRequestedGuardOperator: '!=',
      changesRequestedGuardValue: 'blocked',
    });
    let runInvocation = 0;
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () => ({
        async *run(): AsyncIterable<ProviderEvent> {
          runInvocation += 1;
          if (runInvocation === 1) {
            yield {
              type: 'result',
              content: 'decision: approved\nBoth guards should match.',
              timestamp: 10,
              metadata: { routingDecision: 'approved' },
            };
            return;
          }

          yield { type: 'result', content: `Executed node ${runInvocation}.`, timestamp: 20 };
        },
      }),
    });

    const firstStep = await executor.executeNextRunnableNode({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(firstStep).toEqual({
      outcome: 'executed',
      workflowRunId: runId,
      runNodeId: reviewRunNodeId,
      nodeKey: 'review',
      runNodeStatus: 'completed',
      runStatus: 'running',
      artifactId: expect.any(Number),
    });

    const secondStep = await executor.executeNextRunnableNode({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(secondStep).toEqual({
      outcome: 'executed',
      workflowRunId: runId,
      runNodeId: approvedRunNodeId,
      nodeKey: 'approved_target',
      runNodeStatus: 'completed',
      runStatus: 'completed',
      artifactId: expect.any(Number),
    });

    const reviseStatus = db
      .select({
        status: runNodes.status,
      })
      .from(runNodes)
      .where(eq(runNodes.id, reviseRunNodeId))
      .get();

    expect(reviseStatus).toEqual({
      status: 'skipped',
    });
    expect(runInvocation).toBe(2);
  });

  it('rejects same-priority sibling edges, preventing ambiguous guarded tie-breaks', async () => {
    const { db } = seedDecisionRoutingRun({
      approvedGuardOperator: '!=',
      approvedGuardValue: 'retry',
      changesRequestedGuardOperator: '!=',
      changesRequestedGuardValue: 'blocked',
    });
    expect(() => db.update(treeEdges).set({ priority: 0 }).run()).toThrow();
  });

  it('falls back to a lower-priority auto edge when guarded edges do not match', async () => {
    const { db, runId, reviewRunNodeId, reviseRunNodeId } = seedDecisionRoutingRun();
    const fallbackEdge = db
      .select({
        id: runNodeEdges.id,
      })
      .from(runNodeEdges)
      .where(
        and(
          eq(runNodeEdges.workflowRunId, runId),
          eq(runNodeEdges.sourceRunNodeId, reviewRunNodeId),
          eq(runNodeEdges.routeOn, 'success'),
          eq(runNodeEdges.priority, 1),
          eq(runNodeEdges.edgeKind, 'tree'),
        ),
      )
      .get();
    if (!fallbackEdge) {
      throw new Error('Expected fallback edge row.');
    }

    db.update(runNodeEdges)
      .set({
        auto: 1,
        guardExpression: null,
      })
      .where(eq(runNodeEdges.id, fallbackEdge.id))
      .run();

    let runInvocation = 0;
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () => ({
        async *run(): AsyncIterable<ProviderEvent> {
          runInvocation += 1;
          if (runInvocation === 1) {
            yield {
              type: 'result',
              content: 'decision: blocked\nUse fallback route.',
              timestamp: 10,
              metadata: { routingDecision: 'blocked' },
            };
            return;
          }

          yield { type: 'result', content: `Executed node ${runInvocation}.`, timestamp: 20 };
        },
      }),
    });

    const firstStep = await executor.executeNextRunnableNode({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(firstStep).toEqual({
      outcome: 'executed',
      workflowRunId: runId,
      runNodeId: reviewRunNodeId,
      nodeKey: 'review',
      runNodeStatus: 'completed',
      runStatus: 'running',
      artifactId: expect.any(Number),
    });

    const persistedReviewDecision = db
      .select({
        decisionType: routingDecisions.decisionType,
        rawOutput: routingDecisions.rawOutput,
      })
      .from(routingDecisions)
      .where(eq(routingDecisions.runNodeId, reviewRunNodeId))
      .get();

    expect(persistedReviewDecision).toEqual({
      decisionType: 'blocked',
      rawOutput: {
        source: 'provider_result_metadata',
        routingDecision: 'blocked',
        selectedEdgeId: fallbackEdge.id,
        attempt: 1,
      },
    });

    const secondStep = await executor.executeNextRunnableNode({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(secondStep).toEqual({
      outcome: 'executed',
      workflowRunId: runId,
      runNodeId: reviseRunNodeId,
      nodeKey: 'revise_target',
      runNodeStatus: 'completed',
      runStatus: 'completed',
      artifactId: expect.any(Number),
    });
    expect(runInvocation).toBe(2);
  });

  it('defaults persisted artifact content type to markdown when prompt content type is absent', async () => {
    const { db, runId, runNodeId } = seedSingleAgentRunWithoutPromptTemplate();
    let observedPrompt: string | undefined;
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () => ({
        async *run(prompt: string): AsyncIterable<ProviderEvent> {
          observedPrompt = prompt;
          yield { type: 'result', content: 'Generated report', timestamp: 10 };
        },
      }),
    });

    const result = await executor.executeRun({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(result.finalStep).toEqual({
      outcome: 'run_terminal',
      workflowRunId: runId,
      runStatus: 'completed',
    });
    expect(observedPrompt).toBe('');

    const artifacts = db
      .select({
        artifactType: phaseArtifacts.artifactType,
        contentType: phaseArtifacts.contentType,
        content: phaseArtifacts.content,
      })
      .from(phaseArtifacts)
      .where(eq(phaseArtifacts.runNodeId, runNodeId))
      .all();

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toEqual({
      artifactType: 'report',
      contentType: 'markdown',
      content: 'Generated report',
    });
  });

  it('records failure artifact and terminal statuses when a non-agent node is selected', async () => {
    const { db, runId, runNodeId } = seedSingleHumanNodeRun();
    const resolveProvider = vi.fn(() => createProvider([]));
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider,
    });

    const result = await executor.executeRun({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(result.executedNodes).toBe(1);
    expect(result.finalStep).toEqual({
      outcome: 'run_terminal',
      workflowRunId: runId,
      runStatus: 'failed',
    });
    expect(resolveProvider).not.toHaveBeenCalled();

    const persistedRun = db
      .select({
        status: workflowRuns.status,
        completedAt: workflowRuns.completedAt,
      })
      .from(workflowRuns)
      .where(eq(workflowRuns.id, runId))
      .get();

    expect(persistedRun).toBeDefined();
    if (!persistedRun) {
      throw new Error('Expected persisted workflow run row.');
    }

    expect(persistedRun.status).toBe('failed');
    expect(persistedRun.completedAt).not.toBeNull();

    const persistedRunNode = db
      .select({
        status: runNodes.status,
        completedAt: runNodes.completedAt,
      })
      .from(runNodes)
      .where(eq(runNodes.id, runNodeId))
      .get();

    expect(persistedRunNode).toBeDefined();
    if (!persistedRunNode) {
      throw new Error('Expected persisted run-node row.');
    }

    expect(persistedRunNode.status).toBe('failed');
    expect(persistedRunNode.completedAt).not.toBeNull();

    const artifacts = db
      .select({
        artifactType: phaseArtifacts.artifactType,
        contentType: phaseArtifacts.contentType,
        content: phaseArtifacts.content,
      })
      .from(phaseArtifacts)
      .where(eq(phaseArtifacts.runNodeId, runNodeId))
      .all();

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].artifactType).toBe('log');
    expect(artifacts[0].contentType).toBe('text');
    expect(artifacts[0].content).toContain('Unsupported node type "human"');
  });

  it('returns run_terminal when the workflow run is already terminal', async () => {
    const { db, runId } = seedSingleAgentRun();
    transitionWorkflowRunStatus(db, {
      workflowRunId: runId,
      expectedFrom: 'pending',
      to: 'cancelled',
      occurredAt: '2026-01-01T00:00:00.000Z',
    });

    const resolveProvider = vi.fn(() => createProvider([]));
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider,
    });

    const result = await executor.executeNextRunnableNode({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(result).toEqual({
      outcome: 'run_terminal',
      workflowRunId: runId,
      runStatus: 'cancelled',
    });
    expect(resolveProvider).not.toHaveBeenCalled();
  });

  it('returns no_runnable and completes a running workflow when all latest attempts are terminal', async () => {
    const { db, runId, runNodeId } = seedSingleAgentRun();
    transitionWorkflowRunStatus(db, {
      workflowRunId: runId,
      expectedFrom: 'pending',
      to: 'running',
      occurredAt: '2026-01-01T00:00:00.000Z',
    });
    transitionRunNodeStatus(db, {
      runNodeId,
      expectedFrom: 'pending',
      to: 'running',
      occurredAt: '2026-01-01T00:01:00.000Z',
    });
    transitionRunNodeStatus(db, {
      runNodeId,
      expectedFrom: 'running',
      to: 'completed',
      occurredAt: '2026-01-01T00:02:00.000Z',
    });

    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () => createProvider([]),
    });

    const result = await executor.executeNextRunnableNode({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(result).toEqual({
      outcome: 'no_runnable',
      workflowRunId: runId,
      runStatus: 'completed',
    });
  });

  it('revisits a completed node when selected upstream evidence is newer', async () => {
    const { db, runId, sourceRunNodeId, targetRunNodeId } = seedLinearAutoRun();
    transitionWorkflowRunStatus(db, {
      workflowRunId: runId,
      expectedFrom: 'pending',
      to: 'running',
      occurredAt: '2026-01-01T00:00:00.000Z',
    });
    transitionRunNodeStatus(db, {
      runNodeId: sourceRunNodeId,
      expectedFrom: 'pending',
      to: 'running',
      occurredAt: '2026-01-01T00:01:00.000Z',
    });
    transitionRunNodeStatus(db, {
      runNodeId: sourceRunNodeId,
      expectedFrom: 'running',
      to: 'completed',
      occurredAt: '2026-01-01T00:02:00.000Z',
    });
    transitionRunNodeStatus(db, {
      runNodeId: targetRunNodeId,
      expectedFrom: 'pending',
      to: 'running',
      occurredAt: '2026-01-01T00:03:00.000Z',
    });
    transitionRunNodeStatus(db, {
      runNodeId: targetRunNodeId,
      expectedFrom: 'running',
      to: 'completed',
      occurredAt: '2026-01-01T00:04:00.000Z',
    });

    db.insert(phaseArtifacts)
      .values([
        {
          workflowRunId: runId,
          runNodeId: sourceRunNodeId,
          artifactType: 'report',
          contentType: 'markdown',
          content: 'source-v1',
          metadata: expect.objectContaining({ success: true }),
        },
        {
          workflowRunId: runId,
          runNodeId: targetRunNodeId,
          artifactType: 'report',
          contentType: 'markdown',
          content: 'target-v1',
          metadata: expect.objectContaining({ success: true }),
        },
        {
          workflowRunId: runId,
          runNodeId: sourceRunNodeId,
          artifactType: 'report',
          contentType: 'markdown',
          content: 'source-v2',
          metadata: expect.objectContaining({ success: true }),
        },
      ])
      .run();

    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () =>
        createProvider([
          { type: 'result', content: 'target refreshed from newer source evidence', timestamp: 10 },
        ]),
    });

    const result = await executor.executeNextRunnableNode({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(result).toEqual({
      outcome: 'executed',
      workflowRunId: runId,
      runNodeId: targetRunNodeId,
      nodeKey: 'target',
      runNodeStatus: 'completed',
      runStatus: 'completed',
      artifactId: expect.any(Number),
    });

    const targetNode = db
      .select({
        status: runNodes.status,
        attempt: runNodes.attempt,
      })
      .from(runNodes)
      .where(eq(runNodes.id, targetRunNodeId))
      .get();

    expect(targetNode).toEqual({
      status: 'completed',
      attempt: 2,
    });
  });

  it('returns blocked when a revisited completed-node claim loses a post-requeue race', async () => {
    const { db, runId, sourceRunNodeId, targetRunNodeId } = seedLinearAutoRun();
    transitionWorkflowRunStatus(db, {
      workflowRunId: runId,
      expectedFrom: 'pending',
      to: 'running',
      occurredAt: '2026-01-01T00:00:00.000Z',
    });
    transitionRunNodeStatus(db, {
      runNodeId: sourceRunNodeId,
      expectedFrom: 'pending',
      to: 'running',
      occurredAt: '2026-01-01T00:01:00.000Z',
    });
    transitionRunNodeStatus(db, {
      runNodeId: sourceRunNodeId,
      expectedFrom: 'running',
      to: 'completed',
      occurredAt: '2026-01-01T00:02:00.000Z',
    });
    transitionRunNodeStatus(db, {
      runNodeId: targetRunNodeId,
      expectedFrom: 'pending',
      to: 'running',
      occurredAt: '2026-01-01T00:03:00.000Z',
    });
    transitionRunNodeStatus(db, {
      runNodeId: targetRunNodeId,
      expectedFrom: 'running',
      to: 'completed',
      occurredAt: '2026-01-01T00:04:00.000Z',
    });

    db.insert(phaseArtifacts)
      .values([
        {
          workflowRunId: runId,
          runNodeId: sourceRunNodeId,
          artifactType: 'report',
          contentType: 'markdown',
          content: 'source-v1',
          metadata: expect.objectContaining({ success: true }),
        },
        {
          workflowRunId: runId,
          runNodeId: targetRunNodeId,
          artifactType: 'report',
          contentType: 'markdown',
          content: 'target-v1',
          metadata: expect.objectContaining({ success: true }),
        },
        {
          workflowRunId: runId,
          runNodeId: sourceRunNodeId,
          artifactType: 'report',
          contentType: 'markdown',
          content: 'source-v2',
          metadata: expect.objectContaining({ success: true }),
        },
      ])
      .run();

    db.run(sql`DROP TRIGGER IF EXISTS run_nodes_test_revisit_claim_race`);
    db.run(
      sql.raw(`CREATE TRIGGER run_nodes_test_revisit_claim_race
      AFTER UPDATE OF status ON run_nodes
      FOR EACH ROW
      WHEN OLD.id = ${targetRunNodeId}
        AND OLD.status = 'completed'
        AND NEW.status = 'pending'
      BEGIN
        UPDATE run_nodes
        SET status = 'running',
            started_at = '2026-01-01T00:05:30.000Z',
            completed_at = NULL,
            updated_at = '2026-01-01T00:05:30.000Z'
        WHERE id = OLD.id;
      END`),
    );

    const resolveProvider = vi.fn(() => createProvider([]));
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider,
    });

    const result = await executor.executeNextRunnableNode({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(result).toEqual({
      outcome: 'blocked',
      workflowRunId: runId,
      runStatus: 'running',
    });
    expect(resolveProvider).not.toHaveBeenCalled();

    const targetNode = db
      .select({
        status: runNodes.status,
        attempt: runNodes.attempt,
      })
      .from(runNodes)
      .where(eq(runNodes.id, targetRunNodeId))
      .get();

    expect(targetNode).toEqual({
      status: 'running',
      attempt: 2,
    });
  });

  it('ignores a stale approved decision even when it shares a timestamp with refreshed review output', async () => {
    const {
      db,
      runId,
      sourceRunNodeId,
      reviewRunNodeId,
      approvedRunNodeId,
      fallbackRunNodeId,
    } = seedMixedRoutingRevisitRun();

    if (!sourceRunNodeId || !reviewRunNodeId || !approvedRunNodeId || !fallbackRunNodeId) {
      throw new Error('Expected mixed routing run-nodes to be materialized.');
    }

    transitionWorkflowRunStatus(db, {
      workflowRunId: runId,
      expectedFrom: 'pending',
      to: 'running',
      occurredAt: '2026-01-01T00:00:00.000Z',
    });
    transitionRunNodeStatus(db, {
      runNodeId: sourceRunNodeId,
      expectedFrom: 'pending',
      to: 'running',
      occurredAt: '2026-01-01T00:01:00.000Z',
    });
    transitionRunNodeStatus(db, {
      runNodeId: sourceRunNodeId,
      expectedFrom: 'running',
      to: 'completed',
      occurredAt: '2026-01-01T00:02:00.000Z',
    });
    transitionRunNodeStatus(db, {
      runNodeId: reviewRunNodeId,
      expectedFrom: 'pending',
      to: 'running',
      occurredAt: '2026-01-01T00:03:00.000Z',
    });
    transitionRunNodeStatus(db, {
      runNodeId: reviewRunNodeId,
      expectedFrom: 'running',
      to: 'completed',
      occurredAt: '2026-01-01T00:04:00.000Z',
    });
    transitionRunNodeStatus(db, {
      runNodeId: approvedRunNodeId,
      expectedFrom: 'pending',
      to: 'running',
      occurredAt: '2026-01-01T00:05:00.000Z',
    });
    transitionRunNodeStatus(db, {
      runNodeId: approvedRunNodeId,
      expectedFrom: 'running',
      to: 'completed',
      occurredAt: '2026-01-01T00:06:00.000Z',
    });
    transitionRunNodeStatus(db, {
      runNodeId: fallbackRunNodeId,
      expectedFrom: 'pending',
      to: 'skipped',
      occurredAt: '2026-01-01T00:07:00.000Z',
    });

    db.insert(phaseArtifacts)
      .values([
        {
          workflowRunId: runId,
          runNodeId: sourceRunNodeId,
          artifactType: 'report',
          contentType: 'markdown',
          content: 'source-v1',
          metadata: expect.objectContaining({ success: true }),
        },
        {
          workflowRunId: runId,
          runNodeId: reviewRunNodeId,
          artifactType: 'report',
          contentType: 'markdown',
          content: 'review-v1',
          metadata: expect.objectContaining({ success: true }),
        },
        {
          workflowRunId: runId,
          runNodeId: approvedRunNodeId,
          artifactType: 'report',
          contentType: 'markdown',
          content: 'approved-v1',
          metadata: expect.objectContaining({ success: true }),
        },
      ])
      .run();

    db.insert(routingDecisions)
      .values({
        workflowRunId: runId,
        runNodeId: reviewRunNodeId,
        decisionType: 'approved',
        rawOutput: {
          source: 'phase_result',
          decision: 'approved',
          attempt: 1,
        },
      })
      .run();

    const tiedTimestamp = '2026-01-01T00:08:00.000Z';
    db
      .update(routingDecisions)
      .set({
        createdAt: tiedTimestamp,
      })
      .where(eq(routingDecisions.runNodeId, reviewRunNodeId))
      .run();

    db.insert(phaseArtifacts)
      .values({
        workflowRunId: runId,
        runNodeId: sourceRunNodeId,
        artifactType: 'report',
        contentType: 'markdown',
        content: 'source-v2',
        metadata: expect.objectContaining({ success: true }),
      })
      .run();

    db.run(sql`DROP TRIGGER IF EXISTS phase_artifacts_test_review_refresh_tied_timestamp`);
    db.run(
      sql.raw(`CREATE TRIGGER phase_artifacts_test_review_refresh_tied_timestamp
      AFTER INSERT ON phase_artifacts
      FOR EACH ROW
      WHEN NEW.workflow_run_id = ${runId}
        AND NEW.run_node_id = ${reviewRunNodeId}
      BEGIN
        UPDATE phase_artifacts
        SET created_at = '${tiedTimestamp}'
        WHERE id = NEW.id;
      END`),
    );

    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () =>
        createProvider([
          { type: 'result', content: 'review refreshed without explicit decision', timestamp: 10 },
        ]),
    });

    const revisitResult = await executor.executeNextRunnableNode({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(revisitResult).toEqual({
      outcome: 'executed',
      workflowRunId: runId,
      runNodeId: reviewRunNodeId,
      nodeKey: 'review',
      runNodeStatus: 'completed',
      runStatus: 'running',
      artifactId: expect.any(Number),
    });

    const fallbackNode = db
      .select({
        status: runNodes.status,
      })
      .from(runNodes)
      .where(eq(runNodes.id, fallbackRunNodeId))
      .get();

    expect(fallbackNode).toEqual({
      status: 'pending',
    });

    const fallbackResult = await executor.executeNextRunnableNode({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(fallbackResult).toEqual({
      outcome: 'executed',
      workflowRunId: runId,
      runNodeId: fallbackRunNodeId,
      nodeKey: 'fallback_target',
      runNodeStatus: 'completed',
      runStatus: 'completed',
      artifactId: expect.any(Number),
    });
  });

  it('keeps the run active when skipped-target reactivation loses a claim race', async () => {
    const {
      db,
      runId,
      sourceRunNodeId,
      reviewRunNodeId,
      approvedRunNodeId,
      fallbackRunNodeId,
    } = seedMixedRoutingRevisitRun();

    if (!sourceRunNodeId || !reviewRunNodeId || !approvedRunNodeId || !fallbackRunNodeId) {
      throw new Error('Expected mixed routing run-nodes to be materialized.');
    }

    transitionWorkflowRunStatus(db, {
      workflowRunId: runId,
      expectedFrom: 'pending',
      to: 'running',
      occurredAt: '2026-01-01T00:00:00.000Z',
    });
    transitionRunNodeStatus(db, {
      runNodeId: sourceRunNodeId,
      expectedFrom: 'pending',
      to: 'running',
      occurredAt: '2026-01-01T00:01:00.000Z',
    });
    transitionRunNodeStatus(db, {
      runNodeId: sourceRunNodeId,
      expectedFrom: 'running',
      to: 'completed',
      occurredAt: '2026-01-01T00:02:00.000Z',
    });
    transitionRunNodeStatus(db, {
      runNodeId: reviewRunNodeId,
      expectedFrom: 'pending',
      to: 'running',
      occurredAt: '2026-01-01T00:03:00.000Z',
    });
    transitionRunNodeStatus(db, {
      runNodeId: reviewRunNodeId,
      expectedFrom: 'running',
      to: 'completed',
      occurredAt: '2026-01-01T00:04:00.000Z',
    });
    transitionRunNodeStatus(db, {
      runNodeId: approvedRunNodeId,
      expectedFrom: 'pending',
      to: 'running',
      occurredAt: '2026-01-01T00:05:00.000Z',
    });
    transitionRunNodeStatus(db, {
      runNodeId: approvedRunNodeId,
      expectedFrom: 'running',
      to: 'completed',
      occurredAt: '2026-01-01T00:06:00.000Z',
    });
    transitionRunNodeStatus(db, {
      runNodeId: fallbackRunNodeId,
      expectedFrom: 'pending',
      to: 'skipped',
      occurredAt: '2026-01-01T00:07:00.000Z',
    });

    db.insert(phaseArtifacts)
      .values([
        {
          workflowRunId: runId,
          runNodeId: sourceRunNodeId,
          artifactType: 'report',
          contentType: 'markdown',
          content: 'source-v1',
          metadata: expect.objectContaining({ success: true }),
        },
        {
          workflowRunId: runId,
          runNodeId: reviewRunNodeId,
          artifactType: 'report',
          contentType: 'markdown',
          content: 'review-v1',
          metadata: expect.objectContaining({ success: true }),
        },
        {
          workflowRunId: runId,
          runNodeId: approvedRunNodeId,
          artifactType: 'report',
          contentType: 'markdown',
          content: 'approved-v1',
          metadata: expect.objectContaining({ success: true }),
        },
      ])
      .run();

    const seededReviewDecision = db
      .insert(routingDecisions)
      .values({
        workflowRunId: runId,
        runNodeId: reviewRunNodeId,
        decisionType: 'approved',
      })
      .returning({ id: routingDecisions.id })
      .get();

    const seededDecisionRow = db
      .select({
        rawOutput: routingDecisions.rawOutput,
      })
      .from(routingDecisions)
      .where(eq(routingDecisions.id, seededReviewDecision.id))
      .get();

    expect(seededDecisionRow).toEqual({
      rawOutput: null,
    });

    db.insert(phaseArtifacts)
      .values({
        workflowRunId: runId,
        runNodeId: sourceRunNodeId,
        artifactType: 'report',
        contentType: 'markdown',
        content: 'source-v2',
        metadata: expect.objectContaining({ success: true }),
      })
      .run();

    db.run(sql`DROP TRIGGER IF EXISTS run_nodes_test_skipped_reactivation_claim_race`);
    db.run(
      sql.raw(`CREATE TRIGGER run_nodes_test_skipped_reactivation_claim_race
      AFTER UPDATE OF status ON run_nodes
      FOR EACH ROW
      WHEN OLD.id = ${fallbackRunNodeId}
        AND OLD.status = 'skipped'
        AND NEW.status = 'pending'
      BEGIN
        UPDATE run_nodes
        SET status = 'running',
            started_at = '2026-01-01T00:08:30.000Z',
            completed_at = NULL,
            updated_at = '2026-01-01T00:08:30.000Z'
        WHERE id = OLD.id;
      END`),
    );

    const resolveProvider = vi.fn(() =>
      createProvider([
        { type: 'result', content: 'review refreshed without explicit decision', timestamp: 10 },
      ]),
    );
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider,
    });

    const revisitResult = await executor.executeNextRunnableNode({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(revisitResult).toEqual({
      outcome: 'executed',
      workflowRunId: runId,
      runNodeId: reviewRunNodeId,
      nodeKey: 'review',
      runNodeStatus: 'completed',
      runStatus: 'running',
      artifactId: expect.any(Number),
    });

    const fallbackNode = db
      .select({
        status: runNodes.status,
        attempt: runNodes.attempt,
      })
      .from(runNodes)
      .where(eq(runNodes.id, fallbackRunNodeId))
      .get();

    expect(fallbackNode).toEqual({
      status: 'running',
      attempt: 1,
    });

    const blockedResult = await executor.executeNextRunnableNode({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(blockedResult).toEqual({
      outcome: 'blocked',
      workflowRunId: runId,
      runStatus: 'running',
    });
    expect(resolveProvider).toHaveBeenCalledTimes(1);
  });

  it('ignores stale routing decisions after revisiting a node without a new decision signal', async () => {
    const {
      db,
      runId,
      sourceRunNodeId,
      reviewRunNodeId,
      approvedRunNodeId,
      fallbackRunNodeId,
    } = seedMixedRoutingRevisitRun();

    if (!sourceRunNodeId || !reviewRunNodeId || !approvedRunNodeId || !fallbackRunNodeId) {
      throw new Error('Expected mixed routing run-nodes to be materialized.');
    }

    transitionWorkflowRunStatus(db, {
      workflowRunId: runId,
      expectedFrom: 'pending',
      to: 'running',
      occurredAt: '2026-01-01T00:00:00.000Z',
    });
    transitionRunNodeStatus(db, {
      runNodeId: sourceRunNodeId,
      expectedFrom: 'pending',
      to: 'running',
      occurredAt: '2026-01-01T00:01:00.000Z',
    });
    transitionRunNodeStatus(db, {
      runNodeId: sourceRunNodeId,
      expectedFrom: 'running',
      to: 'completed',
      occurredAt: '2026-01-01T00:02:00.000Z',
    });
    transitionRunNodeStatus(db, {
      runNodeId: reviewRunNodeId,
      expectedFrom: 'pending',
      to: 'running',
      occurredAt: '2026-01-01T00:03:00.000Z',
    });
    transitionRunNodeStatus(db, {
      runNodeId: reviewRunNodeId,
      expectedFrom: 'running',
      to: 'completed',
      occurredAt: '2026-01-01T00:04:00.000Z',
    });
    transitionRunNodeStatus(db, {
      runNodeId: approvedRunNodeId,
      expectedFrom: 'pending',
      to: 'running',
      occurredAt: '2026-01-01T00:05:00.000Z',
    });
    transitionRunNodeStatus(db, {
      runNodeId: approvedRunNodeId,
      expectedFrom: 'running',
      to: 'completed',
      occurredAt: '2026-01-01T00:06:00.000Z',
    });
    transitionRunNodeStatus(db, {
      runNodeId: fallbackRunNodeId,
      expectedFrom: 'pending',
      to: 'skipped',
      occurredAt: '2026-01-01T00:07:00.000Z',
    });

    db.insert(phaseArtifacts)
      .values([
        {
          workflowRunId: runId,
          runNodeId: sourceRunNodeId,
          artifactType: 'report',
          contentType: 'markdown',
          content: 'source-v1',
          metadata: expect.objectContaining({ success: true }),
        },
        {
          workflowRunId: runId,
          runNodeId: reviewRunNodeId,
          artifactType: 'report',
          contentType: 'markdown',
          content: 'review-v1',
          metadata: expect.objectContaining({ success: true }),
        },
        {
          workflowRunId: runId,
          runNodeId: approvedRunNodeId,
          artifactType: 'report',
          contentType: 'markdown',
          content: 'approved-v1',
          metadata: expect.objectContaining({ success: true }),
        },
      ])
      .run();

    db.insert(routingDecisions)
      .values({
        workflowRunId: runId,
        runNodeId: reviewRunNodeId,
        decisionType: 'approved',
      })
      .run();

    db.insert(phaseArtifacts)
      .values({
        workflowRunId: runId,
        runNodeId: sourceRunNodeId,
        artifactType: 'report',
        contentType: 'markdown',
        content: 'source-v2',
        metadata: expect.objectContaining({ success: true }),
      })
      .run();

    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () =>
        createProvider([
          { type: 'result', content: 'review refreshed without explicit decision', timestamp: 10 },
        ]),
    });

    const revisitResult = await executor.executeNextRunnableNode({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(revisitResult).toEqual({
      outcome: 'executed',
      workflowRunId: runId,
      runNodeId: reviewRunNodeId,
      nodeKey: 'review',
      runNodeStatus: 'completed',
      runStatus: 'running',
      artifactId: expect.any(Number),
    });

    const fallbackNode = db
      .select({
        status: runNodes.status,
      })
      .from(runNodes)
      .where(eq(runNodes.id, fallbackRunNodeId))
      .get();

    expect(fallbackNode).toEqual({
      status: 'pending',
    });

    const persistedReviewDecisions = db
      .select({
        decisionType: routingDecisions.decisionType,
        rawOutput: routingDecisions.rawOutput,
      })
      .from(routingDecisions)
      .where(eq(routingDecisions.runNodeId, reviewRunNodeId))
      .orderBy(asc(routingDecisions.id))
      .all();

    expect(persistedReviewDecisions).toEqual([
      {
        decisionType: 'approved',
        rawOutput: null,
      },
    ]);

    const fallbackResult = await executor.executeNextRunnableNode({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(fallbackResult).toEqual({
      outcome: 'executed',
      workflowRunId: runId,
      runNodeId: fallbackRunNodeId,
      nodeKey: 'fallback_target',
      runNodeStatus: 'completed',
      runStatus: 'completed',
      artifactId: expect.any(Number),
    });
  });

  it('ignores stale routing decisions without attempt metadata when refreshed decision timestamps tie', async () => {
    const {
      db,
      runId,
      sourceRunNodeId,
      reviewRunNodeId,
      approvedRunNodeId,
      fallbackRunNodeId,
    } = seedMixedRoutingRevisitRun();

    if (!sourceRunNodeId || !reviewRunNodeId || !approvedRunNodeId || !fallbackRunNodeId) {
      throw new Error('Expected mixed routing run-nodes to be materialized.');
    }

    transitionWorkflowRunStatus(db, {
      workflowRunId: runId,
      expectedFrom: 'pending',
      to: 'running',
      occurredAt: '2026-01-01T00:00:00.000Z',
    });
    transitionRunNodeStatus(db, {
      runNodeId: sourceRunNodeId,
      expectedFrom: 'pending',
      to: 'running',
      occurredAt: '2026-01-01T00:01:00.000Z',
    });
    transitionRunNodeStatus(db, {
      runNodeId: sourceRunNodeId,
      expectedFrom: 'running',
      to: 'completed',
      occurredAt: '2026-01-01T00:02:00.000Z',
    });
    transitionRunNodeStatus(db, {
      runNodeId: reviewRunNodeId,
      expectedFrom: 'pending',
      to: 'running',
      occurredAt: '2026-01-01T00:03:00.000Z',
    });
    transitionRunNodeStatus(db, {
      runNodeId: reviewRunNodeId,
      expectedFrom: 'running',
      to: 'completed',
      occurredAt: '2026-01-01T00:04:00.000Z',
    });
    transitionRunNodeStatus(db, {
      runNodeId: approvedRunNodeId,
      expectedFrom: 'pending',
      to: 'running',
      occurredAt: '2026-01-01T00:05:00.000Z',
    });
    transitionRunNodeStatus(db, {
      runNodeId: approvedRunNodeId,
      expectedFrom: 'running',
      to: 'completed',
      occurredAt: '2026-01-01T00:06:00.000Z',
    });
    transitionRunNodeStatus(db, {
      runNodeId: fallbackRunNodeId,
      expectedFrom: 'pending',
      to: 'skipped',
      occurredAt: '2026-01-01T00:07:00.000Z',
    });

    db.insert(phaseArtifacts)
      .values([
        {
          workflowRunId: runId,
          runNodeId: sourceRunNodeId,
          artifactType: 'report',
          contentType: 'markdown',
          content: 'source-v1',
          metadata: expect.objectContaining({ success: true }),
        },
        {
          workflowRunId: runId,
          runNodeId: reviewRunNodeId,
          artifactType: 'report',
          contentType: 'markdown',
          content: 'review-v1',
          metadata: expect.objectContaining({ success: true }),
        },
        {
          workflowRunId: runId,
          runNodeId: approvedRunNodeId,
          artifactType: 'report',
          contentType: 'markdown',
          content: 'approved-v1',
          metadata: expect.objectContaining({ success: true }),
        },
      ])
      .run();

    db.insert(routingDecisions)
      .values({
        workflowRunId: runId,
        runNodeId: reviewRunNodeId,
        decisionType: 'approved',
      })
      .run();

    const tiedTimestamp = '2026-01-01T00:08:00.000Z';
    db
      .update(routingDecisions)
      .set({
        createdAt: tiedTimestamp,
      })
      .where(eq(routingDecisions.runNodeId, reviewRunNodeId))
      .run();

    db.insert(phaseArtifacts)
      .values({
        workflowRunId: runId,
        runNodeId: sourceRunNodeId,
        artifactType: 'report',
        contentType: 'markdown',
        content: 'source-v2',
        metadata: expect.objectContaining({ success: true }),
      })
      .run();

    db.run(sql`DROP TRIGGER IF EXISTS phase_artifacts_test_review_refresh_tied_timestamp`);
    db.run(
      sql.raw(`CREATE TRIGGER phase_artifacts_test_review_refresh_tied_timestamp
      AFTER INSERT ON phase_artifacts
      FOR EACH ROW
      WHEN NEW.workflow_run_id = ${runId}
        AND NEW.run_node_id = ${reviewRunNodeId}
      BEGIN
        UPDATE phase_artifacts
        SET created_at = '${tiedTimestamp}'
        WHERE id = NEW.id;
      END`),
    );

    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () =>
        createProvider([
          { type: 'result', content: 'review refreshed without explicit decision', timestamp: 10 },
        ]),
    });

    const revisitResult = await executor.executeNextRunnableNode({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(revisitResult).toEqual({
      outcome: 'executed',
      workflowRunId: runId,
      runNodeId: reviewRunNodeId,
      nodeKey: 'review',
      runNodeStatus: 'completed',
      runStatus: 'running',
      artifactId: expect.any(Number),
    });

    const fallbackNode = db
      .select({
        status: runNodes.status,
      })
      .from(runNodes)
      .where(eq(runNodes.id, fallbackRunNodeId))
      .get();

    expect(fallbackNode).toEqual({
      status: 'pending',
    });

    const fallbackResult = await executor.executeNextRunnableNode({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(fallbackResult).toEqual({
      outcome: 'executed',
      workflowRunId: runId,
      runNodeId: fallbackRunNodeId,
      nodeKey: 'fallback_target',
      runNodeStatus: 'completed',
      runStatus: 'completed',
      artifactId: expect.any(Number),
    });
  });

  it('fails the run safely when post-completion target reactivation errors', async () => {
    const {
      db,
      runId,
      sourceRunNodeId,
      reviewRunNodeId,
      approvedRunNodeId,
      fallbackRunNodeId,
    } = seedMixedRoutingRevisitRun();

    if (!sourceRunNodeId || !reviewRunNodeId || !approvedRunNodeId || !fallbackRunNodeId) {
      throw new Error('Expected mixed routing run-nodes to be materialized.');
    }

    transitionWorkflowRunStatus(db, {
      workflowRunId: runId,
      expectedFrom: 'pending',
      to: 'running',
      occurredAt: '2026-01-01T00:00:00.000Z',
    });
    transitionRunNodeStatus(db, {
      runNodeId: sourceRunNodeId,
      expectedFrom: 'pending',
      to: 'running',
      occurredAt: '2026-01-01T00:01:00.000Z',
    });
    transitionRunNodeStatus(db, {
      runNodeId: sourceRunNodeId,
      expectedFrom: 'running',
      to: 'completed',
      occurredAt: '2026-01-01T00:02:00.000Z',
    });
    transitionRunNodeStatus(db, {
      runNodeId: reviewRunNodeId,
      expectedFrom: 'pending',
      to: 'running',
      occurredAt: '2026-01-01T00:03:00.000Z',
    });
    transitionRunNodeStatus(db, {
      runNodeId: reviewRunNodeId,
      expectedFrom: 'running',
      to: 'completed',
      occurredAt: '2026-01-01T00:04:00.000Z',
    });
    transitionRunNodeStatus(db, {
      runNodeId: approvedRunNodeId,
      expectedFrom: 'pending',
      to: 'running',
      occurredAt: '2026-01-01T00:05:00.000Z',
    });
    transitionRunNodeStatus(db, {
      runNodeId: approvedRunNodeId,
      expectedFrom: 'running',
      to: 'completed',
      occurredAt: '2026-01-01T00:06:00.000Z',
    });
    transitionRunNodeStatus(db, {
      runNodeId: fallbackRunNodeId,
      expectedFrom: 'pending',
      to: 'skipped',
      occurredAt: '2026-01-01T00:07:00.000Z',
    });

    db.insert(phaseArtifacts)
      .values([
        {
          workflowRunId: runId,
          runNodeId: sourceRunNodeId,
          artifactType: 'report',
          contentType: 'markdown',
          content: 'source-v1',
          metadata: expect.objectContaining({ success: true }),
        },
        {
          workflowRunId: runId,
          runNodeId: reviewRunNodeId,
          artifactType: 'report',
          contentType: 'markdown',
          content: 'review-v1',
          metadata: expect.objectContaining({ success: true }),
        },
        {
          workflowRunId: runId,
          runNodeId: approvedRunNodeId,
          artifactType: 'report',
          contentType: 'markdown',
          content: 'approved-v1',
          metadata: expect.objectContaining({ success: true }),
        },
        {
          workflowRunId: runId,
          runNodeId: sourceRunNodeId,
          artifactType: 'report',
          contentType: 'markdown',
          content: 'source-v2',
          metadata: expect.objectContaining({ success: true }),
        },
      ])
      .run();

    db.run(sql`DROP TRIGGER IF EXISTS run_nodes_test_post_completion_reactivation_error`);
    db.run(
      sql.raw(`CREATE TRIGGER run_nodes_test_post_completion_reactivation_error
      BEFORE UPDATE OF status ON run_nodes
      FOR EACH ROW
      WHEN OLD.id = ${approvedRunNodeId}
        AND OLD.status = 'completed'
        AND NEW.status = 'pending'
      BEGIN
        SELECT RAISE(IGNORE);
      END`),
    );

    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () =>
        createProvider([
          {
            type: 'result',
            content: 'decision: approved\nRe-approve after source refresh.',
            timestamp: 10,
            metadata: { routingDecision: 'approved' },
          },
        ]),
    });

    const result = await executor.executeNextRunnableNode({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(result).toEqual({
      outcome: 'executed',
      workflowRunId: runId,
      runNodeId: reviewRunNodeId,
      nodeKey: 'review',
      runNodeStatus: 'completed',
      runStatus: 'failed',
      artifactId: expect.any(Number),
    });

    const persistedRun = db
      .select({
        status: workflowRuns.status,
      })
      .from(workflowRuns)
      .where(eq(workflowRuns.id, runId))
      .get();

    expect(persistedRun).toEqual({
      status: 'failed',
    });

    const failureArtifacts = db
      .select({
        artifactType: phaseArtifacts.artifactType,
        metadata: phaseArtifacts.metadata,
      })
      .from(phaseArtifacts)
      .where(and(eq(phaseArtifacts.workflowRunId, runId), eq(phaseArtifacts.runNodeId, reviewRunNodeId)))
      .orderBy(asc(phaseArtifacts.id))
      .all()
      .filter(artifact => artifact.artifactType === 'log');

    expect(failureArtifacts).toHaveLength(1);
    expect(failureArtifacts[0]).toEqual({
      artifactType: 'log',
      metadata: expect.objectContaining({
        failureReason: 'post_completion_failure',
        nodeStatusAtFailure: 'completed',
      }),
    });
  });

  it('returns blocked and fails the run when failures exist but pending nodes are not runnable', async () => {
    const { db, runId, sourceRunNodeId } = seedLinearAutoRun();
    transitionRunNodeStatus(db, {
      runNodeId: sourceRunNodeId,
      expectedFrom: 'pending',
      to: 'running',
      occurredAt: '2026-01-01T00:00:00.000Z',
    });
    transitionRunNodeStatus(db, {
      runNodeId: sourceRunNodeId,
      expectedFrom: 'running',
      to: 'failed',
      occurredAt: '2026-01-01T00:01:00.000Z',
    });

    const resolveProvider = vi.fn(() => createProvider([]));
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider,
    });

    const result = await executor.executeNextRunnableNode({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(result).toEqual({
      outcome: 'blocked',
      workflowRunId: runId,
      runStatus: 'failed',
    });
    expect(resolveProvider).not.toHaveBeenCalled();
  });

  it('supports converging auto edges when selecting the next runnable node', async () => {
    const { db, runId, sourceARunNodeId, sourceBRunNodeId, targetRunNodeId } = seedConvergingAutoRun();
    transitionRunNodeStatus(db, {
      runNodeId: sourceARunNodeId,
      expectedFrom: 'pending',
      to: 'running',
      occurredAt: '2026-01-01T00:00:00.000Z',
    });
    transitionRunNodeStatus(db, {
      runNodeId: sourceARunNodeId,
      expectedFrom: 'running',
      to: 'completed',
      occurredAt: '2026-01-01T00:01:00.000Z',
    });
    transitionRunNodeStatus(db, {
      runNodeId: sourceBRunNodeId,
      expectedFrom: 'pending',
      to: 'running',
      occurredAt: '2026-01-01T00:02:00.000Z',
    });
    transitionRunNodeStatus(db, {
      runNodeId: sourceBRunNodeId,
      expectedFrom: 'running',
      to: 'completed',
      occurredAt: '2026-01-01T00:03:00.000Z',
    });

    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () =>
        createProvider([
          { type: 'result', content: 'Merged output', timestamp: 10 },
        ]),
    });

    const result = await executor.executeNextRunnableNode({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(result).toEqual({
      outcome: 'executed',
      workflowRunId: runId,
      runNodeId: targetRunNodeId,
      nodeKey: 'target',
      runNodeStatus: 'completed',
      runStatus: 'completed',
      artifactId: expect.any(Number),
    });
  });

  it('merges node execution permissions into provider run options', async () => {
    const { db, runId, runNodeId } = seedSingleAgentRun();
    db.update(runNodes)
      .set({
        executionPermissions: {
          approvalPolicy: 'on-request',
          sandboxMode: 'workspace-write',
          additionalDirectories: ['/tmp/extra-tools'],
          webSearchMode: 'cached',
        },
      })
      .where(eq(runNodes.id, runNodeId))
      .run();

    let capturedOptions: ProviderRunOptions | undefined;
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () => ({
        async *run(_prompt: string, options: ProviderRunOptions): AsyncIterable<ProviderEvent> {
          capturedOptions = options;
          yield { type: 'result', content: 'ok', timestamp: 1 };
        },
      }),
    });

    await executor.executeNextRunnableNode({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
        executionPermissions: {
          approvalPolicy: 'never',
          networkAccessEnabled: false,
        },
      },
    });

    expect(capturedOptions?.executionPermissions).toEqual({
      approvalPolicy: 'on-request',
      sandboxMode: 'workspace-write',
      networkAccessEnabled: false,
      additionalDirectories: ['/tmp/extra-tools'],
      webSearchMode: 'cached',
    });
  });

  it('prefers node-level network access execution permissions over run options', async () => {
    const { db, runId, runNodeId } = seedSingleAgentRun();
    db.update(runNodes)
      .set({
        executionPermissions: {
          networkAccessEnabled: true,
        },
      })
      .where(eq(runNodes.id, runNodeId))
      .run();

    let capturedOptions: ProviderRunOptions | undefined;
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () => ({
        async *run(_prompt: string, options: ProviderRunOptions): AsyncIterable<ProviderEvent> {
          capturedOptions = options;
          yield { type: 'result', content: 'ok', timestamp: 1 };
        },
      }),
    });

    await executor.executeNextRunnableNode({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
        executionPermissions: {
          networkAccessEnabled: false,
        },
      },
    });

    expect(capturedOptions?.executionPermissions).toEqual({
      networkAccessEnabled: true,
    });
  });

  it.each([
    {
      name: 'payload is not an object',
      payload: ['workspace-write'],
      message: 'Run node "design" has invalid execution permissions payload.',
    },
    {
      name: 'payload contains unsupported fields',
      payload: { unsupported: true },
      message: 'Run node "design" execution permissions include unsupported field "unsupported".',
    },
    {
      name: 'approvalPolicy is invalid',
      payload: { approvalPolicy: 'sometimes' },
      message: 'Run node "design" has invalid execution approval policy.',
    },
    {
      name: 'sandboxMode is invalid',
      payload: { sandboxMode: 'sometimes' },
      message: 'Run node "design" has invalid execution sandbox mode.',
    },
    {
      name: 'networkAccessEnabled is not boolean',
      payload: { networkAccessEnabled: 'true' },
      message: 'Run node "design" has invalid execution networkAccessEnabled value.',
    },
    {
      name: 'additionalDirectories is not an array',
      payload: { additionalDirectories: '/tmp/cache' },
      message: 'Run node "design" has invalid execution additionalDirectories value.',
    },
    {
      name: 'additionalDirectories contains empty paths',
      payload: { additionalDirectories: ['/tmp/cache', '   '] },
      message: 'Run node "design" has invalid execution additionalDirectories entry at index 1.',
    },
    {
      name: 'additionalDirectories is empty',
      payload: { additionalDirectories: [] },
      message: 'Run node "design" must provide at least one execution additional directory.',
    },
    {
      name: 'webSearchMode is invalid',
      payload: { webSearchMode: 'sometimes' },
      message: 'Run node "design" has invalid execution web search mode.',
    },
  ])('fails when node execution permissions are malformed: $name', async ({ payload, message }) => {
    const { db, runId, runNodeId } = seedSingleAgentRun();
    db.update(runNodes)
      .set({
        executionPermissions: payload as unknown as Record<string, unknown>,
      })
      .where(eq(runNodes.id, runNodeId))
      .run();

    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () =>
        createProvider([
          { type: 'result', content: 'ok', timestamp: 1 },
        ]),
    });

    const step = await executor.executeNextRunnableNode({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(step).toEqual({
      outcome: 'executed',
      workflowRunId: runId,
      runNodeId,
      nodeKey: 'design',
      runNodeStatus: 'failed',
      runStatus: 'failed',
      artifactId: expect.any(Number),
    });

    const artifacts = db
      .select({
        artifactType: phaseArtifacts.artifactType,
        content: phaseArtifacts.content,
      })
      .from(phaseArtifacts)
      .where(eq(phaseArtifacts.runNodeId, runNodeId))
      .all();

    expect(artifacts).toEqual(
      expect.arrayContaining([
        {
          artifactType: 'log',
          content: expect.stringContaining(message),
        },
      ]),
    );
  });

  it('fails gracefully when retry error-handler setup hits malformed execution permissions', async () => {
    const { db, runId, runNodeId } = seedSingleAgentRun('markdown', 1);
    db.update(runNodes)
      .set({
        executionPermissions: { unsupported: true } as unknown as Record<string, unknown>,
      })
      .where(eq(runNodes.id, runNodeId))
      .run();

    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () =>
        createProvider([
          { type: 'result', content: 'ok', timestamp: 1 },
        ]),
    });

    const result = await executor.executeRun({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(result).toEqual({
      workflowRunId: runId,
      executedNodes: 1,
      finalStep: {
        outcome: 'run_terminal',
        workflowRunId: runId,
        runStatus: 'failed',
      },
    });

    const persistedRunNode = db
      .select({
        status: runNodes.status,
        attempt: runNodes.attempt,
      })
      .from(runNodes)
      .where(eq(runNodes.id, runNodeId))
      .get();
    expect(persistedRunNode).toEqual({
      status: 'failed',
      attempt: 2,
    });

    const permissionsErrorMessage =
      'Run node "design" execution permissions include unsupported field "unsupported".';
    const artifacts = db
      .select({
        artifactType: phaseArtifacts.artifactType,
        content: phaseArtifacts.content,
        metadata: phaseArtifacts.metadata,
      })
      .from(phaseArtifacts)
      .where(eq(phaseArtifacts.runNodeId, runNodeId))
      .orderBy(asc(phaseArtifacts.id))
      .all();

    expect(artifacts).toHaveLength(2);
    expect(artifacts[0]?.artifactType).toBe('log');
    expect(artifacts[0]?.content).toContain(permissionsErrorMessage);
    expect(artifacts[0]?.metadata).toEqual(
      expect.objectContaining({
        failureReason: 'retry_scheduled',
        attempt: 1,
        maxRetries: 1,
      }),
    );
    expect(artifacts[1]?.artifactType).toBe('log');
    expect(artifacts[1]?.content).toContain(permissionsErrorMessage);
    expect(artifacts[1]?.metadata).toEqual(
      expect.objectContaining({
        failureReason: 'retry_limit_exceeded',
        attempt: 2,
        maxRetries: 1,
      }),
    );

    const firstAttemptDiagnostics = db
      .select({
        diagnostics: runNodeDiagnostics.diagnostics,
      })
      .from(runNodeDiagnostics)
      .where(and(eq(runNodeDiagnostics.runNodeId, runNodeId), eq(runNodeDiagnostics.attempt, 1)))
      .get();
    const diagnosticsPayload = firstAttemptDiagnostics?.diagnostics as {
      errorHandler?: Record<string, unknown>;
    } | null;
    expect(diagnosticsPayload?.errorHandler).toEqual(
      expect.objectContaining({
        attempted: true,
        status: 'failed',
        sourceAttempt: 1,
        targetAttempt: 2,
        errorMessage: permissionsErrorMessage,
      }),
    );
  });

  it('injects deterministic direct-predecessor report envelopes for linear downstream execution', async () => {
    const { db, runId } = seedBrainstormPickResearchRun();
    const capturedContexts: (string[] | undefined)[] = [];
    let invocation = 0;
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () => ({
        async *run(_prompt: string, options: ProviderRunOptions): AsyncIterable<ProviderEvent> {
          invocation += 1;
          capturedContexts.push(options.context);

          if (invocation === 1) {
            yield { type: 'result', content: 'Brainstorm output', timestamp: 10 };
            return;
          }

          if (invocation === 2) {
            yield { type: 'result', content: 'Pick output', timestamp: 20 };
            return;
          }

          yield { type: 'result', content: 'Research output', timestamp: 30 };
        },
      }),
    });

    const result = await executor.executeRun({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(result).toEqual({
      workflowRunId: runId,
      executedNodes: 3,
      finalStep: {
        outcome: 'run_terminal',
        workflowRunId: runId,
        runStatus: 'completed',
      },
    });

    expect(capturedContexts[0]).toBeUndefined();
    expect(capturedContexts[1]).toHaveLength(1);
    expect(capturedContexts[1]?.[0]).toContain('ALPHRED_UPSTREAM_ARTIFACT v1');
    expect(capturedContexts[1]?.[0]).toContain('target_node_key: pick');
    expect(capturedContexts[1]?.[0]).toContain('source_node_key: brainstorm');
    expect(capturedContexts[1]?.[0]).toContain('artifact_type: report');
    expect(capturedContexts[2]).toHaveLength(1);
    expect(capturedContexts[2]?.[0]).toContain('target_node_key: research');
    expect(capturedContexts[2]?.[0]).toContain('source_node_key: pick');
    expect(capturedContexts[2]?.[0]).not.toContain('source_node_key: brainstorm');

    const reportArtifacts = db
      .select({
        nodeKey: runNodes.nodeKey,
        metadata: phaseArtifacts.metadata,
      })
      .from(phaseArtifacts)
      .innerJoin(runNodes, eq(phaseArtifacts.runNodeId, runNodes.id))
      .where(and(eq(phaseArtifacts.workflowRunId, runId), eq(phaseArtifacts.artifactType, 'report')))
      .orderBy(asc(phaseArtifacts.id))
      .all();

    const contextByNodeKey = new Map(
      reportArtifacts.map((artifact) => [
        artifact.nodeKey,
        artifact.metadata as Record<string, unknown> | null,
      ]),
    );

    expect(contextByNodeKey.get('brainstorm')).toEqual(
      expect.objectContaining({
        context_policy_version: 1,
        included_count: 0,
        missing_upstream_artifacts: true,
      }),
    );
    expect(contextByNodeKey.get('pick')).toEqual(
      expect.objectContaining({
        context_policy_version: 1,
        included_count: 1,
        included_source_node_keys: ['brainstorm'],
      }),
    );
    expect(contextByNodeKey.get('research')).toEqual(
      expect.objectContaining({
        context_policy_version: 1,
        included_count: 1,
        included_source_node_keys: ['pick'],
      }),
    );
  });

  it('applies deterministic overflow bounds and truncation when converging upstream artifacts exceed limits', async () => {
    const { db, runId } = seedFiveSourceConvergingRun();
    const capturedContexts: (string[] | undefined)[] = [];
    const oversizedReport = 'X'.repeat(10_050);
    let invocation = 0;

    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () => ({
        async *run(_prompt: string, options: ProviderRunOptions): AsyncIterable<ProviderEvent> {
          invocation += 1;
          capturedContexts.push(options.context);

          if (invocation <= 5) {
            yield { type: 'result', content: oversizedReport, timestamp: invocation * 10 };
            return;
          }

          yield { type: 'result', content: 'Target output', timestamp: 60 };
        },
      }),
    });

    const result = await executor.executeRun({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(result).toEqual({
      workflowRunId: runId,
      executedNodes: 6,
      finalStep: {
        outcome: 'run_terminal',
        workflowRunId: runId,
        runStatus: 'completed',
      },
    });

    const targetContext = capturedContexts[5];
    expect(targetContext).toBeDefined();
    expect(targetContext).toHaveLength(4);
    expect(targetContext?.[0]).toContain('source_node_key: source_a');
    expect(targetContext?.[1]).toContain('source_node_key: source_b');
    expect(targetContext?.[2]).toContain('source_node_key: source_c');
    expect(targetContext?.[3]).toContain('source_node_key: source_d');
    expect(targetContext?.some(entry => entry.includes('applied: true'))).toBe(true);

    const targetArtifact = db
      .select({
        metadata: phaseArtifacts.metadata,
      })
      .from(phaseArtifacts)
      .innerJoin(runNodes, eq(phaseArtifacts.runNodeId, runNodes.id))
      .where(
        and(
          eq(phaseArtifacts.workflowRunId, runId),
          eq(runNodes.nodeKey, 'target'),
          eq(phaseArtifacts.artifactType, 'report'),
        ),
      )
      .orderBy(asc(phaseArtifacts.id))
      .get();

    const contextHandoff = targetArtifact?.metadata as Record<string, unknown> | null;
    expect(contextHandoff).toEqual(
      expect.objectContaining({
        context_policy_version: 1,
        included_count: 4,
        included_source_node_keys: ['source_a', 'source_b', 'source_c', 'source_d'],
        budget_overflow: true,
        missing_upstream_artifacts: false,
      }),
    );
    expect((contextHandoff?.included_chars_total as number) <= 32_000).toBe(true);
    expect((contextHandoff?.dropped_artifact_ids as unknown[]).length).toBeGreaterThan(0);
    expect((contextHandoff?.truncated_artifact_ids as unknown[]).length).toBeGreaterThan(0);
  });

  it('does not reserve retry-summary budget when no retry summary artifact exists', async () => {
    const { db, runId, runNodeIdByKey } = seedFiveSourceConvergingRun();
    const targetRunNodeId = runNodeIdByKey.get('target');
    if (!targetRunNodeId) {
      throw new Error('Expected target run-node to be materialized.');
    }

    db.update(runNodes)
      .set({
        maxRetries: 1,
        errorHandlerConfig: {
          mode: 'disabled',
        },
      })
      .where(eq(runNodes.id, targetRunNodeId))
      .run();

    const capturedContexts: (string[] | undefined)[] = [];
    const oversizedReport = 'Y'.repeat(10_050);
    let invocation = 0;

    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () => ({
        async *run(_prompt: string, options: ProviderRunOptions): AsyncIterable<ProviderEvent> {
          invocation += 1;
          capturedContexts.push(options.context);

          if (invocation <= 5) {
            yield { type: 'result', content: oversizedReport, timestamp: invocation * 10 };
            return;
          }

          if (invocation === 6) {
            throw new Error('target-attempt-1-failure');
          }

          yield { type: 'result', content: 'Recovered target output', timestamp: 70 };
        },
      }),
    });

    const result = await executor.executeRun({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(result).toEqual({
      workflowRunId: runId,
      executedNodes: 6,
      finalStep: {
        outcome: 'run_terminal',
        workflowRunId: runId,
        runStatus: 'completed',
      },
    });
    expect(invocation).toBe(7);
    expect(capturedContexts[5]).toHaveLength(4);
    expect(capturedContexts[6]).toHaveLength(4);
    expect(capturedContexts[6]?.some(entry => entry.includes('ALPHRED_RETRY_FAILURE_SUMMARY v1'))).toBe(false);

    const targetReportArtifact = db
      .select({
        metadata: phaseArtifacts.metadata,
      })
      .from(phaseArtifacts)
      .where(and(eq(phaseArtifacts.runNodeId, targetRunNodeId), eq(phaseArtifacts.artifactType, 'report')))
      .orderBy(asc(phaseArtifacts.id))
      .get();

    const contextHandoff = targetReportArtifact?.metadata as Record<string, unknown> | null;
    expect(contextHandoff).toEqual(
      expect.objectContaining({
        context_policy_version: 1,
        included_count: 4,
        included_source_node_keys: ['source_a', 'source_b', 'source_c', 'source_d'],
        included_chars_total: MAX_CONTEXT_CHARS_TOTAL,
        retry_summary_included: false,
        retry_summary_chars: 0,
        retry_summary_artifact_id: null,
      }),
    );
  });

  it('persists context handoff metadata for failed downstream executions', async () => {
    const { db, runId, targetRunNodeId } = seedLinearAutoRun();
    let invocation = 0;
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () => ({
        async *run(): AsyncIterable<ProviderEvent> {
          invocation += 1;
          if (invocation === 1) {
            yield { type: 'result', content: 'Source output', timestamp: 10 };
            return;
          }
          throw new Error('Target execution failed');
        },
      }),
    });

    const result = await executor.executeRun({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(result).toEqual({
      workflowRunId: runId,
      executedNodes: 2,
      finalStep: {
        outcome: 'run_terminal',
        workflowRunId: runId,
        runStatus: 'failed',
      },
    });

    const targetFailureArtifact = db
      .select({
        metadata: phaseArtifacts.metadata,
      })
      .from(phaseArtifacts)
      .where(and(eq(phaseArtifacts.runNodeId, targetRunNodeId), eq(phaseArtifacts.artifactType, 'log')))
      .orderBy(asc(phaseArtifacts.id))
      .get();

    const contextHandoff = targetFailureArtifact?.metadata as Record<string, unknown> | null;
    expect(contextHandoff).toEqual(
      expect.objectContaining({
        context_policy_version: 1,
        included_count: 1,
        included_source_node_keys: ['source'],
        missing_upstream_artifacts: false,
      }),
    );
  });

  it('keeps run status running when another latest attempt is already running', async () => {
    const { db, runId, firstRunNodeId, secondRunNodeId } = seedTwoRootAgentRun();
    transitionRunNodeStatus(db, {
      runNodeId: firstRunNodeId,
      expectedFrom: 'pending',
      to: 'running',
      occurredAt: '2026-01-01T00:00:00.000Z',
    });

    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () =>
        createProvider([
          { type: 'result', content: 'Second node result', timestamp: 10 },
        ]),
    });

    const result = await executor.executeNextRunnableNode({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(result).toEqual({
      outcome: 'executed',
      workflowRunId: runId,
      runNodeId: secondRunNodeId,
      nodeKey: 'b',
      runNodeStatus: 'completed',
      runStatus: 'running',
      artifactId: expect.any(Number),
    });
  });

  it('marks run failed after a successful step when a separate latest attempt already failed', async () => {
    const { db, runId, firstRunNodeId, secondRunNodeId } = seedTwoRootAgentRun();
    transitionRunNodeStatus(db, {
      runNodeId: secondRunNodeId,
      expectedFrom: 'pending',
      to: 'running',
      occurredAt: '2026-01-01T00:00:00.000Z',
    });
    transitionRunNodeStatus(db, {
      runNodeId: secondRunNodeId,
      expectedFrom: 'running',
      to: 'failed',
      occurredAt: '2026-01-01T00:01:00.000Z',
    });

    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () =>
        createProvider([
          { type: 'result', content: 'First node result', timestamp: 10 },
        ]),
    });

    const result = await executor.executeNextRunnableNode({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(result).toEqual({
      outcome: 'executed',
      workflowRunId: runId,
      runNodeId: firstRunNodeId,
      nodeKey: 'a',
      runNodeStatus: 'completed',
      runStatus: 'failed',
      artifactId: expect.any(Number),
    });
  });

  it('stores provider errors that are not Error instances as string content', async () => {
    const { db, runId, runNodeId } = seedSingleAgentRun();
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () => ({
        async *run(): AsyncIterable<ProviderEvent> {
          throw 'provider exploded';
          yield { type: 'system', content: '', timestamp: 0 };
        },
      }),
    });

    const result = await executor.executeRun({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(result.finalStep).toEqual({
      outcome: 'run_terminal',
      workflowRunId: runId,
      runStatus: 'failed',
    });

    const artifact = db
      .select({
        artifactType: phaseArtifacts.artifactType,
        contentType: phaseArtifacts.contentType,
        content: phaseArtifacts.content,
      })
      .from(phaseArtifacts)
      .where(eq(phaseArtifacts.runNodeId, runNodeId))
      .get();

    expect(artifact).toEqual({
      artifactType: 'log',
      contentType: 'text',
      content: 'provider exploded',
    });
  });

  it('persists recognized prompt content types on successful artifacts', async () => {
    const { db, runId, runNodeId } = seedSingleAgentRun('text');
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () =>
        createProvider([
          { type: 'result', content: 'Plain text report', timestamp: 10 },
        ]),
    });

    const result = await executor.executeRun({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(result.finalStep).toEqual({
      outcome: 'run_terminal',
      workflowRunId: runId,
      runStatus: 'completed',
    });

    const artifact = db
      .select({
        artifactType: phaseArtifacts.artifactType,
        contentType: phaseArtifacts.contentType,
      })
      .from(phaseArtifacts)
      .where(eq(phaseArtifacts.runNodeId, runNodeId))
      .get();

    expect(artifact).toEqual({
      artifactType: 'report',
      contentType: 'text',
    });
  });

  it('returns blocked from executeRun when the first step has no runnable node', async () => {
    const { db, runId } = seedGuardedCycleRun();
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () => createProvider([]),
    });

    const result = await executor.executeRun({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(result).toEqual({
      workflowRunId: runId,
      executedNodes: 0,
      finalStep: {
        outcome: 'blocked',
        workflowRunId: runId,
        runStatus: 'running',
      },
    });
  });

  it('throws when maxSteps is less than or equal to zero', async () => {
    const { db, runId } = seedSingleAgentRun();
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () => createProvider([]),
    });

    await expect(
      executor.executeRun({
        workflowRunId: runId,
        options: {
          workingDirectory: '/tmp/alphred-worktree',
        },
        maxSteps: 0,
      }),
    ).rejects.toThrow('maxSteps must be greater than zero.');
  });

  it('fails the run and persists iteration-limit metadata when execution exceeds maxSteps', async () => {
    const { db, runId, secondRunNodeId } = seedTwoRootAgentRun();
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () =>
        createProvider([
          { type: 'result', content: 'Node output', timestamp: 10 },
        ]),
    });

    const result = await executor.executeRun({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
      maxSteps: 1,
    });

    expect(result).toEqual({
      workflowRunId: runId,
      executedNodes: 1,
      finalStep: {
        outcome: 'run_terminal',
        workflowRunId: runId,
        runStatus: 'failed',
      },
    });

    const persistedRun = db
      .select({
        status: workflowRuns.status,
      })
      .from(workflowRuns)
      .where(eq(workflowRuns.id, runId))
      .get();

    expect(persistedRun).toEqual({
      status: 'failed',
    });

    const failedNode = db
      .select({
        status: runNodes.status,
      })
      .from(runNodes)
      .where(eq(runNodes.id, secondRunNodeId))
      .get();

    expect(failedNode).toEqual({
      status: 'failed',
    });

    const iterationLimitArtifact = db
      .select({
        artifactType: phaseArtifacts.artifactType,
        metadata: phaseArtifacts.metadata,
      })
      .from(phaseArtifacts)
      .where(eq(phaseArtifacts.runNodeId, secondRunNodeId))
      .get();

    expect(iterationLimitArtifact).toEqual({
      artifactType: 'log',
      metadata: expect.objectContaining({
        failureReason: 'iteration_limit_exceeded',
        maxSteps: 1,
        executedNodes: 1,
      }),
    });
  });

  it('does not count in-node retries against maxSteps', async () => {
    const { db, runId, runNodeId } = seedSingleAgentRun('markdown', 2);
    let invocation = 0;
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () => ({
        async *run(prompt: string): AsyncIterable<ProviderEvent> {
          if (prompt.startsWith('Analyze the following node execution failure.')) {
            yield { type: 'result', content: 'retry-summary', timestamp: 90 };
            return;
          }
          invocation += 1;
          if (invocation <= 2) {
            throw new Error(`Transient failure ${invocation}`);
          }
          yield { type: 'result', content: 'Recovered after retries', timestamp: 100 };
        },
      }),
    });

    const result = await executor.executeRun({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
      maxSteps: 1,
    });

    expect(result).toEqual({
      workflowRunId: runId,
      executedNodes: 1,
      finalStep: {
        outcome: 'run_terminal',
        workflowRunId: runId,
        runStatus: 'completed',
      },
    });

    const persistedRunNode = db
      .select({
        status: runNodes.status,
        attempt: runNodes.attempt,
      })
      .from(runNodes)
      .where(eq(runNodes.id, runNodeId))
      .get();

    expect(persistedRunNode).toEqual({
      status: 'completed',
      attempt: 3,
    });

    const artifacts = db
      .select({
        metadata: phaseArtifacts.metadata,
      })
      .from(phaseArtifacts)
      .where(eq(phaseArtifacts.runNodeId, runNodeId))
      .all();

    const failureReasons = artifacts
      .map(artifact => (artifact.metadata as { failureReason?: string } | null)?.failureReason ?? null)
      .filter((reason): reason is string => reason !== null);

    expect(failureReasons).not.toContain('iteration_limit_exceeded');
  });

  it('covers design_tree approve path with deterministic persisted evidence across run tables', async () => {
    const { db, runId, runNodeIdByKey } = seedDesignTreeIntegrationRun();
    let invocation = 0;
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () => ({
        async *run(): AsyncIterable<ProviderEvent> {
          invocation += 1;
          if (invocation === 1) {
            yield { type: 'result', content: 'Research findings', timestamp: 10 };
            return;
          }
          if (invocation === 2) {
            yield { type: 'result', content: 'Initial design draft', timestamp: 20 };
            return;
          }
          if (invocation === 3) {
            yield {
              type: 'result',
              content: 'decision: approved\nProceed to finalization.',
              timestamp: 30,
              metadata: { routingDecision: 'approved' },
            };
            return;
          }
          yield { type: 'result', content: 'Approval artifacts recorded.', timestamp: 40 };
        },
      }),
    });

    const result = await executor.executeRun({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(result).toEqual({
      workflowRunId: runId,
      executedNodes: 4,
      finalStep: {
        outcome: 'run_terminal',
        workflowRunId: runId,
        runStatus: 'completed',
      },
    });

    const persistedRun = db
      .select({
        status: workflowRuns.status,
      })
      .from(workflowRuns)
      .where(eq(workflowRuns.id, runId))
      .get();

    expect(persistedRun).toEqual({
      status: 'completed',
    });

    const nodeStates = db
      .select({
        nodeKey: runNodes.nodeKey,
        status: runNodes.status,
        attempt: runNodes.attempt,
      })
      .from(runNodes)
      .where(eq(runNodes.workflowRunId, runId))
      .orderBy(asc(runNodes.sequenceIndex))
      .all();

    expect(nodeStates).toEqual([
      { nodeKey: 'research', status: 'completed', attempt: 1 },
      { nodeKey: 'creation', status: 'completed', attempt: 1 },
      { nodeKey: 'review', status: 'completed', attempt: 1 },
      { nodeKey: 'approved', status: 'completed', attempt: 1 },
    ]);

    const reviewRunNodeId = runNodeIdByKey.get('review');
    if (!reviewRunNodeId) {
      throw new Error('Expected design_tree review run node.');
    }

    const decisions = db
      .select({
        decisionType: routingDecisions.decisionType,
        runNodeId: routingDecisions.runNodeId,
      })
      .from(routingDecisions)
      .where(eq(routingDecisions.workflowRunId, runId))
      .orderBy(asc(routingDecisions.id))
      .all();

    expect(decisions).toEqual([
      {
        decisionType: 'approved',
        runNodeId: reviewRunNodeId,
      },
    ]);

    const artifactTimeline = db
      .select({
        nodeKey: runNodes.nodeKey,
        artifactType: phaseArtifacts.artifactType,
      })
      .from(phaseArtifacts)
      .innerJoin(runNodes, eq(phaseArtifacts.runNodeId, runNodes.id))
      .where(eq(phaseArtifacts.workflowRunId, runId))
      .orderBy(asc(phaseArtifacts.id))
      .all();

    expect(artifactTimeline).toEqual([
      { nodeKey: 'research', artifactType: 'report' },
      { nodeKey: 'creation', artifactType: 'report' },
      { nodeKey: 'review', artifactType: 'report' },
      { nodeKey: 'approved', artifactType: 'report' },
    ]);
  });

  it('covers design_tree execution in a clean checkout without prebuilt dist artifacts', async () => {
    const distDirectories = [
      resolve(corePackageRoot, 'dist'),
      resolve(corePackageRoot, '../db/dist'),
      resolve(corePackageRoot, '../shared/dist'),
    ] as const;

    await expect(
      withDistDirectoriesTemporarilyHidden(distDirectories, async () => {
        await runVitestSubprocess([
          'packages/core/src/sqlWorkflowExecutor.test.ts',
          '-t',
          'covers design_tree approve path with deterministic persisted evidence across run tables',
          '--reporter=dot',
        ]);
      }),
    ).resolves.toBeUndefined();
  }, 30_000);

  it('covers design_tree revise loop path in a clean checkout without prebuilt dist artifacts', async () => {
    const distDirectories = [
      resolve(corePackageRoot, 'dist'),
      resolve(corePackageRoot, '../db/dist'),
      resolve(corePackageRoot, '../shared/dist'),
    ] as const;

    await expect(
      withDistDirectoriesTemporarilyHidden(distDirectories, async () => {
        await runVitestSubprocess([
          'packages/core/src/sqlWorkflowExecutor.test.ts',
          '-t',
          'covers design_tree revise loop path by returning to creation and completing after later approval',
          '--reporter=dot',
        ]);
      }),
    ).resolves.toBeUndefined();
  }, 45_000);

  it('covers design_tree revise loop path by returning to creation and completing after later approval', async () => {
    const { db, runId, runNodeIdByKey } = seedDesignTreeIntegrationRun();
    let invocation = 0;
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () => ({
        async *run(): AsyncIterable<ProviderEvent> {
          invocation += 1;
          if (invocation === 1) {
            yield { type: 'result', content: 'Research findings', timestamp: 10 };
            return;
          }
          if (invocation === 2) {
            yield { type: 'result', content: 'Draft v1', timestamp: 20 };
            return;
          }
          if (invocation === 3) {
            yield {
              type: 'result',
              content: 'decision: changes_requested\nRevise the draft.',
              timestamp: 30,
              metadata: { routingDecision: 'changes_requested' },
            };
            return;
          }
          if (invocation === 4) {
            yield { type: 'result', content: 'Draft v2 after revisions', timestamp: 40 };
            return;
          }
          if (invocation === 5) {
            yield {
              type: 'result',
              content: 'decision: approved\nNow it is ready.',
              timestamp: 50,
              metadata: { routingDecision: 'approved' },
            };
            return;
          }
          yield { type: 'result', content: 'Approved after revision cycle.', timestamp: 60 };
        },
      }),
    });

    const result = await executor.executeRun({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
      maxSteps: 20,
    });

    expect(result).toEqual({
      workflowRunId: runId,
      executedNodes: 6,
      finalStep: {
        outcome: 'run_terminal',
        workflowRunId: runId,
        runStatus: 'completed',
      },
    });

    const nodeStates = db
      .select({
        nodeKey: runNodes.nodeKey,
        status: runNodes.status,
        attempt: runNodes.attempt,
      })
      .from(runNodes)
      .where(eq(runNodes.workflowRunId, runId))
      .orderBy(asc(runNodes.sequenceIndex))
      .all();

    expect(nodeStates).toEqual([
      { nodeKey: 'research', status: 'completed', attempt: 1 },
      { nodeKey: 'creation', status: 'completed', attempt: 2 },
      { nodeKey: 'review', status: 'completed', attempt: 2 },
      { nodeKey: 'approved', status: 'completed', attempt: 1 },
    ]);

    const reviewRunNodeId = runNodeIdByKey.get('review');
    if (!reviewRunNodeId) {
      throw new Error('Expected design_tree review run node.');
    }

    const decisions = db
      .select({
        decisionType: routingDecisions.decisionType,
      })
      .from(routingDecisions)
      .where(eq(routingDecisions.runNodeId, reviewRunNodeId))
      .orderBy(asc(routingDecisions.id))
      .all();

    expect(decisions).toEqual([
      { decisionType: 'changes_requested' },
      { decisionType: 'approved' },
    ]);

    const artifactTimeline = db
      .select({
        nodeKey: runNodes.nodeKey,
      })
      .from(phaseArtifacts)
      .innerJoin(runNodes, eq(phaseArtifacts.runNodeId, runNodes.id))
      .where(eq(phaseArtifacts.workflowRunId, runId))
      .orderBy(asc(phaseArtifacts.id))
      .all();

    expect(artifactTimeline.map(artifact => artifact.nodeKey)).toEqual([
      'research',
      'creation',
      'review',
      'creation',
      'review',
      'approved',
    ]);
  });

  it('covers design_tree loop limit safety by failing with explicit iteration-limit metadata', async () => {
    const { db, runId, runNodeIdByKey } = seedDesignTreeIntegrationRun();
    let invocation = 0;
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () => ({
        async *run(): AsyncIterable<ProviderEvent> {
          invocation += 1;
          if (invocation === 3 || invocation === 5 || invocation === 7) {
            yield {
              type: 'result',
              content: 'decision: changes_requested\nKeep iterating.',
              timestamp: 30 + invocation,
              metadata: { routingDecision: 'changes_requested' },
            };
            return;
          }
          yield { type: 'result', content: `Loop execution ${invocation}`, timestamp: 10 + invocation };
        },
      }),
    });

    const result = await executor.executeRun({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
      maxSteps: 5,
    });

    expect(result).toEqual({
      workflowRunId: runId,
      executedNodes: 5,
      finalStep: {
        outcome: 'run_terminal',
        workflowRunId: runId,
        runStatus: 'failed',
      },
    });

    const persistedRun = db
      .select({
        status: workflowRuns.status,
      })
      .from(workflowRuns)
      .where(eq(workflowRuns.id, runId))
      .get();

    expect(persistedRun).toEqual({
      status: 'failed',
    });

    const decisions = db
      .select({
        decisionType: routingDecisions.decisionType,
      })
      .from(routingDecisions)
      .where(eq(routingDecisions.workflowRunId, runId))
      .orderBy(asc(routingDecisions.id))
      .all();

    expect(decisions).toEqual([
      { decisionType: 'changes_requested' },
      { decisionType: 'changes_requested' },
    ]);

    const creationRunNodeId = runNodeIdByKey.get('creation');
    if (!creationRunNodeId) {
      throw new Error('Expected design_tree creation run node.');
    }

    const failedCreationNode = db
      .select({
        status: runNodes.status,
      })
      .from(runNodes)
      .where(eq(runNodes.id, creationRunNodeId))
      .get();

    expect(failedCreationNode).toEqual({
      status: 'failed',
    });

    const iterationLimitArtifact = db
      .select({
        artifactType: phaseArtifacts.artifactType,
        content: phaseArtifacts.content,
        metadata: phaseArtifacts.metadata,
      })
      .from(phaseArtifacts)
      .where(and(eq(phaseArtifacts.workflowRunId, runId), eq(phaseArtifacts.artifactType, 'log')))
      .orderBy(asc(phaseArtifacts.id))
      .all()
      .find(
        artifact =>
          (artifact.metadata as { failureReason?: string } | null)?.failureReason === 'iteration_limit_exceeded',
      );

    expect(iterationLimitArtifact).toEqual({
      artifactType: 'log',
      content: expect.stringContaining('maxSteps=5'),
      metadata: expect.objectContaining({
        failureReason: 'iteration_limit_exceeded',
        maxSteps: 5,
        executedNodes: 5,
      }),
    });
  });

  it('throws when the workflow run id does not exist', async () => {
    const db = createDatabase(':memory:');
    migrateDatabase(db);
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () => createProvider([]),
    });

    await expect(
      executor.executeNextRunnableNode({
        workflowRunId: 999,
        options: {
          workingDirectory: '/tmp/alphred-worktree',
        },
      }),
    ).rejects.toThrow('Workflow run id=999 was not found.');
  });

  it('invokes onRunTerminal when execution transitions a run into a terminal status', async () => {
    const { db, runId } = seedSingleAgentRun();
    const onRunTerminal = vi.fn(async () => undefined);
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () =>
        createProvider([
          { type: 'result', content: 'Design report body', timestamp: 102 },
        ]),
      onRunTerminal,
    });

    const result = await executor.executeRun({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(result.finalStep.runStatus).toBe('completed');
    expect(onRunTerminal).toHaveBeenCalledTimes(1);
    expect(onRunTerminal).toHaveBeenCalledWith({
      workflowRunId: runId,
      runStatus: 'completed',
    });
  });

  it('invokes onRunTerminal when execution transitions a run into failed', async () => {
    const { db, runId } = seedSingleHumanNodeRun();
    const onRunTerminal = vi.fn(async () => undefined);
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () => createProvider([]),
      onRunTerminal,
    });

    const result = await executor.executeRun({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(result.finalStep).toEqual({
      outcome: 'run_terminal',
      workflowRunId: runId,
      runStatus: 'failed',
    });
    expect(onRunTerminal).toHaveBeenCalledTimes(1);
    expect(onRunTerminal).toHaveBeenCalledWith({
      workflowRunId: runId,
      runStatus: 'failed',
    });
  });

  it('invokes onRunTerminal when cancelRun transitions a run into cancelled', async () => {
    const { db, runId } = seedSingleAgentRun();
    const onRunTerminal = vi.fn(async () => undefined);
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () => createProvider([]),
      onRunTerminal,
    });

    const result = await executor.cancelRun({
      workflowRunId: runId,
    });

    expect(result).toEqual({
      action: 'cancel',
      outcome: 'applied',
      workflowRunId: runId,
      previousRunStatus: 'pending',
      runStatus: 'cancelled',
      retriedRunNodeIds: [],
    });
    expect(onRunTerminal).toHaveBeenCalledTimes(1);
    expect(onRunTerminal).toHaveBeenCalledWith({
      workflowRunId: runId,
      runStatus: 'cancelled',
    });
  });

  it('does not invoke onRunTerminal twice when cancelRun terminalizes during an in-flight step', async () => {
    const { db, runId } = seedSingleAgentRun();
    const onRunTerminal = vi.fn(async () => undefined);
    let invocationCount = 0;

    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () => ({
        async *run(): AsyncIterable<ProviderEvent> {
          invocationCount += 1;
          if (invocationCount === 1) {
            await executor.cancelRun({
              workflowRunId: runId,
            });
          }

          yield {
            type: 'result',
            content: `report-${invocationCount}`,
            timestamp: invocationCount,
          };
        },
      }),
      onRunTerminal,
    });

    const result = await executor.executeRun({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(result.finalStep).toEqual({
      outcome: 'run_terminal',
      workflowRunId: runId,
      runStatus: 'cancelled',
    });
    expect(onRunTerminal).toHaveBeenCalledTimes(1);
    expect(onRunTerminal).toHaveBeenCalledWith({
      workflowRunId: runId,
      runStatus: 'cancelled',
    });
  });

  it('does not invoke onRunTerminal for blocked non-terminal outcomes', async () => {
    const { db, runId, runNodeId } = seedSingleAgentRun();
    transitionWorkflowRunStatus(db, {
      workflowRunId: runId,
      expectedFrom: 'pending',
      to: 'running',
      occurredAt: '2026-01-01T00:00:00.000Z',
    });
    transitionRunNodeStatus(db, {
      runNodeId,
      expectedFrom: 'pending',
      to: 'running',
      occurredAt: '2026-01-01T00:01:00.000Z',
    });

    const onRunTerminal = vi.fn(async () => undefined);
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () => createProvider([]),
      onRunTerminal,
    });

    const result = await executor.executeNextRunnableNode({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(result).toEqual({
      outcome: 'blocked',
      workflowRunId: runId,
      runStatus: 'running',
    });
    expect(onRunTerminal).not.toHaveBeenCalled();
  });

  it('does not invoke onRunTerminal when the run is already terminal before the call', async () => {
    const { db, runId } = seedSingleAgentRun();
    transitionWorkflowRunStatus(db, {
      workflowRunId: runId,
      expectedFrom: 'pending',
      to: 'cancelled',
    });

    const onRunTerminal = vi.fn(async () => undefined);
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () => createProvider([]),
      onRunTerminal,
    });

    const result = await executor.executeNextRunnableNode({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(result).toEqual({
      outcome: 'run_terminal',
      workflowRunId: runId,
      runStatus: 'cancelled',
    });
    expect(onRunTerminal).not.toHaveBeenCalled();
  });

  it('returns typed control errors for invalid lifecycle transitions', async () => {
    const { db, runId } = seedSingleAgentRun();
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () => createProvider([]),
    });

    await expect(
      executor.pauseRun({
        workflowRunId: runId,
      }),
    ).rejects.toMatchObject({
      name: 'WorkflowRunControlError',
      code: 'WORKFLOW_RUN_CONTROL_INVALID_TRANSITION',
      action: 'pause',
      workflowRunId: runId,
      runStatus: 'pending',
    });
  });

  it('cancels pending runs without recording a startedAt timestamp', async () => {
    const { db, runId } = seedSingleAgentRun();
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () => createProvider([]),
    });

    const cancelResult = await executor.cancelRun({
      workflowRunId: runId,
    });

    expect(cancelResult).toEqual({
      action: 'cancel',
      outcome: 'applied',
      workflowRunId: runId,
      previousRunStatus: 'pending',
      runStatus: 'cancelled',
      retriedRunNodeIds: [],
    });

    const persistedRun = db
      .select({
        status: workflowRuns.status,
        startedAt: workflowRuns.startedAt,
        completedAt: workflowRuns.completedAt,
      })
      .from(workflowRuns)
      .where(eq(workflowRuns.id, runId))
      .get();
    expect(persistedRun).toBeDefined();
    if (!persistedRun) {
      throw new Error('Expected persisted workflow run row.');
    }

    expect(persistedRun.status).toBe('cancelled');
    expect(persistedRun.startedAt).toBeNull();
    expect(persistedRun.completedAt).not.toBeNull();
  });

  it('cancels paused runs with a direct paused-to-cancelled transition', async () => {
    const { db, runId } = seedSingleAgentRun();
    transitionWorkflowRunStatus(db, {
      workflowRunId: runId,
      expectedFrom: 'pending',
      to: 'running',
      occurredAt: '2026-01-01T00:00:00.000Z',
    });
    transitionWorkflowRunStatus(db, {
      workflowRunId: runId,
      expectedFrom: 'running',
      to: 'paused',
      occurredAt: '2026-01-01T00:01:00.000Z',
    });

    db.run(sql`DROP TABLE IF EXISTS workflow_run_status_audit`);
    db.run(sql`CREATE TABLE workflow_run_status_audit (
      id integer primary key autoincrement,
      old_status text not null,
      new_status text not null
    )`);
    db.run(sql`DROP TRIGGER IF EXISTS workflow_runs_test_cancel_from_paused_audit`);
    db.run(
      sql.raw(`CREATE TRIGGER workflow_runs_test_cancel_from_paused_audit
      AFTER UPDATE OF status ON workflow_runs
      FOR EACH ROW
      WHEN OLD.id = ${runId}
      BEGIN
        INSERT INTO workflow_run_status_audit(old_status, new_status)
        VALUES (OLD.status, NEW.status);
      END`),
    );

    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () => createProvider([]),
    });

    const cancelResult = await executor.cancelRun({
      workflowRunId: runId,
    });

    expect(cancelResult).toEqual({
      action: 'cancel',
      outcome: 'applied',
      workflowRunId: runId,
      previousRunStatus: 'paused',
      runStatus: 'cancelled',
      retriedRunNodeIds: [],
    });

    const statusAuditRows = db
      .select({
        oldStatus: workflowRunStatusAudit.oldStatus,
        newStatus: workflowRunStatusAudit.newStatus,
      })
      .from(workflowRunStatusAudit)
      .orderBy(asc(workflowRunStatusAudit.id))
      .all();

    expect(statusAuditRows).toEqual([
      {
        oldStatus: 'paused',
        newStatus: 'cancelled',
      },
    ]);
  });

  it('preserves in-flight node completion when paused and blocks additional node claims', async () => {
    const { db, runId, sourceRunNodeId, targetRunNodeId } = seedLinearAutoRun();
    let invocationCount = 0;

    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () => ({
        async *run(): AsyncIterable<ProviderEvent> {
          invocationCount += 1;
          if (invocationCount === 1) {
            await executor.pauseRun({
              workflowRunId: runId,
            });
          }

          yield {
            type: 'result',
            content: `report-${invocationCount}`,
            timestamp: invocationCount,
          };
        },
      }),
    });

    const result = await executor.executeRun({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(result.finalStep).toEqual({
      outcome: 'blocked',
      workflowRunId: runId,
      runStatus: 'paused',
    });
    expect(invocationCount).toBe(1);

    const persistedRun = db
      .select({
        status: workflowRuns.status,
      })
      .from(workflowRuns)
      .where(eq(workflowRuns.id, runId))
      .get();
    expect(persistedRun?.status).toBe('paused');

    const persistedNodes = db
      .select({
        id: runNodes.id,
        status: runNodes.status,
      })
      .from(runNodes)
      .where(eq(runNodes.workflowRunId, runId))
      .all();

    expect(persistedNodes).toEqual(
      expect.arrayContaining([
        { id: sourceRunNodeId, status: 'completed' },
        { id: targetRunNodeId, status: 'pending' },
      ]),
    );
  });

  it('halts immediate retry attempts when pause control is requested during a retryable failure', async () => {
    const { db, runId, runNodeId } = seedSingleAgentRun('markdown', 1);
    let invocationCount = 0;

    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () => ({
        async *run(): AsyncIterable<ProviderEvent> {
          invocationCount += 1;
          if (invocationCount === 1) {
            await executor.pauseRun({
              workflowRunId: runId,
            });
          }

          yield* [];
          throw new Error(`attempt-${invocationCount}-failed`);
        },
      }),
    });

    const result = await executor.executeRun({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(result.finalStep).toEqual({
      outcome: 'blocked',
      workflowRunId: runId,
      runStatus: 'paused',
    });
    expect(invocationCount).toBe(2);

    const persistedRunNode = db
      .select({
        status: runNodes.status,
        attempt: runNodes.attempt,
        startedAt: runNodes.startedAt,
        completedAt: runNodes.completedAt,
      })
      .from(runNodes)
      .where(eq(runNodes.id, runNodeId))
      .get();
    expect(persistedRunNode).toBeDefined();
    if (!persistedRunNode) {
      throw new Error('Expected persisted run-node row.');
    }

    expect(persistedRunNode).toEqual({
      status: 'pending',
      attempt: 2,
      startedAt: null,
      completedAt: null,
    });
  });

  it('halts immediate retry attempts when pause control is requested during retry error-handler execution', async () => {
    const { db, runId, runNodeId } = seedSingleAgentRun('markdown', 1);
    let nodeInvocationCount = 0;
    let errorHandlerInvocationCount = 0;

    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () => ({
        async *run(prompt: string): AsyncIterable<ProviderEvent> {
          if (prompt.startsWith('Analyze the following node execution failure.')) {
            errorHandlerInvocationCount += 1;
            await executor.pauseRun({
              workflowRunId: runId,
            });
            yield { type: 'result', content: 'retry guidance', timestamp: 2 };
            return;
          }

          nodeInvocationCount += 1;
          throw new Error(`attempt-${nodeInvocationCount}-failed`);
        },
      }),
    });

    const result = await executor.executeRun({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(result.finalStep).toEqual({
      outcome: 'blocked',
      workflowRunId: runId,
      runStatus: 'paused',
    });
    expect(nodeInvocationCount).toBe(1);
    expect(errorHandlerInvocationCount).toBe(1);

    const persistedRunNode = db
      .select({
        status: runNodes.status,
        attempt: runNodes.attempt,
        startedAt: runNodes.startedAt,
        completedAt: runNodes.completedAt,
      })
      .from(runNodes)
      .where(eq(runNodes.id, runNodeId))
      .get();
    expect(persistedRunNode).toBeDefined();
    if (!persistedRunNode) {
      throw new Error('Expected persisted run-node row.');
    }

    expect(persistedRunNode).toEqual({
      status: 'pending',
      attempt: 2,
      startedAt: null,
      completedAt: null,
    });
  });

  it('keeps run cancelled when cancel control is requested during in-flight execution', async () => {
    const { db, runId, sourceRunNodeId, targetRunNodeId } = seedLinearAutoRun();
    let invocationCount = 0;

    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () => ({
        async *run(): AsyncIterable<ProviderEvent> {
          invocationCount += 1;
          if (invocationCount === 1) {
            await executor.cancelRun({
              workflowRunId: runId,
            });
          }

          yield {
            type: 'result',
            content: `report-${invocationCount}`,
            timestamp: invocationCount,
          };
        },
      }),
    });

    const result = await executor.executeRun({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(result.finalStep).toEqual({
      outcome: 'run_terminal',
      workflowRunId: runId,
      runStatus: 'cancelled',
    });
    expect(invocationCount).toBe(1);

    const persistedRun = db
      .select({
        status: workflowRuns.status,
      })
      .from(workflowRuns)
      .where(eq(workflowRuns.id, runId))
      .get();
    expect(persistedRun?.status).toBe('cancelled');

    const persistedNodes = db
      .select({
        id: runNodes.id,
        status: runNodes.status,
      })
      .from(runNodes)
      .where(eq(runNodes.workflowRunId, runId))
      .all();

    expect(persistedNodes).toEqual(
      expect.arrayContaining([
        { id: sourceRunNodeId, status: 'completed' },
        { id: targetRunNodeId, status: 'pending' },
      ]),
    );
  });

  it('halts immediate retry attempts when cancel control is requested during a retryable failure', async () => {
    const { db, runId, runNodeId } = seedSingleAgentRun('markdown', 1);
    let invocationCount = 0;

    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () => ({
        async *run(): AsyncIterable<ProviderEvent> {
          invocationCount += 1;
          if (invocationCount === 1) {
            await executor.cancelRun({
              workflowRunId: runId,
            });
          }

          yield* [];
          throw new Error(`attempt-${invocationCount}-failed`);
        },
      }),
    });

    const result = await executor.executeRun({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(result.finalStep).toEqual({
      outcome: 'run_terminal',
      workflowRunId: runId,
      runStatus: 'cancelled',
    });
    expect(invocationCount).toBe(1);

    const persistedRunNode = db
      .select({
        status: runNodes.status,
        attempt: runNodes.attempt,
      })
      .from(runNodes)
      .where(eq(runNodes.id, runNodeId))
      .get();
    expect(persistedRunNode).toBeDefined();
    if (!persistedRunNode) {
      throw new Error('Expected persisted run-node row.');
    }

    expect(persistedRunNode.status).toBe('failed');
    expect(persistedRunNode.attempt).toBe(1);
  });

  it('halts immediate retry attempts when cancel control is requested during retry error-handler execution', async () => {
    const { db, runId, runNodeId } = seedSingleAgentRun('markdown', 1);
    let nodeInvocationCount = 0;
    let errorHandlerInvocationCount = 0;

    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () => ({
        async *run(prompt: string): AsyncIterable<ProviderEvent> {
          if (prompt.startsWith('Analyze the following node execution failure.')) {
            errorHandlerInvocationCount += 1;
            await executor.cancelRun({
              workflowRunId: runId,
            });
            yield { type: 'result', content: 'retry guidance', timestamp: 2 };
            return;
          }

          nodeInvocationCount += 1;
          throw new Error(`attempt-${nodeInvocationCount}-failed`);
        },
      }),
    });

    const result = await executor.executeRun({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(result.finalStep).toEqual({
      outcome: 'run_terminal',
      workflowRunId: runId,
      runStatus: 'cancelled',
    });
    expect(nodeInvocationCount).toBe(1);
    expect(errorHandlerInvocationCount).toBe(1);

    const persistedRunNode = db
      .select({
        status: runNodes.status,
        attempt: runNodes.attempt,
      })
      .from(runNodes)
      .where(eq(runNodes.id, runNodeId))
      .get();
    expect(persistedRunNode).toBeDefined();
    if (!persistedRunNode) {
      throw new Error('Expected persisted run-node row.');
    }

    expect(persistedRunNode.status).toBe('failed');
    expect(persistedRunNode.attempt).toBe(1);
  });

  it('requeues only failed latest attempts on retry control and keeps successful nodes intact', async () => {
    const { db, runId, firstRunNodeId, secondRunNodeId } = seedTwoRootAgentRun();
    transitionWorkflowRunStatus(db, {
      workflowRunId: runId,
      expectedFrom: 'pending',
      to: 'running',
      occurredAt: '2026-01-01T00:00:00.000Z',
    });
    transitionRunNodeStatus(db, {
      runNodeId: firstRunNodeId,
      expectedFrom: 'pending',
      to: 'running',
      occurredAt: '2026-01-01T00:01:00.000Z',
    });
    transitionRunNodeStatus(db, {
      runNodeId: firstRunNodeId,
      expectedFrom: 'running',
      to: 'completed',
      occurredAt: '2026-01-01T00:02:00.000Z',
    });
    transitionRunNodeStatus(db, {
      runNodeId: secondRunNodeId,
      expectedFrom: 'pending',
      to: 'running',
      occurredAt: '2026-01-01T00:03:00.000Z',
    });
    transitionRunNodeStatus(db, {
      runNodeId: secondRunNodeId,
      expectedFrom: 'running',
      to: 'failed',
      occurredAt: '2026-01-01T00:04:00.000Z',
    });
    transitionWorkflowRunStatus(db, {
      workflowRunId: runId,
      expectedFrom: 'running',
      to: 'failed',
      occurredAt: '2026-01-01T00:04:30.000Z',
    });

    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () => createProvider([]),
    });

    const retryResult = await executor.retryRun({
      workflowRunId: runId,
    });

    expect(retryResult).toEqual({
      action: 'retry',
      outcome: 'applied',
      workflowRunId: runId,
      previousRunStatus: 'failed',
      runStatus: 'running',
      retriedRunNodeIds: [secondRunNodeId],
    });

    const persistedRun = db
      .select({
        status: workflowRuns.status,
      })
      .from(workflowRuns)
      .where(eq(workflowRuns.id, runId))
      .get();
    expect(persistedRun?.status).toBe('running');

    const persistedNodes = db
      .select({
        id: runNodes.id,
        status: runNodes.status,
        attempt: runNodes.attempt,
        startedAt: runNodes.startedAt,
        completedAt: runNodes.completedAt,
      })
      .from(runNodes)
      .where(eq(runNodes.workflowRunId, runId))
      .all();

    expect(persistedNodes).toEqual(
      expect.arrayContaining([
        {
          id: firstRunNodeId,
          status: 'completed',
          attempt: 1,
          startedAt: '2026-01-01T00:01:00.000Z',
          completedAt: '2026-01-01T00:02:00.000Z',
        },
        {
          id: secondRunNodeId,
          status: 'pending',
          attempt: 2,
          startedAt: null,
          completedAt: null,
        },
      ]),
    );
  });

  it('reopens ready fan-out barriers when retry control requeues failed dynamic children', async () => {
    const { db, runId, runNodeIdByKey } = seedDynamicFanOutIssue163Run();
    const breakdownRunNodeId = runNodeIdByKey.get('breakdown');
    const finalReviewRunNodeId = runNodeIdByKey.get('final-review');
    if (!breakdownRunNodeId || !finalReviewRunNodeId) {
      throw new Error('Expected dynamic fan-out run nodes to include breakdown and final-review.');
    }

    transitionWorkflowRunStatus(db, {
      workflowRunId: runId,
      expectedFrom: 'pending',
      to: 'running',
      occurredAt: '2026-01-01T00:00:00.000Z',
    });

    const spawnerNode = db
      .select({
        treeNodeId: runNodes.treeNodeId,
      })
      .from(runNodes)
      .where(eq(runNodes.id, breakdownRunNodeId))
      .get();
    if (!spawnerNode) {
      throw new Error('Expected breakdown run node to exist.');
    }

    const spawnArtifactId = Number(
      db
        .insert(phaseArtifacts)
        .values({
          workflowRunId: runId,
          runNodeId: breakdownRunNodeId,
          artifactType: 'report',
          contentType: 'json',
          content: '{"schemaVersion":1,"subtasks":[]}',
          metadata: null,
          createdAt: '2026-01-01T00:00:30.000Z',
        })
        .run().lastInsertRowid,
    );

    const childRunNodeId = Number(
      db
        .insert(runNodes)
        .values({
          workflowRunId: runId,
          treeNodeId: spawnerNode.treeNodeId,
          nodeKey: 'issue-163-retry-child',
          nodeRole: 'standard',
          nodeType: 'agent',
          provider: 'codex',
          model: null,
          prompt: 'Retry this fan-out child.',
          promptContentType: 'markdown',
          executionPermissions: null,
          errorHandlerConfig: null,
          maxChildren: 0,
          maxRetries: 0,
          spawnerNodeId: breakdownRunNodeId,
          joinNodeId: finalReviewRunNodeId,
          lineageDepth: 1,
          sequencePath: '20.1',
          status: 'pending',
          sequenceIndex: 50,
          attempt: 1,
          startedAt: null,
          completedAt: null,
          createdAt: '2026-01-01T00:01:00.000Z',
          updatedAt: '2026-01-01T00:01:00.000Z',
        })
        .run().lastInsertRowid,
    );
    db.insert(runNodeEdges)
      .values([
        {
          workflowRunId: runId,
          sourceRunNodeId: breakdownRunNodeId,
          targetRunNodeId: childRunNodeId,
          routeOn: 'success',
          auto: 1,
          guardExpression: null,
          priority: 1,
          edgeKind: 'dynamic_spawner_to_child',
        },
        {
          workflowRunId: runId,
          sourceRunNodeId: childRunNodeId,
          targetRunNodeId: finalReviewRunNodeId,
          routeOn: 'terminal',
          auto: 1,
          guardExpression: null,
          priority: 0,
          edgeKind: 'dynamic_child_to_join',
        },
      ])
      .run();

    transitionRunNodeStatus(db, {
      runNodeId: childRunNodeId,
      expectedFrom: 'pending',
      to: 'running',
      occurredAt: '2026-01-01T00:01:30.000Z',
    });
    transitionRunNodeStatus(db, {
      runNodeId: childRunNodeId,
      expectedFrom: 'running',
      to: 'failed',
      occurredAt: '2026-01-01T00:02:00.000Z',
    });

    db.insert(runJoinBarriers)
      .values({
        workflowRunId: runId,
        spawnerRunNodeId: breakdownRunNodeId,
        joinRunNodeId: finalReviewRunNodeId,
        spawnSourceArtifactId: spawnArtifactId,
        expectedChildren: 1,
        terminalChildren: 1,
        completedChildren: 0,
        failedChildren: 1,
        status: 'ready',
        createdAt: '2026-01-01T00:00:30.000Z',
        updatedAt: '2026-01-01T00:02:00.000Z',
        releasedAt: null,
      })
      .run();

    transitionWorkflowRunStatus(db, {
      workflowRunId: runId,
      expectedFrom: 'running',
      to: 'failed',
      occurredAt: '2026-01-01T00:02:30.000Z',
    });

    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () => createProvider([]),
    });

    const retryResult = await executor.retryRun({
      workflowRunId: runId,
    });

    expect(retryResult.retriedRunNodeIds).toEqual([childRunNodeId]);

    const retriedChild = db
      .select({
        status: runNodes.status,
        attempt: runNodes.attempt,
        startedAt: runNodes.startedAt,
        completedAt: runNodes.completedAt,
      })
      .from(runNodes)
      .where(eq(runNodes.id, childRunNodeId))
      .get();
    expect(retriedChild).toEqual({
      status: 'pending',
      attempt: 2,
      startedAt: null,
      completedAt: null,
    });

    const reopenedBarrier = db
      .select({
        terminalChildren: runJoinBarriers.terminalChildren,
        completedChildren: runJoinBarriers.completedChildren,
        failedChildren: runJoinBarriers.failedChildren,
        status: runJoinBarriers.status,
      })
      .from(runJoinBarriers)
      .where(eq(runJoinBarriers.workflowRunId, runId))
      .get();
    expect(reopenedBarrier).toEqual({
      terminalChildren: 0,
      completedChildren: 0,
      failedChildren: 0,
      status: 'pending',
    });
  });

  it('treats repeated retry control requests deterministically under near-concurrent calls', async () => {
    const { db, runId, secondRunNodeId } = seedTwoRootAgentRun();
    transitionWorkflowRunStatus(db, {
      workflowRunId: runId,
      expectedFrom: 'pending',
      to: 'running',
      occurredAt: '2026-01-01T00:00:00.000Z',
    });

    const firstPending = db
      .select({ id: runNodes.id })
      .from(runNodes)
      .where(eq(runNodes.workflowRunId, runId))
      .orderBy(asc(runNodes.sequenceIndex))
      .all();

    for (const [index, node] of firstPending.entries()) {
      transitionRunNodeStatus(db, {
        runNodeId: node.id,
        expectedFrom: 'pending',
        to: 'running',
        occurredAt: `2026-01-01T00:0${index + 1}:00.000Z`,
      });
      transitionRunNodeStatus(db, {
        runNodeId: node.id,
        expectedFrom: 'running',
        to: node.id === secondRunNodeId ? 'failed' : 'completed',
        occurredAt: `2026-01-01T00:1${index + 1}:00.000Z`,
      });
    }

    transitionWorkflowRunStatus(db, {
      workflowRunId: runId,
      expectedFrom: 'running',
      to: 'failed',
      occurredAt: '2026-01-01T00:20:00.000Z',
    });

    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () => createProvider([]),
    });

    const [firstRetry, secondRetry] = await Promise.all([
      executor.retryRun({ workflowRunId: runId }),
      executor.retryRun({ workflowRunId: runId }),
    ]);

    expect(firstRetry).toEqual(
      expect.objectContaining({
        action: 'retry',
        outcome: 'applied',
        workflowRunId: runId,
        previousRunStatus: 'failed',
        runStatus: 'running',
        retriedRunNodeIds: [secondRunNodeId],
      }),
    );
    expect(secondRetry).toEqual({
      action: 'retry',
      outcome: 'noop',
      workflowRunId: runId,
      previousRunStatus: 'running',
      runStatus: 'running',
      retriedRunNodeIds: [],
    });
  });

  it('returns noop when cancelRun is called for an already cancelled run', async () => {
    const { db, runId } = seedSingleAgentRun();
    transitionWorkflowRunStatus(db, {
      workflowRunId: runId,
      expectedFrom: 'pending',
      to: 'cancelled',
      occurredAt: '2026-01-01T00:00:00.000Z',
    });

    const onRunTerminal = vi.fn(async () => undefined);
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () => createProvider([]),
      onRunTerminal,
    });

    const result = await executor.cancelRun({
      workflowRunId: runId,
    });

    expect(result).toEqual({
      action: 'cancel',
      outcome: 'noop',
      workflowRunId: runId,
      previousRunStatus: 'cancelled',
      runStatus: 'cancelled',
      retriedRunNodeIds: [],
    });
    expect(onRunTerminal).not.toHaveBeenCalled();
  });

  it('returns a typed invalid-transition error when cancelRun is called from completed', async () => {
    const { db, runId } = seedSingleAgentRun();
    transitionWorkflowRunStatus(db, {
      workflowRunId: runId,
      expectedFrom: 'pending',
      to: 'running',
      occurredAt: '2026-01-01T00:00:00.000Z',
    });
    transitionWorkflowRunStatus(db, {
      workflowRunId: runId,
      expectedFrom: 'running',
      to: 'completed',
      occurredAt: '2026-01-01T00:01:00.000Z',
    });

    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () => createProvider([]),
    });

    await expect(
      executor.cancelRun({
        workflowRunId: runId,
      }),
    ).rejects.toMatchObject({
      name: 'WorkflowRunControlError',
      code: 'WORKFLOW_RUN_CONTROL_INVALID_TRANSITION',
      action: 'cancel',
      workflowRunId: runId,
      runStatus: 'completed',
      message: `Cannot cancel workflow run id=${runId} from status "completed". Expected pending, running, or paused.`,
    });
  });

  it('returns a typed invalid-transition error when resumeRun is called from pending', async () => {
    const { db, runId } = seedSingleAgentRun();
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () => createProvider([]),
    });

    await expect(
      executor.resumeRun({
        workflowRunId: runId,
      }),
    ).rejects.toMatchObject({
      name: 'WorkflowRunControlError',
      code: 'WORKFLOW_RUN_CONTROL_INVALID_TRANSITION',
      action: 'resume',
      workflowRunId: runId,
      runStatus: 'pending',
      message: `Cannot resume workflow run id=${runId} from status "pending". Expected status "paused".`,
    });
  });

  it('returns retry-targets-not-found when a failed run has no failed nodes to retry', async () => {
    const { db, runId } = seedSingleAgentRun();
    transitionWorkflowRunStatus(db, {
      workflowRunId: runId,
      expectedFrom: 'pending',
      to: 'running',
      occurredAt: '2026-01-01T00:00:00.000Z',
    });
    transitionWorkflowRunStatus(db, {
      workflowRunId: runId,
      expectedFrom: 'running',
      to: 'failed',
      occurredAt: '2026-01-01T00:01:00.000Z',
    });

    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () => createProvider([]),
    });

    await expect(
      executor.retryRun({
        workflowRunId: runId,
      }),
    ).rejects.toMatchObject({
      name: 'WorkflowRunControlError',
      code: 'WORKFLOW_RUN_CONTROL_RETRY_TARGETS_NOT_FOUND',
      action: 'retry',
      workflowRunId: runId,
      runStatus: 'failed',
    });
  });

  it('retries pause control precondition conflicts and returns a concurrent conflict error on exhaustion', async () => {
    const { db, runId } = seedSingleAgentRun();
    transitionWorkflowRunStatus(db, {
      workflowRunId: runId,
      expectedFrom: 'pending',
      to: 'running',
      occurredAt: '2026-01-01T00:00:00.000Z',
    });

    const dbModule = await import('@alphred/db');
    const originalTransitionWorkflowRunStatus = dbModule.transitionWorkflowRunStatus;
    const transitionSpy = vi.spyOn(dbModule, 'transitionWorkflowRunStatus').mockImplementation((database, params) => {
      if (params.workflowRunId === runId && params.to === 'paused') {
        throw new Error(
          `Workflow-run transition precondition failed for id=${params.workflowRunId}; expected status "${params.expectedFrom}".`,
        );
      }
      return originalTransitionWorkflowRunStatus(database, params);
    });

    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () => createProvider([]),
    });

    try {
      await expect(
        executor.pauseRun({
          workflowRunId: runId,
        }),
      ).rejects.toMatchObject({
        name: 'WorkflowRunControlError',
        code: 'WORKFLOW_RUN_CONTROL_CONCURRENT_CONFLICT',
        action: 'pause',
        workflowRunId: runId,
        runStatus: 'running',
      });
    } finally {
      transitionSpy.mockRestore();
    }
  });

  it('executeSingleNode executes next_runnable once and terminalizes the run', async () => {
    const { db, runId, sourceRunNodeId, targetRunNodeId } = seedLinearAutoRun();
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () =>
        createProvider([
          {
            type: 'result',
            content: 'single node completed',
            timestamp: 1,
          },
        ]),
    });

    const result = await executor.executeSingleNode({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred',
      },
    });

    expect(result.executedNodes).toBe(1);
    expect(result.finalStep).toMatchObject({
      outcome: 'run_terminal',
      workflowRunId: runId,
      runStatus: 'completed',
    });

    const run = db
      .select({
        status: workflowRuns.status,
      })
      .from(workflowRuns)
      .where(eq(workflowRuns.id, runId))
      .get();
    expect(run?.status).toBe('completed');

    const sourceNode = db
      .select({
        status: runNodes.status,
      })
      .from(runNodes)
      .where(eq(runNodes.id, sourceRunNodeId))
      .get();
    const targetNode = db
      .select({
        status: runNodes.status,
      })
      .from(runNodes)
      .where(eq(runNodes.id, targetRunNodeId))
      .get();
    expect(sourceNode?.status).toBe('completed');
    expect(targetNode?.status).toBe('pending');
  });

  it('executeSingleNode supports node_key targeted execution', async () => {
    const { db, runId, sourceRunNodeId, targetRunNodeId } = seedLinearAutoRun();
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () =>
        createProvider([
          {
            type: 'result',
            content: 'target node completed',
            timestamp: 1,
          },
        ]),
    });

    const result = await executor.executeSingleNode({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred',
      },
      nodeSelector: {
        type: 'node_key',
        nodeKey: 'target',
      },
    });

    expect(result.executedNodes).toBe(1);
    expect(result.finalStep).toMatchObject({
      outcome: 'run_terminal',
      workflowRunId: runId,
      runStatus: 'completed',
    });

    const sourceNode = db
      .select({
        status: runNodes.status,
      })
      .from(runNodes)
      .where(eq(runNodes.id, sourceRunNodeId))
      .get();
    const targetNode = db
      .select({
        status: runNodes.status,
      })
      .from(runNodes)
      .where(eq(runNodes.id, targetRunNodeId))
      .get();
    expect(sourceNode?.status).toBe('pending');
    expect(targetNode?.status).toBe('completed');
  });

  it('executeSingleNode performs exactly one failed attempt even when maxRetries is configured', async () => {
    const { db, runId, runNodeId } = seedSingleAgentRun('markdown', 3);
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () => ({
        run(): AsyncIterable<ProviderEvent> {
          return {
            [Symbol.asyncIterator](): AsyncIterator<ProviderEvent> {
              throw new Error('single-node failure');
            },
          };
        },
      }),
    });

    const result = await executor.executeSingleNode({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred',
      },
    });

    expect(result.executedNodes).toBe(1);
    expect(result.finalStep).toMatchObject({
      outcome: 'run_terminal',
      workflowRunId: runId,
      runStatus: 'failed',
    });

    const node = db
      .select({
        status: runNodes.status,
        attempt: runNodes.attempt,
      })
      .from(runNodes)
      .where(eq(runNodes.id, runNodeId))
      .get();
    expect(node).toMatchObject({
      status: 'failed',
      attempt: 1,
    });
  });

  it('executeSingleNode returns typed validation errors for missing node_key selectors', async () => {
    const { db, runId } = seedSingleAgentRun();
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () => createProvider([]),
    });

    await expect(
      executor.executeSingleNode({
        workflowRunId: runId,
        options: {
          workingDirectory: '/tmp/alphred',
        },
        nodeSelector: {
          type: 'node_key',
          nodeKey: 'missing',
        },
      }),
    ).rejects.toMatchObject({
      name: 'WorkflowRunExecutionValidationError',
      code: 'WORKFLOW_RUN_SINGLE_NODE_SELECTOR_NOT_FOUND',
      workflowRunId: runId,
      nodeSelector: {
        type: 'node_key',
        nodeKey: 'missing',
      },
    });

    const run = db
      .select({
        status: workflowRuns.status,
      })
      .from(workflowRuns)
      .where(eq(workflowRuns.id, runId))
      .get();
    expect(run?.status).toBe('pending');
  });

  it('validateSingleNodeSelection accepts trimmed node_key selectors that map to pending nodes', () => {
    const { db, runId } = seedSingleAgentRun();
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () => createProvider([]),
    });

    expect(() =>
      executor.validateSingleNodeSelection({
        workflowRunId: runId,
        nodeSelector: {
          type: 'node_key',
          nodeKey: ' design ',
        },
      }),
    ).not.toThrow();
  });

  it('validateSingleNodeSelection rejects terminal runs', () => {
    const { db, runId } = seedSingleAgentRun();
    transitionWorkflowRunStatus(db, {
      workflowRunId: runId,
      expectedFrom: 'pending',
      to: 'running',
      occurredAt: '2026-01-01T00:00:00.000Z',
    });
    transitionWorkflowRunStatus(db, {
      workflowRunId: runId,
      expectedFrom: 'running',
      to: 'completed',
      occurredAt: '2026-01-01T00:01:00.000Z',
    });

    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () => createProvider([]),
    });

    try {
      executor.validateSingleNodeSelection({ workflowRunId: runId });
      throw new Error('Expected validateSingleNodeSelection to reject terminal runs.');
    } catch (error) {
      expect(error).toMatchObject({
        name: 'WorkflowRunExecutionValidationError',
        code: 'WORKFLOW_RUN_SINGLE_NODE_SELECTOR_NOT_EXECUTABLE',
        workflowRunId: runId,
      });
      expect(String((error as Error).message)).toContain('already terminal');
    }
  });

  it('validateSingleNodeSelection rejects paused runs', () => {
    const { db, runId } = seedSingleAgentRun();
    transitionWorkflowRunStatus(db, {
      workflowRunId: runId,
      expectedFrom: 'pending',
      to: 'running',
      occurredAt: '2026-01-01T00:00:00.000Z',
    });
    transitionWorkflowRunStatus(db, {
      workflowRunId: runId,
      expectedFrom: 'running',
      to: 'paused',
      occurredAt: '2026-01-01T00:01:00.000Z',
    });

    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () => createProvider([]),
    });

    try {
      executor.validateSingleNodeSelection({ workflowRunId: runId });
      throw new Error('Expected validateSingleNodeSelection to reject paused runs.');
    } catch (error) {
      expect(error).toMatchObject({
        name: 'WorkflowRunExecutionValidationError',
        code: 'WORKFLOW_RUN_SINGLE_NODE_SELECTOR_NOT_EXECUTABLE',
        workflowRunId: runId,
      });
      expect(String((error as Error).message)).toContain('is paused and cannot execute a single node');
    }
  });

  it('validateSingleNodeSelection rejects empty node_key selectors', () => {
    const { db, runId } = seedSingleAgentRun();
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () => createProvider([]),
    });

    try {
      executor.validateSingleNodeSelection({
        workflowRunId: runId,
        nodeSelector: {
          type: 'node_key',
          nodeKey: '   ',
        },
      });
      throw new Error('Expected validateSingleNodeSelection to reject empty node_key selectors.');
    } catch (error) {
      expect(error).toMatchObject({
        name: 'WorkflowRunExecutionValidationError',
        code: 'WORKFLOW_RUN_SINGLE_NODE_SELECTOR_NOT_EXECUTABLE',
        workflowRunId: runId,
      });
      expect(String((error as Error).message)).toContain('requires a non-empty "nodeKey" value');
    }
  });

  it('validateSingleNodeSelection rejects unsupported selector types', () => {
    const { db, runId } = seedSingleAgentRun();
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () => createProvider([]),
    });

    try {
      executor.validateSingleNodeSelection({
        workflowRunId: runId,
        nodeSelector: {
          type: 'unsupported',
        } as unknown as {
          type: 'next_runnable';
        },
      });
      throw new Error('Expected validateSingleNodeSelection to reject unsupported selector types.');
    } catch (error) {
      expect(error).toMatchObject({
        name: 'WorkflowRunExecutionValidationError',
        code: 'WORKFLOW_RUN_SINGLE_NODE_SELECTOR_NOT_EXECUTABLE',
        workflowRunId: runId,
      });
      expect(String((error as Error).message)).toContain('Unsupported node selector type "unsupported"');
    }
  });

  it('validateSingleNodeSelection rejects node_key selectors targeting non-executable node states', () => {
    const { db, runId, runNodeId } = seedSingleAgentRun();
    transitionWorkflowRunStatus(db, {
      workflowRunId: runId,
      expectedFrom: 'pending',
      to: 'running',
      occurredAt: '2026-01-01T00:00:00.000Z',
    });
    transitionRunNodeStatus(db, {
      runNodeId,
      expectedFrom: 'pending',
      to: 'running',
      occurredAt: '2026-01-01T00:01:00.000Z',
    });

    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () => createProvider([]),
    });

    try {
      executor.validateSingleNodeSelection({
        workflowRunId: runId,
        nodeSelector: {
          type: 'node_key',
          nodeKey: 'design',
        },
      });
      throw new Error('Expected validateSingleNodeSelection to reject node_key selectors for non-executable node states.');
    } catch (error) {
      expect(error).toMatchObject({
        name: 'WorkflowRunExecutionValidationError',
        code: 'WORKFLOW_RUN_SINGLE_NODE_SELECTOR_NOT_EXECUTABLE',
        workflowRunId: runId,
      });
      expect(String((error as Error).message)).toContain('expected status "pending" or "completed" but found "running"');
    }
  });

  it('executeSingleNode returns immediately when run is already terminal', async () => {
    const { db, runId } = seedSingleAgentRun();
    transitionWorkflowRunStatus(db, {
      workflowRunId: runId,
      expectedFrom: 'pending',
      to: 'running',
      occurredAt: '2026-01-01T00:00:00.000Z',
    });
    transitionWorkflowRunStatus(db, {
      workflowRunId: runId,
      expectedFrom: 'running',
      to: 'cancelled',
      occurredAt: '2026-01-01T00:01:00.000Z',
    });

    const resolveProvider = vi.fn(() => createProvider([]));
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider,
    });

    const result = await executor.executeSingleNode({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred',
      },
    });

    expect(result).toMatchObject({
      workflowRunId: runId,
      executedNodes: 0,
      finalStep: {
        outcome: 'run_terminal',
        workflowRunId: runId,
        runStatus: 'cancelled',
      },
    });
    expect(resolveProvider).not.toHaveBeenCalled();
  });

  it('executes all dynamic fan-out children before join and create-pr', async () => {
    const { db, runId, runNodeIdByKey } = seedDynamicFanOutIssue163Run();
    let runInvocation = 0;
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () => ({
        async *run(): AsyncIterable<ProviderEvent> {
          runInvocation += 1;
          switch (runInvocation) {
            case 1:
              yield {
                type: 'result',
                content: 'Issue 163 design completed.',
                timestamp: 10,
              };
              return;
            case 2:
              yield {
                type: 'result',
                content: JSON.stringify({
                  schemaVersion: 1,
                  subtasks: [
                    {
                      nodeKey: 'issue-163-jump-nav-component',
                      title: 'Implement jump navigation component',
                      prompt: 'Implement jump nav component for issue 163.',
                    },
                    {
                      nodeKey: 'issue-163-run-detail-integration',
                      title: 'Integrate jump navigation into run detail view',
                      prompt: 'Integrate jump nav into run detail for issue 163.',
                    },
                    {
                      nodeKey: 'issue-163-e2e-coverage',
                      title: 'Add end-to-end coverage',
                      prompt: 'Add e2e coverage for issue 163 jump nav behavior.',
                    },
                  ],
                }),
                timestamp: 20,
              };
              return;
            case 3:
            case 4:
            case 5:
              yield {
                type: 'result',
                content: `Child work item ${runInvocation - 2} complete.`,
                timestamp: 30 + runInvocation,
              };
              return;
            case 6:
              yield {
                type: 'result',
                content: 'Final review complete.',
                timestamp: 60,
              };
              return;
            case 7:
              yield {
                type: 'result',
                content: 'PR summary complete.',
                timestamp: 70,
              };
              return;
            default:
              throw new Error(`Unexpected provider invocation ${runInvocation}.`);
          }
        },
      }),
    });

    const result = await executor.executeRun({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
      maxSteps: 20,
    });

    expect(result).toEqual({
      workflowRunId: runId,
      executedNodes: 7,
      finalStep: {
        outcome: 'run_terminal',
        workflowRunId: runId,
        runStatus: 'completed',
      },
    });

    const breakdownRunNodeId = runNodeIdByKey.get('breakdown');
    if (!breakdownRunNodeId) {
      throw new Error('Expected breakdown run node to exist.');
    }

    const dynamicChildren = db
      .select({
        nodeKey: runNodes.nodeKey,
        status: runNodes.status,
      })
      .from(runNodes)
      .where(and(eq(runNodes.workflowRunId, runId), eq(runNodes.spawnerNodeId, breakdownRunNodeId)))
      .orderBy(asc(runNodes.sequenceIndex), asc(runNodes.id))
      .all();

    expect(dynamicChildren).toEqual([
      { nodeKey: 'issue-163-jump-nav-component', status: 'completed' },
      { nodeKey: 'issue-163-run-detail-integration', status: 'completed' },
      { nodeKey: 'issue-163-e2e-coverage', status: 'completed' },
    ]);

    const skippedNodeCountRow = db
      .select({
        count: sql<number>`count(*)`,
      })
      .from(runNodes)
      .where(and(eq(runNodes.workflowRunId, runId), eq(runNodes.status, 'skipped')))
      .get();

    expect(skippedNodeCountRow?.count ?? 0).toBe(0);

    const joinBarrier = db
      .select({
        expectedChildren: runJoinBarriers.expectedChildren,
        terminalChildren: runJoinBarriers.terminalChildren,
        completedChildren: runJoinBarriers.completedChildren,
        failedChildren: runJoinBarriers.failedChildren,
        status: runJoinBarriers.status,
      })
      .from(runJoinBarriers)
      .where(eq(runJoinBarriers.workflowRunId, runId))
      .orderBy(asc(runJoinBarriers.id))
      .get();

    expect(joinBarrier).toEqual({
      expectedChildren: 3,
      terminalChildren: 3,
      completedChildren: 3,
      failedChildren: 0,
      status: 'released',
    });

    expect(runInvocation).toBe(7);
  });

  it('routes failed dynamic children to join via terminal edges without failing the run', async () => {
    const { db, runId, runNodeIdByKey } = seedDynamicFanOutIssue163Run();
    let runInvocation = 0;
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () => ({
        async *run(): AsyncIterable<ProviderEvent> {
          runInvocation += 1;
          switch (runInvocation) {
            case 1:
              yield {
                type: 'result',
                content: 'Issue 163 design completed.',
                timestamp: 10,
              };
              return;
            case 2:
              yield {
                type: 'result',
                content: JSON.stringify({
                  schemaVersion: 1,
                  subtasks: [
                    {
                      nodeKey: 'issue-163-jump-nav-component',
                      title: 'Implement jump navigation component',
                      prompt: 'Implement jump nav component for issue 163.',
                    },
                    {
                      nodeKey: 'issue-163-run-detail-integration',
                      title: 'Integrate jump navigation into run detail view',
                      prompt: 'Integrate jump nav into run detail for issue 163.',
                    },
                    {
                      nodeKey: 'issue-163-e2e-coverage',
                      title: 'Add end-to-end coverage',
                      prompt: 'Add e2e coverage for issue 163 jump nav behavior.',
                    },
                  ],
                }),
                timestamp: 20,
              };
              return;
            case 3:
              yield {
                type: 'result',
                content: 'Child work item 1 complete.',
                timestamp: 31,
              };
              return;
            case 4:
              throw new Error('child-work-item-2-failure');
            case 5:
              yield {
                type: 'result',
                content: 'Child work item 3 complete.',
                timestamp: 35,
              };
              return;
            case 6:
              yield {
                type: 'result',
                content: 'Final review complete.',
                timestamp: 60,
              };
              return;
            case 7:
              yield {
                type: 'result',
                content: 'PR summary complete.',
                timestamp: 70,
              };
              return;
            default:
              throw new Error(`Unexpected provider invocation ${runInvocation}.`);
          }
        },
      }),
    });

    const result = await executor.executeRun({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
      maxSteps: 20,
    });

    expect(result).toEqual({
      workflowRunId: runId,
      executedNodes: 7,
      finalStep: {
        outcome: 'run_terminal',
        workflowRunId: runId,
        runStatus: 'completed',
      },
    });

    const breakdownRunNodeId = runNodeIdByKey.get('breakdown');
    if (!breakdownRunNodeId) {
      throw new Error('Expected breakdown run node to exist.');
    }

    const dynamicChildren = db
      .select({
        id: runNodes.id,
        nodeKey: runNodes.nodeKey,
        status: runNodes.status,
      })
      .from(runNodes)
      .where(and(eq(runNodes.workflowRunId, runId), eq(runNodes.spawnerNodeId, breakdownRunNodeId)))
      .orderBy(asc(runNodes.sequenceIndex), asc(runNodes.id))
      .all();

    expect(dynamicChildren.map(child => ({ nodeKey: child.nodeKey, status: child.status }))).toEqual([
      { nodeKey: 'issue-163-jump-nav-component', status: 'completed' },
      { nodeKey: 'issue-163-run-detail-integration', status: 'failed' },
      { nodeKey: 'issue-163-e2e-coverage', status: 'completed' },
    ]);

    const failedChild = dynamicChildren.find(child => child.status === 'failed');
    if (!failedChild) {
      throw new Error('Expected one dynamic child to fail.');
    }

    const failedChildArtifact = db
      .select({
        metadata: phaseArtifacts.metadata,
      })
      .from(phaseArtifacts)
      .where(
        and(
          eq(phaseArtifacts.workflowRunId, runId),
          eq(phaseArtifacts.runNodeId, failedChild.id),
          eq(phaseArtifacts.artifactType, 'log'),
        ),
      )
      .orderBy(asc(phaseArtifacts.id))
      .get();

    expect(
      (
        failedChildArtifact?.metadata as
          | {
              failureRoute?: {
                status?: string;
                targetNodeKey?: string | null;
              };
            }
          | null
          | undefined
      )?.failureRoute,
    ).toMatchObject({
      status: 'selected',
      targetNodeKey: 'final-review',
    });

    const joinBarrier = db
      .select({
        expectedChildren: runJoinBarriers.expectedChildren,
        terminalChildren: runJoinBarriers.terminalChildren,
        completedChildren: runJoinBarriers.completedChildren,
        failedChildren: runJoinBarriers.failedChildren,
        status: runJoinBarriers.status,
      })
      .from(runJoinBarriers)
      .where(eq(runJoinBarriers.workflowRunId, runId))
      .orderBy(asc(runJoinBarriers.id))
      .get();

    expect(joinBarrier).toEqual({
      expectedChildren: 3,
      terminalChildren: 3,
      completedChildren: 2,
      failedChildren: 1,
      status: 'released',
    });

    expect(runInvocation).toBe(7);
  });

  it('retries retry-control precondition conflicts and keeps retried node ids unique per run node', async () => {
    const { db, runId, firstRunNodeId, secondRunNodeId } = seedTwoRootAgentRun();
    transitionWorkflowRunStatus(db, {
      workflowRunId: runId,
      expectedFrom: 'pending',
      to: 'running',
      occurredAt: '2026-01-01T00:00:00.000Z',
    });
    for (const [index, runNodeId] of [firstRunNodeId, secondRunNodeId].entries()) {
      transitionRunNodeStatus(db, {
        runNodeId,
        expectedFrom: 'pending',
        to: 'running',
        occurredAt: `2026-01-01T00:0${index + 1}:00.000Z`,
      });
      transitionRunNodeStatus(db, {
        runNodeId,
        expectedFrom: 'running',
        to: 'failed',
        occurredAt: `2026-01-01T00:1${index + 1}:00.000Z`,
      });
    }
    transitionWorkflowRunStatus(db, {
      workflowRunId: runId,
      expectedFrom: 'running',
      to: 'failed',
      occurredAt: '2026-01-01T00:20:00.000Z',
    });

    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () => createProvider([]),
    });

    const retryResult = await executor.retryRun({
      workflowRunId: runId,
    });
    expect(retryResult.retriedRunNodeIds).toEqual([firstRunNodeId, secondRunNodeId]);
    expect(new Set(retryResult.retriedRunNodeIds).size).toBe(retryResult.retriedRunNodeIds.length);

    for (const [index, runNodeId] of [firstRunNodeId, secondRunNodeId].entries()) {
      transitionRunNodeStatus(db, {
        runNodeId,
        expectedFrom: 'pending',
        to: 'running',
        occurredAt: `2026-01-01T00:2${index + 1}:00.000Z`,
      });
      transitionRunNodeStatus(db, {
        runNodeId,
        expectedFrom: 'running',
        to: 'failed',
        occurredAt: `2026-01-01T00:3${index + 1}:00.000Z`,
      });
    }
    transitionWorkflowRunStatus(db, {
      workflowRunId: runId,
      expectedFrom: 'running',
      to: 'failed',
      occurredAt: '2026-01-01T00:40:00.000Z',
    });
    const transactionSpy = vi.spyOn(db, 'transaction').mockImplementation(() => {
      throw new Error(`Workflow-run retry control precondition failed for id=${runId}; expected status "failed".`);
    });
    try {
      await expect(
        executor.retryRun({
          workflowRunId: runId,
        }),
      ).rejects.toMatchObject({
        name: 'WorkflowRunControlError',
        code: 'WORKFLOW_RUN_CONTROL_CONCURRENT_CONFLICT',
        action: 'retry',
        workflowRunId: runId,
        runStatus: 'failed',
      });
    } finally {
      transactionSpy.mockRestore();
    }
  });
});
