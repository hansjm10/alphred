import { NextResponse } from 'next/server';
import { toDashboardIntegrationError } from './dashboard-errors';

export function toErrorResponse(
  error: unknown,
): NextResponse<{ error: { code: string; message: string; details?: Record<string, unknown> } }> {
  const integrationError = toDashboardIntegrationError(error);
  return NextResponse.json(
    {
      error: {
        code: integrationError.code,
        message: integrationError.message,
        ...(integrationError.details ? { details: integrationError.details } : {}),
      },
    },
    {
      status: integrationError.status,
    },
  );
}
