import { describe, expect, it } from 'vitest';
import {
  createDatabase,
  eq,
  migrateDatabase,
  promptTemplates,
  treeNodes,
} from '@alphred/db';
import {
  DEFAULT_STORY_BREAKDOWN_NODE_KEY,
  DEFAULT_STORY_BREAKDOWN_TREE_KEY,
  ensureDashboardDefaultWorkflows,
} from './dashboard-default-workflows';

describe('dashboard-default-workflows', () => {
  it('seeds a valid JSON example for the story breakdown prompt', () => {
    const db = createDatabase(':memory:');
    migrateDatabase(db);

    ensureDashboardDefaultWorkflows(db);

    const prompt = db
      .select({
        content: promptTemplates.content,
      })
      .from(promptTemplates)
      .where(
        eq(
          promptTemplates.templateKey,
          `${DEFAULT_STORY_BREAKDOWN_TREE_KEY}/v1/${DEFAULT_STORY_BREAKDOWN_NODE_KEY}/prompt`,
        ),
      )
      .get();
    const plannerNode = db
      .select({
        reportArtifactContentType: treeNodes.reportArtifactContentType,
      })
      .from(treeNodes)
      .where(eq(treeNodes.nodeKey, DEFAULT_STORY_BREAKDOWN_NODE_KEY))
      .get();

    expect(prompt).not.toBeUndefined();
    expect(prompt?.content).not.toContain('string[] | null');
    expect(plannerNode?.reportArtifactContentType).toBe('json');

    const exampleStart = prompt?.content.indexOf('{\n') ?? -1;
    const rulesStart = prompt?.content.indexOf('\nRules:') ?? -1;

    expect(exampleStart).toBeGreaterThanOrEqual(0);
    expect(rulesStart).toBeGreaterThan(exampleStart);

    const jsonExample = prompt?.content.slice(exampleStart, rulesStart);
    expect(() => JSON.parse(jsonExample ?? '')).not.toThrow();
  });
});
