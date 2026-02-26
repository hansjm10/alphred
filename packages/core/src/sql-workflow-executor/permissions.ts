import {
  providerApprovalPolicies,
  providerSandboxModes,
  providerWebSearchModes,
  type ProviderExecutionPermissions,
} from '@alphred/shared';
import {
  executionApprovalPolicies,
  executionPermissionKeys,
  executionSandboxModes,
  executionWebSearchModes,
} from './constants.js';
import { isRecord } from './type-conversions.js';

export function assertSupportedRunNodeExecutionPermissionKeys(value: Record<string, unknown>, nodeKey: string): void {
  for (const key of Object.keys(value)) {
    if (executionPermissionKeys.has(key)) {
      continue;
    }

    throw new Error(`Run node "${nodeKey}" execution permissions include unsupported field "${key}".`);
  }
}

export function parseRunNodeExecutionApprovalPolicy(
  value: Record<string, unknown>,
  nodeKey: string,
): (typeof providerApprovalPolicies)[number] | undefined {
  const approvalPolicy = value.approvalPolicy;
  if (approvalPolicy === undefined) {
    return undefined;
  }

  if (
    typeof approvalPolicy !== 'string'
    || !executionApprovalPolicies.has(approvalPolicy as (typeof providerApprovalPolicies)[number])
  ) {
    throw new Error(`Run node "${nodeKey}" has invalid execution approval policy.`);
  }

  return approvalPolicy as (typeof providerApprovalPolicies)[number];
}

export function parseRunNodeExecutionSandboxMode(
  value: Record<string, unknown>,
  nodeKey: string,
): (typeof providerSandboxModes)[number] | undefined {
  const sandboxMode = value.sandboxMode;
  if (sandboxMode === undefined) {
    return undefined;
  }

  if (
    typeof sandboxMode !== 'string'
    || !executionSandboxModes.has(sandboxMode as (typeof providerSandboxModes)[number])
  ) {
    throw new Error(`Run node "${nodeKey}" has invalid execution sandbox mode.`);
  }

  return sandboxMode as (typeof providerSandboxModes)[number];
}

export function parseRunNodeExecutionNetworkAccessEnabled(
  value: Record<string, unknown>,
  nodeKey: string,
): boolean | undefined {
  const networkAccessEnabled = value.networkAccessEnabled;
  if (networkAccessEnabled === undefined) {
    return undefined;
  }

  if (typeof networkAccessEnabled !== 'boolean') {
    throw new TypeError(`Run node "${nodeKey}" has invalid execution networkAccessEnabled value.`);
  }

  return networkAccessEnabled;
}

export function parseRunNodeExecutionAdditionalDirectories(
  value: Record<string, unknown>,
  nodeKey: string,
): string[] | undefined {
  const additionalDirectories = value.additionalDirectories;
  if (additionalDirectories === undefined) {
    return undefined;
  }

  if (!Array.isArray(additionalDirectories)) {
    throw new TypeError(`Run node "${nodeKey}" has invalid execution additionalDirectories value.`);
  }

  const normalizedDirectories = additionalDirectories.map((directory, index) => {
    if (typeof directory !== 'string' || directory.trim().length === 0) {
      throw new TypeError(
        `Run node "${nodeKey}" has invalid execution additionalDirectories entry at index ${index}.`,
      );
    }

    return directory.trim();
  });

  if (normalizedDirectories.length === 0) {
    throw new Error(`Run node "${nodeKey}" must provide at least one execution additional directory.`);
  }

  return normalizedDirectories;
}

export function parseRunNodeExecutionWebSearchMode(
  value: Record<string, unknown>,
  nodeKey: string,
): (typeof providerWebSearchModes)[number] | undefined {
  const webSearchMode = value.webSearchMode;
  if (webSearchMode === undefined) {
    return undefined;
  }

  if (
    typeof webSearchMode !== 'string'
    || !executionWebSearchModes.has(webSearchMode as (typeof providerWebSearchModes)[number])
  ) {
    throw new Error(`Run node "${nodeKey}" has invalid execution web search mode.`);
  }

  return webSearchMode as (typeof providerWebSearchModes)[number];
}

export function normalizeRunNodeExecutionPermissions(
  value: unknown,
  nodeKey: string,
): ProviderExecutionPermissions | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    throw new TypeError(`Run node "${nodeKey}" has invalid execution permissions payload.`);
  }

  assertSupportedRunNodeExecutionPermissionKeys(value, nodeKey);

  const normalized: ProviderExecutionPermissions = {};
  const approvalPolicy = parseRunNodeExecutionApprovalPolicy(value, nodeKey);
  if (approvalPolicy !== undefined) {
    normalized.approvalPolicy = approvalPolicy;
  }

  const sandboxMode = parseRunNodeExecutionSandboxMode(value, nodeKey);
  if (sandboxMode !== undefined) {
    normalized.sandboxMode = sandboxMode;
  }

  const networkAccessEnabled = parseRunNodeExecutionNetworkAccessEnabled(value, nodeKey);
  if (networkAccessEnabled !== undefined) {
    normalized.networkAccessEnabled = networkAccessEnabled;
  }

  const additionalDirectories = parseRunNodeExecutionAdditionalDirectories(value, nodeKey);
  if (additionalDirectories !== undefined) {
    normalized.additionalDirectories = additionalDirectories;
  }

  const webSearchMode = parseRunNodeExecutionWebSearchMode(value, nodeKey);
  if (webSearchMode !== undefined) {
    normalized.webSearchMode = webSearchMode;
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function mergeExecutionPermissions(
  basePermissions: ProviderExecutionPermissions | undefined,
  nodePermissions: ProviderExecutionPermissions | undefined,
): ProviderExecutionPermissions | undefined {
  if (!basePermissions && !nodePermissions) {
    return undefined;
  }

  if (!basePermissions) {
    return nodePermissions;
  }

  if (!nodePermissions) {
    return basePermissions;
  }

  return {
    ...basePermissions,
    ...nodePermissions,
  };
}
