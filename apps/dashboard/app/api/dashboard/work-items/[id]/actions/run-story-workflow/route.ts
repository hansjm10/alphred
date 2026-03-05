import { parseRunStoryWorkflowRequest } from '../../../_shared/work-item-route-validation';
import { handleWorkItemActionPost, type WorkItemActionRouteContext } from '../_shared/work-item-action-route';

export async function POST(request: Request, context: WorkItemActionRouteContext): Promise<Response> {
  return handleWorkItemActionPost({
    request,
    context,
    invalidJsonMessage: 'Story workflow payload must be valid JSON.',
    objectMessage: 'Story workflow payload must be a JSON object.',
    parseRequest: parseRunStoryWorkflowRequest,
    execute: (service, runRequest) => service.runStoryWorkflow(runRequest),
  });
}
