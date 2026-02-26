// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RunsPage, { RunsPageContent } from './page';
import type {
  DashboardRepositoryState,
  DashboardRunSummary,
  DashboardWorkflowTreeSummary,
} from '../../src/server/dashboard-contracts';
import type { GitHubAuthGate } from '../ui/github-auth';
import { createGitHubAuthGate } from '../ui/github-auth';

const {
  loadGitHubAuthGateMock,
  loadDashboardRunSummariesMock,
  loadDashboardWorkflowTreesMock,
  loadDashboardRepositoriesMock,
} = vi.hoisted(() => ({
  loadGitHubAuthGateMock: vi.fn(),
  loadDashboardRunSummariesMock: vi.fn(),
  loadDashboardWorkflowTreesMock: vi.fn(),
  loadDashboardRepositoriesMock: vi.fn(),
}));

const { pushMock } = vi.hoisted(() => ({
  pushMock: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: pushMock,
  }),
}));

vi.mock('../ui/load-github-auth-gate', () => ({
  loadGitHubAuthGate: loadGitHubAuthGateMock,
}));

vi.mock('./load-dashboard-runs', () => ({
  loadDashboardRunSummaries: loadDashboardRunSummariesMock,
  loadDashboardWorkflowTrees: loadDashboardWorkflowTreesMock,
}));

vi.mock('../repositories/load-dashboard-repositories', () => ({
  loadDashboardRepositories: loadDashboardRepositoriesMock,
}));

function createRunSummary(overrides: Partial<DashboardRunSummary> = {}): DashboardRunSummary {
  const repositoryContext =
    overrides.repository === undefined
      ? {
        id: 1,
        name: 'demo-repo',
      }
      : overrides.repository;

  return {
    id: overrides.id ?? 412,
    tree: overrides.tree ?? {
      id: 1,
      treeKey: 'demo-tree',
      version: 1,
      name: 'Demo Tree',
    },
    status: overrides.status ?? 'running',
    repository: repositoryContext,
    startedAt: overrides.startedAt ?? '2026-02-18T00:00:00.000Z',
    completedAt: overrides.completedAt ?? null,
    createdAt: overrides.createdAt ?? '2026-02-18T00:00:00.000Z',
    nodeSummary: overrides.nodeSummary ?? {
      pending: 1,
      running: 1,
      completed: 1,
      failed: 0,
      skipped: 0,
      cancelled: 0,
    },
  };
}

function createWorkflow(overrides: Partial<DashboardWorkflowTreeSummary> = {}): DashboardWorkflowTreeSummary {
  return {
    id: overrides.id ?? 1,
    treeKey: overrides.treeKey ?? 'demo-tree',
    version: overrides.version ?? 1,
    name: overrides.name ?? 'Demo Tree',
    description: overrides.description ?? 'Default tree',
  };
}

function createRepository(overrides: Partial<DashboardRepositoryState> = {}): DashboardRepositoryState {
  const name = overrides.name ?? 'demo-repo';

  return {
    id: overrides.id ?? 1,
    name,
    provider: overrides.provider ?? 'github',
    remoteRef: overrides.remoteRef ?? `octocat/${name}`,
    remoteUrl: overrides.remoteUrl ?? `https://github.com/octocat/${name}.git`,
    defaultBranch: overrides.defaultBranch ?? 'main',
    branchTemplate: overrides.branchTemplate ?? null,
    cloneStatus: overrides.cloneStatus ?? 'cloned',
    localPath: overrides.localPath ?? `/tmp/repos/${name}`,
  };
}

function createAuthenticatedAuthGate(): GitHubAuthGate {
  return createGitHubAuthGate({
    authenticated: true,
    user: 'octocat',
    scopes: ['repo'],
    error: null,
  });
}

function createJsonResponse(payload: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(payload), init);
}

