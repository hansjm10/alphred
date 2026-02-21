import { NextResponse } from 'next/server';
import { toErrorResponse } from '../../../../src/server/dashboard-http';
import type { DashboardCreateWorkflowRequest, DashboardWorkflowTemplateKey } from '../../../../src/server/dashboard-contracts';
import { DashboardIntegrationError } from '../../../../src/server/dashboard-errors';
import { createDashboardService } from '../../../../src/server/dashboard-service';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseCreateWorkflowRequest(payload: unknown): DashboardCreateWorkflowRequest {
  if (!isRecord(payload)) {
    throw new DashboardIntegrationError('invalid_request', 'Workflow creation payload must be a JSON object.', {
      status: 400,
    });
  }

  const template = payload.template;
  if (template !== 'design-implement-review' && template !== 'blank') {
    throw new DashboardIntegrationError('invalid_request', 'Workflow template is invalid.', {
      status: 400,
      details: { field: 'template' },
    });
  }

  if (typeof payload.name !== 'string') {
    throw new DashboardIntegrationError('invalid_request', 'Workflow name must be a string.', {
      status: 400,
      details: { field: 'name' },
    });
  }

  if (typeof payload.treeKey !== 'string') {
    throw new DashboardIntegrationError('invalid_request', 'Workflow treeKey must be a string.', {
      status: 400,
      details: { field: 'treeKey' },
    });
  }

  const description =
    payload.description === undefined
      ? undefined
      : typeof payload.description === 'string'
        ? payload.description
        : (() => {
            throw new DashboardIntegrationError('invalid_request', 'Workflow description must be a string when provided.', {
              status: 400,
              details: { field: 'description' },
            });
          })();

  return {
    template: template satisfies DashboardWorkflowTemplateKey,
    name: payload.name,
    treeKey: payload.treeKey,
    ...(description === undefined ? {} : { description }),
  };
}

export async function GET(): Promise<Response> {
  const service = createDashboardService();

  try {
    const workflows = await service.listWorkflowTrees();
    return NextResponse.json({ workflows });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  const service = createDashboardService();

  try {
    const payload = parseCreateWorkflowRequest(await request.json());
    const workflow = await service.createWorkflowDraft(payload);
    return NextResponse.json({ workflow }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
