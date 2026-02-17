import { execFile } from 'node:child_process';
import { access, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { AuthStatus } from '@alphred/shared';
import { createAuthErrorMessage } from './authUtils.js';
import { containsGitAuthArgs, createRedactedGitCommandFailureMessage } from './gitCommandSanitizer.js';

const execFileAsync = promisify(execFile);
const GITHUB_HOSTNAME = 'github.com';
const GIT_ACCESS_TOKEN_USERNAME = 'x-access-token';
const SCP_REMOTE_REGEX = /^(?:[^@]+@)?([^:/]+):.+$/;
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

export async function cloneRepo(
  repo: string,
  remote: string,
  localPath: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const env = resolveGitHubEnvironment(environment);
  const cloneSource = resolveGitCloneSource(repo, remote);
  const trimmedRemote = remote.trim();
  const authConfig = resolveGitCloneAuthConfig(cloneSource, env);
  const cloneArgs = [...authConfig, 'clone', cloneSource, localPath];
  const targetExistedBeforeClone = await pathExists(localPath);

  try {
    await execFileAsync('gh', ['repo', 'clone', repo, localPath], { env });
  } catch {
    try {
      await execFileAsync('git', cloneArgs, { env });
    } catch (error) {
      const shouldCleanupPartialClone = (
        !targetExistedBeforeClone
        && isGitCloneDestinationConflictError(error)
        && await pathExists(localPath)
      );
      if (!shouldCleanupPartialClone) {
        throw createGitCloneFallbackError(error, cloneArgs);
      }

      await rm(localPath, { recursive: true, force: true });
      try {
        await execFileAsync('git', cloneArgs, { env });
      } catch (retryError) {
        throw createGitCloneFallbackError(retryError, cloneArgs);
      }
    }
    return;
  }

  if (trimmedRemote.length > 0) {
    const setOriginArgs = ['-C', localPath, 'remote', 'set-url', 'origin', trimmedRemote];
    try {
      await execFileAsync('git', setOriginArgs, { env });
    } catch (error) {
      throw createGitRemoteSetUrlError(error, setOriginArgs);
    }
  }
}

function createGitCloneFallbackError(error: unknown, cloneArgs: readonly string[]): Error {
  if (!containsGitAuthArgs(cloneArgs)) {
    return error instanceof Error ? error : new Error('git clone failed');
  }

  return new Error(createRedactedGitCommandFailureMessage(cloneArgs, 'git clone failed'));
}

function createGitRemoteSetUrlError(error: unknown, setUrlArgs: readonly string[]): Error {
  if (!containsGitAuthArgs(setUrlArgs)) {
    return error instanceof Error ? error : new Error('git remote set-url failed');
  }

  return new Error(createRedactedGitCommandFailureMessage(setUrlArgs, 'git remote set-url failed'));
}

function resolveGitCloneSource(repo: string, remote: string): string {
  const trimmedRemote = remote.trim();
  if (trimmedRemote.length > 0) {
    return trimmedRemote;
  }

  const parsedRepo = parseGitHubRepo(repo);
  if (parsedRepo === undefined) {
    return repo;
  }

  return `https://${parsedRepo.hostname}/${parsedRepo.owner}/${parsedRepo.repository}.git`;
}

function isGitCloneDestinationConflictError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const errorWithStreams = error as Error & { stdout?: unknown; stderr?: unknown };
  const stdout = typeof errorWithStreams.stdout === 'string' ? errorWithStreams.stdout : '';
  const stderr = typeof errorWithStreams.stderr === 'string' ? errorWithStreams.stderr : '';
  const details = `${error.message}\n${stdout}\n${stderr}`.toLowerCase();
  return details.includes('already exists and is not an empty directory');
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
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
    user ??= parseGitHubAuthUser(line);
    rawScopes ??= parseGitHubAuthScopes(line);

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

function resolveGitCloneAuthConfig(cloneSource: string, environment: NodeJS.ProcessEnv): string[] {
  const token = resolveGitHubToken(cloneSource, environment);
  if (token === undefined) {
    return [];
  }

  return createGitAuthConfig(cloneSource, GIT_ACCESS_TOKEN_USERNAME, token);
}

function resolveGitHubToken(cloneSource: string, environment: NodeJS.ProcessEnv): string | undefined {
  const githubToken = resolveConfiguredToken(environment.ALPHRED_GH_TOKEN, environment.GH_TOKEN);
  const enterpriseToken = resolveConfiguredToken(environment.ALPHRED_GH_ENTERPRISE_TOKEN, environment.GH_ENTERPRISE_TOKEN);
  const originHost = resolveRemoteHost(cloneSource);
  if (originHost === undefined || originHost === GITHUB_HOSTNAME) {
    return githubToken;
  }

  return enterpriseToken;
}

function createGitAuthConfig(cloneSource: string, username: string, token: string): string[] {
  const origin = resolveRemoteOrigin(cloneSource);
  if (origin === undefined) {
    return [];
  }

  const authHeader = `AUTHORIZATION: Basic ${Buffer.from(`${username}:${token}`).toString('base64')}`;
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

function resolveRemoteHost(remote: string): string | undefined {
  try {
    const url = new URL(remote);
    return url.hostname.toLowerCase();
  } catch {
    const scpMatch = SCP_REMOTE_REGEX.exec(remote);
    if (scpMatch?.[1] !== undefined) {
      return scpMatch[1].toLowerCase();
    }

    return undefined;
  }
}

function resolveConfiguredToken(...values: (string | undefined)[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }

  return undefined;
}

function parseGitHubRepo(repo: string): { hostname: string; owner: string; repository: string } | undefined {
  const trimmedRepo = repo.trim();
  if (trimmedRepo.length === 0) {
    return undefined;
  }

  const segments = trimmedRepo.split('/').map(segment => segment.trim());

  if (segments.length === 2 && segments.every(segment => segment.length > 0)) {
    return {
      hostname: GITHUB_HOSTNAME,
      owner: segments[0],
      repository: segments[1],
    };
  }

  if (segments.length === 3 && segments.every(segment => segment.length > 0)) {
    return {
      hostname: segments[0],
      owner: segments[1],
      repository: segments[2],
    };
  }

  return undefined;
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
  const parsedRepo = parseGitHubRepo(repo);
  if (parsedRepo === undefined) {
    if (repo.trim().length > 0) {
      return {
        error: `Invalid GitHub repo format: ${repo}. Expected OWNER/REPO or [HOST/]OWNER/REPO.`,
      };
    }

    return {
      error: 'Invalid GitHub repo format. Expected OWNER/REPO or [HOST/]OWNER/REPO.',
    };
  }

  return { hostname: parsedRepo.hostname };
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
