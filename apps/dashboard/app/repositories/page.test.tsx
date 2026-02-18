// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import RepositoriesPage from './page';

describe('RepositoriesPage', () => {
  it('renders shared repository status badges and actions', () => {
    render(<RepositoriesPage />);

    expect(screen.getByRole('heading', { name: 'Repository registry' })).toBeInTheDocument();
    expect(screen.getByText('demo-repo')).toBeInTheDocument();
    expect(screen.getByText('Cloned')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sync Selected' })).toBeInTheDocument();
  });
});
