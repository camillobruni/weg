'use strict';
/* global uPlot */

// ── Chart View (uPlot) ──────────────────────────────────────────────

const ChartView = (() => {

  // ── Metric definitions ─────────────────────────────────────────
  const METRICS = {
    elevation:   { label: 'Elevation',   unit: 'm',    color: '#4ECDC4', field: 'ele',      fmt: (v, s) => s ? `${v.toFixed(0)}` : `${v.toFixed(0)} m`,     fmtAxis: v => v.toFixed(0),  transform: null },
    speed:       { label: 'Speed',       unit: 'km/h', color: '#45B7D1', field: 'speed',    fmt: (v, s) => s ? `${v.toFixed(1)}` : `${v.toFixed(1)} km/h`,  fmtAxis: v => v.toFixed(1),  transform: v => v * 3.6 },
    gradient:    { label: 'Gradient',    unit: '%',    color: '#A8C8A0', field: 'gradient', fmt: (v, s) => s ? `${v.toFixed(1)}` : `${v.toFixed(1)} %`,     fmtAxis: v => `${v.toFixed(0)}%`, transform: null, compute: (pts, fill) => fill(smoothGradient(pts, 20)) },
    power:       { label: 'Power',       unit: 'W',    color: '#F7DC6F', field: 'power',    fmt: (v, s) => s ? `${v.toFixed(0)}` : `${v.toFixed(0)} W`,     fmtAxis: v => v.toFixed(0),  transform: null },
    hr:          { label: 'Heart Rate',  unit: 'bpm',  color: '#FF6B6B', field: 'hr',       fmt: (v, s) => s ? `${v.toFixed(0)}` : `${v.toFixed(0)} bpm`,   fmtAxis: v => v.toFixed(0),  transform: null },
    cadence:     { label: 'Cadence',     unit: 'rpm',  color: '#BB8FCE', field: 'cad',      fmt: (v, s) => s ? `${v.toFixed(0)}` : `${v.toFixed(0)} rpm`,   fmtAxis: v => v.toFixed(0),  transform: null },
    temperature: { label: 'Temperature', unit: '°C',   color: '#F8C471', field: 'temp',     fmt: (v, s) => s ? `${v.toFixed(1)}` : `${v.toFixed(1)} °C`,    fmtAxis: v => v.toFixed(1),  transform: null },
  };

  // ── State ──────────────────────────────────────────────────────
  let plots        = [];
  let syncKey      = null;
  let scaleSyncing = false;
  let activeMetrics = new Set(['elevation','speed']);
  let xAxis        = 'distance';
  let currentTrack = null;

  // Selection / anchor
  let selAnchorVal  = null;   // x-value at drag-start / zoom left edge
  let selEndVal     = null;   // x-value at zoom right edge
  let isDragging    = false;
  let updatingRange = false;  // guard against setScale hook re-entry during handle drag
  let pinnedPtIdx   = null;   // point index pinned by map click

  // Callbacks
  let onCursorMoveCb  = null;
  let onRangeChangeCb = null;
  let onClickCb       = null;

  const HIST_W      = 130;
  const HIST_MARGIN = 10 + 55; // margin-left + margin-right on .hist-col
  let statsVisible = true;
  let histTooltipEl = null;
  let container, emptyEl, selStatsEl, resetSelBtn;
  let mapColorMetric     = null;
  let onMapColorChangeCb = null;

  // ── Init ──────────────────────────────────────────────────────
  function init(onCursorMove, onRangeChange, onClick) {
    onCursorMoveCb  = onCursorMove;
    onRangeChangeCb = onRangeChange;
    onClickCb       = onClick;
    container     = document.getElementById('charts-container');
    emptyEl       = document.getElementById('chart-empty');
    selStatsEl    = document.getElementById('chart-stats-sel');
    resetSelBtn   = document.getElementById('btn-reset-selection');
    histTooltipEl = document.getElementById('hist-tooltip');
    syncKey = uPlot.sync('strasse-sync');

    document.getElementById('sel-cancel-btn')?.addEventListener('click', cancelSelection);
    resetSelBtn?.classList.add('hidden');
  }

  // ── Public API ────────────────────────────────────────────────
  function loadTrack(track) {
    pinnedPtIdx = null;
    // Enable every metric that has at least one non-null data point in this file
    activeMetrics = new Set(
      Object.entries(METRICS)
        .filter(([, def]) => def.compute
          ? track.points.some(p => p[def.field] != null)
          : track.points.some(p => p[def.field] != null))
        .map(([key]) => key)
    );
    // Gradient is off by default (elevation already shows it)
    activeMetrics.delete('gradient');
    // Sync the pill buttons in the toolbar
    document.querySelectorAll('.metric-pill').forEach(pill => {
      pill.classList.toggle('active', activeMetrics.has(pill.dataset.metric));
    });
    currentTrack = track;
    render();
  }

  function clear() {
    pinnedPtIdx  = null;
    currentTrack = null;
    destroyPlots();
    if (emptyEl) { emptyEl.style.display = 'flex'; emptyEl.textContent = 'Select a track to view analysis'; }
    document.getElementById('chart-stats').classList.add('hidden');
    clearSelectionStats();
    mapColorMetric = null;
    if (onMapColorChangeCb) onMapColorChangeCb(null);
  }

  function toggleMetric(key) {
    if (activeMetrics.has(key)) activeMetrics.delete(key);
    else                        activeMetrics.add(key);
    if (currentTrack) render();
  }

  function setXAxis(axis) { xAxis = axis; if (currentTrack) render(); }

  function toggleStats() {
    statsVisible = !statsVisible;
    plots.forEach(({ histCol }) => histCol.classList.toggle('visible', statsVisible));
    resize();
  }

  function setMapColorChangeCb(cb) { onMapColorChangeCb = cb; }

  function toggleMapColor(key) {
    if (mapColorMetric === key) {
      mapColorMetric = null;
      _updateMapColorBtns();
      if (onMapColorChangeCb) onMapColorChangeCb(null);
    } else {
      mapColorMetric = key;
      _updateMapColorBtns();
      _fireMapColorCb();
    }
  }

  function _updateMapColorBtns() {
    document.querySelectorAll('.map-color-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.metric === mapColorMetric);
    });
  }

  function _fireMapColorCb() {
    if (!onMapColorChangeCb || !mapColorMetric || !currentTrack) return;
    const plot = plots.find(p => p.metricKey === mapColorMetric);
    if (!plot) return;
    const colors = _computePointColors(mapColorMetric, plot.yData);
    onMapColorChangeCb({ pts: currentTrack.points, colors });
  }

  function _computePointColors(key, yData) {
    const vals = yData.filter(v => v != null && isFinite(v));
    if (!vals.length) return yData.map(() => '#888896');
    const min = Math.min(...vals), max = Math.max(...vals);
    return yData.map(v => {
      if (v == null || !isFinite(v)) return '#888896';
      if (key === 'gradient') return gradientColor(v);
      const t = max === min ? 0.5 : Math.max(0, Math.min(1, (v - min) / (max - min)));
      if (t <= 0.25) return lerpHex('#4575b4', '#91bfdb', t / 0.25);
      if (t <= 0.5)  return lerpHex('#91bfdb', '#fee090', (t - 0.25) / 0.25);
      if (t <= 0.75) return lerpHex('#fee090', '#fc8d59', (t - 0.5)  / 0.25);
      return              lerpHex('#fc8d59', '#d73027',  (t - 0.75) / 0.25);
    });
  }

  function resetZoom() {
    plots.forEach(({ uplot: u, xData }) => u.setScale('x', { min: xData[0], max: xData[xData.length-1] }));
  }

  function cancelSelection() {
    selAnchorVal = null;
    selEndVal    = null;
    updateSelOverlay();
    redrawHistograms();
    resetZoom();
    if (onRangeChangeCb) onRangeChangeCb(null, null, xAxis);
  }

  function setSelectionStats(stats) {
    if (!selStatsEl) return;
    const fmt = (id, val) => { const el = document.querySelector(`#${id} .stat-value`); if (el) el.textContent = val; };
    fmt('sel-distance',   stats.totalDist  != null ? `${(stats.totalDist/1000).toFixed(1)} km` : '—');
    fmt('sel-duration',   stats.duration   != null ? fmtSecs(Math.floor(stats.duration/1000)) : '—');
    fmt('sel-elevation',  stats.elevGain   != null ? `${Math.round(stats.elevGain)} m` : '—');
    fmt('sel-avg-speed',  stats.avgSpeed   != null ? `${(stats.avgSpeed*3.6).toFixed(1)} km/h` : '—');
    fmt('sel-avg-power',  stats.avgPower   != null ? `${stats.avgPower} W` : '—');
    fmt('sel-avg-hr',     stats.avgHR      != null ? `${stats.avgHR} bpm` : '—');
    selStatsEl.classList.remove('hidden');
    resetSelBtn?.classList.remove('hidden');
  }

  function clearSelectionStats() {
    if (selStatsEl) selStatsEl.classList.add('hidden');
    resetSelBtn?.classList.add('hidden');
  }

  // Called on boot to restore a saved selection without re-firing onRangeChangeCb
  function restoreSelection(xMin, xMax) {
    scaleSyncing = true; // suppress the setScale → onRangeChangeCb loop
    plots.forEach(({ uplot: u }) => {
      u.setScale('x', { min: xMin, max: xMax });
    });
    scaleSyncing = false;
    selAnchorVal = xMin;
    selEndVal    = xMax;
    updateSelOverlay();
  }

  function resize() {
    if (!plots.length) return;
    const w = Math.max(100, container.clientWidth - (statsVisible ? HIST_W + HIST_MARGIN : 0));
    plots.forEach(({ uplot: u, histCanvas, histData }) => {
      u.setSize({ width: w, height: u.height });
      if (statsVisible && histCanvas && histData) drawHistogram(histCanvas, histData, u.height);
    });
    updateSelOverlay();
  }

  // ── Render ────────────────────────────────────────────────────
  function render() {
    destroyPlots();
    if (!currentTrack) return;
    const pts = currentTrack.points;
    if (!pts.length) return;

    let xData;
    if (xAxis === 'distance') {
      xData = pts.map(p => (p.dist || 0) / 1000);
    } else {
      const t0 = pts[0].time || 0;
      xData = pts.map(p => p.time != null ? (p.time - t0) / 1000 : null);
    }

    const available = [...activeMetrics].filter(m => pts.some(p => p[METRICS[m].field] != null));
    if (!available.length) {
      if (emptyEl) { emptyEl.style.display = 'flex'; emptyEl.textContent = 'No data for selected metrics'; }
      return;
    }
    if (emptyEl) emptyEl.style.display = 'none';

    const w = Math.max(100, container.clientWidth - (statsVisible ? HIST_W + HIST_MARGIN : 0));
    available.forEach(key => {
      const def   = METRICS[key];
      const yData = def.compute
        ? def.compute(pts, fillNulls)
        : fillNulls(pts.map(p => { const v = p[def.field]; return (v != null && def.transform) ? def.transform(v) : v; }));
      createChart(key, def, xData, yData, w, pts);
    });

    updateStats(currentTrack);
    // Restore anchor/end lines if a selection was active
    updateSelOverlay();
    // Re-apply map color if active
    _updateMapColorBtns();
    if (mapColorMetric) _fireMapColorCb();
  }

  // ── Create one chart row ───────────────────────────────────────
  function createChart(metricKey, def, xData, yData, w, pts) {
    // Gradient data: smooth over a 20 m distance window (±10 m each side)
    const gradData = metricKey === 'elevation' ? smoothGradient(pts, 20) : null;
    const row = document.createElement('div');
    row.className = 'chart-row';
    row.dataset.metric = metricKey;
    row.style.setProperty('--chart-color', def.color);

    // Header
    const header = document.createElement('div');
    header.className = 'chart-row-header';
    const labelEl  = document.createElement('span');
    labelEl.className = 'chart-row-label';
    labelEl.textContent = def.label;
    const mapColorBtn = document.createElement('button');
    mapColorBtn.className = 'map-color-btn icon-btn' + (mapColorMetric === metricKey ? ' active' : '');
    mapColorBtn.dataset.metric = metricKey;
    mapColorBtn.title = 'Color map track by this metric';
    mapColorBtn.innerHTML = '<span class="material-symbols-rounded">colorize</span>';
    mapColorBtn.addEventListener('click', () => toggleMapColor(metricKey));
    const minmaxEl = document.createElement('div');
    minmaxEl.className = 'chart-minmax';
    header.append(labelEl, mapColorBtn, minmaxEl);

    const rowBody = document.createElement('div');
    rowBody.className = 'chart-row-body';

    const plotEl = document.createElement('div');
    rowBody.appendChild(plotEl);

    const histCol    = document.createElement('div');
    histCol.className = 'hist-col' + (statsVisible ? ' visible' : '');
    const histCanvas  = document.createElement('canvas');
    histCanvas.className = 'hist-canvas';
    histCol.appendChild(histCanvas);
    rowBody.appendChild(histCol);

    row.append(header, rowBody);
    container.appendChild(row);

    const isDistAxis = xAxis === 'distance';

    // Per-range stats
    function renderMinMax(xMin, xMax) {
      const s = rangeStats(xData, yData, xMin, xMax);
      if (!s) { minmaxEl.textContent = ''; return; }
      minmaxEl.innerHTML =
        `<span class="mm-item"><span class="mm-l">min</span>${def.fmt(s.min, true)} ${def.unit}</span>` +
        `<span class="mm-item"><span class="mm-l">avg</span>${def.fmt(s.avg, true)} ${def.unit}</span>` +
        `<span class="mm-item"><span class="mm-l">max</span>${def.fmt(s.max, true)} ${def.unit}</span>`;
    }
    renderMinMax(xData[0], xData[xData.length - 1]);

    const uOpts = {
      width: w, height: 130,
      padding: [4, 0, 0, 0],
      cursor: {
        sync:  { key: syncKey.key },
        drag:  { x: true, y: false, uni: 16 },
        focus: { prox: 16 },
        points: {
          size: 7,
          stroke: '#0e0e10',
          width: 2,
          fill: metricKey === 'elevation'
            ? (u, _si) => gradientColor(gradData ? gradData[u.cursor.idx] : null)
            : def.color,
        },
        x: true, y: false,
      },
      select: { show: true },
      legend: { show: false },
      scales: {
        x: { time: false, range: (_u, mn, mx) => [mn, mx] },
        y: { range: (_u, mn, mx) => { const p = (mx-mn)*0.1||1; return [mn-p, mx+p]; } },
      },
      axes: [
        {
          stroke: '#555564', grid: { stroke: '#2e2e34', width: 1 }, ticks: { stroke: '#2e2e34' },
          size: 30, font: '10px system-ui', color: '#555564',
          values: isDistAxis
            ? (_u, vals) => vals.map(v => v != null ? `${v.toFixed(0)} km` : '')
            : (_u, vals) => vals.map(v => { if (v==null) return ''; const h=Math.floor(v/3600), m=Math.floor((v%3600)/60); return h>0?`${h}:${String(m).padStart(2,'0')}`:`${m}:${String(v%60|0).padStart(2,'0')}`; }),
        },
        {
          stroke: '#555564', grid: { stroke: '#2e2e34', width: 1 }, ticks: { stroke: '#2e2e34' },
          size: 55, font: '10px system-ui', color: '#555564',
          values: (_u, vals) => vals.map(v => v != null ? def.fmtAxis(v) : ''),
        },
      ],
      series: [
        {},
        (metricKey === 'elevation' || metricKey === 'gradient')
          // Invisible — we draw manually in the draw hook
          ? { label: def.label, stroke: 'rgba(0,0,0,0)', fill: 'rgba(0,0,0,0)', width: 0, points: { show: false } }
          : { label: def.label, stroke: def.color, fill: hexToRgba(def.color, 0.08), width: 1.5, points: { show: false } },
      ],
      hooks: {
        draw: [
          ...(metricKey === 'elevation' ? [u => drawElevationGradient(u, xData, yData, gradData)] : []),
          ...(metricKey === 'gradient'  ? [u => drawGradientChart(u, xData, yData)] : []),
          u => drawHoverLine(u, yData, def.color),
          u => drawPinnedDot(u, xData, yData, def.color, def),
        ],
        setCursor: [u => {
          const idx = u.cursor.idx;

          // ── Floating y-value next to cursor dot ──
          const curYValEl = u._strasse?.curYVal;
          if (curYValEl) {
            if (idx != null && yData[idx] != null && u.cursor.left >= 0) {
              const yPx = u.valToPos(yData[idx], 'y');
              const xPx = u.cursor.left;
              const overW = u.over.offsetWidth;

              // For elevation: show "1234 m  ∠ 7.2%"; for gradient: color by value
              if (metricKey === 'elevation' && gradData && gradData[idx] != null) {
                const g = gradData[idx];
                const gColor = gradientColor(g);
                curYValEl.innerHTML = `${def.fmt(yData[idx], false)} <span style="color:${gColor};margin-left:6px;font-size:12px">∠</span> ${Math.abs(g).toFixed(1)}%`;
                curYValEl.style.color = def.color;
                curYValEl.style.borderColor = def.color + '44';
              } else if (metricKey === 'gradient') {
                const gColor = gradientColor(yData[idx]);
                curYValEl.textContent = def.fmt(yData[idx], false);
                curYValEl.style.color = gColor;
                curYValEl.style.borderColor = gColor + '44';
              } else {
                curYValEl.textContent = def.fmt(yData[idx], false);
                curYValEl.style.color = def.color;
                curYValEl.style.borderColor = def.color + '44';
              }

              // Prefer right side; switch left if too close to right edge; clamp so it never bleeds over the y-axis
              const estimatedW = curYValEl.offsetWidth || (curYValEl.textContent.length * 7 + 20);
              const leftPos = overW - xPx > estimatedW + 10 ? xPx + 10 : xPx - estimatedW - 10;
              curYValEl.style.left = `${Math.max(0, leftPos)}px`;
              curYValEl.style.top  = `${Math.max(2, Math.min(yPx - 12, u.over.offsetHeight - 24))}px`;
              curYValEl.style.display = '';
            } else {
              curYValEl.style.display = 'none';
            }
          }

          // Map marker
          if (idx != null && pts[idx] && onCursorMoveCb) {
            onCursorMoveCb(pts[idx]);
          }
          u.redraw(false);
        }],

        setScale: [(u, key) => {
          if (key !== 'x') return;
          const { min, max } = u.scales.x;

          // Sync sibling plots
          if (!scaleSyncing) {
            scaleSyncing = true;
            plots.forEach(({ uplot: other }) => { if (other !== u) other.setScale('x', { min, max }); });
            scaleSyncing = false;
          }

          // Update this chart's stats for visible range
          renderMinMax(min, max);

          // Check if full range
          const xd = plots[0]?.xData;
          const full = !xd || (min <= xd[0] + 0.001 && max >= xd[xd.length-1] - 0.001);

          if (full) {
            selAnchorVal = null;
            selEndVal    = null;
            updateSelOverlay();
            redrawHistograms();
            if (onRangeChangeCb) onRangeChangeCb(null, null, xAxis);
          } else {
            selAnchorVal = min;
            selEndVal    = max;
            updateSelOverlay();
            redrawHistograms();
            if (onRangeChangeCb) onRangeChangeCb(min, max, xAxis);
          }
        }],

        setSelect: [u => {
          if (u.select.width > 0 && isDragging) {
            // No-op (previously showSelInfo)
          }
        }],
      },
    };

    const uplot = new uPlot(uOpts, [xData, yData], plotEl);
    syncKey.sub(uplot);

    // ── Overlay (pointer-events off except handles) ──
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:visible;z-index:5';

    // Selection fill
    const selFill = document.createElement('div');
    selFill.className = 'sel-fill';
    selFill.style.display = 'none';

    // Anchor line + label + drag handle
    const anchorLine   = document.createElement('div');
    anchorLine.className = 'sel-line sel-line-anchor';
    anchorLine.style.display = 'none';

    const anchorLabel  = document.createElement('div');
    anchorLabel.className = 'sel-line-label sel-line-label-anchor';
    anchorLabel.style.display = 'none';

    const anchorHandle = document.createElement('div');
    anchorHandle.className = 'sel-handle sel-handle-anchor';
    anchorHandle.style.display = 'none';

    const anchorMarker = document.createElement('div');
    anchorMarker.className = 'sel-graph-marker';
    anchorMarker.innerHTML = '<span class="material-symbols-rounded" style="color:#000; font-size:20px; font-variation-settings:\'FILL\' 1; filter: drop-shadow(0 0 1px #fff) drop-shadow(0 0 2px #fff); opacity: 0.5">play_circle</span>';
    anchorMarker.style.display = 'none';

    // End line + label + drag handle
    const endLine   = document.createElement('div');
    endLine.className = 'sel-line sel-line-end';
    endLine.style.display = 'none';

    const endLabel  = document.createElement('div');
    endLabel.className = 'sel-line-label sel-line-label-end';
    endLabel.style.display = 'none';

    const endHandle = document.createElement('div');
    endHandle.className = 'sel-handle sel-handle-end';
    endHandle.style.display = 'none';

    const endMarker = document.createElement('div');
    endMarker.className = 'sel-graph-marker';
    endMarker.innerHTML = '<span class="material-symbols-rounded" style="color:#000; font-size:20px; font-variation-settings:\'FILL\' 1; filter: drop-shadow(0 0 1px #fff) drop-shadow(0 0 2px #fff); opacity: 0.5">stop_circle</span>';
    endMarker.style.display = 'none';

    // Floating cursor y-value
    const curYVal = document.createElement('div');
    curYVal.className = 'cur-y-val';
    curYVal.style.cssText = `color:${def.color};display:none`;

    overlay.append(selFill, anchorLine, anchorLabel, anchorHandle, anchorMarker, endLine, endLabel, endHandle, endMarker, curYVal);
    uplot.over.appendChild(overlay);

    // Back-reference
    uplot._strasse = {
      selFill,
      anchorLine, anchorLabel, anchorHandle, anchorMarker,
      endLine, endLabel, endHandle, endMarker,
      curYVal, renderMinMax
    };

    // ── Handle drag ──
    attachHandleDrag(anchorHandle, uplot, xData, true);
    attachHandleDrag(endHandle,    uplot, xData, false);

    // ── Mouse listeners ──
    let mousedownX = null;
    uplot.over.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      isDragging = false;
      const rect  = uplot.over.getBoundingClientRect();
      const xPx   = e.clientX - rect.left;
      mousedownX  = xPx;
    });
    uplot.over.addEventListener('mousemove', e => {
      if (mousedownX !== null) {
        const rect = uplot.over.getBoundingClientRect();
        if (Math.abs(e.clientX - rect.left - mousedownX) > 5) isDragging = true;
      }
    });
    uplot.over.addEventListener('mouseup', () => { mousedownX = null; });

    // Click to pin point (sticky selection)
    uplot.over.addEventListener('click', () => {
      if (isDragging) return;
      const idx = uplot.cursor.idx;
      if (idx != null && pts[idx]) {
        pinnedPtIdx = idx;
        plots.forEach(({ uplot: u }) => u.redraw(false));
        if (onClickCb) onClickCb(pts[idx]);
      }
    });

    plotEl.addEventListener('dblclick', cancelSelection);

    const histData = { yData, xData, def, BINS: 24 };
    drawHistogram(histCanvas, histData, 130);
    attachHistTooltip(histCanvas, histData);

    plots.push({ uplot, row, xData, yData, def, metricKey, minmaxEl, histCol, histCanvas, histData });
  }

  // ── Selection overlay (fill + lines + handles) ───────────────
  function updateSelOverlay() {
    updateAnchorLines();
  }

  function updateAnchorLines() {
    plots.forEach(({ uplot: u }) => {
      const s = u._strasse; if (!s) return;
      const {
        selFill,
        anchorLine, anchorLabel, anchorHandle, anchorMarker,
        endLine, endLabel, endHandle, endMarker
      } = s;
      if (selAnchorVal == null || selEndVal == null) {
        [selFill, anchorLine, anchorLabel, anchorHandle, anchorMarker, endLine, endLabel, endHandle, endMarker]
          .forEach(el => { el.style.display = 'none'; });
        return;
      }
      const aX = u.valToPos(selAnchorVal, 'x');
      const eX = u.valToPos(selEndVal,    'x');
      const overW = u.over.offsetWidth;
      const overH = u.over.offsetHeight;

      // Fill
      selFill.style.left    = `${aX}px`;
      selFill.style.width   = `${eX - aX}px`;
      selFill.style.top     = '0';
      selFill.style.height  = `${overH}px`;
      selFill.style.display = '';

      // Anchor line
      anchorLine.style.left    = `${aX}px`;
      anchorLine.style.height  = `${overH}px`;
      anchorLine.style.display = '';
      // Anchor label
      const aText = fmtXVal(selAnchorVal);
      anchorLabel.textContent  = aText;
      const aLabelW = aText.length * 7 + 10;
      anchorLabel.style.left   = aX + aLabelW + 4 < overW ? `${aX + 3}px` : `${aX - aLabelW - 3}px`;
      anchorLabel.style.display = '';
      // Anchor handle
      anchorHandle.style.left  = `${aX}px`;
      anchorHandle.style.display = '';
      // Anchor marker
      anchorMarker.style.left = `${aX}px`;
      anchorMarker.style.top = `${overH}px`;
      anchorMarker.style.display = '';

      // End line
      endLine.style.left    = `${eX}px`;
      endLine.style.height  = `${overH}px`;
      endLine.style.display = '';
      // End label
      const eText = fmtXVal(selEndVal);
      endLabel.textContent  = eText;
      const eLabelW = eText.length * 7 + 10;
      endLabel.style.left   = eX - eLabelW - 3 > 0 ? `${eX - eLabelW - 3}px` : `${eX + 3}px`;
      endLabel.style.display = '';
      // End handle
      endHandle.style.left  = `${eX}px`;
      endHandle.style.display = '';
      // End marker
      endMarker.style.left = `${eX}px`;
      endMarker.style.top = `${overH}px`;
      endMarker.style.display = '';
    });
  }

  function fmtXVal(v) {
    return xAxis === 'distance' ? `${v.toFixed(2)} km` : fmtSecs(v);
  }

  // ── Handle drag logic ─────────────────────────────────────────
  function attachHandleDrag(handleEl, uplot, xData, isAnchor) {
    // pointer-events enabled on the handle itself
    handleEl.style.pointerEvents = 'auto';

    handleEl.addEventListener('mousedown', e => {
      e.stopPropagation();
      e.preventDefault();
      const startX = e.clientX;
      const startVal = isAnchor ? selAnchorVal : selEndVal;
      const overW   = uplot.over.offsetWidth;
      // px-per-data-unit at current zoom
      const xMin = uplot.scales.x.min, xMax = uplot.scales.x.max;
      const pxPerUnit = overW / (xMax - xMin);
      const xFull = [xData[0], xData[xData.length - 1]];

      document.body.style.cursor = 'ew-resize';
      isDragging = true;

      function onMove(me) {
        const dx   = me.clientX - startX;
        let newVal = startVal + dx / pxPerUnit;
        newVal = Math.max(xFull[0], Math.min(xFull[1], newVal));

        if (isAnchor) {
          selAnchorVal = Math.min(newVal, selEndVal - 0.001);
        } else {
          selEndVal    = Math.max(newVal, selAnchorVal + 0.001);
        }
        setSelectionRange(selAnchorVal, selEndVal);
      }

      function onUp() {
        document.body.style.cursor = '';
        isDragging = false;
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup',   onUp);
      }

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup',   onUp);
    });
  }

  // Apply a selection range to all plots + trigger callbacks
  function setSelectionRange(xMin, xMax) {
    updatingRange = true;
    scaleSyncing  = true;
    plots.forEach(({ uplot: u }) => u.setScale('x', { min: xMin, max: xMax }));
    scaleSyncing  = false;
    updatingRange = false;

    // Update each chart's min/max stats for the new range
    plots.forEach(p => p.uplot._strasse?.renderMinMax(xMin, xMax));

    updateSelOverlay();
    if (onRangeChangeCb) onRangeChangeCb(xMin, xMax, xAxis);
  }

  // ── Overall stats bar ──────────────────────────────────────────
  function updateStats(track) {
    const s = track.stats;
    document.getElementById('chart-stats').classList.remove('hidden');
    const fmt = (id, val) => { const el = document.querySelector(`#${id} .stat-value`); if (el) el.textContent = val; };
    fmt('stat-distance',  s.totalDist != null ? `${(s.totalDist/1000).toFixed(1)} km` : '—');
    fmt('stat-duration',  s.duration  != null ? fmtSecs(Math.floor(s.duration/1000)) : '—');
    fmt('stat-elevation', s.elevGain  != null ? `${Math.round(s.elevGain)} m` : '—');
    fmt('stat-avg-speed', s.avgSpeed  != null ? `${(s.avgSpeed*3.6).toFixed(1)} km/h` : '—');
    fmt('stat-avg-power', s.avgPower  != null ? `${s.avgPower} W` : '—');
    fmt('stat-avg-hr',    s.avgHR     != null ? `${s.avgHR} bpm` : '—');
  }

  // ── Helpers ───────────────────────────────────────────────────
  function destroyPlots() {
    if (histTooltipEl) histTooltipEl.style.display = 'none';
    plots.forEach(({ uplot: u, row }) => { syncKey.unsub(u); u.destroy(); row.remove(); });
    plots = [];
    selAnchorVal = null;
    selEndVal    = null;
    isDragging   = false;
  }

  function rangeStats(xData, yData, xMin, xMax) {
    let min = Infinity, max = -Infinity, sum = 0, n = 0;
    for (let i = 0; i < xData.length; i++) {
      if (xData[i] == null || xData[i] < xMin || xData[i] > xMax) continue;
      const v = yData[i];
      if (v == null || !isFinite(v)) continue;
      if (v < min) min = v; if (v > max) max = v;
      sum += v; n++;
    }
    return n ? { min, max, avg: sum / n } : null;
  }

  // Distance-weighted gradient smoothing over a window of `windowM` metres.
  // For each point, averages all neighbours within ±(windowM/2) metres of dist.
  function smoothGradient(pts, windowM) {
    const half  = windowM / 2;
    const n     = pts.length;
    const dists = pts.map(p => p.dist || 0);  // cumulative metres
    const raw   = pts.map(p => p.gradient);

    const out = new Array(n).fill(null);
    let lo = 0, hi = 0;                        // sliding window indices

    for (let i = 0; i < n; i++) {
      const d = dists[i];
      // Expand / shrink window
      while (lo < i     && dists[lo] < d - half) lo++;
      while (hi < n - 1 && dists[hi] <= d + half) hi++;

      let sum = 0, cnt = 0;
      for (let j = lo; j <= hi; j++) {
        if (raw[j] == null) continue;
        sum += raw[j]; cnt++;
      }
      out[i] = cnt ? sum / cnt : null;
    }

    return fillNulls(out);
  }

  function fillNulls(arr) {
    const out = [...arr];
    let last = null;
    for (let i = 0; i < out.length; i++) { if (out[i] != null) last = out[i]; else if (last != null) out[i] = last; }
    last = null;
    for (let i = out.length-1; i >= 0; i--) { if (out[i] != null) last = out[i]; else if (last != null) out[i] = last; }
    return out;
  }

  // ── Standalone gradient chart draw ───────────────────────────
  function drawGradientChart(u, xData, yData) {
    const ctx = u.ctx;
    const dpr = window.devicePixelRatio || 1;
    const bb  = u.bbox;

    ctx.save();
    ctx.beginPath();
    ctx.rect(bb.left, bb.top, bb.width, bb.height);
    ctx.clip();

    // Zero line
    const zeroY = u.valToPos(0, 'y', true);
    if (zeroY >= bb.top && zeroY <= bb.top + bb.height) {
      ctx.beginPath();
      ctx.setLineDash([4 * dpr, 4 * dpr]);
      ctx.strokeStyle = 'rgba(255,255,255,0.15)';
      ctx.lineWidth   = 1 * dpr;
      ctx.moveTo(bb.left, zeroY);
      ctx.lineTo(bb.left + bb.width, zeroY);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Colored line segments
    ctx.lineWidth  = 1.5 * dpr;
    ctx.lineJoin   = 'round';
    ctx.lineCap    = 'round';
    for (let i = 1; i < xData.length; i++) {
      if (xData[i] == null || yData[i] == null || xData[i-1] == null || yData[i-1] == null) continue;
      const x0 = u.valToPos(xData[i-1], 'x', true);
      const y0 = u.valToPos(yData[i-1], 'y', true);
      const x1 = u.valToPos(xData[i],   'x', true);
      const y1 = u.valToPos(yData[i],   'y', true);
      ctx.strokeStyle = gradientColor(yData[i]);
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }

    ctx.restore();
  }

  // ── Gradient-colored elevation draw ──────────────────────────
  function drawElevationGradient(u, xData, yData, gradData) {
    const ctx = u.ctx;
    const dpr = window.devicePixelRatio || 1;
    const bb  = u.bbox; // canvas-px bounding box

    ctx.save();
    ctx.beginPath();
    ctx.rect(bb.left, bb.top, bb.width, bb.height);
    ctx.clip();

    // ── Area fill (subtle, neutral teal) ──
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < xData.length; i++) {
      if (xData[i] == null || yData[i] == null) continue;
      const cx = u.valToPos(xData[i], 'x', true);
      const cy = u.valToPos(yData[i], 'y', true);
      started ? ctx.lineTo(cx, cy) : (ctx.moveTo(cx, cy), started = true);
    }
    // close back to bottom
    const lastX = u.valToPos(xData[xData.length - 1], 'x', true);
    const firstX = u.valToPos(xData[0], 'x', true);
    const baseY  = bb.top + bb.height;
    ctx.lineTo(lastX, baseY);
    ctx.lineTo(firstX, baseY);
    ctx.closePath();
    ctx.fillStyle = 'rgba(78,205,196,0.07)';
    ctx.fill();

    // ── Colored line segments ──
    ctx.lineWidth = 1.5 * dpr;
    ctx.lineJoin  = 'round';
    ctx.lineCap   = 'round';

    for (let i = 1; i < xData.length; i++) {
      if (xData[i] == null || yData[i] == null || xData[i-1] == null || yData[i-1] == null) continue;
      const x0 = u.valToPos(xData[i-1], 'x', true);
      const y0 = u.valToPos(yData[i-1], 'y', true);
      const x1 = u.valToPos(xData[i],   'x', true);
      const y1 = u.valToPos(yData[i],   'y', true);
      ctx.strokeStyle = gradientColor(gradData ? gradData[i] : null);
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }

    ctx.restore();
  }

  // Color ramp: descent → flat → climb → steep → brutal
  // 0% = gray, +25% = near-black dark red; negatives = muted blue
  function gradientColor(g) {
    if (g == null || !isFinite(g)) return '#888896';
    if (g <= 0) return lerpHex('#888896', '#5b8fcc', Math.min(-g / 12, 1));  // gentle descent blue
    if (g <=  6) return lerpHex('#888896', '#d4a827', g / 6);                 // flat → warm yellow
    if (g <= 12) return lerpHex('#d4a827', '#d95a00', (g -  6) / 6);         // yellow → orange
    if (g <= 20) return lerpHex('#d95a00', '#8b0000', (g - 12) / 8);         // orange → dark red
    return             lerpHex('#8b0000', '#1a0000',  Math.min((g - 20) / 8, 1)); // dark red → near black
  }

  function lerpHex(a, b, t) {
    t = Math.max(0, Math.min(1, t));
    const p = s => [parseInt(s.slice(1,3),16), parseInt(s.slice(3,5),16), parseInt(s.slice(5,7),16)];
    const [ar,ag,ab] = p(a), [br,bg,bb2] = p(b);
    return `rgb(${Math.round(ar+(br-ar)*t)},${Math.round(ag+(bg-ag)*t)},${Math.round(ab+(bb2-ab)*t)})`;
  }

  function hexToRgba(hex, alpha) {
    const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  function fmtSecs(s) {
    s = Math.floor(s);
    const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), ss = s%60;
    return h > 0 ? `${h}:${String(m).padStart(2,'0')}:${String(ss).padStart(2,'0')}` : `${m}:${String(ss).padStart(2,'0')}`;
  }

  // Pin a circle on every chart at the given point index (from a map click).
  // Drawn on the canvas via the draw hook — no DOM positioning issues.
  function setCursorAt(ptIdx) {
    pinnedPtIdx = ptIdx;
    plots.forEach(({ uplot: u }) => u.redraw(false)); // false = skip data re-render
  }

  function clearPinnedDot() {
    pinnedPtIdx = null;
    plots.forEach(({ uplot: u }) => u.redraw(false));
  }

  function drawHoverLine(u, yData, color) {
    const idx = u.cursor.idx;
    if (idx == null || yData[idx] == null || u.cursor.left < 0) return;

    const cy  = u.valToPos(yData[idx], 'y', true);
    const bb  = u.bbox;
    const ctx = u.ctx;
    const dpr = window.devicePixelRatio || 1;

    ctx.save();
    ctx.setLineDash([5 * dpr, 5 * dpr]);
    ctx.strokeStyle = hexToRgba(color, 0.4);
    ctx.lineWidth = 1 * dpr;
    ctx.beginPath();
    ctx.moveTo(bb.left, cy);
    ctx.lineTo(bb.left + bb.width, cy);
    ctx.stroke();
    ctx.restore();
  }

  function drawPinnedDot(u, xData, yData, color, def) {
    if (pinnedPtIdx == null) return;
    const xVal = xData[pinnedPtIdx];
    const yVal = yData[pinnedPtIdx];
    if (xVal == null || yVal == null) return;

    const cx  = u.valToPos(xVal, 'x', true);
    const cy  = u.valToPos(yVal, 'y', true);
    const bb  = u.bbox;
    const ctx = u.ctx;
    const dpr = window.devicePixelRatio || 1;

    // Clamp cy to bbox (point may be scrolled out of visible x-range)
    if (cx < bb.left - 1 || cx > bb.left + bb.width + 1) return;
    const cyClamp = Math.max(bb.top, Math.min(bb.top + bb.height, cy));

    ctx.save();

    // ── 1. Solid fill above the pinned line ────────────────────────
    // Walk across all data points; where yData > yVal, fill from curve down to cy.
    const rgba = hexToRgba(color, 0.35);
    ctx.beginPath();
    let inAbove = false;
    for (let i = 0; i < xData.length; i++) {
      if (xData[i] == null || yData[i] == null) { inAbove = false; continue; }
      const px = u.valToPos(xData[i], 'x', true);
      const py = u.valToPos(yData[i], 'y', true);
      if (py <= cyClamp) {           // curve is above the line (canvas y is inverted)
        if (!inAbove) {
          // Start new sub-path: move to line level, then up to curve
          const pxPrev = i > 0 ? u.valToPos(xData[i-1], 'x', true) : px;
          ctx.moveTo(pxPrev, cyClamp);
          inAbove = true;
        }
        ctx.lineTo(px, py);
      } else {
        if (inAbove) {
          // Close back down to line level
          const pxPrev = u.valToPos(xData[i-1], 'x', true);
          ctx.lineTo(pxPrev, cyClamp);
          ctx.closePath();
        }
        inAbove = false;
      }
    }
    if (inAbove) {
      const lastX = u.valToPos(xData[xData.length - 1], 'x', true);
      ctx.lineTo(lastX, cyClamp);
      ctx.closePath();
    }
    ctx.fillStyle = rgba;
    ctx.fill();

    // ── 2. Dotted horizontal line across full plot width ──────────
    ctx.beginPath();
    ctx.setLineDash([4 * dpr, 4 * dpr]);
    ctx.moveTo(bb.left, cyClamp);
    ctx.lineTo(bb.left + bb.width, cyClamp);
    ctx.strokeStyle = hexToRgba(color, 0.6);
    ctx.lineWidth   = 1.5 * dpr;
    ctx.stroke();
    ctx.setLineDash([]);

    // ── 3. Dot ─────────────────────────────────────────────────────
    const r = 5 * dpr;
    ctx.beginPath();
    ctx.arc(cx, cyClamp, r, 0, Math.PI * 2);
    ctx.fillStyle   = 'rgba(14,14,16,0.9)';
    ctx.strokeStyle = color;
    ctx.lineWidth   = 2 * dpr;
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cyClamp, 2 * dpr, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();

    // ── 4. Tooltip label ───────────────────────────────────────────
    const label    = `${def.fmt(yVal, false)} ${def.unit}`;
    const fontSize = 11 * dpr;
    ctx.font      = `600 ${fontSize}px system-ui, sans-serif`;
    const tw      = ctx.measureText(label).width;
    const pad     = 5 * dpr;
    const th      = fontSize + pad * 1.6;
    const bw      = tw + pad * 2.4;
    // Prefer right of dot; flip left if too close to edge
    const bx = cx + r + 4 * dpr + bw < bb.left + bb.width
      ? cx + r + 4 * dpr
      : cx - r - 4 * dpr - bw;
    const by = cyClamp - th / 2;

    // Background pill
    ctx.beginPath();
    const rad = 4 * dpr;
    if (ctx.roundRect) {
      ctx.roundRect(bx, by, bw, th, rad);
    } else {
      ctx.moveTo(bx + rad, by);
      ctx.arcTo(bx + bw, by, bx + bw, by + th, rad);
      ctx.arcTo(bx + bw, by + th, bx, by + th, rad);
      ctx.arcTo(bx, by + th, bx, by, rad);
      ctx.arcTo(bx, by, bx + bw, by, rad);
      ctx.closePath();
    }
    ctx.fillStyle = 'rgba(14,14,16,0.88)';
    ctx.fill();
    ctx.strokeStyle = hexToRgba(color, 0.55);
    ctx.lineWidth   = 1 * dpr;
    ctx.stroke();

    // Text
    ctx.fillStyle    = color;
    ctx.textBaseline = 'middle';
    ctx.fillText(label, bx + pad * 1.2, by + th / 2);

    ctx.restore();
  }

  // ── Histogram drawing ─────────────────────────────────────────
  function buildHistBins(histData) {
    if (histData.bins) return; // already built
    const { yData, xData, BINS } = histData;
    const values = yData.filter(v => v != null && isFinite(v));
    if (!values.length) return;

    const min  = Math.min(...values);
    const max  = Math.max(...values);
    const span = max - min || 1;

    const bins      = new Array(BINS).fill(0);
    const binAccum  = new Array(BINS).fill(0); // accumulated x-weight per bin (time in s or dist in km)

    for (let i = 0; i < yData.length; i++) {
      const v = yData[i];
      if (v == null || !isFinite(v)) continue;
      const bi = Math.min(BINS - 1, Math.floor(((v - min) / span) * BINS));
      bins[bi]++;
      // Weight = half-interval to prev + half-interval to next
      if (xData) {
        const prev = i > 0 && xData[i - 1] != null ? xData[i - 1] : xData[i];
        const next = i < xData.length - 1 && xData[i + 1] != null ? xData[i + 1] : xData[i];
        binAccum[bi] += (next - prev) / 2;
      }
    }

    histData.bins     = bins;
    histData.binAccum = binAccum;
    histData.min      = min;
    histData.max      = max;
    histData.total    = values.length;
  }

  function drawHistogram(canvas, histData, chartH, hoverBinI = null) {
    const { def, BINS } = histData;
    buildHistBins(histData);
    const { bins, min, max } = histData;
    if (!bins) return;

    const dpr  = window.devicePixelRatio || 1;
    const W    = HIST_W;
    const H    = chartH;
    canvas.width  = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width  = W + 'px';
    canvas.style.height = H + 'px';

    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);

    const hasSel = selAnchorVal != null && selEndVal != null;
    const peak   = Math.max(...bins);

    // Measure label width so bars start right after them
    const fmt    = v => (max - min < 10 ? v.toFixed(1) : v.toFixed(0));
    ctx.font     = '9px system-ui, sans-serif';
    const labelW = Math.ceil(Math.max(
      ctx.measureText(`${fmt(max)} ${def.unit}`).width,
      ctx.measureText(`${fmt(min)} ${def.unit}`).width
    ));
    const pad    = { t: 6, r: 4, b: 6, l: labelW + 6 };
    histData.padL = pad.l;
    const plotW  = W - pad.l - pad.r;
    const plotH  = H - pad.t - pad.b;

    // Compute selection bins if a range is active
    let selBins = null;
    if (hasSel) {
      selBins = new Array(BINS).fill(0);
      const selBinAccum = new Array(BINS).fill(0);
      const { yData, xData } = histData;
      const span = max - min || 1;
      for (let i = 0; i < yData.length; i++) {
        const v = yData[i];
        if (v == null || !isFinite(v)) continue;
        const x = xData[i];
        if (x == null || x < selAnchorVal || x > selEndVal) continue;
        const bi = Math.min(BINS - 1, Math.floor(((v - min) / span) * BINS));
        selBins[bi]++;
        const prev = i > 0 && xData[i - 1] != null ? xData[i - 1] : xData[i];
        const next = i < xData.length - 1 && xData[i + 1] != null ? xData[i + 1] : xData[i];
        selBinAccum[bi] += (next - prev) / 2;
      }
      histData.selBins     = selBins;
      histData.selBinAccum = selBinAccum;
    } else {
      histData.selBins     = null;
      histData.selBinAccum = null;
    }

    // bin 0 = lowest values → drawn at bottom; bin BINS-1 = highest → drawn at top
    const binY = i => pad.t + (BINS - 1 - i) * (plotH / BINS);
    const binH = plotH / BINS - 1;

    // Full distribution (dimmed when selection active)
    for (let i = 0; i < BINS; i++) {
      if (!bins[i]) continue;
      const bw    = (bins[i] / peak) * plotW;
      const alpha = hasSel ? 0.15 : (0.3 + 0.6 * (bins[i] / peak));
      ctx.fillStyle = hexToRgba(def.color, alpha);
      ctx.fillRect(pad.l, binY(i), bw, binH);
    }

    // Selection overlay (bright)
    if (selBins) {
      for (let i = 0; i < BINS; i++) {
        if (!selBins[i]) continue;
        const bw = (selBins[i] / peak) * plotW;
        ctx.fillStyle = hexToRgba(def.color, 0.85);
        ctx.fillRect(pad.l, binY(i), bw, binH);
      }
      ctx.fillStyle = def.color;
      ctx.fillRect(pad.l, pad.t, 2, plotH);
    }

    // CDF overlay — smooth curve from bottom (0%) to top (100%)
    const total = bins.reduce((s, v) => s + v, 0);
    if (total > 0) {
      // Build CDF points: one per bin boundary, bottom→top
      const pts2 = [{ x: pad.l, y: pad.t + plotH }];
      let cumSum = 0;
      for (let i = 0; i < BINS; i++) {
        cumSum += bins[i];
        pts2.push({ x: pad.l + (cumSum / total) * plotW, y: binY(i) });
      }

      ctx.beginPath();
      ctx.setLineDash([2 * dpr, 3 * dpr]);
      ctx.strokeStyle = def.color;
      ctx.lineWidth   = 0.75 * dpr;
      ctx.lineJoin    = 'round';
      ctx.moveTo(pts2[0].x, pts2[0].y);
      for (let i = 1; i < pts2.length - 1; i++) {
        const mx = (pts2[i].x + pts2[i + 1].x) / 2;
        const my = (pts2[i].y + pts2[i + 1].y) / 2;
        ctx.quadraticCurveTo(pts2[i].x, pts2[i].y, mx, my);
      }
      ctx.lineTo(pts2[pts2.length - 1].x, pts2[pts2.length - 1].y);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Axis labels: max at top, min at bottom
    ctx.fillStyle    = '#888896';
    ctx.font         = '9px system-ui, sans-serif';
    ctx.textAlign    = 'right';
    ctx.textBaseline = 'top';
    ctx.fillText(`${fmt(max)} ${def.unit}`, pad.l - 4, pad.t);
    ctx.textBaseline = 'bottom';
    ctx.fillText(`${fmt(min)} ${def.unit}`, pad.l - 4, H - pad.b);
  }

  function redrawHistograms() {
    if (!statsVisible) return;
    plots.forEach(({ histCanvas, histData, uplot: u }) => {
      if (histCanvas && histData) drawHistogram(histCanvas, histData, u.height);
    });
  }

  function attachHistTooltip(canvas, histData) {
    let lastBinI  = null;
    const lineEl  = document.getElementById('hist-line');

    const hide = () => {
      if (histTooltipEl) histTooltipEl.style.display = 'none';
      if (lineEl) lineEl.style.display = 'none';
      if (lastBinI !== null) {
        lastBinI = null;
        drawHistogram(canvas, histData, canvas.height / (window.devicePixelRatio || 1));
      }
    };

    canvas.addEventListener('mousemove', e => {
      if (!histTooltipEl) return;
      const { bins, binAccum, min, max, BINS, def } = histData;
      if (!bins) return;

      const rect  = canvas.getBoundingClientRect();
      const relY  = e.clientY - rect.top;
      const pad   = { t: 6, b: 6 };
      const plotH = rect.height - pad.t - pad.b;
      // bins are drawn bottom-to-top: row 0 of canvas = highest bin
      const rawI  = Math.floor(((relY - pad.t) / plotH) * BINS);
      const binI  = BINS - 1 - rawI;

      if (rawI < 0 || rawI >= BINS) { hide(); return; }

      if (binI !== lastBinI) {
        lastBinI = binI;
        drawHistogram(canvas, histData, canvas.height / (window.devicePixelRatio || 1), binI);
      }

      const span   = max - min || 1;
      const binMin = min + (binI / BINS) * span;
      const binMax = min + ((binI + 1) / BINS) * span;
      const fmt    = v => (max - min < 10 ? v.toFixed(1) : v.toFixed(0));
      const fmtAccum = v => xAxis === 'time' ? fmtSecs(Math.round(v)) : `${v.toFixed(2)} km`;
      const label  = xAxis === 'time' ? 'Duration' : 'Dist';

      const { selBins, selBinAccum } = histData;
      const hasSel = selBins != null;

      const totalAccum = binAccum ? fmtAccum(binAccum[binI]) : null;
      const selAccum   = hasSel && selBinAccum ? fmtAccum(selBinAccum[binI]) : null;

      let html = `<span style="color:${def.color};font-weight:600">${fmt(binMin)}–${fmt(binMax)} ${def.unit}</span>`;
      if (hasSel) {
        html += `<br><span style="color:var(--text-muted);font-size:10px">Total &nbsp;</span><span style="color:var(--text)">${totalAccum ?? '—'}</span>`;
        html += `<br><span style="color:var(--accent);font-size:10px">Sel &nbsp;&nbsp;&nbsp;</span><span style="color:var(--accent)">${selAccum ?? '—'}</span>`;
      } else if (totalAccum) {
        html += `<br><span style="color:var(--text-muted)">${label}: ${totalAccum}</span>`;
      }
      histTooltipEl.innerHTML = html;

      // Position tooltip: fixed X left of canvas, Y centered on bin
      histTooltipEl.style.display = 'block';
      const ttH   = histTooltipEl.offsetHeight;
      const ttW   = histTooltipEl.offsetWidth;
      // binY(i) = pad.t + (BINS-1-i) * (plotH/BINS), centre = + 0.5*(plotH/BINS)
      const binCY = rect.top + pad.t + (BINS - 1 - binI + 0.5) * (plotH / BINS);
      const ttLeft = rect.left - ttW - 10;
      const ttTop  = Math.round(binCY - ttH / 2);
      histTooltipEl.style.left = `${ttLeft}px`;
      histTooltipEl.style.top  = `${ttTop}px`;

      // Dotted line: tooltip right edge → left edge of bars (through axes area)
      if (lineEl) {
        const lineY    = Math.round(binCY);
        const lineLeft = ttLeft + ttW;
        const barLeft  = rect.left + (histData.padL || 0);
        const lineW    = barLeft - lineLeft;
        lineEl.style.display = 'block';
        lineEl.style.left    = `${lineLeft}px`;
        lineEl.style.top     = `${lineY}px`;
        lineEl.style.width   = `${Math.max(0, lineW)}px`;
        lineEl.style.borderTopColor = hexToRgba(def.color, 0.5);
      }
    });

    canvas.addEventListener('mouseleave', hide);
  }

  function getIsDragging() {
    return isDragging;
  }

  return {
    init, loadTrack, clear,
    toggleMetric, setXAxis, toggleStats,
    resetZoom, cancelSelection,
    setSelectionStats, clearSelectionStats,
    restoreSelection,
    setCursorAt, clearPinnedDot,
    resize, METRICS,
    isDragging: getIsDragging,
    setMapColorChangeCb, toggleMapColor,
  };

})();
