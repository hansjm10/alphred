export type ApiErrorEnvelope = {
  error?: {
    message?: string;
  };
};

function trimHyphens(value: string): string {
  let start = 0;
  while (start < value.length && value[start] === '-') {
    start += 1;
  }

  let end = value.length;
  while (end > start && value[end - 1] === '-') {
    end -= 1;
  }

  return start === 0 && end === value.length ? value : value.slice(start, end);
}

export function slugifyKey(value: string, maxLength: number): string {
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) return '';

  return trimHyphens(normalized.replace(/[^a-z0-9]+/g, '-')).slice(0, maxLength);
}

export function resolveApiError(status: number, payload: unknown, fallback: string): string {
  if (
    typeof payload === 'object' &&
    payload !== null &&
    'error' in payload &&
    typeof (payload as ApiErrorEnvelope).error === 'object' &&
    (payload as ApiErrorEnvelope).error !== null &&
    typeof (payload as ApiErrorEnvelope).error?.message === 'string'
  ) {
    return (payload as ApiErrorEnvelope).error?.message as string;
  }

  return `${fallback} (HTTP ${status}).`;
}
