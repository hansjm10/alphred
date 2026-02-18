// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { NOT_FOUND_ERROR, notFoundMock } = vi.hoisted(() => {
  const error = new Error('NEXT_NOT_FOUND');

  return {
    NOT_FOUND_ERROR: error,
    notFoundMock: vi.fn(() => {
      throw error;
    }),
  };
});

vi.mock('next/navigation', () => ({
  notFound: notFoundMock,
}));

import RunWorktreePage from './page';

describe('RunWorktreePage', () => {
  beforeEach(() => {
    notFoundMock.mockClear();
  });

  it('renders changed files and default preview selection', async () => {
    render(await RunWorktreePage({ params: Promise.resolve({ runId: '412' }) }));

    expect(screen.getByRole('heading', { name: 'Run #412 worktree' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'src/core/engine.ts *' })).toHaveAttribute(
      'href',
      '/runs/412/worktree?path=src%2Fcore%2Fengine.ts',
    );
    expect(screen.getByLabelText('File diff preview')).toHaveTextContent(
      'emitLifecycleCheckpoint',
    );
  });

  it('uses the deep-linked path when provided', async () => {
    render(
      await RunWorktreePage({
        params: Promise.resolve({ runId: '412' }),
        searchParams: Promise.resolve({ path: 'apps/dashboard/app/runs/page.tsx' }),
      }),
    );

    expect(screen.getByLabelText('File diff preview')).toHaveTextContent(
      '/runs/412">Open</Link>',
    );
  });

  it('falls back to the first tracked file when the requested path is unknown', async () => {
    render(
      await RunWorktreePage({
        params: Promise.resolve({ runId: '412' }),
        searchParams: Promise.resolve({ path: 'does/not/exist.ts' }),
      }),
    );

    expect(screen.getByLabelText('File diff preview')).toHaveTextContent(
      'emitLifecycleCheckpoint',
    );
    expect(screen.getByRole('link', { name: 'View Diff' })).toHaveAttribute(
      'href',
      '/runs/412/worktree?path=src%2Fcore%2Fengine.ts',
    );
  });

  it('uses the first repeated path value before applying fallback rules', async () => {
    render(
      await RunWorktreePage({
        params: Promise.resolve({ runId: '412' }),
        searchParams: Promise.resolve({
          path: ['does/not/exist.ts', 'apps/dashboard/app/runs/page.tsx'],
        }),
      }),
    );

    expect(screen.getByLabelText('File diff preview')).toHaveTextContent(
      'emitLifecycleCheckpoint',
    );
    expect(screen.getByRole('link', { name: 'View Diff' })).toHaveAttribute(
      'href',
      '/runs/412/worktree?path=src%2Fcore%2Fengine.ts',
    );
  });

  it('renders empty state when the run has no changed files', async () => {
    render(await RunWorktreePage({ params: Promise.resolve({ runId: '410' }) }));

    expect(screen.getByRole('heading', { name: 'No changed files' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to Run' })).toHaveAttribute('href', '/runs/410');
  });

  it('routes invalid run ids to not-found', async () => {
    await expect(
      RunWorktreePage({ params: Promise.resolve({ runId: '9999' }) }),
    ).rejects.toThrow(NOT_FOUND_ERROR);
    expect(notFoundMock).toHaveBeenCalled();
  });
});
