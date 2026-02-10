import { defineConfig } from 'vitest/config';

export default defineConfig({
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
      ],
      exclude: ['**/*.test.ts', '**/*.test.tsx', '**/dist/**', '**/node_modules/**', '**/*.d.ts'],
    },
  },
});
