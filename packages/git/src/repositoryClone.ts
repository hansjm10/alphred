import { execFile, spawn } from 'node:child_process';
import { access, mkdir, realpath, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import {
  getRepositoryByName,
  insertRepository,
  updateRepositoryCloneStatus,
  type AlphredDatabase,
  type InsertRepositoryParams,
} from '@alphred/db';
import type { RepositoryConfig, ScmProviderKind } from '@alphred/shared';
import { redactGitAuthArgs } from './gitCommandSanitizer.js';
import { createScmProvider, type ScmProvider, type ScmProviderConfig } from './scmProvider.js';
import { deriveSandboxRepoPath, resolveSandboxDir } from './sandbox.js';

const execFileAsync = promisify(execFile);
const GITHUB_HOSTNAME = 'github.com';
const AZURE_DEVOPS_HOSTNAME = 'dev.azure.com';
const AZURE_DEVOPS_SSH_HOSTNAME = 'ssh.dev.azure.com';
const AZURE_DEVOPS_LEGACY_HOST_SUFFIX = '.visualstudio.com';
const SCP_REMOTE_REGEX = /^(?:[^@]+@)?([^:/]+):(.+)$/;
const GIT_EXECUTABLE_ENV_KEY = 'ALPHRED_GIT_EXECUTABLE';
const UNIX_GIT_EXECUTABLE_CANDIDATES = ['/usr/bin/git', '/usr/local/bin/git', '/opt/homebrew/bin/git'];
const WINDOWS_GIT_EXECUTABLE_CANDIDATES = [
  String.raw`C:\Program Files\Git\cmd\git.exe`,
  String.raw`C:\Program Files\Git\bin\git.exe`,
];
const DEFAULT_SYNC_COMMITTER_NAME = 'Alphred Sync';
const DEFAULT_SYNC_COMMITTER_EMAIL = 'alphred-sync@localhost';

export const repositorySyncModes = ['fetch', 'pull'] as const;
export type RepositorySyncMode = (typeof repositorySyncModes)[number];

export const repositorySyncStrategies = ['ff-only', 'merge', 'rebase'] as const;
export type RepositorySyncStrategy = (typeof repositorySyncStrategies)[number];

export const repositorySyncStatuses = ['fetched', 'up_to_date', 'updated', 'conflicted'] as const;
export type RepositorySyncStatus = (typeof repositorySyncStatuses)[number];

export type RepositorySyncDetails = {
  mode: RepositorySyncMode;
  strategy: RepositorySyncStrategy | null;
  branch: string | null;
  status: RepositorySyncStatus;
  conflictMessage: string | null;
};

type EnsureRepositorySyncOptions = {
  mode?: RepositorySyncMode;
  strategy?: RepositorySyncStrategy;
  branch?: string;
};

export type EnsureRepositoryCloneParams = {
  db: AlphredDatabase;
  repository: InsertRepositoryInput;
  provider?: ScmProvider;
  environment?: NodeJS.ProcessEnv;
  fetchAll?: (
    localPath: string,
    environment: NodeJS.ProcessEnv,
    context: FetchRepositoryContext,
  ) => Promise<void>;
  sync?: EnsureRepositorySyncOptions;
};

export type FetchRepositoryContext = {
  provider: ScmProviderKind;
  remoteUrl: string;
};

type InsertRepositoryInput = Pick<
  InsertRepositoryParams,
  'name' | 'provider' | 'remoteUrl' | 'remoteRef' | 'defaultBranch'
>;

export type EnsureRepositoryCloneResult = {
  repository: RepositoryConfig;
  action: 'cloned' | 'fetched';
  sync?: RepositorySyncDetails;
};

export async function ensureRepositoryClone(params: EnsureRepositoryCloneParams): Promise<EnsureRepositoryCloneResult> {
  const environment = params.environment ?? process.env;
  const fetchAll = params.fetchAll ?? fetchRepository;
  const syncOptions = resolveSyncOptions(params.sync);
  validateRepositoryInput(params.repository);

  const repository = getOrCreateRepository(params.db, params.repository);
  assertRepositoryIdentityMatches(repository, params.repository);

  const localPath = await resolveRepositoryLocalPath(repository, environment);
  const canReuseLocalPath = await isPathInsideProviderSandbox(localPath, repository.provider, environment);
  if (
    canReuseLocalPath
    && await isGitRepository(localPath)
    && await hasExpectedRepositoryOrigin(localPath, repository.remoteUrl, environment)
  ) {
    const fetchContext: FetchRepositoryContext = {
      provider: repository.provider,
      remoteUrl: repository.remoteUrl,
    };

    await fetchAll(localPath, environment, fetchContext);
    const defaultBranch = await resolveRepositoryDefaultBranch(localPath, repository.defaultBranch, environment);
    const sync = await resolveFetchedSyncDetails({
      localPath,
      defaultBranch,
      syncOptions,
      environment,
    });
    const updated = updateRepositoryCloneStatus(params.db, {
      repositoryId: repository.id,
      cloneStatus: 'cloned',
      localPath,
      defaultBranch,
    });

    return {
      repository: updated,
      action: 'fetched',
      sync,
    };
  }

  const provider = resolveProvider(repository, params.provider);
  try {
    await mkdir(dirname(localPath), { recursive: true });
    await rm(localPath, { recursive: true, force: true });
    await provider.cloneRepo(repository.remoteUrl, localPath, environment);
    const defaultBranch = await resolveRepositoryDefaultBranch(localPath, repository.defaultBranch, environment);
    const updated = updateRepositoryCloneStatus(params.db, {
      repositoryId: repository.id,
      cloneStatus: 'cloned',
      localPath,
      defaultBranch,
    });

    return {
      repository: updated,
      action: 'cloned',
      sync: {
        mode: 'fetch',
        strategy: null,
        branch: defaultBranch,
        status: 'updated',
        conflictMessage: null,
      },
    };
  } catch (error) {
    await rm(localPath, { recursive: true, force: true }).catch(() => undefined);
    updateRepositoryCloneStatus(params.db, {
      repositoryId: repository.id,
      cloneStatus: 'error',
      localPath,
    });
    throw error;
  }
}

type ResolvedSyncOptions = {
  mode: RepositorySyncMode;
  strategy: RepositorySyncStrategy;
  branch: string | undefined;
};

type ResolveFetchedSyncDetailsParams = {
  localPath: string;
  defaultBranch: string;
  syncOptions: ResolvedSyncOptions;
  environment: NodeJS.ProcessEnv;
};

function resolveSyncOptions(syncOptions: EnsureRepositorySyncOptions | undefined): ResolvedSyncOptions {
  const branch = syncOptions?.branch?.trim();
  return {
    mode: syncOptions?.mode ?? 'fetch',
    strategy: syncOptions?.strategy ?? 'ff-only',
    branch: branch && branch.length > 0 ? branch : undefined,
  };
}

async function resolveFetchedSyncDetails(params: ResolveFetchedSyncDetailsParams): Promise<RepositorySyncDetails> {
  if (params.syncOptions.mode === 'fetch') {
    return {
      mode: 'fetch',
      strategy: null,
      branch: params.defaultBranch,
      status: 'fetched',
      conflictMessage: null,
    };
  }

  const targetBranch = params.syncOptions.branch ?? params.defaultBranch;
  const pullResult = await pullFetchedBranch({
    localPath: params.localPath,
    branch: targetBranch,
    strategy: params.syncOptions.strategy,
    environment: params.environment,
  });

  return {
    mode: 'pull',
    strategy: params.syncOptions.strategy,
    branch: targetBranch,
    status: pullResult.status,
    conflictMessage: pullResult.conflictMessage,
  };
}

type PullFetchedBranchParams = {
  localPath: string;
  branch: string;
  strategy: RepositorySyncStrategy;
  environment: NodeJS.ProcessEnv;
};

type PullFetchedBranchResult = {
  status: Extract<RepositorySyncStatus, 'up_to_date' | 'updated' | 'conflicted'>;
  conflictMessage: string | null;
};

async function pullFetchedBranch(params: PullFetchedBranchParams): Promise<PullFetchedBranchResult> {
  const normalizedBranch = params.branch.trim();
  if (normalizedBranch.length === 0) {
    return {
      status: 'up_to_date',
      conflictMessage: null,
    };
  }

  const hasRemoteBranch = await hasGitRef(
    params.localPath,
    `refs/remotes/origin/${normalizedBranch}`,
    params.environment,
  );
  if (!hasRemoteBranch) {
    return {
      status: 'up_to_date',
      conflictMessage: null,
    };
  }

  const createdLocalBranch = await ensureLocalBranchExists(params.localPath, normalizedBranch, params.environment);
  const divergence = await resolveBranchDivergence(params.localPath, normalizedBranch, params.environment);
  if (divergence.behind === 0) {
    return {
      status: createdLocalBranch ? 'updated' : 'up_to_date',
      conflictMessage: null,
    };
  }

  const previousBranch = await resolveCurrentBranch(params.localPath, params.environment);
  const previousHeadRevision = previousBranch === undefined
    ? await resolveCurrentHeadRevision(params.localPath, params.environment)
    : undefined;
  const pullEnvironment = resolvePullEnvironment(params.strategy, params.environment);
  let switchedToTargetBranch = false;

  try {
    if (previousBranch !== normalizedBranch) {
      await runGitCommandWithOutput(['checkout', normalizedBranch], {
        cwd: params.localPath,
        environment: params.environment,
      });
      switchedToTargetBranch = true;
    }

    await runGitCommandWithOutput(resolvePullCommand(params.strategy, normalizedBranch), {
      cwd: params.localPath,
      environment: pullEnvironment,
    });

    return {
      status: 'updated',
      conflictMessage: null,
    };
  } catch (error) {
    if (!isSyncConflictError(error)) {
      throw error;
    }

    await abortSyncIfNeeded(params.localPath, params.strategy, pullEnvironment);
    const conflictSummary = extractSyncConflictSummary(error);

    return {
      status: 'conflicted',
      conflictMessage: `Sync conflict on branch "${normalizedBranch}" with strategy "${params.strategy}": ${conflictSummary}`,
    };
  } finally {
    const restoreCommand = previousBranch !== undefined
      ? ['checkout', previousBranch]
      : previousHeadRevision !== undefined
        ? ['checkout', '--detach', previousHeadRevision]
        : undefined;
    if (switchedToTargetBranch && restoreCommand !== undefined) {
      await runGitCommandWithOutput(restoreCommand, {
        cwd: params.localPath,
        environment: params.environment,
      }).catch(() => undefined);
    }
  }
}

async function ensureLocalBranchExists(
  localPath: string,
  branch: string,
  environment: NodeJS.ProcessEnv,
): Promise<boolean> {
  if (await hasGitRef(localPath, `refs/heads/${branch}`, environment)) {
    return false;
  }

  await runGitCommandWithOutput(['branch', '--track', branch, `origin/${branch}`], {
    cwd: localPath,
    environment,
  });
  return true;
}

async function hasGitRef(
  localPath: string,
  refName: string,
  environment: NodeJS.ProcessEnv,
): Promise<boolean> {
  try {
    await runGitCommandWithOutput(['show-ref', '--verify', '--quiet', refName], {
      cwd: localPath,
      environment,
    });
    return true;
  } catch (error) {
    if (isExecErrorCode(error, 1)) {
      return false;
    }

    throw error;
  }
}

async function resolveCurrentBranch(
  localPath: string,
  environment: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  try {
    const { stdout } = await runGitCommandWithOutput(['symbolic-ref', '--quiet', '--short', 'HEAD'], {
      cwd: localPath,
      environment,
    });
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch (error) {
    if (isExecErrorCode(error, 1)) {
      return undefined;
    }

    throw error;
  }
}

async function resolveCurrentHeadRevision(
  localPath: string,
  environment: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  try {
    const { stdout } = await runGitCommandWithOutput(['rev-parse', '--verify', '--quiet', 'HEAD'], {
      cwd: localPath,
      environment,
    });
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch (error) {
    if (isExecErrorCode(error, 1)) {
      return undefined;
    }

    throw error;
  }
}

async function resolveBranchDivergence(
  localPath: string,
  branch: string,
  environment: NodeJS.ProcessEnv,
): Promise<{ ahead: number; behind: number }> {
  const { stdout } = await runGitCommandWithOutput(
    ['rev-list', '--left-right', '--count', `refs/heads/${branch}...refs/remotes/origin/${branch}`],
    {
      cwd: localPath,
      environment,
    },
  );
  const [aheadValue, behindValue] = stdout.trim().split(/\s+/);
  const ahead = Number.parseInt(aheadValue ?? '', 10);
  const behind = Number.parseInt(behindValue ?? '', 10);
  if (!Number.isInteger(ahead) || ahead < 0 || !Number.isInteger(behind) || behind < 0) {
    throw new Error(`Unable to determine branch divergence for "${branch}".`);
  }

  return {
    ahead,
    behind,
  };
}

function resolvePullCommand(strategy: RepositorySyncStrategy, branch: string): string[] {
  const targetRef = `origin/${branch}`;
  if (strategy === 'ff-only') {
    return ['merge', '--ff-only', targetRef];
  }

  if (strategy === 'merge') {
    return ['merge', '--no-edit', targetRef];
  }

  return ['rebase', targetRef];
}

function resolvePullEnvironment(
  strategy: RepositorySyncStrategy,
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  if (strategy === 'ff-only') {
    return environment;
  }

  const committerName = resolveIdentityValue(environment.GIT_COMMITTER_NAME)
    ?? resolveIdentityValue(environment.GIT_AUTHOR_NAME)
    ?? DEFAULT_SYNC_COMMITTER_NAME;
  const committerEmail = resolveIdentityValue(environment.GIT_COMMITTER_EMAIL)
    ?? resolveIdentityValue(environment.GIT_AUTHOR_EMAIL)
    ?? DEFAULT_SYNC_COMMITTER_EMAIL;
  const authorName = resolveIdentityValue(environment.GIT_AUTHOR_NAME) ?? committerName;
  const authorEmail = resolveIdentityValue(environment.GIT_AUTHOR_EMAIL) ?? committerEmail;

  return {
    ...environment,
    GIT_COMMITTER_NAME: committerName,
    GIT_COMMITTER_EMAIL: committerEmail,
    GIT_AUTHOR_NAME: authorName,
    GIT_AUTHOR_EMAIL: authorEmail,
  };
}

function resolveIdentityValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed.length === 0) {
    return undefined;
  }

  return trimmed;
}

async function abortSyncIfNeeded(
  localPath: string,
  strategy: RepositorySyncStrategy,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  if (strategy === 'rebase') {
    await runGitCommandWithOutput(['rebase', '--abort'], {
      cwd: localPath,
      environment,
    }).catch(() => undefined);
    return;
  }

  if (strategy === 'merge') {
    await runGitCommandWithOutput(['merge', '--abort'], {
      cwd: localPath,
      environment,
    }).catch(() => undefined);
  }
}

function isSyncConflictError(error: unknown): boolean {
  const output = readGitErrorOutput(error).toLowerCase();
  return (
    output.includes('conflict')
    || output.includes('automatic merge failed')
    || output.includes('could not apply')
    || output.includes('not possible to fast-forward')
    || output.includes('already checked out at')
    || output.includes('please commit your changes or stash them')
    || output.includes('would be overwritten by merge')
    || output.includes('would be overwritten by checkout')
    || output.includes('cannot rebase')
  );
}

function extractSyncConflictSummary(error: unknown): string {
  const output = readGitErrorOutput(error);
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }

    if (
      /conflict/i.test(trimmed)
      || /could not apply/i.test(trimmed)
      || /automatic merge failed/i.test(trimmed)
      || /fast-forward/i.test(trimmed)
      || /already checked out/i.test(trimmed)
      || /stash/i.test(trimmed)
      || /overwritten/i.test(trimmed)
    ) {
      return trimmed;
    }
  }

  return 'Git reported a repository sync conflict.';
}

