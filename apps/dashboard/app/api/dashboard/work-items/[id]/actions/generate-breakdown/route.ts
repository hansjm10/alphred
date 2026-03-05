import { NextResponse } from 'next/server';
import { toErrorResponse } from '@dashboard/server/dashboard-http';
import { createDashboardService } from '@dashboard/server/dashboard-service';
import {
  parseGenerateStoryBreakdownDraftRequest,
  parseJsonObjectBody,
  parseWorkItemIdFromPathSegment,
} from '../../../_shared/work-item-route-validation';

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

async function resolveStoryId(context: RouteContext): Promise<number> {
  const params = await context.params;
  return parseWorkItemIdFromPathSegment(params.id);
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const service = createDashboardService();

  try {
    const storyId = await resolveStoryId(context);
    const payload = await parseJsonObjectBody(request, {
      invalidJsonMessage: 'Work item breakdown generation payload must be valid JSON.',
      objectMessage: 'Work item breakdown generation payload must be a JSON object.',
    });
    const generateRequest = parseGenerateStoryBreakdownDraftRequest(payload, storyId);
    const result = await service.generateStoryBreakdownDraft(generateRequest);
    return NextResponse.json(result);
  } catch (error) {
    return toErrorResponse(error);
  }
}
