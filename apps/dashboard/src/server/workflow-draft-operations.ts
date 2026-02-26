import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  guardDefinitions,
  promptTemplates,
  treeEdges,
  treeNodes,
  workflowTrees,
  type AlphredDatabase,
} from '@alphred/db';
import { loadAgentCatalog, resolveDefaultModelForProvider, type AgentCatalog } from './agent-catalog';
import type {
  DashboardCreateWorkflowRequest,
  DashboardCreateWorkflowResult,
  DashboardWorkflowDraftTopology,
  DashboardWorkflowValidationResult,
  DashboardSaveWorkflowDraftRequest,
} from './dashboard-contracts';
import { DashboardIntegrationError } from './dashboard-errors';
import {
  computeInitialRunnableNodeKeys,
  isWorkflowTreeUniqueConstraintError,
  normalizeDraftTopologyKeys,
  normalizeExecutionPermissions,
  normalizeWorkflowTreeKey,
  validateDraftTopology,
} from './workflow-validation';

const MAX_DRAFT_BOOTSTRAP_ATTEMPTS = 4;

const utcNow = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

type WithDatabase = <T>(operation: (db: AlphredDatabase) => Promise<T> | T) => Promise<T>;

export type WorkflowDraftOperations = {
  createWorkflowDraft: (request: DashboardCreateWorkflowRequest) => Promise<DashboardCreateWorkflowResult>;
  getOrCreateWorkflowDraft: (treeKeyRaw: string) => Promise<DashboardWorkflowDraftTopology>;
  saveWorkflowDraft: (
    treeKeyRaw: string,
    version: number,
    request: DashboardSaveWorkflowDraftRequest,
  ) => Promise<DashboardWorkflowDraftTopology>;
  validateWorkflowDraft: (treeKeyRaw: string, version: number) => Promise<DashboardWorkflowValidationResult>;
};

function templatePrompt(template: DashboardCreateWorkflowRequest['template'], nodeKey: string): string {
  if (template !== 'design-implement-review') {
    return 'Describe what to do for this workflow phase.';
  }

  switch (nodeKey) {
    case 'design':
      return 'You are the design phase. Produce a clear design plan, constraints, and acceptance criteria.';
    case 'implement':
      return 'You are the implementation phase. Make the required code changes, run tests, and summarize the result.';
    case 'review':
      return 'You are the review phase. Audit changes for correctness, risks, and edge cases.';
    default:
      return 'Describe what to do for this workflow phase.';
  }
}

