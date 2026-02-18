import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import RootLayout from './layout';
import AppShell from './ui/app-shell';

describe('RootLayout', () => {
  it('wraps children in html/body and injects the shared app shell', () => {
    const child = <div>dashboard content</div>;

    const root = RootLayout({ children: child }) as ReactElement<{
      lang: string;
      children: ReactElement;
    }>;

    expect(root.type).toBe('html');
    expect(root.props.lang).toBe('en');

    const body = root.props.children as ReactElement<{ children: ReactElement }>;
    expect(body.type).toBe('body');

    const shell = body.props.children as ReactElement<{ children: ReactElement }>;
    expect(shell.type).toBe(AppShell);
    expect(shell.props.children).toBe(child);
  });
});
