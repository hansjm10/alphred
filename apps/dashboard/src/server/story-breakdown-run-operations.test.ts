import { describe, expect, it, vi } from 'vitest';
import {
  createDatabase,
  migrateDatabase,
  phaseArtifacts,
  repositories,
  runNodeDiagnostics,
  runNodes,
  treeNodes,
  transitionRunNodeStatus,
  transitionWorkflowRunStatus,
  workItems,
  workflowRunAssociations,
  workflowRuns,
  workflowTrees,
  type AlphredDatabase,
} from '@alphred/db';
import { createStoryBreakdownRunOperations } from './story-breakdown-run-operations';

function createHarness(environment: Partial<NodeJS.ProcessEnv> = {}): {
  db: AlphredDatabase;
  launchWorkflowRunMock: ReturnType<typeof vi.fn>;
  operations: ReturnType<typeof createStoryBreakdownRunOperations>;
} {
  const db = createDatabase(':memory:');
  migrateDatabase(db);

  const launchWorkflowRunMock = vi.fn(async () => ({
    workflowRunId: 91,
    mode: 'async' as const,
    status: 'accepted' as const,
    runStatus: 'pending' as const,
    executionOutcome: null,
    executedNodes: null,
  }));

  return {
    db,
    launchWorkflowRunMock,
    operations: createStoryBreakdownRunOperations({
      withDatabase: async operation => operation(db),
      dependencies: {
        launchWorkflowRun: launchWorkflowRunMock,
      },
      environment: {
        ...process.env,
        ...environment,
      },
    }),
  };
}

function seedRepository(db: AlphredDatabase, name = 'demo-repo'): number {
  return Number(
    db.insert(repositories)
      .values({
        name,
        provider: 'github',
        remoteUrl: `https://github.com/octocat/${name}.git`,
        remoteRef: `octocat/${name}`,
        defaultBranch: 'main',
        localPath: `/tmp/${name}`,
        cloneStatus: 'cloned',
        createdAt: '2026-03-05T17:00:00.000Z',
        updatedAt: '2026-03-05T17:00:00.000Z',
      })
      .run().lastInsertRowid,
  );
}

function seedStory(db: AlphredDatabase, repositoryId: number, revision = 4): number {
  return Number(
    db.insert(workItems)
      .values({
        repositoryId,
        type: 'story',
        status: 'NeedsBreakdown',
        title: 'Generated story',
        revision,
        createdAt: '2026-03-05T17:01:00.000Z',
        updatedAt: '2026-03-05T17:01:00.000Z',
      })
      .run().lastInsertRowid,
  );
}

function seedPlannerTree(
  db: AlphredDatabase,
  params: {
    treeKey?: string;
    nodeKey?: string;
  } = {},
): { treeId: number; treeNodeId: number } {
  const treeId = Number(
    db.insert(workflowTrees)
      .values({
        treeKey: params.treeKey ?? 'story-breakdown-planner',
        version: 1,
        status: 'published',
        name: 'Story Breakdown Planner',
        createdAt: '2026-03-05T17:02:00.000Z',
        updatedAt: '2026-03-05T17:02:00.000Z',
      })
      .run().lastInsertRowid,
  );

  const treeNodeId = Number(
    db.insert(treeNodes)
      .values({
        workflowTreeId: treeId,
        nodeKey: params.nodeKey ?? 'breakdown',
        nodeRole: 'standard',
        nodeType: 'agent',
        provider: 'codex',
        model: 'gpt-5.3-codex',
        promptTemplateId: null,
        maxRetries: 0,
        sequenceIndex: 0,
        createdAt: '2026-03-05T17:02:00.000Z',
        updatedAt: '2026-03-05T17:02:00.000Z',
      })
      .run().lastInsertRowid,
  );

  return { treeId, treeNodeId };
}