function readGitErrorOutput(error: unknown): string {
  if (typeof error !== 'object' || error === null) {
    return String(error);
  }

  const errorRecord = error as { stdout?: unknown; stderr?: unknown; message?: unknown };
  const stdout = toErrorText(errorRecord.stdout);
  const stderr = toErrorText(errorRecord.stderr);
  const message = typeof errorRecord.message === 'string' ? errorRecord.message : '';
  return [stdout, stderr, message].filter(part => part.length > 0).join('\n');
}

function isExecErrorCode(error: unknown, expectedCode: number): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  return (error as { code?: unknown }).code === expectedCode;
}

async function resolveRepositoryDefaultBranch(
  localPath: string,
  fallback: string,
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  try {
    const gitExecutable = await resolveGitExecutable(environment);
    const { stdout } = await execFileAsync(
      gitExecutable,
      ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
      { cwd: localPath },
    );
    const trimmed = stdout.trim();
    if (trimmed.startsWith('origin/')) {
      const branch = trimmed.slice('origin/'.length).trim();
      if (branch.length > 0) {
        return branch;
      }
    }
  } catch {
    // Preserve the existing configured default branch if origin/HEAD is unavailable.
  }

  return fallback;
}

async function resolveRepositoryLocalPath(
  repository: RepositoryConfig,
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  const derivedPath = deriveSandboxRepoPath(repository.provider, repository.remoteRef, environment);
  const storedPath = repository.localPath;
  if (storedPath === null || storedPath === undefined) {
    return derivedPath;
  }

  if (await isPathInsideProviderSandbox(storedPath, repository.provider, environment)) {
    return storedPath;
  }

  return derivedPath;
}

