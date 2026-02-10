// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import Page from './page';

describe('Dashboard Page', () => {
  const originalTestRoutesEnv = process.env.ALPHRED_DASHBOARD_TEST_ROUTES;

  afterEach(() => {
    if (originalTestRoutesEnv === undefined) {
      delete process.env.ALPHRED_DASHBOARD_TEST_ROUTES;
    } else {
      process.env.ALPHRED_DASHBOARD_TEST_ROUTES = originalTestRoutesEnv;
    }
  });

  it('does not render the test route link by default', () => {
    delete process.env.ALPHRED_DASHBOARD_TEST_ROUTES;

    render(<Page />);

    expect(screen.queryByRole('link', { name: 'Open slow dashboard route' })).not.toBeInTheDocument();
  });

  it("renders the test route link when ALPHRED_DASHBOARD_TEST_ROUTES is '1'", () => {
    process.env.ALPHRED_DASHBOARD_TEST_ROUTES = '1';

    render(<Page />);

    const link = screen.getByRole('link', { name: 'Open slow dashboard route' });
    expect(link).toHaveAttribute('href', '/test/slow');
  });
});

