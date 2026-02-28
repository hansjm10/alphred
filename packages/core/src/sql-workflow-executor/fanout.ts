import { and, asc, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import { runJoinBarriers, runNodeEdges, runNodes, type AlphredDatabase, type RunNodeStatus } from '@alphred/db';
import type { AgentProviderName } from '@alphred/shared';
import type { EdgeRow, RunNodeExecutionRow } from './types.js';

type SpawnerSubtaskSpec = {
  nodeKey: string;
  title: string;
  prompt: string;
  provider: AgentProviderName | null;
  model: string | null;
  metadata: Record<string, unknown> | null;
};

type JoinBarrierState = 'pending' | 'ready';

type JoinBarrierRow = {
  id: number;
  workflowRunId: number;
  spawnerRunNodeId: number;
  joinRunNodeId: number;
  spawnSourceArtifactId: number;
  expectedChildren: number;
  terminalChildren: number;
  completedChildren: number;
  failedChildren: number;
  status: 'pending' | 'ready' | 'released' | 'cancelled';
};

const terminalStatuses: ReadonlySet<RunNodeStatus> = new Set(['completed', 'failed', 'skipped', 'cancelled']);

function parseJoinBarrierStatus(status: string): JoinBarrierRow['status'] {
  if (status === 'pending' || status === 'ready' || status === 'released' || status === 'cancelled') {
    return status;
  }

  throw new Error(`Unexpected run_join_barriers.status value "${status}".`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function formatUnexpectedValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value) ?? '[unserializable value]';
    } catch {
      return '[unserializable value]';
    }
  }

  return String(value);
}

function normalizeNodeKey(value: string): string {
  const segments = value.trim().toLowerCase().match(/[a-z0-9]+/g);
  return segments?.join('-') ?? '';
}

function parseOptionalProvider(value: unknown): AgentProviderName | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (value === 'codex' || value === 'claude') {
    return value;
  }

  throw new TypeError(`Invalid subtask provider "${formatUnexpectedValue(value)}". Expected "codex" or "claude".`);
}

function parseOptionalModel(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new TypeError('Subtask model must be a string when provided.');
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error('Subtask model must not be empty when provided.');
  }

  return trimmed;
}

function parseOptionalMetadata(value: unknown): Record<string, unknown> | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (!isRecord(value)) {
    throw new Error('Subtask metadata must be a JSON object when provided.');
  }

  return value;
}

