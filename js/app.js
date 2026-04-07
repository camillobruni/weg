'use strict';

// ── Main Application ──────────────────────────────────────────────

const TRACK_COLORS = [
  '#FF6B35','#4ECDC4','#45B7D1','#F7DC6F','#FF6B6B',
  '#BB8FCE','#82E0AA','#F8C471','#3b82f6','#ec4899',
  '#06b6d4','#84cc16','#f97316','#a78bfa','#fb7185',
];

let tracks = {};       // id → track
let colorIdx = 0;
let selectedId = null;
let chartHeight = 280; // pixels for chart panel

// ── Tab Navigation ─────────────────────────────────────────────────
document.addEventListener('click', e => {
  const btn = e.target.closest('.tab-btn');
  if (!btn) return;
  const nav = btn.closest('#tab-nav');
  if (!nav) return;

  // Toggle buttons
  nav.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b === btn));

  // Toggle contents
  const panel = nav.closest('#chart-panel');
  if (panel) {
    panel.querySelectorAll('.tab-content').forEach(c => {
      c.classList.toggle('active', c.id === `tab-${btn.dataset.tab}`);
    });
  }

  if (btn.dataset.tab === 'details' && selectedId && tracks[selectedId]) {
    renderDetails(tracks[selectedId]);
  }

  if (btn.dataset.tab === 'graphs' && typeof ChartView !== 'undefined') ChartView.resize();
});

// ── Boot ──────────────────────────────────────────────────────────
(async function init() {
  const urlState = UrlState.get();

  // Init sub-systems
  MapView.init(selectTrack, onMapMove, onMapPointClick);
  ChartView.init(onChartCursorMove, onChartRangeChange, onChartClick);

  // Restore basemap
  if (urlState.basemap) {
    MapView.switchBasemap(urlState.basemap);
    document.querySelectorAll('.bm-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.layer === urlState.basemap));
  }

  // Restore map position (before fitAll so it doesn't get overridden)
  if (urlState.map) {
    const [lat, lng, zoom] = urlState.map;
    MapView.setPosition(lat, lng, zoom);
  }

  // Restore x-axis mode
  if (urlState.xaxis) {
    ChartView.setXAxis(urlState.xaxis);
    document.querySelectorAll('#x-axis-ctrl .seg-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.axis === urlState.xaxis));
  }

  // Load persisted tracks
  try {
    const saved = await Storage.getAll();
    saved.sort((a,b) => a.addedAt - b.addedAt);
    for (const t of saved) {
      tracks[t.id] = t;
      colorIdx = Math.max(colorIdx, TRACK_COLORS.indexOf(t.color) + 1);
      MapView.addTrack(t);
    }
    renderTrackList();
    // Only fit all if no saved map position
    if (saved.length && !urlState.map) MapView.fitAll();

    // ── RESTORE SELECTION ─────────────────────────────────────────
    // Must happen AFTER tracks are loaded into the global 'tracks' object
    const savedIds = Object.keys(tracks);
    const restoreId = (urlState.track && tracks[urlState.track])
      ? urlState.track
      : (savedIds.length > 0 ? savedIds[0] : null);

    if (restoreId) {
      selectTrack(restoreId, !urlState.map);

      if (urlState.sel) {
        const [xMin, xMax] = urlState.sel;
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            ChartView.restoreSelection(xMin, xMax);
          });
        });
      }
    }
  } catch(e) {
    console.warn('Could not load saved tracks:', e);
  }

  // Chart panel resize
  initResizeHandle();

  // Basemap switcher
  document.getElementById('basemap-switcher').addEventListener('click', e => {
    const btn = e.target.closest('.bm-btn');
    if (!btn) return;
    document.querySelectorAll('.bm-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    MapView.switchBasemap(btn.dataset.layer);
    UrlState.patch({ basemap: btn.dataset.layer });
  });

  // Fit all
  document.getElementById('btn-fit-all').addEventListener('click', () => MapView.fitAll());

  // Clear all
  document.getElementById('btn-clear-all').addEventListener('click', clearAll);

  // Metric toggles
  document.getElementById('metric-pills').addEventListener('click', e => {
    const pill = e.target.closest('.metric-pill');
    if (!pill) return;
    pill.classList.toggle('active');
    ChartView.toggleMetric(pill.dataset.metric);
  });

  // X-axis toggle
  document.getElementById('x-axis-ctrl').addEventListener('click', e => {
    const btn = e.target.closest('.seg-btn');
    if (!btn) return;
    document.querySelectorAll('#x-axis-ctrl .seg-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    ChartView.setXAxis(btn.dataset.axis);
    UrlState.patch({ xaxis: btn.dataset.axis });
  });

  // Reset zoom
  document.getElementById('btn-reset-zoom').addEventListener('click', () => {
    ChartView.resetZoom();
    MapView.clearHighlight();
  });

  // Reset selection
  document.getElementById('btn-reset-selection').addEventListener('click', () => {
    ChartView.cancelSelection();
  });

  // File drag/drop
  initDropZone();

  // File browse
  document.getElementById('file-input').addEventListener('change', e => {
    handleFiles(Array.from(e.target.files));
    e.target.value = '';
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') MapView.hideCursor();
  });

  // Resize charts when window changes
  window.addEventListener('resize', () => ChartView.resize());
})();

