'use client';

import { useMemo, useState, type DragEvent } from 'react';
import type { DashboardWorkflowDraftNode } from '../../../../src/server/dashboard-contracts';
import { ActionButton, Card } from '../../../ui/primitives';

function setDragPayload(event: DragEvent<HTMLButtonElement>, nodeType: DashboardWorkflowDraftNode['nodeType']) {
  event.dataTransfer.setData('application/alphred-workflow-node', nodeType);
  event.dataTransfer.effectAllowed = 'move';
}

const nodeTemplates: readonly {
  nodeType: DashboardWorkflowDraftNode['nodeType'];
  label: string;
  description: string;
}[] = [
  {
    nodeType: 'agent',
    label: 'Agent node',
    description: 'Provider-backed phase with prompt template support.',
  },
  {
    nodeType: 'human',
    label: 'Human node',
    description: 'Draft placeholder for operator checkpoints.',
  },
  {
    nodeType: 'tool',
    label: 'Tool node',
    description: 'Draft placeholder for future tool execution.',
  },
];

export function WorkflowEditorNodePalette(args: Readonly<{
  onAdd: (nodeType: DashboardWorkflowDraftNode['nodeType']) => void;
}>) {
  const [search, setSearch] = useState('');
  const filteredTemplates = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (query.length === 0) {
      return nodeTemplates;
    }

    return nodeTemplates.filter(template => {
      return (
        template.nodeType.includes(query) ||
        template.label.toLowerCase().includes(query) ||
        template.description.toLowerCase().includes(query)
      );
    });
  }, [search]);

  return (
    <Card title="Node palette" description="Drag onto canvas or click to add.">
      <label className="workflow-palette-search">
        <span>Search templates</span>
        <input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search by node type"
          aria-label="Search node templates"
        />
      </label>

      <ul className="workflow-palette-draggable-list">
        {filteredTemplates.map((template) => (
          <li key={template.nodeType}>
            <button
              type="button"
              className="workflow-palette-draggable"
              draggable
              onDragStart={(event) => setDragPayload(event, template.nodeType)}
              onClick={() => args.onAdd(template.nodeType)}
            >
              <strong>{template.label}</strong>
              <span>{template.description}</span>
            </button>
          </li>
        ))}
      </ul>

      <div className="workflow-palette-actions">
        <ActionButton onClick={() => args.onAdd('agent')}>Add agent</ActionButton>
        <ActionButton onClick={() => args.onAdd('human')}>Add human</ActionButton>
        <ActionButton onClick={() => args.onAdd('tool')}>Add tool</ActionButton>
      </div>
    </Card>
  );
}
