import { DashboardIntegrationError } from '../../../../../src/server/dashboard-errors';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function requireRecord(payload: unknown, message: string): Record<string, unknown> {
  if (!isRecord(payload)) {
    throw new DashboardIntegrationError('invalid_request', message, { status: 400 });
  }

  return payload;
}

export function requireStringField(payload: Record<string, unknown>, field: string, message: string): string {
  if (typeof payload[field] !== 'string') {
    throw new DashboardIntegrationError('invalid_request', message, {
      status: 400,
      details: { field },
    });
  }

  return payload[field];
}

export function optionalStringField(payload: Record<string, unknown>, field: string, message: string): string | undefined {
  const value = payload[field];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string') {
    throw new DashboardIntegrationError('invalid_request', message, {
      status: 400,
      details: { field },
    });
  }

  return value;
}

export function parsePositiveIntegerQueryParam(request: Request, name: string, message: string): number {
  const url = new URL(request.url);
  const raw = url.searchParams.get(name);
  const parsed = raw ? Number(raw) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new DashboardIntegrationError('invalid_request', message, { status: 400 });
  }

  return parsed;
}
