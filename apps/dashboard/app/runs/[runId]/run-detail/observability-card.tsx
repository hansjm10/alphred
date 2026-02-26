import { Card } from '../../../ui/primitives';
import type { DashboardRunDetail } from '../../../../src/server/dashboard-contracts';
import { ExpandablePreview } from './expandable-preview';
import { RUN_DETAIL_SECTION_IDS } from './section-navigation.js';
import { partitionByRecency } from './timeline';
import { RUN_OBSERVABILITY_RECENT_ENTRY_COUNT } from './types';

export function resolvePayloadStorageSummary(diagnostics: DashboardRunDetail['diagnostics'][number]): string {
  if (!diagnostics.truncated && !diagnostics.redacted) {
    return 'Payload stored without truncation.';
  }

  const normalizationActions: string[] = [];
  if (diagnostics.redacted) {
    normalizationActions.push('redaction');
  }
  if (diagnostics.truncated) {
    normalizationActions.push('truncation');
  }

  return `Payload normalized with ${normalizationActions.join(' and ')}.`;
}


type RunObservabilityCardProps = Readonly<{
  detail: DashboardRunDetail;
}>;

export function RunObservabilityCard({ detail }: RunObservabilityCardProps) {
  const artifactPartition = partitionByRecency(detail.artifacts, RUN_OBSERVABILITY_RECENT_ENTRY_COUNT, 'newest-first');
  const diagnosticsPartition = partitionByRecency(
    detail.diagnostics,
    RUN_OBSERVABILITY_RECENT_ENTRY_COUNT,
    'newest-first',
  );

  const renderDiagnosticsEntry = (
    diagnostics: DashboardRunDetail['diagnostics'][number],
  ) => {
    const node = detail.nodes.find((candidate) => candidate.id === diagnostics.runNodeId);
    const nodeLabel = node ? `${node.nodeKey} (attempt ${diagnostics.attempt})` : `Node #${diagnostics.runNodeId}`;
    const payloadStorageSummary = resolvePayloadStorageSummary(diagnostics);

    return (
      <li key={diagnostics.id}>
        <p>{`${nodeLabel}: ${diagnostics.outcome}`}</p>
        <p className="meta-text">
          {`Events ${diagnostics.retainedEventCount}/${diagnostics.eventCount}; tools ${diagnostics.diagnostics.summary.toolEventCount}; tokens ${diagnostics.diagnostics.summary.tokensUsed}.`}
        </p>
        <p className="meta-text">{payloadStorageSummary}</p>
        {diagnostics.diagnostics.error ? (
          <ExpandablePreview
            value={`Failure: ${diagnostics.diagnostics.error.classification} (${diagnostics.diagnostics.error.message}).`}
            label="failure diagnostics"
          />
        ) : null}
        {diagnostics.diagnostics.toolEvents.length > 0 ? (
          <ExpandablePreview
            value={`Tool activity: ${diagnostics.diagnostics.toolEvents.map(event => event.summary).join('; ')}`}
            label="tool activity"
          />
        ) : null}
      </li>
    );
  };

  return (
    <Card title="Observability" headingId={RUN_DETAIL_SECTION_IDS.observability}>
      <section className="run-observability-section">
        <p className="meta-text">Artifacts</p>
        {detail.artifacts.length === 0 ? <p>No artifacts captured yet.</p> : null}
        <ul className="page-stack run-observability-list" aria-label="Run artifacts">
          {artifactPartition.recent.map((artifact) => {
            const node = detail.nodes.find((candidate) => candidate.id === artifact.runNodeId);
            const nodeLabel = node ? node.nodeKey : `node-${artifact.runNodeId}`;
            return (
              <li key={artifact.id}>
                <p>{`${nodeLabel} · ${artifact.artifactType} (${artifact.contentType})`}</p>
                <ExpandablePreview value={artifact.contentPreview} label="artifact preview" />
              </li>
            );
          })}
          {artifactPartition.earlier.length > 0 ? (
            <li>
              <details className="run-collapsible-history">
                <summary className="run-collapsible-history__summary">
                  {`Show ${artifactPartition.earlier.length} earlier artifacts`}
                </summary>
                <ul className="page-stack run-collapsible-history__list" aria-label="Earlier run artifacts">
                  {artifactPartition.earlier.map((artifact) => {
                    const node = detail.nodes.find((candidate) => candidate.id === artifact.runNodeId);
                    const nodeLabel = node ? node.nodeKey : `node-${artifact.runNodeId}`;
                    return (
                      <li key={`older-${artifact.id}`}>
                        <p>{`${nodeLabel} · ${artifact.artifactType} (${artifact.contentType})`}</p>
                        <ExpandablePreview value={artifact.contentPreview} label="artifact preview" />
                      </li>
                    );
                  })}
                </ul>
              </details>
            </li>
          ) : null}
        </ul>
      </section>

      <section className="run-observability-section">
        <p className="meta-text">Node diagnostics</p>
        {detail.diagnostics.length === 0 ? <p>No node diagnostics captured yet.</p> : null}
        <ul className="page-stack run-observability-list" aria-label="Run node diagnostics">
          {diagnosticsPartition.recent.map((diagnostics) => renderDiagnosticsEntry(diagnostics))}
          {diagnosticsPartition.earlier.length > 0 ? (
            <li>
              <details className="run-collapsible-history">
                <summary className="run-collapsible-history__summary">
                  {`Show ${diagnosticsPartition.earlier.length} earlier diagnostics`}
                </summary>
                <ul className="page-stack run-collapsible-history__list" aria-label="Earlier run node diagnostics">
                  {diagnosticsPartition.earlier.map((diagnostics) => renderDiagnosticsEntry(diagnostics))}
                </ul>
              </details>
            </li>
          ) : null}
        </ul>
      </section>

      <section className="run-observability-section">
        <p className="meta-text">Routing decisions</p>
        {detail.routingDecisions.length === 0 ? <p>No routing decisions captured yet.</p> : null}
        <ul className="page-stack run-observability-list" aria-label="Run routing decisions">
          {detail.routingDecisions.map((decision) => (
            <li key={decision.id}>
              <p>{decision.decisionType}</p>
              <p className="meta-text">{decision.rationale ?? 'No rationale provided.'}</p>
            </li>
          ))}
        </ul>
      </section>
    </Card>
  );
}
