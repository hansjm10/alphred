export const workItemTypes = ['epic', 'feature', 'story', 'task'] as const;
export type WorkItemType = (typeof workItemTypes)[number];

export const epicWorkItemStatuses = ['Draft', 'Approved', 'InProgress', 'Blocked', 'InReview', 'Done'] as const;
export type EpicWorkItemStatus = (typeof epicWorkItemStatuses)[number];

export const featureWorkItemStatuses = ['Draft', 'Approved', 'InProgress', 'Blocked', 'InReview', 'Done'] as const;
export type FeatureWorkItemStatus = (typeof featureWorkItemStatuses)[number];

export const storyWorkItemStatuses = [
  'Draft',
  'NeedsBreakdown',
  'BreakdownProposed',
  'Approved',
  'InProgress',
  'InReview',
  'Done',
] as const;
export type StoryWorkItemStatus = (typeof storyWorkItemStatuses)[number];

export const taskWorkItemStatuses = ['Draft', 'Ready', 'InProgress', 'Blocked', 'InReview', 'Done'] as const;
export type TaskWorkItemStatus = (typeof taskWorkItemStatuses)[number];

export type WorkItemStatus = EpicWorkItemStatus | FeatureWorkItemStatus | StoryWorkItemStatus | TaskWorkItemStatus;

export type WorkItemStatusByType = {
  epic: EpicWorkItemStatus;
  feature: FeatureWorkItemStatus;
  story: StoryWorkItemStatus;
  task: TaskWorkItemStatus;
};

export const workItemStatusesByType = {
  epic: epicWorkItemStatuses,
  feature: featureWorkItemStatuses,
  story: storyWorkItemStatuses,
  task: taskWorkItemStatuses,
} as const satisfies Record<WorkItemType, readonly string[]>;

