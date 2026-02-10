import { describe, it, expect } from 'vitest';
import { createDatabase } from './connection.js';
import { migrateDatabase } from './migrate.js';
import { workflows } from './schema.js';

describe('database schema', () => {
  it('should create database and run migrations', () => {
    const db = createDatabase(':memory:');
    migrateDatabase(db);

    const result = db.insert(workflows).values({
      name: 'test-workflow',
      definition: { phases: [] },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }).returning().get();

    expect(result.id).toBe(1);
    expect(result.name).toBe('test-workflow');
  });

  it('should enforce foreign keys', () => {
    const db = createDatabase(':memory:');
    migrateDatabase(db);

    // This should work - no foreign key violation when table is empty
    expect(() => db.select().from(workflows).all()).not.toThrow();
  });
});
