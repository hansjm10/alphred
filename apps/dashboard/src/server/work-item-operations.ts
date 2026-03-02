import { validateParentChildWorkItemTypes, validateTransition } from '@alphred/core';
import {
  and,
  asc,
  desc,
  eq,
  repositories,
  sql,
  workItemEvents,
  workItems,
  type AlphredDatabase,
  type WorkItemActorType,
  type WorkItemEventType,
} from '@alphred/db';
import { workItemStatusesByType, type WorkItemStatus, type WorkItemType } from '@alphred/shared';
import { DashboardIntegrationError } from './dashboard-errors';
import type {
  DashboardApproveStoryBreakdownRequest,
  DashboardApproveStoryBreakdownResult,
  DashboardBoardEventSnapshot,
  DashboardBoardEventsSnapshot,
  DashboardCreateWorkItemRequest,
  DashboardCreateWorkItemResult,
  DashboardGetWorkItemResult,
  DashboardListWorkItemsResult,
  DashboardMoveWorkItemStatusRequest,
  DashboardMoveWorkItemStatusResult,
  DashboardProposeStoryBreakdownRequest,
  DashboardProposeStoryBreakdownResult,
  DashboardSetWorkItemParentRequest,
  DashboardSetWorkItemParentResult,
  DashboardUpdateWorkItemFieldsRequest,
  DashboardUpdateWorkItemFieldsResult,
  DashboardWorkItemSnapshot,
} from './dashboard-contracts';

type WithDatabase = <T>(operation: (db: AlphredDatabase) => Promise<T> | T) => Promise<T>;

type WorkItemRow = typeof workItems.$inferSelect;
type WorkItemEventRow = typeof workItemEvents.$inferSelect;
type AlphredTransaction = Parameters<Parameters<AlphredDatabase['transaction']>[0]>[0];
type DbOrTx = AlphredDatabase | AlphredTransaction;

const MAX_BOARD_EVENT_SNAPSHOT_EVENTS = 200;

function toOptionalNonEmptyTrimmedString(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function toStringArrayOrNull(value: unknown): string[] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) return null;
  const strings: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') return null;
    strings.push(entry);
  }
  return strings;
}

function toWorkItemSnapshot(row: WorkItemRow): DashboardWorkItemSnapshot {
  return {
    id: row.id,
    repositoryId: row.repositoryId,
    type: row.type as WorkItemType,
    status: row.status as WorkItemStatus,
    title: row.title,
    description: row.description,
    parentId: row.parentId,
    tags: toStringArrayOrNull(row.tags),
    plannedFiles: toStringArrayOrNull(row.plannedFiles),
    assignees: toStringArrayOrNull(row.assignees),
    priority: row.priority,
    estimate: row.estimate,
    revision: row.revision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toBoardEventSnapshot(row: WorkItemEventRow): DashboardBoardEventSnapshot {
  return {
    id: row.id,
    repositoryId: row.repositoryId,
    workItemId: row.workItemId,
    eventType: row.eventType as WorkItemEventType,
    actorType: row.actorType as WorkItemActorType,
    actorLabel: row.actorLabel,
    payload: row.payload,
    createdAt: row.createdAt,
  };
}

function requireActor(params: { actorType: WorkItemActorType; actorLabel: string }): {
  actorType: WorkItemActorType;
  actorLabel: string;
} {
  const actorLabel = params.actorLabel.trim();
  if (actorLabel.length === 0) {
    throw new DashboardIntegrationError('invalid_request', 'actorLabel cannot be empty.', {
      status: 400,
    });
  }
  return {
    actorType: params.actorType,
    actorLabel,
  };
}

function requireRepositoryId(repositoryId: number): number {
  if (!Number.isInteger(repositoryId) || repositoryId < 1) {
    throw new DashboardIntegrationError('invalid_request', 'repositoryId must be a positive integer.', {
      status: 400,
    });
  }
  return repositoryId;
}

function requireWorkItemId(workItemId: number, label = 'workItemId'): number {
  if (!Number.isInteger(workItemId) || workItemId < 1) {
    throw new DashboardIntegrationError('invalid_request', `${label} must be a positive integer.`, {
      status: 400,
    });
  }
  return workItemId;
}

function requireExpectedRevision(expectedRevision: number): number {
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    throw new DashboardIntegrationError('invalid_request', 'expectedRevision must be a non-negative integer.', {
      status: 400,
    });
  }
  return expectedRevision;
}

function requireLastEventId(lastEventId: number): number {
  if (!Number.isInteger(lastEventId) || lastEventId < 0) {
    throw new DashboardIntegrationError('invalid_request', 'lastEventId must be a non-negative integer.', {
      status: 400,
    });
  }
  return lastEventId;
}

function requireSnapshotLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new DashboardIntegrationError('invalid_request', 'limit must be a positive integer.', {
      status: 400,
    });
  }

  return Math.min(limit, MAX_BOARD_EVENT_SNAPSHOT_EVENTS);
}