async function isPathInsideProviderSandbox(
  path: string,
  provider: ScmProviderKind,
  environment: NodeJS.ProcessEnv,
): Promise<boolean> {
  if (!isAbsolute(path)) {
    return false;
  }

  const providerSandboxRoot = resolve(join(resolveSandboxDir(environment), provider));
  const [resolvedSandboxRoot, resolvedPath] = await Promise.all([
    resolveRealPath(providerSandboxRoot),
    resolveRealPath(path),
  ]);
  if (resolvedSandboxRoot === undefined || resolvedPath === undefined) {
    return false;
  }

  const relativePath = relative(resolvedSandboxRoot, resolvedPath);
  if (relativePath.length === 0) {
    return false;
  }

  if (relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
    return false;
  }

  return !isAbsolute(relativePath);
}

async function resolveRealPath(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch {
    return undefined;
  }
}

export async function fetchRepository(
  localPath: string,
  environment: NodeJS.ProcessEnv = process.env,
  context?: FetchRepositoryContext,
): Promise<void> {
  const authConfig = resolveGitFetchAuthConfig(context, environment);
  await runGitCommand([...authConfig, 'fetch', '--all', '--prune', '--tags'], {
    cwd: localPath,
    environment,
  });
}

async function runGitCommand(
  args: string[],
  options: {
    cwd?: string;
    environment?: NodeJS.ProcessEnv;
  },
): Promise<void> {
  const gitExecutable = await resolveGitExecutable(options.environment);
  await new Promise<void>((resolve, reject) => {
    const childProcess = spawn(gitExecutable, args, {
      cwd: options.cwd,
      stdio: 'inherit',
    });

    childProcess.once('error', reject);
    childProcess.once('close', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      const signalSuffix = signal === null ? '' : ` (signal: ${signal})`;
      reject(
        new Error(`git ${redactGitAuthArgs(args).join(' ')} exited with code ${code ?? 'null'}${signalSuffix}`),
      );
    });
  });
}

