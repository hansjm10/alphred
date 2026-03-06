import {
  and,
  desc,
  eq,
  phaseArtifacts,
  sql,
  workflowRunAssociations,
  workflowRuns,
  workflowTrees,
  type AlphredDatabase,
} from '@alphred/db';

export const STORY_BREAKDOWN_LAUNCH_CONTEXT_ARTIFACT_KIND = 'story_breakdown_launch_context_v1';

export type StoryBreakdownRunIdentity = {
  workflowRunId: number;
  repositoryId: number;
  storyId: number;
  runStatus: 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
  treeKey: string;
};

export function loadStoryBreakdownRunIdentity(
  db: AlphredDatabase,
  workflowRunId: number,
): StoryBreakdownRunIdentity | null {
  const row = db
    .select({
      workflowRunId: workflowRuns.id,
      repositoryId: workflowRunAssociations.repositoryId,
      storyId: workflowRunAssociations.workItemId,
      runStatus: workflowRuns.status,
      treeKey: workflowTrees.treeKey,
    })
    .from(workflowRuns)
    .innerJoin(workflowTrees, eq(workflowRuns.workflowTreeId, workflowTrees.id))
    .innerJoin(workflowRunAssociations, eq(workflowRunAssociations.workflowRunId, workflowRuns.id))
    .innerJoin(
      phaseArtifacts,
      and(
        eq(phaseArtifacts.workflowRunId, workflowRuns.id),
        eq(phaseArtifacts.artifactType, 'note'),
        sql`coalesce(json_extract(${phaseArtifacts.metadata}, '$.kind'), '') = ${STORY_BREAKDOWN_LAUNCH_CONTEXT_ARTIFACT_KIND}`,
      ),
    )
    .where(eq(workflowRuns.id, workflowRunId))
    .orderBy(desc(phaseArtifacts.createdAt), desc(phaseArtifacts.id))
    .get();

  if (!row || row.repositoryId === null || row.storyId === null) {
    return null;
  }

  return {
    workflowRunId: row.workflowRunId,
    repositoryId: row.repositoryId,
    storyId: row.storyId,
    runStatus: row.runStatus as StoryBreakdownRunIdentity['runStatus'],
    treeKey: row.treeKey,
  };
}

export function findActiveStoryBreakdownRunForStory(
  db: AlphredDatabase,
  params: {
    repositoryId: number;
    storyId: number;
    excludeWorkflowRunId?: number;
  },
): Pick<StoryBreakdownRunIdentity, 'workflowRunId' | 'runStatus' | 'treeKey'> | null {
  const row = db
    .select({
      workflowRunId: workflowRuns.id,
      runStatus: workflowRuns.status,
      treeKey: workflowTrees.treeKey,
    })
    .from(workflowRunAssociations)
    .innerJoin(workflowRuns, eq(workflowRunAssociations.workflowRunId, workflowRuns.id))
    .innerJoin(workflowTrees, eq(workflowRuns.workflowTreeId, workflowTrees.id))
    .innerJoin(
      phaseArtifacts,
      and(
        eq(phaseArtifacts.workflowRunId, workflowRuns.id),
        eq(phaseArtifacts.artifactType, 'note'),
        sql`coalesce(json_extract(${phaseArtifacts.metadata}, '$.kind'), '') = ${STORY_BREAKDOWN_LAUNCH_CONTEXT_ARTIFACT_KIND}`,
      ),
    )
    .where(
      and(
        eq(workflowRunAssociations.repositoryId, params.repositoryId),
        eq(workflowRunAssociations.workItemId, params.storyId),
        sql`${workflowRuns.status} in ('pending', 'running', 'paused')`,
        params.excludeWorkflowRunId === undefined ? undefined : sql`${workflowRuns.id} <> ${params.excludeWorkflowRunId}`,
      ),
    )
    .orderBy(desc(workflowRuns.id), desc(phaseArtifacts.createdAt), desc(phaseArtifacts.id))
    .get();

  if (!row) {
    return null;
  }

  return {
    workflowRunId: row.workflowRunId,
    runStatus: row.runStatus as StoryBreakdownRunIdentity['runStatus'],
    treeKey: row.treeKey,
  };
}
