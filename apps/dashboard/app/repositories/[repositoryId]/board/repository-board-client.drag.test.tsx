// @vitest-environment jsdom

import { act, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { DashboardRepositoryState, DashboardWorkItemSnapshot } from '@dashboard/server/dashboard-contracts';

const { dndState } = vi.hoisted(() => ({
  dndState: {
    onDragEnd: null as null | ((event: { active: { id: number | string }; over?: { id: string } | null }) => void | Promise<void>),
  },
}));

vi.mock('@dnd-kit/core', async () => {
  const React = await import('react');

  return {
    DndContext: (props: {
      children?: ReactNode;
      onDragEnd?: null | ((event: { active: { id: number | string }; over?: { id: string } | null }) => void | Promise<void>);
    }) => {
      dndState.onDragEnd = props.onDragEnd ?? null;
      return React.createElement('div', { 'data-testid': 'mock-dnd-context' }, props.children);
    },
    DragOverlay: (props: { children?: ReactNode }) => React.createElement(React.Fragment, null, props.children),
    MouseSensor: class MouseSensor {},
    rectIntersection: vi.fn(),
    useDndContext: () => ({ active: null }),
    useDraggable: () => ({
      attributes: {},
      listeners: {},
      setNodeRef: () => undefined,
      transform: null,
      isDragging: false,
    }),
    useDroppable: () => ({
      isOver: false,
      setNodeRef: () => undefined,
    }),
    useSensor: () => ({}),
    useSensors: (...sensors: unknown[]) => sensors,
  };
});

import { RepositoryBoardPageContent } from './repository-board-client';

function createRepository(overrides: Partial<DashboardRepositoryState> = {}): DashboardRepositoryState {
  return {
    id: overrides.id ?? 1,
    name: overrides.name ?? 'demo-repo',
    provider: overrides.provider ?? 'github',
    remoteRef: overrides.remoteRef ?? 'octocat/demo-repo',
    remoteUrl: overrides.remoteUrl ?? 'https://github.com/octocat/demo-repo.git',
    defaultBranch: overrides.defaultBranch ?? 'main',
    branchTemplate: overrides.branchTemplate ?? null,
    cloneStatus: overrides.cloneStatus ?? 'cloned',
    localPath: overrides.localPath ?? '/tmp/repos/demo-repo',
    archivedAt: overrides.archivedAt ?? null,
  };
}

function createWorkItem(overrides: Partial<DashboardWorkItemSnapshot> = {}): DashboardWorkItemSnapshot {
  return {
    id: overrides.id ?? 10,
    repositoryId: overrides.repositoryId ?? 1,
    type: overrides.type ?? 'task',
    status: overrides.status ?? 'Ready',
    title: overrides.title ?? 'Write tests',
    description: overrides.description ?? null,
    parentId: overrides.parentId ?? null,
    tags: overrides.tags ?? null,
    plannedFiles: overrides.plannedFiles ?? null,
    assignees: overrides.assignees ?? null,
    priority: overrides.priority ?? null,
    estimate: overrides.estimate ?? null,
    revision: overrides.revision ?? 0,
    createdAt: overrides.createdAt ?? new Date('2026-03-02T00:00:00.000Z').toISOString(),
    updatedAt: overrides.updatedAt ?? new Date('2026-03-02T00:00:00.000Z').toISOString(),
    effectivePolicy: overrides.effectivePolicy ?? null,
    linkedWorkflowRun: overrides.linkedWorkflowRun ?? null,
  };
}

function createJsonResponse(payload: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(payload), init);
}

describe('RepositoryBoardPageContent drag moves', () => {
  beforeEach(() => {
    dndState.onDragEnd = null;
    vi.stubGlobal('EventSource', undefined as unknown as typeof EventSource);
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('starts task workflows when Ready tasks are dragged into InProgress', async () => {
    const fetchMock = vi.mocked(global.fetch);

    fetchMock.mockResolvedValueOnce(
      createJsonResponse({
        workItem: createWorkItem({
          id: 10,
          status: 'InProgress',
          revision: 1,
          linkedWorkflowRun: {
            workflowRunId: 44,
            runStatus: 'pending',
            linkedAt: new Date('2026-03-06T00:00:00.000Z').toISOString(),
          },
        }),
        workflowRunId: 44,
      }),
    );

    render(
      <RepositoryBoardPageContent
        repository={createRepository({ id: 1, name: 'demo-repo' })}
        actor={{ actorType: 'human', actorLabel: 'octocat' }}
        initialLatestEventId={0}
        initialWorkItems={[createWorkItem({ id: 10, status: 'Ready', revision: 0, title: 'Write tests', type: 'task' })]}
      />,
    );

    await act(async () => {
      await dndState.onDragEnd?.({
        active: { id: 10 },
        over: { id: 'InProgress' },
      });
    });

    expect(fetchMock).toHaveBeenCalledWith('/api/dashboard/work-items/10/actions/start-task-workflow', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repositoryId: 1,
        expectedRevision: 0,
        actorType: 'human',
        actorLabel: 'octocat',
      }),
    });
    expect(screen.getByText('Moved "Write tests" to InProgress.')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Tasks InProgress' })).getByRole('button', { name: /Write tests/ })).toBeInTheDocument();
  });
});