function seedPlannerRun(
  db: AlphredDatabase,
  params: {
    treeId: number;
    treeNodeId: number;
    repositoryId: number;
    storyId: number;
    runStatus?: 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
    nodeStatus?: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
    nodeKey?: string;
    attempt?: number;
  },
): { runId: number; runNodeId: number } {
  const runStatus = params.runStatus ?? 'completed';
  const nodeStatus = params.nodeStatus ?? (runStatus === 'completed' ? 'completed' : runStatus === 'failed' ? 'failed' : 'pending');
  const attempt = params.attempt ?? 1;

  const runId = Number(
    db.insert(workflowRuns)
      .values({
        workflowTreeId: params.treeId,
        status: 'pending',
        startedAt: null,
        completedAt: null,
        createdAt: '2026-03-05T17:03:00.000Z',
        updatedAt: '2026-03-05T17:03:00.000Z',
      })
      .run().lastInsertRowid,
  );

  db.insert(workflowRunAssociations)
    .values({
      workflowRunId: runId,
      repositoryId: params.repositoryId,
      workItemId: params.storyId,
      createdAt: '2026-03-05T17:03:00.000Z',
    })
    .run();

  const runNodeId = Number(
    db.insert(runNodes)
      .values({
        workflowRunId: runId,
        treeNodeId: params.treeNodeId,
        nodeKey: params.nodeKey ?? 'breakdown',
        nodeRole: 'standard',
        nodeType: 'agent',
        provider: 'codex',
        model: 'gpt-5.3-codex',
        prompt: 'Return a story breakdown result.',
        promptContentType: 'markdown',
        maxRetries: 0,
        sequenceIndex: 0,
        attempt,
        status: 'pending',
        startedAt: null,
        completedAt: null,
        createdAt: '2026-03-05T17:03:00.000Z',
        updatedAt: '2026-03-05T17:03:00.000Z',
      })
      .run().lastInsertRowid,
  );

  if (nodeStatus !== 'pending') {
    transitionRunNodeStatus(db, {
      runNodeId,
      expectedFrom: 'pending',
      to: 'running',
      occurredAt: '2026-03-05T17:03:10.000Z',
    });
  }
  if (nodeStatus === 'completed' || nodeStatus === 'failed' || nodeStatus === 'cancelled') {
    transitionRunNodeStatus(db, {
      runNodeId,
      expectedFrom: 'running',
      to: nodeStatus,
      occurredAt: '2026-03-05T17:04:00.000Z',
    });
  }

  if (runStatus !== 'pending') {
    transitionWorkflowRunStatus(db, {
      workflowRunId: runId,
      expectedFrom: 'pending',
      to: 'running',
      occurredAt: '2026-03-05T17:03:05.000Z',
    });
  }
  if (runStatus === 'paused') {
    transitionWorkflowRunStatus(db, {
      workflowRunId: runId,
      expectedFrom: 'running',
      to: 'paused',
      occurredAt: '2026-03-05T17:03:30.000Z',
    });
  }
  if (runStatus === 'completed' || runStatus === 'failed' || runStatus === 'cancelled') {
    transitionWorkflowRunStatus(db, {
      workflowRunId: runId,
      expectedFrom: 'running',
      to: runStatus,
      occurredAt: '2026-03-05T17:04:00.000Z',
    });
  }

  return { runId, runNodeId };
}

function insertPlannerReportArtifact(db: AlphredDatabase, runId: number, runNodeId: number, content: string): number {
  return Number(
    db.insert(phaseArtifacts)
      .values({
        workflowRunId: runId,
        runNodeId,
        artifactType: 'report',
        contentType: 'markdown',
        content,
        metadata: { success: true },
        createdAt: '2026-03-05T17:04:00.000Z',
      })
      .run().lastInsertRowid,
  );
}

