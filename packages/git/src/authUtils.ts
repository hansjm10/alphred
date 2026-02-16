export function createAuthErrorMessage(
  prefix: string,
  guidance: string | string[],
  error: unknown,
): string {
  const steps = Array.isArray(guidance) ? guidance.join(' | ') : guidance;
  const details = extractCommandErrorDetail(error);
  const message = `${prefix}. ${steps}`;

  if (!details) {
    return message;
  }

  return `${message}. CLI output: ${details}`;
}

export function extractCommandErrorDetail(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null) {
    const maybeStdout = (error as { stdout?: unknown }).stdout;
    const maybeStderr = (error as { stderr?: unknown }).stderr;
    const stdout = typeof maybeStdout === 'string' ? maybeStdout : '';
    const stderr = typeof maybeStderr === 'string' ? maybeStderr : '';
    const combined = `${stdout}\n${stderr}`
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .join(' ');

    if (combined.length > 0) {
      return combined;
    }
  }

  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim();
  }

  return undefined;
}
