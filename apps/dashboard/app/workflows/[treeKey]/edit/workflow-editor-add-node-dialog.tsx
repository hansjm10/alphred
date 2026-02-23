'use client';

import { useEffect, useRef } from 'react';
import type { DashboardWorkflowDraftNode } from '../../../../src/server/dashboard-contracts';
import { ActionButton } from '../../../ui/primitives';

export function WorkflowEditorAddNodeDialog(args: Readonly<{
  open: boolean;
  onClose: () => void;
  onSelect: (nodeType: DashboardWorkflowDraftNode['nodeType']) => void;
}>) {
  const firstOptionRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!args.open) {
      return;
    }

    const timeout = globalThis.setTimeout(() => {
      firstOptionRef.current?.focus();
    }, 0);

    return () => globalThis.clearTimeout(timeout);
  }, [args.open]);

  if (!args.open) {
    return null;
  }

  return (
    <div className="workflow-overlay">
      <button
        type="button"
        data-testid="workflow-add-node-backdrop"
        aria-label="Close add node dialog"
        tabIndex={-1}
        onClick={args.onClose}
        style={{
          position: 'absolute',
          inset: 0,
          background: 'transparent',
          border: 0,
          padding: 0,
        }}
      />
      <dialog
        open
        className="workflow-dialog workflow-command-palette"
        aria-label="Add node"
        onCancel={(event) => {
          event.preventDefault();
          args.onClose();
        }}
        style={{ position: 'relative' }}
      >
        <header className="workflow-dialog__header">
          <h3>Add node</h3>
          <p className="meta-text">Choose a node type to add to the canvas. Press Escape to close.</p>
        </header>

        <ul className="workflow-command-palette__options">
          <li>
            <button
              ref={firstOptionRef}
              type="button"
              className="workflow-command-palette__option"
              onClick={() => args.onSelect('agent')}
            >
              <strong>Agent node</strong>
              <span>Provider-backed phase with a prompt template.</span>
            </button>
          </li>
          <li>
            <button
              type="button"
              className="workflow-command-palette__option"
              onClick={() => args.onSelect('human')}
            >
              <strong>Human node</strong>
              <span>Draft placeholder (publish may be blocked by validation).</span>
            </button>
          </li>
          <li>
            <button
              type="button"
              className="workflow-command-palette__option"
              onClick={() => args.onSelect('tool')}
            >
              <strong>Tool node</strong>
              <span>Draft placeholder for tool execution (publish may be blocked by validation).</span>
            </button>
          </li>
        </ul>

        <div className="workflow-dialog__actions">
          <ActionButton onClick={args.onClose}>Close</ActionButton>
        </div>
      </dialog>
    </div>
  );
}

