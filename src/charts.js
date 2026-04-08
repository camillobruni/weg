'use strict';
/* global uPlot */

// ── Chart View (uPlot) ──────────────────────────────────────────────

import uPlot from 'uplot';

export const ChartView = (() => {

  // ── Metric definitions ─────────────────────────────────────────
  const METRICS = {
    elevation:   { abbr: 'ele',  label: 'Elevation',   icon: 'height',    unit: 'm',    color: '#4ECDC4', field: 'ele',      fmt: (v, s) => s ? `${v.toFixed(0)}` : `${v.toFixed(0)} m`,     fmtAxis: v => v.toFixed(0),  transform: null },
    speed:       { abbr: 'spd',  label: 'Speed',       icon: 'speed',     unit: 'km/h', color: '#45B7D1', field: 'speed',    fmt: (v, s) => s ? `${v.toFixed(1)}` : `${v.toFixed(1)} km/h`,  fmtAxis: v => v.toFixed(1),  transform: v => v * 3.6 },
    gradient:    { abbr: 'grad', label: 'Gradient',    icon: 'trending_up', unit: '%',    color: '#A8C8A0', field: 'gradient', fmt: (v, s) => s ? `${v.toFixed(1)}` : `${v.toFixed(1)} %`,     fmtAxis: v => `${v.toFixed(0)}%`, transform: null, compute: (pts, fill) => fill(smoothGradient(pts, 20)) },
    power:       { abbr: 'pwr',  label: 'Power',       icon: 'bolt',      unit: 'W',    color: '#F7DC6F', field: 'power',    fmt: (v, s) => s ? `${v.toFixed(0)}` : `${v.toFixed(0)} W`,     fmtAxis: v => v.toFixed(0),  transform: null },
    hr:          { abbr: 'hr',   label: 'Heart Rate',  icon: 'favorite',  unit: 'bpm',  color: '#FF6B6B', field: 'hr',       fmt: (v, s) => s ? `${v.toFixed(0)}` : `${v.toFixed(0)} bpm`,   fmtAxis: v => v.toFixed(0),  transform: null },
    cadence:     { abbr: 'cad',  label: 'Cadence',     icon: 'directions_run', unit: 'rpm',  color: '#BB8FCE', field: 'cad',      fmt: (v, s) => s ? `${v.toFixed(0)}` : `${v.toFixed(0)} rpm`,   fmtAxis: v => v.toFixed(0),  transform: null },
    temperature: { abbr: 'temp', label: 'Temperature', icon: 'thermostat', unit: '°C',   color: '#F8C471', field: 'temp',     fmt: (v, s) => s ? `${v.toFixed(1)}` : `${v.toFixed(1)} °C`,    fmtAxis: v => v.toFixed(1),  transform: null },
  };

  // ── State ──────────────────────────────────────────────────────
  let plots        = [];
  let syncKey      = null;
  let scaleSyncing = false;
  let activeMetrics = new Set(['elevation','speed']);
  let availableMetrics = new Set();
  let xAxis        = 'time';
  let currentTrack = null;

  // Selection / anchor
  let selAnchorVal  = null;   // x-value at drag-start / zoom left edge
  let selEndVal     = null;   // x-value at zoom right edge
  let isDragging    = false;
  let updatingRange = false;  // guard against setScale hook re-entry during handle drag
  let pinnedPtIdx   = null;   // point index pinned by map click
  let lastMouseXVal = null;   // last hovered x-value for keyboard zoom center
  
  let currentXRange = null;   // [min, max] currently rendered
  let targetXRange  = null;   // [min, max] for smooth keyboard animation
  let animId        = null;

  // Callbacks
  let onCursorMoveCb  = null;
  let onRangeChangeCb = null;
  let onClickCb       = null;

  const HIST_W      = 130;
  const ROW_BODY_PADDING = 28; // 14px left + 14px right
  const HIST_GAP     = 20; // margin-left on .hist-col
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

    // ── WASD Keyboard Navigation ──
    const navKeys = new Set(['w', 'a', 's', 'd']);
    const activeNavKeys = new Set();

    document.addEventListener('keydown', e => {
      if (!plots.length || !currentTrack) return;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return;

      const key = e.key.toLowerCase();
      if (!navKeys.has(key)) return;

      e.preventDefault();
      activeNavKeys.add(key);
      
      const u = plots[0].uplot;
      if (!targetXRange) {
        targetXRange = [u.scales.x.min, u.scales.x.max];
      }

      let [min, max] = targetXRange;
      const span = max - min;
      const moveStep = span * 0.1;
      const zoomFactor = 0.15;

      let newMin = min, newMax = max;

      if (key === 'a') { // Pan left
        newMin = min - moveStep;
        newMax = max - moveStep;
      } else if (key === 'd') { // Pan right
        newMin = min + moveStep;
        newMax = max + moveStep;
      } else if (key === 'w' || key === 's') { // Zoom
        const center = lastMouseXVal !== null ? lastMouseXVal : (min + max) / 2;
        const factor = key === 'w' ? (1 - zoomFactor) : (1 + (zoomFactor * 1.2));
        newMin = center - (center - min) * factor;
        newMax = center + (max - center) * factor;
      }

      // Clamp to track bounds
      const xFull = [plots[0].xData[0], plots[0].xData[plots[0].xData.length - 1]];
      if (newMin < xFull[0]) {
        const d = xFull[0] - newMin;
        newMin += d; newMax += d;
      }
      if (newMax > xFull[1]) {
        const d = newMax - xFull[1];
        newMin -= d; newMax -= d;
      }
      newMin = Math.max(xFull[0], newMin);
      newMax = Math.min(xFull[1], newMax);

      if (newMax - newMin > 0.001) {
        targetXRange = [newMin, newMax];
        setVisibleRange(newMin, newMax, true); // true = animate
      }
    });

    document.addEventListener('keyup', e => {
      const key = e.key.toLowerCase();
      if (navKeys.has(key)) {
        activeNavKeys.delete(key);
      }
    });
  }

  // ── Public API ────────────────────────────────────────────────
  function loadTrack(track) {
    pinnedPtIdx = null;
    
    // Detect which metrics are available in this file
    availableMetrics = new Set(
      Object.entries(METRICS)
        .filter(([, def]) => track.points.some(p => p[def.field] != null))
        .map(([key]) => key)
    );

    // If no metrics are active (e.g. first load), default to everything available
    // but skip gradient by default.
    if (activeMetrics.size === 0) {
      activeMetrics = new Set(availableMetrics);
      activeMetrics.delete('gradient');
    } else {
      // Filter existing active metrics by what's actually available in this track
      // (We don't delete them from the Set so they can come back if you switch to a track that has them)
    }

    // Sync the pill buttons in the toolbar
    document.querySelectorAll('.metric-pill').forEach(pill => {
      const metric = pill.dataset.metric;
      const isAvailable = availableMetrics.has(metric);
      pill.classList.toggle('active', isAvailable && activeMetrics.has(metric));
      pill.classList.toggle('disabled', !isAvailable);
    });

    currentTrack = track;
    render();
  }

  function clear() {
    pinnedPtIdx  = null;
    currentTrack = null;
    destroyPlots();
    if (emptyEl) { 
      emptyEl.style.display = 'flex'; 
      emptyEl.innerHTML = `
        <span class="material-symbols-rounded empty-icon">no_sim</span>
        <div class="empty-text">Select a track to view analysis</div>
      `;
    }
    document.getElementById('chart-stats').classList.add('hidden');
    clearSelectionStats();
    mapColorMetric = null;
    if (onMapColorChangeCb) onMapColorChangeCb(null);
  }

  function toggleMetric(key) {
    if (activeMetrics.has(key)) activeMetrics.delete(key);
    else                        activeMetrics.add(key);
    if (currentTrack) render(true);
  }

  function setActiveMetrics(keys) {
    activeMetrics = new Set(keys);
    if (currentTrack) render(true);
    // Sync the pill buttons
    document.querySelectorAll('.metric-pill').forEach(pill => {
      pill.classList.toggle('active', activeMetrics.has(pill.dataset.metric));
    });
  }

  function setXAxis(axis) { xAxis = axis; if (currentTrack) render(true); }

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
    cancelSelection();
  }

  function cancelSelection() {
    selAnchorVal = null;
    selEndVal    = null;
    pinnedPtIdx  = null;
    
    // Reset individual histogram pins
    plots.forEach(p => { p.pinnedHistY = null; });

    updateSelOverlay();
    redrawHistograms();
    
    // Perform the actual zoom reset
    plots.forEach(({ uplot: u, xData }) => {
      u.setScale('x', { min: xData[0], max: xData[xData.length-1] });
      u._strasse?.updateHeaderStats(xData[0], xData[xData.length-1]);
    });

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
    const w = Math.max(100, container.clientWidth - ROW_BODY_PADDING - (statsVisible ? HIST_W + HIST_GAP : 0));
    plots.forEach(({ uplot: u, histCanvas, histData }) => {
      u.setSize({ width: w, height: u.height });
      if (statsVisible && histCanvas && histData) drawHistogram(histCanvas, histData, u.height);
    });
    updateSelOverlay();
  }

  // ── Render ────────────────────────────────────────────────────
  function render(keepState = false) {
    let savedRange = null;
    if (keepState && plots.length) {
      const u = plots[0].uplot;
      savedRange = [u.scales.x.min, u.scales.x.max];
    }

    destroyPlots(keepState);
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
      if (emptyEl) { 
        emptyEl.style.display = 'flex'; 
        emptyEl.innerHTML = `
          <span class="material-symbols-rounded empty-icon">no_sim</span>
          <div class="empty-text">No data for selected metrics</div>
        `;
      }
      return;
    }
    if (emptyEl) emptyEl.style.display = 'none';

    const w = Math.max(100, container.clientWidth - ROW_BODY_PADDING - (statsVisible ? HIST_W + HIST_GAP : 0));
    available.forEach(key => {
      const def   = METRICS[key];
      const yData = def.compute
        ? def.compute(pts, fillNulls)
        : fillNulls(pts.map(p => { const v = p[def.field]; return (v != null && def.transform) ? def.transform(v) : v; }));
      createChart(key, def, xData, yData, w, pts);
    });

    // Restore zoom if saved
    if (savedRange) {
      scaleSyncing = true;
      plots.forEach(({ uplot: u }) => {
        u.setScale('x', { min: savedRange[0], max: savedRange[1] });
      });
      scaleSyncing = false;
    }

    updateStats(currentTrack);
    // Restore anchor/end lines if a selection was active
    requestAnimationFrame(() => {
      updateSelOverlay();
    });
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
    
    const labelEl  = document.createElement('div');
    labelEl.className = 'chart-row-label-group';
    labelEl.innerHTML = `
      <span class="material-symbols-rounded chart-row-icon">${def.icon}</span>
      <span class="chart-row-label">${def.label}</span>
    `;
    
    const mapColorBtn = document.createElement('button');
    mapColorBtn.className = 'map-color-btn icon-btn' + (mapColorMetric === metricKey ? ' active' : '');
    mapColorBtn.dataset.metric = metricKey;
    mapColorBtn.title = 'Color map track by this metric';
    mapColorBtn.innerHTML = '<span class="material-symbols-rounded">colorize</span>';
    mapColorBtn.addEventListener('click', () => toggleMapColor(metricKey));

    const statsTotalEl = document.createElement('div');
    statsTotalEl.className = 'chart-stats-total';
    
    const statsSelEl = document.createElement('div');
    statsSelEl.className = 'chart-stats-selection';

    const statsContainer = document.createElement('div');
    statsContainer.className = 'chart-row-stats-container';
    statsContainer.append(statsTotalEl, statsSelEl);

    header.append(labelEl, mapColorBtn, statsContainer);

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

    // Compute global Y range once to keep axis stable during zoom/pan
    const yVals = yData.filter(v => v != null && isFinite(v));
    const gMin  = yVals.length ? Math.min(...yVals) : 0;
    const gMax  = yVals.length ? Math.max(...yVals) : 100;
    const gPad  = (gMax - gMin) * 0.1 || 1;
    const fixedYRange = [gMin - gPad, gMax + gPad];

    // Per-range stats
    function updateHeaderStats(visibleMin, visibleMax) {
      const getHtml = (xMin, xMax, isSel = false) => {
        const s = rangeStats(xData, yData, xMin, xMax);
        if (!s) return '';

        let h = `
          <span class="mm-item"><span class="material-symbols-rounded mm-icon">arrow_downward</span><span class="mm-l">min</span>${def.fmt(s.min, true)}&nbsp;${def.unit}</span>
          <span class="mm-item"><span class="material-symbols-rounded mm-icon">horizontal_rule</span><span class="mm-l">avg</span>${def.fmt(s.avg, true)}&nbsp;${def.unit}</span>
          <span class="mm-item"><span class="material-symbols-rounded mm-icon">arrow_upward</span><span class="mm-l">max</span>${def.fmt(s.max, true)}&nbsp;${def.unit}</span>
        `;

        if (metricKey === 'elevation') {
          const es = elevationRangeStats(pts, xMin, xMax);
          h += `
            <span class="mm-item"><span class="material-symbols-rounded mm-icon">trending_up</span><span class="mm-l">gain</span>+${Math.round(es.gain)}&nbsp;m</span>
            <span class="mm-item"><span class="material-symbols-rounded mm-icon">trending_down</span><span class="mm-l">loss</span>-${Math.round(es.loss)}&nbsp;m</span>
          `;
        }
        return h;
      };

      statsTotalEl.innerHTML = getHtml(visibleMin, visibleMax);

      if (selAnchorVal !== null && selEndVal !== null) {
        statsSelEl.innerHTML = `<span class="sel-tag">SEL</span>` + getHtml(selAnchorVal, selEndVal, true);
        statsSelEl.style.display = 'flex';
      } else {
        statsSelEl.style.display = 'none';
      }
    }
    updateHeaderStats(xData[0], xData[xData.length - 1]);

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
        x: false, y: false,
      },
      select: { show: true },
      legend: { show: false },
      scales: {
        x: { time: false, range: (_u, mn, mx) => [mn, mx] },
        y: { range: () => fixedYRange },
      },
      axes: [
        {
          stroke: '#555564', grid: { stroke: '#2e2e34', width: 1 }, ticks: { stroke: '#2e2e34' },
          size: 30, font: '10px system-ui', color: '#555564',
          values: isDistAxis
            ? (_u, vals) => {
                const range = _u.scales.x.max - _u.scales.x.min;
                const dec = range < 1 ? 3 : (range < 5 ? 2 : (range < 20 ? 1 : 0));
                return vals.map(v => v != null ? `${v.toFixed(dec)} km` : '');
              }
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
        (metricKey === 'elevation' || metricKey === 'gradient' || mapColorMetric === metricKey)
          // Invisible — we draw manually in the draw hook
          ? { label: def.label, stroke: 'rgba(0,0,0,0)', fill: 'rgba(0,0,0,0)', width: 0, points: { show: false } }
          : { label: def.label, stroke: def.color, fill: hexToRgba(def.color, 0.08), width: 1.5, points: { show: false } },
      ],
      hooks: {
        draw: [
          ...(metricKey === 'elevation' ? [u => drawElevationGradient(u, xData, yData, gradData)] : []),
          ...(metricKey === 'gradient'  ? [u => drawGradientChart(u, xData, yData)] : []),
          // Metric coloring sync: if this metric is coloring the map, fill the graph with it too
          u => {
            if (mapColorMetric === metricKey && metricKey !== 'elevation' && metricKey !== 'gradient') {
              drawMetricColorFill(u, xData, yData, pts, metricKey);
            }
          },
          u => drawHoverLine(u, yData, def.color, pts),
          u => {
            const plot = plots.find(p => p.uplot === u);
            if (!plot) return;

            // Priority 1: Global pinned point (all charts)
            if (pinnedPtIdx != null) {
              drawPinnedDot(u, xData, yData, def.color, def, pts);
            } 
            // Priority 2: Individual histogram pinned Y-pos (this chart only)
            else if (plot.pinnedHistY != null) {
              drawYAxisHighlight(u, xData, yData, plot.pinnedHistY, def.color, def);
            }
            // Priority 3: Individual histogram hovered Y-pos (this chart only)
            else if (plot.hoveredHistY != null) {
              drawYAxisHighlight(u, xData, yData, plot.hoveredHistY, def.color, def);
            }
          },
          u => {
            const hIdx = u.cursor.idx;
            const hasPinned = pinnedPtIdx != null;
            const hasHover  = hIdx != null && u.cursor.left >= 0;

            // 1. Draw vertical lines (drawn first, underneath labels)
            if (hasPinned) {
              drawVerticalLineOnly(u, pts, pinnedPtIdx, def.color);
            }
            if (hasHover && hIdx !== pinnedPtIdx) {
              drawVerticalLineOnly(u, pts, hIdx, 'rgba(255,255,255,0.4)');
            }

            // ── Bold selection x-axis line ──
            if (selAnchorVal != null && selEndVal != null) {
              const ctx = u.ctx;
              const dpr = window.devicePixelRatio || 1;
              const bb  = u.bbox;
              const ax  = u.valToPos(selAnchorVal, 'x', true);
              const ex  = u.valToPos(selEndVal,    'x', true);
              
              ctx.save();
              ctx.beginPath();
              ctx.lineWidth = 3 * dpr;
              ctx.strokeStyle = def.color;
              ctx.moveTo(ax, bb.top + bb.height);
              ctx.lineTo(ex, bb.top + bb.height);
              ctx.stroke();

              // Selection span label (centered pill, sticky)
              const span = Math.abs(selEndVal - selAnchorVal);
              const label = xAxis === 'distance' ? `${span.toFixed(2)} km` : fmtSecs(span);
              const fontSize = 9 * dpr;
              ctx.font = `bold ${fontSize}px system-ui, sans-serif`;
              const tw = ctx.measureText(label).width;
              
              // Sticky logic: find the visible start/end of the selection
              const visibleL = Math.max(bb.left, ax);
              const visibleR = Math.min(bb.left + bb.width, ex);
              const visibleW = visibleR - visibleL;

              // Only draw if the visible part of the selection is wide enough for the pill
              if (visibleW > tw + 14 * dpr) {
                const padH = 5 * dpr;
                const padV = 2 * dpr;
                const bw = tw + padH * 2;
                const bh = fontSize + padV * 2;
                
                // Center the pill within the VISIBLE portion of the selection
                const bx = (visibleL + visibleR) / 2 - bw / 2;
                const by = bb.top + bb.height - bh / 2;

                ctx.beginPath();
                if (ctx.roundRect) ctx.roundRect(bx, by, bw, bh, 3 * dpr);
                else ctx.rect(bx, by, bw, bh);
                ctx.fillStyle = def.color;
                ctx.fill();

                ctx.fillStyle = '#000';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(label, bx + bw / 2, by + bh / 2);
              }
              ctx.restore();
            }

            // 2. Draw label pills (on top)
            if (hasPinned) {
              drawXAxisLabels(u, pts, pinnedPtIdx, def.color, true); // true = skipLine
            }
            if (hasHover && hIdx !== pinnedPtIdx) {
              drawXAxisLabels(u, pts, hIdx, '#888896', true); // true = skipLine
            }
          }
        ],
        setCursor: [u => {
          const idx = u.cursor.idx;
          
          // Track current x-value for keyboard navigation
          if (u.cursor.left >= 0) {
            lastMouseXVal = u.posToVal(u.cursor.left, 'x');
          } else {
            lastMouseXVal = null;
          }

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

          // ── Histogram bucket highlight on chart hover ──
          if (statsVisible) {
            plots.forEach(p => {
              if (!p.histCanvas || !p.histData) return;
              const { yData, histData } = p;
              const val = idx != null ? yData[idx] : null;
              let binI = null;
              if (val != null && isFinite(val) && histData.bins) {
                const { min, max, BINS } = histData;
                const span = max - min || 1;
                binI = Math.min(BINS - 1, Math.floor(((val - min) / span) * BINS));
              }
              // Only redraw if bin changed or cursor left/entered
              if (p._lastHoverBin !== binI) {
                p._lastHoverBin = binI;
                drawHistogram(p.histCanvas, histData, p.uplot.height, binI);
              }
            });
          }

          u.redraw(false);
        }],

        setScale: [(u, key) => {
          if (key !== 'x') return;
          const { min, max } = u.scales.x;

          // Sync currentXRange so keyboard navigation baseline is always accurate
          currentXRange = [min, max];

          // Clear keyboard target when user interacts via mouse
          if (!updatingRange && !scaleSyncing) {
            targetXRange = null;
          }

          // Sync sibling plots
          if (!scaleSyncing) {
            scaleSyncing = true;
            plots.forEach(({ uplot: other }) => { if (other !== u) other.setScale('x', { min, max }); });
            scaleSyncing = false;
          }

          // Update stats based on selection if present, else visible range
          const sMin = selAnchorVal !== null ? selAnchorVal : min;
          const sMax = selEndVal !== null ? selEndVal : max;
          updateHeaderStats(min, max);

          updateSelOverlay();
          redrawHistograms();
          
          if (onRangeChangeCb) {
            if (selAnchorVal !== null) onRangeChangeCb(selAnchorVal, selEndVal, xAxis);
            else onRangeChangeCb(min, max, xAxis);
          }
        }],

        setSelect: [u => {
          if (updatingRange) return;
          targetXRange = null;
          const { left, width } = u.select;
          if (width > 0) {
            const min = u.posToVal(left, 'x');
            const max = u.posToVal(left + width, 'x');
            selAnchorVal = min;
            selEndVal    = max;
            
            // Sync stats to new selection
            updateHeaderStats(u.scales.x.min, u.scales.x.max);
            updateSelOverlay();
            redrawHistograms();
            
            if (onRangeChangeCb) onRangeChangeCb(selAnchorVal, selEndVal, xAxis);
            
            // Clear uPlot's internal selection immediately so it doesn't block WASD/interaction
            u.setSelect({ left: 0, width: 0 }, false);
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
    anchorMarker.innerHTML = '<span class="material-symbols-rounded" style="font-size:16px; font-variation-settings:\'FILL\' 1">play_circle</span>';
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
    endMarker.innerHTML = '<span class="material-symbols-rounded" style="font-size:16px; font-variation-settings:\'FILL\' 1">stop_circle</span>';
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
      curYVal, updateHeaderStats
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
    const plot = { uplot, row, xData, yData, def, metricKey, statsTotalEl, statsSelEl, histCol, histCanvas, histData, hoveredHistY: null, pinnedHistY: null };
    histData.plot = plot; // Back-reference for tooltip to trigger redraws

    drawHistogram(histCanvas, histData, 130);
    attachHistTooltip(histCanvas, histData);

    plots.push(plot);
  }

  // ── Selection overlay (fill + lines + handles) ───────────────
  function updateSelOverlay() {
    updateAnchorLines();
    // Redraw canvas markers (bold selection line + span pill)
    plots.forEach(({ uplot: u }) => u.redraw(false));
  }

  function updateAnchorLines() {
    plots.forEach(({ uplot: u, def }) => {
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
      const dpr   = window.devicePixelRatio || 1;
      const bb    = u.bbox;
      const plotBottom = (bb.top + bb.height) / dpr;

      const isAnchorVisible = aX >= 0 && aX <= overW;
      const isEndVisible    = eX >= 0 && eX <= overW;

      // Fill: clamp left/right to visible area
      const fillL = Math.max(0, aX);
      const fillR = Math.min(overW, eX);
      if (fillR > fillL) {
        selFill.style.left    = `${fillL}px`;
        selFill.style.width   = `${fillR - fillL}px`;
        selFill.style.top     = '0';
        selFill.style.height  = `${overH}px`;
        selFill.style.backgroundColor = hexToRgba(def.color, 0.07);
        selFill.style.display = '';
      } else {
        selFill.style.display = 'none';
      }

      // Anchor line
      if (isAnchorVisible) {
        anchorLine.style.left    = `${aX}px`;
        anchorLine.style.height  = `${overH}px`;
        anchorLine.style.borderLeftColor = def.color;
        anchorLine.style.display = '';
        // Anchor label
        const aText = fmtXVal(selAnchorVal);
        anchorLabel.textContent  = aText;
        const aLabelW = aText.length * 7 + 10;
        anchorLabel.style.left   = aX + aLabelW + 4 < overW ? `${aX + 3}px` : `${aX - aLabelW - 3}px`;
        anchorLabel.style.display = '';
        // Anchor handle
        anchorHandle.style.left  = `${aX}px`;
        anchorHandle.style.backgroundColor = def.color;
        anchorHandle.style.display = '';
        // Anchor marker: centered on the bold line
        anchorMarker.style.left = `${aX}px`;
        anchorMarker.style.top = `${plotBottom}px`;
        const aIcon = anchorMarker.querySelector('.material-symbols-rounded');
        if (aIcon) aIcon.style.color = def.color;
        anchorMarker.style.display = '';
      } else {
        [anchorLine, anchorLabel, anchorHandle, anchorMarker].forEach(el => el.style.display = 'none');
      }

      // End line
      if (isEndVisible) {
        endLine.style.left    = `${eX}px`;
        endLine.style.height  = `${overH}px`;
        endLine.style.borderLeftColor = def.color;
        endLine.style.display = '';
        // End label
        const eText = fmtXVal(selEndVal);
        endLabel.textContent  = eText;
        const eLabelW = eText.length * 7 + 10;
        endLabel.style.left   = eX - eLabelW - 3 > 0 ? `${eX - eLabelW - 3}px` : `${eX + 3}px`;
        endLabel.style.display = '';
        // End handle
        endHandle.style.left  = `${eX}px`;
        endHandle.style.backgroundColor = def.color;
        endHandle.style.display = '';
        // End marker: centered on the bold line
        endMarker.style.left = `${eX}px`;
        endMarker.style.top = `${plotBottom}px`;
        const eIcon = endMarker.querySelector('.material-symbols-rounded');
        if (eIcon) eIcon.style.color = def.color;
        endMarker.style.display = '';
      } else {
        [endLine, endLabel, endHandle, endMarker].forEach(el => el.style.display = 'none');
      }
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
        
        // When dragging handles, we typically want to stay zoomed to the selection?
        // Actually, let's keep the zoom as is, and just update the selection overlay and stats.
        plots.forEach(p => p.uplot._strasse?.updateHeaderStats(p.uplot.scales.x.min, p.uplot.scales.x.max));
        updateSelOverlay();
        redrawHistograms();
        if (onRangeChangeCb) onRangeChangeCb(selAnchorVal, selEndVal, xAxis);
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

  // Apply a visible range (zoom) to all plots + trigger callbacks
  // Apply a visible range (zoom) to all plots + trigger callbacks
  function setVisibleRange(xMin, xMax, animate = false) {
    targetXRange = [xMin, xMax];
    
    if (!animate) {
      if (animId) cancelAnimationFrame(animId);
      animId = null;
      currentXRange = [xMin, xMax];
      _applyRangeInternal(xMin, xMax);
      return;
    }

    if (animId) return; // Loop already running

    const step = () => {
      if (!targetXRange || !currentXRange) { animId = null; return; }
      const [tMin, tMax] = targetXRange;
      const [cMin, cMax] = currentXRange;
      
      const dMin = tMin - cMin;
      const dMax = tMax - cMax;
      
      // Stop if close enough
      if (Math.abs(dMin) < 0.00001 && Math.abs(dMax) < 0.00001) {
        currentXRange = [tMin, tMax];
        _applyRangeInternal(tMin, tMax);
        animId = null;
        return;
      }
      
      // Move towards target
      const factor = 0.25;
      const nextMin = cMin + dMin * factor;
      const nextMax = cMax + dMax * factor;
      
      currentXRange = [nextMin, nextMax];
      _applyRangeInternal(nextMin, nextMax);
      animId = requestAnimationFrame(step);
    };

    if (!currentXRange && plots.length) {
      const u = plots[0].uplot;
      currentXRange = [u.scales.x.min, u.scales.x.max];
    }
    animId = requestAnimationFrame(step);
  }

  function _applyRangeInternal(xMin, xMax) {
    updatingRange = true;
    scaleSyncing  = true;
    plots.forEach(({ uplot: u }) => u.setScale('x', { min: xMin, max: xMax }));
    scaleSyncing  = false;
    updatingRange = false;

    // Update each chart's min/max stats
    plots.forEach(p => p.uplot._strasse?.updateHeaderStats(xMin, xMax));

    updateSelOverlay();
    if (onRangeChangeCb) {
      if (selAnchorVal !== null) onRangeChangeCb(selAnchorVal, selEndVal, xAxis);
      else onRangeChangeCb(xMin, xMax, xAxis);
    }
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
  function destroyPlots(keepState = false) {
    if (histTooltipEl) histTooltipEl.style.display = 'none';
    plots.forEach(({ uplot: u, row }) => { syncKey.unsub(u); u.destroy(); row.remove(); });
    plots = [];
    if (!keepState) {
      selAnchorVal = null;
      selEndVal    = null;
    }
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

  function elevationRangeStats(pts, xMin, xMax) {
    let gain = 0, loss = 0;
    let prevEle = null;
    const isDist = xAxis === 'distance';
    const t0 = pts[0].time || 0;

    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const x = isDist ? (p.dist || 0) / 1000 : (p.time - t0) / 1000;
      if (x < xMin || x > xMax) continue;

      if (p.ele != null) {
        if (prevEle != null) {
          const diff = p.ele - prevEle;
          if (diff > 0) gain += diff;
          else if (diff < 0) loss += Math.abs(diff);
        }
        prevEle = p.ele;
      }
    }
    return { gain, loss };
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

  function drawVerticalLineOnly(u, pts, idx, color) {
    if (idx == null || !pts[idx]) return;
    const pt  = pts[idx];
    const bb  = u.bbox;
    const ctx = u.ctx;
    const dpr = window.devicePixelRatio || 1;
    const cx  = u.valToPos(xAxis === 'distance' ? (pt.dist || 0) / 1000 : (pt.time - pts[0].time) / 1000, 'x', true);

    // Skip if point is outside visible x-range
    if (cx < bb.left || cx > bb.left + bb.width) return;

    ctx.save();
    
    // Clip to chart area (horizontally) to avoid drawing over Y-axis
    ctx.beginPath();
    ctx.rect(bb.left, 0, bb.width, u.over.offsetHeight * dpr);
    ctx.clip();

    ctx.beginPath();
    ctx.setLineDash([4 * dpr, 4 * dpr]);
    ctx.strokeStyle = hexToRgba(color, 0.5);
    ctx.lineWidth = 1 * dpr;
    // Start below the top label area (approx 14px) and extend through bottom axis
    ctx.moveTo(cx, bb.top + 14 * dpr); 
    ctx.lineTo(cx, bb.top + bb.height + 25 * dpr); 
    ctx.stroke();
    
    ctx.restore();
  }

  function drawXAxisLabels(u, pts, idx, color, skipLine = false) {
    if (idx == null || !pts[idx]) return;
    const pt  = pts[idx];
    const bb  = u.bbox;
    const ctx = u.ctx;
    const dpr = window.devicePixelRatio || 1;
    const cx  = u.valToPos(xAxis === 'distance' ? (pt.dist || 0) / 1000 : (pt.time - pts[0].time) / 1000, 'x', true);

    // Skip if labels would be outside the chart area (left/right)
    if (cx < bb.left || cx > bb.left + bb.width) return;

    ctx.save();
    
    // ── Vertical line ──
    if (!skipLine) {
      drawVerticalLineOnly(u, pts, idx, color);
    }

    // ── Labels ──
    const fontSize = 9 * dpr;
    const axisColor = '#555564'; // Match uPlot axis label color
    ctx.font = `600 ${fontSize}px system-ui, sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';

    const t0 = pts[0].time || 0;
    const distStr = `${((pt.dist || 0) / 1000).toFixed(2)} km`;
    const timeStr = fmtSecs((pt.time - t0) / 1000);

    const bottomLabel = xAxis === 'distance' ? distStr : timeStr;
    const topLabel    = xAxis === 'distance' ? timeStr : distStr;

    const drawPill = (text, x, y, isTop) => {
      const tw = ctx.measureText(text).width;
      const padH = 4 * dpr;
      const padV = 2 * dpr;
      const bw = tw + padH * 2;
      const bh = fontSize + padV * 2;
      const rx = x - bw / 2;
      
      // Horizontal clamping for the pill itself so it doesn't bleed out of the chart horizontally
      const clampedRx = Math.max(bb.left, Math.min(bb.left + bb.width - bw, rx));
      const ry = y - bh / 2;

      ctx.save();
      ctx.setLineDash([]); // Ensure pills are not dashed
      ctx.beginPath();
      if (ctx.roundRect) {
        ctx.roundRect(clampedRx, ry, bw, bh, 3 * dpr);
      } else {
        ctx.rect(clampedRx, ry, bw, bh);
      }
      ctx.fillStyle = 'rgba(14,14,16,1.0)'; // Fully opaque to cover axis labels
      ctx.fill();
      ctx.strokeStyle = hexToRgba(axisColor, 0.6);
      ctx.stroke();
      ctx.fillStyle = axisColor;
      // Center text relative to the clamped pill
      ctx.fillText(text, clampedRx + bw / 2, ry + bh / 2);
      ctx.restore();
    };

    // Top label flush with chart top
    drawPill(topLabel, cx, bb.top + 7 * dpr, true);
    // Bottom label aligns with axis labels
    drawPill(bottomLabel, cx, bb.top + bb.height + 18 * dpr, false);

    ctx.restore();
  }

  function drawHoverLine(u, yData, color, pts) {
    const idx = u.cursor.idx;
    if (idx == null || yData[idx] == null || u.cursor.left < 0) return;

    const cy  = u.valToPos(yData[idx], 'y', true);
    const bb  = u.bbox;
    const ctx = u.ctx;
    const dpr = window.devicePixelRatio || 1;

    ctx.save();
    // ── Horizontal line ──
    ctx.setLineDash([5 * dpr, 5 * dpr]);
    ctx.strokeStyle = hexToRgba(color, 0.4);
    ctx.lineWidth = 1 * dpr;
    ctx.beginPath();
    ctx.moveTo(bb.left, cy);
    ctx.lineTo(bb.left + bb.width, cy);
    ctx.stroke();
    ctx.restore();
  }

  function drawPinnedDot(u, xData, yData, color, def, pts) {
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
    drawAreaFillAbove(u, xData, yData, cyClamp, color);

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
    const label    = def.fmt(yVal, false);
    const fontSize = 11 * dpr;
    ctx.font      = `600 ${fontSize}px system-ui, sans-serif`;
    const tw      = ctx.measureText(label).width;
    const pad     = 5 * dpr;
    const th      = fontSize + pad * 1.2;
    const bw      = tw + pad * 2.0;
    // Prefer right of dot; flip left if too close to edge
    const bx = cx + r + 6 * dpr + bw < bb.left + bb.width
      ? cx + r + 6 * dpr
      : cx - r - 6 * dpr - bw;
    const by = cyClamp - th - 4 * dpr; // Position above the dot

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
    ctx.fillStyle = 'rgba(14,14,16,0.92)';
    ctx.fill();
    ctx.strokeStyle = hexToRgba(color, 0.6);
    ctx.lineWidth   = 1 * dpr;
    ctx.stroke();

    // Text
    ctx.fillStyle    = color;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, bx + bw / 2, by + th / 2);

    ctx.restore();
  }

  function drawYAxisHighlight(u, xData, yData, yVal, color, def) {
    const bb  = u.bbox;
    const ctx = u.ctx;
    const dpr = window.devicePixelRatio || 1;
    const cy  = u.valToPos(yVal, 'y', true);

    // Clamp cy to bbox
    const cyClamp = Math.max(bb.top, Math.min(bb.top + bb.height, cy));

    ctx.save();

    // ── 1. Area fill ──
    drawAreaFillAbove(u, xData, yData, cyClamp, color);

    // ── 2. Dotted horizontal line ──
    ctx.beginPath();
    ctx.setLineDash([4 * dpr, 4 * dpr]);
    ctx.moveTo(bb.left, cyClamp);
    ctx.lineTo(bb.left + bb.width, cyClamp);
    ctx.strokeStyle = hexToRgba(color, 0.6);
    ctx.lineWidth   = 1.5 * dpr;
    ctx.stroke();
    ctx.setLineDash([]);

    // ── 3. Tooltip label (next to axis) ──
    const label    = def.fmt(yVal, false);
    const fontSize = 10 * dpr;
    ctx.font      = `600 ${fontSize}px system-ui, sans-serif`;
    const tw      = ctx.measureText(label).width;
    const pad     = 4 * dpr;
    const th      = fontSize + pad * 1.5;
    const bw      = tw + pad * 2.5;
    
    // Position on the left edge of the chart area
    const bx = bb.left + 4 * dpr;
    const by = cyClamp - th / 2;

    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(bx, by, bw, th, 3 * dpr);
    else ctx.rect(bx, by, bw, th);
    
    ctx.fillStyle = 'rgba(14,14,16,0.92)';
    ctx.fill();
    ctx.strokeStyle = hexToRgba(color, 0.6);
    ctx.stroke();

    ctx.fillStyle    = color;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, bx + bw / 2, by + th / 2);

    ctx.restore();
  }

  function drawAreaFillAbove(u, xData, yData, cyClamp, color) {
    const ctx = u.ctx;
    const rgba = hexToRgba(color, 0.3);
    ctx.beginPath();
    let inAbove = false;
    for (let i = 0; i < xData.length; i++) {
      if (xData[i] == null || yData[i] == null) { inAbove = false; continue; }
      const px = u.valToPos(xData[i], 'x', true);
      const py = u.valToPos(yData[i], 'y', true);
      if (py <= cyClamp) { // canvas y is inverted
        if (!inAbove) {
          const pxPrev = i > 0 ? u.valToPos(xData[i-1], 'x', true) : px;
          ctx.moveTo(pxPrev, cyClamp);
          inAbove = true;
        }
        ctx.lineTo(px, py);
      } else if (inAbove) {
        const pxPrev = u.valToPos(xData[i-1], 'x', true);
        ctx.lineTo(pxPrev, cyClamp);
        ctx.closePath();
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
    
    // Vertical alignment with main graph:
    // uPlot padding: [4, 0, 0, 0]
    // Axis size: 30
    const pad    = { t: 4, r: 0, b: 30, l: labelW + 6 };
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
      // CDF line is now solid
      ctx.setLineDash([]);
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

      // ── Hover highlight on CDF ──
      if (hoverBinI != null && pts2[hoverBinI + 1]) {
        const cp = pts2[hoverBinI + 1];
        // Vertical line down
        ctx.beginPath();
        ctx.setLineDash([2 * dpr, 2 * dpr]);
        ctx.strokeStyle = hexToRgba(def.color, 0.6);
        ctx.moveTo(cp.x, cp.y);
        ctx.lineTo(cp.x, pad.t + plotH);
        ctx.stroke();
        ctx.setLineDash([]);

        // Dot: tiny precision point
        ctx.beginPath();
        ctx.arc(cp.x, cp.y, 1.2 * dpr, 0, Math.PI * 2);
        ctx.fillStyle = '#0e0e10';
        ctx.fill();
        ctx.strokeStyle = def.color;
        ctx.lineWidth = 1 * dpr;
        ctx.stroke();
      }
    }

    // Axis labels: max at top, min at bottom
    ctx.fillStyle    = '#888896';
    ctx.font         = '9px system-ui, sans-serif';
    ctx.textAlign    = 'right';
    
    // Draw Max
    ctx.textBaseline = 'top';
    ctx.fillText(`${fmt(max)} ${def.unit}`, pad.l - 4, pad.t);
    
    // Draw Min
    ctx.textBaseline = 'bottom';
    ctx.fillText(`${fmt(min)} ${def.unit}`, pad.l - 4, H - pad.b);

    // Draw Avg (only if it doesn't overlap min/max)
    const stats = rangeStats(histData.xData, histData.yData, selAnchorVal || -Infinity, selEndVal || Infinity);
    if (stats) {
      const avgY = pad.t + (BINS - 1 - Math.min(BINS - 1, Math.floor(((stats.avg - min) / (max - min || 1)) * BINS))) * (plotH / BINS);
      const minLabelY = H - pad.b;
      const maxLabelY = pad.t;
      const labelHeight = 10; // Approx 10px height for 9px font

      if (avgY > maxLabelY + labelHeight + 2 && avgY < minLabelY - labelHeight - 2) {
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#aaa';
        ctx.fillText(`${fmt(stats.avg)} ${def.unit}`, pad.l - 4, avgY);
        // Draw small indicator tick
        ctx.beginPath();
        ctx.moveTo(pad.l - 3, avgY);
        ctx.lineTo(pad.l, avgY);
        ctx.strokeStyle = '#aaa';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    // ── Higher/Lower percentages below histogram ──
    if (hoverBinI != null && total > 0) {
      let countLower = 0;
      for (let i = 0; i < hoverBinI; i++) countLower += bins[i];
      let countHigher = 0;
      for (let i = hoverBinI + 1; i < BINS; i++) countHigher += bins[i];

      const pLower  = Math.round((countLower / total) * 100);
      const pHigher = Math.round((countHigher / total) * 100);

      ctx.save();
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.font = '8px system-ui, sans-serif';
      
      const textY = H - pad.b + 6;
      
      // Draw "Lower" stat
      ctx.fillStyle = '#888896';
      ctx.fillText('LOWER', pad.l, textY);
      ctx.fillStyle = '#ccc';
      ctx.font = 'bold 10px system-ui, sans-serif';
      ctx.fillText(`${pLower}%`, pad.l, textY + 10);

      // Draw "Higher" stat
      const midX = pad.l + plotW / 2;
      ctx.font = '8px system-ui, sans-serif';
      ctx.fillStyle = '#888896';
      ctx.fillText('HIGHER', midX, textY);
      ctx.fillStyle = '#ccc';
      ctx.font = 'bold 10px system-ui, sans-serif';
      ctx.fillText(`${pHigher}%`, midX, textY + 10);
      
      ctx.restore();
    }
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

    const getBinAt = (e) => {
      const { bins, BINS } = histData;
      if (!bins) return null;
      const rect  = canvas.getBoundingClientRect();
      const relY  = e.clientY - rect.top;
      // Use exact padding from drawHistogram: t: 4, b: 30
      const pad   = { t: 4, b: 30 };
      const plotH = rect.height - pad.t - pad.b;
      const rawI  = Math.floor(((relY - pad.t) / plotH) * BINS);
      const binI  = BINS - 1 - rawI;
      if (rawI < 0 || rawI >= BINS) return null;
      return binI;
    };

    const hide = () => {
      if (histTooltipEl) histTooltipEl.style.display = 'none';
      if (lineEl) lineEl.style.display = 'none';
      if (lastBinI !== null) {
        lastBinI = null;
        if (histData.plot) {
          histData.plot.hoveredHistY = null;
          histData.plot.uplot.redraw(false);
        }
        drawHistogram(canvas, histData, canvas.height / (window.devicePixelRatio || 1));
      }
    };

    canvas.addEventListener('mousemove', e => {
      if (!histTooltipEl) return;
      const { binAccum, min, max, BINS, def, plot } = histData;
      const binI = getBinAt(e);
      if (binI === null) { hide(); return; }

      const span   = max - min || 1;
      const binMin = min + (binI / BINS) * span;
      const binMax = min + ((binI + 1) / BINS) * span;

      if (binI !== lastBinI) {
        lastBinI = binI;
        if (plot) {
          plot.hoveredHistY = binMin;
          plot.uplot.redraw(false);
        }
        drawHistogram(canvas, histData, canvas.height / (window.devicePixelRatio || 1), binI);
      }

      const fmt    = v => (max - min < 10 ? v.toFixed(1) : v.toFixed(0));
      const fmtAccum = v => xAxis === 'time' ? fmtSecs(Math.round(v)) : `${v.toFixed(2)} km`;
      const label  = xAxis === 'time' ? 'Duration' : 'Dist';

      const { selBins, selBinAccum } = histData;
      const hasSel = selBins != null;

      const totalAccum = binAccum ? fmtAccum(binAccum[binI]) : null;
      const selAccum   = hasSel && selBinAccum ? fmtAccum(selBinAccum[binI]) : null;

      // Percentage calculation: weight of this bin / total weight of all bins
      const totalWeight = binAccum.reduce((a, b) => a + b, 0);
      const totalPct = totalWeight > 0 ? (binAccum[binI] / totalWeight) * 100 : 0;

      let html = `<div style="color:${def.color};font-weight:600;margin-bottom:4px;text-align:center">${fmt(binMin)}–${fmt(binMax)} ${def.unit}</div>`;
      if (hasSel) {
        const selWeight = histData.selBinAccum.reduce((a, b) => a + b, 0);
        const selPct = selWeight > 0 ? (histData.selBinAccum[binI] / selWeight) * 100 : 0;

        html += `<div class="hist-tt-grid">
          <span class="hist-tt-label">Total</span>
          <span class="hist-tt-value">${totalAccum ?? '—'}</span>
          <span class="hist-tt-pct">${totalPct.toFixed(1)}%</span>
          
          <span class="hist-tt-label sel">Sel</span>
          <span class="hist-tt-value sel">${selAccum ?? '—'}</span>
          <span class="hist-tt-pct sel">${selPct.toFixed(1)}%</span>
        </div>`;
      } else if (totalAccum) {
        html += `<div class="hist-tt-grid">
          <span class="hist-tt-label">${label}</span>
          <span class="hist-tt-value">${totalAccum}</span>
          <span class="hist-tt-pct">${totalPct.toFixed(1)}%</span>
        </div>`;
      }
      histTooltipEl.innerHTML = html;

      // Position tooltip: fixed X left of canvas, Y centered on bin
      histTooltipEl.style.display = 'block';
      const ttH   = histTooltipEl.offsetHeight;
      const ttW   = histTooltipEl.offsetWidth;
      // binY(i) = pad.t + (BINS-1-i) * (plotH/BINS), centre = + 0.5*(plotH/BINS)
      const rect  = canvas.getBoundingClientRect();
      const pad   = { t: 4, b: 30 };
      const plotH = rect.height - pad.t - pad.b;
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

    canvas.addEventListener('click', e => {
      const binI = getBinAt(e);
      if (binI === null || !histData.plot) return;
      const { min, max, BINS } = histData;
      const span   = max - min || 1;
      const binMin = min + (binI / BINS) * span;

      // Toggle pinned Y if same bucket, otherwise set new pinned Y
      if (histData.plot.pinnedHistY === binMin) {
        histData.plot.pinnedHistY = null;
      } else {
        histData.plot.pinnedHistY = binMin;
      }
      histData.plot.uplot.redraw(false);
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
    getActiveMetrics: () => activeMetrics,
    getAvailableMetrics: () => availableMetrics,
    setActiveMetrics,
    getXAxis: () => xAxis,
  };

  function drawMetricColorFill(u, xData, yData, pts, metricKey) {
    const ctx = u.ctx;
    const bb  = u.bbox;
    const dpr = window.devicePixelRatio || 1;
    const colors = _computePointColors(metricKey, yData);

    ctx.save();
    ctx.beginPath();
    ctx.rect(bb.left, bb.top, bb.width, bb.height);
    ctx.clip();

    const baseY = bb.top + bb.height;

    for (let i = 1; i < xData.length; i++) {
      if (xData[i] == null || yData[i] == null || xData[i-1] == null || yData[i-1] == null) continue;
      const x0 = u.valToPos(xData[i-1], 'x', true);
      const y0 = u.valToPos(yData[i-1], 'y', true);
      const x1 = u.valToPos(xData[i],   'x', true);
      const y1 = u.valToPos(yData[i],   'y', true);

      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.lineTo(x1, baseY);
      ctx.lineTo(x0, baseY);
      ctx.closePath();
      
      const c = colors[i];
      ctx.fillStyle = hexToRgba(c, 0.25);
      ctx.fill();

      // Top line segment
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.strokeStyle = c;
      ctx.lineWidth = 1.5 * dpr;
      ctx.stroke();
    }

    ctx.restore();
  }

})();
