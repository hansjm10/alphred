import { describe, it, expect } from 'vitest';
import {
  compareStringsByCodeUnit,
  type AuthStatus,
  type CloneStatus,
  type CreatePrParams,
  type RepositoryConfig,
  type PullRequestResult,
  type RunStatus,
  type ScmProviderKind,
  type PhaseStatus,
  type WorkItem,
  type WorkflowDefinition,
  type GuardExpression,
} from './index.js';

describe('shared types', () => {
  it('should allow valid run statuses', () => {
    const statuses: RunStatus[] = ['pending', 'running', 'paused', 'completed', 'failed', 'cancelled'];
    expect(statuses).toHaveLength(6);
  });

  it('should allow valid phase statuses', () => {
    const statuses: PhaseStatus[] = ['pending', 'running', 'completed', 'failed', 'skipped'];
    expect(statuses).toHaveLength(5);
  });

  it('should type-check a workflow definition', () => {
    const workflow: WorkflowDefinition = {
      name: 'test-workflow',
      version: 1,
      phases: [
        {
          name: 'design',
          type: 'agent',
          provider: 'claude',
          prompt: 'Create a design document',
          maxRetries: 2,
          transitions: [
            { target: 'implement', priority: 1, auto: true },
          ],
        },
      ],
    };
    expect(workflow.phases).toHaveLength(1);
    expect(workflow.phases[0].name).toBe('design');
  });

  it('should type-check guard expressions', () => {
    const guard: GuardExpression = {
      logic: 'and',
      conditions: [
        { field: 'report.approved', operator: '==', value: true },
        { field: 'report.score', operator: '>=', value: 80 },
      ],
    };
    expect('logic' in guard).toBe(true);
  });

  it('should compare strings by locale-independent code-unit order', () => {
    const names = ['zeta', 'angstrom', 'alpha', 'ångstrom'];
    const sorted = [...names].sort(compareStringsByCodeUnit);

    expect(sorted).toEqual(['alpha', 'angstrom', 'zeta', 'ångstrom']);
  });

  it('should type-check normalized scm types', () => {
    const provider: ScmProviderKind = 'github';
    const workItem: WorkItem = {
      id: '42',
      title: 'Broken test',
      body: 'Fix flaky timing',
      labels: ['bug'],
      provider,
    };
    const prParams: CreatePrParams = {
      title: 'Fix flaky test',
      body: 'Stabilize timing assertions',
      sourceBranch: 'fix/flaky-test',
      targetBranch: 'main',
    };
    const prResult: PullRequestResult = {
      id: '123',
      url: 'https://github.com/owner/repo/pull/123',
      provider,
    };

    expect(workItem.labels).toContain('bug');
    expect(prParams.targetBranch).toBe('main');
    expect(prResult.id).toBe('123');
  });

  it('should type-check repository registry types', () => {
    const cloneStatus: CloneStatus = 'pending';
    const repository: RepositoryConfig = {
      id: 1,
      name: 'frontend',
      provider: 'github',
      remoteUrl: 'https://github.com/owner/repo.git',
      remoteRef: 'owner/repo',
      defaultBranch: 'main',
      branchTemplate: null,
      localPath: null,
      cloneStatus,
    };

    expect(repository.cloneStatus).toBe('pending');
    expect(repository.provider).toBe('github');
  });

  it('should type-check scm auth status', () => {
    const ok: AuthStatus = {
      authenticated: true,
      user: 'hansjm10',
      scopes: ['repo', 'read:org'],
    };

    const notOk: AuthStatus = {
      authenticated: false,
      error: 'GitHub auth is not configured.',
    };

    expect(ok.authenticated).toBe(true);
    expect(notOk.error).toContain('not configured');
  });
});
