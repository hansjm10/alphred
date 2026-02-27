// @vitest-environment jsdom

import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DashboardRepositoryState,
  DashboardRunDetail,
  DashboardRunNodeStreamEvent,
} from '../../../../src/server/dashboard-contracts';
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

function createStreamEvent(
  overrides: Partial<DashboardRunNodeStreamEvent> & Pick<DashboardRunNodeStreamEvent, 'sequence'>,
): DashboardRunNodeStreamEvent {
  const sequence = overrides.sequence;

  return {
    id: overrides.id ?? sequence,
    workflowRunId: overrides.workflowRunId ?? 412,
    runNodeId: overrides.runNodeId ?? 2,
    attempt: overrides.attempt ?? 1,
    sequence,
    type: overrides.type ?? 'assistant',
    timestamp: overrides.timestamp ?? sequence,
    contentChars: overrides.contentChars ?? 12,
    contentPreview: overrides.contentPreview ?? `event ${sequence}`,
    metadata: overrides.metadata ?? null,
    usage: overrides.usage ?? null,
    createdAt: overrides.createdAt ?? '2026-02-18T00:00:40.000Z',
  };
}

function createControlResult(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    action: 'pause',
    outcome: 'applied',
    workflowRunId: 412,
    previousRunStatus: 'running',
    runStatus: 'paused',
    retriedRunNodeIds: [],
    ...overrides,
  };
}

