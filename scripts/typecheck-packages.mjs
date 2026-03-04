import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const isWindows = process.platform === 'win32';
const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

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

      if (entry.isFile() && entry.name.endsWith('.d.ts')) {
        return true;
      }
    }
  }

  return false;
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

  return !hasTypesEntry || !hasDeclarations;
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
    process.exit(1);
  }

  process.exit(result.status ?? 1);
}

const stalePackageReferences = getPackageReferencePaths().filter((referencePath) =>
  packageHasStaleBuildArtifacts(referencePath),
);

if (stalePackageReferences.length > 0) {
  // eslint-disable-next-line no-console
  console.warn(
    [
      'Detected stale TypeScript incremental artifacts; forcing package rebuild for:',
      ...stalePackageReferences.map((path) => `- ${path}`),
    ].join('\n'),
  );
}

runTypecheck(stalePackageReferences.length > 0);
