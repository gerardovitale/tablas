import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { JSDOM } from 'jsdom';
import type { CsvParseOutcome } from '../../../src/csvParser';
import { bucketIndex, planHistogram } from '../../../src/columnStats';
import type {
  ColumnStats,
  MultiTableData,
  MultiTableParseOutcome,
  ParsedTable,
  TableStats,
} from '../../../src/tableData';

const webviewMainPath = path.join(process.cwd(), 'src', 'webview', 'main.js');
const webviewMainSource = fs.readFileSync(webviewMainPath, 'utf8');

/**
 * `src/webview/main.js` isn't a CJS/ESM module — in production it runs as a
 * plain `<script>` tag inside the webview, an IIFE with no exports that
 * calls `acquireVsCodeApi()` and wires a `window.addEventListener('message',
 * ...)` listener as a side effect. We test it the same way: build a fresh
 * jsdom document, stub the globals it expects, and execute its source text
 * fresh with `vm.runInThisContext` so each test gets its own listener bound
 * to its own DOM (a `require`/`import` cache would instead hand back the
 * first test's already-executed, already-bound module).
 */
interface VsCodeApiStub {
  postMessage: (msg: unknown) => void;
  getState: () => unknown;
  setState: (state: unknown) => void;
}

interface WebviewGlobals {
  window: unknown;
  document: unknown;
  acquireVsCodeApi: (() => VsCodeApiStub) | undefined;
}

const webviewGlobal = global as unknown as WebviewGlobals;

/**
 * `initialState` seeds `vscode.getState()`; every `setState` call is recorded
 * and reflected back through `getState`, like the real webview state store.
 */
/** Statistics the default `get-stats` auto-reply answers with; set by the stats tests' `send`. */
let replyStats: TableStats | undefined;

type StatsReply = (request: { type: string; table?: string }) => unknown;

/**
 * Like a real host, answers a `get-stats` request with a `stats-data` message
 * carrying `replyStats` (echoing the requested table). The reply is delivered
 * synchronously inside `postMessage`, which is the harshest ordering for the
 * webview to cope with. Pass a custom `reply` to answer differently (its
 * return value is the `stats-data` payload; `undefined` = don't answer, so the
 * test can deliver a reply later), or `null` to never answer.
 */
function loadWebview(
  initialState?: unknown,
  reply?: StatsReply | null
): {
  dom: JSDOM;
  postedMessages: unknown[];
  savedStates: unknown[];
} {
  const dom = new JSDOM('<!DOCTYPE html><body><div id="app"></div></body>');
  const postedMessages: unknown[] = [];
  const savedStates: unknown[] = [];
  let state: unknown = initialState;

  webviewGlobal.window = dom.window;
  webviewGlobal.document = dom.window.document;
  webviewGlobal.acquireVsCodeApi = () => ({
    postMessage: (msg: unknown) => {
      postedMessages.push(msg);
      const request = msg as { type: string; table?: string };
      if (request.type === 'get-stats' && reply !== null) {
        const payload = reply
          ? reply(request)
          : { ...(request.table !== undefined && { table: request.table }), stats: replyStats };
        if (payload !== undefined) {
          dom.window.dispatchEvent(
            new dom.window.MessageEvent('message', { data: { type: 'stats-data', payload } })
          );
        }
      }
    },
    getState: () => state,
    setState: (next: unknown) => {
      state = next;
      savedStates.push(next);
    },
  });

  vm.runInThisContext(webviewMainSource, { filename: webviewMainPath });

  return { dom, postedMessages, savedStates };
}

function sendCsvData(dom: JSDOM, payload: CsvParseOutcome): void {
  dom.window.dispatchEvent(
    new dom.window.MessageEvent('message', { data: { type: 'csv-data', payload } })
  );
}

function sendSqliteData(dom: JSDOM, payload: MultiTableParseOutcome): void {
  dom.window.dispatchEvent(
    new dom.window.MessageEvent('message', { data: { type: 'sqlite-data', payload } })
  );
}

function sendDuckdbData(dom: JSDOM, payload: MultiTableParseOutcome): void {
  dom.window.dispatchEvent(
    new dom.window.MessageEvent('message', { data: { type: 'duckdb-data', payload } })
  );
}

// ── Table picker helpers ────────────────────────────────────────────────

function pickerTrigger(app: HTMLElement): HTMLButtonElement | null {
  return app.querySelector('button.table-picker-trigger');
}

/** The name shown on the trigger button (the currently selected table). */
function pickerCurrent(app: HTMLElement): string | null | undefined {
  return pickerTrigger(app)?.querySelector('.picker-name')?.textContent;
}

function openPickerPopup(app: HTMLElement): HTMLElement {
  pickerTrigger(app)!.click();
  const popup = app.querySelector('.table-picker-popup');
  assert.ok(popup, 'the picker popup should be open');
  return popup as HTMLElement;
}

/** Names of the options currently listed in the open popup, in order. */
function listedNames(app: HTMLElement): (string | null | undefined)[] {
  return Array.from(app.querySelectorAll('.table-picker-option')).map(
    (o) => o.querySelector('.picker-name')?.textContent
  );
}

