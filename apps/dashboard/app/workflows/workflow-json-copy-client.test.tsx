// @vitest-environment jsdom

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkflowJsonCopyActions } from './workflow-json-copy-client';

describe('WorkflowJsonCopyActions', () => {
  async function flushMicrotasks(): Promise<void> {
    await act(async () => {
      await Promise.resolve();
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('copies JSON using the clipboard API when available', async () => {
    const writeTextMock = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: writeTextMock },
      configurable: true,
    });

    render(<WorkflowJsonCopyActions json='{"ok":true}' />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy JSON' }));
    });

    await flushMicrotasks();

    expect(writeTextMock).toHaveBeenCalledWith('{"ok":true}');
    expect(screen.getByRole('status')).toHaveTextContent('Copied.');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });
    expect(screen.getByRole('status')).toHaveTextContent('');
  });

  it('falls back to execCommand copy when clipboard API is unavailable', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: undefined,
      configurable: true,
    });

    render(<WorkflowJsonCopyActions json="demo" />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy JSON' }));
    });

    await flushMicrotasks();

    expect(screen.getByRole('status')).toHaveTextContent('Copy failed.');
  });

  it('surfaces an error when copying fails', async () => {
    const writeTextMock = vi.fn(async () => {
      throw new Error('nope');
    });
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: writeTextMock },
      configurable: true,
    });

    render(<WorkflowJsonCopyActions json="demo" />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy JSON' }));
    });

    await flushMicrotasks();

    expect(writeTextMock).toHaveBeenCalledWith('demo');
    expect(screen.getByRole('status')).toHaveTextContent('Copy failed.');
  });
});
