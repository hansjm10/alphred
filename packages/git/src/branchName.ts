import { randomBytes } from 'node:crypto';

export const DEFAULT_BRANCH_TEMPLATE = 'alphred/{tree-key}/{run-id}';

export type BranchNameContext = {
  treeKey: string;
  runId: number;
  nodeKey?: string;
  issueId?: string;
  timestamp?: number;
};

type GenerateBranchNameOptions = {
  now?: () => Date;
  randomHex?: (length: number) => string;
};

const tokenPattern = /\{(tree-key|run-id|node-key|issue-id|timestamp|short-hash|date)\}/g;

function defaultRandomHex(length: number): string {
  return randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length);
}

function collapseRepeatedCharacter(value: string, character: string): string {
  let result = '';
  let previousWasCharacter = false;

  for (const currentCharacter of value) {
    if (currentCharacter === character) {
      if (!previousWasCharacter) {
        result += currentCharacter;
      }
      previousWasCharacter = true;
      continue;
    }

    result += currentCharacter;
    previousWasCharacter = false;
  }

  return result;
}

function trimCharacterEdges(value: string, character: string): string {
  let start = 0;
  let end = value.length;

  while (start < end && value[start] === character) {
    start += 1;
  }

  while (end > start && value[end - 1] === character) {
    end -= 1;
  }

  return value.slice(start, end);
}

function trimDotAndDashEdges(value: string): string {
  return trimCharacterEdges(trimCharacterEdges(value, '.'), '-');
}

function removeHyphenRunsAdjacentToSlash(value: string): string {
  let result = '';
  let index = 0;

  while (index < value.length) {
    if (value[index] !== '-') {
      result += value[index];
      index += 1;
      continue;
    }

    let runEnd = index;
    while (runEnd < value.length && value[runEnd] === '-') {
      runEnd += 1;
    }

    const nextCharacter = value[runEnd] ?? '';
    const previousOutputCharacter = result[result.length - 1] ?? '';
    if (nextCharacter === '/' || previousOutputCharacter === '/') {
      index = runEnd;
      continue;
    }

    result += value.slice(index, runEnd);
    index = runEnd;
  }

  return result;
}

function normalizeTokenValue(value: string | number | null | undefined): string {
  if (value === undefined || value === null) {
    return '';
  }

  const normalized = String(value)
    .trim()
    .toLowerCase()
    .replaceAll(/[\\/]+/g, '-')
    .replaceAll(/[\s_]+/g, '-')
    .replaceAll(/[^a-z0-9.-]+/g, '-');

  return trimDotAndDashEdges(collapseRepeatedCharacter(normalized, '-'));
}

function sanitizeBranchSegment(segment: string): string {
  const withoutControls = Array.from(segment, character => {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f) {
      return '-';
    }

    return character;
  })
    .join('')
    .replaceAll(/[[ ~^:\\?*]+/g, '-')
    .replaceAll(/\.\.+/g, '.')
    .replaceAll('@{', '-');

  let value = trimDotAndDashEdges(collapseRepeatedCharacter(withoutControls, '-'));

  while (value.endsWith('.lock')) {
    value = trimDotAndDashEdges(value.slice(0, -'.lock'.length));
  }

  return value;
}

function sanitizeBranchName(rawBranchName: string): string {
  const rawSegments = rawBranchName
    .replaceAll('\\', '-')
    .replaceAll(/\/+/g, '/')
    .split('/');

  const segments: string[] = [];
  for (const segment of rawSegments) {
    const sanitized = sanitizeBranchSegment(segment);
    if (sanitized.length > 0) {
      segments.push(sanitized);
    }
  }

  let branchName = segments.join('/');
  branchName = removeHyphenRunsAdjacentToSlash(branchName);

  if (branchName.startsWith('-')) {
    branchName = `branch-${branchName.slice(1)}`;
  }

  if (branchName.length === 0) {
    return 'alphred/branch';
  }

  if (branchName.endsWith('.')) {
    branchName = branchName.slice(0, -1);
  }

  if (branchName.length === 0) {
    return 'alphred/branch';
  }

  return branchName;
}

export function resolveBranchTemplate(template?: string | null): string {
  if (template?.trim()) {
    return template.trim();
  }

  const envTemplate = process.env.ALPHRED_BRANCH_TEMPLATE;
  if (envTemplate?.trim()) {
    return envTemplate.trim();
  }

  return DEFAULT_BRANCH_TEMPLATE;
}

export function generateBranchName(
  template: string,
  context: BranchNameContext,
  options: GenerateBranchNameOptions = {},
): string {
  const now = options.now ?? (() => new Date());
  const randomHex = options.randomHex ?? defaultRandomHex;
  const timestamp = context.timestamp ?? Math.floor(now().getTime() / 1000);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);

  const normalizedTemplate = resolveBranchTemplate(template);
  const interpolated = normalizedTemplate.replaceAll(tokenPattern, (_match, token: string) => {
    if (token === 'tree-key') {
      return normalizeTokenValue(context.treeKey);
    }
    if (token === 'run-id') {
      return normalizeTokenValue(context.runId);
    }
    if (token === 'node-key') {
      return normalizeTokenValue(context.nodeKey);
    }
    if (token === 'issue-id') {
      return normalizeTokenValue(context.issueId);
    }
    if (token === 'timestamp') {
      return normalizeTokenValue(timestamp);
    }
    if (token === 'short-hash') {
      return normalizeTokenValue(randomHex(6));
    }

    return normalizeTokenValue(date);
  });

  return sanitizeBranchName(interpolated);
}

export function generateConfiguredBranchName(
  context: BranchNameContext,
  template?: string | null,
  options?: GenerateBranchNameOptions,
): string {
  return generateBranchName(resolveBranchTemplate(template), context, options);
}