async function runGitCommandWithOutput(
  args: string[],
  options: {
    cwd?: string;
    environment?: NodeJS.ProcessEnv;
  },
): Promise<{ stdout: string; stderr: string }> {
  const gitExecutable = await resolveGitExecutable(options.environment);
  const result = await execFileAsync(gitExecutable, args, {
    cwd: options.cwd,
    env: options.environment,
  });

  return {
    stdout: toErrorText(result.stdout),
    stderr: toErrorText(result.stderr),
  };
}

async function resolveGitExecutable(environment: NodeJS.ProcessEnv = process.env): Promise<string> {
  const configuredPath = environment[GIT_EXECUTABLE_ENV_KEY]?.trim();
  if (configuredPath !== undefined && configuredPath.length > 0) {
    if (!isAbsolute(configuredPath)) {
      throw new Error(`${GIT_EXECUTABLE_ENV_KEY} must be an absolute path to a git executable.`);
    }

    return configuredPath;
  }

  const candidates = process.platform === 'win32'
    ? WINDOWS_GIT_EXECUTABLE_CANDIDATES
    : UNIX_GIT_EXECUTABLE_CANDIDATES;
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      continue;
    }
  }

  throw new Error(
    `Unable to locate git executable in fixed system paths. Set ${GIT_EXECUTABLE_ENV_KEY} to an absolute path.`,
  );
}

