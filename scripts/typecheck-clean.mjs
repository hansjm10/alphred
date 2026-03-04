import { existsSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

function readJsonFile(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const rootTsconfigPath = resolve(repoRoot, 'tsconfig.json');
const rootTsconfig = readJsonFile(rootTsconfigPath);
const references = Array.isArray(rootTsconfig.references) ? rootTsconfig.references : [];
const packageReferencePaths = references
  .map((reference) => (typeof reference?.path === 'string' ? reference.path : null))
  .filter((referencePath) => typeof referencePath === 'string' && referencePath.startsWith('./packages/'));

const cleanedPaths = [];
for (const packageReferencePath of packageReferencePaths) {
  const packageDirectory = resolve(repoRoot, packageReferencePath);
  const tsconfigPath = resolve(packageDirectory, 'tsconfig.json');
  if (!existsSync(tsconfigPath)) {
    continue;
  }

  const tsconfig = readJsonFile(tsconfigPath);
  const compilerOptions = tsconfig.compilerOptions ?? {};
  const outDir = resolve(packageDirectory, compilerOptions.outDir ?? 'dist');

  if (existsSync(outDir)) {
    rmSync(outDir, { recursive: true, force: true });
    cleanedPaths.push(outDir);
  }

  if (typeof compilerOptions.tsBuildInfoFile === 'string') {
    const tsBuildInfoPath = resolve(packageDirectory, compilerOptions.tsBuildInfoFile);
    if (!tsBuildInfoPath.startsWith(outDir) && existsSync(tsBuildInfoPath)) {
      rmSync(tsBuildInfoPath, { force: true });
      cleanedPaths.push(tsBuildInfoPath);
    }
  }
}

if (cleanedPaths.length === 0) {
  // eslint-disable-next-line no-console
  console.log('No package build artifacts found to clean.');
  process.exit(0);
}

// eslint-disable-next-line no-console
console.log(['Cleaned package build artifacts:', ...cleanedPaths.map((path) => `- ${path}`)].join('\n'));
