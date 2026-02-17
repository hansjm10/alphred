const EXTRA_HEADER_MARKER = '.extraheader=';
const AUTHORIZATION_PREFIX = 'authorization:';
const HTTP_SCHEME = 'http://';
const HTTPS_SCHEME = 'https://';

function redactGitAuthExtraHeaderArg(arg: string): string {
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

function redactHttpUrlUserInfo(arg: string): string {
  const lowerArg = arg.toLowerCase();
  if (!lowerArg.startsWith(HTTP_SCHEME) && !lowerArg.startsWith(HTTPS_SCHEME)) {
    return arg;
  }

  const authorityStart = arg.indexOf('://') + 3;
  const firstSlashIndex = arg.indexOf('/', authorityStart);
  const firstQueryIndex = arg.indexOf('?', authorityStart);
  const firstHashIndex = arg.indexOf('#', authorityStart);
  const authorityEnd = [firstSlashIndex, firstQueryIndex, firstHashIndex]
    .filter(index => index !== -1)
    .reduce((min, index) => Math.min(min, index), arg.length);
  const userInfoEnd = arg.lastIndexOf('@', authorityEnd - 1);

  if (userInfoEnd < authorityStart) {
    return arg;
  }

  return `${arg.slice(0, authorityStart)}<redacted>@${arg.slice(userInfoEnd + 1)}`;
}

function redactGitAuthArg(arg: string): string {
  return redactHttpUrlUserInfo(redactGitAuthExtraHeaderArg(arg));
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
