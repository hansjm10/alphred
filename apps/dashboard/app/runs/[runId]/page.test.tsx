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

import RunDetailPage from './page';

describe('RunDetailPage', () => {
  beforeEach(() => {
    notFoundMock.mockClear();
  });

  it('renders run summary and completed-run worktree action', () => {
    render(<RunDetailPage params={{ runId: '410' }} />);

    expect(screen.getByRole('heading', { name: 'Run #410' })).toBeInTheDocument();
    expect(screen.getByText('demo-repo')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Worktree' })).toHaveAttribute(
      'href',
      '/runs/410/worktree',
    );
  });

  it('renders status-specific primary action for active runs', () => {
    render(<RunDetailPage params={{ runId: '412' }} />);

    expect(screen.getByRole('button', { name: 'Pause' })).toBeDisabled();
    expect(screen.getByText('Run started and queued node execution.')).toBeInTheDocument();
  });

  it('routes invalid run ids to not-found', () => {
    expect(() => render(<RunDetailPage params={{ runId: '9999' }} />)).toThrow(NOT_FOUND_ERROR);
    expect(notFoundMock).toHaveBeenCalled();
  });
});
