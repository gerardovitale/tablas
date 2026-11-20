const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const extensionConfig = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  // Kept external because they are not JS text: sql.js's .wasm (located with require.resolve
  // in sqliteParser.ts) and DuckDB's per-platform native packages
  // (@duckdb/node-bindings-<platform-arch>/duckdb.node + libduckdb). Everything else is bundled,
  // including @duckdb/node-api and @duckdb/node-bindings' duckdb.js dispatcher with its
  // detect-libc dependency: the dispatcher's `require('@duckdb/node-bindings-<p>/duckdb.node')`
  // calls stay as plain requires resolved from node_modules at runtime. (Shipping the dispatcher
  // unbundled would also need detect-libc in the .vsix; without it an Alpine build silently falls
  // back to the glibc binding it does not contain.)
  external: ['vscode', 'sql.js', '@duckdb/node-bindings-*'],
  sourcemap: !production,
  minify: production,
};

/** @type {import('esbuild').BuildOptions} */
const webviewConfig = {
  entryPoints: ['src/webview/main.js'],
  bundle: true,
  outfile: 'media/webview.js',
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  sourcemap: !production,
  minify: production,
};

async function build() {
  if (watch) {
    const [extCtx, webCtx] = await Promise.all([
      esbuild.context(extensionConfig),
      esbuild.context(webviewConfig),
    ]);
    await Promise.all([extCtx.watch(), webCtx.watch()]);
    console.log('Watching for changes...');
  } else {
    await Promise.all([
      esbuild.build(extensionConfig),
      esbuild.build(webviewConfig),
    ]);
    console.log('Build complete.');
  }
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
