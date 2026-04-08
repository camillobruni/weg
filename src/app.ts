'use strict';

// ── Main Application ──────────────────────────────────────────────

import { Storage } from './storage';
import { UrlState } from './url-state';
import { Parsers, TrackData, TrackPoint } from './parsers';
import { MapView } from './map';
import { ChartView, MetricDefinition } from './charts';

const TRACK_COLORS: string[] = [
  '#FF6B35',
  '#4ECDC4',
  '#45B7D1',
  '#F7DC6F',
  '#FF6B6B',
  '#BB8FCE',
  '#82E0AA',
  '#F8C471',
  '#3b82f6',
  '#ec4899',
  '#06b6d4',
  '#10b981',
  '#f59e0b',
  '#ef4444',
  '#8b5cf6',
];

let tracks: Record<string, TrackData> = {};
let colorIdx: number = 0;
let selectedId: string | null = null;
let currentMapColors: string[] | null = null;
let chartHeight: number = 400; // pixels for chart panel

interface Filters {
  date: (string | null)[];
  dist: (number | null)[];
  dur: (number | null)[];
  metrics: Set<string>;
}

let filters: Filters = {
  date: [null, null],
  dist: [null, null],
  dur: [null, null],
  metrics: new Set<string>(),
};

let searchQuery: string = '';
let searchRegex: boolean = false;
let currentSort: string = 'date-desc';
let followDot: boolean = false;

const POINT_ZOOM_LEVEL: number = 15;

