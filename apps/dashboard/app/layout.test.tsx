import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import RootLayout from './layout';
import AppShell from './ui/app-shell';
import { createGitHubAuthGate, type GitHubAuthGate } from './ui/github-auth';
import { loadGitHubAuthGate } from './ui/load-github-auth-gate';

vi.mock('./ui/load-github-auth-gate', () => ({
  loadGitHubAuthGate: vi.fn(),
}));

describe('RootLayout', () => {
  it('wraps children in html/body and injects the shared app shell', async () => {
    const authGate = createGitHubAuthGate({
      authenticated: true,
      user: 'octocat',
      scopes: ['repo'],
      error: null,
    });
    vi.mocked(loadGitHubAuthGate).mockResolvedValue(authGate);

    const child = <div>dashboard content</div>;

    const root = (await RootLayout({ children: child })) as ReactElement<{
      lang: string;
      children: ReactElement;
    }>;

    expect(root.type).toBe('html');
    expect(root.props.lang).toBe('en');

    const body = root.props.children as ReactElement<{ children: ReactElement }>;
    expect(body.type).toBe('body');

    const shell = body.props.children as ReactElement<{ children: ReactElement; authGate: GitHubAuthGate }>;
    expect(shell.type).toBe(AppShell);
    expect(shell.props.children).toBe(child);
    expect(shell.props.authGate).toEqual(authGate);
  });
});
