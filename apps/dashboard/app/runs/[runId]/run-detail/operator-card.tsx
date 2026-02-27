import { ActionButton, ButtonLink, Card, StatusBadge } from '../../../ui/primitives';
import type { DashboardRunControlAction, DashboardRunDetail } from '../../../../src/server/dashboard-contracts';
import { resolveActionButtonLabel, triggerRunControlAction } from './actions';
import { formatLastUpdated, formatTimelineTime } from './formatting';
import type { OperatorActionState, RealtimeChannelState, TimelineItem } from './types';

type RunOperatorFocusCardProps = Readonly<{
  detail: DashboardRunDetail;
  latestTimelineEvent: TimelineItem | null;
  hasHydrated: boolean;
  headingId?: string;
  primaryAction: OperatorActionState;
  secondaryAction: OperatorActionState | null;
  pendingControlAction: DashboardRunControlAction | null;
  actionHint: string | null;
  actionHintTone: 'info' | 'success' | 'error';
  channelState: RealtimeChannelState;
  realtimeLabel: {
    badgeLabel: string;
    detail: string;
  };
  lastUpdatedAtMs: number;
  isRefreshing: boolean;
  updateError: string | null;
  onRunControlAction: (action: DashboardRunControlAction) => Promise<void>;
}>;

export function RunOperatorFocusCard({
  detail,
  latestTimelineEvent,
  hasHydrated,
  headingId,
  primaryAction,
  secondaryAction,
  pendingControlAction,
  actionHint,
  actionHintTone,
  channelState,
  realtimeLabel,
  lastUpdatedAtMs,
  isRefreshing,
  updateError,
  onRunControlAction,
}: RunOperatorFocusCardProps) {
  return (
    <Card
      title="Operator focus"
      description="Current run status, latest event, and next likely operator action."
      headingId={headingId}
      className="run-operator-focus"
    >
      <ul className="entity-list run-operator-focus-list">
        <li>
          <span>Current status</span>
          <StatusBadge status={detail.run.status} />
        </li>
        <li>
          <span>Latest event</span>
          {latestTimelineEvent ? (
            <div className="run-operator-focus-list__value">
              <p>{latestTimelineEvent.summary}</p>
              <p className="meta-text">{formatTimelineTime(latestTimelineEvent.timestamp, hasHydrated)}</p>
            </div>
          ) : (
            <span className="meta-text">No lifecycle events captured yet.</span>
          )}
        </li>
        <li>
          <span>Next action</span>
          <span className="meta-text">{primaryAction.label}</span>
        </li>
      </ul>

      <div className="action-row run-detail-primary-actions">
        {primaryAction.href ? (
          <ButtonLink href={primaryAction.href} tone="primary">
            {primaryAction.label}
          </ButtonLink>
        ) : (
          <ActionButton
            tone="primary"
            disabled={primaryAction.disabledReason !== null || pendingControlAction !== null}
            aria-disabled={primaryAction.disabledReason !== null || pendingControlAction !== null}
            title={primaryAction.disabledReason ?? undefined}
            onClick={() => {
              triggerRunControlAction({
                action: primaryAction.controlAction,
                onRunControlAction,
              });
            }}
          >
            {resolveActionButtonLabel({
              action: primaryAction,
              pendingControlAction,
            })}
          </ActionButton>
        )}
        {secondaryAction ? (
          <ActionButton
            disabled={secondaryAction.disabledReason !== null || pendingControlAction !== null}
            aria-disabled={secondaryAction.disabledReason !== null || pendingControlAction !== null}
            title={secondaryAction.disabledReason ?? undefined}
            onClick={() => {
              triggerRunControlAction({
                action: secondaryAction.controlAction,
                onRunControlAction,
              });
            }}
          >
            {resolveActionButtonLabel({
              action: secondaryAction,
              pendingControlAction,
            })}
          </ActionButton>
        ) : null}
        <ButtonLink href="/runs">Back to Runs</ButtonLink>
      </div>
      {actionHint ? (
        <output className={`run-action-feedback run-action-feedback--${actionHintTone}`} aria-live="polite">
          {actionHint}
        </output>
      ) : null}

      <output className={`run-realtime-status run-realtime-status--${channelState}`} aria-live="polite">
        <span className="run-realtime-status__badge">{realtimeLabel.badgeLabel}</span>
        <span className="meta-text">{realtimeLabel.detail}</span>
        <span className="meta-text">
          {`Last updated ${formatLastUpdated(lastUpdatedAtMs, hasHydrated)}.`}
          {isRefreshing ? ' Refreshing timeline...' : ''}
        </span>
      </output>

      {updateError && (channelState === 'reconnecting' || channelState === 'stale') ? (
        <output className="run-realtime-warning" aria-live="polite">
          {`Update channel degraded: ${updateError}`}
        </output>
      ) : null}
    </Card>
  );
}
