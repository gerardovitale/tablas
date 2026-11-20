import * as fs from 'fs';
import * as path from 'path';
import { MAIN_SCHEMA, type TableRef } from './tableData';

/**
 * Light dbt awareness, no `vscode` import (unit-tested from `test/unit/`): find a
 * dbt project and its `manifest.json`, index what dbt built (models, seeds,
 * snapshots, sources) by file and by relation, and match a dbt relation to a table
 * in a DuckDB file. Everything degrades to "nothing found" -- a missing or odd
 * manifest must never break opening a table.
 */

export const DBT_PROJECT_FILE = 'dbt_project.yml';
const DEFAULT_TARGET_PATH = 'target';

/** Longest description kept, so one verbose doc block cannot bloat every payload. */
const MAX_DESCRIPTION_LENGTH = 2000;
/** A manifest larger than this is not parsed (it would stall the extension host). */
export const MANIFEST_MAX_BYTES = 300 * 1024 * 1024;

/** Resource types that end up as a table or view the viewer can show. */
const RELATION_TYPES: ReadonlySet<string> = new Set(['model', 'seed', 'snapshot', 'source']);

export interface DbtProjectInfo {
  root: string;
  /** `name:` of dbt_project.yml; models of other packages carry another `package_name`. */
  name?: string;
  /** `target-path:` (default `target`), relative to the root. */
  targetPath: string;
}

/**
 * Reads `name:` and `target-path:` from dbt_project.yml with two line patterns, not
 * a YAML parser (only top-level scalars matter; a templated value falls back to
 * the default).
 */
