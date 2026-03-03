import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs;

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const localVitest = resolve(
  repoRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'vitest.cmd' : 'vitest',
);
const vitestCommand = existsSync(localVitest) ? localVitest : process.platform === 'win32' ? 'vitest.cmd' : 'vitest';
const child = spawn(vitestCommand, ['run', ...args], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  detached: process.platform !== 'win32',
});

let shutdownSignal;
let forceKillTimer;
let postKillExitTimer;

function terminateWithSignal(signal) {
  for (const s of signalsToForward) process.removeAllListeners(s);
  process.kill(process.pid, signal);
}

function killChild(signal) {
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // ignore and fall back
    }
  }

  try {
    child.kill(signal);
  } catch {
    // ignore
  }
}

function forwardAndExit(signal) {
  if (shutdownSignal) return void killChild('SIGKILL');
  shutdownSignal = signal;

  killChild(signal);

  forceKillTimer = setTimeout(() => {
    killChild('SIGKILL');
    postKillExitTimer = setTimeout(() => terminateWithSignal(signal), 1000);
    postKillExitTimer.unref?.();
  }, 5000);
  forceKillTimer.unref?.();
}

const signalsToForward =
  process.platform === 'win32' ? ['SIGINT', 'SIGTERM', 'SIGBREAK'] : ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'];

for (const signal of signalsToForward) {
  process.on(signal, () => forwardAndExit(signal));
}

child.on('exit', (code, signal) => {
  if (forceKillTimer) clearTimeout(forceKillTimer);
  if (postKillExitTimer) clearTimeout(postKillExitTimer);
  if (shutdownSignal) return void terminateWithSignal(shutdownSignal);
  if (signal) return void terminateWithSignal(signal);
  process.exit(code ?? 1);
});

child.on('error', (error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