function resolveGitFetchAuthConfig(
  context: FetchRepositoryContext | undefined,
  environment: NodeJS.ProcessEnv,
): string[] {
  if (context?.provider === 'azure-devops') {
    const azurePat = environment.ALPHRED_AZURE_DEVOPS_PAT ?? environment.AZURE_DEVOPS_EXT_PAT;
    if (typeof azurePat === 'string' && azurePat.length > 0) {
      return createGitAuthConfig(context.remoteUrl, '', azurePat);
    }

    return [];
  }

  if (context?.provider === 'github') {
    const githubToken = resolveGitHubToken(context.remoteUrl, environment);
    if (githubToken !== undefined) {
      return createGitAuthConfig(context.remoteUrl, 'x-access-token', githubToken);
    }
  }

  return [];
}

function resolveGitHubToken(remoteUrl: string, environment: NodeJS.ProcessEnv): string | undefined {
  const githubToken = resolveConfiguredToken(environment.ALPHRED_GH_TOKEN, environment.GH_TOKEN);
  const enterpriseToken = resolveConfiguredToken(environment.ALPHRED_GH_ENTERPRISE_TOKEN, environment.GH_ENTERPRISE_TOKEN);
  const originHost = resolveRemoteHost(remoteUrl);
  if (originHost === undefined || originHost === GITHUB_HOSTNAME) {
    return githubToken;
  }

  return enterpriseToken;
}

function createGitAuthConfig(remoteUrl: string, username: string, token: string): string[] {
  const origin = resolveRemoteOrigin(remoteUrl);
  if (origin === undefined) {
    return [];
  }

  const basicCredentials = Buffer.from(`${username}:${token}`).toString('base64');
  const authHeader = `AUTHORIZATION: Basic ${basicCredentials}`;
  return ['-c', `http.${origin}/.extraheader=${authHeader}`];
}

function resolveRemoteOrigin(remoteUrl: string): string | undefined {
  try {
    const url = new URL(remoteUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return undefined;
    }

    return url.origin;
  } catch {
    return undefined;
  }
}

function resolveRemoteHost(remoteUrl: string): string | undefined {
  try {
    const url = new URL(remoteUrl);
    return url.hostname.toLowerCase();
  } catch {
    const scpMatch = SCP_REMOTE_REGEX.exec(remoteUrl);
    if (scpMatch?.[1] !== undefined) {
      return scpMatch[1].toLowerCase();
    }

    return undefined;
  }
}