function parseRequiredStringField(record: Record<string, unknown>, fieldName: string): string {
  const value = record[fieldName];
  if (typeof value !== 'string') {
    throw new TypeError(`Subtask field "${fieldName}" is required and must be a string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`Subtask field "${fieldName}" must not be empty.`);
  }

  return trimmed;
}

function resolveSubtaskNodeKey(
  record: Record<string, unknown>,
  params: {
    generatedNodeKey: string;
  },
): string {
  const explicitNodeKey = record.nodeKey;
  if (explicitNodeKey === undefined || explicitNodeKey === null) {
    return params.generatedNodeKey;
  }
  if (typeof explicitNodeKey !== 'string') {
    throw new TypeError('Subtask field "nodeKey" must be a string when provided.');
  }

  const normalized = normalizeNodeKey(explicitNodeKey);
  if (normalized.length === 0) {
    throw new Error('Subtask field "nodeKey" must contain at least one alphanumeric character.');
  }

  return normalized;
}

export function parseSpawnerSubtasks(params: {
  report: string;
  spawnerNodeKey: string;
  maxChildren: number;
  lineageDepth: number;
  batchOrdinal: number;
}): SpawnerSubtaskSpec[] {
  if (params.lineageDepth > 0) {
    throw new Error('SPAWNER_DEPTH_EXCEEDED: nested fan-out beyond depth 1 is not allowed in phase 1.');
  }
  if (!Number.isInteger(params.batchOrdinal) || params.batchOrdinal < 1) {
    throw new Error('SPAWNER_OUTPUT_INVALID: batchOrdinal must be an integer greater than or equal to 1.');
  }

  let payload: unknown;
  try {
    payload = JSON.parse(params.report);
  } catch (error) {
    throw new Error(`SPAWNER_OUTPUT_INVALID: failed to parse JSON output (${String((error as Error).message)}).`);
  }

  if (!isRecord(payload)) {
    throw new Error('SPAWNER_OUTPUT_INVALID: spawner output must be a JSON object.');
  }
  if (payload.schemaVersion !== 1) {
    throw new Error('SPAWNER_OUTPUT_INVALID: schemaVersion must equal 1.');
  }
  if (!Array.isArray(payload.subtasks)) {
    throw new TypeError('SPAWNER_OUTPUT_INVALID: subtasks must be an array.');
  }
  if (payload.subtasks.length > params.maxChildren) {
    throw new Error(
      `SPAWNER_OUTPUT_INVALID: subtasks length ${payload.subtasks.length} exceeds maxChildren=${params.maxChildren}.`,
    );
  }

  const generatedNodeKeyPrefix = `${normalizeNodeKey(params.spawnerNodeKey)}__${params.batchOrdinal}`;
  const subtaskSpecs: SpawnerSubtaskSpec[] = [];
  const seenNodeKeys = new Set<string>();
  for (let index = 0; index < payload.subtasks.length; index += 1) {
    const item = payload.subtasks[index];
    if (!isRecord(item)) {
      throw new Error(`SPAWNER_OUTPUT_INVALID: subtasks[${index}] must be an object.`);
    }

    const generatedNodeKey = `${generatedNodeKeyPrefix}__${index + 1}`;
    const nodeKey = resolveSubtaskNodeKey(item, { generatedNodeKey });
    if (seenNodeKeys.has(nodeKey)) {
      throw new Error(`SPAWNER_OUTPUT_INVALID: duplicate subtask nodeKey "${nodeKey}".`);
    }
    seenNodeKeys.add(nodeKey);

    subtaskSpecs.push({
      nodeKey,
      title: parseRequiredStringField(item, 'title'),
      prompt: parseRequiredStringField(item, 'prompt'),
      provider: parseOptionalProvider(item.provider),
      model: parseOptionalModel(item.model),
      metadata: parseOptionalMetadata(item.metadata),
    });
  }

  return subtaskSpecs;
}

export function resolveSpawnerJoinTarget(params: {
  spawnerNode: RunNodeExecutionRow;
  latestNodeAttempts: RunNodeExecutionRow[];
  edgeRows: EdgeRow[];
}): RunNodeExecutionRow {
  const successTargets = params.edgeRows.filter(
    edge => edge.sourceNodeId === params.spawnerNode.runNodeId && edge.routeOn === 'success' && edge.edgeKind === 'tree',
  );
  if (successTargets.length !== 1) {
    throw new Error(
      `SPAWNER_OUTPUT_INVALID: spawner "${params.spawnerNode.nodeKey}" must have exactly one static success edge to a join node.`,
    );
  }

  const joinTarget = params.latestNodeAttempts.find(node => node.runNodeId === successTargets[0]?.targetNodeId);
  if (joinTarget?.nodeRole !== 'join') {
    throw new Error(
      `SPAWNER_OUTPUT_INVALID: spawner "${params.spawnerNode.nodeKey}" success target must resolve to a join run node.`,
    );
  }

  return joinTarget;
}

function loadExistingNodeKeys(db: Pick<AlphredDatabase, 'select'>, workflowRunId: number): Set<string> {
  const rows = db
    .select({
      nodeKey: runNodes.nodeKey,
    })
    .from(runNodes)
    .where(eq(runNodes.workflowRunId, workflowRunId))
    .all();

  return new Set(rows.map(row => row.nodeKey));
}

function loadMaxSequenceIndex(db: Pick<AlphredDatabase, 'select'>, workflowRunId: number): number {
  const row = db
    .select({
      maxSequenceIndex: sql<number>`COALESCE(MAX(${runNodes.sequenceIndex}), 0)`,
    })
    .from(runNodes)
    .where(eq(runNodes.workflowRunId, workflowRunId))
    .get();

  return row?.maxSequenceIndex ?? 0;
}

function loadNextSuccessEdgePriorityForSource(
  db: Pick<AlphredDatabase, 'select'>,
  params: {
    workflowRunId: number;
    sourceRunNodeId: number;
  },
): number {
  const row = db
    .select({
      maxPriority: sql<number>`COALESCE(MAX(${runNodeEdges.priority}), -1)`,
    })
    .from(runNodeEdges)
    .where(
      and(
        eq(runNodeEdges.workflowRunId, params.workflowRunId),
        eq(runNodeEdges.sourceRunNodeId, params.sourceRunNodeId),
        eq(runNodeEdges.routeOn, 'success'),
      ),
    )
    .get();

  return (row?.maxPriority ?? -1) + 1;
}

function loadActiveBarriersForSpawnerJoin(
  db: Pick<AlphredDatabase, 'select'>,
  params: {
    workflowRunId: number;
    spawnerRunNodeId: number;
    joinRunNodeId: number;
  },
): JoinBarrierRow[] {
  const rows = db
    .select({
      id: runJoinBarriers.id,
      workflowRunId: runJoinBarriers.workflowRunId,
      spawnerRunNodeId: runJoinBarriers.spawnerRunNodeId,
      joinRunNodeId: runJoinBarriers.joinRunNodeId,
      spawnSourceArtifactId: runJoinBarriers.spawnSourceArtifactId,
      expectedChildren: runJoinBarriers.expectedChildren,
      terminalChildren: runJoinBarriers.terminalChildren,
      completedChildren: runJoinBarriers.completedChildren,
      failedChildren: runJoinBarriers.failedChildren,
      status: runJoinBarriers.status,
    })
    .from(runJoinBarriers)
    .where(
      and(
        eq(runJoinBarriers.workflowRunId, params.workflowRunId),
        eq(runJoinBarriers.spawnerRunNodeId, params.spawnerRunNodeId),
        eq(runJoinBarriers.joinRunNodeId, params.joinRunNodeId),
        inArray(runJoinBarriers.status, ['pending', 'ready']),
      ),
    )
    .orderBy(desc(runJoinBarriers.id))
    .all();

  return rows.map(row => ({
    ...row,
    status: parseJoinBarrierStatus(row.status),
  }));
}

export function spawnDynamicChildrenForSpawner(
  db: AlphredDatabase,
  params: {
    workflowRunId: number;
    spawnerNode: RunNodeExecutionRow;
    joinNode: RunNodeExecutionRow;
    spawnSourceArtifactId: number;
    subtasks: readonly SpawnerSubtaskSpec[];
  },
): void {
  if (params.subtasks.length > params.spawnerNode.maxChildren) {
    throw new Error(
      `SPAWNER_OUTPUT_INVALID: subtasks length ${params.subtasks.length} exceeds maxChildren=${params.spawnerNode.maxChildren}.`,
    );
  }

  db.transaction(tx => {
    const activeBarrier = loadActiveBarriersForSpawnerJoin(tx, {
      workflowRunId: params.workflowRunId,
      spawnerRunNodeId: params.spawnerNode.runNodeId,
      joinRunNodeId: params.joinNode.runNodeId,
    })[0];
    if (activeBarrier) {
      throw new Error(
        `SPAWNER_OUTPUT_INVALID: spawner "${params.spawnerNode.nodeKey}" cannot emit another fan-out batch while join "${params.joinNode.nodeKey}" barrier id=${activeBarrier.id} remains ${activeBarrier.status}.`,
      );
    }

    const existingNodeKeys = loadExistingNodeKeys(tx, params.workflowRunId);
    for (const subtask of params.subtasks) {
      if (existingNodeKeys.has(subtask.nodeKey)) {
        throw new Error(`SPAWNER_OUTPUT_INVALID: subtask nodeKey "${subtask.nodeKey}" already exists in this run.`);
      }
    }

    const sequenceStart = loadMaxSequenceIndex(tx, params.workflowRunId) + 1;
    const sequencePrefix = params.spawnerNode.sequencePath ?? String(params.spawnerNode.sequenceIndex);
    const nextLineageDepth = params.spawnerNode.lineageDepth + 1;
    if (nextLineageDepth > 1) {
      throw new Error('SPAWNER_DEPTH_EXCEEDED: nested fan-out beyond depth 1 is not allowed in phase 1.');
    }

    const insertedChildren =
      params.subtasks.length === 0
        ? []
        : tx
            .insert(runNodes)
            .values(
              params.subtasks.map((subtask, index) => ({
                workflowRunId: params.workflowRunId,
                treeNodeId: params.spawnerNode.treeNodeId,
                nodeKey: subtask.nodeKey,
                nodeRole: 'standard',
                nodeType: 'agent',
                provider: subtask.provider ?? params.spawnerNode.provider,
                model: subtask.model ?? params.spawnerNode.model,
                prompt: subtask.prompt,
                promptContentType: 'markdown',
                executionPermissions: params.spawnerNode.executionPermissions,
                errorHandlerConfig: params.spawnerNode.errorHandlerConfig,
                maxChildren: 0,
                maxRetries: params.spawnerNode.maxRetries,
                spawnerNodeId: params.spawnerNode.runNodeId,
                joinNodeId: params.joinNode.runNodeId,
                lineageDepth: nextLineageDepth,
                sequencePath: `${sequencePrefix}.${index + 1}`,
                status: 'pending',
                sequenceIndex: sequenceStart + index,
                attempt: 1,
              })),
            )
            .returning({
              id: runNodes.id,
              sequenceIndex: runNodes.sequenceIndex,
            })
            .all();

    if (insertedChildren.length > 0) {
      const dynamicSpawnerEdgePriorityBase = loadNextSuccessEdgePriorityForSource(tx, {
        workflowRunId: params.workflowRunId,
        sourceRunNodeId: params.spawnerNode.runNodeId,
      });
      tx
        .insert(runNodeEdges)
        .values(
          insertedChildren.flatMap((child, index) => [
            {
              workflowRunId: params.workflowRunId,
              sourceRunNodeId: params.spawnerNode.runNodeId,
              targetRunNodeId: child.id,
              routeOn: 'success',
              auto: 1,
              guardExpression: null,
              priority: dynamicSpawnerEdgePriorityBase + index,
              edgeKind: 'dynamic_spawner_to_child',
            },
            {
              workflowRunId: params.workflowRunId,
              sourceRunNodeId: child.id,
              targetRunNodeId: params.joinNode.runNodeId,
              routeOn: 'terminal',
              auto: 1,
              guardExpression: null,
              priority: index,
              edgeKind: 'dynamic_child_to_join',
            },
          ]),
        )
        .run();
    }

    const now = new Date().toISOString();
    const expectedChildren = params.subtasks.length;
    const status = expectedChildren === 0 ? 'ready' : 'pending';
    tx.insert(runJoinBarriers)
      .values({
        workflowRunId: params.workflowRunId,
        spawnerRunNodeId: params.spawnerNode.runNodeId,
        joinRunNodeId: params.joinNode.runNodeId,
        spawnSourceArtifactId: params.spawnSourceArtifactId,
        expectedChildren,
        terminalChildren: 0,
        completedChildren: 0,
        failedChildren: 0,
        status,
        createdAt: now,
        updatedAt: now,
        releasedAt: null,
      })
      .run();
  });
}

export function loadJoinBarrierStatesByJoinRunNodeId(
  db: AlphredDatabase,
  workflowRunId: number,
): Map<number, JoinBarrierState> {
  const rows = db
    .select({
      joinRunNodeId: runJoinBarriers.joinRunNodeId,
      status: runJoinBarriers.status,
    })
    .from(runJoinBarriers)
    .where(and(eq(runJoinBarriers.workflowRunId, workflowRunId), inArray(runJoinBarriers.status, ['pending', 'ready'])))
    .orderBy(asc(runJoinBarriers.id))
    .all();

  const states = new Map<number, JoinBarrierState>();
  for (const row of rows) {
    const previous = states.get(row.joinRunNodeId);
    if (row.status === 'pending') {
      states.set(row.joinRunNodeId, 'pending');
      continue;
    }
    if (!previous) {
      states.set(row.joinRunNodeId, 'ready');
    }
  }

  return states;
}

export function loadReadyJoinBarriersForJoinNode(
  db: Pick<AlphredDatabase, 'select'>,
  params: {
    workflowRunId: number;
    joinRunNodeId: number;
  },
): JoinBarrierRow[] {
  const rows = db
    .select({
      id: runJoinBarriers.id,
      workflowRunId: runJoinBarriers.workflowRunId,
      spawnerRunNodeId: runJoinBarriers.spawnerRunNodeId,
      joinRunNodeId: runJoinBarriers.joinRunNodeId,
      spawnSourceArtifactId: runJoinBarriers.spawnSourceArtifactId,
      expectedChildren: runJoinBarriers.expectedChildren,
      terminalChildren: runJoinBarriers.terminalChildren,
      completedChildren: runJoinBarriers.completedChildren,
      failedChildren: runJoinBarriers.failedChildren,
      status: runJoinBarriers.status,
    })
    .from(runJoinBarriers)
    .where(
      and(
        eq(runJoinBarriers.workflowRunId, params.workflowRunId),
        eq(runJoinBarriers.joinRunNodeId, params.joinRunNodeId),
        eq(runJoinBarriers.status, 'ready'),
      ),
    )
    .orderBy(desc(runJoinBarriers.id))
    .all();

  return rows.map(row => ({
    ...row,
    status: parseJoinBarrierStatus(row.status),
  }));
}

export function loadMostRecentJoinBarrier(
  db: AlphredDatabase,
  params: {
    workflowRunId: number;
    joinRunNodeId: number;
  },
): JoinBarrierRow | null {
  const row = db
    .select({
      id: runJoinBarriers.id,
      workflowRunId: runJoinBarriers.workflowRunId,
      spawnerRunNodeId: runJoinBarriers.spawnerRunNodeId,
      joinRunNodeId: runJoinBarriers.joinRunNodeId,
      spawnSourceArtifactId: runJoinBarriers.spawnSourceArtifactId,
      expectedChildren: runJoinBarriers.expectedChildren,
      terminalChildren: runJoinBarriers.terminalChildren,
      completedChildren: runJoinBarriers.completedChildren,
      failedChildren: runJoinBarriers.failedChildren,
      status: runJoinBarriers.status,
    })
    .from(runJoinBarriers)
    .where(
      and(
        eq(runJoinBarriers.workflowRunId, params.workflowRunId),
        eq(runJoinBarriers.joinRunNodeId, params.joinRunNodeId),
      ),
    )
    .orderBy(desc(runJoinBarriers.id))
    .get();

  if (!row) {
    return null;
  }

  return {
    ...row,
    status: parseJoinBarrierStatus(row.status),
  };
}

export function loadBarriersForSpawnerJoin(
  db: Pick<AlphredDatabase, 'select'>,
  params: {
    workflowRunId: number;
    spawnerRunNodeId: number;
    joinRunNodeId: number;
  },
): JoinBarrierRow[] {
  return db
    .select({
      id: runJoinBarriers.id,
      workflowRunId: runJoinBarriers.workflowRunId,
      spawnerRunNodeId: runJoinBarriers.spawnerRunNodeId,
      joinRunNodeId: runJoinBarriers.joinRunNodeId,
      spawnSourceArtifactId: runJoinBarriers.spawnSourceArtifactId,
      expectedChildren: runJoinBarriers.expectedChildren,
      terminalChildren: runJoinBarriers.terminalChildren,
      completedChildren: runJoinBarriers.completedChildren,
      failedChildren: runJoinBarriers.failedChildren,
      status: runJoinBarriers.status,
    })
    .from(runJoinBarriers)
    .where(
      and(
        eq(runJoinBarriers.workflowRunId, params.workflowRunId),
        eq(runJoinBarriers.spawnerRunNodeId, params.spawnerRunNodeId),
        eq(runJoinBarriers.joinRunNodeId, params.joinRunNodeId),
      ),
    )
    .orderBy(asc(runJoinBarriers.id))
    .all()
    .map(row => ({
      ...row,
      status: parseJoinBarrierStatus(row.status),
    }));
}

function loadBarrierForChildRunNode(
  db: Pick<AlphredDatabase, 'select'>,
  params: {
    workflowRunId: number;
    childRunNodeId: number;
    spawnerRunNodeId: number;
    joinRunNodeId: number;
  },
): JoinBarrierRow | null {
  const childSpawnerEdge = db
    .select({
      priority: runNodeEdges.priority,
    })
    .from(runNodeEdges)
    .where(
      and(
        eq(runNodeEdges.workflowRunId, params.workflowRunId),
        eq(runNodeEdges.sourceRunNodeId, params.spawnerRunNodeId),
        eq(runNodeEdges.targetRunNodeId, params.childRunNodeId),
        eq(runNodeEdges.routeOn, 'success'),
        eq(runNodeEdges.edgeKind, 'dynamic_spawner_to_child'),
      ),
    )
    .get();
  if (!childSpawnerEdge) {
    throw new Error(
      `JOIN_BARRIER_STATE_INVALID: cannot map child runNodeId=${params.childRunNodeId} because no dynamic spawner edge exists for workflowRunId=${params.workflowRunId}, spawnerRunNodeId=${params.spawnerRunNodeId}, joinRunNodeId=${params.joinRunNodeId}.`,
    );
  }

  const childOrdinalRow = db
    .select({
      value: sql<number>`COUNT(*)`,
    })
    .from(runNodeEdges)
    .where(
      and(
        eq(runNodeEdges.workflowRunId, params.workflowRunId),
        eq(runNodeEdges.sourceRunNodeId, params.spawnerRunNodeId),
        eq(runNodeEdges.routeOn, 'success'),
        eq(runNodeEdges.edgeKind, 'dynamic_spawner_to_child'),
        lte(runNodeEdges.priority, childSpawnerEdge.priority),
      ),
    )
    .get();
  const childOrdinal = childOrdinalRow?.value ?? 0;
  if (childOrdinal <= 0) {
    throw new Error(
      `JOIN_BARRIER_STATE_INVALID: missing child ordinal for workflowRunId=${params.workflowRunId}, childRunNodeId=${params.childRunNodeId}.`,
    );
  }

  const barriers = loadBarriersForSpawnerJoin(db, params);
  if (barriers.length === 0) {
    return null;
  }

  let accumulatedChildren = 0;
  for (const barrier of barriers) {
    accumulatedChildren += barrier.expectedChildren;
    if (childOrdinal <= accumulatedChildren) {
      return barrier;
    }
  }

  throw new Error(
    `JOIN_BARRIER_STATE_INVALID: cannot map child runNodeId=${params.childRunNodeId} to join barrier for workflowRunId=${params.workflowRunId}, spawnerRunNodeId=${params.spawnerRunNodeId}, joinRunNodeId=${params.joinRunNodeId}.`,
  );
}

function loadMutableBarrierForChildRunNode(
  db: Pick<AlphredDatabase, 'select'>,
  params: {
    workflowRunId: number;
    childRunNodeId: number;
    spawnerRunNodeId: number;
    joinRunNodeId: number;
  },
): JoinBarrierRow | null {
  const barrier = loadBarrierForChildRunNode(db, params);
  if (!barrier || barrier.status === 'cancelled') {
    return null;
  }

  return barrier;
}

export function updateJoinBarrierForChildTerminal(
  db: Pick<AlphredDatabase, 'select' | 'update'>,
  params: {
    workflowRunId: number;
    childNode: Pick<RunNodeExecutionRow, 'runNodeId' | 'spawnerNodeId' | 'joinNodeId'>;
    childTerminalStatus: RunNodeStatus;
  },
): void {
  if (!terminalStatuses.has(params.childTerminalStatus)) {
    return;
  }

  const spawnerRunNodeId = params.childNode.spawnerNodeId;
  const joinRunNodeId = params.childNode.joinNodeId;
  if (!spawnerRunNodeId || !joinRunNodeId) {
    return;
  }

  const barrier = loadMutableBarrierForChildRunNode(db, {
    workflowRunId: params.workflowRunId,
    childRunNodeId: params.childNode.runNodeId,
    spawnerRunNodeId,
    joinRunNodeId,
  });
  if (!barrier) {
    return;
  }
  if (barrier.status === 'released') {
    return;
  }
  if (barrier.terminalChildren >= barrier.expectedChildren) {
    return;
  }

  const completedIncrement = params.childTerminalStatus === 'completed' ? 1 : 0;
  const failedIncrement = params.childTerminalStatus === 'failed' ? 1 : 0;
  const now = new Date().toISOString();

  db.update(runJoinBarriers)
    .set({
      terminalChildren: sql<number>`${runJoinBarriers.terminalChildren} + 1`,
      completedChildren: sql<number>`${runJoinBarriers.completedChildren} + ${completedIncrement}`,
      failedChildren: sql<number>`${runJoinBarriers.failedChildren} + ${failedIncrement}`,
      status: sql<JoinBarrierRow['status']>`CASE
        WHEN ${runJoinBarriers.terminalChildren} + 1 >= ${runJoinBarriers.expectedChildren} THEN 'ready'
        ELSE ${runJoinBarriers.status}
      END`,
      updatedAt: now,
    })
    .where(
      and(
        eq(runJoinBarriers.id, barrier.id),
        inArray(runJoinBarriers.status, ['pending', 'ready']),
        sql`${runJoinBarriers.terminalChildren} < ${runJoinBarriers.expectedChildren}`,
      ),
    )
    .run();
}

export function reopenJoinBarrierForRetriedChild(
  db: Pick<AlphredDatabase, 'select' | 'update'>,
  params: {
    workflowRunId: number;
    childNode: Pick<RunNodeExecutionRow, 'runNodeId' | 'spawnerNodeId' | 'joinNodeId'>;
    previousTerminalStatus: RunNodeStatus;
  },
): void {
  if (!terminalStatuses.has(params.previousTerminalStatus)) {
    return;
  }

  const spawnerRunNodeId = params.childNode.spawnerNodeId;
  const joinRunNodeId = params.childNode.joinNodeId;
  if (!spawnerRunNodeId || !joinRunNodeId) {
    return;
  }

  const barrier = loadMutableBarrierForChildRunNode(db, {
    workflowRunId: params.workflowRunId,
    childRunNodeId: params.childNode.runNodeId,
    spawnerRunNodeId,
    joinRunNodeId,
  });
  if (!barrier) {
    return;
  }
  if (barrier.terminalChildren === 0) {
    return;
  }

  const completedDecrement = params.previousTerminalStatus === 'completed' ? 1 : 0;
  const failedDecrement = params.previousTerminalStatus === 'failed' ? 1 : 0;
  if (barrier.completedChildren < completedDecrement || barrier.failedChildren < failedDecrement) {
    throw new Error(
      `JOIN_BARRIER_STATE_INVALID: cannot reopen barrier id=${barrier.id} for child status "${params.previousTerminalStatus}" because counters would become negative.`,
    );
  }

  const now = new Date().toISOString();

  db.update(runJoinBarriers)
    .set({
      terminalChildren: sql<number>`${runJoinBarriers.terminalChildren} - 1`,
      completedChildren: sql<number>`${runJoinBarriers.completedChildren} - ${completedDecrement}`,
      failedChildren: sql<number>`${runJoinBarriers.failedChildren} - ${failedDecrement}`,
      status: sql<JoinBarrierRow['status']>`CASE
        WHEN ${runJoinBarriers.terminalChildren} - 1 >= ${runJoinBarriers.expectedChildren} THEN 'ready'
        ELSE 'pending'
      END`,
      updatedAt: now,
      releasedAt: sql<string | null>`CASE
        WHEN ${runJoinBarriers.status} = 'released' THEN NULL
        ELSE ${runJoinBarriers.releasedAt}
      END`,
    })
    .where(
      and(
        eq(runJoinBarriers.id, barrier.id),
        inArray(runJoinBarriers.status, ['pending', 'ready', 'released']),
        sql`${runJoinBarriers.terminalChildren} > 0`,
        sql`${runJoinBarriers.completedChildren} >= ${completedDecrement}`,
        sql`${runJoinBarriers.failedChildren} >= ${failedDecrement}`,
      ),
    )
    .run();
}

export function releaseReadyJoinBarriersForJoinNode(
  db: AlphredDatabase,
  params: {
    workflowRunId: number;
    joinRunNodeId: number;
  },
): void {
  const now = new Date().toISOString();
  db.update(runJoinBarriers)
    .set({
      status: 'released',
      updatedAt: now,
      releasedAt: now,
    })
    .where(
      and(
        eq(runJoinBarriers.workflowRunId, params.workflowRunId),
        eq(runJoinBarriers.joinRunNodeId, params.joinRunNodeId),
        eq(runJoinBarriers.status, 'ready'),
      ),
    )
    .run();
}