describe('RunsPage', () => {
  beforeEach(() => {
    pushMock.mockReset();
    loadGitHubAuthGateMock.mockReset();
    loadDashboardRunSummariesMock.mockReset();
    loadDashboardWorkflowTreesMock.mockReset();
    loadDashboardRepositoriesMock.mockReset();
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders launch form and lifecycle rows', () => {
    render(
      <RunsPageContent
        runs={[
          createRunSummary({ id: 412, status: 'running' }),
          createRunSummary({ id: 411, status: 'failed', completedAt: '2026-02-18T00:02:00.000Z' }),
        ]}
        workflows={[createWorkflow()]}
        repositories={[createRepository()]}
        authGate={createAuthenticatedAuthGate()}
        activeFilter="all"
        activeRepositoryName={null}
        activeWorkflowKey={null}
        activeWindow="all"
      />,
    );

    expect(screen.getByRole('heading', { name: 'Run lifecycle' })).toBeInTheDocument();
    expect(screen.getByLabelText('Workflow')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Launch Run' })).toBeEnabled();
    expect(screen.getByRole('columnheader', { name: 'Repository' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Node lifecycle' })).toBeInTheDocument();
    expect(screen.getByText('#412 Demo Tree')).toBeInTheDocument();
    expect(screen.getAllByText('demo-repo').length).toBeGreaterThan(0);
    expect(screen.getAllByText('2026-02-18 00:00:00 UTC')).toHaveLength(2);
    expect(screen.getByText('2026-02-18 00:02:00 UTC')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Open' })[0]).toHaveAttribute('href', '/runs/412');
  });

  it('prefills repository context when an initial repository name is provided', () => {
    render(
      <RunsPageContent
        runs={[createRunSummary({ id: 412, status: 'running' })]}
        workflows={[createWorkflow()]}
        repositories={[
          createRepository({ name: 'demo-repo', cloneStatus: 'cloned' }),
          createRepository({ id: 2, name: 'sample-repo', cloneStatus: 'cloned' }),
        ]}
        authGate={createAuthenticatedAuthGate()}
        activeFilter="all"
        activeRepositoryName="sample-repo"
        activeWorkflowKey={null}
        activeWindow="all"
      />,
    );

    expect(screen.getByLabelText('Repository context')).toHaveValue('sample-repo');
  });

  it('treats running filter as active lifecycle states', () => {
    render(
      <RunsPageContent
        runs={[
          createRunSummary({ id: 412, status: 'running' }),
          createRunSummary({ id: 413, status: 'pending' }),
          createRunSummary({ id: 414, status: 'paused' }),
          createRunSummary({ id: 415, status: 'failed', completedAt: '2026-02-18T00:02:00.000Z' }),
        ]}
        workflows={[createWorkflow()]}
        repositories={[createRepository()]}
        authGate={createAuthenticatedAuthGate()}
        activeFilter="running"
        activeRepositoryName={null}
        activeWorkflowKey={null}
        activeWindow="all"
      />,
    );

    expect(screen.getByText('#412 Demo Tree')).toBeInTheDocument();
    expect(screen.getByText('#413 Demo Tree')).toBeInTheDocument();
    expect(screen.getByText('#414 Demo Tree')).toBeInTheDocument();
    expect(screen.queryByText('#415 Demo Tree')).toBeNull();
    expect(screen.getByRole('link', { name: 'Running' })).toHaveAttribute('aria-current', 'page');
  });

  it('pushes updated query params when filter bar changes', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <RunsPageContent
        runs={[createRunSummary({ id: 412, status: 'running' })]}
        workflows={[
          createWorkflow({ id: 1, treeKey: 'demo-tree', name: 'Demo Tree' }),
          createWorkflow({ id: 2, treeKey: 'other-tree', name: 'Other Tree' }),
        ]}
        repositories={[
          createRepository({ id: 1, name: 'demo-repo', cloneStatus: 'cloned' }),
          createRepository({ id: 2, name: 'sample-repo', cloneStatus: 'cloned' }),
        ]}
        authGate={createAuthenticatedAuthGate()}
        activeFilter="failed"
        activeRepositoryName={null}
        activeWorkflowKey={null}
        activeWindow="all"
      />,
    );

    await user.selectOptions(screen.getByLabelText('Workflow filter'), 'demo-tree');
    expect(pushMock).toHaveBeenCalledWith('/runs?status=failed&workflow=demo-tree');

    rerender(
      <RunsPageContent
        runs={[createRunSummary({ id: 412, status: 'running' })]}
        workflows={[
          createWorkflow({ id: 1, treeKey: 'demo-tree', name: 'Demo Tree' }),
          createWorkflow({ id: 2, treeKey: 'other-tree', name: 'Other Tree' }),
        ]}
        repositories={[
          createRepository({ id: 1, name: 'demo-repo', cloneStatus: 'cloned' }),
          createRepository({ id: 2, name: 'sample-repo', cloneStatus: 'cloned' }),
        ]}
        authGate={createAuthenticatedAuthGate()}
        activeFilter="failed"
        activeRepositoryName={null}
        activeWorkflowKey="demo-tree"
        activeWindow="all"
      />,
    );

    await user.selectOptions(screen.getByLabelText('Time window'), '24h');
    expect(pushMock).toHaveBeenLastCalledWith('/runs?status=failed&workflow=demo-tree&window=24h');

    rerender(
      <RunsPageContent
        runs={[createRunSummary({ id: 412, status: 'running' })]}
        workflows={[
          createWorkflow({ id: 1, treeKey: 'demo-tree', name: 'Demo Tree' }),
          createWorkflow({ id: 2, treeKey: 'other-tree', name: 'Other Tree' }),
        ]}
        repositories={[
          createRepository({ id: 1, name: 'demo-repo', cloneStatus: 'cloned' }),
          createRepository({ id: 2, name: 'sample-repo', cloneStatus: 'cloned' }),
        ]}
        authGate={createAuthenticatedAuthGate()}
        activeFilter="failed"
        activeRepositoryName="sample-repo"
        activeWorkflowKey="demo-tree"
        activeWindow="24h"
      />,
    );

    await user.selectOptions(screen.getByLabelText('Repository filter'), 'demo-repo');
    expect(pushMock).toHaveBeenLastCalledWith(
      '/runs?status=failed&workflow=demo-tree&repository=demo-repo&window=24h',
    );
  });

  it('navigates to run detail on row click', async () => {
    const user = userEvent.setup();
    render(
      <RunsPageContent
        runs={[createRunSummary({ id: 412, status: 'running' })]}
        workflows={[createWorkflow()]}
        repositories={[createRepository()]}
        authGate={createAuthenticatedAuthGate()}
        activeFilter="all"
        activeRepositoryName={null}
        activeWorkflowKey={null}
        activeWindow="all"
      />,
    );

    await user.click(screen.getByText('#412 Demo Tree'));
    expect(pushMock).toHaveBeenCalledWith('/runs/412');
  });

  it('renders a compact KPI strip for the current filter context', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-18T00:10:00.000Z'));

    try {
      render(
        <RunsPageContent
          runs={[
            createRunSummary({
              id: 412,
              status: 'running',
              startedAt: '2026-02-18T00:05:00.000Z',
              createdAt: '2026-02-18T00:05:00.000Z',
              completedAt: null,
            }),
            createRunSummary({
              id: 411,
              status: 'failed',
              startedAt: '2026-02-18T00:00:00.000Z',
              completedAt: '2026-02-18T00:02:00.000Z',
              createdAt: '2026-02-18T00:00:00.000Z',
            }),
            createRunSummary({
              id: 410,
              status: 'completed',
              startedAt: '2026-02-17T23:40:00.000Z',
              completedAt: '2026-02-17T23:50:00.000Z',
              createdAt: '2026-02-17T23:40:00.000Z',
            }),
          ]}
          workflows={[createWorkflow()]}
          repositories={[createRepository()]}
          authGate={createAuthenticatedAuthGate()}
          activeFilter="all"
          activeRepositoryName={null}
          activeWorkflowKey={null}
          activeWindow="all"
        />,
      );

      const kpis = within(screen.getByLabelText('Run KPIs'));
      expect(kpis.getByText('Active')).toBeInTheDocument();
      expect(kpis.getByText('Failures (24h)')).toBeInTheDocument();
      expect(kpis.getByText('Median duration')).toBeInTheDocument();
      expect(screen.getByLabelText('Run KPIs')).toHaveTextContent(/Active\s*1/);
      expect(screen.getByLabelText('Run KPIs')).toHaveTextContent(/Failures \(24h\)\s*1/);
      expect(screen.getByLabelText('Run KPIs')).toHaveTextContent(/Median duration\s*6m 00s/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-syncs visible rows when server-provided runs props change', () => {
    const initialRuns = [createRunSummary({ id: 412, status: 'running' })];
    const refreshedRuns = [createRunSummary({ id: 610, status: 'failed', completedAt: '2026-02-18T00:02:00.000Z' })];

    const { rerender } = render(
      <RunsPageContent
        runs={initialRuns}
        workflows={[createWorkflow()]}
        repositories={[createRepository()]}
        authGate={createAuthenticatedAuthGate()}
        activeFilter="all"
        activeRepositoryName={null}
        activeWorkflowKey={null}
        activeWindow="all"
      />,
    );

    expect(screen.getByText('#412 Demo Tree')).toBeInTheDocument();

    rerender(
      <RunsPageContent
        runs={refreshedRuns}
        workflows={[createWorkflow()]}
        repositories={[createRepository()]}
        authGate={createAuthenticatedAuthGate()}
        activeFilter="all"
        activeRepositoryName={null}
        activeWorkflowKey={null}
        activeWindow="all"
      />,
    );

    expect(screen.queryByText('#412 Demo Tree')).toBeNull();
    expect(screen.getByText('#610 Demo Tree')).toBeInTheDocument();
  });

  it('launches a run and refreshes lifecycle rows', async () => {
    const fetchMock = vi.mocked(global.fetch);
    fetchMock
      .mockResolvedValueOnce(createJsonResponse({
        workflowRunId: 600,
        mode: 'async',
        status: 'accepted',
        runStatus: 'running',
        executionOutcome: null,
        executedNodes: null,
      }, { status: 202 }))
      .mockResolvedValueOnce(createJsonResponse({
        runs: [
          createRunSummary({
            id: 600,
            status: 'running',
            tree: {
              id: 2,
              treeKey: 'other-tree',
              version: 3,
              name: 'Other Tree',
            },
          }),
        ],
      }));

    const user = userEvent.setup();
    render(
      <RunsPageContent
        runs={[createRunSummary({ id: 412, status: 'running' })]}
        workflows={[createWorkflow(), createWorkflow({ id: 2, treeKey: 'other-tree', name: 'Other Tree' })]}
        repositories={[createRepository({ name: 'demo-repo', cloneStatus: 'cloned' })]}
        authGate={createAuthenticatedAuthGate()}
        activeFilter="all"
        activeRepositoryName={null}
        activeWorkflowKey={null}
        activeWindow="all"
      />,
    );

    await user.selectOptions(screen.getByLabelText('Workflow'), 'other-tree');
    await user.selectOptions(screen.getByLabelText('Repository context'), 'demo-repo');
    await user.type(screen.getByLabelText('Branch (optional)'), 'feature/runs-ui');
    await user.click(screen.getByRole('button', { name: 'Launch Run' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/dashboard/runs', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          treeKey: 'other-tree',
          repositoryName: 'demo-repo',
          branch: 'feature/runs-ui',
          executionMode: 'async',
          executionScope: 'full',
        }),
      });
      expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/dashboard/runs?limit=50', {
        method: 'GET',
      });
    });

    expect(await screen.findByText(/Run #600 accepted. Current status: running./)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open run detail' })).toHaveAttribute('href', '/runs/600');
    expect(screen.getByText('#600 Other Tree')).toBeInTheDocument();
  });

  it('launches a single-node run with node_key selector payload', async () => {
    const fetchMock = vi.mocked(global.fetch);
    fetchMock
      .mockResolvedValueOnce(createJsonResponse({
        workflowRunId: 612,
        mode: 'async',
        status: 'accepted',
        runStatus: 'running',
        executionOutcome: null,
        executedNodes: null,
      }, { status: 202 }))
      .mockResolvedValueOnce(createJsonResponse({
        runs: [createRunSummary({ id: 612, status: 'completed' })],
      }));

    const user = userEvent.setup();
    render(
      <RunsPageContent
        runs={[createRunSummary({ id: 412, status: 'running' })]}
        workflows={[createWorkflow(), createWorkflow({ id: 2, treeKey: 'other-tree', name: 'Other Tree' })]}
        repositories={[createRepository({ name: 'demo-repo', cloneStatus: 'cloned' })]}
        authGate={createAuthenticatedAuthGate()}
        activeFilter="all"
        activeRepositoryName={null}
        activeWorkflowKey={null}
        activeWindow="all"
      />,
    );

    await user.selectOptions(screen.getByLabelText('Workflow'), 'other-tree');
    await user.selectOptions(screen.getByLabelText('Execution scope'), 'single_node');
    await user.selectOptions(screen.getByLabelText('Node selector'), 'node_key');
    await user.type(screen.getByLabelText('Node key'), 'design');
    await user.click(screen.getByRole('button', { name: 'Launch Run' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/dashboard/runs', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          treeKey: 'other-tree',
          repositoryName: undefined,
          branch: undefined,
          executionMode: 'async',
          executionScope: 'single_node',
          nodeSelector: {
            type: 'node_key',
            nodeKey: 'design',
          },
        }),
      });
    });
  });

  it('launches a single-node run with the default next_runnable selector payload', async () => {
    const fetchMock = vi.mocked(global.fetch);
    fetchMock
      .mockResolvedValueOnce(createJsonResponse({
        workflowRunId: 613,
        mode: 'async',
        status: 'accepted',
        runStatus: 'running',
        executionOutcome: null,
        executedNodes: null,
      }, { status: 202 }))
      .mockResolvedValueOnce(createJsonResponse({
        runs: [createRunSummary({ id: 613, status: 'running' })],
      }));

    const user = userEvent.setup();
    render(
      <RunsPageContent
        runs={[createRunSummary({ id: 412, status: 'running' })]}
        workflows={[createWorkflow(), createWorkflow({ id: 2, treeKey: 'other-tree', name: 'Other Tree' })]}
        repositories={[createRepository({ name: 'demo-repo', cloneStatus: 'cloned' })]}
        authGate={createAuthenticatedAuthGate()}
        activeFilter="all"
        activeRepositoryName={null}
        activeWorkflowKey={null}
        activeWindow="all"
      />,
    );

    await user.selectOptions(screen.getByLabelText('Workflow'), 'other-tree');
    await user.selectOptions(screen.getByLabelText('Execution scope'), 'single_node');
    await user.click(screen.getByRole('button', { name: 'Launch Run' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/dashboard/runs', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          treeKey: 'other-tree',
          repositoryName: undefined,
          branch: undefined,
          executionMode: 'async',
          executionScope: 'single_node',
          nodeSelector: {
            type: 'next_runnable',
          },
        }),
      });
    });
  });

  it('ignores unsupported execution scope values from DOM events', async () => {
    const user = userEvent.setup();
    render(
      <RunsPageContent
        runs={[createRunSummary({ id: 412, status: 'running' })]}
        workflows={[createWorkflow()]}
        repositories={[createRepository({ name: 'demo-repo', cloneStatus: 'cloned' })]}
        authGate={createAuthenticatedAuthGate()}
        activeFilter="all"
        activeRepositoryName={null}
        activeWorkflowKey={null}
        activeWindow="all"
      />,
    );

    const scopeSelect = screen.getByLabelText('Execution scope');
    expect(scopeSelect).toHaveValue('full');

    fireEvent.change(scopeSelect, {
      target: { value: 'unsupported' },
    });

    expect(scopeSelect).toHaveValue('full');

    await user.selectOptions(scopeSelect, 'single_node');
    expect(scopeSelect).toHaveValue('single_node');
  });

  it('ignores unsupported node selector values from DOM events', async () => {
    const user = userEvent.setup();
    render(
      <RunsPageContent
        runs={[createRunSummary({ id: 412, status: 'running' })]}
        workflows={[createWorkflow()]}
        repositories={[createRepository({ name: 'demo-repo', cloneStatus: 'cloned' })]}
        authGate={createAuthenticatedAuthGate()}
        activeFilter="all"
        activeRepositoryName={null}
        activeWorkflowKey={null}
        activeWindow="all"
      />,
    );

    await user.selectOptions(screen.getByLabelText('Execution scope'), 'single_node');

    const selectorInput = screen.getByLabelText('Node selector');
    expect(selectorInput).toHaveValue('next_runnable');

    fireEvent.change(selectorInput, {
      target: { value: 'unsupported_selector' },
    });

    expect(selectorInput).toHaveValue('next_runnable');
  });

  it('disables launch when single-node node_key selector is missing node key', async () => {
    const user = userEvent.setup();
    render(
      <RunsPageContent
        runs={[createRunSummary({ id: 412, status: 'running' })]}
        workflows={[createWorkflow()]}
        repositories={[createRepository({ name: 'demo-repo', cloneStatus: 'cloned' })]}
        authGate={createAuthenticatedAuthGate()}
        activeFilter="all"
        activeRepositoryName={null}
        activeWorkflowKey={null}
        activeWindow="all"
      />,
    );

    await user.selectOptions(screen.getByLabelText('Execution scope'), 'single_node');
    await user.selectOptions(screen.getByLabelText('Node selector'), 'node_key');

    expect(screen.getByRole('button', { name: 'Launch Run' })).toBeDisabled();
  });

  it('uses refreshed run status in launch accepted messaging', async () => {
    const fetchMock = vi.mocked(global.fetch);
    fetchMock
      .mockResolvedValueOnce(createJsonResponse({
        workflowRunId: 611,
        mode: 'async',
        status: 'accepted',
        runStatus: 'running',
        executionOutcome: null,
        executedNodes: null,
      }, { status: 202 }))
      .mockResolvedValueOnce(createJsonResponse({
        runs: [createRunSummary({ id: 611, status: 'completed', completedAt: '2026-02-18T00:03:00.000Z' })],
      }));

    const user = userEvent.setup();
    render(
      <RunsPageContent
        runs={[createRunSummary({ id: 412, status: 'running' })]}
        workflows={[createWorkflow(), createWorkflow({ id: 2, treeKey: 'other-tree', name: 'Other Tree' })]}
        repositories={[createRepository({ name: 'demo-repo', cloneStatus: 'cloned' })]}
        authGate={createAuthenticatedAuthGate()}
        activeFilter="all"
        activeRepositoryName={null}
        activeWorkflowKey={null}
        activeWindow="all"
      />,
    );

    await user.selectOptions(screen.getByLabelText('Workflow'), 'other-tree');
    await user.click(screen.getByRole('button', { name: 'Launch Run' }));

    expect(await screen.findByText(/Run #611 accepted. Current status: completed./)).toBeInTheDocument();
    expect(screen.queryByText(/Run #611 accepted. Current status: running./)).toBeNull();
  });

  it('keeps launch accepted messaging when lifecycle refresh fails', async () => {
    const fetchMock = vi.mocked(global.fetch);
    fetchMock
      .mockResolvedValueOnce(createJsonResponse({
        workflowRunId: 700,
        mode: 'async',
        status: 'accepted',
        runStatus: 'running',
        executionOutcome: null,
        executedNodes: null,
      }, { status: 202 }))
      .mockResolvedValueOnce(createJsonResponse({
        error: {
          message: 'Refresh unavailable.',
        },
      }, { status: 503 }));

    const user = userEvent.setup();
    render(
      <RunsPageContent
        runs={[createRunSummary({ id: 412, status: 'running' })]}
        workflows={[createWorkflow(), createWorkflow({ id: 2, treeKey: 'other-tree', name: 'Other Tree' })]}
        repositories={[createRepository({ name: 'demo-repo', cloneStatus: 'cloned' })]}
        authGate={createAuthenticatedAuthGate()}
        activeFilter="all"
        activeRepositoryName={null}
        activeWorkflowKey={null}
        activeWindow="all"
      />,
    );

    await user.selectOptions(screen.getByLabelText('Workflow'), 'other-tree');
    await user.click(screen.getByRole('button', { name: 'Launch Run' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/dashboard/runs', expect.any(Object));
      expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/dashboard/runs?limit=50', { method: 'GET' });
    });

    expect(await screen.findByText(/Run #700 accepted./)).toBeInTheDocument();
    expect(
      screen.getByText(/Run accepted, but lifecycle refresh failed: Refresh unavailable\./),
    ).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows an error when launch response payload is malformed', async () => {
    const fetchMock = vi.mocked(global.fetch);
    fetchMock.mockResolvedValueOnce(createJsonResponse({
      workflowRunId: '700',
    }, { status: 202 }));

    const user = userEvent.setup();
    render(
      <RunsPageContent
        runs={[createRunSummary({ id: 412, status: 'running' })]}
        workflows={[createWorkflow(), createWorkflow({ id: 2, treeKey: 'other-tree', name: 'Other Tree' })]}
        repositories={[createRepository({ name: 'demo-repo', cloneStatus: 'cloned' })]}
        authGate={createAuthenticatedAuthGate()}
        activeFilter="all"
        activeRepositoryName={null}
        activeWorkflowKey={null}
        activeWindow="all"
      />,
    );

    await user.selectOptions(screen.getByLabelText('Workflow'), 'other-tree');
    await user.click(screen.getByRole('button', { name: 'Launch Run' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Run launch response was malformed.');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('link', { name: 'Open run detail' })).toBeNull();
  });

  it('renders fallback repository label when run has no repository context', () => {
    render(
      <RunsPageContent
        runs={[createRunSummary({ id: 500, repository: null })]}
        workflows={[createWorkflow()]}
        repositories={[createRepository()]}
        authGate={createAuthenticatedAuthGate()}
        activeFilter="all"
        activeRepositoryName={null}
        activeWorkflowKey={null}
        activeWindow="all"
      />,
    );

    expect(screen.getByText('#500 Demo Tree')).toBeInTheDocument();
    expect(screen.getByText('Not attached')).toBeInTheDocument();
  });

  it('blocks launch actions and shows remediation when auth is unavailable', () => {
    render(
      <RunsPageContent
        runs={[createRunSummary({ id: 412, status: 'running' })]}
        workflows={[createWorkflow()]}
        repositories={[createRepository()]}
        authGate={createGitHubAuthGate({
          authenticated: false,
          user: null,
          scopes: [],
          error: 'Run gh auth login before launching.',
        })}
        activeFilter="all"
        activeRepositoryName={null}
        activeWorkflowKey={null}
        activeWindow="all"
      />,
    );

    expect(screen.getByRole('button', { name: 'Launch Run' })).toBeDisabled();
    expect(screen.getByText('Run launch is blocked until GitHub authentication is restored.')).toBeInTheDocument();
    expect(screen.getByText('gh auth login')).toBeInTheDocument();
  });

  it('loads runs dependencies for async page export when props are omitted', async () => {
    const runs = [createRunSummary({ id: 512 })];
    const workflows = [createWorkflow()];
    const repositories = [createRepository()];
    const authGate = createAuthenticatedAuthGate();
    loadDashboardRunSummariesMock.mockResolvedValue(runs);
    loadDashboardWorkflowTreesMock.mockResolvedValue(workflows);
    loadDashboardRepositoriesMock.mockResolvedValue(repositories);
    loadGitHubAuthGateMock.mockResolvedValue(authGate);

    const root = (await RunsPage()) as ReactElement<{
      runs: readonly DashboardRunSummary[];
      workflows: readonly DashboardWorkflowTreeSummary[];
      repositories: readonly DashboardRepositoryState[];
      authGate: GitHubAuthGate;
      activeFilter: 'all' | 'running' | 'failed';
      activeRepositoryName: string | null;
      activeWorkflowKey: string | null;
      activeWindow: 'all' | '24h' | '7d' | '30d';
    }>;

    expect(loadDashboardRunSummariesMock).toHaveBeenCalledTimes(1);
    expect(loadDashboardWorkflowTreesMock).toHaveBeenCalledTimes(1);
    expect(loadDashboardRepositoriesMock).toHaveBeenCalledTimes(1);
    expect(loadGitHubAuthGateMock).toHaveBeenCalledTimes(1);
    expect(root.type).toBe(RunsPageContent);
    expect(root.props.runs).toEqual(runs);
    expect(root.props.workflows).toEqual(workflows);
    expect(root.props.repositories).toEqual(repositories);
    expect(root.props.authGate).toEqual(authGate);
    expect(root.props.activeFilter).toBe('all');
    expect(root.props.activeRepositoryName).toBeNull();
    expect(root.props.activeWorkflowKey).toBeNull();
    expect(root.props.activeWindow).toBe('all');
  });

  it('uses provided props without invoking loaders and resolves query-driven prefill', async () => {
    const runs = [createRunSummary({ id: 514 })];
    const workflows = [createWorkflow({ id: 2, treeKey: 'other-tree' })];
    const repositories = [createRepository({ id: 2, name: 'sample-repo' })];
    const authGate = createAuthenticatedAuthGate();

    const root = (await RunsPage({
      runs,
      workflows,
      repositories,
      authGate,
      searchParams: Promise.resolve({
        status: ['failed', 'running'],
        workflow: ['other-tree', 'demo-tree'],
        repository: ['sample-repo', 'demo-repo'],
        window: ['7d', '24h'],
      }),
    })) as ReactElement<{
      runs: readonly DashboardRunSummary[];
      workflows: readonly DashboardWorkflowTreeSummary[];
      repositories: readonly DashboardRepositoryState[];
      authGate: GitHubAuthGate;
      activeFilter: 'all' | 'running' | 'failed';
      activeRepositoryName: string | null;
      activeWorkflowKey: string | null;
      activeWindow: 'all' | '24h' | '7d' | '30d';
    }>;

    expect(loadDashboardRunSummariesMock).not.toHaveBeenCalled();
    expect(loadDashboardWorkflowTreesMock).not.toHaveBeenCalled();
    expect(loadDashboardRepositoriesMock).not.toHaveBeenCalled();
    expect(loadGitHubAuthGateMock).not.toHaveBeenCalled();
    expect(root.type).toBe(RunsPageContent);
    expect(root.props.runs).toEqual(runs);
    expect(root.props.workflows).toEqual(workflows);
    expect(root.props.repositories).toEqual(repositories);
    expect(root.props.authGate).toEqual(authGate);
    expect(root.props.activeFilter).toBe('failed');
    expect(root.props.activeRepositoryName).toBe('sample-repo');
    expect(root.props.activeWorkflowKey).toBe('other-tree');
    expect(root.props.activeWindow).toBe('7d');
  });

  it('drops repository prefill when query repository is not cloned', async () => {
    const runs = [createRunSummary({ id: 518 })];
    const workflows = [createWorkflow()];
    const repositories = [createRepository({ id: 7, name: 'pending-repo', cloneStatus: 'pending', localPath: null })];
    const authGate = createAuthenticatedAuthGate();

    const root = (await RunsPage({
      runs,
      workflows,
      repositories,
      authGate,
      searchParams: Promise.resolve({ repository: 'pending-repo' }),
    })) as ReactElement<{
      runs: readonly DashboardRunSummary[];
      workflows: readonly DashboardWorkflowTreeSummary[];
      repositories: readonly DashboardRepositoryState[];
      authGate: GitHubAuthGate;
      activeFilter: 'all' | 'running' | 'failed';
      activeRepositoryName: string | null;
      activeWorkflowKey: string | null;
      activeWindow: 'all' | '24h' | '7d' | '30d';
    }>;

    expect(root.type).toBe(RunsPageContent);
    expect(root.props.activeRepositoryName).toBeNull();
    expect(root.props.activeWorkflowKey).toBeNull();
    expect(root.props.activeWindow).toBe('all');
  });
});
