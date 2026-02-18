import Link from 'next/link';
import type { ComponentPropsWithoutRef, ReactNode } from 'react';

type SurfaceTone = 'default' | 'subtle';
export type StatusVariant = 'pending' | 'running' | 'completed' | 'failed' | 'paused';
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

const STATUS_VARIANTS: Record<StatusVariant, { icon: string; label: string }> = {
  pending: { icon: 'o', label: 'Pending' },
  running: { icon: '>', label: 'Running' },
  completed: { icon: '*', label: 'Completed' },
  failed: { icon: 'x', label: 'Failed' },
  paused: { icon: '||', label: 'Paused' },
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
  const variant = STATUS_VARIANTS[status];

  return (
    <span
      className={classNames('status-badge', `status-badge--${status}`, className)}
      data-status={status}
    >
      <span className="status-badge__icon" aria-hidden="true">
        {variant.icon}
      </span>
      <span>{label ?? variant.label}</span>
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
