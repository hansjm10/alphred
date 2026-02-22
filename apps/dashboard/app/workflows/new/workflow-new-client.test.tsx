// @vitest-environment jsdom

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NewWorkflowPageContent } from './workflow-new-client';

const { pushMock } = vi.hoisted(() => ({
  pushMock: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: pushMock,
  }),
}));

function createJsonResponse(payload: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(payload), {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
}

describe('NewWorkflowPageContent', () => {
  beforeEach(() => {
    pushMock.mockReset();
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('submits a workflow creation request and routes to the builder', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async () => createJsonResponse({ treeKey: 'demo-tree', draftVersion: 1 }, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    render(<NewWorkflowPageContent />);

    const createButton = screen.getByRole('button', { name: 'Create and open builder' });
    expect(createButton).toBeDisabled();

    await user.type(screen.getByPlaceholderText('Workflow name'), 'Demo Tree');
    expect(createButton).toBeEnabled();

    await user.click(createButton);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/dashboard/workflows');
    expect(init.method).toBe('POST');

    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      template: 'design-implement-review',
      name: 'Demo Tree',
      treeKey: 'demo-tree',
    });

    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith('/workflows/demo-tree/edit');
    });
  });

  it('renders API errors returned during creation', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async () =>
      createJsonResponse({ error: { message: 'Name already exists.' } }, { status: 409 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<NewWorkflowPageContent />);

    await user.type(screen.getByPlaceholderText('Workflow name'), 'Demo Tree');
    await user.click(screen.getByRole('button', { name: 'Create and open builder' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Name already exists.');
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('falls back to a status message when the API response lacks an error envelope', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async () => createJsonResponse({}, { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    render(<NewWorkflowPageContent />);

    await user.type(screen.getByPlaceholderText('Workflow name'), 'Demo Tree');
    await user.click(screen.getByRole('button', { name: 'Create and open builder' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Workflow creation failed (HTTP 500).');
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('surfaces thrown errors during creation', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async () => {
      throw new Error('Network down');
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<NewWorkflowPageContent />);

    await user.type(screen.getByPlaceholderText('Workflow name'), 'Demo Tree');
    await user.click(screen.getByRole('button', { name: 'Create and open builder' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Network down');
    expect(pushMock).not.toHaveBeenCalled();
  });
});
