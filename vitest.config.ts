import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      // Keep tests independent from prebuilt package artifacts in clean checkouts.
      '@alphred/db': resolve(__dirname, 'packages/db/src/index.ts'),
      '@alphred/shared': resolve(__dirname, 'packages/shared/src/index.ts'),
      '@alphred/core': resolve(__dirname, 'packages/core/src/index.ts'),
      '@alphred/agents': resolve(__dirname, 'packages/agents/src/index.ts'),
      '@alphred/git': resolve(__dirname, 'packages/git/src/index.ts'),
    },
  },
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'react',
  },
  test: {
    include: [
      'packages/**/src/**/*.test.ts',
      'apps/**/src/**/*.test.ts',
      'apps/**/src/**/*.test.tsx',
      'apps/**/app/**/*.test.ts',
      'apps/**/app/**/*.test.tsx',
      'apps/**/scripts/**/*.test.ts',
    ],
    exclude: ['**/dist/**', '**/node_modules/**'],
    setupFiles: ['./test/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      reportsDirectory: './coverage',
      include: [
        'packages/*/src/**/*.ts',
        'apps/*/src/**/*.ts',
        'apps/*/src/**/*.tsx',
        'apps/*/app/**/*.ts',
        'apps/*/app/**/*.tsx',
        'apps/*/scripts/**/*.mjs',
      ],
      exclude: [
        '**/*.test.ts',
        '**/*.test.tsx',
        '**/dist/**',
        '**/node_modules/**',
        '**/*.d.ts',
        'apps/*/app/test/**',
      ],
    },
  },
});
