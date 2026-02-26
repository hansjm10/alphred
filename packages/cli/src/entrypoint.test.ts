import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isExecutedAsScript, runCliEntrypoint } from './bin.js';
import { createCapturedIo } from './test-support.js';

describe('CLI script entrypoint behavior', () => {
  it('identifies matching script and module paths', () => {
    const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), 'bin.ts');
    expect(isExecutedAsScript(scriptPath, pathToFileURL(scriptPath).href)).toBe(true);
    expect(isExecutedAsScript(undefined, pathToFileURL(scriptPath).href)).toBe(false);
  });

  it('calls runtime.exit for non-zero command results', async () => {
    const exitCodes: number[] = [];
    const captured = createCapturedIo();

    await runCliEntrypoint(
      {
        argv: ['node', 'alphred', 'unknown-command'],
        exit: code => exitCodes.push(code),
      },
      { io: captured.io },
    );

    expect(exitCodes).toEqual([2]);
    expect(captured.stderr[0]).toBe('Unknown command "unknown-command".');
  });

  it('does not call runtime.exit for successful command results', async () => {
    const exitCodes: number[] = [];
    const captured = createCapturedIo();

    await runCliEntrypoint(
      {
        argv: ['node', 'alphred', 'help'],
        exit: code => exitCodes.push(code),
      },
      { io: captured.io },
    );

    expect(exitCodes).toEqual([]);
    expect(captured.stderr).toEqual([]);
    expect(captured.stdout).toContain('Usage: alphred <command> [options]');
  });
});
