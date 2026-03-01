import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import buildGatePlaywrightConfig from '../../../playwright.build-gate.config.js';
import mainPlaywrightConfig from '../../../playwright.config.js';
import noTestRoutesPlaywrightConfig from '../../../playwright.no-test-routes.config.js';

const DEDICATED_GATE_SPEC_NAMES = ['test-routes-gated.spec.ts', 'test-routes-build-gate.spec.ts'] as const;
const ROOT_TEST_MATCH_PATTERN = '**/*.spec.ts';
const ROOT_GATE_IGNORE_PATTERNS = DEDICATED_GATE_SPEC_NAMES.map((name) => `**/${name}`);

function toStringPatternList(patterns: string | RegExp | readonly (string | RegExp)[] | undefined): string[] {
  if (typeof patterns === 'string') {
    return [patterns];
  }

  if (Array.isArray(patterns)) {
    return patterns.filter((pattern): pattern is string => typeof pattern === 'string');
  }

  return [];
}

async function collectDashboardE2eSpecNames(): Promise<string[]> {
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const e2eDirectory = path.resolve(scriptDirectory, '..', 'e2e');
  const entries = await fs.readdir(e2eDirectory, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.spec.ts'))
    .map((entry) => entry.name)
    .sort();
}

describe('dashboard playwright root discovery', () => {
  it('uses convention-based test discovery with dedicated gate-suite ignores', () => {
    expect(toStringPatternList(mainPlaywrightConfig.testMatch)).toEqual([ROOT_TEST_MATCH_PATTERN]);
    expect(toStringPatternList(mainPlaywrightConfig.testIgnore).sort()).toEqual([...ROOT_GATE_IGNORE_PATTERNS].sort());
  });

  it('keeps dedicated gate suites mapped to dedicated configs', () => {
    expect(toStringPatternList(noTestRoutesPlaywrightConfig.testMatch)).toEqual(['**/test-routes-gated.spec.ts']);
    expect(toStringPatternList(buildGatePlaywrightConfig.testMatch)).toEqual(['**/test-routes-build-gate.spec.ts']);
  });

  it('keeps the dedicated gate-suite ignores in sync with dashboard e2e specs', async () => {
    const specNames = await collectDashboardE2eSpecNames();

    for (const dedicatedSpecName of DEDICATED_GATE_SPEC_NAMES) {
      expect(specNames).toContain(dedicatedSpecName);
    }

    const rootIgnoredSpecNames = toStringPatternList(mainPlaywrightConfig.testIgnore).map((pattern) =>
      pattern.replace('**/', ''),
    );
    expect(rootIgnoredSpecNames.sort()).toEqual([...DEDICATED_GATE_SPEC_NAMES].sort());
  });
});
