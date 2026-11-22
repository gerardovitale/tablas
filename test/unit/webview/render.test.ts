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
  TableRef,
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
/** The `seq` of the newest `get-stats` request the webview sent (what a real host would echo). */
let lastStatsRequestSeq: number | undefined;

type StatsReply = (request: { type: string; table?: string; seq?: number }) => unknown;

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
      const request = msg as { type: string; table?: string; seq?: number };
      if (request.type === 'get-stats') { lastStatsRequestSeq = request.seq; }
      if (request.type === 'get-stats' && reply !== null) {
        const payload = reply
          ? reply(request)
          : { ...(request.table !== undefined && { table: request.table }), seq: request.seq, stats: replyStats };
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

    describe('order and cost of the requests a reload makes', () => {
      const types = (posted: unknown[]) => posted.map((m) => (m as { type: string }).type);
      const meta = { reload: { at: '2026-11-19T10:00:00.000Z', previousRowCount: 3 } };

      it('asks for the filter before the statistics, so the filtered rows are not queued behind the scan', () => {
        const { dom, postedMessages } = loadWebview();
        sendDuckdbData(dom, payload(threeRows));
        filterBoxes(dom)[1].value = 'Rome';
        const before = postedMessages.length;
        sendDuckdbData(dom, payload(fiveRows, meta));
        const after = types(postedMessages.slice(before));
        assert.deepStrictEqual(after, ['filter', 'get-stats']);
      });

      it('still asks for statistics once when there is no filter to re-apply', () => {
        const { dom, postedMessages } = loadWebview();
        sendDuckdbData(dom, payload(threeRows));
        const before = postedMessages.length;
        sendDuckdbData(dom, payload(fiveRows, meta));
        assert.deepStrictEqual(types(postedMessages.slice(before)), ['get-stats']);
      });

      it('asks for statistics when the filters were dropped because the columns changed', () => {
        const { dom, postedMessages } = loadWebview();
        sendDuckdbData(dom, payload(threeRows));
        filterBoxes(dom)[1].value = 'Rome';
        const before = postedMessages.length;
        sendDuckdbData(dom, payload([['1', 'Rome', 'x']], meta, ['id', 'city', 'extra']));
        assert.deepStrictEqual(types(postedMessages.slice(before)), ['get-stats']);
      });

      it('does not draw the unfiltered table while the re-applied filter is pending', () => {
        const { dom, postedMessages } = loadWebview();
        sendDuckdbData(dom, payload(threeRows));
        filterBoxes(dom)[1].value = 'Rome';
        sendDuckdbData(dom, payload(fiveRows, meta));
        const rows = () => dom.window.document.querySelectorAll('#csv-table tbody tr').length;
        assert.strictEqual(rows(), 0, 'nothing is shown that the filter would hide');
        const seq = (filterRequests(postedMessages) as unknown as Array<{ seq: number }>).at(-1)!.seq;
        dom.window.dispatchEvent(
          new dom.window.MessageEvent('message', {
            data: { type: 'filter-data', payload: { seq, table: 'a', rows: [['1', 'Rome'], ['5', 'Rome']], matchCount: 2 } },
          })
        );
        assert.strictEqual(rows(), 2);
      });

      it('brings the table back when the re-applied filter text does not parse', () => {
        const { dom, postedMessages } = loadWebview();
        sendDuckdbData(dom, payload(threeRows));
        filterBoxes(dom)[1].value = '>';
        sendDuckdbData(dom, payload(fiveRows, meta));
        const seq = (filterRequests(postedMessages) as unknown as Array<{ seq: number }>).at(-1)!.seq;
        dom.window.dispatchEvent(
          new dom.window.MessageEvent('message', {
            data: { type: 'filter-data', payload: { seq, table: 'a', errors: [{ column: 1, message: 'bad' }] } },
          })
        );
        assert.strictEqual(dom.window.document.querySelectorAll('#csv-table tbody tr').length, 5);
      });

      it('brings the table back when the re-applied filter fails', () => {
        const { dom, postedMessages } = loadWebview();
        sendDuckdbData(dom, payload(threeRows));
        filterBoxes(dom)[1].value = 'Rome';
        sendDuckdbData(dom, payload(fiveRows, meta));
        const seq = (filterRequests(postedMessages) as unknown as Array<{ seq: number }>).at(-1)!.seq;
        dom.window.dispatchEvent(
          new dom.window.MessageEvent('message', {
            data: { type: 'filter-data', payload: { seq, table: 'a', failedReason: 'too big' } },
          })
        );
        assert.strictEqual(dom.window.document.querySelectorAll('#csv-table tbody tr').length, 5);
      });
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

  describe('sql box', () => {
    function warehouse(extra: Partial<MultiTableData> = {}, selectedTable = 'a'): MultiTableParseOutcome {
      return {
        success: true,
        errors: [],
        data: {
          tables: [
            { name: 'a', type: 'table' },
            { name: 'b', type: 'table' },
          ],
          selectedTable,
          data: {
            headers: ['id', 'city'],
            rows: [['1', 'Rome'], ['2', 'Paris']],
            rowCount: 2,
            columnCount: 2,
          },
          capabilities: { refresh: true, query: true },
          querySuggestion: `select * from "${selectedTable}" limit 5`,
          ...extra,
        },
      };
    }
    const doc = (dom: JSDOM) => dom.window.document;
    const sqlButton = (dom: JSDOM) => doc(dom).querySelector<HTMLButtonElement>('.sql-toggle')!;
    const panel = (dom: JSDOM) => doc(dom).querySelector<HTMLElement>('.query-panel')!;
    const queryInput = (dom: JSDOM) => doc(dom).querySelector<HTMLTextAreaElement>('.query-input')!;
    const runButton = (dom: JSDOM) => doc(dom).querySelector<HTMLButtonElement>('.query-run')!;
    const queryStatus = (dom: JSDOM) => doc(dom).querySelector('.query-status')?.textContent;
    const queryMessage = (dom: JSDOM) => doc(dom).querySelector<HTMLElement>('.query-message')!;
    const chip = (dom: JSDOM) => doc(dom).querySelector<HTMLElement>('.result-chip');
    const closeChip = (dom: JSDOM) => doc(dom).querySelector<HTMLButtonElement>('.result-chip-close')!;
    const cellText = (dom: JSDOM) => doc(dom).querySelector('#csv-table tbody td:not(.row-num)')?.textContent;
    const filterBoxIn = (dom: JSDOM, scope: string) => doc(dom).querySelector<HTMLInputElement>(`${scope} input.col-filter`)!;
    const runQueries = (posted: unknown[]) =>
      posted.filter((m) => (m as { type: string }).type === 'run-query') as Array<{ seq: number; sql: string }>;
    const sentOf = (posted: unknown[], type: string) =>
      posted.filter((m) => (m as { type: string }).type === type) as Array<Record<string, unknown>>;
    const countOf = (posted: unknown[], type: string) => sentOf(posted, type).length;
    const sendQueryData = (dom: JSDOM, payload: Record<string, unknown>) =>
      dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { type: 'query-data', payload } }));
    /** An answer with a result the host keeps as a table (`result` = the run's seq), unless `rest` says otherwise. */
    const resultOk = (seq: number, data: Partial<ParsedTable> = {}, rest: Record<string, unknown> = {}) => ({
      seq,
      data: { headers: ['n'], rows: [['1'], ['2'], ['3']], rowCount: 3, columnCount: 1, ...data },
      truncated: false,
      elapsedMs: 42,
      result: seq,
      materializedRows: 3,
      ...rest,
    });
    const ctrlEnter = (dom: JSDOM, target: Element) =>
      target.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true })
      );
    const type = (dom: JSDOM, text: string) => {
      queryInput(dom).value = text;
      queryInput(dom).dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    };
    const reloadMeta = { reload: { at: '2026-11-19T10:00:00.000Z', previousRowCount: 2 } };
    const pickTable = (dom: JSDOM, name: string) => {
      const app = doc(dom).getElementById('app')!;
      openPickerPopup(app);
      Array.from(app.querySelectorAll<HTMLElement>('.table-picker-option'))
        .find((o) => o.querySelector('.picker-name')?.textContent === name)!
        .click();
    };

    /** The page with the panel open. */
    function inPanel(extra: Partial<MultiTableData> = {}) {
      const loaded = loadWebview();
      sendDuckdbData(loaded.dom, warehouse(extra));
      sqlButton(loaded.dom).click();
      return loaded;
    }
    /** Runs the suggestion and answers it: a result is on screen, as a table the host keeps. */
    function withResult(data: Partial<ParsedTable> = {}, rest: Record<string, unknown> = {}) {
      const loaded = inPanel();
      runButton(loaded.dom).click();
      const seq = runQueries(loaded.postedMessages).at(-1)!.seq;
      sendQueryData(loaded.dom, resultOk(seq, data, rest));
      return { ...loaded, seq };
    }

    describe('the panel', () => {
      it('has a button only when the host can run queries, and no Table | SQL switch', () => {
        const { dom } = loadWebview();
        sendDuckdbData(dom, warehouse({ capabilities: { refresh: true } }));
        assert.strictEqual(doc(dom).querySelector('.sql-toggle'), null);
        assert.strictEqual(doc(dom).querySelector('.query-panel'), null);
        sendDuckdbData(dom, warehouse());
        assert.ok(sqlButton(dom));
        assert.strictEqual(doc(dom).querySelector('.mode-toggle'), null);
        assert.strictEqual(doc(dom).querySelector('.mode-button'), null);
      });

      it('starts closed: the box exists but is hidden, and the button says so', () => {
        const { dom } = loadWebview();
        sendDuckdbData(dom, warehouse());
        assert.strictEqual(sqlButton(dom).getAttribute('aria-expanded'), 'false');
        assert.strictEqual(sqlButton(dom).getAttribute('aria-controls'), panel(dom).id);
        assert.strictEqual(panel(dom).hidden, true);
      });

      it('opens beside the table, which and whose picker stay where they are', () => {
        const { dom, postedMessages } = inPanel();
        assert.strictEqual(sqlButton(dom).getAttribute('aria-expanded'), 'true');
        assert.strictEqual(panel(dom).hidden, false);
        assert.strictEqual(queryInput(dom).value, 'select * from "a" limit 5');
        assert.strictEqual(doc(dom).activeElement, queryInput(dom), 'the box is ready to type in');
        assert.ok(doc(dom).querySelector('#csv-table'), 'the table is still there');
        assert.ok(doc(dom).querySelector('.table-picker-trigger'), 'so is the picker');
        assert.strictEqual(chip(dom), null);
        assert.strictEqual(runQueries(postedMessages).length, 0, 'opening runs nothing');
      });

      it('opening and closing leaves the table, its filters and scroll alone, and returns focus to the button', () => {
        const { dom, postedMessages } = loadWebview();
        sendDuckdbData(dom, warehouse());
        const box = filterBoxIn(dom, '.table-area');
        box.value = 'Rome';
        box.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        const table = doc(dom).querySelector('#csv-table');
        const filtersBefore = countOf(postedMessages, 'filter');
        sqlButton(dom).click();
        sqlButton(dom).click();
        assert.strictEqual(panel(dom).hidden, true);
        assert.strictEqual(doc(dom).querySelector('#csv-table'), table, 'the same table element');
        assert.strictEqual(filterBoxIn(dom, '.table-area').value, 'Rome');
        assert.strictEqual(countOf(postedMessages, 'filter'), filtersBefore, 'nothing was re-sent');
        assert.strictEqual(doc(dom).activeElement, sqlButton(dom));
      });

      it('follows the table being viewed until the user edits the box, then keeps their text', () => {
        const { dom } = loadWebview();
        sendDuckdbData(dom, warehouse());
        sqlButton(dom).click();
        assert.strictEqual(queryInput(dom).value, 'select * from "a" limit 5');

        // On another table, the untouched box offers that table's suggestion.
        sendDuckdbData(dom, warehouse({}, 'b'));
        assert.strictEqual(queryInput(dom).value, 'select * from "b" limit 5');

        // Once edited, the text is theirs, whatever table is shown later.
        type(dom, 'select count(*) from b');
        sendDuckdbData(dom, warehouse({}, 'a'));
        assert.strictEqual(queryInput(dom).value, 'select count(*) from b');
      });

      it('keeps a box the user emptied empty, instead of refilling the suggestion', () => {
        const { dom } = inPanel();
        type(dom, '');
        sendDuckdbData(dom, warehouse({}, 'b'));
        assert.strictEqual(queryInput(dom).value, '');
      });

      it('keeps the panel open and the text through a table switch', () => {
        const { dom } = inPanel();
        type(dom, 'select 7');
        sendDuckdbData(dom, warehouse({}, 'b'));
        assert.strictEqual(panel(dom).hidden, false);
        assert.strictEqual(sqlButton(dom).getAttribute('aria-expanded'), 'true');
        assert.strictEqual(queryInput(dom).value, 'select 7');
      });

      it('falls back to a plain table when the host can no longer query (e.g. the file became empty)', () => {
        const { dom } = withResult();
        assert.ok(chip(dom));
        sendDuckdbData(dom, warehouse({ capabilities: { refresh: true, query: false }, ...reloadMeta }));
        assert.strictEqual(doc(dom).querySelector('.query-panel'), null);
        assert.strictEqual(doc(dom).querySelector('.sql-toggle'), null);
        assert.strictEqual(chip(dom), null);
        assert.strictEqual(cellText(dom), '1');
      });
    });

    describe('running', () => {
      it('runs the text with the Run button and with Ctrl+Enter, numbering each request', () => {
        const { dom, postedMessages } = inPanel();
        runButton(dom).click();
        type(dom, 'SELECT 2');
        ctrlEnter(dom, queryInput(dom));
        const sent = runQueries(postedMessages);
        assert.deepStrictEqual(sent.map((q) => q.sql), ['select * from "a" limit 5', 'SELECT 2']);
        assert.ok(sent[1].seq > sent[0].seq);
        assert.strictEqual(queryStatus(dom), 'Running…');
      });

      it('does not run an empty query', () => {
        const { dom, postedMessages } = inPanel({ querySuggestion: undefined });
        assert.strictEqual(queryInput(dom).value, '');
        assert.strictEqual(runButton(dom).disabled, true);
        ctrlEnter(dom, queryInput(dom));
        assert.strictEqual(runQueries(postedMessages).length, 0);
      });

      it('keeps the box, its focus and the table while the query runs', () => {
        const { dom } = inPanel();
        runButton(dom).click();
        assert.ok(doc(dom).querySelector('#csv-table'), 'the table stays until the answer');
        assert.strictEqual(chip(dom), null);
      });

      it('ignores a reply that a newer run overtook', () => {
        const { dom, postedMessages } = inPanel();
        runButton(dom).click();
        runButton(dom).click();
        const [first, second] = runQueries(postedMessages);
        sendQueryData(dom, resultOk(first.seq, { rows: [['old']], rowCount: 1 }));
        assert.strictEqual(chip(dom), null, 'the older answer is not shown');
        assert.strictEqual(cellText(dom), '1', 'the table is still there');
        assert.strictEqual(queryStatus(dom), 'Running…');
        sendQueryData(dom, resultOk(second.seq, { rows: [['new']], rowCount: 1 }));
        assert.strictEqual(cellText(dom), 'new');
      });
    });

    describe('a result', () => {
      it('replaces the grid under a "Result of query" chip, with the picker and the box still there', () => {
        const { dom } = withResult();
        assert.strictEqual(chip(dom)?.querySelector('.result-chip-label')?.textContent, 'Result of query');
        assert.strictEqual(doc(dom).querySelectorAll('#csv-table').length, 1, 'one grid: the result replaced the table');
        assert.strictEqual(doc(dom).querySelectorAll('#csv-table tbody tr').length, 3);
        assert.strictEqual(doc(dom).querySelector('.stats-bar')?.textContent, '3 rows × 1 column');
        assert.ok(doc(dom).querySelector('.table-picker-trigger'));
        assert.ok(queryInput(dom));
        assert.strictEqual(queryStatus(dom), '3 rows · 42 ms');
        assert.strictEqual(queryMessage(dom).hidden, true);
      });

      it('does not move focus out of the box when it arrives', () => {
        const { dom, postedMessages } = inPanel();
        queryInput(dom).focus();
        ctrlEnter(dom, queryInput(dom));
        sendQueryData(dom, resultOk(runQueries(postedMessages)[0].seq));
        assert.strictEqual(doc(dom).activeElement, queryInput(dom));
      });

      it('says when the query returned more rows than are shown', () => {
        const { dom } = withResult({}, { result: undefined, truncated: true });
        assert.match(doc(dom).querySelector('.stats-bar')?.textContent ?? '', /returned more — showing the first 3 rows/);
        assert.strictEqual(queryStatus(dom), '3+ rows · 42 ms');
      });

      it('treats cell text as text, never markup', () => {
        const { dom } = withResult({ rows: [['<img src=x onerror=alert(1)>']], rowCount: 1 });
        assert.strictEqual(doc(dom).querySelector('img'), null);
        assert.strictEqual(cellText(dom), '<img src=x onerror=alert(1)>');
      });

      it('does not decorate it with the table\'s column descriptions', () => {
        const loaded = loadWebview();
        sendDuckdbData(loaded.dom, warehouse({ columnDescriptions: { id: 'Primary key.' } }));
        assert.strictEqual(doc(loaded.dom).querySelectorAll('th.has-description').length, 1);
        sqlButton(loaded.dom).click();
        runButton(loaded.dom).click();
        sendQueryData(loaded.dom, resultOk(runQueries(loaded.postedMessages)[0].seq, { headers: ['id'], rows: [['1']], rowCount: 1 }));
        assert.ok(chip(loaded.dom));
        assert.strictEqual(doc(loaded.dom).querySelectorAll('th.has-description').length, 0);
      });
    });

    describe('what is not a result', () => {
      it('shows an error under the box, keeps the box and the table, and fails the status', () => {
        const { dom, postedMessages } = inPanel();
        runButton(dom).click();
        sendQueryData(dom, { seq: runQueries(postedMessages)[0].seq, error: 'Catalog Error: Table "x" does not exist' });
        assert.strictEqual(queryMessage(dom).hidden, false);
        assert.strictEqual(queryMessage(dom).textContent, 'Catalog Error: Table "x" does not exist');
        assert.strictEqual(queryMessage(dom).getAttribute('role'), 'alert');
        assert.ok(queryMessage(dom).classList.contains('error'));
        assert.strictEqual(queryStatus(dom), 'Failed');
        assert.strictEqual(queryInput(dom).value, 'select * from "a" limit 5');
        assert.strictEqual(chip(dom), null);
        assert.strictEqual(cellText(dom), '1', 'the table is still there');
      });

      it('keeps the previous result when a later run fails, and clears the message on the next success', () => {
        const { dom, postedMessages } = withResult({ rows: [['kept']], rowCount: 1 });
        runButton(dom).click();
        sendQueryData(dom, { seq: runQueries(postedMessages).at(-1)!.seq, error: 'Parser Error: nope' });
        assert.strictEqual(cellText(dom), 'kept');
        assert.ok(chip(dom));
        assert.strictEqual(queryMessage(dom).textContent, 'Parser Error: nope');
        runButton(dom).click();
        sendQueryData(dom, resultOk(runQueries(postedMessages).at(-1)!.seq, { rows: [['fresh']], rowCount: 1 }));
        assert.strictEqual(cellText(dom), 'fresh');
        assert.strictEqual(queryMessage(dom).hidden, true);
      });

      it('explains a statement that returned no columns, under the box, and leaves the grid', () => {
        const { dom, postedMessages } = inPanel();
        runButton(dom).click();
        sendQueryData(dom, resultOk(runQueries(postedMessages)[0].seq, { headers: [], rows: [], rowCount: 0, columnCount: 0 }, { result: undefined }));
        assert.strictEqual(queryMessage(dom).textContent, 'The statement ran and returned no columns.');
        assert.ok(!queryMessage(dom).classList.contains('error'));
        assert.strictEqual(chip(dom), null);
        assert.strictEqual(cellText(dom), '1');
        assert.strictEqual(queryStatus(dom), 'Done · 42 ms');
      });
    });

    describe('going back to the table', () => {
      it('the ✕ restores the table with its filter and its scroll, and tells the host to drop the result', () => {
        const { dom, postedMessages } = loadWebview();
        sendDuckdbData(dom, warehouse());
        const box = filterBoxIn(dom, '.table-area');
        box.value = 'Rome';
        box.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        doc(dom).querySelector<HTMLElement>('.scroll-wrapper')!.scrollTop = 33;
        sqlButton(dom).click();
        runButton(dom).click();
        const seq = runQueries(postedMessages)[0].seq;
        sendQueryData(dom, resultOk(seq));
        assert.deepStrictEqual(sentOf(postedMessages, 'filter').at(-1)!.filters, [], 'leaving the table releases its filter on the host');

        closeChip(dom).click();

        assert.strictEqual(chip(dom), null);
        assert.ok(doc(dom).querySelector('#csv-table .filter-row'), 'the table is back (its rows wait for the filter\'s answer)');
        assert.strictEqual(filterBoxIn(dom, '.table-area').value, 'Rome');
        assert.deepStrictEqual(sentOf(postedMessages, 'filter').at(-1)!.filters, [{ column: 0, text: 'Rome' }]);
        // The scroll comes back with the filter's rows, like after a refresh.
        const refilter = sentOf(postedMessages, 'filter').at(-1)!;
        dom.window.dispatchEvent(
          new dom.window.MessageEvent('message', {
            data: { type: 'filter-data', payload: { seq: refilter.seq, table: 'a', rows: [['1', 'Rome']], matchCount: 1 } },
          })
        );
        assert.strictEqual(doc(dom).querySelector<HTMLElement>('.scroll-wrapper')!.scrollTop, 33);
        assert.deepStrictEqual(sentOf(postedMessages, 'close-result'), [{ type: 'close-result', seq }]);
        assert.strictEqual(queryInput(dom).value, 'select * from "a" limit 5', 'the box keeps its text');
        assert.strictEqual(panel(dom).hidden, false);
        assert.strictEqual(queryStatus(dom), '');
        assert.strictEqual(doc(dom).activeElement, doc(dom).querySelector('.scroll-wrapper'));
      });

      it('has an accessible name for the ✕', () => {
        const { dom } = withResult();
        assert.match(closeChip(dom).getAttribute('aria-label') ?? '', /Close the result/);
      });

      it('a result without a table has nothing to tell the host', () => {
        const { dom, postedMessages } = withResult({}, { result: undefined });
        closeChip(dom).click();
        assert.strictEqual(countOf(postedMessages, 'close-result'), 0);
        assert.strictEqual(chip(dom), null);
      });

      it('forgets a run still in flight, so its answer cannot bring a result back', () => {
        const { dom, postedMessages, seq } = withResult();
        runButton(dom).click();
        const second = runQueries(postedMessages).at(-1)!.seq;
        closeChip(dom).click();
        assert.deepStrictEqual(
          sentOf(postedMessages, 'close-result').map((m) => m.seq),
          [seq, second],
          'the shown result and the one the run will make'
        );
        sendQueryData(dom, resultOk(second, { rows: [['late']], rowCount: 1 }));
        assert.strictEqual(chip(dom), null);
        assert.strictEqual(cellText(dom), '1');
      });

      it('is what a pick of another table does: the table replaces the result, which is not re-run', () => {
        const { dom, postedMessages } = withResult();
        pickTable(dom, 'b');
        sendDuckdbData(dom, warehouse({}, 'b'));
        assert.strictEqual(chip(dom), null);
        assert.strictEqual(cellText(dom), '1');
        const sentBefore = runQueries(postedMessages).length;
        sendDuckdbData(dom, warehouse({ ...reloadMeta }, 'b'));
        assert.strictEqual(runQueries(postedMessages).length, sentBefore, 'nothing left to re-run');
      });

      it('is what the host choosing a table does (dbt Preview Model, the same table, show-table)', () => {
        const first = withResult();
        sendDuckdbData(first.dom, warehouse({ hostSelected: true }, 'b'));
        assert.strictEqual(chip(first.dom), null);
        assert.strictEqual(pickerCurrent(doc(first.dom).getElementById('app')!), 'b');

        const second = withResult();
        second.dom.window.dispatchEvent(new second.dom.window.MessageEvent('message', { data: { type: 'show-table' } }));
        assert.strictEqual(chip(second.dom), null);
        assert.ok(doc(second.dom).querySelector('#csv-table'));
        // With nothing to give way, a no-op.
        second.dom.window.dispatchEvent(new second.dom.window.MessageEvent('message', { data: { type: 'show-table' } }));
        assert.ok(doc(second.dom).querySelector('#csv-table'));
      });

      it('shows the refreshed table when the file was refreshed while the result was on screen', () => {
        const { dom } = withResult();
        sendDuckdbData(
          dom,
          warehouse({ ...reloadMeta, data: { headers: ['id', 'city'], rows: [['9', 'Oslo']], rowCount: 1, columnCount: 2 } })
        );
        closeChip(dom).click();
        assert.strictEqual(cellText(dom), '9');
      });
    });

    describe('when the file is refreshed', () => {
      it('keeps the result on screen and re-runs the query behind it, not unsent edits', () => {
        const { dom, postedMessages } = withResult();
        const grid = doc(dom).querySelector('#csv-table');
        type(dom, 'SELECT 99 -- not run yet');

        sendDuckdbData(dom, warehouse({ ...reloadMeta }));

        const sent = runQueries(postedMessages);
        assert.strictEqual(sent.length, 2);
        assert.strictEqual(sent[1].sql, 'select * from "a" limit 5', 'the query behind the result, not the unsent edit');
        assert.strictEqual(queryInput(dom).value, 'SELECT 99 -- not run yet');
        assert.ok(chip(dom), 'still the result');
        assert.strictEqual(doc(dom).querySelector('#csv-table'), grid, 'the old result stays as it is until the new one arrives');
        assert.strictEqual(queryStatus(dom), 'Running…');
        sendQueryData(dom, resultOk(sent[1].seq, { rows: [['9']], rowCount: 1 }));
        assert.strictEqual(cellText(dom), '9');
      });

      it('puts the result\'s filter and scroll back on the new answer', () => {
        const { dom, postedMessages } = withResult();
        const box = filterBoxIn(dom, '.table-area');
        box.value = '>1';
        box.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

        sendDuckdbData(dom, warehouse({ ...reloadMeta }));
        assert.strictEqual(filterBoxIn(dom, '.table-area').value, '>1', 'kept while the re-run is pending');

        const second = runQueries(postedMessages)[1].seq;
        sendQueryData(dom, resultOk(second, { rows: [['5'], ['6']], rowCount: 2 }));
        assert.strictEqual(filterBoxIn(dom, '.table-area').value, '>1');
        const filter = sentOf(postedMessages, 'filter').at(-1)!;
        assert.strictEqual(filter.result, second, 'asked of the new result');
        assert.deepStrictEqual(filter.filters, [{ column: 0, text: '>1' }]);
      });

      it('keeps the scroll of the result through the refresh and the new answer', () => {
        const { dom, postedMessages } = withResult();
        const wrapper = () => doc(dom).querySelector<HTMLElement>('.scroll-wrapper')!;
        wrapper().scrollTop = 120;
        wrapper().scrollLeft = 30;
        sendDuckdbData(dom, warehouse({ ...reloadMeta }));
        assert.strictEqual(wrapper().scrollTop, 120);
        sendQueryData(dom, resultOk(runQueries(postedMessages)[1].seq, { rows: [['9']], rowCount: 1 }));
        assert.strictEqual(wrapper().scrollTop, 120);
        assert.strictEqual(wrapper().scrollLeft, 30);
      });

      it('keeps focus, caret and scroll in the box through a refresh', () => {
        const { dom } = withResult();
        const before = queryInput(dom);
        before.focus();
        before.setSelectionRange(3, 7);
        before.scrollTop = 11;

        sendDuckdbData(dom, warehouse({ ...reloadMeta }));

        const after = queryInput(dom);
        assert.notStrictEqual(after, before, 'the page is rebuilt');
        assert.strictEqual(doc(dom).activeElement, after, 'typing can go on');
        assert.deepStrictEqual([after.selectionStart, after.selectionEnd], [3, 7]);
        assert.strictEqual(after.scrollTop, 11);
      });

      it('does not move focus into the box on a refresh when the user was elsewhere', () => {
        const { dom } = inPanel();
        (doc(dom).activeElement as HTMLElement).blur();
        sendDuckdbData(dom, warehouse({ ...reloadMeta }));
        assert.notStrictEqual(doc(dom).activeElement, queryInput(dom));
      });

      it('does not start a second run on top of a running one, but runs once more after its answer', () => {
        const { dom, postedMessages } = withResult();
        runButton(dom).click();
        sendDuckdbData(dom, warehouse({ ...reloadMeta }));
        sendDuckdbData(dom, warehouse({ ...reloadMeta }));
        assert.strictEqual(runQueries(postedMessages).length, 2, 'refreshes during a run add no runs');

        sendQueryData(dom, resultOk(runQueries(postedMessages)[1].seq));
        const sent = runQueries(postedMessages);
        assert.strictEqual(sent.length, 3, 'one re-run for all of them, after the answer');
        assert.strictEqual(sent[2].sql, sent[1].sql);
        assert.ok(chip(dom), 'the answer that did arrive is shown meanwhile');
      });

      it('a manual run cancels a pending re-run', () => {
        const { dom, postedMessages } = withResult();
        runButton(dom).click();
        sendDuckdbData(dom, warehouse({ ...reloadMeta }));
        runButton(dom).click();
        sendQueryData(dom, resultOk(runQueries(postedMessages)[2].seq));
        assert.strictEqual(runQueries(postedMessages).length, 3, 'no extra run after the manual one answered');
      });

      it('runs nothing when no result is on screen, and nothing after the result was closed', () => {
        const { dom, postedMessages } = inPanel();
        sendDuckdbData(dom, warehouse({ ...reloadMeta }));
        assert.strictEqual(runQueries(postedMessages).length, 0);
        assert.ok(queryInput(dom), 'the panel is still there after the refresh');

        const withOne = withResult();
        closeChip(withOne.dom).click();
        const before = runQueries(withOne.postedMessages).length;
        sendDuckdbData(withOne.dom, warehouse({ ...reloadMeta }));
        assert.strictEqual(runQueries(withOne.postedMessages).length, before);
      });

      it('does not re-run a query whose run failed (the result on screen came from another one)', () => {
        const { dom, postedMessages } = withResult();
        type(dom, 'SELECT nope');
        runButton(dom).click();
        sendQueryData(dom, { seq: runQueries(postedMessages).at(-1)!.seq, error: 'Binder Error' });
        sendDuckdbData(dom, warehouse({ ...reloadMeta }));
        const sent = runQueries(postedMessages);
        assert.strictEqual(sent.at(-1)!.sql, 'select * from "a" limit 5', 'the SQL behind the result on screen');
      });
    });

    describe('a result served as a table by the host', () => {
      const intStats = { columns: [{ type: 'integer', nullCount: 0, distinctCount: 3, min: '1', max: '3', mean: 2, nativeType: 'BIGINT' }] };
      const sendStats = (dom: JSDOM, payload: Record<string, unknown>) =>
        dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { type: 'stats-data', payload } }));
      const sendFilterData = (dom: JSDOM, payload: Record<string, unknown>) =>
        dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { type: 'filter-data', payload } }));
      const last = (posted: unknown[], type: string) =>
        posted.filter((m) => (m as { type: string }).type === type).at(-1) as Record<string, unknown>;

      const withServedResult = (rest: Record<string, unknown> = {}, data: Partial<ParsedTable> = {}) => withResult(data, rest);

      it('gets the filter row, and asks for statistics by result, never by table', () => {
        const { dom, postedMessages, seq } = withServedResult();
        assert.strictEqual(doc(dom).querySelectorAll('.table-area input.col-filter').length, 1);
        assert.strictEqual(doc(dom).querySelectorAll('.table-area thead tr').length, 2);
        const request = last(postedMessages, 'get-stats');
        assert.strictEqual(request.result, seq);
        assert.ok(!('table' in request), 'a result has no table name');
      });

      it('draws the profile strip and the type badge from the statistics answer', () => {
        const { dom, postedMessages, seq } = withServedResult();
        sendStats(dom, { result: seq, seq: last(postedMessages, 'get-stats').seq, stats: intStats });
        const strip = doc(dom).querySelector('.table-area button.col-profile');
        assert.ok(strip, 'the strip is attached');
        assert.match(doc(dom).querySelector('.table-area .type-badge')?.getAttribute('aria-label') ?? '', /integer · BIGINT/);
      });

      it('drops statistics and filter answers that belong to another result or to a table', () => {
        const { dom, postedMessages, seq } = withServedResult();
        const statsSeq = last(postedMessages, 'get-stats').seq;
        sendStats(dom, { result: seq + 1, seq: statsSeq, stats: intStats });
        sendStats(dom, { table: 'a', seq: statsSeq, stats: intStats });
        assert.strictEqual(doc(dom).querySelector('.table-area button.col-profile'), null);

        const box = doc(dom).querySelector<HTMLInputElement>('.table-area input.col-filter')!;
        box.value = '>1';
        box.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        const filter = last(postedMessages, 'filter');
        assert.strictEqual(filter.result, seq);
        assert.ok(!('table' in filter));
        const rows = [['2'], ['3']];
        sendFilterData(dom, { seq: filter.seq, result: seq + 1, rows, matchCount: 2 });
        assert.strictEqual(doc(dom).querySelectorAll('.table-area tbody tr').length, 3, 'a stale result address is ignored');
        sendFilterData(dom, { seq: filter.seq, result: seq, rows, matchCount: 2 });
        assert.strictEqual(doc(dom).querySelectorAll('.table-area tbody tr').length, 2);
        assert.strictEqual(doc(dom).querySelector('.table-area .stats-bar')?.textContent, '2 of 3 rows match');
      });

      it('says when a failed answer is because the result is gone', () => {
        const { dom, postedMessages, seq } = withServedResult();
        const box = doc(dom).querySelector<HTMLInputElement>('.table-area input.col-filter')!;
        box.value = '>1';
        box.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        sendFilterData(dom, {
          seq: last(postedMessages, 'filter').seq,
          result: seq,
          failedReason: 'This result is no longer available; run the query again.',
        });
        assert.match(doc(dom).querySelector('.table-area .stats-bar')?.textContent ?? '', /no longer available/);
        assert.strictEqual(doc(dom).querySelectorAll('.table-area tbody tr').length, 3, 'the rows stay');
      });

      it('says the statistics and filters cover the first N rows when the query had more', () => {
        const { dom } = withServedResult({ capped: true, truncated: true, materializedRows: 100000 }, { totalRowCount: 100000 });
        const bar = doc(dom).querySelector('.table-area .stats-bar')?.textContent ?? '';
        assert.match(bar, /the query returned more than 100,000 rows — statistics and filters cover the first 100,000; showing 3/);
        assert.strictEqual(queryStatus(dom), '3+ rows · 42 ms');
      });

      it('has no note about a cap when the whole result is held', () => {
        const { dom } = withServedResult();
        assert.strictEqual(doc(dom).querySelector('.table-area .stats-bar')?.textContent, '3 rows × 1 column');
      });

      it('explains a result without a table: rows only, no filter boxes', () => {
        const { dom, postedMessages } = inPanel();
        runButton(dom).click();
        sendQueryData(dom, resultOk(runQueries(postedMessages)[0].seq, {}, { result: undefined }));
        assert.strictEqual(doc(dom).querySelectorAll('.table-area input.col-filter').length, 0);
        assert.strictEqual(doc(dom).querySelector('.table-area .stats-status')?.textContent, 'Statistics and filters are not available for this result.');
      });
    });

  });

  describe('sql box for a single-table source (CSV, Parquet)', () => {
    const doc = (dom: JSDOM) => dom.window.document;
    const rows = [['1', 'Rome'], ['2', 'Paris']];
    function csvWithSql(extra: Record<string, unknown> = {}): CsvParseOutcome {
      return {
        success: true,
        errors: [],
        data: { headers: ['id', 'city'], rows, rowCount: 2, columnCount: 2 },
        capabilities: { query: true },
        querySuggestion: 'select * from "sales-2024" limit 5',
        queryNote: 'Types are detected by DuckDB.',
        ...extra,
      } as CsvParseOutcome;
    }
    const posted = (messages: unknown[], type: string) =>
      messages.filter((m) => (m as { type: string }).type === type) as Array<Record<string, unknown>>;
    const sendQueryData = (dom: JSDOM, payload: Record<string, unknown>) =>
      dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { type: 'query-data', payload } }));
    const filterBox = (dom: JSDOM) => doc(dom).querySelector<HTMLInputElement>('.table-area input.col-filter')!;

    it('offers nothing without the capability', () => {
      const { dom } = loadWebview();
      sendCsvData(dom, { success: true, errors: [], data: { headers: ['a'], rows: [['1']], rowCount: 1, columnCount: 1 } });
      assert.strictEqual(doc(dom).querySelector('.sql-toggle'), null);
      assert.strictEqual(doc(dom).querySelector('.query-panel'), null);
      assert.ok(doc(dom).querySelector('#csv-table'));
    });

    it('has the SQL button and a closed panel, with the table in the grid area and no picker', () => {
      const { dom } = loadWebview();
      sendCsvData(dom, csvWithSql());
      assert.ok(doc(dom).querySelector('.table-toolbar .sql-toggle'));
      assert.strictEqual(doc(dom).querySelector('.table-picker-trigger'), null, 'one table: nothing to pick');
      assert.strictEqual(doc(dom).querySelector<HTMLElement>('.query-panel')!.hidden, true);
      assert.strictEqual(doc(dom).querySelectorAll('.table-area #csv-table tbody tr').length, 2);
      assert.strictEqual(doc(dom).querySelector('.reload-status'), null, 'a CSV has no refresh');
    });

    it('opens on the file\'s view, as the host wrote it, and shows the host\'s note under the box', () => {
      const { dom } = loadWebview();
      sendCsvData(dom, csvWithSql());
      doc(dom).querySelector<HTMLButtonElement>('.sql-toggle')!.click();
      assert.strictEqual(doc(dom).querySelector<HTMLTextAreaElement>('.query-input')!.value, 'select * from "sales-2024" limit 5');
      assert.strictEqual(doc(dom).querySelector('.query-note')?.textContent, 'Types are detected by DuckDB.');
    });

    it('shows no note when the host has none (Parquet)', () => {
      const { dom } = loadWebview();
      sendCsvData(dom, csvWithSql({ queryNote: undefined }));
      assert.strictEqual(doc(dom).querySelector('.query-note'), null);
    });

    it('asks for the table\'s statistics with no table name, as before', () => {
      const { dom, postedMessages } = loadWebview();
      sendCsvData(dom, csvWithSql());
      const request = posted(postedMessages, 'get-stats').at(-1)!;
      assert.ok(!('table' in request) && !('result' in request));
    });

    it('runs a query, shows its result as a table, and ✕ brings the table back with its filter', () => {
      const { dom, postedMessages } = loadWebview();
      sendCsvData(dom, csvWithSql());
      filterBox(dom).value = 'Ro';
      filterBox(dom).dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      const tableFilter = posted(postedMessages, 'filter').at(-1)!;
      assert.ok(!('table' in tableFilter) && !('result' in tableFilter), 'the file\'s own filter carries no address');

      doc(dom).querySelector<HTMLButtonElement>('.sql-toggle')!.click();
      doc(dom).querySelector<HTMLButtonElement>('.query-run')!.click();
      const run = posted(postedMessages, 'run-query').at(-1) as { seq: number; sql: string };
      assert.strictEqual(run.sql, 'select * from "sales-2024" limit 5');
      sendQueryData(dom, {
        seq: run.seq, result: run.seq, materializedRows: 1, truncated: false, elapsedMs: 5,
        data: { headers: ['n'], rows: [['7']], rowCount: 1, columnCount: 1 },
      });
      assert.ok(doc(dom).querySelector('.result-chip'));
      assert.strictEqual(posted(postedMessages, 'get-stats').at(-1)!.result, run.seq);
      assert.strictEqual(doc(dom).querySelectorAll('.table-area input.col-filter').length, 1);

      doc(dom).querySelector<HTMLButtonElement>('.result-chip-close')!.click();
      assert.strictEqual(doc(dom).querySelector('.result-chip'), null);
      assert.strictEqual(filterBox(dom).value, 'Ro');
      assert.deepStrictEqual(posted(postedMessages, 'close-result'), [{ type: 'close-result', seq: run.seq }]);
      assert.deepStrictEqual(posted(postedMessages, 'filter').at(-1)!.filters, [{ column: 0, text: 'Ro' }]);
    });

    it('keeps an error under the box and the table in place', () => {
      const { dom, postedMessages } = loadWebview();
      sendCsvData(dom, csvWithSql());
      doc(dom).querySelector<HTMLButtonElement>('.sql-toggle')!.click();
      doc(dom).querySelector<HTMLButtonElement>('.query-run')!.click();
      const run = posted(postedMessages, 'run-query').at(-1) as { seq: number };
      sendQueryData(dom, { seq: run.seq, error: 'Could not read the file with DuckDB 2.0.0: nope' });
      assert.match(doc(dom).querySelector('.query-message')?.textContent ?? '', /Could not read the file/);
      assert.strictEqual(doc(dom).querySelectorAll('.table-area #csv-table tbody tr').length, 2);
    });
  });

  describe('dbt awareness', () => {
    function payload(extra: Partial<MultiTableData> = {}, selectedTable = 'a'): MultiTableParseOutcome {
      return {
        success: true,
        errors: [],
        data: {
          tables: [
            { name: 'a', type: 'table' },
            { name: 'b', type: 'table' },
            { name: 'c', type: 'table' },
          ],
          selectedTable,
          data: {
            headers: ['id', 'Status', 'plain'],
            rows: [['1', 'new', 'x']],
            rowCount: 1,
            columnCount: 3,
          },
          capabilities: { refresh: true, query: true },
          ...extra,
        },
      };
    }
    const doc = (dom: JSDOM) => dom.window.document;
    const headerTh = (dom: JSDOM, name: string) =>
      Array.from(doc(dom).querySelectorAll<HTMLElement>('#csv-table thead tr:first-child th')).find(
        (th) => th.querySelector('.col-name')?.textContent === name
      )!;

    describe('column descriptions', () => {
      const descriptions = { id: 'Primary key of the order.', STATUS: 'new | paid' };

      it('puts them in the header tooltip (matching column names ignoring case) and marks the header', () => {
        const { dom } = loadWebview();
        sendDuckdbData(dom, payload({ columnDescriptions: descriptions }));
        assert.strictEqual(headerTh(dom, 'id').title, 'id\nPrimary key of the order.');
        assert.strictEqual(headerTh(dom, 'Status').title, 'Status\nnew | paid');
        assert.ok(headerTh(dom, 'id').classList.contains('has-description'));
        assert.strictEqual(headerTh(dom, 'plain').title, 'plain');
        assert.ok(!headerTh(dom, 'plain').classList.contains('has-description'));
      });

      it('leaves the header text itself untouched', () => {
        const { dom } = loadWebview();
        sendDuckdbData(dom, payload({ columnDescriptions: descriptions }));
        assert.strictEqual(headerTh(dom, 'id').querySelector('.col-name')?.textContent, 'id');
      });

      it('shows the description in the detail card', () => {
        const { dom } = loadWebview();
        replyStats = {
          columns: [
            { type: 'integer', nullCount: 0, distinctCount: 1, min: '1', max: '1', mean: 1 },
            { type: 'text', nullCount: 0, distinctCount: 1 },
            { type: 'text', nullCount: 0, distinctCount: 1 },
          ],
        };
        sendDuckdbData(dom, payload({ columnDescriptions: descriptions }));
        const strips = doc(dom).querySelectorAll<HTMLButtonElement>('button.col-profile');
        assert.strictEqual(strips.length, 3);
        strips[0].click();
        assert.strictEqual(doc(dom).querySelector('.stats-card .card-description')?.textContent, 'Primary key of the order.');
        strips[2].click();
        assert.strictEqual(doc(dom).querySelector('.stats-card .card-description'), null, 'no description, no paragraph');
      });

      it('treats the text as text, never markup', () => {
        const { dom } = loadWebview();
        sendDuckdbData(dom, payload({ columnDescriptions: { id: '<img src=x onerror=alert(1)>' } }));
        assert.strictEqual(doc(dom).querySelector('#csv-table img'), null);
        assert.strictEqual(headerTh(dom, 'id').title, 'id\n<img src=x onerror=alert(1)>');
      });

      it('shows none for a table without descriptions', () => {
        const { dom } = loadWebview();
        sendDuckdbData(dom, payload());
        assert.strictEqual(doc(dom).querySelectorAll('th.has-description').length, 0);
      });

    });

    describe('a table chosen by the host (Preview Model)', () => {
      const pick = (dom: JSDOM, name: string) => {
        const app = doc(dom).getElementById('app')!;
        openPickerPopup(app);
        Array.from(app.querySelectorAll<HTMLElement>('.table-picker-option'))
          .find((o) => o.querySelector('.picker-name')?.textContent === name)!
          .click();
      };
      const shown = (dom: JSDOM) => pickerCurrent(doc(dom).getElementById('app')!);

      it('is shown even though it differs from the last pick still in flight, which then counts as stale', () => {
        const { dom } = loadWebview();
        sendDuckdbData(dom, payload());
        pick(dom, 'b'); // the user's pick is on its way...
        sendDuckdbData(dom, payload({ hostSelected: true }, 'c')); // ...when the command pushes c
        assert.strictEqual(shown(dom), 'c');
        sendDuckdbData(dom, payload({}, 'b')); // the reply to the pick arrives late
        assert.strictEqual(shown(dom), 'c', 'the late reply must not undo the host choice');
      });

      it('is shown when the user had picked another table before, and later replies for that one are stale', () => {
        const { dom } = loadWebview();
        sendDuckdbData(dom, payload());
        pick(dom, 'b');
        sendDuckdbData(dom, payload({}, 'b'));
        sendDuckdbData(dom, payload({ hostSelected: true }, 'a'));
        assert.strictEqual(shown(dom), 'a');
      });

      it('does not change how an ordinary stale reply is dropped', () => {
        const { dom } = loadWebview();
        sendDuckdbData(dom, payload());
        pick(dom, 'b');
        sendDuckdbData(dom, payload({}, 'a')); // not host-selected, not the pick
        assert.strictEqual(shown(dom), 'b');
      });
    });
  });

  describe('table picker', () => {
    const tableData = { headers: ['id'], rows: [['1']], rowCount: 1, columnCount: 1 };

    function sendTables(
      dom: JSDOM,
      tables: TableRef[],
      selectedTable = tables[0].name
    ): HTMLElement {
      sendDuckdbData(dom, { success: true, errors: [], data: { tables, selectedTable, data: tableData } });
      return dom.window.document.getElementById('app')!;
    }

    const mixed: TableRef[] = [
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

    describe('tables in several schemas', () => {
      const warehouse: TableRef[] = [
        { name: 'raw_events', type: 'table', approxRows: 2 },
        { name: 'main_marts.orders', type: 'table', schema: 'main_marts', table: 'orders', approxRows: 1500 },
        { name: 'main_staging.orders', type: 'table', schema: 'main_staging', table: 'orders', approxRows: 3 },
        { name: 'main_staging.stg_events', type: 'view', schema: 'main_staging', table: 'stg_events' },
      ];
      const groupTexts = (app: HTMLElement) =>
        Array.from(app.querySelectorAll('.table-picker-group')).map((g) => g.textContent);

      it('groups by schema with counts (main first) and shows the short table name', () => {
        const { dom } = loadWebview();
        const app = sendTables(dom, warehouse);
        openPickerPopup(app);
        assert.deepStrictEqual(groupTexts(app), ['main (1)', 'main_marts (1)', 'main_staging (2)']);
        assert.deepStrictEqual(listedNames(app), ['raw_events', 'orders', 'orders', 'stg_events']);
      });

      it('picks the table by its qualified name, so same-named tables stay apart', () => {
        const { dom, postedMessages } = loadWebview();
        const app = sendTables(dom, warehouse);
        openPickerPopup(app);
        app.querySelectorAll<HTMLElement>('.table-picker-option')[2].click();
        assert.deepStrictEqual(postedMessages.filter((m) => (m as { type: string }).type === 'select-table'), [
          { type: 'select-table', table: 'main_staging.orders' },
        ]);
      });

      it('shows the qualified name on the trigger', () => {
        const { dom } = loadWebview();
        const app = sendTables(dom, warehouse, 'main_marts.orders');
        assert.strictEqual(pickerCurrent(app), 'main_marts.orders');
      });

      it('searches the schema part too', () => {
        const { dom } = loadWebview();
        const app = sendTables(dom, warehouse);
        const popup = openPickerPopup(app);
        typeInPicker(dom, popup, 'staging');
        assert.deepStrictEqual(groupTexts(app), ['main_staging (2)']);
        assert.deepStrictEqual(listedNames(app), ['orders', 'stg_events']);
      });

      it('finds the main tables under the "main" header by that name', () => {
        const { dom } = loadWebview();
        const app = sendTables(dom, warehouse);
        const popup = openPickerPopup(app);
        typeInPicker(dom, popup, 'main.');
        assert.deepStrictEqual(groupTexts(app), ['main (1)']);
        assert.deepStrictEqual(listedNames(app), ['raw_events']);
        typeInPicker(dom, popup, 'main.raw');
        assert.deepStrictEqual(listedNames(app), ['raw_events']);
        typeInPicker(dom, popup, 'raw_ev');
        assert.deepStrictEqual(listedNames(app), ['raw_events'], 'the plain name still works');
      });

      it('lists a single non-main schema flat, with qualified names', () => {
        const { dom } = loadWebview();
        const app = sendTables(dom, [
          { name: 'staging.a', type: 'table', schema: 'staging', table: 'a' },
          { name: 'staging.b', type: 'table', schema: 'staging', table: 'b' },
        ]);
        openPickerPopup(app);
        assert.strictEqual(app.querySelector('.table-picker-group'), null);
        assert.deepStrictEqual(listedNames(app), ['staging.a', 'staging.b']);
      });
    });

    describe('row-count hints', () => {
      it('shows an approximate count for tables that have one, and none for views', () => {
        const { dom } = loadWebview();
        const app = sendTables(dom, [
          { name: 'small', type: 'table', approxRows: 3 },
          { name: 'big', type: 'table', approxRows: 1500 },
          { name: 'v', type: 'view' },
        ]);
        openPickerPopup(app);
        const options = Array.from(app.querySelectorAll('.table-picker-option'));
        const meta = options.map((o) => o.querySelector('.picker-meta')?.textContent ?? null);
        assert.strictEqual(meta[0], '~3');
        assert.match(meta[1] ?? '', /^~1[.,]5/);
        assert.strictEqual(meta[2], null);
        assert.strictEqual(options[0].getAttribute('title'), 'small · about 3 rows');
        assert.strictEqual(options[2].getAttribute('title'), 'v');
      });

      it('says "1 row", not "1 rows"', () => {
        const { dom } = loadWebview();
        const app = sendTables(dom, [{ name: 'one', type: 'table', approxRows: 1 }]);
        openPickerPopup(app);
        assert.strictEqual(app.querySelector('.table-picker-option')?.getAttribute('title'), 'one · about 1 row');
      });

      it('leaves sources without estimates (SQLite, Excel) untouched', () => {
        const { dom } = loadWebview();
        const app = sendTables(dom, mixed);
        openPickerPopup(app);
        assert.strictEqual(app.querySelector('.picker-meta'), null);
      });
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
  /** Which kind a strip's badge shows (the badge carries it as `data-kind`; its icon has no text). */
  const badgeKind = (strip: Element): string | null | undefined =>
    strip.querySelector('.type-badge')?.getAttribute('data-kind');
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
      // Answers the newest request, like a host would, unless the test names a seq itself.
      const answer =
        typeof payload === 'object' && payload !== null && !('seq' in payload)
          ? { ...payload, seq: lastStatsRequestSeq }
          : payload;
      dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { type: 'stats-data', payload: answer } }));
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
      assert.deepStrictEqual(postedMessages, [{ type: 'ready' }, { type: 'get-stats', seq: 1 }]);
    });

    it('names the selected table for a multi-table source', () => {
      const { dom, postedMessages } = loadWebview();
      sendMulti(dom, 'orders', table(), ['customers', 'orders']);
      assert.deepStrictEqual(getStats(postedMessages), [{ type: 'get-stats', seq: 1, table: 'orders' }]);
      assert.strictEqual(strips(dom).length, 2);
    });

    it('asks again for each newly shown table', () => {
      const { dom, postedMessages } = loadWebview();
      sendMulti(dom, 'a', table(), ['a', 'b']);
      sendMulti(dom, 'b', table(), ['a', 'b']);
      assert.deepStrictEqual(getStats(postedMessages), [
        { type: 'get-stats', seq: 1, table: 'a' },
        { type: 'get-stats', seq: 2, table: 'b' },
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

      it("drops a slower answer for the same table's previous view (a refresh re-rendered it meanwhile)", () => {
        const { dom, postedMessages } = loadWebview(undefined, () => undefined);
        sendMulti(dom, 'a', table(), ['a', 'b']);
        const oldSeq = (postedMessages.filter((m) => (m as { type: string }).type === 'get-stats').at(-1) as { seq: number }).seq;
        sendMulti(dom, 'a', table(), ['a', 'b']); // the reload's render of the same table
        const newSeq = (postedMessages.filter((m) => (m as { type: string }).type === 'get-stats').at(-1) as { seq: number }).seq;
        assert.notStrictEqual(newSeq, oldSeq);

        deliver(dom, { table: 'a', seq: oldSeq, stats: twoColumnStats });
        assert.strictEqual(doc(dom).querySelector('.col-profile'), null, 'pre-refresh numbers must not land on the new view');
        assert.strictEqual(text(doc(dom).querySelector('.stats-status')), 'Computing…');

        deliver(dom, { table: 'a', seq: newSeq, stats: twoColumnStats });
        assert.strictEqual(doc(dom).querySelectorAll('.col-profile').length, 2);
      });

      it('drops an answer that carries no seq at all', () => {
        const { dom } = loadWebview(undefined, () => undefined);
        send(dom, table());
        dom.window.dispatchEvent(
          new dom.window.MessageEvent('message', { data: { type: 'stats-data', payload: { stats: twoColumnStats } } })
        );
        assert.strictEqual(doc(dom).querySelector('.col-profile'), null);
      });

      it('numbers requests so that no two share a seq, across tables', () => {
        const { dom, postedMessages } = loadWebview(undefined, () => undefined);
        sendMulti(dom, 'a', table(), ['a', 'b']);
        sendMulti(dom, 'b', table(), ['a', 'b']);
        const seqs = postedMessages
          .filter((m) => (m as { type: string }).type === 'get-stats')
          .map((m) => (m as { seq: number }).seq);
        assert.strictEqual(new Set(seqs).size, seqs.length);
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

  describe('type icons', () => {
    const badge = (strip: Element) => strip.querySelector<HTMLElement>('.type-badge')!;

    it('draws every kind as its own SVG icon, with no text in the badge', () => {
      const { dom } = loadWebview();
      const kinds = ['integer', 'float', 'boolean', 'date', 'text', 'mixed', 'other', 'empty'] as const;
      send(dom, tableOf(kinds.map((type) => ({ type, nullCount: 0, distinctCount: 1 }))));
      const shapes = kinds.map((_, i) => {
        const b = badge(profile(dom, i)!);
        assert.strictEqual(b.textContent, '', 'the icon is not a text glyph');
        const svg = b.querySelector('svg.type-icon');
        assert.ok(svg, `${kinds[i]} has an icon`);
        assert.strictEqual(svg.getAttribute('aria-hidden'), 'true');
        return svg.innerHTML;
      });
      assert.strictEqual(new Set(shapes).size, kinds.length, 'no two kinds share a drawing');
    });

    it('names the type for assistive technology and the tooltip', () => {
      const { dom } = loadWebview();
      send(dom, table());
      const b = badge(profile(dom, 0)!);
      assert.strictEqual(b.getAttribute('role'), 'img');
      assert.strictEqual(b.getAttribute('aria-label'), 'integer');
      assert.strictEqual(b.title, 'integer');
    });

    it("adds the source's own type to the badge, the summary and the card when the host sent one", () => {
      const { dom } = loadWebview();
      send(dom, tableOf([
        { type: 'integer', nullCount: 0, distinctCount: 2, nativeType: 'BIGINT' },
        { type: 'float', nullCount: 0, distinctCount: 2, nativeType: 'DECIMAL(10,2)' },
      ]));
      const strip = profile(dom, 0)!;
      assert.strictEqual(badge(strip).title, 'integer · BIGINT');
      assert.strictEqual(badge(strip).getAttribute('aria-label'), 'integer · BIGINT');
      assert.match(strip.getAttribute('aria-label') ?? '', /^Details for c0: integer, BIGINT, /);
      strip.click();
      assert.strictEqual(text(doc(dom).querySelector('.card-sub')), 'integer · BIGINT');
    });

    it('treats the native type as text, never markup', () => {
      const { dom } = loadWebview();
      send(dom, tableOf([{ type: 'text', nullCount: 0, distinctCount: 1, nativeType: '<img src=x onerror=alert(1)>' }]));
      assert.strictEqual(doc(dom).querySelector('img'), null);
      assert.strictEqual(badge(profile(dom, 0)!).title, 'text · <img src=x onerror=alert(1)>');
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
      assert.strictEqual(badgeKind(strip), 'integer');
      assert.strictEqual(strip.querySelector('.nullbar-valid')?.getAttribute('width'), '100');
      assert.strictEqual(strip.querySelector('.null-pct'), null, 'no nulls, no percentage');
      assert.strictEqual(strip.querySelectorAll('svg.hist-mini rect').length, 2);
      assert.strictEqual(strip.querySelector('svg.hist-mini title'), null, 'tooltips live in the card');
    });

    it('sizes the valid part of the null bar and shows the null percentage', () => {
      const { dom } = loadWebview();
      send(dom, table());
      const strip = profile(dom, 1)!; // 1 null in 2 rows
      assert.strictEqual(badgeKind(strip), 'text');
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
        [0, 1, 2, 3, 4].map((i) => badgeKind(profile(dom, i)!)),
        ['date', 'boolean', 'mixed', 'other', 'empty']
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

  describe('row virtualization', () => {
    const ROW_HEIGHT = 20;
    const VIEWPORT = 400;
    const doc = (dom: JSDOM) => dom.window.document;

    /** A DOM with "layout": a tbody is as tall as its rows, the scroll wrapper is VIEWPORT high. */
    function loadWithLayout(rowHeight = ROW_HEIGHT) {
      const loaded = loadWebview();
      const win = loaded.dom.window as unknown as {
        Element: { prototype: { getBoundingClientRect: () => unknown } };
        HTMLElement: { prototype: object };
      };
      win.Element.prototype.getBoundingClientRect = function (this: Element) {
        const height = this.tagName === 'TBODY' ? this.children.length * rowHeight : 0;
        return { height, width: 0, top: 0, left: 0, right: 0, bottom: height, x: 0, y: 0 };
      };
      Object.defineProperty(win.HTMLElement.prototype, 'clientHeight', {
        configurable: true,
        get(this: HTMLElement) {
          return this.classList.contains('scroll-wrapper') ? VIEWPORT : 0;
        },
      });
      return loaded;
    }

    const manyRows = (count: number) => Array.from({ length: count }, (_, i) => [String(i + 1), `row ${i + 1}`]);
    const sendRows = (dom: JSDOM, rows: string[][]) =>
      sendCsvData(dom, {
        success: true,
        errors: [],
        data: { headers: ['n', 'label'], rows, rowCount: rows.length, columnCount: 2 },
      });
    const wrapper = (dom: JSDOM) => doc(dom).querySelector<HTMLElement>('.scroll-wrapper')!;
    const dataRows = (dom: JSDOM) => Array.from(doc(dom).querySelectorAll<HTMLElement>('#csv-table tbody tr:not(.row-spacer)'));
    const numbers = (dom: JSDOM) => dataRows(dom).map((tr) => Number(tr.querySelector('.row-num')!.textContent));
    const spacerHeights = (dom: JSDOM) =>
      Array.from(doc(dom).querySelectorAll<HTMLElement>('#csv-table tbody tr.row-spacer td')).map((td) => td.style.height);
    const scrollTo = async (dom: JSDOM, top: number) => {
      wrapper(dom).scrollTop = top;
      wrapper(dom).dispatchEvent(new dom.window.Event('scroll'));
      await new Promise((resolve) => setTimeout(resolve, 10));
    };

    it('draws only the rows around the viewport, between two spacers that hold the rest of the height', () => {
      const { dom } = loadWithLayout();
      sendRows(dom, manyRows(5000));
      const drawn = numbers(dom);
      // 400px / 20px = 20 visible rows, plus 30 of overscan below (none above the top)
      assert.deepStrictEqual([drawn[0], drawn.at(-1)], [1, 50]);
      assert.deepStrictEqual(spacerHeights(dom), ['0px', `${(5000 - 50) * ROW_HEIGHT}px`]);
      assert.strictEqual(doc(dom).querySelectorAll('#csv-table tbody tr').length, 52);
    });

    it('still says how many rows there are, and the table keeps its fixed layout', () => {
      const { dom } = loadWithLayout();
      sendRows(dom, manyRows(5000));
      assert.match(doc(dom).querySelector('.stats-bar')?.textContent ?? '', /^5000 rows × 2 columns/);
      assert.ok(doc(dom).querySelector('#csv-table')?.classList.contains('table-fixed'));
    });

    it('moves the window when the table scrolls, keeping row numbers true', async () => {
      const { dom } = loadWithLayout();
      sendRows(dom, manyRows(5000));
      await scrollTo(dom, 50000); // row index 2500
      const drawn = numbers(dom);
      assert.strictEqual(drawn[0], 2500 - 30 + 1);
      assert.ok(drawn.includes(2501), 'the row at the top of the viewport is drawn');
      assert.ok(drawn.includes(2520), 'and the last one in view');
      assert.strictEqual(dataRows(dom)[0].querySelector('td:not(.row-num)')?.textContent, String(drawn[0]), 'the cells match their number');
      assert.deepStrictEqual(spacerHeights(dom), [`${(drawn[0] - 1) * ROW_HEIGHT}px`, `${(5000 - drawn.at(-1)!) * ROW_HEIGHT}px`]);
    });

    it('does not redraw for a small scroll, only once the viewport nears an edge of what is drawn', async () => {
      const { dom } = loadWithLayout();
      sendRows(dom, manyRows(5000));
      const before = dataRows(dom)[0];
      await scrollTo(dom, 3 * ROW_HEIGHT);
      assert.strictEqual(dataRows(dom)[0], before, 'the same elements: nothing was redrawn');
      await scrollTo(dom, 25 * ROW_HEIGHT); // the viewport's bottom is now within the margin of row 50
      assert.notStrictEqual(dataRows(dom)[0], before);
    });

    it('scrolls all the way to the last row', async () => {
      const { dom } = loadWithLayout();
      sendRows(dom, manyRows(5000));
      await scrollTo(dom, 5000 * ROW_HEIGHT - VIEWPORT);
      assert.strictEqual(numbers(dom).at(-1), 5000);
      assert.strictEqual(spacerHeights(dom)[1], '0px');
    });

    it('stripes by row number, not by position in the window', async () => {
      const { dom } = loadWithLayout();
      sendRows(dom, manyRows(5000));
      const stripes = () =>
        dataRows(dom).map((tr): [number, boolean] => [Number(tr.querySelector('.row-num')!.textContent), tr.classList.contains('alt')]);
      for (const [number, alt] of stripes()) { assert.strictEqual(alt, number % 2 === 0, `row ${number}`); }
      await scrollTo(dom, 50000 + ROW_HEIGHT); // an odd shift
      for (const [number, alt] of stripes()) { assert.strictEqual(alt, number % 2 === 0, `row ${number} after scrolling`); }
    });

    it('draws a table of up to 500 rows in full, with no spacers', () => {
      const { dom } = loadWithLayout();
      sendRows(dom, manyRows(500));
      assert.strictEqual(dataRows(dom).length, 500);
      assert.deepStrictEqual(spacerHeights(dom), []);
    });

    it('draws everything when a row cannot be measured (no layout, e.g. a hidden panel)', () => {
      const { dom } = loadWebview();
      sendRows(dom, manyRows(800));
      assert.strictEqual(doc(dom).querySelectorAll('#csv-table tbody tr').length, 800);
      assert.deepStrictEqual(spacerHeights(dom), []);
    });

    it('treats cell text as text in a window just as in a full table', () => {
      const { dom } = loadWithLayout();
      const rows = manyRows(1000);
      rows[0] = ['<img src=x onerror=alert(1)>', 'b'];
      sendRows(dom, rows);
      assert.strictEqual(doc(dom).querySelector('#csv-table tbody img'), null);
      assert.strictEqual(dataRows(dom)[0].querySelector('td:not(.row-num)')?.textContent, '<img src=x onerror=alert(1)>');
    });

    it('ignores Alt+click on a spacer', () => {
      const { dom, postedMessages } = loadWithLayout();
      sendRows(dom, manyRows(5000));
      const before = postedMessages.length;
      const spacer = doc(dom).querySelector<HTMLElement>('#csv-table tbody tr.row-spacer td')!;
      spacer.dispatchEvent(new dom.window.MouseEvent('click', { altKey: true, bubbles: true }));
      assert.strictEqual(postedMessages.length, before);
    });

    describe('with a filter', () => {
      const filterReply = (dom: JSDOM, seq: number, rows: string[][], matchCount: number) =>
        dom.window.dispatchEvent(
          new dom.window.MessageEvent('message', { data: { type: 'filter-data', payload: { seq, rows, matchCount } } })
        );
      const filterBox = (dom: JSDOM) => doc(dom).querySelector<HTMLInputElement>('input.col-filter')!;
      const lastSeq = (posted: unknown[]) =>
        (posted.filter((m) => (m as { type: string }).type === 'filter').at(-1) as { seq: number }).seq;
      function filtered(posted: unknown[], dom: JSDOM) {
        filterBox(dom).value = 'x';
        filterBox(dom).dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        return lastSeq(posted);
      }

      it('windows a long answer from the top and numbers it 1..N', async () => {
        const { dom, postedMessages } = loadWithLayout();
        sendRows(dom, manyRows(5000));
        await scrollTo(dom, 40000);
        filterReply(dom, filtered(postedMessages, dom), manyRows(3000), 3000);
        assert.strictEqual(wrapper(dom).scrollTop, 0);
        const drawn = numbers(dom);
        assert.deepStrictEqual([drawn[0], drawn.at(-1)], [1, 50]);
        assert.strictEqual(spacerHeights(dom)[1], `${(3000 - 50) * ROW_HEIGHT}px`);
      });

      it('draws a short answer in full with no spacers, and the original windowed rows come back on clear', async () => {
        const { dom, postedMessages } = loadWithLayout();
        sendRows(dom, manyRows(5000));
        filterReply(dom, filtered(postedMessages, dom), manyRows(7), 7);
        assert.strictEqual(dataRows(dom).length, 7);
        assert.deepStrictEqual(spacerHeights(dom), []);
        filterBox(dom).value = '';
        filterBox(dom).dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        assert.strictEqual(numbers(dom).at(-1), 50);
        assert.strictEqual(spacerHeights(dom).length, 2);
      });
    });

    it('puts a refresh back at the scroll position the user was at', () => {
      const { dom } = loadWithLayout();
      const payload = (): MultiTableParseOutcome => ({
        success: true,
        errors: [],
        data: {
          tables: [{ name: 'a', type: 'table' }],
          selectedTable: 'a',
          data: { headers: ['n', 'label'], rows: manyRows(5000), rowCount: 5000, columnCount: 2 },
          capabilities: { refresh: true },
          reload: { at: '2026-11-19T10:00:00.000Z', previousRowCount: 5000 },
        },
      });
      sendDuckdbData(dom, payload());
      wrapper(dom).scrollTop = 20000; // row index 1000
      sendDuckdbData(dom, payload());
      assert.strictEqual(wrapper(dom).scrollTop, 20000);
      const drawn = numbers(dom);
      assert.ok(drawn[0] <= 1001 && drawn.at(-1)! >= 1020, `the window around row 1000 is drawn, got ${drawn[0]}..${drawn.at(-1)}`);
    });

    it('windows a SQL result too', () => {
      const { dom, postedMessages } = loadWithLayout();
      sendDuckdbData(dom, {
        success: true,
        errors: [],
        data: {
          tables: [{ name: 'a', type: 'table' }],
          selectedTable: 'a',
          data: { headers: ['n', 'label'], rows: [['1', 'x']], rowCount: 1, columnCount: 2 },
          capabilities: { refresh: true, query: true },
        },
      });
      doc(dom).querySelector<HTMLButtonElement>('.sql-toggle')!.click();
      doc(dom).querySelector<HTMLTextAreaElement>('.query-input')!.value = 'select 1';
      doc(dom).querySelector<HTMLTextAreaElement>('.query-input')!.dispatchEvent(new dom.window.Event('input'));
      doc(dom).querySelector<HTMLButtonElement>('.query-run')!.click();
      const seq = (postedMessages.filter((m) => (m as { type: string }).type === 'run-query').at(-1) as { seq: number }).seq;
      dom.window.dispatchEvent(
        new dom.window.MessageEvent('message', {
          data: { type: 'query-data', payload: { seq, data: { headers: ['n', 'label'], rows: manyRows(4000), rowCount: 4000, columnCount: 2 }, truncated: false, elapsedMs: 5 } },
        })
      );
      assert.strictEqual(doc(dom).querySelectorAll('.table-area #csv-table tbody tr').length, 52);
    });
  });

  describe('selection', () => {
    const rows = [
      ['1', 'a', '10'],
      ['2', 'b', '20.5'],
      ['3', 'c', 'x'],
      ['4', 'd', '40'],
      ['5', 'e', ''],
    ];
    const doc = (dom: JSDOM) => dom.window.document;

    function open(data: string[][] = rows) {
      const loaded = loadWebview();
      sendCsvData(loaded.dom, {
        success: true,
        errors: [],
        data: { headers: ['n', 'label', 'score'], rows: data, rowCount: data.length, columnCount: 3 },
      });
      return loaded;
    }
    const body = (dom: JSDOM) => doc(dom).querySelector<HTMLTableSectionElement>('#csv-table tbody')!;
    const cell = (dom: JSDOM, r: number, c: number) => body(dom).rows[r].cells[c + 1];
    const gutter = (dom: JSDOM, r: number) => body(dom).rows[r].cells[0];
    const header = (dom: JSDOM, c: number) => doc(dom).querySelectorAll<HTMLElement>('#csv-table thead tr:first-child th')[c + 1];
    const colName = (dom: JSDOM, c: number) => header(dom, c).querySelector('.col-name')!;
    const wrapper = (dom: JSDOM) => doc(dom).querySelector<HTMLElement>('.scroll-wrapper')!;
    const summary = (dom: JSDOM) => doc(dom).querySelector<HTMLElement>('.selection-summary')!;
    /** The "r,c" of every drawn cell that is selected. */
    const selected = (dom: JSDOM) => {
      const out: string[] = [];
      Array.from(body(dom).rows).forEach((tr, r) => {
        Array.from(tr.cells).slice(1).forEach((td, c) => {
          if (td.classList.contains('is-selected')) { out.push(`${r},${c}`); }
        });
      });
      return out;
    };
    const mouse = (dom: JSDOM, type: string, target: Element, init: Record<string, unknown> = {}) => {
      const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init });
      target.dispatchEvent(event);
      return event;
    };
    const click = (dom: JSDOM, target: Element, init: Record<string, unknown> = {}) => mouse(dom, 'mousedown', target, init);
    const key = (dom: JSDOM, k: string, init: Record<string, unknown> = {}) => {
      const event = new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
      wrapper(dom).dispatchEvent(event);
      return event;
    };
    /** Fires `copy` with a clipboard stub and returns what was put on it (undefined = left alone). */
    function copy(dom: JSDOM): string | undefined {
      let text: string | undefined;
      const event = new dom.window.Event('copy', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', { value: { setData: (_type: string, value: string) => { text = value; } } });
      doc(dom).dispatchEvent(event);
      return text;
    }

    describe('with the mouse', () => {
      it('selects a cell on click and replaces the selection on the next click', () => {
        const { dom } = open();
        click(dom, cell(dom, 1, 1));
        assert.deepStrictEqual(selected(dom), ['1,1']);
        assert.ok(cell(dom, 1, 1).classList.contains('is-cursor'));
        click(dom, cell(dom, 3, 2));
        assert.deepStrictEqual(selected(dom), ['3,2']);
        assert.strictEqual(summary(dom).hidden, true, 'one cell needs no summary');
      });

      it('takes keyboard focus and stops the native text selection', () => {
        const { dom } = open();
        const event = click(dom, cell(dom, 0, 0));
        assert.strictEqual(event.defaultPrevented, true);
        assert.strictEqual(doc(dom).activeElement, wrapper(dom));
      });

      it('selects a whole row from its number, and a whole column from its name', () => {
        const { dom } = open();
        click(dom, gutter(dom, 2));
        assert.deepStrictEqual(selected(dom), ['2,0', '2,1', '2,2']);
        assert.ok(gutter(dom, 2).classList.contains('is-selected'));
        click(dom, colName(dom, 1));
        assert.deepStrictEqual(selected(dom), ['0,1', '1,1', '2,1', '3,1', '4,1']);
        assert.ok(header(dom, 1).classList.contains('is-selected'));
        assert.ok(!gutter(dom, 2).classList.contains('is-selected'), 'the row highlight is gone');
      });

      it('selects everything from the corner cell', () => {
        const { dom } = open();
        click(dom, doc(dom).querySelector('#csv-table thead th.row-num')!);
        assert.strictEqual(selected(dom).length, 15);
        assert.strictEqual(summary(dom).textContent?.startsWith('15 cells selected'), true);
      });

      it('extends from the anchor with Shift, as a rectangle, a block of rows or a block of columns', () => {
        const { dom } = open();
        click(dom, cell(dom, 1, 0));
        click(dom, cell(dom, 3, 1), { shiftKey: true });
        assert.deepStrictEqual(selected(dom), ['1,0', '1,1', '2,0', '2,1', '3,0', '3,1']);
        click(dom, gutter(dom, 1));
        click(dom, gutter(dom, 3), { shiftKey: true });
        assert.strictEqual(selected(dom).length, 9);
        click(dom, colName(dom, 0));
        click(dom, colName(dom, 1), { shiftKey: true });
        assert.strictEqual(selected(dom).length, 10);
      });

      it('adds further ranges with Cmd or Ctrl', () => {
        const { dom } = open();
        click(dom, cell(dom, 0, 0));
        click(dom, cell(dom, 4, 2), { metaKey: true });
        click(dom, cell(dom, 2, 1), { ctrlKey: true });
        assert.deepStrictEqual(selected(dom), ['0,0', '2,1', '4,2']);
      });

      it('sweeps with a drag, and stops when the button is released', () => {
        const { dom } = open();
        click(dom, cell(dom, 0, 0));
        mouse(dom, 'mousemove', cell(dom, 2, 1), { buttons: 1 });
        assert.deepStrictEqual(selected(dom), ['0,0', '0,1', '1,0', '1,1', '2,0', '2,1']);
        mouse(dom, 'mouseup', cell(dom, 2, 1));
        mouse(dom, 'mousemove', cell(dom, 4, 2), { buttons: 1 });
        assert.strictEqual(selected(dom).length, 6, 'no longer dragging');
      });

      it('sweeps rows when dragging from a row number', () => {
        const { dom } = open();
        click(dom, gutter(dom, 1));
        mouse(dom, 'mousemove', cell(dom, 3, 2), { buttons: 1 });
        assert.strictEqual(selected(dom).length, 9);
        assert.ok(gutter(dom, 3).classList.contains('is-selected'));
      });

      it('leaves Alt+click to the filter, and the filter boxes and the right button alone', () => {
        const { dom } = open();
        click(dom, cell(dom, 1, 1), { altKey: true });
        assert.deepStrictEqual(selected(dom), []);
        click(dom, doc(dom).querySelector('input.col-filter')!);
        assert.deepStrictEqual(selected(dom), []);
        click(dom, cell(dom, 1, 1), { button: 2 });
        assert.deepStrictEqual(selected(dom), []);
      });
    });

    describe('with the keyboard', () => {
      it('leaves the arrow keys to native scrolling until something is selected', () => {
        const { dom } = open();
        assert.strictEqual(key(dom, 'ArrowDown').defaultPrevented, false);
        click(dom, cell(dom, 0, 0));
        assert.strictEqual(key(dom, 'ArrowDown').defaultPrevented, true);
      });

      it('moves the cursor cell and stays inside the table', () => {
        const { dom } = open();
        click(dom, cell(dom, 0, 0));
        key(dom, 'ArrowUp');
        key(dom, 'ArrowLeft');
        assert.deepStrictEqual(selected(dom), ['0,0']);
        key(dom, 'ArrowDown');
        key(dom, 'ArrowRight');
        assert.deepStrictEqual(selected(dom), ['1,1']);
        key(dom, 'End');
        assert.deepStrictEqual(selected(dom), ['1,2']);
        key(dom, 'Home');
        assert.deepStrictEqual(selected(dom), ['1,0']);
        key(dom, 'ArrowDown', { ctrlKey: true });
        assert.deepStrictEqual(selected(dom), ['4,0']);
        key(dom, 'ArrowUp', { metaKey: true });
        assert.deepStrictEqual(selected(dom), ['0,0']);
        for (let i = 0; i < 10; i++) { key(dom, 'ArrowDown'); key(dom, 'ArrowRight'); }
        assert.deepStrictEqual(selected(dom), ['4,2']);
      });

      it('extends with Shift+arrows', () => {
        const { dom } = open();
        click(dom, cell(dom, 1, 1));
        key(dom, 'ArrowDown', { shiftKey: true });
        key(dom, 'ArrowRight', { shiftKey: true });
        assert.deepStrictEqual(selected(dom), ['1,1', '1,2', '2,1', '2,2']);
        key(dom, 'ArrowUp', { shiftKey: true });
        key(dom, 'ArrowLeft', { shiftKey: true });
        assert.deepStrictEqual(selected(dom), ['1,1']);
      });

      it('keeps a row selection whole while Shift+arrows extend it', () => {
        const { dom } = open();
        click(dom, gutter(dom, 1));
        key(dom, 'ArrowDown', { shiftKey: true });
        assert.strictEqual(selected(dom).length, 6);
      });

      it('selects all with Cmd/Ctrl+A, and Escape clears', () => {
        const { dom } = open();
        key(dom, 'a', { metaKey: true });
        assert.strictEqual(selected(dom).length, 15);
        key(dom, 'Escape');
        assert.deepStrictEqual(selected(dom), []);
        assert.strictEqual(summary(dom).hidden, true);
      });

      it('does not take keys typed in a filter box', () => {
        const { dom } = open();
        click(dom, cell(dom, 0, 0));
        const box = doc(dom).querySelector<HTMLInputElement>('input.col-filter')!;
        const event = new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true });
        box.dispatchEvent(event);
        assert.strictEqual(event.defaultPrevented, false);
        assert.deepStrictEqual(selected(dom), ['0,0']);
      });
    });

    describe('the summary', () => {
      it('counts the cells, and adds the figures when every filled cell is a number', () => {
        const { dom } = open();
        click(dom, cell(dom, 0, 0));
        click(dom, cell(dom, 3, 0), { shiftKey: true }); // 1 2 3 4
        assert.strictEqual(summary(dom).textContent, '4 cells selected · Sum 10 · Avg 2.5 · Min 1 · Max 4');
        assert.strictEqual(summary(dom).hidden, false);
      });

      it('shows only the count once a cell is not a number, and skips blanks in the average', () => {
        const { dom } = open();
        click(dom, colName(dom, 2)); // 10, 20.5, x, 40 and a blank
        assert.strictEqual(summary(dom).textContent, '5 cells selected');
        click(dom, cell(dom, 3, 2));
        click(dom, cell(dom, 4, 2), { shiftKey: true }); // 40 and a blank
        assert.strictEqual(summary(dom).textContent, '2 cells selected · Sum 40 · Avg 40 · Min 40 · Max 40');
      });

      it('does not count a cell twice when two ranges overlap', () => {
        const { dom } = open();
        click(dom, cell(dom, 0, 0));
        click(dom, cell(dom, 1, 0), { shiftKey: true }); // 1, 2
        click(dom, cell(dom, 1, 0), { metaKey: true });
        click(dom, cell(dom, 2, 0), { metaKey: true, shiftKey: true }); // 2, 3 again
        assert.strictEqual(summary(dom).textContent, '3 cells selected · Sum 6 · Avg 2 · Min 1 · Max 3');
      });

      it('is not inside the stats bar', () => {
        const { dom } = open();
        key(dom, 'a', { metaKey: true });
        assert.strictEqual(doc(dom).querySelector('.stats-bar')?.textContent, '5 rows × 3 columns');
      });
    });

    describe('copying', () => {
      it('puts a cell, a block or several blocks on the clipboard as tab-separated text', () => {
        const { dom } = open();
        click(dom, cell(dom, 1, 1));
        assert.strictEqual(copy(dom), 'b');
        click(dom, cell(dom, 0, 0));
        click(dom, cell(dom, 1, 1), { shiftKey: true });
        assert.strictEqual(copy(dom), '1\ta\n2\tb');
        click(dom, cell(dom, 0, 0));
        click(dom, cell(dom, 4, 2), { metaKey: true });
        assert.strictEqual(copy(dom), '1\n');
      });

      it('copies whole rows and whole columns', () => {
        const { dom } = open();
        click(dom, gutter(dom, 3));
        assert.strictEqual(copy(dom), '4\td\t40');
        click(dom, colName(dom, 0));
        assert.strictEqual(copy(dom), '1\n2\n3\n4\n5');
      });

      it('quotes what a spreadsheet would: tabs, line breaks and quotes', () => {
        const { dom } = open([['a\tb', 'line\nbreak', 'say "hi"'], ['plain', '', 'x']]);
        key(dom, 'a', { metaKey: true });
        assert.strictEqual(copy(dom), '"a\tb"\t"line\nbreak"\t"say ""hi"""\nplain\t\tx');
      });

      it('adds the column names with Cmd/Ctrl+Shift+C', () => {
        const { dom } = open();
        click(dom, cell(dom, 0, 1));
        click(dom, cell(dom, 1, 2), { shiftKey: true });
        let copied: string | undefined;
        (doc(dom) as unknown as { execCommand: (name: string) => boolean }).execCommand = () => {
          copied = copy(dom);
          return true;
        };
        const event = key(dom, 'C', { metaKey: true, shiftKey: true });
        assert.strictEqual(event.defaultPrevented, true);
        assert.strictEqual(copied, 'label\tscore\na\t10\nb\t20.5');
        assert.strictEqual(copy(dom), 'a\t10\nb\t20.5', 'a plain copy afterwards has no header line');
      });

      it('leaves the clipboard alone with nothing selected, or while a text box has focus', () => {
        const { dom } = open();
        assert.strictEqual(copy(dom), undefined);
        click(dom, cell(dom, 0, 0));
        doc(dom).querySelector<HTMLInputElement>('input.col-filter')!.focus();
        assert.strictEqual(copy(dom), undefined);
      });
    });

    describe('when the rows change', () => {
      it('drops the selection when a filter swaps the rows', () => {
        const { dom, postedMessages } = open();
        click(dom, cell(dom, 0, 0));
        const box = doc(dom).querySelector<HTMLInputElement>('input.col-filter')!;
        box.value = 'a';
        box.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        const seq = (postedMessages.filter((m) => (m as { type: string }).type === 'filter').at(-1) as { seq: number }).seq;
        dom.window.dispatchEvent(
          new dom.window.MessageEvent('message', { data: { type: 'filter-data', payload: { seq, rows: [rows[0]], matchCount: 1 } } })
        );
        assert.deepStrictEqual(selected(dom), []);
        assert.strictEqual(summary(dom).hidden, true);
      });

      it('keeps the selection through a refresh, cut to the rows that remain', () => {
        const { dom } = loadWebview();
        const payload = (data: string[][]): MultiTableParseOutcome => ({
          success: true,
          errors: [],
          data: {
            tables: [{ name: 'a', type: 'table' }],
            selectedTable: 'a',
            data: { headers: ['n', 'label', 'score'], rows: data, rowCount: data.length, columnCount: 3 },
            capabilities: { refresh: true },
            reload: { at: '2026-11-19T10:00:00.000Z', previousRowCount: 5 },
          },
        });
        sendDuckdbData(dom, payload(rows));
        click(dom, cell(dom, 1, 0));
        click(dom, cell(dom, 4, 1), { shiftKey: true });
        sendDuckdbData(dom, payload(rows.slice(0, 3)));
        assert.deepStrictEqual(selected(dom), ['1,0', '1,1', '2,0', '2,1']);
      });
    });

    describe('in a large, virtualized table', () => {
      const ROW_HEIGHT = 20;
      const many = Array.from({ length: 5000 }, (_, i) => [String(i + 1), `row ${i + 1}`, String(i)]);
      function openLarge() {
        const loaded = loadWebview();
        const win = loaded.dom.window as unknown as {
          Element: { prototype: { getBoundingClientRect: () => unknown } };
          HTMLElement: { prototype: object };
        };
        win.Element.prototype.getBoundingClientRect = function (this: Element) {
          const height = this.tagName === 'TBODY' ? this.children.length * ROW_HEIGHT : 0;
          return { height, width: 0, top: 0, left: 0, right: 0, bottom: height, x: 0, y: 0 };
        };
        Object.defineProperty(win.HTMLElement.prototype, 'clientHeight', {
          configurable: true,
          get(this: HTMLElement) { return this.classList.contains('scroll-wrapper') ? 400 : 0; },
        });
        sendCsvData(loaded.dom, {
          success: true,
          errors: [],
          data: { headers: ['n', 'label', 'score'], rows: many, rowCount: many.length, columnCount: 3 },
        });
        return loaded;
      }

      it('copies rows that are not drawn: the data is copied, not the DOM', () => {
        const { dom } = openLarge();
        key(dom, 'a', { metaKey: true });
        const lines = (copy(dom) ?? '').split('\n');
        assert.strictEqual(lines.length, 5000);
        assert.strictEqual(lines[4999], '5000\trow 5000\t4999');
        assert.strictEqual(summary(dom).textContent, '15,000 cells selected');
      });

      // The first row of a windowed body is its top spacer.
      const drawnCell = (dom: JSDOM, r: number, c: number) => body(dom).rows[r + 1].cells[c + 1];
      const drawnGutter = (dom: JSDOM, r: number) => body(dom).rows[r + 1].cells[0];

      it('follows the cursor with the keyboard, drawing the rows it scrolls to', () => {
        const { dom } = openLarge();
        click(dom, drawnCell(dom, 0, 0));
        for (let i = 0; i < 6; i++) { key(dom, 'PageDown'); } // 19 rows a page: row index 114
        assert.strictEqual(wrapper(dom).scrollTop > 0, true, 'the table scrolled to keep the cursor in view');
        const cursor = doc(dom).querySelector('#csv-table td.is-cursor')!;
        assert.ok(cursor, 'the cursor cell is drawn and marked');
        assert.strictEqual((cursor.parentElement as HTMLTableRowElement).cells[0].textContent, '115');
      });

      it('keeps a row selection painted when the window moves away and back', async () => {
        const { dom } = openLarge();
        click(dom, drawnGutter(dom, 2));
        const scrollTo = async (top: number) => {
          wrapper(dom).scrollTop = top;
          wrapper(dom).dispatchEvent(new dom.window.Event('scroll'));
          await new Promise((resolve) => setTimeout(resolve, 10));
        };
        await scrollTo(50000);
        assert.strictEqual(selected(dom).length, 0, 'row 3 is not drawn any more');
        await scrollTo(0);
        assert.strictEqual(selected(dom).length, 3, 'and it is painted again when it is');
      });
    });
  });

  describe('sql highlighting', () => {
    const doc = (dom: JSDOM) => dom.window.document;

    function openBox(text = '') {
      const loaded = loadWebview();
      sendDuckdbData(loaded.dom, {
        success: true,
        errors: [],
        data: {
          tables: [{ name: 'a', type: 'table' }],
          selectedTable: 'a',
          data: { headers: ['id'], rows: [['1']], rowCount: 1, columnCount: 1 },
          capabilities: { refresh: true, query: true },
          querySuggestion: text,
        },
      });
      doc(loaded.dom).querySelector<HTMLButtonElement>('.sql-toggle')!.click();
      return loaded;
    }
    const input = (dom: JSDOM) => doc(dom).querySelector<HTMLTextAreaElement>('.query-input')!;
    const layer = (dom: JSDOM) => doc(dom).querySelector<HTMLElement>('.query-highlight')!;
    function type(dom: JSDOM, text: string) {
      input(dom).value = text;
      input(dom).dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    }
    /** The coloured pieces of the layer as [kind, text]; text outside any span is `plain`. */
    function pieces(dom: JSDOM): Array<[string, string]> {
      return Array.from(layer(dom).childNodes).map((node): [string, string] => {
        const span = node as HTMLElement;
        const kind = span.className ? span.className.replace('sql-', '') : 'plain';
        return [kind, node.textContent ?? ''];
      });
    }
    const colored = (dom: JSDOM) => pieces(dom).filter(([kind]) => kind !== 'plain');

    it('draws a coloured copy of the text under the box, which the screen reader ignores', () => {
      const { dom } = openBox('select 1');
      assert.strictEqual(layer(dom).getAttribute('aria-hidden'), 'true');
      assert.strictEqual(layer(dom).textContent, 'select 1');
      assert.ok(layer(dom).nextElementSibling === input(dom), 'the real control is the textarea, drawn above');
      assert.strictEqual(input(dom).getAttribute('wrap'), 'off');
    });

    it('colours keywords, names before a bracket, numbers, strings, comments, types and constants', () => {
      const { dom } = openBox('');
      type(dom, "SELECT count(*), 12.5, 'a b', \"Col\" FROM t -- note\nWHERE x::INTEGER IS NOT NULL /* c */");
      assert.deepStrictEqual(colored(dom), [
        ['keyword', 'SELECT'],
        ['function', 'count'],
        ['operator', '*'],
        ['number', '12.5'],
        ['string', "'a b'"],
        ['identifier', '"Col"'],
        ['keyword', 'FROM'],
        ['comment', '-- note'],
        ['keyword', 'WHERE'],
        ['operator', '::'],
        ['type', 'INTEGER'],
        ['keyword', 'IS'],
        ['keyword', 'NOT'],
        ['constant', 'NULL'],
        ['comment', '/* c */'],
      ]);
    });

    it('is case-insensitive about keywords and leaves ordinary names plain', () => {
      const { dom } = openBox('');
      type(dom, 'Select Name, selected from People');
      assert.deepStrictEqual(colored(dom), [['keyword', 'Select'], ['keyword', 'from']]);
    });

    it('keeps a keyword a keyword before a bracket, and a type a type', () => {
      const { dom } = openBox('');
      type(dom, 'x IN (1) CAST(y AS DECIMAL(10, 2))');
      assert.deepStrictEqual(
        colored(dom).filter(([kind]) => kind === 'keyword' || kind === 'type' || kind === 'function'),
        [['keyword', 'IN'], ['keyword', 'CAST'], ['keyword', 'AS'], ['type', 'DECIMAL']]
      );
    });

    it('reads a doubled quote as part of the string or name, not its end', () => {
      const { dom } = openBox('');
      type(dom, `'it''s' "a""b" 'x'`);
      assert.deepStrictEqual(colored(dom), [['string', "'it''s'"], ['identifier', '"a""b"'], ['string', "'x'"]]);
    });

    it('colours an unterminated string, block comment or dollar string to the end', () => {
      for (const [text, kind] of [["select 'abc", 'string'], ['select /* abc', 'comment'], ['select $$ abc', 'string'], ['select "abc', 'identifier']] as const) {
        const { dom } = openBox('');
        type(dom, text);
        assert.strictEqual(colored(dom).at(-1)?.[0], kind, text);
        assert.strictEqual(layer(dom).textContent, text);
      }
    });

    it('colours numbers in the forms SQL has them', () => {
      const { dom } = openBox('');
      type(dom, '1 2.5 .5 1e10 2.5E-3 0xFF');
      assert.deepStrictEqual(colored(dom).map(([, text]) => text), ['1', '2.5', '.5', '1e10', '2.5E-3', '0xFF']);
      assert.ok(colored(dom).every(([kind]) => kind === 'number'));
    });

    it('does not take digits inside a name for a number', () => {
      const { dom } = openBox('');
      type(dom, 'col1 t2.c3 x_1');
      assert.deepStrictEqual(colored(dom), []);
    });

    it('always reproduces the text exactly, whatever it holds', () => {
      const { dom } = openBox('');
      const samples = [
        '', ' ', '\n', 'select\n\n', "'", '"', '/*', '--', '$$', '$', '.', '..', '::', '-', 'a.b."c d".e',
        'sélèct 日本語 “quoted” 😀 from t', "it's", 'x\t\ty', '1.2.3', '0x', 'e1', '<>!=||', '\r\n',
        'select * from "a""b" where \'x\' = \'it\'\'s\' -- c\n/* d */ limit 5;',
      ];
      for (const text of samples) {
        type(dom, text);
        // What the box holds (a textarea turns "\r\n" into "\n" itself).
        const held = input(dom).value;
        const expected = held.endsWith('\n') ? held + ' ' : held;
        assert.strictEqual(layer(dom).textContent, expected, JSON.stringify(text));
      }
    });

    it('gives a text that ends in a line break one more character, so the last line is not lost', () => {
      const { dom } = openBox('');
      type(dom, 'select 1\n');
      assert.strictEqual(layer(dom).textContent, 'select 1\n ');
    });

    it('treats what is typed as text, never as markup', () => {
      const { dom } = openBox('');
      type(dom, '<img src=x onerror=alert(1)> \'<b>x</b>\' -- <script>');
      assert.strictEqual(layer(dom).querySelector('img, b, script'), null);
      assert.strictEqual(layer(dom).textContent, '<img src=x onerror=alert(1)> \'<b>x</b>\' -- <script>');
    });

    it('follows every edit, and keeps the layer scrolled with the box', () => {
      const { dom } = openBox('select 1');
      type(dom, 'select 2 from t');
      assert.strictEqual(layer(dom).textContent, 'select 2 from t');
      input(dom).scrollTop = 40;
      input(dom).scrollLeft = 25;
      input(dom).dispatchEvent(new dom.window.Event('scroll'));
      assert.strictEqual(layer(dom).scrollTop, 40);
      assert.strictEqual(layer(dom).scrollLeft, 25);
    });

    it('draws the starting text on opening, and again after a refresh rebuilds the box', () => {
      const { dom } = openBox('select 1');
      type(dom, 'select max(x) from t');
      sendDuckdbData(dom, {
        success: true,
        errors: [],
        data: {
          tables: [{ name: 'a', type: 'table' }],
          selectedTable: 'a',
          data: { headers: ['id'], rows: [['1']], rowCount: 1, columnCount: 1 },
          capabilities: { refresh: true, query: true },
          reload: { at: '2026-11-19T10:00:00.000Z', previousRowCount: 1 },
        },
      });
      assert.strictEqual(layer(dom).textContent, 'select max(x) from t');
      assert.deepStrictEqual(colored(dom).map(([kind]) => kind), ['keyword', 'function', 'keyword']);
    });

    it('draws a very long text a frame later instead of on every keystroke', async () => {
      const { dom } = openBox('');
      const long = 'select 1, '.repeat(3000); // 30,000 characters
      type(dom, long);
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.strictEqual(layer(dom).textContent, long);
    });

    describe('theme colours from the host', () => {
      const root = (dom: JSDOM) => doc(dom).documentElement;
      const send = (dom: JSDOM, colors: unknown) =>
        dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { type: 'sql-theme', colors } }));
      const value = (dom: JSDOM, kind: string) => root(dom).style.getPropertyValue(`--sql-${kind}`);

      it('sets one variable per valid colour, which the stylesheet reads', () => {
        const { dom } = openBox('');
        send(dom, { keyword: '#c586c0', string: '#ce9178', comment: '#6a9955cc' });
        assert.strictEqual(value(dom, 'keyword'), '#c586c0');
        assert.strictEqual(value(dom, 'string'), '#ce9178');
        assert.strictEqual(value(dom, 'comment'), '#6a9955cc');
        assert.strictEqual(value(dom, 'number'), '', 'a kind the theme does not colour keeps the default');
      });

      it('ignores anything that is not a plain hex colour, so a message cannot inject CSS', () => {
        const { dom } = openBox('');
        send(dom, {
          keyword: 'red',
          function: 'url(https://x/y)',
          string: '#fff; background: red',
          number: 5,
          comment: null,
          type: '#12',
          operator: { a: 1 },
          unknown: '#ffffff',
        });
        for (const kind of ['keyword', 'function', 'string', 'number', 'comment', 'type', 'operator', 'identifier', 'constant']) {
          assert.strictEqual(value(dom, kind), '', kind);
        }
        assert.strictEqual(root(dom).style.getPropertyValue('--sql-unknown'), '');
      });

      it('replaces the colours when the theme changes, and clears those the new theme lacks', () => {
        const { dom } = openBox('');
        send(dom, { keyword: '#111111', string: '#222222' });
        send(dom, { keyword: '#333333' });
        assert.strictEqual(value(dom, 'keyword'), '#333333');
        assert.strictEqual(value(dom, 'string'), '');
        send(dom, undefined);
        assert.strictEqual(value(dom, 'keyword'), '');
      });

      it('works before the SQL box has ever been opened', () => {
        const { dom } = loadWebview();
        send(dom, { keyword: '#abcdef' });
        assert.strictEqual(value(dom, 'keyword'), '#abcdef');
      });
    });
  });
});
