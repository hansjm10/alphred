import { and, asc, eq, sql } from 'drizzle-orm';
import {
  createDatabase,
  guardDefinitions,
  materializeWorkflowRunFromTree,
  migrateDatabase,
  promptTemplates,
  runJoinBarriers,
  runNodeEdges,
  runNodes,
  treeEdges,
  treeNodes,
  workflowTrees,
} from '@alphred/db';
import type { GuardExpression, ProviderEvent, ProviderRunOptions } from '@alphred/shared';
import { describe, expect, it } from 'vitest';
import { createSqlWorkflowExecutor } from './index.js';

type TestDatabase = ReturnType<typeof createDatabase>;

type TopologyNode = {
  nodeKey: string;
  sequenceIndex: number;
  nodeRole?: 'standard' | 'spawner' | 'join';
  nodeType?: 'agent' | 'human' | 'tool';
  provider?: 'codex' | 'claude';
  maxChildren?: number;
  maxRetries?: number;
};

type TopologyEdge = {
  sourceNodeKey: string;
  targetNodeKey: string;
  routeOn?: 'success' | 'failure';
  auto?: boolean;
  priority?: number;
  guard?: {
    guardKey: string;
    expression: GuardExpression;
  };
};

type TopologyDefinition = {
  treeKey: string;
  name: string;
  nodes: readonly TopologyNode[];
  edges: readonly TopologyEdge[];
};

type ScenarioRun = {
  db: TestDatabase;
  runId: number;
  runNodeIdByKey: Map<string, number>;
};

type NodeScriptAction =
  | {
      kind: 'result';
      content: string;
      metadata?: ProviderEvent['metadata'];
    }
  | {
      kind: 'error';
      message: string;
    };

type ScriptedProvider = {
  resolveProvider: () => {
    run: (prompt: string, options: ProviderRunOptions) => AsyncIterable<ProviderEvent>;
  };
  invocations: { nodeKey: string; attempt: number }[];
};

function createSpawnerJoinTopology(params: {
  treeKey: string;
  maxChildren?: number;
  spawnerMaxRetries?: number;
}): TopologyDefinition {
  return {
    treeKey: params.treeKey,
    name: `${params.treeKey} workflow simulation`,
    nodes: [
      {
        nodeKey: 'design',
        sequenceIndex: 10,
      },
      {
        nodeKey: 'breakdown',
        sequenceIndex: 20,
        nodeRole: 'spawner',
        maxChildren: params.maxChildren ?? 8,
        maxRetries: params.spawnerMaxRetries ?? 0,
      },
      {
        nodeKey: 'final-review',
        sequenceIndex: 30,
        nodeRole: 'join',
      },
      {
        nodeKey: 'create-pr',
        sequenceIndex: 40,
      },
    ],
    edges: [
      {
        sourceNodeKey: 'design',
        targetNodeKey: 'breakdown',
        routeOn: 'success',
        auto: true,
        priority: 0,
      },
      {
        sourceNodeKey: 'breakdown',
        targetNodeKey: 'final-review',
        routeOn: 'success',
        auto: true,
        priority: 0,
      },
      {
        sourceNodeKey: 'final-review',
        targetNodeKey: 'create-pr',
        routeOn: 'success',
        auto: true,
        priority: 0,
      },
    ],
  };
}

