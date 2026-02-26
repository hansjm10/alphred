import { and, asc, desc, eq, sql } from 'drizzle-orm';
import {
  guardDefinitions,
  promptTemplates,
  treeEdges,
  treeNodes,
  workflowTrees,
  type AlphredDatabase,
} from '@alphred/db';
import { loadAgentCatalog } from './agent-catalog';
import type {
  DashboardAgentModelOption,
  DashboardAgentProviderOption,
  DashboardDuplicateWorkflowRequest,
  DashboardDuplicateWorkflowResult,
  DashboardPublishWorkflowDraftRequest,
  DashboardWorkflowCatalogItem,
  DashboardWorkflowNodeOption,
  DashboardWorkflowTreeKeyAvailability,
  DashboardWorkflowTreeSnapshot,
  DashboardWorkflowTreeSummary,
} from './dashboard-contracts';
import { DashboardIntegrationError } from './dashboard-errors';
import { loadDraftTopologyByTreeId } from './workflow-draft-operations';
import {
  isWorkflowTreeUniqueConstraintError,
  normalizeExecutionPermissions,
  normalizeWorkflowTreeKey,
  validateDraftTopology,
} from './workflow-validation';

const utcNow = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

type WithDatabase = <T>(operation: (db: AlphredDatabase) => Promise<T> | T) => Promise<T>;

export type WorkflowOperations = {
  listWorkflowTrees: () => Promise<DashboardWorkflowTreeSummary[]>;
  listWorkflowCatalog: () => Promise<DashboardWorkflowCatalogItem[]>;
  listAgentProviders: () => Promise<DashboardAgentProviderOption[]>;
  listAgentModels: () => Promise<DashboardAgentModelOption[]>;
  isWorkflowTreeKeyAvailable: (treeKeyRaw: string) => Promise<DashboardWorkflowTreeKeyAvailability>;
  getWorkflowTreeSnapshot: (treeKeyRaw: string) => Promise<DashboardWorkflowTreeSnapshot>;
  getWorkflowTreeVersionSnapshot: (treeKeyRaw: string, version: number) => Promise<DashboardWorkflowTreeSnapshot>;
  duplicateWorkflowTree: (
    sourceTreeKeyRaw: string,
    request: DashboardDuplicateWorkflowRequest,
  ) => Promise<DashboardDuplicateWorkflowResult>;
  listPublishedTreeNodes: (treeKeyRaw: string) => Promise<DashboardWorkflowNodeOption[]>;
  publishWorkflowDraft: (
    treeKeyRaw: string,
    version: number,
    request: DashboardPublishWorkflowDraftRequest,
  ) => Promise<DashboardWorkflowTreeSummary>;
};

