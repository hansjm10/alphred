import { NextResponse } from 'next/server';
import { toDashboardIntegrationError } from './dashboard-errors';

export function toErrorResponse(error: unknown): NextResponse<{ error: { code: string; message: string } }> {
  const integrationError = toDashboardIntegrationError(error);
  return NextResponse.json(
    {
      error: {
        code: integrationError.code,
        message: integrationError.message,
      },
    },
    {
      status: integrationError.status,
    },
  );
}
