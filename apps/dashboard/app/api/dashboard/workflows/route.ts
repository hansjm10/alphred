import { NextResponse } from 'next/server';
import { toErrorResponse } from '@dashboard/server/dashboard-http';
import type { DashboardCreateWorkflowRequest, DashboardWorkflowTemplateKey } from '@dashboard/server/dashboard-contracts';
import { DashboardIntegrationError } from '@dashboard/server/dashboard-errors';
import { createDashboardService } from '@dashboard/server/dashboard-service';
import { optionalStringField, requireRecord, requireStringField } from './_shared/validation';

function parseCreateWorkflowRequest(payload: unknown): DashboardCreateWorkflowRequest {
  const record = requireRecord(payload, 'Workflow creation payload must be a JSON object.');

  const template = record.template;
  if (template !== 'design-implement-review' && template !== 'blank') {
    throw new DashboardIntegrationError('invalid_request', 'Workflow template is invalid.', {
      status: 400,
      details: { field: 'template' },
    });
  }

  const name = requireStringField(record, 'name', 'Workflow name must be a string.');

  const treeKey = requireStringField(record, 'treeKey', 'Workflow treeKey must be a string.');

  const description = optionalStringField(record, 'description', 'Workflow description must be a string when provided.');

  return {
    template: template satisfies DashboardWorkflowTemplateKey,
    name,
    treeKey,
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
