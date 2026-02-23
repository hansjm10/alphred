import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Codex, type CodexOptions } from '@openai/codex-sdk';

const CODEX_API_KEY_ENV_VAR = 'CODEX_API_KEY';
const OPENAI_API_KEY_ENV_VAR = 'OPENAI_API_KEY';
const CODEX_MODEL_ENV_VAR = 'CODEX_MODEL';
const OPENAI_BASE_URL_ENV_VAR = 'OPENAI_BASE_URL';
const CODEX_HOME_ENV_VAR = 'CODEX_HOME';
const CODEX_SDK_PACKAGE_JSON_PATH_SEGMENTS = ['node_modules', '@openai', 'codex-sdk', 'package.json'] as const;

const DEFAULT_CODEX_MODEL = 'gpt-5-codex';

export type CodexBootstrapAuthMode = 'api_key' | 'cli_session';

export type CodexBootstrapErrorCode =
  | 'CODEX_BOOTSTRAP_INVALID_CONFIG'
  | 'CODEX_BOOTSTRAP_MISSING_AUTH'
  | 'CODEX_BOOTSTRAP_SESSION_CHECK_FAILED'
  | 'CODEX_BOOTSTRAP_UNSUPPORTED_PLATFORM'
  | 'CODEX_BOOTSTRAP_CLIENT_INIT_FAILED';

export class CodexBootstrapError extends Error {
  readonly code: CodexBootstrapErrorCode;
  readonly details?: Record<string, unknown>;
  readonly cause?: unknown;

  constructor(
    code: CodexBootstrapErrorCode,
    message: string,
    details?: Record<string, unknown>,
    cause?: unknown,
  ) {
    super(message);
    this.name = 'CodexBootstrapError';
    this.code = code;
    this.details = details;
    this.cause = cause;
  }
}

type CliSessionCheckResult = Readonly<{
  status: 'authenticated' | 'not_authenticated' | 'error';
  message?: string;
}>;

type CodexBootstrapDependencies = Readonly<{
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  arch: string;
  getHomedir: () => string;
  resolveSdkPackageJsonPath: () => string;
  fileExists: (path: string) => boolean;
  checkCliSession: (codexBinaryPath: string, env: NodeJS.ProcessEnv) => CliSessionCheckResult;
  createClient: (options: CodexOptions) => Codex;
}>;

export type CodexBootstrapOverrides = Partial<CodexBootstrapDependencies>;

export type CodexSdkBootstrap = Readonly<{
  client: Codex;
  authMode: CodexBootstrapAuthMode;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  codexHome: string;
  codexBinaryPath: string;
}>;

let cachedBootstrap: CodexSdkBootstrap | undefined;

function readConfiguredEnvValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const rawValue = env[key];
  if (rawValue === undefined) {
    return undefined;
  }

  const normalizedValue = rawValue.trim();
  if (normalizedValue.length === 0) {
    throw new CodexBootstrapError(
      'CODEX_BOOTSTRAP_INVALID_CONFIG',
      `Codex provider requires ${key} to be a non-empty string when set.`,
      { envKey: key },
    );
  }

  return normalizedValue;
}

function resolveCodexModel(env: NodeJS.ProcessEnv): string {
  return readConfiguredEnvValue(env, CODEX_MODEL_ENV_VAR) ?? DEFAULT_CODEX_MODEL;
}

function resolveBaseUrl(env: NodeJS.ProcessEnv): string | undefined {
  const baseUrl = readConfiguredEnvValue(env, OPENAI_BASE_URL_ENV_VAR);
  if (baseUrl === undefined) {
    return undefined;
  }

  let parsedBaseUrl: URL;
  try {
    parsedBaseUrl = new URL(baseUrl);
  } catch (error) {
    throw new CodexBootstrapError(
      'CODEX_BOOTSTRAP_INVALID_CONFIG',
      `Codex provider requires ${OPENAI_BASE_URL_ENV_VAR} to be a valid URL when set.`,
      { envKey: OPENAI_BASE_URL_ENV_VAR, baseUrl },
      error,
    );
  }

  if (parsedBaseUrl.protocol !== 'http:' && parsedBaseUrl.protocol !== 'https:') {
    throw new CodexBootstrapError(
      'CODEX_BOOTSTRAP_INVALID_CONFIG',
      `Codex provider requires ${OPENAI_BASE_URL_ENV_VAR} to use http or https.`,
      { envKey: OPENAI_BASE_URL_ENV_VAR, baseUrl },
    );
  }

  return parsedBaseUrl.toString();
}