export function loadDraftTopologyByTreeId(
  db: Pick<AlphredDatabase, 'select'>,
  treeId: number,
  catalog: Pick<AgentCatalog, 'defaultModelByProvider'>,
): Pick<DashboardWorkflowDraftTopology, 'nodes' | 'edges' | 'initialRunnableNodeKeys'> {
  const nodes = db
    .select({
      nodeKey: treeNodes.nodeKey,
      displayName: treeNodes.displayName,
      nodeType: treeNodes.nodeType,
      provider: treeNodes.provider,
      model: treeNodes.model,
      executionPermissions: treeNodes.executionPermissions,
      maxRetries: treeNodes.maxRetries,
      sequenceIndex: treeNodes.sequenceIndex,
      positionX: treeNodes.positionX,
      positionY: treeNodes.positionY,
      promptContent: promptTemplates.content,
      promptContentType: promptTemplates.contentType,
    })
    .from(treeNodes)
    .leftJoin(promptTemplates, eq(treeNodes.promptTemplateId, promptTemplates.id))
    .where(eq(treeNodes.workflowTreeId, treeId))
    .orderBy(asc(treeNodes.sequenceIndex), asc(treeNodes.nodeKey), asc(treeNodes.id))
    .all()
    .map((row) => {
      const executionPermissions =
        row.nodeType === 'agent'
          ? normalizeExecutionPermissions(
              row.executionPermissions as
                | import('@alphred/shared').ProviderExecutionPermissions
                | null
                | undefined,
            )
          : null;

      return {
        nodeKey: row.nodeKey,
        displayName: row.displayName ?? row.nodeKey,
        nodeType: row.nodeType as 'agent' | 'human' | 'tool',
        provider: row.provider,
        model:
          row.nodeType === 'agent'
            ? (row.model ?? resolveDefaultModelForProvider(row.provider, catalog))
            : null,
        ...(executionPermissions === null ? {} : { executionPermissions }),
        maxRetries: row.maxRetries,
        sequenceIndex: row.sequenceIndex,
        position:
          row.positionX === null || row.positionY === null
            ? null
            : { x: row.positionX, y: row.positionY },
        promptTemplate:
          row.promptContent === null || row.promptContentType === null
            ? null
            : {
                content: row.promptContent,
                contentType: (row.promptContentType as 'text' | 'markdown') ?? 'markdown',
              },
      };
    });

  const nodeKeyById = new Map<number, string>(
    db
      .select({ id: treeNodes.id, nodeKey: treeNodes.nodeKey })
      .from(treeNodes)
      .where(eq(treeNodes.workflowTreeId, treeId))
      .all()
      .map((row) => [row.id, row.nodeKey]),
  );

  const edges = db
    .select({
      sourceNodeId: treeEdges.sourceNodeId,
      targetNodeId: treeEdges.targetNodeId,
      priority: treeEdges.priority,
      auto: treeEdges.auto,
      guardExpression: guardDefinitions.expression,
    })
    .from(treeEdges)
    .leftJoin(guardDefinitions, eq(treeEdges.guardDefinitionId, guardDefinitions.id))
    .where(eq(treeEdges.workflowTreeId, treeId))
    .orderBy(asc(treeEdges.sourceNodeId), asc(treeEdges.priority), asc(treeEdges.targetNodeId), asc(treeEdges.id))
    .all()
    .map((row) => ({
      sourceNodeKey: nodeKeyById.get(row.sourceNodeId) ?? 'unknown',
      targetNodeKey: nodeKeyById.get(row.targetNodeId) ?? 'unknown',
      priority: row.priority,
      auto: row.auto === 1,
      guardExpression: row.auto === 1 ? null : (row.guardExpression as import('@alphred/shared').GuardExpression | null),
    }));

  const initialRunnableNodeKeys = computeInitialRunnableNodeKeys(nodes, edges);
  return { nodes, edges, initialRunnableNodeKeys };
}