// ── Drag & Drop ───────────────────────────────────────────────────
function initDropZone() {
  const zone = document.getElementById('drop-zone');

  ['dragenter','dragover'].forEach(ev => {
    zone.addEventListener(ev, e => { e.preventDefault(); zone.classList.add('drag-over'); });
    document.body.addEventListener(ev, e => { e.preventDefault(); zone.classList.add('drag-over'); });
  });

  ['dragleave','dragend'].forEach(ev => {
    zone.addEventListener(ev, () => zone.classList.remove('drag-over'));
    document.body.addEventListener(ev, () => zone.classList.remove('drag-over'));
  });

  const onDrop = e => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    const files = Array.from(e.dataTransfer.files);
    handleFiles(files);
  };
  zone.addEventListener('drop', onDrop);
  document.body.addEventListener('drop', onDrop);
}

// ── File loading ──────────────────────────────────────────────────
async function handleFiles(files) {
  const valid = files.filter(f => /\.(gpx|fit|tcx|kml)$/i.test(f.name));
  if (!valid.length) {
    showToast('No supported files found (GPX, FIT, TCX, KML)', 'error');
    return;
  }

  const overlay = showLoading(`Loading ${valid.length} file${valid.length > 1 ? 's' : ''}…`);

  let added = 0, errors = [];
  for (const file of valid) {
    try {
      overlay.setText(`Parsing ${file.name}…`);
      const data = await Parsers.parseFile(file);
      const id   = crypto.randomUUID();
      const color = TRACK_COLORS[colorIdx % TRACK_COLORS.length];
      colorIdx++;

      const track = {
        id,
        name: data.name || file.name.replace(/\.[^.]+$/, ''),
        filename: file.name,
        format: data.format,
        color,
        visible: true,
        addedAt: Date.now(),
        points: data.points,
        stats: data.stats,
      };

      tracks[id] = track;
      MapView.addTrack(track);
      await Storage.put(track);
      added++;
    } catch(e) {
      errors.push(`${file.name}: ${e.message}`);
    }
  }

  hideLoading(overlay);
  renderTrackList();

  if (added)  {
    showToast(`Added ${added} track${added > 1 ? 's' : ''}`, 'success');
    if (!selectedId) {
      const firstId = Object.keys(tracks).sort((a,b) => tracks[a].addedAt - tracks[b].addedAt).pop();
      if (firstId) selectTrack(firstId);
    } else {
      MapView.fitAll();
    }
  }
  if (errors.length) {
    errors.forEach(msg => showToast(msg, 'error'));
  }
}

