'use client';

import type { DragEvent } from 'react';
import type { DashboardWorkflowDraftNode } from '../../../../src/server/dashboard-contracts';
import { ActionButton, Card } from '../../../ui/primitives';

function setDragPayload(event: DragEvent<HTMLButtonElement>, nodeType: DashboardWorkflowDraftNode['nodeType']) {
  event.dataTransfer.setData('application/alphred-workflow-node', nodeType);
  event.dataTransfer.effectAllowed = 'move';
}

export function WorkflowEditorNodePalette(args: Readonly<{
  onAdd: (nodeType: DashboardWorkflowDraftNode['nodeType']) => void;
}>) {
  return (
    <Card title="Node palette" description="Drag onto canvas or click to add.">
      <ul className="workflow-palette-draggable-list">
        <li>
          <button
            type="button"
            className="workflow-palette-draggable"
            draggable
            onDragStart={(event) => setDragPayload(event, 'agent')}
          >
            Agent node
          </button>
        </li>
        <li>
          <button
            type="button"
            className="workflow-palette-draggable"
            draggable
            onDragStart={(event) => setDragPayload(event, 'human')}
          >
            Human node
          </button>
        </li>
        <li>
          <button
            type="button"
            className="workflow-palette-draggable"
            draggable
            onDragStart={(event) => setDragPayload(event, 'tool')}
          >
            Tool node
          </button>
        </li>
      </ul>

      <div className="workflow-palette-actions">
        <ActionButton onClick={() => args.onAdd('agent')}>Add agent</ActionButton>
        <ActionButton onClick={() => args.onAdd('human')}>Add human</ActionButton>
        <ActionButton onClick={() => args.onAdd('tool')}>Add tool</ActionButton>
      </div>
    </Card>
  );
}

