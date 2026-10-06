import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    ignores: [
      'apps/desktop/node_modules',
      'apps/desktop/out',
      'apps/desktop/dist',
      'apps/desktop/.vite',
      'apps/desktop/coverage',
      'apps/desktop/test-results',
      'apps/desktop/playwright-report',
      '.serena',
      '.claude',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: [
      'apps/desktop/src/main/**/*.ts',
      'apps/desktop/src/preload/**/*.ts',
      'apps/desktop/src/shared/**/*.ts',
      'apps/desktop/tests/**/*.ts',
      'apps/desktop/tests/**/*.mjs',
      'apps/desktop/scripts/**/*.mjs',
      'apps/desktop/*.ts',
    ],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ['apps/desktop/src/renderer/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    ...reactHooks.configs.flat.recommended,
  },
  {
    files: ['apps/desktop/src/preload/**/*.ts'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
);
