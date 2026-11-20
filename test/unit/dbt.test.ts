import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  clearDbtProjectCache,
  columnDescriptionsFor,
  findNodeForFile,
  findProjectRoot,
  findTableRef,
  indexManifest,
  loadDbtManifest,
  MANIFEST_MAX_BYTES,
  manifestPath,
  parseProjectYaml,
  readProject,
  relationKey,
} from '../../src/dbt';
import type { TableRef } from '../../src/tableData';

// process.cwd() is the project root under ts-node and under the compiled output alike.
const projectDir = path.join(process.cwd(), 'test', 'fixtures', 'dbt');
const manifestFile = path.join(projectDir, 'target', 'manifest.json');

async function fixtureIndex() {
  const loaded = await loadDbtManifest(manifestFile);
  assert.ok('index' in loaded, JSON.stringify(loaded));
  return 'index' in loaded ? loaded.index : (undefined as never);
}

describe('dbt', () => {
  describe('parseProjectYaml', () => {
    it('reads name and target-path, with quotes, comments and defaults', () => {
      assert.deepStrictEqual(parseProjectYaml("name: shop\nversion: '1'\n"), { name: 'shop', targetPath: 'target' });
      assert.deepStrictEqual(parseProjectYaml('name: "my_shop"   # the project\ntarget-path: "build"\n'), {
        name: 'my_shop',
        targetPath: 'build',
      });
      assert.deepStrictEqual(parseProjectYaml("name: 'x'\ntarget-path: 'out/dbt'"), { name: 'x', targetPath: 'out/dbt' });
    });

    it('ignores nested keys, templated values and an empty file', () => {
      assert.deepStrictEqual(parseProjectYaml('models:\n  name: nested\n'), { name: undefined, targetPath: 'target' });
      assert.strictEqual(parseProjectYaml('target-path: "{{ env_var(\'T\') }}"').targetPath, 'target');
      assert.deepStrictEqual(parseProjectYaml(''), { name: undefined, targetPath: 'target' });
    });
  });

  describe('manifestPath', () => {
    it('puts a relative target-path under the project and lets an absolute one stand', () => {
      assert.strictEqual(manifestPath({ root: '/p', targetPath: 'target' }), path.resolve('/p', 'target', 'manifest.json'));
      assert.strictEqual(manifestPath({ root: '/p', targetPath: '/var/tmp/out' }), path.resolve('/var/tmp/out', 'manifest.json'));
    });
  });

  describe('findProjectRoot / readProject', () => {
    it('walks up from a nested folder to the folder holding dbt_project.yml', () => {
      assert.strictEqual(findProjectRoot(path.join(projectDir, 'models', 'marts')), projectDir);
      assert.strictEqual(findProjectRoot(projectDir), projectDir);
    });

    it('finds nothing outside a project', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tablas-nodbt-'));
      try {
        assert.strictEqual(findProjectRoot(dir), undefined);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('reads the project name, falling back to defaults when the file is unreadable', async () => {
      assert.deepStrictEqual(await readProject(projectDir), { root: projectDir, name: 'shop', targetPath: 'target' });
      assert.deepStrictEqual(await readProject(path.join(projectDir, 'nope')), {
        root: path.join(projectDir, 'nope'),
        name: undefined,
        targetPath: 'target',
      });
    });
  });

  describe('indexManifest', () => {
    it('maps a model file to its schema, relation (alias first) and database', async () => {
      const index = await fixtureIndex();
      const orders = findNodeForFile(index, 'models/marts/orders.sql', 'shop');
      assert.deepStrictEqual(
        [orders?.resourceType, orders?.schema, orders?.relation, orders?.database, orders?.materialized],
        ['model', 'main_marts', 'orders', 'schemas', 'table']
      );
      const staged = findNodeForFile(index, 'models/staging/stg_orders.sql', 'shop');
      assert.deepStrictEqual([staged?.name, staged?.relation, staged?.schema], ['stg_orders', 'orders', 'main_staging']);
    });

    it('falls back to the node name when there is no alias', async () => {
      const notBuilt = findNodeForFile(await fixtureIndex(), 'models/marts/not_built.sql', 'shop');
      assert.strictEqual(notBuilt?.relation, 'not_built');
    });

    it("prefers the project's own package when two packages share a file path", async () => {
      const index = await fixtureIndex();
      assert.strictEqual(findNodeForFile(index, 'models/marts/orders.sql', 'shop')?.schema, 'main_marts');
      assert.strictEqual(findNodeForFile(index, 'models/marts/orders.sql', 'other_pkg')?.schema, 'other');
      // No project name: the first one listed.
      assert.ok(findNodeForFile(index, 'models/marts/orders.sql'));
    });

    it("does not hand a file the project has not built yet to an installed package that has the same path", async () => {
      const index = await fixtureIndex();
      // `other_pkg` has models/marts/orders.sql; a project called `ghost` has no node there.
      assert.strictEqual(findNodeForFile(index, 'models/marts/orders.sql', 'ghost'), undefined);
      assert.strictEqual(findNodeForFile(index, 'models/marts/orders.sql', 'shop')?.packageName, 'shop');
    });

    it('knows what a file is when it is not a table: ephemeral model, test; and nothing for a macro', async () => {
      const index = await fixtureIndex();
      assert.strictEqual(findNodeForFile(index, 'models/staging/inline.sql', 'shop')?.materialized, 'ephemeral');
      assert.strictEqual(findNodeForFile(index, 'tests/singular.sql', 'shop')?.resourceType, 'test');
      assert.strictEqual(findNodeForFile(index, 'macros/helpers.sql', 'shop'), undefined);
    });

    it('indexes models and sources by relation, case-insensitively, but not tests', async () => {
      const index = await fixtureIndex();
      assert.strictEqual(index.byRelation.get(relationKey('MAIN_MARTS', 'Orders'))?.[0].name, 'orders');
      assert.strictEqual(index.byRelation.get(relationKey('main', 'raw_events'))?.[0].resourceType, 'source');
      assert.strictEqual(index.byRelation.has(relationKey('main_dbt_test__audit', 'singular')), false);
    });

    it('keeps only non-empty column descriptions', async () => {
      const index = await fixtureIndex();
      assert.deepStrictEqual(findNodeForFile(index, 'models/marts/orders.sql', 'shop')?.columns, {
        id: 'Primary key of the order.',
        total: 'Order total in euros, tax included.',
      });
    });

    it('cuts an overlong description', () => {
      const index = indexManifest({
        nodes: {
          a: {
            resource_type: 'model', name: 'a', schema: 's', original_file_path: 'models/a.sql',
            columns: { c: { description: 'x'.repeat(5000) } },
          },
        },
      });
      const description = index.byRelation.get(relationKey('s', 'a'))?.[0].columns.c ?? '';
      assert.strictEqual(description.length, 2001);
      assert.ok(description.endsWith('…'));
    });

    it('normalizes Windows separators in file paths', () => {
      const index = indexManifest({
        nodes: { a: { resource_type: 'model', name: 'a', schema: 's', original_file_path: 'models\\marts\\a.sql' } },
      });
      assert.ok(index.byFile.has('models/marts/a.sql'));
    });

    it('survives shapes it does not know', () => {
      for (const junk of [undefined, null, 7, 'x', [], {}, { nodes: [] }, { nodes: { a: 1, b: null, c: { resource_type: 'model' } } }]) {
        const index = indexManifest(junk);
        assert.strictEqual(index.byFile.size, 0, JSON.stringify(junk));
        assert.strictEqual(index.byRelation.size, 0);
      }
    });
  });

  describe('loadDbtManifest', () => {
    let dir: string;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tablas-manifest-'));
    });
    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('reports a missing file', async () => {
      const result = await loadDbtManifest(path.join(dir, 'manifest.json'));
      assert.ok('error' in result && result.error === 'missing');
    });

    it('reports a file that is not JSON, without throwing', async () => {
      const file = path.join(dir, 'manifest.json');
      fs.writeFileSync(file, '{ not json');
      const result = await loadDbtManifest(file);
      assert.ok('error' in result && result.error === 'invalid');
    });

    it('refuses a manifest over the size limit without reading it', async () => {
      const file = path.join(dir, 'manifest.json');
      fs.writeFileSync(file, '{}');
      fs.truncateSync(file, MANIFEST_MAX_BYTES + 1);
      const result = await loadDbtManifest(file);
      assert.ok('error' in result && result.error === 'too-large');
    });

    it('shares one read between callers that ask while it is running', async () => {
      const file = path.join(dir, 'manifest.json');
      fs.writeFileSync(file, JSON.stringify({ nodes: { n: { resource_type: 'model', name: 'a', schema: 's', original_file_path: 'models/a.sql' } } }));
      const reads: string[] = [];
      const original = fs.promises.readFile;
      (fs.promises as { readFile: unknown }).readFile = (...args: unknown[]) => {
        reads.push(String(args[0]));
        return (original as (...a: unknown[]) => Promise<unknown>)(...args);
      };
      try {
        const results = await Promise.all([loadDbtManifest(file), loadDbtManifest(file), loadDbtManifest(file)]);
        assert.ok(results.every((r) => 'index' in r));
        assert.strictEqual(reads.filter((r) => r === file).length, 1, 'parsed once for three callers');
        const first = results[0];
        assert.ok(results.every((r) => 'index' in r && 'index' in first && r.index === first.index), 'all get the same index');
      } finally {
        (fs.promises as { readFile: unknown }).readFile = original;
      }
    });

    it('does not let an in-flight read of an older version answer for a newer file', async () => {
      const file = path.join(dir, 'manifest.json');
      const write = (name: string) =>
        fs.writeFileSync(file, JSON.stringify({ nodes: { n: { resource_type: 'model', name, schema: 's', original_file_path: `models/${name}.sql` } } }));
      write('old');
      const older = loadDbtManifest(file);
      write('a_newer_and_longer_name'); // different size: a different version
      const newer = await loadDbtManifest(file);
      await older;
      assert.ok('index' in newer && newer.index.byFile.has('models/a_newer_and_longer_name.sql'));
    });

    it('reuses the parsed index until the file changes', async () => {
      const file = path.join(dir, 'manifest.json');
      const write = (name: string) =>
        fs.writeFileSync(file, JSON.stringify({ nodes: { n: { resource_type: 'model', name, schema: 's', original_file_path: `models/${name}.sql` } } }));
      write('one');
      const first = await loadDbtManifest(file);
      const again = await loadDbtManifest(file);
      assert.ok('index' in first && 'index' in again);
      assert.strictEqual('index' in again && again.index, 'index' in first && first.index, 'same object while unchanged');

      write('second_version'); // different size, so the change is seen even within one mtime tick
      const changed = await loadDbtManifest(file);
      assert.ok('index' in changed && changed.index.byFile.has('models/second_version.sql'));
    });
  });

  describe('findTableRef', () => {
    const tables: TableRef[] = [
      { name: 'raw_events', type: 'table' },
      { name: 'main_marts.orders', type: 'table', schema: 'main_marts', table: 'orders' },
      { name: 'main_staging.Orders', type: 'view', schema: 'main_staging', table: 'Orders' },
    ];

    it('finds a main table by its bare name and others by schema and table', () => {
      assert.strictEqual(findTableRef(tables, { schema: 'main', table: 'raw_events' })?.name, 'raw_events');
      assert.strictEqual(findTableRef(tables, { schema: 'main_marts', table: 'orders' })?.name, 'main_marts.orders');
    });

    it('ignores case, as DuckDB does', () => {
      assert.strictEqual(findTableRef(tables, { schema: 'MAIN_STAGING', table: 'orders' })?.name, 'main_staging.Orders');
    });

    it('does not mix up the same table name in two schemas, nor invent a match', () => {
      assert.strictEqual(findTableRef(tables, { schema: 'main', table: 'orders' }), undefined);
      assert.strictEqual(findTableRef(tables, { schema: 'nope', table: 'orders' }), undefined);
      assert.strictEqual(findTableRef([], { schema: 'main', table: 'x' }), undefined);
    });
  });

  describe('columnDescriptionsFor', () => {
    const marts: TableRef = { name: 'main_marts.orders', type: 'table', schema: 'main_marts', table: 'orders' };

    it('uses the dbt project above the database file', async () => {
      assert.deepStrictEqual(await columnDescriptionsFor(path.join(projectDir, 'schemas.duckdb'), marts, []), {
        id: 'Primary key of the order.',
        total: 'Order total in euros, tax included.',
      });
    });

    it("falls back to the workspace's only project for a file outside it", async () => {
      const outside = path.join(os.tmpdir(), 'schemas.duckdb');
      assert.ok(await columnDescriptionsFor(outside, marts, [projectDir]));
      assert.strictEqual(await columnDescriptionsFor(outside, marts, []), undefined, 'no project to ask');
      assert.strictEqual(await columnDescriptionsFor(outside, marts, [projectDir, projectDir + '2']), undefined, 'ambiguous');
    });

    it('finds the description of a source and of a bare main table', async () => {
      const events: TableRef = { name: 'raw_events', type: 'table' };
      assert.deepStrictEqual(await columnDescriptionsFor(path.join(projectDir, 'schemas.duckdb'), events, []), { kind: 'click or view' });
    });

    it('says nothing when the file is not the database dbt built the model in', async () => {
      // dbt-duckdb names the catalog after the file: this manifest was built into "schemas".
      assert.strictEqual(await columnDescriptionsFor(path.join(projectDir, 'scratch.duckdb'), marts, []), undefined);
      assert.strictEqual(await columnDescriptionsFor(path.join(os.tmpdir(), 'scratch.duckdb'), marts, [projectDir]), undefined);
      // Case does not matter, as for DuckDB itself.
      assert.ok(await columnDescriptionsFor(path.join(projectDir, 'SCHEMAS.duckdb'), marts, []));
      assert.ok(await columnDescriptionsFor(path.join(projectDir, 'schemas.ddb'), marts, []));
    });

    describe('in a project of its own', () => {
      let dir: string;
      beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tablas-dbtdocs-'));
      });
      afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
      });
      const node = (pkg: string, database: string, description: string) => ({
        resource_type: 'model', name: 'orders', package_name: pkg, original_file_path: `models/${pkg}.sql`,
        database, schema: 'main', columns: { id: { description } },
      });

      it("prefers the project's own package, and ignores a node built into another database", async () => {
        fs.writeFileSync(path.join(dir, 'dbt_project.yml'), 'name: shop\n');
        fs.mkdirSync(path.join(dir, 'target'));
        fs.writeFileSync(
          path.join(dir, 'target', 'manifest.json'),
          JSON.stringify({
            nodes: {
              a: node('installed_pkg', 'dev', 'from the package'),
              b: node('shop', 'dev', 'from the project'),
              c: node('shop', 'prod', 'built elsewhere'),
            },
          })
        );
        const orders: TableRef = { name: 'orders', type: 'table' };
        assert.deepStrictEqual(await columnDescriptionsFor(path.join(dir, 'dev.duckdb'), orders, []), { id: 'from the project' });
        assert.deepStrictEqual(await columnDescriptionsFor(path.join(dir, 'prod.duckdb'), orders, []), { id: 'built elsewhere' });
        assert.strictEqual(await columnDescriptionsFor(path.join(dir, 'test.duckdb'), orders, []), undefined);
      });

      describe('remembering the project lookups', () => {
        const orders: TableRef = { name: 'orders', type: 'table' };
        const writeProject = (yml: string, target: string, description: string) => {
          fs.writeFileSync(path.join(dir, 'dbt_project.yml'), yml);
          fs.mkdirSync(path.join(dir, target), { recursive: true });
          fs.writeFileSync(
            path.join(dir, target, 'manifest.json'),
            JSON.stringify({ nodes: { a: node('shop', 'dev', description) } })
          );
        };
        beforeEach(() => clearDbtProjectCache());
        afterEach(() => clearDbtProjectCache());

        it('does not walk the folder tree again for a folder it has already resolved', async () => {
          writeProject('name: shop\n', 'target', 'first');
          const db = path.join(dir, 'dev.duckdb');
          assert.deepStrictEqual(await columnDescriptionsFor(db, orders, []), { id: 'first' });
          fs.rmSync(path.join(dir, 'dbt_project.yml'));
          // The root is remembered; the default target folder still holds the manifest.
          assert.deepStrictEqual(await columnDescriptionsFor(db, orders, []), { id: 'first' });
          clearDbtProjectCache();
          assert.strictEqual(await columnDescriptionsFor(db, orders, []), undefined, 'forgotten: no project any more');
        });

        it('remembers that a folder has no project, until told a dbt_project.yml appeared', async () => {
          const db = path.join(dir, 'dev.duckdb');
          assert.strictEqual(await columnDescriptionsFor(db, orders, []), undefined);
          writeProject('name: shop\n', 'target', 'now there is one');
          assert.strictEqual(await columnDescriptionsFor(db, orders, []), undefined, 'still the remembered answer');
          clearDbtProjectCache();
          assert.deepStrictEqual(await columnDescriptionsFor(db, orders, []), { id: 'now there is one' });
        });

        it('notices an edited dbt_project.yml without being told', async () => {
          writeProject('name: shop\n', 'target', 'old target');
          const db = path.join(dir, 'dev.duckdb');
          assert.deepStrictEqual(await columnDescriptionsFor(db, orders, []), { id: 'old target' });
          writeProject('name: shop\ntarget-path: other_target_folder\n', 'other_target_folder', 'new target');
          assert.deepStrictEqual(await columnDescriptionsFor(db, orders, []), { id: 'new target' });
        });
      });

      it('finds the manifest under an absolute target-path', async () => {
        const out = fs.mkdtempSync(path.join(os.tmpdir(), 'tablas-dbttarget-'));
        try {
          fs.writeFileSync(path.join(dir, 'dbt_project.yml'), `name: shop\ntarget-path: "${out.replace(/\\/g, '/')}"\n`);
          fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({ nodes: { a: node('shop', 'dev', 'absolute') } }));
          assert.deepStrictEqual(
            await columnDescriptionsFor(path.join(dir, 'dev.duckdb'), { name: 'orders', type: 'table' }, []),
            { id: 'absolute' }
          );
        } finally {
          fs.rmSync(out, { recursive: true, force: true });
        }
      });
    });

    it('says nothing for a table dbt does not know, or one without descriptions', async () => {
      const file = path.join(projectDir, 'schemas.duckdb');
      assert.strictEqual(await columnDescriptionsFor(file, { name: 'unknown', type: 'table' }, []), undefined);
      assert.strictEqual(
        await columnDescriptionsFor(file, { name: 'main_marts.not_built', type: 'table', schema: 'main_marts', table: 'not_built' }, []),
        undefined
      );
    });
  });
});
