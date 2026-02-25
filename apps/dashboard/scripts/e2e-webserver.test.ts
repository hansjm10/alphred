import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireLock, normalizeColorEnv, parseArgs, resolveE2eRuntimeRoot } from './e2e-webserver.mjs';

const tempDirs: string[] = [];

async function createTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('parseArgs', () => {
  it('returns parsed values for valid args', () => {
    expect(parseArgs(['--port=18080', '--test-routes=1', '--build-test-routes=0'])).toEqual({
      port: 18080,
      testRoutes: '1',
      buildTestRoutes: '0',
    });
  });

  it('throws for missing or invalid port', () => {
    expect(() => parseArgs(['--test-routes=1', '--build-test-routes=1'])).toThrow(/--port/);
    expect(() => parseArgs(['--port=0', '--test-routes=1', '--build-test-routes=1'])).toThrow(/--port/);
    expect(() => parseArgs(['--port=65536', '--test-routes=1', '--build-test-routes=1'])).toThrow(/--port/);
    expect(() => parseArgs(['--port=18080.5', '--test-routes=1', '--build-test-routes=1'])).toThrow(/--port/);
    expect(() => parseArgs(['--port=abc', '--test-routes=1', '--build-test-routes=1'])).toThrow(/--port/);
  });

  it('throws for invalid test-route flags', () => {
    expect(() => parseArgs(['--port=18080', '--test-routes=2', '--build-test-routes=1'])).toThrow(/--test-routes/);
    expect(() => parseArgs(['--port=18080', '--test-routes=1', '--build-test-routes=2'])).toThrow(
      /--build-test-routes/,
    );
  });
});

describe('normalizeColorEnv', () => {
  it('drops NO_COLOR when FORCE_COLOR is present', () => {
    expect(normalizeColorEnv({ FORCE_COLOR: '1', NO_COLOR: '1', PATH: '/tmp/bin' })).toEqual({
      FORCE_COLOR: '1',
      PATH: '/tmp/bin',
    });
  });

  it('drops NO_COLOR when FORCE_COLOR is absent', () => {
    expect(normalizeColorEnv({ NO_COLOR: '1', PATH: '/tmp/bin' })).toEqual({
      PATH: '/tmp/bin',
    });
  });
});

describe('acquireLock', () => {
  it('creates lock directory when it is available', async () => {
    const root = await createTempDir('alphred-e2e-lock-success-');
    const lockDir = path.join(root, 'lock');

    await expect(acquireLock(lockDir, { timeoutMs: 100 })).resolves.toBeUndefined();
    await expect(fs.stat(lockDir)).resolves.toBeDefined();
  });

  it('throws timeout when lock directory stays present', async () => {
    const root = await createTempDir('alphred-e2e-lock-timeout-');
    const lockDir = path.join(root, 'lock');
    await fs.mkdir(lockDir);

    let tick = 0;
    const nowFn = () => {
      tick += 50;
      return tick;
    };

    await expect(
      acquireLock(lockDir, {
        timeoutMs: 75,
        pollIntervalMs: 0,
        sleepFn: async () => undefined,
        nowFn,
      }),
    ).rejects.toThrow(/Timed out after 75ms waiting for e2e build lock/);
  });
});

describe('resolveE2eRuntimeRoot', () => {
  it('resolves suite-local runtime directories by port', () => {
    expect(resolveE2eRuntimeRoot('/repo/apps/dashboard', 18080)).toBe(
      path.join('/repo/apps/dashboard', '.e2e-runtime', 'port-18080'),
    );
    expect(resolveE2eRuntimeRoot('/repo/apps/dashboard', 18081)).toBe(
      path.join('/repo/apps/dashboard', '.e2e-runtime', 'port-18081'),
    );
  });
});