function createFailedRunDetail(overrides: RunDetailOverrides = {}): DashboardRunDetail {
  const { run: runOverrides, ...detailOverrides } = overrides;

  return createRunDetail({
    run: {
      status: 'failed',
      completedAt: '2026-02-18T00:10:00.000Z',
      nodeSummary: {
        pending: 0,
        running: 0,
        completed: 0,
        failed: 1,
        skipped: 0,
        cancelled: 0,
      },
      ...runOverrides,
    },
    nodes: detailOverrides.nodes ?? [
      {
        id: 1,
        treeNodeId: 1,
        nodeKey: 'design',
        sequenceIndex: 0,
        attempt: 1,
        status: 'failed',
        startedAt: '2026-02-18T00:00:10.000Z',
        completedAt: '2026-02-18T00:01:00.000Z',
        latestArtifact: null,
        latestRoutingDecision: null,
        latestDiagnostics: null,
      },
    ],
    ...detailOverrides,
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

type IntersectionEntryOverrides = Readonly<{
  isIntersecting?: boolean;
  intersectionRatio?: number;
  top?: number;
}>;

class MockIntersectionObserver implements IntersectionObserver {
  static instances: MockIntersectionObserver[] = [];

  readonly callback: IntersectionObserverCallback;
  readonly root: Element | Document | null;
  readonly rootMargin: string;
  readonly thresholds: readonly number[];
  readonly observedElements = new Set<Element>();
  disconnected = false;

  constructor(callback: IntersectionObserverCallback, options: IntersectionObserverInit = {}) {
    this.callback = callback;
    this.root = options.root ?? null;
    this.rootMargin = options.rootMargin ?? '0px';
    if (Array.isArray(options.threshold)) {
      this.thresholds = options.threshold;
    } else if (typeof options.threshold === 'number') {
      this.thresholds = [options.threshold];
    } else {
      this.thresholds = [0];
    }
    MockIntersectionObserver.instances.push(this);
  }

  observe(target: Element): void {
    this.observedElements.add(target);
  }

  unobserve(target: Element): void {
    this.observedElements.delete(target);
  }

  disconnect(): void {
    this.disconnected = true;
    this.observedElements.clear();
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  emit(entries: IntersectionObserverEntry[]): void {
    this.callback(entries, this);
  }
}

function createIntersectionEntry(target: Element, overrides: IntersectionEntryOverrides = {}): IntersectionObserverEntry {
  const { isIntersecting = true, intersectionRatio = 1, top = 0 } = overrides;
  const rect = {
    x: 0,
    y: top,
    width: 120,
    height: 120,
    top,
    right: 120,
    bottom: top + 120,
    left: 0,
    toJSON: () => ({}),
  } as DOMRectReadOnly;

  return {
    time: 0,
    target,
    rootBounds: rect,
    boundingClientRect: rect,
    intersectionRect: rect,
    intersectionRatio,
    isIntersecting,
  };
}

function createMatchMediaMock(reducedMotionEnabled: boolean): (query: string) => MediaQueryList {
  return vi.fn().mockImplementation((query: string): MediaQueryList => ({
    matches: reducedMotionEnabled && query === '(prefers-reduced-motion: reduce)',
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

describe('RunDetailContent realtime updates', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    MockEventSource.instances = [];
    MockIntersectionObserver.instances = [];
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('does not emit hydration mismatch errors when server and client clocks differ by a second', async () => {
    vi.useFakeTimers();
    const detail = createRunDetail({
      run: {
        startedAt: '2026-02-24T04:06:05.000Z',
        createdAt: '2026-02-24T04:06:05.000Z',
      },
      nodes: [
        {
          id: 2,
          treeNodeId: 2,
          nodeKey: 'agent',
          sequenceIndex: 1,
          attempt: 1,
          status: 'running',
          startedAt: '2026-02-24T04:06:05.000Z',
          completedAt: null,
          latestArtifact: null,
          latestRoutingDecision: null,
          latestDiagnostics: null,
        },
      ],
    });

    vi.setSystemTime(new Date('2026-02-24T04:06:05.000Z'));
    const serverMarkup = renderToString(
      <RunDetailContent
        initialDetail={detail}
        repositories={[createRepository()]}
        enableRealtime={false}
      />,
    );

    vi.setSystemTime(new Date('2026-02-24T04:06:06.000Z'));
    const container = document.createElement('div');
    container.innerHTML = serverMarkup;
    document.body.appendChild(container);

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await act(async () => {
        hydrateRoot(
          container,
          <RunDetailContent
            initialDetail={detail}
            repositories={[createRepository()]}
            enableRealtime={false}
          />,
        );
      });

      const hydrationErrors = consoleErrorSpy.mock.calls.filter(([firstArg]) => {
        if (firstArg instanceof Error) {
          return firstArg.message.includes("Hydration failed because the server rendered text didn't match the client.");
        }

        return (
          typeof firstArg === 'string' &&
          firstArg.includes("Hydration failed because the server rendered text didn't match the client.")
        );
      });
      expect(hydrationErrors).toHaveLength(0);
    } finally {
      consoleErrorSpy.mockRestore();
      container.remove();
    }
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

    expect(screen.getByRole('button', { name: 'Pause' })).toBeEnabled();

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/dashboard/runs/412',
        expect.objectContaining({ method: 'GET' }),
      );
    }, { timeout: 2_000 });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Resume' })).toBeEnabled();
    }, { timeout: 2_000 });

    expect(screen.getByText(/Live updates every 1s/)).toBeInTheDocument();
  });

  it('keeps pending start disabled while exposing cancel for pending runs', () => {
    render(
      <RunDetailContent
        initialDetail={createRunDetail({
          run: {
            status: 'pending',
            startedAt: null,
            completedAt: null,
          },
        })}
        repositories={[createRepository()]}
        enableRealtime={false}
      />,
    );

    expect(screen.getByRole('button', { name: 'Pending Start' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel Run' })).toBeEnabled();
    expect(screen.getByText('Run has not started yet.')).toBeInTheDocument();
  });

  it('shows retry as the failed-run primary action', () => {
    render(
      <RunDetailContent
        initialDetail={createRunDetail({
          run: {
            status: 'failed',
            completedAt: '2026-02-18T00:10:00.000Z',
          },
          nodes: [
            {
              id: 1,
              treeNodeId: 1,
              nodeKey: 'design',
              sequenceIndex: 0,
              attempt: 1,
              status: 'failed',
              startedAt: '2026-02-18T00:00:10.000Z',
              completedAt: '2026-02-18T00:01:00.000Z',
              latestArtifact: null,
              latestRoutingDecision: null,
              latestDiagnostics: null,
            },
          ],
        })}
        repositories={[createRepository()]}
        enableRealtime={false}
      />,
    );

    expect(screen.getByRole('button', { name: 'Retry Failed Node' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Cancel Run' })).toBeNull();
  });

  it('applies pause control, refreshes detail, and shows in-flight and success feedback', async () => {
    const pausedDetail = createRunDetail({
      run: {
        status: 'paused',
      },
    });
    let resolvePauseActionResponse!: (response: Response) => void;
    const pauseActionResponse = new Promise<Response>((resolve) => {
      resolvePauseActionResponse = resolve;
    });

    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      if (url === '/api/dashboard/runs/412/actions/pause' && init?.method === 'POST') {
        return pauseActionResponse;
      }

      if (url === '/api/dashboard/runs/412' && init?.method === 'GET') {
        return Promise.resolve(createJsonResponse(pausedDetail));
      }

      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });

    render(
      <RunDetailContent
        initialDetail={createRunDetail()}
        repositories={[createRepository()]}
        enableRealtime={false}
      />,
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Pause' }));

    expect(screen.getByRole('button', { name: 'Pause...' })).toBeDisabled();
    expect(screen.getByText('Applying pause action...')).toBeInTheDocument();

    resolvePauseActionResponse(createJsonResponse(createControlResult()));

    await waitFor(() => {
      expect(screen.getByText('Run paused.')).toBeInTheDocument();
    }, { timeout: 2_000 });
    const successFeedback = screen.getByText('Run paused.');
    expect(successFeedback).toHaveClass('run-action-feedback', 'run-action-feedback--success');
    expect(successFeedback).not.toHaveClass('meta-text');

    expect(screen.getByRole('button', { name: 'Resume' })).toBeEnabled();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/dashboard/runs/412/actions/pause',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/dashboard/runs/412',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('surfaces lifecycle control API errors and leaves controls actionable', async () => {
    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      if (url === '/api/dashboard/runs/412/actions/pause' && init?.method === 'POST') {
        return Promise.resolve(
          createJsonResponse(
            {
              error: {
                message:
                  'Cannot pause workflow run id=412 from status "completed". Expected status "running".',
              },
            },
            409,
          ),
        );
      }

      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });

    render(
      <RunDetailContent
        initialDetail={createRunDetail()}
        repositories={[createRepository()]}
        enableRealtime={false}
      />,
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Pause' }));

    await waitFor(() => {
      expect(
        screen.getByText(
          'Cannot pause workflow run id=412 from status "completed". Expected status "running".',
        ),
      ).toBeInTheDocument();
    }, { timeout: 2_000 });
    const errorFeedback = screen.getByText(
      'Cannot pause workflow run id=412 from status "completed". Expected status "running".',
    );
    expect(errorFeedback).toHaveClass('run-action-feedback', 'run-action-feedback--error');
    expect(errorFeedback).not.toHaveClass('meta-text');

    expect(screen.getByRole('button', { name: 'Pause' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Cancel Run' })).toBeEnabled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('restarts realtime polling when retry succeeds but immediate refresh fails', async () => {
    const failedDetail = createRunDetail({
      run: {
        status: 'failed',
        completedAt: '2026-02-18T00:10:00.000Z',
        nodeSummary: {
          pending: 0,
          running: 0,
          completed: 0,
          failed: 1,
          skipped: 0,
          cancelled: 0,
        },
      },
      nodes: [
        {
          id: 1,
          treeNodeId: 1,
          nodeKey: 'design',
          sequenceIndex: 0,
          attempt: 1,
          status: 'failed',
          startedAt: '2026-02-18T00:00:10.000Z',
          completedAt: '2026-02-18T00:01:00.000Z',
          latestArtifact: null,
          latestRoutingDecision: null,
          latestDiagnostics: null,
        },
      ],
    });
    const resumedDetail = createRunDetail({
      run: {
        status: 'running',
        completedAt: null,
      },
      nodes: [
        {
          id: 1,
          treeNodeId: 1,
          nodeKey: 'design',
          sequenceIndex: 0,
          attempt: 2,
          status: 'running',
          startedAt: '2026-02-18T00:10:05.000Z',
          completedAt: null,
          latestArtifact: null,
          latestRoutingDecision: null,
          latestDiagnostics: null,
        },
      ],
    });
    let detailFetchCount = 0;

    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      if (url === '/api/dashboard/runs/412/actions/retry' && init?.method === 'POST') {
        return Promise.resolve(
          createJsonResponse(
            createControlResult({
              action: 'retry',
              previousRunStatus: 'failed',
              runStatus: 'running',
              retriedRunNodeIds: [1],
            }),
          ),
        );
      }

      if (url === '/api/dashboard/runs/412' && init?.method === 'GET') {
        detailFetchCount += 1;
        if (detailFetchCount === 1) {
          return Promise.reject(new Error('refresh down'));
        }

        return Promise.resolve(createJsonResponse(resumedDetail));
      }

      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });

    render(
      <RunDetailContent
        initialDetail={failedDetail}
        repositories={[createRepository()]}
        pollIntervalMs={50}
      />,
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Retry Failed Node' }));

    await waitFor(() => {
      expect(screen.getByText(/Unable to refresh run timeline: refresh down/i)).toBeInTheDocument();
    }, { timeout: 2_000 });

    await waitFor(() => {
      expect(detailFetchCount).toBeGreaterThan(1);
    }, { timeout: 2_000 });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Pause' })).toBeEnabled();
    }, { timeout: 2_000 });
  });

  it.each([
    {
      name: 'cancel applied',
      action: 'cancel',
      actionButton: 'Cancel Run',
      initialDetail: () => createRunDetail(),
      controlResult: createControlResult({
        action: 'cancel',
        outcome: 'applied',
        previousRunStatus: 'running',
        runStatus: 'cancelled',
      }),
      refreshedDetail: () => createRunDetail({
        run: {
          status: 'cancelled',
          completedAt: '2026-02-18T00:15:00.000Z',
        },
      }),
      expectedMessage: 'Run cancelled.',
      expectedPrimaryAction: 'Run Cancelled',
    },
    {
      name: 'cancel noop',
      action: 'cancel',
      actionButton: 'Cancel Run',
      initialDetail: () => createRunDetail(),
      controlResult: createControlResult({
        action: 'cancel',
        outcome: 'noop',
        previousRunStatus: 'running',
        runStatus: 'cancelled',
      }),
      refreshedDetail: () => createRunDetail({
        run: {
          status: 'cancelled',
          completedAt: '2026-02-18T00:15:00.000Z',
        },
      }),
      expectedMessage: 'Run is already cancelled.',
      expectedPrimaryAction: 'Run Cancelled',
    },
    {
      name: 'resume applied',
      action: 'resume',
      actionButton: 'Resume',
      initialDetail: () => createRunDetail({
        run: {
          status: 'paused',
        },
      }),
      controlResult: createControlResult({
        action: 'resume',
        outcome: 'applied',
        previousRunStatus: 'paused',
        runStatus: 'running',
      }),
      refreshedDetail: () => createRunDetail({
        run: {
          status: 'running',
        },
      }),
      expectedMessage: 'Run resumed.',
      expectedPrimaryAction: 'Pause',
    },
    {
      name: 'resume noop',
      action: 'resume',
      actionButton: 'Resume',
      initialDetail: () => createRunDetail({
        run: {
          status: 'paused',
        },
      }),
      controlResult: createControlResult({
        action: 'resume',
        outcome: 'noop',
        previousRunStatus: 'paused',
        runStatus: 'running',
      }),
      refreshedDetail: () => createRunDetail({
        run: {
          status: 'running',
        },
      }),
      expectedMessage: 'Run is already running.',
      expectedPrimaryAction: 'Pause',
    },
    {
      name: 'pause noop',
      action: 'pause',
      actionButton: 'Pause',
      initialDetail: () => createRunDetail(),
      controlResult: createControlResult({
        action: 'pause',
        outcome: 'noop',
        previousRunStatus: 'running',
        runStatus: 'paused',
      }),
      refreshedDetail: () => createRunDetail({
        run: {
          status: 'paused',
        },
      }),
      expectedMessage: 'Run is already paused.',
      expectedPrimaryAction: 'Resume',
    },
    {
      name: 'retry applied with empty retry list',
      action: 'retry',
      actionButton: 'Retry Failed Node',
      initialDetail: () => createFailedRunDetail(),
      controlResult: createControlResult({
        action: 'retry',
        outcome: 'applied',
        previousRunStatus: 'failed',
        runStatus: 'running',
        retriedRunNodeIds: [],
      }),
      refreshedDetail: () => createRunDetail({
        run: {
          status: 'running',
          completedAt: null,
        },
      }),
      expectedMessage: 'Retry queued for failed nodes.',
      expectedPrimaryAction: 'Pause',
    },
    {
      name: 'retry noop',
      action: 'retry',
      actionButton: 'Retry Failed Node',
      initialDetail: () => createFailedRunDetail(),
      controlResult: createControlResult({
        action: 'retry',
        outcome: 'noop',
        previousRunStatus: 'failed',
        runStatus: 'failed',
        retriedRunNodeIds: [],
      }),
      refreshedDetail: () => createFailedRunDetail(),
      expectedMessage: 'No retryable failed nodes were queued.',
      expectedPrimaryAction: 'Retry Failed Node',
    },
  ])('handles $name control feedback', async ({ action, actionButton, controlResult, expectedMessage, refreshedDetail, initialDetail, expectedPrimaryAction }) => {
    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      if (url === `/api/dashboard/runs/412/actions/${action}` && init?.method === 'POST') {
        return Promise.resolve(createJsonResponse(controlResult));
      }

      if (url === '/api/dashboard/runs/412' && init?.method === 'GET') {
        return Promise.resolve(createJsonResponse(refreshedDetail()));
      }

      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });

    render(
      <RunDetailContent
        initialDetail={initialDetail()}
        repositories={[createRepository()]}
        enableRealtime={false}
      />,
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: actionButton }));

    await waitFor(() => {
      expect(screen.getByText(expectedMessage)).toBeInTheDocument();
    }, { timeout: 2_000 });

    const feedback = screen.getByText(expectedMessage);
    expect(feedback).toHaveClass('run-action-feedback', 'run-action-feedback--success');
    expect(screen.getByRole('button', { name: expectedPrimaryAction })).toBeInTheDocument();
  });

  it.each([
    {
      name: 'cancel',
      action: 'cancel',
      actionButton: 'Cancel Run',
      initialDetail: () => createRunDetail(),
      expectedPrefix: 'Unable to cancel run',
    },
    {
      name: 'resume',
      action: 'resume',
      actionButton: 'Resume',
      initialDetail: () => createRunDetail({
        run: {
          status: 'paused',
        },
      }),
      expectedPrefix: 'Unable to resume run',
    },
    {
      name: 'retry',
      action: 'retry',
      actionButton: 'Retry Failed Node',
      initialDetail: () => createFailedRunDetail(),
      expectedPrefix: 'Unable to retry failed node',
    },
  ])('uses stable API error fallback messaging for $name control failures', async ({ action, actionButton, initialDetail, expectedPrefix }) => {
    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      if (url === `/api/dashboard/runs/412/actions/${action}` && init?.method === 'POST') {
        return Promise.resolve(createJsonResponse({}, 500));
      }

      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });

    render(
      <RunDetailContent
        initialDetail={initialDetail()}
        repositories={[createRepository()]}
        enableRealtime={false}
      />,
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: actionButton }));

    await waitFor(() => {
      expect(screen.getByText(`${expectedPrefix} (HTTP 500).`)).toBeInTheDocument();
    }, { timeout: 2_000 });
    expect(screen.getByRole('button', { name: actionButton })).toBeEnabled();
  });

  it.each([
    {
      name: 'invalid object payload',
      payload: createControlResult({
        runStatus: 'mystery',
      }),
    },
    {
      name: 'non-object payload',
      payload: null,
    },
  ])('reports malformed control responses for $name', async ({ payload }) => {
    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      if (url === '/api/dashboard/runs/412/actions/pause' && init?.method === 'POST') {
        return Promise.resolve(createJsonResponse(payload));
      }

      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });

    render(
      <RunDetailContent
        initialDetail={createRunDetail()}
        repositories={[createRepository()]}
        enableRealtime={false}
      />,
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Pause' }));

    await waitFor(() => {
      expect(screen.getByText('Run action response was malformed.')).toBeInTheDocument();
    }, { timeout: 2_000 });
    expect(screen.getByRole('button', { name: 'Pause' })).toBeEnabled();
  });

  it('surfaces refresh HTTP errors after a successful lifecycle control action', async () => {
    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      if (url === '/api/dashboard/runs/412/actions/pause' && init?.method === 'POST') {
        return Promise.resolve(createJsonResponse(createControlResult()));
      }

      if (url === '/api/dashboard/runs/412' && init?.method === 'GET') {
        return Promise.resolve(createJsonResponse({}, 503));
      }

      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });

    render(
      <RunDetailContent
        initialDetail={createRunDetail()}
        repositories={[createRepository()]}
        enableRealtime={false}
      />,
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Pause' }));

    await waitFor(() => {
      expect(
        screen.getByText(
          'Run paused. Unable to refresh run timeline: Unable to refresh run timeline (HTTP 503).',
        ),
      ).toBeInTheDocument();
    }, { timeout: 2_000 });
    expect(screen.getByRole('button', { name: 'Resume' })).toBeEnabled();
  });

  it('clears action feedback when realtime updates move run status past that feedback state', async () => {
    const pausedDetail = createRunDetail({
      run: {
        status: 'paused',
      },
    });
    const runningDetail = createRunDetail({
      run: {
        status: 'running',
      },
    });
    let detailFetchCount = 0;

    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      if (url === '/api/dashboard/runs/412/actions/pause' && init?.method === 'POST') {
        return Promise.resolve(createJsonResponse(createControlResult()));
      }

      if (url === '/api/dashboard/runs/412' && init?.method === 'GET') {
        detailFetchCount += 1;
        return Promise.resolve(createJsonResponse(detailFetchCount === 1 ? pausedDetail : runningDetail));
      }

      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });

    render(
      <RunDetailContent
        initialDetail={createRunDetail()}
        repositories={[createRepository()]}
        pollIntervalMs={1_000}
      />,
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Pause' }));

    await waitFor(() => {
      expect(screen.getByText('Run paused.')).toBeInTheDocument();
    }, { timeout: 2_000 });

    await waitFor(() => {
      expect(detailFetchCount).toBeGreaterThan(1);
    }, { timeout: 2_000 });
    await waitFor(() => {
      expect(screen.queryByText('Run paused.')).toBeNull();
    }, { timeout: 2_000 });
    expect(screen.getByRole('button', { name: 'Pause' })).toBeEnabled();
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
    source.emit('stream_state', {
      connectionState: 'live',
      nodeStatus: 'running',
      latestSequence: 2,
    });
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
      metadata: {
        approvalPolicy: 'on-request',
        sandboxMode: 'workspace-write',
      },
      usage: null,
      createdAt: '2026-02-18T00:00:41.000Z',
    });

    await waitFor(() => {
      expect(screen.getByText('phase two')).toBeInTheDocument();
    });
    await user.click(screen.getByText('metadata'));
    expect(screen.getByText(/workspace-write/)).toBeInTheDocument();

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

  it('deduplicates persisted stream snapshot events by sequence and keeps the latest entry', async () => {
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
          latestSequence: 2,
          events: [
            createStreamEvent({
              id: 300,
              sequence: 1,
              contentPreview: 'duplicate original',
            }),
            createStreamEvent({
              id: 301,
              sequence: 1,
              contentPreview: 'duplicate replacement',
            }),
            createStreamEvent({
              id: 302,
              sequence: 2,
              contentPreview: 'unique second event',
            }),
          ],
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
      expect(screen.getByText('duplicate replacement')).toBeInTheDocument();
    });

    expect(screen.queryByText('duplicate original')).toBeNull();
    expect(screen.getAllByText('duplicate replacement')).toHaveLength(1);
    expect(screen.getAllByText('unique second event')).toHaveLength(1);
  });

  it('does not restart stream when selecting the active node in the status panel', async () => {
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
            createStreamEvent({
              sequence: 1,
              contentPreview: 'seeded event',
            }),
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

    await user.click(screen.getByRole('button', { name: 'Pause auto-scroll' }));
    source.emit('stream_event', createStreamEvent({ sequence: 2, contentPreview: 'buffered update' }));

    await waitFor(() => {
      expect(screen.getByText('1 new events buffered.')).toBeInTheDocument();
    });
    expect(screen.queryByText('buffered update')).toBeNull();

    const nodeStatusPanel = screen.getByRole('heading', { level: 3, name: 'Node status' }).closest('aside');
    expect(nodeStatusPanel).not.toBeNull();
    const streamCallsBeforeClick = fetchMock.mock.calls.filter(([input]) => String(input).includes('/nodes/2/stream')).length;
    const streamConnectionsBeforeClick = MockEventSource.instances.length;
    await user.click(within(nodeStatusPanel!).getByRole('button', { name: 'implement (attempt 1)' }));

    expect(screen.getByText('1 new events buffered.')).toBeInTheDocument();
    expect(screen.queryByText('buffered update')).toBeNull();
    expect(MockEventSource.instances).toHaveLength(streamConnectionsBeforeClick);

    const streamCallsAfterClick = fetchMock.mock.calls.filter(([input]) => String(input).includes('/nodes/2/stream')).length;
    expect(streamCallsAfterClick).toBe(streamCallsBeforeClick);
  });

  it('clears agent stream target when selecting a non-streamable node in the status panel', async () => {
    vi.stubGlobal('EventSource', MockEventSource as unknown as typeof EventSource);
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/nodes/1/stream')) {
        return createJsonResponse({
          workflowRunId: 412,
          runNodeId: 1,
          attempt: 1,
          nodeStatus: 'completed',
          ended: true,
          latestSequence: 0,
          events: [],
        });
      }
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

    const user = userEvent.setup();

    render(
      <RunDetailContent
        initialDetail={createRunDetail({
          run: {
            nodeSummary: {
              pending: 1,
              running: 1,
              completed: 1,
              failed: 0,
              skipped: 0,
              cancelled: 0,
            },
          },
          nodes: [
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
              latestDiagnostics: null,
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
            {
              id: 3,
              treeNodeId: 3,
              nodeKey: 'review',
              sequenceIndex: 2,
              attempt: 1,
              status: 'pending',
              startedAt: null,
              completedAt: null,
              latestArtifact: null,
              latestRoutingDecision: null,
              latestDiagnostics: null,
            },
          ],
        })}
        repositories={[createRepository()]}
        enableRealtime={false}
      />,
    );

    const nodeStatusPanel = screen.getByRole('heading', { level: 3, name: 'Node status' }).closest('aside');
    expect(nodeStatusPanel).not.toBeNull();

    await user.click(within(nodeStatusPanel!).getByRole('button', { name: 'design (attempt 1)' }));

    await waitFor(() => {
      expect(screen.getByText(/Node design \(attempt 1\)/i)).toBeInTheDocument();
    });

    await user.click(within(nodeStatusPanel!).getByRole('button', { name: 'review (attempt 1)' }));

    await waitFor(() => {
      expect(screen.getByText('Select a node from Node Status to open its agent stream.')).toBeInTheDocument();
    });
    expect(screen.queryByText(/Node design \(attempt 1\)/i)).toBeNull();

    const pendingNodeStreamCalls = fetchMock.mock.calls.filter(([input]) => String(input).includes('/nodes/3/stream'));
    expect(pendingNodeStreamCalls).toHaveLength(0);
  });

  it('paginates ended stream snapshots until persisted history is fully loaded', async () => {
    vi.stubGlobal('EventSource', MockEventSource as unknown as typeof EventSource);
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/nodes/2/stream')) {
        const parsed = new URL(url, 'http://localhost');
        const lastEventSequence = Number(parsed.searchParams.get('lastEventSequence') ?? '0');

        if (lastEventSequence === 0) {
          return createJsonResponse({
            workflowRunId: 412,
            runNodeId: 2,
            attempt: 1,
            nodeStatus: 'completed',
            ended: true,
            latestSequence: 3,
            events: [
              createStreamEvent({
                sequence: 1,
                contentPreview: 'seeded event',
              }),
            ],
          });
        }

        if (lastEventSequence === 1) {
          return createJsonResponse({
            workflowRunId: 412,
            runNodeId: 2,
            attempt: 1,
            nodeStatus: 'completed',
            ended: true,
            latestSequence: 3,
            events: [
              createStreamEvent({
                sequence: 2,
                contentPreview: 'second page one',
              }),
              createStreamEvent({
                sequence: 3,
                contentPreview: 'second page two',
              }),
            ],
          });
        }

        return createJsonResponse({
          workflowRunId: 412,
          runNodeId: 2,
          attempt: 1,
          nodeStatus: 'completed',
          ended: true,
          latestSequence: 3,
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
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/api/dashboard/runs/412/nodes/2/stream?attempt=1&lastEventSequence=0'),
        expect.objectContaining({ method: 'GET' }),
      );
    });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/api/dashboard/runs/412/nodes/2/stream?attempt=1&lastEventSequence=1'),
        expect.objectContaining({ method: 'GET' }),
      );
    });

    await waitFor(() => {
      expect(screen.getByText('seeded event')).toBeInTheDocument();
      expect(screen.getByText('second page one')).toBeInTheDocument();
      expect(screen.getByText('second page two')).toBeInTheDocument();
    });

    expect(MockEventSource.instances).toHaveLength(0);
  });

  it('resumes SSE from the last loaded snapshot event when latestSequence is ahead', async () => {
    vi.stubGlobal('EventSource', MockEventSource as unknown as typeof EventSource);
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/nodes/2/stream')) {
        const parsed = new URL(url, 'http://localhost');
        const lastEventSequence = Number(parsed.searchParams.get('lastEventSequence') ?? '0');

        if (lastEventSequence === 0) {
          return createJsonResponse({
            workflowRunId: 412,
            runNodeId: 2,
            attempt: 1,
            nodeStatus: 'running',
            ended: false,
            latestSequence: 2,
            events: [
              createStreamEvent({
                sequence: 1,
                contentPreview: 'first page',
              }),
            ],
          });
        }

        return createJsonResponse({
          workflowRunId: 412,
          runNodeId: 2,
          attempt: 1,
          nodeStatus: 'running',
          ended: false,
          latestSequence: 2,
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
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/api/dashboard/runs/412/nodes/2/stream?attempt=1&lastEventSequence=1'),
        expect.objectContaining({ method: 'GET' }),
      );
    });

    await waitFor(() => {
      expect(MockEventSource.instances).toHaveLength(1);
    });

    expect(MockEventSource.instances[0]?.url).toContain('lastEventSequence=1');
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

    const timeline = screen.getByRole('list', { name: 'Run timeline' });
    expect(within(timeline).getByText('implement started (attempt 1).')).toBeInTheDocument();

    await user.click(screen.getAllByRole('button', { name: 'design (attempt 1)' })[0]!);

    expect(within(timeline).getByText('design completed.')).toBeInTheDocument();
    expect(within(timeline).queryByText('implement started (attempt 1).')).toBeNull();
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

    const timeline = screen.getByRole('list', { name: 'Run timeline' });
    await user.click(within(timeline).getByRole('button', { name: /design completed\./i }));

    expect(within(timeline).getByText('design completed.')).toBeInTheDocument();
    expect(within(timeline).getByText('implement started (attempt 1).')).toBeInTheDocument();
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

    const timeline = screen.getByRole('list', { name: 'Run timeline' });
    const designFilterButton = screen.getAllByRole('button', { name: 'design (attempt 1)' })[0]!;
    await user.click(designFilterButton);

    expect(within(timeline).queryByText('implement started (attempt 1).')).toBeNull();
    expect(designFilterButton).toHaveAttribute('aria-pressed', 'true');

    await user.click(within(timeline).getByRole('button', { name: /run started\./i }));

    expect(within(timeline).queryByText('implement started (attempt 1).')).toBeNull();
    expect(screen.getByText(/Filtered to design \(attempt 1\)\./i)).toBeInTheDocument();
    expect(designFilterButton).toHaveAttribute('aria-pressed', 'true');
  });

  it('renders section jump nav links with heading targets and default active state', () => {
    render(
      <RunDetailContent
        initialDetail={createRunDetail()}
        repositories={[createRepository()]}
        enableRealtime={false}
      />,
    );

    const sectionNav = screen.getByRole('navigation', { name: 'Run detail sections' });
    const expectedSectionLinks = [
      ['Focus', '#run-detail-operator-focus-heading'],
      ['Timeline', '#run-detail-timeline-heading'],
      ['Stream', '#run-detail-stream-heading'],
      ['Observability', '#run-detail-observability-heading'],
    ] as const;

    for (const [label, hash] of expectedSectionLinks) {
      const link = within(sectionNav).getByRole('link', { name: label });
      expect(link).toHaveAttribute('href', hash);
      expect(document.getElementById(hash.slice(1))).toBeTruthy();
    }

    const focusLink = within(sectionNav).getByRole('link', { name: 'Focus' });
    const timelineLink = within(sectionNav).getByRole('link', { name: 'Timeline' });
    const streamLink = within(sectionNav).getByRole('link', { name: 'Stream' });
    const observabilityLink = within(sectionNav).getByRole('link', { name: 'Observability' });
    expect(focusLink).toHaveAttribute('aria-current', 'location');
    expect(timelineLink).not.toHaveAttribute('aria-current');
    expect(streamLink).not.toHaveAttribute('aria-current');
    expect(observabilityLink).not.toHaveAttribute('aria-current');

    const expectedSectionContainers = [
      ['run-detail-operator-focus-section', 'run-detail-operator-focus-heading'],
      ['run-detail-timeline-section', 'run-detail-timeline-heading'],
      ['run-detail-stream-section', 'run-detail-stream-heading'],
      ['run-detail-observability-section', 'run-detail-observability-heading'],
    ] as const;
    for (const [sectionId, headingId] of expectedSectionContainers) {
      expect(document.getElementById(sectionId)).toHaveAttribute('aria-labelledby', headingId);
    }
  });

  it('updates jump-nav active section from deterministic intersection observer entries', () => {
    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver as unknown as typeof IntersectionObserver);

    render(
      <RunDetailContent
        initialDetail={createRunDetail()}
        repositories={[createRepository()]}
        enableRealtime={false}
      />,
    );

    expect(MockIntersectionObserver.instances).toHaveLength(1);
    const sectionObserver = MockIntersectionObserver.instances[0]!;
    expect(sectionObserver.observedElements.size).toBe(4);

    const sectionNav = screen.getByRole('navigation', { name: 'Run detail sections' });
    const focusLink = within(sectionNav).getByRole('link', { name: 'Focus' });
    const timelineLink = within(sectionNav).getByRole('link', { name: 'Timeline' });
    expect(focusLink).toHaveAttribute('aria-current', 'location');

    const focusSection = document.getElementById('run-detail-operator-focus-section');
    const timelineSection = document.getElementById('run-detail-timeline-section');
    expect(focusSection).toBeTruthy();
    expect(timelineSection).toBeTruthy();

    act(() => {
      sectionObserver.emit([
        createIntersectionEntry(focusSection!, {
          isIntersecting: true,
          intersectionRatio: 0.2,
          top: 0,
        }),
        createIntersectionEntry(timelineSection!, {
          isIntersecting: true,
          intersectionRatio: 0.7,
          top: 96,
        }),
      ]);
    });

    expect(timelineLink).toHaveAttribute('aria-current', 'location');
    expect(focusLink).not.toHaveAttribute('aria-current');
  });

  it('uses auto scroll behavior for jump-nav anchors when reduced motion is preferred', async () => {
    vi.stubGlobal('matchMedia', createMatchMediaMock(true));
    const user = userEvent.setup();

    render(
      <RunDetailContent
        initialDetail={createRunDetail()}
        repositories={[createRepository()]}
        enableRealtime={false}
      />,
    );

    const timelineHeading = document.getElementById('run-detail-timeline-heading');
    expect(timelineHeading).toBeTruthy();

    const scrollIntoViewMock = vi.fn();
    Object.defineProperty(timelineHeading!, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoViewMock,
    });

    const sectionNav = screen.getByRole('navigation', { name: 'Run detail sections' });
    await user.click(within(sectionNav).getByRole('link', { name: 'Timeline' }));

    expect(window.location.hash).toBe('#run-detail-timeline-heading');
    expect(scrollIntoViewMock).toHaveBeenCalledWith({
      behavior: 'auto',
      block: 'start',
    });
    expect(within(sectionNav).getByRole('link', { name: 'Timeline' })).toHaveAttribute('aria-current', 'location');
  });

  it('uses a non-stretch lifecycle grid for timeline and node status panels', () => {
    render(
      <RunDetailContent
        initialDetail={createRunDetail()}
        repositories={[createRepository()]}
        enableRealtime={false}
      />,
    );

    const timelineHeading = screen.getByRole('heading', { level: 3, name: 'Timeline' });
    const lifecycleGrid = timelineHeading.closest('.page-grid');

    expect(lifecycleGrid).not.toBeNull();
    expect(lifecycleGrid).toHaveClass('run-detail-lifecycle-grid');
  });

  it('adds an expand affordance for long artifact previews', async () => {
    const user = userEvent.setup();
    const longArtifact = `Artifact summary ${'x'.repeat(280)}`;

    render(
      <RunDetailContent
        initialDetail={createRunDetail({
          artifacts: [
            {
              id: 1,
              runNodeId: 1,
              artifactType: 'report',
              contentType: 'markdown',
              contentPreview: longArtifact,
              createdAt: '2026-02-18T00:00:25.000Z',
            },
          ],
        })}
        repositories={[createRepository()]}
        enableRealtime={false}
      />,
    );

    const toggle = screen.getByText('Show full artifact preview');
    const details = toggle.closest('details');

    expect(details).not.toHaveAttribute('open');
    await user.click(toggle);
    expect(details).toHaveAttribute('open');
    expect(details).toHaveTextContent(longArtifact);
  });

  it('adds an expand affordance for long stream event payloads', async () => {
    vi.stubGlobal('EventSource', MockEventSource as unknown as typeof EventSource);
    const user = userEvent.setup();
    const longStreamPayload = `stream payload ${'payload '.repeat(60)}`;

    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/nodes/2/stream')) {
        return createJsonResponse({
          workflowRunId: 412,
          runNodeId: 2,
          attempt: 1,
          nodeStatus: 'completed',
          ended: true,
          latestSequence: 1,
          events: [
            createStreamEvent({
              sequence: 1,
              contentPreview: longStreamPayload,
            }),
          ],
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
      expect(screen.getByText('Show full event payload')).toBeInTheDocument();
    });

    const toggle = screen.getByText('Show full event payload');
    const details = toggle.closest('details');
    expect(details).not.toHaveAttribute('open');

    await user.click(toggle);
    expect(details).toHaveAttribute('open');
    expect(details).toHaveTextContent(longStreamPayload.trim());
  });

  it('surfaces operator focus with current status, latest event, and next action', () => {
    render(
      <RunDetailContent
        initialDetail={createRunDetail()}
        repositories={[createRepository()]}
        enableRealtime={false}
      />,
    );

    const focusHeading = screen.getByRole('heading', { level: 3, name: 'Operator focus' });
    const focusCard = focusHeading.closest('section');

    expect(focusCard).not.toBeNull();
    expect(within(focusCard!).getByText('Current status')).toBeInTheDocument();
    expect(within(focusCard!).getByText('Latest event')).toBeInTheDocument();
    expect(within(focusCard!).getByText('Next action')).toBeInTheDocument();
    expect(within(focusCard!).getByRole('button', { name: 'Pause' })).toBeEnabled();
    expect(within(focusCard!).getByRole('button', { name: 'Cancel Run' })).toBeEnabled();
    expect(within(focusCard!).getByText(/implement started \(attempt 1\)\./i)).toBeInTheDocument();
  });

  it('collapses earlier timeline entries behind disclosure when the timeline is long', () => {
    const nodes = Array.from({ length: 6 }, (_, index) => {
      const minuteOffset = index + 1;
      const startedAt = `2026-02-18T00:${String(minuteOffset).padStart(2, '0')}:00.000Z`;
      const completedAt = `2026-02-18T00:${String(minuteOffset).padStart(2, '0')}:30.000Z`;

      return {
        id: index + 1,
        treeNodeId: index + 1,
        nodeKey: `phase-${index + 1}`,
        sequenceIndex: index,
        attempt: 1,
        status: 'completed' as const,
        startedAt,
        completedAt,
        latestArtifact: null,
        latestRoutingDecision: null,
        latestDiagnostics: null,
      };
    });

    render(
      <RunDetailContent
        initialDetail={createRunDetail({
          run: {
            status: 'completed',
            completedAt: '2026-02-18T00:07:00.000Z',
          },
          nodes,
          artifacts: [],
          routingDecisions: [],
          diagnostics: [],
        })}
        repositories={[createRepository()]}
        enableRealtime={false}
      />,
    );

    const timelineDisclosure = screen.getByText('Show 6 earlier events');
    const timelineDisclosureDetails = timelineDisclosure.closest('details');

    expect(timelineDisclosure).toBeInTheDocument();
    expect(timelineDisclosureDetails).not.toHaveAttribute('open');
  });

  it('collapses older observability entries behind disclosure while keeping newest snapshots visible', () => {
    const baseDetail = createRunDetail();
    const baseDiagnostics = baseDetail.diagnostics[0]!;
    const diagnostics = Array.from({ length: 4 }, (_, index) => {
      const attempt = index + 1;
      return {
        ...baseDiagnostics,
        id: 20 + attempt,
        attempt,
        createdAt: `2026-02-18T00:0${attempt}:32.000Z`,
        diagnostics: {
          ...baseDiagnostics.diagnostics,
          attempt,
        },
      };
    }).reverse();
    const artifacts = Array.from({ length: 4 }, (_, index) => {
      const entry = index + 1;
      return {
        id: entry,
        runNodeId: 1,
        artifactType: 'report' as const,
        contentType: 'markdown' as const,
        contentPreview: `artifact ${entry} ${'content '.repeat(20)}`,
        createdAt: `2026-02-18T00:0${entry}:25.000Z`,
      };
    }).reverse();

    render(
      <RunDetailContent
        initialDetail={createRunDetail({
          artifacts,
          diagnostics,
        })}
        repositories={[createRepository()]}
        enableRealtime={false}
      />,
    );

    const artifactDisclosure = screen.getByText('Show 2 earlier artifacts');
    const diagnosticDisclosure = screen.getByText('Show 2 earlier diagnostics');
    const artifactList = screen.getByRole('list', { name: 'Run artifacts' });
    const diagnosticsList = screen.getByRole('list', { name: 'Run node diagnostics' });
    const artifactItems = artifactList.querySelectorAll(':scope > li');
    const diagnosticItems = diagnosticsList.querySelectorAll(':scope > li');

    expect(artifactDisclosure.closest('details')).not.toHaveAttribute('open');
    expect(diagnosticDisclosure.closest('details')).not.toHaveAttribute('open');
    expect(artifactItems).toHaveLength(3);
    expect(diagnosticItems).toHaveLength(3);
    expect(
      within(artifactItems[0] as HTMLElement).getByText(/artifact 4/i, {
        selector: 'div.run-expandable-preview > p.meta-text',
      }),
    ).toBeInTheDocument();
    expect(
      within(artifactItems[1] as HTMLElement).getByText(/artifact 3/i, {
        selector: 'div.run-expandable-preview > p.meta-text',
      }),
    ).toBeInTheDocument();
    expect(within(diagnosticItems[0] as HTMLElement).getByText(/attempt 4\): completed/i)).toBeInTheDocument();
    expect(within(diagnosticItems[1] as HTMLElement).getByText(/attempt 3\): completed/i)).toBeInTheDocument();
  });

  it('collapses agent stream behind disclosure for terminal runs', () => {
    render(
      <RunDetailContent
        initialDetail={createRunDetail({
          run: {
            status: 'completed',
            completedAt: '2026-02-18T00:05:00.000Z',
          },
          nodes: [
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
              latestDiagnostics: null,
            },
          ],
        })}
        repositories={[createRepository()]}
        enableRealtime={false}
      />,
    );

    const disclosure = screen.getByText(/Stream ended/i);
    const details = disclosure.closest('details');

    expect(details).not.toBeNull();
    expect(details).not.toHaveAttribute('open');
    expect(disclosure).toHaveTextContent(/design \(attempt 1\)/i);
  });

  it('shows "no target selected" in collapsed stream for terminal runs without nodes', () => {
    render(
      <RunDetailContent
        initialDetail={createRunDetail({
          run: {
            status: 'completed',
            completedAt: '2026-02-18T00:05:00.000Z',
          },
          nodes: [],
          artifacts: [],
          routingDecisions: [],
          diagnostics: [],
        })}
        repositories={[createRepository()]}
        enableRealtime={false}
      />,
    );

    const disclosure = screen.getByText(/Stream ended/i);
    expect(disclosure).toHaveTextContent(/no target selected/i);
    expect(disclosure).toHaveTextContent(/no events captured/i);
  });

  it('shows singular "event" label in collapsed stream for terminal runs with one stream event', async () => {
    vi.stubGlobal('EventSource', MockEventSource as unknown as typeof EventSource);
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/nodes/1/stream')) {
        return createJsonResponse({
          workflowRunId: 412,
          runNodeId: 1,
          attempt: 1,
          nodeStatus: 'completed',
          ended: true,
          latestSequence: 1,
          events: [
            createStreamEvent({ runNodeId: 1, sequence: 1, contentPreview: 'sole event' }),
          ],
        });
      }
      return createJsonResponse(createRunDetail({
        run: { status: 'completed', completedAt: '2026-02-18T00:05:00.000Z' },
      }));
    });

    render(
      <RunDetailContent
        initialDetail={createRunDetail({
          run: {
            status: 'completed',
            completedAt: '2026-02-18T00:05:00.000Z',
          },
          nodes: [
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
              latestDiagnostics: null,
            },
          ],
        })}
        repositories={[createRepository()]}
        enableRealtime={false}
      />,
    );

    await waitFor(() => {
      const disclosure = screen.getByText(/Stream ended/i);
      expect(disclosure).toHaveTextContent(/1 event captured/i);
      expect(disclosure).not.toHaveTextContent(/1 events captured/i);
    });
  });

  it('shows plural "events" label in collapsed stream for terminal runs with multiple stream events', async () => {
    vi.stubGlobal('EventSource', MockEventSource as unknown as typeof EventSource);
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/nodes/1/stream')) {
        return createJsonResponse({
          workflowRunId: 412,
          runNodeId: 1,
          attempt: 1,
          nodeStatus: 'completed',
          ended: true,
          latestSequence: 2,
          events: [
            createStreamEvent({ runNodeId: 1, sequence: 1, contentPreview: 'first event' }),
            createStreamEvent({ runNodeId: 1, sequence: 2, contentPreview: 'second event' }),
          ],
        });
      }
      return createJsonResponse(createRunDetail({
        run: { status: 'completed', completedAt: '2026-02-18T00:05:00.000Z' },
      }));
    });

    render(
      <RunDetailContent
        initialDetail={createRunDetail({
          run: {
            status: 'completed',
            completedAt: '2026-02-18T00:05:00.000Z',
          },
          nodes: [
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
              latestDiagnostics: null,
            },
          ],
        })}
        repositories={[createRepository()]}
        enableRealtime={false}
      />,
    );

    await waitFor(() => {
      const disclosure = screen.getByText(/Stream ended/i);
      expect(disclosure).toHaveTextContent(/2 events captured/i);
    });
  });

  it('counts buffered events in terminal collapsed stream summary', async () => {
    vi.stubGlobal('EventSource', MockEventSource as unknown as typeof EventSource);
    let allowTerminalTransition = false;

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
            createStreamEvent({
              sequence: 1,
              contentPreview: 'seeded event',
            }),
          ],
        });
      }

      if (url === '/api/dashboard/runs/412') {
        if (!allowTerminalTransition) {
          return createJsonResponse(createRunDetail());
        }

        return createJsonResponse(createRunDetail({
          run: {
            status: 'completed',
            completedAt: '2026-02-18T00:05:00.000Z',
          },
          nodes: [
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
              latestDiagnostics: null,
            },
            {
              id: 2,
              treeNodeId: 2,
              nodeKey: 'implement',
              sequenceIndex: 1,
              attempt: 1,
              status: 'completed',
              startedAt: '2026-02-18T00:00:35.000Z',
              completedAt: '2026-02-18T00:01:10.000Z',
              latestArtifact: null,
              latestRoutingDecision: null,
              latestDiagnostics: null,
            },
          ],
        }));
      }

      return createJsonResponse(createRunDetail());
    });

    const user = userEvent.setup();

    render(
      <RunDetailContent
        initialDetail={createRunDetail()}
        repositories={[createRepository()]}
        pollIntervalMs={30}
      />,
    );

    await waitFor(() => {
      expect(MockEventSource.instances).toHaveLength(1);
    });

    const source = MockEventSource.instances[0]!;
    source.emitOpen();

    await waitFor(() => {
      expect(screen.getByText('seeded event')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: 'Pause auto-scroll' }));
    source.emit('stream_event', createStreamEvent({ sequence: 2, contentPreview: 'buffered update' }));

    await waitFor(() => {
      expect(screen.getByText('1 new events buffered.')).toBeInTheDocument();
    });
    expect(screen.queryByText('buffered update')).toBeNull();

    allowTerminalTransition = true;

    await waitFor(() => {
      const disclosure = screen.getByText(/Stream ended/i);
      expect(disclosure).toHaveTextContent(/2 events captured/i);
    });
  });

  it('does not collapse agent stream for active runs', () => {
    render(
      <RunDetailContent
        initialDetail={createRunDetail()}
        repositories={[createRepository()]}
        enableRealtime={false}
      />,
    );

    expect(screen.queryByText(/Stream ended/i)).toBeNull();
    expect(screen.getByRole('heading', { level: 3, name: 'Agent stream' })).toBeInTheDocument();
  });

  it('renders a single node list in the Node Status panel without duplicating in agent stream', () => {
    render(
      <RunDetailContent
        initialDetail={createRunDetail()}
        repositories={[createRepository()]}
        enableRealtime={false}
      />,
    );

    const nodeStatusPanel = screen.getByRole('heading', { level: 3, name: 'Node status' }).closest('aside');
    expect(nodeStatusPanel).not.toBeNull();
    expect(within(nodeStatusPanel!).getByRole('button', { name: 'design (attempt 1)' })).toBeInTheDocument();

    expect(screen.queryByRole('list', { name: 'Agent stream targets' })).toBeNull();
  });

  it('selects agent stream target when clicking a node in the status panel', async () => {
    vi.stubGlobal('EventSource', MockEventSource as unknown as typeof EventSource);
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/nodes/1/stream')) {
        return createJsonResponse({
          workflowRunId: 412,
          runNodeId: 1,
          attempt: 1,
          nodeStatus: 'completed',
          ended: true,
          latestSequence: 0,
          events: [],
        });
      }
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

    const user = userEvent.setup();

    render(
      <RunDetailContent
        initialDetail={createRunDetail()}
        repositories={[createRepository()]}
        enableRealtime={false}
      />,
    );

    const designButton = screen.getByRole('button', { name: 'design (attempt 1)' });
    await user.click(designButton);

    await waitFor(() => {
      expect(screen.getByText(/Node design \(attempt 1\)/i)).toBeInTheDocument();
    });
  });
});
