// @vitest-environment jsdom

import { render, screen, waitFor } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
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

function fetchCallUrl(value: RequestInfo | URL): string {
  if (typeof value === 'string') {
    return value;
  }

  if (value instanceof URL) {
    return value.toString();
  }

  return value.url;
}

function createWorkflowFetchMock(args?: Readonly<{
  available?: boolean;
  createResponse?: () => Promise<Response>;
}>): ReturnType<typeof vi.fn> {
  const available = args?.available ?? true;
  const createResponse = args?.createResponse ?? (async () => createJsonResponse({ treeKey: 'demo-tree', draftVersion: 1 }, { status: 200 }));

  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = fetchCallUrl(input);
    if (url.startsWith('/api/dashboard/workflows/catalog?treeKey=')) {
      const parsed = new URL(url, 'http://localhost');
      const treeKey = parsed.searchParams.get('treeKey') ?? '';
      return createJsonResponse({ treeKey, available }, { status: 200 });
    }

    if (url === '/api/dashboard/workflows') {
      return createResponse();
    }

    throw new Error(`Unexpected fetch URL: ${url} (${init?.method ?? 'GET'})`);
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
    const fetchMock = createWorkflowFetchMock();
    vi.stubGlobal('fetch', fetchMock);

    render(<NewWorkflowPageContent />);

    const createButton = screen.getByRole('button', { name: 'Create and open builder' });
    expect(createButton).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText('Workflow name'), { target: { value: 'Demo Tree' } });

    await waitFor(() => {
      expect(createButton).toBeEnabled();
    });

    await user.click(createButton);

    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find((call) => fetchCallUrl(call[0] as RequestInfo | URL) === '/api/dashboard/workflows');
      expect(postCall).toBeTruthy();
    });

    const postCall = fetchMock.mock.calls.find((call) => fetchCallUrl(call[0] as RequestInfo | URL) === '/api/dashboard/workflows');
    expect(postCall).toBeTruthy();
    const [url, init] = postCall as unknown as [string, RequestInit];
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

  it('omits blank descriptions from the create payload', async () => {
    const user = userEvent.setup();
    const fetchMock = createWorkflowFetchMock();
    vi.stubGlobal('fetch', fetchMock);

    render(<NewWorkflowPageContent />);

    fireEvent.change(screen.getByPlaceholderText('Workflow name'), { target: { value: 'Demo Tree' } });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Create and open builder' })).toBeEnabled();
    });
    await user.type(screen.getByPlaceholderText('Optional one-line description'), '   ');
    await user.click(screen.getByRole('button', { name: 'Create and open builder' }));

    const postCall = await waitFor(() => {
      const call = fetchMock.mock.calls.find((candidate) => fetchCallUrl(candidate[0] as RequestInfo | URL) === '/api/dashboard/workflows');
      expect(call).toBeTruthy();
      return call;
    });

    const [, init] = postCall as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).not.toHaveProperty('description');
  });

  it('submits custom template and tree key selections', async () => {
    const user = userEvent.setup();
    const fetchMock = createWorkflowFetchMock({
      createResponse: async () => createJsonResponse({ treeKey: 'custom-key', draftVersion: 1 }, { status: 200 }),
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<NewWorkflowPageContent />);

    await user.click(screen.getByRole('radio', { name: /Blank workflow/ }));
    fireEvent.change(screen.getByPlaceholderText('Workflow name'), { target: { value: 'Demo Tree' } });
    fireEvent.change(screen.getByPlaceholderText('demo-tree'), { target: { value: 'custom-key' } });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Create and open builder' })).toBeEnabled();
    });
    await user.type(screen.getByPlaceholderText('Optional one-line description'), 'Hello');
    await user.click(screen.getByRole('button', { name: 'Create and open builder' }));

    const postCall = await waitFor(() => {
      const call = fetchMock.mock.calls.find((candidate) => fetchCallUrl(candidate[0] as RequestInfo | URL) === '/api/dashboard/workflows');
      expect(call).toBeTruthy();
      return call;
    });

    const [, init] = postCall as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      template: 'blank',
      name: 'Demo Tree',
      treeKey: 'custom-key',
      description: 'Hello',
    });
  });

  it('can switch templates back to design-implement-review before submitting', async () => {
    const user = userEvent.setup();
    const fetchMock = createWorkflowFetchMock();
    vi.stubGlobal('fetch', fetchMock);

    render(<NewWorkflowPageContent />);

    await user.click(screen.getByRole('radio', { name: /Blank workflow/ }));
    await user.click(screen.getByRole('radio', { name: /Template: Design/ }));
    fireEvent.change(screen.getByPlaceholderText('Workflow name'), { target: { value: 'Demo Tree' } });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Create and open builder' })).toBeEnabled();
    });
    await user.click(screen.getByRole('button', { name: 'Create and open builder' }));

    const postCall = await waitFor(() => {
      const call = fetchMock.mock.calls.find((candidate) => fetchCallUrl(candidate[0] as RequestInfo | URL) === '/api/dashboard/workflows');
      expect(call).toBeTruthy();
      return call;
    });

    const [, init] = postCall as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.template).toBe('design-implement-review');
  });

  it('shows inline format errors for invalid tree keys and blocks submit', async () => {
    const user = userEvent.setup();
    const fetchMock = createWorkflowFetchMock();
    vi.stubGlobal('fetch', fetchMock);

    render(<NewWorkflowPageContent />);

    fireEvent.change(screen.getByPlaceholderText('Workflow name'), { target: { value: 'Demo Tree' } });
    fireEvent.change(screen.getByPlaceholderText('demo-tree'), { target: { value: 'Invalid Key' } });

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Tree key must be lowercase and contain only a-z, 0-9, and hyphens.',
    );
    expect(screen.getByRole('button', { name: 'Create and open builder' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Create and open builder' }));
    expect(fetchMock.mock.calls.some((call) => fetchCallUrl(call[0] as RequestInfo | URL) === '/api/dashboard/workflows')).toBe(false);
  });

  it('shows inline duplicate-key errors when availability check fails', async () => {
    const fetchMock = createWorkflowFetchMock({ available: false });
    vi.stubGlobal('fetch', fetchMock);

    render(<NewWorkflowPageContent />);

    fireEvent.change(screen.getByPlaceholderText('Workflow name'), { target: { value: 'Demo Tree' } });
    await expect(screen.findByRole('alert')).resolves.toHaveTextContent('Tree key "demo-tree" already exists.');
    expect(screen.getByRole('button', { name: 'Create and open builder' })).toBeDisabled();
  });

  it('renders API errors returned during creation', async () => {
    const user = userEvent.setup();
    const fetchMock = createWorkflowFetchMock({
      createResponse: async () => createJsonResponse({ error: { message: 'Name already exists.' } }, { status: 409 }),
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<NewWorkflowPageContent />);

    fireEvent.change(screen.getByPlaceholderText('Workflow name'), { target: { value: 'Demo Tree' } });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Create and open builder' })).toBeEnabled();
    });
    await user.click(screen.getByRole('button', { name: 'Create and open builder' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Name already exists.');
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('falls back to a status message when the API response lacks an error envelope', async () => {
    const user = userEvent.setup();
    const fetchMock = createWorkflowFetchMock({
      createResponse: async () => createJsonResponse({}, { status: 500 }),
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<NewWorkflowPageContent />);

    fireEvent.change(screen.getByPlaceholderText('Workflow name'), { target: { value: 'Demo Tree' } });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Create and open builder' })).toBeEnabled();
    });
    await user.click(screen.getByRole('button', { name: 'Create and open builder' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Workflow creation failed (HTTP 500).');
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('surfaces thrown errors during creation', async () => {
    const user = userEvent.setup();
    const fetchMock = createWorkflowFetchMock({
      createResponse: async () => {
        throw new Error('Network down');
      },
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<NewWorkflowPageContent />);

    fireEvent.change(screen.getByPlaceholderText('Workflow name'), { target: { value: 'Demo Tree' } });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Create and open builder' })).toBeEnabled();
    });
    await user.click(screen.getByRole('button', { name: 'Create and open builder' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Network down');
    expect(pushMock).not.toHaveBeenCalled();
  });
});