function insertFailureArtifact(db: AlphredDatabase, runId: number, runNodeId: number, content: string): number {
  return Number(
    db.insert(phaseArtifacts)
      .values({
        workflowRunId: runId,
        runNodeId,
        artifactType: 'log',
        contentType: 'text',
        content,
        metadata: { failureReason: 'retry_limit_exceeded' },
        createdAt: '2026-03-05T17:04:00.000Z',
      })
      .run().lastInsertRowid,
  );
}

function insertDiagnostics(
  db: AlphredDatabase,
  runId: number,
  runNodeId: number,
  diagnostics: Record<string, unknown>,
): number {
  return Number(
    db.insert(runNodeDiagnostics)
      .values({
        workflowRunId: runId,
        runNodeId,
        attempt: 1,
        outcome: 'failed',
        eventCount: 1,
        retainedEventCount: 1,
        droppedEventCount: 0,
        redacted: 0,
        truncated: 0,
        payloadChars: JSON.stringify(diagnostics).length,
        diagnostics,
        createdAt: '2026-03-05T17:04:00.000Z',
      })
      .run().lastInsertRowid,
  );
}

function validPlannerResultJson(): string {
  return JSON.stringify({
    schemaVersion: 1,
    resultType: 'story_breakdown_result',
    proposed: {
      tags: ['story'],
      plannedFiles: ['apps/dashboard/src/server/story-breakdown-run-operations.ts'],
      links: ['https://example.com/spec'],
      tasks: [
        {
          title: 'Validate planner schema',
          description: 'Add contract validation before mutations.',
          tags: ['api'],
          plannedFiles: ['apps/dashboard/src/server/story-breakdown-run-operations.ts'],
          assignees: ['codex'],
          priority: 1,
          estimate: 3,
          links: ['https://example.com/design'],
        },
      ],
    },
  });
}

