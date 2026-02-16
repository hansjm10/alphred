import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AuthStatus } from '@alphred/shared';
import { createAuthErrorMessage } from './authUtils.js';

const execFileAsync = promisify(execFile);
const GITHUB_HOSTNAME = 'github.com';
const TOKEN_SCOPES_PREFIX = 'Token scopes:';
const LOGGED_IN_PREFIX = 'logged in to ';
const ACCOUNT_MARKER = ' account ';

export type GitHubIssue = {
  number: number;
  title: string;
  body: string;
  labels: string[];
};

export async function getIssue(
  repo: string,
  issueNumber: number,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<GitHubIssue> {
  const env = resolveGitHubEnvironment(environment);
  const { stdout } = await execFileAsync('gh', [
    'issue', 'view', String(issueNumber),
    '--repo', repo,
    '--json', 'number,title,body,labels',
  ], { env });

  const data = JSON.parse(stdout) as { number: number; title: string; body: string; labels: { name: string }[] };
  return {
    number: data.number,
    title: data.title,
    body: data.body,
    labels: data.labels.map(l => l.name),
  };
}

export async function createPullRequest(
  repo: string,
  title: string,
  body: string,
  branch: string,
  base = 'main',
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const env = resolveGitHubEnvironment(environment);
  const { stdout } = await execFileAsync('gh', [
    'pr', 'create',
    '--repo', repo,
    '--title', title,
    '--body', body,
    '--head', branch,
    '--base', base,
  ], { env });
  return stdout.trim();
}

export async function checkAuth(environment: NodeJS.ProcessEnv = process.env): Promise<AuthStatus> {
  const env = resolveGitHubEnvironment(environment);
  return checkGitHubAuthByHostname(GITHUB_HOSTNAME, env);
}

export async function checkAuthForRepo(
  repo: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<AuthStatus> {
  const resolvedRepo = resolveGitHubHostname(repo);
  if ('error' in resolvedRepo) {
    return {
      authenticated: false,
      error: resolvedRepo.error,
    };
  }

  const env = resolveGitHubEnvironment(environment);
  return checkGitHubAuthByHostname(resolvedRepo.hostname, env);
}

function resolveGitHubEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...environment };

  const githubToken = environment.ALPHRED_GH_TOKEN ?? environment.GH_TOKEN;
  if (githubToken !== undefined) {
    env.GH_TOKEN = githubToken;
  }

  const githubEnterpriseToken = environment.ALPHRED_GH_ENTERPRISE_TOKEN ?? environment.GH_ENTERPRISE_TOKEN;
  if (githubEnterpriseToken !== undefined) {
    env.GH_ENTERPRISE_TOKEN = githubEnterpriseToken;
  }

  return env;
}

function parseGitHubAuthStatus(output: string): { user?: string; scopes: string[] } {
  let user: string | undefined;
  let rawScopes: string | undefined;

  for (const line of output.split('\n')) {
    if (user === undefined) {
      user = parseGitHubAuthUser(line);
    }

    if (rawScopes === undefined) {
      rawScopes = parseGitHubAuthScopes(line);
    }

    if (user !== undefined && rawScopes !== undefined) {
      break;
    }
  }

  return {
    user,
    scopes: parseScopes(rawScopes),
  };
}

function parseScopes(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }

  return raw
    .split(',')
    .map(scope => trimOuterQuotes(scope.trim()))
    .filter(scope => scope.length > 0);
}

function parseGitHubAuthUser(line: string): string | undefined {
  const normalizedLine = line.trim();
  const lowerLine = normalizedLine.toLowerCase();

  const loggedInIndex = lowerLine.indexOf(LOGGED_IN_PREFIX);
  if (loggedInIndex === -1) {
    return undefined;
  }

  const userStartIndex = lowerLine.indexOf(
    ACCOUNT_MARKER,
    loggedInIndex + LOGGED_IN_PREFIX.length,
  );
  if (userStartIndex === -1) {
    return undefined;
  }

  const start = userStartIndex + ACCOUNT_MARKER.length;
  let end = normalizedLine.indexOf(' (', start);
  if (end === -1) {
    end = normalizedLine.length;
  }

  const user = normalizedLine.slice(start, end).trim();
  return user.length > 0 ? user : undefined;
}

function parseGitHubAuthScopes(line: string): string | undefined {
  const scopePrefixIndex = line.indexOf(TOKEN_SCOPES_PREFIX);
  if (scopePrefixIndex === -1) {
    return undefined;
  }

  const rawScopes = line.slice(scopePrefixIndex + TOKEN_SCOPES_PREFIX.length).trim();
  return rawScopes.length > 0 ? rawScopes : undefined;
}

function trimOuterQuotes(value: string): string {
  let start = 0;
  let end = value.length;

  while (start < end && (value[start] === '\'' || value[start] === '"')) {
    start += 1;
  }

  while (end > start && (value[end - 1] === '\'' || value[end - 1] === '"')) {
    end -= 1;
  }

  return value.slice(start, end);
}

function createGitHubAuthError(error: unknown, hostname: string): string {
  return createAuthErrorMessage('GitHub auth is not configured', [
    `Run: gh auth login --hostname ${hostname}`,
    'Or set: ALPHRED_GH_TOKEN=<your-pat> (or GH_TOKEN)',
    'For GitHub Enterprise: ALPHRED_GH_ENTERPRISE_TOKEN=<your-pat> (or GH_ENTERPRISE_TOKEN)',
  ], error);
}

function resolveGitHubHostname(repo: string): { hostname: string } | { error: string } {
  const trimmedRepo = repo.trim();
  if (trimmedRepo.length === 0) {
    return {
      error: 'Invalid GitHub repo format. Expected OWNER/REPO or [HOST/]OWNER/REPO.',
    };
  }

  const segments = trimmedRepo.split('/').map(segment => segment.trim());

  // gh supports OWNER/REPO and [HOST/]OWNER/REPO.
  if (segments.length === 2 && segments.every(segment => segment.length > 0)) {
    return { hostname: GITHUB_HOSTNAME };
  }

  if (segments.length === 3 && segments.every(segment => segment.length > 0)) {
    return { hostname: segments[0] };
  }

  return {
    error: `Invalid GitHub repo format: ${repo}. Expected OWNER/REPO or [HOST/]OWNER/REPO.`,
  };
}

async function checkGitHubAuthByHostname(hostname: string, env: NodeJS.ProcessEnv): Promise<AuthStatus> {
  try {
    const { stdout, stderr } = await execFileAsync('gh', [
      'auth',
      'status',
      '--hostname',
      hostname,
    ], { env });

    const { user, scopes } = parseGitHubAuthStatus(`${stdout}\n${stderr}`);

    return {
      authenticated: true,
      user,
      scopes: scopes.length > 0 ? scopes : undefined,
    };
  } catch (error) {
    return {
      authenticated: false,
      error: createGitHubAuthError(error, hostname),
    };
  }
}
