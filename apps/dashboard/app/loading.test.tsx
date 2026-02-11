// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import Loading from './loading';

describe('Loading', () => {
  it('renders loading text inside a polite output element', () => {
    const { container } = render(<Loading />);

    expect(screen.getByRole('heading', { name: 'Loading dashboard' })).toBeInTheDocument();

    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveTextContent('Preparing workflow run data...');

    const outputElement = container.querySelector('output');
    expect(outputElement).not.toBeNull();
    expect(outputElement).toBe(status);
  });
});