// ── UI Components ─────────────────────────────────────────────────
function initResizeHandle() {
  const handle = document.getElementById('resize-handle');
  const panel = document.getElementById('chart-panel');
  if (!handle || !panel) return;

  let startY: number, startH: number;
  const onMove = (e: MouseEvent | TouchEvent) => {
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;
    const dy = startY - clientY;
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
  handle.addEventListener('mousedown', (e) => {
    startY = e.clientY;
    startH = panel.offsetHeight;
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
  handle.addEventListener('touchstart', (e) => {
    startY = e.touches[0].clientY;
    startH = panel.offsetHeight;
    document.addEventListener('touchmove', onMove);
    document.addEventListener('touchend', onUp);
  });
}

function initSidebarResizer() {
  const resizer = document.getElementById('sidebar-resizer');
  const sidebar = document.getElementById('sidebar');
  if (!resizer || !sidebar) return;

  let startX: number, startW: number;

  const onMove = (e: MouseEvent | TouchEvent) => {
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const newWidth = Math.max(150, Math.min(600, startW + (clientX - startX)));
    document.documentElement.style.setProperty('--sidebar-w', `${newWidth}px`);

    // Invalidate sub-view sizes as container changes
    MapView.invalidateSize();
    ChartView.resize();
    updateToolbarLayout();
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

  resizer.addEventListener('mousedown', (e) => {
    startX = e.clientX;
    startW = sidebar.offsetWidth;
    resizer.classList.add('dragging');
    document.body.classList.add('dragging-sidebar');
    document.body.style.cursor = 'col-resize';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  resizer.addEventListener('touchstart', (e) => {
    startX = e.touches[0].clientX;
    startW = sidebar.offsetWidth;
    resizer.classList.add('dragging');
    document.body.classList.add('dragging-sidebar');
    document.addEventListener('touchmove', onMove);
    document.addEventListener('touchend', onUp);
  });
}

function syncMetricsToUrl() {
  const active = ChartView.getActiveMetrics();
  const metrics = ChartView.METRICS;
  const abbrs = Array.from(active).map((key) => metrics[key].abbr);
  UrlState.patch({ metrics: abbrs.length ? abbrs : null });
}

function showMetricMenu(anchorEl: HTMLElement) {
  document.querySelectorAll('.metric-menu-popup').forEach((el) => el.remove());

  const popup = document.createElement('div');
  popup.className = 'metric-menu-popup';

  const metrics = ChartView.METRICS;
  const activeMetrics = ChartView.getActiveMetrics?.() || new Set(['elevation', 'speed']);
  const available = ChartView.getAvailableMetrics?.() || new Set(Object.keys(metrics));

  // Determine order: Active ones first (in their current order), then the rest
  const sortedKeys = Array.from(activeMetrics);
  Object.keys(metrics).forEach((k) => {
    if (!activeMetrics.has(k)) sortedKeys.push(k);
  });

  sortedKeys.forEach((key) => {
    const def = metrics[key];
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

  const dismiss = (e: MouseEvent) => {
    if (!popup.contains(e.target as Node) && e.target !== anchorEl) {
      popup.remove();
      document.removeEventListener('click', dismiss);
    }
  };
  setTimeout(() => document.addEventListener('click', dismiss), 10);
}

// ── Tab Navigation ─────────────────────────────────────────────────
document.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('.tab-btn') as HTMLElement;
  if (!btn) return;
  const nav = btn.closest('#tab-nav');
  if (!nav) return;

  // Toggle buttons
  nav.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b === btn));

  // Toggle contents
  const panel = nav.closest('#chart-panel');
  if (panel) {
    panel.querySelectorAll('.tab-content').forEach((c) => {
      c.classList.toggle('active', c.id === `tab-${btn.dataset.tab}`);
    });
  }

  if (btn.dataset.tab === 'details' && selectedId && tracks[selectedId]) {
    renderDetails(tracks[selectedId]);
  }

  if (btn.dataset.tab === 'graphs') {
    ChartView.resize();
    updateToolbarLayout();
  }
});

// ── Boot ──────────────────────────────────────────────────────────
async function init() {
  const urlState = UrlState.get();

  // Init sub-systems
  MapView.init((id) => selectTrack(id), onMapMove, onMapPointClick, onMapDblClick);
  ChartView.init(onChartCursorMove, onChartRangeChange, onChartClick);

  ChartView.setMapColorChangeCb((data) => {
    if (data) {
      currentMapColors = data.colors;
      if (selectedId) MapView.colorTrackByMetric(selectedId, data.pts, data.colors);
    } else {
      currentMapColors = null;
      if (selectedId) MapView.clearMetricColor(selectedId);
    }

    // Refresh highlight with new colors if a selection exists
    const currentUrlState = UrlState.get();
    if (currentUrlState.sel) {
      onChartRangeChange(currentUrlState.sel[0], currentUrlState.sel[1], ChartView.getXAxis());
    }
  });

  // Restore basemap
  if (urlState.map && typeof urlState.map === 'string') {
    MapView.switchBasemap(urlState.map);
    document
      .querySelectorAll('.bm-btn')
      .forEach((b) =>
        b.classList.toggle('active', (b as HTMLElement).dataset.layer === urlState.map),
      );
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
  document
    .querySelectorAll('#x-axis-ctrl .seg-btn')
    .forEach((b) => b.classList.toggle('active', (b as HTMLElement).dataset.axis === currentXAxis));

  // Restore active metrics
  if (urlState.metrics) {
    const metrics = ChartView.METRICS;
    const keys = urlState.metrics
      .map((abbr) => Object.keys(metrics).find((k) => metrics[k].abbr === abbr))
      .filter((k): k is string => k !== undefined);
    if (keys.length) ChartView.setActiveMetrics(keys);
  }

  // Restore filters
  if (urlState.f_date) filters.date = urlState.f_date.map((v) => v || null);
  if (urlState.f_dist) filters.dist = urlState.f_dist.map((v) => (v === 0 ? 0 : v || null));
  if (urlState.f_dur) filters.dur = urlState.f_dur.map((v) => (v === 0 ? 0 : v || null));
  if (urlState.f_mets) filters.metrics = new Set(urlState.f_mets);
  updateFilterUI();

  if (urlState.q) searchQuery = urlState.q;
  if (urlState.re) searchRegex = urlState.re;
  if (urlState.sort) currentSort = urlState.sort;
  updateSearchSortUI();

  // Load persisted tracks
  try {
    const saved = await Storage.getAll();
    saved.sort((a, b) => a.addedAt - b.addedAt);
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
    const restoreId =
      urlState.track && tracks[urlState.track]
        ? urlState.track
        : savedIds.length > 0
          ? savedIds[0]
          : null;

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
  } catch (e) {
    console.warn('Could not load saved tracks:', e);
  }

  // Panel resizers
  initResizeHandle();
  initSidebarResizer();
  initMetricPillDraggable();
  updateToolbarLayout();

  // Basemap switcher
  document.getElementById('basemap-switcher')?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('.bm-btn') as HTMLElement;
    if (!btn) return;
    document.querySelectorAll('.bm-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    if (btn.dataset.layer) {
      MapView.switchBasemap(btn.dataset.layer);
      UrlState.patch({ map: btn.dataset.layer });
    }
  });

  // Fit all
  document.getElementById('btn-fit-all')?.addEventListener('click', () => MapView.fitAll());

  // Clear all
  document.getElementById('btn-clear-all')?.addEventListener('click', clearAll);

  // Search
  document.getElementById('track-search')?.addEventListener('input', (e) => {
    searchQuery = (e.target as HTMLInputElement).value;
    applyFilters();
    UrlState.patch({ q: searchQuery || null });
  });

  document.getElementById('btn-regex-toggle')?.addEventListener('click', (e) => {
    searchRegex = !searchRegex;
    (e.target as HTMLElement).classList.toggle('active', searchRegex);
    applyFilters();
    UrlState.patch({ re: searchRegex ? 1 : null });
  });

  // Sort
  document.getElementById('btn-sort-menu')?.addEventListener('click', (e) => {
    e.stopPropagation();
    showSortMenu(e.currentTarget as HTMLElement);
  });

  // Metric menu toggle
  document.getElementById('btn-metric-menu')?.addEventListener('click', (e) => {
    e.stopPropagation();
    showMetricMenu(e.currentTarget as HTMLElement);
  });

  // Metric toggles (shared logic)
  const toggleMetric = (metric: string, pill: HTMLElement | null) => {
    if (pill) pill.classList.toggle('active');
    ChartView.toggleMetric(metric);
    syncMetricsToUrl();
  };

  document.getElementById('metric-pills')?.addEventListener('click', (e) => {
    const pill = (e.target as HTMLElement).closest('.metric-pill') as HTMLElement;
    if (pill) toggleMetric(pill.dataset.metric!, pill);
  });

  // X-axis toggle
  document.getElementById('x-axis-ctrl')?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('.seg-btn') as HTMLElement;
    if (!btn) return;
    const axis = btn.dataset.axis!;
    ChartView.setXAxis(axis);
    document
      .querySelectorAll('#x-axis-ctrl .seg-btn')
      .forEach((b) => b.classList.toggle('active', b === btn));
    UrlState.patch({ xaxis: axis });
  });

  // Follow dot
  document.getElementById('btn-follow-dot')?.addEventListener('click', (e) => {
    followDot = !followDot;
    (e.currentTarget as HTMLElement).classList.toggle('active', followDot);
  });

  // Reset zoom
  document.getElementById('btn-reset-zoom')?.addEventListener('click', () => {
    ChartView.resetZoom();
    MapView.clearHighlight();
  });

  // File drag/drop
  initDropZone();

  // File browse
  document.getElementById('file-input')?.addEventListener('change', (e) => {
    handleFiles(Array.from((e.target as HTMLInputElement).files || []));
    (e.target as HTMLInputElement).value = '';
  });
  document.getElementById('folder-input')?.addEventListener('change', (e) => {
    handleFiles(Array.from((e.target as HTMLInputElement).files || []));
    (e.target as HTMLInputElement).value = '';
  });

  // Filters
  document.getElementById('btn-toggle-filters')?.addEventListener('click', () => {
    const panel = document.getElementById('filter-panel');
    if (panel) {
      panel.classList.toggle('hidden');
      document
        .getElementById('btn-toggle-filters')
        ?.classList.toggle('active', !panel.classList.contains('hidden'));
    }
  });

  const onFilterInput = (type: 'date' | 'dist' | 'dur', idx: number, e: Event) => {
    const val = (e.target as HTMLInputElement).value;
    (filters[type] as any)[idx] = val === '' ? null : val;
    applyFilters();
    syncFiltersToUrl();
  };

  document
    .getElementById('filter-date-start')
    ?.addEventListener('change', (e) => onFilterInput('date', 0, e));
  document
    .getElementById('filter-date-end')
    ?.addEventListener('change', (e) => onFilterInput('date', 1, e));
  document
    .getElementById('filter-dist-min')
    ?.addEventListener('input', (e) => onFilterInput('dist', 0, e));
  document
    .getElementById('filter-dist-max')
    ?.addEventListener('input', (e) => onFilterInput('dist', 1, e));
  document
    .getElementById('filter-dur-min')
    ?.addEventListener('input', (e) => onFilterInput('dur', 0, e));
  document
    .getElementById('filter-dur-max')
    ?.addEventListener('input', (e) => onFilterInput('dur', 1, e));

  document.getElementById('filter-metrics')?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('.mini-pill') as HTMLElement;
    if (!btn) return;
    const m = btn.dataset.metric!;
    if (filters.metrics.has(m)) filters.metrics.delete(m);
    else filters.metrics.add(m);
    updateFilterUI();
    applyFilters();
    syncFiltersToUrl();
  });

  document.getElementById('btn-reset-filters')?.addEventListener('click', () => {
    filters = { date: [null, null], dist: [null, null], dur: [null, null], metrics: new Set() };
    updateFilterUI();
    applyFilters();
    syncFiltersToUrl();
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      MapView.hideCursor();
      MapView.closePopup?.();
      // Dismiss popups
      document
        .querySelectorAll('.color-picker-popup, .metric-menu-popup, .sort-menu-popup')
        .forEach((el) => el.remove());
    }
  });

  // Resize charts when window changes
  window.addEventListener('resize', () => {
    ChartView.resize();
    MapView.invalidateSize?.();
    updateToolbarLayout();
  });
}

