// @ts-check
import eslint from '@eslint/js';
import eslintComments from '@eslint-community/eslint-plugin-eslint-comments/configs';
import prettier from 'eslint-config-prettier/flat';
import globals from 'globals';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  {
    ignores: [
      'node_modules/',
      'out/',
      '.logs/',
      '.claude/logs/',
      '.claude/skills/',
      '.vscode-test/',
      'test-results/',
      'playwright-report/',
      'coverage/',
    ],
  },
  eslint.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  eslintComments.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
      reportUnusedInlineConfigs: 'error',
    },
    rules: {
      // Every eslint-disable needs a written reason after "--".
      '@eslint-community/eslint-comments/require-description': ['error', { ignore: [] }],
      '@eslint-community/eslint-comments/no-unlimited-disable': 'error',
      // A @ts-expect-error needs a written reason too; @ts-ignore and @ts-nocheck are banned.
      '@typescript-eslint/ban-ts-comment': [
        'error',
        {
          'ts-expect-error': 'allow-with-description',
          'ts-ignore': true,
          'ts-nocheck': true,
          'ts-check': false,
          minimumDescriptionLength: 10,
        },
      ],
      'no-console': 'error',
    },
  },
  {
    // The core is headless: it never imports the VS Code API (spec #12, Architecture).
    files: ['src/core/**'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'vscode',
              message:
                'src/core must not import the VS Code API. Depend on a port instead (CODING_STANDARDS.md).',
            },
          ],
          patterns: [
            {
              group: ['**/adapters/**', '**/vscode/**', '**/player/**'],
              message:
                'src/core must not reach into adapters or the player. Depend on a port or src/protocol instead.',
            },
          ],
        },
      ],
      // tsconfig includes the DOM types for the player; the core runs in the extension host.
      'no-restricted-globals': ['error', 'window', 'document', 'navigator', 'localStorage'],
    },
  },
  {
    // The player runs in the webview: no Node built-ins, no VS Code API, no core internals.
    files: ['src/player/**'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'vscode', message: 'The player runs in a webview; use the message protocol.' },
          ],
          patterns: [
            {
              group: ['node:*', '**/core/**', '**/adapters/**'],
              message:
                'The player runs in a webview: it talks to the extension only through src/protocol.',
            },
          ],
        },
      ],
    },
  },
  {
    // Seam 2 tests import test/player/fixtures.ts, which fails tests on browser console output.
    files: ['test/player/**'],
    ignores: ['test/player/fixtures.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@playwright/test',
              message:
                "Import { test, expect } from './fixtures' so browser console output is caught.",
              allowTypeImports: true,
            },
          ],
        },
      ],
    },
  },
  {
    // Node helper scripts and Claude Code hooks talk to the terminal, so console is their output.
    files: ['scripts/**', '.claude/hooks/**', '*.mjs'],
    languageOptions: { globals: globals.node },
    rules: { 'no-console': 'off' },
  },
  prettier,
);
