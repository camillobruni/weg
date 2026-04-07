'use strict';

// ── Map View (Leaflet) ─────────────────────────────────────────────

const MapView = (() => {
  let map, cursorMarker, highlightLine;
  let polylines = {};      // id → L.Polyline
  let trackData = {};      // id → track
  let selectedId = null;
  let selectedOutline = null;
  let onSelectCb     = null;
  let onPointClickCb = null;

  // Tile layers
  const LAYERS = {
    swisstopo: L.tileLayer(
      'https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.pixelkarte-farbe/default/current/3857/{z}/{x}/{y}.jpeg',
      { attribution: '© <a href="https://www.swisstopo.admin.ch" target="_blank">swisstopo</a>', maxZoom: 19 }
    ),
    'swisstopo-gray': L.tileLayer(
      'https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.pixelkarte-grau/default/current/3857/{z}/{x}/{y}.jpeg',
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

  let onMoveCb = null;

  function init(onSelect, onMove, onPointClick) {
    onSelectCb     = onSelect;
    onMoveCb       = onMove;
    onPointClickCb = onPointClick;

    map = L.map('map', {
      center: [46.8, 8.3],
      zoom: 8,
      zoomControl: true,
      attributionControl: true,
    });

    LAYERS.swisstopo.addTo(map);

    // Cursor marker (hidden by default)
    const dotIcon = L.divIcon({ className: 'cursor-marker-dot', iconSize: [10,10], iconAnchor: [5,5] });
    cursorMarker = L.marker([0,0], { icon: dotIcon, zIndexOffset: 1000 });

    // Map click → find nearest tracks
    map.on('click', handleMapClick);

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
    const latlngs = track.points.map(p => [p.lat, p.lon]);
    const pl = L.polyline(latlngs, {
      color: track.color,
      weight: 3,
      opacity: 0.85,
    });
    pl.addTo(map);
    pl.on('click', e => {
      L.DomEvent.stopPropagation(e);
      if (onSelectCb) onSelectCb(track.id);
    });
    polylines[track.id] = pl;
  }

  function removeTrack(id) {
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
        pl.setStyle({ weight: 4, opacity: 1 });
        pl.bringToFront();
      } else {
        pl.setStyle({ weight: 2, opacity: 0.45 });
      }
    });

    _syncOutline();
  }

  // Manage the black outline for the selected track
  function _syncOutline() {
    if (selectedOutline) {
      map.removeLayer(selectedOutline);
      selectedOutline = null;
    }

    const pl = polylines[selectedId];
    if (selectedId && pl && map.hasLayer(pl)) {
      selectedOutline = L.polyline(pl.getLatLngs(), {
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
      if (highlightLine._innerLine) highlightLine._innerLine.bringToFront();
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
  function highlightSegment(id, pts, iMin, iMax, fit = false) {
    clearHighlight();
    if (!pts || iMin >= iMax) return;
    const latlngs = pts.slice(iMin, iMax + 1).map(p => [p.lat, p.lon]);
    if (latlngs.length < 2) return;

    if (fit) fitSegment(latlngs);

    const trackColor = trackData[id]?.color || '#fff';
    highlightLine = L.polyline(latlngs, {
      color: '#ffffff',
      weight: 5,
      opacity: 0.9,
      dashArray: null,
      className: 'highlight-segment',
    });
    // Draw a coloured inner line on top
    const inner = L.polyline(latlngs, {
      color: trackColor,
      weight: 3,
      opacity: 1,
    });
    // Group them so we can remove both
    highlightLine._innerLine = inner;
    highlightLine.addTo(map);
    inner.addTo(map);
  }

  function clearHighlight() {
    if (highlightLine) {
      if (map.hasLayer(highlightLine)) map.removeLayer(highlightLine);
      if (highlightLine._innerLine && map.hasLayer(highlightLine._innerLine)) {
        map.removeLayer(highlightLine._innerLine);
      }
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

  function centerOn(lat, lon) {
    // Ensure Leaflet has the latest container dimensions before centering
    map.invalidateSize();
    map.panTo([lat, lon], { animate: true });
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
    // If there's only one nearby track (or one is already selected), fire
    // the point-click callback immediately without waiting for popup selection.
    const alreadySelected = shown.find(r => r.id === shown[0].id);
    if (alreadySelected && onPointClickCb) {
      onPointClickCb(alreadySelected.id, alreadySelected.nearestIdx);
    }

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
  };
})();