function syncFiltersToUrl() {
  UrlState.patch({
    f_date: filters.date.every((v) => v === null) ? null : filters.date.map((v) => v || ''),
    f_dist: filters.dist.every((v) => v === null) ? null : filters.dist.map((v) => v || null),
    f_dur: filters.dur.every((v) => v === null) ? null : filters.dur.map((v) => v || null),
    f_mets: filters.metrics.size === 0 ? null : Array.from(filters.metrics),
  });
}

function applyFilters() {
  const ids = Object.keys(tracks);

  let regex: RegExp | null = null;
  if (searchRegex && searchQuery) {
    try {
      regex = new RegExp(searchQuery, 'i');
    } catch (e) {}
  }
  const query = searchQuery.toLowerCase();

  ids.forEach((id) => {
    const t = tracks[id];
    const s = t.stats;
    const pts = t.points;
    const date =
      pts.length && pts[0].time ? new Date(pts[0].time).toISOString().split('T')[0] : null;

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
    if (visible && filters.dist[0] !== null && distKm < (filters.dist[0] as number))
      visible = false;
    if (visible && filters.dist[1] !== null && distKm > (filters.dist[1] as number))
      visible = false;

    // Duration filter (s to h)
    const durH = s.duration ? s.duration / 3600000 : 0;
    if (visible && filters.dur[0] !== null && durH < (filters.dur[0] as number)) visible = false;
    if (visible && filters.dur[1] !== null && durH > (filters.dur[1] as number)) visible = false;

    // Metrics filter
    if (visible && filters.metrics.size > 0) {
      for (const m of filters.metrics) {
        const field = ChartView.METRICS[m].field;
        if (!t.points.some((p) => p[field] != null)) {
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
    if (details)
      details.innerHTML = `
      <div id="details-empty" class="empty-state">
        <span class="material-symbols-rounded empty-icon">no_sim</span>
        <div class="empty-text">Select a track for details</div>
      </div>
    `;
  }
}

function updateFilterUI() {
  (document.getElementById('filter-date-start') as HTMLInputElement).value = filters.date[0] || '';
  (document.getElementById('filter-date-end') as HTMLInputElement).value = filters.date[1] || '';
  (document.getElementById('filter-dist-min') as HTMLInputElement).value =
    filters.dist[0]?.toString() || '';
  (document.getElementById('filter-dist-max') as HTMLInputElement).value =
    filters.dist[1]?.toString() || '';
  (document.getElementById('filter-dur-min') as HTMLInputElement).value =
    filters.dur[0]?.toString() || '';
  (document.getElementById('filter-dur-max') as HTMLInputElement).value =
    filters.dur[1]?.toString() || '';

  document.querySelectorAll('#filter-metrics .mini-pill').forEach((el) => {
    const btn = el as HTMLElement;
    btn.classList.toggle('active', filters.metrics.has(btn.dataset.metric!));
  });
}

function updateSearchSortUI() {
  const searchEl = document.getElementById('track-search') as HTMLInputElement;
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

// ── Track list UI ─────────────────────────────────────────────────
function renderTrackList() {
  const list = document.getElementById('track-list');
  const emptyEl = document.getElementById('track-list-empty') as HTMLElement;
  const headerLabel = document.querySelector('.section-label');
  if (!list) return;

  const ids = Object.keys(tracks).filter((id) => !tracks[id]._filtered);
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

  ids
    .sort((a, b) => {
      // Current selected always first
      if (a === selectedId) return -1;
      if (b === selectedId) return 1;

      const ta = tracks[a],
        tb = tracks[b];
      const sa = ta.stats,
        sb = tb.stats;

      switch (currentSort) {
        case 'date-asc':
          return (sa.startTime || 0) - (sb.startTime || 0);
        case 'date-desc':
          return (sb.startTime || 0) - (sa.startTime || 0);
        case 'dist-asc':
          return (sa.totalDist || 0) - (sb.totalDist || 0);
        case 'dist-desc':
          return (sb.totalDist || 0) - (sa.totalDist || 0);
        case 'dur-asc':
          return (sa.duration || 0) - (sb.duration || 0);
        case 'dur-desc':
          return (sb.duration || 0) - (sa.duration || 0);
        default:
          return 0;
      }
    })
    .forEach((id) => {
      list.appendChild(buildTrackItem(tracks[id]));
    });
}

function buildTrackItem(track: TrackData) {
  const item = document.createElement('div');
  item.className = 'track-item' + (track.id === selectedId ? ' selected' : '');
  item.dataset.id = track.id;

  const date =
    track.points.length && track.points[0].time
      ? new Date(track.points[0].time).toLocaleDateString()
      : 'Unknown date';

  item.innerHTML = `
    <div class="track-color" style="background:${track.color}"></div>
    <div class="track-info">
      <div class="track-name">${escHtml(track.name)}</div>
      <div class="track-meta">
        <span>${date}</span>
        <span>${(track.stats.totalDist / 1000).toFixed(1)} km</span>
        <span class="badge">${track.format.toUpperCase()}</span>
      </div>
    </div>
    <button class="icon-btn mini toggle-vis" title="Toggle visibility">
      <span class="material-symbols-rounded">${track.visible ? 'visibility' : 'visibility_off'}</span>
    </button>
    <button class="icon-btn mini danger delete-track" title="Remove track">
      <span class="material-symbols-rounded">close</span>
    </button>
  `;

  item.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('.icon-btn')) return;
    selectTrack(track.id);
  });

  item.querySelector('.toggle-vis')?.addEventListener('click', (e) => {
    e.stopPropagation();
    track.visible = !track.visible;
    MapView.setTrackVisible(track.id, track.visible);
    renderTrackList();
  });

  item.querySelector('.delete-track')?.addEventListener('click', (e) => {
    e.stopPropagation();
    deleteTrack(track.id);
  });

  return item;
}

function showSortMenu(anchorEl: HTMLElement) {
  document.querySelectorAll('.sort-menu-popup').forEach((el) => el.remove());

  const popup = document.createElement('div');
  popup.className = 'sort-menu-popup';

  const options = [
    { value: 'date-desc', label: 'Date (Newest)', icon: 'calendar_today', arrow: 'arrow_downward' },
    { value: 'date-asc', label: 'Date (Oldest)', icon: 'calendar_today', arrow: 'arrow_upward' },
    { value: 'dist-desc', label: 'Distance (Longest)', icon: 'route', arrow: 'arrow_downward' },
    { value: 'dist-asc', label: 'Distance (Shortest)', icon: 'route', arrow: 'arrow_upward' },
    { value: 'dur-desc', label: 'Duration (Longest)', icon: 'schedule', arrow: 'arrow_downward' },
    { value: 'dur-asc', label: 'Duration (Shortest)', icon: 'schedule', arrow: 'arrow_upward' },
  ];

  options.forEach((opt) => {
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

  const dismiss = (e: MouseEvent) => {
    if (!popup.contains(e.target as Node) && e.target !== anchorEl) {
      popup.remove();
      document.removeEventListener('click', dismiss);
    }
  };
  setTimeout(() => document.addEventListener('click', dismiss), 10);
}

// ── Track actions ─────────────────────────────────────────────────
function selectTrack(id: string, fit = true) {
  if (!tracks[id]) return;
  selectedId = id;

  // Fully reset metric coloring when switching tracks
  currentMapColors = null;
  MapView.clearMetricColor(id);
  ChartView.toggleMapColor(null); // Ensure ChartView state also resets

  UrlState.patch({ track: id, sel: null });

  // Update UI immediately
  renderTrackList();

  // Render details
  const activeTabBtn = document.querySelector('.tab-btn.active') as HTMLElement;
  const activeTab = activeTabBtn ? activeTabBtn.dataset.tab : 'graphs';
  if (activeTab === 'details') renderDetails(tracks[id]);

  // Tell sub-views
  MapView.setSelectedTrack(id, fit);
  if (fit) MapView.fitTrack(id);
  ChartView.loadTrack(tracks[id]);
}

async function deleteTrack(id: string) {
  await Storage.remove(id);
  MapView.removeTrack(id);
  delete tracks[id];

  if (selectedId === id) {
    selectedId = null;
    UrlState.patch({ track: null, sel: null });
    ChartView.clear();
    const details = document.getElementById('details-view');
    if (details)
      details.innerHTML = `
      <div id="details-empty" class="empty-state">
        <span class="material-symbols-rounded empty-icon">no_sim</span>
        <div class="empty-text">Select a track for details</div>
      </div>
    `;
  }
  applyFilters();
}

async function clearAll() {
  if (!confirm('Remove all tracks?')) return;
  await Storage.clear();
  Object.keys(tracks).forEach((id) => MapView.removeTrack(id));
  tracks = {};
  selectedId = null;
  colorIdx = 0;
  UrlState.patch({ track: null, sel: null });
  ChartView.clear();
  applyFilters();
}

async function handleFiles(files: File[]) {
  if (!files.length) return;
  let count = 0;
  for (const f of files) {
    try {
      const data = await Parsers.parseFile(f);
      const id = crypto.randomUUID();
      const track: TrackData = {
        ...data,
        id,
        color: TRACK_COLORS[colorIdx % TRACK_COLORS.length],
        addedAt: Date.now(),
        visible: true,
      };
      colorIdx++;

      await Storage.save(track);
      tracks[id] = track;
      MapView.addTrack(track);
      count++;
    } catch (e) {
      console.warn('Failed to parse file:', f.name, e);
      showToast(`Error parsing ${f.name}`, 'error');
    }
  }
  if (count > 0) {
    applyFilters();
    if (count === 1) {
      const lastId = Object.keys(tracks).pop();
      if (lastId) selectTrack(lastId);
    } else {
      MapView.fitAll();
    }
    showToast(`Loaded ${count} track${count > 1 ? 's' : ''}`);
  }
}

// ── Drag & Drop ───────────────────────────────────────────────────
function readDirEntries(reader: any): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const results: any[] = [];
    const readBatch = () =>
      reader.readEntries((batch: any[]) => {
        if (!batch.length) {
          resolve(results);
          return;
        }
        results.push(...batch);
        readBatch();
      }, reject);
    readBatch();
  });
}

async function collectEntry(entry: any): Promise<File[]> {
  if (entry.isFile) {
    return new Promise((resolve, reject) => entry.file(resolve, reject)).then((f) => [f as File]);
  }
  const reader = entry.createReader();
  const entries = await readDirEntries(reader);
  const results = await Promise.allSettled(entries.map(collectEntry));
  return results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
}

async function collectDroppedFiles(dataTransfer: DataTransfer): Promise<File[]> {
  // entries must be captured synchronously before the event is released
  const items = Array.from(dataTransfer.items || []);
  const entries = items.map((i) => i.webkitGetAsEntry?.()).filter(Boolean);

  if (entries.length) {
    const results = await Promise.allSettled(entries.map(collectEntry));
    return results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  }
  return Array.from(dataTransfer.files);
}

function initDropZone() {
  const zone = document.getElementById('drop-zone');
  if (!zone) return;

  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.className = 'drop-active';
  });
  zone.addEventListener('dragleave', () => {
    zone.className = 'drop-idle';
  });
  zone.addEventListener('drop', async (e) => {
    e.preventDefault();
    zone.className = 'drop-idle';
    if (e.dataTransfer) {
      const files = await collectDroppedFiles(e.dataTransfer);
      handleFiles(files);
    }
  });

  zone.addEventListener('click', (e) => {
    const input = document.getElementById('file-input');
    if (!input) return;
    // If user clicked the folder-input or its label, let the browser handle it.
    if (
      (e.target as HTMLElement).closest('#folder-label') ||
      (e.target as HTMLElement).closest('#folder-input')
    ) {
      return;
    }
    if (e.target !== input) input.click();
  });
}

