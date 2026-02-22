export type PrimaryNavItem = Readonly<{
  href: string;
  label: string;
}>;

export const PRIMARY_NAV_ITEMS: readonly PrimaryNavItem[] = [
  { href: '/', label: 'Overview' },
  { href: '/repositories', label: 'Repositories' },
  { href: '/workflows', label: 'Workflows' },
  { href: '/runs', label: 'Runs' },
  { href: '/settings/integrations', label: 'Integrations' },
];
