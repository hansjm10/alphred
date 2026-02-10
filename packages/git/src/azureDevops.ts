import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type AzureWorkItem = {
  id: number;
  title: string;
  description: string;
  type: string;
};

export async function getWorkItem(
  organization: string,
  project: string,
  workItemId: number,
): Promise<AzureWorkItem> {
  const { stdout } = await execFileAsync('az', [
    'boards', 'work-item', 'show',
    '--id', String(workItemId),
    '--org', `https://dev.azure.com/${organization}`,
    '--project', project,
    '--output', 'json',
  ]);

  const data = JSON.parse(stdout) as { id: number; fields: Record<string, string> };
  return {
    id: data.id,
    title: data.fields['System.Title'] ?? '',
    description: data.fields['System.Description'] ?? '',
    type: data.fields['System.WorkItemType'] ?? '',
  };
}

export async function createPullRequest(
  organization: string,
  project: string,
  repository: string,
  title: string,
  description: string,
  sourceBranch: string,
  targetBranch = 'main',
): Promise<number> {
  const { stdout } = await execFileAsync('az', [
    'repos', 'pr', 'create',
    '--org', `https://dev.azure.com/${organization}`,
    '--project', project,
    '--repository', repository,
    '--title', title,
    '--description', description,
    '--source-branch', sourceBranch,
    '--target-branch', targetBranch,
    '--output', 'json',
  ]);

  const data = JSON.parse(stdout) as { pullRequestId: number };
  return data.pullRequestId;
}