// ── Helpers ───────────────────────────────────────────────────
function renderDetails(track: TrackData) {
  const container = document.getElementById('details-view');
  if (!container) return;

  const s = track.stats;
  const date =
    track.points.length && track.points[0].time
      ? new Date(track.points[0].time).toLocaleString()
      : '—';

  container.innerHTML = `
    <div id="details-header">
      <div class="details-title">${escHtml(track.name)}</div>
      <div class="details-subtitle">${date} ${track.device ? '· ' + escHtml(track.device) : ''}</div>
    </div>
    <div class="details-grid">
      <div class="details-card">
        <span class="material-symbols-rounded">route</span>
        <div class="details-card-label">Distance</div>
        <div class="details-card-value">${(s.totalDist / 1000).toFixed(2)} km</div>
      </div>
      <div class="details-card">
        <span class="material-symbols-rounded">schedule</span>
        <div class="details-card-label">Duration</div>
        <div class="details-card-value">${s.duration ? fmtSecs(Math.floor(s.duration / 1000)) : '—'}</div>
      </div>
      <div class="details-card">
        <span class="material-symbols-rounded">height</span>
        <div class="details-card-label">Elevation</div>
        <div class="details-card-value">+${Math.round(s.elevGain)}m / -${Math.round(s.elevLoss)}m</div>
      </div>
      <div class="details-card">
        <span class="material-symbols-rounded">speed</span>
        <div class="details-card-label">Avg Speed</div>
        <div class="details-card-value">${s.avgSpeed ? (s.avgSpeed * 3.6).toFixed(1) : '—'} km/h</div>
      </div>
      ${
        s.avgPower
          ? `
      <div class="details-card">
        <span class="material-symbols-rounded">bolt</span>
        <div class="details-card-label">Avg Power</div>
        <div class="details-card-value">${s.avgPower} W (Max ${s.maxPower}W)</div>
      </div>`
          : ''
      }
      ${
        s.avgHR
          ? `
      <div class="details-card">
        <span class="material-symbols-rounded">favorite</span>
        <div class="details-card-label">Avg HR</div>
        <div class="details-card-value">${s.avgHR} bpm (Max ${s.maxHR}bpm)</div>
      </div>`
          : ''
      }
    </div>
  `;
}

