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

  /**
   * How each ColumnStats.type is shown. Types are told apart by glyph, not
   * colour (no icon font is available in the webview, and colour-only
   * distinctions fail high-contrast themes).
   * @type {Record<string, { glyph: string, name: string }>}
   */
  const KIND_INFO = {
    integer: { glyph: '123', name: 'integer' },
    float: { glyph: '1.5', name: 'float' },
    boolean: { glyph: 'T/F', name: 'boolean' },
    date: { glyph: 'date', name: 'date/time' },
    text: { glyph: 'Abc', name: 'text' },
    mixed: { glyph: 'mix', name: 'mixed types' },
    other: { glyph: '{ }', name: 'nested or binary' },
    empty: { glyph: '∅', name: 'no values' },
  };

  /**
   * @typedef {Object} ColumnModel
   * @property {number} index
   * @property {string} name
   * @property {import('../../src/tableData').ColumnStats} column
   * @property {{ glyph: string, name: string }} info
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

  /**
   * The rendered table plus everything the stats UI needs after the fact.
   * Reassigned on every renderTable; undefined while no table is shown.
   *
   * Statistics are always on but still arrive after the rows: `stats` walks
   * idle -> pending (a `get-stats` request is in flight) -> ready (profile
   * strips attached) | skipped (the host deliberately didn't compute them;
   * `skippedReason` says why) | failed. The table itself never waits on any
   * of it.
   *
   * Column filtering is a second, independent state machine on the same view:
   * `filter` walks none -> pending (a `filter` request is in flight) -> active
   * (the tbody shows the host's matches) | invalid (some box didn't parse; rows
   * unchanged) | failed (the host couldn't run it; original rows restored). The
   * header, the profile strips and the focused input are never re-rendered --
   * only the tbody is swapped.
   * @type {{ wrapper: HTMLElement, thead: HTMLElement, tbody: HTMLElement, ths: HTMLElement[],
   *          gutterTh: HTMLElement, statusEl: HTMLElement, statsBar: HTMLElement,
   *          tableName: string | undefined, headers: string[], rowCount: number, totalRowCount?: number,
   *          coverNote: string | undefined, models: ColumnModel[] | undefined,
   *          skippedReason: string | undefined,
   *          stats: 'idle' | 'pending' | 'ready' | 'skipped' | 'failed',
   *          originalRows: string[][], baseStatsText: string,
   *          filterInputs: HTMLInputElement[], clearButton: HTMLButtonElement,
   *          filterSeq: number, filterTimer: number | undefined,
   *          filter: 'none' | 'pending' | 'active' | 'invalid' | 'failed' } | undefined}
   */
  let currentView;

  // Webview-wide `filter` request counter: every request takes the next number
  // and only a reply carrying the newest one is applied. Never reset, so a
  // reply for a table that has since been replaced can't collide with a new one.
  let filterSeqCounter = 0;
  const FILTER_DEBOUNCE_MS = 250;
  // Mirrors filterLimits.maxTextLength in src/filter.ts: the host rejects longer text.
  const MAX_FILTER_TEXT_LENGTH = 1000;
  const FILTER_HELP =
    'Filter this column. text: contains · !text: does not contain · =text: equals · =: empty · !=: not empty · ' +
    '> >= < <=: compare numbers or dates · \\text: literal. Esc clears. Alt+click a cell to filter by its value.';

  /** @type {{ card: HTMLElement, trigger: HTMLElement, th: HTMLElement } | undefined} */
  let openCard;

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
   * Everything the header strip and the detail card need
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
   * @param {{ width: number, height: number, className: string, tooltips: 'none' | 'group',
   *           decorative?: boolean, stretch?: boolean }} opts
   *   tooltips: 'group' wraps each bin in a <g> with a <title> and a
   *   full-height transparent hit rect so empty bins are hoverable.
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
      if (opts.tooltips === 'group') {
        const tip = svgEl('title');
        const share = total > 0 ? ` (${formatPercent((count / total) * 100)}%)` : '';
        tip.textContent = `${binLabel(model.column.type, histogram, i)}: ${count.toLocaleString()} value${count !== 1 ? 's' : ''}${share}`;
        const group = svgEl('g', { class: 'bin' });
        group.appendChild(tip);
        group.appendChild(svgEl('rect', {
          class: 'bin-hit', x: String(i * slot), y: '0', width: String(slot), height: String(height),
        }));
        group.appendChild(bar);
        svg.appendChild(group);
      } else {
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
   * The compact strip inside a column header: type
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

  // ── Statistics: status ────────────────────────────────────────────────

  /** A live-region span beside the stats bar. Empty (and so invisible) when there is nothing to say. */
  function renderStatsStatus() {
    return el('span', { class: 'stats-status', role: 'status', 'aria-live': 'polite' });
  }

  function applyStatsStatus() {
    const view = currentView;
    if (!view) { return; }
    let text = '';
    if (view.stats === 'pending') {
      text = 'Computing…';
    } else if (view.stats === 'failed') {
      text = 'Statistics unavailable for this table';
    } else if (view.stats === 'skipped') {
      text = view.skippedReason || '';
    }
    view.statusEl.textContent = text;
    // A long skip reason is ellipsised in the bar; the title keeps it readable.
    if (view.stats === 'skipped') {
      view.statusEl.title = text;
    } else {
      view.statusEl.removeAttribute('title');
    }
  }

  // ── Statistics: loading ───────────────────────────────────────────────

  /**
   * Asks the extension host for this table's statistics, once per rendered
   * view, right after its rows are in the DOM. The state flips to 'pending'
   * *before* posting, so a reply that lands synchronously (as it does in
   * tests) finds the view ready to receive it.
   */
  function requestStats() {
    const view = currentView;
    if (!view || view.stats !== 'idle') { return; }
    view.stats = 'pending';
    applyStatsStatus();
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
    } else if (stats.skippedReason) {
      view.stats = 'skipped';
      view.skippedReason = stats.skippedReason;
    } else {
      attachStats(view, stats);
    }
    applyStatsStatus();
  }

  /**
   * Appends a profile strip to every header of an already-rendered table, so
   * the table is never re-rendered.
   * @param {NonNullable<typeof currentView>} view
   * @param {import('../../src/tableData').TableStats} stats
   */
  function attachStats(view, stats) {
    const models = buildColumnModels(stats, view);
    view.models = models;
    view.stats = 'ready';
    models.forEach((model, i) => view.ths[i].appendChild(renderProfileStrip(model)));
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
    // Under the whole sticky header (profile strips + filter row), so the
    // card never covers the column's own filter box.
    const headBottom = currentView ? currentView.thead.getBoundingClientRect().bottom : 0;
    const top = Math.max(anchor.bottom, headBottom) + 4;
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
    const filterNote = currentView.filter !== 'none' ? 'Statistics ignore the active filter.' : undefined;
    const note = [currentView.coverNote, filterNote].filter(Boolean).join(' ') || undefined;
    const card = buildDetailCard(model, note);
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

  // ── Column filtering ──────────────────────────────────────────────────

  /**
   * Replaces the body's rows. The only thing a filter reply (or a clear)
   * re-renders: the header, the profile strips and the focused filter input
   * stay exactly as they are.
   * @param {HTMLElement} tbody
   * @param {string[][]} rows
   */
  function renderRows(tbody, rows) {
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < rows.length; i++) {
      const tr = el('tr');

      // Row number cell
      const rnCell = el('td', { class: 'row-num' });
      rnCell.textContent = String(i + 1);
      tr.appendChild(rnCell);

      for (const cell of rows[i]) {
        const td = el('td');
        td.textContent = cell;
        td.title = cell;
        tr.appendChild(td);
      }
      fragment.appendChild(tr);
    }
    tbody.textContent = '';
    tbody.appendChild(fragment);
  }

  /** @param {NonNullable<typeof currentView>} view @param {Record<string, unknown>} message */
  function withTable(view, message) {
    return view.tableName !== undefined ? { ...message, table: view.tableName } : message;
  }

  /** @param {NonNullable<typeof currentView>} view */
  function cancelFilterTimer(view) {
    if (view.filterTimer !== undefined) {
      window.clearTimeout(view.filterTimer);
      view.filterTimer = undefined;
    }
  }

  /** The clear-all button is only there while some box holds text. @param {NonNullable<typeof currentView>} view */
  function updateFilterChrome(view) {
    view.clearButton.hidden = !view.filterInputs.some((input) => input.value !== '');
  }

  /** Back to the unfiltered table, without asking the host. @param {NonNullable<typeof currentView>} view */
  function restoreOriginalRows(view) {
    renderRows(view.tbody, view.originalRows);
    view.statsBar.textContent = view.baseStatsText;
    view.wrapper.scrollTop = 0;
  }

  /**
   * Sends the boxes' current text to the host (blank boxes are dropped; the
   * host parses what's left). With nothing left to filter the original rows
   * are put back locally -- no round trip -- and the host is only told so it
   * can release anything it cached for this table.
   * @param {NonNullable<typeof currentView>} view
   */
  function sendFilter(view) {
    cancelFilterTimer(view);
    if (currentView !== view) { return; }
    for (const input of view.filterInputs) {
      input.removeAttribute('aria-invalid');
      input.title = FILTER_HELP;
    }
    updateFilterChrome(view);
    const filters = view.filterInputs
      .map((input, column) => ({ column, text: input.value }))
      .filter((f) => f.text.trim() !== '');
    const seq = ++filterSeqCounter;
    view.filterSeq = seq;
    if (filters.length === 0) {
      if (view.filter !== 'none') {
        view.filter = 'none';
        restoreOriginalRows(view);
        vscode.postMessage(withTable(view, { type: 'filter', seq, filters: [] }));
      }
      return;
    }
    view.filter = 'pending';
    vscode.postMessage(withTable(view, { type: 'filter', seq, filters }));
  }

  /** @param {NonNullable<typeof currentView>} view */
  function scheduleFilter(view) {
    cancelFilterTimer(view);
    view.filterTimer = window.setTimeout(() => {
      view.filterTimer = undefined;
      sendFilter(view);
    }, FILTER_DEBOUNCE_MS);
  }

  /**
   * Applies a `filter-data` reply to the view it was requested for. Replies
   * that were overtaken by a newer request (or belong to another table) are
   * dropped, so a slow answer can never overwrite a newer one.
   * @param {import('../../src/filterMessage').FilterPayload | undefined} payload
   */
  function handleFilterData(payload) {
    const view = currentView;
    if (!view || view.filter !== 'pending' || !payload || payload.seq !== view.filterSeq || payload.table !== view.tableName) {
      return;
    }
    if (Array.isArray(payload.errors) && payload.errors.length > 0) {
      // Keep whatever rows are showing; just point at the boxes that didn't parse.
      view.filter = 'invalid';
      for (const error of payload.errors) {
        const input = view.filterInputs[error.column];
        if (input) {
          input.setAttribute('aria-invalid', 'true');
          input.title = String(error.message);
        }
      }
      return;
    }
    if (typeof payload.failedReason === 'string' || !Array.isArray(payload.rows) || typeof payload.matchCount !== 'number') {
      view.filter = 'failed';
      restoreOriginalRows(view);
      const reason = typeof payload.failedReason === 'string' ? payload.failedReason : 'unexpected reply';
      view.statsBar.textContent = `${view.baseStatsText} — filter unavailable: ${reason}`;
      return;
    }
    view.filter = 'active';
    renderRows(view.tbody, payload.rows);
    view.wrapper.scrollTop = 0;
    const total = view.totalRowCount != null ? view.totalRowCount : view.rowCount;
    let text = `${payload.matchCount.toLocaleString()} of ${total.toLocaleString()} row${total !== 1 ? 's' : ''} match`;
    if (payload.matchCount > payload.rows.length) {
      text += ` (showing first ${payload.rows.length.toLocaleString()} — increase tablas.maxRows in settings to see more)`;
    }
    view.statsBar.textContent = text;
  }

  /**
   * Wires the filter row's inputs, the clear-all button and Alt+click. Called
   * once the view exists; every handler closes over that view, so a handler
   * that outlives a re-render finds `currentView !== view` and does nothing.
   * @param {NonNullable<typeof currentView>} view
   */
  function wireFilterRow(view) {
    view.filterInputs.forEach((input) => {
      input.addEventListener('input', () => {
        updateFilterChrome(view);
        scheduleFilter(view);
      });
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          sendFilter(view);
        } else if (event.key === 'Escape' && input.value !== '') {
          // Clears the box, and stops here so it doesn't also close an open card.
          event.preventDefault();
          event.stopPropagation();
          input.value = '';
          sendFilter(view);
        }
      });
    });

    view.clearButton.addEventListener('click', () => {
      for (const input of view.filterInputs) { input.value = ''; }
      sendFilter(view);
      if (view.filterInputs[0]) { view.filterInputs[0].focus(); }
    });

    // Alt+click a cell: filter its column to exactly that value.
    view.tbody.addEventListener('click', (event) => {
      if (!event.altKey) { return; }
      const cell = /** @type {Element} */ (event.target).closest('td');
      if (!cell || cell.classList.contains('row-num')) { return; }
      const input = view.filterInputs[/** @type {HTMLTableCellElement} */ (cell).cellIndex - 1]; // minus the row-number gutter
      const text = cell.textContent || '';
      const value = '=' + text;
      // A one-line box can't hold a line break, the host rejects over-long text,
      // and it trims the box: trailing spaces would turn "=abc " into "=abc",
      // which matches nothing. (A whitespace-only cell is fine: "=" means empty.)
      if (!input || /[\r\n]/.test(value) || value.length > MAX_FILTER_TEXT_LENGTH
        || (text.trim() !== '' && /\s$/.test(text))) { return; }
      event.preventDefault();
      input.value = value;
      sendFilter(view);
    });
  }

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
    // A new table replaces the old one's filters. Tell the host if there were
    // any, so it can release what it cached (and drop a filter still running).
    const previous = currentView;
    if (previous) {
      cancelFilterTimer(previous);
      if (previous.filter !== 'none') {
        vscode.postMessage(withTable(previous, { type: 'filter', seq: ++filterSeqCounter, filters: [] }));
      }
    }
    currentView = undefined;

    if (data.columnCount === 0) {
      appendMessage('Empty file — no data to display.', false);
      return;
    }

    const coverNote = data.totalRowCount != null && data.totalRowCount > data.rowCount
      ? `Statistics cover all ${data.totalRowCount.toLocaleString()} rows, not just the ${data.rowCount.toLocaleString()} shown.`
      : undefined;

    // Stats header: the text-only stats bar plus a status span. Column
    // statistics themselves aren't in `data`: they're requested once the rows
    // are in the DOM (see requestStats) and drawn into the headers on arrival.
    const statsHeader = el('div', { class: 'stats-header' });
    // A live region: the filter's "N of M rows match" is announced as it changes.
    const statsBar = el('div', { class: 'stats-bar', 'aria-live': 'polite' });
    let statsText = `${data.rowCount} row${data.rowCount !== 1 ? 's' : ''} × ${data.columnCount} column${data.columnCount !== 1 ? 's' : ''}`;
    if (data.totalRowCount != null && data.totalRowCount > data.rowCount) {
      statsText += ` (showing first ${data.rowCount} of ${data.totalRowCount} — increase tablas.maxRows in settings to see more)`;
    }
    statsBar.textContent = statsText;
    const baseStatsText = statsText;
    statsHeader.appendChild(statsBar);

    const statusEl = renderStatsStatus();
    statsHeader.appendChild(statusEl);
    app.appendChild(statsHeader);

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

    // Filter row: one box per column, under the header (and its profile strips).
    // Same cell order as the header row, which Alt+click and the tests rely on.
    const filterRow = el('tr', { class: 'filter-row' });
    const filterGutter = el('th', { class: 'row-num' });
    const clearButton = /** @type {HTMLButtonElement} */ (el('button', {
      type: 'button',
      class: 'filter-clear',
      'aria-label': 'Clear all filters',
      title: 'Clear all filters',
    }));
    clearButton.textContent = '×';
    clearButton.hidden = true;
    filterGutter.appendChild(clearButton);
    filterRow.appendChild(filterGutter);
    /** @type {HTMLInputElement[]} */
    const filterInputs = [];
    data.headers.forEach((header) => {
      const cell = el('th', { class: 'filter-cell' });
      const input = /** @type {HTMLInputElement} */ (el('input', {
        type: 'search',
        class: 'col-filter',
        placeholder: 'Filter…',
        maxlength: String(MAX_FILTER_TEXT_LENGTH),
        autocomplete: 'off',
        spellcheck: 'false',
        'aria-label': `Filter ${header}`,
        title: FILTER_HELP,
      }));
      cell.appendChild(input);
      filterRow.appendChild(cell);
      filterInputs.push(input);
    });
    thead.appendChild(filterRow);
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

    const tbody = el('tbody');
    renderRows(tbody, data.rows);
    table.appendChild(tbody);
    wrapper.appendChild(table);
    app.appendChild(wrapper);

    currentView = {
      wrapper,
      thead,
      tbody,
      ths,
      gutterTh: rnHeader,
      statusEl,
      statsBar,
      tableName,
      headers: data.headers,
      rowCount: data.rowCount,
      totalRowCount: data.totalRowCount,
      coverNote,
      models: undefined,
      skippedReason: undefined,
      stats: 'idle',
      originalRows: data.rows,
      baseStatsText,
      filterInputs,
      clearButton,
      filterSeq: 0,
      filterTimer: undefined,
      filter: 'none',
    };
    wireFilterRow(currentView);
    requestStats();
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
    } else if (message.type === 'filter-data') {
      handleFilterData(message.payload);
    }
  });

  // Signal to extension host that the webview is ready
  vscode.postMessage({ type: 'ready' });
})();