export function createWorkflowOperations(params: {
  withDatabase: WithDatabase;
}): WorkflowOperations {
  const { withDatabase } = params;

  return {
    listWorkflowTrees(): Promise<DashboardWorkflowTreeSummary[]> {
      return withDatabase(async db => {
        const rows = db
          .select({
            id: workflowTrees.id,
            treeKey: workflowTrees.treeKey,
            version: workflowTrees.version,
            name: workflowTrees.name,
            description: workflowTrees.description,
          })
          .from(workflowTrees)
          .where(eq(workflowTrees.status, 'published'))
          .orderBy(asc(workflowTrees.treeKey), desc(workflowTrees.version), desc(workflowTrees.id))
          .all();

        const seen = new Set<string>();
        const workflows: DashboardWorkflowTreeSummary[] = [];
        for (const row of rows) {
          if (seen.has(row.treeKey)) {
            continue;
          }
          seen.add(row.treeKey);
          workflows.push(row);
        }

        return workflows;
      });
    },

    listWorkflowCatalog(): Promise<DashboardWorkflowCatalogItem[]> {
      return withDatabase(async db => {
        const rows = db
          .select({
            treeKey: workflowTrees.treeKey,
            version: workflowTrees.version,
            status: workflowTrees.status,
            name: workflowTrees.name,
            description: workflowTrees.description,
            updatedAt: workflowTrees.updatedAt,
          })
          .from(workflowTrees)
          .orderBy(asc(workflowTrees.treeKey), desc(workflowTrees.version), desc(workflowTrees.id))
          .all();

        const catalogByKey = new Map<string, DashboardWorkflowCatalogItem>();
        for (const row of rows) {
          const existing = catalogByKey.get(row.treeKey);
          if (!existing) {
            catalogByKey.set(row.treeKey, {
              treeKey: row.treeKey,
              name: row.name,
              description: row.description,
              publishedVersion: row.status === 'published' ? row.version : null,
              draftVersion: row.status === 'draft' ? row.version : null,
              updatedAt: row.updatedAt,
            });
            continue;
          }

          if (existing.publishedVersion === null && row.status === 'published') {
            existing.publishedVersion = row.version;
          }
          if (existing.draftVersion === null && row.status === 'draft') {
            existing.draftVersion = row.version;
            existing.updatedAt = row.updatedAt;
          }
        }

        return [...catalogByKey.values()];
      });
    },

    listAgentProviders(): Promise<DashboardAgentProviderOption[]> {
      return withDatabase(async db => {
        const catalog = loadAgentCatalog(db);
        return catalog.providerOptions;
      });
    },

    listAgentModels(): Promise<DashboardAgentModelOption[]> {
      return withDatabase(async db => {
        const catalog = loadAgentCatalog(db);
        return catalog.modelOptions;
      });
    },

    isWorkflowTreeKeyAvailable(treeKeyRaw: string): Promise<DashboardWorkflowTreeKeyAvailability> {
      const treeKey = normalizeWorkflowTreeKey(treeKeyRaw);

      return withDatabase(async db => {
        const existing = db
          .select({ id: workflowTrees.id })
          .from(workflowTrees)
          .where(eq(workflowTrees.treeKey, treeKey))
          .limit(1)
          .get();

        return {
          treeKey,
          available: existing === undefined,
        };
      });
    },

    async getWorkflowTreeSnapshot(treeKeyRaw: string): Promise<DashboardWorkflowTreeSnapshot> {
      const treeKey = normalizeWorkflowTreeKey(treeKeyRaw);

      return withDatabase(async db => {
        const draft = db
          .select({
            id: workflowTrees.id,
            version: workflowTrees.version,
            status: workflowTrees.status,
            name: workflowTrees.name,
            description: workflowTrees.description,
            versionNotes: workflowTrees.versionNotes,
            draftRevision: workflowTrees.draftRevision,
          })
          .from(workflowTrees)
          .where(and(eq(workflowTrees.treeKey, treeKey), eq(workflowTrees.status, 'draft')))
          .orderBy(desc(workflowTrees.version), desc(workflowTrees.id))
          .get();

        const published = draft
          ? null
          : db
              .select({
                id: workflowTrees.id,
                version: workflowTrees.version,
                status: workflowTrees.status,
                name: workflowTrees.name,
                description: workflowTrees.description,
                versionNotes: workflowTrees.versionNotes,
                draftRevision: workflowTrees.draftRevision,
              })
              .from(workflowTrees)
              .where(and(eq(workflowTrees.treeKey, treeKey), eq(workflowTrees.status, 'published')))
              .orderBy(desc(workflowTrees.version), desc(workflowTrees.id))
              .get();

        const record = draft ?? published;
        if (!record) {
          throw new DashboardIntegrationError('not_found', `Workflow tree "${treeKey}" was not found.`, {
            status: 404,
          });
        }

        const catalog = loadAgentCatalog(db);
        const topology = loadDraftTopologyByTreeId(db, record.id, catalog);
        return {
          status: record.status as 'draft' | 'published',
          treeKey,
          version: record.version,
          draftRevision: record.draftRevision,
          name: record.name,
          description: record.description,
          versionNotes: record.versionNotes,
          ...topology,
        };
      });
    },

    async getWorkflowTreeVersionSnapshot(treeKeyRaw: string, version: number): Promise<DashboardWorkflowTreeSnapshot> {
      const treeKey = normalizeWorkflowTreeKey(treeKeyRaw);
      if (!Number.isInteger(version) || version < 1) {
        throw new DashboardIntegrationError('invalid_request', 'Workflow version must be a positive integer.', {
          status: 400,
        });
      }

      return withDatabase(async db => {
        const record = db
          .select({
            id: workflowTrees.id,
            version: workflowTrees.version,
            status: workflowTrees.status,
            name: workflowTrees.name,
            description: workflowTrees.description,
            versionNotes: workflowTrees.versionNotes,
            draftRevision: workflowTrees.draftRevision,
          })
          .from(workflowTrees)
          .where(and(eq(workflowTrees.treeKey, treeKey), eq(workflowTrees.version, version)))
          .get();

        if (!record) {
          throw new DashboardIntegrationError('not_found', `Workflow tree "${treeKey}" v${version} was not found.`, {
            status: 404,
          });
        }

        const catalog = loadAgentCatalog(db);
        const topology = loadDraftTopologyByTreeId(db, record.id, catalog);
        return {
          status: record.status as 'draft' | 'published',
          treeKey,
          version: record.version,
          draftRevision: record.draftRevision,
          name: record.name,
          description: record.description,
          versionNotes: record.versionNotes,
          ...topology,
        };
      });
    },

    listPublishedTreeNodes(treeKeyRaw: string): Promise<DashboardWorkflowNodeOption[]> {
      const treeKey = normalizeWorkflowTreeKey(treeKeyRaw);

      return withDatabase(async db => {
        const published = db
          .select({ id: workflowTrees.id })
          .from(workflowTrees)
          .where(and(eq(workflowTrees.treeKey, treeKey), eq(workflowTrees.status, 'published')))
          .orderBy(desc(workflowTrees.version), desc(workflowTrees.id))
          .get();

        if (!published) {
          throw new DashboardIntegrationError('not_found', `Published workflow tree "${treeKey}" was not found.`, {
            status: 404,
          });
        }

        const rows = db
          .select({
            nodeKey: treeNodes.nodeKey,
            displayName: treeNodes.displayName,
          })
          .from(treeNodes)
          .where(eq(treeNodes.workflowTreeId, published.id))
          .orderBy(asc(treeNodes.sequenceIndex), asc(treeNodes.nodeKey))
          .all();

        return rows.map(row => ({
          nodeKey: row.nodeKey,
          displayName: row.displayName ?? row.nodeKey,
        }));
      });
    },

    async duplicateWorkflowTree(
      sourceTreeKeyRaw: string,
      request: DashboardDuplicateWorkflowRequest,
    ): Promise<DashboardDuplicateWorkflowResult> {
      const sourceTreeKey = normalizeWorkflowTreeKey(sourceTreeKeyRaw);

      const name = request.name.trim();
      if (name.length === 0) {
        throw new DashboardIntegrationError('invalid_request', 'Workflow name cannot be empty.', { status: 400 });
      }

      const treeKey = normalizeWorkflowTreeKey(request.treeKey);
      const description = request.description?.trim() ?? null;

      return withDatabase(async db =>
        db.transaction((tx) => {
          const existing = tx
            .select({ id: workflowTrees.id })
            .from(workflowTrees)
            .where(eq(workflowTrees.treeKey, treeKey))
            .get();
          if (existing) {
            throw new DashboardIntegrationError('conflict', `Workflow tree "${treeKey}" already exists.`, { status: 409 });
          }

          const draftSource = tx
            .select({ id: workflowTrees.id })
            .from(workflowTrees)
            .where(and(eq(workflowTrees.treeKey, sourceTreeKey), eq(workflowTrees.status, 'draft')))
            .orderBy(desc(workflowTrees.version), desc(workflowTrees.id))
            .get();

          const publishedSource = draftSource
            ? null
            : tx
                .select({ id: workflowTrees.id })
                .from(workflowTrees)
                .where(and(eq(workflowTrees.treeKey, sourceTreeKey), eq(workflowTrees.status, 'published')))
                .orderBy(desc(workflowTrees.version), desc(workflowTrees.id))
                .get();

          const sourceRecord = draftSource ?? publishedSource;
          if (!sourceRecord) {
            throw new DashboardIntegrationError('not_found', `Workflow tree "${sourceTreeKey}" was not found.`, {
              status: 404,
            });
          }

          const catalog = loadAgentCatalog(tx);
          const topology = loadDraftTopologyByTreeId(tx, sourceRecord.id, catalog);

          let insertedTree: { id: number };
          try {
            insertedTree = tx
              .insert(workflowTrees)
              .values({
                treeKey,
                version: 1,
                status: 'draft',
                name,
                description,
                versionNotes: null,
                draftRevision: 0,
              })
              .returning({ id: workflowTrees.id })
              .get();
          } catch (error) {
            if (isWorkflowTreeUniqueConstraintError(error)) {
              throw new DashboardIntegrationError('conflict', `Workflow tree "${treeKey}" already exists.`, {
                status: 409,
                cause: error,
              });
            }
            throw error;
          }

          const promptTemplateIdByNodeKey = new Map<string, number>();
          for (const node of topology.nodes) {
            if (!node.promptTemplate) {
              continue;
            }
            const inserted = tx
              .insert(promptTemplates)
              .values({
                templateKey: `${treeKey}/v1/${node.nodeKey}/prompt`,
                version: 1,
                content: node.promptTemplate.content,
                contentType: node.promptTemplate.contentType,
              })
              .returning({ id: promptTemplates.id })
              .get();
            promptTemplateIdByNodeKey.set(node.nodeKey, inserted.id);
          }

          const nodeIdByKey = new Map<string, number>();
          for (const node of topology.nodes) {
            const inserted = tx
              .insert(treeNodes)
              .values({
                workflowTreeId: insertedTree.id,
                nodeKey: node.nodeKey,
                displayName: node.displayName,
                nodeType: node.nodeType,
                provider: node.provider,
                model: node.model,
                executionPermissions: normalizeExecutionPermissions(node.executionPermissions),
                promptTemplateId: promptTemplateIdByNodeKey.get(node.nodeKey) ?? null,
                maxRetries: node.maxRetries,
                sequenceIndex: node.sequenceIndex,
                positionX: node.position?.x ?? null,
                positionY: node.position?.y ?? null,
              })
              .returning({ id: treeNodes.id })
              .get();
            nodeIdByKey.set(node.nodeKey, inserted.id);
          }

          const guardDefinitionIdByKey = new Map<string, number>();
          for (const edge of topology.edges) {
            if (edge.auto || edge.guardExpression === null) {
              continue;
            }
            const routeOn = edge.routeOn === 'failure' ? 'failure' : 'success';
            const key = `${routeOn}/${edge.sourceNodeKey}->${edge.targetNodeKey}/priority-${edge.priority}`;
            const inserted = tx
              .insert(guardDefinitions)
              .values({
                guardKey: `${treeKey}/v1/${key}`,
                version: 1,
                expression: edge.guardExpression,
                description: null,
              })
              .returning({ id: guardDefinitions.id })
              .get();
            guardDefinitionIdByKey.set(key, inserted.id);
          }

          for (const edge of topology.edges) {
            const sourceNodeId = nodeIdByKey.get(edge.sourceNodeKey);
            const targetNodeId = nodeIdByKey.get(edge.targetNodeKey);
            if (!sourceNodeId || !targetNodeId) {
              throw new DashboardIntegrationError(
                'internal_error',
                `Failed to resolve node IDs for transition ${edge.sourceNodeKey} → ${edge.targetNodeKey}.`,
                {
                  status: 500,
                  details: { sourceNodeKey: edge.sourceNodeKey, targetNodeKey: edge.targetNodeKey },
                },
              );
            }

            const routeOn = edge.routeOn === 'failure' ? 'failure' : 'success';
            const key = `${routeOn}/${edge.sourceNodeKey}->${edge.targetNodeKey}/priority-${edge.priority}`;
            if (!edge.auto && !guardDefinitionIdByKey.has(key)) {
              throw new DashboardIntegrationError(
                'internal_error',
                `Failed to resolve guard definition for transition ${edge.sourceNodeKey} → ${edge.targetNodeKey} (priority ${edge.priority}).`,
                {
                  status: 500,
                  details: { transitionKey: key },
                },
              );
            }

            tx.insert(treeEdges)
              .values({
                workflowTreeId: insertedTree.id,
                sourceNodeId,
                targetNodeId,
                routeOn,
                priority: edge.priority,
                auto: edge.auto ? 1 : 0,
                guardDefinitionId: edge.auto ? null : (guardDefinitionIdByKey.get(key) ?? null),
              })
              .run();
          }

          return { treeKey, draftVersion: 1 };
        }),
      );
    },

    async publishWorkflowDraft(
      treeKeyRaw: string,
      version: number,
      request: DashboardPublishWorkflowDraftRequest,
    ): Promise<DashboardWorkflowTreeSummary> {
      const treeKey = normalizeWorkflowTreeKey(treeKeyRaw);
      if (!Number.isInteger(version) || version < 1) {
        throw new DashboardIntegrationError('invalid_request', 'Workflow version must be a positive integer.', {
          status: 400,
        });
      }

      return withDatabase(async db => {
        const catalog = loadAgentCatalog(db);
        const tree = db
          .select({
            id: workflowTrees.id,
            name: workflowTrees.name,
            description: workflowTrees.description,
            draftRevision: workflowTrees.draftRevision,
          })
          .from(workflowTrees)
          .where(and(eq(workflowTrees.treeKey, treeKey), eq(workflowTrees.version, version), eq(workflowTrees.status, 'draft')))
          .get();
        if (!tree) {
          throw new DashboardIntegrationError('not_found', `Draft workflow tree "${treeKey}" v${version} was not found.`, {
            status: 404,
          });
        }

        const topology = loadDraftTopologyByTreeId(db, tree.id, catalog);
        const validation = validateDraftTopology({ nodes: topology.nodes, edges: topology.edges }, 'publish', catalog);
        if (validation.errors.length > 0) {
          throw new DashboardIntegrationError('invalid_request', 'Draft workflow failed validation and cannot be published.', {
            status: 400,
            details: validation as unknown as Record<string, unknown>,
          });
        }

        const nextVersionNotes =
          request.versionNotes === undefined ? undefined : (request.versionNotes.trim().length > 0 ? request.versionNotes.trim() : null);

        const publishUpdate = db.update(workflowTrees)
          .set({
            status: 'published',
            updatedAt: utcNow,
            draftRevision: 0,
            ...(nextVersionNotes === undefined ? {} : { versionNotes: nextVersionNotes }),
          })
          .where(
            and(
              eq(workflowTrees.id, tree.id),
              eq(workflowTrees.status, 'draft'),
              eq(workflowTrees.draftRevision, tree.draftRevision),
            ),
          )
          .run();
        if (publishUpdate.changes !== 1) {
          throw new DashboardIntegrationError(
            'conflict',
            'Draft workflow changed while publishing. Refresh the editor and try publishing again.',
            {
              status: 409,
              details: {
                expectedDraftRevision: tree.draftRevision,
              },
            },
          );
        }

        return {
          id: tree.id,
          treeKey,
          version,
          name: tree.name,
          description: tree.description,
        };
      });
    },
  };
}
