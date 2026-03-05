import { parseApproveStoryBreakdownRequest } from '../../../_shared/work-item-route-validation';
import { handleWorkItemActionPost, type WorkItemActionRouteContext } from '../_shared/work-item-action-route';

export async function POST(request: Request, context: WorkItemActionRouteContext): Promise<Response> {
  return handleWorkItemActionPost({
    request,
    context,
    invalidJsonMessage: 'Work item breakdown approval payload must be valid JSON.',
    objectMessage: 'Work item breakdown approval payload must be a JSON object.',
    parseRequest: parseApproveStoryBreakdownRequest,
    execute: (service, approveRequest) => service.approveStoryBreakdown(approveRequest),
  });
}
