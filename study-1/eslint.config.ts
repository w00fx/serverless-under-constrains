// Lint configuration (design §15.1). Loaded by ESLint 10 through
// `--flag unstable_native_nodejs_ts_config`, so Node strips the types natively.
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  {
    ignores: [
      'node_modules/**',
      'cdk.out/**',
      'reports/**',
      '.stryker-tmp/**',
      'coverage/**',
      'evidence/**',
      '.deploy-staging/**',
      'test/golden/**/fixtures/**',
    ],
  },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      // A leading underscore marks a binding kept on purpose, such as a property removed by rest destructuring.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      // Clean-code rules: files under 500 lines, at most two nested blocks per function.
      'max-lines': ['error', { max: 500 }],
      'max-depth': ['error', 2],
    },
  },
  {
    files: ['test/**/*.ts'],
    rules: {
      // node:test's describe/it return promises the runner awaits itself.
      '@typescript-eslint/no-floating-promises': 'off',
      // Inline stubs are forbidden; external I/O is replaced by named fake classes (design §12.2).
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.object.name='mock'][callee.property.name=/^(fn|method)$/]",
          message: 'Inline stubs are forbidden: replace the port with a named fake class under test/support/.',
        },
        {
          selector: "CallExpression[callee.object.property.name='mock'][callee.property.name=/^(fn|method)$/]",
          message: 'Inline stubs are forbidden: replace the port with a named fake class under test/support/.',
        },
      ],
    },
  },
);
