import {
  and,
  desc,
  eq,
  promptTemplates,
  treeNodes,
  workflowTrees,
  type AlphredDatabase,
} from '@alphred/db';
import { loadAgentCatalog, resolveDefaultModelForProvider } from './agent-catalog';
import { isWorkflowTreeUniqueConstraintError } from './workflow-validation';

export const DEFAULT_STORY_BREAKDOWN_TREE_KEY = 'story-breakdown-planner';
export const DEFAULT_STORY_BREAKDOWN_NODE_KEY = 'breakdown';

const DEFAULT_STORY_BREAKDOWN_WORKFLOW_NAME = 'Story Breakdown Planner';
const DEFAULT_STORY_BREAKDOWN_WORKFLOW_DESCRIPTION =
  'Single-node planner that returns story_breakdown_result JSON for a story.';
const DEFAULT_STORY_BREAKDOWN_VERSION_NOTES = 'Seeded default story breakdown planner.';
type WorkflowSeedExecutor = Pick<AlphredDatabase, 'select' | 'insert'>;

const DEFAULT_STORY_BREAKDOWN_PROMPT = [
  'You are the story breakdown planner for a single story.',
  'Return exactly one JSON object and no markdown fences or extra prose.',
  'The JSON must match this contract exactly:',
  '{',
  '  "schemaVersion": 1,',
  '  "resultType": "story_breakdown_result",',
  '  "proposed": {',
  '    "tags": string[] | null,',
  '    "plannedFiles": string[] | null,',
  '    "links": string[] | null,',
  '    "tasks": [',
  '      {',
  '        "title": string,',
  '        "description": string | null,',
  '        "tags": string[] | null,',
  '        "plannedFiles": string[] | null,',
  '        "assignees": string[] | null,',
  '        "priority": number | null,',
  '        "estimate": number | null,',
  '        "links": string[] | null',
  '      }',
  '    ]',
  '  }',
  '}',
  'Rules:',
  '- Break the story into concrete child tasks that can be executed independently.',
  '- Keep task titles short and imperative.',
  '- Use null for unknown optional fields instead of omitting them.',
  '- Put story-wide tags, plannedFiles, and links under proposed; put task-specific details on each task.',
  '- Return valid JSON only.',
].join('\n');

function nextWorkflowVersion(db: Pick<AlphredDatabase, 'select'>, treeKey: string): number {
  const versions = db
    .select({ version: workflowTrees.version })
    .from(workflowTrees)
    .where(eq(workflowTrees.treeKey, treeKey))
    .all()
    .map(row => row.version);

  return (versions.length === 0 ? 0 : Math.max(...versions)) + 1;
}

function ensurePublishedStoryBreakdownWorkflow(db: WorkflowSeedExecutor): void {
  const published = db
    .select({ id: workflowTrees.id })
    .from(workflowTrees)
    .where(and(eq(workflowTrees.treeKey, DEFAULT_STORY_BREAKDOWN_TREE_KEY), eq(workflowTrees.status, 'published')))
    .orderBy(desc(workflowTrees.version), desc(workflowTrees.id))
    .get();
  if (published) {
    return;
  }

  const catalog = loadAgentCatalog(db);
  const defaultCodexModel = resolveDefaultModelForProvider('codex', catalog) ?? 'gpt-5.3-codex';
  const version = nextWorkflowVersion(db, DEFAULT_STORY_BREAKDOWN_TREE_KEY);

  const tree = db
    .insert(workflowTrees)
    .values({
      treeKey: DEFAULT_STORY_BREAKDOWN_TREE_KEY,
      version,
      status: 'published',
      name: DEFAULT_STORY_BREAKDOWN_WORKFLOW_NAME,
      description: DEFAULT_STORY_BREAKDOWN_WORKFLOW_DESCRIPTION,
      versionNotes: DEFAULT_STORY_BREAKDOWN_VERSION_NOTES,
      draftRevision: 0,
    })
    .returning({ id: workflowTrees.id })
    .get();

  const prompt = db
    .insert(promptTemplates)
    .values({
      templateKey: `${DEFAULT_STORY_BREAKDOWN_TREE_KEY}/v${String(version)}/${DEFAULT_STORY_BREAKDOWN_NODE_KEY}/prompt`,
      version: 1,
      content: DEFAULT_STORY_BREAKDOWN_PROMPT,
      contentType: 'markdown',
    })
    .returning({ id: promptTemplates.id })
    .get();

  db.insert(treeNodes)
    .values({
      workflowTreeId: tree.id,
      nodeKey: DEFAULT_STORY_BREAKDOWN_NODE_KEY,
      displayName: 'Breakdown',
      nodeType: 'agent',
      nodeRole: 'standard',
      provider: 'codex',
      model: defaultCodexModel,
      executionPermissions: null,
      promptTemplateId: prompt.id,
      maxChildren: 12,
      maxRetries: 0,
      sequenceIndex: 10,
      positionX: 0,
      positionY: 0,
    })
    .run();
}

export function ensureDashboardDefaultWorkflows(db: AlphredDatabase): void {
  try {
    db.transaction(tx => {
      ensurePublishedStoryBreakdownWorkflow(tx);
    });
  } catch (error) {
    if (isWorkflowTreeUniqueConstraintError(error)) {
      return;
    }
    throw error;
  }
}
