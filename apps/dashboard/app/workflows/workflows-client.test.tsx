// @vitest-environment jsdom

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkflowsPageContent } from './workflows-client';
import type { DashboardWorkflowCatalogItem } from '../../src/server/dashboard-contracts';

const { pushMock } = vi.hoisted(() => ({
  pushMock: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: pushMock,
  }),
}));

function createWorkflow(overrides: Partial<DashboardWorkflowCatalogItem> = {}): DashboardWorkflowCatalogItem {
  return {
    treeKey: overrides.treeKey ?? 'demo-tree',
    name: overrides.name ?? 'Demo Tree',
    description: overrides.description ?? 'Default description',
    publishedVersion: overrides.publishedVersion ?? 1,
    draftVersion: overrides.draftVersion ?? null,
    updatedAt: overrides.updatedAt ?? '2026-02-18T00:00:00.000Z',
  };
}

function createJsonResponse(payload: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(payload), {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
}

describe('WorkflowsPageContent', () => {
  beforeEach(() => {
    pushMock.mockReset();
    vi.stubGlobal('fetch', vi.fn());
    vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-02-18T00:00:20.000Z').getTime());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders an empty state when there are no workflows', () => {
    render(<WorkflowsPageContent workflows={[]} />);

    expect(screen.getByRole('heading', { name: 'Workflow trees' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'No workflows yet' })).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Create workflow' }).length).toBeGreaterThan(0);
  });

  it('filters workflows by name, key, and description', async () => {
    const user = userEvent.setup();
    render(
      <WorkflowsPageContent
        workflows={[
          createWorkflow({ treeKey: 'demo-tree', name: 'Demo Tree', description: 'First workflow' }),
          createWorkflow({ treeKey: 'other-tree', name: 'Other Tree', description: 'Something else' }),
        ]}
      />,
    );

    expect(screen.getByText('Demo Tree')).toBeInTheDocument();
    expect(screen.getByText('Other Tree')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Search'), 'other');

    expect(screen.queryByText('Demo Tree')).toBeNull();
    expect(screen.getByText('Other Tree')).toBeInTheDocument();

    await user.clear(screen.getByLabelText('Search'));
    await user.type(screen.getByLabelText('Search'), 'first');

    expect(screen.getByText('Demo Tree')).toBeInTheDocument();
    expect(screen.queryByText('Other Tree')).toBeNull();
  });

  it('renders draft/published versions and relative updated time', () => {
    render(
      <WorkflowsPageContent
        workflows={[
          createWorkflow({
            treeKey: 'demo-tree',
            name: 'Demo Tree',
            publishedVersion: 3,
            draftVersion: 4,
            updatedAt: '2026-02-18T00:00:10.000Z',
          }),
        ]}
      />,
    );

    expect(screen.getByText('Draft v4')).toBeInTheDocument();
    expect(screen.getByText('Published v3')).toBeInTheDocument();
    expect(screen.getByText('just now')).toBeInTheDocument();
  });

  it('renders version cells for published-only and never-published workflows', () => {
    render(
      <WorkflowsPageContent
        workflows={[
          createWorkflow({ treeKey: 'published', name: 'Published Only', publishedVersion: 2, draftVersion: null }),
          {
            treeKey: 'empty',
            name: 'Empty',
            description: 'Default description',
            publishedVersion: null,
            draftVersion: null,
            updatedAt: '2026-02-18T00:00:10.000Z',
          },
        ]}
      />,
    );

    expect(screen.getByText('v2')).toBeInTheDocument();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('renders Unknown when updatedAt is invalid', () => {
    render(
      <WorkflowsPageContent
        workflows={[
          createWorkflow({
            treeKey: 'demo-tree',
            name: 'Demo Tree',
            updatedAt: 'not-a-date',
            publishedVersion: 1,
            draftVersion: null,
          }),
        ]}
      />,
    );

    expect(screen.getByText('Unknown')).toBeInTheDocument();
  });

  it('duplicates a workflow and routes to the new builder on success', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async () => createJsonResponse({ treeKey: 'demo-tree-copy', draftVersion: 1 }, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <WorkflowsPageContent
        workflows={[
          createWorkflow({
            treeKey: 'demo-tree',
            name: 'Demo Tree',
            description: 'First workflow',
            publishedVersion: 1,
            draftVersion: null,
          }),
        ]}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Duplicate' }));
    expect(screen.getByRole('dialog', { name: 'Duplicate workflow' })).toBeInTheDocument();

    const dialog = screen.getByRole('dialog', { name: 'Duplicate workflow' });
    const dialogQueries = within(dialog);

    const nameInput = dialogQueries.getByLabelText('Name');
    const treeKeyInput = dialogQueries.getByRole('textbox', { name: /^Tree key/ });

    await user.clear(nameInput);
    await user.type(nameInput, 'Demo Tree Copy');
    await user.clear(treeKeyInput);
    await user.type(treeKeyInput, 'demo-tree-copy');

    await user.click(dialogQueries.getByRole('button', { name: 'Duplicate and open builder' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/dashboard/workflows/demo-tree/duplicate');
    expect(init.method).toBe('POST');

    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      name: 'Demo Tree Copy',
      treeKey: 'demo-tree-copy',
      description: 'First workflow',
    });

    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith('/workflows/demo-tree-copy/edit');
    });
  });

  it('slugifies the tree key when left blank in the duplicate dialog', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async () => createJsonResponse({ treeKey: 'demo-tree-copy', draftVersion: 1 }, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    render(<WorkflowsPageContent workflows={[createWorkflow({ treeKey: 'demo-tree', description: 'First workflow' })]} />);

    await user.click(screen.getByRole('button', { name: 'Duplicate' }));

    const dialog = screen.getByRole('dialog', { name: 'Duplicate workflow' });
    const dialogQueries = within(dialog);

    const nameInput = dialogQueries.getByLabelText('Name');
    const treeKeyInput = dialogQueries.getByRole('textbox', { name: /^Tree key/ });

    await user.clear(nameInput);
    await user.type(nameInput, 'Demo Tree Copy');
    await user.clear(treeKeyInput);

    await user.click(dialogQueries.getByRole('button', { name: 'Duplicate and open builder' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.treeKey).toBe('demo-tree-copy');
  });

  it('requires name and tree key when duplicating', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async () => createJsonResponse({ treeKey: 'demo-tree-copy', draftVersion: 1 }, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    render(<WorkflowsPageContent workflows={[createWorkflow({ treeKey: 'demo-tree', description: 'First workflow' })]} />);

    await user.click(screen.getByRole('button', { name: 'Duplicate' }));

    const dialog = screen.getByRole('dialog', { name: 'Duplicate workflow' });
    const dialogQueries = within(dialog);

    await user.clear(dialogQueries.getByLabelText('Name'));
    await user.clear(dialogQueries.getByRole('textbox', { name: /^Tree key/ }));

    await user.click(dialogQueries.getByRole('button', { name: 'Duplicate and open builder' }));

    expect(await dialogQueries.findByRole('alert')).toHaveTextContent('Name and tree key are required.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces API error payloads when duplication fails', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async () =>
      createJsonResponse({ error: { message: 'No permissions.' } }, { status: 403 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<WorkflowsPageContent workflows={[createWorkflow()]} />);

    await user.click(screen.getByRole('button', { name: 'Duplicate' }));

    const dialog = screen.getByRole('dialog', { name: 'Duplicate workflow' });
    await user.click(within(dialog).getByRole('button', { name: 'Duplicate and open builder' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('No permissions.');
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('falls back to an HTTP status message when the duplicate API response is not JSON', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async () => new Response('nope', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    render(<WorkflowsPageContent workflows={[createWorkflow()]} />);

    await user.click(screen.getByRole('button', { name: 'Duplicate' }));

    const dialog = screen.getByRole('dialog', { name: 'Duplicate workflow' });
    await user.click(within(dialog).getByRole('button', { name: 'Duplicate and open builder' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Workflow duplicate failed (HTTP 500).');
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('surfaces thrown errors when duplication fails before a response is returned', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async () => {
      throw new Error('Network down');
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<WorkflowsPageContent workflows={[createWorkflow()]} />);

    await user.click(screen.getByRole('button', { name: 'Duplicate' }));

    const dialog = screen.getByRole('dialog', { name: 'Duplicate workflow' });
    await user.click(within(dialog).getByRole('button', { name: 'Duplicate and open builder' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Network down');
    expect(pushMock).not.toHaveBeenCalled();
  });
});
