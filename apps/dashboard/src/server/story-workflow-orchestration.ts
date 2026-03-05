import type {
  DashboardApproveStoryBreakdownRequest,
  DashboardApproveStoryBreakdownResult,
  DashboardGetWorkItemResult,
  DashboardListWorkItemsResult,
  DashboardMoveWorkItemStatusRequest,
  DashboardMoveWorkItemStatusResult,
  DashboardRunStoryWorkflowRequest,
  DashboardRunStoryWorkflowResult,
  DashboardRunStoryWorkflowStepResult,
  DashboardWorkItemSnapshot,
} from './dashboard-contracts';
import { DashboardIntegrationError } from './dashboard-errors';

type StoryWorkflowMode = 'default' | 'generate_only' | 'approve_only' | 'approve_and_start';

export type StoryWorkflowOrchestrationOperations = {
  getWorkItem: (params: { repositoryId: number; workItemId: number }) => Promise<DashboardGetWorkItemResult>;
  listWorkItems: (repositoryId: number) => Promise<DashboardListWorkItemsResult>;
  moveWorkItemStatus: (request: DashboardMoveWorkItemStatusRequest) => Promise<DashboardMoveWorkItemStatusResult>;
  approveStoryBreakdown: (request: DashboardApproveStoryBreakdownRequest) => Promise<DashboardApproveStoryBreakdownResult>;
};

type TaskStartFailure = {
  taskId: number;
  status: number;
  message: string;
};

function resolveMode(request: DashboardRunStoryWorkflowRequest): StoryWorkflowMode {
  if (request.approveOnly === true) {
    return 'approve_only';
  }
  if (request.approveAndStart === true) {
    return 'approve_and_start';
  }
  if (request.generateOnly === true) {
    return 'generate_only';
  }
  return 'default';
}

function requirePositiveInteger(value: number, fieldName: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new DashboardIntegrationError('invalid_request', `${fieldName} must be a positive integer.`, {
      status: 400,
    });
  }
  return value;
}

function requireNonNegativeInteger(value: number, fieldName: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new DashboardIntegrationError('invalid_request', `${fieldName} must be a non-negative integer.`, {
      status: 400,
    });
  }
  return value;
}

function assertStoryRevision(params: { story: DashboardWorkItemSnapshot; expectedRevision: number }): void {
  if (params.story.revision === params.expectedRevision) {
    return;
  }

  throw new DashboardIntegrationError(
    'conflict',
    `Work item id=${params.story.id} revision conflict (expected ${params.expectedRevision}).`,
    {
      status: 409,
      details: {
        workItemId: params.story.id,
        expectedRevision: params.expectedRevision,
        currentRevision: params.story.revision,
      },
    },
  );
}

function ensureStoryWorkItem(story: DashboardWorkItemSnapshot, storyId: number): DashboardWorkItemSnapshot {
  if (story.type === 'story') {
    return story;
  }

  throw new DashboardIntegrationError('invalid_request', `Work item id=${storyId} is not a story.`, {
    status: 400,
  });
}

function mapTaskStartFailure(taskId: number, error: unknown): TaskStartFailure {
  if (error instanceof DashboardIntegrationError) {
    return {
      taskId,
      status: error.status,
      message: error.message,
    };
  }

  throw error;
}

function createStep(step: DashboardRunStoryWorkflowStepResult['step'], outcome: DashboardRunStoryWorkflowStepResult['outcome'], message: string): DashboardRunStoryWorkflowStepResult {
  return { step, outcome, message };
}

async function loadReadyChildTasks(params: {
  repositoryId: number;
  storyId: number;
  operations: StoryWorkflowOrchestrationOperations;
}): Promise<DashboardWorkItemSnapshot[]> {
  const allWorkItems = await params.operations.listWorkItems(params.repositoryId);
  return allWorkItems.workItems.filter(item => item.type === 'task' && item.parentId === params.storyId && item.status === 'Ready');
}

