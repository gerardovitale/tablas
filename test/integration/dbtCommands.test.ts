import * as assert from 'assert';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { TablasApi } from '../../src/extension';
import type { MultiTableParseOutcome } from '../../src/tableData';
import type { PreviewResult } from '../../src/dbtCommands';
import { DuckdbEditorProvider } from '../../src/duckdbEditorProvider';

const fixturesDir = path.join(process.cwd(), 'test', 'fixtures');
const dbtDir = path.join(fixturesDir, 'dbt');
const sqlUri = (rel: string) => vscode.Uri.file(path.join(dbtDir, ...rel.split('/')));

function getApi(): TablasApi {
  const ext = vscode.extensions.getExtension<TablasApi>('gerardovitale.tablas');
  assert.ok(ext?.isActive && ext.exports, 'the extension should be active');
  return ext.exports;
}

/** Resolves with the next `duckdb-data` the host posts to any panel. */
function nextOutcome(): Promise<MultiTableParseOutcome> {
  return new Promise((resolve) => {
    const subscription = getApi().onDidPostDuckdbData((outcome) => {
      subscription.dispose();
      resolve(outcome);
    });
  });
}

const preview = (uri: vscode.Uri) => vscode.commands.executeCommand<PreviewResult>('tablas.previewDbtModel', uri);

describe('dbt: Preview Model', () => {
  before(async () => {
    const ext = vscode.extensions.getExtension('gerardovitale.tablas');
    assert.ok(ext);
    if (!ext.isActive) {
      await ext.activate();
    }
  });

  afterEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  it('activates in a workspace that holds a dbt project', () => {
    const contributed = vscode.extensions.getExtension('gerardovitale.tablas')?.packageJSON.activationEvents as string[];
    assert.ok(contributed.includes('workspaceContains:**/dbt_project.yml'));
  });

  it('opens the DuckDB file on the table dbt built from a model', async () => {
    const posted = nextOutcome();
    assert.strictEqual(await preview(sqlUri('models/marts/orders.sql')), 'shown');
    const outcome = await posted;
    assert.ok(outcome.success);
    if (outcome.success) {
      // schemas.duckdb is the file named after the manifest's database ("schemas").
      assert.strictEqual(outcome.data.selectedTable, 'main_marts.orders');
      assert.ok(
        vscode.window.tabGroups.all.some((g) => g.tabs.some((t) => t.label.includes('schemas.duckdb'))),
        'the file should be open'
      );
    }
  });

  it('uses the alias, so a model aliased to a name another schema also has opens the right one', async () => {
    const posted = nextOutcome();
    assert.strictEqual(await preview(sqlUri('models/staging/stg_orders.sql')), 'shown');
    const outcome = await posted;
    assert.ok(outcome.success && outcome.data.selectedTable === 'main_staging.orders');
  });

  it('switches a panel that is already open, and says the host chose the table', async () => {
    const opened = nextOutcome();
    await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(path.join(fixturesDir, 'schemas.duckdb')), 'tablas.duckdbViewer');
    const first = await opened;
    // The file reopens on the table remembered from earlier tests: preview the other one.
    const showing = first.success ? first.data.selectedTable : undefined;
    const [model, table] =
      showing === 'main_staging.orders'
        ? (['models/marts/orders.sql', 'main_marts.orders'] as const)
        : (['models/staging/stg_orders.sql', 'main_staging.orders'] as const);

    const posted = nextOutcome();
    assert.strictEqual(await preview(sqlUri(model)), 'shown');
    const outcome = await posted;
    assert.ok(outcome.success);
    if (outcome.success) {
      assert.strictEqual(outcome.data.selectedTable, table);
      assert.strictEqual(outcome.data.hostSelected, true);
    }
  });

  it('remembers a model opened by Preview, so reopening the file lands on it', async () => {
    const posted = nextOutcome();
    assert.strictEqual(await preview(sqlUri('models/marts/orders.sql')), 'shown');
    await posted;
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');

    const reopened = nextOutcome();
    await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(path.join(fixturesDir, 'schemas.duckdb')), 'tablas.duckdbViewer');
    const outcome = await reopened;
    assert.ok(outcome.success && outcome.data.selectedTable === 'main_marts.orders');
  });

  it('does not re-post a table that is already shown, so filters and scroll survive', async () => {
    const first = nextOutcome();
    assert.strictEqual(await preview(sqlUri('models/marts/orders.sql')), 'shown');
    await first;

    let reposted = false;
    const subscription = getApi().onDidPostDuckdbData(() => {
      reposted = true;
    });
    try {
      assert.strictEqual(await preview(sqlUri('models/marts/orders.sql')), 'shown');
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.strictEqual(reposted, false, 'the table on screen must not be replaced');
    } finally {
      subscription.dispose();
    }
  });

  it('says so when the model has no table in the file yet', async () => {
    assert.strictEqual(await preview(sqlUri('models/marts/not_built.sql')), 'missing-table');
  });

  it('explains files that are not a table', async () => {
    assert.strictEqual(await preview(sqlUri('macros/helpers.sql')), 'not-a-model', 'a macro');
    assert.strictEqual(await preview(sqlUri('tests/singular.sql')), 'not-a-model', 'a singular test');
    assert.strictEqual(await preview(sqlUri('models/staging/inline.sql')), 'not-a-model', 'an ephemeral model');
    assert.strictEqual(await preview(vscode.Uri.file(path.join(fixturesDir, 'simple.csv'))), 'not-sql');
  });

  describe('outside a usable project', () => {
    let dir: string;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tablas-dbtcmd-'));
    });
    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('a .sql file with no dbt_project.yml above it', async () => {
      const file = path.join(dir, 'a.sql');
      fs.writeFileSync(file, 'select 1');
      assert.strictEqual(await preview(vscode.Uri.file(file)), 'no-project');
    });

    it('a project that has not been parsed yet (no manifest)', async () => {
      fs.writeFileSync(path.join(dir, 'dbt_project.yml'), 'name: fresh\n');
      fs.mkdirSync(path.join(dir, 'models'));
      const file = path.join(dir, 'models', 'a.sql');
      fs.writeFileSync(file, 'select 1');
      assert.strictEqual(await preview(vscode.Uri.file(file)), 'no-manifest');
    });

    it('a manifest that is not JSON', async () => {
      fs.writeFileSync(path.join(dir, 'dbt_project.yml'), 'name: broken\n');
      fs.mkdirSync(path.join(dir, 'models'));
      fs.mkdirSync(path.join(dir, 'target'));
      fs.writeFileSync(path.join(dir, 'target', 'manifest.json'), '{ nope');
      const file = path.join(dir, 'models', 'a.sql');
      fs.writeFileSync(file, 'select 1');
      assert.strictEqual(await preview(vscode.Uri.file(file)), 'no-manifest');
    });

    it('a file the manifest does not list (a new model)', async () => {
      fs.cpSync(dbtDir, dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'models', 'brand_new.sql'), 'select 1');
      assert.strictEqual(await preview(vscode.Uri.file(path.join(dir, 'models', 'brand_new.sql'))), 'not-a-model');
    });
  });
});

