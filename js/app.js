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
  document.getElementById('folder-input').addEventListener('change', e => {
    handleFiles(Array.from(e.target.files));
    e.target.value = '';
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      MapView.hideCursor();
      MapView.closePopup?.();
      // Dismiss color picker if open
      document.querySelectorAll('.color-picker-popup').forEach(el => el.remove());
    }
  });

  // Resize charts when window changes
  window.addEventListener('resize', () => ChartView.resize());
})();

// ── Drag & Drop ───────────────────────────────────────────────────
function readDirEntries(reader) {
  return new Promise((resolve, reject) => {
    const results = [];
    const readBatch = () => reader.readEntries(batch => {
      if (!batch.length) { resolve(results); return; }
      results.push(...batch);
      readBatch();
    }, reject);
    readBatch();
  });
}

async function collectEntry(entry) {
  if (entry.isFile) {
    return new Promise((resolve, reject) => entry.file(resolve, reject));
  }
  const reader = entry.createReader();
  const entries = await readDirEntries(reader);
  const results = await Promise.allSettled(entries.map(collectEntry));
  return results.flatMap(r => r.status === 'fulfilled' ? [r.value].flat() : []);
}

async function collectDroppedFiles(dataTransfer) {
  // entries must be captured synchronously before the event is released
  const entries = Array.from(dataTransfer.items || [])
    .map(i => i.webkitGetAsEntry?.())
    .filter(Boolean);
  if (entries.length) {
    const results = await Promise.allSettled(entries.map(collectEntry));
    return results.flatMap(r => r.status === 'fulfilled' ? [r.value].flat() : []);
  }
  return Array.from(dataTransfer.files);
}

function initDropZone() {
  const zone = document.getElementById('drop-zone');
  const input = document.getElementById('file-input');

  ['dragenter','dragover'].forEach(ev => {
    zone.addEventListener(ev, e => { e.preventDefault(); zone.classList.add('drag-over'); });
    document.body.addEventListener(ev, e => { e.preventDefault(); zone.classList.add('drag-over'); });
  });

  ['dragleave','dragend'].forEach(ev => {
    zone.addEventListener(ev, () => zone.classList.remove('drag-over'));
    document.body.addEventListener(ev, () => zone.classList.remove('drag-over'));
  });

  zone.addEventListener('click', (e) => {
    // If clicking the folder-input or its label, let the browser handle it.
    if (e.target.closest('#folder-label') || e.target.closest('#folder-input')) {
      return;
    }
    if (e.target !== input) input.click();
  });

  const onDrop = async e => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    const files = await collectDroppedFiles(e.dataTransfer);
    handleFiles(files);
  };
  zone.addEventListener('drop', onDrop);
  document.body.addEventListener('drop', onDrop);
}

// ── File loading ──────────────────────────────────────────────────
async function handleFiles(files) {
  const existingFilenames = new Set(Object.values(tracks).map(t => t.filename));
  const valid = files.filter(f => /\.(gpx|fit|tcx|kml)$/i.test(f.name) && !existingFilenames.has(f.name));
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

  // Render details
  const activeTab = document.querySelector('.tab-btn.active').dataset.tab;
  if (activeTab === 'details') renderDetails(tracks[id]);

  // Tell sub-views
  MapView.selectTrack(id, fit);
  ChartView.loadTrack(tracks[id]);
}

function deleteTrack(id) {
  MapView.removeTrack(id);
  Storage.delete(id);
  delete tracks[id];

  if (selectedId === id) {
    selectedId = null;
    UrlState.patch({ track: null, sel: null });
    ChartView.clear();
    const details = document.getElementById('details-view');
    if (details) details.innerHTML = '<div id="details-empty">Select a track for details</div>';
  }
  renderTrackList();
}

function clearAll() {
  Object.keys(tracks).forEach(id => {
    MapView.removeTrack(id);
    Storage.delete(id);
  });
  tracks = {};
  selectedId = null;
  UrlState.patch({ track: null, sel: null });
  ChartView.clear();
  renderTrackList();
}

// ── Details View ──────────────────────────────────────────────────
function renderDetails(track) {
  const container = document.getElementById('details-view');
  if (!container) return;

  const s = track.stats;
  const dist = s.totalDist != null ? (s.totalDist/1000).toFixed(2) : '--';
  const time = s.duration  != null ? fmtDuration(s.duration) : '--';
  const move = s.movingTime != null ? fmtDuration(s.movingTime) : '--';
  const gain = s.elevGain  != null ? Math.round(s.elevGain) : '--';
  const loss = s.elevLoss  != null ? Math.round(s.elevLoss) : '--';
  const vMin = s.minEle    != null ? Math.round(s.minEle) : '--';
  const vMax = s.maxEle    != null ? Math.round(s.maxEle) : '--';
  const sAvg = s.avgSpeed  != null ? (s.avgSpeed * 3.6).toFixed(1) : '--';
  const sMax = s.maxSpeed  != null ? (s.maxSpeed * 3.6).toFixed(1) : '--';

  container.innerHTML = `
    <div class="details-header">
      <h3>${escHtml(track.name)}</h3>
      <div class="details-filename">${escHtml(track.filename)}</div>
    </div>
    <div class="details-grid">
      <div class="details-item"><label>Distance</label><span>${dist} km</span></div>
      <div class="details-item"><label>Duration</label><span>${time}</span></div>
      <div class="details-item"><label>Moving Time</label><span>${move}</span></div>
      <div class="details-item"><label>Elevation Gain</label><span>${gain} m</span></div>
      <div class="details-item"><label>Elevation Loss</label><span>${loss} m</span></div>
      <div class="details-item"><label>Min Elevation</label><span>${vMin} m</span></div>
      <div class="details-item"><label>Max Elevation</label><span>${vMax} m</span></div>
      <div class="details-item"><label>Avg Speed</label><span>${sAvg} km/h</span></div>
      <div class="details-item"><label>Max Speed</label><span>${sMax} km/h</span></div>
    </div>
  `;
}

