import { parseStartTaskWorkflowRequest } from '../../../_shared/work-item-route-validation';
import { handleWorkItemActionPost, type WorkItemActionRouteContext } from '../_shared/work-item-action-route';

export async function POST(request: Request, context: WorkItemActionRouteContext): Promise<Response> {
  return handleWorkItemActionPost({
    request,
    context,
    invalidJsonMessage: 'Task workflow payload must be valid JSON.',
    objectMessage: 'Task workflow payload must be a JSON object.',
    parseRequest: parseStartTaskWorkflowRequest,
    execute: (service, startRequest) => service.startTaskWorkflow(startRequest),
  });
}
