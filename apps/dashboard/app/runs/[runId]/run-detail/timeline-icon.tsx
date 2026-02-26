import type { TimelineCategory } from './types';

export function TimelineCategoryIcon({ category }: Readonly<{ category: TimelineCategory }>) {
  const iconProps = {
    'aria-hidden': true as const,
    focusable: 'false' as const,
    className: 'timeline-category-icon',
    width: 10,
    height: 10,
    viewBox: '0 0 10 10',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };

  switch (category) {
    case 'lifecycle':
      return <svg {...iconProps}><circle cx="5" cy="5" r="3.5" /></svg>;
    case 'node':
      return <svg {...iconProps}><path d="M2 5h6M6 3l2 2-2 2" /></svg>;
    case 'artifact':
      return <svg {...iconProps}><rect x="2" y="1.5" width="6" height="7" rx="1" /></svg>;
    case 'diagnostics':
      return <svg {...iconProps}><path d="M5 1.5L8.5 8H1.5z" /></svg>;
    case 'routing':
      return <svg {...iconProps}><path d="M5 1l3.5 4L5 9 1.5 5z" /></svg>;
  }
}
