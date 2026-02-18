import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import AppShell from './ui/app-shell';

export const metadata: Metadata = {
  title: 'Alphred Dashboard',
  description: 'LLM Agent Orchestrator dashboard',
};

type RootLayoutProps = Readonly<{
  children: ReactNode;
}>;

export default function RootLayout({ children }: RootLayoutProps) {
  return (
    <html lang="en">
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
