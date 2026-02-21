// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import RepositoriesError from './repositories/error';
import RepositoriesLoading from './repositories/loading';
import WorkflowsError from './workflows/error';
import WorkflowsLoading from './workflows/loading';
import RunDetailError from './runs/[runId]/error';
import RunDetailLoading from './runs/[runId]/loading';
import RunWorktreeError from './runs/[runId]/worktree/error';
import RunWorktreeLoading from './runs/[runId]/worktree/loading';
import RunsError from './runs/error';
import RunsLoading from './runs/loading';
import IntegrationsError from './settings/integrations/error';
import IntegrationsLoading from './settings/integrations/loading';

type ErrorBoundaryProps = Readonly<{
  error: Error & { digest?: string };
  reset: () => void;
}>;

type ErrorBoundaryComponent = (props: ErrorBoundaryProps) => ReactElement;

const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

const loadingCases: readonly {
  component: () => ReactElement;
  heading: string;
  message: string;
}[] = [
  {
    component: RepositoriesLoading,
    heading: 'Loading repositories',
    message: 'Checking clone status and sync state...',
  },
  {
    component: WorkflowsLoading,
    heading: 'Loading workflows',
    message: 'Fetching version catalog and draft state...',
  },
  { component: RunsLoading, heading: 'Loading runs', message: 'Loading run lifecycle data...' },
  {
    component: RunDetailLoading,
    heading: 'Loading run detail',
    message: 'Fetching timeline and node lifecycle...',
  },
  {
    component: RunWorktreeLoading,
    heading: 'Loading worktree',
    message: 'Preparing changed-file explorer...',
  },
  {
    component: IntegrationsLoading,
    heading: 'Loading integrations',
    message: 'Checking GitHub authentication status...',
  },
];

const errorCases: readonly {
  component: ErrorBoundaryComponent;
  heading: string;
  body: string;
  logPrefix: string;
}[] = [
  {
    component: RepositoriesError,
    heading: 'Repositories unavailable',
    body: 'Unable to load repository registry data.',
    logPrefix: 'Repositories route error:',
  },
  {
    component: WorkflowsError,
    heading: 'Workflows unavailable',
    body: 'Unable to load workflow catalog data.',
    logPrefix: 'Workflows route error:',
  },
  {
    component: RunsError,
    heading: 'Runs unavailable',
    body: 'Unable to load run summaries right now.',
    logPrefix: 'Runs route error:',
  },
  {
    component: RunDetailError,
    heading: 'Run detail unavailable',
    body: 'Unable to load this run detail snapshot.',
    logPrefix: 'Run detail route error:',
  },
  {
    component: RunWorktreeError,
    heading: 'Worktree unavailable',
    body: 'Unable to load worktree files for this run.',
    logPrefix: 'Run worktree route error:',
  },
  {
    component: IntegrationsError,
    heading: 'Integrations unavailable',
    body: 'Unable to load integration authentication status.',
    logPrefix: 'Integrations route error:',
  },
];

describe('Route boundary components', () => {
  afterEach(() => {
    consoleErrorSpy.mockClear();
  });

  afterAll(() => {
    consoleErrorSpy.mockRestore();
  });

  for (const testCase of loadingCases) {
    it(`renders loading boundary: ${testCase.heading}`, () => {
      const { container } = render(<testCase.component />);

      expect(screen.getByRole('heading', { name: testCase.heading })).toBeInTheDocument();

      const status = screen.getByRole('status');
      expect(status).toHaveAttribute('aria-live', 'polite');
      expect(status).toHaveTextContent(testCase.message);
      expect(container.querySelector('output')).toBe(status);
    });
  }

  for (const testCase of errorCases) {
    it(`renders error boundary and retry behavior: ${testCase.heading}`, async () => {
      const error = new Error('route failed');
      const reset = vi.fn();
      const user = userEvent.setup();

      render(<testCase.component error={error} reset={reset} />);

      expect(screen.getByRole('heading', { name: testCase.heading })).toBeInTheDocument();
      expect(screen.getByText(testCase.body)).toBeInTheDocument();

      const alertRegion = screen.getByRole('alert');
      expect(alertRegion).toHaveAttribute('aria-live', 'assertive');
      expect(consoleErrorSpy).toHaveBeenCalledWith(testCase.logPrefix, error);

      await user.click(screen.getByRole('button', { name: 'Retry' }));
      expect(reset).toHaveBeenCalledTimes(1);
    });
  }
});
