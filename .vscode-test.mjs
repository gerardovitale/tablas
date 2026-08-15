import { defineConfig } from '@vscode/test-cli';

export default defineConfig([
  {
    label: 'unit',
    files: 'out/test/unit/**/*.test.js',
    mocha: {
      ui: 'bdd',
      timeout: 10000,
    },
  },
  {
    label: 'integration',
    files: 'out/test/integration/**/*.test.js',
    workspaceFolder: './test/fixtures',
    extensionDevelopmentPath: '.',
    mocha: {
      ui: 'bdd',
      timeout: 30000,
    },
  },
]);