export function createWorkflowDraftOperations(params: {
  withDatabase: WithDatabase;
}): WorkflowDraftOperations {
  const { withDatabase } = params;

  return {
    async createWorkflowDraft(request: DashboardCreateWorkflowRequest): Promise<DashboardCreateWorkflowResult> {
      const name = request.name.trim();
      if (name.length === 0) {
        throw new DashboardIntegrationError('invalid_request', 'Workflow name cannot be empty.', { status: 400 });
      }

      const treeKey = normalizeWorkflowTreeKey(request.treeKey);
      const description = request.description?.trim() ?? null;

      return withDatabase(async db =>
        db.transaction((tx) => {
          const catalog = loadAgentCatalog(tx);
          const defaultCodexModel = resolveDefaultModelForProvider('codex', catalog) ?? 'gpt-5.3-codex';
          const existing = tx
            .select({ id: workflowTrees.id })
            .from(workflowTrees)
            .where(eq(workflowTrees.treeKey, treeKey))
            .get();
          if (existing) {
            throw new DashboardIntegrationError('conflict', `Workflow tree "${treeKey}" already exists.`, { status: 409 });
          }

          let tree: { id: number };
          try {
            tree = tx
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

          if (request.template === 'design-implement-review') {
            const nodeSpecs: {
              nodeKey: string;
              displayName: string;
              position: { x: number; y: number };
              sequenceIndex: number;
            }[] = [
              { nodeKey: 'design', displayName: 'Design', position: { x: 0, y: 0 }, sequenceIndex: 10 },
              { nodeKey: 'implement', displayName: 'Implement', position: { x: 320, y: 0 }, sequenceIndex: 20 },
              { nodeKey: 'review', displayName: 'Review', position: { x: 640, y: 0 }, sequenceIndex: 30 },
            ];

            const promptTemplateIdByNodeKey = new Map<string, number>();
            for (const spec of nodeSpecs) {
              const prompt = tx
                .insert(promptTemplates)
                .values({
                  templateKey: `${treeKey}/v1/${spec.nodeKey}/prompt`,
                  version: 1,
                  content: templatePrompt(request.template, spec.nodeKey),
                  contentType: 'markdown',
                })
                .returning({ id: promptTemplates.id })
                .get();
              promptTemplateIdByNodeKey.set(spec.nodeKey, prompt.id);
            }

            const nodeIdByKey = new Map<string, number>();
            for (const spec of nodeSpecs) {
              const node = tx
                .insert(treeNodes)
                .values({
                  workflowTreeId: tree.id,
                  nodeKey: spec.nodeKey,
                  displayName: spec.displayName,
                  nodeType: 'agent',
                  provider: 'codex',
                  model: defaultCodexModel,
                  executionPermissions: null,
                  promptTemplateId: promptTemplateIdByNodeKey.get(spec.nodeKey) ?? null,
                  maxRetries: 0,
                  sequenceIndex: spec.sequenceIndex,
                  positionX: spec.position.x,
                  positionY: spec.position.y,
                })
                .returning({ id: treeNodes.id })
                .get();
              nodeIdByKey.set(spec.nodeKey, node.id);
            }

            const designId = nodeIdByKey.get('design');
            const implementId = nodeIdByKey.get('implement');
            const reviewId = nodeIdByKey.get('review');
            if (!designId || !implementId || !reviewId) {
              throw new DashboardIntegrationError('internal_error', 'Failed to seed template node IDs.', { status: 500 });
            }

            const reviseGuard = tx
              .insert(guardDefinitions)
              .values({
                guardKey: `${treeKey}/v1/review->implement/priority-10`,
                version: 1,
                expression: { field: 'decision', operator: '==', value: 'changes_requested' },
                description: 'Loop back when changes are requested.',
              })
              .returning({ id: guardDefinitions.id })
              .get();

            tx.insert(treeEdges)
              .values({
                workflowTreeId: tree.id,
                sourceNodeId: designId,
                targetNodeId: implementId,
                priority: 100,
                auto: 1,
                guardDefinitionId: null,
              })
              .run();

            tx.insert(treeEdges)
              .values({
                workflowTreeId: tree.id,
                sourceNodeId: reviewId,
                targetNodeId: implementId,
                priority: 10,
                auto: 0,
                guardDefinitionId: reviseGuard.id,
              })
              .run();

            tx.insert(treeEdges)
              .values({
                workflowTreeId: tree.id,
                sourceNodeId: implementId,
                targetNodeId: reviewId,
                priority: 100,
                auto: 1,
                guardDefinitionId: null,
              })
              .run();
          }

          return { treeKey, draftVersion: 1 };
        }),
      );
    },

    async getOrCreateWorkflowDraft(treeKeyRaw: string): Promise<DashboardWorkflowDraftTopology> {
      const treeKey = normalizeWorkflowTreeKey(treeKeyRaw);

      return withDatabase(async db => {
        const catalog = loadAgentCatalog(db);
        const loadLatestDraft = () =>
          db
            .select({
              id: workflowTrees.id,
              version: workflowTrees.version,
              name: workflowTrees.name,
              description: workflowTrees.description,
              versionNotes: workflowTrees.versionNotes,
              draftRevision: workflowTrees.draftRevision,
            })
            .from(workflowTrees)
            .where(and(eq(workflowTrees.treeKey, treeKey), eq(workflowTrees.status, 'draft')))
            .orderBy(desc(workflowTrees.version), desc(workflowTrees.id))
            .get();

        const toDraftTopology = (
          draftRecord: {
            id: number;
            version: number;
            name: string;
            description: string | null;
            versionNotes: string | null;
            draftRevision: number;
          },
        ): DashboardWorkflowDraftTopology => {
          const topology = loadDraftTopologyByTreeId(db, draftRecord.id, catalog);
          return {
            treeKey,
            version: draftRecord.version,
            draftRevision: draftRecord.draftRevision,
            name: draftRecord.name,
            description: draftRecord.description,
            versionNotes: draftRecord.versionNotes,
            ...topology,
          };
        };

        const loadLatestPublished = () =>
          db
            .select({
              id: workflowTrees.id,
              version: workflowTrees.version,
              name: workflowTrees.name,
              description: workflowTrees.description,
            })
            .from(workflowTrees)
            .where(and(eq(workflowTrees.treeKey, treeKey), eq(workflowTrees.status, 'published')))
            .orderBy(desc(workflowTrees.version), desc(workflowTrees.id))
            .get();

        const createDraftFromPublished = (
          published: {
            id: number;
            version: number;
            name: string;
            description: string | null;
          },
          draftVersion: number,
        ) =>
          db.transaction((tx) => {
            const insertedDraft = tx
              .insert(workflowTrees)
              .values({
                treeKey,
                version: draftVersion,
                status: 'draft',
                name: published.name,
                description: published.description,
                versionNotes: null,
                draftRevision: 0,
              })
              .returning({ id: workflowTrees.id })
              .get();
            const draftTreeId = insertedDraft.id;

            const publishedNodes = tx
              .select({
                id: treeNodes.id,
                nodeKey: treeNodes.nodeKey,
                displayName: treeNodes.displayName,
                nodeType: treeNodes.nodeType,
                provider: treeNodes.provider,
                model: treeNodes.model,
                executionPermissions: treeNodes.executionPermissions,
                maxRetries: treeNodes.maxRetries,
                sequenceIndex: treeNodes.sequenceIndex,
                positionX: treeNodes.positionX,
                positionY: treeNodes.positionY,
                promptTemplateId: treeNodes.promptTemplateId,
              })
              .from(treeNodes)
              .where(eq(treeNodes.workflowTreeId, published.id))
              .orderBy(asc(treeNodes.sequenceIndex), asc(treeNodes.id))
              .all();

            const promptTemplateIds = publishedNodes
              .map(node => node.promptTemplateId)
              .filter((id): id is number => typeof id === 'number');
            const promptTemplateRows =
              promptTemplateIds.length === 0
                ? []
                : tx
                    .select({
                      id: promptTemplates.id,
                      content: promptTemplates.content,
                      contentType: promptTemplates.contentType,
                    })
                    .from(promptTemplates)
                    .where(inArray(promptTemplates.id, promptTemplateIds))
                    .all();

            const promptTemplateById = new Map(promptTemplateRows.map(row => [row.id, row]));
            const promptTemplateCloneById = new Map<number, number>();
            for (const templateId of promptTemplateIds) {
              if (promptTemplateCloneById.has(templateId)) {
                continue;
              }
              const template = promptTemplateById.get(templateId);
              if (!template) {
                continue;
              }
              const inserted = tx
                .insert(promptTemplates)
                .values({
                  templateKey: `${treeKey}/v${draftVersion}/prompt-template/${templateId}`,
                  version: 1,
                  content: template.content,
                  contentType: template.contentType,
                })
                .returning({ id: promptTemplates.id })
                .get();
              promptTemplateCloneById.set(templateId, inserted.id);
            }

            const nodeIdCloneById = new Map<number, number>();
            for (const node of publishedNodes) {
              const inserted = tx
                .insert(treeNodes)
                .values({
                  workflowTreeId: draftTreeId,
                  nodeKey: node.nodeKey,
                  displayName: node.displayName,
                  nodeType: node.nodeType,
                  provider: node.provider,
                  model:
                    node.nodeType === 'agent'
                      ? (node.model ?? resolveDefaultModelForProvider(node.provider, catalog))
                      : null,
                  executionPermissions: normalizeExecutionPermissions(
                    node.executionPermissions as
                      | import('@alphred/shared').ProviderExecutionPermissions
                      | null
                      | undefined,
                  ),
                  promptTemplateId:
                    node.promptTemplateId === null ? null : (promptTemplateCloneById.get(node.promptTemplateId) ?? null),
                  maxRetries: node.maxRetries,
                  sequenceIndex: node.sequenceIndex,
                  positionX: node.positionX,
                  positionY: node.positionY,
                })
                .returning({ id: treeNodes.id })
                .get();
              nodeIdCloneById.set(node.id, inserted.id);
            }

            const publishedEdges = tx
              .select({
                sourceNodeId: treeEdges.sourceNodeId,
                targetNodeId: treeEdges.targetNodeId,
                priority: treeEdges.priority,
                auto: treeEdges.auto,
                guardDefinitionId: treeEdges.guardDefinitionId,
              })
              .from(treeEdges)
              .where(eq(treeEdges.workflowTreeId, published.id))
              .orderBy(asc(treeEdges.sourceNodeId), asc(treeEdges.priority), asc(treeEdges.id))
              .all();

            const guardDefinitionIds = publishedEdges
              .map(edge => edge.guardDefinitionId)
              .filter((id): id is number => typeof id === 'number');
            const guardRows =
              guardDefinitionIds.length === 0
                ? []
                : tx
                    .select({
                      id: guardDefinitions.id,
                      expression: guardDefinitions.expression,
                      description: guardDefinitions.description,
                    })
                    .from(guardDefinitions)
                    .where(inArray(guardDefinitions.id, guardDefinitionIds))
                    .all();
            const guardById = new Map(guardRows.map(row => [row.id, row]));
            const guardCloneById = new Map<number, number>();
            for (const guardId of guardDefinitionIds) {
              if (guardCloneById.has(guardId)) {
                continue;
              }
              const guard = guardById.get(guardId);
              if (!guard) {
                continue;
              }
              const inserted = tx
                .insert(guardDefinitions)
                .values({
                  guardKey: `${treeKey}/v${draftVersion}/guard/${guardId}`,
                  version: 1,
                  expression: guard.expression,
                  description: guard.description,
                })
                .returning({ id: guardDefinitions.id })
                .get();
              guardCloneById.set(guardId, inserted.id);
            }

            for (const edge of publishedEdges) {
              const sourceNodeId = nodeIdCloneById.get(edge.sourceNodeId);
              const targetNodeId = nodeIdCloneById.get(edge.targetNodeId);
              if (!sourceNodeId || !targetNodeId) {
                continue;
              }
              tx.insert(treeEdges)
                .values({
                  workflowTreeId: draftTreeId,
                  sourceNodeId,
                  targetNodeId,
                  priority: edge.priority,
                  auto: edge.auto,
                  guardDefinitionId:
                    edge.guardDefinitionId === null ? null : (guardCloneById.get(edge.guardDefinitionId) ?? null),
                })
                .run();
            }

            const nextCatalog = loadAgentCatalog(tx);
            const topology = loadDraftTopologyByTreeId(tx, draftTreeId, nextCatalog);
            return {
              treeKey,
              version: draftVersion,
              draftRevision: 0,
              name: published.name,
              description: published.description,
              versionNotes: null,
              ...topology,
            };
          });

        let lastVersionConflictError: unknown = null;
        for (let attempt = 1; attempt <= MAX_DRAFT_BOOTSTRAP_ATTEMPTS; attempt += 1) {
          const existingDraft = loadLatestDraft();
          if (existingDraft) {
            return toDraftTopology(existingDraft);
          }

          const published = loadLatestPublished();
          if (!published) {
            throw new DashboardIntegrationError('not_found', `Workflow tree "${treeKey}" was not found.`, {
              status: 404,
            });
          }

          try {
            return createDraftFromPublished(published, published.version + 1);
          } catch (error) {
            if (!isWorkflowTreeUniqueConstraintError(error)) {
              throw error;
            }

            const concurrentDraft = loadLatestDraft();
            if (concurrentDraft) {
              return toDraftTopology(concurrentDraft);
            }

            lastVersionConflictError = error;
          }
        }

        throw new DashboardIntegrationError(
          'conflict',
          'Workflow draft changed concurrently. Refresh the editor and try again.',
          {
            status: 409,
            details: {
              treeKey,
              attempts: MAX_DRAFT_BOOTSTRAP_ATTEMPTS,
            },
            cause: lastVersionConflictError,
          },
        );
      });
    },

    async saveWorkflowDraft(
      treeKeyRaw: string,
      version: number,
      request: DashboardSaveWorkflowDraftRequest,
    ): Promise<DashboardWorkflowDraftTopology> {
      const treeKey = normalizeWorkflowTreeKey(treeKeyRaw);
      if (!Number.isInteger(version) || version < 1) {
        throw new DashboardIntegrationError('invalid_request', 'Workflow version must be a positive integer.', {
          status: 400,
        });
      }

      const name = request.name.trim();
      if (name.length === 0) {
        throw new DashboardIntegrationError('invalid_request', 'Workflow name cannot be empty.', { status: 400 });
      }

      if (!Number.isInteger(request.draftRevision) || request.draftRevision < 1) {
        throw new DashboardIntegrationError('invalid_request', 'Draft revision must be a positive integer.', {
          status: 400,
        });
      }

      const normalizedTopology = normalizeDraftTopologyKeys({ nodes: request.nodes, edges: request.edges });
      const description = request.description?.trim() ?? null;
      const versionNotes = request.versionNotes?.trim() ?? null;

      return withDatabase(async db => {
        const catalog = loadAgentCatalog(db);
        const draftValidation = validateDraftTopology(normalizedTopology, 'save', catalog);
        if (draftValidation.errors.length > 0) {
          throw new DashboardIntegrationError('invalid_request', 'Draft workflow failed validation and cannot be saved.', {
            status: 400,
            details: draftValidation as unknown as Record<string, unknown>,
          });
        }

        return db.transaction((tx) => {
          const tree = tx
            .select({
              id: workflowTrees.id,
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

          const expectedDraftRevision = tree.draftRevision + 1;
          if (request.draftRevision !== expectedDraftRevision) {
            throw new DashboardIntegrationError(
              'conflict',
              'Draft workflow is out of date. Refresh the editor before saving again.',
              {
                status: 409,
                details: {
                  currentDraftRevision: tree.draftRevision,
                  receivedDraftRevision: request.draftRevision,
                  expectedDraftRevision,
                  expectedMinDraftRevision: expectedDraftRevision,
                },
              },
            );
          }

          const saveUpdate = tx.update(workflowTrees)
            .set({ name, description, versionNotes, draftRevision: request.draftRevision, updatedAt: utcNow })
            .where(
              and(
                eq(workflowTrees.id, tree.id),
                eq(workflowTrees.status, 'draft'),
                eq(workflowTrees.draftRevision, tree.draftRevision),
              ),
            )
            .run();
          if (saveUpdate.changes !== 1) {
            throw new DashboardIntegrationError(
              'conflict',
              'Draft workflow changed while saving. Refresh the editor before saving again.',
              {
                status: 409,
                details: {
                  expectedPreviousDraftRevision: tree.draftRevision,
                  receivedDraftRevision: request.draftRevision,
                  expectedDraftRevision,
                },
              },
            );
          }

          const existingPromptTemplateIds = tx
            .select({ id: treeNodes.promptTemplateId })
            .from(treeNodes)
            .where(eq(treeNodes.workflowTreeId, tree.id))
            .all()
            .map(row => row.id)
            .filter((id): id is number => typeof id === 'number');

          const existingGuardDefinitionIds = tx
            .select({ id: treeEdges.guardDefinitionId })
            .from(treeEdges)
            .where(eq(treeEdges.workflowTreeId, tree.id))
            .all()
            .map(row => row.id)
            .filter((id): id is number => typeof id === 'number');

          tx.delete(treeEdges).where(eq(treeEdges.workflowTreeId, tree.id)).run();
          tx.delete(treeNodes).where(eq(treeNodes.workflowTreeId, tree.id)).run();

          if (existingPromptTemplateIds.length > 0) {
            tx.delete(promptTemplates).where(inArray(promptTemplates.id, existingPromptTemplateIds)).run();
          }
          if (existingGuardDefinitionIds.length > 0) {
            tx.delete(guardDefinitions).where(inArray(guardDefinitions.id, existingGuardDefinitionIds)).run();
          }

          const promptTemplateIdByNodeKey = new Map<string, number>();
          for (const node of normalizedTopology.nodes) {
            if (!node.promptTemplate) {
              continue;
            }
            const inserted = tx
              .insert(promptTemplates)
              .values({
                templateKey: `${treeKey}/v${version}/${node.nodeKey}/prompt`,
                version: 1,
                content: node.promptTemplate.content,
                contentType: node.promptTemplate.contentType,
              })
              .returning({ id: promptTemplates.id })
              .get();
            promptTemplateIdByNodeKey.set(node.nodeKey, inserted.id);
          }

          const nodeIdByKey = new Map<string, number>();
          for (const node of normalizedTopology.nodes) {
            const nodeModel =
              node.nodeType === 'agent'
                ? (node.model ?? resolveDefaultModelForProvider(node.provider, catalog))
                : null;
            const inserted = tx
              .insert(treeNodes)
              .values({
                workflowTreeId: tree.id,
                nodeKey: node.nodeKey,
                displayName: node.displayName,
                nodeType: node.nodeType,
                provider: node.provider,
                model: nodeModel,
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
          for (const edge of normalizedTopology.edges) {
            if (edge.auto || edge.guardExpression === null) {
              continue;
            }
            const key = `${edge.sourceNodeKey}->${edge.targetNodeKey}/priority-${edge.priority}`;
            const inserted = tx
              .insert(guardDefinitions)
              .values({
                guardKey: `${treeKey}/v${version}/${key}`,
                version: 1,
                expression: edge.guardExpression,
                description: null,
              })
              .returning({ id: guardDefinitions.id })
              .get();
            guardDefinitionIdByKey.set(key, inserted.id);
          }

          for (const edge of normalizedTopology.edges) {
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

            const key = `${edge.sourceNodeKey}->${edge.targetNodeKey}/priority-${edge.priority}`;
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
                workflowTreeId: tree.id,
                sourceNodeId,
                targetNodeId,
                priority: edge.priority,
                auto: edge.auto ? 1 : 0,
                guardDefinitionId: edge.auto ? null : (guardDefinitionIdByKey.get(key) ?? null),
              })
              .run();
          }

          const nextCatalog = loadAgentCatalog(tx);
          const topology = loadDraftTopologyByTreeId(tx, tree.id, nextCatalog);
          return {
            treeKey,
            version,
            draftRevision: request.draftRevision,
            name,
            description,
            versionNotes,
            ...topology,
          };
        });
      });
    },

    async validateWorkflowDraft(treeKeyRaw: string, version: number): Promise<DashboardWorkflowValidationResult> {
      const treeKey = normalizeWorkflowTreeKey(treeKeyRaw);
      if (!Number.isInteger(version) || version < 1) {
        throw new DashboardIntegrationError('invalid_request', 'Workflow version must be a positive integer.', {
          status: 400,
        });
      }

      return withDatabase(async db => {
        const catalog = loadAgentCatalog(db);
        const tree = db
          .select({ id: workflowTrees.id })
          .from(workflowTrees)
          .where(and(eq(workflowTrees.treeKey, treeKey), eq(workflowTrees.version, version), eq(workflowTrees.status, 'draft')))
          .get();
        if (!tree) {
          throw new DashboardIntegrationError('not_found', `Draft workflow tree "${treeKey}" v${version} was not found.`, {
            status: 404,
          });
        }

        const topology = loadDraftTopologyByTreeId(db, tree.id, catalog);
        return validateDraftTopology({ nodes: topology.nodes, edges: topology.edges }, 'publish', catalog);
      });
    },
  };
}
