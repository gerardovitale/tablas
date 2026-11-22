// @ts-check
'use strict';

(function () {
  const vscode = acquireVsCodeApi();

  // Above this row count, switch to table-layout: fixed (see styles.css)
  // to skip the full-content layout pass. Below it, auto layout looks
  // better (columns hug their actual content) and the pass is cheap
  // enough not to matter.
  const LARGE_TABLE_ROW_THRESHOLD = 500;
  // Row virtualization: a table with more rows than this draws only the rows around the
  // viewport (plus ROW_OVERSCAN beyond each edge) between two spacer rows that stand in for the
  // rest, so a 200k-row table costs a screenful of DOM, not 200k x columns of it. The window is
  // redrawn once the viewport gets within ROW_WINDOW_MARGIN rows of an edge of what is drawn.
  const VIRTUALIZE_ABOVE_ROWS = LARGE_TABLE_ROW_THRESHOLD;
  const ROW_OVERSCAN = 30;
  const ROW_WINDOW_MARGIN = 10;
  /** Rows drawn to measure how tall one is (every row is one line, so they are all alike). */
  const ROW_MEASURE_SAMPLE = 20;

  const SVG_NS = 'http://www.w3.org/2000/svg';

  /**
   * How each ColumnStats.type is shown: a 16x16 outline icon (stroked with
   * currentColor by `.type-icon`, so it follows the theme) and a name. Kinds are
   * told apart by shape first; the per-kind colour in styles.css only adds to
   * that, so high-contrast themes and colour-blind users lose nothing. Each
   * shape is `[tag, attributes]`; `solid: '1'` marks a filled dot.
   * @typedef {{ icon: Array<[string, Record<string, string>]>, name: string }} KindInfo
   * @type {Record<string, KindInfo>}
   */
  const KIND_INFO = {
    // #
    integer: { name: 'integer', icon: [['path', { d: 'M6.5 2.5 5.5 13.5M11 2.5 10 13.5M3 6h10.5M2.5 10h10.5' }]] },
    // # with a decimal point
    float: {
      name: 'float',
      icon: [
        ['path', { d: 'M5.5 2.5 4.5 11.5M10 2.5 9 11.5M2.5 5.5h9M2 9h9' }],
        ['circle', { cx: '13', cy: '12.5', r: '1.3', solid: '1' }],
      ],
    },
    // a switch
    boolean: {
      name: 'boolean',
      icon: [
        ['rect', { x: '1.5', y: '4.5', width: '13', height: '7', rx: '3.5' }],
        ['circle', { cx: '10.5', cy: '8', r: '1.6', solid: '1' }],
      ],
    },
    // a calendar
    date: {
      name: 'date/time',
      icon: [
        ['rect', { x: '2.5', y: '3.5', width: '11', height: '10', rx: '1.5' }],
        ['path', { d: 'M2.5 6.5h11M5.5 2v3M10.5 2v3' }],
      ],
    },
    // lines of text
    text: { name: 'text', icon: [['path', { d: 'M2.5 4h11M2.5 8h11M2.5 12h6.5' }]] },
    // two arrows crossing
    mixed: { name: 'mixed types', icon: [['path', { d: 'M2 4.5h2.5L11 11.5h3M2 11.5h2.5L11 4.5h3M12 2.5l2 2-2 2M12 9.5l2 2-2 2' }]] },
    // { }
    other: {
      name: 'nested or binary',
      icon: [['path', { d: 'M6 2.5c-1.5 0-2 .8-2 2v2c0 1-.6 1.5-1.5 1.5.9 0 1.5.5 1.5 1.5v2c0 1.2.5 2 2 2M10 2.5c1.5 0 2 .8 2 2v2c0 1 .6 1.5 1.5 1.5-.9 0-1.5.5-1.5 1.5v2c0 1.2-.5 2-2 2' }]],
    },
    // a crossed-out circle
    empty: {
      name: 'no values',
      icon: [
        ['circle', { cx: '8', cy: '8', r: '5.5' }],
        ['path', { d: 'M4.2 11.8 11.8 4.2' }],
      ],
    },
  };

  /**
   * @typedef {Object} ColumnModel
   * @property {number} index
   * @property {string} name
   * @property {import('../../src/tableData').ColumnStats} column
   * @property {KindInfo} info
   * @property {number} nonNull
   * @property {number} nullFrac
   * @property {string} nullText   "0", or "N (P%)"
   * @property {string} nullPct    percentage text without the % sign
   * @property {string} distinctText
   * @property {number | undefined} distinctRatio  distinct / non-null, 0..1
   * @property {string | undefined} distinctTag    "unique" | "constant"
   * @property {string | undefined} rangeText      "min → max" for date columns
   * @property {string} summary    accessible name for the profile button
   * @property {string | undefined} description  the column's description (dbt docs), if the host has one
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
   *          pendingScroll?: { top: number, left: number },
   *          rowsHidden?: boolean, statsSeq?: number,
   *          resultSeq?: number,
   *          rowHeight?: number, scrollQueued?: boolean,
   *          shownRows?: string[][], sel?: Selection, selectionEl?: HTMLElement,
   *          win?: { rows: string[][], rowHeight: number, start: number, end: number, top: HTMLElement, bottom: HTMLElement },
   *          descriptions: Array<string | undefined>,
   *          filter: 'none' | 'pending' | 'active' | 'invalid' | 'failed' } | undefined}
   */
  let currentView;

  // Webview-wide `filter` request counter: every request takes the next number
  // and only a reply carrying the newest one is applied. Never reset, so a
  // reply for a table that has since been replaced can't collide with a new one.
  let filterSeqCounter = 0;
  // The same for `get-stats` requests.
  let statsSeqCounter = 0;
  const FILTER_DEBOUNCE_MS = 250;
  // Mirrors filterLimits.maxTextLength in src/filter.ts: the host rejects longer text.
  const MAX_FILTER_TEXT_LENGTH = 1000;
  const FILTER_HELP =
    'Filter this column. text: contains · !text: does not contain · =text: equals · =: empty · !=: not empty · ' +
    '> >= < <=: compare numbers or dates · \\text: literal. Esc clears. Alt+click a cell to filter by its value.';

  /** @type {{ card: HTMLElement, trigger: HTMLElement, th: HTMLElement } | undefined} */
  let openCard;

  /**
   * The table picker's open popup, if any (at most one). `root` is the whole
   * picker (trigger + popup), so a press on the trigger is "inside".
   * @type {{ root: HTMLElement, close: (restoreFocus: boolean) => void } | undefined}
   */
  let openPicker;
  let pickerIdCounter = 0;

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
    if (openPicker) { openPicker.close(false); }
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

      const typeName = column.nativeType ? `${info.name}, ${column.nativeType}` : info.name;
      const summary = `Details for ${name}: ${typeName}, `
        + (column.nullCount > 0 ? `${nullText} nulls` : 'no nulls')
        + (column.distinctCount !== undefined ? `, ${distinctText} distinct` : '');

      return {
        index, name, column, info, nonNull, nullFrac, nullText, nullPct,
        distinctText, distinctRatio, distinctTag, rangeText, summary,
        description: data.descriptions ? data.descriptions[index] : undefined,
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
    const label = typeLabel(model);
    const badge = el('span', {
      class: `type-badge type-${model.column.type}`,
      'data-kind': model.column.type,
      role: 'img',
      'aria-label': label,
      title: label,
    });
    const svg = svgEl('svg', { class: 'type-icon', width: '14', height: '14', viewBox: '0 0 16 16', 'aria-hidden': 'true' });
    for (const [tag, attrs] of model.info.icon) {
      const { solid, ...rest } = attrs;
      svg.appendChild(svgEl(tag, solid ? { ...rest, class: 'type-icon-solid' } : rest));
    }
    badge.appendChild(svg);
    return badge;
  }

  /** "integer", or "integer · BIGINT" when the source names its own type. @param {ColumnModel} model */
  function typeLabel(model) {
    return model.column.nativeType ? `${model.info.name} · ${model.column.nativeType}` : model.info.name;
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
    const seq = ++statsSeqCounter;
    view.statsSeq = seq;
    applyStatsStatus();
    vscode.postMessage(withTable(view, { type: 'get-stats', seq }));
  }

  /**
   * Attaches a `stats-data` reply to the view it was requested for. Replies
   * for another table, or after the view was re-rendered, are dropped (the
   * host echoes `table`; CSV/Parquet have none, so `undefined` matches).
   * @param {{ table?: string, stats?: import('../../src/tableData').TableStats } | undefined} payload
   */
  function handleStatsData(payload) {
    const view = currentView;
    // The seq is what tells this view's reply from a slower one for the same table's previous view
    // (a refresh re-renders the table while the old handle's scan may still be running).
    if (
      !view || view.stats !== 'pending' || !payload || payload.table !== view.tableName ||
      payload.result !== view.resultSeq || payload.seq !== view.statsSeq
    ) { return; }
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
    sub.textContent = typeLabel(model);
    card.appendChild(sub);
    if (model.description) {
      const about = el('p', { class: 'card-description' });
      about.textContent = model.description;
      card.appendChild(about);
    }

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

  // ── Selection ─────────────────────────────────────────────────────────
  //
  // Click a cell, a row number or a column name to select it (JetBrains-style): Shift extends
  // from the anchor, Cmd/Ctrl adds another range, dragging sweeps, the arrow keys move and
  // Cmd/Ctrl+C copies the selection as tab-separated text. State is by row *index* into
  // `view.shownRows` (the rows the table is showing), never by DOM node: with row
  // virtualization most rows are not in the DOM, and the ones that are get redrawn.

  /** Above this many cells a selection is counted but not summed. */
  const SELECTION_SCAN_CAP = 250000;
  const NUMERIC_CELL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

  /**
   * @typedef {{ r0: number, r1: number, c0: number, c1: number }} SelRange
   * @typedef {{ r: number, c: number }} SelSpot
   * @typedef {{ ranges: SelRange[], kind: 'cells' | 'rows' | 'cols', anchor: SelSpot, cursor: SelSpot }} Selection
   */

  /** The mouse gesture in progress (a drag extends the selection it started). @type {{ view: NonNullable<typeof currentView>, kind: 'cells' | 'rows' | 'cols' } | undefined} */
  let selectionDrag;
  /** Set only while Cmd/Ctrl+Shift+C asks the `copy` handler to add the header line. */
  let copyWithHeaders = false;

  /**
   * The range between two spots: a rectangle of cells, or whole rows / whole columns.
   * @param {'cells' | 'rows' | 'cols'} kind
   * @param {SelSpot} a
   * @param {SelSpot} b
   * @param {NonNullable<typeof currentView>} view
   * @returns {SelRange}
   */
  function makeRange(kind, a, b, view) {
    const rows = view.shownRows ? view.shownRows.length : 0;
    const cols = view.headers.length;
    const r0 = Math.min(a.r, b.r);
    const r1 = Math.max(a.r, b.r);
    const c0 = Math.min(a.c, b.c);
    const c1 = Math.max(a.c, b.c);
    if (kind === 'rows') { return { r0, r1, c0: 0, c1: cols - 1 }; }
    if (kind === 'cols') { return { r0: 0, r1: rows - 1, c0, c1 }; }
    return { r0, r1, c0, c1 };
  }

  /**
   * Plain click replaces the selection, Shift extends the active range from the anchor, Cmd/Ctrl adds a range.
   * @param {NonNullable<typeof currentView>} view
   * @param {'cells' | 'rows' | 'cols'} kind
   * @param {SelSpot} spot
   * @param {boolean} extend
   * @param {boolean} add
   */
  function applySelection(view, kind, spot, extend, add) {
    const sel = view.sel;
    if (extend && sel && sel.kind === kind) {
      const ranges = sel.ranges.slice(0, -1);
      ranges.push(makeRange(kind, sel.anchor, spot, view));
      view.sel = { ranges, kind, anchor: sel.anchor, cursor: spot };
    } else if (add && sel) {
      view.sel = { ranges: [...sel.ranges, makeRange(kind, spot, spot, view)], kind, anchor: spot, cursor: spot };
    } else {
      view.sel = { ranges: [makeRange(kind, spot, spot, view)], kind, anchor: spot, cursor: spot };
    }
    paintSelection(view);
  }

  /** @param {NonNullable<typeof currentView>} view */
  function selectAll(view) {
    const rows = view.shownRows ? view.shownRows.length : 0;
    if (rows === 0) { return; }
    const last = { r: rows - 1, c: view.headers.length - 1 };
    view.sel = { ranges: [makeRange('cells', { r: 0, c: 0 }, last, view)], kind: 'cells', anchor: { r: 0, c: 0 }, cursor: last };
    paintSelection(view);
  }

  /** @param {NonNullable<typeof currentView>} view */
  function clearSelection(view) {
    if (!view.sel) { return; }
    view.sel = undefined;
    paintSelection(view);
  }

  /** The row index a drawn <tr> stands for: its gutter number minus one. @param {Element | null} tr */
  function rowIndexOf(tr) {
    const gutter = tr && /** @type {HTMLTableRowElement} */ (tr).cells && /** @type {HTMLTableRowElement} */ (tr).cells[0];
    return gutter ? Number(gutter.textContent) - 1 : -1;
  }

  /**
   * Which cell, row or column an element is, for the kind of gesture under way.
   * @param {Element} target
   * @param {'cells' | 'rows' | 'cols'} kind
   * @param {SelSpot} fallback used for the part the element does not say (the column of a gutter cell, ...)
   * @returns {SelSpot | undefined}
   */
  function spotOf(target, kind, fallback) {
    const cell = target.closest('td, th');
    if (!cell || cell.classList.contains('spacer-cell')) { return undefined; }
    const inBody = cell.tagName === 'TD';
    const column = cell.classList.contains('row-num') ? fallback.c : /** @type {HTMLTableCellElement} */ (cell).cellIndex - 1;
    if (kind === 'cols') {
      return inBody || !(cell.parentElement && cell.parentElement.classList.contains('filter-row'))
        ? { r: 0, c: Math.max(0, column) }
        : undefined;
    }
    if (!inBody) { return undefined; }
    const r = rowIndexOf(cell.parentElement);
    return r < 0 ? undefined : { r, c: kind === 'rows' ? 0 : Math.max(0, column) };
  }

  /**
   * @param {NonNullable<typeof currentView>} view
   * @param {MouseEvent} event
   */
  function onTableMouseDown(view, event) {
    if (event.button !== 0 || event.altKey) { return; } // Alt+click is the filter shortcut
    const target = /** @type {Element | null} */ (event.target);
    if (!target || !target.closest || target.closest('input, button, textarea, select, a')) { return; }
    const cell = target.closest('td, th');
    if (!cell || !view.shownRows || cell.classList.contains('spacer-cell')) { return; }
    const extend = event.shiftKey;
    const add = event.metaKey || event.ctrlKey;
    /** @type {'cells' | 'rows' | 'cols'} */
    let kind = 'cells';
    if (cell.tagName === 'TH') {
      if (cell.parentElement && cell.parentElement.classList.contains('filter-row')) { return; }
      if (cell.classList.contains('row-num')) {
        event.preventDefault();
        view.wrapper.focus({ preventScroll: true });
        selectAll(view);
        return;
      }
      kind = 'cols';
    } else if (cell.classList.contains('row-num')) {
      kind = 'rows';
    }
    const spot = spotOf(target, kind, view.sel ? view.sel.cursor : { r: 0, c: 0 });
    if (!spot) { return; }
    // No default: it would start a native text selection and drag the page around.
    event.preventDefault();
    view.wrapper.focus({ preventScroll: true });
    applySelection(view, kind, spot, extend, add);
    selectionDrag = { view, kind };
  }

  document.addEventListener('mousemove', (event) => {
    const drag = selectionDrag;
    if (!drag) { return; }
    if (currentView !== drag.view || !(event.buttons & 1)) { selectionDrag = undefined; return; }
    const sel = drag.view.sel;
    const target = /** @type {Element | null} */ (event.target);
    if (!sel || !target || !target.closest) { return; }
    const spot = spotOf(target, drag.kind, sel.cursor);
    if (!spot || (spot.r === sel.cursor.r && spot.c === sel.cursor.c)) { return; }
    applySelection(drag.view, drag.kind, spot, true, false);
  });
  document.addEventListener('mouseup', () => { selectionDrag = undefined; });

  /**
   * Arrow keys, Home/End, PageUp/PageDown and Cmd/Ctrl+A on the focused table; Escape clears.
   * With no selection the keys are left alone (they scroll the table natively).
   * @param {NonNullable<typeof currentView>} view
   * @param {KeyboardEvent} event
   */
  function onTableKeyDown(view, event) {
    const target = /** @type {Element | null} */ (event.target);
    if (target && target.closest && target.closest('input, textarea, button, select')) { return; }
    const mod = event.metaKey || event.ctrlKey;
    const key = event.key;
    if (mod && !event.altKey && key.toLowerCase() === 'a') {
      event.preventDefault();
      selectAll(view);
      return;
    }
    if (mod && event.shiftKey && key.toLowerCase() === 'c') {
      if (view.sel && typeof document.execCommand === 'function') {
        event.preventDefault();
        copyWithHeaders = true;
        try { document.execCommand('copy'); } finally { copyWithHeaders = false; }
      }
      return;
    }
    const sel = view.sel;
    if (key === 'Escape') {
      // An open statistics card closes first (its own handler, one level up).
      if (sel && !openCard) {
        event.stopPropagation();
        clearSelection(view);
      }
      return;
    }
    if (!sel || !view.shownRows || event.altKey) { return; }
    const rows = view.shownRows.length;
    const cols = view.headers.length;
    const { r, c } = sel.cursor;
    const page = Math.max(1, Math.floor((view.wrapper.clientHeight || 400) / rowHeightOf(view)) - 1);
    /** @type {SelSpot | undefined} */
    let next;
    switch (key) {
      case 'ArrowUp': next = { r: mod ? 0 : r - 1, c }; break;
      case 'ArrowDown': next = { r: mod ? rows - 1 : r + 1, c }; break;
      case 'ArrowLeft': next = { r, c: mod ? 0 : c - 1 }; break;
      case 'ArrowRight': next = { r, c: mod ? cols - 1 : c + 1 }; break;
      case 'Home': next = { r: mod ? 0 : r, c: 0 }; break;
      case 'End': next = { r: mod ? rows - 1 : r, c: cols - 1 }; break;
      case 'PageUp': next = { r: r - page, c }; break;
      case 'PageDown': next = { r: r + page, c }; break;
      default: return;
    }
    event.preventDefault();
    const spot = { r: Math.max(0, Math.min(rows - 1, next.r)), c: Math.max(0, Math.min(cols - 1, next.c)) };
    if (event.shiftKey) {
      // Rows/columns stay whole while extended along their own axis.
      applySelection(view, sel.kind, spot, true, false);
    } else {
      applySelection(view, 'cells', spot, false, false);
    }
    revealCell(view, spot);
  }

  /**
   * Puts a selection back after a refresh, cut to the rows the table has now (it may have shrunk).
   * @param {NonNullable<typeof currentView>} view
   * @param {Selection | undefined} previous
   */
  function restoreSelection(view, previous) {
    const rows = view.shownRows ? view.shownRows.length : 0;
    if (!previous || rows === 0) { return; }
    const last = rows - 1;
    const ranges = previous.ranges
      .filter((g) => g.r0 <= last)
      .map((g) => ({ ...g, r1: Math.min(g.r1, last) }));
    if (ranges.length === 0) { return; }
    const clamp = (/** @type {SelSpot} */ spot) => ({ r: Math.min(spot.r, last), c: spot.c });
    view.sel = { ranges, kind: previous.kind, anchor: clamp(previous.anchor), cursor: clamp(previous.cursor) };
    paintSelection(view);
  }

  /** One row's height in px: measured, else read from a drawn row, else a typical one. @param {NonNullable<typeof currentView>} view */
  function rowHeightOf(view) {
    if (view.win) { return view.win.rowHeight; }
    if (view.rowHeight) { return view.rowHeight; }
    const row = view.tbody.rows[0];
    return (row && row.getBoundingClientRect().height) || 24;
  }

  /**
   * Scrolls so the cell is in view, clear of the sticky header and gutter.
   * @param {NonNullable<typeof currentView>} view
   * @param {SelSpot} spot
   */
  function revealCell(view, spot) {
    const wrapper = view.wrapper;
    const headerHeight = view.thead.getBoundingClientRect().height;
    if (view.win) {
      // The row may not be drawn: bring its position into the viewport arithmetically, then draw it.
      const top = spot.r * view.win.rowHeight;
      const viewport = (wrapper.clientHeight || 400) - headerHeight;
      if (top < wrapper.scrollTop) { wrapper.scrollTop = top; }
      else if (top + view.win.rowHeight > wrapper.scrollTop + viewport) { wrapper.scrollTop = top + view.win.rowHeight - viewport; }
      syncWindow(view);
    }
    const tr = view.win
      ? view.tbody.rows[spot.r - view.win.start + 1]
      : view.tbody.rows[spot.r];
    const td = tr && tr.cells[spot.c + 1];
    if (!td) { return; }
    const box = td.getBoundingClientRect();
    const frame = wrapper.getBoundingClientRect();
    const gutter = view.gutterTh.getBoundingClientRect().width;
    if (box.top < frame.top + headerHeight) { wrapper.scrollTop -= frame.top + headerHeight - box.top; }
    else if (box.bottom > frame.bottom) { wrapper.scrollTop += box.bottom - frame.bottom; }
    if (box.left < frame.left + gutter) { wrapper.scrollLeft -= frame.left + gutter - box.left; }
    else if (box.right > frame.right) { wrapper.scrollLeft += box.right - frame.right; }
    syncWindow(view);
  }

  /**
   * Marks the drawn cells, row numbers and column headers that the selection covers.
   * Cheap enough to run on every redraw: only the (few) drawn rows are visited.
   * @param {NonNullable<typeof currentView>} view
   */
  function paintSelection(view) {
    const sel = view.sel;
    const ranges = sel ? sel.ranges : [];
    const cols = view.headers.length;
    const total = view.shownRows ? view.shownRows.length : 0;
    const rows = view.tbody.rows;
    for (let i = 0; i < rows.length; i++) {
      const tr = rows[i];
      if (tr.classList.contains('row-spacer')) { continue; }
      const r = rowIndexOf(tr);
      const hit = ranges.filter((g) => r >= g.r0 && r <= g.r1);
      tr.cells[0].classList.toggle('is-selected', hit.some((g) => g.c0 === 0 && g.c1 === cols - 1));
      for (let c = 0; c < cols; c++) {
        const td = tr.cells[c + 1];
        if (!td) { break; }
        td.classList.toggle('is-selected', hit.some((g) => c >= g.c0 && c <= g.c1));
        td.classList.toggle('is-cursor', !!sel && sel.kind === 'cells' && sel.cursor.r === r && sel.cursor.c === c);
      }
    }
    view.ths.forEach((th, c) => {
      th.classList.toggle('is-selected', ranges.some((g) => g.r0 === 0 && g.r1 === total - 1 && c >= g.c0 && c <= g.c1));
    });
    view.gutterTh.classList.toggle(
      'is-selected',
      ranges.some((g) => g.r0 === 0 && g.r1 === total - 1 && g.c0 === 0 && g.c1 === cols - 1)
    );
    if (view.selectionEl) {
      const text = selectionSummary(view);
      view.selectionEl.textContent = text;
      view.selectionEl.hidden = text === '';
    }
  }

  /**
   * "12 cells selected · Sum 340 · Avg 28.3 · Min 1 · Max 99"; the figures only when every
   * non-empty selected cell is a number, and nothing for a single cell.
   * @param {NonNullable<typeof currentView>} view
   */
  function selectionSummary(view) {
    const sel = view.sel;
    const shown = view.shownRows;
    if (!sel || !shown) { return ''; }
    const cols = view.headers.length;
    let area = 0;
    for (const g of sel.ranges) { area += (g.r1 - g.r0 + 1) * (g.c1 - g.c0 + 1); }
    if (area <= 1) { return ''; }
    if (area > SELECTION_SCAN_CAP) { return `${area.toLocaleString()} cells selected`; }
    const seen = sel.ranges.length > 1 ? new Set() : undefined;
    let cells = 0;
    let nonEmpty = 0;
    let sum = 0;
    let min = Infinity;
    let max = -Infinity;
    let numeric = true;
    for (const g of sel.ranges) {
      for (let r = g.r0; r <= g.r1; r++) {
        const row = shown[r] || [];
        for (let c = g.c0; c <= g.c1; c++) {
          if (seen) {
            const key = r * cols + c;
            if (seen.has(key)) { continue; }
            seen.add(key);
          }
          cells++;
          const text = (row[c] === undefined ? '' : row[c]).trim();
          if (text === '') { continue; }
          nonEmpty++;
          const n = NUMERIC_CELL.test(text) ? Number(text) : NaN;
          if (Number.isFinite(n)) {
            sum += n;
            if (n < min) { min = n; }
            if (n > max) { max = n; }
          } else {
            numeric = false;
          }
        }
      }
    }
    const label = `${cells.toLocaleString()} cells selected`;
    if (!numeric || nonEmpty === 0) { return label; }
    return `${label} · Sum ${formatNumber(sum)} · Avg ${formatNumber(sum / nonEmpty)} · Min ${formatNumber(min)} · Max ${formatNumber(max)}`;
  }

  /** One cell as a spreadsheet pastes it: quoted when it holds a tab, a line break or a quote. @param {string} text */
  function tsvCell(text) {
    return /[\t\r\n"]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  /**
   * The selection as tab-separated text, one block per range. Reads the data, not the DOM,
   * so rows that are not drawn are copied too.
   * @param {NonNullable<typeof currentView>} view
   * @param {boolean} withHeaders add the column names above the first range
   */
  function selectionToTsv(view, withHeaders) {
    const sel = view.sel;
    const shown = view.shownRows;
    if (!sel || !shown) { return ''; }
    const blocks = sel.ranges.map((g, index) => {
      const lines = [];
      if (withHeaders && index === 0) {
        lines.push(view.headers.slice(g.c0, g.c1 + 1).map(tsvCell).join('\t'));
      }
      for (let r = g.r0; r <= g.r1; r++) {
        const row = shown[r] || [];
        const cells = [];
        for (let c = g.c0; c <= g.c1; c++) { cells.push(tsvCell(row[c] === undefined ? '' : row[c])); }
        lines.push(cells.join('\t'));
      }
      return lines.join('\n');
    });
    return blocks.join('\n');
  }

  // Registered once. Leaves a copy alone when the user is copying from a text box or has
  // selected text elsewhere (the statistics card), so those keep working.
  document.addEventListener('copy', (event) => {
    const view = currentView;
    if (!view || !view.sel || !event.clipboardData) { return; }
    const active = document.activeElement;
    if (active && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) { return; }
    const selected = window.getSelection ? window.getSelection() : null;
    if (selected && selected.toString() !== '') { return; }
    event.clipboardData.setData('text/plain', selectionToTsv(view, copyWithHeaders));
    event.preventDefault();
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
    tbody.textContent = '';
    tbody.appendChild(buildRows(rows, 0, rows.length));
  }

  /**
   * The <tr>s for rows [start, end), numbered by their index in `rows` (so a window
   * starting at row 5000 still counts from 5001). Odd-numbered rows are `alt` for the
   * zebra stripes, which `:nth-child` cannot do once spacer rows shift the parity.
   * @param {string[][]} rows
   * @param {number} start
   * @param {number} end
   */
  function buildRows(rows, start, end) {
    const fragment = document.createDocumentFragment();
    for (let i = start; i < end; i++) {
      const tr = el('tr', i % 2 === 1 ? { class: 'alt' } : undefined);

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
    return fragment;
  }

  /**
   * Shows `rows` in the view's body: all of them for a small table, else a window of them
   * (see VIRTUALIZE_ABOVE_ROWS). Without layout (a hidden panel, or a test DOM) one row's
   * height cannot be measured, and the whole table is drawn as before.
   * @param {NonNullable<typeof currentView>} view
   * @param {string[][]} rows
   */
  function showRows(view, rows) {
    view.win = undefined;
    // New rows: what was selected by index no longer means anything.
    view.sel = undefined;
    view.shownRows = rows;
    if (rows.length <= VIRTUALIZE_ABOVE_ROWS) {
      renderRows(view.tbody, rows);
      paintSelection(view);
      return;
    }
    let rowHeight = view.rowHeight;
    if (!rowHeight) {
      const sample = Math.min(rows.length, ROW_MEASURE_SAMPLE);
      renderRows(view.tbody, rows.slice(0, sample));
      const measured = view.tbody.getBoundingClientRect().height / sample;
      if (!(measured > 0)) {
        renderRows(view.tbody, rows);
        paintSelection(view);
        return;
      }
      rowHeight = view.rowHeight = measured;
    }
    const columns = view.headers.length + 1; // plus the row-number gutter
    const spacer = () => {
      const tr = el('tr', { class: 'row-spacer', 'aria-hidden': 'true' });
      tr.appendChild(el('td', { class: 'spacer-cell', colspan: String(columns) }));
      return tr;
    };
    view.win = { rows, rowHeight, start: -1, end: -1, top: spacer(), bottom: spacer() };
    syncWindow(view, true);
  }

  /**
   * Redraws the window around the viewport if the viewport has moved close to an edge of
   * what is drawn (or `force`). Call it after anything that moves the scroll position from
   * script: the `scroll` event is asynchronous.
   * @param {NonNullable<typeof currentView> | undefined} view
   * @param {boolean=} force
   */
  function syncWindow(view, force) {
    const win = view && view.win;
    if (!view || !win) { return; }
    const total = win.rows.length;
    const scrollTop = view.wrapper.scrollTop;
    // A panel that is not laid out reports 0; assume a tall one rather than draw nothing.
    const viewport = view.wrapper.clientHeight || 1000;
    const needFirst = Math.floor(scrollTop / win.rowHeight);
    const needLast = Math.min(total, Math.ceil((scrollTop + viewport) / win.rowHeight));
    if (!force) {
      const topOk = win.start === 0 || needFirst >= win.start + ROW_WINDOW_MARGIN;
      const bottomOk = win.end === total || needLast <= win.end - ROW_WINDOW_MARGIN;
      if (topOk && bottomOk) { return; }
    }
    const first = Math.max(0, needFirst - ROW_OVERSCAN);
    const last = Math.min(total, Math.max(needLast, first + 1) + ROW_OVERSCAN);
    win.start = first;
    win.end = last;
    // CSSOM, not a style attribute: the CSP has no 'unsafe-inline' for styles.
    /** @type {HTMLElement} */ (win.top.firstElementChild).style.height = `${first * win.rowHeight}px`;
    /** @type {HTMLElement} */ (win.bottom.firstElementChild).style.height = `${(total - last) * win.rowHeight}px`;
    view.tbody.textContent = '';
    view.tbody.appendChild(win.top);
    view.tbody.appendChild(buildRows(win.rows, first, last));
    view.tbody.appendChild(win.bottom);
    paintSelection(view);
  }

  /** `scroll` events come in bursts: redraw at most once a frame. @param {NonNullable<typeof currentView>} view */
  function queueWindowSync(view) {
    if (!view.win || view.scrollQueued) { return; }
    view.scrollQueued = true;
    const run = () => {
      view.scrollQueued = false;
      if (currentView === view) { syncWindow(view); }
    };
    if (window.requestAnimationFrame) { window.requestAnimationFrame(run); } else { window.setTimeout(run, 0); }
  }

  /**
   * Addresses a request to what the view shows: its table, or the query result the host keeps
   * as a table (`result`, the seq of the run that made it). CSV/Parquet have neither.
   * @param {NonNullable<typeof currentView>} view @param {Record<string, unknown>} message
   */
  function withTable(view, message) {
    if (view.resultSeq !== undefined) { return { ...message, result: view.resultSeq }; }
    return view.tableName !== undefined ? { ...message, table: view.tableName } : message;
  }

  /**
   * Forgets the rendered table. A new table replaces the old one's filters: tell
   * the host if there were any, so it can release what it cached (and drop a
   * filter still running).
   */
  function releaseCurrentView() {
    const previous = currentView;
    if (previous) {
      cancelFilterTimer(previous);
      if (previous.filter !== 'none') {
        vscode.postMessage(withTable(previous, { type: 'filter', seq: ++filterSeqCounter, filters: [] }));
      }
    }
    currentView = undefined;
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
    view.rowsHidden = false;
    view.wrapper.scrollTop = 0;
    showRows(view, view.originalRows);
    view.statsBar.textContent = view.baseStatsText;
  }

  /**
   * Sends the boxes' current text to the host (blank boxes are dropped; the
   * host parses what's left). With nothing left to filter the original rows
   * are put back locally -- no round trip -- and the host is only told so it
   * can release anything it cached for this table.
   * @param {NonNullable<typeof currentView>} view
   * @param {boolean=} keepPendingScroll true only for the request a reload sends on the user's behalf
   */
  function sendFilter(view, keepPendingScroll) {
    cancelFilterTimer(view);
    if (currentView !== view) { return; }
    // The scroll position a reload wants back only belongs to the request the
    // reload itself sends; any filter the user changes after that starts at the top.
    if (!keepPendingScroll) { view.pendingScroll = undefined; }
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
   * Puts back the scroll position a reload captured, once, however its filter
   * request ended (applied, invalid or failed).
   * @param {NonNullable<typeof currentView>} view
   */
  function restorePendingScroll(view) {
    const scroll = view.pendingScroll;
    view.pendingScroll = undefined;
    if (!scroll) { return; }
    view.wrapper.scrollTop = scroll.top;
    view.wrapper.scrollLeft = scroll.left;
    syncWindow(view);
  }

  /**
   * Applies a `filter-data` reply to the view it was requested for. Replies
   * that were overtaken by a newer request (or belong to another table) are
   * dropped, so a slow answer can never overwrite a newer one.
   * @param {import('../../src/filterMessage').FilterPayload | undefined} payload
   */
  function handleFilterData(payload) {
    const view = currentView;
    if (
      !view || view.filter !== 'pending' || !payload || payload.seq !== view.filterSeq ||
      payload.table !== view.tableName || payload.result !== view.resultSeq
    ) {
      return;
    }
    if (Array.isArray(payload.errors) && payload.errors.length > 0) {
      // Keep whatever rows are showing; just point at the boxes that didn't parse.
      view.filter = 'invalid';
      // A reload hid the rows while it waited for this answer; there is no answer, so the table comes back.
      if (view.rowsHidden) { restoreOriginalRows(view); }
      restorePendingScroll(view);
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
      restorePendingScroll(view);
      const reason = typeof payload.failedReason === 'string' ? payload.failedReason : 'unexpected reply';
      view.statsBar.textContent = `${view.baseStatsText} — filter unavailable: ${reason}`;
      return;
    }
    view.filter = 'active';
    view.rowsHidden = false;
    // After a reload the user's scroll position comes back with the filtered rows.
    view.wrapper.scrollTop = 0;
    showRows(view, payload.rows);
    restorePendingScroll(view);
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
      if (!cell || cell.classList.contains('row-num') || cell.classList.contains('spacer-cell')) { return; }
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
   * @param {string=} tableError why reading `tableName` failed; shown instead of the table
   * @param {{ host?: HTMLElement, result?: { truncated: boolean, seq?: number, capped?: boolean }, columnDescriptions?: Record<string, string>, deferStats?: boolean }=} opts
   *   `host` is where to render instead of #app; `result` marks the rows of a query. With a `seq` the host
   *   keeps the result as a table, so it gets the filter row, statistics and type badges like any table
   *   (requests carry `result: seq` instead of a table name); without one (no table could be made) it is
   *   rows only, with a note. `capped`: the query had more rows than the host's table holds, so statistics
   *   and filters cover only the first `data.totalRowCount`. `columnDescriptions` (by column name, matched ignoring case) are shown in the header
   *   tooltip and the detail card; `deferStats` leaves the `get-stats` request to the caller (it must call
   *   `requestStats()` itself): a reload sends the filter first so the filtered rows are not queued behind a
   *   whole-table statistics scan.
   */
  function renderTable(data, tableName, tableError, opts) {
    const app = opts && opts.host ? opts.host : document.getElementById('app');
    if (!app) { return; }
    const result = opts && opts.result;
    // A result the host kept as a table is served like one; the rest is rows only.
    const addressable = !result || result.seq !== undefined;
    releaseCurrentView();

    if (tableError !== undefined) {
      appendMessage('Could not read "' + tableName + '":\n' + tableError, true);
      return;
    }
    if (data.columnCount === 0) {
      appendMessage('Empty file — no data to display.', false);
      return;
    }

    const heldRows = data.totalRowCount != null ? data.totalRowCount : data.rowCount;
    let coverNote = data.totalRowCount != null && data.totalRowCount > data.rowCount
      ? `Statistics cover all ${data.totalRowCount.toLocaleString()} rows, not just the ${data.rowCount.toLocaleString()} shown.`
      : undefined;
    if (result && result.capped) {
      coverNote = `Statistics and filters cover the first ${heldRows.toLocaleString()} rows of this result` +
        (heldRows > data.rowCount ? `, not just the ${data.rowCount.toLocaleString()} shown.` : '.');
    }

    // Stats header: the text-only stats bar plus a status span. Column
    // statistics themselves aren't in `data`: they're requested once the rows
    // are in the DOM (see requestStats) and drawn into the headers on arrival.
    const statsHeader = el('div', { class: 'stats-header' });
    // A live region: the filter's "N of M rows match" is announced as it changes.
    const statsBar = el('div', { class: 'stats-bar', 'aria-live': 'polite' });
    let statsText = `${data.rowCount} row${data.rowCount !== 1 ? 's' : ''} × ${data.columnCount} column${data.columnCount !== 1 ? 's' : ''}`;
    if (result && result.capped) {
      statsText += ` (the query returned more than ${heldRows.toLocaleString()} rows — statistics and filters cover the first ${heldRows.toLocaleString()}` +
        (heldRows > data.rowCount ? `; showing ${data.rowCount.toLocaleString()}, increase tablas.maxRows in settings to see more` : '') + ')';
    } else if (data.totalRowCount != null && data.totalRowCount > data.rowCount) {
      statsText += ` (showing first ${data.rowCount} of ${data.totalRowCount} — increase tablas.maxRows in settings to see more)`;
    } else if (result && result.truncated) {
      statsText += ` (the query returned more — showing the first ${data.rowCount} rows; increase tablas.maxRows in settings to see more)`;
    }
    statsBar.textContent = statsText;
    const baseStatsText = statsText;
    statsHeader.appendChild(statsBar);

    const statusEl = renderStatsStatus();
    statsHeader.appendChild(statusEl);
    // Beside the stats bar, not in it (the bar's text is asserted exactly): what is selected.
    const selectionEl = el('span', { class: 'selection-summary' });
    selectionEl.hidden = true;
    statsHeader.appendChild(selectionEl);
    app.appendChild(statsHeader);

    // Scroll wrapper
    const wrapper = el('div', { class: 'scroll-wrapper', tabindex: '0', 'aria-label': 'Table data' });

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
    const descriptionByName = new Map(
      Object.entries((opts && opts.columnDescriptions) || {}).map(([column, text]) => [column.toLowerCase(), text])
    );
    const descriptions = data.headers.map((header) => descriptionByName.get(header.toLowerCase()));
    data.headers.forEach((header, i) => {
      const th = el('th');
      const name = el('span', { class: 'col-name' });
      name.textContent = header;
      th.appendChild(name);
      const description = descriptions[i];
      th.title = description ? `${header}\n${description}` : header;
      if (description) { th.classList.add('has-description'); }
      headerRow.appendChild(th);
      ths.push(th);
    });
    thead.appendChild(headerRow);

    // Filter row: one box per column, under the header (and its profile strips).
    // Same cell order as the header row, which Alt+click and the tests rely on.
    // A query result the host did not keep as a table has none: there is nothing to filter against.
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
    (addressable ? data.headers : []).forEach((header) => {
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
    if (addressable) { thead.appendChild(filterRow); }
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
    table.appendChild(tbody);
    wrapper.appendChild(table);
    app.appendChild(wrapper);

    currentView = {
      wrapper,
      thead,
      tbody,
      ths,
      gutterTh: rnHeader,
      selectionEl,
      statusEl,
      statsBar,
      tableName,
      headers: data.headers,
      descriptions,
      rowCount: data.rowCount,
      totalRowCount: data.totalRowCount,
      coverNote,
      models: undefined,
      skippedReason: undefined,
      resultSeq: result ? result.seq : undefined,
      stats: addressable ? 'idle' : 'skipped',
      originalRows: data.rows,
      baseStatsText,
      filterInputs,
      clearButton,
      filterSeq: 0,
      filterTimer: undefined,
      filter: 'none',
    };
    // After the view exists and is in the document: a large table measures a row to size its window.
    const created = /** @type {NonNullable<typeof currentView>} */ (currentView);
    showRows(created, data.rows);
    wrapper.addEventListener('scroll', () => queueWindowSync(created), { passive: true });
    wrapper.addEventListener('mousedown', (event) => onTableMouseDown(created, event));
    wrapper.addEventListener('keydown', (event) => onTableKeyDown(created, event));
    if (addressable) {
      wireFilterRow(currentView);
      if (!(opts && opts.deferStats)) { requestStats(); }
    } else {
      created.skippedReason = 'Statistics and filters are not available for this result.';
      applyStatsStatus();
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
   * The toolbar's "Updated 14:32 · rows ..." / "Refreshing…" line, when the
   * source can refresh. Replaced on every multi-table render.
   * @type {HTMLElement | undefined}
   */
  let reloadStatusEl;

  // ── SQL mode (sources whose host advertises `capabilities.query`) ─────
  // Mode, text and the last result are module state, not DOM: every payload
  // (reload, table switch) rebuilds the page, and they must survive that.
  const MAX_QUERY_LENGTH = 100000; // mirrors queryLimits.maxSqlLength in src/duckdbParser.ts
  let queryMode = false;
  let queryText = '';
  // Whether the user has changed the box. Until then it holds the host's suggestion for the table
  // being viewed (re-read every time the box opens); after that the text is theirs and is kept.
  let queryTextEdited = false;
  /** The SQL that produced `queryResult`; what a refresh re-runs (not half-typed edits). */
  let queryRunSql;
  /** Webview-wide `run-query` counter; only a reply carrying the newest number is applied. */
  let querySeqCounter = 0;
  let queryRunning = false;
  /** @type {{ kind: 'data', data: import('../../src/tableData').ParsedTable, truncated: boolean, elapsedMs: number, seq?: number, capped?: boolean } | { kind: 'error', message: string } | undefined} */
  let queryResult;
  /** The last successful multi-table payload, to re-render when the mode is toggled. */
  let lastMultiOutcome;
  /** Table-mode filters and scroll, kept while the SQL box is showing. */
  let savedTableState;
  let focusQueryInput = false;
  /** @type {HTMLElement | undefined} */
  let queryResultHost;
  /** @type {HTMLTextAreaElement | undefined} */
  let queryInputEl;
  /** A refresh landed while a query was still running: re-run once it has answered. */
  let queryRerun;
  /** Result scroll position to put back once the re-run's answer is drawn. */
  let queryScrollToRestore;
  /**
   * The data changed (a refresh) while the SQL box was not showing, so the result held for it is
   * old. It is re-run when the box is opened again, not while nobody can see it.
   */
  let queryStale = false;
  /** @type {HTMLElement | undefined} */
  let queryStatusEl;

  // ── Table picker ──────────────────────────────────────────────────────

  /**
   * Small outline icon: a grid for a table, a dashed grid for a view. SVG built
   * with setAttribute only (the CSP forbids inline style).
   * @param {'table' | 'view'} type
   */
  function tableKindIcon(type) {
    const svg = pickerSvg('picker-icon', '1.2');
    const box = { x: '2', y: '3', width: '12', height: '10', rx: '1' };
    svg.appendChild(svgEl('rect', type === 'view' ? { ...box, 'stroke-dasharray': '2 1.5' } : box));
    svg.appendChild(svgEl('path', { d: 'M2 7h12M6.5 7v6' }));
    return svg;
  }

  /** @param {string} d */
  function pickerGlyph(d) {
    const svg = pickerSvg('picker-glyph', '1.4');
    svg.appendChild(svgEl('path', { d }));
    return svg;
  }

  /** The empty 14px outline-icon canvas shared by the picker's icons. @param {string} cls @param {string} strokeWidth */
  function pickerSvg(cls, strokeWidth) {
    return svgEl('svg', {
      class: cls, width: '14', height: '14', viewBox: '0 0 16 16',
      fill: 'none', stroke: 'currentColor', 'stroke-width': strokeWidth, 'aria-hidden': 'true',
    });
  }

  /**
   * Appends `name` to `parent`, wrapping the case-insensitive match of `query`
   * in <mark>. Text nodes only. Skipped when lower-casing changes the string's
   * length (e.g. "İ"), where the match offsets would no longer line up.
   * @param {HTMLElement} parent @param {string} name @param {string} query already lower-cased
   */
  function appendHighlighted(parent, name, query) {
    const index = query === '' || name.toLocaleLowerCase().length !== name.length
      ? -1
      : name.toLocaleLowerCase().indexOf(query);
    if (index < 0) {
      parent.appendChild(document.createTextNode(name));
      return;
    }
    const mark = el('mark');
    mark.textContent = name.slice(index, index + query.length);
    parent.appendChild(document.createTextNode(name.slice(0, index)));
    parent.appendChild(mark);
    parent.appendChild(document.createTextNode(name.slice(index + query.length)));
  }

  /**
   * "1,204" -> "1.2K": the row-count hint beside a table in the picker.
   * @param {number} n
   */
  const compactFormat = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
  function compactCount(n) {
    return compactFormat.format(n);
  }

  /**
   * Builds the table/view picker for a multi-table source (SQLite, DuckDB,
   * XLSX): a trigger button showing the current table that opens a searchable
   * listbox (a combobox: the search input owns focus, `aria-activedescendant`
   * names the highlighted option). Picking a different table posts
   * `select-table` to the extension host, which re-queries the already-open
   * source and answers with a fresh payload of the same message type -- see
   * renderMultiTableOutcome below. A source with tables in several schemas
   * (DuckDB, e.g. dbt's `staging`/`marts`) is grouped by schema, the group
   * header carrying the schema so the rows show the short table name; otherwise
   * Tables/Views group headers only appear when the source has both (XLSX sheets
   * are all "tables"). A table with a row-count estimate shows it as "~1.2K".
   * @param {import('../../src/tableData').TableRef[]} tables
   * @param {string} selectedTable
   */
  function renderTableSelector(tables, selectedTable) {
    const uid = 'table-picker-' + (++pickerIdCounter);
    const hasBothKinds = tables.some((t) => t.type === 'view') && tables.some((t) => t.type !== 'view');
    // A ref without a schema is in DuckDB's `main` (and other sources have none at all).
    const schemaOf = (/** @type {import('../../src/tableData').TableRef} */ t) => t.schema !== undefined ? t.schema : 'main';
    const bySchema = new Set(tables.map(schemaOf)).size > 1;
    let current = selectedTable;
    // Lower-cased once: the filter runs on every keystroke over every name. With
    // schema groups a `main` table is searched as `main.<name>` too, so typing
    // the header's name ("main", "main.raw") finds what is listed under it.
    const lowerNames = new Map(tables.map((t) => [
      t.name,
      (bySchema && t.schema === undefined ? `main.${t.name}` : t.name).toLocaleLowerCase(),
    ]));

    const wrapper = el('div', { class: 'table-selector' });
    const trigger = el('button', {
      type: 'button', class: 'table-picker-trigger',
      'aria-haspopup': 'listbox', 'aria-expanded': 'false',
    });
    wrapper.appendChild(trigger);

    function renderTrigger() {
      const ref = tables.find((t) => t.name === current);
      const type = ref && ref.type === 'view' ? 'view' : 'table';
      trigger.textContent = '';
      trigger.setAttribute('aria-label', 'Table: ' + current + (type === 'view' ? ' (view)' : ''));
      trigger.title = current;
      trigger.appendChild(tableKindIcon(type));
      const name = el('span', { class: 'picker-name' });
      name.textContent = current;
      trigger.appendChild(name);
      if (type === 'view') {
        const tag = el('span', { class: 'picker-tag' });
        tag.textContent = 'view';
        trigger.appendChild(tag);
      }
      trigger.appendChild(pickerGlyph('M4 6l4 4 4-4'));
    }
    renderTrigger();

    /** @type {HTMLElement | undefined} */
    let popup;

    /** @param {boolean} restoreFocus */
    function close(restoreFocus) {
      if (!popup) { return; }
      popup.remove();
      popup = undefined;
      openPicker = undefined;
      trigger.setAttribute('aria-expanded', 'false');
      if (restoreFocus) { trigger.focus(); }
    }

    /** @param {string} name */
    function pick(name) {
      if (name === current) {
        close(true);
        return;
      }
      current = name;
      requestedTable = name;
      renderTrigger();
      // Cleared by the re-render that the host's reply triggers.
      wrapper.setAttribute('aria-busy', 'true');
      // Close (and refocus the trigger) before posting: a reply that lands
      // synchronously re-renders and must find focus already on the trigger.
      close(true);
      vscode.postMessage({ type: 'select-table', table: name });
    }

    function open() {
      if (popup) { return; }
      if (openPicker) { openPicker.close(false); }
      closeCard(false);

      const popupEl = el('div', { class: 'table-picker-popup' });
      popup = popupEl;
      const search = /** @type {HTMLInputElement} */ (el('input', {
        type: 'text', class: 'table-picker-search', role: 'combobox',
        'aria-label': 'Filter tables', 'aria-controls': uid + '-list',
        'aria-expanded': 'true', 'aria-autocomplete': 'list',
        placeholder: `Filter ${tables.length} ${tables.length === 1 ? 'table' : 'tables'}…`,
        spellcheck: 'false', autocomplete: 'off',
      }));
      const list = el('ul', { class: 'table-picker-list', role: 'listbox', id: uid + '-list', 'aria-label': 'Tables' });
      popupEl.appendChild(search);
      popupEl.appendChild(list);

      /** @type {HTMLElement[]} */
      let options = [];
      /** @type {string[]} table name of each entry in `options` */
      let optionNames = [];
      let active = -1;

      /** @param {number} index @param {boolean} scroll */
      function setActive(index, scroll) {
        if (options.length === 0) { return; }
        const next = Math.max(0, Math.min(options.length - 1, index));
        if (active >= 0 && options[active]) { options[active].classList.remove('active'); }
        active = next;
        const option = options[next];
        option.classList.add('active');
        search.setAttribute('aria-activedescendant', option.id);
        if (scroll && typeof option.scrollIntoView === 'function') {
          option.scrollIntoView({ block: 'nearest' });
        }
      }

      /** @param {string} rawQuery */
      function renderList(rawQuery) {
        const query = rawQuery.trim().toLocaleLowerCase();
        list.textContent = '';
        options = [];
        optionNames = [];
        active = -1;
        search.removeAttribute('aria-activedescendant');
        const matches = tables.filter((t) => lowerNames.get(t.name).includes(query));
        if (matches.length === 0) {
          const empty = el('li', { class: 'table-picker-empty', role: 'presentation' });
          empty.textContent = 'No matching tables';
          list.appendChild(empty);
          return;
        }
        /** @type {Array<{ label: string | undefined, items: import('../../src/tableData').TableRef[] }>} */
        let groups;
        if (bySchema) {
          // The host lists `main` first, then schemas alphabetically; keep that order.
          const bySchemaName = new Map();
          for (const t of matches) {
            const key = schemaOf(t);
            if (!bySchemaName.has(key)) { bySchemaName.set(key, []); }
            bySchemaName.get(key).push(t);
          }
          groups = Array.from(bySchemaName, ([label, items]) => ({ label, items }));
        } else {
          groups = hasBothKinds
            ? [
              { label: 'Tables', items: matches.filter((t) => t.type !== 'view') },
              { label: 'Views', items: matches.filter((t) => t.type === 'view') },
            ]
            : [{ label: undefined, items: matches }];
        }
        for (const group of groups) {
          if (group.items.length === 0) { continue; }
          // Options go straight into the listbox, or into a labelled role=group
          // so a screen reader hears "Views (2)" (the visible header is hidden
          // from it to avoid reading the same text twice).
          let container = list;
          if (group.label !== undefined) {
            const groupText = `${group.label} (${group.items.length})`;
            const groupEl = el('li', { role: 'group', 'aria-label': groupText });
            const header = el('div', { class: 'table-picker-group', 'aria-hidden': 'true' });
            header.textContent = groupText;
            container = el('ul', { role: 'presentation', class: 'table-picker-group-items' });
            groupEl.appendChild(header);
            groupEl.appendChild(container);
            list.appendChild(groupEl);
          }
          for (const table of group.items) {
            const selected = table.name === current;
            const option = el('li', {
              class: 'table-picker-option', role: 'option',
              id: `${uid}-opt-${options.length}`, 'aria-selected': selected ? 'true' : 'false',
            });
            option.title = table.approxRows !== undefined
              ? `${table.name} · about ${table.approxRows.toLocaleString()} row${table.approxRows === 1 ? '' : 's'}`
              : table.name;
            option.appendChild(tableKindIcon(table.type === 'view' ? 'view' : 'table'));
            const name = el('span', { class: 'picker-name' });
            // Under a schema header the short name is enough; the full one is the tooltip.
            appendHighlighted(name, bySchema && table.table !== undefined ? table.table : table.name, query);
            option.appendChild(name);
            if (table.type === 'view') {
              const tag = el('span', { class: 'picker-tag' });
              tag.textContent = 'view';
              option.appendChild(tag);
            }
            if (table.approxRows !== undefined) {
              const meta = el('span', { class: 'picker-meta' });
              meta.textContent = '~' + compactCount(table.approxRows);
              option.appendChild(meta);
            }
            if (selected) { option.appendChild(pickerGlyph('M3.5 8.5l3 3 6-7')); }
            const tableName = table.name;
            const optionIndex = options.length;
            option.addEventListener('mousemove', () => {
              if (optionIndex !== active) { setActive(optionIndex, false); }
            });
            option.addEventListener('click', () => pick(tableName));
            options.push(option);
            optionNames.push(tableName);
            container.appendChild(option);
          }
        }
        const currentIndex = options.findIndex((o) => o.getAttribute('aria-selected') === 'true');
        setActive(currentIndex >= 0 ? currentIndex : 0, true);
      }

      search.addEventListener('input', () => renderList(search.value));
      search.addEventListener('keydown', (event) => {
        // Enter/arrows while an IME composition is open belong to the IME.
        if (event.isComposing) { return; }
        switch (event.key) {
          case 'ArrowDown': event.preventDefault(); setActive(active + 1, true); break;
          case 'ArrowUp': event.preventDefault(); setActive(active - 1, true); break;
          case 'PageDown': event.preventDefault(); setActive(active + 10, true); break;
          case 'PageUp': event.preventDefault(); setActive(active - 10, true); break;
          case 'Enter':
            event.preventDefault();
            if (active >= 0) { pick(optionNames[active]); }
            break;
          case 'Escape':
            // Must not also reach the card's document-level Escape handling.
            event.preventDefault();
            event.stopPropagation();
            close(true);
            break;
          case 'Tab':
            // Focus goes back to the trigger first, so Tab continues from there.
            close(true);
            break;
          default: break;
        }
      });

      wrapper.appendChild(popupEl);
      trigger.setAttribute('aria-expanded', 'true');
      openPicker = { root: wrapper, close };
      renderList('');
      search.focus();
    }

    trigger.addEventListener('click', () => {
      if (popup) { close(true); } else { open(); }
    });
    trigger.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' && !popup) {
        event.preventDefault();
        open();
      }
    });
    return wrapper;
  }

  // Registered once, a no-op while no picker is open (like the card's below).
  document.addEventListener('pointerdown', (event) => {
    if (openPicker && !openPicker.root.contains(/** @type {Node} */ (event.target))) {
      openPicker.close(false);
    }
  }, true);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && openPicker) { openPicker.close(false); }
  });

  /**
   * @param {import('../../src/tableData').MultiTableParseOutcome} outcome
   */
  function renderMultiTableOutcome(outcome, options) {
    // `rerender`: the same payload drawn again (the SQL/Table toggle) -- not news
    // from the host, so no stale-reply check and none of the reload handling.
    const rerender = !!(options && options.rerender);
    const isReload = !rerender && outcome.success && outcome.data.reload !== undefined;
    if (outcome.success && !rerender && outcome.data.hostSelected) {
      // The host chose this table (dbt "Preview Model"): it is the user's pick from
      // now on, wherever they were (a pick still in flight is stale, and the SQL box
      // gives way to the table).
      requestedTable = outcome.data.selectedTable;
      queryMode = false;
      savedTableState = undefined;
    } else if (outcome.success && !rerender) {
      const selected = outcome.data.selectedTable;
      if (requestedTable !== undefined && selected !== requestedTable) {
        // A response to an older select-table request, superseded by a newer
        // one already in flight -- drop it rather than momentarily showing a
        // table the user already moved away from. The same goes for a reload
        // that was still reading the table the user has since left. The one
        // exception is a table that is gone from the file (dropped by a
        // rebuild): the host fell back to another table, and that is what the
        // user is looking at from now on.
        if (outcome.data.tables.some((t) => t.name === requestedTable)) { return; }
        requestedTable = selected;
      }
    }
    if (outcome.success && outcome.data.tables.length > 0) { lastMultiOutcome = outcome; }
    // A reload while the table is showing leaves the SQL result behind the data.
    if (isReload && !queryMode && queryRunSql !== undefined) { queryStale = true; }
    // A reload re-renders everything; remember what the user was doing.
    const carried = isReload && !queryMode ? captureReloadState() : undefined;
    const carriedQuery = isReload && queryMode ? captureQueryUiState() : undefined;
    // A keyboard user who just picked a table has focus on the picker's
    // trigger; the re-render below replaces it, so hand focus to the new one.
    const active = document.activeElement;
    const pickerHadFocus = !!active && active.closest('.table-selector') !== null;
    const refreshHadFocus = !!active && active.classList.contains('toolbar-button');
    const modeHadFocus = active && active.classList.contains('mode-button') ? active.getAttribute('data-mode') : null;
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
    const canQuery = !!(outcome.data.capabilities && outcome.data.capabilities.query);
    if (!canQuery) { queryMode = false; }
    const selector = renderTableSelector(outcome.data.tables, outcome.data.selectedTable);
    const toolbar = el('div', { class: 'table-toolbar' });
    if (canQuery) { toolbar.appendChild(renderModeToggle()); }
    // The picker chooses a table to look at; the SQL box names its tables itself.
    if (!queryMode) { toolbar.appendChild(selector); }
    reloadStatusEl = undefined;
    /** @type {HTMLElement | undefined} */
    let refreshButton;
    if (outcome.data.capabilities && outcome.data.capabilities.refresh) {
      const refresh = el('button', {
        type: 'button',
        class: 'toolbar-button',
        'aria-label': 'Refresh from disk',
        title: 'Re-read the file from disk (also happens automatically when it changes)',
      });
      refresh.textContent = '↻';
      refresh.addEventListener('click', () => { vscode.postMessage({ type: 'refresh' }); });
      toolbar.appendChild(refresh);
      refreshButton = refresh;
      reloadStatusEl = el('span', { class: 'reload-status', role: 'status' });
      if (outcome.data.reload) {
        setReloadStatus(reloadSummary(outcome.data), false);
      }
      toolbar.appendChild(reloadStatusEl);
    }
    app.appendChild(toolbar);
    // The reload a click on the refresh button causes replaces that button; focus
    // can only move once the new one is in the document.
    if (refreshHadFocus && refreshButton) { refreshButton.focus(); }
    if (pickerHadFocus && !queryMode) {
      const newTrigger = selector.querySelector('button');
      if (newTrigger) { newTrigger.focus(); }
    }
    if (modeHadFocus) {
      const button = toolbar.querySelector(`.mode-button[data-mode="${modeHadFocus}"]`);
      if (button) { /** @type {HTMLElement} */ (button).focus(); }
    }
    if (queryMode) {
      renderQueryPanel(app);
      if (carriedQuery) { restoreQueryUiState(carriedQuery); }
      // A refresh re-runs what produced the result on screen, so the result follows the data.
      if (isReload && queryRunSql !== undefined) {
        const scroll = carriedQuery ? { top: carriedQuery.resultTop, left: carriedQuery.resultLeft } : undefined;
        if (queryRunning) {
          // Not a second run on top of a running one: it follows the running one's answer.
          queryRerun = { scroll };
        } else {
          runQuery(queryRunSql, scroll);
        }
      }
      return;
    }
    const restoring = carried || (rerender ? savedTableState : undefined);
    renderTable(outcome.data.data, outcome.data.selectedTable, outcome.data.tableError, {
      columnDescriptions: outcome.data.columnDescriptions,
      deferStats: !!restoring,
    });
    if (restoring) {
      // After a reload, or back from the SQL box: the filters and scroll the table had.
      restoreReloadState(restoring);
      // Statistics only now, behind the filter request: the host answers in order.
      requestStats();
    }
    if (rerender) { savedTableState = undefined; }
  }

  // ── SQL highlighting ──────────────────────────────────────────────────
  //
  // The query box is a <textarea> (so selection, undo, IME and accessibility are the browser's)
  // with its text made transparent and a <pre> underneath that draws the same text coloured.
  // The colours come from CSS variables the host fills from the active theme (`sql-theme`
  // message), with a default palette per theme brightness in styles.css. Spans are built with
  // textContent only: the text is whatever the user typed or pasted.

  const SQL_KEYWORDS = new Set((
    'select from where group by order having limit offset fetch union intersect except all distinct as on join inner ' +
    'left right full outer cross natural using with recursive insert into values update set delete create table view ' +
    'drop alter add column index schema sequence temp temporary replace if exists not and or in is like ilike similar ' +
    'glob between escape asc desc nulls first last case when then else end cast try_cast any some lateral unnest ' +
    'window over partition rows range groups unbounded preceding following current row filter within qualify pivot ' +
    'unpivot describe show summarize explain analyze copy attach detach install load pragma call returning primary ' +
    'key foreign references unique check default constraint collate sample tablesample using ordinality ignore respect ' +
    'grouping sets cube rollup array struct map extract interval at time zone positional asof anti semi macro function ' +
    'begin commit rollback transaction use database export import vacuum checkpoint force summarize to from'
  ).split(' '));
  const SQL_CONSTANTS = new Set(['null', 'true', 'false']);
  const SQL_TYPES = new Set((
    'integer int bigint smallint tinyint hugeint ubigint uinteger usmallint utinyint uhugeint float double real decimal ' +
    'numeric boolean bool varchar text char string blob bytea date time timestamp timestamptz datetime interval uuid ' +
    'json bit bitstring list union enum varint'
  ).split(' '));
  const SQL_IDENTIFIER = /[\p{L}_][\p{L}\p{N}_$]*/uy;
  const SQL_NUMBER = /(?:0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/y;
  const SQL_OPERATOR = /[+\-*/%<>=!|&^~:@#?]+/y;
  /** The kinds of coloured token, which are also the names of the `sql-theme` colours. */
  const SQL_COLOR_CLASSES = ['keyword', 'function', 'string', 'number', 'comment', 'type', 'operator', 'identifier', 'constant'];
  const SQL_HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
  /** Longer than this is highlighted a frame later instead of on every keystroke. */
  const SQL_SYNC_HIGHLIGHT_LIMIT = 20000;

  /**
   * Splits SQL text into `[class, text]` pieces that together are exactly the text. `plain` is
   * everything that is not coloured (names, punctuation, whitespace). It never throws, and an
   * unterminated string or comment simply runs to the end, as an editor draws it while you type.
   * @param {string} text
   * @returns {Array<[string, string]>}
   */
  function tokenizeSql(text) {
    /** @type {Array<[string, string]>} */
    const tokens = [];
    const n = text.length;
    let i = 0;
    let plain = '';
    const flush = () => { if (plain !== '') { tokens.push(['plain', plain]); plain = ''; } };
    /** @param {string} kind @param {number} end */
    const take = (kind, end) => { flush(); tokens.push([kind, text.slice(i, end)]); i = end; };
    while (i < n) {
      const ch = text[i];
      const next = text[i + 1];
      if (ch === '-' && next === '-') {
        const eol = text.indexOf('\n', i);
        take('comment', eol === -1 ? n : eol);
      } else if (ch === '/' && next === '*') {
        const close = text.indexOf('*/', i + 2);
        take('comment', close === -1 ? n : close + 2);
      } else if (ch === "'" || ch === '"') {
        let j = i + 1;
        while (j < n) {
          if (text[j] === ch) {
            if (text[j + 1] === ch) { j += 2; continue; } // a doubled quote is an escaped one
            j++;
            break;
          }
          j++;
        }
        take(ch === "'" ? 'string' : 'identifier', j);
      } else if (ch === '$' && next === '$') {
        const close = text.indexOf('$$', i + 2);
        take('string', close === -1 ? n : close + 2);
      } else if ((ch >= '0' && ch <= '9') || (ch === '.' && next !== undefined && next >= '0' && next <= '9')) {
        SQL_NUMBER.lastIndex = i;
        const match = SQL_NUMBER.exec(text);
        take('number', match ? i + match[0].length : i + 1);
      } else {
        SQL_IDENTIFIER.lastIndex = i;
        const word = SQL_IDENTIFIER.exec(text);
        if (word) {
          const lower = word[0].toLowerCase();
          let kind = 'plain';
          if (SQL_CONSTANTS.has(lower)) { kind = 'constant'; }
          else if (SQL_TYPES.has(lower)) { kind = 'type'; }
          else if (SQL_KEYWORDS.has(lower)) { kind = 'keyword'; }
          else {
            // A name straight before "(" is a call.
            let k = i + word[0].length;
            while (k < n && (text[k] === ' ' || text[k] === '\t')) { k++; }
            if (text[k] === '(') { kind = 'function'; }
          }
          if (kind === 'plain') { plain += word[0]; i += word[0].length; } else { take(kind, i + word[0].length); }
        } else {
          SQL_OPERATOR.lastIndex = i;
          const op = SQL_OPERATOR.exec(text);
          if (op) { take('operator', i + op[0].length); } else { plain += ch; i++; }
        }
      }
    }
    flush();
    return tokens;
  }

  /**
   * Draws `text` coloured into the overlay. A text that ends in a line break gets one more
   * character, or the overlay would be a line shorter than the box and drift out of step.
   * @param {HTMLElement} layer
   * @param {string} text
   */
  function paintSqlHighlight(layer, text) {
    const fragment = document.createDocumentFragment();
    for (const [kind, piece] of tokenizeSql(text)) {
      if (kind === 'plain') {
        fragment.appendChild(document.createTextNode(piece));
      } else {
        const span = el('span', { class: `sql-${kind}` });
        span.textContent = piece;
        fragment.appendChild(span);
      }
    }
    if (text.endsWith('\n')) { fragment.appendChild(document.createTextNode(' ')); }
    layer.textContent = '';
    layer.appendChild(fragment);
  }

  /**
   * Applies the host's `sql-theme` colours: each valid one becomes a CSS variable on the root
   * (CSSOM, allowed by the CSP); a kind the theme does not colour, or an invalid value, goes back
   * to the stylesheet's default for the theme's brightness.
   * @param {Record<string, unknown> | undefined} colors
   */
  function applySqlTheme(colors) {
    const root = document.documentElement;
    for (const kind of SQL_COLOR_CLASSES) {
      const value = colors && colors[kind];
      if (typeof value === 'string' && SQL_HEX_COLOR.test(value)) {
        root.style.setProperty(`--sql-${kind}`, value);
      } else {
        root.style.removeProperty(`--sql-${kind}`);
      }
    }
  }

  // ── SQL box ───────────────────────────────────────────────────────────

  /** The Table | SQL switch at the toolbar's left. */
  function renderModeToggle() {
    const group = el('div', { class: 'mode-toggle', role: 'group', 'aria-label': 'View' });
    for (const [mode, label] of [['table', 'Table'], ['sql', 'SQL']]) {
      const button = el('button', {
        type: 'button',
        class: 'mode-button',
        'data-mode': mode,
        'aria-pressed': String((mode === 'sql') === queryMode),
      });
      button.textContent = label;
      button.addEventListener('click', () => setQueryMode(mode === 'sql'));
      group.appendChild(button);
    }
    return group;
  }

  /** @param {boolean} on */
  function setQueryMode(on) {
    if (queryMode === on || !lastMultiOutcome || !lastMultiOutcome.success) { return; }
    if (on) {
      savedTableState = captureReloadState();
      if (!queryTextEdited) {
        queryText = lastMultiOutcome.data.querySuggestion || '';
      }
      focusQueryInput = true;
    }
    queryMode = on;
    renderMultiTableOutcome(lastMultiOutcome, { rerender: true });
    if (on && queryStale && queryRunSql !== undefined && !queryRunning) { runQuery(queryRunSql); }
  }

  /** The result's scroll wrapper, if a result table is showing. */
  function queryResultWrapper() {
    return queryResultHost ? /** @type {HTMLElement | null} */ (queryResultHost.querySelector('.scroll-wrapper')) : null;
  }

  /**
   * What an auto-refresh must not take from someone typing a query: the box's
   * focus, caret and scroll, and where they had scrolled the result to.
   */
  function captureQueryUiState() {
    const input = queryInputEl;
    if (!input || !input.isConnected) { return undefined; }
    const wrapper = queryResultWrapper();
    return {
      focused: document.activeElement === input,
      start: input.selectionStart,
      end: input.selectionEnd,
      inputTop: input.scrollTop,
      resultTop: wrapper ? wrapper.scrollTop : 0,
      resultLeft: wrapper ? wrapper.scrollLeft : 0,
    };
  }

  /** @param {NonNullable<ReturnType<typeof captureQueryUiState>>} state */
  function restoreQueryUiState(state) {
    const input = queryInputEl;
    if (!input) { return; }
    input.scrollTop = state.inputTop;
    if (state.focused) {
      input.focus();
      if (state.start !== null && state.end !== null) { input.setSelectionRange(state.start, state.end); }
    }
    putResultScroll({ top: state.resultTop, left: state.resultLeft });
  }

  /** @param {{ top: number, left: number } | undefined} scroll */
  function putResultScroll(scroll) {
    const wrapper = queryResultWrapper();
    if (!scroll || !wrapper) { return; }
    wrapper.scrollTop = scroll.top;
    wrapper.scrollLeft = scroll.left;
    syncWindow(currentView);
  }

  /** @param {HTMLElement} app */
  function renderQueryPanel(app) {
    releaseCurrentView();
    const panel = el('div', { class: 'query-panel' });
    const input = /** @type {HTMLTextAreaElement} */ (el('textarea', {
      class: 'query-input',
      'aria-label': 'SQL query',
      rows: '6',
      // No soft wrapping: a wrapped line breaks where the box's width says, and the coloured
      // layer underneath has none of the box's scrollbars, so the two would break differently.
      wrap: 'off',
      maxlength: String(MAX_QUERY_LENGTH),
      spellcheck: 'false',
      autocomplete: 'off',
      placeholder: 'SELECT … (read-only: SELECT, WITH, FROM, SHOW, DESCRIBE, SUMMARIZE, PIVOT, EXPLAIN)',
    }));
    input.value = queryText;
    queryInputEl = input;
    // The coloured copy of the text, drawn under the (transparent-text) box. It is not for
    // assistive technology or the mouse: the textarea is the real control.
    const layer = el('pre', { class: 'query-highlight', 'aria-hidden': 'true' });
    paintSqlHighlight(layer, input.value);
    let highlightFrame = 0;
    const highlight = () => {
      if (input.value.length <= SQL_SYNC_HIGHLIGHT_LIMIT) {
        paintSqlHighlight(layer, input.value);
      } else if (!highlightFrame) {
        highlightFrame = window.requestAnimationFrame
          ? window.requestAnimationFrame(() => { highlightFrame = 0; paintSqlHighlight(layer, input.value); })
          : window.setTimeout(() => { highlightFrame = 0; paintSqlHighlight(layer, input.value); }, 0);
      }
      layer.scrollTop = input.scrollTop;
      layer.scrollLeft = input.scrollLeft;
    };
    const bar = el('div', { class: 'query-bar' });
    const run = /** @type {HTMLButtonElement} */ (el('button', { type: 'button', class: 'query-run' }));
    run.textContent = 'Run';
    const modifier = /mac/i.test(window.navigator.platform || '') ? '⌘' : 'Ctrl';
    run.title = `Run the query (${modifier}+Enter)`;
    const hint = el('span', { class: 'query-hint' });
    hint.textContent = `${modifier}+Enter to run · read-only`;
    const status = el('span', { class: 'query-status', role: 'status' });
    const sync = () => { run.disabled = input.value.trim() === ''; };
    sync();
    input.addEventListener('input', () => { queryText = input.value; queryTextEdited = true; sync(); highlight(); });
    input.addEventListener('scroll', () => {
      layer.scrollTop = input.scrollTop;
      layer.scrollLeft = input.scrollLeft;
    });
    input.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        runQuery(input.value);
      }
    });
    run.addEventListener('click', () => runQuery(input.value));
    bar.appendChild(run);
    bar.appendChild(hint);
    bar.appendChild(status);
    const editor = el('div', { class: 'query-editor' });
    editor.appendChild(layer);
    editor.appendChild(input);
    panel.appendChild(editor);
    panel.appendChild(bar);
    app.appendChild(panel);
    layer.scrollTop = input.scrollTop;
    layer.scrollLeft = input.scrollLeft;
    const host = el('div', { class: 'query-result' });
    app.appendChild(host);
    queryResultHost = host;
    queryStatusEl = status;
    paintQueryResult();
    if (queryRunning) { setQueryStatus('Running…', false); }
    if (focusQueryInput) {
      focusQueryInput = false;
      input.focus();
    }
  }

  /** @param {string} text @param {boolean} isError */
  function setQueryStatus(text, isError) {
    if (!queryStatusEl) { return; }
    queryStatusEl.textContent = text;
    queryStatusEl.classList.toggle('error', isError);
  }

  /**
   * Sends `sql` to the host. The previous result stays on screen until the answer replaces it.
   * @param {string} sql
   * @param {{ top: number, left: number }=} scroll result scroll to put back when the answer is drawn (a refresh's re-run)
   */
  function runQuery(sql, scroll) {
    if (sql.trim() === '') { return; }
    queryRunSql = sql;
    queryRunning = true;
    queryRerun = undefined;
    queryStale = false;
    queryScrollToRestore = scroll;
    setQueryStatus('Running…', false);
    vscode.postMessage({ type: 'run-query', seq: ++querySeqCounter, sql });
  }

  /** Draws `queryResult` into the result area (and the status line beside the Run button). */
  function paintQueryResult() {
    const host = queryResultHost;
    if (!host || !host.isConnected) { return; }
    host.textContent = '';
    releaseCurrentView();
    const note = (/** @type {string} */ text, /** @type {boolean} */ isError) => {
      const p = el('p', { class: isError ? 'message error' : 'message' });
      p.textContent = text;
      host.appendChild(p);
    };
    if (!queryResult) {
      note('Run a query to see its result here.', false);
      setQueryStatus('', false);
    } else if (queryResult.kind === 'error') {
      note(queryResult.message, true);
      setQueryStatus('Failed', true);
    } else if (queryResult.data.columnCount === 0) {
      note('The statement ran and returned no columns.', false);
      setQueryStatus(`Done · ${queryResult.elapsedMs.toLocaleString()} ms`, false);
    } else {
      const { data, truncated, elapsedMs, seq, capped } = queryResult;
      renderTable(data, undefined, undefined, { host, result: { truncated, seq, capped } });
      setQueryStatus(
        `${data.rowCount.toLocaleString()}${truncated ? '+' : ''} row${data.rowCount !== 1 ? 's' : ''} · ${elapsedMs.toLocaleString()} ms`,
        false
      );
    }
  }

  /** `query-data` from the host; a reply that a newer run overtook is dropped. @param {import('../../src/queryMessage').QueryPayload | undefined} payload */
  function handleQueryData(payload) {
    if (!payload || payload.seq !== querySeqCounter) { return; }
    queryRunning = false;
    if (typeof payload.error === 'string') {
      queryResult = { kind: 'error', message: payload.error };
    } else if (payload.data && Array.isArray(payload.data.headers) && Array.isArray(payload.data.rows)) {
      queryResult = {
        kind: 'data',
        data: payload.data,
        truncated: payload.truncated === true,
        elapsedMs: typeof payload.elapsedMs === 'number' ? payload.elapsedMs : 0,
        seq: Number.isSafeInteger(payload.result) ? payload.result : undefined,
        capped: payload.capped === true,
      };
    } else {
      queryResult = { kind: 'error', message: 'The host sent an unexpected reply.' };
    }
    paintQueryResult();
    putResultScroll(queryScrollToRestore);
    queryScrollToRestore = undefined;
    // A refresh landed while this ran: the data changed under it, so run it again.
    const again = queryRerun;
    queryRerun = undefined;
    if (again && queryRunSql !== undefined) {
      if (queryMode) { runQuery(queryRunSql, again.scroll); } else { queryStale = true; }
    }
  }

  /** @param {string} text @param {boolean} isError @param {string=} title */
  function setReloadStatus(text, isError, title) {
    if (!reloadStatusEl) { return; }
    // Identical text is not rewritten: the element is a live region, and a
    // rewrite makes screen readers announce it again (the host repeats
    // "Build in progress" on every poll while it waits).
    if (reloadStatusEl.textContent === text && reloadStatusEl.classList.contains('error') === isError) { return; }
    reloadStatusEl.textContent = text;
    reloadStatusEl.classList.toggle('error', isError);
    reloadStatusEl.title = title !== undefined ? title : '';
  }

  /**
   * "Updated 14:32:05 · rows 1,204 → 1,310 (+106)". Only the row count is
   * compared: it says the table moved, not that unchanged-count data is the same.
   * @param {import('../../src/tableData').MultiTableData} data
   */
  function reloadSummary(data) {
    const reload = /** @type {import('../../src/tableData').ReloadInfo} */ (data.reload);
    let text = 'Updated ' + new Date(reload.at).toLocaleTimeString();
    if (reload.previousRowCount !== undefined && data.tableError === undefined) {
      const now = data.data.totalRowCount != null ? data.data.totalRowCount : data.data.rowCount;
      const delta = now - reload.previousRowCount;
      text += delta === 0
        ? ` · ${now.toLocaleString()} rows, count unchanged`
        : ` · rows ${reload.previousRowCount.toLocaleString()} → ${now.toLocaleString()} (${delta > 0 ? '+' : '−'}${Math.abs(delta).toLocaleString()})`;
    }
    return text;
  }

  /** `reload-status` from the host: a refresh started, is waiting for a build, or failed. */
  function handleReloadStatus(message) {
    if (message.state === 'refreshing') {
      setReloadStatus('Refreshing…', false);
    } else if (message.state === 'building') {
      setReloadStatus('Build in progress — refreshing when it finishes…', false);
    } else if (message.state === 'failed') {
      const reason = typeof message.message === 'string' ? message.message : 'unknown error';
      setReloadStatus('Refresh failed: ' + reason.split('\n')[0], true, reason);
    }
  }

  /**
   * What a reload must not lose: filter text, scroll position, and the focused
   * filter box (an auto-refresh can land while the user is typing).
   */
  function captureReloadState() {
    const view = currentView;
    if (!view) { return undefined; }
    const active = document.activeElement;
    const focused = view.filterInputs.findIndex((input) => input === active);
    const focusedInput = focused >= 0 ? view.filterInputs[focused] : undefined;
    return {
      tableName: view.tableName,
      headers: view.headers,
      filters: view.filterInputs.map((input) => input.value),
      top: view.wrapper.scrollTop,
      left: view.wrapper.scrollLeft,
      cellSelection: view.sel,
      focused,
      selection: focusedInput ? [focusedInput.selectionStart, focusedInput.selectionEnd] : undefined,
    };
  }

  /**
   * Puts that state back onto the freshly rendered view -- only if it is the
   * same table with the same columns; otherwise the old boxes would mean
   * something else (or nothing) and are dropped.
   * @param {NonNullable<ReturnType<typeof captureReloadState>>} state
   */
  function restoreReloadState(state) {
    const view = currentView;
    if (
      !view || view.tableName !== state.tableName || view.headers.length !== state.headers.length ||
      view.headers.some((header, i) => header !== state.headers[i])
    ) { return; }
    const hasFilter = state.filters.some((text) => text.trim() !== '');
    if (hasFilter) {
      state.filters.forEach((text, i) => { view.filterInputs[i].value = text; });
      // Not the whole unfiltered table for a moment: it is not what the user was looking at, and
      // drawing it is the costly part. The filtered rows replace this empty body when they arrive.
      view.win = undefined;
      view.tbody.textContent = '';
      view.rowsHidden = true;
      view.pendingScroll = { top: state.top, left: state.left };
      sendFilter(view, true);
    } else {
      view.wrapper.scrollTop = state.top;
      view.wrapper.scrollLeft = state.left;
      syncWindow(view);
      restoreSelection(view, state.cellSelection);
    }
    const input = state.focused >= 0 ? view.filterInputs[state.focused] : undefined;
    if (input) {
      input.focus();
      if (state.selection && state.selection[0] !== null && state.selection[1] !== null) {
        input.setSelectionRange(state.selection[0], state.selection[1]);
      }
    }
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
    } else if (message.type === 'reload-status') {
      handleReloadStatus(message);
    } else if (message.type === 'query-data') {
      handleQueryData(message.payload);
    } else if (message.type === 'sql-theme') {
      applySqlTheme(message.colors);
    } else if (message.type === 'show-table') {
      // The host (dbt "Preview Model") asked for the table that is already the selected one:
      // nothing to re-read, but the SQL box has to give way to it.
      setQueryMode(false);
    }
  });

  // Signal to extension host that the webview is ready
  vscode.postMessage({ type: 'ready' });
})();
