import { spawn } from 'node:child_process';

function normalizeColorEnv(baseEnv) {
  const env = { ...baseEnv };
  if (env.NO_COLOR !== undefined) {
    delete env.NO_COLOR;
  }
  return env;
}

const cliArgs = process.argv.slice(2);

const child = spawn('playwright', ['test', ...cliArgs], {
  env: normalizeColorEnv(process.env),
  stdio: 'inherit',
});

child.on('error', (error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
