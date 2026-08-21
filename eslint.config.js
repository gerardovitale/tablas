// @ts-check
'use strict';

const tseslint = require('typescript-eslint');
const js = require('@eslint/js');

/**
 * Project rule: no `.innerHTML` writes anywhere. CLAUDE.md mandates
 * textContent/setAttribute-only DOM writes in the webview because CSV
 * content is untrusted — this makes that convention machine-checked
 * instead of just documented.
 * @type {import('eslint').Linter.RulesRecord}
 */
const noInnerHtml = {
  'no-restricted-properties': [
    'error',
    {
      object: 'document',
      property: 'write',
      message: 'document.write is disallowed.',
    },
  ],
  'no-restricted-syntax': [
    'error',
    {
      selector:
        "AssignmentExpression[left.property.name='innerHTML'], AssignmentExpression[left.property.name='outerHTML']",
      message:
        'Do not assign innerHTML/outerHTML — use textContent/setAttribute (see CLAUDE.md DOM-safety rule).',
    },
  ],
};

const nodeConfigFiles = {
  files: ['eslint.config.js', 'esbuild.js', '.mocharc*.js', 'scripts/**/*.js'],
  languageOptions: {
    sourceType: 'commonjs',
    globals: {
      require: 'readonly',
      module: 'readonly',
      process: 'readonly',
      console: 'readonly',
      __dirname: 'readonly',
    },
  },
};

module.exports = tseslint.config(
  {
    ignores: [
      'dist/**',
      'media/**',
      'out/**',
      'node_modules/**',
      '.vscode-test/**',
      'coverage/**',
    ],
  },
  js.configs.recommended,
  nodeConfigFiles,
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    extends: [...tseslint.configs.recommended],
    rules: {
      ...noInnerHtml,
    },
  },
  {
    files: ['src/webview/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: {
        window: 'readonly',
        document: 'readonly',
        acquireVsCodeApi: 'readonly',
      },
    },
    rules: {
      ...noInnerHtml,
    },
  }
);
