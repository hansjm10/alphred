'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { PRIMARY_NAV_ITEMS } from './navigation';
import { ButtonLink, StatusBadge } from './primitives';

type AppShellProps = Readonly<{
  children: ReactNode;
}>;

function isActivePath(pathname: string, href: string): boolean {
  if (href === '/') {
    return pathname === '/';
  }

  return pathname === href || pathname.startsWith(`${href}/`);
}

export default function AppShell({ children }: AppShellProps) {
  const pathname = usePathname() ?? '/';
  const activeNav =
    PRIMARY_NAV_ITEMS.find((item) => isActivePath(pathname, item.href)) ??
    PRIMARY_NAV_ITEMS[0];

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
            <StatusBadge status="running" label="System ready" />
            <ButtonLink href="/runs" tone="primary">
              Launch Run
            </ButtonLink>
          </div>
        </header>

        <main id="main-content" className="shell-content">
          {children}
        </main>
      </div>
    </div>
  );
}
