import { resolve } from 'node:path';
import { NextResponse } from 'next/server';
import {
  createDatabase,
  migrateDatabase,
  phaseArtifacts,
  runNodeDiagnostics,
  runNodeStreamEvents,
  runNodes,
  routingDecisions,
  treeNodes,
  transitionRunNodeStatus,
  transitionWorkflowRunStatus,
  workflowRuns,
  workflowTrees,
  type AlphredDatabase,
} from '@alphred/db';
import { canServeTestRoutes } from '../test-routes-gate';

export const dynamic = 'force-dynamic';

type LifecycleFixturePayload = {
  runningRunId: number;
  pausedRunId: number;
  failedRunId: number;
  failedRunNodeId: number;
};

type FixtureRunState = 'running' | 'paused' | 'failed';

function resolveDatabasePath(environment: NodeJS.ProcessEnv, cwd: string): string {
  const configuredPath = environment.ALPHRED_DB_PATH?.trim();
  if (configuredPath && configuredPath.length > 0) {
    return resolve(cwd, configuredPath);
  }

  return resolve(cwd, 'alphred.db');
}

function timestamp(baseMs: number, offsetMs: number): string {
  return new Date(baseMs + offsetMs).toISOString();
}

function insertFixtureTree(db: AlphredDatabase, baseMs: number): {
  treeId: number;
  treeNodeId: number;
} {
  const suffix = `${baseMs}`;
  const tree = db
    .insert(workflowTrees)
    .values({
      treeKey: `e2e-lifecycle-controls-${suffix}`,
      version: 1,
      name: `E2E lifecycle controls ${suffix}`,
      description: 'Deterministic run lifecycle fixtures for Playwright e2e tests.',
      createdAt: timestamp(baseMs, 0),
      updatedAt: timestamp(baseMs, 0),
    })
    .returning({
      id: workflowTrees.id,
    })
    .get();

  const node = db
    .insert(treeNodes)
    .values({
      workflowTreeId: tree.id,
      nodeKey: 'design',
      nodeType: 'agent',
      provider: 'codex',
      model: 'gpt-5.3-codex',
      promptTemplateId: null,
      maxRetries: 0,
      sequenceIndex: 0,
      createdAt: timestamp(baseMs, 0),
      updatedAt: timestamp(baseMs, 0),
    })
    .returning({
      id: treeNodes.id,
    })
    .get();

  return {
    treeId: tree.id,
    treeNodeId: node.id,
  };
}

function transitionFixtureRunToRunning(params: {
  db: AlphredDatabase;
  runId: number;
  runNodeId: number;
  baseMs: number;
}): void {
  const { db, runId, runNodeId, baseMs } = params;
  const startedAt = timestamp(baseMs, 1000);

  transitionWorkflowRunStatus(db, {
    workflowRunId: runId,
    expectedFrom: 'pending',
    to: 'running',
    occurredAt: startedAt,
  });
  transitionRunNodeStatus(db, {
    runNodeId,
    expectedFrom: 'pending',
    to: 'running',
    occurredAt: startedAt,
  });
}

function transitionFixtureRunToTerminalState(params: {
  db: AlphredDatabase;
  runId: number;
  runNodeId: number;
  baseMs: number;
  nodeStatus: 'completed' | 'failed';
  runStatus: 'paused' | 'failed';
}): void {
  const { db, runId, runNodeId, baseMs, nodeStatus, runStatus } = params;
  transitionRunNodeStatus(db, {
    runNodeId,
    expectedFrom: 'running',
    to: nodeStatus,
    occurredAt: timestamp(baseMs, 2000),
  });
  transitionWorkflowRunStatus(db, {
    workflowRunId: runId,
    expectedFrom: 'running',
    to: runStatus,
    occurredAt: timestamp(baseMs, 3000),
  });
}

