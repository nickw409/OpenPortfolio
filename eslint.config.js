import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

import noMoneyArithmetic from './eslint-rules/no-money-arithmetic.js';

export default [
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-empty': ['error', { allowEmptyCatch: false }],
    },
  },
  // Type-aware linting for TS files; carries the openportfolio/no-money-arithmetic rule.
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      openportfolio: {
        rules: { 'no-money-arithmetic': noMoneyArithmetic },
      },
    },
    rules: {
      'openportfolio/no-money-arithmetic': 'error',
    },
  },
  // money.ts is the implementation — raw arithmetic on the underlying number is intentional.
  {
    files: ['src/shared/money.ts'],
    rules: {
      'openportfolio/no-money-arithmetic': 'off',
    },
  },
  prettier,
  {
    ignores: [
      'dist/',
      'build/',
      'out/',
      'node_modules/',
      'coverage/',
      'migrations/',
      'eslint-rules/',
    ],
  },
];