function pickerKey(dom: JSDOM, target: Element, key: string): KeyboardEvent {
  const event = new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

function pickerSearch(popup: HTMLElement): HTMLInputElement {
  return popup.querySelector('input.table-picker-search') as HTMLInputElement;
}

function typeInPicker(dom: JSDOM, popup: HTMLElement, text: string): void {
  const search = pickerSearch(popup);
  search.value = text;
  search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
}

/** Opens the picker and clicks the option for `name`. */
function pickTable(app: HTMLElement, name: string): void {
  const popup = openPickerPopup(app);
  const option = Array.from(popup.querySelectorAll('.table-picker-option')).find(
    (o) => o.querySelector('.picker-name')?.textContent === name
  ) as HTMLElement;
  assert.ok(option, `option "${name}" should be listed`);
  option.click();
}

describe('webview main.js rendering', () => {
  afterEach(() => {
    webviewGlobal.window = undefined;
    webviewGlobal.document = undefined;
    webviewGlobal.acquireVsCodeApi = undefined;
  });

  it('posts a ready message on load', () => {
    const { postedMessages } = loadWebview();
    assert.deepStrictEqual(postedMessages, [{ type: 'ready' }]);
  });

  it('renders headers and rows for a successful parse', () => {
    const { dom } = loadWebview();
    sendCsvData(dom, {
      success: true,
      errors: [],
      data: {
        headers: ['name', 'age'],
        rows: [
          ['Alice', '30'],
          ['Bob', '25'],
        ],
        rowCount: 2,
        columnCount: 2,
      },
    });

    const app = dom.window.document.getElementById('app')!;
    const headerCells = Array.from(app.querySelectorAll('thead tr:first-child th')).map((th) => th.textContent);
    assert.deepStrictEqual(headerCells, ['#', 'name', 'age']);

    const bodyRows = app.querySelectorAll('tbody tr');
    assert.strictEqual(bodyRows.length, 2);
    assert.deepStrictEqual(
      Array.from(bodyRows[0].querySelectorAll('td')).map((td) => td.textContent),
      ['1', 'Alice', '30']
    );
    assert.deepStrictEqual(
      Array.from(bodyRows[1].querySelectorAll('td')).map((td) => td.textContent),
      ['2', 'Bob', '25']
    );

    const stats = app.querySelector('.stats-bar');
    assert.strictEqual(stats?.textContent, '2 rows × 2 columns');
  });

  it('keeps table-layout auto (no table-fixed class) for small tables', () => {
    const { dom } = loadWebview();
    sendCsvData(dom, {
      success: true,
      errors: [],
      data: {
        headers: ['name'],
        rows: [['Alice'], ['Bob']],
        rowCount: 2,
        columnCount: 1,
      },
    });

    const app = dom.window.document.getElementById('app')!;
    const table = app.querySelector('#csv-table');
    assert.strictEqual(table?.classList.contains('table-fixed'), false);
  });

  it('switches to table-layout fixed (table-fixed class) once row count is large', () => {
    const { dom } = loadWebview();
    const rows = Array.from({ length: 501 }, (_, i) => [`row${i}`]);
    sendCsvData(dom, {
      success: true,
      errors: [],
      data: { headers: ['name'], rows, rowCount: rows.length, columnCount: 1 },
    });

    const app = dom.window.document.getElementById('app')!;
    const table = app.querySelector('#csv-table');
    assert.strictEqual(table?.classList.contains('table-fixed'), true);
  });

  it('appends a truncation notice to the stats bar when totalRowCount exceeds rowCount', () => {
    const { dom } = loadWebview();
    sendCsvData(dom, {
      success: true,
      errors: [],
      data: {
        headers: ['name'],
        rows: [['Alice']],
        rowCount: 1,
        columnCount: 1,
        totalRowCount: 5,
      },
    });

    const app = dom.window.document.getElementById('app')!;
    const stats = app.querySelector('.stats-bar');
    assert.match(stats?.textContent ?? '', /showing first 1 of 5/i);
  });

  it('omits the truncation notice when totalRowCount equals rowCount', () => {
    const { dom } = loadWebview();
    sendCsvData(dom, {
      success: true,
      errors: [],
      data: {
        headers: ['name'],
        rows: [['Alice']],
        rowCount: 1,
        columnCount: 1,
        totalRowCount: 1,
      },
    });

    const app = dom.window.document.getElementById('app')!;
    const stats = app.querySelector('.stats-bar');
    assert.strictEqual(stats?.textContent, '1 row × 1 column');
  });

  it('shows an empty-file message when columnCount is 0', () => {
    const { dom } = loadWebview();
    sendCsvData(dom, {
      success: true,
      errors: [],
      data: { headers: [], rows: [], rowCount: 0, columnCount: 0 },
    });

    const app = dom.window.document.getElementById('app')!;
    assert.strictEqual(app.querySelector('table'), null);
    assert.match(app.textContent ?? '', /empty file/i);
  });

  it('shows an error message when parsing fails, without touching innerHTML', () => {
    const { dom } = loadWebview();
    sendCsvData(dom, {
      success: false,
      errors: [{ type: 'Abort', code: 'TooManyFields', message: 'Too many fields: expected 2' }],
    });

    const app = dom.window.document.getElementById('app')!;
    const message = app.querySelector('.message.error');
    assert.ok(message, 'error message element should be rendered');
    assert.match(message!.textContent ?? '', /Too many fields: expected 2/);
  });

  it('renders untrusted cell content as inert text, not markup', () => {
    const { dom } = loadWebview();
    const payload = '<img src=x onerror=alert(1)>';
    sendCsvData(dom, {
      success: true,
      errors: [],
      data: {
        headers: [payload],
        rows: [[payload]],
        rowCount: 1,
        columnCount: 1,
      },
    });

    const app = dom.window.document.getElementById('app')!;
    // No element from the injected markup should have been parsed into the DOM.
    assert.strictEqual(app.querySelector('img'), null);
    // The literal string is present as text instead.
    const headerCell = app.querySelector('thead th:not(.row-num)');
    assert.strictEqual(headerCell?.textContent, payload);
  });

  describe('sqlite-data (multi-table sources)', () => {
    it('renders a table picker showing the selected table, plus the table', () => {
      const { dom } = loadWebview();
      sendSqliteData(dom, {
        success: true,
        errors: [],
        data: {
          tables: [
            { name: 'customers', type: 'table' },
            { name: 'customer_totals', type: 'view' },
          ],
          selectedTable: 'customer_totals',
          data: {
            headers: ['name', 'total'],
            rows: [['Acme', '25.49']],
            rowCount: 1,
            columnCount: 2,
          },
        },
      });

      const app = dom.window.document.getElementById('app')!;
      assert.ok(pickerTrigger(app), 'a table picker should be rendered');
      assert.strictEqual(app.querySelector('select'), null, 'no native <select> any more');
      assert.strictEqual(pickerCurrent(app), 'customer_totals');
      assert.ok(pickerTrigger(app)!.querySelector('.picker-tag'), 'a view is tagged on the trigger');

      const popup = openPickerPopup(app);
      assert.deepStrictEqual(listedNames(app), ['customers', 'customer_totals']);
      const selected = popup.querySelector('[aria-selected="true"]');
      assert.strictEqual(selected?.querySelector('.picker-name')?.textContent, 'customer_totals');

      const table = app.querySelector('table');
      assert.ok(table, 'the selected table should also be rendered');
    });

    it('keeps the selector visible when the selected table has zero columns', () => {
      const { dom } = loadWebview();
      sendSqliteData(dom, {
        success: true,
        errors: [],
        data: {
          tables: [
            { name: 'empty_table', type: 'table' },
            { name: 'other', type: 'table' },
          ],
          selectedTable: 'empty_table',
          data: { headers: [], rows: [], rowCount: 0, columnCount: 0 },
        },
      });

      const app = dom.window.document.getElementById('app')!;
      assert.ok(pickerTrigger(app), 'the table picker should survive a zero-column selection');
      assert.strictEqual(pickerCurrent(app), 'empty_table');
      assert.match(app.textContent ?? '', /empty file/i);
    });

    it('drops a stale select-table response superseded by a newer request', () => {
      const { dom } = loadWebview();
      sendSqliteData(dom, {
        success: true,
        errors: [],
        data: {
          tables: [
            { name: 'a', type: 'table' },
            { name: 'b', type: 'table' },
          ],
          selectedTable: 'a',
          data: { headers: ['id'], rows: [['1']], rowCount: 1, columnCount: 1 },
        },
      });

      const app = dom.window.document.getElementById('app')!;
      // The user switches to 'b' before the host has answered.
      pickTable(app, 'b');

      // A late response for the first (now-superseded) request for 'a'
      // should be dropped, not flash 'a' back onto the screen.
      sendSqliteData(dom, {
        success: true,
        errors: [],
        data: {
          tables: [
            { name: 'a', type: 'table' },
            { name: 'b', type: 'table' },
          ],
          selectedTable: 'a',
          data: { headers: ['id'], rows: [['1']], rowCount: 1, columnCount: 1 },
        },
      });

      assert.strictEqual(pickerCurrent(app), 'b', 'a stale response for "a" must not override "b"');

      // The real response for 'b' should still be accepted normally.
      sendSqliteData(dom, {
        success: true,
        errors: [],
        data: {
          tables: [
            { name: 'a', type: 'table' },
            { name: 'b', type: 'table' },
          ],
          selectedTable: 'b',
          data: { headers: ['id'], rows: [['2']], rowCount: 1, columnCount: 1 },
        },
      });

      assert.strictEqual(pickerCurrent(app), 'b');
      const bodyRow = app.querySelector('tbody tr');
      assert.deepStrictEqual(
        Array.from(bodyRow!.querySelectorAll('td')).map((td) => td.textContent),
        ['1', '2']
      );
    });

    it('posts a select-table message when another table is picked', () => {
      const { dom, postedMessages } = loadWebview();
      sendSqliteData(dom, {
        success: true,
        errors: [],
        data: {
          tables: [
            { name: 'customers', type: 'table' },
            { name: 'orders', type: 'table' },
          ],
          selectedTable: 'customers',
          data: { headers: ['id'], rows: [['1']], rowCount: 1, columnCount: 1 },
        },
      });

      const app = dom.window.document.getElementById('app')!;
      pickTable(app, 'orders');

      assert.deepStrictEqual(postedMessages[postedMessages.length - 1], {
        type: 'select-table',
        table: 'orders',
      });
    });

    it('shows a "no tables" message and no selector/table for a table-less database', () => {
      const { dom } = loadWebview();
      sendSqliteData(dom, {
        success: true,
        errors: [],
        data: {
          tables: [],
          selectedTable: '',
          data: { headers: [], rows: [], rowCount: 0, columnCount: 0 },
        },
      });

      const app = dom.window.document.getElementById('app')!;
      assert.strictEqual(pickerTrigger(app), null);
      assert.strictEqual(app.querySelector('table'), null);
      assert.match(app.textContent ?? '', /no tables found/i);
    });

    it('shows an error message when parsing fails, without touching innerHTML', () => {
      const { dom } = loadWebview();
      sendSqliteData(dom, {
        success: false,
        errors: [{ type: 'SqliteError', code: 'NotASqliteFile', message: 'not a sqlite file' }],
      });

      const app = dom.window.document.getElementById('app')!;
      const message = app.querySelector('.message.error');
      assert.ok(message, 'error message element should be rendered');
      assert.match(message!.textContent ?? '', /not a sqlite file/);
    });

    it('renders untrusted table names as inert text, not markup', () => {
      const { dom } = loadWebview();
      const payload = '<img src=x onerror=alert(1)>';
      sendSqliteData(dom, {
        success: true,
        errors: [],
        data: {
          tables: [{ name: payload, type: 'table' }],
          selectedTable: payload,
          data: { headers: ['x'], rows: [['1']], rowCount: 1, columnCount: 1 },
        },
      });

      const app = dom.window.document.getElementById('app')!;
      assert.strictEqual(app.querySelector('img'), null);
      assert.strictEqual(pickerCurrent(app), payload);
      openPickerPopup(app);
      assert.strictEqual(app.querySelector('img'), null);
      assert.deepStrictEqual(listedNames(app), [payload]);
    });
  });

  describe('duckdb-data', () => {
    // duckdb-data is routed to the exact same renderMultiTableOutcome as
    // sqlite-data/xlsx-data (see the 'sqlite-data (multi-table sources)'
    // suite above for full coverage of that shared rendering path) -- this
    // just proves the dispatch wiring for the new message type itself.
    it('renders a table selector and the table', () => {
      const { dom } = loadWebview();
      sendDuckdbData(dom, {
        success: true,
        errors: [],
        data: {
          tables: [
            { name: 'customers', type: 'table' },
            { name: 'customer_totals', type: 'view' },
          ],
          selectedTable: 'customer_totals',
          data: {
            headers: ['name', 'total'],
            rows: [['Acme', '25.49']],
            rowCount: 1,
            columnCount: 2,
          },
        },
      });

      const app = dom.window.document.getElementById('app')!;
      assert.ok(pickerTrigger(app), 'a table picker should be rendered');
      assert.strictEqual(pickerCurrent(app), 'customer_totals');
      assert.ok(app.querySelector('table'), 'the selected table should also be rendered');
    });

    it('keeps the selector and shows the error when the selected table cannot be read', () => {
      const { dom } = loadWebview();
      sendDuckdbData(dom, {
        success: true,
        errors: [],
        data: {
          tables: [
            { name: 'broken_view', type: 'view' },
            { name: 'customers', type: 'table' },
          ],
          selectedTable: 'broken_view',
          data: { headers: [], rows: [], rowCount: 0, columnCount: 0 },
          tableError: 'IO Error: No files found',
        },
      });

      const app = dom.window.document.getElementById('app')!;
      assert.ok(pickerTrigger(app), 'the picker must stay so another table can be picked');
      assert.strictEqual(app.querySelector('table'), null);
      const message = app.querySelector('p.message.error');
      assert.ok(message);
      assert.strictEqual(message!.textContent, 'Could not read "broken_view":\nIO Error: No files found');
    });
  });

  describe('duckdb reload (live refresh)', () => {
    function payload(
      rows: string[][],
      extra: Partial<MultiTableData> = {},
      headers = ['id', 'city']
    ): MultiTableParseOutcome {
      return {
        success: true,
        errors: [],
        data: {
          tables: [
            { name: 'a', type: 'table' },
            { name: 'b', type: 'table' },
          ],
          selectedTable: 'a',
          data: { headers, rows, rowCount: rows.length, columnCount: headers.length },
          capabilities: { refresh: true },
          ...extra,
        },
      };
    }
    const threeRows = [['1', 'Rome'], ['2', 'Paris'], ['3', 'Oslo']];
    const fiveRows = [...threeRows, ['4', 'Lima'], ['5', 'Rome']];
    const status = (dom: JSDOM) => dom.window.document.querySelector('.reload-status');
    const filterBoxes = (dom: JSDOM) =>
      Array.from(dom.window.document.querySelectorAll<HTMLInputElement>('input.col-filter'));
    const filterRequests = (posted: unknown[]) =>
      posted.filter((m) => (m as { type: string }).type === 'filter') as Array<{
        filters: Array<{ column: number; text: string }>;
      }>;
    const sendStatus = (dom: JSDOM, message: Record<string, unknown>) =>
      dom.window.dispatchEvent(
        new dom.window.MessageEvent('message', { data: { type: 'reload-status', ...message } })
      );

    it('shows a refresh button only when the host advertises refresh', () => {
      const { dom, postedMessages } = loadWebview();
      sendDuckdbData(dom, payload(threeRows, { capabilities: undefined }));
      assert.strictEqual(dom.window.document.querySelector('.toolbar-button'), null);
      assert.strictEqual(status(dom), null);

      sendDuckdbData(dom, payload(threeRows));
      const button = dom.window.document.querySelector<HTMLButtonElement>('.toolbar-button');
      assert.ok(button);
      button.click();
      assert.ok(postedMessages.some((m) => (m as { type: string }).type === 'refresh'));
    });

    it('shows when the data was refreshed and how the row count moved', () => {
      const { dom } = loadWebview();
      sendDuckdbData(dom, payload(threeRows));
      assert.strictEqual(status(dom)?.textContent, '');
      sendDuckdbData(dom, payload(fiveRows, { reload: { at: '2026-11-19T10:00:00.000Z', previousRowCount: 3 } }));
      assert.match(status(dom)?.textContent ?? '', /^Updated .+ · rows 3 → 5 \(\+2\)$/);
      sendDuckdbData(dom, payload(threeRows, { reload: { at: '2026-11-19T10:01:00.000Z', previousRowCount: 5 } }));
      assert.match(status(dom)?.textContent ?? '', /rows 5 → 3 \(−2\)$/);
      sendDuckdbData(dom, payload(threeRows, { reload: { at: '2026-11-19T10:02:00.000Z', previousRowCount: 3 } }));
      assert.match(status(dom)?.textContent ?? '', /3 rows, count unchanged$/);
    });

    it('reports refresh progress and failure from reload-status', () => {
      const { dom } = loadWebview();
      sendDuckdbData(dom, payload(threeRows));
      sendStatus(dom, { state: 'refreshing' });
      assert.strictEqual(status(dom)?.textContent, 'Refreshing…');
      sendStatus(dom, { state: 'building' });
      assert.match(status(dom)?.textContent ?? '', /^Build in progress/);
      sendStatus(dom, { state: 'failed', message: 'file is locked\nsecond line' });
      assert.strictEqual(status(dom)?.textContent, 'Refresh failed: file is locked');
      assert.ok(status(dom)?.classList.contains('error'));
      assert.strictEqual(status(dom)?.getAttribute('title'), 'file is locked\nsecond line');
      // The table that was on screen is untouched by a failed refresh.
      assert.strictEqual(dom.window.document.querySelectorAll('#csv-table tbody tr').length, 3);
    });

    it('keeps the filter text and asks the host to filter the new data', () => {
      const { dom, postedMessages } = loadWebview();
      sendDuckdbData(dom, payload(threeRows));
      filterBoxes(dom)[1].value = 'Rome';
      sendDuckdbData(dom, payload(fiveRows, { reload: { at: '2026-11-19T10:00:00.000Z', previousRowCount: 3 } }));
      assert.strictEqual(filterBoxes(dom)[1].value, 'Rome');
      const requests = filterRequests(postedMessages);
      assert.deepStrictEqual(requests[requests.length - 1].filters, [{ column: 1, text: 'Rome' }]);
    });

    it('drops the filters when the columns changed', () => {
      const { dom, postedMessages } = loadWebview();
      sendDuckdbData(dom, payload(threeRows));
      filterBoxes(dom)[1].value = 'Rome';
      const before = filterRequests(postedMessages).length;
      sendDuckdbData(
        dom,
        payload(
          [['1', 'Rome', 'x']],
          { reload: { at: '2026-11-19T10:00:00.000Z', previousRowCount: 3 } },
          ['id', 'city', 'extra']
        )
      );
      assert.ok(filterBoxes(dom).every((box) => box.value === ''));
      assert.strictEqual(
        filterRequests(postedMessages).slice(before).filter((r) => r.filters.length > 0).length,
        0
      );
    });

    it('keeps focus in the filter box the user was typing in', () => {
      const { dom } = loadWebview();
      sendDuckdbData(dom, payload(threeRows));
      const box = filterBoxes(dom)[0];
      box.focus();
      box.value = '1';
      sendDuckdbData(dom, payload(fiveRows, { reload: { at: '2026-11-19T10:00:00.000Z', previousRowCount: 3 } }));
      assert.strictEqual(dom.window.document.activeElement, filterBoxes(dom)[0]);
      assert.strictEqual(filterBoxes(dom)[0].value, '1');
    });

    it('ignores a reload that still shows the previous table while a pick is pending', () => {
      const { dom } = loadWebview();
      sendDuckdbData(dom, payload(threeRows));
      const app = dom.window.document.getElementById('app')!;
      openPickerPopup(app);
      const option = Array.from(app.querySelectorAll<HTMLElement>('.table-picker-option')).find(
        (o) => o.querySelector('.picker-name')?.textContent === 'b'
      )!;
      option.click();
      sendDuckdbData(dom, payload(fiveRows, { reload: { at: '2026-11-19T10:00:00.000Z', previousRowCount: 3 } }));
      assert.strictEqual(pickerCurrent(app), 'b', 'the pick must not be overwritten');
      assert.strictEqual(app.querySelectorAll('#csv-table tbody tr').length, 3);
    });

    /** Picks `name` in the open picker, like a user would. */
    function pickTable(dom: JSDOM, name: string): void {
      const app = dom.window.document.getElementById('app')!;
      openPickerPopup(app);
      Array.from(app.querySelectorAll<HTMLElement>('.table-picker-option'))
        .find((o) => o.querySelector('.picker-name')?.textContent === name)!
        .click();
    }
    const reloadMeta = { reload: { at: '2026-11-19T10:00:00.000Z' } };
    const rowCount = (dom: JSDOM) => dom.window.document.querySelectorAll('#csv-table tbody tr').length;

    it('follows the host when the shown table disappeared in the reload', () => {
      const { dom } = loadWebview();
      sendDuckdbData(dom, payload(threeRows));
      pickTable(dom, 'b');
      sendDuckdbData(dom, payload(threeRows, { selectedTable: 'b' }));
      // The rebuild dropped 'b': the host falls back to 'a'.
      sendDuckdbData(dom, payload(fiveRows, { ...reloadMeta, tables: [{ name: 'a', type: 'table' }] }));
      const app = dom.window.document.getElementById('app')!;
      assert.strictEqual(pickerCurrent(app), 'a');
      assert.strictEqual(rowCount(dom), 5);
    });

    it('drops a slow reload for the old table that lands after a completed pick', () => {
      const { dom } = loadWebview();
      sendDuckdbData(dom, payload(threeRows));
      pickTable(dom, 'b');
      sendDuckdbData(dom, payload(threeRows, { selectedTable: 'b' }));
      // The reload started on 'a' and only now arrives, though 'b' still exists.
      sendDuckdbData(dom, payload(fiveRows, { ...reloadMeta }));
      const app = dom.window.document.getElementById('app')!;
      assert.strictEqual(pickerCurrent(app), 'b', 'the user stays on the table they picked');
      assert.strictEqual(rowCount(dom), 3);
    });

    it('shows the host fallback when the picked table is gone, and keeps accepting reloads after it', () => {
      const { dom } = loadWebview();
      sendDuckdbData(dom, payload(threeRows));
      pickTable(dom, 'b');
      // 'b' was dropped by a rebuild meanwhile: the host answers with 'a'.
      sendDuckdbData(dom, payload(threeRows, { selectedTable: 'a', tables: [{ name: 'a', type: 'table' }] }));
      const app = dom.window.document.getElementById('app')!;
      assert.strictEqual(pickerCurrent(app), 'a');
      sendDuckdbData(dom, payload(fiveRows, { ...reloadMeta, tables: [{ name: 'a', type: 'table' }] }));
      assert.strictEqual(rowCount(dom), 5, 'later reloads are not stuck behind the dropped pick');
    });

    it('still drops an older select reply that a newer pick superseded', () => {
      const { dom } = loadWebview();
      sendDuckdbData(dom, payload(threeRows));
      pickTable(dom, 'b');
      sendDuckdbData(dom, payload(fiveRows, { selectedTable: 'a' }));
      const app = dom.window.document.getElementById('app')!;
      assert.strictEqual(rowCount(dom), 3, 'a reply for a table other than the pick is dropped');
      assert.strictEqual(pickerCurrent(app), 'b');
    });

    it('keeps keyboard focus on the refresh button across the reload it triggers', () => {
      const { dom } = loadWebview();
      sendDuckdbData(dom, payload(threeRows));
      dom.window.document.querySelector<HTMLButtonElement>('.toolbar-button')!.focus();
      sendDuckdbData(dom, payload(fiveRows, { ...reloadMeta }));
      assert.strictEqual(
        dom.window.document.activeElement,
        dom.window.document.querySelector('.toolbar-button')
      );
    });

    it('does not rewrite an identical status, so the live region is not re-announced', () => {
      const { dom } = loadWebview();
      sendDuckdbData(dom, payload(threeRows));
      sendStatus(dom, { state: 'building' });
      const node = status(dom)!.firstChild;
      assert.ok(node);
      sendStatus(dom, { state: 'building' });
      sendStatus(dom, { state: 'building' });
      assert.strictEqual(status(dom)!.firstChild, node);
    });

    describe('scroll position after a reload with a filter', () => {
      const wrapper = (dom: JSDOM) => dom.window.document.querySelector<HTMLElement>('.scroll-wrapper')!;
      const lastFilterSeq = (posted: unknown[]) =>
        (filterRequests(posted) as unknown as Array<{ seq: number }>).at(-1)!.seq;
      const filterReply = (dom: JSDOM, seq: number, rest: Record<string, unknown>) =>
        dom.window.dispatchEvent(
          new dom.window.MessageEvent('message', { data: { type: 'filter-data', payload: { seq, table: 'a', ...rest } } })
        );
      /** A filtered view scrolled to (120, 30), then a reload that re-applies the filter. */
      function reloadWithFilterScrolled() {
        const loaded = loadWebview();
        sendDuckdbData(loaded.dom, payload(threeRows));
        filterBoxes(loaded.dom)[1].value = 'Rome';
        wrapper(loaded.dom).scrollTop = 120;
        wrapper(loaded.dom).scrollLeft = 30;
        sendDuckdbData(loaded.dom, payload(fiveRows, { ...reloadMeta }));
        return loaded;
      }

      it('is restored when the re-applied filter answers', () => {
        const { dom, postedMessages } = reloadWithFilterScrolled();
        filterReply(dom, lastFilterSeq(postedMessages), { rows: [['1', 'Rome']], matchCount: 1 });
        assert.strictEqual(wrapper(dom).scrollTop, 120);
        assert.strictEqual(wrapper(dom).scrollLeft, 30);
      });

      it('is restored even when the re-applied filter fails', () => {
        const { dom, postedMessages } = reloadWithFilterScrolled();
        filterReply(dom, lastFilterSeq(postedMessages), { failedReason: 'too big' });
        assert.strictEqual(wrapper(dom).scrollTop, 120);
      });

      it('is restored even when the re-applied filter text is invalid', () => {
        const { dom, postedMessages } = reloadWithFilterScrolled();
        filterReply(dom, lastFilterSeq(postedMessages), { errors: [{ column: 1, message: 'bad' }] });
        assert.strictEqual(wrapper(dom).scrollTop, 120);
      });

      it('is not applied to a later filter the user changes', () => {
        const { dom, postedMessages } = reloadWithFilterScrolled();
        // The user edits the filter before the reload's own request is answered.
        filterBoxes(dom)[1].value = 'Paris';
        filterBoxes(dom)[1].dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        filterReply(dom, lastFilterSeq(postedMessages), { rows: [['2', 'Paris']], matchCount: 1 });
        assert.strictEqual(wrapper(dom).scrollTop, 0);
      });
    });
  });

  describe('table picker', () => {
    const tableData = { headers: ['id'], rows: [['1']], rowCount: 1, columnCount: 1 };

    function sendTables(
      dom: JSDOM,
      tables: { name: string; type: 'table' | 'view' }[],
      selectedTable = tables[0].name
    ): HTMLElement {
      sendDuckdbData(dom, { success: true, errors: [], data: { tables, selectedTable, data: tableData } });
      return dom.window.document.getElementById('app')!;
    }

    const mixed: { name: string; type: 'table' | 'view' }[] = [
      { name: 'raw_invoices', type: 'table' },
      { name: 'stg_invoice', type: 'view' },
      { name: 'stg_payment', type: 'view' },
    ];

    it('toggles aria-expanded and the popup when the trigger is clicked', () => {
      const { dom } = loadWebview();
      const app = sendTables(dom, mixed);
      const trigger = pickerTrigger(app)!;
      assert.strictEqual(trigger.getAttribute('aria-expanded'), 'false');
      assert.strictEqual(app.querySelector('.table-picker-popup'), null);

      trigger.click();
      assert.strictEqual(trigger.getAttribute('aria-expanded'), 'true');
      assert.ok(app.querySelector('.table-picker-popup'));

      trigger.click();
      assert.strictEqual(trigger.getAttribute('aria-expanded'), 'false');
      assert.strictEqual(app.querySelector('.table-picker-popup'), null);
    });

    it('groups tables and views with counts only when both kinds exist', () => {
      const { dom } = loadWebview();
      const app = sendTables(dom, mixed);
      openPickerPopup(app);
      assert.deepStrictEqual(
        Array.from(app.querySelectorAll('.table-picker-group')).map((g) => g.textContent),
        ['Tables (1)', 'Views (2)']
      );
      assert.deepStrictEqual(listedNames(app), ['raw_invoices', 'stg_invoice', 'stg_payment']);
    });

    it('lists a source with only tables (e.g. XLSX sheets) flat, without group headers', () => {
      const { dom } = loadWebview();
      const app = sendTables(dom, [
        { name: 'Sheet1', type: 'table' },
        { name: 'Sheet2', type: 'table' },
      ]);
      openPickerPopup(app);
      assert.strictEqual(app.querySelector('.table-picker-group'), null);
      assert.deepStrictEqual(listedNames(app), ['Sheet1', 'Sheet2']);
    });

    it('filters case-insensitively, updates group counts and highlights the match', () => {
      const { dom } = loadWebview();
      const app = sendTables(dom, mixed);
      const popup = openPickerPopup(app);

      typeInPicker(dom, popup, 'STG_');
      assert.deepStrictEqual(listedNames(app), ['stg_invoice', 'stg_payment']);
      assert.deepStrictEqual(
        Array.from(app.querySelectorAll('.table-picker-group')).map((g) => g.textContent),
        ['Views (2)']
      );
      assert.strictEqual(app.querySelector('.table-picker-option mark')?.textContent, 'stg_');

      typeInPicker(dom, popup, 'nothing like this');
      assert.deepStrictEqual(listedNames(app), []);
      assert.match(app.querySelector('.table-picker-empty')?.textContent ?? '', /no matching tables/i);
    });

    it('filters non-ASCII names case-insensitively', () => {
      const { dom } = loadWebview();
      const app = sendTables(dom, [
        { name: 'Überweisung', type: 'table' },
        { name: 'orders', type: 'table' },
      ]);
      const popup = openPickerPopup(app);
      typeInPicker(dom, popup, 'ü');
      assert.deepStrictEqual(listedNames(app), ['Überweisung']);
    });

    it('moves with ArrowDown and picks with Enter, posting select-table', () => {
      const { dom, postedMessages } = loadWebview();
      const app = sendTables(dom, mixed);
      const popup = openPickerPopup(app);
      const search = pickerSearch(popup);

      // Opens on the current table (raw_invoices); one ArrowDown lands on stg_invoice.
      pickerKey(dom, search, 'ArrowDown');
      const activeId = search.getAttribute('aria-activedescendant');
      assert.strictEqual(
        popup.querySelector('.table-picker-option.active')?.id,
        activeId
      );
      pickerKey(dom, search, 'Enter');

      assert.deepStrictEqual(postedMessages[postedMessages.length - 1], {
        type: 'select-table',
        table: 'stg_invoice',
      });
      assert.strictEqual(app.querySelector('.table-picker-popup'), null, 'picking closes the popup');
      assert.strictEqual(pickerCurrent(app), 'stg_invoice');
    });

    it('posts nothing when the already-selected table is picked', () => {
      const { dom, postedMessages } = loadWebview();
      const app = sendTables(dom, mixed);
      const before = postedMessages.length;
      pickTable(app, 'raw_invoices');
      assert.strictEqual(postedMessages.length, before);
      assert.strictEqual(app.querySelector('.table-picker-popup'), null);
    });

    it('closes on Escape without posting, returning focus to the trigger', () => {
      const { dom, postedMessages } = loadWebview();
      const app = sendTables(dom, mixed);
      const before = postedMessages.length;
      const popup = openPickerPopup(app);
      const event = pickerKey(dom, pickerSearch(popup), 'Escape');

      assert.ok(event.defaultPrevented);
      assert.strictEqual(app.querySelector('.table-picker-popup'), null);
      assert.strictEqual(postedMessages.length, before);
      assert.strictEqual(dom.window.document.activeElement, pickerTrigger(app));
    });

    it('closes when the user presses outside the picker', () => {
      const { dom } = loadWebview();
      const app = sendTables(dom, mixed);
      openPickerPopup(app);
      app.querySelector('table')!.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }));
      assert.strictEqual(app.querySelector('.table-picker-popup'), null);
    });

    it('opens with ArrowDown on the trigger', () => {
      const { dom } = loadWebview();
      const app = sendTables(dom, mixed);
      pickerKey(dom, pickerTrigger(app)!, 'ArrowDown');
      assert.ok(app.querySelector('.table-picker-popup'));
    });

    it('exposes each group to assistive tech as a labelled role=group', () => {
      const { dom } = loadWebview();
      const app = sendTables(dom, mixed);
      openPickerPopup(app);
      const groups = Array.from(app.querySelectorAll('[role="group"]'));
      assert.deepStrictEqual(groups.map((g) => g.getAttribute('aria-label')), ['Tables (1)', 'Views (2)']);
      assert.deepStrictEqual(
        groups.map((g) => g.querySelectorAll('[role="option"]').length),
        [1, 2]
      );
    });

    it('ignores Enter while an IME composition is open', () => {
      const { dom, postedMessages } = loadWebview();
      const app = sendTables(dom, mixed);
      const popup = openPickerPopup(app);
      const before = postedMessages.length;
      pickerSearch(popup).dispatchEvent(
        new dom.window.KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })
      );
      assert.strictEqual(postedMessages.length, before);
      assert.ok(app.querySelector('.table-picker-popup'), 'the popup stays open');
    });

    it('closes on Tab and leaves focus on the trigger', () => {
      const { dom } = loadWebview();
      const app = sendTables(dom, mixed);
      const popup = openPickerPopup(app);
      pickerKey(dom, pickerSearch(popup), 'Tab');
      assert.strictEqual(app.querySelector('.table-picker-popup'), null);
      assert.strictEqual(dom.window.document.activeElement, pickerTrigger(app));
    });

    it('moves focus to the new trigger when the reply re-renders while focus is in the picker', () => {
      const { dom } = loadWebview();
      const app = sendTables(dom, mixed);
      pickTable(app, 'stg_invoice');
      assert.strictEqual(dom.window.document.activeElement, pickerTrigger(app));

      // The host's reply replaces the whole picker; focus must follow it.
      const oldTrigger = pickerTrigger(app);
      sendDuckdbData(dom, {
        success: true,
        errors: [],
        data: { tables: mixed, selectedTable: 'stg_invoice', data: tableData },
      });
      assert.notStrictEqual(pickerTrigger(app), oldTrigger, 'the picker was re-rendered');
      assert.strictEqual(dom.window.document.activeElement, pickerTrigger(app));

      // Same when the user has already reopened it and is typing in the search box.
      openPickerPopup(app);
      pickerSearch(app.querySelector('.table-picker-popup') as HTMLElement).focus();
      sendDuckdbData(dom, {
        success: true,
        errors: [],
        data: { tables: mixed, selectedTable: 'stg_invoice', data: tableData },
      });
      assert.strictEqual(app.querySelector('.table-picker-popup'), null);
      assert.strictEqual(dom.window.document.activeElement, pickerTrigger(app));
    });

    it('is not rendered for single-table sources', () => {
      const { dom } = loadWebview();
      sendCsvData(dom, {
        success: true,
        errors: [],
        data: { headers: ['a'], rows: [['1']], rowCount: 1, columnCount: 1 },
      });
      assert.strictEqual(pickerTrigger(dom.window.document.getElementById('app')!), null);
    });

    it('renders hostile names as inert text, including the match highlight', () => {
      const { dom } = loadWebview();
      const payload = '<img src=x onerror=alert(1)>';
      const app = sendTables(dom, [{ name: payload, type: 'view' }]);
      const popup = openPickerPopup(app);
      typeInPicker(dom, popup, 'img');
      assert.strictEqual(app.querySelector('img'), null);
      assert.strictEqual(app.querySelector('.table-picker-option mark')?.textContent, 'img');
      assert.deepStrictEqual(listedNames(app), [payload]);
    });
  });
});

