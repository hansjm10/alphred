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

  it('renders changed files and default preview selection', () => {
    render(<RunWorktreePage params={{ runId: '412' }} />);

    expect(screen.getByRole('heading', { name: 'Run #412 worktree' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'src/core/engine.ts *' })).toHaveAttribute(
      'href',
      '/runs/412/worktree?path=src%2Fcore%2Fengine.ts',
    );
    expect(screen.getByLabelText('File diff preview')).toHaveTextContent(
      'emitLifecycleCheckpoint',
    );
  });

  it('uses the deep-linked path when provided', () => {
    render(
      <RunWorktreePage
        params={{ runId: '412' }}
        searchParams={{ path: 'apps/dashboard/app/runs/page.tsx' }}
      />,
    );

    expect(screen.getByLabelText('File diff preview')).toHaveTextContent(
      '/runs/412">Open</Link>',
    );
  });

  it('renders empty state when the run has no changed files', () => {
    render(<RunWorktreePage params={{ runId: '410' }} />);

    expect(screen.getByRole('heading', { name: 'No changed files' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to Run' })).toHaveAttribute('href', '/runs/410');
  });

  it('routes invalid run ids to not-found', () => {
    expect(() => render(<RunWorktreePage params={{ runId: '9999' }} />)).toThrow(NOT_FOUND_ERROR);
    expect(notFoundMock).toHaveBeenCalled();
  });
});
