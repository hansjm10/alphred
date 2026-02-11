// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import Page from './page';

describe('Dashboard Page', () => {
  it('renders the dashboard home content', () => {
    render(<Page />);

    expect(screen.getByRole('heading', { name: 'Alphred Dashboard' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Workflow Runs' })).toBeInTheDocument();
    expect(screen.getByText('No active runs. Start a workflow from the CLI.')).toBeInTheDocument();
  });
});
