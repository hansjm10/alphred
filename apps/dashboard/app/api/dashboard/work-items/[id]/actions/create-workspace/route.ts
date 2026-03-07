import { parseCreateStoryWorkspaceRequest } from '../../../_shared/work-item-route-validation';
import { handleWorkItemActionPost, type WorkItemActionRouteContext } from '../_shared/work-item-action-route';

export async function POST(request: Request, context: WorkItemActionRouteContext): Promise<Response> {
  return handleWorkItemActionPost({
    request,
    context,
    invalidJsonMessage: 'Story workspace payload must be valid JSON.',
    objectMessage: 'Story workspace payload must be a JSON object.',
    parseRequest: parseCreateStoryWorkspaceRequest,
    execute: (service, createRequest) => service.createStoryWorkspace(createRequest),
  });
}
