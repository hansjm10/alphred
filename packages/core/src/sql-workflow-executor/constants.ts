import type { WorkflowRunStatus } from '@alphred/db';
import {
  providerApprovalPolicies,
  providerSandboxModes,
  providerWebSearchModes,
  type GuardCondition,
} from '@alphred/shared';

export const artifactContentTypes = new Set(['text', 'markdown', 'json', 'diff']);
export const runTerminalStatuses = new Set<WorkflowRunStatus>(['completed', 'failed', 'cancelled']);
export const runClaimableStatuses: readonly WorkflowRunStatus[] = ['pending', 'running'];
export const guardOperators: ReadonlySet<GuardCondition['operator']> = new Set(['==', '!=', '>', '<', '>=', '<=']);
export const executionPermissionKeys = new Set([
  'approvalPolicy',
  'sandboxMode',
  'networkAccessEnabled',
  'additionalDirectories',
  'webSearchMode',
]);
export const executionApprovalPolicies = new Set(providerApprovalPolicies);
export const executionSandboxModes = new Set(providerSandboxModes);
export const executionWebSearchModes = new Set(providerWebSearchModes);
export const CONTEXT_POLICY_VERSION = 1;
export const MAX_UPSTREAM_ARTIFACTS = 4;
export const MAX_CONTEXT_CHARS_TOTAL = 32_000;
export const MAX_CHARS_PER_ARTIFACT = 12_000;
export const MIN_REMAINING_CONTEXT_CHARS = 1_000;
export const RUN_NODE_DIAGNOSTICS_SCHEMA_VERSION = 1;
export const MAX_DIAGNOSTIC_EVENTS = 120;
export const MAX_DIAGNOSTIC_PAYLOAD_CHARS = 48_000;
export const MAX_DIAGNOSTIC_EVENT_CONTENT_CHARS = 600;
export const MAX_DIAGNOSTIC_METADATA_CHARS = 2_000;
export const MAX_DIAGNOSTIC_ERROR_STACK_CHARS = 1_600;
export const MAX_REDACTION_DEPTH = 6;
export const MAX_REDACTION_ARRAY_LENGTH = 24;
export const MAX_CONTROL_PRECONDITION_RETRIES = 5;

export const sensitiveMetadataKeyPattern =
  /(token|secret|password|authorization|auth|api[_-]?key|session|cookie|credential)/i;
export const sensitiveStringPattern =
  /(gh[pousr]_\w{8,}|github_pat_\w{12,}|sk-[A-Z0-9]{10,}|Bearer\s+[-._~+/A-Z0-9]+=*)/i;

