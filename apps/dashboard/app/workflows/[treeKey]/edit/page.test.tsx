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

const { createDashboardServiceMock, getWorkflowTreeSnapshotMock } = vi.hoisted(() => ({
  createDashboardServiceMock: vi.fn(),
  getWorkflowTreeSnapshotMock: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  notFound: notFoundMock,
}));

vi.mock('../../../../src/server/dashboard-service', () => ({
  createDashboardService: createDashboardServiceMock,
}));

vi.mock('./workflow-editor-client', () => ({
  WorkflowEditorPageContent: ({
    initialDraft,
    bootstrapDraftOnMount,
  }: {
    initialDraft: { treeKey: string };
    bootstrapDraftOnMount?: boolean;
  }) => (
    <div>
      Editor for {initialDraft.treeKey} ({bootstrapDraftOnMount ? 'bootstrap' : 'ready'})
    </div>
  ),
}));

describe('WorkflowEditorPage', () => {
  beforeEach(() => {
    notFoundMock.mockClear();
    createDashboardServiceMock.mockReset();
    getWorkflowTreeSnapshotMock.mockReset();
    createDashboardServiceMock.mockReturnValue({
      getWorkflowTreeSnapshot: getWorkflowTreeSnapshotMock,
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

    expect(getWorkflowTreeSnapshotMock).not.toHaveBeenCalled();
    expect(screen.getByText('Editor for demo-tree (ready)')).toBeInTheDocument();
  });

  it('loads a draft snapshot without bootstrap when a draft already exists', async () => {
    getWorkflowTreeSnapshotMock.mockResolvedValue({
      status: 'draft',
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

    expect(getWorkflowTreeSnapshotMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Editor for demo-tree (ready)')).toBeInTheDocument();
  });

  it('enables client-side draft bootstrap when only a published snapshot is available', async () => {
    getWorkflowTreeSnapshotMock.mockResolvedValue({
      status: 'published',
      treeKey: 'demo-tree',
      version: 2,
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

    expect(getWorkflowTreeSnapshotMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Editor for demo-tree (bootstrap)')).toBeInTheDocument();
  });

  it('delegates missing drafts to next/navigation notFound()', async () => {
    getWorkflowTreeSnapshotMock.mockRejectedValue(
      new DashboardIntegrationError('not_found', 'missing', { status: 404 }),
    );

    await expect(
      WorkflowEditorPage({ params: Promise.resolve({ treeKey: 'missing' }) }),
    ).rejects.toThrowError('NOT_FOUND');
    expect(notFoundMock).toHaveBeenCalledTimes(1);
  });

  it('rethrows unexpected errors from the dashboard service', async () => {
    getWorkflowTreeSnapshotMock.mockRejectedValue(new Error('boom'));

    await expect(
      WorkflowEditorPage({ params: Promise.resolve({ treeKey: 'demo-tree' }) }),
    ).rejects.toThrowError('boom');
    expect(notFoundMock).not.toHaveBeenCalled();
  });
});