describe('story-breakdown-run-operations', () => {
  it('launches a story breakdown run as an async single-node workflow run', async () => {
    const { db, launchWorkflowRunMock, operations } = createHarness();
    const repositoryId = seedRepository(db, 'planner-launch');
    const storyId = seedStory(db, repositoryId, 7);

    const result = await operations.launchStoryBreakdownRun({
      repositoryId,
      storyId,
      expectedRevision: 7,
    });

    expect(launchWorkflowRunMock).toHaveBeenCalledWith({
      treeKey: 'story-breakdown-planner',
      repositoryName: 'planner-launch',
      workItemId: storyId,
      executionMode: 'async',
      executionScope: 'single_node',
      nodeSelector: {
        type: 'node_key',
        nodeKey: 'breakdown',
      },
    });
    expect(result).toEqual({
      workflowRunId: 91,
      mode: 'async',
      status: 'accepted',
      runStatus: 'pending',
      result: null,
      error: null,
    });
  });

  it('rejects launching a second active breakdown run for the same story', async () => {
    const { db, launchWorkflowRunMock, operations } = createHarness();
    const repositoryId = seedRepository(db, 'planner-conflict');
    const storyId = seedStory(db, repositoryId, 2);
    const { treeId, treeNodeId } = seedPlannerTree(db);
    seedPlannerRun(db, {
      treeId,
      treeNodeId,
      repositoryId,
      storyId,
      runStatus: 'running',
      nodeStatus: 'running',
    });

    await expect(
      operations.launchStoryBreakdownRun({
        repositoryId,
        storyId,
        expectedRevision: 2,
      }),
    ).rejects.toMatchObject({
      code: 'conflict',
      status: 409,
      message: 'Story breakdown planner run is already active for this story.',
    });
    expect(launchWorkflowRunMock).not.toHaveBeenCalled();
  });

  it('returns a validated story_breakdown_result for completed runs', async () => {
    const { db, operations } = createHarness();
    const repositoryId = seedRepository(db, 'planner-complete');
    const storyId = seedStory(db, repositoryId);
    const { treeId, treeNodeId } = seedPlannerTree(db);
    const { runId, runNodeId } = seedPlannerRun(db, {
      treeId,
      treeNodeId,
      repositoryId,
      storyId,
      runStatus: 'completed',
      nodeStatus: 'completed',
    });
    insertPlannerReportArtifact(db, runId, runNodeId, validPlannerResultJson());

    const result = await operations.getStoryBreakdownRun({
      repositoryId,
      storyId,
      workflowRunId: runId,
    });

    expect(result).toEqual({
      workflowRunId: runId,
      runStatus: 'completed',
      result: {
        schemaVersion: 1,
        resultType: 'story_breakdown_result',
        proposed: {
          tags: ['story'],
          plannedFiles: ['apps/dashboard/src/server/story-breakdown-run-operations.ts'],
          links: ['https://example.com/spec'],
          tasks: [
            {
              title: 'Validate planner schema',
              description: 'Add contract validation before mutations.',
              tags: ['api'],
              plannedFiles: ['apps/dashboard/src/server/story-breakdown-run-operations.ts'],
              assignees: ['codex'],
              priority: 1,
              estimate: 3,
              links: ['https://example.com/design'],
            },
          ],
        },
      },
      error: null,
    });
  });

  it('surfaces invalid_output when the completed planner report fails schema validation', async () => {
    const { db, operations } = createHarness();
    const repositoryId = seedRepository(db, 'planner-invalid-output');
    const storyId = seedStory(db, repositoryId);
    const { treeId, treeNodeId } = seedPlannerTree(db);
    const { runId, runNodeId } = seedPlannerRun(db, {
      treeId,
      treeNodeId,
      repositoryId,
      storyId,
      runStatus: 'completed',
      nodeStatus: 'completed',
    });
    const reportArtifactId = insertPlannerReportArtifact(
      db,
      runId,
      runNodeId,
      JSON.stringify({
        schemaVersion: 2,
        resultType: 'story_breakdown_result',
        proposed: {
          tags: ['story'],
          plannedFiles: ['README.md'],
          links: [],
          tasks: [{ title: 'Broken schema' }],
        },
      }),
    );

    const result = await operations.getStoryBreakdownRun({
      repositoryId,
      storyId,
      workflowRunId: runId,
    });

    expect(result).toEqual({
      workflowRunId: runId,
      runStatus: 'completed',
      result: null,
      error: {
        code: 'invalid_output',
        message: 'Planner output does not match the story_breakdown_result schema.',
        retryable: false,
        details: expect.objectContaining({
          reason: 'schema_validation_failed',
          reportArtifactId,
          validationErrors: expect.arrayContaining(['schemaVersion must equal 1.']),
        }),
      },
    });
  });

  it('maps failed timeout diagnostics to a transient planner error', async () => {
    const { db, operations } = createHarness();
    const repositoryId = seedRepository(db, 'planner-transient');
    const storyId = seedStory(db, repositoryId);
    const { treeId, treeNodeId } = seedPlannerTree(db);
    const { runId, runNodeId } = seedPlannerRun(db, {
      treeId,
      treeNodeId,
      repositoryId,
      storyId,
      runStatus: 'failed',
      nodeStatus: 'failed',
    });
    const failureArtifactId = insertFailureArtifact(db, runId, runNodeId, 'Request timed out while waiting for model response.');
    const diagnosticId = insertDiagnostics(db, runId, runNodeId, {
      error: {
        name: 'TimeoutError',
        message: 'Request timed out while waiting for model response.',
        classification: 'timeout',
        stackPreview: null,
      },
    });

    const result = await operations.getStoryBreakdownRun({
      repositoryId,
      storyId,
      workflowRunId: runId,
    });

    expect(result).toEqual({
      workflowRunId: runId,
      runStatus: 'failed',
      result: null,
      error: {
        code: 'transient',
        message: 'Request timed out while waiting for model response.',
        retryable: true,
        details: expect.objectContaining({
          kind: 'planner_transient_failure',
          diagnosticId,
          failureArtifactId,
          diagnosticClassification: 'timeout',
        }),
      },
    });
  });
});