describe('dbt: column descriptions in the payload', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tablas-dbtdocs-'));
    fs.cpSync(dbtDir, dir, { recursive: true });
    fs.copyFileSync(path.join(fixturesDir, 'schemas.duckdb'), path.join(dir, 'schemas.duckdb'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function open() {
    const provider = new DuckdbEditorProvider({ extensionPath: process.cwd() } as vscode.ExtensionContext);
    const document = provider.openCustomDocument(vscode.Uri.file(path.join(dir, 'schemas.duckdb')));
    const outcome = await provider.loadInitial(document);
    return { provider, document, outcome };
  }

  it("adds the manifest's descriptions for the table shown, and changes them with the table", async () => {
    const { provider, document, outcome } = await open();
    try {
      // First table is the main-schema source `raw_events`.
      assert.ok(outcome.success);
      if (outcome.success) {
        assert.deepStrictEqual(outcome.data.columnDescriptions, { kind: 'click or view' });
      }
      const marts = await provider.handleSelectTable(document, 'main_marts.orders');
      assert.ok(marts?.success);
      if (marts?.success) {
        assert.deepStrictEqual(marts.data.columnDescriptions, {
          id: 'Primary key of the order.',
          total: 'Order total in euros, tax included.',
        });
      }
      const noDocs = await provider.handleSelectTable(document, 'main_staging.stg_events');
      assert.ok(noDocs?.success && noDocs.data.columnDescriptions === undefined, 'a table dbt does not describe');
    } finally {
      document.dispose();
    }
  });

  it('keeps them across a reload and picks up a changed manifest', async () => {
    const { provider, document } = await open();
    try {
      await provider.handleSelectTable(document, 'main_marts.orders');
      const manifest = path.join(dir, 'target', 'manifest.json');
      const edited = fs.readFileSync(manifest, 'utf8').replace('Primary key of the order.', 'Surrogate key.');
      fs.writeFileSync(manifest, edited);
      const reloaded = await provider.handleReload(document);
      assert.ok(reloaded?.success);
      if (reloaded?.success) {
        assert.strictEqual(reloaded.data.columnDescriptions?.id, 'Surrogate key.');
      }
    } finally {
      document.dispose();
    }
  });

  it('shows nothing, and does not fail, when the manifest is gone or broken', async () => {
    fs.writeFileSync(path.join(dir, 'target', 'manifest.json'), '{ broken');
    const { document, outcome } = await open();
    try {
      assert.ok(outcome.success);
      if (outcome.success) {
        assert.strictEqual(outcome.data.columnDescriptions, undefined);
        assert.ok(outcome.data.data.rowCount > 0, 'the table itself is unaffected');
      }
    } finally {
      document.dispose();
    }
  });
});