function insertFixtureRun(params: {
  db: AlphredDatabase;
  treeId: number;
  treeNodeId: number;
  baseMs: number;
  state: FixtureRunState;
}): {
  runId: number;
  runNodeId: number;
} {
  const { db, treeId, treeNodeId, baseMs, state } = params;
  const run = db
    .insert(workflowRuns)
    .values({
      workflowTreeId: treeId,
      status: 'pending',
      startedAt: null,
      completedAt: null,
      createdAt: timestamp(baseMs, 0),
      updatedAt: timestamp(baseMs, 0),
    })
    .returning({
      id: workflowRuns.id,
    })
    .get();

  const runNode = db
    .insert(runNodes)
    .values({
      workflowRunId: run.id,
      treeNodeId,
      nodeKey: 'design',
      status: 'pending',
      sequenceIndex: 0,
      attempt: 1,
      startedAt: null,
      completedAt: null,
      createdAt: timestamp(baseMs, 0),
      updatedAt: timestamp(baseMs, 0),
    })
    .returning({
      id: runNodes.id,
    })
    .get();

  transitionFixtureRunToRunning({
    db,
    runId: run.id,
    runNodeId: runNode.id,
    baseMs,
  });

  if (state === 'paused') {
    transitionFixtureRunToTerminalState({
      db,
      runId: run.id,
      runNodeId: runNode.id,
      baseMs,
      nodeStatus: 'completed',
      runStatus: 'paused',
    });
  }

  if (state === 'failed') {
    transitionFixtureRunToTerminalState({
      db,
      runId: run.id,
      runNodeId: runNode.id,
      baseMs,
      nodeStatus: 'failed',
      runStatus: 'failed',
    });

    db.insert(runNodeDiagnostics)
      .values({
        workflowRunId: run.id,
        runNodeId: runNode.id,
        attempt: 1,
        outcome: 'failed',
        eventCount: 3,
        retainedEventCount: 3,
        droppedEventCount: 0,
        redacted: 0,
        truncated: 0,
        payloadChars: 420,
        diagnostics: {
          schemaVersion: 1,
          workflowRunId: run.id,
          runNodeId: runNode.id,
          nodeKey: 'design',
          attempt: 1,
          outcome: 'failed',
          status: 'failed',
          provider: 'codex',
          timing: {
            queuedAt: timestamp(baseMs, 0),
            startedAt: timestamp(baseMs, 1000),
            completedAt: null,
            failedAt: timestamp(baseMs, 2000),
            persistedAt: timestamp(baseMs, 3500),
          },
          summary: {
            tokensUsed: 0,
            eventCount: 3,
            retainedEventCount: 3,
            droppedEventCount: 0,
            toolEventCount: 0,
            redacted: false,
            truncated: false,
          },
          contextHandoff: {},
          eventTypeCounts: {
            system: 1,
            result: 1,
          },
          events: [],
          toolEvents: [],
          routingDecision: null,
          error: {
            code: 'E2E_FIXTURE_FAILURE',
            message: 'Synthetic failed attempt for retry flow coverage.',
          },
        },
        createdAt: timestamp(baseMs, 3500),
      })
      .run();

    db.insert(runNodeStreamEvents)
      .values([
        {
          workflowRunId: run.id,
          runNodeId: runNode.id,
          attempt: 1,
          sequence: 1,
          eventType: 'system',
          timestamp: 100,
          contentChars: 8,
          contentPreview: 'starting',
          metadata: { channel: 'fixture' },
          usageDeltaTokens: null,
          usageCumulativeTokens: null,
          createdAt: timestamp(baseMs, 1200),
        },
        {
          workflowRunId: run.id,
          runNodeId: runNode.id,
          attempt: 1,
          sequence: 2,
          eventType: 'result',
          timestamp: 101,
          contentChars: 14,
          contentPreview: 'fixture failed',
          metadata: null,
          usageDeltaTokens: null,
          usageCumulativeTokens: null,
          createdAt: timestamp(baseMs, 2000),
        },
      ])
      .run();

    const artifactRows = Array.from({ length: 10 }, (_, index) => ({
      workflowRunId: run.id,
      runNodeId: runNode.id,
      artifactType: index % 2 === 0 ? 'report' : 'note',
      contentType: index % 3 === 0 ? 'markdown' : 'text',
      content: `Fixture artifact ${index + 1}: ${'Long observability payload '.repeat(10)}`.trim(),
      metadata: {
        source: 'e2e-lifecycle-fixture',
        ordinal: index + 1,
      },
      createdAt: timestamp(baseMs, 3600 + index * 30),
    }));
    db.insert(phaseArtifacts).values(artifactRows).run();

    db.insert(routingDecisions)
      .values([
        {
          workflowRunId: run.id,
          runNodeId: runNode.id,
          decisionType: 'retry',
          rationale: 'Retry queued after synthetic failure for fixture coverage.',
          rawOutput: { source: 'fixture', retryable: true },
          createdAt: timestamp(baseMs, 3900),
        },
        {
          workflowRunId: run.id,
          runNodeId: runNode.id,
          decisionType: 'blocked',
          rationale: 'Awaiting operator acknowledgement before another retry.',
          rawOutput: { source: 'fixture', reason: 'operator-ack-required' },
          createdAt: timestamp(baseMs, 3950),
        },
      ])
      .run();
  }

  return {
    runId: run.id,
    runNodeId: runNode.id,
  };
}

function seedLifecycleFixtures(db: AlphredDatabase): LifecycleFixturePayload {
  const baseMs = Date.now();
  const { treeId, treeNodeId } = insertFixtureTree(db, baseMs);
  const running = insertFixtureRun({
    db,
    treeId,
    treeNodeId,
    baseMs: baseMs + 10_000,
    state: 'running',
  });
  const paused = insertFixtureRun({
    db,
    treeId,
    treeNodeId,
    baseMs: baseMs + 20_000,
    state: 'paused',
  });
  const failed = insertFixtureRun({
    db,
    treeId,
    treeNodeId,
    baseMs: baseMs + 30_000,
    state: 'failed',
  });

  return {
    runningRunId: running.runId,
    pausedRunId: paused.runId,
    failedRunId: failed.runId,
    failedRunNodeId: failed.runNodeId,
  };
}

export async function POST() {
  if (!canServeTestRoutes()) {
    return NextResponse.json(
      {
        error: {
          message: 'Not found.',
        },
      },
      {
        status: 404,
      },
    );
  }

  const db = createDatabase(resolveDatabasePath(process.env, process.cwd()));

  try {
    migrateDatabase(db);
    const payload = seedLifecycleFixtures(db);
    return NextResponse.json(payload, {
      status: 201,
    });
  } finally {
    db.$client.close();
  }
}
