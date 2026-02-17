import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { ScmProviderKind } from '@alphred/shared';

const DEFAULT_SANDBOX_SUBPATH = join('.alphred', 'repos');

export function resolveSandboxDir(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.ALPHRED_SANDBOX_DIR?.trim();
  if (configured && configured.length > 0) {
    return isAbsolute(configured) ? configured : resolve(configured);
  }

  return join(homedir(), DEFAULT_SANDBOX_SUBPATH);
}

export function deriveSandboxRepoPath(
  provider: ScmProviderKind,
  remoteRef: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const segments = resolvePathSegments(provider, remoteRef);
  return join(resolveSandboxDir(environment), provider, ...segments);
}

function resolvePathSegments(provider: ScmProviderKind, remoteRef: string): string[] {
  const parsedSegments = parseRemoteRef(provider, remoteRef);
  return parsedSegments.map(validatePathSegment);
}

function parseRemoteRef(provider: ScmProviderKind, remoteRef: string): string[] {
  const segments = remoteRef
    .split('/')
    .map(segment => segment.trim())
    .filter(segment => segment.length > 0);

  if (provider === 'github') {
    if (segments.length === 2 || segments.length === 3) {
      return segments;
    }

    throw new Error(
      `Invalid GitHub remoteRef: ${remoteRef}. Expected owner/repo or host/owner/repo.`,
    );
  }

  if (segments.length === 3) {
    return segments;
  }

  throw new Error(
    `Invalid Azure DevOps remoteRef: ${remoteRef}. Expected org/project/repository.`,
  );
}

function validatePathSegment(segment: string): string {
  if (segment === '.' || segment === '..') {
    throw new Error(`Invalid sandbox path segment: ${segment}`);
  }

  if (/[\\/]/.test(segment)) {
    throw new Error(`Invalid sandbox path segment: ${segment}`);
  }

  return segment;
}