function fmtSecs(s: number) {
  const h = Math.floor(s / 3600),
    m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
}

function escHtml(str: string) {
  const p = document.createElement('p');
  p.textContent = str;
  return p.innerHTML;
}

// ── Chart Callbacks ───────────────────────────────────────────────
function onChartCursorMove(pt: TrackPoint) {
  MapView.showCursorAt(pt.lat, pt.lon);
  if (followDot) {
    MapView.centerOn(pt.lat, pt.lon, null, true); // true = animate
  }
}

function onChartRangeChange(minX: number | null, maxX: number | null, xAxis: string) {
  const track = tracks[selectedId!];
  if (!track || minX == null || maxX == null) {
    UrlState.patch({ sel: null });
    MapView.clearHighlight();
    return;
  }
  const pts = track.points;
  let iMin, iMax;
  if (xAxis === 'distance') {
    const dMin = minX * 1000,
      dMax = maxX * 1000;
    iMin = pts.findIndex((p) => (p.dist || 0) >= dMin);
    iMax = pts.findLastIndex((p) => (p.dist || 0) <= dMax);
  } else {
    const t0 = pts[0].time || 0;
    const tMin = t0 + minX * 1000,
      tMax = t0 + maxX * 1000;
    iMin = pts.findIndex((p) => (p.time || 0) >= tMin);
    iMax = pts.findLastIndex((p) => (p.time || 0) <= tMax);
  }

  // Always save time-based selection to URL
  if (iMin !== -1 && iMax !== -1) {
    const t0 = pts[0].time || 0;
    const tMin = ((pts[iMin].time || t0) - t0) / 1000;
    const tMax = ((pts[iMax].time || t0) - t0) / 1000;
    UrlState.patch({ sel: [tMin, tMax] });
  }

  if (iMin !== -1 && iMax !== -1 && iMin < iMax) {
    MapView.highlightSegment(selectedId!, pts, iMin, iMax, true, currentMapColors);
  } else {
    MapView.clearHighlight();
  }
}