// ── Track list UI ─────────────────────────────────────────────────
function renderTrackList() {
  const list   = document.getElementById('track-list');
  const emptyEl = document.getElementById('track-list-empty');
  if (!list) return;

  const ids = Object.keys(tracks);

  if (!ids.length) {
    list.innerHTML = '';
    if (emptyEl) {
      list.appendChild(emptyEl);
      emptyEl.style.display = 'block';
    }
    return;
  }
  if (emptyEl) emptyEl.style.display = 'none';
  list.innerHTML = '';

  ids.sort((a,b) => tracks[a].addedAt - tracks[b].addedAt).forEach(id => {
    list.appendChild(buildTrackItem(tracks[id]));
  });
}

function buildTrackItem(track) {
  const item = document.createElement('div');
  item.className = 'track-item' + (track.id === selectedId ? ' selected' : '');
  item.dataset.id = track.id;

  const s = track.stats;
  const distStr = s.totalDist  != null ? `${(s.totalDist/1000).toFixed(1)} km` : '';
  const timeStr = s.duration   != null ? fmtDuration(s.duration) : '';
  const elevStr = s.elevGain   != null ? `↑${Math.round(s.elevGain)}m` : '';

  item.innerHTML = `
    <span class="track-color-swatch" style="background:${track.color}" title="Click to change color"></span>
    <div class="track-info">
      <div class="track-name" title="${escHtml(track.name)}">${escHtml(track.name)}</div>
      <div class="track-meta">
        <span class="badge">${track.format.toUpperCase()}</span>
        ${distStr ? `<span>${distStr}</span>` : ''}
        ${timeStr ? `<span>${timeStr}</span>` : ''}
        ${elevStr ? `<span>${elevStr}</span>` : ''}
      </div>
    </div>
    <div class="track-actions">
      <button class="icon-btn eye-btn${track.visible ? '' : ' hidden-track'}" data-action="toggle-vis" title="Show/hide">
        <span class="material-symbols-rounded">${track.visible ? 'visibility' : 'visibility_off'}</span>
      </button>
      <button class="icon-btn danger" data-action="delete" title="Remove track">
        <span class="material-symbols-rounded">delete</span>
      </button>
    </div>
  `;

  // Select track
  item.addEventListener('click', e => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (!action) { selectTrack(track.id); return; }

    if (action === 'toggle-vis') {
      track.visible = !track.visible;
      MapView.setTrackVisible(track.id, track.visible);
      Storage.put(track);
      renderTrackList();
    } else if (action === 'delete') {
      deleteTrack(track.id);
    }
  });

  // Color swatch click
  item.querySelector('.track-color-swatch').addEventListener('click', e => {
    e.stopPropagation();
    showColorPicker(e.target, track);
  });

  return item;
}

// ── Track actions ─────────────────────────────────────────────────
function selectTrack(id, fit = true) {
  if (!tracks[id]) return;
  selectedId = id;
  UrlState.patch({ track: id, sel: null });

  // Update UI immediately
  renderTrackList();
  renderDetails(tracks[id]);

  MapView.setSelectedTrack(id);
  MapView.clearHighlight();
  ChartView.clearPinnedDot();
  if (fit) MapView.fitTrack(id);
  ChartView.loadTrack(tracks[id]);
}

async function deleteTrack(id) {
  MapView.removeTrack(id);
  await Storage.remove(id);
  delete tracks[id];
  if (selectedId === id) {
    selectedId = null;
    ChartView.clear();
    UrlState.patch({ track: null, sel: null });
    renderDetails(null);
  }
  renderTrackList();
}

async function clearAll() {
  if (!Object.keys(tracks).length) return;
  if (!confirm('Remove all tracks?')) return;
  for (const id of Object.keys(tracks)) MapView.removeTrack(id);
  tracks = {};
  selectedId = null;
  colorIdx = 0;
  ChartView.clear();
  await Storage.clear();
  UrlState.patch({ track: null, sel: null });
  renderDetails(null);
  renderTrackList();
}