describe('webview main.js statistics', () => {
  afterEach(() => {
    webviewGlobal.window = undefined;
    webviewGlobal.document = undefined;
    webviewGlobal.acquireVsCodeApi = undefined;
  });

  const twoColumnStats: TableStats = {
    columns: [
      {
        type: 'integer',
        nullCount: 0,
        distinctCount: 2,
        min: '1',
        max: '2',
        mean: 1.5,
        histogram: { lo: 1, hi: 2, counts: [1, 2] },
      },
      { type: 'text', nullCount: 1, distinctCount: 1, min: 'a', max: 'a' },
    ],
  };

  /** Rows as the host posts them, plus the stats the host will answer `get-stats` with. */
  interface TableFixture extends ParsedTable {
    stats?: TableStats;
  }

  function table(overrides: Partial<TableFixture> = {}): TableFixture {
    return {
      headers: ['n', 'label'],
      rows: [
        ['1', 'a'],
        ['2', ''],
      ],
      rowCount: 2,
      columnCount: 2,
      stats: twoColumnStats,
      ...overrides,
    };
  }

  /** A table whose columns are exactly `columns`, with `rows` (default 4) data rows. */
  function tableOf(columns: ColumnStats[], headers?: string[], rows = 4): TableFixture {
    return {
      headers: headers ?? columns.map((_, i) => `c${i}`),
      rows: Array.from({ length: rows }, () => columns.map(() => 'x')),
      rowCount: rows,
      columnCount: columns.length,
      stats: { columns },
    };
  }

  /** Splits a fixture into the row message (no stats -- rows never carry them) and the stats the host will serve. */
  function splitFixture(fixture: TableFixture): ParsedTable {
    replyStats = fixture.stats;
    const rows: TableFixture = { ...fixture };
    delete rows.stats;
    return rows;
  }

  function send(dom: JSDOM, data: TableFixture): void {
    sendCsvData(dom, { success: true, errors: [], data: splitFixture(data) });
  }

  function sendMulti(dom: JSDOM, selectedTable: string, data: TableFixture, tables = [selectedTable]): void {
    sendSqliteData(dom, {
      success: true,
      errors: [],
      data: {
        tables: tables.map((name) => ({ name, type: 'table' as const })),
        selectedTable,
        data: splitFixture(data),
      },
    });
  }

  const doc = (dom: JSDOM) => dom.window.document;
  const cardOf = (dom: JSDOM): HTMLElement | null => doc(dom).getElementById('stats-card');
  const tableEl = (dom: JSDOM): HTMLElement | null => doc(dom).getElementById('csv-table');
  const profile = (dom: JSDOM, col: number): HTMLButtonElement | null =>
    doc(dom).querySelector(`#csv-table thead button.col-profile[data-col="${col}"]`);
  const text = (node: Element | null | undefined): string | null | undefined => node?.textContent;

  function press(dom: JSDOM, key: string, target?: EventTarget): void {
    (target ?? doc(dom)).dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true }));
  }

  function pointerDownOutside(dom: JSDOM): void {
    doc(dom).body.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }));
  }

  describe('always-on statistics', () => {
    const getStats = (postedMessages: unknown[]) =>
      postedMessages.filter((m) => (m as { type: string }).type === 'get-stats');

    /** A `get-stats` answer the test delivers by hand, when it wants control over timing. */
    function deliver(dom: JSDOM, payload: unknown): void {
      dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { type: 'stats-data', payload } }));
    }

    const strips = (dom: JSDOM) => doc(dom).querySelectorAll('#csv-table thead button.col-profile');

    it('renders no mode control and no overview panel', () => {
      const { dom } = loadWebview();
      send(dom, table());
      assert.strictEqual(doc(dom).querySelector('.stats-mode'), null);
      assert.strictEqual(doc(dom).querySelector('.stats-mode-btn'), null);
      assert.strictEqual(doc(dom).getElementById('stats-panel'), null);
    });

    it('shows a profile strip in every header without any click, leaving the stats bar text unchanged', () => {
      const { dom } = loadWebview();
      send(dom, table());
      assert.strictEqual(text(doc(dom).querySelector('.stats-bar')), '2 rows × 2 columns');
      assert.strictEqual(strips(dom).length, 2);
    });

    it('requests stats as soon as a table renders, naming no table for CSV/Parquet', () => {
      const { dom, postedMessages } = loadWebview();
      send(dom, table());
      assert.deepStrictEqual(postedMessages, [{ type: 'ready' }, { type: 'get-stats' }]);
    });

    it('names the selected table for a multi-table source', () => {
      const { dom, postedMessages } = loadWebview();
      sendMulti(dom, 'orders', table(), ['customers', 'orders']);
      assert.deepStrictEqual(getStats(postedMessages), [{ type: 'get-stats', table: 'orders' }]);
      assert.strictEqual(strips(dom).length, 2);
    });

    it('asks again for each newly shown table', () => {
      const { dom, postedMessages } = loadWebview();
      sendMulti(dom, 'a', table(), ['a', 'b']);
      sendMulti(dom, 'b', table(), ['a', 'b']);
      assert.deepStrictEqual(getStats(postedMessages), [
        { type: 'get-stats', table: 'a' },
        { type: 'get-stats', table: 'b' },
      ]);
    });

    it('ignores a legacy saved Off mode and never writes webview state', () => {
      const { dom, savedStates } = loadWebview({ statsMode: 'off' });
      send(dom, table());
      assert.strictEqual(strips(dom).length, 2);
      assert.deepStrictEqual(savedStates, []);
    });

    describe('while the answer is pending', () => {
      it('says so and has no strips yet', () => {
        const { dom } = loadWebview(undefined, () => undefined);
        send(dom, table());
        assert.strictEqual(text(doc(dom).querySelector('.stats-status')), 'Computing…');
        assert.strictEqual(doc(dom).querySelector('.col-profile'), null);
        assert.strictEqual(doc(dom).querySelectorAll('#csv-table tbody tr').length, 2, 'the rows never wait for stats');
      });

      it('fills in the strips when the answer arrives, without re-rendering the table', () => {
        const { dom } = loadWebview(undefined, () => undefined);
        send(dom, table());
        const before = tableEl(dom);
        deliver(dom, { stats: twoColumnStats });

        assert.strictEqual(tableEl(dom), before);
        assert.strictEqual(strips(dom).length, 2);
        assert.strictEqual(text(doc(dom).querySelector('.stats-status')), '');
      });
    });

    describe('answers that do not belong', () => {
      it("drops an answer for a table that is no longer shown, and accepts the current table's", () => {
        const { dom } = loadWebview(undefined, () => undefined);
        sendMulti(dom, 'a', table(), ['a', 'b']);
        sendMulti(dom, 'b', table(), ['a', 'b']);

        deliver(dom, { table: 'a', stats: twoColumnStats });
        assert.strictEqual(doc(dom).querySelector('.col-profile'), null, 'the stale answer must be ignored');
        assert.strictEqual(text(doc(dom).querySelector('.stats-status')), 'Computing…');

        deliver(dom, { table: 'b', stats: twoColumnStats });
        assert.strictEqual(doc(dom).querySelectorAll('.col-profile').length, 2);
      });

      it('ignores an answer that arrives before any table is shown', () => {
        const { dom } = loadWebview();
        deliver(dom, { stats: twoColumnStats });
        assert.strictEqual(doc(dom).querySelector('.col-profile'), null);
      });

      it('ignores a duplicate answer once one has been applied', () => {
        const { dom } = loadWebview();
        send(dom, table());
        deliver(dom, { stats: { columns: [] } });
        assert.strictEqual(doc(dom).querySelectorAll('.col-profile').length, 2);
      });

      it('ignores an empty payload', () => {
        const { dom } = loadWebview(undefined, () => undefined);
        send(dom, table());
        deliver(dom, undefined);
        assert.strictEqual(text(doc(dom).querySelector('.stats-status')), 'Computing…');
      });
    });

    describe('when the stats are skipped', () => {
      it("shows the host's reason in the status, with no strips", () => {
        const { dom } = loadWebview();
        send(dom, table({ stats: { columns: [], skippedReason: 'Table is too large.' } }));
        const status = doc(dom).querySelector('.stats-status');
        assert.strictEqual(text(status), 'Table is too large.');
        assert.strictEqual(status?.getAttribute('title'), 'Table is too large.');
        assert.strictEqual(doc(dom).querySelector('.col-profile'), null);
        assert.strictEqual(doc(dom).querySelectorAll('#csv-table tbody tr').length, 2);
      });

      it('clears the reason once a later table has stats', () => {
        const { dom } = loadWebview();
        send(dom, table({ stats: { columns: [], skippedReason: 'Table is too large.' } }));
        send(dom, table());
        const status = doc(dom).querySelector('.stats-status');
        assert.strictEqual(text(status), '');
        assert.strictEqual(status?.hasAttribute('title'), false);
        assert.strictEqual(strips(dom).length, 2);
      });
    });

    describe('when the stats cannot be had', () => {
      it('says so, shows no strips, and keeps the table', () => {
        const { dom } = loadWebview();
        send(dom, table({ stats: undefined })); // the host answers a failure with no stats
        assert.strictEqual(text(doc(dom).querySelector('.stats-status')), 'Statistics unavailable for this table');
        assert.strictEqual(doc(dom).querySelector('.col-profile'), null);
        assert.strictEqual(doc(dom).querySelectorAll('#csv-table tbody tr').length, 2);
      });

      it('treats a column count that does not match the headers as a failure', () => {
        const { dom } = loadWebview();
        send(dom, table({ stats: { columns: [twoColumnStats.columns[0]] } }));
        assert.strictEqual(text(doc(dom).querySelector('.stats-status')), 'Statistics unavailable for this table');
        assert.strictEqual(doc(dom).querySelector('.col-profile'), null);
      });

      it('tries again the next time the table is rendered', () => {
        const { dom, postedMessages } = loadWebview();
        send(dom, table({ stats: undefined }));
        send(dom, table());
        assert.strictEqual(getStats(postedMessages).length, 2);
        assert.strictEqual(text(doc(dom).querySelector('.stats-status')), '');
        assert.strictEqual(strips(dom).length, 2);
      });
    });
  });

  describe('header profile strips', () => {
    it('adds one strip per column to thead, and none to the body', () => {
      const { dom } = loadWebview();
      send(dom, table());
      assert.strictEqual(doc(dom).querySelectorAll('#csv-table thead button.col-profile').length, 2);
      assert.strictEqual(doc(dom).querySelectorAll('#csv-table tbody button').length, 0);
    });

    it('does the same for a large (table-fixed) table', () => {
      const { dom } = loadWebview();
      const rows = Array.from({ length: 501 }, () => ['1', 'a']);
      send(dom, table({ rows, rowCount: 501 }));
      assert.strictEqual(tableEl(dom)?.classList.contains('table-fixed'), true);
      assert.strictEqual(doc(dom).querySelectorAll('#csv-table thead button.col-profile').length, 2);
    });

    it('keeps the column name separate from the strip', () => {
      const { dom } = loadWebview();
      send(dom, table());
      const names = Array.from(doc(dom).querySelectorAll('#csv-table thead .col-name')).map((n) => n.textContent);
      assert.deepStrictEqual(names, ['n', 'label']);
    });

    it('shows a type badge, a null bar and a mini histogram for a numeric column', () => {
      const { dom } = loadWebview();
      send(dom, table());
      const strip = profile(dom, 0)!;
      assert.strictEqual(text(strip.querySelector('.type-badge')), '123');
      assert.strictEqual(strip.querySelector('.nullbar-valid')?.getAttribute('width'), '100');
      assert.strictEqual(strip.querySelector('.null-pct'), null, 'no nulls, no percentage');
      assert.strictEqual(strip.querySelectorAll('svg.hist-mini rect').length, 2);
      assert.strictEqual(strip.querySelector('svg.hist-mini title'), null, 'tooltips live in the card');
    });

    it('sizes the valid part of the null bar and shows the null percentage', () => {
      const { dom } = loadWebview();
      send(dom, table());
      const strip = profile(dom, 1)!; // 1 null in 2 rows
      assert.strictEqual(text(strip.querySelector('.type-badge')), 'Abc');
      assert.strictEqual(strip.querySelector('.nullbar-valid')?.getAttribute('width'), '50');
      assert.strictEqual(text(strip.querySelector('.null-pct')), '50%');
    });

    it('keeps a sliver of the bar for a tiny null share, and none valid for all-null', () => {
      const { dom } = loadWebview();
      send(
        dom,
        tableOf(
          [
            { type: 'integer', nullCount: 1, distinctCount: 3 },
            { type: 'empty', nullCount: 4 },
          ],
          undefined,
          1000
        )
      );
      assert.strictEqual(profile(dom, 0)!.querySelector('.nullbar-valid')?.getAttribute('width'), '99');
      assert.strictEqual(text(profile(dom, 0)!.querySelector('.null-pct')), '0.1%');
      assert.strictEqual(profile(dom, 1)!.querySelector('.nullbar-valid')?.getAttribute('width'), '99');

      const all = loadWebview();
      send(all.dom, tableOf([{ type: 'empty', nullCount: 4 }]));
      assert.strictEqual(profile(all.dom, 0)!.querySelector('.nullbar-valid')?.getAttribute('width'), '0');
      assert.strictEqual(text(profile(all.dom, 0)!.querySelector('.null-pct')), '100%');
    });

    it('shows distinct-ratio treatment for text columns, tagging unique and constant ones', () => {
      const { dom } = loadWebview();
      send(
        dom,
        tableOf([
          { type: 'text', nullCount: 0, distinctCount: 4 }, // all unique
          { type: 'text', nullCount: 0, distinctCount: 1 }, // constant
          { type: 'text', nullCount: 0, distinctCount: 2 }, // neither
          { type: 'text', nullCount: 0, distinctCount: 100000, distinctIsLowerBound: true },
        ])
      );
      const dist = (i: number) => profile(dom, i)!.querySelector('.profile-dist')!;
      assert.strictEqual(text(dist(0).querySelector('.dist-text')), '4 distinct');
      assert.strictEqual(text(dist(0).querySelector('.dist-tag')), 'unique');
      assert.strictEqual(dist(0).querySelector('.distbar-fill')?.getAttribute('width'), '100');
      assert.strictEqual(text(dist(1).querySelector('.dist-tag')), 'constant');
      assert.strictEqual(dist(1).querySelector('.distbar-fill')?.getAttribute('width'), '25');
      assert.strictEqual(dist(2).querySelector('.dist-tag'), null);
      assert.strictEqual(text(dist(3).querySelector('.dist-text')), '≥ 100,000 distinct');
      assert.strictEqual(dist(3).querySelector('.dist-tag'), null, 'a lower bound proves neither');
    });

    it('shows the range for dates, distinct for booleans and mixed, and nothing for other/empty', () => {
      const { dom } = loadWebview();
      send(
        dom,
        tableOf([
          { type: 'date', nullCount: 0, distinctCount: 3, min: '2019-01-01', max: '2021-01-01' },
          { type: 'boolean', nullCount: 0, distinctCount: 2 },
          { type: 'mixed', nullCount: 0, distinctCount: 3 },
          { type: 'other', nullCount: 1 },
          { type: 'empty', nullCount: 4 },
          { type: 'integer', nullCount: 0, distinctCount: 1, min: '4', max: '4', mean: 4 },
        ])
      );
      const dist = (i: number) => profile(dom, i)!.querySelector('.profile-dist')!;
      assert.strictEqual(text(dist(0).querySelector('.range-text')), '2019-01-01 → 2021-01-01');
      assert.strictEqual(text(dist(1)), '2 distinct');
      assert.strictEqual(text(dist(2)), '3 distinct');
      assert.strictEqual(dist(3).textContent, '');
      assert.strictEqual(dist(4).textContent, '');
      assert.strictEqual(text(dist(5)), 'constant');
      assert.deepStrictEqual(
        [0, 1, 2, 3, 4].map((i) => text(profile(dom, i)!.querySelector('.type-badge'))),
        ['date', 'T/F', 'mix', '{ }', '∅']
      );
    });

    it('gives each strip an accessible summary', () => {
      const { dom } = loadWebview();
      send(dom, table());
      assert.strictEqual(
        profile(dom, 1)!.getAttribute('aria-label'),
        'Details for label: text, 1 (50%) nulls, 1 distinct'
      );
      assert.strictEqual(profile(dom, 0)!.getAttribute('aria-label'), 'Details for n: integer, no nulls, 2 distinct');
      assert.strictEqual(profile(dom, 0)!.getAttribute('aria-haspopup'), 'dialog');
      assert.strictEqual(profile(dom, 0)!.getAttribute('aria-expanded'), 'false');
    });
  });

  describe('detail card', () => {
    it('opens on click with the full stats, focus, and ARIA wiring', () => {
      const { dom } = loadWebview();
      send(dom, table());
      profile(dom, 0)!.click();

      const card = cardOf(dom)!;
      assert.ok(card);
      assert.strictEqual(card.getAttribute('role'), 'dialog');
      assert.strictEqual(card.getAttribute('aria-labelledby'), 'stats-card-title');
      assert.strictEqual(text(doc(dom).getElementById('stats-card-title')), 'n');
      assert.strictEqual(doc(dom).activeElement, card);
      assert.strictEqual(profile(dom, 0)!.getAttribute('aria-expanded'), 'true');
      assert.strictEqual(profile(dom, 0)!.getAttribute('aria-controls'), 'stats-card');
      assert.strictEqual(card.parentElement?.id, 'app');

      const rows = Array.from(card.querySelectorAll('dt')).map((dt) => [dt.textContent, text(dt.nextElementSibling)]);
      assert.deepStrictEqual(rows, [
        ['Nulls', '0'],
        ['Distinct', '2 · 100% of non-null'],
        ['Min', '1'],
        ['Max', '2'],
        ['Mean', '1.5'],
      ]);
      assert.strictEqual(text(card.querySelector('.card-sub')), 'integer');
    });

    it('omits stats the column does not have', () => {
      const { dom } = loadWebview();
      send(dom, tableOf([{ type: 'other', nullCount: 1 }]));
      profile(dom, 0)!.click();
      const labels = Array.from(cardOf(dom)!.querySelectorAll('dt')).map((dt) => dt.textContent);
      assert.deepStrictEqual(labels, ['Nulls', 'Distinct']);
      assert.strictEqual(cardOf(dom)!.querySelector('.card-hist'), null);
      assert.strictEqual(text(cardOf(dom)!.querySelectorAll('dd')[1]), '—');
    });

    it('draws a large histogram with axis labels and a hoverable group per bin', () => {
      const { dom } = loadWebview();
      send(dom, table());
      profile(dom, 0)!.click();
      const card = cardOf(dom)!;
      assert.strictEqual(card.querySelectorAll('svg.hist-large g.bin').length, 2);
      assert.strictEqual(card.querySelectorAll('svg.hist-large g.bin rect.bin-hit').length, 2);
      assert.deepStrictEqual(
        Array.from(card.querySelectorAll('.hist-axis span')).map((s) => s.textContent),
        ['1', '2']
      );
      assert.deepStrictEqual(
        Array.from(card.querySelectorAll('svg.hist-large title')).map((t) => t.textContent),
        ['1: 1 value (33.3%)', '2: 2 values (66.7%)']
      );
      assert.strictEqual(
        card.querySelector('svg.hist-large')!.getAttribute('aria-label'),
        'Distribution from 1 to 2. Most values: 2 (2)'
      );
    });

    it('closes on the same trigger, swaps for another, and only ever shows one card', () => {
      const { dom } = loadWebview();
      send(dom, table());
      profile(dom, 0)!.click();
      profile(dom, 1)!.click();
      assert.strictEqual(doc(dom).querySelectorAll('#stats-card').length, 1);
      assert.strictEqual(text(doc(dom).getElementById('stats-card-title')), 'label');
      assert.strictEqual(profile(dom, 0)!.getAttribute('aria-expanded'), 'false');
      assert.strictEqual(profile(dom, 1)!.getAttribute('aria-expanded'), 'true');
      profile(dom, 1)!.click();
      assert.strictEqual(cardOf(dom), null);
      assert.strictEqual(profile(dom, 1)!.getAttribute('aria-expanded'), 'false');
      assert.strictEqual(profile(dom, 1)!.hasAttribute('aria-controls'), false);
    });

    it('closes on Escape and returns focus to the trigger', () => {
      const { dom } = loadWebview();
      send(dom, table());
      profile(dom, 0)!.click();
      press(dom, 'Escape');
      assert.strictEqual(cardOf(dom), null);
      assert.strictEqual(doc(dom).activeElement, profile(dom, 0));
    });

    it('closes from its close button and returns focus', () => {
      const { dom } = loadWebview();
      send(dom, table());
      profile(dom, 1)!.click();
      (cardOf(dom)!.querySelector('.card-close') as HTMLButtonElement).click();
      assert.strictEqual(cardOf(dom), null);
      assert.strictEqual(doc(dom).activeElement, profile(dom, 1));
    });

    it('closes on an outside pointerdown but not on one inside the card', () => {
      const { dom } = loadWebview();
      send(dom, table());
      profile(dom, 0)!.click();
      cardOf(dom)!.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }));
      assert.ok(cardOf(dom), 'a press inside the card must keep it open');
      pointerDownOutside(dom);
      assert.strictEqual(cardOf(dom), null);
    });

    it('closes when Tab leaves it, handing focus back to the trigger', () => {
      const { dom } = loadWebview();
      send(dom, table());
      profile(dom, 0)!.click();
      const close = cardOf(dom)!.querySelector('.card-close') as HTMLButtonElement;
      close.focus();
      press(dom, 'Tab', close);
      assert.strictEqual(cardOf(dom), null);
      assert.strictEqual(doc(dom).activeElement, profile(dom, 0));
    });

    it('keeps the card open on other keys', () => {
      const { dom } = loadWebview();
      send(dom, table());
      profile(dom, 0)!.click();
      press(dom, 'a');
      assert.ok(cardOf(dom));
    });

    it('closes when the table re-renders', () => {
      const { dom } = loadWebview();
      send(dom, table());
      profile(dom, 0)!.click();
      assert.ok(cardOf(dom));
      send(dom, table());
      assert.strictEqual(cardOf(dom), null);
    });

    it('closes when the page is hidden', () => {
      const { dom } = loadWebview();
      send(dom, table());
      profile(dom, 0)!.click();
      Object.defineProperty(doc(dom), 'hidden', { configurable: true, get: () => true });
      doc(dom).dispatchEvent(new dom.window.Event('visibilitychange'));
      assert.strictEqual(cardOf(dom), null);
    });

    it('says the stats cover the whole table when rows were truncated', () => {
      const { dom } = loadWebview();
      send(dom, table({ totalRowCount: 50 }));
      profile(dom, 1)!.click();
      assert.strictEqual(
        text(cardOf(dom)!.querySelector('.card-note')),
        'Statistics cover all 50 rows, not just the 2 shown.'
      );
      // and percentages are relative to the whole table: 1 null in 50 rows
      assert.strictEqual(text(cardOf(dom)!.querySelector('dd')), '1 (2%)');
    });

    describe('positioning', () => {
      function stubLayout(dom: JSDOM, opts: { viewportWidth: number; cardWidth: number; anchor: number }) {
        const window = dom.window;
        Object.defineProperty(doc(dom).documentElement, 'clientWidth', { configurable: true, value: opts.viewportWidth });
        Object.defineProperty(doc(dom).documentElement, 'clientHeight', { configurable: true, value: 600 });
        Object.defineProperty(window.HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => opts.cardWidth });
        const rect = (left: number, width: number) =>
          ({ left, right: left + width, top: 0, bottom: 50, width, height: 50, x: left, y: 0, toJSON: () => ({}) }) as DOMRect;
        const ths = doc(dom).querySelectorAll('#csv-table thead th');
        ths[0].getBoundingClientRect = () => rect(0, 40); // row-number gutter
        ths[1].getBoundingClientRect = () => rect(opts.anchor, 100);
        (doc(dom).querySelector('.scroll-wrapper') as HTMLElement).getBoundingClientRect = () =>
          rect(0, opts.viewportWidth);
        return { ths, rect };
      }

      it('anchors the card under its header', () => {
        const { dom } = loadWebview();
        send(dom, table());
        stubLayout(dom, { viewportWidth: 1000, cardWidth: 300, anchor: 200 });
        profile(dom, 0)!.click();
        assert.strictEqual(cardOf(dom)!.style.left, '200px');
        assert.strictEqual(cardOf(dom)!.style.top, '54px');
        assert.strictEqual(cardOf(dom)!.style.maxHeight, '538px');
      });

      it('clamps the card inside the right edge of the viewport', () => {
        const { dom } = loadWebview();
        send(dom, table());
        stubLayout(dom, { viewportWidth: 1000, cardWidth: 300, anchor: 900 });
        profile(dom, 0)!.click();
        assert.strictEqual(cardOf(dom)!.style.left, '692px');
      });

      it('keeps the card clear of the row-number gutter', () => {
        const { dom } = loadWebview();
        send(dom, table());
        stubLayout(dom, { viewportWidth: 1000, cardWidth: 300, anchor: 10 });
        profile(dom, 0)!.click();
        assert.strictEqual(cardOf(dom)!.style.left, '44px');
      });

      it('follows its header on horizontal scroll', () => {
        const { dom } = loadWebview();
        send(dom, table());
        const { ths, rect } = stubLayout(dom, { viewportWidth: 1000, cardWidth: 300, anchor: 200 });
        profile(dom, 0)!.click();
        ths[1].getBoundingClientRect = () => rect(120, 100);
        doc(dom).dispatchEvent(new dom.window.Event('scroll'));
        assert.strictEqual(cardOf(dom)!.style.left, '120px');
      });

      it('closes when its column scrolls out of view', () => {
        const { dom } = loadWebview();
        send(dom, table());
        const { ths, rect } = stubLayout(dom, { viewportWidth: 1000, cardWidth: 300, anchor: 200 });
        profile(dom, 0)!.click();
        ths[1].getBoundingClientRect = () => rect(-80, 100); // right edge (20) is under the 40px gutter
        doc(dom).dispatchEvent(new dom.window.Event('scroll'));
        assert.strictEqual(cardOf(dom), null);

        profile(dom, 0)!.click();
        assert.ok(cardOf(dom));
        ths[1].getBoundingClientRect = () => rect(1200, 100); // off the right edge of the wrapper
        doc(dom).defaultView!.dispatchEvent(new dom.window.Event('resize'));
        assert.strictEqual(cardOf(dom), null);
      });

      it('ignores scrolling inside the card itself', () => {
        const { dom } = loadWebview();
        send(dom, table());
        const { ths, rect } = stubLayout(dom, { viewportWidth: 1000, cardWidth: 300, anchor: 200 });
        profile(dom, 0)!.click();
        ths[1].getBoundingClientRect = () => rect(-80, 100);
        cardOf(dom)!.dispatchEvent(new dom.window.Event('scroll'));
        assert.ok(cardOf(dom));
      });

      it('does not treat an unmeasurable (all-zero) rect as scrolled out of view', () => {
        const { dom } = loadWebview();
        send(dom, table());
        profile(dom, 0)!.click();
        doc(dom).dispatchEvent(new dom.window.Event('scroll'));
        assert.ok(cardOf(dom));
      });
    });
  });

  describe('histogram bin labels', () => {
    /** Opens the card of a one-column table and returns its bin tooltip labels. */
    function labelsFor(type: 'integer' | 'float', lo: number, hi: number, bins: number): string[] {
      const { dom } = loadWebview();
      send(
        dom,
        tableOf([
          {
            type,
            nullCount: 0,
            distinctCount: bins,
            min: String(lo),
            max: String(hi),
            histogram: { lo, hi, counts: Array.from({ length: bins }, () => 1) },
          },
        ])
      );
      profile(dom, 0)!.click();
      return Array.from(cardOf(dom)!.querySelectorAll('svg.hist-large title')).map(
        (t) => t.textContent!.slice(0, t.textContent!.lastIndexOf(': '))
      );
    }

    const parseInt10 = (s: string) => Number(s.replace(/,/g, ''));

    it('labels a bin that holds exactly one integer with that value', () => {
      assert.deepStrictEqual(labelsFor('integer', 0, 1, 2), ['0', '1']);
      assert.deepStrictEqual(labelsFor('integer', 1, 3, 3), ['1', '2', '3']);
    });

    it('labels wider integer bins as ranges that tile [lo, hi] exactly (mirrors planHistogram)', () => {
      const ranges: Array<[number, number]> = [[1, 3], [0, 1], [1, 100], [0, 14], [-5, 5], [1, 1000000], [10, 60]];
      for (const [lo, hi] of ranges) {
        const plan = planHistogram(lo, hi, true)!;
        const labels = labelsFor('integer', lo, hi, plan.bins);
        assert.strictEqual(labels.length, plan.bins, `${lo}..${hi}`);

        const spans = labels.map((label) => {
          const m = /^(-?[\d,]+)(?:–(-?[\d,]+))?$/.exec(label);
          assert.ok(m, `unparseable label "${label}" for ${lo}..${hi}`);
          const first = parseInt10(m![1]);
          return [first, m![2] !== undefined ? parseInt10(m![2]) : first] as const;
        });
        assert.strictEqual(spans[0][0], lo, `${lo}..${hi} starts at lo`);
        assert.strictEqual(spans[spans.length - 1][1], hi, `${lo}..${hi} ends at hi`);
        for (let i = 1; i < spans.length; i++) {
          assert.strictEqual(spans[i][0], spans[i - 1][1] + 1, `${lo}..${hi} bins ${i - 1}/${i} must be contiguous`);
        }
        // Every integer must land in the bin whose label claims it.
        const step = Math.max(1, Math.floor((hi - lo) / 997));
        for (let x = lo; x <= hi; x += step) {
          const [first, last] = spans[bucketIndex(plan, x)];
          assert.ok(first <= x && x <= last, `${x} is in bin ${bucketIndex(plan, x)} (${first}–${last}) for ${lo}..${hi}`);
        }
        const [first, last] = spans[bucketIndex(plan, hi)];
        assert.ok(first <= hi && hi <= last);
      }
    });

    it('labels float bins as half-open intervals, the last one closed', () => {
      const labels = labelsFor('float', 0, 1, 10);
      assert.strictEqual(labels[0], '[0, 0.1)');
      assert.strictEqual(labels[2], '[0.2, 0.3)');
      assert.strictEqual(labels[9], '[0.9, 1]');
    });

    it('places every float in the bin whose interval contains it', () => {
      const [lo, hi] = [1.5, 10];
      const plan = planHistogram(lo, hi, false)!;
      const labels = labelsFor('float', lo, hi, plan.bins);
      for (let k = 0; k <= 200; k++) {
        const x = lo + ((hi - lo) * k) / 200;
        const m = /^[[(]([\d.,-]+), ([\d.,-]+)[\])]$/.exec(labels[bucketIndex(plan, x)]);
        assert.ok(m);
        assert.ok(parseInt10(m![1]) - 1e-4 <= x && x <= parseInt10(m![2]) + 1e-4, `${x} in ${labels[bucketIndex(plan, x)]}`);
      }
    });
  });

  describe('histograms and distinct counts', () => {
    it('draws one mini-histogram bar per bin in the strip, scaled to the tallest', () => {
      const { dom } = loadWebview();
      send(dom, table());
      const rects = profile(dom, 0)!.querySelectorAll('svg.hist-mini rect');
      assert.strictEqual(rects.length, 2);
      assert.deepStrictEqual(Array.from(rects).map((r) => r.getAttribute('height')), ['11', '22']);
    });

    it('keeps a non-empty but tiny bin at least 1px tall and an empty bin flat', () => {
      const { dom } = loadWebview();
      send(
        dom,
        tableOf([{ type: 'integer', nullCount: 0, distinctCount: 3, histogram: { lo: 0, hi: 2, counts: [1, 0, 1000] } }])
      );
      const heights = Array.from(profile(dom, 0)!.querySelectorAll('svg.hist-mini rect')).map((r) => r.getAttribute('height'));
      assert.deepStrictEqual(heights, ['1', '0', '22']);
    });

    it('titles each bin in the card with its range, count and share', () => {
      const { dom } = loadWebview();
      send(dom, table());
      profile(dom, 0)!.click();
      const titles = Array.from(cardOf(dom)!.querySelectorAll('svg.hist-large title')).map((t) => t.textContent);
      assert.deepStrictEqual(titles, ['1: 1 value (33.3%)', '2: 2 values (66.7%)']);
    });

    it('prefixes a capped distinct count with ≥, in the strip and the card', () => {
      const { dom } = loadWebview();
      send(dom, tableOf([{ type: 'text', nullCount: 0, distinctCount: 100000, distinctIsLowerBound: true }]));
      assert.strictEqual(text(profile(dom, 0)!.querySelector('.dist-text')), '≥ 100,000 distinct');
      profile(dom, 0)!.click();
      const values = Array.from(cardOf(dom)!.querySelectorAll('dd')).map((dd) => dd.textContent);
      assert.ok(values.some((v) => v!.startsWith('≥ 100,000')), `card distinct row in ${JSON.stringify(values)}`);
    });
  });

  describe('untrusted content', () => {
    const evil = '<img src=x onerror=alert(1)>';

    function evilTable(): ParsedTable {
      return tableOf(
        [
          { type: 'text', nullCount: 0, distinctCount: 2, min: '<script>x</script>', max: '<i>y</i>' },
          { type: 'date', nullCount: 0, distinctCount: 2, min: '<b>a</b>', max: '<u>z</u>' },
        ],
        [evil, '<b>bold</b>']
      );
    }

    function assertInert(dom: JSDOM): void {
      const body = doc(dom).body;
      for (const tag of ['img', 'script', 'b', 'i', 'u']) {
        assert.strictEqual(body.querySelector(`#app ${tag}`), null, `no <${tag}> element may be created from file content`);
      }
    }

    it('renders column names and min/max as inert text in the strip and the card', () => {
      const { dom } = loadWebview();
      send(dom, evilTable());

      assert.strictEqual(text(doc(dom).querySelector('#csv-table thead .col-name')), evil);
      assert.ok(profile(dom, 0)!.getAttribute('aria-label')!.includes(evil));
      assert.strictEqual(text(profile(dom, 1)!.querySelector('.range-text')), '<b>a</b> → <u>z</u>');
      assertInert(dom);

      profile(dom, 0)!.click();
      assert.strictEqual(text(doc(dom).getElementById('stats-card-title')), evil);
      const values = Array.from(cardOf(dom)!.querySelectorAll('dd')).map((dd) => dd.textContent);
      assert.ok(values.includes('<script>x</script>'));
      assertInert(dom);
    });
  });

  it('leaves the plain data table alone', () => {
    const { dom } = loadWebview();
    send(dom, table());
    const dataHeaders = Array.from(doc(dom).querySelectorAll('#csv-table thead .col-name')).map((n) => n.textContent);
    assert.deepStrictEqual(dataHeaders, ['n', 'label']);
    assert.strictEqual(doc(dom).querySelectorAll('#csv-table tbody tr').length, 2);
  });
});

