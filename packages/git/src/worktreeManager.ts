import {
  getRunWorktreeById,
  getRepositoryById,
  getRepositoryByName,
  insertRunWorktree,
  listRunWorktreesForRun,
  markRunWorktreeRemoved,
  type AlphredDatabase,
  type RunWorktreeRecord,
} from '@alphred/db';
import type { RepositoryConfig } from '@alphred/shared';
import {
  createWorktree as defaultCreateWorktree,
  removeWorktree as defaultRemoveWorktree,
  type WorktreeInfo,
} from './worktree.js';
import {
  installDependencies as defaultInstallDependencies,
  type InstallDepsOptions,
  type InstallDepsResult,
  type InstallOutput,
} from './installDeps.js';
import {
  ensureRepositoryClone as defaultEnsureRepositoryClone,
  type EnsureRepositoryCloneResult,
} from './repositoryClone.js';

export type ManagedWorktree = {
  id: number;
  runId: number;
  repositoryId: number;
  path: string;
  branch: string;
  commitHash: string | null;
  createdAt: string;
};

export type CreateRunWorktreeParams = {
  repoName: string;
  treeKey: string;
  runId: number;
  nodeKey?: string;
  branch?: string;
  branchTemplate?: string;
  baseBranch?: string;
  skipInstall?: boolean;
};

export type WorktreeManagerOptions = {
  worktreeBase: string;
  environment?: NodeJS.ProcessEnv;
  installTimeoutMs?: number;
  onInstallOutput?: (output: InstallOutput) => void;
  createWorktree?: (
    repoDir: string,
    worktreeBase: string,
    params: {
      branch?: string;
      branchTemplate?: string | null;
      branchContext?: {
        treeKey: string;
        runId: number;
        nodeKey?: string;
      };
      baseRef?: string;
    },
  ) => Promise<WorktreeInfo>;
  removeWorktree?: (repoDir: string, worktreePath: string) => Promise<void>;
  ensureRepositoryClone?: (params: {
    db: AlphredDatabase;
    repository: {
      name: string;
      provider: RepositoryConfig['provider'];
      remoteUrl: string;
      remoteRef: string;
      defaultBranch?: string;
    };
    environment?: NodeJS.ProcessEnv;
  }) => Promise<EnsureRepositoryCloneResult>;
  installDependencies?: (params: InstallDepsOptions) => Promise<InstallDepsResult>;
};

function toManagedWorktree(record: RunWorktreeRecord): ManagedWorktree {
  return {
    id: record.id,
    runId: record.workflowRunId,
    repositoryId: record.repositoryId,
    path: record.worktreePath,
    branch: record.branch,
    commitHash: record.commitHash,
    createdAt: record.createdAt,
  };
}

export class WorktreeManager {
  private readonly db: AlphredDatabase;
  private readonly worktreeBase: string;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly createWorktree: NonNullable<WorktreeManagerOptions['createWorktree']>;
  private readonly removeWorktree: NonNullable<WorktreeManagerOptions['removeWorktree']>;
  private readonly ensureRepositoryClone: NonNullable<WorktreeManagerOptions['ensureRepositoryClone']>;
  private readonly installDependencies: NonNullable<WorktreeManagerOptions['installDependencies']>;
  private readonly installTimeoutMs: number | undefined;
  private readonly onInstallOutput: ((output: InstallOutput) => void) | undefined;

  constructor(db: AlphredDatabase, options: WorktreeManagerOptions) {
    this.db = db;
    this.worktreeBase = options.worktreeBase;
    this.environment = options.environment ?? process.env;
    this.createWorktree = options.createWorktree ?? defaultCreateWorktree;
    this.removeWorktree = options.removeWorktree ?? defaultRemoveWorktree;
    this.ensureRepositoryClone = options.ensureRepositoryClone ?? defaultEnsureRepositoryClone;
    this.installDependencies = options.installDependencies ?? defaultInstallDependencies;
    this.installTimeoutMs = options.installTimeoutMs;
    this.onInstallOutput = options.onInstallOutput;
  }

  async createRunWorktree(params: CreateRunWorktreeParams): Promise<ManagedWorktree> {
    const repository = getRepositoryByName(this.db, params.repoName);
    if (!repository) {
      throw new Error(`Repository "${params.repoName}" was not found in the registry.`);
    }

    const ensured = await this.ensureRepositoryClone({
      db: this.db,
      repository: {
        name: repository.name,
        provider: repository.provider,
        remoteUrl: repository.remoteUrl,
        remoteRef: repository.remoteRef,
        defaultBranch: repository.defaultBranch,
      },
      environment: this.environment,
    });
    const clonedRepository = ensured.repository;
    if (!clonedRepository.localPath) {
      throw new Error(`Repository "${clonedRepository.name}" does not have a local clone path.`);
    }

    const trimmedBranch = params.branch?.trim();
    const createParams = trimmedBranch && trimmedBranch.length > 0
      ? {
        branch: trimmedBranch,
        baseRef: params.baseBranch ?? clonedRepository.defaultBranch,
      }
      : {
        branchTemplate: params.branchTemplate ?? clonedRepository.branchTemplate,
        branchContext: {
          treeKey: params.treeKey,
          runId: params.runId,
          nodeKey: params.nodeKey,
        },
        baseRef: params.baseBranch ?? clonedRepository.defaultBranch,
      };

    const worktree = await this.createWorktree(
      clonedRepository.localPath,
      this.worktreeBase,
      createParams,
    );

    await this.installDependencies({
      worktreePath: worktree.path,
      environment: this.environment,
      skipInstall: params.skipInstall,
      timeoutMs: this.installTimeoutMs,
      onOutput: this.onInstallOutput,
    });

    const persisted = insertRunWorktree(this.db, {
      workflowRunId: params.runId,
      repositoryId: clonedRepository.id,
      worktreePath: worktree.path,
      branch: worktree.branch,
      commitHash: worktree.commit,
    });

    return toManagedWorktree(persisted);
  }

  async removeRunWorktree(worktreeId: number): Promise<void> {
    const activeRecord = getRunWorktreeById(this.db, worktreeId);
    if (!activeRecord) {
      throw new Error(`Run-worktree id=${worktreeId} was not found.`);
    }
    if (activeRecord.status === 'removed') {
      return;
    }

    const repository = getRepositoryById(this.db, activeRecord.repositoryId);
    if (!repository) {
      throw new Error(`Repository id=${activeRecord.repositoryId} for run-worktree id=${worktreeId} was not found.`);
    }
    if (!repository.localPath) {
      throw new Error(
        `Repository "${repository.name}" has no local_path; cannot remove run-worktree id=${worktreeId}.`,
      );
    }

    await this.removeWorktree(repository.localPath, activeRecord.worktreePath);
    markRunWorktreeRemoved(this.db, {
      runWorktreeId: activeRecord.id,
    });
  }

  async listRunWorktrees(runId: number): Promise<ManagedWorktree[]> {
    return listRunWorktreesForRun(this.db, runId, { status: 'active' }).map(toManagedWorktree);
  }

  async cleanupRun(runId: number): Promise<void> {
    const worktrees = listRunWorktreesForRun(this.db, runId, { status: 'active' });
    for (const worktree of worktrees) {
      await this.removeRunWorktree(worktree.id);
    }
  }
}
