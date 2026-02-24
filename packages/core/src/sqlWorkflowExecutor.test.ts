import { execFile } from 'node:child_process';
import { access, mkdtemp, rename, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { ProviderEvent, ProviderRunOptions } from '@alphred/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  createDatabase,
  guardDefinitions,
  materializeWorkflowRunFromTree,
  migrateDatabase,
  phaseArtifacts,
  promptTemplates,
  runNodeDiagnostics,
  runNodes,
  routingDecisions,
  transitionRunNodeStatus,
  transitionWorkflowRunStatus,
  treeEdges,
  treeNodes,
  workflowRuns,
  workflowTrees,
} from '@alphred/db';
import { createSqlWorkflowExecutor } from './sqlWorkflowExecutor.js';

const coreSourceDirectory = fileURLToPath(new URL('.', import.meta.url));
const corePackageRoot = resolve(coreSourceDirectory, '..');
const workspaceRoot = resolve(corePackageRoot, '../..');
const execFileAsync = promisify(execFile);

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
      content: 'Produce route decision',
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
    expect(payload.summary.eventCount).toBe(0);
    expect(payload.summary.droppedEventCount).toBe(0);
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

    expect(artifacts).toHaveLength(2);
    expect(artifacts[0]).toEqual({
      artifactType: 'log',
      metadata: expect.objectContaining({
        failureReason: 'retry_scheduled',
        attempt: 1,
        maxRetries: 1,
      }),
    });
    expect(artifacts[1]).toEqual({
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
      }),
    });
  });

  it('retries up to max_retries and succeeds on the final allowed retry attempt', async () => {
    const { db, runId, runNodeId } = seedSingleAgentRun('markdown', 2);
    let invocation = 0;
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () => ({
        async *run(): AsyncIterable<ProviderEvent> {
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

    expect(artifacts).toHaveLength(3);
    expect(artifacts[0]).toEqual({
      artifactType: 'log',
      metadata: expect.objectContaining({
        failureReason: 'retry_scheduled',
        attempt: 1,
        maxRetries: 2,
      }),
    });
    expect(artifacts[1]).toEqual({
      artifactType: 'log',
      metadata: expect.objectContaining({
        failureReason: 'retry_scheduled',
        attempt: 2,
        maxRetries: 2,
      }),
    });
    expect(artifacts[2]).toEqual({
      artifactType: 'report',
      metadata: expect.objectContaining({
        attempt: 3,
        maxRetries: 2,
        retriesUsed: 2,
      }),
    });
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
    db.update(guardDefinitions)
      .set({
        expression: {
          logic: 'and',
          conditions: 'invalid',
        },
      })
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
        id: treeEdges.id,
      })
      .from(treeEdges)
      .where(eq(treeEdges.priority, 1))
      .get();
    if (!fallbackEdge) {
      throw new Error('Expected fallback edge row.');
    }

    db.update(treeEdges)
      .set({
        auto: 1,
        guardDefinitionId: null,
      })
      .where(eq(treeEdges.id, fallbackEdge.id))
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
        async *run(): AsyncIterable<ProviderEvent> {
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
});