function resolveTargetTriple(platform: NodeJS.Platform, arch: string): string {
  if (platform === 'linux' || platform === 'android') {
    if (arch === 'x64') {
      return 'x86_64-unknown-linux-musl';
    }
    if (arch === 'arm64') {
      return 'aarch64-unknown-linux-musl';
    }
  }

  if (platform === 'darwin') {
    if (arch === 'x64') {
      return 'x86_64-apple-darwin';
    }
    if (arch === 'arm64') {
      return 'aarch64-apple-darwin';
    }
  }

  if (platform === 'win32') {
    if (arch === 'x64') {
      return 'x86_64-pc-windows-msvc';
    }
    if (arch === 'arm64') {
      return 'aarch64-pc-windows-msvc';
    }
  }

  throw new CodexBootstrapError(
    'CODEX_BOOTSTRAP_UNSUPPORTED_PLATFORM',
    `Codex provider does not support platform "${platform}" with architecture "${arch}".`,
    { platform, arch },
  );
}

function resolveCodexBinaryPath(dependencies: CodexBootstrapDependencies): string {
  const packageJsonPath = dependencies.resolveSdkPackageJsonPath();
  const targetTriple = resolveTargetTriple(dependencies.platform, dependencies.arch);
  const binaryName = dependencies.platform === 'win32' ? 'codex.exe' : 'codex';
  const binaryPath = join(dirname(packageJsonPath), 'vendor', targetTriple, 'codex', binaryName);

  if (!dependencies.fileExists(binaryPath)) {
    throw new CodexBootstrapError(
      'CODEX_BOOTSTRAP_INVALID_CONFIG',
      `Codex provider could not find the bundled codex binary at "${binaryPath}".`,
      { binaryPath },
    );
  }

  return binaryPath;
}

function createSessionCheckEnv(env: NodeJS.ProcessEnv, codexHome: string): NodeJS.ProcessEnv {
  const commandEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      commandEnv[key] = value;
    }
  }

  commandEnv.CODEX_HOME = codexHome;
  return commandEnv;
}

function defaultCheckCliSession(codexBinaryPath: string, env: NodeJS.ProcessEnv): CliSessionCheckResult {
  const commandResult = spawnSync(codexBinaryPath, ['login', 'status'], {
    env,
    encoding: 'utf8',
  });

  if (commandResult.error) {
    return {
      status: 'error',
      message: commandResult.error.message,
    };
  }

  const stderr = (commandResult.stderr ?? '').trim();
  if (commandResult.status === 0) {
    return { status: 'authenticated' };
  }

  if (stderr.includes('Not logged in')) {
    return { status: 'not_authenticated' };
  }

  return {
    status: 'error',
    message: stderr.length > 0 ? stderr : 'Unknown failure while checking Codex CLI login status.',
  };
}

function findSdkPackageJsonPathFromRoot(rootDirectory: string): string | undefined {
  let currentDirectory = rootDirectory;
  while (true) {
    const candidatePackageJsonPath = join(currentDirectory, ...CODEX_SDK_PACKAGE_JSON_PATH_SEGMENTS);
    if (existsSync(candidatePackageJsonPath)) {
      return candidatePackageJsonPath;
    }

    const parentDirectory = dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      return undefined;
    }

    currentDirectory = parentDirectory;
  }
}

function resolveSdkPackageJsonPathFromEntrypoint(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const lookupRoots = new Set([moduleDirectory, process.cwd()]);
  for (const lookupRoot of lookupRoots) {
    const sdkPackageJsonPath = findSdkPackageJsonPathFromRoot(lookupRoot);
    if (sdkPackageJsonPath) {
      return sdkPackageJsonPath;
    }
  }

  throw new CodexBootstrapError(
    'CODEX_BOOTSTRAP_INVALID_CONFIG',
    'Codex provider could not resolve @openai/codex-sdk from the current runtime.',
    {
      checkedRoots: [...lookupRoots],
    },
  );
}

