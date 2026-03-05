import { parseProposeStoryBreakdownRequest } from '../../../_shared/work-item-route-validation';
import { handleWorkItemActionPost, type WorkItemActionRouteContext } from '../_shared/work-item-action-route';

export async function POST(request: Request, context: WorkItemActionRouteContext): Promise<Response> {
  return handleWorkItemActionPost({
    request,
    context,
    invalidJsonMessage: 'Work item breakdown proposal payload must be valid JSON.',
    objectMessage: 'Work item breakdown proposal payload must be a JSON object.',
    parseRequest: parseProposeStoryBreakdownRequest,
    execute: (service, proposeRequest) => service.proposeStoryBreakdown(proposeRequest),
  });
}
