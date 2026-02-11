import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import RootLayout from './layout';

describe('RootLayout', () => {
  it('wraps children in html/body with lang="en"', () => {
    const child = <div>dashboard content</div>;

    const root = RootLayout({ children: child }) as ReactElement<{
      lang: string;
      children: ReactElement;
    }>;

    expect(root.type).toBe('html');
    expect(root.props.lang).toBe('en');

    const body = root.props.children as ReactElement<{ children: ReactElement }>;
    expect(body.type).toBe('body');
    expect(body.props.children).toBe(child);
  });
});
