// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import WorkflowDetailPage from './page';
import { DashboardIntegrationError } from '../../../src/server/dashboard-errors';

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

vi.mock('../../../src/server/dashboard-service', () => ({
  createDashboardService: createDashboardServiceMock,
}));

vi.mock('../workflow-json-copy-client', () => ({
  WorkflowJsonCopyActions: () => null,
}));

describe('WorkflowDetailPage', () => {
  it('renders a workflow tree snapshot', async () => {
    getWorkflowTreeSnapshotMock.mockResolvedValue({
      treeKey: 'demo-tree',
      name: 'Demo Tree',
      status: 'published',
      version: 2,
      nodes: [
        {
          nodeKey: 'decompose',
          nodeRole: 'spawner',
          maxChildren: 8,
        },
      ],
      edges: [
        {
          sourceNodeKey: 'decompose',
          targetNodeKey: 'review',
          routeOn: 'failure',
          priority: 20,
        },
      ],
      initialRunnableNodeKeys: [],
    });
    createDashboardServiceMock.mockReturnValue({
      getWorkflowTreeSnapshot: getWorkflowTreeSnapshotMock,
    });

    const element = (await WorkflowDetailPage({
      params: Promise.resolve({ treeKey: 'demo-tree' }),
    })) as unknown as ReactElement;

    render(element);

    expect(screen.getByRole('heading', { name: 'Demo Tree' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Edit' })).toHaveAttribute('href', '/workflows/demo-tree/edit');
    expect(screen.getByText('role spawner · maxChildren 8')).toBeInTheDocument();
    expect(screen.getByText('failure route · priority 20')).toBeInTheDocument();
  });

  it('delegates not found snapshots to next/navigation notFound()', async () => {
    getWorkflowTreeSnapshotMock.mockRejectedValue(
      new DashboardIntegrationError('not_found', 'missing', { status: 404 }),
    );
    createDashboardServiceMock.mockReturnValue({
      getWorkflowTreeSnapshot: getWorkflowTreeSnapshotMock,
    });

    await expect(
      WorkflowDetailPage({ params: Promise.resolve({ treeKey: 'missing' }) }),
    ).rejects.toThrowError('NOT_FOUND');
    expect(notFoundMock).toHaveBeenCalledTimes(1);
  });

  it('rethrows unexpected errors', async () => {
    notFoundMock.mockClear();
    getWorkflowTreeSnapshotMock.mockRejectedValue(new Error('boom'));
    createDashboardServiceMock.mockReturnValue({
      getWorkflowTreeSnapshot: getWorkflowTreeSnapshotMock,
    });

    await expect(
      WorkflowDetailPage({ params: Promise.resolve({ treeKey: 'demo-tree' }) }),
    ).rejects.toThrowError('boom');
    expect(notFoundMock).not.toHaveBeenCalled();
  });
});
