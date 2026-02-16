import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AuthStatus } from '@alphred/shared';

const execFileAsync = promisify(execFile);
const GITHUB_HOSTNAME = 'github.com';

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
  const hostname = GITHUB_HOSTNAME;

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

export async function checkAuthForRepo(
  repo: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<AuthStatus> {
  const env = resolveGitHubEnvironment(environment);
  const resolvedRepo = resolveGitHubHostname(repo);
  if ('error' in resolvedRepo) {
    return {
      authenticated: false,
      error: resolvedRepo.error,
    };
  }
  const hostname = resolvedRepo.hostname;

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
  const userMatch = /Logged in to [^\s]+ account ([^\s(]+)/i.exec(output);
  const scopesMatch = /Token scopes:\s*(.+)$/im.exec(output);

  return {
    user: userMatch?.[1],
    scopes: parseScopes(scopesMatch?.[1]),
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

function trimOuterQuotes(value: string): string {
  let start = 0;
  let end = value.length;

  while (start < end && isQuote(value[start])) {
    start += 1;
  }

  while (start < end && isQuote(value[end - 1])) {
    end -= 1;
  }

  return value.slice(start, end);
}

function isQuote(char: string | undefined): boolean {
  return char === '"' || char === '\'';
}

function createGitHubAuthError(error: unknown, hostname: string): string {
  const details = extractErrorDetail(error);
  const guidance = [
    `Run: gh auth login --hostname ${hostname}`,
    'Or set: ALPHRED_GH_TOKEN=<your-pat> (or GH_TOKEN)',
    'For GitHub Enterprise: ALPHRED_GH_ENTERPRISE_TOKEN=<your-pat> (or GH_ENTERPRISE_TOKEN)',
  ].join(' | ');

  if (!details) {
    return `GitHub auth is not configured. ${guidance}`;
  }

  return `GitHub auth is not configured. ${guidance}. CLI output: ${details}`;
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

function extractErrorDetail(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null) {
    const maybeStdout = (error as { stdout?: unknown }).stdout;
    const maybeStderr = (error as { stderr?: unknown }).stderr;
    const stdout = typeof maybeStdout === 'string' ? maybeStdout : '';
    const stderr = typeof maybeStderr === 'string' ? maybeStderr : '';
    const combined = `${stdout}\n${stderr}`
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .join(' ');

    if (combined.length > 0) {
      return combined;
    }
  }

  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim();
  }

  return undefined;
}
