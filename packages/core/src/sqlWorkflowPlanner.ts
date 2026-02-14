import {
  loadWorkflowTreeTopology,
  materializeWorkflowRunFromTree,
  type AlphredDatabase,
  type LoadWorkflowTreeTopologyParams,
  type MaterializeWorkflowRunParams,
  type MaterializedWorkflowRun,
  type WorkflowTreeTopology,
} from '@alphred/db';

export type SqlWorkflowPlanner = {
  loadTopology(params: LoadWorkflowTreeTopologyParams): WorkflowTreeTopology;
  materializeRun(params: MaterializeWorkflowRunParams): MaterializedWorkflowRun;
};

export function createSqlWorkflowPlanner(db: AlphredDatabase): SqlWorkflowPlanner {
  return {
    loadTopology: params => loadWorkflowTreeTopology(db, params),
    materializeRun: params => materializeWorkflowRunFromTree(db, params),
  };
}
