// @vitest-environment jsdom

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DashboardRepositoryState, DashboardRunDetail } from '../../../src/server/dashboard-contracts';
import { RunDetailContent } from './run-detail-content';

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

type RunDetailOverrides = Omit<Partial<DashboardRunDetail>, 'run'> & Readonly<{
  run?: Partial<DashboardRunDetail['run']>;
}>;

function createRunDetail(overrides: RunDetailOverrides = {}): DashboardRunDetail {
  const defaultDiagnostics: DashboardRunDetail['diagnostics'][number] = {
    id: 10,
    runNodeId: 1,
    attempt: 1,
    outcome: 'completed',
    eventCount: 3,
    retainedEventCount: 3,
    droppedEventCount: 0,
    redacted: false,
    truncated: false,
    payloadChars: 512,
    createdAt: '2026-02-18T00:00:32.000Z',
    diagnostics: {
      schemaVersion: 1,
      workflowRunId: 412,
      runNodeId: 1,
      nodeKey: 'design',
      attempt: 1,
      outcome: 'completed',
      status: 'completed',
      provider: 'codex',
      timing: {
        queuedAt: '2026-02-18T00:00:00.000Z',
        startedAt: '2026-02-18T00:00:10.000Z',
        completedAt: '2026-02-18T00:00:30.000Z',
        failedAt: null,
        persistedAt: '2026-02-18T00:00:32.000Z',
      },
      summary: {
        tokensUsed: 42,
        eventCount: 3,
        retainedEventCount: 3,
        droppedEventCount: 0,
        toolEventCount: 1,
        redacted: false,
        truncated: false,
      },
      contextHandoff: {},
      eventTypeCounts: {
        system: 1,
        tool_use: 1,
        result: 1,
      },
      events: [
        {
          eventIndex: 0,
          type: 'system',
          timestamp: 100,
          contentChars: 5,
          contentPreview: 'start',
          metadata: null,
          usage: null,
        },
      ],
      toolEvents: [
        {
          eventIndex: 1,
          type: 'tool_use',
          timestamp: 101,
          toolName: 'search',
          summary: 'search()',
        },
      ],
      routingDecision: 'approved',
      error: null,
    },
  };
  const diagnostics = overrides.diagnostics ?? (overrides.nodes === undefined ? [defaultDiagnostics] : []);

  return {
    run: {
      id: 412,
      tree: {
        id: 1,
        treeKey: 'demo-tree',
        version: 1,
        name: 'Demo Tree',
      },
      repository: {
        id: 1,
        name: 'demo-repo',
      },
      status: 'running',
      startedAt: '2026-02-18T00:00:00.000Z',
      completedAt: null,
      createdAt: '2026-02-18T00:00:00.000Z',
      nodeSummary: {
        pending: 0,
        running: 1,
        completed: 1,
        failed: 0,
        skipped: 0,
        cancelled: 0,
      },
      ...overrides.run,
    },
    nodes: overrides.nodes ?? [
      {
        id: 1,
        treeNodeId: 1,
        nodeKey: 'design',
        sequenceIndex: 0,
        attempt: 1,
        status: 'completed',
        startedAt: '2026-02-18T00:00:10.000Z',
        completedAt: '2026-02-18T00:00:30.000Z',
        latestArtifact: null,
        latestRoutingDecision: null,
        latestDiagnostics: diagnostics[0] ?? null,
      },
      {
        id: 2,
        treeNodeId: 2,
        nodeKey: 'implement',
        sequenceIndex: 1,
        attempt: 1,
        status: 'running',
        startedAt: '2026-02-18T00:00:35.000Z',
        completedAt: null,
        latestArtifact: null,
        latestRoutingDecision: null,
        latestDiagnostics: null,
      },
    ],
    artifacts: overrides.artifacts ?? [
      {
        id: 1,
        runNodeId: 1,
        artifactType: 'report',
        contentType: 'markdown',
        contentPreview: 'Plan complete and ready for operator review.',
        createdAt: '2026-02-18T00:00:25.000Z',
      },
    ],
    routingDecisions: overrides.routingDecisions ?? [
      {
        id: 1,
        runNodeId: 1,
        decisionType: 'approved',
        rationale: 'All checks passed.',
        createdAt: '2026-02-18T00:00:31.000Z',
      },
    ],
    diagnostics,
    worktrees: overrides.worktrees ?? [
      {
        id: 5,
        runId: 412,
        repositoryId: 1,
        path: '/tmp/worktrees/demo-tree-412',
        branch: 'alphred/demo-tree/412',
        commitHash: null,
        status: 'active',
        createdAt: '2026-02-18T00:00:08.000Z',
        removedAt: null,
      },
    ],
  };
}

function createJsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json',
    },
  });
}

class MockEventSource {
  static instances: MockEventSource[] = [];

  readonly url: string;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  private listeners = new Map<string, ((event: MessageEvent<string>) => void)[]>();

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const handler =
      typeof listener === 'function'
        ? (listener as (event: MessageEvent<string>) => void)
        : ((event: MessageEvent<string>) => listener.handleEvent(event));
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(handler);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const listeners = this.listeners.get(type);
    if (!listeners) {
      return;
    }

    const handler =
      typeof listener === 'function'
        ? (listener as (event: MessageEvent<string>) => void)
        : ((event: MessageEvent<string>) => listener.handleEvent(event));
    const nextListeners = listeners.filter(existing => existing !== handler);
    this.listeners.set(type, nextListeners);
  }

  close(): void {
    return;
  }

  emitOpen(): void {
    this.onopen?.(new Event('open'));
  }

  emitError(): void {
    this.onerror?.(new Event('error'));
  }

  emit(type: string, payload: unknown): void {
    const listeners = this.listeners.get(type) ?? [];
    const event = new MessageEvent('message', {
      data: JSON.stringify(payload),
    });
    for (const listener of listeners) {
      listener(event);
    }
  }
}

describe('RunDetailContent realtime updates', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    MockEventSource.instances = [];
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('refreshes active run detail without a full page reload', async () => {
    const updated = createRunDetail({
      run: {
        status: 'paused',
      },
    });
    fetchMock.mockImplementation(() => Promise.resolve(createJsonResponse(updated)));

    render(
      <RunDetailContent
        initialDetail={createRunDetail()}
        repositories={[createRepository()]}
        pollIntervalMs={50}
      />,
    );

    expect(screen.getByRole('button', { name: 'Pause' })).toBeDisabled();

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/dashboard/runs/412',
        expect.objectContaining({ method: 'GET' }),
      );
    }, { timeout: 2_000 });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Resume' })).toBeDisabled();
    }, { timeout: 2_000 });

    expect(screen.getByText(/Live updates every 1s/)).toBeInTheDocument();
  });

  it('shows reconnect state after transient failure and recovers on retry', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('network down'))
      .mockImplementation(() => Promise.resolve(createJsonResponse(createRunDetail())));

    render(
      <RunDetailContent
        initialDetail={createRunDetail()}
        repositories={[createRepository()]}
        pollIntervalMs={50}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/Connection interrupted\. Retrying in/i)).toBeInTheDocument();
    }, { timeout: 2_000 });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    }, { timeout: 2_000 });

    await waitFor(() => {
      expect(screen.getByText(/Live updates every 1s/)).toBeInTheDocument();
    }, { timeout: 2_000 });
  });

  it('transitions to stale after prolonged reconnect failures', async () => {
    vi.useFakeTimers();
    fetchMock.mockRejectedValue(new Error('network down'));

    render(
      <RunDetailContent
        initialDetail={createRunDetail()}
        repositories={[createRepository()]}
        pollIntervalMs={1_000}
      />,
    );

    await vi.advanceTimersByTimeAsync(1_000);
    expect(screen.getByText(/Connection interrupted\. Retrying in/i)).toBeInTheDocument();

    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(4_000);
    await vi.advanceTimersByTimeAsync(8_000);
    await vi.advanceTimersByTimeAsync(8_000);

    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(screen.getByText(/Latest data is stale\. Reconnect attempt in/i)).toBeInTheDocument();
    expect(screen.getByText(/Update channel degraded: network down/i)).toBeInTheDocument();
  });

  it('degrades gracefully when realtime response omits required run fields', async () => {
    fetchMock.mockResolvedValue(
      createJsonResponse({
        run: {
          id: 412,
          status: 'running',
          repository: null,
          startedAt: '2026-02-18T00:00:00.000Z',
          completedAt: null,
          createdAt: '2026-02-18T00:00:00.000Z',
          nodeSummary: {
            pending: 0,
            running: 1,
            completed: 1,
            failed: 0,
            skipped: 0,
            cancelled: 0,
          },
        },
        nodes: [],
        artifacts: [],
        routingDecisions: [],
        worktrees: [],
      }),
    );

    render(
      <RunDetailContent
        initialDetail={createRunDetail()}
        repositories={[createRepository()]}
        pollIntervalMs={50}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/Connection interrupted\. Retrying in/i)).toBeInTheDocument();
    }, { timeout: 2_000 });

    await waitFor(() => {
      expect(screen.getByText(/Update channel degraded: Realtime run detail response was malformed\./i)).toBeInTheDocument();
    }, { timeout: 2_000 });
  });

  it('degrades gracefully when realtime response includes malformed node snapshots', async () => {
    fetchMock.mockResolvedValue(
      createJsonResponse({
        ...createRunDetail(),
        nodes: [{ id: 1 }],
      }),
    );

    render(
      <RunDetailContent
        initialDetail={createRunDetail()}
        repositories={[createRepository()]}
        pollIntervalMs={50}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/Connection interrupted\. Retrying in/i)).toBeInTheDocument();
    }, { timeout: 2_000 });

    await waitFor(() => {
      expect(screen.getByText(/Update channel degraded: Realtime run detail response was malformed\./i)).toBeInTheDocument();
    }, { timeout: 2_000 });
  });

  it('clears degraded warning when realtime is disabled after an error', async () => {
    const initialDetail = createRunDetail();
    fetchMock.mockRejectedValue(new Error('network down'));

    const { rerender } = render(
      <RunDetailContent
        initialDetail={initialDetail}
        repositories={[createRepository()]}
        pollIntervalMs={50}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/Update channel degraded: network down/i)).toBeInTheDocument();
    }, { timeout: 2_000 });

    rerender(
      <RunDetailContent
        initialDetail={initialDetail}
        repositories={[createRepository()]}
        enableRealtime={false}
        pollIntervalMs={50}
      />,
    );

    expect(screen.getByText(/Realtime updates are paused for this run state\./i)).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByText(/Update channel degraded:/i)).toBeNull();
    }, { timeout: 2_000 });
  });

  it('loads persisted agent stream history and buffers new events while auto-scroll is paused', async () => {
    vi.stubGlobal('EventSource', MockEventSource as unknown as typeof EventSource);
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/nodes/2/stream')) {
        return createJsonResponse({
          workflowRunId: 412,
          runNodeId: 2,
          attempt: 1,
          nodeStatus: 'running',
          ended: false,
          latestSequence: 1,
          events: [
            {
              id: 200,
              workflowRunId: 412,
              runNodeId: 2,
              attempt: 1,
              sequence: 1,
              type: 'system',
              timestamp: 100,
              contentChars: 11,
              contentPreview: 'seeded event',
              metadata: null,
              usage: null,
              createdAt: '2026-02-18T00:00:40.000Z',
            },
          ],
        });
      }

      return createJsonResponse(createRunDetail());
    });

    const user = userEvent.setup();

    render(
      <RunDetailContent
        initialDetail={createRunDetail()}
        repositories={[createRepository()]}
        enableRealtime={false}
      />,
    );

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/api/dashboard/runs/412/nodes/2/stream?attempt=1&lastEventSequence=0'),
        expect.objectContaining({ method: 'GET' }),
      );
    });

    await waitFor(() => {
      expect(MockEventSource.instances).toHaveLength(1);
    });

    const source = MockEventSource.instances[0]!;
    source.emitOpen();
    source.emit('stream_event', {
      id: 201,
      workflowRunId: 412,
      runNodeId: 2,
      attempt: 1,
      sequence: 2,
      type: 'assistant',
      timestamp: 101,
      contentChars: 9,
      contentPreview: 'phase two',
      metadata: null,
      usage: null,
      createdAt: '2026-02-18T00:00:41.000Z',
    });

    await waitFor(() => {
      expect(screen.getByText('phase two')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: 'Pause auto-scroll' }));

    source.emit('stream_event', {
      id: 202,
      workflowRunId: 412,
      runNodeId: 2,
      attempt: 1,
      sequence: 3,
      type: 'assistant',
      timestamp: 102,
      contentChars: 14,
      contentPreview: 'buffered update',
      metadata: null,
      usage: null,
      createdAt: '2026-02-18T00:00:42.000Z',
    });

    await waitFor(() => {
      expect(screen.getByText('1 new events buffered.')).toBeInTheDocument();
    });
    expect(screen.queryByText('buffered update')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Resume auto-scroll' }));

    await waitFor(() => {
      expect(screen.getByText('buffered update')).toBeInTheDocument();
    });
  });

  it('reconnects the agent stream after drops and transitions to ended on terminal event', async () => {
    vi.stubGlobal('EventSource', MockEventSource as unknown as typeof EventSource);
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/nodes/2/stream')) {
        return createJsonResponse({
          workflowRunId: 412,
          runNodeId: 2,
          attempt: 1,
          nodeStatus: 'running',
          ended: false,
          latestSequence: 0,
          events: [],
        });
      }

      return createJsonResponse(createRunDetail());
    });

    render(
      <RunDetailContent
        initialDetail={createRunDetail()}
        repositories={[createRepository()]}
        enableRealtime={false}
      />,
    );

    await waitFor(() => {
      expect(MockEventSource.instances).toHaveLength(1);
    });

    const firstSource = MockEventSource.instances[0]!;
    firstSource.emitOpen();
    firstSource.emitError();

    await waitFor(() => {
      expect(screen.getByText(/Agent stream connection interrupted\. Retrying in/i)).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(MockEventSource.instances).toHaveLength(2);
    }, { timeout: 2_500 });

    const secondSource = MockEventSource.instances[1]!;
    secondSource.emitOpen();
    secondSource.emit('stream_end', {
      connectionState: 'ended',
      nodeStatus: 'failed',
      latestSequence: 0,
    });

    await waitFor(() => {
      expect(screen.getByText('Ended')).toBeInTheDocument();
      expect(screen.getByText(/Node attempt reached terminal state; stream is closed\./i)).toBeInTheDocument();
    });
  });

  it('filters timeline events when selecting a node from the status panel', async () => {
    const user = userEvent.setup();

    render(
      <RunDetailContent
        initialDetail={createRunDetail()}
        repositories={[createRepository()]}
        enableRealtime={false}
      />,
    );

    expect(screen.getByText('implement started (attempt 1).')).toBeInTheDocument();

    await user.click(screen.getAllByRole('button', { name: 'design (attempt 1)' })[0]!);

    expect(screen.getByText('design completed.')).toBeInTheDocument();
    expect(screen.queryByText('implement started (attempt 1).')).toBeNull();
  });

  it('keeps timeline events visible when selecting an event from the timeline', async () => {
    const user = userEvent.setup();

    render(
      <RunDetailContent
        initialDetail={createRunDetail()}
        repositories={[createRepository()]}
        enableRealtime={false}
      />,
    );

    await user.click(screen.getByRole('button', { name: /design completed\./i }));

    expect(screen.getByText('design completed.')).toBeInTheDocument();
    expect(screen.getByText('implement started (attempt 1).')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'design (attempt 1)' })[0]!).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByText(/Filtered to design \(attempt 1\)\./i)).toBeNull();
  });

  it('keeps node filter button selected after clicking a run-level timeline event', async () => {
    const user = userEvent.setup();

    render(
      <RunDetailContent
        initialDetail={createRunDetail()}
        repositories={[createRepository()]}
        enableRealtime={false}
      />,
    );

    const designFilterButton = screen.getAllByRole('button', { name: 'design (attempt 1)' })[0]!;
    await user.click(designFilterButton);

    expect(screen.queryByText('implement started (attempt 1).')).toBeNull();
    expect(designFilterButton).toHaveAttribute('aria-pressed', 'true');

    await user.click(screen.getByRole('button', { name: /run started\./i }));

    expect(screen.queryByText('implement started (attempt 1).')).toBeNull();
    expect(screen.getByText(/Filtered to design \(attempt 1\)\./i)).toBeInTheDocument();
    expect(designFilterButton).toHaveAttribute('aria-pressed', 'true');
  });
});