export function parseProjectYaml(text: string): { name?: string; targetPath: string } {
  const scalar = (key: string): string | undefined => {
    const match = new RegExp(`^${key}:[ \\t]*(?:"([^"\\n]*)"|'([^'\\n]*)'|([^#\\n]*))`, 'm').exec(text);
    const value = (match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim();
    return value === '' || value.includes('{{') ? undefined : value;
  };
  return { name: scalar('name'), targetPath: scalar('target-path') ?? DEFAULT_TARGET_PATH };
}

/** Walks up from `startDir` to the first folder holding a dbt_project.yml. */
export function findProjectRoot(startDir: string): string | undefined {
  let dir = path.resolve(startDir);
  for (;;) {
    if (fs.existsSync(path.join(dir, DBT_PROJECT_FILE))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

/** `<target-path>/manifest.json`; an absolute `target-path:` stands on its own instead of going under the root. */
export function manifestPath(project: DbtProjectInfo): string {
  return path.resolve(project.root, project.targetPath, 'manifest.json');
}

export async function readProject(root: string): Promise<DbtProjectInfo> {
  let text = '';
  try {
    text = await fs.promises.readFile(path.join(root, DBT_PROJECT_FILE), 'utf8');
  } catch {
    // unreadable: the defaults still point at <root>/target
  }
  return { root, ...parseProjectYaml(text) };
}

/**
 * `findProjectRoot` and `readProject` run on every first load, table switch and reload
 * of a DuckDB file (up to three times per reload), each with synchronous `existsSync`
 * calls up the folder tree. Their answers change only when a `dbt_project.yml` appears,
 * disappears or is edited, so they are remembered: the root per folder for a short
 * time (a project created outside the workspace has no watcher to tell us), the parsed
 * project until the file's mtime or size changes.
 */
const ROOT_CACHE_TTL_MS = 30_000;
const rootCache = new Map<string, { root: string | undefined; at: number }>();
const projectCache = new Map<string, { mtimeMs: number; size: number; info: DbtProjectInfo }>();

/** Forgets what the project lookups remember (a `dbt_project.yml` was created or deleted). */
export function clearDbtProjectCache(): void {
  rootCache.clear();
  projectCache.clear();
}

function findProjectRootCached(startDir: string): string | undefined {
  const key = path.resolve(startDir);
  const hit = rootCache.get(key);
  if (hit && Date.now() - hit.at < ROOT_CACHE_TTL_MS) {
    return hit.root;
  }
  const root = findProjectRoot(key);
  rootCache.set(key, { root, at: Date.now() });
  return root;
}

async function readProjectCached(root: string): Promise<DbtProjectInfo> {
  let stat: fs.Stats | undefined;
  try {
    stat = await fs.promises.stat(path.join(root, DBT_PROJECT_FILE));
  } catch {
    // gone or unreadable: readProject falls back to the defaults
  }
  const hit = projectCache.get(root);
  if (stat && hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
    return hit.info;
  }
  const info = await readProject(root);
  if (stat) {
    projectCache.set(root, { mtimeMs: stat.mtimeMs, size: stat.size, info });
  } else {
    projectCache.delete(root);
  }
  return info;
}

/** One relation dbt knows about. */
export interface DbtRelation {
  resourceType: string;
  /** dbt's node name (the model's file name without extension). */
  name: string;
  packageName?: string;
  /** Catalog dbt wrote to; for dbt-duckdb that is the database file's name without extension. */
  database?: string;
  schema: string;
  /** The table or view name in the database: `alias`, else `name` (a source's `identifier`). */
  relation: string;
  materialized?: string;
  /** Path relative to its package root, with forward slashes. */
  originalFilePath: string;
  /** Column name -> non-empty description. */
  columns: Record<string, string>;
}

export interface DbtManifestIndex {
  /** Every node by `original_file_path` (tests and analyses too, to say what a file is). */
  byFile: Map<string, DbtRelation[]>;
  /** Models, seeds, snapshots and sources by `relationKey`. */
  byRelation: Map<string, DbtRelation[]>;
}

/** Case-insensitive key: DuckDB identifiers are, and dbt keeps the case the author wrote. */
export function relationKey(schema: string, relation: string): string {
  return `${schema.toLowerCase()}.${relation.toLowerCase()}`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function columnDescriptions(columns: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, column] of Object.entries(asRecord(columns) ?? {})) {
    const description = asString(asRecord(column)?.description)?.trim();
    if (description) {
      result[key] = description.length > MAX_DESCRIPTION_LENGTH ? `${description.slice(0, MAX_DESCRIPTION_LENGTH)}…` : description;
    }
  }
  return result;
}

function toRelation(raw: unknown): DbtRelation | undefined {
  const node = asRecord(raw);
  if (!node) {
    return undefined;
  }
  const resourceType = asString(node.resource_type);
  const schema = asString(node.schema);
  const name = asString(node.name);
  const originalFilePath = asString(node.original_file_path);
  if (!resourceType || !name || !originalFilePath) {
    return undefined;
  }
  const isSource = resourceType === 'source';
  const relation = (isSource ? asString(node.identifier) : asString(node.alias)) ?? name;
  return {
    resourceType,
    name,
    packageName: asString(node.package_name),
    database: asString(node.database),
    // A test or analysis has no schema of its own; only relations need one.
    schema: schema ?? '',
    relation,
    materialized: asString(asRecord(node.config)?.materialized),
    originalFilePath: originalFilePath.replace(/\\/g, '/'),
    columns: columnDescriptions(node.columns),
  };
}

/** Indexes a parsed manifest.json. Tolerates anything: unknown shapes just yield an empty index. */
export function indexManifest(manifest: unknown): DbtManifestIndex {
  const index: DbtManifestIndex = { byFile: new Map(), byRelation: new Map() };
  const root = asRecord(manifest);
  for (const section of [asRecord(root?.nodes), asRecord(root?.sources)]) {
    for (const raw of Object.values(section ?? {})) {
      const relation = toRelation(raw);
      if (!relation) {
        continue;
      }
      push(index.byFile, relation.originalFilePath, relation);
      if (RELATION_TYPES.has(relation.resourceType) && relation.schema !== '') {
        push(index.byRelation, relationKey(relation.schema, relation.relation), relation);
      }
    }
  }
  return index;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) {
    list.push(value);
  } else {
    map.set(key, [value]);
  }
}

/**
 * What dbt built from `originalFilePath` (relative to the project root, forward
 * slashes). `original_file_path` is relative to each *package*, so an installed
 * package can have a node at the same path as a file of the project: with a known
 * `projectName` only the project's own node counts (a file the manifest does not
 * list yet must read as "not a model", not as the package's). Without a name, the
 * first match.
 */
export function findNodeForFile(
  index: DbtManifestIndex,
  originalFilePath: string,
  projectName?: string
): DbtRelation | undefined {
  const candidates = index.byFile.get(originalFilePath);
  return projectName === undefined ? candidates?.[0] : candidates?.find((c) => c.packageName === projectName);
}

/**
 * Which of the nodes sharing a relation name describes the table in the DuckDB
 * file called `fileStem` (extension removed). dbt-duckdb names the catalog it
 * writes to after the file, so a node whose `database` is another name was built
 * somewhere else: it is not this table. A node without a database matches any
 * file. The project's own package wins over an installed one.
 */
function relationForFile(candidates: readonly DbtRelation[] | undefined, fileStem: string, projectName?: string): DbtRelation | undefined {
  const here = (candidates ?? []).filter((c) => c.database === undefined || c.database.toLowerCase() === fileStem.toLowerCase());
  return here.find((c) => projectName !== undefined && c.packageName === projectName) ?? here[0];
}

export type ManifestResult =
  | { index: DbtManifestIndex }
  | { error: 'missing' | 'too-large' | 'invalid'; message: string };

const manifestCache = new Map<string, { mtimeMs: number; size: number; index: DbtManifestIndex }>();

/** Reads and indexes a manifest, remembering it until the file changes (size or mtime). */
export async function loadDbtManifest(file: string): Promise<ManifestResult> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(file);
  } catch {
    return { error: 'missing', message: `No manifest at ${file}.` };
  }
  if (stat.size > MANIFEST_MAX_BYTES) {
    return { error: 'too-large', message: `The manifest at ${file} is too large to read.` };
  }
  const cached = manifestCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return { index: cached.index };
  }
  try {
    const index = indexManifest(JSON.parse(await fs.promises.readFile(file, 'utf8')));
    manifestCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, index });
    return { index };
  } catch (err) {
    manifestCache.delete(file);
    return { error: 'invalid', message: `The manifest at ${file} could not be read: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** A table named the way dbt names it. */
export interface TableTarget {
  schema: string;
  table: string;
}

/** The listed table matching `target`: exact first, then ignoring case. */
export function findTableRef(tables: readonly TableRef[], target: TableTarget): TableRef | undefined {
  const schemaOf = (ref: TableRef) => ref.schema ?? MAIN_SCHEMA;
  const tableOf = (ref: TableRef) => ref.table ?? ref.name;
  return (
    tables.find((ref) => schemaOf(ref) === target.schema && tableOf(ref) === target.table) ??
    tables.find(
      (ref) =>
        schemaOf(ref).toLowerCase() === target.schema.toLowerCase() &&
        tableOf(ref).toLowerCase() === target.table.toLowerCase()
    )
  );
}

/**
 * Column descriptions dbt has for `ref`, for a DuckDB file: from the dbt project
 * above the file, else the workspace's only project. `undefined` whenever any
 * step finds nothing -- no project, no manifest, table not in it, no descriptions.
 */
export async function columnDescriptionsFor(
  dbFilePath: string,
  ref: TableRef,
  workspaceRoots: readonly string[]
): Promise<Record<string, string> | undefined> {
  const root = findProjectRootCached(path.dirname(dbFilePath)) ?? (workspaceRoots.length === 1 ? workspaceRoots[0] : undefined);
  if (!root) {
    return undefined;
  }
  const project = await readProjectCached(root);
  const loaded = await loadDbtManifest(manifestPath(project));
  if ('error' in loaded) {
    return undefined;
  }
  const hit = relationForFile(
    loaded.index.byRelation.get(relationKey(ref.schema ?? MAIN_SCHEMA, ref.table ?? ref.name)),
    path.basename(dbFilePath, path.extname(dbFilePath)),
    project.name
  );
  return hit && Object.keys(hit.columns).length > 0 ? hit.columns : undefined;
}