export async function runStoryWorkflowOrchestration(params: {
  request: DashboardRunStoryWorkflowRequest;
  operations: StoryWorkflowOrchestrationOperations;
}): Promise<DashboardRunStoryWorkflowResult> {
  const repositoryId = requirePositiveInteger(params.request.repositoryId, 'repositoryId');
  const storyId = requirePositiveInteger(params.request.storyId, 'storyId');
  const expectedRevision = requireNonNegativeInteger(params.request.expectedRevision, 'expectedRevision');
  const actorType = params.request.actorType;
  const actorLabel = params.request.actorLabel;
  if (typeof actorLabel !== 'string' || actorLabel.length === 0) {
    throw new DashboardIntegrationError('invalid_request', 'actorLabel must be a non-empty string.', {
      status: 400,
    });
  }

  const mode = resolveMode(params.request);
  const steps: DashboardRunStoryWorkflowStepResult[] = [];
  let updatedTasks: DashboardWorkItemSnapshot[] = [];
  const startedTasks: DashboardWorkItemSnapshot[] = [];
  let approvedTasks: DashboardWorkItemSnapshot[] = [];

  const initialStory = await params.operations.getWorkItem({
    repositoryId,
    workItemId: storyId,
  });
  let story = ensureStoryWorkItem(initialStory.workItem, storyId);
  assertStoryRevision({ story, expectedRevision });

  if (mode === 'approve_only') {
    steps.push(createStep('move_to_needs_breakdown', 'skipped', 'Skipped status move in approve-only mode.'));
  } else if (story.status === 'Draft') {
    const movedStory = await params.operations.moveWorkItemStatus({
      repositoryId,
      workItemId: storyId,
      expectedRevision: story.revision,
      toStatus: 'NeedsBreakdown',
      actorType,
      actorLabel,
    });
    story = movedStory.workItem;
    steps.push(createStep('move_to_needs_breakdown', 'applied', 'Moved story to NeedsBreakdown.'));
  } else {
    steps.push(
      createStep(
        'move_to_needs_breakdown',
        'skipped',
        `Skipped status move because story is currently ${story.status}.`,
      ),
    );
  }

  if (mode === 'approve_only') {
    steps.push(createStep('generate_breakdown', 'skipped', 'Skipped breakdown generation in approve-only mode.'));
  } else if (story.status === 'NeedsBreakdown') {
    steps.push(
      createStep(
        'generate_breakdown',
        'blocked',
        'Story is waiting for a breakdown proposal. No server-side generator is configured on this route yet.',
      ),
    );
  } else {
    steps.push(
      createStep(
        'generate_breakdown',
        'skipped',
        `Skipped breakdown generation because story is currently ${story.status}.`,
      ),
    );
  }

  if (story.status === 'NeedsBreakdown') {
    steps.push(createStep('approve_breakdown', 'skipped', 'Cannot approve while story is in NeedsBreakdown.'));
    steps.push(createStep('start_ready_tasks', 'skipped', 'Cannot start tasks before breakdown approval.'));
    return {
      story,
      updatedTasks,
      startedTasks,
      steps,
    };
  }

  if (mode === 'generate_only') {
    steps.push(createStep('approve_breakdown', 'skipped', 'Skipped approval in generate-only mode.'));
    steps.push(createStep('start_ready_tasks', 'skipped', 'Skipped task start in generate-only mode.'));
    return {
      story,
      updatedTasks,
      startedTasks,
      steps,
    };
  }

  const shouldApprove = mode === 'default' || mode === 'approve_only' || mode === 'approve_and_start';
  if (!shouldApprove) {
    steps.push(createStep('approve_breakdown', 'skipped', 'Skipped approval for this mode.'));
  } else if (story.status === 'BreakdownProposed') {
    const approved = await params.operations.approveStoryBreakdown({
      repositoryId,
      storyId,
      expectedRevision: story.revision,
      actorType,
      actorLabel,
    });
    story = approved.story;
    approvedTasks = approved.tasks;
    updatedTasks = approved.tasks;
    steps.push(createStep('approve_breakdown', 'applied', 'Approved breakdown and moved child tasks to Ready.'));
  } else {
    steps.push(
      createStep(
        'approve_breakdown',
        'skipped',
        `Skipped approval because story is currently ${story.status}.`,
      ),
    );
  }

  const shouldStart = mode === 'default' || mode === 'approve_and_start';
  if (!shouldStart) {
    steps.push(createStep('start_ready_tasks', 'skipped', 'Skipped task start for this mode.'));
    return {
      story,
      updatedTasks,
      startedTasks,
      steps,
    };
  }

  if (story.status !== 'Approved') {
    steps.push(createStep('start_ready_tasks', 'skipped', `Skipped task start because story is currently ${story.status}.`));
    return {
      story,
      updatedTasks,
      startedTasks,
      steps,
    };
  }

  let readyTasks = approvedTasks.filter(task => task.type === 'task' && task.status === 'Ready');
  if (readyTasks.length === 0) {
    readyTasks = await loadReadyChildTasks({
      repositoryId,
      storyId,
      operations: params.operations,
    });
  }

  if (readyTasks.length === 0) {
    steps.push(createStep('start_ready_tasks', 'skipped', 'No Ready child tasks were found to start.'));
    return {
      story,
      updatedTasks,
      startedTasks,
      steps,
    };
  }

  const failures: TaskStartFailure[] = [];
  for (const task of readyTasks) {
    try {
      const startedTask = await params.operations.moveWorkItemStatus({
        repositoryId,
        workItemId: task.id,
        expectedRevision: task.revision,
        toStatus: 'InProgress',
        actorType,
        actorLabel,
      });
      startedTasks.push(startedTask.workItem);
    } catch (error) {
      failures.push(mapTaskStartFailure(task.id, error));
    }
  }

  if (failures.length > 0) {
    if (startedTasks.length > 0) {
      const startedById = new Map(startedTasks.map(task => [task.id, task]));
      updatedTasks = updatedTasks.map(task => startedById.get(task.id) ?? task);
      for (const startedTask of startedTasks) {
        if (!updatedTasks.some(task => task.id === startedTask.id)) {
          updatedTasks.push(startedTask);
        }
      }
    }
    steps.push({
      step: 'start_ready_tasks',
      outcome: 'partial_failure',
      message: `Started ${startedTasks.length} task(s); failed to start ${failures.length} task(s).`,
      startedTaskIds: startedTasks.map(task => task.id),
      failedTaskIds: failures.map(failure => failure.taskId),
    });
    return {
      story,
      updatedTasks,
      startedTasks,
      steps,
    };
  }

  if (startedTasks.length > 0) {
    const startedById = new Map(startedTasks.map(task => [task.id, task]));
    updatedTasks = updatedTasks.map(task => startedById.get(task.id) ?? task);
    for (const startedTask of startedTasks) {
      if (!updatedTasks.some(task => task.id === startedTask.id)) {
        updatedTasks.push(startedTask);
      }
    }
  }

  steps.push({
    step: 'start_ready_tasks',
    outcome: 'applied',
    message: `Started ${startedTasks.length} task(s).`,
    startedTaskIds: startedTasks.map(task => task.id),
  });

  return {
    story,
    updatedTasks,
    startedTasks,
    steps,
  };
}
