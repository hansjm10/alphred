import { describe, expect, it } from 'vitest';
import * as db from './index.js';

describe('db index exports', () => {
  it('re-exports database setup and schema tables', () => {
    expect(typeof db.createDatabase).toBe('function');
    expect(typeof db.migrateDatabase).toBe('function');
    expect(db.workflows).toBeDefined();
    expect(db.runs).toBeDefined();
    expect(db.phases).toBeDefined();
  });
});
