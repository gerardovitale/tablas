import * as path from 'path';
import * as vscode from 'vscode';
import {
  DBT_PROJECT_FILE,
  findNodeForFile,
  findProjectRoot,
  loadDbtManifest,
  manifestPath,
  readProject,
  type DbtRelation,
} from './dbt';
import type { DuckdbEditorProvider } from './duckdbEditorProvider';

/**
 * The vscode side of the light dbt support: the `tablas.dbtProject` context key
 * that shows the command in dbt workspaces, the list of project roots the
 * provider falls back on, and `tablas.previewDbtModel` ("Preview Model" on a
 * model's .sql file: open the table dbt built from it). The matching logic itself
 * lives in the vscode-free `dbt.ts`.
 */

const EXCLUDE = '**/{node_modules,.git,dbt_packages}/**';

let projectRoots: readonly string[] = [];

/** Folders of the dbt projects in the workspace (empty until the first scan finishes). */
export function getDbtProjectRoots(): readonly string[] {
  return projectRoots;
}

/** How `tablas.previewDbtModel` ended; also what the command returns (tests read it). */
export type PreviewResult =
  | 'shown'
  | 'missing-table'
  | 'unavailable'
  | 'not-sql'
  | 'no-project'
  | 'no-manifest'
  | 'not-a-model'
  | 'no-database'
  | 'cancelled';

export function registerDbtSupport(context: vscode.ExtensionContext, provider: DuckdbEditorProvider): void {
  const scan = async (): Promise<void> => {
    try {
      const found = await vscode.workspace.findFiles(`**/${DBT_PROJECT_FILE}`, EXCLUDE, 20);
      projectRoots = found.filter((uri) => uri.scheme === 'file').map((uri) => path.dirname(uri.fsPath));
    } catch {
      projectRoots = [];
    }
    await vscode.commands.executeCommand('setContext', 'tablas.dbtProject', projectRoots.length > 0);
  };
  void scan();

  const watcher = vscode.workspace.createFileSystemWatcher(`**/${DBT_PROJECT_FILE}`);
  context.subscriptions.push(
    watcher,
    watcher.onDidCreate(() => void scan()),
    watcher.onDidDelete(() => void scan()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void scan()),
    vscode.commands.registerCommand('tablas.previewDbtModel', (uri?: vscode.Uri) => previewDbtModel(provider, uri))
  );
}

/** Where the command starts: the file it was invoked on, else the active editor's. */
function sourceFile(uri?: vscode.Uri): vscode.Uri | undefined {
  return uri ?? vscode.window.activeTextEditor?.document.uri;
}

function say(message: string): void {
  void vscode.window.showInformationMessage(message);
}

/**
 * "Preview Model": from a dbt model's .sql file to the table dbt built from it.
 * Finds the project and its manifest, looks the file up, finds the DuckDB file
 * (by the manifest's database name, else asks), and has the viewer open on the
 * table. Every dead end says what to do and returns its reason.
 */
export async function previewDbtModel(provider: DuckdbEditorProvider, uri?: vscode.Uri): Promise<PreviewResult> {
  const file = sourceFile(uri);
  if (!file || file.scheme !== 'file' || path.extname(file.fsPath).toLowerCase() !== '.sql') {
    say('Open a dbt model (.sql file) to preview its table.');
    return 'not-sql';
  }
  const root = findProjectRoot(path.dirname(file.fsPath));
  if (!root) {
    say(`No ${DBT_PROJECT_FILE} found above ${path.basename(file.fsPath)}: it is not in a dbt project.`);
    return 'no-project';
  }
  const project = await readProject(root);
  const manifestFile = manifestPath(project);
  const loaded = await loadDbtManifest(manifestFile);
  if ('error' in loaded) {
    say(
      loaded.error === 'missing'
        ? `No manifest yet (${path.relative(root, manifestFile)}). Run dbt parse or dbt build, then try again.`
        : loaded.message
    );
    return 'no-manifest';
  }

  const relPath = path.relative(root, file.fsPath).split(path.sep).join('/');
  const node = findNodeForFile(loaded.index, relPath, project.name);
  if (!node) {
    say(`${path.basename(file.fsPath)} is not a model in the manifest. If it is new, run dbt parse and try again.`);
    return 'not-a-model';
  }
  if (!['model', 'seed', 'snapshot'].includes(node.resourceType) || node.materialized === 'ephemeral') {
    say(
      node.materialized === 'ephemeral'
        ? `${node.name} is ephemeral: dbt inlines it into other models, so it has no table.`
        : `${node.name} is a ${node.resourceType}, not a table or view.`
    );
    return 'not-a-model';
  }

  const database = await pickDuckdbFile(node, root);
  if (database === 'none') {
    say('No .duckdb or .ddb file found in the workspace.');
    return 'no-database';
  }
  if (database === undefined) {
    return 'cancelled';
  }
  const outcome = await provider.revealTable(database, { schema: node.schema, table: node.relation });
  if (outcome === 'missing') {
    say(`"${node.schema}.${node.relation}" is not in ${path.basename(database.fsPath)} yet. Run dbt build, then try again.`);
    return 'missing-table';
  }
  if (outcome === 'unavailable') {
    say(`Could not open ${path.basename(database.fsPath)} to show "${node.schema}.${node.relation}". Open it directly and check the error there.`);
    return 'unavailable';
  }
  return 'shown';
}

/**
 * The DuckDB file holding the model: `<database>.duckdb`/`.ddb` (dbt-duckdb names
 * the catalog after the file), else any DuckDB file in the workspace; one match is
 * used as is, several are offered (files inside the dbt project first).
 * `'none'` = no DuckDB file at all, `undefined` = the user dismissed the picker.
 */
async function pickDuckdbFile(node: DbtRelation, projectRoot: string): Promise<vscode.Uri | 'none' | undefined> {
  let found: vscode.Uri[] = [];
  // A glob made from a name with glob characters would match the wrong thing.
  if (node.database && /^[\w .-]+$/.test(node.database)) {
    found = await vscode.workspace.findFiles(`**/${node.database}.{duckdb,ddb}`, EXCLUDE, 20);
  }
  if (found.length === 0) {
    found = await vscode.workspace.findFiles('**/*.{duckdb,ddb}', EXCLUDE, 50);
  }
  found = found.filter((uri) => uri.scheme === 'file');
  if (found.length === 0) {
    return 'none';
  }
  if (found.length === 1) {
    return found[0];
  }
  const inProject = (uri: vscode.Uri) => !path.relative(projectRoot, uri.fsPath).startsWith('..');
  found.sort((a, b) => Number(inProject(b)) - Number(inProject(a)) || a.fsPath.length - b.fsPath.length);
  const picked = await vscode.window.showQuickPick(
    found.map((uri) => ({ label: path.basename(uri.fsPath), description: vscode.workspace.asRelativePath(uri, true), uri })),
    { placeHolder: `Which DuckDB file holds ${node.schema}.${node.relation}?` }
  );
  return picked?.uri;
}
