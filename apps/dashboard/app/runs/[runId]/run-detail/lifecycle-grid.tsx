import { ActionButton, Card, Panel, StatusBadge } from '../../../ui/primitives';
import { formatTimelineTime } from './formatting';
import { TIMELINE_CATEGORY_LABELS } from './timeline';
import { TimelineCategoryIcon } from './timeline-icon';
import type { RunDetailLifecycleGridProps, TimelineItem } from './types';

export function resolveEmptyTimelineLabel(filteredNodeId: number | null): string {
  return filteredNodeId === null ? 'No lifecycle events captured yet.' : 'No events match the selected node.';
}

export function RunDetailLifecycleGrid({
  detail,
  selectedNode,
  filteredNodeId,
  highlightedNodeId,
  hasHydrated,
  visibleTimeline,
  visibleTimelinePartition,
  onSelectTimelineNode,
  onClearNodeFilter,
  onToggleNodeFilter,
}: RunDetailLifecycleGridProps) {
  const nodeById = new Map(detail.nodes.map(node => [node.id, node]));
  const fanOutGroups = detail.fanOutGroups ?? [];
  const groupedChildNodeIds = new Set(fanOutGroups.flatMap(group => group.childNodeIds));
  const ungroupedNodes = detail.nodes.filter(node => !groupedChildNodeIds.has(node.id));

  const renderTimelineEvent = (event: TimelineItem) => {
    const highlighted = highlightedNodeId !== null && event.relatedNodeId === highlightedNodeId;

    return (
      <li key={event.key}>
        <button
          type="button"
          className={`run-timeline-event run-timeline-event--${event.category}${highlighted ? ' run-timeline-event--selected' : ''}`}
          aria-pressed={highlighted}
          onClick={() => {
            onSelectTimelineNode(event.relatedNodeId);
          }}
        >
          <span className="run-timeline-event__header">
            <span className={`timeline-category-indicator timeline-category-indicator--${event.category}`}>
              <TimelineCategoryIcon category={event.category} />
              <span>{TIMELINE_CATEGORY_LABELS[event.category]}</span>
            </span>
            <span className="meta-text">{formatTimelineTime(event.timestamp, hasHydrated)}</span>
          </span>
          <p>{event.summary}</p>
        </button>
      </li>
    );
  };

  return (
    <div className="page-grid run-detail-lifecycle-grid">
      <Card title="Timeline" description="Latest run events">
        {selectedNode ? (
          <div className="run-timeline-filter">
            <p className="meta-text">{`Filtered to ${selectedNode.nodeKey} (attempt ${selectedNode.attempt}).`}</p>
            <ActionButton className="run-timeline-clear" onClick={onClearNodeFilter}>
              Show all events
            </ActionButton>
          </div>
        ) : null}

        <ol className="page-stack run-timeline-list" aria-label="Run timeline">
          {visibleTimeline.length > 0 ? (
            <>
              {visibleTimelinePartition.earlier.length > 0 ? (
                <li>
                  <details className="run-collapsible-history">
                    <summary className="run-collapsible-history__summary">
                      {`Show ${visibleTimelinePartition.earlier.length} earlier events`}
                    </summary>
                    <ol className="page-stack run-collapsible-history__list" aria-label="Earlier run timeline events">
                      {visibleTimelinePartition.earlier.map((event) => renderTimelineEvent(event))}
                    </ol>
                  </details>
                </li>
              ) : null}
              {visibleTimelinePartition.recent.map((event) => renderTimelineEvent(event))}
            </>
          ) : (
            <li>
              <p>{resolveEmptyTimelineLabel(filteredNodeId)}</p>
            </li>
          )}
        </ol>
      </Card>

      <Panel title="Node status" description="Node lifecycle snapshot">
        <ul className="entity-list run-node-status-list">
          {detail.nodes.length > 0 ? (
            <>
              {fanOutGroups.map((group) => {
                const spawnerNode = nodeById.get(group.spawnerNodeId);
                const joinNode = nodeById.get(group.joinNodeId);

                return (
                  <li key={`${group.spawnerNodeId}:${group.joinNodeId}:${group.spawnSourceArtifactId}`}>
                    <details>
                      <summary>
                        {`${spawnerNode?.nodeKey ?? 'spawner'} -> ${group.terminalChildren}/${group.expectedChildren} terminal (${group.completedChildren} completed, ${group.failedChildren} failed) -> ${joinNode?.nodeKey ?? 'join'} [${group.status}]`}
                      </summary>
                      <ul className="entity-list run-node-status-list">
                        {group.childNodeIds.map((childNodeId) => {
                          const node = nodeById.get(childNodeId);
                          if (!node) {
                            return null;
                          }
                          const selected = filteredNodeId === node.id;

                          return (
                            <li key={node.id}>
                              <ActionButton
                                className={`run-node-filter${selected ? ' run-node-filter--selected' : ''}`}
                                aria-pressed={selected}
                                onClick={() => {
                                  onToggleNodeFilter(node.id);
                                }}
                              >
                                {`${node.nodeKey} (attempt ${node.attempt})`}
                              </ActionButton>
                              <StatusBadge status={node.status} />
                            </li>
                          );
                        })}
                      </ul>
                    </details>
                  </li>
                );
              })}
              {ungroupedNodes.map((node) => {
                const selected = filteredNodeId === node.id;

                return (
                  <li key={node.id}>
                    <ActionButton
                      className={`run-node-filter${selected ? ' run-node-filter--selected' : ''}`}
                      aria-pressed={selected}
                      onClick={() => {
                        onToggleNodeFilter(node.id);
                      }}
                    >
                      {`${node.nodeKey} (attempt ${node.attempt})`}
                    </ActionButton>
                    <StatusBadge status={node.status} />
                  </li>
                );
              })}
            </>
          ) : (
            <li>
              <span>No run nodes have been materialized yet.</span>
            </li>
          )}
        </ul>
      </Panel>
    </div>
  );
}
