import { DASHBOARD_NOT_FOUND_CONTENT } from './not-found-content';
import { ButtonLink, Card } from './ui/primitives';

export default function NotFound() {
  return (
    <div className="page-stack">
      <Card title={DASHBOARD_NOT_FOUND_CONTENT.title}>
        <p>{DASHBOARD_NOT_FOUND_CONTENT.message}</p>
        <div className="action-row">
          <ButtonLink href="/">{DASHBOARD_NOT_FOUND_CONTENT.homeLabel}</ButtonLink>
        </div>
      </Card>
    </div>
  );
}