describe('webview main.js column filtering', () => {
  afterEach(() => {
    webviewGlobal.window = undefined;
    webviewGlobal.document = undefined;
    webviewGlobal.acquireVsCodeApi = undefined;
  });

  const peopleStats: TableStats = {
    columns: [
      { type: 'text', nullCount: 0, distinctCount: 3, min: 'Alice', max: 'Carol' },
      { type: 'text', nullCount: 0, distinctCount: 3, min: 'Paris', max: 'rome' },
    ],
  };

  function people(overrides: Partial<ParsedTable> = {}): ParsedTable {
    return {
      headers: ['name', 'city'],
      rows: [
        ['Alice', 'Rome'],
        ['Bob', 'Paris'],
        ['Carol', 'rome'],
      ],
      rowCount: 3,
      columnCount: 2,
      ...overrides,
    };
  }

  const doc = (dom: JSDOM) => dom.window.document;
  const inputs = (dom: JSDOM): HTMLInputElement[] =>
    Array.from(doc(dom).querySelectorAll<HTMLInputElement>('#csv-table thead input.col-filter'));
  const bodyRows = (dom: JSDOM): string[][] =>
    Array.from(doc(dom).querySelectorAll('#csv-table tbody tr')).map((tr) =>
      Array.from(tr.querySelectorAll('td:not(.row-num)')).map((td) => td.textContent ?? '')
    );
  const statsBarText = (dom: JSDOM) => doc(dom).querySelector('.stats-bar')?.textContent;
  const filterMessages = (postedMessages: unknown[]) =>
    postedMessages.filter((m) => (m as { type: string }).type === 'filter') as Array<{
      type: 'filter';
      seq: number;
      table?: string;
      filters: Array<{ column: number; text: string }>;
    }>;

  /** Loads the webview with the debounce timer under the test's control. */
  function load() {
    const loaded = loadWebview();
    const timers = new Map<number, () => void>();
    let nextId = 1;
    const win = loaded.dom.window as unknown as {
      setTimeout: (fn: () => void) => number;
      clearTimeout: (id: number) => void;
    };
    win.setTimeout = (fn) => {
      timers.set(nextId, fn);
      return nextId++;
    };
    win.clearTimeout = (id) => {
      timers.delete(id);
    };
    const runTimers = () => {
      const pending = Array.from(timers.values());
      timers.clear();
      pending.forEach((fn) => fn());
    };
    return { ...loaded, pendingTimers: () => timers.size, runTimers };
  }

  function show(dom: JSDOM, data: ParsedTable = people()): void {
    replyStats = peopleStats;
    sendCsvData(dom, { success: true, errors: [], data });
  }

  function showMulti(dom: JSDOM, selectedTable: string, data: ParsedTable = people()): void {
    replyStats = peopleStats;
    sendSqliteData(dom, {
      success: true,
      errors: [],
      data: {
        tables: ['a', 'b'].map((name) => ({ name, type: 'table' as const })),
        selectedTable,
        data,
      },
    });
  }

  function reply(dom: JSDOM, payload: unknown): void {
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { type: 'filter-data', payload } }));
  }

  function typeInto(dom: JSDOM, column: number, value: string): HTMLInputElement {
    const input = inputs(dom)[column];
    input.value = value;
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    return input;
  }

  function press(dom: JSDOM, target: EventTarget, key: string): KeyboardEvent {
    const event = new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event;
  }

  /** Types into a box and presses Enter, so the request goes out immediately. */
  function filterNow(dom: JSDOM, column: number, value: string): void {
    press(dom, typeInto(dom, column, value), 'Enter');
  }

  const lastSeq = (postedMessages: unknown[]) => filterMessages(postedMessages).at(-1)!.seq;

  describe('the filter row', () => {
    it('adds a second header row with one labelled box per column, after the header row', () => {
      const { dom } = load();
      show(dom);
      const rows = doc(dom).querySelectorAll('#csv-table thead tr');
      assert.strictEqual(rows.length, 2);
      assert.ok(rows[1].classList.contains('filter-row'));
      assert.deepStrictEqual(inputs(dom).map((i) => i.getAttribute('aria-label')), ['Filter name', 'Filter city']);
      assert.ok(inputs(dom).every((i) => i.type === 'search' && i.placeholder === 'Filter…'));
      assert.ok(inputs(dom).every((i) => i.title.includes('Esc clears')));
    });

    it('keeps the boxes in the same column order as the header cells', () => {
      const { dom } = load();
      show(dom);
      const headerCells = doc(dom).querySelectorAll('#csv-table thead tr:first-child th');
      const filterCells = doc(dom).querySelectorAll('#csv-table thead tr.filter-row th');
      assert.strictEqual(headerCells.length, filterCells.length);
      inputs(dom).forEach((input, i) => assert.strictEqual(input.parentElement, filterCells[i + 1]));
    });

    it('starts with the clear-all button hidden and nothing sent', () => {
      const { dom, postedMessages } = load();
      show(dom);
      const clear = doc(dom).querySelector<HTMLButtonElement>('.filter-clear')!;
      assert.strictEqual(clear.hidden, true);
      assert.strictEqual(clear.getAttribute('aria-label'), 'Clear all filters');
      assert.deepStrictEqual(filterMessages(postedMessages), []);
    });

    it('makes the stats bar a polite live region, with its text unchanged', () => {
      const { dom } = load();
      show(dom);
      const bar = doc(dom).querySelector('.stats-bar')!;
      assert.strictEqual(bar.getAttribute('aria-live'), 'polite');
      assert.strictEqual(bar.textContent, '3 rows × 2 columns');
    });

    it('limits the length of a box to what the host accepts', () => {
      const { dom } = load();
      show(dom);
      assert.ok(inputs(dom).every((i) => i.getAttribute('maxlength') === '1000'));
    });
  });

  describe('sending a filter', () => {
    it('sends the boxes on Enter, omitting blank ones, with no table for CSV/Parquet', () => {
      const { dom, postedMessages } = load();
      show(dom);
      typeInto(dom, 1, 'rome');
      press(dom, inputs(dom)[0], 'Enter');
      const sent = filterMessages(postedMessages);
      assert.strictEqual(sent.length, 1);
      assert.deepStrictEqual(sent[0].filters, [{ column: 1, text: 'rome' }]);
      assert.ok(!('table' in sent[0]));
      assert.ok(Number.isInteger(sent[0].seq));
    });

    it('names the selected table for a multi-table source', () => {
      const { dom, postedMessages } = load();
      showMulti(dom, 'b');
      filterNow(dom, 0, 'a');
      assert.strictEqual(filterMessages(postedMessages)[0].table, 'b');
    });

    it('waits for a pause in typing, then sends once', () => {
      const { dom, postedMessages, runTimers, pendingTimers } = load();
      show(dom);
      typeInto(dom, 0, 'a');
      typeInto(dom, 0, 'al');
      typeInto(dom, 0, 'ali');
      assert.deepStrictEqual(filterMessages(postedMessages), [], 'nothing goes out while typing');
      assert.strictEqual(pendingTimers(), 1, 'each keystroke restarts one timer');
      runTimers();
      const sent = filterMessages(postedMessages);
      assert.strictEqual(sent.length, 1);
      assert.deepStrictEqual(sent[0].filters, [{ column: 0, text: 'ali' }]);
    });

    it('sends immediately on Enter and cancels the pending timer', () => {
      const { dom, postedMessages, pendingTimers } = load();
      show(dom);
      filterNow(dom, 0, 'ali');
      assert.strictEqual(filterMessages(postedMessages).length, 1);
      assert.strictEqual(pendingTimers(), 0);
    });

    it('gives every request a higher seq than the one before', () => {
      const { dom, postedMessages } = load();
      show(dom);
      filterNow(dom, 0, 'a');
      filterNow(dom, 0, 'al');
      const [first, second] = filterMessages(postedMessages);
      assert.ok(second.seq > first.seq);
    });

    it('shows the clear-all button while any box has text', () => {
      const { dom } = load();
      show(dom);
      const clear = doc(dom).querySelector<HTMLButtonElement>('.filter-clear')!;
      typeInto(dom, 1, 'x');
      assert.strictEqual(clear.hidden, false);
      typeInto(dom, 1, '');
      assert.strictEqual(clear.hidden, true);
    });
  });

  describe('applying a reply', () => {
    it('swaps in the matching rows and reports the count', () => {
      const { dom, postedMessages } = load();
      show(dom);
      filterNow(dom, 1, 'rome');
      reply(dom, { seq: lastSeq(postedMessages), rows: [['Alice', 'Rome'], ['Carol', 'rome']], matchCount: 2 });
      assert.deepStrictEqual(bodyRows(dom), [['Alice', 'Rome'], ['Carol', 'rome']]);
      assert.strictEqual(statsBarText(dom), '2 of 3 rows match');
      // gutter numbers restart at 1 for the rows shown
      const gutter = Array.from(doc(dom).querySelectorAll('#csv-table tbody td.row-num')).map((td) => td.textContent);
      assert.deepStrictEqual(gutter, ['1', '2']);
    });

    it('uses the true total when the file was truncated by tablas.maxRows', () => {
      const { dom, postedMessages } = load();
      show(dom, people({ totalRowCount: 50000 }));
      filterNow(dom, 0, 'a');
      reply(dom, { seq: lastSeq(postedMessages), rows: [['Alice', 'Rome']], matchCount: 1 });
      assert.strictEqual(statsBarText(dom), '1 of 50,000 rows match');
    });

    it('says when there are more matches than rows shown', () => {
      const { dom, postedMessages } = load();
      show(dom);
      filterNow(dom, 0, 'a');
      reply(dom, { seq: lastSeq(postedMessages), rows: [['Alice', 'Rome']], matchCount: 1234 });
      assert.ok(statsBarText(dom)!.startsWith('1,234 of 3 rows match (showing first 1'));
      assert.ok(statsBarText(dom)!.includes('tablas.maxRows'));
    });

    it('shows no rows, not the old ones, when nothing matches', () => {
      const { dom, postedMessages } = load();
      show(dom);
      filterNow(dom, 0, 'zzz');
      reply(dom, { seq: lastSeq(postedMessages), rows: [], matchCount: 0 });
      assert.deepStrictEqual(bodyRows(dom), []);
      assert.strictEqual(statsBarText(dom), '0 of 3 rows match');
    });

    it('re-renders only the body: header, strips and the focused box are the same elements', () => {
      const { dom, postedMessages } = load();
      show(dom);
      const thead = doc(dom).querySelector('#csv-table thead')!;
      const headerCells = Array.from(thead.querySelectorAll('th'));
      const strips = Array.from(thead.querySelectorAll('button.col-profile'));
      assert.strictEqual(strips.length, 2, 'stats arrived');
      const input = typeInto(dom, 1, 'rome');
      input.focus();
      press(dom, input, 'Enter');
      reply(dom, { seq: lastSeq(postedMessages), rows: [['Alice', 'Rome']], matchCount: 1 });
      assert.strictEqual(doc(dom).querySelector('#csv-table thead'), thead);
      assert.deepStrictEqual(Array.from(thead.querySelectorAll('th')), headerCells);
      assert.deepStrictEqual(Array.from(thead.querySelectorAll('button.col-profile')), strips);
      assert.strictEqual(inputs(dom)[1], input);
      assert.strictEqual(doc(dom).activeElement, input);
      assert.strictEqual(input.value, 'rome');
    });

    it('keeps the table layout chosen for the full table', () => {
      const { dom, postedMessages } = load();
      const rows = Array.from({ length: 600 }, (_, i) => [`n${i}`, `c${i}`]);
      show(dom, { headers: ['name', 'city'], rows, rowCount: 600, columnCount: 2 });
      const table = doc(dom).getElementById('csv-table')!;
      assert.ok(table.classList.contains('table-fixed'));
      filterNow(dom, 0, 'n1');
      reply(dom, { seq: lastSeq(postedMessages), rows: [['n1', 'c1']], matchCount: 1 });
      assert.ok(table.classList.contains('table-fixed'), 'a short result must not flip the layout');
    });

    it('renders untrusted cell text as inert text', () => {
      const { dom, postedMessages } = load();
      show(dom);
      const evil = '<img src=x onerror=alert(1)><script>x</script>';
      filterNow(dom, 0, 'a');
      reply(dom, { seq: lastSeq(postedMessages), rows: [[evil, '<b>y</b>']], matchCount: 1 });
      assert.deepStrictEqual(bodyRows(dom), [[evil, '<b>y</b>']]);
      for (const tag of ['img', 'script', 'b']) {
        assert.strictEqual(doc(dom).querySelector(`#app ${tag}`), null, `no <${tag}> may be created from a cell`);
      }
    });
  });

  describe('replies that do not belong', () => {
    it('drops a reply overtaken by a newer request', () => {
      const { dom, postedMessages } = load();
      show(dom);
      filterNow(dom, 0, 'a');
      const stale = lastSeq(postedMessages);
      filterNow(dom, 0, 'al');
      reply(dom, { seq: stale, rows: [['STALE', 'x']], matchCount: 1 });
      assert.deepStrictEqual(bodyRows(dom).map((r) => r[0]), ['Alice', 'Bob', 'Carol'], 'rows unchanged');
      reply(dom, { seq: lastSeq(postedMessages), rows: [['Alice', 'Rome']], matchCount: 1 });
      assert.deepStrictEqual(bodyRows(dom), [['Alice', 'Rome']]);
    });

    it('drops a reply for another table', () => {
      const { dom, postedMessages } = load();
      showMulti(dom, 'a');
      filterNow(dom, 0, 'a');
      reply(dom, { seq: lastSeq(postedMessages), table: 'b', rows: [['WRONG', 'x']], matchCount: 1 });
      assert.deepStrictEqual(bodyRows(dom).map((r) => r[0]), ['Alice', 'Bob', 'Carol']);
      reply(dom, { seq: lastSeq(postedMessages), table: 'a', rows: [['Alice', 'Rome']], matchCount: 1 });
      assert.deepStrictEqual(bodyRows(dom), [['Alice', 'Rome']]);
    });

    it('drops a reply that arrives after the box was cleared', () => {
      const { dom, postedMessages } = load();
      show(dom);
      filterNow(dom, 0, 'a');
      const stale = lastSeq(postedMessages);
      filterNow(dom, 0, '');
      reply(dom, { seq: stale, rows: [['STALE', 'x']], matchCount: 1 });
      assert.deepStrictEqual(bodyRows(dom).map((r) => r[0]), ['Alice', 'Bob', 'Carol']);
      assert.strictEqual(statsBarText(dom), '3 rows × 2 columns');
    });

    it('ignores a reply when nothing was asked, and an empty or malformed payload', () => {
      const { dom, postedMessages } = load();
      show(dom);
      reply(dom, { seq: 1, rows: [['X', 'x']], matchCount: 1 });
      reply(dom, undefined);
      assert.deepStrictEqual(bodyRows(dom).map((r) => r[0]), ['Alice', 'Bob', 'Carol']);
      filterNow(dom, 0, 'a');
      reply(dom, undefined);
      reply(dom, { rows: [['X', 'x']], matchCount: 1 });
      assert.deepStrictEqual(bodyRows(dom).map((r) => r[0]), ['Alice', 'Bob', 'Carol']);
      reply(dom, { seq: lastSeq(postedMessages), rows: [['Alice', 'Rome']], matchCount: 1 });
      assert.deepStrictEqual(bodyRows(dom), [['Alice', 'Rome']]);
    });

    it('ignores a second reply to the same request', () => {
      const { dom, postedMessages } = load();
      show(dom);
      filterNow(dom, 0, 'a');
      const seq = lastSeq(postedMessages);
      reply(dom, { seq, rows: [['Alice', 'Rome']], matchCount: 1 });
      reply(dom, { seq, rows: [['DUP', 'x']], matchCount: 1 });
      assert.deepStrictEqual(bodyRows(dom), [['Alice', 'Rome']]);
    });
  });

  describe('invalid filter text', () => {
    it('marks the offending boxes, explains why, and leaves the rows alone', () => {
      const { dom, postedMessages } = load();
      show(dom);
      filterNow(dom, 1, '>');
      reply(dom, { seq: lastSeq(postedMessages), errors: [{ column: 1, message: '">" needs a value after it.' }] });
      assert.strictEqual(inputs(dom)[1].getAttribute('aria-invalid'), 'true');
      assert.strictEqual(inputs(dom)[1].title, '">" needs a value after it.');
      assert.strictEqual(inputs(dom)[0].hasAttribute('aria-invalid'), false);
      assert.deepStrictEqual(bodyRows(dom).map((r) => r[0]), ['Alice', 'Bob', 'Carol']);
    });

    it('clears the mark on the next request and restores the help text', () => {
      const { dom, postedMessages } = load();
      show(dom);
      filterNow(dom, 1, '>');
      reply(dom, { seq: lastSeq(postedMessages), errors: [{ column: 1, message: 'bad' }] });
      filterNow(dom, 1, '>1');
      assert.strictEqual(inputs(dom)[1].hasAttribute('aria-invalid'), false);
      assert.ok(inputs(dom)[1].title.includes('Esc clears'));
    });

    it('keeps the previous matches on screen while a typo is pending', () => {
      const { dom, postedMessages } = load();
      show(dom);
      filterNow(dom, 1, 'rome');
      reply(dom, { seq: lastSeq(postedMessages), rows: [['Alice', 'Rome']], matchCount: 1 });
      filterNow(dom, 1, '>');
      reply(dom, { seq: lastSeq(postedMessages), errors: [{ column: 1, message: 'bad' }] });
      assert.deepStrictEqual(bodyRows(dom), [['Alice', 'Rome']]);
    });
  });

  describe('when the host cannot filter', () => {
    it('puts the original rows back and says why', () => {
      const { dom, postedMessages } = load();
      show(dom);
      filterNow(dom, 0, 'a');
      reply(dom, { seq: lastSeq(postedMessages), rows: [['Alice', 'Rome']], matchCount: 1 });
      filterNow(dom, 0, 'al');
      reply(dom, { seq: lastSeq(postedMessages), failedReason: 'Filtering timed out.' });
      assert.deepStrictEqual(bodyRows(dom).map((r) => r[0]), ['Alice', 'Bob', 'Carol']);
      assert.ok(statsBarText(dom)!.startsWith('3 rows × 2 columns'));
      assert.ok(statsBarText(dom)!.includes('Filtering timed out.'));
    });

    it('treats a reply with neither rows nor a reason as a failure', () => {
      const { dom, postedMessages } = load();
      show(dom);
      filterNow(dom, 0, 'a');
      reply(dom, { seq: lastSeq(postedMessages) });
      assert.ok(statsBarText(dom)!.includes('filter unavailable'));
      assert.deepStrictEqual(bodyRows(dom).map((r) => r[0]), ['Alice', 'Bob', 'Carol']);
    });

    it('tries again on the next request', () => {
      const { dom, postedMessages } = load();
      show(dom);
      filterNow(dom, 0, 'a');
      reply(dom, { seq: lastSeq(postedMessages), failedReason: 'nope' });
      filterNow(dom, 0, 'al');
      reply(dom, { seq: lastSeq(postedMessages), rows: [['Alice', 'Rome']], matchCount: 1 });
      assert.deepStrictEqual(bodyRows(dom), [['Alice', 'Rome']]);
      assert.strictEqual(statsBarText(dom), '1 of 3 rows match');
    });
  });

  describe('clearing', () => {
    it('restores the original rows locally, and tells the host only to release its cache', () => {
      const { dom, postedMessages } = load();
      show(dom);
      filterNow(dom, 0, 'a');
      reply(dom, { seq: lastSeq(postedMessages), rows: [['Alice', 'Rome']], matchCount: 1 });
      const before = filterMessages(postedMessages).length;
      filterNow(dom, 0, '');
      assert.deepStrictEqual(bodyRows(dom).map((r) => r[0]), ['Alice', 'Bob', 'Carol']);
      assert.strictEqual(statsBarText(dom), '3 rows × 2 columns');
      const sent = filterMessages(postedMessages);
      assert.strictEqual(sent.length, before + 1);
      assert.deepStrictEqual(sent.at(-1)!.filters, []);
    });

    it('treats a box of only spaces as blank', () => {
      const { dom, postedMessages } = load();
      show(dom);
      filterNow(dom, 0, 'a');
      reply(dom, { seq: lastSeq(postedMessages), rows: [['Alice', 'Rome']], matchCount: 1 });
      filterNow(dom, 0, '   ');
      assert.deepStrictEqual(bodyRows(dom).map((r) => r[0]), ['Alice', 'Bob', 'Carol']);
      assert.deepStrictEqual(filterMessages(postedMessages).at(-1)!.filters, []);
    });

    it('sends nothing when there was nothing to clear', () => {
      const { dom, postedMessages } = load();
      show(dom);
      filterNow(dom, 0, '');
      typeInto(dom, 1, '   ');
      press(dom, inputs(dom)[1], 'Enter');
      assert.deepStrictEqual(filterMessages(postedMessages), []);
    });

    it('also clears while a request is still in flight', () => {
      const { dom, postedMessages } = load();
      show(dom);
      filterNow(dom, 0, 'a');
      const inFlight = lastSeq(postedMessages);
      filterNow(dom, 0, '');
      reply(dom, { seq: inFlight, rows: [['Alice', 'Rome']], matchCount: 1 });
      assert.deepStrictEqual(bodyRows(dom).map((r) => r[0]), ['Alice', 'Bob', 'Carol']);
      assert.deepStrictEqual(filterMessages(postedMessages).at(-1)!.filters, []);
    });

    it('clears every box from the clear-all button and puts focus in the first one', () => {
      const { dom, postedMessages } = load();
      show(dom);
      typeInto(dom, 0, 'a');
      filterNow(dom, 1, 'rome');
      reply(dom, { seq: lastSeq(postedMessages), rows: [['Alice', 'Rome']], matchCount: 1 });
      const clear = doc(dom).querySelector<HTMLButtonElement>('.filter-clear')!;
      clear.click();
      assert.deepStrictEqual(inputs(dom).map((i) => i.value), ['', '']);
      assert.strictEqual(clear.hidden, true);
      assert.deepStrictEqual(bodyRows(dom).map((r) => r[0]), ['Alice', 'Bob', 'Carol']);
      assert.deepStrictEqual(filterMessages(postedMessages).at(-1)!.filters, []);
      assert.strictEqual(doc(dom).activeElement, inputs(dom)[0]);
    });

    it('clears a box with Escape, immediately, and consumes the key', () => {
      const { dom, postedMessages } = load();
      show(dom);
      const input = typeInto(dom, 0, 'ali');
      press(dom, input, 'Enter');
      reply(dom, { seq: lastSeq(postedMessages), rows: [['Alice', 'Rome']], matchCount: 1 });
      const event = press(dom, input, 'Escape');
      assert.strictEqual(input.value, '');
      assert.strictEqual(event.defaultPrevented, true);
      assert.deepStrictEqual(bodyRows(dom).map((r) => r[0]), ['Alice', 'Bob', 'Carol']);
      assert.deepStrictEqual(filterMessages(postedMessages).at(-1)!.filters, []);
    });

    it('leaves Escape alone in an empty box', () => {
      const { dom, postedMessages } = load();
      show(dom);
      const event = press(dom, inputs(dom)[0], 'Escape');
      assert.strictEqual(event.defaultPrevented, false);
      assert.deepStrictEqual(filterMessages(postedMessages), []);
    });
  });

  describe('Alt+click on a cell', () => {
    const cellAt = (dom: JSDOM, row: number, column: number) =>
      doc(dom).querySelectorAll('#csv-table tbody tr')[row].querySelectorAll('td')[column + 1] as HTMLElement;

    function click(dom: JSDOM, target: Element, altKey: boolean): MouseEvent {
      const event = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, altKey });
      target.dispatchEvent(event);
      return event;
    }

    it('filters that column to exactly the cell value, at once', () => {
      const { dom, postedMessages } = load();
      show(dom);
      const event = click(dom, cellAt(dom, 1, 1), true);
      assert.strictEqual(inputs(dom)[1].value, '=Paris');
      assert.strictEqual(event.defaultPrevented, true);
      const sent = filterMessages(postedMessages);
      assert.strictEqual(sent.length, 1);
      assert.deepStrictEqual(sent[0].filters, [{ column: 1, text: '=Paris' }]);
    });

    it('turns an empty cell into the "is empty" filter', () => {
      const { dom, postedMessages } = load();
      show(dom, people({ rows: [['Alice', ''], ['Bob', 'Paris']] , rowCount: 2 }));
      click(dom, cellAt(dom, 0, 1), true);
      assert.deepStrictEqual(filterMessages(postedMessages).at(-1)!.filters, [{ column: 1, text: '=' }]);
    });

    it('adds to the filters already set on other columns', () => {
      const { dom, postedMessages } = load();
      show(dom);
      typeInto(dom, 0, 'a');
      click(dom, cellAt(dom, 1, 1), true);
      assert.deepStrictEqual(filterMessages(postedMessages).at(-1)!.filters, [
        { column: 0, text: 'a' },
        { column: 1, text: '=Paris' },
      ]);
    });

    it('does nothing without Alt', () => {
      const { dom, postedMessages } = load();
      show(dom);
      const event = click(dom, cellAt(dom, 1, 1), false);
      assert.strictEqual(event.defaultPrevented, false);
      assert.strictEqual(inputs(dom)[1].value, '');
      assert.deepStrictEqual(filterMessages(postedMessages), []);
    });

    it('ignores the row-number gutter', () => {
      const { dom, postedMessages } = load();
      show(dom);
      click(dom, doc(dom).querySelector('#csv-table tbody td.row-num')!, true);
      assert.deepStrictEqual(filterMessages(postedMessages), []);
    });

    it('ignores a cell that a one-line box cannot hold', () => {
      const { dom, postedMessages } = load();
      show(dom, people({ rows: [['two\nlines', 'x'], [`${'z'.repeat(1000)}`, 'y']], rowCount: 2 }));
      click(dom, cellAt(dom, 0, 0), true);
      click(dom, cellAt(dom, 1, 0), true);
      assert.strictEqual(inputs(dom)[0].value, '');
      assert.deepStrictEqual(filterMessages(postedMessages), []);
    });

    it('ignores a cell with trailing spaces, which the host would trim into a filter that matches nothing', () => {
      const { dom, postedMessages } = load();
      show(dom, people({ rows: [['abc ', 'x'], ['  lead', 'y']], rowCount: 2 }));
      click(dom, cellAt(dom, 0, 0), true);
      assert.strictEqual(inputs(dom)[0].value, '');
      assert.deepStrictEqual(filterMessages(postedMessages), []);
      // leading spaces survive the trim, so those cells still work
      click(dom, cellAt(dom, 1, 0), true);
      assert.deepStrictEqual(filterMessages(postedMessages).at(-1)!.filters, [{ column: 0, text: '=  lead' }]);
    });

    it('still turns a whitespace-only cell into the "is empty" filter', () => {
      const { dom, postedMessages } = load();
      show(dom, people({ rows: [['   ', 'x']], rowCount: 1 }));
      click(dom, cellAt(dom, 0, 0), true);
      // Sent as typed; the host trims "=   " to "=", which means "is empty".
      assert.deepStrictEqual(filterMessages(postedMessages).at(-1)!.filters, [{ column: 0, text: '=   ' }]);
    });

    it('works on the rows a filter returned', () => {
      const { dom, postedMessages } = load();
      show(dom);
      filterNow(dom, 1, 'rome');
      reply(dom, { seq: lastSeq(postedMessages), rows: [['Alice', 'Rome'], ['Carol', 'rome']], matchCount: 2 });
      click(dom, cellAt(dom, 1, 0), true);
      assert.deepStrictEqual(filterMessages(postedMessages).at(-1)!.filters, [
        { column: 0, text: '=Carol' },
        { column: 1, text: 'rome' },
      ]);
    });
  });

  describe('switching tables', () => {
    it('starts the new table with empty boxes', () => {
      const { dom, postedMessages } = load();
      showMulti(dom, 'a');
      filterNow(dom, 0, 'a');
      reply(dom, { seq: lastSeq(postedMessages), table: 'a', rows: [['Alice', 'Rome']], matchCount: 1 });
      showMulti(dom, 'b');
      assert.deepStrictEqual(inputs(dom).map((i) => i.value), ['', '']);
      assert.strictEqual(doc(dom).querySelector<HTMLButtonElement>('.filter-clear')!.hidden, true);
      assert.strictEqual(statsBarText(dom), '3 rows × 2 columns');
      assert.strictEqual(bodyRows(dom).length, 3);
    });

    it('tells the host to drop the old table\'s filters, naming that table', () => {
      const { dom, postedMessages } = load();
      showMulti(dom, 'a');
      filterNow(dom, 0, 'a');
      showMulti(dom, 'b');
      const released = filterMessages(postedMessages).at(-1)!;
      assert.strictEqual(released.table, 'a');
      assert.deepStrictEqual(released.filters, []);
    });

    it('sends nothing extra when the old table had no filters', () => {
      const { dom, postedMessages } = load();
      showMulti(dom, 'a');
      showMulti(dom, 'b');
      assert.deepStrictEqual(filterMessages(postedMessages), []);
    });

    it('drops the old table\'s late reply', () => {
      const { dom, postedMessages } = load();
      showMulti(dom, 'a');
      filterNow(dom, 0, 'a');
      const stale = lastSeq(postedMessages);
      showMulti(dom, 'b');
      reply(dom, { seq: stale, table: 'a', rows: [['STALE', 'x']], matchCount: 1 });
      assert.deepStrictEqual(bodyRows(dom).map((r) => r[0]), ['Alice', 'Bob', 'Carol']);
    });

    it('cancels a debounce still waiting when the table is replaced', () => {
      const { dom, postedMessages, runTimers } = load();
      showMulti(dom, 'a');
      typeInto(dom, 0, 'a');
      showMulti(dom, 'b');
      runTimers();
      assert.deepStrictEqual(filterMessages(postedMessages).filter((m) => m.filters.length > 0), []);
    });

    it('keeps the other tables\' filters independent: boxes belong to the table they were typed in', () => {
      const { dom, postedMessages } = load();
      showMulti(dom, 'a');
      filterNow(dom, 0, 'a');
      showMulti(dom, 'b');
      filterNow(dom, 1, 'rome');
      const last = filterMessages(postedMessages).at(-1)!;
      assert.strictEqual(last.table, 'b');
      assert.deepStrictEqual(last.filters, [{ column: 1, text: 'rome' }]);
    });
  });

  describe('with a statistics card open', () => {
    const strip = (dom: JSDOM, col: number) =>
      doc(dom).querySelector<HTMLButtonElement>(`#csv-table thead button.col-profile[data-col="${col}"]`)!;
    const card = (dom: JSDOM) => doc(dom).getElementById('stats-card');

    it('stays open while a filter is applied', () => {
      const { dom, postedMessages } = load();
      show(dom);
      strip(dom, 0).click();
      assert.ok(card(dom));
      filterNow(dom, 1, 'rome');
      reply(dom, { seq: lastSeq(postedMessages), rows: [['Alice', 'Rome']], matchCount: 1 });
      assert.ok(card(dom), 'filtering must not close the card');
    });

    it('says the statistics ignore the filter, only while one is set', () => {
      const { dom, postedMessages } = load();
      show(dom);
      strip(dom, 0).click();
      assert.ok(!card(dom)!.textContent!.includes('ignore'));
      press(dom, doc(dom), 'Escape');
      filterNow(dom, 1, 'rome');
      reply(dom, { seq: lastSeq(postedMessages), rows: [['Alice', 'Rome']], matchCount: 1 });
      strip(dom, 0).click();
      assert.ok(card(dom)!.querySelector('.card-note')!.textContent!.includes('Statistics ignore the active filter.'));
    });

    it('combines that with the truncation note', () => {
      const { dom, postedMessages } = load();
      show(dom, people({ totalRowCount: 9000 }));
      filterNow(dom, 1, 'rome');
      reply(dom, { seq: lastSeq(postedMessages), rows: [['Alice', 'Rome']], matchCount: 1 });
      strip(dom, 0).click();
      const note = card(dom)!.querySelector('.card-note')!.textContent!;
      assert.ok(note.includes('9,000 rows') && note.includes('ignore the active filter'));
    });

    it('keeps Escape in a box for the box: it clears the text and leaves the card open', () => {
      const { dom, postedMessages } = load();
      show(dom);
      const input = typeInto(dom, 1, 'rome');
      press(dom, input, 'Enter');
      reply(dom, { seq: lastSeq(postedMessages), rows: [['Alice', 'Rome']], matchCount: 1 });
      strip(dom, 0).click();
      press(dom, input, 'Escape');
      assert.strictEqual(input.value, '');
      assert.ok(card(dom), 'the first Escape belongs to the box');
    });

    it('lets Escape in an empty box close the card, as everywhere else', () => {
      const { dom } = load();
      show(dom);
      strip(dom, 0).click();
      press(dom, inputs(dom)[0], 'Escape');
      assert.strictEqual(card(dom), null);
    });

    it('is anchored below the whole header, including the filter row', () => {
      const { dom } = load();
      show(dom);
      Object.defineProperty(doc(dom).documentElement, 'clientWidth', { configurable: true, value: 1000 });
      Object.defineProperty(doc(dom).documentElement, 'clientHeight', { configurable: true, value: 600 });
      const rect = (bottom: number) =>
        ({ left: 0, right: 100, top: 0, bottom, width: 100, height: bottom, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
      const ths = doc(dom).querySelectorAll('#csv-table thead tr:first-child th');
      ths[0].getBoundingClientRect = () => rect(50);
      ths[1].getBoundingClientRect = () => rect(50);
      doc(dom).querySelector('#csv-table thead')!.getBoundingClientRect = () => rect(90); // header + filter row
      strip(dom, 0).click();
      assert.strictEqual(card(dom)!.style.top, '94px');
    });
  });
});