// ── Details rendering ─────────────────────────────────────────────
function renderDetails(track) {
  const container = document.getElementById('details-content');
  if (!container) return;

  if (!track) {
    container.innerHTML = '<div class="details-empty">Select a track to view details</div>';
    return;
  }

  try {
    const s = track.stats || {};
    const pts = track.points || [];

    const fmtDate  = d => d ? new Date(d).toLocaleString() : '—';
    const fmtDist  = d => d != null ? `${(d/1000).toFixed(2)} km` : '—';
    const fmtElev  = e => e != null ? `${Math.round(e)} m` : '—';
    const fmtSpeed = sp => sp != null ? `${(sp*3.6).toFixed(1)} km/h` : '—';
    const fmtDur   = ms => ms != null ? fmtDuration(ms) : '—';
    const fmtVal   = (v, unit = '') => v != null ? `${v}${unit}` : '—';

    container.innerHTML = `
      <div class="details-grid">
        <div class="details-section">
          <h3>General</h3>
          <ul class="details-list">
            <li class="details-item"><span class="details-label">Name</span><span class="details-value">${escHtml(track.name || 'Unnamed')}</span></li>
            <li class="details-item"><span class="details-label">Filename</span><span class="details-value">${escHtml(track.filename || '—')}</span></li>
            <li class="details-item"><span class="details-label">Format</span><span class="details-value">${(track.format || '—').toUpperCase()}</span></li>
            <li class="details-item"><span class="details-label">Points</span><span class="details-value">${pts.length.toLocaleString()}</span></li>
            <li class="details-item"><span class="details-label">Date</span><span class="details-value">${fmtDate(pts[0]?.time)}</span></li>
          </ul>
        </div>
        <div class="details-section">
          <h3>Core Metrics</h3>
          <ul class="details-list">
            <li class="details-item"><span class="details-label">Distance</span><span class="details-value">${fmtDist(s.totalDist)}</span></li>
            <li class="details-item"><span class="details-label">Moving Time</span><span class="details-value">${fmtDur(s.duration)}</span></li>
            <li class="details-item"><span class="details-label">Elevation Gain</span><span class="details-value">${fmtElev(s.elevGain)}</span></li>
            <li class="details-item"><span class="details-label">Avg Speed</span><span class="details-value">${fmtSpeed(s.avgSpeed)}</span></li>
            <li class="details-item"><span class="details-label">Max Speed</span><span class="details-value">${fmtSpeed(s.maxSpeed)}</span></li>
          </ul>
        </div>
        <div class="details-section">
          <h3>Performance</h3>
          <ul class="details-list">
            <li class="details-item"><span class="details-label">Avg Power</span><span class="details-value">${fmtVal(s.avgPower, ' W')}</span></li>
            <li class="details-item"><span class="details-label">Max Power</span><span class="details-value">${fmtVal(s.maxPower, ' W')}</span></li>
            <li class="details-item"><span class="details-label">Avg HR</span><span class="details-value">${fmtVal(s.avgHR, ' bpm')}</span></li>
            <li class="details-item"><span class="details-label">Max HR</span><span class="details-value">${fmtVal(s.maxHR, ' bpm')}</span></li>
            <li class="details-item"><span class="details-label">Avg Cadence</span><span class="details-value">${fmtVal(s.avgCadence, ' rpm')}</span></li>
          </ul>
        </div>
        <div class="details-section">
          <h3>Hardware</h3>
          <ul class="details-list">
            <li class="details-item"><span class="details-label">Device</span><span class="details-value">${escHtml(track.device || 'Unknown')}</span></li>
            <li class="details-item"><span class="details-label">Sensors</span><span class="details-value">${s.sensors?.length ? s.sensors.join(', ') : 'GPS Only'}</span></li>
          </ul>
        </div>
      </div>
    `;
  } catch (err) {
    console.error('renderDetails error:', err);
  }
}

