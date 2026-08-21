import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { JSDOM } from 'jsdom';
import type { CsvParseOutcome } from '../../../src/csvParser';
import type { MultiTableParseOutcome } from '../../../src/tableData';

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
interface WebviewGlobals {
  window: unknown;
  document: unknown;
  acquireVsCodeApi: (() => { postMessage: (msg: unknown) => void }) | undefined;
}

const webviewGlobal = global as unknown as WebviewGlobals;

function loadWebview(): { dom: JSDOM; postedMessages: unknown[] } {
  const dom = new JSDOM('<!DOCTYPE html><body><div id="app"></div></body>');
  const postedMessages: unknown[] = [];

  webviewGlobal.window = dom.window;
  webviewGlobal.document = dom.window.document;
  webviewGlobal.acquireVsCodeApi = () => ({
    postMessage: (msg: unknown) => postedMessages.push(msg),
  });

  vm.runInThisContext(webviewMainSource, { filename: webviewMainPath });

  return { dom, postedMessages };
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
    const headerCells = Array.from(app.querySelectorAll('thead th')).map((th) => th.textContent);
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
    it('renders a table selector with the right option pre-selected, plus the table', () => {
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
      const select = app.querySelector('select') as HTMLSelectElement | null;
      assert.ok(select, 'a table selector should be rendered');
      const options = Array.from(select!.querySelectorAll('option'));
      assert.deepStrictEqual(
        options.map((o) => [o.getAttribute('value'), o.textContent]),
        [
          ['customers', 'customers'],
          ['customer_totals', 'customer_totals (view)'],
        ]
      );
      assert.strictEqual(select!.value, 'customer_totals');

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
      const select = app.querySelector('select') as HTMLSelectElement | null;
      assert.ok(select, 'the table selector should survive a zero-column selection');
      assert.strictEqual(select!.value, 'empty_table');
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
      const select = app.querySelector('select') as HTMLSelectElement;
      // Simulate the user switching twice before either response arrives.
      select.value = 'b';
      select.dispatchEvent(new dom.window.Event('change'));

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

      const selectAfterStale = app.querySelector('select') as HTMLSelectElement;
      assert.strictEqual(selectAfterStale.value, 'b', 'a stale response for "a" must not override "b"');

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

      const selectAfterFresh = app.querySelector('select') as HTMLSelectElement;
      assert.strictEqual(selectAfterFresh.value, 'b');
      const bodyRow = app.querySelector('tbody tr');
      assert.deepStrictEqual(
        Array.from(bodyRow!.querySelectorAll('td')).map((td) => td.textContent),
        ['1', '2']
      );
    });

    it('posts a select-table message when the dropdown changes', () => {
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
      const select = app.querySelector('select') as HTMLSelectElement;
      select.value = 'orders';
      select.dispatchEvent(new dom.window.Event('change'));

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
      assert.strictEqual(app.querySelector('select'), null);
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
      const option = app.querySelector('option');
      assert.strictEqual(option?.textContent, payload);
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
      const select = app.querySelector('select') as HTMLSelectElement | null;
      assert.ok(select, 'a table selector should be rendered');
      assert.strictEqual(select!.value, 'customer_totals');
      assert.ok(app.querySelector('table'), 'the selected table should also be rendered');
    });
  });
});
