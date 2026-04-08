'use strict';

// ── Main Application ──────────────────────────────────────────────

const TRACK_COLORS = [
  '#FF6B35','#4ECDC4','#45B7D1','#F7DC6F','#FF6B6B',
  '#BB8FCE','#82E0AA','#F8C471','#3b82f6','#ec4899',
  '#06b6d4','#84cc16','#f97316','#a78bfa','#fb7185',
];

const POINT_ZOOM_LEVEL = 15; // Zoom level when clicking on chart point

let tracks = {};       // id → track
let colorIdx = 0;
let selectedId = null;
let currentMapColors = null;
let chartHeight = 400; // pixels for chart panel

let filters = {
  date: [null, null],
  dist: [null, null],
  dur:  [null, null],
  metrics: new Set(),
};

let searchQuery = '';
let searchRegex = false;
let currentSort = 'date-desc';
let followDot = false;

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

function updateSearchSortUI() {
  const searchEl = document.getElementById('track-search');
  if (searchEl) searchEl.value = searchQuery;
  
  const regexBtn = document.getElementById('btn-regex-toggle');
  if (regexBtn) regexBtn.classList.toggle('active', searchRegex);
  
  const labelEl = document.getElementById('sort-current-label');
  const iconEl = document.getElementById('sort-current-icon');
  
  if (!labelEl || !iconEl) return;
  
  if (currentSort.startsWith('date')) {
    labelEl.textContent = 'Date';
    iconEl.textContent = 'calendar_today';
  } else if (currentSort.startsWith('dist')) {
    labelEl.textContent = 'Distance';
    iconEl.textContent = 'route';
  } else if (currentSort.startsWith('dur')) {
    labelEl.textContent = 'Duration';
    iconEl.textContent = 'schedule';
  }
}

// ── UI Components ─────────────────────────────────────────────────
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

