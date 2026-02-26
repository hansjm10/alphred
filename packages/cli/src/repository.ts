import {
  getRepositoryByName,
  insertRepository,
  type AlphredDatabase,
  type InsertRepositoryParams,
} from '@alphred/db';
import type { ScmProviderConfig } from '@alphred/git';
import type { RepositoryConfig } from '@alphred/shared';
import { parseRunRepositoryInput } from './parsing.js';
import type { ResolvedRunRepository } from './types.js';

export function assertRepositoryIdentity(
  existing: RepositoryConfig,
  expected: Pick<InsertRepositoryParams, 'provider' | 'remoteRef' | 'remoteUrl'>,
): void {
  if (existing.provider !== expected.provider) {
    throw new Error(
      `Repository "${existing.name}" provider mismatch. Existing=${existing.provider}, expected=${expected.provider}.`,
    );
  }

  if (existing.remoteRef !== expected.remoteRef) {
    throw new Error(
      `Repository "${existing.name}" remoteRef mismatch. Existing=${existing.remoteRef}, expected=${expected.remoteRef}.`,
    );
  }

  if (existing.remoteUrl !== expected.remoteUrl) {
    throw new Error(
      `Repository "${existing.name}" remoteUrl mismatch. Existing=${existing.remoteUrl}, expected=${expected.remoteUrl}.`,
    );
  }
}

export function resolveRunRepository(db: AlphredDatabase, value: string): ResolvedRunRepository {
  const parsedInput = parseRunRepositoryInput(value);
  if (parsedInput.kind === 'name') {
    const existing = getRepositoryByName(db, parsedInput.repoName);
    if (!existing) {
      throw new Error(`Repository "${parsedInput.repoName}" was not found.`);
    }
    return {
      repoName: existing.name,
      autoRegistered: false,
    };
  }

  const existing = getRepositoryByName(db, parsedInput.repoName);
  if (existing) {
    assertRepositoryIdentity(existing, {
      provider: parsedInput.provider,
      remoteRef: parsedInput.remoteRef,
      remoteUrl: parsedInput.remoteUrl,
    });
    return {
      repoName: existing.name,
      autoRegistered: false,
    };
  }

  insertRepository(db, {
    name: parsedInput.repoName,
    provider: parsedInput.provider,
    remoteRef: parsedInput.remoteRef,
    remoteUrl: parsedInput.remoteUrl,
  });
  return {
    repoName: parsedInput.repoName,
    autoRegistered: true,
    provider: parsedInput.provider,
    remoteRef: parsedInput.remoteRef,
  };
}

export function renderRepositoryTableRows(repositoryRows: readonly RepositoryConfig[]): string[] {
  const headers = ['NAME', 'PROVIDER', 'REMOTE_REF', 'CLONE_STATUS', 'LOCAL_PATH'] as const;
  const rows = repositoryRows.map(repository => [
    repository.name,
    repository.provider,
    repository.remoteRef,
    repository.cloneStatus,
    repository.localPath ?? '-',
  ]);
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map(row => row[index]?.length ?? 0)),
  );
  const toLine = (values: readonly string[]) =>
    values
      .map((value, index) => value.padEnd(widths[index] ?? 0))
      .join('  ');

  const divider = widths.map(width => '-'.repeat(width)).join('  ');
  return [
    toLine(headers),
    divider,
    ...rows.map(toLine),
  ];
}

export function formatScmProviderLabel(provider: RepositoryConfig['provider']): string {
  return provider === 'github' ? 'GitHub' : 'Azure DevOps';
}

export function toScmProviderConfigForAuth(
  repository: Pick<RepositoryConfig, 'provider' | 'remoteRef'>,
): ScmProviderConfig {
  if (repository.provider === 'github') {
    return {
      kind: 'github',
      repo: repository.remoteRef,
    };
  }

  const segments = repository.remoteRef
    .split('/')
    .map(segment => segment.trim())
    .filter(segment => segment.length > 0);
  if (segments.length !== 3) {
    throw new Error(
      `Invalid Azure repository reference "${repository.remoteRef}". Expected org/project/repository.`,
    );
  }

  return {
    kind: 'azure-devops',
    organization: segments[0],
    project: segments[1],
    repository: segments[2],
  };
}