function onChartClick(pt: TrackPoint) {
  MapView.centerOn(pt.lat, pt.lon, POINT_ZOOM_LEVEL);
}

// ── Map Callbacks ─────────────────────────────────────────────────
function onMapMove(lat: number, lng: number, zoom: number) {
  UrlState.patch({ map_pos: [lat, lng, zoom] });
}

function onMapPointClick(trackId: string, ptIdx: number) {
  if (trackId !== selectedId) selectTrack(trackId, false);
  ChartView.setCursorAt(ptIdx);
}

function onMapDblClick() {
  ChartView.clearPinnedDot();
}

function showToast(msg: string, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 400);
  }, 3000);
}

function updateToolbarLayout() {
  const toolbar = document.getElementById('chart-toolbar');
  const pills = document.getElementById('metric-pills');
  if (!toolbar || !pills) return;

  // We temporarily remove "collapsed" to measure the FULL width needed by pills
  const wasCollapsed = toolbar.classList.contains('collapsed');
  toolbar.classList.remove('collapsed');

  // Comparison: scrollWidth (needed) vs clientWidth (available in toolbar)
  const hasOverflow = pills.scrollWidth > pills.clientWidth;

  if (hasOverflow) {
    toolbar.classList.add('collapsed');
  }
  // Otherwise it stays uncollapsed
}