function initSidebarResizer() {
  const resizer = document.getElementById('sidebar-resizer');
  const sidebar = document.getElementById('sidebar');
  if (!resizer || !sidebar) return;

  let startX, startW;

  const onMove = e => {
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const newWidth = Math.max(150, Math.min(600, startW + (clientX - startX)));
    document.documentElement.style.setProperty('--sidebar-w', `${newWidth}px`);
    
    // Invalidate sub-view sizes as container changes
    MapView.invalidateSize();
    ChartView.resize();
  };

  const onUp = () => {
    resizer.classList.remove('dragging');
    document.body.classList.remove('dragging-sidebar');
    document.body.style.cursor = '';
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.removeEventListener('touchmove', onMove);
    document.removeEventListener('touchend', onUp);
  };

  resizer.addEventListener('mousedown', e => {
    startX = e.clientX;
    startW = sidebar.offsetWidth;
    resizer.classList.add('dragging');
    document.body.classList.add('dragging-sidebar');
    document.body.style.cursor = 'col-resize';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  resizer.addEventListener('touchstart', e => {
    startX = e.touches[0].clientX;
    startW = sidebar.offsetWidth;
    resizer.classList.add('dragging');
    document.body.classList.add('dragging-sidebar');
    document.addEventListener('touchmove', onMove);
    document.addEventListener('touchend', onUp);
  });
}

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
import { Storage } from './storage.js';
import { UrlState } from './url-state.js';
import { Parsers } from './parsers.js';
import { MapView } from './map.js';
import { ChartView } from './charts.js';

async function init() {
  const urlState = UrlState.get();

  // Init sub-systems
  MapView.init(selectTrack, onMapMove, onMapPointClick, onMapDblClick);
  ChartView.init(onChartCursorMove, onChartRangeChange, onChartClick);

  ChartView.setMapColorChangeCb(data => {
    if (data) {
      currentMapColors = data.colors;
      MapView.colorTrackByMetric(selectedId, data.pts, data.colors);
    } else {
      currentMapColors = null;
      MapView.clearMetricColor();
    }
    
    // Refresh highlight with new colors if a selection exists
    const urlState = UrlState.get();
    if (urlState.sel) {
      onChartRangeChange(urlState.sel[0], urlState.sel[1], ChartView.getXAxis());
    }
  });

  // Restore basemap
  if (urlState.map && typeof urlState.map === 'string') {
    MapView.switchBasemap(urlState.map);
    document.querySelectorAll('.bm-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.layer === urlState.map));
  }

  // Restore map position (before fitAll so it doesn't get overridden)
  if (urlState.map_pos) {
    const [lat, lng, zoom] = urlState.map_pos;
    MapView.setPosition(lat, lng, zoom);
  }

  // Restore x-axis mode
  if (urlState.xaxis) {
    ChartView.setXAxis(urlState.xaxis);
  }
  const currentXAxis = urlState.xaxis || 'time';
  document.querySelectorAll('#x-axis-ctrl .seg-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.axis === currentXAxis));

  // Restore active metrics
  if (urlState.metrics) {
    const metrics = ChartView.METRICS;
    const keys = urlState.metrics.map(abbr => 
      Object.keys(metrics).find(k => metrics[k].abbr === abbr)
    ).filter(Boolean);
    if (keys.length) ChartView.setActiveMetrics(keys);
  }

  // Restore filters
  if (urlState.f_date) filters.date = urlState.f_date.map(v => v || null);
  if (urlState.f_dist) filters.dist = urlState.f_dist.map(v => v === 0 ? 0 : (v || null));
  if (urlState.f_dur)  filters.dur  = urlState.f_dur.map(v => v === 0 ? 0 : (v || null));
  if (urlState.f_mets) filters.metrics = new Set(urlState.f_mets);
  updateFilterUI();

  if (urlState.q) searchQuery = urlState.q;
  if (urlState.re) searchRegex = urlState.re;
  if (urlState.sort) currentSort = urlState.sort;
  updateSearchSortUI();

  // Load persisted tracks
  try {
    const saved = await Storage.getAll();
    saved.sort((a,b) => a.addedAt - b.addedAt);
    for (const t of saved) {
      tracks[t.id] = t;
      colorIdx = Math.max(colorIdx, TRACK_COLORS.indexOf(t.color) + 1);
      MapView.addTrack(t);
    }
    
    applyFilters(); // Filter and render list/map
    
    // Only fit all if no saved map position
    if (saved.length && !urlState.map_pos) MapView.fitAll();

    // ── RESTORE SELECTION ─────────────────────────────────────────
    // Must happen AFTER tracks are loaded into the global 'tracks' object
    const savedIds = Object.keys(tracks);
    const restoreId = (urlState.track && tracks[urlState.track])
      ? urlState.track
      : (savedIds.length > 0 ? savedIds[0] : null);

    if (restoreId) {
      selectTrack(restoreId, !urlState.map_pos);

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

  // Panel resizers
  initResizeHandle();
  initSidebarResizer();

  // Basemap switcher
  document.getElementById('basemap-switcher').addEventListener('click', e => {
    const btn = e.target.closest('.bm-btn');
    if (!btn) return;
    document.querySelectorAll('.bm-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    MapView.switchBasemap(btn.dataset.layer);
    UrlState.patch({ map: btn.dataset.layer });
  });

  // Fit all
  document.getElementById('btn-fit-all').addEventListener('click', () => MapView.fitAll());

  // Clear all
  document.getElementById('btn-clear-all').addEventListener('click', clearAll);

  // Search
  document.getElementById('track-search').addEventListener('input', e => {
    searchQuery = e.target.value;
    applyFilters();
    UrlState.patch({ q: searchQuery || null });
  });

  document.getElementById('btn-regex-toggle').addEventListener('click', e => {
    searchRegex = !searchRegex;
    e.target.classList.toggle('active', searchRegex);
    applyFilters();
    UrlState.patch({ re: searchRegex ? 1 : null });
  });

  // Sort
  document.getElementById('btn-sort-menu').addEventListener('click', e => {
    e.stopPropagation();
    showSortMenu(e.currentTarget);
  });

  // Metric menu toggle
  document.getElementById('btn-metric-menu').addEventListener('click', e => {
    e.stopPropagation();
    showMetricMenu(e.currentTarget);
  });

  // Metric toggles (shared logic)
  const toggleMetric = (metric, pill) => {
    if (pill) pill.classList.toggle('active');
    ChartView.toggleMetric(metric);
    syncMetricsToUrl();
  };

  document.getElementById('metric-pills').addEventListener('click', e => {
    const pill = e.target.closest('.metric-pill');
    if (pill) toggleMetric(pill.dataset.metric, pill);
  });

  // Collapse detection
  const toolbar = document.getElementById('chart-toolbar');
  const pills = document.getElementById('metric-pills');
  const options = document.getElementById('chart-options');
  let pillsFullWidth = 0;

  const observer = new ResizeObserver(entries => {
    for (const entry of entries) {
      // Only measure full width when NOT collapsed
      if (!toolbar.classList.contains('collapsed')) {
        pillsFullWidth = pills.offsetWidth;
      }
      
      const availableW = entry.contentRect.width - options.offsetWidth - 40; // 40px buffer
      
      if (toolbar.classList.contains('collapsed')) {
        // Try to expand: if the full width fits again
        if (pillsFullWidth > 0 && availableW > pillsFullWidth) {
          toolbar.classList.remove('collapsed');
        }
      } else {
        // Try to collapse: if pills currently overflow
        if (pills.offsetWidth > availableW) {
          toolbar.classList.add('collapsed');
        }
      }
    }
  });
  observer.observe(toolbar);

  // X-axis toggle
  document.getElementById('x-axis-ctrl').addEventListener('click', e => {
    const btn = e.target.closest('.seg-btn');
    if (!btn) return;
    document.querySelectorAll('#x-axis-ctrl .seg-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    ChartView.setXAxis(btn.dataset.axis);
    UrlState.patch({ xaxis: btn.dataset.axis });
  });

  // Follow dot
  document.getElementById('btn-follow-dot').addEventListener('click', e => {
    followDot = !followDot;
    e.currentTarget.classList.toggle('active', followDot);
  });

  // Reset zoom
  document.getElementById('btn-reset-zoom').addEventListener('click', () => {
    ChartView.resetZoom();
    MapView.clearHighlight();
  });

  // Reset selection
  document.getElementById('sel-cancel-btn').addEventListener('click', () => {
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

  // Filters
  document.getElementById('btn-toggle-filters').addEventListener('click', () => {
    const panel = document.getElementById('filter-panel');
    panel.classList.toggle('hidden');
    document.getElementById('btn-toggle-filters').classList.toggle('active', !panel.classList.contains('hidden'));
  });

  const onFilterInput = (type, idx, e) => {
    const val = e.target.value;
    filters[type][idx] = (val === '' ? null : val);
    applyFilters();
    syncFiltersToUrl();
  };

  document.getElementById('filter-date-start').addEventListener('change', e => onFilterInput('date', 0, e));
  document.getElementById('filter-date-end').addEventListener('change', e => onFilterInput('date', 1, e));
  document.getElementById('filter-dist-min').addEventListener('input', e => onFilterInput('dist', 0, e));
  document.getElementById('filter-dist-max').addEventListener('input', e => onFilterInput('dist', 1, e));
  document.getElementById('filter-dur-min').addEventListener('input', e => onFilterInput('dur', 0, e));
  document.getElementById('filter-dur-max').addEventListener('input', e => onFilterInput('dur', 1, e));
  
  document.getElementById('filter-metrics').addEventListener('click', e => {
    const btn = e.target.closest('.mini-pill');
    if (!btn) return;
    const m = btn.dataset.metric;
    if (filters.metrics.has(m)) filters.metrics.delete(m);
    else filters.metrics.add(m);
    updateFilterUI();
    applyFilters();
    syncFiltersToUrl();
  });

  document.getElementById('btn-reset-filters').addEventListener('click', () => {
    filters = { date: [null, null], dist: [null, null], dur: [null, null], metrics: new Set() };
    updateFilterUI();
    applyFilters();
    syncFiltersToUrl();
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      MapView.hideCursor();
      MapView.closePopup?.();
      // Dismiss popups
      document.querySelectorAll('.color-picker-popup, .metric-menu-popup, .sort-menu-popup').forEach(el => el.remove());
    }
  });

  // Resize charts when window changes
  window.addEventListener('resize', () => ChartView.resize());
  }

  document.addEventListener('DOMContentLoaded', init);

  function showSortMenu(anchorEl) {
  document.querySelectorAll('.sort-menu-popup').forEach(el => el.remove());

  const popup = document.createElement('div');
  popup.className = 'sort-menu-popup';

  const options = [
    { value: 'date-desc', label: 'Date (Newest)', icon: 'calendar_today', arrow: 'arrow_downward' },
    { value: 'date-asc',  label: 'Date (Oldest)', icon: 'calendar_today', arrow: 'arrow_upward' },
    { value: 'dist-desc', label: 'Distance (Longest)', icon: 'route', arrow: 'arrow_downward' },
    { value: 'dist-asc',  label: 'Distance (Shortest)', icon: 'route', arrow: 'arrow_upward' },
    { value: 'dur-desc',  label: 'Duration (Longest)', icon: 'schedule', arrow: 'arrow_downward' },
    { value: 'dur-asc',   label: 'Duration (Shortest)', icon: 'schedule', arrow: 'arrow_upward' },
  ];

  options.forEach(opt => {
    const isActive = currentSort === opt.value;
    const item = document.createElement('div');
    item.className = `menu-item ${isActive ? 'active' : ''}`;
    item.innerHTML = `
      <span class="material-symbols-rounded">${opt.icon}</span>
      <span class="item-label">${opt.label}</span>
      <span class="material-symbols-rounded arrow">${opt.arrow}</span>
    `;

    item.addEventListener('click', () => {
      currentSort = opt.value;
      updateSearchSortUI();
      renderTrackList();
      UrlState.patch({ sort: currentSort });
      popup.remove();
    });
    popup.appendChild(item);
  });

  const rect = anchorEl.getBoundingClientRect();
  popup.style.cssText = `
    position: fixed;
    z-index: 10000;
    background: var(--surface2);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 6px;
    min-width: 180px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.5);
    left: ${rect.left}px;
    top: ${rect.bottom + 4}px;
  `;
  document.body.appendChild(popup);

  const dismiss = e => { if (!popup.contains(e.target) && e.target !== anchorEl) { popup.remove(); document.removeEventListener('click', dismiss); } };
  setTimeout(() => document.addEventListener('click', dismiss), 10);
  }

function applyFilters() {
  const ids = Object.keys(tracks);
  
  let regex = null;
  if (searchRegex && searchQuery) {
    try { regex = new RegExp(searchQuery, 'i'); } catch(e) {}
  }
  const query = searchQuery.toLowerCase();

  ids.forEach(id => {
    const t = tracks[id];
    const s = t.stats;
    const pts = t.points;
    const date = pts.length && pts[0].time ? new Date(pts[0].time).toISOString().split('T')[0] : null;
    
    let visible = true;
    
    // Search filter
    if (searchQuery) {
      if (regex) {
        if (!regex.test(t.name)) visible = false;
      } else {
        if (!t.name.toLowerCase().includes(query)) visible = false;
      }
    }

    // Date filter
    if (visible && filters.date[0] && date && date < filters.date[0]) visible = false;
    if (visible && filters.date[1] && date && date > filters.date[1]) visible = false;
    
    // Distance filter (m to km)
    const distKm = s.totalDist ? s.totalDist / 1000 : 0;
    if (visible && filters.dist[0] !== null && distKm < parseFloat(filters.dist[0])) visible = false;
    if (visible && filters.dist[1] !== null && distKm > parseFloat(filters.dist[1])) visible = false;
    
    // Duration filter (s to h)
    const durH = s.duration ? s.duration / 3600 : 0;
    if (visible && filters.dur[0] !== null && durH < parseFloat(filters.dur[0])) visible = false;
    if (visible && filters.dur[1] !== null && durH > parseFloat(filters.dur[1])) visible = false;
    
    // Metrics filter
    if (visible && filters.metrics.size > 0) {
      for (const m of filters.metrics) {
        const field = ChartView.METRICS[m].field;
        if (!t.points.some(p => p[field] != null)) {
          visible = false;
          break;
        }
      }
    }

    t._filtered = !visible;
    MapView.setTrackVisible(id, visible && t.visible);
  });
  
  renderTrackList();
  
  // If selected track is filtered out, clear charts
  if (selectedId && tracks[selectedId]._filtered) {
    ChartView.clear();
    const details = document.getElementById('details-view');
    if (details) details.innerHTML = '<div id="details-empty">Select a track for details</div>';
  }
}

function updateFilterUI() {
  document.getElementById('filter-date-start').value = filters.date[0] || '';
  document.getElementById('filter-date-end').value   = filters.date[1] || '';
  document.getElementById('filter-dist-min').value   = filters.dist[0] || '';
  document.getElementById('filter-dist-max').value   = filters.dist[1] || '';
  document.getElementById('filter-dur-min').value    = filters.dur[0] || '';
  document.getElementById('filter-dur-max').value    = filters.dur[1] || '';

  document.querySelectorAll('#filter-metrics .mini-pill').forEach(btn => {
    btn.classList.toggle('active', filters.metrics.has(btn.dataset.metric));
  });
}

function syncFiltersToUrl() {
  UrlState.patch({
    f_date: filters.date.every(v => v === null) ? null : filters.date.map(v => v || ''),
    f_dist: filters.dist.every(v => v === null) ? null : filters.dist.map(v => v || ''),
    f_dur:  filters.dur.every(v => v === null)  ? null : filters.dur.map(v => v || ''),
    f_mets: filters.metrics.size === 0 ? null : Array.from(filters.metrics),
  });
}

function syncMetricsToUrl() {
  const active = ChartView.getActiveMetrics();
  const metrics = ChartView.METRICS;
  const abbrs = Array.from(active).map(key => metrics[key].abbr);
  UrlState.patch({ metrics: abbrs.length ? abbrs : null });
}

function showMetricMenu(anchorEl) {
  document.querySelectorAll('.metric-menu-popup').forEach(el => el.remove());

  const popup = document.createElement('div');
  popup.className = 'metric-menu-popup';
  
  const metrics = ChartView.METRICS;
  const activeMetrics = ChartView.getActiveMetrics?.() || new Set(['elevation', 'speed']);
  const available = ChartView.getAvailableMetrics?.() || new Set(Object.keys(metrics));

  Object.entries(metrics).forEach(([key, def]) => {
    const isAvailable = available.has(key);
    const isActive = activeMetrics.has(key);
    
    const item = document.createElement('div');
    item.className = `menu-item ${isActive ? 'active' : ''} ${isAvailable ? '' : 'disabled'}`;
    item.innerHTML = `
      <span class="material-symbols-rounded">${def.icon}</span>
      <span class="item-label">${def.label}</span>
      <span class="material-symbols-rounded check">${isActive ? 'check' : ''}</span>
    `;
    
    if (isAvailable) {
      item.addEventListener('click', () => {
        ChartView.toggleMetric(key);
        syncMetricsToUrl();
        // Sync the main pill if it exists (hidden but should stay synced)
        const mainPill = document.querySelector(`.metric-pill[data-metric="${key}"]`);
        if (mainPill) mainPill.classList.toggle('active');
        popup.remove();
      });
    }
    popup.appendChild(item);
  });

  const rect = anchorEl.getBoundingClientRect();
  popup.style.cssText = `
    position: fixed;
    z-index: 10000;
    background: var(--surface2);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 6px;
    min-width: 160px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.5);
    left: ${rect.left}px;
    top: ${rect.bottom + 4}px;
  `;
  document.body.appendChild(popup);

  const dismiss = e => { if (!popup.contains(e.target) && e.target !== anchorEl) { popup.remove(); document.removeEventListener('click', dismiss); } };
  setTimeout(() => document.addEventListener('click', dismiss), 10);
}

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
  
  if (added)  {
    applyFilters(); // Render list and sync map
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
  const headerLabel = document.querySelector('.section-label');
  if (!list) return;

  const ids = Object.keys(tracks).filter(id => !tracks[id]._filtered);
  if (headerLabel) {
    headerLabel.textContent = `Tracks (${ids.length})`;
  }

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

  ids.sort((a, b) => {
    // Current selected always first
    if (a === selectedId) return -1;
    if (b === selectedId) return 1;

    const ta = tracks[a], tb = tracks[b];
    const sa = ta.stats, sb = tb.stats;

    switch (currentSort) {
      case 'date-asc':  return (sa.startTime || 0) - (sb.startTime || 0);
      case 'date-desc': return (sb.startTime || 0) - (sa.startTime || 0);
      case 'dist-asc':  return (sa.totalDist || 0) - (sb.totalDist || 0);
      case 'dist-desc': return (sb.totalDist || 0) - (sa.totalDist || 0);
      case 'dur-asc':   return (sa.duration || 0) - (sb.duration || 0);
      case 'dur-desc':  return (sb.duration || 0) - (sa.duration || 0);
      default: return 0;
    }
  }).forEach(id => {
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
    <div class="track-selection-marker"></div>
  `;

  // Select track
  item.addEventListener('click', e => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (!action) { selectTrack(track.id); return; }

    if (action === 'toggle-vis') {
      track.visible = !track.visible;
      MapView.setTrackVisible(track.id, track.visible && !track._filtered);
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
  
  // Fully reset metric coloring when switching tracks
  currentMapColors = null;
  MapView.clearMetricColor();
  ChartView.toggleMapColor(null); // Ensure ChartView state also resets
  
  UrlState.patch({ track: id, sel: null });

  // Update UI immediately
  renderTrackList();

  // Render details
  const activeTab = document.querySelector('.tab-btn.active').dataset.tab;
  if (activeTab === 'details') renderDetails(tracks[id]);

  // Tell sub-views
  MapView.setSelectedTrack(id, fit);
  if (fit) MapView.fitTrack(id);
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
    if (details) details.innerHTML = `
      <div id="details-empty" class="empty-state">
        <span class="material-symbols-rounded empty-icon">no_sim</span>
        <div class="empty-text">Select a track for details</div>
      </div>
    `;
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
  MapView.showCursorAt(pt.lat, pt.lon);
  if (followDot) {
    MapView.centerOn(pt.lat, pt.lon, null, true); // true = animate
  }
}

function onChartRangeChange(minX, maxX, xAxis) {
  UrlState.patch({ sel: (minX != null && maxX != null) ? [minX, maxX] : null });
  const track = tracks[selectedId];
  if (!track || minX == null || maxX == null) {
    MapView.clearHighlight();
    return;
  }
  const pts = track.points;
  let iMin, iMax;
  if (xAxis === 'distance') {
    const dMin = minX * 1000, dMax = maxX * 1000;
    iMin = pts.findIndex(p => (p.dist || 0) >= dMin);
    iMax = pts.findLastIndex(p => (p.dist || 0) <= dMax);
  } else {
    const t0 = pts[0].time || 0;
    const tMin = t0 + minX * 1000, tMax = t0 + maxX * 1000;
    iMin = pts.findIndex(p => p.time >= tMin);
    iMax = pts.findLastIndex(p => p.time <= tMax);
  }
  if (iMin !== -1 && iMax !== -1 && iMin < iMax) {
    MapView.highlightSegment(selectedId, pts, iMin, iMax, true, currentMapColors);
  } else {
    MapView.clearHighlight();
  }
}

function onChartClick(pt) {
  MapView.centerOn(pt.lat, pt.lon, POINT_ZOOM_LEVEL);
}

// ── Map Callbacks ─────────────────────────────────────────────────
function onMapMove(lat, lng, zoom) {
  UrlState.patch({ map_pos: [lat, lng, zoom] });
}

function onMapPointClick(trackId, ptIdx) {
  if (trackId !== selectedId) selectTrack(trackId, false);
  ChartView.setCursorAt(ptIdx);
}

function onMapDblClick() {
  ChartView.clearPinnedDot();
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