function createScenarioRun(topology: TopologyDefinition): ScenarioRun {
  const db = createDatabase(':memory:');
  migrateDatabase(db);

  const tree = db
    .insert(workflowTrees)
    .values({
      treeKey: topology.treeKey,
      version: 1,
      name: topology.name,
    })
    .returning({ id: workflowTrees.id })
    .get();

  const promptTemplateIdByNodeKey = new Map<string, number>();
  for (const node of topology.nodes) {
    const prompt = db
      .insert(promptTemplates)
      .values({
        templateKey: `${topology.treeKey}_${node.nodeKey}_prompt`,
        version: 1,
        content: `Prompt for ${node.nodeKey}`,
        contentType: 'markdown',
      })
      .returning({ id: promptTemplates.id })
      .get();
    promptTemplateIdByNodeKey.set(node.nodeKey, prompt.id);
  }

  const insertedNodes = db
    .insert(treeNodes)
    .values(
      topology.nodes.map(node => {
        const promptTemplateId = promptTemplateIdByNodeKey.get(node.nodeKey);
        if (!promptTemplateId) {
          throw new Error(`Missing prompt template id for node "${node.nodeKey}".`);
        }

        return {
          workflowTreeId: tree.id,
          nodeKey: node.nodeKey,
          nodeRole: node.nodeRole ?? 'standard',
          nodeType: node.nodeType ?? 'agent',
          provider: node.provider ?? 'codex',
          promptTemplateId,
          sequenceIndex: node.sequenceIndex,
          maxChildren: node.maxChildren ?? 12,
          maxRetries: node.maxRetries ?? 0,
        };
      }),
    )
    .returning({
      id: treeNodes.id,
      nodeKey: treeNodes.nodeKey,
    })
    .all();

  const treeNodeIdByKey = new Map(insertedNodes.map(node => [node.nodeKey, node.id]));
  const guardIdByKey = new Map<string, number>();
  for (const edge of topology.edges) {
    const sourceNodeId = treeNodeIdByKey.get(edge.sourceNodeKey);
    const targetNodeId = treeNodeIdByKey.get(edge.targetNodeKey);
    if (!sourceNodeId || !targetNodeId) {
      throw new Error(
        `Missing source/target tree node id for edge "${edge.sourceNodeKey}" -> "${edge.targetNodeKey}".`,
      );
    }

    let guardDefinitionId: number | null = null;
    if (edge.guard) {
      const existingGuardDefinitionId = guardIdByKey.get(edge.guard.guardKey);
      if (existingGuardDefinitionId) {
        guardDefinitionId = existingGuardDefinitionId;
      } else {
        const insertedGuard = db
          .insert(guardDefinitions)
          .values({
            guardKey: edge.guard.guardKey,
            version: 1,
            expression: edge.guard.expression,
          })
          .returning({ id: guardDefinitions.id })
          .get();
        guardDefinitionId = insertedGuard.id;
        guardIdByKey.set(edge.guard.guardKey, insertedGuard.id);
      }
    }

    db.insert(treeEdges)
      .values({
        workflowTreeId: tree.id,
        sourceNodeId,
        targetNodeId,
        routeOn: edge.routeOn ?? 'success',
        priority: edge.priority ?? 0,
        auto: edge.auto === false ? 0 : 1,
        guardDefinitionId,
      })
      .run();
  }

  const materialized = materializeWorkflowRunFromTree(db, {
    treeKey: topology.treeKey,
  });
  const runNodeRows = db
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
    runNodeIdByKey: new Map(runNodeRows.map(node => [node.nodeKey, node.id])),
  };
}

function createScriptedProvider(params: {
  db: TestDatabase;
  runId: number;
  scriptsByNodeKey: Record<string, readonly NodeScriptAction[]>;
}): ScriptedProvider {
  let timestamp = 0;
  const invocations: { nodeKey: string; attempt: number }[] = [];

  function resolveScriptedAction(nodeKey: string, attempt: number): NodeScriptAction {
    const actions = params.scriptsByNodeKey[nodeKey];
    if (!actions || actions.length === 0) {
      throw new Error(`No scripted provider action configured for node "${nodeKey}".`);
    }
    const action = actions[attempt - 1] ?? actions[actions.length - 1];
    if (!action) {
      throw new Error(`No scripted action resolved for node "${nodeKey}" attempt ${attempt}.`);
    }

    return action;
  }

  return {
    resolveProvider: () => ({
      async *run(prompt: string, _options: ProviderRunOptions): AsyncIterable<ProviderEvent> {
        if (prompt.startsWith('Analyze the following node execution failure.')) {
          timestamp += 1;
          yield {
            type: 'result',
            content: 'Retry summary generated.',
            timestamp,
          };
          return;
        }

        const runningNode = params.db
          .select({
            nodeKey: runNodes.nodeKey,
            attempt: runNodes.attempt,
          })
          .from(runNodes)
          .where(and(eq(runNodes.workflowRunId, params.runId), eq(runNodes.status, 'running')))
          .orderBy(asc(runNodes.sequenceIndex), asc(runNodes.id))
          .get();
        if (!runningNode) {
          throw new Error('Expected one running node while provider invocation is in flight.');
        }

        invocations.push({
          nodeKey: runningNode.nodeKey,
          attempt: runningNode.attempt,
        });

        const action = resolveScriptedAction(runningNode.nodeKey, runningNode.attempt);
        if (action.kind === 'error') {
          throw new Error(action.message);
        }

        timestamp += 1;
        yield {
          type: 'result',
          content: action.content,
          timestamp,
          metadata: action.metadata,
        };
      },
    }),
    invocations,
  };
}

