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

  it('renders empty-state callout when no repositories exist', () => {
    render(<RepositoriesPage repositories={[]} />);

    expect(screen.getByRole('heading', { name: 'No repositories configured' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Add Repository' })).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Sync Selected' })).toBeDisabled();
  });
});
