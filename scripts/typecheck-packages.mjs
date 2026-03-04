import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const isWindows = process.platform === 'win32';
const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const checkOnly = process.argv.includes('--check-only');

function readJsonFile(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function hasDeclarationFiles(directoryPath) {
  if (!existsSync(directoryPath)) return false;

  const queue = [directoryPath];
  while (queue.length > 0) {
    const current = queue.pop();
    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const nextPath = resolve(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(nextPath);
        continue;
      }

      if (
        entry.isFile() &&
        (entry.name.endsWith('.d.ts') ||
          entry.name.endsWith('.d.mts') ||
          entry.name.endsWith('.d.cts'))
      ) {
        return true;
      }
    }
  }

  return false;
}

const declarationExtensionBySourceExtension = new Map([
  ['.ts', '.d.ts'],
  ['.tsx', '.d.ts'],
  ['.mts', '.d.mts'],
  ['.cts', '.d.cts'],
]);

function getDeclarationExtensionForSourceFile(fileName) {
  if (fileName.endsWith('.d.ts') || fileName.endsWith('.d.mts') || fileName.endsWith('.d.cts')) {
    return null;
  }

  for (const [sourceExtension, declarationExtension] of declarationExtensionBySourceExtension) {
    if (fileName.endsWith(sourceExtension)) {
      return declarationExtension;
    }
  }

  return null;
}

function getMissingDeclarationOutputs(rootDirectoryPath, outputDirectoryPath) {
  if (!existsSync(rootDirectoryPath)) return [];

  const missingDeclarations = [];
  const queue = [rootDirectoryPath];

  while (queue.length > 0) {
    const current = queue.pop();
    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const nextPath = resolve(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(nextPath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const declarationExtension = getDeclarationExtensionForSourceFile(entry.name);
      if (!declarationExtension) {
        continue;
      }

      const relativeSourcePath = relative(rootDirectoryPath, nextPath);
      const declarationRelativePath = relativeSourcePath.replace(/\.[^.]+$/, declarationExtension);
      const declarationPath = resolve(outputDirectoryPath, declarationRelativePath);

      if (!existsSync(declarationPath)) {
        missingDeclarations.push(declarationPath);
      }
    }
  }

  return missingDeclarations;
}

function getPackageReferencePaths() {
  const rootTsconfigPath = resolve(repoRoot, 'tsconfig.json');
  const rootTsconfig = readJsonFile(rootTsconfigPath);
  const references = Array.isArray(rootTsconfig.references) ? rootTsconfig.references : [];

  return references
    .map((reference) => (typeof reference?.path === 'string' ? reference.path : null))
    .filter((referencePath) => typeof referencePath === 'string' && referencePath.startsWith('./packages/'));
}

function packageHasStaleBuildArtifacts(packageReferencePath) {
  const packageDirectory = resolve(repoRoot, packageReferencePath);
  const tsconfigPath = resolve(packageDirectory, 'tsconfig.json');
  const packageJsonPath = resolve(packageDirectory, 'package.json');

  if (!existsSync(tsconfigPath) || !existsSync(packageJsonPath)) {
    return false;
  }

  const tsconfig = readJsonFile(tsconfigPath);
  const packageJson = readJsonFile(packageJsonPath);
  const compilerOptions = tsconfig.compilerOptions ?? {};
  const outDir = resolve(packageDirectory, compilerOptions.outDir ?? 'dist');
  const rootDir = resolve(packageDirectory, compilerOptions.rootDir ?? '.');
  const tsBuildInfoPath = resolve(
    packageDirectory,
    compilerOptions.tsBuildInfoFile ?? `${compilerOptions.outDir ?? 'dist'}/tsconfig.tsbuildinfo`,
  );

  if (!existsSync(tsBuildInfoPath)) {
    return false;
  }

  const typesPath =
    typeof packageJson.types === 'string' ? resolve(packageDirectory, packageJson.types) : null;
  const hasTypesEntry = typesPath ? existsSync(typesPath) : true;
  const hasDeclarations = hasDeclarationFiles(outDir);
  const missingDeclarations = getMissingDeclarationOutputs(rootDir, outDir);

  return !hasTypesEntry || !hasDeclarations || missingDeclarations.length > 0;
}

function getStalePackageReferences() {
  return getPackageReferencePaths().filter((referencePath) =>
    packageHasStaleBuildArtifacts(referencePath),
  );
}

function reportStaleArtifacts(stalePackageReferences, logger) {
  logger(
    [
      'Detected stale TypeScript incremental artifacts (`tsbuildinfo` present but declaration outputs are missing):',
      ...stalePackageReferences.map((path) => `- ${path}`),
      'Run `pnpm typecheck:clean && pnpm typecheck` to recover.',
    ].join('\n'),
  );
}

function runTypecheck(forceRebuild) {
  const localTsc = resolve(repoRoot, 'node_modules', '.bin', isWindows ? 'tsc.cmd' : 'tsc');
  const tscCommand = existsSync(localTsc) ? localTsc : isWindows ? 'tsc.cmd' : 'tsc';
  const tscArgs = ['-b', '--pretty', 'false'];

  if (forceRebuild) {
    tscArgs.push('--force');
  }

  const result = spawnSync(tscCommand, tscArgs, {
    cwd: repoRoot,
    shell: isWindows,
    stdio: 'inherit',
  });

  if (result.error) {
    // eslint-disable-next-line no-console
    console.error(result.error);
    return 1;
  }

  return result.status ?? 1;
}

const stalePackageReferencesBeforeTypecheck = getStalePackageReferences();

if (checkOnly) {
  if (stalePackageReferencesBeforeTypecheck.length > 0) {
    reportStaleArtifacts(stalePackageReferencesBeforeTypecheck, console.error);
    process.exit(1);
  }

  process.exit(0);
}

if (stalePackageReferencesBeforeTypecheck.length > 0) {
  // eslint-disable-next-line no-console
  console.warn('Detected stale TypeScript incremental artifacts before package typecheck; forcing rebuild.');
  reportStaleArtifacts(stalePackageReferencesBeforeTypecheck, console.warn);
}

const typecheckStatus = runTypecheck(stalePackageReferencesBeforeTypecheck.length > 0);
if (typecheckStatus !== 0) {
  process.exit(typecheckStatus);
}

const stalePackageReferencesAfterTypecheck = getStalePackageReferences();
if (stalePackageReferencesAfterTypecheck.length > 0) {
  // eslint-disable-next-line no-console
  console.error('Package typecheck finished, but stale artifacts still remain.');
  reportStaleArtifacts(stalePackageReferencesAfterTypecheck, console.error);
  process.exit(1);
}
