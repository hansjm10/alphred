// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import DashboardError from './error';

const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

describe('DashboardError', () => {
  afterEach(() => {
    consoleErrorSpy.mockClear();
  });

  afterAll(() => {
    consoleErrorSpy.mockRestore();
  });

  it('renders the dashboard error fallback with alert semantics', () => {
    const reset = vi.fn();
    const error = new Error('route failed');

    render(<DashboardError error={error} reset={reset} />);

    expect(screen.getByRole('heading', { name: 'Dashboard error' })).toBeInTheDocument();
    expect(screen.getByText('Something went wrong while loading this route.')).toBeInTheDocument();

    const alertRegion = screen.getByRole('alert');
    expect(alertRegion).toHaveAttribute('aria-live', 'assertive');
    expect(consoleErrorSpy).toHaveBeenCalledWith('Dashboard route error:', error);
  });

  it('invokes reset when the retry button is clicked', async () => {
    const reset = vi.fn();
    const user = userEvent.setup();

    render(<DashboardError error={new Error('boom')} reset={reset} />);

    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(reset).toHaveBeenCalledTimes(1);
  });
});
