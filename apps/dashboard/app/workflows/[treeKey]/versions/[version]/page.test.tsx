// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import WorkflowVersionPage from './page';
import { DashboardIntegrationError } from '../../../../../src/server/dashboard-errors';

const { notFoundMock } = vi.hoisted(() => ({
  notFoundMock: vi.fn(() => {
    throw new Error('NOT_FOUND');
  }),
}));

const { createDashboardServiceMock, getWorkflowTreeVersionSnapshotMock } = vi.hoisted(() => ({
  createDashboardServiceMock: vi.fn(),
  getWorkflowTreeVersionSnapshotMock: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  notFound: notFoundMock,
}));

vi.mock('../../../../../src/server/dashboard-service', () => ({
  createDashboardService: createDashboardServiceMock,
}));

vi.mock('../../../workflow-json-copy-client', () => ({
  WorkflowJsonCopyActions: () => null,
}));

describe('WorkflowVersionPage', () => {
  beforeEach(() => {
    notFoundMock.mockClear();
    createDashboardServiceMock.mockReset();
    getWorkflowTreeVersionSnapshotMock.mockReset();
    createDashboardServiceMock.mockReturnValue({
      getWorkflowTreeVersionSnapshot: getWorkflowTreeVersionSnapshotMock,
    });
  });

  it('renders version snapshots from the dashboard service', async () => {
    getWorkflowTreeVersionSnapshotMock.mockResolvedValue({
      treeKey: 'demo-tree',
      name: 'Demo Tree',
      status: 'published',
      version: 2,
      initialRunnableNodeKeys: [],
    });

    const element = (await WorkflowVersionPage({
      params: Promise.resolve({ treeKey: 'demo-tree', version: '2' }),
    })) as unknown as ReactElement;

    render(element);

    expect(getWorkflowTreeVersionSnapshotMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('heading', { name: 'Demo Tree v2' })).toBeInTheDocument();
  });

  it('delegates invalid version params to next/navigation notFound()', async () => {
    await expect(
      WorkflowVersionPage({ params: Promise.resolve({ treeKey: 'demo-tree', version: 'nope' }) }),
    ).rejects.toThrowError('NOT_FOUND');
    expect(getWorkflowTreeVersionSnapshotMock).not.toHaveBeenCalled();
    expect(notFoundMock).toHaveBeenCalledTimes(1);
  });

  it('delegates missing versions to next/navigation notFound()', async () => {
    getWorkflowTreeVersionSnapshotMock.mockRejectedValue(
      new DashboardIntegrationError('not_found', 'missing', { status: 404 }),
    );

    await expect(
      WorkflowVersionPage({ params: Promise.resolve({ treeKey: 'demo-tree', version: '1' }) }),
    ).rejects.toThrowError('NOT_FOUND');
    expect(notFoundMock).toHaveBeenCalledTimes(1);
  });
});

