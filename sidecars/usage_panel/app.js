/**
 * Usage Panel frontend.
 * Polls /api/usage with ETag caching, renders responsive multi-series smooth area
 * charts via monotone cubic splines, syncs host theme tokens, and navigates
 * directly to Antigravity conversations from Session breakdown rows.
 */
(() => {
  const POLL_MS = 3000;
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const $ = (id) => document.getElementById(id);

  const TYPE_SEGMENTS = [
    { key: 'input', tokenKey: 'uncachedInputTokens', label: 'Input', color: 'var(--t-input)' },
    { key: 'cacheRead', tokenKey: 'cachedInputTokens', label: 'Cache read', color: 'var(--t-cache-read)' },
    { key: 'cacheWrite', tokenKey: 'cacheCreationTokens', label: 'Cache write', color: 'var(--t-cache-write)' },
    { key: 'output', tokenKey: 'outputTokens', label: 'Output', color: 'var(--t-output)' },
  ];

  const storedPeriod = localStorage.getItem('usage_panel_period');
  const storedMetric = localStorage.getItem('usage_panel_metric');
  const storedTab = localStorage.getItem('usage_panel_tab');
  const storedScope = localStorage.getItem('usage_panel_scope');

  const state = {
    etag: '',
    data: null,
    period: ['24h', '7d', '30d', '90d'].includes(storedPeriod) ? storedPeriod : '7d',
    metric: storedMetric === 'cost' ? 'cost' : 'tokens',
    tab: ['model', 'session', 'time'].includes(storedTab) ? storedTab : 'model',
    scope: storedScope && !storedScope.startsWith('workspace:') ? storedScope : 'all',
    family: '',
    expandedModels: new Set(),
    hoverIdx: null,
    fallbackConvId: new URLSearchParams(location.search).get('conversationId') || '',
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    timer: null,
  };

  // ---------- Theme Sync ----------
  function syncScheme() {
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--background, #f7f7f8)';
    document.documentElement.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    const nums = (c.match(/[\d.]+/g) || []).map(Number);
    if (nums.length < 3) return;
    const scale = c.startsWith('color(') ? 1 : 255;
    const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const theme = lum < 0.5 ? 'dark' : 'light';
    if (document.documentElement.dataset.theme !== theme) {
      document.documentElement.dataset.theme = theme;
    }
  }
  syncScheme();
  new MutationObserver(syncScheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style'],
  });

  // ---------- Formatters ----------
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[c]));

  function fmtTokens(n) {
    const v = Number(n) || 0;
    if (v >= 1e9) {
      const b = v / 1e9;
      return `${b >= 100 ? b.toFixed(0) : b.toFixed(2).replace(/\.?0+$/, '')}B`;
    }
    if (v >= 1e6) {
      const m = v / 1e6;
      return `${m >= 100 ? m.toFixed(0) : m >= 10 ? m.toFixed(1).replace(/\.0$/, '') : m.toFixed(2).replace(/\.?0+$/, '')}M`;
    }
    if (v >= 1e3) {
      const k = v / 1e3;
      return `${k >= 100 ? k.toFixed(0) : k.toFixed(1).replace(/\.0$/, '')}K`;
    }
    return String(Math.round(v));
  }

  function fmtUsd(n) {
    const v = Number(n) || 0;
    if (v > 0 && v < 0.01) return `$${v.toFixed(4)}`;
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(v);
  }

  function fmtShare(ratio) {
    const pct = (Number(ratio) || 0) * 100;
    if (pct > 0 && pct < 0.1) return '<0.1%';
    return `${pct.toFixed(1)}%`;
  }

  function fmtCount(n, singular, plural) {
    const v = Number(n) || 0;
    return `${v.toLocaleString('en-US')} ${v === 1 ? singular : plural}`;
  }

  // ---------- Smooth Monotone Cubic Spline SVG Chart ----------
  function niceAxisMax(rawMax, isCost) {
    if (!(rawMax > 0)) return isCost ? 1 : 1000;
    const targetTicks = 4;
    const rawStep = rawMax / targetTicks;
    const pow10 = Math.pow(10, Math.floor(Math.log10(rawStep)));
    const frac = rawStep / pow10;
    let niceFrac = 1;
    if (frac <= 1) niceFrac = 1;
    else if (frac <= 2) niceFrac = 2;
    else if (frac <= 2.5) niceFrac = 2.5;
    else if (frac <= 5) niceFrac = 5;
    else niceFrac = 10;
    const step = niceFrac * pow10;
    return Math.ceil(rawMax / step) * step;
  }

  /**
   * Computes Fritsch-Carlson monotone cubic Hermite spline path so smoothed
   * curves never dip below baseline 0 or overshoot neighboring points.
   */
  function buildMonotoneSpline(points) {
    const n = points.length;
    if (n === 0) return '';
    if (n === 1) return `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;

    const dx = [];
    const dy = [];
    const slope = [];
    for (let i = 0; i < n - 1; i++) {
      const dxi = points[i + 1].x - points[i].x;
      const dyi = points[i + 1].y - points[i].y;
      dx.push(dxi);
      dy.push(dyi);
      slope.push(dxi === 0 ? 0 : dyi / dxi);
    }

    const tangents = new Array(n).fill(0);
    tangents[0] = slope[0];
    tangents[n - 1] = slope[n - 2];

    for (let i = 1; i < n - 1; i++) {
      const s0 = slope[i - 1];
      const s1 = slope[i];
      if (s0 * s1 <= 0) {
        tangents[i] = 0;
      } else {
        const w1 = 2 * dx[i] + dx[i - 1];
        const w2 = dx[i] + 2 * dx[i - 1];
        tangents[i] = (w1 + w2) / (w1 / s0 + w2 / s1);
      }
    }

    // Clamp tangents to prevent overshoot on steep segments
    for (let i = 0; i < n - 1; i++) {
      const si = slope[i];
      if (si === 0) {
        tangents[i] = 0;
        tangents[i + 1] = 0;
      } else {
        const a = tangents[i] / si;
        const b = tangents[i + 1] / si;
        const sum = a * a + b * b;
        if (sum > 9) {
          const t = 3 / Math.sqrt(sum);
          tangents[i] = t * a * si;
          tangents[i + 1] = t * b * si;
        }
      }
    }

    let d = `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
    for (let i = 0; i < n - 1; i++) {
      const p0 = points[i];
      const p1 = points[i + 1];
      const segDx = dx[i] / 3;
      const cp1x = p0.x + segDx;
      const cp1y = p0.y + tangents[i] * segDx;
      const cp2x = p1.x - segDx;
      const cp2y = p1.y - tangents[i + 1] * segDx;
      d += ` C ${cp1x.toFixed(2)} ${cp1y.toFixed(2)}, ${cp2x.toFixed(2)} ${cp2y.toFixed(2)}, ${p1.x.toFixed(2)} ${p1.y.toFixed(2)}`;
    }
    return d;
  }

  function renderChart(snap) {
    const svg = $('area-chart');
    const stage = $('chart-stage');
    const isCost = state.metric === 'cost';
    const isHourly = snap.resolution === 'hour';

    $('chart-title').textContent = isCost
      ? isHourly
        ? 'Hourly API cost'
        : 'Daily API cost'
      : isHourly
        ? 'Hourly processed tokens'
        : 'Daily processed tokens';

    const soloBtn = $('solo-reset-btn');
    if (state.family) {
      const fam = (snap.families || []).find((f) => f.id === state.family);
      $('solo-reset-label').textContent = fam ? fam.label : state.family;
      soloBtn.classList.remove('hidden');
    } else {
      soloBtn.classList.add('hidden');
    }

    const timeline = snap.timeline || [];
    const series = snap.series || [];
    if (timeline.length === 0) {
      svg.innerHTML = '';
      return;
    }

    const rect = stage.getBoundingClientRect();
    const W = Math.max(300, Math.round(rect.width || 560));
    const H = Math.max(170, Math.round(rect.height || 196));
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

    const pad = { top: 10, right: 8, bottom: 22, left: 42 };
    const plotW = Math.max(80, W - pad.left - pad.right);
    const plotH = Math.max(60, H - pad.top - pad.bottom);

    let maxSeriesVal = 0;
    for (const slot of timeline) {
      for (const s of series) {
        const entry = slot.byFamily?.[s.id];
        const v = entry ? (isCost ? entry.costUsd : entry.processedTokens) : 0;
        if (v > maxSeriesVal) maxSeriesVal = v;
      }
    }
    const maxY = niceAxisMax(maxSeriesVal, isCost);

    const xAt = (i) =>
      timeline.length === 1
        ? pad.left + plotW / 2
        : pad.left + (i / (timeline.length - 1)) * plotW;
    const yAt = (v) => pad.top + plotH - (Math.max(0, v) / maxY) * plotH;

    let parts = [];

    // Defs gradients per series
    parts.push('<defs>');
    for (const s of series) {
      parts.push(
        `<linearGradient id="grad-${esc(s.id)}" x1="0" y1="0" x2="0" y2="1">` +
          `<stop offset="0%" stop-color="var(${esc(s.colorVar)})" stop-opacity="0.22"/>` +
          `<stop offset="100%" stop-color="var(${esc(s.colorVar)})" stop-opacity="0.01"/>` +
          '</linearGradient>'
      );
    }
    parts.push('</defs>');

    // Grid lines & Y-axis labels (4 ticks: 0, 1/3, 2/3, max)
    const ticks = 3;
    for (let t = 0; t <= ticks; t++) {
      const val = (maxY * t) / ticks;
      const y = yAt(val).toFixed(2);
      parts.push(
        `<line class="chart-grid-line" x1="${pad.left}" y1="${y}" x2="${W - pad.right}" y2="${y}"/>`
      );
      const label = val === 0 ? '0' : isCost ? fmtUsd(val) : fmtTokens(val);
      parts.push(
        `<text class="chart-axis-text" x="${pad.left - 7}" y="${Number(y) + 3}" text-anchor="end">${esc(label)}</text>`
      );
    }

    // X-axis labels (start, middle(s), end)
    const n = timeline.length;
    const xIndices =
      n <= 1
        ? [0]
        : n <= 7
          ? [0, Math.floor((n - 1) / 2), n - 1]
          : [0, Math.floor((n - 1) / 3), Math.floor(((n - 1) * 2) / 3), n - 1];
    const uniqueXIdx = [...new Set(xIndices)];
    for (let k = 0; k < uniqueXIdx.length; k++) {
      const idx = uniqueXIdx[k];
      const anchor = k === 0 ? 'start' : k === uniqueXIdx.length - 1 ? 'end' : 'middle';
      const x = xAt(idx).toFixed(2);
      parts.push(
        `<text class="chart-axis-text" x="${x}" y="${H - 4}" text-anchor="${anchor}">${esc(timeline[idx].shortLabel)}</text>`
      );
    }

    // Series areas & lines (draw smallest total last so curves stay legible)
    const orderedSeries = [...series].reverse();
    const baseY = (pad.top + plotH).toFixed(2);
    for (const s of orderedSeries) {
      const pts = timeline.map((slot, idx) => {
        const entry = slot.byFamily?.[s.id];
        const v = entry ? (isCost ? entry.costUsd : entry.processedTokens) : 0;
        return { x: xAt(idx), y: yAt(v) };
      });
      const linePath = buildMonotoneSpline(pts);
      const areaPath =
        pts.length > 0
          ? `${linePath} L ${pts[pts.length - 1].x.toFixed(2)} ${baseY} L ${pts[0].x.toFixed(2)} ${baseY} Z`
          : '';
      if (areaPath) {
        parts.push(`<path d="${areaPath}" fill="url(#grad-${esc(s.id)})"/>`);
      }
      if (linePath) {
        parts.push(
          `<path d="${linePath}" fill="none" stroke="var(${esc(s.colorVar)})" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`
        );
      }
    }

    // Hover crosshair & dots
    if (state.hoverIdx !== null && timeline[state.hoverIdx]) {
      const idx = state.hoverIdx;
      const hx = xAt(idx).toFixed(2);
      parts.push(
        `<line class="chart-cursor-line" x1="${hx}" y1="${pad.top}" x2="${hx}" y2="${baseY}"/>`
      );
      for (const s of series) {
        const entry = timeline[idx].byFamily?.[s.id];
        const v = entry ? (isCost ? entry.costUsd : entry.processedTokens) : 0;
        if (v > 0) {
          parts.push(
            `<circle cx="${hx}" cy="${yAt(v).toFixed(2)}" r="3.2" fill="var(${esc(s.colorVar)})" stroke="var(--u-surface)" stroke-width="1.5"/>`
          );
        }
      }
    }

    svg.innerHTML = parts.join('');
    svg._chartGeom = { pad, plotW, count: timeline.length, W };
    updateTooltip(snap);
  }

  function updateTooltip(snap) {
    const tip = $('chart-tooltip');
    const stage = $('chart-stage');
    const idx = state.hoverIdx;
    const timeline = snap?.timeline || [];
    if (idx === null || !timeline[idx]) {
      tip.classList.add('hidden');
      return;
    }

    const slot = timeline[idx];
    const isCost = state.metric === 'cost';
    const totalVal = isCost ? fmtUsd(slot.costUsd) : fmtTokens(slot.processedTokens);
    const activeFamilies = (snap.series || [])
      .map((s) => {
        const entry = slot.byFamily?.[s.id];
        const val = entry ? (isCost ? entry.costUsd : entry.processedTokens) : 0;
        return { ...s, val };
      })
      .filter((r) => r.val > 0)
      .sort((a, b) => b.val - a.val);

    const rowsHtml = activeFamilies.length
      ? activeFamilies
          .map(
            (r) =>
              `<div class="tt-row">` +
              `<span class="tt-name"><span class="tt-dot" style="background:var(${esc(r.colorVar)})"></span>${esc(r.label)}</span>` +
              `<span class="tt-val num">${esc(isCost ? fmtUsd(r.val) : fmtTokens(r.val))}</span>` +
              `</div>`
          )
          .join('')
      : `<div class="tt-row"><span class="tt-name">No activity</span><span class="tt-val num">0</span></div>`;

    tip.innerHTML =
      `<div class="tt-head"><span>${esc(slot.label)}</span><span class="num">${esc(totalVal)}</span></div>` +
      `<div class="tt-rows">${rowsHtml}</div>`;
    tip.classList.remove('hidden');

    const stageW = stage.clientWidth || 320;
    const ratio = timeline.length <= 1 ? 0.5 : idx / (timeline.length - 1);
    const tipW = tip.offsetWidth || 168;
    const anchorX = ratio * stageW;
    const placeLeft = anchorX > stageW * 0.58;
    const leftPx = placeLeft
      ? Math.max(6, anchorX - tipW - 12)
      : Math.min(stageW - tipW - 6, anchorX + 12);
    tip.style.left = `${Math.round(leftPx)}px`;
  }

  // ---------- Section Renderers ----------
  function renderToolbar(snap) {
    const sel = $('scope-select');
    const scopes = [...(snap.scopes || [{ id: 'all', label: 'All usage', tokens: 0 }])];
    if (state.scope && state.scope !== 'all' && !scopes.some((s) => s.id === state.scope)) {
      state.scope = 'all';
      localStorage.setItem('usage_panel_scope', 'all');
      if (snap.scope && snap.scope !== 'all') {
        state.etag = '';
        queueMicrotask(() => poll(true));
      }
    }

    const sig = scopes.map((s) => `${s.id}:${s.label}`).join('|');
    if (sel.dataset.sig !== sig) {
      sel.dataset.sig = sig;
      sel.innerHTML = scopes
        .map((s) => `<option value="${esc(s.id)}">${esc(s.label)}</option>`)
        .join('');
    }
    if (sel.value !== state.scope) {
      sel.value = scopes.some((s) => s.id === state.scope) ? state.scope : 'all';
      if (sel.value !== state.scope) state.scope = sel.value;
    }

    document.querySelectorAll('[data-period]').forEach((btn) => {
      const on = btn.dataset.period === state.period;
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-pressed', String(on));
    });

    document.querySelectorAll('[data-metric]').forEach((btn) => {
      const on = btn.dataset.metric === state.metric;
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-pressed', String(on));
    });

    $('time-tab-btn').textContent = state.period === '24h' ? 'Hour' : 'Day';
    document.querySelectorAll('[data-tab]').forEach((btn) => {
      const on = btn.dataset.tab === state.tab;
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-pressed', String(on));
    });
  }

  function renderHeroAndFamilies(snap) {
    const t = snap.totals;
    const isCost = state.metric === 'cost';

    $('hero-value').textContent = isCost ? fmtUsd(t.costUsd) : fmtTokens(t.processedTokens);
    const parts = [fmtCount(t.sessions, 'session', 'sessions')];
    if (t.subagentSessions > 0) {
      parts.push(fmtCount(t.subagentSessions, 'subagent', 'subagents'));
    } else if (t.records > 0) {
      parts.push(fmtCount(t.records, 'request', 'requests'));
    }
    $('hero-sub').textContent = parts.join(' · ');

    const families = snap.families || [];
    if (state.family && !families.some((f) => f.id === state.family)) {
      state.family = '';
    }

    $('family-list').innerHTML = families
      .map((f) => {
        const isActive = state.family === f.id;
        const isDimmed = Boolean(state.family && state.family !== f.id);
        const primary = isCost ? fmtUsd(f.costUsd) : fmtTokens(f.processedTokens);
        const sessLabel = fmtCount(f.sessions, 'session', 'sessions');
        const secondary = isCost
          ? `${sessLabel} · ${fmtShare(f.costShare)} of cost · ${fmtTokens(f.processedTokens)}`
          : `${sessLabel} · ${fmtShare(f.tokenShare)} of tokens · ${fmtUsd(f.costUsd)}`;
        return (
          `<button type="button" class="family-row${isActive ? ' active' : ''}${isDimmed ? ' dimmed' : ''}" data-family="${esc(f.id)}" aria-pressed="${isActive}">` +
            `<div class="family-top">` +
              `<span class="family-id">` +
                `<span class="family-dot" style="background:var(${esc(f.colorVar)})"></span>` +
                `<span class="family-name">${esc(f.label)}</span>` +
              `</span>` +
              `<span class="family-val num">${esc(primary)}</span>` +
            `</div>` +
            `<div class="family-sub num">${esc(secondary)}</div>` +
          `</button>`
        );
      })
      .join('');
  }

  function renderTotalsAndComposition(snap) {
    const t = snap.totals;
    const isCost = state.metric === 'cost';

    $('tot-processed').textContent = fmtTokens(t.processedTokens);
    $('tot-cached').textContent = fmtTokens(t.cachedInputTokens);
    $('tot-cache-rate').textContent = fmtShare(t.cacheHitRate);
    $('tot-uncached').textContent = fmtTokens(t.uncachedInputTokens);
    $('tot-output').textContent = fmtTokens(t.outputTokens);
    $('tot-savings').textContent = fmtUsd(t.cacheSavingsUsd);

    $('type-heading').textContent = isCost ? 'Cost by type' : 'Tokens by type';

    const catCost = t.categoryCostUsd || { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
    const totalDenom = isCost ? t.costUsd : t.processedTokens;

    const visibleSegs = TYPE_SEGMENTS.map((seg) => {
      const val = isCost ? (catCost[seg.key] || 0) : (t[seg.tokenKey] || 0);
      return { ...seg, val };
    }).filter((seg) => seg.val > 0 || seg.key !== 'cacheWrite');

    $('type-bar').innerHTML =
      totalDenom > 0
        ? visibleSegs
            .filter((s) => s.val > 0)
            .map((s) => {
              const pct = Math.max(0.5, (s.val / totalDenom) * 100);
              return `<span class="type-seg" style="width:${pct.toFixed(2)}%;background:${s.color}" title="${esc(s.label)}: ${esc(isCost ? fmtUsd(s.val) : fmtTokens(s.val))}"></span>`;
            })
            .join('')
        : '';

    $('type-legend').innerHTML = visibleSegs
      .map(
        (s) =>
          `<span class="legend-item">` +
            `<span class="legend-swatch" style="background:${s.color}"></span>` +
            `<span>${esc(s.label)}</span>` +
            `<span class="legend-val num">${esc(isCost ? fmtUsd(s.val) : fmtTokens(s.val))}</span>` +
          `</span>`
      )
      .join('');
  }

  function renderBreakdown(snap) {
    const isCost = state.metric === 'cost';
    const isHourly = snap.resolution === 'hour';
    const bd = snap.breakdown || {};
    const body = $('breakdown-body');

    if (state.tab === 'model') {
      $('col-primary').textContent = 'Model';
      const rows = bd.models || [];
      const maxMetric = Math.max(
        1e-9,
        ...rows.map((r) => (isCost && r.costUsd > 0 ? r.costUsd : r.processedTokens))
      );

      body.innerHTML = rows
        .map((m, idx) => {
          const share = isCost && snap.totals.costUsd > 0 ? m.costShare : m.tokenShare;
          const barVal = isCost && m.costUsd > 0 ? m.costUsd : m.processedTokens;
          const barPct = Math.min(100, Math.max(2, (barVal / maxMetric) * 100));
          const expanded = state.expandedModels.has(m.model);
          const colorVar =
            (snap.families || []).find((f) => f.id === m.family)?.colorVar || '--f-other';
          const costCell = m.unpriced ? 'Unpriced' : fmtUsd(m.costUsd);
          const rateTxt = m.rate
            ? `$${m.rate.inPerM}/$${m.rate.outPerM} per 1M`
            : 'No rate table entry';

          let html =
            `<tr class="bd-row clickable" data-model="${esc(m.model)}" aria-expanded="${expanded}">` +
              `<td class="col-rank num">${idx + 1}</td>` +
              `<td>` +
                `<div class="primary-cell">` +
                  `<div class="primary-title-row">` +
                    `<span class="primary-name mono">${esc(m.model)}</span>` +
                  `</div>` +
                  `<div class="share-bar-bg"><div class="share-bar-fill" style="width:${barPct.toFixed(1)}%;background:var(${esc(colorVar)})"></div></div>` +
                `</div>` +
              `</td>` +
              `<td class="col-num num ${isCost ? 'col-strong' : 'col-muted'}">${esc(costCell)}</td>` +
              `<td class="col-num num col-muted">${esc(fmtShare(share))}</td>` +
              `<td class="col-num num ${!isCost ? 'col-strong' : 'col-muted'}">${esc(fmtTokens(m.processedTokens))}</td>` +
            `</tr>`;

          if (expanded) {
            html +=
              `<tr class="bd-detail"><td colspan="5">` +
                `<div class="detail-grid num">` +
                  `<span class="detail-kv"><span>Uncached</span><strong>${esc(fmtTokens(m.uncachedInputTokens))}</strong></span>` +
                  `<span class="detail-kv"><span>Cache read</span><strong>${esc(fmtTokens(m.cachedInputTokens))}</strong></span>` +
                  (m.cacheCreationTokens > 0
                    ? `<span class="detail-kv"><span>Cache write</span><strong>${esc(fmtTokens(m.cacheCreationTokens))}</strong></span>`
                    : '') +
                  `<span class="detail-kv"><span>Output</span><strong>${esc(fmtTokens(m.outputTokens))}</strong></span>` +
                  (m.reasoningTokens > 0
                    ? `<span class="detail-kv"><span>Reasoning</span><strong>${esc(fmtTokens(m.reasoningTokens))}</strong></span>`
                    : '') +
                  `<span class="detail-kv"><span>Cache hit</span><strong>${esc(fmtShare(m.cacheHitRate))}</strong></span>` +
                  `<span class="detail-kv"><span>Cache saved</span><strong>${esc(fmtUsd(m.cacheSavingsUsd))}</strong></span>` +
                  `<span class="detail-kv"><span>Requests</span><strong>${m.records.toLocaleString('en-US')}</strong></span>` +
                  `<span class="detail-kv"><span>Rate</span><strong>${esc(rateTxt)}</strong></span>` +
                `</div>` +
              `</td></tr>`;
          }
          return html;
        })
        .join('');
    } else if (state.tab === 'session') {
      $('col-primary').textContent = 'Session';
      const rows = bd.sessions || [];
      const maxMetric = Math.max(
        1e-9,
        ...rows.map((r) => (isCost && r.costUsd > 0 ? r.costUsd : r.processedTokens))
      );

      body.innerHTML = rows
        .map((s, idx) => {
          const share = isCost && snap.totals.costUsd > 0 ? s.costShare : s.tokenShare;
          const barVal = isCost && s.costUsd > 0 ? s.costUsd : s.processedTokens;
          const barPct = Math.min(100, Math.max(2, (barVal / maxMetric) * 100));
          const colorVar =
            (snap.families || []).find((f) => f.id === s.family)?.colorVar || '--u-primary';
          const metaParts = [s.workspaceLabel, s.surface === 'cli' ? 'CLI' : s.surface === 'ide' ? 'IDE' : ''].filter(Boolean);
          if (s.topModel) metaParts.push(s.topModel);

          return (
            `<tr class="bd-row clickable" data-session="${esc(s.sessionId)}" title="Open conversation ${esc(s.title)}">` +
              `<td class="col-rank num">${idx + 1}</td>` +
              `<td>` +
                `<div class="primary-cell">` +
                  `<div class="primary-title-row">` +
                    `<span class="primary-name">${esc(s.title)}</span>` +
                  `</div>` +
                  (metaParts.length
                    ? `<span class="primary-meta">${esc(metaParts.join(' · '))}</span>`
                    : '') +
                  `<div class="share-bar-bg"><div class="share-bar-fill" style="width:${barPct.toFixed(1)}%;background:var(${esc(colorVar)})"></div></div>` +
                `</div>` +
              `</td>` +
              `<td class="col-num num ${isCost ? 'col-strong' : 'col-muted'}">${esc(fmtUsd(s.costUsd))}</td>` +
              `<td class="col-num num col-muted">${esc(fmtShare(share))}</td>` +
              `<td class="col-num num ${!isCost ? 'col-strong' : 'col-muted'}">${esc(fmtTokens(s.processedTokens))}</td>` +
            `</tr>`
          );
        })
        .join('');
    } else {
      $('col-primary').textContent = isHourly ? 'Hour' : 'Day';
      const rows = (bd.timeRows || []).filter((r) => r.records > 0);
      const maxMetric = Math.max(
        1e-9,
        ...rows.map((r) => (isCost && r.costUsd > 0 ? r.costUsd : r.processedTokens))
      );

      body.innerHTML = rows
        .map((r, idx) => {
          const share = isCost && snap.totals.costUsd > 0 ? r.costShare : r.tokenShare;
          const barVal = isCost && r.costUsd > 0 ? r.costUsd : r.processedTokens;
          const barPct = Math.min(100, Math.max(2, (barVal / maxMetric) * 100));
          return (
            `<tr class="bd-row">` +
              `<td class="col-rank num">${idx + 1}</td>` +
              `<td>` +
                `<div class="primary-cell">` +
                  `<span class="primary-name num">${esc(r.label)}</span>` +
                  `<div class="share-bar-bg"><div class="share-bar-fill" style="width:${barPct.toFixed(1)}%;background:var(--u-primary)"></div></div>` +
                `</div>` +
              `</td>` +
              `<td class="col-num num ${isCost ? 'col-strong' : 'col-muted'}">${esc(fmtUsd(r.costUsd))}</td>` +
              `<td class="col-num num col-muted">${esc(fmtShare(share))}</td>` +
              `<td class="col-num num ${!isCost ? 'col-strong' : 'col-muted'}">${esc(fmtTokens(r.processedTokens))}</td>` +
            `</tr>`
          );
        })
        .join('');
    }
  }

  function render(snap) {
    state.data = snap;
    $('loading').classList.add('hidden');
    $('panel').classList.remove('hidden');

    renderToolbar(snap);

    const hasActivity = (snap.totals?.records || 0) > 0 || (snap.totals?.processedTokens || 0) > 0;
    $('main-content').classList.toggle('hidden', !hasActivity);
    $('empty-window').classList.toggle('hidden', hasActivity);

    if (!hasActivity) return;

    renderHeroAndFamilies(snap);
    renderChart(snap);
    renderTotalsAndComposition(snap);
    renderBreakdown(snap);
  }

  // ---------- Polling ----------
  async function poll(force = false) {
    const conv = window.sidecar?.conversationId || state.fallbackConvId || '';
    const qs = new URLSearchParams();
    qs.set('period', state.period);
    qs.set('scope', state.scope);
    if (state.family) qs.set('family', state.family);
    qs.set('tz', state.timeZone);
    if (conv) qs.set('conversationId', conv);
    if (!force && state.etag) qs.set('etag', state.etag);

    try {
      const f = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : fetch;
      const res = await f(`/api/usage?${qs.toString()}`, { method: 'GET' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload = await res.json();
      if (payload.unchanged) return;
      state.etag = payload.etag || '';
      render(payload);
    } catch {
      // keep existing UI state across transient sidecar reconnects
    }
  }

  function schedulePoll() {
    clearTimeout(state.timer);
    const delay = document.hidden ? 10000 : POLL_MS;
    state.timer = setTimeout(async () => {
      await poll(false);
      schedulePoll();
    }, delay);
  }

  // ---------- Interactions ----------
  $('scope-select').addEventListener('change', (e) => {
    state.scope = e.target.value || 'all';
    localStorage.setItem('usage_panel_scope', state.scope);
    state.family = '';
    state.etag = '';
    poll(true);
  });

  document.addEventListener('click', (e) => {
    const periodBtn = e.target.closest('[data-period]');
    if (periodBtn) {
      state.period = periodBtn.dataset.period;
      localStorage.setItem('usage_panel_period', state.period);
      state.hoverIdx = null;
      state.etag = '';
      poll(true);
      return;
    }

    const metricBtn = e.target.closest('[data-metric]');
    if (metricBtn) {
      state.metric = metricBtn.dataset.metric;
      localStorage.setItem('usage_panel_metric', state.metric);
      if (state.data) render(state.data);
      return;
    }

    const tabBtn = e.target.closest('[data-tab]');
    if (tabBtn) {
      state.tab = tabBtn.dataset.tab;
      localStorage.setItem('usage_panel_tab', state.tab);
      if (state.data) {
        renderToolbar(state.data);
        renderBreakdown(state.data);
      }
      return;
    }

    const famBtn = e.target.closest('[data-family]');
    if (famBtn) {
      const fid = famBtn.dataset.family;
      state.family = state.family === fid ? '' : fid;
      state.etag = '';
      poll(true);
      return;
    }

    if (e.target.closest('#solo-reset-btn')) {
      state.family = '';
      state.etag = '';
      poll(true);
      return;
    }

    const modelRow = e.target.closest('[data-model]');
    if (modelRow) {
      const m = modelRow.dataset.model;
      if (state.expandedModels.has(m)) state.expandedModels.delete(m);
      else state.expandedModels.add(m);
      if (state.data) renderBreakdown(state.data);
      return;
    }

    const sessRow = e.target.closest('[data-session]');
    if (sessRow) {
      const cid = sessRow.dataset.session;
      if (cid && window.sidecar?.ui?.toggleConversation) {
        window.sidecar.ui.toggleConversation(cid, { focus: true });
      }
    }
  });

  const stageEl = $('chart-stage');
  stageEl.addEventListener('pointermove', (e) => {
    const svg = $('area-chart');
    const geom = svg._chartGeom;
    if (!geom || !state.data || geom.count === 0) return;
    const rect = svg.getBoundingClientRect();
    if (!rect.width) return;
    const svgX = ((e.clientX - rect.left) / rect.width) * geom.W;
    const clamped = Math.max(0, Math.min(1, (svgX - geom.pad.left) / geom.plotW));
    const idx = Math.round(clamped * (geom.count - 1));
    if (idx !== state.hoverIdx) {
      state.hoverIdx = idx;
      renderChart(state.data);
    }
  });
  stageEl.addEventListener('pointerleave', () => {
    if (state.hoverIdx !== null) {
      state.hoverIdx = null;
      if (state.data) renderChart(state.data);
    }
  });

  new ResizeObserver(() => {
    if (state.data && (state.data.totals?.records || 0) > 0) {
      renderChart(state.data);
    }
  }).observe(stageEl);

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) poll(false);
    schedulePoll();
  });

  (async () => {
    await poll(true);
    schedulePoll();
  })();
})();