function initMetricPillDraggable() {
  const container = document.getElementById('metric-pills');
  if (!container) return;

  let draggedEl: HTMLElement | null = null;

  container.addEventListener('dragstart', (e) => {
    const target = (e.target as HTMLElement).closest('.metric-pill') as HTMLElement;
    if (!target) return;
    draggedEl = target;
    e.dataTransfer!.effectAllowed = 'move';
    target.classList.add('dragging-pill');
    // For transparent background in ghost image
    setTimeout(() => target.style.opacity = '0.4', 0);
  });

  container.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'move';
    const target = (e.target as HTMLElement).closest('.metric-pill') as HTMLElement;
    if (target && target !== draggedEl) {
      const rect = target.getBoundingClientRect();
      const next = (e.clientX - rect.left) > (rect.width / 2);
      container.insertBefore(draggedEl!, next ? target.nextSibling : target);
    }
  });

  container.addEventListener('dragend', () => {
    if (!draggedEl) return;
    draggedEl.classList.remove('dragging-pill');
    draggedEl.style.opacity = '';
    draggedEl = null;

    // Update Chart order
    const keys = Array.from(container.querySelectorAll('.metric-pill')).map(
      (el) => (el as HTMLElement).dataset.metric!,
    );
    ChartView.updateMetricOrder(keys);
    syncMetricsToUrl();
  });
}

document.addEventListener('DOMContentLoaded', init);
