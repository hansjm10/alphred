// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import NotFound from './not-found';

describe('NotFound', () => {
  it('renders not-found messaging and a home link target', () => {
    render(<NotFound />);

    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeInTheDocument();

    const homeLink = screen.getByRole('link', { name: 'Return to home' });
    expect(homeLink).toHaveAttribute('href', '/');
  });
});