function getOrCreateRepository(db: AlphredDatabase, repository: InsertRepositoryInput): RepositoryConfig {
  const existing = getRepositoryByName(db, repository.name);
  if (existing) {
    return existing;
  }

  return insertRepository(db, {
    name: repository.name,
    provider: repository.provider,
    remoteUrl: repository.remoteUrl,
    remoteRef: repository.remoteRef,
    ...(repository.defaultBranch === undefined ? {} : { defaultBranch: repository.defaultBranch }),
  });
}

function validateRepositoryInput(repository: InsertRepositoryInput): void {
  toScmProviderConfig(repository.provider, repository.remoteRef, repository.remoteUrl);
  deriveSandboxRepoPath(repository.provider, repository.remoteRef);
}

function assertRepositoryIdentityMatches(existing: RepositoryConfig, expected: InsertRepositoryInput): void {
  if (existing.provider !== expected.provider) {
    throw new Error(
      `Repository "${existing.name}" provider mismatch. Existing=${existing.provider}, expected=${expected.provider}.`,
    );
  }

  if (existing.remoteUrl !== expected.remoteUrl) {
    throw new Error(
      `Repository "${existing.name}" remoteUrl mismatch. Existing=${existing.remoteUrl}, expected=${expected.remoteUrl}.`,
    );
  }

  if (existing.remoteRef !== expected.remoteRef) {
    throw new Error(
      `Repository "${existing.name}" remoteRef mismatch. Existing=${existing.remoteRef}, expected=${expected.remoteRef}.`,
    );
  }
}

function resolveProvider(repository: RepositoryConfig, provider: ScmProvider | undefined): ScmProvider {
  const expectedConfig = toScmProviderConfig(repository.provider, repository.remoteRef, repository.remoteUrl);

  if (provider) {
    if (provider.kind !== repository.provider) {
      throw new Error(
        `Provider kind mismatch for repository "${repository.name}". Expected ${repository.provider}, received ${provider.kind}.`,
      );
    }

    const providedConfig = provider.getConfig?.();
    if (providedConfig !== undefined && !areScmProviderConfigsEqual(providedConfig, expectedConfig)) {
      throw new Error(
        `Provider identity mismatch for repository "${repository.name}". Expected ${formatScmProviderConfig(expectedConfig)}, received ${formatScmProviderConfig(providedConfig)}.`,
      );
    }

    return provider;
  }

  return createScmProvider(expectedConfig);
}

function areScmProviderConfigsEqual(a: ScmProviderConfig, b: ScmProviderConfig): boolean {
  if (a.kind !== b.kind) {
    return false;
  }

  if (a.kind === 'github') {
    return b.kind === 'github' && a.repo === b.repo;
  }

  return (
    b.kind === 'azure-devops'
    && a.organization === b.organization
    && a.project === b.project
    && a.repository === b.repository
  );
}

function formatScmProviderConfig(config: ScmProviderConfig): string {
  if (config.kind === 'github') {
    return `github:${config.repo}`;
  }

  return `azure-devops:${config.organization}/${config.project}/${config.repository}`;
}

function toScmProviderConfig(provider: ScmProviderKind, remoteRef: string, remoteUrl: string): ScmProviderConfig {
  if (provider === 'github') {
    return {
      kind: 'github',
      repo: resolveGitHubRepo(remoteRef, remoteUrl),
    };
  }

  const segments = remoteRef
    .split('/')
    .map(segment => segment.trim())
    .filter(segment => segment.length > 0);

  if (segments.length !== 3) {
    throw new Error(
      `Invalid Azure DevOps remoteRef: ${remoteRef}. Expected org/project/repository.`,
    );
  }
  assertSupportedAzureDevopsRemote(remoteUrl);
  assertAzureDevopsRepositoryMatchesRemote(remoteRef, remoteUrl, segments);

  return {
    kind: 'azure-devops',
    organization: segments[0],
    project: segments[1],
    repository: segments[2],
  };
}

function assertSupportedAzureDevopsRemote(remoteUrl: string): void {
  const remoteHost = resolveRemoteHost(remoteUrl);
  if (remoteHost === undefined || !isSupportedAzureDevopsHost(remoteHost)) {
    throw new Error(
      `Invalid Azure DevOps remoteUrl: ${remoteUrl}. Host must be ${AZURE_DEVOPS_HOSTNAME}, ${AZURE_DEVOPS_SSH_HOSTNAME}, or *.visualstudio.com.`,
    );
  }
}

