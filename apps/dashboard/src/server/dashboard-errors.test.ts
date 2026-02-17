import { describe, expect, it } from 'vitest';
import { DashboardIntegrationError, toDashboardIntegrationError } from './dashboard-errors';

describe('toDashboardIntegrationError', () => {
  it('returns dashboard errors as-is', () => {
    const original = new DashboardIntegrationError('invalid_request', 'invalid', { status: 400 });

    const mapped = toDashboardIntegrationError(original);

    expect(mapped).toBe(original);
  });

  it('maps workflow tree missing code to not_found', () => {
    const mapped = toDashboardIntegrationError({
      code: 'WORKFLOW_TREE_NOT_FOUND',
      message: 'No workflow tree found for tree_key="missing".',
    });

    expect(mapped.code).toBe('not_found');
    expect(mapped.status).toBe(404);
  });

  it('maps auth-required message to auth_required', () => {
    const mapped = toDashboardIntegrationError(new Error('GitHub authentication is required.'));

    expect(mapped.code).toBe('auth_required');
    expect(mapped.status).toBe(401);
  });

  it('maps malformed JSON parse errors to invalid_request', () => {
    const mapped = toDashboardIntegrationError(new SyntaxError('Unexpected token } in JSON at position 12'));

    expect(mapped.code).toBe('invalid_request');
    expect(mapped.status).toBe(400);
  });

  it('maps unknown errors to internal_error with fallback message', () => {
    const mapped = toDashboardIntegrationError(new Error('completely unexpected'), 'fallback');

    expect(mapped.code).toBe('internal_error');
    expect(mapped.status).toBe(500);
    expect(mapped.message).toBe('fallback');
  });
});
