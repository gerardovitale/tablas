import * as vscode from 'vscode';

/** Mirrors the `tablas.maxRows` default declared in package.json's configuration contribution. */
export const DEFAULT_MAX_ROWS = 5000;

/**
 * Hard ceiling on `tablas.maxRows`, applied regardless of the configured
 * value. `tablas.maxRows` is readable from workspace-level
 * `.vscode/settings.json`, which is attacker-controlled when opening an
 * untrusted repo -- without this ceiling, a malicious repo could set
 * `tablas.maxRows` to an enormous number and fully defeat the row cap that
 * keeps large-file opens responsive for every file opened in that
 * workspace, not just its own.
 */
export const MAX_ROWS_CEILING = 200_000;

/**
 * Single source of truth for reading `tablas.maxRows`, used by both
 * editor providers so the default/ceiling can't drift between them.
 */
export function getMaxRowsSetting(): number {
  const configured = vscode.workspace
    .getConfiguration('tablas')
    .get<number>('maxRows', DEFAULT_MAX_ROWS);
  const safe = Number.isFinite(configured) ? Math.floor(configured) : DEFAULT_MAX_ROWS;
  return Math.min(MAX_ROWS_CEILING, Math.max(1, safe));
}