function isSupportedAzureDevopsHost(hostname: string): boolean {
  return (
    hostname === AZURE_DEVOPS_HOSTNAME
    || hostname === AZURE_DEVOPS_SSH_HOSTNAME
    || hostname.endsWith(AZURE_DEVOPS_LEGACY_HOST_SUFFIX)
  );
}

function assertAzureDevopsRepositoryMatchesRemote(
  remoteRef: string,
  remoteUrl: string,
  refSegments: string[],
): void {
  const remoteRepository = resolveAzureDevopsRemoteRepository(remoteUrl);
  if (remoteRepository === undefined) {
    throw new Error(
      `Invalid Azure DevOps remoteUrl: ${remoteUrl}. Expected an Azure DevOps repository URL path.`,
    );
  }

  const [refOrganization, refProject, refRepository] = refSegments;
  if (
    refOrganization.toLowerCase() !== remoteRepository.organization.toLowerCase()
    || refProject.toLowerCase() !== remoteRepository.project.toLowerCase()
    || refRepository.toLowerCase() !== remoteRepository.repository.toLowerCase()
  ) {
    throw new Error(
      `Invalid Azure DevOps remoteRef: ${remoteRef}. Organization/project/repository must match remoteUrl repository ${remoteRepository.organization}/${remoteRepository.project}/${remoteRepository.repository}.`,
    );
  }
}

function resolveAzureDevopsRemoteRepository(
  remoteUrl: string,
): { organization: string; project: string; repository: string } | undefined {
  const remoteHost = resolveRemoteHost(remoteUrl);
  const pathname = resolveRemotePathname(remoteUrl);
  if (remoteHost === undefined || pathname === undefined) {
    return undefined;
  }

  const segments = decodeRemotePathSegments(pathname);
  if (segments === undefined) {
    return undefined;
  }

  return resolveAzureDevopsRemoteRepositoryFromSegments(remoteHost, segments);
}

function decodeRemotePathSegments(pathname: string): string[] | undefined {
  const segments: string[] = [];
  for (const segment of pathname.split('/')) {
    const trimmedSegment = segment.trim();
    if (trimmedSegment.length === 0) {
      continue;
    }

    let decodedSegment: string;
    try {
      decodedSegment = decodeURIComponent(trimmedSegment);
    } catch {
      return undefined;
    }

    segments.push(decodedSegment.replace(/\.git$/i, ''));
  }

  return segments;
}

function resolveAzureDevopsRemoteRepositoryFromSegments(
  remoteHost: string,
  segments: string[],
): { organization: string; project: string; repository: string } | undefined {
  if (remoteHost === AZURE_DEVOPS_HOSTNAME) {
    if (segments.length !== 4 || segments[2].toLowerCase() !== '_git') {
      return undefined;
    }

    return {
      organization: segments[0],
      project: segments[1],
      repository: segments[3],
    };
  }

  if (remoteHost === AZURE_DEVOPS_SSH_HOSTNAME) {
    if (segments.length !== 4 || segments[0].toLowerCase() !== 'v3') {
      return undefined;
    }

    return {
      organization: segments[1],
      project: segments[2],
      repository: segments[3],
    };
  }

  if (!remoteHost.endsWith(AZURE_DEVOPS_LEGACY_HOST_SUFFIX)) {
    return undefined;
  }

  const organization = remoteHost.slice(0, -AZURE_DEVOPS_LEGACY_HOST_SUFFIX.length);
  if (organization.length === 0) {
    return undefined;
  }

  if (segments.length === 3 && segments[1].toLowerCase() === '_git') {
    return {
      organization,
      project: segments[0],
      repository: segments[2],
    };
  }

  if (
    segments.length === 4
    && segments[0].toLowerCase() === organization.toLowerCase()
    && segments[2].toLowerCase() === '_git'
  ) {
    return {
      organization,
      project: segments[1],
      repository: segments[3],
    };
  }

  return undefined;
}

