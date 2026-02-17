import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AuthStatus } from '@alphred/shared';
import { createAuthErrorMessage } from './authUtils.js';
import { containsGitAuthArgs, createRedactedGitCommandFailureMessage } from './gitCommandSanitizer.js';

const execFileAsync = promisify(execFile);
const AZURE_DEVOPS_BASE_URL = 'https://dev.azure.com';

export type AzureWorkItem = {
  id: number;
  title: string;
  description: string;
  type: string;
};

export type CreateAzurePullRequestParams = {
  organization: string;
  project: string;
  repository: string;
  title: string;
  description: string;
  sourceBranch: string;
  targetBranch?: string;
};

export async function getWorkItem(
  organization: string,
  project: string,
  workItemId: number,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<AzureWorkItem> {
  const env = resolveAzureEnvironment(environment);
  const { stdout } = await execFileAsync('az', [
    'boards', 'work-item', 'show',
    '--id', String(workItemId),
    '--org', `${AZURE_DEVOPS_BASE_URL}/${organization}`,
    '--project', project,
    '--output', 'json',
  ], { env });

  const data = parseJsonOutput<{ id: number; fields: Record<string, string> }>(
    stdout,
    'az boards work-item show',
  );
  return {
    id: data.id,
    title: data.fields['System.Title'] ?? '',
    description: data.fields['System.Description'] ?? '',
    type: data.fields['System.WorkItemType'] ?? '',
  };
}

export async function createPullRequest(
  params: CreateAzurePullRequestParams,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const {
    organization,
    project,
    repository,
    title,
    description,
    sourceBranch,
    targetBranch = 'main',
  } = params;
  const env = resolveAzureEnvironment(environment);
  const { stdout } = await execFileAsync('az', [
    'repos', 'pr', 'create',
    '--org', `${AZURE_DEVOPS_BASE_URL}/${organization}`,
    '--project', project,
    '--repository', repository,
    '--title', title,
    '--description', description,
    '--source-branch', sourceBranch,
    '--target-branch', targetBranch,
    '--output', 'json',
  ], { env });

  const data = parseJsonOutput<{ pullRequestId: number }>(
    stdout,
    'az repos pr create',
  );
  return data.pullRequestId;
}

export async function cloneRepo(
  remote: string,
  localPath: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const env = resolveAzureEnvironment(environment);
  const authConfig = resolveAzureGitAuthConfig(remote, env);
  const cloneArgs = [...authConfig, 'clone', remote, localPath];
  try {
    await execFileAsync('git', cloneArgs, { env });
  } catch (error) {
    if (!containsGitAuthArgs(cloneArgs)) {
      throw error;
    }

    throw new Error(createRedactedGitCommandFailureMessage(cloneArgs, 'git clone failed'));
  }
}

export async function checkAuth(
  organization: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<AuthStatus> {
  const env = resolveAzureEnvironment(environment);

  const account = await checkAzureAccountAuth(env);
  if (!account.ok) {
    return {
      authenticated: false,
      error: account.error,
    };
  }

  const organizationUrl = `${AZURE_DEVOPS_BASE_URL}/${organization}`;
  try {
    await execFileAsync('az', [
      'devops',
      'project',
      'list',
      '--organization',
      organizationUrl,
      '--output',
      'json',
    ], { env });
  } catch (error) {
    return {
      authenticated: false,
      error: createAzureDevOpsLoginError(error, organizationUrl),
    };
  }

  return {
    authenticated: true,
    user: account.user,
  };
}

function resolveAzureEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...environment };
  const azureDevopsPat = environment.ALPHRED_AZURE_DEVOPS_PAT ?? environment.AZURE_DEVOPS_EXT_PAT;
  if (azureDevopsPat !== undefined) {
    env.AZURE_DEVOPS_EXT_PAT = azureDevopsPat;
  }

  return env;
}

function resolveAzureGitAuthConfig(remote: string, environment: NodeJS.ProcessEnv): string[] {
  const pat = environment.ALPHRED_AZURE_DEVOPS_PAT ?? environment.AZURE_DEVOPS_EXT_PAT;
  if (typeof pat !== 'string' || pat.length === 0) {
    return [];
  }

  const origin = resolveRemoteOrigin(remote);
  if (origin === undefined) {
    return [];
  }

  const basicCredentials = Buffer.from(`:${pat}`).toString('base64');
  const authHeader = `AUTHORIZATION: Basic ${basicCredentials}`;
  return ['-c', `http.${origin}/.extraheader=${authHeader}`];
}

function resolveRemoteOrigin(remote: string): string | undefined {
  try {
    const url = new URL(remote);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return undefined;
    }

    return url.origin;
  } catch {
    return undefined;
  }
}

async function checkAzureAccountAuth(
  env: NodeJS.ProcessEnv,
): Promise<{ ok: true; user?: string } | { ok: false; error: string }> {
  try {
    const { stdout } = await execFileAsync('az', ['account', 'show', '--output', 'json'], { env });
    const user = parseAzureAccountUser(stdout);

    return {
      ok: true,
      user,
    };
  } catch (error) {
    return {
      ok: false,
      error: createAzureLoginError(error),
    };
  }
}

function parseAzureAccountUser(stdout: string): string | undefined {
  try {
    const parsed = JSON.parse(stdout) as {
      user?: {
        name?: string;
      };
    };

    const userName = parsed.user?.name;
    return typeof userName === 'string' && userName.trim().length > 0 ? userName : undefined;
  } catch {
    return undefined;
  }
}

function parseJsonOutput<T>(stdout: string, commandLabel: string): T {
  try {
    return JSON.parse(stdout) as T;
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    throw new Error(`${commandLabel} returned malformed JSON output: ${details}`);
  }
}

function createAzureLoginError(error: unknown): string {
  return createAuthErrorMessage('Azure CLI auth is not configured', 'Run: az login', error);
}

function createAzureDevOpsLoginError(error: unknown, organizationUrl: string): string {
  return createAuthErrorMessage('Azure DevOps auth is not configured', [
    `Run: az devops login --organization ${organizationUrl}`,
    'Or set: ALPHRED_AZURE_DEVOPS_PAT=<your-pat> (or AZURE_DEVOPS_EXT_PAT)',
  ], error);
}
