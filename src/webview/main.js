// @ts-check
'use strict';

(function () {
  const vscode = acquireVsCodeApi();

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

  function showMessage(text, isError) {
    const app = document.getElementById('app');
    if (!app) { return; }
    app.textContent = '';
    const p = el('p', { class: isError ? 'message error' : 'message' });
    p.textContent = text;
    app.appendChild(p);
  }

  /**
   * @param {{ headers: string[], rows: string[][], rowCount: number, columnCount: number }} data
   */
  function renderTable(data) {
    const app = document.getElementById('app');
    if (!app) { return; }
    app.textContent = '';

    if (data.columnCount === 0) {
      showMessage('Empty file — no data to display.', false);
      return;
    }

    // Stats bar
    const stats = el('div', { class: 'stats-bar' });
    stats.textContent = `${data.rowCount} row${data.rowCount !== 1 ? 's' : ''} × ${data.columnCount} column${data.columnCount !== 1 ? 's' : ''}`;
    app.appendChild(stats);

    // Scroll wrapper
    const wrapper = el('div', { class: 'scroll-wrapper' });

    const table = el('table', { id: 'csv-table' });

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
    if (!outcome.success) {
      const msgs = outcome.errors.map((e) => e.message).join('\n');
      showMessage('Failed to parse file:\n' + msgs, true);
      return;
    }
    renderTable(outcome.data);
  }

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message && (message.type === 'csv-data' || message.type === 'parquet-data')) {
      renderOutcome(message.payload);
    }
  });

  // Signal to extension host that the webview is ready
  vscode.postMessage({ type: 'ready' });
})();
