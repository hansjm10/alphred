import { describe, expect, it } from 'vitest';
import { DashboardIntegrationError } from '../../../../../src/server/dashboard-errors';
import { optionalStringField, parsePositiveIntegerQueryParam, requireRecord, requireStringField } from './validation';

describe('workflows validation helpers', () => {
  it('requires record payloads', () => {
    expect(() => requireRecord(null, 'payload must be object')).toThrowError(DashboardIntegrationError);
    expect(() => requireRecord([], 'payload must be object')).toThrowError(DashboardIntegrationError);
    expect(requireRecord({ ok: true }, 'payload must be object')).toEqual({ ok: true });
  });

  it('requires string fields and preserves field details', () => {
    expect(() => requireStringField({ name: 123 }, 'name', 'name must be string')).toThrowError(DashboardIntegrationError);
    expect(requireStringField({ name: 'demo' }, 'name', 'name must be string')).toBe('demo');
  });

  it('parses optional string fields', () => {
    expect(optionalStringField({}, 'description', 'description must be string')).toBeUndefined();
    expect(optionalStringField({ description: 'ok' }, 'description', 'description must be string')).toBe('ok');
    expect(() => optionalStringField({ description: 123 }, 'description', 'description must be string')).toThrowError(
      DashboardIntegrationError,
    );
  });

  it('parses positive integer query params', () => {
    expect(parsePositiveIntegerQueryParam(new Request('http://localhost/?version=2'), 'version', 'bad')).toBe(2);
    expect(() => parsePositiveIntegerQueryParam(new Request('http://localhost/?version=0'), 'version', 'bad')).toThrowError(
      DashboardIntegrationError,
    );
    expect(() => parsePositiveIntegerQueryParam(new Request('http://localhost/?version=nope'), 'version', 'bad')).toThrowError(
      DashboardIntegrationError,
    );
  });
});