function resolveDependencies(overrides: CodexBootstrapOverrides): CodexBootstrapDependencies {
  return {
    env: overrides.env ?? process.env,
    platform: overrides.platform ?? process.platform,
    arch: overrides.arch ?? process.arch,
    getHomedir: overrides.getHomedir ?? homedir,
    resolveSdkPackageJsonPath: overrides.resolveSdkPackageJsonPath
      ?? resolveSdkPackageJsonPathFromEntrypoint,
    fileExists: overrides.fileExists ?? existsSync,
    checkCliSession: overrides.checkCliSession ?? defaultCheckCliSession,
    createClient: overrides.createClient ?? ((options) => new Codex(options)),
  };
}

function resolveCodexHome(env: NodeJS.ProcessEnv, getHomeDirectory: () => string): string {
  const configuredCodexHome = readConfiguredEnvValue(env, CODEX_HOME_ENV_VAR);
  if (configuredCodexHome !== undefined) {
    return configuredCodexHome;
  }

  return join(getHomeDirectory(), '.codex');
}

function resolveApiKey(env: NodeJS.ProcessEnv): string | undefined {
  const codexApiKey = readConfiguredEnvValue(env, CODEX_API_KEY_ENV_VAR);
  if (codexApiKey !== undefined) {
    return codexApiKey;
  }

  return readConfiguredEnvValue(env, OPENAI_API_KEY_ENV_VAR);
}

export function resetCodexSdkBootstrapCache(): void {
  cachedBootstrap = undefined;
}

export function initializeCodexSdkBootstrap(overrides: CodexBootstrapOverrides = {}): CodexSdkBootstrap {
  if (Object.keys(overrides).length === 0 && cachedBootstrap) {
    return cachedBootstrap;
  }

  const dependencies = resolveDependencies(overrides);
  const model = resolveCodexModel(dependencies.env);
  const baseUrl = resolveBaseUrl(dependencies.env);
  const codexHome = resolveCodexHome(dependencies.env, dependencies.getHomedir);
  const codexBinaryPath = resolveCodexBinaryPath(dependencies);
  const apiKey = resolveApiKey(dependencies.env);

  let authMode: CodexBootstrapAuthMode;
  if (apiKey) {
    authMode = 'api_key';
  } else {
    const sessionCheckEnv = createSessionCheckEnv(dependencies.env, codexHome);
    const sessionStatus = dependencies.checkCliSession(codexBinaryPath, sessionCheckEnv);
    if (sessionStatus.status === 'authenticated') {
      authMode = 'cli_session';
    } else if (sessionStatus.status === 'not_authenticated') {
      throw new CodexBootstrapError(
        'CODEX_BOOTSTRAP_MISSING_AUTH',
        'Codex provider requires either an API key or an existing Codex CLI login session.',
        {
          checkedEnvVars: [CODEX_API_KEY_ENV_VAR, OPENAI_API_KEY_ENV_VAR],
          codexHome,
        },
      );
    } else {
      throw new CodexBootstrapError(
        'CODEX_BOOTSTRAP_SESSION_CHECK_FAILED',
        'Codex provider could not verify Codex CLI login status.',
        {
          codexHome,
          message: sessionStatus.message,
        },
      );
    }
  }

  const clientOptions: CodexOptions = {
    codexPathOverride: codexBinaryPath,
    baseUrl,
    apiKey,
  };

  let client: Codex;
  try {
    client = dependencies.createClient(clientOptions);
  } catch (error) {
    throw new CodexBootstrapError(
      'CODEX_BOOTSTRAP_CLIENT_INIT_FAILED',
      'Codex provider failed to initialize the Codex SDK client.',
      {
        authMode,
        codexBinaryPath,
      },
      error,
    );
  }

  const bootstrap = Object.freeze({
    client,
    authMode,
    model,
    baseUrl,
    apiKey,
    codexHome,
    codexBinaryPath,
  });

  if (Object.keys(overrides).length === 0) {
    cachedBootstrap = bootstrap;
  }

  return bootstrap;
}