// ── Color picker ──────────────────────────────────────────────────
function showColorPicker(anchor, track) {
  // Remove existing pickers
  document.querySelectorAll('.color-picker-popup').forEach(el => el.remove());

  const popup = document.createElement('div');
  popup.className = 'color-picker-popup';
  popup.style.cssText = `
    position:fixed; z-index:9000; padding:8px; border-radius:8px;
    background:var(--surface2); border:1px solid var(--border);
    display:grid; grid-template-columns:repeat(5,1fr); gap:5px;
    box-shadow:0 8px 24px rgba(0,0,0,0.5);
  `;

  TRACK_COLORS.forEach(c => {
    const dot = document.createElement('div');
    dot.style.cssText = `width:20px;height:20px;border-radius:50%;background:${c};cursor:pointer;
      border:2px solid ${c === track.color ? '#fff' : 'transparent'};transition:transform .1s;`;
    dot.title = c;
    dot.addEventListener('mouseover', () => dot.style.transform = 'scale(1.2)');
    dot.addEventListener('mouseout',  () => dot.style.transform = '');
    dot.addEventListener('click', () => {
      track.color = c;
      MapView.setTrackColor(track.id, c);
      Storage.put(track);
      renderTrackList();
      popup.remove();
    });
    popup.appendChild(dot);
  });

  const rect = anchor.getBoundingClientRect();
  popup.style.left = `${Math.min(rect.left, window.innerWidth - 140)}px`;
  popup.style.top  = `${rect.bottom + 4}px`;
  document.body.appendChild(popup);

  const dismiss = e => { if (!popup.contains(e.target)) { popup.remove(); document.removeEventListener('click', dismiss); } };
  setTimeout(() => document.addEventListener('click', dismiss), 0);
}

// ── Cursor sync ───────────────────────────────────────────────────
function onChartCursorMove(pt) {
  if (pt && pt.lat != null && pt.lon != null) {
    MapView.showCursorAt(pt.lat, pt.lon);
  }
}

function onChartRangeChange(xMin, xMax, axis) {
  if (!selectedId) return;
  const track = tracks[selectedId];
  if (!track) return;

  // null means selection was cancelled
  if (xMin == null) {
    MapView.clearHighlight();
    ChartView.clearSelectionStats();
    UrlState.patch({ sel: null });
    return;
  }

  const pts = track.points;
  const t0  = pts[0]?.time || 0;

  let iMin = 0, iMax = pts.length - 1;
  for (let i = 0; i < pts.length; i++) {
    const x = axis === 'distance' ? pts[i].dist / 1000 : (pts[i].time - t0) / 1000;
    if (x >= xMin) { iMin = i; break; }
  }
  for (let i = pts.length - 1; i >= 0; i--) {
    const x = axis === 'distance' ? pts[i].dist / 1000 : (pts[i].time - t0) / 1000;
    if (x <= xMax) { iMax = i; break; }
  }

  if (iMin <= 0 && iMax >= pts.length - 1) {
    MapView.clearHighlight();
    ChartView.clearSelectionStats();
    UrlState.patch({ sel: null });
  } else {
    // Only fit map if we're not currently dragging the handles/zoom
    const shouldFit = !ChartView.isDragging();
    MapView.highlightSegment(selectedId, pts, iMin, iMax, shouldFit);
    ChartView.setSelectionStats(computeRangeStats(pts, iMin, iMax));
    UrlState.patch({ sel: [xMin, xMax] });
  }
}

