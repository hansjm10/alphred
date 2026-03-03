import { spawn } from 'node:child_process';

const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs;

const vitestCommand = process.platform === 'win32' ? 'vitest.cmd' : 'vitest';
const child = spawn(vitestCommand, ['run', ...args], { stdio: 'inherit' });

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});

child.on('error', (error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
