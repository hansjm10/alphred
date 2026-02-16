import type { ScmProviderKind } from '@alphred/shared';
import { describe, expect, it } from 'vitest';
import { createDatabase } from './connection.js';
import { migrateDatabase } from './migrate.js';
import {
  getRepositoryById,
  getRepositoryByName,
  insertRepository,
  listRepositories,
  updateRepositoryCloneStatus,
} from './repositories.js';
import { repositories } from './schema.js';

function createMigratedDb() {
  const db = createDatabase(':memory:');
  migrateDatabase(db);
  return db;
}

describe('repository registry CRUD helpers', () => {
  it('inserts a repository and reads it by id and name', () => {
    const db = createMigratedDb();
    const inserted = insertRepository(db, {
      name: 'frontend',
      provider: 'github',
      remoteUrl: 'https://github.com/acme/frontend.git',
      remoteRef: 'acme/frontend',
    });

    expect(inserted.defaultBranch).toBe('main');
    expect(inserted.localPath).toBeNull();
    expect(inserted.cloneStatus).toBe('pending');

    const byId = getRepositoryById(db, inserted.id);
    const byName = getRepositoryByName(db, inserted.name);
    expect(byId).toEqual(inserted);
    expect(byName).toEqual(inserted);
  });

  it('lists repositories in deterministic name order', () => {
    const db = createMigratedDb();
    insertRepository(db, {
      name: 'zeta-service',
      provider: 'github',
      remoteUrl: 'https://github.com/acme/zeta-service.git',
      remoteRef: 'acme/zeta-service',
    });
    insertRepository(db, {
      name: 'alpha-service',
      provider: 'azure-devops',
      remoteUrl: 'https://dev.azure.com/acme/project/_git/alpha-service',
      remoteRef: 'acme/project/alpha-service',
    });

    const listed = listRepositories(db);
    expect(listed.map(repository => repository.name)).toEqual(['alpha-service', 'zeta-service']);
  });

  it('updates clone status and local path', () => {
    const db = createMigratedDb();
    const inserted = insertRepository(db, {
      name: 'backend',
      provider: 'github',
      remoteUrl: 'https://github.com/acme/backend.git',
      remoteRef: 'acme/backend',
    });

    const updated = updateRepositoryCloneStatus(db, {
      repositoryId: inserted.id,
      cloneStatus: 'cloned',
      localPath: '/tmp/alphred/backend',
    });

    expect(updated.cloneStatus).toBe('cloned');
    expect(updated.localPath).toBe('/tmp/alphred/backend');
  });

  it('preserves existing local path when clone-status update omits localPath', () => {
    const db = createMigratedDb();
    const inserted = insertRepository(db, {
      name: 'mobile',
      provider: 'github',
      remoteUrl: 'https://github.com/acme/mobile.git',
      remoteRef: 'acme/mobile',
      localPath: '/tmp/alphred/mobile',
      cloneStatus: 'cloned',
    });

    const updated = updateRepositoryCloneStatus(db, {
      repositoryId: inserted.id,
      cloneStatus: 'error',
    });

    expect(updated.cloneStatus).toBe('error');
    expect(updated.localPath).toBe('/tmp/alphred/mobile');
  });

  it('throws when updating clone status for a missing repository id', () => {
    const db = createMigratedDb();

    expect(() =>
      updateRepositoryCloneStatus(db, {
        repositoryId: 999,
        cloneStatus: 'error',
      }),
    ).toThrow('Repository clone-status update precondition failed for id=999.');
  });

  it('enforces unique repository names', () => {
    const db = createMigratedDb();
    insertRepository(db, {
      name: 'frontend',
      provider: 'github',
      remoteUrl: 'https://github.com/acme/frontend.git',
      remoteRef: 'acme/frontend',
    });

    expect(() =>
      insertRepository(db, {
        name: 'frontend',
        provider: 'azure-devops',
        remoteUrl: 'https://dev.azure.com/acme/project/_git/frontend',
        remoteRef: 'acme/project/frontend',
      }),
    ).toThrow('UNIQUE constraint failed: repositories.name');
  });

  it('validates provider kinds in helper and at DB level', () => {
    const db = createMigratedDb();
    const invalidProvider = 'gitlab' as ScmProviderKind;

    expect(() =>
      insertRepository(db, {
        name: 'invalid-helper',
        provider: invalidProvider,
        remoteUrl: 'https://example.com/repo.git',
        remoteRef: 'group/repo',
      }),
    ).toThrow('Unknown SCM provider: gitlab');

    expect(() =>
      db
        .insert(repositories)
        .values({
          name: 'invalid-db',
          provider: 'gitlab' as never,
          remoteUrl: 'https://example.com/repo.git',
          remoteRef: 'group/repo',
          defaultBranch: 'main',
          localPath: null,
          cloneStatus: 'pending',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        })
        .run(),
    ).toThrow('repositories_provider_ck');
  });
});
