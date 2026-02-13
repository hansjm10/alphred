const CLAUDE_API_KEY_ENV_VAR = 'CLAUDE_API_KEY';
const ANTHROPIC_API_KEY_ENV_VAR = 'ANTHROPIC_API_KEY';
const CLAUDE_MODEL_ENV_VAR = 'CLAUDE_MODEL';
const CLAUDE_BASE_URL_ENV_VAR = 'CLAUDE_BASE_URL';
const ANTHROPIC_BASE_URL_ENV_VAR = 'ANTHROPIC_BASE_URL';
const CLAUDE_AUTH_MODE_ENV_VAR = 'CLAUDE_AUTH_MODE';

const DEFAULT_CLAUDE_MODEL = 'claude-3-7-sonnet-latest';

const SUPPORTED_AUTH_MODES = ['api_key'] as const;
export type SupportedAuthMode = (typeof SUPPORTED_AUTH_MODES)[number];

type RequestedAuthMode = SupportedAuthMode | 'cli_session';

export type ClaudeBootstrapErrorCode =
  | 'CLAUDE_BOOTSTRAP_INVALID_CONFIG'
  | 'CLAUDE_BOOTSTRAP_MISSING_AUTH'
  | 'CLAUDE_BOOTSTRAP_UNSUPPORTED_AUTH_MODE';

export class ClaudeBootstrapError extends Error {
  readonly code: ClaudeBootstrapErrorCode;
  readonly details?: Record<string, unknown>;
  readonly cause?: unknown;

  constructor(
    code: ClaudeBootstrapErrorCode,
    message: string,
    details?: Record<string, unknown>,
    cause?: unknown,
  ) {
    super(message);
    this.name = 'ClaudeBootstrapError';
    this.code = code;
    this.details = details;
    this.cause = cause;
  }
}

type ClaudeBootstrapDependencies = Readonly<{
  env: NodeJS.ProcessEnv;
}>;

export type ClaudeBootstrapOverrides = Partial<ClaudeBootstrapDependencies>;

export type ClaudeSdkBootstrap = Readonly<{
  authMode: SupportedAuthMode;
  model: string;
  baseUrl?: string;
  apiKey: string;
  apiKeySource: typeof CLAUDE_API_KEY_ENV_VAR | typeof ANTHROPIC_API_KEY_ENV_VAR;
}>;

let cachedBootstrap: ClaudeSdkBootstrap | undefined;

function readConfiguredEnvValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const rawValue = env[key];
  if (rawValue === undefined) {
    return undefined;
  }

  const normalizedValue = rawValue.trim();
  if (normalizedValue.length === 0) {
    throw new ClaudeBootstrapError(
      'CLAUDE_BOOTSTRAP_INVALID_CONFIG',
      `Claude provider requires ${key} to be a non-empty string when set.`,
      { envKey: key },
    );
  }

  return normalizedValue;
}

function resolveClaudeModel(env: NodeJS.ProcessEnv): string {
  return readConfiguredEnvValue(env, CLAUDE_MODEL_ENV_VAR) ?? DEFAULT_CLAUDE_MODEL;
}

function resolveConfiguredAuthMode(env: NodeJS.ProcessEnv): RequestedAuthMode | undefined {
  const authMode = readConfiguredEnvValue(env, CLAUDE_AUTH_MODE_ENV_VAR);
  if (authMode === undefined) {
    return undefined;
  }

  if (authMode === 'api_key' || authMode === 'cli_session') {
    return authMode;
  }

  throw new ClaudeBootstrapError(
    'CLAUDE_BOOTSTRAP_INVALID_CONFIG',
    `Claude provider requires ${CLAUDE_AUTH_MODE_ENV_VAR} to be one of: api_key, cli_session.`,
    {
      envKey: CLAUDE_AUTH_MODE_ENV_VAR,
      authMode,
      allowedValues: ['api_key', 'cli_session'],
    },
  );
}

