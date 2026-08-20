// @ts-check
'use strict';

(function () {
  const vscode = acquireVsCodeApi();

  // Above this row count, switch to table-layout: fixed (see styles.css)
  // to skip the full-content layout pass. Below it, auto layout looks
  // better (columns hug their actual content) and the pass is cheap
  // enough not to matter.
  const LARGE_TABLE_ROW_THRESHOLD = 500;

  /** @param {string} tag @param {Record<string, string>=} attrs @returns {HTMLElement} */
  function el(tag, attrs) {
    const elem = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        elem.setAttribute(k, v);
      }
    }
    return elem;
  }

  function clearApp() {
    const app = document.getElementById('app');
    if (app) { app.textContent = ''; }
  }

  // Appends a message paragraph without clearing #app first -- used by
  // renderTable's empty-data branch so a sibling table selector (multi-table
  // sources) survives. showMessage (below) is the clear-then-append version
  // used everywhere else, where #app should be replaced wholesale.
  function appendMessage(text, isError) {
    const app = document.getElementById('app');
    if (!app) { return; }
    const p = el('p', { class: isError ? 'message error' : 'message' });
    p.textContent = text;
    app.appendChild(p);
  }

  function showMessage(text, isError) {
    clearApp();
    appendMessage(text, isError);
  }

  /**
   * Renders the stats bar + table into #app. Does NOT clear #app itself --
   * callers clear first, so a multi-table source (e.g. SQLite) can render a
   * table selector as #app's first child and this as a sibling after it.
   * Empty data likewise only appends a message (via appendMessage, not
   * showMessage) rather than clearing -- otherwise selecting a table/view
   * with zero columns would wipe out the selector that was just rendered.
   * @param {{ headers: string[], rows: string[][], rowCount: number, columnCount: number, totalRowCount?: number }} data
   */
  function renderTable(data) {
    const app = document.getElementById('app');
    if (!app) { return; }

    if (data.columnCount === 0) {
      appendMessage('Empty file — no data to display.', false);
      return;
    }

    // Stats bar
    const stats = el('div', { class: 'stats-bar' });
    let statsText = `${data.rowCount} row${data.rowCount !== 1 ? 's' : ''} × ${data.columnCount} column${data.columnCount !== 1 ? 's' : ''}`;
    if (data.totalRowCount != null && data.totalRowCount > data.rowCount) {
      statsText += ` (showing first ${data.rowCount} of ${data.totalRowCount} — increase tablas.maxRows in settings to see more)`;
    }
    stats.textContent = statsText;
    app.appendChild(stats);

    // Scroll wrapper
    const wrapper = el('div', { class: 'scroll-wrapper' });

    const table = el('table', {
      id: 'csv-table',
      ...(data.rows.length > LARGE_TABLE_ROW_THRESHOLD ? { class: 'table-fixed' } : {}),
    });

    // <thead>
    const thead = el('thead');
    const headerRow = el('tr');
    // Row number gutter header
    const rnHeader = el('th', { class: 'row-num' });
    rnHeader.textContent = '#';
    headerRow.appendChild(rnHeader);

    for (const header of data.headers) {
      const th = el('th');
      th.textContent = header;
      th.title = header;
      headerRow.appendChild(th);
    }
    thead.appendChild(headerRow);
    table.appendChild(thead);

    // <tbody> — use DocumentFragment for performance
    const tbody = el('tbody');
    const fragment = document.createDocumentFragment();

    for (let i = 0; i < data.rows.length; i++) {
      const tr = el('tr');

      // Row number cell
      const rnCell = el('td', { class: 'row-num' });
      rnCell.textContent = String(i + 1);
      tr.appendChild(rnCell);

      for (const cell of data.rows[i]) {
        const td = el('td');
        td.textContent = cell;
        td.title = cell;
        tr.appendChild(td);
      }
      fragment.appendChild(tr);
    }

    tbody.appendChild(fragment);
    table.appendChild(tbody);
    wrapper.appendChild(table);
    app.appendChild(wrapper);
  }

  /**
   * @param {import('../../src/tableData').TableParseOutcome} outcome
   */
  function renderOutcome(outcome) {
    clearApp();
    if (!outcome.success) {
      const msgs = outcome.errors.map((e) => e.message).join('\n');
      showMessage('Failed to parse file:\n' + msgs, true);
      return;
    }
    renderTable(outcome.data);
  }

  // Tracks the most recently user-requested table name, so a stale
  // select-table response (superseded by a newer request already in
  // flight, if they resolve out of order) can be dropped instead of
  // flashing outdated data. undefined until the user changes the dropdown
  // for the first time -- the initial load's response is always accepted.
  let requestedTable;

  /**
   * Builds a <select> listing every table/view in a multi-table source
   * (e.g. SQLite), with `selectedTable` pre-selected. Switching it posts a
   * `select-table` request back to the extension host, which re-queries the
   * already-open database and responds with a fresh payload of the same
   * message type -- see renderMultiTableOutcome below.
   * @param {import('../../src/tableData').TableRef[]} tables
   * @param {string} selectedTable
   */
  function renderTableSelector(tables, selectedTable) {
    const wrapper = el('div', { class: 'table-selector' });
    const select = el('select', { 'aria-label': 'Table' });
    for (const table of tables) {
      const option = el('option', { value: table.name });
      option.textContent = table.type === 'view' ? `${table.name} (view)` : table.name;
      if (table.name === selectedTable) {
        option.selected = true;
      }
      select.appendChild(option);
    }
    select.addEventListener('change', () => {
      requestedTable = select.value;
      vscode.postMessage({ type: 'select-table', table: requestedTable });
    });
    wrapper.appendChild(select);
    return wrapper;
  }

  /**
   * @param {import('../../src/tableData').MultiTableParseOutcome} outcome
   */
  function renderMultiTableOutcome(outcome) {
    if (
      outcome.success &&
      requestedTable !== undefined &&
      outcome.data.selectedTable !== requestedTable
    ) {
      // A response to an older select-table request, superseded by a newer
      // one already in flight -- drop it rather than momentarily showing a
      // table the user already moved away from.
      return;
    }
    clearApp();
    if (!outcome.success) {
      const msgs = outcome.errors.map((e) => e.message).join('\n');
      showMessage('Failed to parse file:\n' + msgs, true);
      return;
    }
    if (outcome.data.tables.length === 0) {
      showMessage('No tables found in this database.', false);
      return;
    }
    const app = document.getElementById('app');
    if (!app) { return; }
    app.appendChild(renderTableSelector(outcome.data.tables, outcome.data.selectedTable));
    renderTable(outcome.data.data);
  }

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message) { return; }
    if (message.type === 'csv-data' || message.type === 'parquet-data') {
      renderOutcome(message.payload);
    } else if (message.type === 'sqlite-data') {
      renderMultiTableOutcome(message.payload);
    }
  });

  // Signal to extension host that the webview is ready
  vscode.postMessage({ type: 'ready' });
})();
