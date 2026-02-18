// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import IntegrationsPage from './page';

describe('IntegrationsPage', () => {
  it('renders auth status and remediation actions', () => {
    render(<IntegrationsPage />);

    expect(screen.getByRole('heading', { name: 'Integrations status' })).toBeInTheDocument();
    expect(screen.getByText('Authenticated')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Check Auth' })).toHaveAttribute(
      'href',
      '/settings/integrations',
    );
  });
});
