#!/usr/bin/env node
/**
 * Checks what a `vsce package` for THIS machine would ship, and that it works:
 *
 *   1. `vsce ls` lists few files, no source maps, nothing from node_modules but sql.js and
 *      exactly one DuckDB native package, and that package is the one this OS/arch/libc needs.
 *   2. The listed files are copied to a scratch folder outside the repo (so Node cannot
 *      fall back to the repo's node_modules), the SQLite and DuckDB parsers are bundled with the
 *      extension's own esbuild options, and run from there against a fixture of each.
 *
 * That exercises what the .vsix is made of at run time: the bundled @duckdb/node-api, the
 * bundled dispatcher and its detect-libc (musl vs glibc), the native package resolved from the
 * shipped node_modules, and sql.js's .wasm. It does not start VS Code.
 *
 * Needs `vsce` on PATH (`npm install -g @vscode/vsce`). Run on the platform you are testing:
 *     node scripts/smoke-package.js
 */
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const esbuild = require('esbuild');
const { extensionConfig } = require('../esbuild.js');

const ROOT = path.join(__dirname, '..');
const MAX_FILES = 25;

/** The `@duckdb/node-bindings-*` package this process needs (mirrors the package's own dispatcher). */
function runtimeBindingPackage() {
  const { platform, arch } = process;
  if (platform === 'linux') {
    const glibc = process.report && process.report.getReport().header.glibcVersionRuntime;
    return `node-bindings-linux-${arch}${glibc ? '' : '-musl'}`;
  }
  return `node-bindings-${platform}-${arch}`;
}

function fail(message) {
  console.error(`smoke-package: FAIL: ${message}`);
  process.exit(1);
}

function listPackagedFiles() {
  const out = execFileSync('vsce', ['ls'], {
    cwd: ROOT,
    encoding: 'utf8',
    shell: process.platform === 'win32', // vsce is vsce.cmd there
  });
  return out
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/\\/g, '/'))
    .filter((line) => line !== '' && fs.existsSync(path.join(ROOT, line)));
}

function checkLayout(files) {
  console.log(`vsce ls: ${files.length} files`);
  if (!files.includes('dist/extension.js')) {
    fail('dist/extension.js is not packaged (run `npm run compile:production` first)');
  }
  if (files.length > MAX_FILES) {
    fail(`${files.length} files, expected at most ${MAX_FILES}:\n  ${files.join('\n  ')}`);
  }
  const maps = files.filter((f) => f.endsWith('.map'));
  if (maps.length > 0) {
    fail(`source maps are packaged: ${maps.join(', ')}`);
  }
  const stray = files.filter(
    (f) => f.startsWith('node_modules/') && !f.startsWith('node_modules/sql.js/') && !f.startsWith('node_modules/@duckdb/node-bindings-')
  );
  if (stray.length > 0) {
    fail(`unbundled dependencies are packaged: ${stray.join(', ')}`);
  }
  const bindings = [...new Set(files.map((f) => /^node_modules\/@duckdb\/(node-bindings-[^/]+)\//.exec(f)?.[1]).filter(Boolean))];
  if (bindings.length !== 1) {
    fail(`expected exactly one DuckDB native package, found ${bindings.length}: ${bindings.join(', ') || '(none)'}`);
  }
  if (bindings[0] !== runtimeBindingPackage()) {
    fail(`packaged ${bindings[0]} but this machine needs ${runtimeBindingPackage()}`);
  }
  console.log(`native package: @duckdb/${bindings[0]}`);
}

const ENTRY = `
import * as fs from 'fs';
import { parseDuckdb } from './src/duckdbParser';
import { parseSqlite } from './src/sqliteParser';
(async () => {
  const read = (file: string) => new Uint8Array(fs.readFileSync(file));
  const [duckdbFile, sqliteFile] = process.argv.slice(2);
  const result: Record<string, unknown> = {};
  for (const [name, outcome] of [
    ['duckdb', await parseDuckdb(read(duckdbFile), 100)],
    ['sqlite', await parseSqlite(read(sqliteFile), 100)],
  ] as const) {
    if (!outcome.success) {
      console.error(name + ' failed: ' + JSON.stringify(outcome.errors));
      process.exit(1);
    }
    result[name] = { tables: outcome.data.tables.map((t) => t.name), rows: outcome.data.data.rowCount };
  }
  console.log(JSON.stringify(result));
  process.exit(0);
})();
`;

async function runFromScratchFolder(files) {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'tablas-smoke-'));
  try {
    for (const file of files) {
      fs.mkdirSync(path.dirname(path.join(stage, file)), { recursive: true });
      fs.copyFileSync(path.join(ROOT, file), path.join(stage, file));
    }
    const { entryPoints, ...options } = extensionConfig; // eslint-disable-line no-unused-vars
    await esbuild.build({
      ...options,
      stdin: { contents: ENTRY, resolveDir: ROOT, sourcefile: 'smoke-entry.ts', loader: 'ts' },
      outfile: path.join(stage, 'dist', 'smoke.js'),
      minify: true,
      sourcemap: false,
      logLevel: 'warning',
    });
    const output = execFileSync(
      process.execPath,
      [
        path.join(stage, 'dist', 'smoke.js'),
        path.join(ROOT, 'test', 'fixtures', 'simple.duckdb'),
        path.join(ROOT, 'test', 'fixtures', 'simple.db'),
      ],
      { cwd: stage, encoding: 'utf8' }
    );
    const result = JSON.parse(output.trim().split('\n').pop());
    for (const format of ['duckdb', 'sqlite']) {
      if (!result[format] || result[format].tables.length === 0 || result[format].rows === 0) {
        fail(`${format} opened but showed no data: ${output}`);
      }
    }
    console.log(`opened from the packaged layout: ${output.trim()}`);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

(async () => {
  const files = listPackagedFiles();
  checkLayout(files);
  await runFromScratchFolder(files);
  console.log('smoke-package: OK');
})().catch((err) => fail(err && err.stack ? err.stack : String(err)));
