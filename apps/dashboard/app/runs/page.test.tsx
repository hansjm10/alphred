// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import RunsPage from './page';

describe('RunsPage', () => {
  it('renders run status tabs and lifecycle rows', () => {
    render(<RunsPage />);

    expect(screen.getByRole('heading', { name: 'Run lifecycle' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Run status filters' })).toBeInTheDocument();
    expect(screen.getByText('#412 demo-tree')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Running' })).toHaveAttribute(
      'href',
      '/runs?status=running',
    );
  });
});
