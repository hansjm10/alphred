const EXTRA_HEADER_MARKER = '.extraheader=';
const AUTHORIZATION_PREFIX = 'authorization:';

function redactGitAuthArg(arg: string): string {
  const markerIndex = arg.toLowerCase().indexOf(EXTRA_HEADER_MARKER);
  if (markerIndex === -1) {
    return arg;
  }

  const headerStartIndex = markerIndex + EXTRA_HEADER_MARKER.length;
  const rawHeader = arg.slice(headerStartIndex);
  const header = rawHeader.trimStart();
  if (!header.toLowerCase().startsWith(AUTHORIZATION_PREFIX)) {
    return arg;
  }

  const leadingWhitespaceLength = rawHeader.length - header.length;
  const leadingWhitespace = rawHeader.slice(0, leadingWhitespaceLength);

  return `${arg.slice(0, headerStartIndex)}${leadingWhitespace}AUTHORIZATION: <redacted>`;
}

export function redactGitAuthArgs(args: readonly string[]): string[] {
  return args.map(redactGitAuthArg);
}

export function containsGitAuthArgs(args: readonly string[]): boolean {
  return args.some(arg => redactGitAuthArg(arg) !== arg);
}

export function createRedactedGitCommandFailureMessage(
  args: readonly string[],
  prefix: string,
): string {
  const command = `git ${redactGitAuthArgs(args).join(' ')}`;
  return `${prefix}: ${command}`;
}
