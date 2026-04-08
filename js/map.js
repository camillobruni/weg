'use strict';

// ── Map View (Leaflet) ─────────────────────────────────────────────

const MapView = (() => {
  let map, cursorMarker, highlightLine;
  let polylines = {};      // id → L.Polyline
  let trackData = {};      // id → track
  let selectedId = null;
  let selectedOutline = null;
  let metricColorLayer = null;   // featureGroup of colored segments
  let metricColorId    = null;   // track id currently colored by metric
  let onSelectCb     = null;
  let onPointClickCb = null;
  let onMoveCb       = null;
  let onDblClickCb   = null;

  const GAP_THRESHOLD = 60000; // 1 minute in ms

  // Tile layers
  const LAYERS = {
    swisstopo: L.tileLayer(
      'https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.pixelkarte-farbe/default/current/3857/{z}/{x}/{y}.jpeg',
      { attribution: '© <a href="https://www.swisstopo.admin.ch" target="_blank">swisstopo</a>', maxZoom: 19 }
    ),
    osm: L.tileLayer(
      'https://{s}.tile.openstreetmap.fr/osmfr/{z}/{x}/{y}.png',
      { attribution: '© <a href="https://openstreetmap.org">OpenStreetMap</a> contributors', maxZoom: 20 }
    ),
    opentopomap: L.tileLayer(
      'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
      { attribution: 'Map data: © <a href="https://openstreetmap.org/copyright">OpenStreetMap</a> contributors, <a href="http://viewfinderpanoramas.org">SRTM</a> | Map style: © <a href="https://opentopomap.org">OpenTopoMap</a> (<a href="https://creativecommons.org/licenses/by-sa/3.0/">CC-BY-SA</a>)', maxZoom: 17 }
    ),
    satellite: L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      { attribution: '© Esri', maxZoom: 19 }
    ),
  };

  function init(onSelect, onMove, onPointClick, onDblClick) {
    onSelectCb     = onSelect;
    onMoveCb       = onMove;
    onPointClickCb = onPointClick;
    onDblClickCb   = onDblClick;

    map = L.map('map', {
      center: [46.8, 8.3],
      zoom: 8,
      zoomControl: true,
      attributionControl: true,
      doubleClickZoom: false, // Disable default so we can use it
    });

    LAYERS.swisstopo.addTo(map);

    // Cursor marker (hidden by default)
    const dotIcon = L.divIcon({ className: 'cursor-marker-dot', iconSize: [10,10], iconAnchor: [5,5] });
    cursorMarker = L.marker([0,0], { icon: dotIcon, zIndexOffset: 1000 });

    // Map click → find nearest tracks
    map.on('click', handleMapClick);

    // Map dblclick → callback (e.g., clear highlights)
    map.on('dblclick', () => {
      if (onDblClickCb) onDblClickCb();
    });

    // Mouse position in status bar
    map.on('mousemove', e => {
      const el = document.getElementById('map-cursor-info');
      el.textContent = `${e.latlng.lat.toFixed(5)}, ${e.latlng.lng.toFixed(5)}`;
      el.classList.add('visible');
    });
    map.on('mouseout', () => {
      document.getElementById('map-cursor-info').classList.remove('visible');
    });

    map.on('moveend zoomend', () => {
      if (onMoveCb) {
        const c = map.getCenter();
        onMoveCb(c.lat, c.lng, map.getZoom());
      }
    });
  }

  function getPosition() {
    const c = map.getCenter();
    return [c.lat, c.lng, map.getZoom()];
  }

  function setPosition(lat, lng, zoom) {
    map.setView([lat, lng], zoom, { animate: false });
  }

  function switchBasemap(key) {
    Object.values(LAYERS).forEach(l => { if (map.hasLayer(l)) map.removeLayer(l); });
    (LAYERS[key] || LAYERS.osm).addTo(map);
  }

  // ── Track rendering ──────────────────────────────────────────
  function addTrack(track) {
    trackData[track.id] = track;
    const pts = track.points;
    const layers = [];
    
    let currentSegment = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (i > 0) {
        const prev = pts[i-1];
        const dt = (p.time && prev.time) ? p.time - prev.time : 0;
        
        if (dt > GAP_THRESHOLD) {
          // Finish current segment
          if (currentSegment.length > 1) {
            layers.push(L.polyline(currentSegment, { color: track.color, weight: 3, opacity: 0.2 }));
          }
          // Draw dotted line for gap
          layers.push(L.polyline([[prev.lat, prev.lon], [p.lat, p.lon]], {
            color: track.color, weight: 2, opacity: 0.15, dashArray: '5, 8'
          }));
          currentSegment = [];
        }
      }
      currentSegment.push([p.lat, p.lon]);
    }
    if (currentSegment.length > 1) {
      layers.push(L.polyline(currentSegment, { color: track.color, weight: 3, opacity: 0.2 }));
    }

    const group = L.featureGroup(layers).addTo(map);
    group.on('click', e => {
      L.DomEvent.stopPropagation(e);
      if (onSelectCb) onSelectCb(track.id);
    });
    polylines[track.id] = group;
  }

  function colorTrackByMetric(id, pts, colors) {
    clearMetricColor();
    if (!pts || !colors || !pts.length) return;
    metricColorId = id;

    const segs = [];
    for (let i = 1; i < pts.length; i++) {
      if (!pts[i-1] || !pts[i]) continue;
      const dt = (pts[i].time && pts[i-1].time) ? pts[i].time - pts[i-1].time : 0;
      const c = colors[i] || colors[i-1] || '#888896';
      
      if (dt > GAP_THRESHOLD) {
        segs.push(L.polyline(
          [[pts[i-1].lat, pts[i-1].lon], [pts[i].lat, pts[i].lon]],
          { color: '#888896', weight: 2, opacity: 0.5, dashArray: '4, 6', interactive: false }
        ));
      } else {
        segs.push(L.polyline(
          [[pts[i-1].lat, pts[i-1].lon], [pts[i].lat, pts[i].lon]],
          { color: c, weight: 4, opacity: 0.9, interactive: false }
        ));
      }
    }
    metricColorLayer = L.featureGroup(segs).addTo(map);

    // Hide the regular polyline so only colored segments show
    if (polylines[id]) polylines[id].setStyle({ opacity: 0 });

    // Ensure ordering: outline behind, metric layer on top
    if (selectedOutline) selectedOutline.bringToFront();
    metricColorLayer.bringToFront();
    if (highlightLine && map.hasLayer(highlightLine)) highlightLine.bringToFront();
  }

  function clearMetricColor() {
    if (metricColorLayer) { map.removeLayer(metricColorLayer); metricColorLayer = null; }
    const id = metricColorId;
    metricColorId = null;
    if (id && polylines[id]) {
      const isSelected = id === selectedId;
      polylines[id].setStyle({ opacity: isSelected ? 0.4 : 0.15 });
    }
  }

  function removeTrack(id) {
    if (id === metricColorId) clearMetricColor();
    if (polylines[id]) { map.removeLayer(polylines[id]); delete polylines[id]; }
    delete trackData[id];
    if (id === selectedId) {
      if (selectedOutline) { map.removeLayer(selectedOutline); selectedOutline = null; }
      selectedId = null;
    }
  }

  function setTrackVisible(id, visible) {
    const pl = polylines[id];
    if (!pl) return;
    if (visible) pl.addTo(map);
    else         map.removeLayer(pl);
    
    if (id === selectedId) _syncOutline();
  }

  function setTrackColor(id, color) {
    if (polylines[id]) polylines[id].setStyle({ color });
    if (trackData[id]) trackData[id].color = color;
  }

  function setSelectedTrack(id) {
    selectedId = id;

    // Raise selected, dim others
    Object.entries(polylines).forEach(([pid, pl]) => {
      if (pid === id) {
        pl.setStyle({ weight: 5, opacity: 0.4 });
        pl.bringToFront();
      } else {
        pl.setStyle({ weight: 3, opacity: 0.15 });
      }
    });
    _syncOutline();

    // Keep metric-colored track's polyline hidden; bring metric layer to front
    if (metricColorId && polylines[metricColorId]) {
      polylines[metricColorId].setStyle({ opacity: 0 });
    }
    if (metricColorLayer) metricColorLayer.bringToFront();
  }

  // Manage the black outline for the selected track
  function _syncOutline() {
    if (selectedOutline) {
      map.removeLayer(selectedOutline);
      selectedOutline = null;
    }

    const pl = polylines[selectedId];
    const track = trackData[selectedId];
    if (selectedId && pl && track && map.hasLayer(pl)) {
      const latlngs = track.points.map(p => [p.lat, p.lon]);
      selectedOutline = L.polyline(latlngs, {
        color: '#000000',
        weight: 7,
        opacity: 0.65,
        interactive: false,
      }).addTo(map);
      
      // Keep it exactly behind the colored line
      selectedOutline.bringToFront();
      pl.bringToFront();
    }
    
    // Ensure segment highlight stays on top of both
    if (highlightLine && map.hasLayer(highlightLine)) {
      highlightLine.bringToFront();
    }
  }

  function fitAll() {
    const all = Object.values(polylines).filter(pl => map.hasLayer(pl));
    if (!all.length) return;
    const group = L.featureGroup(all);
    map.fitBounds(group.getBounds().pad(0.05));
  }

  function fitTrack(id) {
    if (polylines[id]) map.fitBounds(polylines[id].getBounds().pad(0.05));
  }

  function fitSegment(latlngs) {
    if (!latlngs || latlngs.length < 2) return;
    const bounds = L.latLngBounds(latlngs);
    map.fitBounds(bounds.pad(0.15), { animate: true });
  }

  // ── Chart-selection highlight segment ────────────────────────
  // pts: full points array, iMin/iMax: indices of visible range
  function highlightSegment(id, pts, iMin, iMax, fit = false, colors = null) {
    clearHighlight();
    if (!pts || iMin >= iMax) return;
    const latlngs = pts.slice(iMin, iMax + 1).map(p => [p.lat, p.lon]);
    if (latlngs.length < 2) return;

    if (fit) fitSegment(latlngs);

    const trackColor = trackData[id]?.color || '#fff';
    
    // Triple layer for maximum pronunciation: Black -> White -> Color
    const bgBlack = L.polyline(latlngs, {
      color: '#000000',
      weight: 14,
      opacity: 0.5,
      interactive: false,
    });
    
    const bgWhite = L.polyline(latlngs, {
      color: '#ffffff',
      weight: 9,
      opacity: 0.9,
      interactive: false,
    });
    
    // Inner segments: handle both metric coloring and gaps
    const innerSegs = [];
    for (let i = iMin + 1; i <= iMax; i++) {
      const p0 = pts[i-1], p1 = pts[i];
      const dt = (p1.time && p0.time) ? p1.time - p0.time : 0;
      
      const c = (colors && colors[i]) ? colors[i] : trackColor;
      const isGap = dt > GAP_THRESHOLD;
      
      innerSegs.push(L.polyline(
        [[p0.lat, p0.lon], [p1.lat, p1.lon]],
        {
          color: isGap ? '#888896' : c,
          weight: 6,
          opacity: 1,
          dashArray: isGap ? '4, 6' : null,
          interactive: false
        }
      ));
    }
    const inner = L.featureGroup(innerSegs);

    // Start/End markers (Monochrome)
    const startIcon = L.divIcon({
      className: 'sel-marker-start',
      html: `<span class="material-symbols-rounded" style="color:#fff; font-size:20px; font-variation-settings:'FILL' 1; filter: drop-shadow(0 0 1px #000) drop-shadow(0 0 2px #000)">play_circle</span>`,
      iconSize: [20, 20],
      iconAnchor: [10, 10],
    });
    const endIcon = L.divIcon({
      className: 'sel-marker-end',
      html: `<span class="material-symbols-rounded" style="color:#fff; font-size:20px; font-variation-settings:'FILL' 1; filter: drop-shadow(0 0 1px #000) drop-shadow(0 0 2px #000)">stop_circle</span>`,
      iconSize: [20, 20],
      iconAnchor: [10, 10],
    });

    const mStart = L.marker([pts[iMin].lat, pts[iMin].lon], { icon: startIcon, interactive: false });
    const mEnd   = L.marker([pts[iMax].lat, pts[iMax].lon], { icon: endIcon, interactive: false });

    // Group them on the highlightLine variable for easy removal
    highlightLine = L.featureGroup([bgBlack, bgWhite, inner, mStart, mEnd]).addTo(map);
    highlightLine.bringToFront();
  }

  function clearHighlight() {
    if (highlightLine) {
      map.removeLayer(highlightLine);
      highlightLine = null;
    }
  }

  // ── Cursor marker (driven by chart hover) ────────────────────
  function showCursorAt(lat, lon) {
    if (!cursorMarker) return;
    cursorMarker.setLatLng([lat, lon]);
    if (!map.hasLayer(cursorMarker)) cursorMarker.addTo(map);
  }

  function hideCursor() {
    if (cursorMarker && map.hasLayer(cursorMarker)) map.removeLayer(cursorMarker);
  }

  function centerOn(lat, lon, zoom, animate = true) {
    // Ensure Leaflet has the latest container dimensions before centering
    map.invalidateSize();
    if (zoom) {
      map.setView([lat, lon], zoom, { animate });
    } else {
      map.panTo([lat, lon], { animate });
    }
  }

  function invalidateSize() {
    if (map) map.invalidateSize();
  }

  // ── Nearest-track popup ───────────────────────────────────────
  function handleMapClick(e) {
    const { lat, lng } = e.latlng;
    const ids = Object.keys(trackData);
    if (!ids.length) return;

    // For each track find nearest point
    const results = ids.map(id => {
      const track = trackData[id];
      if (!polylines[id] || !map.hasLayer(polylines[id])) return null;
      let minDist = Infinity, nearestIdx = 0;
      track.points.forEach((p, i) => {
        const d = haversine(lat, p.lat, lng, p.lon);
        if (d < minDist) { minDist = d; nearestIdx = i; }
      });
      return { id, track, dist: minDist, nearestIdx };
    }).filter(Boolean).sort((a,b) => a.dist - b.dist);

    // Only show tracks within 500m (or the 3 closest regardless)
    const shown = results.slice(0, Math.min(results.length, 5)).filter(
      (r, i) => i < 3 || r.dist < 500
    );
    if (!shown.length) return;

    // Build popup HTML
    let html = `<div class="nearest-popup"><h4>Nearby Tracks</h4>`;
    shown.forEach(({ id, track, dist }) => {
      const distStr = dist < 1000 ? `${Math.round(dist)}m` : `${(dist/1000).toFixed(1)}km`;
      html += `<div class="nearest-item" data-id="${id}">
        <span class="nearest-dot" style="background:${track.color}"></span>
        <span class="nearest-name">${escHtml(track.name)}</span>
        <span class="nearest-dist">${distStr}</span>
      </div>`;
    });
    html += `</div>`;

    const popup = L.popup({ maxWidth: 280, className: '' })
      .setLatLng([lat, lng])
      .setContent(html)
      .openOn(map);

    // Wire up click handlers after popup is in DOM
    setTimeout(() => {
      document.querySelectorAll('.nearest-item').forEach(el => {
        el.addEventListener('click', () => {
          map.closePopup();
          const result = shown.find(r => r.id === el.dataset.id);
          if (onSelectCb) onSelectCb(el.dataset.id);
          if (result && onPointClickCb) onPointClickCb(el.dataset.id, result.nearestIdx);
        });
      });
    }, 50);
  }

  function haversine(lat1, lat2, lon1, lon2) {
    const R  = 6371000;
    const φ1 = lat1 * Math.PI / 180, φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;
    const a  = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  }

  function escHtml(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function closePopup() {
    if (map) map.closePopup();
  }

  return {
    init,
    switchBasemap,
    addTrack,
    removeTrack,
    setTrackVisible,
    setTrackColor,
    setSelectedTrack,
    fitAll,
    fitTrack,
    showCursorAt,
    hideCursor,
    highlightSegment,
    clearHighlight,
    centerOn,
    closePopup,
    invalidateSize,
    getPosition,
    setPosition,
    colorTrackByMetric,
    clearMetricColor,
  };
})();