function resolveBaseUrl(env: NodeJS.ProcessEnv): string | undefined {
  const claudeBaseUrl = readConfiguredEnvValue(env, CLAUDE_BASE_URL_ENV_VAR);
  const baseUrl =
    claudeBaseUrl ?? readConfiguredEnvValue(env, ANTHROPIC_BASE_URL_ENV_VAR);
  if (baseUrl === undefined) {
    return undefined;
  }

  const sourceEnvKey = claudeBaseUrl ? CLAUDE_BASE_URL_ENV_VAR : ANTHROPIC_BASE_URL_ENV_VAR;
  let parsedBaseUrl: URL;
  try {
    parsedBaseUrl = new URL(baseUrl);
  } catch (error) {
    throw new ClaudeBootstrapError(
      'CLAUDE_BOOTSTRAP_INVALID_CONFIG',
      `Claude provider requires ${sourceEnvKey} to be a valid URL when set.`,
      { envKey: sourceEnvKey, baseUrl },
      error,
    );
  }

  if (parsedBaseUrl.protocol !== 'http:' && parsedBaseUrl.protocol !== 'https:') {
    throw new ClaudeBootstrapError(
      'CLAUDE_BOOTSTRAP_INVALID_CONFIG',
      `Claude provider requires ${sourceEnvKey} to use http or https.`,
      { envKey: sourceEnvKey, baseUrl },
    );
  }

  return parsedBaseUrl.toString();
}

function resolveApiKey(env: NodeJS.ProcessEnv): {
  apiKey: string;
  apiKeySource: typeof CLAUDE_API_KEY_ENV_VAR | typeof ANTHROPIC_API_KEY_ENV_VAR;
} | undefined {
  const claudeApiKey = readConfiguredEnvValue(env, CLAUDE_API_KEY_ENV_VAR);
  if (claudeApiKey !== undefined) {
    return {
      apiKey: claudeApiKey,
      apiKeySource: CLAUDE_API_KEY_ENV_VAR,
    };
  }

  const anthropicApiKey = readConfiguredEnvValue(env, ANTHROPIC_API_KEY_ENV_VAR);
  if (anthropicApiKey !== undefined) {
    return {
      apiKey: anthropicApiKey,
      apiKeySource: ANTHROPIC_API_KEY_ENV_VAR,
    };
  }

  return undefined;
}

function resolveDependencies(overrides: ClaudeBootstrapOverrides): ClaudeBootstrapDependencies {
  return {
    env: overrides.env ?? process.env,
  };
}

export function resetClaudeSdkBootstrapCache(): void {
  cachedBootstrap = undefined;
}

export function initializeClaudeSdkBootstrap(overrides: ClaudeBootstrapOverrides = {}): ClaudeSdkBootstrap {
  if (Object.keys(overrides).length === 0 && cachedBootstrap) {
    return cachedBootstrap;
  }

  const dependencies = resolveDependencies(overrides);
  const requestedAuthMode = resolveConfiguredAuthMode(dependencies.env);
  if (requestedAuthMode === 'cli_session') {
    throw new ClaudeBootstrapError(
      'CLAUDE_BOOTSTRAP_UNSUPPORTED_AUTH_MODE',
      'Claude provider does not support CLI-session auth in this runtime; configure an API key instead.',
      {
        requestedAuthMode,
        supportedAuthModes: [...SUPPORTED_AUTH_MODES],
      },
    );
  }

  const authMode = requestedAuthMode ?? 'api_key';
  const apiKey = resolveApiKey(dependencies.env);
  if (!apiKey) {
    throw new ClaudeBootstrapError(
      'CLAUDE_BOOTSTRAP_MISSING_AUTH',
      'Claude provider requires an API key via CLAUDE_API_KEY or ANTHROPIC_API_KEY.',
      {
        requestedAuthMode: authMode,
        checkedEnvVars: [CLAUDE_API_KEY_ENV_VAR, ANTHROPIC_API_KEY_ENV_VAR],
      },
    );
  }

  const bootstrap = Object.freeze({
    authMode,
    model: resolveClaudeModel(dependencies.env),
    baseUrl: resolveBaseUrl(dependencies.env),
    apiKey: apiKey.apiKey,
    apiKeySource: apiKey.apiKeySource,
  });

  if (Object.keys(overrides).length === 0) {
    cachedBootstrap = bootstrap;
  }

  return bootstrap;
}
