import { Panel } from '../ui/primitives';
import { WorkflowJsonCopyActions } from './workflow-json-copy-client';

type FanoutNode = Readonly<{
  nodeKey: string;
  nodeRole?: 'standard' | 'spawner' | 'join' | null;
  maxChildren?: number | null;
}>;

type FanoutEdge = Readonly<{
  sourceNodeKey: string;
  targetNodeKey: string;
  routeOn?: 'success' | 'failure' | null;
  priority: number;
}>;

type WorkflowFanoutSettingsPanelProps = Readonly<{
  nodes?: readonly FanoutNode[] | null;
  edges?: readonly FanoutEdge[] | null;
}>;

type WorkflowJsonPanelProps = Readonly<{
  json: string;
}>;

const DEFAULT_NODE_ROLE: NonNullable<FanoutNode['nodeRole']> = 'standard';
const DEFAULT_MAX_CHILDREN = 12;

export function WorkflowFanoutSettingsPanel({ nodes, edges }: WorkflowFanoutSettingsPanelProps) {
  const safeNodes = nodes ?? [];
  const safeEdges = edges ?? [];

  const nonDefaultRoleNodes = safeNodes.filter((node) => {
    const nodeRole = node.nodeRole ?? DEFAULT_NODE_ROLE;
    const maxChildren = node.maxChildren ?? DEFAULT_MAX_CHILDREN;
    return nodeRole !== DEFAULT_NODE_ROLE || maxChildren !== DEFAULT_MAX_CHILDREN;
  });

  const failureRouteEdges = safeEdges.filter((edge) => (edge.routeOn ?? 'success') === 'failure');
  const hasFanoutConfiguration = nonDefaultRoleNodes.length > 0 || failureRouteEdges.length > 0;

  return (
    <Panel title="Fan-out settings">
      {hasFanoutConfiguration ? (
        <ul className="entity-list">
          {nonDefaultRoleNodes.map((node) => (
            <li key={`node-${node.nodeKey}`}>
              <span>{node.nodeKey}</span>
              <span>
                role {(node.nodeRole ?? DEFAULT_NODE_ROLE)} · maxChildren {node.maxChildren ?? DEFAULT_MAX_CHILDREN}
              </span>
            </li>
          ))}
          {failureRouteEdges.map((edge) => (
            <li key={`edge-${edge.sourceNodeKey}-${edge.targetNodeKey}-${edge.priority}`}>
              <span>{edge.sourceNodeKey} → {edge.targetNodeKey}</span>
              <span>failure route · priority {edge.priority}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="meta-text">No fan-out specific settings configured.</p>
      )}
    </Panel>
  );
}

export function WorkflowJsonPanel({ json }: WorkflowJsonPanelProps) {
  return (
    <Panel title="View JSON">
      <div className="workflows-toolbar">
        <WorkflowJsonCopyActions json={json} />
      </div>
      <pre className="workflow-json" aria-label="Workflow JSON">{json}</pre>
    </Panel>
  );
}