function isValidStatusForType(type: WorkItemType, status: string): status is WorkItemStatus {
  return (workItemStatusesByType[type] as readonly string[]).includes(status);
}

function readWorkItemOrThrow(
  db: DbOrTx,
  params: { repositoryId: number; workItemId: number; notFoundMessage?: string },
): WorkItemRow {
  const row = db
    .select()
    .from(workItems)
    .where(and(eq(workItems.repositoryId, params.repositoryId), eq(workItems.id, params.workItemId)))
    .get();

  if (!row) {
    throw new DashboardIntegrationError(
      'not_found',
      params.notFoundMessage ?? `Work item id=${params.workItemId} was not found.`,
      { status: 404 },
    );
  }

  return row;
}

function insertEvent(
  db: DbOrTx,
  params: {
    repositoryId: number;
    workItemId: number;
    eventType: WorkItemEventType;
    actorType: WorkItemActorType;
    actorLabel: string;
    payload: Record<string, unknown>;
    occurredAt: string;
  },
): void {
  db.insert(workItemEvents)
    .values({
      repositoryId: params.repositoryId,
      workItemId: params.workItemId,
      eventType: params.eventType,
      actorType: params.actorType,
      actorLabel: params.actorLabel,
      payload: params.payload,
      createdAt: params.occurredAt,
    })
    .run();
}

function throwRevisionConflict(params: { workItemId: number; expectedRevision: number }): never {
  throw new DashboardIntegrationError(
    'conflict',
    `Work item id=${params.workItemId} revision conflict (expected ${params.expectedRevision}).`,
    {
      status: 409,
      details: {
        workItemId: params.workItemId,
        expectedRevision: params.expectedRevision,
      },
    },
  );
}

function toTransitionConflictError(error: unknown): DashboardIntegrationError {
  const message = error instanceof Error ? error.message : String(error);
  return new DashboardIntegrationError('conflict', message, {
    status: 409,
    details: {
      kind: 'work_item_transition',
    },
    cause: error,
  });
}

function toHierarchyConflictError(error: unknown): DashboardIntegrationError {
  const message = error instanceof Error ? error.message : String(error);
  return new DashboardIntegrationError('conflict', message, {
    status: 409,
    details: {
      kind: 'work_item_hierarchy',
    },
    cause: error,
  });
}

export type WorkItemOperations = {
  listWorkItems: (repositoryId: number) => Promise<DashboardListWorkItemsResult>;
  getRepositoryBoardEventsSnapshot: (params: {
    repositoryId: number;
    lastEventId?: number;
    limit?: number;
  }) => Promise<DashboardBoardEventsSnapshot>;
  getWorkItem: (params: { repositoryId: number; workItemId: number }) => Promise<DashboardGetWorkItemResult>;
  createWorkItem: (request: DashboardCreateWorkItemRequest) => Promise<DashboardCreateWorkItemResult>;
  updateWorkItemFields: (request: DashboardUpdateWorkItemFieldsRequest) => Promise<DashboardUpdateWorkItemFieldsResult>;
  moveWorkItemStatus: (request: DashboardMoveWorkItemStatusRequest) => Promise<DashboardMoveWorkItemStatusResult>;
  setWorkItemParent: (request: DashboardSetWorkItemParentRequest) => Promise<DashboardSetWorkItemParentResult>;
  proposeStoryBreakdown: (request: DashboardProposeStoryBreakdownRequest) => Promise<DashboardProposeStoryBreakdownResult>;
  approveStoryBreakdown: (request: DashboardApproveStoryBreakdownRequest) => Promise<DashboardApproveStoryBreakdownResult>;
};

