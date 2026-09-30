// @ts-check
'use strict';

(function () {
  const vscode = acquireVsCodeApi();

  // Above this row count, switch to table-layout: fixed (see styles.css)
  // to skip the full-content layout pass. Below it, auto layout looks
  // better (columns hug their actual content) and the pass is cheap
  // enough not to matter.
  const LARGE_TABLE_ROW_THRESHOLD = 500;

  const SVG_NS = 'http://www.w3.org/2000/svg';

  const STATS_MODES = ['off', 'headers', 'overview'];
  const FLASH_MS = 1500;

  /**
   * How each ColumnStats.type is shown. Types are told apart by glyph, not
   * colour (no icon font is available in the webview, and colour-only
   * distinctions fail high-contrast themes).
   * @type {Record<string, { glyph: string, name: string, label: string }>}
   */
  const KIND_INFO = {
    integer: { glyph: '123', name: 'integer', label: 'int' },
    float: { glyph: '1.5', name: 'float', label: 'float' },
    boolean: { glyph: 'T/F', name: 'boolean', label: 'bool' },
    date: { glyph: 'date', name: 'date/time', label: 'date/time' },
    text: { glyph: 'Abc', name: 'text', label: 'text' },
    mixed: { glyph: 'mix', name: 'mixed types', label: 'mixed' },
    other: { glyph: '{ }', name: 'nested or binary', label: 'other' },
    empty: { glyph: '∅', name: 'no values', label: 'empty' },
  };

  /**
   * @typedef {Object} ColumnModel
   * @property {number} index
   * @property {string} name
   * @property {import('../../src/tableData').ColumnStats} column
   * @property {{ glyph: string, name: string, label: string }} info
   * @property {number} nonNull
   * @property {number} nullFrac
   * @property {string} nullText   "0", or "N (P%)"
   * @property {string} nullPct    percentage text without the % sign
   * @property {string} distinctText
   * @property {number | undefined} distinctRatio  distinct / non-null, 0..1
   * @property {string | undefined} distinctTag    "unique" | "constant"
   * @property {string | undefined} rangeText      "min → max" for date columns
   * @property {string} summary    accessible name for the profile button
   */

  // The statistics view mode. Module-level (not per-render) so it survives the
  // full #app re-render that switching tables triggers, and mirrored into the
  // webview's saved state so it survives reloads.
  /** @type {string} */
  let statsMode = readSavedStatsMode();

  /**
   * The rendered table plus everything the stats UI needs after the fact.
   * Reassigned on every renderTable; undefined while no table is shown.
   *
   * Statistics are lazy: `stats` walks idle -> pending (a `get-stats` request
   * is in flight) -> ready (strips + overview attached) | skipped (the host
   * deliberately didn't compute them; the reason is in the Overview panel) |
   * failed. The table itself never waits on any of it.
   * @type {{ table: HTMLElement, wrapper: HTMLElement, panel: HTMLElement, ths: HTMLElement[],
   *          gutterTh: HTMLElement, modeBtns: HTMLElement[], statusEl: HTMLElement,
   *          tableName: string | undefined, headers: string[], rowCount: number, totalRowCount?: number,
   *          coverNote: string | undefined, models: ColumnModel[] | undefined,
   *          stats: 'idle' | 'pending' | 'ready' | 'skipped' | 'failed' } | undefined}
   */
  let currentView;

  /** @type {{ card: HTMLElement, trigger: HTMLElement, th: HTMLElement } | undefined} */
  let openCard;

  /** @type {number | undefined} */
  let flashTimer;
  /** @type {HTMLElement | undefined} */
  let flashedTh;

  function readSavedStatsMode() {
    const state = vscode.getState();
    const mode = state && state.statsMode;
    return STATS_MODES.includes(mode) ? mode : 'off';
  }

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

  /** @param {string} tag @param {Record<string, string>=} attrs @returns {SVGElement} */
  function svgEl(tag, attrs) {
    const elem = document.createElementNS(SVG_NS, tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        elem.setAttribute(k, v);
      }
    }
    return elem;
  }

  function clearApp() {
    closeCard(false);
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

  // ── Statistics: formatting and per-column view models ─────────────────

  /** @param {number} n */
  function formatNumber(n) {
    // `n === 0` is also true for -0, which would otherwise print as "-0"
    // (bin edges just below zero round to it).
    const value = n === 0 ? 0 : n;
    return Number.isInteger(value) ? value.toLocaleString() : String(Number(value.toPrecision(6)));
  }

  /** @param {number} pct 0..100 */
  function formatPercent(pct) {
    return pct > 0 && pct < 0.1 ? '<0.1' : String(Number(pct.toFixed(1)));
  }

  /** @param {number} n */
  function trimWidth(n) {
    return String(Number(n.toFixed(2)));
  }

  /**
   * Everything the header strip, the detail card and the overview row need
   * to say about one column, computed once per render.
   * @param {import('../../src/tableData').TableStats} stats
   * @param {{ headers: string[], rowCount: number, totalRowCount?: number }} data
   * @returns {ColumnModel[]}
   */
  function buildColumnModels(stats, data) {
    // Stats cover the whole table, which can be more rows than are shown.
    const totalRows = data.totalRowCount != null ? data.totalRowCount : data.rowCount;
    return stats.columns.map((column, index) => {
      const info = KIND_INFO[column.type] || KIND_INFO.other;
      const name = data.headers[index] !== undefined ? data.headers[index] : '';
      const nonNull = Math.max(0, totalRows - column.nullCount);
      const nullFrac = totalRows > 0 ? column.nullCount / totalRows : 0;
      const nullPct = formatPercent(nullFrac * 100);
      const nullText = column.nullCount > 0
        ? `${column.nullCount.toLocaleString()}${totalRows > 0 ? ` (${nullPct}%)` : ''}`
        : '0';

      const distinctText = column.distinctCount === undefined
        ? '—'
        : (column.distinctIsLowerBound ? '≥ ' : '') + column.distinctCount.toLocaleString();
      const distinctRatio = column.distinctCount !== undefined && nonNull > 0
        ? Math.min(1, column.distinctCount / nonNull)
        : undefined;
      /** @type {string | undefined} */
      let distinctTag;
      if (column.distinctCount !== undefined && !column.distinctIsLowerBound && nonNull > 1) {
        if (column.distinctCount === 1) {
          distinctTag = 'constant';
        } else if (column.distinctCount === nonNull) {
          distinctTag = 'unique';
        }
      }
      const rangeText = column.type === 'date' && column.min !== undefined && column.max !== undefined
        ? `${column.min} → ${column.max}`
        : undefined;

      const summary = `Details for ${name}: ${info.name}, `
        + (column.nullCount > 0 ? `${nullText} nulls` : 'no nulls')
        + (column.distinctCount !== undefined ? `, ${distinctText} distinct` : '');

      return {
        index, name, column, info, nonNull, nullFrac, nullText, nullPct,
        distinctText, distinctRatio, distinctTag, rangeText, summary,
      };
    });
  }

  // ── Statistics: histogram ─────────────────────────────────────────────

  /** @param {number} v */
  function snap(v) {
    return Math.round(v * 1e6) / 1e6;
  }

  /**
   * Value range covered by histogram bin `i`. The webview never receives bin
   * edges; it re-derives them from (type, lo, hi, bin count), which is all
   * planHistogram in src/columnStats.ts computes them from. Mirrors it:
   * integer columns use width (hi-lo+1)/bins so a small span gets one bin per
   * value, floats use (hi-lo)/bins. Keep both in sync -- render.test.ts
   * brute-forces this against planHistogram/bucketIndex.
   * @param {string} kind
   * @param {import('../../src/tableData').HistogramStats} histogram
   * @param {number} i
   */
  function binLabel(kind, histogram, i) {
    const bins = histogram.counts.length;
    const last = i === bins - 1;
    if (kind === 'integer') {
      const width = (histogram.hi - histogram.lo + 1) / bins;
      const first = Math.ceil(snap(histogram.lo + i * width));
      const end = last ? histogram.hi : Math.ceil(snap(histogram.lo + (i + 1) * width)) - 1;
      return first >= end ? formatNumber(first) : `${formatNumber(first)}–${formatNumber(end)}`;
    }
    const width = (histogram.hi - histogram.lo) / bins;
    const from = formatNumber(histogram.lo + i * width);
    const to = formatNumber(last ? histogram.hi : histogram.lo + (i + 1) * width);
    return last ? `[${from}, ${to}]` : `[${from}, ${to})`;
  }

  /**
   * Bar chart of a numeric column's distribution. Built as SVG with
   * setAttribute only: the CSP has no 'unsafe-inline' for styles, so bar
   * geometry can't go through style="" attributes.
   * @param {ColumnModel} model
   * @param {{ width: number, height: number, className: string, tooltips: 'none' | 'bar' | 'group',
   *           decorative?: boolean, stretch?: boolean }} opts
   *   tooltips: 'bar' puts a <title> in each bar; 'group' wraps each bin in a
   *   <g> with a full-height transparent hit rect so empty bins are hoverable.
   */
  function renderHistogram(model, opts) {
    const histogram = /** @type {import('../../src/tableData').HistogramStats} */ (model.column.histogram);
    const { width, height } = opts;
    const svg = svgEl('svg', {
      class: `stats-hist ${opts.className}`,
      viewBox: `0 0 ${width} ${height}`,
    });
    if (opts.stretch) {
      svg.setAttribute('preserveAspectRatio', 'none');
    }
    const counts = histogram.counts;
    const total = counts.reduce((a, b) => a + b, 0);
    const maxCount = Math.max(...counts);
    if (opts.decorative) {
      svg.setAttribute('aria-hidden', 'true');
    } else {
      const peak = counts.indexOf(maxCount);
      svg.setAttribute('role', 'img');
      svg.setAttribute(
        'aria-label',
        `Distribution from ${formatNumber(histogram.lo)} to ${formatNumber(histogram.hi)}` +
          (opts.tooltips === 'group' ? `. Most values: ${binLabel(model.column.type, histogram, peak)} (${counts[peak].toLocaleString()})` : '')
      );
    }
    const slot = width / counts.length;
    counts.forEach((count, i) => {
      // 1px minimum so a small but non-empty bin stays visible next to a tall one.
      const barHeight = count === 0 ? 0 : Math.max(1, (count / maxCount) * (height - 2));
      const bar = svgEl('rect', {
        class: 'bar',
        x: String(i * slot),
        y: String(height - barHeight),
        width: String(Math.max(1, slot - 1)),
        height: String(barHeight),
      });
      let tip;
      if (opts.tooltips !== 'none') {
        tip = svgEl('title');
        const share = total > 0 ? ` (${formatPercent((count / total) * 100)}%)` : '';
        tip.textContent = `${binLabel(model.column.type, histogram, i)}: ${count.toLocaleString()} value${count !== 1 ? 's' : ''}${share}`;
      }
      if (opts.tooltips === 'group' && tip) {
        const group = svgEl('g', { class: 'bin' });
        group.appendChild(tip);
        group.appendChild(svgEl('rect', {
          class: 'bin-hit', x: String(i * slot), y: '0', width: String(slot), height: String(height),
        }));
        group.appendChild(bar);
        svg.appendChild(group);
      } else {
        if (tip) { bar.appendChild(tip); }
        svg.appendChild(bar);
      }
    });
    return svg;
  }

  // ── Statistics: small shared widgets ──────────────────────────────────

  /** @param {ColumnModel} model */
  function renderTypeBadge(model) {
    const badge = el('span', { class: `type-badge type-${model.column.type}`, title: model.info.name });
    badge.textContent = model.info.glyph;
    return badge;
  }

  /**
   * Valid-vs-null bar. A tiny null share still keeps one visible unit of
   * width, so "a few nulls" never looks identical to "no nulls".
   * @param {ColumnModel} model
   * @param {boolean=} large
   */
  function renderNullBar(model, large) {
    const svg = svgEl('svg', {
      class: large ? 'nullbar nullbar-lg' : 'nullbar',
      viewBox: '0 0 100 4',
      preserveAspectRatio: 'none',
      'aria-hidden': 'true',
    });
    const validWidth = model.column.nullCount > 0 ? Math.min(99, (1 - model.nullFrac) * 100) : 100;
    svg.appendChild(svgEl('rect', { class: 'nullbar-null', x: '0', y: '0', width: '100', height: '4' }));
    svg.appendChild(svgEl('rect', { class: 'nullbar-valid', x: '0', y: '0', width: trimWidth(validWidth), height: '4' }));
    return svg;
  }

  /** @param {number} ratio 0..1 */
  function renderDistinctBar(ratio) {
    const svg = svgEl('svg', {
      class: 'distbar',
      viewBox: '0 0 100 4',
      preserveAspectRatio: 'none',
      'aria-hidden': 'true',
    });
    svg.appendChild(svgEl('rect', { class: 'distbar-track', x: '0', y: '0', width: '100', height: '4' }));
    svg.appendChild(svgEl('rect', {
      class: 'distbar-fill', x: '0', y: '0', width: trimWidth(ratio > 0 ? Math.max(1, ratio * 100) : 0), height: '4',
    }));
    return svg;
  }

  // ── Statistics: column header profile strip ───────────────────────────

  /**
   * The compact strip inside a column header (shown in "Headers" mode): type
   * badge + null bar on top, a distribution summary underneath. It is a
   * <button> so it is keyboard-reachable and opens the detail card.
   * @param {ColumnModel} model
   */
  function renderProfileStrip(model) {
    const button = el('button', {
      type: 'button',
      class: 'col-profile',
      'data-col': String(model.index),
      'aria-haspopup': 'dialog',
      'aria-expanded': 'false',
      'aria-label': model.summary,
    });
    button.title = model.summary;

    const top = el('span', { class: 'profile-row' });
    top.appendChild(renderTypeBadge(model));
    top.appendChild(renderNullBar(model));
    if (model.column.nullCount > 0) {
      const pct = el('span', { class: 'null-pct' });
      pct.textContent = `${model.nullPct}%`;
      top.appendChild(pct);
    }
    button.appendChild(top);

    // Fixed height whatever it holds, so every header in the row stays aligned.
    const dist = el('span', { class: 'profile-dist' });
    const kind = model.column.type;
    /** @param {string} text @param {string} cls */
    const addText = (text, cls) => {
      const span = el('span', { class: cls });
      span.textContent = text;
      dist.appendChild(span);
    };
    if (kind === 'integer' || kind === 'float') {
      if (model.column.histogram) {
        dist.appendChild(renderHistogram(model, {
          width: 100, height: 24, className: 'hist-mini', tooltips: 'none', decorative: true, stretch: true,
        }));
      } else {
        addText(model.distinctTag === 'constant' ? 'constant' : '—', 'dist-text');
      }
    } else if (kind === 'text') {
      if (model.distinctRatio !== undefined) {
        dist.appendChild(renderDistinctBar(model.distinctRatio));
      }
      addText(`${model.distinctText} distinct`, 'dist-text');
      if (model.distinctTag) {
        addText(model.distinctTag, 'dist-tag');
      }
    } else if (kind === 'date') {
      addText(model.rangeText !== undefined ? model.rangeText : '—', 'range-text');
    } else if (kind === 'boolean' || kind === 'mixed') {
      addText(`${model.distinctText} distinct`, 'dist-text');
    }
    button.appendChild(dist);
    return button;
  }

  // ── Statistics: mode control ──────────────────────────────────────────

  /**
   * Off / Headers / Overview. The saved choice is never overwritten by what a
   * particular table allows: a table whose stats were skipped can't show
   * Headers, so it shows Overview (which carries the reason); one whose stats
   * failed shows neither.
   */
  function effectiveMode() {
    if (!currentView) { return statsMode; }
    if (currentView.stats === 'failed') { return 'off'; }
    if (currentView.stats === 'skipped' && statsMode === 'headers') { return 'overview'; }
    return statsMode;
  }

  const STATUS_TEXT = {
    pending: 'Computing…',
    failed: 'Statistics unavailable for this table',
  };

  function applyStatsMode() {
    const view = currentView;
    if (!view) { return; }
    const mode = effectiveMode();
    view.table.classList.toggle('show-profile', mode === 'headers');
    view.panel.hidden = mode !== 'overview';
    for (const btn of view.modeBtns) {
      const btnMode = btn.getAttribute('data-mode');
      btn.setAttribute('aria-pressed', String(btnMode === mode));
      const unavailable =
        (btnMode === 'headers' && (view.stats === 'skipped' || view.stats === 'failed')) ||
        (btnMode === 'overview' && view.stats === 'failed');
      if (unavailable) {
        btn.setAttribute('disabled', '');
        btn.title = 'Per-column statistics are unavailable for this table';
      } else {
        btn.removeAttribute('disabled');
        btn.removeAttribute('title');
      }
    }
    view.statusEl.textContent = STATUS_TEXT[view.stats] || '';
    closeCard(false);
  }

  /** @param {string} mode */
  function setStatsMode(mode) {
    statsMode = mode;
    vscode.setState({ ...(vscode.getState() || {}), statsMode: mode });
    applyStatsMode();
    if (mode !== 'off') {
      requestStats();
    }
  }

  function renderModeControl() {
    const group = el('div', { class: 'stats-mode', role: 'group', 'aria-label': 'Column statistics' });
    const label = el('span', { class: 'stats-mode-label', 'aria-hidden': 'true' });
    label.textContent = 'Statistics';
    group.appendChild(label);
    const seg = el('div', { class: 'stats-mode-seg' });
    /** @type {HTMLElement[]} */
    const buttons = [];
    for (const [mode, text] of [['off', 'Off'], ['headers', 'Headers'], ['overview', 'Overview']]) {
      const btn = el('button', {
        type: 'button', class: 'stats-mode-btn', 'data-mode': mode, 'aria-pressed': 'false',
      });
      btn.textContent = text;
      if (mode === 'overview') {
        btn.setAttribute('aria-controls', 'stats-panel');
      }
      btn.addEventListener('click', () => setStatsMode(mode));
      seg.appendChild(btn);
      buttons.push(btn);
    }
    group.appendChild(seg);
    const statusEl = el('span', { class: 'stats-status', role: 'status', 'aria-live': 'polite' });
    group.appendChild(statusEl);
    return { group, buttons, statusEl };
  }

  // ── Statistics: lazy loading ──────────────────────────────────────────

  /** Swaps the (hidden or visible) overview panel's contents for a single note. */
  function showPanelNote(text) {
    const view = currentView;
    if (!view) { return; }
    const panel = el('div', { id: 'stats-panel', class: 'stats-panel' });
    const note = el('p', { class: 'stats-note' });
    note.textContent = text;
    panel.appendChild(note);
    view.panel.replaceWith(panel);
    view.panel = panel;
  }

  /**
   * Asks the extension host for this table's statistics -- once per rendered
   * view, and only when the user has turned the view on (or a saved "on" mode
   * is restored), so tables that never use it never pay for it. The state
   * flips to 'pending' *before* posting, so a reply that lands synchronously
   * (as it does in tests) finds the view ready to receive it.
   */
  function requestStats() {
    const view = currentView;
    if (!view || view.stats !== 'idle') { return; }
    view.stats = 'pending';
    showPanelNote('Computing column statistics…');
    applyStatsMode();
    vscode.postMessage(
      view.tableName !== undefined ? { type: 'get-stats', table: view.tableName } : { type: 'get-stats' }
    );
  }

  /**
   * Attaches a `stats-data` reply to the view it was requested for. Replies
   * for another table, or after the view was re-rendered, are dropped (the
   * host echoes `table`; CSV/Parquet have none, so `undefined` matches).
   * @param {{ table?: string, stats?: import('../../src/tableData').TableStats } | undefined} payload
   */
  function handleStatsData(payload) {
    const view = currentView;
    if (!view || view.stats !== 'pending' || !payload || payload.table !== view.tableName) { return; }
    const stats = payload.stats;
    if (!stats || (!stats.skippedReason && (!Array.isArray(stats.columns) || stats.columns.length !== view.headers.length))) {
      view.stats = 'failed';
      showPanelNote('Statistics are unavailable for this table.');
    } else if (stats.skippedReason) {
      view.stats = 'skipped';
      const panel = renderStatsPanel(stats, undefined, undefined);
      view.panel.replaceWith(panel);
      view.panel = panel;
    } else {
      attachStats(view, stats);
    }
    applyStatsMode();
  }

  /**
   * Fills in the parts of an already-rendered table that need statistics:
   * the overview panel and a profile strip in every header. The strips are
   * `display: none` until Headers mode is on, so attaching them changes no
   * layout by itself and the table is never re-rendered.
   * @param {NonNullable<typeof currentView>} view
   * @param {import('../../src/tableData').TableStats} stats
   */
  function attachStats(view, stats) {
    const models = buildColumnModels(stats, view);
    view.models = models;
    view.stats = 'ready';
    const panel = renderStatsPanel(stats, models, view.coverNote);
    view.panel.replaceWith(panel);
    view.panel = panel;
    models.forEach((model, i) => view.ths[i].appendChild(renderProfileStrip(model)));
  }

  // ── Statistics: overview panel (one row per column) ───────────────────

  /**
   * Builds the overview panel. Every cell is textContent-only, like the main
   * table: min/max are untrusted file content.
   * @param {import('../../src/tableData').TableStats} stats
   * @param {ColumnModel[] | undefined} models
   * @param {string | undefined} coverNote
   */
  function renderStatsPanel(stats, models, coverNote) {
    const panel = el('div', { id: 'stats-panel', class: 'stats-panel' });
    if (stats.skippedReason) {
      const note = el('p', { class: 'stats-note' });
      note.textContent = stats.skippedReason;
      panel.appendChild(note);
      return panel;
    }
    if (coverNote) {
      const note = el('p', { class: 'stats-note' });
      note.textContent = coverNote;
      panel.appendChild(note);
    }
    if (!models) { return panel; }

    const table = el('table', { class: 'stats-table' });
    const headerRow = el('tr');
    for (const [label, numeric] of [
      ['Column', false],
      ['Type', false],
      ['Nulls', true],
      ['Distinct', true],
      ['Min', false],
      ['Max', false],
      ['Mean', true],
      ['Distribution', false],
    ]) {
      const th = el('th', numeric ? { class: 'num' } : undefined);
      th.textContent = String(label);
      headerRow.appendChild(th);
    }
    const thead = el('thead');
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = el('tbody');
    for (const model of models) {
      const { column } = model;
      const tr = el('tr', { 'data-col': String(model.index) });
      /** @param {boolean=} numeric @param {string=} title */
      const addCell = (numeric, title) => {
        const td = el('td', numeric ? { class: 'num' } : undefined);
        if (title !== undefined) { td.title = title; }
        tr.appendChild(td);
        return td;
      };
      /** @param {string} text @param {boolean=} numeric */
      const addTextCell = (text, numeric) => {
        const td = addCell(numeric, text);
        td.textContent = text;
        return td;
      };

      const nameCell = addCell(false, model.name);
      const jump = el('button', { type: 'button', class: 'col-jump' });
      jump.textContent = model.name;
      nameCell.appendChild(jump);

      const typeCell = addCell(false, model.info.name);
      typeCell.appendChild(renderTypeBadge(model));
      const typeName = el('span', { class: 'type-name' });
      typeName.textContent = model.info.label;
      typeCell.appendChild(typeName);

      const nullCell = addCell(true, model.nullText);
      nullCell.appendChild(renderNullBar(model));
      const nullText = el('span', { class: 'null-text' });
      nullText.textContent = model.nullText;
      nullCell.appendChild(nullText);

      addTextCell(model.distinctText, true);
      addTextCell(column.min !== undefined ? column.min : '—');
      addTextCell(column.max !== undefined ? column.max : '—');
      addTextCell(column.mean !== undefined ? formatNumber(column.mean) : '—', true);

      const distribution = el('td');
      if (column.histogram) {
        distribution.appendChild(renderHistogram(model, {
          width: 80, height: 24, className: 'hist-row', tooltips: 'bar',
        }));
      } else {
        distribution.textContent = '—';
      }
      tr.appendChild(distribution);
      tbody.appendChild(tr);
    }
    tbody.addEventListener('click', (event) => {
      const target = /** @type {Element} */ (event.target);
      const row = target.closest('tr[data-col]');
      if (row) {
        jumpToColumn(Number(row.getAttribute('data-col')));
      }
    });
    table.appendChild(tbody);
    panel.appendChild(table);
    return panel;
  }

  /** Scrolls the data table to column `index` and flashes its header. */
  function jumpToColumn(index) {
    const th = currentView && currentView.ths[index];
    if (!th) { return; }
    th.scrollIntoView({ inline: 'center', block: 'nearest' });
    if (flashTimer !== undefined) {
      window.clearTimeout(flashTimer);
    }
    if (flashedTh) {
      flashedTh.classList.remove('col-flash');
    }
    // Reading offsetWidth forces a reflow, so re-adding the class restarts
    // the animation even when the same column is flashed twice in a row.
    void th.offsetWidth;
    th.classList.add('col-flash');
    flashedTh = th;
    flashTimer = window.setTimeout(() => {
      th.classList.remove('col-flash');
      flashTimer = undefined;
    }, FLASH_MS);
  }

  // ── Statistics: detail card ───────────────────────────────────────────

  /**
   * @param {ColumnModel} model
   * @param {string | undefined} coverNote
   */
  function buildDetailCard(model, coverNote) {
    const { column } = model;
    const card = el('div', {
      id: 'stats-card',
      class: 'stats-card',
      role: 'dialog',
      'aria-labelledby': 'stats-card-title',
      tabindex: '-1',
    });

    const head = el('div', { class: 'card-head' });
    head.appendChild(renderTypeBadge(model));
    const title = el('h2', { id: 'stats-card-title', class: 'card-title' });
    title.textContent = model.name;
    title.title = model.name;
    head.appendChild(title);
    const close = el('button', { type: 'button', class: 'card-close', 'aria-label': 'Close column details' });
    close.textContent = '×';
    close.addEventListener('click', () => closeCard(true));
    head.appendChild(close);
    card.appendChild(head);

    const sub = el('p', { class: 'card-sub' });
    sub.textContent = model.info.name;
    card.appendChild(sub);

    const grid = el('dl', { class: 'card-grid' });
    /** @param {string} label @param {string} text @param {SVGElement=} extra */
    const addRow = (label, text, extra) => {
      const dt = el('dt');
      dt.textContent = label;
      const dd = el('dd');
      const span = el('span', { class: 'card-value' });
      span.textContent = text;
      span.title = text;
      dd.appendChild(span);
      if (extra) { dd.appendChild(extra); }
      grid.appendChild(dt);
      grid.appendChild(dd);
    };
    addRow('Nulls', model.nullText, renderNullBar(model, true));
    addRow(
      'Distinct',
      model.distinctText + (model.distinctRatio !== undefined ? ` · ${formatPercent(model.distinctRatio * 100)}% of non-null` : '')
    );
    if (column.min !== undefined) { addRow('Min', column.min); }
    if (column.max !== undefined) { addRow('Max', column.max); }
    if (column.mean !== undefined) { addRow('Mean', formatNumber(column.mean)); }
    card.appendChild(grid);

    if (column.histogram) {
      const hist = el('div', { class: 'card-hist' });
      hist.appendChild(renderHistogram(model, {
        width: 280, height: 96, className: 'hist-large', tooltips: 'group', stretch: true,
      }));
      const axis = el('div', { class: 'hist-axis' });
      const lo = el('span');
      lo.textContent = formatNumber(column.histogram.lo);
      const hi = el('span');
      hi.textContent = formatNumber(column.histogram.hi);
      axis.appendChild(lo);
      axis.appendChild(hi);
      hist.appendChild(axis);
      card.appendChild(hist);
    }
    if (coverNote) {
      const note = el('p', { class: 'card-note' });
      note.textContent = coverNote;
      card.appendChild(note);
    }
    return card;
  }

  function positionCard() {
    if (!openCard) { return; }
    const { card, th } = openCard;
    const anchor = th.getBoundingClientRect();
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = document.documentElement.clientHeight;
    const cardWidth = card.offsetWidth || 300;
    // Keep the card clear of the sticky row-number gutter, then inside the viewport.
    const gutterRight = currentView ? currentView.gutterTh.getBoundingClientRect().right : 0;
    const left = Math.max(8, gutterRight + 4, Math.min(anchor.left, viewportWidth - cardWidth - 8));
    const top = anchor.bottom + 4;
    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
    if (viewportHeight > 0) {
      card.style.maxHeight = `${Math.max(120, viewportHeight - top - 8)}px`;
    }
  }

  /** Scroll/resize: close the card if its column was scrolled out of view, else re-anchor it. */
  function repositionOrCloseCard() {
    if (!openCard || !currentView) { return; }
    const anchor = openCard.th.getBoundingClientRect();
    // An all-zero rect means "not measurable" (e.g. jsdom), not "off-screen".
    if (anchor.width > 0 || anchor.height > 0) {
      const gutterRight = currentView.gutterTh.getBoundingClientRect().right;
      const wrapperRight = currentView.wrapper.getBoundingClientRect().right;
      if (anchor.right <= gutterRight || anchor.left >= wrapperRight) {
        closeCard(false);
        return;
      }
    }
    positionCard();
  }

  /**
   * @param {ColumnModel} model
   * @param {HTMLElement} trigger
   * @param {HTMLElement} th
   */
  function openDetailCard(model, trigger, th) {
    closeCard(false);
    const app = document.getElementById('app');
    if (!app || !currentView) { return; }
    const card = buildDetailCard(model, currentView.coverNote);
    app.appendChild(card);
    openCard = { card, trigger, th };
    trigger.setAttribute('aria-expanded', 'true');
    trigger.setAttribute('aria-controls', 'stats-card');
    positionCard();
    card.focus();
  }

  /** @param {boolean} restoreFocus */
  function closeCard(restoreFocus) {
    if (!openCard) { return; }
    const { card, trigger } = openCard;
    openCard = undefined;
    card.remove();
    trigger.setAttribute('aria-expanded', 'false');
    trigger.removeAttribute('aria-controls');
    if (restoreFocus && trigger.isConnected) {
      trigger.focus();
    }
  }

  // Document-level listeners are registered once; every one is a no-op while
  // no card is open. (`document` is the webview's own document, so there's
  // nothing to unregister.)
  document.addEventListener('pointerdown', (event) => {
    if (!openCard) { return; }
    const target = /** @type {Node} */ (event.target);
    if (!openCard.card.contains(target) && !openCard.trigger.contains(target)) {
      closeCard(false);
    }
  }, true);

  document.addEventListener('keydown', (event) => {
    if (!openCard) { return; }
    if (event.key === 'Escape') {
      event.preventDefault();
      closeCard(true);
      return;
    }
    if (event.key === 'Tab') {
      // Non-modal dialog: tabbing out of it closes it and hands focus back to
      // its trigger, so the next Tab continues from where the user was.
      const { card } = openCard;
      const focusables = Array.from(card.querySelectorAll('button'));
      const active = document.activeElement;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const leaving = event.shiftKey
        ? active === card || active === first
        : active === last || (focusables.length === 0 && active === card);
      if (leaving) {
        closeCard(true);
      }
    }
  });

  document.addEventListener('scroll', (event) => {
    if (openCard && !openCard.card.contains(/** @type {Node} */ (event.target))) {
      repositionOrCloseCard();
    }
  }, true);
  window.addEventListener('resize', repositionOrCloseCard);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { closeCard(false); }
  });

  // ── Table ─────────────────────────────────────────────────────────────

  /**
   * Renders the stats bar + table into #app. Does NOT clear #app itself --
   * callers clear first, so a multi-table source (e.g. SQLite) can render a
   * table selector as #app's first child and this as a sibling after it.
   * Empty data likewise only appends a message (via appendMessage, not
   * showMessage) rather than clearing -- otherwise selecting a table/view
   * with zero columns would wipe out the selector that was just rendered.
   * @param {{ headers: string[], rows: string[][], rowCount: number, columnCount: number, totalRowCount?: number }} data
   * @param {string=} tableName the selected table/sheet of a multi-table source; undefined for CSV/Parquet
   */
  function renderTable(data, tableName) {
    const app = document.getElementById('app');
    if (!app) { return; }
    currentView = undefined;

    if (data.columnCount === 0) {
      appendMessage('Empty file — no data to display.', false);
      return;
    }

    const coverNote = data.totalRowCount != null && data.totalRowCount > data.rowCount
      ? `Statistics cover all ${data.totalRowCount.toLocaleString()} rows, not just the ${data.rowCount.toLocaleString()} shown.`
      : undefined;

    // Stats header: the text-only stats bar plus the Off / Headers / Overview
    // mode control. Statistics themselves aren't in `data`: they're requested
    // lazily (see requestStats) once the user picks Headers or Overview.
    const statsHeader = el('div', { class: 'stats-header' });
    const statsBar = el('div', { class: 'stats-bar' });
    let statsText = `${data.rowCount} row${data.rowCount !== 1 ? 's' : ''} × ${data.columnCount} column${data.columnCount !== 1 ? 's' : ''}`;
    if (data.totalRowCount != null && data.totalRowCount > data.rowCount) {
      statsText += ` (showing first ${data.rowCount} of ${data.totalRowCount} — increase tablas.maxRows in settings to see more)`;
    }
    statsBar.textContent = statsText;
    statsHeader.appendChild(statsBar);

    const control = renderModeControl();
    statsHeader.appendChild(control.group);
    const statsPanel = el('div', { id: 'stats-panel', class: 'stats-panel' });
    app.appendChild(statsHeader);
    app.appendChild(statsPanel);

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

    /** @type {HTMLElement[]} */
    const ths = [];
    data.headers.forEach((header) => {
      const th = el('th');
      const name = el('span', { class: 'col-name' });
      name.textContent = header;
      th.appendChild(name);
      th.title = header;
      headerRow.appendChild(th);
      ths.push(th);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);

    // Installed once; the strips it reacts to only exist after attachStats,
    // and it reads the models from the current view at click time.
    thead.addEventListener('click', (event) => {
      const target = /** @type {Element} */ (event.target);
      const trigger = target.closest('button.col-profile');
      const view = currentView;
      if (!trigger || !view || !view.models) { return; }
      const index = Number(trigger.getAttribute('data-col'));
      const wasOpen = !!openCard && openCard.trigger === trigger;
      closeCard(false);
      if (!wasOpen) {
        openDetailCard(view.models[index], /** @type {HTMLElement} */ (trigger), ths[index]);
      }
    });

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

    currentView = {
      table,
      wrapper,
      panel: statsPanel,
      ths,
      gutterTh: rnHeader,
      modeBtns: control.buttons,
      statusEl: control.statusEl,
      tableName,
      headers: data.headers,
      rowCount: data.rowCount,
      totalRowCount: data.totalRowCount,
      coverNote,
      models: undefined,
      stats: 'idle',
    };
    applyStatsMode();
    // A restored or carried-over "on" mode (reload, table switch) has no user
    // click to trigger the request, so make it here.
    if (statsMode !== 'off') {
      requestStats();
    }
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
      // Generic wording -- this function is shared by every multi-table
      // source (SQLite tables/views, XLSX sheets), not just databases.
      showMessage('No tables found in this file.', false);
      return;
    }
    const app = document.getElementById('app');
    if (!app) { return; }
    app.appendChild(renderTableSelector(outcome.data.tables, outcome.data.selectedTable));
    renderTable(outcome.data.data, outcome.data.selectedTable);
  }

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message) { return; }
    if (message.type === 'csv-data' || message.type === 'parquet-data') {
      renderOutcome(message.payload);
    } else if (
      message.type === 'sqlite-data' ||
      message.type === 'xlsx-data' ||
      message.type === 'duckdb-data'
    ) {
      renderMultiTableOutcome(message.payload);
    } else if (message.type === 'stats-data') {
      handleStatsData(message.payload);
    }
  });

  // Signal to extension host that the webview is ready
  vscode.postMessage({ type: 'ready' });
})();
