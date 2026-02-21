import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { connection } from 'next/server';
import './globals.css';
import AppShell from './ui/app-shell';
import { loadGitHubAuthGate } from './ui/load-github-auth-gate';

export const metadata: Metadata = {
  title: 'Alphred Dashboard',
  description: 'LLM Agent Orchestrator dashboard',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

type RootLayoutProps = Readonly<{
  children: ReactNode;
}>;

export default async function RootLayout({ children }: RootLayoutProps) {
  await connection();
  const authGate = await loadGitHubAuthGate();

  return (
    <html lang="en">
      <body>
        <AppShell authGate={authGate}>{children}</AppShell>
      </body>
    </html>
  );
}