function computeRangeStats(pts, iMin, iMax) {
  const slice = pts.slice(iMin, iMax + 1);
  let elevGain = 0, powerSum = 0, powerN = 0, hrSum = 0, hrN = 0, speedSum = 0, speedN = 0;
  for (let i = 1; i < slice.length; i++) {
    const p = slice[i], prev = slice[i-1];
    if (p.ele != null && prev.ele != null && p.ele > prev.ele) elevGain += p.ele - prev.ele;
    if (p.power != null) { powerSum += p.power; powerN++; }
    if (p.hr    != null) { hrSum    += p.hr;    hrN++; }
    if (p.speed != null) { speedSum += p.speed; speedN++; }
  }
  const totalDist = (slice[slice.length-1]?.dist || 0) - (slice[0]?.dist || 0);
  const duration  = (slice[slice.length-1]?.time && slice[0]?.time)
    ? slice[slice.length-1].time - slice[0].time : null;
  return {
    totalDist,
    elevGain,
    duration,
    avgSpeed:  speedN ? speedSum / speedN : null,
    avgPower:  powerN ? Math.round(powerSum / powerN) : null,
    avgHR:     hrN    ? Math.round(hrSum    / hrN)    : null,
  };
}

function onChartClick(pt) {
  if (pt?.lat != null && pt?.lon != null) {
    MapView.centerOn(pt.lat, pt.lon);
    MapView.closePopup();
  }
}

function onMapPointClick(trackId, ptIdx) {
  // If a different track was clicked, select it first
  if (trackId !== selectedId) {
    selectTrack(trackId);
  } else {
    // Already selected, but make sure details are up to date
    renderDetails(tracks[selectedId]);
  }
  // Mark the point on all charts
  ChartView.setCursorAt(ptIdx);
}

function onMapMove(lat, lng, zoom) {
  UrlState.patch({ map: [+lat.toFixed(5), +lng.toFixed(5), zoom] });
}

// ── Resize handle ─────────────────────────────────────────────────
function initResizeHandle() {
  const handle     = document.getElementById('resize-handle');
  const mapCont    = document.getElementById('map-container');
  const chartPanel = document.getElementById('chart-panel');

  let startY, startMapH;

  handle.addEventListener('mousedown', e => {
    startY = e.clientY;
    startMapH = mapCont.offsetHeight;
    handle.classList.add('dragging');
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
  });

  function onMove(e) {
    const dy    = e.clientY - startY;
    const newH  = Math.max(150, startMapH + dy);
    const mainH = document.getElementById('main').offsetHeight;
    const maxH  = mainH - 100 - 6; // leave min 100px for charts
    mapCont.style.height = `${Math.min(newH, maxH)}px`;
    mapCont.style.flex   = 'none';
    MapView.invalidateSize();
    ChartView.resize();
  }

  function onUp() {
    handle.classList.remove('dragging');
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup',   onUp);
  }
}

// ── Loading overlay ───────────────────────────────────────────────
function showLoading(msg) {
  const el = document.createElement('div');
  el.className = 'loading-overlay';
  el.innerHTML = `<div class="spinner"></div><div class="loading-text">${escHtml(msg)}</div>`;
  document.body.appendChild(el);
  return {
    setText: t => { const tx = el.querySelector('.loading-text'); if (tx) tx.textContent = t; },
    el,
  };
}

function hideLoading(overlay) {
  if (overlay?.el) overlay.el.remove();
}

// ── Toast ─────────────────────────────────────────────────────────
function showToast(msg, type = '') {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }
  const t = document.createElement('div');
  t.className = `toast${type ? ' ' + type : ''}`;
  t.textContent = msg;
  container.appendChild(t);
  setTimeout(() => t.remove(), 4000);
}

// ── Utilities ─────────────────────────────────────────────────────
function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2,'0')}:${String(ss).padStart(2,'0')}`
    : `${m}:${String(ss).padStart(2,'0')}`;
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function slugify(s) {
  return String(s)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')  // strip accents
    .replace(/[^a-zA-Z0-9]+/g, '-')                    // non-alphanum → hyphen
    .replace(/-+/g, '-')                               // collapse multiple hyphens
    .replace(/^-+|-+$/g, '')                           // trim hyphens from ends
    .toLowerCase() || 'track';                         // fallback
}