export function createWorkItemOperations(params: { withDatabase: WithDatabase }): WorkItemOperations {
  const { withDatabase } = params;

  return {
    listWorkItems(repositoryIdRaw): Promise<DashboardListWorkItemsResult> {
      const repositoryId = requireRepositoryId(repositoryIdRaw);
      return withDatabase(db => {
        const repository = db
          .select({ id: repositories.id })
          .from(repositories)
          .where(eq(repositories.id, repositoryId))
          .get();
        if (!repository) {
          throw new DashboardIntegrationError('not_found', `Repository id=${repositoryId} was not found.`, {
            status: 404,
          });
        }

        const rows = db.select().from(workItems).where(eq(workItems.repositoryId, repositoryId)).all();
        return { workItems: rows.map(toWorkItemSnapshot) };
      });
    },

    getRepositoryBoardEventsSnapshot(paramsRaw): Promise<DashboardBoardEventsSnapshot> {
      const repositoryId = requireRepositoryId(paramsRaw.repositoryId);
      const lastEventId = requireLastEventId(paramsRaw.lastEventId ?? 0);
      const limit = requireSnapshotLimit(paramsRaw.limit ?? MAX_BOARD_EVENT_SNAPSHOT_EVENTS);

      return withDatabase(db => {
        const repository = db
          .select({ id: repositories.id })
          .from(repositories)
          .where(eq(repositories.id, repositoryId))
          .get();
        if (!repository) {
          throw new DashboardIntegrationError('not_found', `Repository id=${repositoryId} was not found.`, {
            status: 404,
          });
        }

        const latestEvent = db
          .select({ id: workItemEvents.id })
          .from(workItemEvents)
          .where(eq(workItemEvents.repositoryId, repositoryId))
          .orderBy(desc(workItemEvents.id))
          .limit(1)
          .get();

        const events = db
          .select()
          .from(workItemEvents)
          .where(
            and(
              eq(workItemEvents.repositoryId, repositoryId),
              sql`${workItemEvents.id} > ${lastEventId}`,
            ),
          )
          .orderBy(asc(workItemEvents.id))
          .limit(limit)
          .all();

        return {
          repositoryId,
          latestEventId: latestEvent?.id ?? 0,
          events: events.map(toBoardEventSnapshot),
        };
      });
    },

    getWorkItem(paramsRaw): Promise<DashboardGetWorkItemResult> {
      const repositoryId = requireRepositoryId(paramsRaw.repositoryId);
      const workItemId = requireWorkItemId(paramsRaw.workItemId);
      return withDatabase(db => {
        const row = readWorkItemOrThrow(db, { repositoryId, workItemId });
        return { workItem: toWorkItemSnapshot(row) };
      });
    },

    createWorkItem(requestRaw): Promise<DashboardCreateWorkItemResult> {
      const repositoryId = requireRepositoryId(requestRaw.repositoryId);
      const type = requestRaw.type;
      const title = requestRaw.title.trim();
      if (title.length === 0) {
        throw new DashboardIntegrationError('invalid_request', 'title cannot be empty.', { status: 400 });
      }

      const status = requestRaw.status ?? 'Draft';
      if (!isValidStatusForType(type, status)) {
        throw new DashboardIntegrationError('invalid_request', `Invalid status "${status}" for type "${type}".`, {
          status: 400,
        });
      }

      const actor = requireActor(requestRaw);

      const description = toOptionalNonEmptyTrimmedString(requestRaw.description ?? null);
      const tags = requestRaw.tags ?? null;
      const plannedFiles = requestRaw.plannedFiles ?? null;
      const assignees = requestRaw.assignees ?? null;
      const priority = requestRaw.priority ?? null;
      const estimate = requestRaw.estimate ?? null;
      const parentIdRaw = requestRaw.parentId ?? null;

      if (tags !== null && toStringArrayOrNull(tags) === null) {
        throw new DashboardIntegrationError('invalid_request', 'tags must be an array of strings when provided.', {
          status: 400,
        });
      }
      if (plannedFiles !== null && toStringArrayOrNull(plannedFiles) === null) {
        throw new DashboardIntegrationError('invalid_request', 'plannedFiles must be an array of strings when provided.', {
          status: 400,
        });
      }
      if (assignees !== null && toStringArrayOrNull(assignees) === null) {
        throw new DashboardIntegrationError('invalid_request', 'assignees must be an array of strings when provided.', {
          status: 400,
        });
      }

      const occurredAt = new Date().toISOString();

      return withDatabase(db =>
        db.transaction(tx => {
          const repository = tx
            .select({ id: repositories.id })
            .from(repositories)
            .where(eq(repositories.id, repositoryId))
            .get();
          if (!repository) {
            throw new DashboardIntegrationError('not_found', `Repository id=${repositoryId} was not found.`, {
              status: 404,
            });
          }

          let parentId: number | null = null;
          if (parentIdRaw !== null) {
            parentId = requireWorkItemId(parentIdRaw, 'parentId');
            const parent = readWorkItemOrThrow(tx, {
              repositoryId,
              workItemId: parentId,
              notFoundMessage: `Parent work item id=${parentId} was not found.`,
            });
            try {
              validateParentChildWorkItemTypes(parent.type as WorkItemType, type);
            } catch (error) {
              throw toHierarchyConflictError(error);
            }
          }

          const insertResult = tx
            .insert(workItems)
            .values({
              repositoryId,
              type,
              status,
              title,
              description,
              parentId,
              tags,
              plannedFiles,
              assignees,
              priority,
              estimate,
              revision: 0,
              createdAt: occurredAt,
              updatedAt: occurredAt,
            })
            .run();
          const workItemId = Number(insertResult.lastInsertRowid);
          const inserted = readWorkItemOrThrow(tx, { repositoryId, workItemId });

          insertEvent(tx, {
            repositoryId,
            workItemId,
            eventType: 'created',
            actorType: actor.actorType,
            actorLabel: actor.actorLabel,
            occurredAt,
            payload: {
              type,
              status,
              title,
              parentId,
              tags,
              plannedFiles,
              assignees,
              priority,
              estimate,
              revision: 0,
            },
          });

          return {
            workItem: toWorkItemSnapshot(inserted),
          };
        }),
      );
    },

    updateWorkItemFields(requestRaw): Promise<DashboardUpdateWorkItemFieldsResult> {
      const repositoryId = requireRepositoryId(requestRaw.repositoryId);
      const workItemId = requireWorkItemId(requestRaw.workItemId);
      const expectedRevision = requireExpectedRevision(requestRaw.expectedRevision);
      const actor = requireActor(requestRaw);

      const title = requestRaw.title !== undefined ? requestRaw.title.trim() : undefined;
      if (title !== undefined && title.length === 0) {
        throw new DashboardIntegrationError('invalid_request', 'title cannot be empty when provided.', { status: 400 });
      }

      const description = requestRaw.description !== undefined ? toOptionalNonEmptyTrimmedString(requestRaw.description) : undefined;
      const tags = requestRaw.tags !== undefined ? requestRaw.tags : undefined;
      const plannedFiles = requestRaw.plannedFiles !== undefined ? requestRaw.plannedFiles : undefined;
      const assignees = requestRaw.assignees !== undefined ? requestRaw.assignees : undefined;
      const priority = requestRaw.priority !== undefined ? requestRaw.priority : undefined;
      const estimate = requestRaw.estimate !== undefined ? requestRaw.estimate : undefined;

      if (tags !== undefined && tags !== null && toStringArrayOrNull(tags) === null) {
        throw new DashboardIntegrationError('invalid_request', 'tags must be an array of strings when provided.', {
          status: 400,
        });
      }
      if (plannedFiles !== undefined && plannedFiles !== null && toStringArrayOrNull(plannedFiles) === null) {
        throw new DashboardIntegrationError('invalid_request', 'plannedFiles must be an array of strings when provided.', {
          status: 400,
        });
      }
      if (assignees !== undefined && assignees !== null && toStringArrayOrNull(assignees) === null) {
        throw new DashboardIntegrationError('invalid_request', 'assignees must be an array of strings when provided.', {
          status: 400,
        });
      }

      const hasUpdate =
        title !== undefined ||
        description !== undefined ||
        tags !== undefined ||
        plannedFiles !== undefined ||
        assignees !== undefined ||
        priority !== undefined ||
        estimate !== undefined;
      if (!hasUpdate) {
        throw new DashboardIntegrationError('invalid_request', 'No updatable fields were provided.', { status: 400 });
      }

      const occurredAt = new Date().toISOString();

      return withDatabase(db =>
        db.transaction(tx => {
          const existing = readWorkItemOrThrow(tx, { repositoryId, workItemId });
          if (existing.revision !== expectedRevision) {
            throwRevisionConflict({ workItemId, expectedRevision });
          }

          const nextRevision = expectedRevision + 1;
          const updateValues: Partial<typeof workItems.$inferInsert> = {
            updatedAt: occurredAt,
            revision: nextRevision,
          };
          if (title !== undefined) updateValues.title = title;
          if (description !== undefined) updateValues.description = description;
          if (tags !== undefined) updateValues.tags = tags;
          if (plannedFiles !== undefined) updateValues.plannedFiles = plannedFiles;
          if (assignees !== undefined) updateValues.assignees = assignees;
          if (priority !== undefined) updateValues.priority = priority;
          if (estimate !== undefined) updateValues.estimate = estimate;

          const updated = tx
            .update(workItems)
            .set(updateValues)
            .where(
              and(
                eq(workItems.repositoryId, repositoryId),
                eq(workItems.id, workItemId),
                eq(workItems.revision, expectedRevision),
              ),
            )
            .run();

          if (updated.changes !== 1) {
            throwRevisionConflict({ workItemId, expectedRevision });
          }

          insertEvent(tx, {
            repositoryId,
            workItemId,
            eventType: 'updated',
            actorType: actor.actorType,
            actorLabel: actor.actorLabel,
            occurredAt,
            payload: {
              expectedRevision,
              revision: nextRevision,
              changes: {
                ...(title !== undefined ? { title } : {}),
                ...(description !== undefined ? { description } : {}),
                ...(tags !== undefined ? { tags } : {}),
                ...(plannedFiles !== undefined ? { plannedFiles } : {}),
                ...(assignees !== undefined ? { assignees } : {}),
                ...(priority !== undefined ? { priority } : {}),
                ...(estimate !== undefined ? { estimate } : {}),
              },
            },
          });

          const reloaded = readWorkItemOrThrow(tx, { repositoryId, workItemId });
          return {
            workItem: toWorkItemSnapshot(reloaded),
          };
        }),
      );
    },

    moveWorkItemStatus(requestRaw): Promise<DashboardMoveWorkItemStatusResult> {
      const repositoryId = requireRepositoryId(requestRaw.repositoryId);
      const workItemId = requireWorkItemId(requestRaw.workItemId);
      const expectedRevision = requireExpectedRevision(requestRaw.expectedRevision);
      const toStatus = requestRaw.toStatus;
      const actor = requireActor(requestRaw);

      const occurredAt = new Date().toISOString();

      return withDatabase(db =>
        db.transaction(tx => {
          const existing = readWorkItemOrThrow(tx, { repositoryId, workItemId });
          if (existing.revision !== expectedRevision) {
            throwRevisionConflict({ workItemId, expectedRevision });
          }

          const type = existing.type as WorkItemType;
          const fromStatus = existing.status;
          try {
            validateTransition({ type, from: fromStatus, to: toStatus });
          } catch (error) {
            throw toTransitionConflictError(error);
          }

          const nextRevision = expectedRevision + 1;
          const updated = tx
            .update(workItems)
            .set({ status: toStatus, updatedAt: occurredAt, revision: nextRevision })
            .where(
              and(
                eq(workItems.repositoryId, repositoryId),
                eq(workItems.id, workItemId),
                eq(workItems.revision, expectedRevision),
              ),
            )
            .run();

          if (updated.changes !== 1) {
            throwRevisionConflict({ workItemId, expectedRevision });
          }

          insertEvent(tx, {
            repositoryId,
            workItemId,
            eventType: 'status_changed',
            actorType: actor.actorType,
            actorLabel: actor.actorLabel,
            occurredAt,
            payload: {
              type,
              fromStatus,
              toStatus,
              expectedRevision,
              revision: nextRevision,
            },
          });

          const reloaded = readWorkItemOrThrow(tx, { repositoryId, workItemId });
          return { workItem: toWorkItemSnapshot(reloaded) };
        }),
      );
    },

    setWorkItemParent(requestRaw): Promise<DashboardSetWorkItemParentResult> {
      const repositoryId = requireRepositoryId(requestRaw.repositoryId);
      const workItemId = requireWorkItemId(requestRaw.workItemId);
      const expectedRevision = requireExpectedRevision(requestRaw.expectedRevision);
      const actor = requireActor(requestRaw);

      const parentId = requestRaw.parentId === null ? null : requireWorkItemId(requestRaw.parentId, 'parentId');
      const occurredAt = new Date().toISOString();

      return withDatabase(db =>
        db.transaction(tx => {
          const existing = readWorkItemOrThrow(tx, { repositoryId, workItemId });
          if (existing.revision !== expectedRevision) {
            throwRevisionConflict({ workItemId, expectedRevision });
          }

          let parent: WorkItemRow | null = null;
          if (parentId !== null) {
            parent = readWorkItemOrThrow(tx, {
              repositoryId,
              workItemId: parentId,
              notFoundMessage: `Parent work item id=${parentId} was not found.`,
            });
            try {
              validateParentChildWorkItemTypes(parent.type as WorkItemType, existing.type as WorkItemType);
            } catch (error) {
              throw toHierarchyConflictError(error);
            }
          }

          const nextRevision = expectedRevision + 1;
          const updated = tx
            .update(workItems)
            .set({
              parentId,
              updatedAt: occurredAt,
              revision: nextRevision,
            })
            .where(
              and(
                eq(workItems.repositoryId, repositoryId),
                eq(workItems.id, workItemId),
                eq(workItems.revision, expectedRevision),
              ),
            )
            .run();

          if (updated.changes !== 1) {
            throwRevisionConflict({ workItemId, expectedRevision });
          }

          insertEvent(tx, {
            repositoryId,
            workItemId,
            eventType: 'reparented',
            actorType: actor.actorType,
            actorLabel: actor.actorLabel,
            occurredAt,
            payload: {
              fromParentId: existing.parentId,
              toParentId: parentId,
              parentType: parent?.type ?? null,
              childType: existing.type,
              expectedRevision,
              revision: nextRevision,
            },
          });

          const reloaded = readWorkItemOrThrow(tx, { repositoryId, workItemId });
          return { workItem: toWorkItemSnapshot(reloaded) };
        }),
      );
    },

    proposeStoryBreakdown(requestRaw): Promise<DashboardProposeStoryBreakdownResult> {
      const repositoryId = requireRepositoryId(requestRaw.repositoryId);
      const storyId = requireWorkItemId(requestRaw.storyId, 'storyId');
      const expectedRevision = requireExpectedRevision(requestRaw.expectedRevision);
      const actor = requireActor(requestRaw);

      const proposed = requestRaw.proposed;
      if (proposed.tasks.length === 0) {
        throw new DashboardIntegrationError('invalid_request', 'proposed.tasks cannot be empty.', { status: 400 });
      }

      for (const [idx, task] of proposed.tasks.entries()) {
        const taskTitle = task.title.trim();
        if (taskTitle.length === 0) {
          throw new DashboardIntegrationError('invalid_request', `proposed.tasks[${idx}].title cannot be empty.`, {
            status: 400,
          });
        }
        if (task.tags !== undefined && task.tags !== null && toStringArrayOrNull(task.tags) === null) {
          throw new DashboardIntegrationError(
            'invalid_request',
            `proposed.tasks[${idx}].tags must be an array of strings when provided.`,
            { status: 400 },
          );
        }
        if (task.plannedFiles !== undefined && task.plannedFiles !== null && toStringArrayOrNull(task.plannedFiles) === null) {
          throw new DashboardIntegrationError(
            'invalid_request',
            `proposed.tasks[${idx}].plannedFiles must be an array of strings when provided.`,
            { status: 400 },
          );
        }
        if (task.assignees !== undefined && task.assignees !== null && toStringArrayOrNull(task.assignees) === null) {
          throw new DashboardIntegrationError(
            'invalid_request',
            `proposed.tasks[${idx}].assignees must be an array of strings when provided.`,
            { status: 400 },
          );
        }
        if (task.links !== undefined && task.links !== null && toStringArrayOrNull(task.links) === null) {
          throw new DashboardIntegrationError(
            'invalid_request',
            `proposed.tasks[${idx}].links must be an array of strings when provided.`,
            { status: 400 },
          );
        }
      }

      if (proposed.tags !== undefined && proposed.tags !== null && toStringArrayOrNull(proposed.tags) === null) {
        throw new DashboardIntegrationError('invalid_request', 'proposed.tags must be an array of strings when provided.', {
          status: 400,
        });
      }
      if (proposed.plannedFiles !== undefined && proposed.plannedFiles !== null && toStringArrayOrNull(proposed.plannedFiles) === null) {
        throw new DashboardIntegrationError(
          'invalid_request',
          'proposed.plannedFiles must be an array of strings when provided.',
          { status: 400 },
        );
      }
      if (proposed.links !== undefined && proposed.links !== null && toStringArrayOrNull(proposed.links) === null) {
        throw new DashboardIntegrationError('invalid_request', 'proposed.links must be an array of strings when provided.', {
          status: 400,
        });
      }

      const occurredAt = new Date().toISOString();

      return withDatabase(db =>
        db.transaction(tx => {
          const story = readWorkItemOrThrow(tx, {
            repositoryId,
            workItemId: storyId,
            notFoundMessage: `Story id=${storyId} was not found.`,
          });
          if (story.type !== 'story') {
            throw new DashboardIntegrationError('invalid_request', `Work item id=${storyId} is not a story.`, {
              status: 400,
            });
          }
          if (story.revision !== expectedRevision) {
            throwRevisionConflict({ workItemId: storyId, expectedRevision });
          }

          try {
            validateTransition({ type: 'story', from: story.status, to: 'BreakdownProposed' });
          } catch (error) {
            throw toTransitionConflictError(error);
          }

          const insertedTasks: WorkItemRow[] = [];
          const createdTaskIds: number[] = [];
          for (const task of proposed.tasks) {
            const insertResult = tx
              .insert(workItems)
              .values({
                repositoryId,
                type: 'task',
                status: 'Draft',
                title: task.title.trim(),
                description: toOptionalNonEmptyTrimmedString(task.description ?? null),
                parentId: storyId,
                tags: task.tags ?? null,
                plannedFiles: task.plannedFiles ?? null,
                assignees: task.assignees ?? null,
                priority: task.priority ?? null,
                estimate: task.estimate ?? null,
                revision: 0,
                createdAt: occurredAt,
                updatedAt: occurredAt,
              })
              .run();

            const insertedId = Number(insertResult.lastInsertRowid);
            const inserted = readWorkItemOrThrow(tx, { repositoryId, workItemId: insertedId });

            insertedTasks.push(inserted);
            createdTaskIds.push(insertedId);

            insertEvent(tx, {
              repositoryId,
              workItemId: insertedId,
              eventType: 'created',
              actorType: actor.actorType,
              actorLabel: actor.actorLabel,
              occurredAt,
              payload: {
                type: 'task',
                status: 'Draft',
                title: inserted.title,
                parentId: storyId,
                tags: inserted.tags,
                plannedFiles: inserted.plannedFiles,
                assignees: inserted.assignees,
                priority: inserted.priority,
                estimate: inserted.estimate,
                revision: 0,
                links: task.links ?? null,
              },
            });
          }

          const storyNextRevision = expectedRevision + 1;
          const updatedStory = tx
            .update(workItems)
            .set({
              status: 'BreakdownProposed',
              updatedAt: occurredAt,
              revision: storyNextRevision,
            })
            .where(and(eq(workItems.repositoryId, repositoryId), eq(workItems.id, storyId), eq(workItems.revision, expectedRevision)))
            .run();
          if (updatedStory.changes !== 1) {
            throwRevisionConflict({ workItemId: storyId, expectedRevision });
          }

          insertEvent(tx, {
            repositoryId,
            workItemId: storyId,
            eventType: 'breakdown_proposed',
            actorType: actor.actorType,
            actorLabel: actor.actorLabel,
            occurredAt,
            payload: {
              fromStatus: story.status,
              toStatus: 'BreakdownProposed',
              expectedRevision,
              revision: storyNextRevision,
              createdTaskIds,
              proposed: {
                tags: proposed.tags ?? null,
                plannedFiles: proposed.plannedFiles ?? null,
                links: proposed.links ?? null,
                tasks: proposed.tasks.map(task => ({
                  title: task.title.trim(),
                  description: toOptionalNonEmptyTrimmedString(task.description ?? null),
                  tags: task.tags ?? null,
                  plannedFiles: task.plannedFiles ?? null,
                  assignees: task.assignees ?? null,
                  priority: task.priority ?? null,
                  estimate: task.estimate ?? null,
                  links: task.links ?? null,
                })),
              },
            },
          });

          const reloadedStory = readWorkItemOrThrow(tx, { repositoryId, workItemId: storyId });
          return {
            story: toWorkItemSnapshot(reloadedStory),
            tasks: insertedTasks.map(toWorkItemSnapshot),
          };
        }),
      );
    },

    approveStoryBreakdown(requestRaw): Promise<DashboardApproveStoryBreakdownResult> {
      const repositoryId = requireRepositoryId(requestRaw.repositoryId);
      const storyId = requireWorkItemId(requestRaw.storyId, 'storyId');
      const expectedRevision = requireExpectedRevision(requestRaw.expectedRevision);
      const actor = requireActor(requestRaw);

      const occurredAt = new Date().toISOString();

      return withDatabase(db =>
        db.transaction(tx => {
          const story = readWorkItemOrThrow(tx, {
            repositoryId,
            workItemId: storyId,
            notFoundMessage: `Story id=${storyId} was not found.`,
          });
          if (story.type !== 'story') {
            throw new DashboardIntegrationError('invalid_request', `Work item id=${storyId} is not a story.`, {
              status: 400,
            });
          }
          if (story.revision !== expectedRevision) {
            throwRevisionConflict({ workItemId: storyId, expectedRevision });
          }

          try {
            validateTransition({ type: 'story', from: story.status, to: 'Approved' });
          } catch (error) {
            throw toTransitionConflictError(error);
          }

          const children = tx
            .select()
            .from(workItems)
            .where(
              and(
                eq(workItems.repositoryId, repositoryId),
                eq(workItems.parentId, storyId),
                eq(workItems.type, 'task'),
              ),
            )
            .all();

          if (children.length === 0) {
            throw new DashboardIntegrationError('conflict', 'Cannot approve breakdown without child tasks.', {
              status: 409,
              details: {
                storyId,
              },
            });
          }

          const invalidChildren = children.filter(child => child.status !== 'Draft');
          if (invalidChildren.length > 0) {
            throw new DashboardIntegrationError(
              'conflict',
              'Cannot approve breakdown while child tasks are not in Draft.',
              {
                status: 409,
                details: {
                  childTaskIds: invalidChildren.map(child => child.id),
                },
              },
            );
          }

          const storyNextRevision = expectedRevision + 1;
          const storyUpdate = tx
            .update(workItems)
            .set({
              status: 'Approved',
              updatedAt: occurredAt,
              revision: storyNextRevision,
            })
            .where(and(eq(workItems.repositoryId, repositoryId), eq(workItems.id, storyId), eq(workItems.revision, expectedRevision)))
            .run();
          if (storyUpdate.changes !== 1) {
            throwRevisionConflict({ workItemId: storyId, expectedRevision });
          }

          insertEvent(tx, {
            repositoryId,
            workItemId: storyId,
            eventType: 'breakdown_approved',
            actorType: actor.actorType,
            actorLabel: actor.actorLabel,
            occurredAt,
            payload: {
              fromStatus: story.status,
              toStatus: 'Approved',
              expectedRevision,
              revision: storyNextRevision,
              childTaskIds: children.map(child => child.id),
            },
          });

          const updatedTasks: WorkItemRow[] = [];
          for (const child of children) {
            try {
              validateTransition({ type: 'task', from: child.status, to: 'Ready' });
            } catch (error) {
              throw toTransitionConflictError(error);
            }

            const childNextRevision = child.revision + 1;
            const updated = tx
              .update(workItems)
              .set({
                status: 'Ready',
                updatedAt: occurredAt,
                revision: childNextRevision,
              })
              .where(
                and(
                  eq(workItems.repositoryId, repositoryId),
                  eq(workItems.id, child.id),
                  eq(workItems.revision, child.revision),
                ),
              )
              .run();
            if (updated.changes !== 1) {
              throw new DashboardIntegrationError(
                'conflict',
                `Work item id=${child.id} revision conflict while approving breakdown.`,
                {
                  status: 409,
                  details: {
                    workItemId: child.id,
                    expectedRevision: child.revision,
                  },
                },
              );
            }

            insertEvent(tx, {
              repositoryId,
              workItemId: child.id,
              eventType: 'status_changed',
              actorType: actor.actorType,
              actorLabel: actor.actorLabel,
              occurredAt,
              payload: {
                type: 'task',
                fromStatus: child.status,
                toStatus: 'Ready',
                expectedRevision: child.revision,
                revision: childNextRevision,
                approvedStoryId: storyId,
              },
            });

            const reloaded = readWorkItemOrThrow(tx, { repositoryId, workItemId: child.id });
            updatedTasks.push(reloaded);
          }

          const reloadedStory = readWorkItemOrThrow(tx, { repositoryId, workItemId: storyId });
          return {
            story: toWorkItemSnapshot(reloadedStory),
            tasks: updatedTasks.map(toWorkItemSnapshot),
          };
        }),
      );
    },
  };
}
