import { hasTruncatedPreview, truncatePreview } from './formatting';
import type { ExpandablePreviewProps } from './types';

export function ExpandablePreview({
  value,
  label,
  previewLength = 140,
  className = 'meta-text',
  emptyLabel = '(no content)',
}: ExpandablePreviewProps) {
  const normalized = value.trim();
  if (normalized.length === 0) {
    return <p className={className}>{emptyLabel}</p>;
  }

  const preview = truncatePreview(normalized, previewLength);
  if (!hasTruncatedPreview(normalized, previewLength)) {
    return <p className={className}>{preview}</p>;
  }

  return (
    <div className="run-expandable-preview">
      <p className={className}>{preview}</p>
      <details className="run-expandable-preview__details">
        <summary className="run-expandable-preview__summary">{`Show full ${label}`}</summary>
        <p className={className}>{normalized}</p>
      </details>
    </div>
  );
}

