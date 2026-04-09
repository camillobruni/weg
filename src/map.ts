// Copyright (c) 2026, Camillo Bruni.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

'use strict';

// ── Map View (Leaflet) ─────────────────────────────────────────────

import L from 'leaflet';
import { TrackData, TrackPoint } from './parsers';

export const MapView = (() => {
  let map: L.Map;
  let cursorMarker: L.Marker;
  let highlightLine: L.FeatureGroup | null = null;
  let polylines: Record<string, L.FeatureGroup> = {}; // id → L.FeatureGroup
  let trackData: Record<string, TrackData> = {}; // id → TrackData
  let selectedId: string | null = null;
  let selectedOutline: L.Polyline | null = null;

  let onSelectCb: (id: string) => void;
  let onMoveCb: (lat: number, lng: number, zoom: number) => void;
  let onPointClickCb: (id: string, idx: number) => void;
  let onPointHoverCb: (id: string | null, idx: number | null) => void;
  let onDblClickCb: () => void;

  const GAP_THRESHOLD: number = 60000; // 1 minute in ms

  interface ImagerySource {
    id: string;
    name: string;
    type: string;
    url: string;
    attribution?: { text?: string; url?: string };
    max_zoom?: number;
    extent?: {
      min_lat?: number;
      max_lat?: number;
      min_lon?: number;
      max_lon?: number;
      polygon?: [number, number][][];
    };
    best?: boolean;
    overlay?: boolean;
  }

  let imageryConfig: ImagerySource[] = [];
  const extraLayers: Record<string, L.TileLayer> = {};

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

  async function fetchImageryConfig() {
    try {
      const resp = await fetch(
        'https://raw.githubusercontent.com/osmlab/editor-layer-index/gh-pages/imagery.json',
      );
      if (!resp.ok) return;
      const data = await resp.json();
      // Filter out non-tms/bing/wms for now, prefer tms
      imageryConfig = data.filter(
        (s: ImagerySource) => s.type === 'tms' && s.url.includes('{z}') && !s.overlay,
      );
      updateExtraLayersMenu();
    } catch (e) {
      console.error('MapView: Failed to fetch imagery config', e);
    }
  }

  function updateExtraLayersMenu() {
    const menuEl = document.getElementById('extra-layers-menu');
    if (!menuEl) return;

    const bounds = map.getBounds();
    const lat = bounds.getCenter().lat;
    const lon = bounds.getCenter().lng;

    // Filter by extent if present
    const visible = imageryConfig
      .filter((s) => {
        if (!s.extent) return true; // Global
        const e = s.extent;
        if (e.min_lat != null && lat < e.min_lat) return false;
        if (e.max_lat != null && lat > e.max_lat) return false;
        if (e.min_lon != null && lon < e.min_lon) return false;
        if (e.max_lon != null && lon > e.max_lon) return false;
        return true;
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    menuEl.innerHTML = `
      <div class="extra-layers-header">Additional Maps</div>
      ${visible
        .map(
          (s) => `
        <button class="extra-layer-item" data-id="${s.id}" title="${s.name}">${s.name}</button>
      `,
        )
        .join('')}
    `;

    menuEl.querySelectorAll('.extra-layer-item').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = (btn as HTMLElement).dataset.id!;
        const source = imageryConfig.find((s) => s.id === id);
        if (source) switchExtraLayer(source);
        menuEl.classList.add('hidden');
      });
    });
  }

  function switchExtraLayer(s: ImagerySource) {
    // Convert iD-style URL to Leaflet-style if needed
    // iD uses {switch:a,b,c}, Leaflet uses {s}
    const url = s.url.replace(/\{switch:([^}]+)\}/, '{s}');
    const subdomains = s.url.match(/\{switch:([^}]+)\}/)?.[1]?.split(',') || 'abc';

    const layer = L.tileLayer(url, {
      attribution: s.attribution?.text || '',
      maxZoom: s.max_zoom || 20,
      subdomains,
    });

    Object.values(LAYERS).forEach((l) => map.removeLayer(l));
    Object.values(extraLayers).forEach((l) => map.removeLayer(l));

    extraLayers[s.id] = layer;
    map.addLayer(layer);

    // Unselect defaults
    document.querySelectorAll('.bm-btn').forEach((btn) => btn.classList.remove('active'));
  }

  function init(
    onSelect: (id: string) => void,
    onMove: (lat: number, lng: number, zoom: number) => void,
    onPointClick: (id: string, idx: number) => void,
    onPointHover: (id: string | null, idx: number | null) => void,
    onDblClick: () => void,
  ) {
    onSelectCb = onSelect;
    onMoveCb = onMove;
    onPointClickCb = onPointClick;
    onPointHoverCb = onPointHover;
    onDblClickCb = onDblClick;

    map = L.map('map', {
      center: [46.8, 8.2], // Switzerland center
      zoom: 8,
      layers: [LAYERS.swisstopo],
      zoomControl: false,
    });

    L.control.zoom({ position: 'bottomright' }).addTo(map);

    // Burger menu toggle
    const burgerBtn = document.getElementById('btn-extra-layers');
    const menuEl = document.getElementById('extra-layers-menu');
    burgerBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      menuEl?.classList.toggle('hidden');
      if (!menuEl?.classList.contains('hidden')) updateExtraLayersMenu();
    });
    document.addEventListener('click', () => menuEl?.classList.add('hidden'));
    menuEl?.addEventListener('click', (e) => e.stopPropagation());

    // Create custom panes for strict layering
    // order (lowest to highest): 
    // 1. All tracks (default overlayPane, z-index 400)
    // 2. White selection range outline (highlightPane)
    // 3. Black outline for current track (selectedOutlinePane)
    // 4. Color for current track (foregroundPane)
    map.createPane('highlightPane');
    map.getPane('highlightPane')!.style.zIndex = '410';

    map.createPane('selectedOutlinePane');
    map.getPane('selectedOutlinePane')!.style.zIndex = '420';
    
    map.createPane('foregroundPane');
    map.getPane('foregroundPane')!.style.zIndex = '430';

    map.on('moveend', () => {
      const c = map.getCenter();
      onMoveCb(c.lat, c.lng, map.getZoom());
      if (menuEl && !menuEl.classList.contains('hidden')) updateExtraLayersMenu();
    });

    map.on('dblclick', () => {
      onDblClickCb();
    });

    map.on('mousemove', (e: L.LeafletMouseEvent) => {
      const tracksFound = findNearestTracks(e.latlng, 24);
      if (tracksFound.length > 0) {
        const nearest = tracksFound[0];
        if (nearest.id === selectedId) {
          onPointHoverCb(nearest.id, nearest.pointIdx);
          return;
        }
      }
      onPointHoverCb(null, null);
    });

    map.on('click', (e: L.LeafletMouseEvent) => {
      const tracksFound = findNearestTracks(e.latlng);
      if (tracksFound.length === 0) return;
      
      const nearest = tracksFound[0];

      // If clicking on/near the ALREADY selected track, move the pinned point
      if (nearest.id === selectedId && nearest.dist < 32) {
        onPointClickCb(nearest.id, nearest.pointIdx);
        return;
      }

      if (tracksFound.length === 1 && nearest.dist < 32) {
        // If very close to exactly one track, just select it
        onSelectCb(nearest.id);
        return;
      }

      showTrackPickerPopup(e.latlng, tracksFound);
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

    fetchImageryConfig();
  }

  function switchBasemap(key: string) {
    if (!LAYERS[key]) return;
    Object.values(LAYERS).forEach((l) => map.removeLayer(l));
    Object.values(extraLayers).forEach((l) => map.removeLayer(l));
    map.addLayer(LAYERS[key]);
  }

  function addTrack(track: TrackData, pane: string = 'overlayPane') {
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
              L.polyline(currentSegment, { color: track.color, weight: 3, opacity: 0.2, pane }),
            );
          }
          // Draw solid line for gap
          layers.push(
            L.polyline(
              [
                [prev.lat, prev.lon],
                [p.lat, p.lon],
              ],
              {
                color: '#888896',
                weight: 3,
                opacity: 1,
                pane
              },
            ),
          );
          currentSegment = [];
        }
      }
      currentSegment.push([p.lat, p.lon]);
    }
    if (currentSegment.length > 1) {
      layers.push(L.polyline(currentSegment, { color: track.color, weight: 3, opacity: 0.2, pane }));
    }

    const group = L.featureGroup(layers).addTo(map);
    group.on('click', (e: L.LeafletMouseEvent) => {
      // Don't stopPropagation so map click listener also fires
    });
    polylines[track.id] = group;
  }

  function findNearestTracks(latlng: L.LatLng, maxPixelDist = 32): { id: string, name: string, color: string, dist: number, geoDist: number, pointIdx: number }[] {
    const results: { id: string, name: string, color: string, dist: number, geoDist: number, pointIdx: number }[] = [];
    const clickPoint = map.latLngToContainerPoint(latlng);

    for (const id in trackData) {
      if (!map.hasLayer(polylines[id])) continue;
      const t = trackData[id];
      let minDistPx = Infinity;
      let minGeoDist = Infinity;
      let pointIdx = -1;

      // Quick bounds check with a pixel-based buffer
      const bounds = polylines[id].getBounds();
      const sw = map.latLngToContainerPoint(bounds.getSouthWest());
      const ne = map.latLngToContainerPoint(bounds.getNorthEast());
      
      // Expand pixel bounds by maxPixelDist
      if (clickPoint.x < sw.x - maxPixelDist || clickPoint.x > ne.x + maxPixelDist ||
          clickPoint.y > sw.y + maxPixelDist || clickPoint.y < ne.y - maxPixelDist) {
        continue;
      }

      // Find nearest point in track
      for (let i = 0; i < t.points.length; i++) {
        const p = t.points[i];
        const pt = map.latLngToContainerPoint([p.lat, p.lon]);
        const dpx = clickPoint.distanceTo(pt);
        if (dpx < minDistPx) {
          minDistPx = dpx;
          minGeoDist = haversine(latlng.lat, latlng.lng, p.lat, p.lon);
          pointIdx = i;
        }
        if (minDistPx < 5) break; // Optimization: close enough
      }

      if (minDistPx <= maxPixelDist) {
        results.push({ id, name: t.name, color: t.color, dist: minDistPx, geoDist: minGeoDist, pointIdx });
      }
    }

    return results.sort((a, b) => a.dist - b.dist);
  }

  function showTrackPickerPopup(latlng: L.LatLng, tracks: { id: string, name: string, color: string, geoDist: number }[]) {
    const content = document.createElement('div');
    content.className = 'track-picker-popup';
    
    const fmtGeoDist = (m: number) => {
      if (m < 1000) return `${Math.round(m)}m away`;
      return `${(m / 1000).toFixed(1)}km away`;
    };

    content.innerHTML = `
      <div class="picker-header">Select track</div>
      <div class="picker-list">
        ${tracks.map(t => `
          <div class="picker-item" data-id="${t.id}">
            <div class="picker-color" style="background:${t.color}"></div>
            <div class="picker-info">
              <div class="picker-name">${t.name}</div>
              <div class="picker-meta">${fmtGeoDist(t.geoDist)}</div>
            </div>
          </div>
        `).join('')}
      </div>
    `;

    content.querySelectorAll('.picker-item').forEach(el => {
      el.addEventListener('click', () => {
        onSelectCb((el as HTMLElement).dataset.id!);
        map.closePopup();
      });
    });

    L.popup({
      closeButton: false,
      className: 'weg-popup',
      maxWidth: 240,
    })
      .setLatLng(latlng)
      .setContent(content)
      .openOn(map);
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
        pane: 'selectedOutlinePane'
      }).addTo(map);

      // Move the selected track's polyline to the foreground pane
      // Unfortunately we have to re-add it or use a separate layer for selection
      // For now, let's just make sure it stays topmost within its pane if we don't re-create.
      // Actually, let's re-add the selected track to the foregroundPane if it's selected.
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

  function ensureVisible(latlngs: [number, number][]) {
    if (!latlngs || latlngs.length < 2) return;
    const bounds = L.latLngBounds(latlngs);
    if (!map.getBounds().contains(bounds)) {
      map.fitBounds(bounds.pad(0.2), { animate: true });
    }
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
    
    // If selecting full track, don't show the highlight
    if (iMin === 0 && iMax >= pts.length - 1) return;

    const latlngs = pts.slice(iMin, iMax + 1).map((p) => [p.lat, p.lon] as [number, number]);
    if (latlngs.length < 2) return;

    if (fit) fitSegment(latlngs);

    const trackColor = trackData[id]?.color || '#fff';

    // Triple layer for maximum pronunciation: Black -> White -> Color
    const bgBlack = L.polyline(latlngs, {
      color: '#000000',
      weight: 13,
      opacity: 0.5,
      interactive: false,
      pane: 'highlightPane',
    });

    const bgWhite = L.polyline(latlngs, {
      color: '#ffffff',
      weight: 11,
      opacity: 0.9,
      interactive: false,
      pane: 'highlightPane',
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
            weight: 4,
            opacity: 1,
            dashArray: isGap ? '4, 6' : undefined,
            interactive: false,
            pane: 'foregroundPane',
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
      pane: 'foregroundPane',
    });
    const mEnd = L.marker([pts[iMax].lat, pts[iMax].lon], {
      icon: endIcon,
      interactive: false,
      pane: 'foregroundPane',
    });

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
      const dt = pts[i].time! && pts[i - 1].time! ? pts[i].time! - pts[i - 1].time! : 0;
      const c = colors[i] || colors[i - 1] || '#888896';

      if (dt > GAP_THRESHOLD) {
        segs.push(
          L.polyline(
            [
              [pts[i - 1].lat, pts[i - 1].lon],
              [pts[i].lat, pts[i].lon],
            ],
            { color: '#888896', weight: 4, opacity: 1, interactive: false, pane: 'foregroundPane' },
          ),
        );
      } else {

        segs.push(
          L.polyline(
            [
              [pts[i - 1].lat, pts[i - 1].lon],
              [pts[i].lat, pts[i].lon],
            ],
            { color: c, weight: 4, opacity: 0.9, interactive: false, pane: 'foregroundPane' },
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
    ensureVisible,
    centerOn,
    closePopup,
    invalidateSize,
    getPosition,
    setPosition,
    colorTrackByMetric,
    clearMetricColor,
  };
})();
