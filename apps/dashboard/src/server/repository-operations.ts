import {
  getRepositoryByName,
  insertRepository,
  listRepositories as listRepositoryConfigs,
  type AlphredDatabase,
} from '@alphred/db';
import {
  ensureRepositoryClone,
  type RepositorySyncStrategy,
  type ScmProviderConfig,
} from '@alphred/git';
import {
  type AuthStatus,
  type RepositoryConfig,
} from '@alphred/shared';
import type {
  DashboardCreateRepositoryRequest,
  DashboardCreateRepositoryResult,
  DashboardGitHubAuthStatus,
  DashboardRepositoryState,
  DashboardRepositorySyncRequest,
  DashboardRepositorySyncResult,
} from './dashboard-contracts';
import { DashboardIntegrationError } from './dashboard-errors';
import {
  parseAzureRemoteRef,
  parseGitHubRemoteRef,
  toRepositoryState,
  toRepositorySyncDetails,
} from './dashboard-snapshots';

const DEFAULT_GITHUB_AUTH_REPO = 'octocat/Hello-World';

type WithDatabase = <T>(operation: (db: AlphredDatabase) => Promise<T> | T) => Promise<T>;

export type RepositoryOperationsDependencies = {
  createScmProvider: (config: ScmProviderConfig) => {
    checkAuth: (environment?: NodeJS.ProcessEnv) => Promise<AuthStatus>;
  };
  ensureRepositoryClone: typeof ensureRepositoryClone;
};

export type RepositoryOperations = {
  listRepositories: () => Promise<DashboardRepositoryState[]>;
  createRepository: (request: DashboardCreateRepositoryRequest) => Promise<DashboardCreateRepositoryResult>;
  checkGitHubAuth: () => Promise<DashboardGitHubAuthStatus>;
  syncRepository: (repositoryName: string, request?: DashboardRepositorySyncRequest) => Promise<DashboardRepositorySyncResult>;
};

export function toAuthScmProviderConfig(repository: Pick<RepositoryConfig, 'provider' | 'remoteRef'>): ScmProviderConfig {
  if (repository.provider === 'github') {
    return {
      kind: 'github',
      repo: repository.remoteRef,
    };
  }

  const parsed = parseAzureRemoteRef(repository.remoteRef);
  return {
    kind: 'azure-devops',
    organization: parsed.organization,
    project: parsed.project,
    repository: parsed.repository,
  };
}

export async function ensureRepositoryAuth(
  repository: Pick<RepositoryConfig, 'provider' | 'remoteRef'>,
  dependencies: Pick<RepositoryOperationsDependencies, 'createScmProvider'>,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const provider = dependencies.createScmProvider(toAuthScmProviderConfig(repository));
  const authStatus = await provider.checkAuth(environment);
  if (authStatus.authenticated) {
    return;
  }

  const providerLabel = repository.provider === 'github' ? 'GitHub' : 'Azure DevOps';
  throw new DashboardIntegrationError(
    'auth_required',
    authStatus.error?.trim() || `${providerLabel} authentication is required.`,
    {
      status: 401,
      details: {
        provider: repository.provider,
      },
    },
  );
}

export function createRepositoryOperations(params: {
  withDatabase: WithDatabase;
  dependencies: RepositoryOperationsDependencies;
  environment: NodeJS.ProcessEnv;
}): RepositoryOperations {
  const { withDatabase, dependencies, environment } = params;

  return {
    listRepositories(): Promise<DashboardRepositoryState[]> {
      return withDatabase(async db => listRepositoryConfigs(db).map(toRepositoryState));
    },

    async createRepository(request: DashboardCreateRepositoryRequest): Promise<DashboardCreateRepositoryResult> {
      const trimmedName = request.name.trim();
      if (trimmedName.length === 0) {
        throw new DashboardIntegrationError('invalid_request', 'Repository name cannot be empty.', {
          status: 400,
        });
      }

      const trimmedRemoteRef = request.remoteRef.trim();
      if (trimmedRemoteRef.length === 0) {
        throw new DashboardIntegrationError('invalid_request', 'Repository remoteRef cannot be empty.', {
          status: 400,
        });
      }

      return withDatabase(async db => {
        const existing = getRepositoryByName(db, trimmedName);
        if (existing) {
          throw new DashboardIntegrationError('conflict', `Repository "${trimmedName}" already exists.`, {
            status: 409,
          });
        }

        const parsedRemoteRef = parseGitHubRemoteRef(trimmedRemoteRef);
        const inserted = insertRepository(db, {
          name: trimmedName,
          provider: request.provider,
          remoteRef: `${parsedRemoteRef.owner}/${parsedRemoteRef.repository}`,
          remoteUrl: `https://github.com/${parsedRemoteRef.owner}/${parsedRemoteRef.repository}.git`,
        });

        return {
          repository: toRepositoryState(inserted),
        };
      });
    },

    checkGitHubAuth(): Promise<DashboardGitHubAuthStatus> {
      return withDatabase(async db => {
        const githubRepo = listRepositoryConfigs(db).find(repository => repository.provider === 'github');
        const provider = dependencies.createScmProvider({
          kind: 'github',
          repo: githubRepo?.remoteRef ?? environment.ALPHRED_DASHBOARD_GITHUB_AUTH_REPO ?? DEFAULT_GITHUB_AUTH_REPO,
        });
        const auth = await provider.checkAuth(environment);

        return {
          authenticated: auth.authenticated,
          user: auth.user ?? null,
          scopes: auth.scopes ?? [],
          error: auth.error ?? null,
        };
      });
    },

    syncRepository(repositoryName: string, request: DashboardRepositorySyncRequest = {}): Promise<DashboardRepositorySyncResult> {
      const trimmedRepositoryName = repositoryName.trim();
      if (trimmedRepositoryName.length === 0) {
        throw new DashboardIntegrationError('invalid_request', 'Repository name cannot be empty.', {
          status: 400,
        });
      }
      const strategy: RepositorySyncStrategy = request.strategy ?? 'ff-only';

      return withDatabase(async db => {
        const repository = getRepositoryByName(db, trimmedRepositoryName);
        if (!repository) {
          throw new DashboardIntegrationError('not_found', `Repository "${trimmedRepositoryName}" was not found.`, {
            status: 404,
          });
        }

        await ensureRepositoryAuth(repository, dependencies, environment);

        const cloned = await dependencies.ensureRepositoryClone({
          db,
          repository: {
            name: repository.name,
            provider: repository.provider,
            remoteUrl: repository.remoteUrl,
            remoteRef: repository.remoteRef,
            defaultBranch: repository.defaultBranch,
          },
          environment,
          sync: {
            mode: 'pull',
            strategy,
          },
        });
        const syncDetails = toRepositorySyncDetails(cloned.sync, cloned.repository.defaultBranch);
        if (syncDetails.status === 'conflicted') {
          throw new DashboardIntegrationError(
            'conflict',
            syncDetails.conflictMessage ?? 'Repository sync encountered conflicts.',
            {
              status: 409,
              details: {
                strategy,
                branch: syncDetails.branch,
              },
            },
          );
        }

        return {
          action: cloned.action,
          repository: toRepositoryState(cloned.repository),
          sync: syncDetails,
        };
      });
    },
  };
}
