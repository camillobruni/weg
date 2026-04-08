'use strict';

// ── Map View (Leaflet) ─────────────────────────────────────────────

import L from 'leaflet';
import { TrackData, TrackPoint } from './parsers';

export const MapView = (() => {
  let map: L.Map, cursorMarker: L.Marker, highlightLine: L.FeatureGroup | null;
  let polylines: Record<string, L.FeatureGroup> = {}; // id → L.FeatureGroup
  let trackData: Record<string, TrackData> = {}; // id → TrackData
  let selectedId: string | null = null;
  let selectedOutline: L.Polyline | null = null;

  let onSelectCb: (id: string) => void;
  let onMoveCb: (lat: number, lng: number, zoom: number) => void;
  let onPointClickCb: (id: string, idx: number) => void;
  let onDblClickCb: () => void;

  const GAP_THRESHOLD = 60000; // 1 minute in ms

  // Tile layers
  const LAYERS: Record<string, L.TileLayer> = {
    swisstopo: L.tileLayer(
      'https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.pixelkarte-farbe/default/current/3857/{z}/{x}/{y}.jpeg',
      {
        attribution: '&copy; swisstopo',
        maxZoom: 18,
      },
    ),
    opentopomap: L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenTopoMap contributors',
      maxZoom: 17,
    }),
    osm: L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
    }),
    satellite: L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      {
        attribution: '&copy; Esri',
      },
    ),
  };

  function init(
    onSelect: (id: string) => void,
    onMove: (lat: number, lng: number, zoom: number) => void,
    onPointClick: (id: string, idx: number) => void,
    onDblClick: () => void,
  ) {
    onSelectCb = onSelect;
    onMoveCb = onMove;
    onPointClickCb = onPointClick;
    onDblClickCb = onDblClick;

    map = L.map('map', {
      center: [46.8, 8.2], // Switzerland center
      zoom: 8,
      layers: [LAYERS.swisstopo],
      zoomControl: false,
    });

    L.control.zoom({ position: 'bottomright' }).addTo(map);

    map.on('moveend', () => {
      const c = map.getCenter();
      onMoveCb(c.lat, c.lng, map.getZoom());
    });

    map.on('dblclick', () => {
      onDblClickCb();
    });

    cursorMarker = L.marker([0, 0], {
      icon: L.divIcon({
        className: 'map-cursor-dot',
        html: '<div class="dot-inner"></div>',
        iconSize: [12, 12],
        iconAnchor: [6, 6],
      }),
      interactive: false,
    });
  }

  function switchBasemap(key: string) {
    if (!LAYERS[key]) return;
    Object.values(LAYERS).forEach((l) => map.removeLayer(l));
    map.addLayer(LAYERS[key]);
  }

  function addTrack(track: TrackData) {
    trackData[track.id] = track;
    const pts = track.points;
    const layers: L.Polyline[] = [];

    let currentSegment: [number, number][] = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (i > 0) {
        const prev = pts[i - 1];
        const dt = p.time && prev.time ? p.time - prev.time : 0;

        if (dt > GAP_THRESHOLD) {
          // Finish current segment
          if (currentSegment.length > 1) {
            layers.push(
              L.polyline(currentSegment, { color: track.color, weight: 3, opacity: 0.2 }),
            );
          }
          // Draw dotted line for gap
          layers.push(
            L.polyline(
              [
                [prev.lat, prev.lon],
                [p.lat, p.lon],
              ],
              {
                color: track.color,
                weight: 2,
                opacity: 0.15,
                dashArray: '5, 8',
              },
            ),
          );
          currentSegment = [];
        }
      }
      currentSegment.push([p.lat, p.lon]);
    }
    if (currentSegment.length > 1) {
      layers.push(L.polyline(currentSegment, { color: track.color, weight: 3, opacity: 0.2 }));
    }

    const group = L.featureGroup(layers).addTo(map);
    group.on('click', (e: L.LeafletMouseEvent) => {
      L.DomEvent.stopPropagation(e);
      if (onSelectCb) onSelectCb(track.id);
    });
    polylines[track.id] = group;
  }

  function removeTrack(id: string) {
    if (polylines[id]) {
      map.removeLayer(polylines[id]);
      delete polylines[id];
      delete trackData[id];
    }
    if (selectedId === id) {
      selectedId = null;
      _syncOutline();
    }
  }

  function setTrackVisible(id: string, visible: boolean) {
    const pl = polylines[id];
    if (!pl) return;
    if (visible) map.addLayer(pl);
    else map.removeLayer(pl);
    if (selectedId === id) _syncOutline();
  }

  function setSelectedTrack(id: string | null, _fit = true) {
    selectedId = id;
    _syncOutline();
  }

  function _syncOutline() {
    if (selectedOutline) {
      map.removeLayer(selectedOutline);
      selectedOutline = null;
    }
    const pl = polylines[selectedId!];
    const track = trackData[selectedId!];
    if (selectedId && pl && track && map.hasLayer(pl)) {
      const latlngs = track.points.map((p) => [p.lat, p.lon] as [number, number]);
      selectedOutline = L.polyline(latlngs, {
        color: '#000000',
        weight: 7,
        opacity: 0.65,
        interactive: false,
      }).addTo(map);

      // Ensure outline is behind the actual colored line
      selectedOutline.bringToFront();
      pl.bringToFront();
    }

    // Ensure segment highlight stays on top of both
    if (highlightLine && map.hasLayer(highlightLine)) {
      highlightLine.bringToFront();
    }
  }

  function fitAll() {
    const all = Object.values(polylines).filter((pl) => map.hasLayer(pl));
    if (!all.length) return;
    const group = L.featureGroup(all);
    map.fitBounds(group.getBounds().pad(0.05));
  }

  function fitTrack(id: string) {
    if (polylines[id]) map.fitBounds(polylines[id].getBounds().pad(0.05));
  }

  function fitSegment(latlngs: [number, number][]) {
    if (!latlngs || latlngs.length < 2) return;
    const bounds = L.latLngBounds(latlngs);
    map.fitBounds(bounds.pad(0.15), { animate: true });
  }

  // ── Chart-selection highlight segment ────────────────────────
  // pts: full points array, iMin/iMax: indices of visible range
  function highlightSegment(
    id: string,
    pts: TrackPoint[],
    iMin: number,
    iMax: number,
    fit = false,
    colors: string[] | null = null,
  ) {
    clearHighlight();
    if (!pts || iMin >= iMax) return;
    const latlngs = pts.slice(iMin, iMax + 1).map((p) => [p.lat, p.lon] as [number, number]);
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
    const innerSegs: L.Polyline[] = [];
    for (let i = iMin + 1; i <= iMax; i++) {
      const p0 = pts[i - 1],
        p1 = pts[i];
      const dt = p1.time && p0.time ? p1.time - p0.time : 0;

      const c = colors && colors[i] ? colors[i] : trackColor;
      const isGap = dt > GAP_THRESHOLD;

      innerSegs.push(
        L.polyline(
          [
            [p0.lat, p0.lon],
            [p1.lat, p1.lon],
          ],
          {
            color: isGap ? '#888896' : c,
            weight: 6,
            opacity: 1,
            dashArray: isGap ? '4, 6' : undefined,
            interactive: false,
          },
        ),
      );
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

    const mStart = L.marker([pts[iMin].lat, pts[iMin].lon], {
      icon: startIcon,
      interactive: false,
    });
    const mEnd = L.marker([pts[iMax].lat, pts[iMax].lon], { icon: endIcon, interactive: false });

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
  function showCursorAt(lat: number, lon: number) {
    if (!cursorMarker) return;
    cursorMarker.setLatLng([lat, lon]);
    if (!map.hasLayer(cursorMarker)) cursorMarker.addTo(map);
  }

  function hideCursor() {
    if (cursorMarker && map.hasLayer(cursorMarker)) map.removeLayer(cursorMarker);
  }

  function centerOn(lat: number, lon: number, zoom?: number | null, animate = true) {
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

  function getPosition(): [number, number, number] {
    const c = map.getCenter();
    return [c.lat, c.lng, map.getZoom()];
  }

  function setPosition(lat: number, lon: number, zoom: number) {
    map.setView([lat, lon], zoom);
  }

  function colorTrackByMetric(id: string, pts: TrackPoint[], colors: string[]) {
    const pl = polylines[id];
    if (!pl) return;
    map.removeLayer(pl);

    const segs: L.Polyline[] = [];
    for (let i = 1; i < pts.length; i++) {
      if (!pts[i - 1] || !pts[i]) continue;
      const dt = pts[i].time && pts[i - 1].time ? pts[i].time - pts[i - 1].time : 0;
      const c = colors[i] || colors[i - 1] || '#888896';

      if (dt > GAP_THRESHOLD) {
        segs.push(
          L.polyline(
            [
              [pts[i - 1].lat, pts[i - 1].lon],
              [pts[i].lat, pts[i].lon],
            ],
            { color: '#888896', weight: 2, opacity: 0.5, dashArray: '4, 6', interactive: false },
          ),
        );
      } else {
        segs.push(
          L.polyline(
            [
              [pts[i - 1].lat, pts[i - 1].lon],
              [pts[i].lat, pts[i].lon],
            ],
            { color: c, weight: 4, opacity: 0.9, interactive: false },
          ),
        );
      }
    }
    const group = L.featureGroup(segs).addTo(map);
    group.on('click', (e: L.LeafletMouseEvent) => {
      L.DomEvent.stopPropagation(e);
      if (onSelectCb) onSelectCb(id);
    });
    polylines[id] = group;
    _syncOutline();
  }

  function clearMetricColor(id: string) {
    if (!trackData[id]) return;
    const pl = polylines[id];
    if (pl) map.removeLayer(pl);
    addTrack(trackData[id]);
    _syncOutline();
  }

  function closePopup() {
    map.closePopup();
  }

  // ── Utils ─────────────────────────────────────────────────────
  function haversine(lat1: number, lon1: number, lat2: number, lon2: number) {
    const R = 6371000;
    const φ1 = (lat1 * Math.PI) / 180,
      φ2 = (lat2 * Math.PI) / 180;
    const Δφ = ((lat2 - lat1) * Math.PI) / 180;
    const Δλ = ((lon2 - lon1) * Math.PI) / 180;
    const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  return {
    init,
    switchBasemap,
    addTrack,
    removeTrack,
    setTrackVisible,
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