function resolveGitHubRepo(remoteRef: string, remoteUrl: string): string {
  const segments = remoteRef
    .split('/')
    .map(segment => segment.trim())
    .filter(segment => segment.length > 0);

  if (segments.length !== 2 && segments.length !== 3) {
    throw new Error(
      `Invalid GitHub remoteRef: ${remoteRef}. Expected owner/repo or host/owner/repo.`,
    );
  }

  const remoteHost = resolveRemoteHost(remoteUrl);
  if (remoteHost !== undefined && remoteHost !== GITHUB_HOSTNAME) {
    if (segments.length !== 3) {
      throw new Error(
        `Invalid GitHub remoteRef: ${remoteRef}. Expected ${remoteHost}/owner/repo for remoteUrl ${remoteUrl}.`,
      );
    }
  }

  if (segments.length === 3 && remoteHost !== undefined && segments[0].toLowerCase() !== remoteHost) {
    throw new Error(
      `Invalid GitHub remoteRef: ${remoteRef}. Host must match remoteUrl host ${remoteHost}.`,
    );
  }

  const remoteRepository = resolveGitHubRemoteRepository(remoteUrl);
  if (remoteRepository === undefined) {
    throw new Error(
      `Invalid GitHub remoteUrl: ${remoteUrl}. Expected owner/repo path.`,
    );
  }

  const ownerIndex = segments.length - 2;
  const refOwner = segments[ownerIndex];
  const refRepository = segments[ownerIndex + 1];
  if (
    refOwner.toLowerCase() !== remoteRepository.owner.toLowerCase()
    || refRepository.toLowerCase() !== remoteRepository.repository.toLowerCase()
  ) {
    throw new Error(
      `Invalid GitHub remoteRef: ${remoteRef}. Owner/repository must match remoteUrl repository ${remoteRepository.owner}/${remoteRepository.repository}.`,
    );
  }

  return segments.join('/');
}

function resolveGitHubRemoteRepository(remoteUrl: string): { owner: string; repository: string } | undefined {
  const pathname = resolveRemotePathname(remoteUrl);
  if (pathname === undefined) {
    return undefined;
  }

  const segments = pathname
    .split('/')
    .map(segment => segment.trim())
    .filter(segment => segment.length > 0);
  if (segments.length !== 2) {
    return undefined;
  }

  const owner = segments[0];
  const repository = segments[1].replace(/\.git$/i, '');
  if (owner.length === 0 || repository.length === 0) {
    return undefined;
  }

  return {
    owner,
    repository,
  };
}

function resolveRemotePathname(remoteUrl: string): string | undefined {
  try {
    const url = new URL(remoteUrl);
    return url.pathname;
  } catch {
    const scpMatch = SCP_REMOTE_REGEX.exec(remoteUrl);
    if (scpMatch?.[2] !== undefined) {
      return `/${scpMatch[2]}`;
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

async function isGitRepository(localPath: string): Promise<boolean> {
  try {
    await access(join(localPath, '.git'));
    return true;
  } catch {
    return false;
  }
}

async function hasExpectedRepositoryOrigin(
  localPath: string,
  expectedRemoteUrl: string,
  environment: NodeJS.ProcessEnv,
): Promise<boolean> {
  const configuredOrigin = await resolveRepositoryOrigin(localPath, environment);
  if (configuredOrigin === undefined) {
    return false;
  }

  return normalizeRemoteForComparison(configuredOrigin) === normalizeRemoteForComparison(expectedRemoteUrl);
}

async function resolveRepositoryOrigin(
  localPath: string,
  environment: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', localPath, 'remote', 'get-url', 'origin'], {
      env: environment,
    });
    const remoteUrl = stdout.trim();
    return remoteUrl.length === 0 ? undefined : remoteUrl;
  } catch (error) {
    if (isMissingOriginRemoteError(error)) {
      return undefined;
    }

    throw error;
  }
}

function isMissingOriginRemoteError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const errorRecord = error as { code?: unknown; stderr?: unknown; message?: unknown };
  if (errorRecord.code !== 2) {
    return false;
  }

  const stderr = toErrorText(errorRecord.stderr);
  const message = typeof errorRecord.message === 'string' ? errorRecord.message : '';
  return /no such remote ['"]origin['"]/i.test(`${stderr}\n${message}`);
}

function toErrorText(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (Buffer.isBuffer(value)) {
    return value.toString('utf8');
  }

  return '';
}

function normalizeRemoteForComparison(remoteUrl: string): string {
  const trimmedRemoteUrl = remoteUrl.trim();
  const scpMatch = SCP_REMOTE_REGEX.exec(trimmedRemoteUrl);
  if (scpMatch !== null) {
    const host = scpMatch[1]?.toLowerCase();
    const path = normalizeRemotePath(scpMatch[2] ?? '');
    return `${host}:${path}`;
  }

  try {
    const parsedUrl = new URL(trimmedRemoteUrl);
    const host = parsedUrl.hostname.toLowerCase();
    const port = parsedUrl.port.length > 0 ? `:${parsedUrl.port}` : '';
    const path = normalizeRemotePath(parsedUrl.pathname);
    return `${parsedUrl.protocol}//${host}${port}${path}`;
  } catch {
    return trimmedRemoteUrl;
  }
}

function normalizeRemotePath(path: string): string {
  const withoutGitSuffix = path.replace(/\.git$/i, '');
  let endIndex = withoutGitSuffix.length;
  while (endIndex > 0 && withoutGitSuffix.codePointAt(endIndex - 1) === 47) {
    endIndex -= 1;
  }

  return withoutGitSuffix.slice(0, endIndex);
}
