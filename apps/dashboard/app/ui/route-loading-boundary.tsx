import { Card } from './primitives';

export type RouteLoadingBoundaryProps = Readonly<{
  title: string;
  message: string;
}>;

export function RouteLoadingBoundary({ title, message }: RouteLoadingBoundaryProps) {
  return (
    <div className="page-stack">
      <Card title={title}>
        <output aria-live="polite">{message}</output>
      </Card>
    </div>
  );
}
