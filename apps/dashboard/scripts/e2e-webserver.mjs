import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function parseArgs(argv) {
  const args = {
    port: null,
    testRoutes: null,
    buildTestRoutes: null,
  };

  for (const raw of argv) {
    if (raw.startsWith('--port=')) {
      const portRaw = raw.slice('--port='.length).trim();
      args.port = /^\d+$/.test(portRaw) ? Number(portRaw) : Number.NaN;
    } else if (raw.startsWith('--test-routes=')) {
      args.testRoutes = raw.slice('--test-routes='.length);
    } else if (raw.startsWith('--build-test-routes=')) {
      args.buildTestRoutes = raw.slice('--build-test-routes='.length);
    }
  }

  if (!Number.isInteger(args.port) || args.port < 1 || args.port > 65_535) {
    throw new Error('Missing/invalid --port=... (expected integer in range 1..65535).');
  }
  if (args.testRoutes !== '0' && args.testRoutes !== '1') {
    throw new Error("Missing/invalid --test-routes=... (expected '0' or '1').");
  }
  if (args.buildTestRoutes !== '0' && args.buildTestRoutes !== '1') {
    throw new Error("Missing/invalid --build-test-routes=... (expected '0' or '1').");
  }

  return args;
}

async function fileExists(p) {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

function parsePositiveIntEnv(name) {
  const raw = process.env[name];
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.trunc(value);
}

function sleep(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

export function normalizeColorEnv(baseEnv) {
  const sanitized = { ...baseEnv };
  // pnpm can inject FORCE_COLOR for child Node processes, which conflicts with inherited NO_COLOR.
  if (sanitized.NO_COLOR !== undefined) {
    delete sanitized.NO_COLOR;
  }
  return sanitized;
}

export async function acquireLock(
  lockDir,
  { timeoutMs, pollIntervalMs = 250, sleepFn = sleep, nowFn = Date.now },
) {
  const startedAt = nowFn();
  // Cross-platform lock: mkdir is atomic. Wait until the directory can be created.
  for (;;) {
    try {
      await fs.mkdir(lockDir);
      return;
    } catch (err) {
      if (err && err.code === 'EEXIST') {
        if (nowFn() - startedAt > timeoutMs) {
          throw new Error(
            [
              `Timed out after ${timeoutMs}ms waiting for e2e build lock: ${lockDir}`,
              `A previous run may have been interrupted and left a stale lock directory.`,
              `Fix: rm -rf ${lockDir}`,
              `Override: set ALPHRED_E2E_BUILD_LOCK_TIMEOUT_MS to a larger value.`,
            ].join('\n'),
          );
        }
        await sleepFn(pollIntervalMs);
        continue;
      }
      throw err;
    }
  }
}

async function releaseLock(lockDir) {
  await fs.rm(lockDir, { recursive: true, force: true });
}

function run(cmd, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...options, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`));
    });
  });
}

function runCapture(cmd, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...options, stdio: ['ignore', 'pipe', 'inherit'] });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`));
    });
  });
}

async function main() {
  const { port, testRoutes, buildTestRoutes } = parseArgs(process.argv.slice(2));

  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const dashboardDir = path.resolve(scriptDir, '..'); // apps/dashboard
  const repoRoot = path.resolve(dashboardDir, '..', '..');
  const sanitizedEnv = normalizeColorEnv(process.env);

  const nextDir = path.join(dashboardDir, '.next');
  const buildIdPath = path.join(nextDir, 'BUILD_ID');
  const buildMarkerPath = path.join(nextDir, '.e2e-build-rev');
  const lockDir = path.join(dashboardDir, '.e2e-build-lock');
  // Allow concurrent e2e suites to share a single build, but fail eventually if the lock is stale.
  const lockTimeoutMs = parsePositiveIntEnv('ALPHRED_E2E_BUILD_LOCK_TIMEOUT_MS') ?? 180_000;

  const envForServer = {
    ...sanitizedEnv,
    // Force explicit behavior per suite, while still using a shared build output.
    ALPHRED_DASHBOARD_TEST_ROUTES: testRoutes,
  };

  const envForBuild = {
    ...sanitizedEnv,
    // Compile-time flag baked by next.config.ts for /test/* route availability.
    ALPHRED_DASHBOARD_TEST_ROUTES_BUILD: buildTestRoutes,
  };

  await acquireLock(lockDir, { timeoutMs: lockTimeoutMs });
  try {
    const currentRev = await runCapture('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, env: sanitizedEnv });
    const dirtyStatus = await runCapture('git', ['status', '--porcelain'], { cwd: repoRoot, env: sanitizedEnv });
    const buildKey = `${currentRev}\n${dirtyStatus}\nALPHRED_DASHBOARD_TEST_ROUTES_BUILD=${buildTestRoutes}\n`;

    const hasBuild = await fileExists(buildIdPath);
    const markerMatches =
      hasBuild && (await fileExists(buildMarkerPath)) ? (await fs.readFile(buildMarkerPath, 'utf8')) === buildKey : false;

    if (!markerMatches) {
      await run(
        'pnpm',
        ['--filter', '@alphred/dashboard', 'exec', 'next', 'build'],
        { cwd: repoRoot, env: envForBuild },
      );

      // Stamp the build with the repo revision so concurrent suites don't rebuild on top of a running server.
      await fs.mkdir(nextDir, { recursive: true });
      await fs.writeFile(buildMarkerPath, buildKey, 'utf8');
    }
  } finally {
    await releaseLock(lockDir);
  }

  // Keep running until Playwright stops us.
  await run(
    'pnpm',
    ['--filter', '@alphred/dashboard', 'exec', 'next', 'start', '--port', String(port)],
    { cwd: repoRoot, env: envForServer },
  );
}

const isDirectExecution = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}
