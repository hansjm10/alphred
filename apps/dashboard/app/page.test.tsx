// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import Page from './page';

describe('Dashboard Page', () => {
  it('renders the dashboard home content', () => {
    render(<Page />);

    expect(screen.getByRole('heading', { name: 'System readiness' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Global readiness' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Check Auth' })).toHaveAttribute(
      'href',
      '/settings/integrations',
    );
  });
});
