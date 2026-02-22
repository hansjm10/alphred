// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import WorkflowEditorPage from './page';
import { DashboardIntegrationError } from '../../../../src/server/dashboard-errors';

const { notFoundMock } = vi.hoisted(() => ({
  notFoundMock: vi.fn(() => {
    throw new Error('NOT_FOUND');
  }),
}));

const { createDashboardServiceMock, getOrCreateWorkflowDraftMock } = vi.hoisted(() => ({
  createDashboardServiceMock: vi.fn(),
  getOrCreateWorkflowDraftMock: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  notFound: notFoundMock,
}));

vi.mock('../../../../src/server/dashboard-service', () => ({
  createDashboardService: createDashboardServiceMock,
}));

vi.mock('./workflow-editor-client', () => ({
  WorkflowEditorPageContent: ({ initialDraft }: { initialDraft: { treeKey: string } }) => (
    <div>Editor for {initialDraft.treeKey}</div>
  ),
}));

describe('WorkflowEditorPage', () => {
  beforeEach(() => {
    notFoundMock.mockClear();
    createDashboardServiceMock.mockReset();
    getOrCreateWorkflowDraftMock.mockReset();
    createDashboardServiceMock.mockReturnValue({
      getOrCreateWorkflowDraft: getOrCreateWorkflowDraftMock,
    });
  });

  it('uses provided draft without calling the service', async () => {
    const element = (await WorkflowEditorPage({
      draft: {
        treeKey: 'demo-tree',
        version: 1,
        draftRevision: 0,
        name: 'Demo Tree',
        description: null,
        versionNotes: null,
        nodes: [],
        edges: [],
        initialRunnableNodeKeys: [],
      },
      params: Promise.resolve({ treeKey: 'demo-tree' }),
    })) as unknown as ReactElement;

    render(element);

    expect(getOrCreateWorkflowDraftMock).not.toHaveBeenCalled();
    expect(screen.getByText('Editor for demo-tree')).toBeInTheDocument();
  });

  it('loads the workflow draft via the dashboard service when none is provided', async () => {
    getOrCreateWorkflowDraftMock.mockResolvedValue({
      treeKey: 'demo-tree',
      version: 1,
      draftRevision: 0,
      name: 'Demo Tree',
      description: null,
      versionNotes: null,
      nodes: [],
      edges: [],
      initialRunnableNodeKeys: [],
    });

    const element = (await WorkflowEditorPage({
      params: Promise.resolve({ treeKey: 'demo-tree' }),
    })) as unknown as ReactElement;

    render(element);

    expect(getOrCreateWorkflowDraftMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Editor for demo-tree')).toBeInTheDocument();
  });

  it('delegates missing drafts to next/navigation notFound()', async () => {
    getOrCreateWorkflowDraftMock.mockRejectedValue(
      new DashboardIntegrationError('not_found', 'missing', { status: 404 }),
    );

    await expect(
      WorkflowEditorPage({ params: Promise.resolve({ treeKey: 'missing' }) }),
    ).rejects.toThrowError('NOT_FOUND');
    expect(notFoundMock).toHaveBeenCalledTimes(1);
  });

  it('rethrows unexpected errors from the dashboard service', async () => {
    getOrCreateWorkflowDraftMock.mockRejectedValue(new Error('boom'));

    await expect(
      WorkflowEditorPage({ params: Promise.resolve({ treeKey: 'demo-tree' }) }),
    ).rejects.toThrowError('boom');
    expect(notFoundMock).not.toHaveBeenCalled();
  });
});
