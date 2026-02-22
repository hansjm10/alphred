export type ApiErrorEnvelope = {
  error?: {
    message?: string;
  };
};

function isSlugChar(value: string): boolean {
  if (value.length !== 1) return false;
  const codePoint = value.codePointAt(0);
  if (codePoint === undefined) return false;
  return (codePoint >= 97 && codePoint <= 122) || (codePoint >= 48 && codePoint <= 57);
}

export function slugifyKey(value: string, maxLength: number): string {
  if (maxLength <= 0) return '';

  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) return '';

  let slug = '';
  let pendingHyphen = false;

  for (const char of normalized) {
    if (isSlugChar(char)) {
      if (pendingHyphen && slug.length < maxLength) {
        slug += '-';
      }
      pendingHyphen = false;

      if (slug.length < maxLength) {
        slug += char;
      }
      continue;
    }

    if (slug.length > 0) {
      pendingHyphen = true;
    }
  }

  return slug;
}

export function resolveApiError(status: number, payload: unknown, fallback: string): string {
  if (typeof payload === 'object' && payload !== null && 'error' in payload) {
    const error = (payload as ApiErrorEnvelope).error;
    if (typeof error === 'object' && error !== null && typeof error.message === 'string') {
      return error.message;
    }
  }

  return `${fallback} (HTTP ${status}).`;
}
