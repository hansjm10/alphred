import js from '@eslint/js';
import nextPlugin from '@next/eslint-plugin-next';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.next/**',
      '**/.next-*/**',
      '**/.e2e-build-lock/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...tseslint.configs.stylistic,
  {
    ...nextPlugin.configs['core-web-vitals'],
    files: ['apps/dashboard/**/*.{js,jsx,ts,tsx}'],
    settings: {
      next: {
        rootDir: 'apps/dashboard',
      },
    },
  },
  {
    files: ['apps/dashboard/app/**/*.{js,jsx,ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['../**/src/**', './src/**'],
              message: 'Use `@dashboard/*` (for example, `@dashboard/server/...`) instead of relative imports into `src/*`.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/consistent-type-definitions': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
);
