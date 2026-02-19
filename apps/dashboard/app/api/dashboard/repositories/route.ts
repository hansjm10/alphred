import { NextResponse } from 'next/server';
import type { DashboardCreateRepositoryRequest } from '../../../../src/server/dashboard-contracts';
import { DashboardIntegrationError } from '../../../../src/server/dashboard-errors';
import { toErrorResponse } from '../../../../src/server/dashboard-http';
import { createDashboardService } from '../../../../src/server/dashboard-service';

function parseCreateRepositoryRequest(payload: unknown): DashboardCreateRepositoryRequest {
  if (typeof payload !== 'object' || payload === null) {
    throw new DashboardIntegrationError('invalid_request', 'Repository create request body must be an object.', {
      status: 400,
    });
  }

  const candidate = payload as Record<string, unknown>;
  const nameValue = candidate.name;
  if (typeof nameValue !== 'string') {
    throw new DashboardIntegrationError('invalid_request', 'Repository create requires string field "name".', {
      status: 400,
    });
  }

  const providerValue = candidate.provider;
  if (providerValue !== 'github') {
    throw new DashboardIntegrationError('invalid_request', 'Field "provider" must be "github".', {
      status: 400,
    });
  }

  const remoteRefValue = candidate.remoteRef;
  if (typeof remoteRefValue !== 'string') {
    throw new DashboardIntegrationError('invalid_request', 'Repository create requires string field "remoteRef".', {
      status: 400,
    });
  }

  return {
    name: nameValue,
    provider: providerValue,
    remoteRef: remoteRefValue,
  };
}

export async function GET(): Promise<Response> {
  const service = createDashboardService();

  try {
    const repositories = await service.listRepositories();
    return NextResponse.json({ repositories });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  const service = createDashboardService();

  try {
    const payload: unknown = await request.json();
    const createRequest = parseCreateRepositoryRequest(payload);
    const result = await service.createRepository(createRequest);
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