function spawnerPayload(
  subtasks: readonly {
    nodeKey: string;
    title: string;
    prompt: string;
  }[],
): string {
  return JSON.stringify({
    schemaVersion: 1,
    subtasks,
  });
}

function loadNodeStatusByKey(db: TestDatabase, runId: number): Record<string, string> {
  const rows = db
    .select({
      nodeKey: runNodes.nodeKey,
      status: runNodes.status,
    })
    .from(runNodes)
    .where(eq(runNodes.workflowRunId, runId))
    .all();

  return Object.fromEntries(rows.map(row => [row.nodeKey, row.status]));
}

function loadSkippedNodeKeys(db: TestDatabase, runId: number): string[] {
  const rows = db
    .select({
      nodeKey: runNodes.nodeKey,
    })
    .from(runNodes)
    .where(and(eq(runNodes.workflowRunId, runId), eq(runNodes.status, 'skipped')))
    .orderBy(asc(runNodes.nodeKey))
    .all();

  return rows.map(row => row.nodeKey);
}

function loadBarrier(db: TestDatabase, runId: number) {
  return db
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
}

describe('workflow simulation invariants', () => {
  it('simulates linear A->B->C execution without unexpected skips', async () => {
    const { db, runId } = createScenarioRun({
      treeKey: 'sim_linear_abc',
      name: 'Simulation Linear A B C',
      nodes: [
        { nodeKey: 'a', sequenceIndex: 10 },
        { nodeKey: 'b', sequenceIndex: 20 },
        { nodeKey: 'c', sequenceIndex: 30 },
      ],
      edges: [
        { sourceNodeKey: 'a', targetNodeKey: 'b', routeOn: 'success', auto: true, priority: 0 },
        { sourceNodeKey: 'b', targetNodeKey: 'c', routeOn: 'success', auto: true, priority: 0 },
      ],
    });
    const scriptedProvider = createScriptedProvider({
      db,
      runId,
      scriptsByNodeKey: {
        a: [{ kind: 'result', content: 'A complete.' }],
        b: [{ kind: 'result', content: 'B complete.' }],
        c: [{ kind: 'result', content: 'C complete.' }],
      },
    });

    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: scriptedProvider.resolveProvider,
    });
    const result = await executor.executeRun({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
      maxSteps: 10,
    });

    expect(result).toMatchObject({
      workflowRunId: runId,
      executedNodes: 3,
      finalStep: {
        outcome: 'run_terminal',
        workflowRunId: runId,
        runStatus: 'completed',
      },
    });
    expect(scriptedProvider.invocations.map(invocation => invocation.nodeKey)).toEqual(['a', 'b', 'c']);
    expect(loadNodeStatusByKey(db, runId)).toEqual({
      a: 'completed',
      b: 'completed',
      c: 'completed',
    });
    expect(loadSkippedNodeKeys(db, runId)).toEqual([]);
  });

  it('simulates guarded + auto success routing with a failure edge and skips only unreachable branches', async () => {
    const { db, runId } = createScenarioRun({
      treeKey: 'sim_conditional_routes',
      name: 'Simulation Conditional Routing',
      nodes: [
        { nodeKey: 'review', sequenceIndex: 10 },
        { nodeKey: 'approved', sequenceIndex: 20 },
        { nodeKey: 'fallback', sequenceIndex: 30 },
        { nodeKey: 'failure', sequenceIndex: 40 },
        { nodeKey: 'done', sequenceIndex: 50 },
      ],
      edges: [
        {
          sourceNodeKey: 'review',
          targetNodeKey: 'approved',
          routeOn: 'success',
          auto: false,
          priority: 0,
          guard: {
            guardKey: 'sim_conditional_routes_approved',
            expression: {
              field: 'decision',
              operator: '==',
              value: 'approved',
            },
          },
        },
        {
          sourceNodeKey: 'review',
          targetNodeKey: 'fallback',
          routeOn: 'success',
          auto: true,
          priority: 1,
        },
        {
          sourceNodeKey: 'review',
          targetNodeKey: 'failure',
          routeOn: 'failure',
          auto: true,
          priority: 0,
        },
        {
          sourceNodeKey: 'approved',
          targetNodeKey: 'done',
          routeOn: 'success',
          auto: true,
          priority: 0,
        },
        {
          sourceNodeKey: 'fallback',
          targetNodeKey: 'done',
          routeOn: 'success',
          auto: true,
          priority: 0,
        },
        {
          sourceNodeKey: 'failure',
          targetNodeKey: 'done',
          routeOn: 'success',
          auto: true,
          priority: 0,
        },
      ],
    });
    const scriptedProvider = createScriptedProvider({
      db,
      runId,
      scriptsByNodeKey: {
        review: [
          {
            kind: 'result',
            content: 'Review complete.',
            metadata: {
              routingDecision: 'approved',
            },
          },
        ],
        approved: [{ kind: 'result', content: 'Approved path complete.' }],
        done: [{ kind: 'result', content: 'Done complete.' }],
      },
    });

    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: scriptedProvider.resolveProvider,
    });
    const result = await executor.executeRun({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
      maxSteps: 10,
    });

    expect(result).toMatchObject({
      workflowRunId: runId,
      executedNodes: 3,
      finalStep: {
        outcome: 'run_terminal',
        workflowRunId: runId,
        runStatus: 'completed',
      },
    });
    expect(scriptedProvider.invocations.map(invocation => invocation.nodeKey)).toEqual(['review', 'approved', 'done']);
    expect(loadNodeStatusByKey(db, runId)).toEqual({
      review: 'completed',
      approved: 'completed',
      fallback: 'skipped',
      failure: 'skipped',
      done: 'completed',
    });
    expect(loadSkippedNodeKeys(db, runId)).toEqual(['failure', 'fallback']);
  });

  it('simulates dynamic fan-out/fan-in and keeps join blocked until all spawned children are terminal', async () => {
    const topology = createSpawnerJoinTopology({
      treeKey: 'sim_dynamic_fanout_baseline',
    });
    const { db, runId, runNodeIdByKey } = createScenarioRun(topology);
    const breakdownRunNodeId = runNodeIdByKey.get('breakdown');
    if (!breakdownRunNodeId) {
      throw new Error('Expected breakdown run node id to be present.');
    }

    const scriptedProvider = createScriptedProvider({
      db,
      runId,
      scriptsByNodeKey: {
        design: [{ kind: 'result', content: 'Design complete.' }],
        breakdown: [
          {
            kind: 'result',
            content: spawnerPayload([
              { nodeKey: 'child-a', title: 'Child A', prompt: 'Implement child A' },
              { nodeKey: 'child-b', title: 'Child B', prompt: 'Implement child B' },
              { nodeKey: 'child-c', title: 'Child C', prompt: 'Implement child C' },
            ]),
          },
        ],
        'child-a': [{ kind: 'result', content: 'Child A complete.' }],
        'child-b': [{ kind: 'result', content: 'Child B complete.' }],
        'child-c': [{ kind: 'result', content: 'Child C complete.' }],
        'final-review': [{ kind: 'result', content: 'Final review complete.' }],
        'create-pr': [{ kind: 'result', content: 'Create PR complete.' }],
      },
    });

    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: scriptedProvider.resolveProvider,
    });

    const firstStep = await executor.executeNextRunnableNode({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });
    expect(firstStep).toMatchObject({
      outcome: 'executed',
      nodeKey: 'design',
      runNodeStatus: 'completed',
    });

    const secondStep = await executor.executeNextRunnableNode({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });
    expect(secondStep).toMatchObject({
      outcome: 'executed',
      nodeKey: 'breakdown',
      runNodeStatus: 'completed',
    });

    const dynamicEdgeCount = db
      .select({
        count: sql<number>`count(*)`,
      })
      .from(runNodeEdges)
      .where(
        and(
          eq(runNodeEdges.workflowRunId, runId),
          eq(runNodeEdges.sourceRunNodeId, breakdownRunNodeId),
          eq(runNodeEdges.edgeKind, 'dynamic_spawner_to_child'),
        ),
      )
      .get();
    expect(dynamicEdgeCount?.count ?? 0).toBe(3);

    const pendingBarrier = loadBarrier(db, runId);
    expect(pendingBarrier).toEqual({
      expectedChildren: 3,
      terminalChildren: 0,
      completedChildren: 0,
      failedChildren: 0,
      status: 'pending',
    });

    const childStepA = await executor.executeNextRunnableNode({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });
    const childStepB = await executor.executeNextRunnableNode({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });
    const childStepC = await executor.executeNextRunnableNode({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect([childStepA, childStepB, childStepC].map(step => (step as { nodeKey?: string }).nodeKey)).toEqual([
      'child-a',
      'child-b',
      'child-c',
    ]);

    const readyBarrier = loadBarrier(db, runId);
    expect(readyBarrier).toEqual({
      expectedChildren: 3,
      terminalChildren: 3,
      completedChildren: 3,
      failedChildren: 0,
      status: 'ready',
    });

    const joinStep = await executor.executeNextRunnableNode({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });
    expect(joinStep).toMatchObject({
      outcome: 'executed',
      nodeKey: 'final-review',
      runNodeStatus: 'completed',
    });

    const releasedBarrier = loadBarrier(db, runId);
    expect(releasedBarrier).toEqual({
      expectedChildren: 3,
      terminalChildren: 3,
      completedChildren: 3,
      failedChildren: 0,
      status: 'released',
    });

    const createPrStep = await executor.executeNextRunnableNode({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });
    expect(createPrStep).toMatchObject({
      outcome: 'executed',
      nodeKey: 'create-pr',
      runNodeStatus: 'completed',
    });

    const terminalStep = await executor.executeNextRunnableNode({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });
    expect(terminalStep).toMatchObject({
      outcome: 'run_terminal',
      workflowRunId: runId,
      runStatus: 'completed',
    });

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
      { nodeKey: 'child-a', status: 'completed' },
      { nodeKey: 'child-b', status: 'completed' },
      { nodeKey: 'child-c', status: 'completed' },
    ]);
    expect(loadSkippedNodeKeys(db, runId)).toEqual([]);
    expect(scriptedProvider.invocations.map(invocation => invocation.nodeKey)).toEqual([
      'design',
      'breakdown',
      'child-a',
      'child-b',
      'child-c',
      'final-review',
      'create-pr',
    ]);
  });

  it('simulates N=0 fan-out children with immediate join readiness', async () => {
    const { db, runId, runNodeIdByKey } = createScenarioRun(
      createSpawnerJoinTopology({
        treeKey: 'sim_dynamic_fanout_zero_children',
      }),
    );
    const breakdownRunNodeId = runNodeIdByKey.get('breakdown');
    if (!breakdownRunNodeId) {
      throw new Error('Expected breakdown run node id to be present.');
    }

    const scriptedProvider = createScriptedProvider({
      db,
      runId,
      scriptsByNodeKey: {
        design: [{ kind: 'result', content: 'Design complete.' }],
        breakdown: [{ kind: 'result', content: spawnerPayload([]) }],
        'final-review': [{ kind: 'result', content: 'Final review complete.' }],
        'create-pr': [{ kind: 'result', content: 'Create PR complete.' }],
      },
    });

    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: scriptedProvider.resolveProvider,
    });
    const result = await executor.executeRun({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
      maxSteps: 10,
    });

    expect(result).toMatchObject({
      workflowRunId: runId,
      executedNodes: 4,
      finalStep: {
        outcome: 'run_terminal',
        workflowRunId: runId,
        runStatus: 'completed',
      },
    });
    expect(scriptedProvider.invocations.map(invocation => invocation.nodeKey)).toEqual([
      'design',
      'breakdown',
      'final-review',
      'create-pr',
    ]);

    const dynamicChildCount = db
      .select({
        count: sql<number>`count(*)`,
      })
      .from(runNodes)
      .where(and(eq(runNodes.workflowRunId, runId), eq(runNodes.spawnerNodeId, breakdownRunNodeId)))
      .get();
    expect(dynamicChildCount?.count ?? 0).toBe(0);

    expect(loadBarrier(db, runId)).toEqual({
      expectedChildren: 0,
      terminalChildren: 0,
      completedChildren: 0,
      failedChildren: 0,
      status: 'released',
    });
    expect(loadSkippedNodeKeys(db, runId)).toEqual([]);
  });

  it('simulates fan-out child retry interaction and preserves join barrier accounting', async () => {
    const { db, runId } = createScenarioRun(
      createSpawnerJoinTopology({
        treeKey: 'sim_dynamic_fanout_retry_interaction',
        spawnerMaxRetries: 1,
      }),
    );

    const scriptedProvider = createScriptedProvider({
      db,
      runId,
      scriptsByNodeKey: {
        design: [{ kind: 'result', content: 'Design complete.' }],
        breakdown: [
          {
            kind: 'result',
            content: spawnerPayload([
              { nodeKey: 'child-retry', title: 'Retry Child', prompt: 'Retry child prompt' },
              { nodeKey: 'child-steady', title: 'Steady Child', prompt: 'Steady child prompt' },
            ]),
          },
        ],
        'child-retry': [
          { kind: 'error', message: 'child-retry-first-attempt-failure' },
          { kind: 'result', content: 'Child retry recovered.' },
        ],
        'child-steady': [{ kind: 'result', content: 'Child steady complete.' }],
        'final-review': [{ kind: 'result', content: 'Final review complete.' }],
        'create-pr': [{ kind: 'result', content: 'Create PR complete.' }],
      },
    });

    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: scriptedProvider.resolveProvider,
    });
    const result = await executor.executeRun({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
      maxSteps: 20,
    });

    expect(result.finalStep).toEqual({
      outcome: 'run_terminal',
      workflowRunId: runId,
      runStatus: 'completed',
    });

    const retryChild = db
      .select({
        status: runNodes.status,
        attempt: runNodes.attempt,
      })
      .from(runNodes)
      .where(and(eq(runNodes.workflowRunId, runId), eq(runNodes.nodeKey, 'child-retry')))
      .get();
    expect(retryChild).toEqual({
      status: 'completed',
      attempt: 2,
    });

    const steadyChild = db
      .select({
        status: runNodes.status,
        attempt: runNodes.attempt,
      })
      .from(runNodes)
      .where(and(eq(runNodes.workflowRunId, runId), eq(runNodes.nodeKey, 'child-steady')))
      .get();
    expect(steadyChild).toEqual({
      status: 'completed',
      attempt: 1,
    });

    expect(loadBarrier(db, runId)).toEqual({
      expectedChildren: 2,
      terminalChildren: 2,
      completedChildren: 2,
      failedChildren: 0,
      status: 'released',
    });
    expect(loadSkippedNodeKeys(db, runId)).toEqual([]);

    const retryInvocationCount = scriptedProvider.invocations.filter(
      invocation => invocation.nodeKey === 'child-retry',
    );
    expect(retryInvocationCount).toEqual([
      { nodeKey: 'child-retry', attempt: 1 },
      { nodeKey: 'child-retry', attempt: 2 },
    ]);

    const joinInvocationIndex = scriptedProvider.invocations.findIndex(
      invocation => invocation.nodeKey === 'final-review',
    );
    const latestChildInvocationIndex = scriptedProvider.invocations.reduce((maxIndex, invocation, index) => {
      if (invocation.nodeKey === 'child-retry' || invocation.nodeKey === 'child-steady') {
        return Math.max(maxIndex, index);
      }

      return maxIndex;
    }, -1);
    expect(joinInvocationIndex).toBeGreaterThan(latestChildInvocationIndex);
  });
});
