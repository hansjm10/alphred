import Link from 'next/link';
import type { ComponentPropsWithoutRef, ReactNode } from 'react';

type SurfaceTone = 'default' | 'subtle';
export type StatusVariant =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'paused'
  | 'skipped'
  | 'cancelled';
type ButtonTone = 'primary' | 'secondary';

type CardProps = ComponentPropsWithoutRef<'section'> & {
  title?: string;
  description?: string;
  tone?: SurfaceTone;
};

type PanelProps = ComponentPropsWithoutRef<'aside'> & {
  title?: string;
  description?: string;
  tone?: SurfaceTone;
};

type StatusBadgeProps = Readonly<{
  status: StatusVariant;
  label?: string;
  className?: string;
}>;

type ButtonLinkProps = ComponentPropsWithoutRef<typeof Link> & {
  tone?: ButtonTone;
};

type ActionButtonProps = ComponentPropsWithoutRef<'button'> & {
  tone?: ButtonTone;
};

export type TabItem = Readonly<{
  href: string;
  label: string;
}>;

type TabsProps = Readonly<{
  items: readonly TabItem[];
  activeHref: string;
  ariaLabel?: string;
}>;

const STATUS_LABELS: Record<StatusVariant, string> = {
  pending: 'Pending',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  paused: 'Paused',
  skipped: 'Skipped',
  cancelled: 'Cancelled',
};

function classNames(...parts: (string | undefined | false)[]): string {
  return parts.filter(Boolean).join(' ');
}

function isActiveHref(pathname: string, href: string): boolean {
  if (href === '/') {
    return pathname === '/';
  }

  return pathname === href || pathname.startsWith(`${href}/`);
}

function SurfaceHeader({
  title,
  description,
}: Readonly<{ title?: string; description?: string }>): ReactNode {
  if (!title && !description) {
    return null;
  }

  return (
    <header className="surface-header">
      {title ? <h3>{title}</h3> : null}
      {description ? <p>{description}</p> : null}
    </header>
  );
}

function StatusIcon({ status }: Readonly<{ status: StatusVariant }>) {
  const common = {
    className: 'status-badge__icon',
    width: 14,
    height: 14,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    focusable: false,
  };

  switch (status) {
    case 'pending':
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="5" />
        </svg>
      );
    case 'running':
      return (
        <svg {...common}>
          <path d="M3 8h7" />
          <path d="M8 5l3 3-3 3" />
        </svg>
      );
    case 'completed':
      return (
        <svg {...common}>
          <path d="M3.5 8.5l2.5 2.5 6.5-6.5" />
        </svg>
      );
    case 'failed':
      return (
        <svg {...common}>
          <path d="M5 5l6 6" />
          <path d="M11 5l-6 6" />
        </svg>
      );
    case 'paused':
      return (
        <svg {...common}>
          <path d="M6 5v6" />
          <path d="M10 5v6" />
        </svg>
      );
    case 'skipped':
      return (
        <svg {...common}>
          <path d="M4 8h8" />
        </svg>
      );
    case 'cancelled':
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="5" />
          <path d="M8 5.25v4.25" />
          <path d="M8 11.5h0.01" />
        </svg>
      );
  }
}

export function Card({
  title,
  description,
  tone = 'default',
  className,
  children,
  ...rest
}: CardProps) {
  return (
    <section
      className={classNames('surface', 'surface-card', `surface--${tone}`, className)}
      {...rest}
    >
      <SurfaceHeader title={title} description={description} />
      {children}
    </section>
  );
}

export function Panel({
  title,
  description,
  tone = 'subtle',
  className,
  children,
  ...rest
}: PanelProps) {
  return (
    <aside
      className={classNames('surface', 'surface-panel', `surface--${tone}`, className)}
      {...rest}
    >
      <SurfaceHeader title={title} description={description} />
      {children}
    </aside>
  );
}

export function StatusBadge({ status, label, className }: StatusBadgeProps) {
  return (
    <span
      className={classNames('status-badge', `status-badge--${status}`, className)}
      data-status={status}
    >
      <StatusIcon status={status} />
      <span>{label ?? STATUS_LABELS[status]}</span>
    </span>
  );
}

export function ButtonLink({ tone = 'secondary', className, ...rest }: ButtonLinkProps) {
  return (
    <Link
      className={classNames('button-link', `button-link--${tone}`, className)}
      {...rest}
    />
  );
}

export function ActionButton({
  tone = 'secondary',
  className,
  type = 'button',
  ...rest
}: ActionButtonProps) {
  return (
    <button
      className={classNames('button-link', `button-link--${tone}`, className)}
      type={type}
      {...rest}
    />
  );
}

export function Tabs({ items, activeHref, ariaLabel = 'Tabs' }: TabsProps) {
  return (
    <nav aria-label={ariaLabel} className="tabs">
      <ul>
        {items.map((item) => {
          const active = isActiveHref(activeHref, item.href);

          return (
            <li key={item.href}>
              <Link
                href={item.href}
                className={classNames('tabs__link', active && 'tabs__link--active')}
                aria-current={active ? 'page' : undefined}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