// ── Chart Callbacks ───────────────────────────────────────────────
function onChartCursorMove(pt) {
  MapView.highlightPoint(pt);
}

function onChartRangeChange(minX, maxX, xAxis) {
  UrlState.patch({ sel: (minX != null && maxX != null) ? [minX, maxX] : null });
  MapView.highlightRange(selectedId, minX, maxX, xAxis);
}

function onChartClick(pt) {
  MapView.panTo(pt.lat, pt.lng);
}

// ── Map Callbacks ─────────────────────────────────────────────────
function onMapMove(lat, lng, zoom) {
  UrlState.patch({ map: [lat.toFixed(6), lng.toFixed(6), zoom] });
}

function onMapPointClick(trackId, ptIdx) {
  if (trackId !== selectedId) selectTrack(trackId, false);
  ChartView.pinPoint(ptIdx);
}

// ── Helpers ───────────────────────────────────────────────────────
function fmtDuration(s) {
  const h = Math.floor(s/3600), m = Math.floor((s%3600)/60);
  return h > 0 ? `${h}h ${m}m` : `${m}m ${s%60}s`;
}

function escHtml(str) {
  const p = document.createElement('p');
  p.textContent = str;
  return p.innerHTML;
}

function showColorPicker(anchorEl, track) {
  document.querySelectorAll('.color-picker-popup').forEach(el => el.remove());

  const popup = document.createElement('div');
  popup.className = 'color-picker-popup';
  popup.style.cssText = `
    position: fixed;
    z-index: 10000;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 8px;
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    gap: 6px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.2);
  `;

  TRACK_COLORS.forEach(c => {
    const dot = document.createElement('div');
    dot.style.cssText = `width:20px;height:20px;border-radius:50%;background:${c};cursor:pointer;border:1.5px solid transparent;`;
    if (track.color === c) dot.style.borderColor = 'var(--text)';
    dot.addEventListener('click', () => {
      track.color = c;
      MapView.updateTrackStyle(track.id, { color: c });
      Storage.put(track);
      renderTrackList();
      popup.remove();
    });
    popup.appendChild(dot);
  });

  const rect = anchorEl.getBoundingClientRect();
  popup.style.left = `${Math.min(rect.left, window.innerWidth - 140)}px`;
  popup.style.top  = `${rect.bottom + 4}px`;
  document.body.appendChild(popup);

  const dismiss = e => { if (!popup.contains(e.target)) { popup.remove(); document.removeEventListener('click', dismiss); } };
  setTimeout(() => document.addEventListener('click', dismiss), 10);
}

// ── Resize Handle ─────────────────────────────────────────────────
function initResizeHandle() {
  const handle = document.getElementById('resize-handle');
  const panel  = document.getElementById('chart-panel');
  if (!handle || !panel) return;

  let startY, startH;
  const onMove = e => {
    const dy = startY - (e.touches ? e.touches[0].clientY : e.clientY);
    chartHeight = Math.max(100, Math.min(window.innerHeight - 200, startH + dy));
    panel.style.height = `${chartHeight}px`;
    ChartView.resize();
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.removeEventListener('touchmove', onMove);
    document.removeEventListener('touchend', onUp);
  };
  handle.addEventListener('mousedown', e => {
    startY = e.clientY; startH = panel.offsetHeight;
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
  handle.addEventListener('touchstart', e => {
    startY = e.touches[0].clientY; startH = panel.offsetHeight;
    document.addEventListener('touchmove', onMove);
    document.addEventListener('touchend', onUp);
  });
}

// ── Loading overlay ───────────────────────────────────────────────
function showLoading(msg) {
  const el = document.createElement('div');
  el.className = 'loading-overlay';
  el.innerHTML = `<div class="loading-spinner"></div><div class="loading-text">${msg}</div>`;
  document.body.appendChild(el);
  return { el, setText: m => el.querySelector('.loading-text').textContent = m };
}

function hideLoading(overlay) {
  if (overlay?.el) overlay.el.remove();
}

function showToast(msg, type = '') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 400); }, 3000);
}
