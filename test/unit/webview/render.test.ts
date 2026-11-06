import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { JSDOM } from 'jsdom';
import type { CsvParseOutcome } from '../../../src/csvParser';
import { bucketIndex, planHistogram } from '../../../src/columnStats';
import type { ColumnStats, MultiTableParseOutcome, ParsedTable, TableStats } from '../../../src/tableData';

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
