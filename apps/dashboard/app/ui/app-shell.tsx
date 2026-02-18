'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import type { GitHubAuthGate } from './github-auth';
import { PRIMARY_NAV_ITEMS } from './navigation';
import { ActionButton, ButtonLink, StatusBadge } from './primitives';

type AppShellProps = Readonly<{
  children: ReactNode;
  authGate: GitHubAuthGate;
}>;

function isActivePath(pathname: string, href: string): boolean {
  if (href === '/') {
    return pathname === '/';
  }

  return pathname === href || pathname.startsWith(`${href}/`);
}

export default function AppShell({ children, authGate }: AppShellProps) {
  const pathname = usePathname() ?? '/';
  const activeNav =
    PRIMARY_NAV_ITEMS.find((item) => isActivePath(pathname, item.href)) ??
    PRIMARY_NAV_ITEMS[0];
  let launchAction: ReactNode;
  if (authGate.canMutate) {
    launchAction = (
      <ButtonLink href="/runs" tone="primary">
        Launch Run
      </ButtonLink>
    );
  } else if (authGate.state === 'checking') {
    launchAction = (
      <ActionButton tone="primary" disabled aria-disabled="true">
        Checking auth...
      </ActionButton>
    );
  } else {
    launchAction = (
      <ButtonLink href="/settings/integrations" tone="primary">
        Connect GitHub
      </ButtonLink>
    );
  }

  return (
    <div className="dashboard-shell">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>

      <aside className="shell-rail" aria-label="Primary shell">
        <div className="shell-brand">
          <Link href="/" aria-label="Alphred home">
            Alphred
          </Link>
          <p>Operator Console</p>
        </div>

        <nav aria-label="Primary navigation">
          <ul className="shell-nav-list">
            {PRIMARY_NAV_ITEMS.map((item) => {
              const active = isActivePath(pathname, item.href);

              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className={`shell-nav-link${active ? ' shell-nav-link--active' : ''}`}
                    aria-current={active ? 'page' : undefined}
                  >
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      </aside>

      <div className="shell-main">
        <header className="shell-topbar" role="banner">
          <div>
            <p className="shell-kicker">Dashboard</p>
            <h1>{activeNav.label}</h1>
          </div>

          <div className="shell-topbar-actions">
            <StatusBadge status={authGate.badge.status} label={authGate.badge.label} />
            {launchAction}
          </div>
        </header>

        <main id="main-content" className="shell-content">
          {children}
        </main>
      </div>
    </div>
  );
}
