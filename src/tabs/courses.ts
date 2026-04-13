// Copyright (c) 2026, Camillo Bruni.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

'use strict';

import { MapView } from '../map';
import { Storage } from '../storage';
import { UrlState } from '../url-state';
import { escHtml, fmtPace } from '../utils';
import { SPORTS } from '../sports';
import { METRICS } from '../metrics';
import L from 'leaflet';
import { selectTrack } from '../app';
import { ChartView } from '../charts';

export interface CoursePoint {
  lat: number;
  lon: number;
  radius: number; // in meters
  name?: string;
}

export interface Course {
  id: string;
  name: string;
  points: CoursePoint[];
}

let courses: Course[] = [];

export function getCoursesForTrack(track: any): Course[] {
  return courses.filter(c => {
    if (c.points.length === 0) return false;
    for (const pt of c.points) {
      let passesPoint = false;
      for (const trackPt of track.points) {
        const d = haversine(pt.lat, pt.lon, trackPt.lat, trackPt.lon);
        if (d <= pt.radius) {
          passesPoint = true;
          break;
        }
      }
      if (!passesPoint) return false;
    }
    return true;
  });
}

let activeCourseId: string | null = null;
let isEditMode = false;
let openCourseId: string | null = null;
let toastFn: (msg: string, type?: string) => void = () => {};
let courseLayer: L.FeatureGroup | null = null;
let zoomListener: (() => void) | null = null;

export function initCourses(showToast: (msg: string, type?: string) => void) {
  toastFn = showToast;
  loadCourses();
}

async function loadCourses() {
  try {
    const stored = await Storage.get('courses');
    if (stored) {
      courses = stored;
    }
  } catch (e) {
    console.error('Courses: Failed to load courses', e);
  }
}

async function saveCourses() {
  try {
    await Storage.set('courses', courses);
  } catch (e) {
    console.error('Courses: Failed to save courses', e);
    toastFn('Failed to save courses', 'error');
  }
}

function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371e3; // Earth radius in metres
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const deltaPhi = ((lat2 - lat1) * Math.PI) / 180;
  const deltaLambda = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}

function calculateCourseDistance(course: Course): number {
  let total = 0;
  for (let i = 0; i < course.points.length - 1; i++) {
    const p1 = course.points[i];
    const p2 = course.points[i + 1];
    total += haversine(p1.lat, p1.lon, p2.lat, p2.lon);
  }
  return total / 1000; // in km
}

export function findCourseRange(track: any, coursePoints: CoursePoint[]): { startIdx: number; endIdx: number } | null {
  if (coursePoints.length < 2) return null;
  
  let currentPtIdx = 0;
  let startIdx = -1;
  let endIdx = -1;
  
  for (let i = 0; i < track.points.length; i++) {
    const tp = track.points[i];
    const cp = coursePoints[currentPtIdx];
    const d = haversine(cp.lat, cp.lon, tp.lat, tp.lon);
    
    if (d <= cp.radius) {
      if (currentPtIdx === 0) {
        startIdx = i;
      }
      if (currentPtIdx === coursePoints.length - 1) {
        endIdx = i;
        return { startIdx, endIdx };
      }
      currentPtIdx++;
    }
  }
  return null;
}

export function calculateCourseStats(track: any, startIdx: number, endIdx: number) {
  const points = track.points.slice(startIdx, endIdx + 1);
  const startTime = points[0]?.time || 0;
  const endTime = points[points.length - 1]?.time || 0;
  const duration = (endTime - startTime) / 1000; // in seconds
  
  let totalPower = 0;
  let powerCount = 0;
  let totalHR = 0;
  let hrCount = 0;
  let totalSpeed = 0;
  let speedCount = 0;
  let totalCadence = 0;
  let cadenceCount = 0;
  let totalAscent = 0;
  
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (p.power != null) {
      totalPower += p.power;
      powerCount++;
    }
    if (p.hr != null) {
      totalHR += p.hr;
      hrCount++;
    }
    if (p.speed != null) {
      totalSpeed += p.speed;
      speedCount++;
    }
    if (p.cadence != null) {
      totalCadence += p.cadence;
      cadenceCount++;
    }
    if (i > 0) {
      const prev = points[i - 1];
      if (p.ele != null && prev.ele != null) {
        const de = p.ele - prev.ele;
        if (de > 0) totalAscent += de;
      }
    }
  }
  
  const dist = points.length > 1 ? (points[points.length - 1].dist || 0) - (points[0].dist || 0) : 0;
  
  return {
    duration,
    dist,
    avgWatts: powerCount > 0 ? Math.round(totalPower / powerCount) : null,
    avgHR: hrCount > 0 ? Math.round(totalHR / hrCount) : null,
    avgSpeed: speedCount > 0 ? totalSpeed / speedCount : null,
    avgCadence: cadenceCount > 0 ? Math.round(totalCadence / cadenceCount) : null,
    avgVam: duration > 0 ? Math.round(totalAscent / (duration / 3600)) : null,
  };
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function renderCourseTableHeaders() {
  return `
    <th><span class="material-symbols-rounded metric-icon date" title="Date">calendar_today</span> Date</th>
    <th><span class="material-symbols-rounded metric-icon" title="Distance">straighten</span> Distance</th>
    <th><span class="material-symbols-rounded metric-icon duration" title="Duration">timer</span> Duration</th>
    <th><span class="material-symbols-rounded metric-icon speed" title="Avg Speed">speed</span> Speed</th>
    <th><span class="material-symbols-rounded metric-icon speed" title="Avg Pace">speed</span> Pace</th>
    <th><span class="material-symbols-rounded metric-icon" style="color: ${METRICS.vam.color}" title="Avg VAM">trending_up</span> VAM</th>
    <th><span class="material-symbols-rounded metric-icon power" title="Avg Power">bolt</span> Power</th>
    <th><span class="material-symbols-rounded metric-icon hr" title="Avg Heart Rate">favorite</span> HR</th>
  `;
}

export function renderCourseTableCells(stats: any, sport: string | null, dateStr: string) {
  const sportDef = sport ? SPORTS[sport.toLowerCase()] : null;
  const paceUnit = sportDef?.paceUnit || 'km';
  let paceStr = '--';
  if (stats.avgSpeed != null && stats.avgSpeed > 0.1) {
    const paceSeconds = (paceUnit === 'km' ? 1000 : 100) / stats.avgSpeed;
    paceStr = fmtPace(paceSeconds) + `&nbsp;min/${paceUnit}`;
  }
  
  return `
    <td>${dateStr}</td>
    <td>${stats.dist != null ? (stats.dist / 1000).toFixed(2) + '&nbsp;km' : '-'}</td>
    <td>${formatDuration(stats.duration)}</td>
    <td>${stats.avgSpeed != null ? (stats.avgSpeed * 3.6).toFixed(1) + '&nbsp;km/h' : '-'}</td>
    <td>${paceStr}</td>
    <td>${stats.avgVam != null ? stats.avgVam + '&nbsp;m/h' : '-'}</td>
    <td>${stats.avgWatts != null ? stats.avgWatts + '&nbsp;W' : '-'}</td>
    <td>${stats.avgHR != null ? stats.avgHR + '&nbsp;bpm' : '-'}</td>
  `;
}

export function renderCourses() {
  const container = document.getElementById('courses-view');
  if (!container) return;

  container.innerHTML = `
    <div class="evolution-toolbar">
      <div class="evolution-toolbar-left">
      </div>
      <div class="evolution-toolbar-right">
        ${isEditMode ? `
          <button id="btn-done-edit" class="icon-btn" title="Done Editing">
            <span class="material-symbols-rounded">done</span>
          </button>
        ` : `
          <button id="btn-new-course" class="icon-btn" title="New Course">
            <span class="material-symbols-rounded">add_circle</span>
          </button>
        `}
      </div>
    </div>
    <div class="courses-container">
      <div id="courses-list" class="courses-list">
        ${courses.length === 0 ? `
          <div class="empty-state">
            <span class="material-symbols-rounded empty-icon">route</span>
            <div class="empty-text">No courses created yet</div>
          </div>
        ` : courses.map(c => {
          const pts = c.points.map(p => ({ lat: p.lat, lng: p.lon }));
          const matchingIds = MapView.findTracksPassingThroughPoints(pts, c.points[0]?.radius || 20);
          const isOpen = c.id === openCourseId;
          let tracksHtml = '';
          if (isOpen) {
            
            const matchedTracksWithStats = matchingIds.map(id => {
              const track = MapView.getTrackData(id) as any;
              if (!track) return null;
              const range = findCourseRange(track, c.points);
              if (!range) return null;
              const stats = calculateCourseStats(track, range.startIdx, range.endIdx);
              const startTime = track.stats?.startTime || track.points?.[0]?.time;
              const dateStr = startTime ? new Date(startTime).toLocaleDateString('en-CA') : '-';
              return {
                id,
                displayName: track.displayName || track.name || id,
                date: dateStr,
                sport: track.sport,
                color: track.color,
                ...stats,
                startIdx: range.startIdx,
                endIdx: range.endIdx
              };
            }).filter(t => t !== null) as any[];
            
            // Sort by duration (fastest first)
            matchedTracksWithStats.sort((a, b) => a.duration - b.duration);

            tracksHtml = `
              <div class="course-tracks">
                ${matchedTracksWithStats.length === 0 ? `
                  <div class="empty-text">No matching tracks</div>
                ` : `
                  <table class="course-tracks-table">
                    <thead>
                      <tr>
                        <th>Track (${matchedTracksWithStats.length})</th>
                        ${renderCourseTableHeaders()}
                      </tr>
                    </thead>
                    <tbody>
                      ${matchedTracksWithStats.map(t => {
                        const isSelected = t.id === UrlState.get().track;
                        return `
                        <tr class="course-track-row ${isSelected ? 'selected' : ''}" data-track-id="${t.id}" data-start="${t.startIdx}" data-end="${t.endIdx}">
                          <td class="track-name-cell clickable">
                            <div style="display: flex; align-items: center;">
                              <div style="background:${t.color}; width: 3px; height: 16px; margin-right: 8px; border-radius: 1px; flex-shrink: 0;"></div>
                              ${escHtml(t.displayName)}
                            </div>
                          </td>
                          ${renderCourseTableCells(t, t.sport, t.date)}
                        </tr>
                      `}).join('')}
                    </tbody>
                  </table>
                `}
              </div>
            `;
          }
          return `
            <div class="course-item ${isOpen ? 'open' : ''}" data-id="${c.id}">
              <div class="course-item-header">
                <span class="material-symbols-rounded expand-icon">${isOpen ? 'expand_more' : 'chevron_right'}</span>
                <div class="course-name">${escHtml(c.name)} <span class="material-symbols-rounded btn-rename-course clickable" style="font-size: 14px; color: var(--text-muted);" title="Rename">edit</span></div>
                <div class="course-meta"><span class="material-symbols-rounded" style="font-size: 14px; vertical-align: middle;" title="Distance">straighten</span> ${calculateCourseDistance(c).toFixed(2)} km | ${c.points.length} points | ${matchingIds.length} matching tracks</div>
                <div class="course-actions">
                  <button class="btn-edit-course icon-btn" title="Edit Course"><span class="material-symbols-rounded">edit</span></button>
                  <button class="btn-delete-course icon-btn danger" title="Delete Course"><span class="material-symbols-rounded">delete</span></button>
                </div>
              </div>
              ${tracksHtml}
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `;

  document.getElementById('btn-new-course')?.addEventListener('click', () => {
    createNewCourse();
  });

  document.getElementById('btn-done-edit')?.addEventListener('click', () => {
    isEditMode = false;
    MapView.setCustomClickHandler(null);
    document.getElementById('map-container')?.classList.remove('editing-mode');
    
    if (zoomListener) {
      const map = MapView.getMap();
      if (map) map.off('zoomend', zoomListener);
      zoomListener = null;
    }
    
    renderCourses();
    if (activeCourseId) {
      renderCourseOnMap(activeCourseId);
    }
  });

  container.querySelectorAll('.course-item').forEach(el => {
    const id = (el as HTMLElement).dataset.id!;
    el.querySelector('.btn-edit-course')?.addEventListener('click', (e) => {
      e.stopPropagation();
      editCourse(id);
    });
    el.querySelector('.btn-rename-course')?.addEventListener('click', (e) => {
      e.stopPropagation();
      renameCourse(id);
    });
    el.querySelector('.btn-delete-course')?.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteCourse(id);
    });
    el.querySelector('.course-item-header')?.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.course-actions') || (e.target as HTMLElement).closest('.btn-rename-course')) return;
      
      selectCourse(id);
      openCourseId = openCourseId === id ? null : id;
      renderCourses();
    });

    el.querySelectorAll('.course-track-row').forEach(row => {
      const trackId = (row as HTMLElement).dataset.trackId!;
      const startIdx = parseInt((row as HTMLElement).dataset.start!, 10);
      const endIdx = parseInt((row as HTMLElement).dataset.end!, 10);
      
      row.querySelector('.track-name-cell')?.addEventListener('click', (e) => {
        e.stopPropagation();
        const track = MapView.getTrackData(trackId);
        if (track) {
          // Select track (clears selection in app.ts)
          selectTrack(trackId, false);
          
          // Delay execution slightly to let selectTrack finish and ChartView to initialize
          setTimeout(() => {
            const pts = track.points;
            const t0 = pts.find((p: any) => p.time != null)?.time || 0;
            
            // Ensure indices are within bounds
            const sIdx = Math.max(0, Math.min(startIdx, pts.length - 1));
            const eIdx = Math.max(0, Math.min(endIdx, pts.length - 1));
            
            const tMin = Math.max(0, ((pts[sIdx]?.time || 0) - t0) / 1000);
            const tMax = Math.max(0, ((pts[eIdx]?.time || 0) - t0) / 1000);
            
            const axis = ChartView.getXAxis();
            let selMin = tMin;
            let selMax = tMax;
            
            if (axis === 'distance') {
              selMin = Math.max(0, (pts[sIdx]?.dist || 0) / 1000);
              selMax = Math.max(0, (pts[eIdx]?.dist || 0) / 1000);
            }
            
            // Set selection and switch tab
            UrlState.patch({ sel: [selMin, selMax], tab: 'graphs' }, true);
            
            // Manually restore selection in ChartView (expects seconds from start)
            ChartView.restoreSelection(tMin, tMax);
            
            // Highlight segment on map
            MapView.highlightSegment(trackId, track.points, startIdx, endIdx, true);
          }, 50);
        }
      });

      row.addEventListener('mouseenter', () => {
        MapView.setTrackHover(trackId, true);
      });

      row.addEventListener('mouseleave', () => {
        MapView.setTrackHover(trackId, false);
      });
    });
  });
}

function createNewCourse() {
  const name = `Course ${courses.length + 1}`;

  const newCourse: Course = {
    id: Math.random().toString(36).substring(2, 9),
    name: name,
    points: [],
  };

  courses.push(newCourse);
  saveCourses();
  renderCourses();
  editCourse(newCourse.id);
}

function renameCourse(id: string) {
  const course = courses.find(c => c.id === id);
  if (!course) return;
  
  const el = document.querySelector(`.course-item[data-id="${id}"]`);
  if (!el) return;
  
  const nameEl = el.querySelector('.course-name');
  if (!nameEl) return;
  
  const currentName = course.name;
  nameEl.innerHTML = `<input type="text" class="course-name-input" value="${escHtml(currentName)}" style="background: var(--bg); border: 1px solid var(--border); color: var(--text); font-size: inherit; padding: 2px 4px; border-radius: 4px; width: 80%;">`;
  
  const input = nameEl.querySelector('.course-name-input') as HTMLInputElement;
  input.focus();
  input.select();
  
  const save = () => {
    const newName = input.value.trim();
    if (newName !== '') {
      course.name = newName;
      saveCourses();
    }
    renderCourses();
  };
  
  input.addEventListener('blur', save);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      save();
    } else if (e.key === 'Escape') {
      renderCourses();
    }
  });
}

function editCourse(id: string) {
  activeCourseId = id;
  isEditMode = true;
  toastFn('Click on map to add points. Drag to move.', 'info');
  document.getElementById('map-container')?.classList.add('editing-mode');
  renderCourses();
  
  const map = MapView.getMap();
  if (!map) {
    console.error('Courses: Map not initialized');
    return;
  }

  // Clear previous course layer
  clearCourseLayer();

  courseLayer = L.featureGroup().addTo(map);

  // Add custom click handler to map
  MapView.setCustomClickHandler((e: L.LeafletMouseEvent) => {
    if (!isEditMode || !activeCourseId) return false;
    
    addPointToCourse(activeCourseId, e.latlng.lat, e.latlng.lng);
    return true; // prevent default
  });

  renderCourseOnMap(id);

  // Fit bounds after rendering if there are points
  if (courseLayer.getLayers().length > 0) {
    map.fitBounds(courseLayer.getBounds(), { padding: [50, 50] });
  }

  if (zoomListener) map.off('zoomend', zoomListener);
  zoomListener = () => {
    if (isEditMode && activeCourseId) {
      renderCourseOnMap(activeCourseId);
    }
  };
  map.on('zoomend', zoomListener);
}

function clearCourseLayer() {
  const map = MapView.getMap();
  if (map && courseLayer) {
    map.removeLayer(courseLayer);
    courseLayer = null;
  }
}

function addPointToCourse(courseId: string, lat: number, lon: number) {
  const course = courses.find(c => c.id === courseId);
  if (!course) return;

  const newPoint: CoursePoint = {
    lat,
    lon,
    radius: 20, // 20m default radius
  };

  course.points.push(newPoint);
  saveCourses();
  renderCourseOnMap(courseId);
  renderCourses(); // Update list to show point count
}

function renderCourseOnMap(courseId: string) {
  const course = courses.find(c => c.id === courseId);
  if (!course || !courseLayer) return;
  const cl = courseLayer;

  const map = MapView.getMap();
  if (!map) return;

  cl.clearLayers();

  const latlngs = course.points.map(p => [p.lat, p.lon] as [number, number]);

  if (latlngs.length > 1) {
    L.polyline(latlngs, { color: '#3b82f6', weight: 4 }).addTo(cl);
  }

  course.points.forEach((p, idx) => {
    const isStart = idx === 0;
    const isEnd = idx === course.points.length - 1 && idx > 0;

    let color = '#3b82f6';
    let iconHtml = 'fiber_manual_record';
    if (isStart) { iconHtml = 'play_circle'; }
    if (isEnd) { iconHtml = 'stop_circle'; }

    const icon = L.divIcon({
      className: 'course-point-marker',
      html: `<span class="material-symbols-rounded" style="color:${color}; font-size:24px;">${iconHtml}</span>`,
      iconSize: [24, 24],
      iconAnchor: [12, 12],
    });

    const marker = L.marker([p.lat, p.lon], {
      icon,
      draggable: isEditMode,
    }).addTo(cl);

    const circle = L.circle([p.lat, p.lon], {
      radius: p.radius,
      color: color,
      fillColor: color,
      fillOpacity: 0.2,
      weight: 1,
      interactive: false,
    }).addTo(cl);

    if (isEditMode) {
      marker.on('drag', (e: any) => {
        const newLatLng = e.latlng;
        circle.setLatLng(newLatLng);
        // Update point in memory
        p.lat = newLatLng.lat;
        p.lon = newLatLng.lng;
      });

      marker.on('dragend', () => {
        saveCourses();
        renderCourseOnMap(courseId); // redraw to update handle position
      });

      // Add a handle to resize the circle if zoomed in enough
      const currentZoom = map.getZoom();
      if (currentZoom >= 16) {
        let maxRadius = 100; // default fallback
        if (course.points.length > 1) {
          let minDist = Infinity;
          const pLatLng = L.latLng(p.lat, p.lon);
          course.points.forEach((otherP, oIdx) => {
            if (oIdx === idx) return;
            const otherLatLng = L.latLng(otherP.lat, otherP.lon);
            const dist = pLatLng.distanceTo(otherLatLng);
            if (dist < minDist) minDist = dist;
          });
          // Use half the distance to prevent overlap
          maxRadius = Math.max(5, minDist / 2);
        }

        const latRad = p.lat * Math.PI / 180;
        const deltaLon = p.radius / (111320 * Math.cos(latRad));
        
        const handleIcon = L.divIcon({
          className: 'course-point-handle',
          html: `<div style="width:12px; height:12px; background:#fff; border:2px solid #3b82f6; border-radius:50%;"></div>`,
          iconSize: [12, 12],
          iconAnchor: [6, 6],
        });

        const handle = L.marker([p.lat, p.lon + deltaLon], {
          icon: handleIcon,
          draggable: true,
        }).addTo(cl);

        handle.on('drag', (e: any) => {
          const center = L.latLng(p.lat, p.lon);
          const newRadius = center.distanceTo(e.latlng);
          p.radius = Math.min(maxRadius, Math.max(5, newRadius));
          circle.setRadius(p.radius);
        });

        handle.on('dragend', () => {
          saveCourses();
          renderCourseOnMap(courseId);
        });
      }
    }
  });
}

export function selectCourse(id: string, open: boolean = false) {
  activeCourseId = id;
  if (open) openCourseId = id;
  isEditMode = false;
  MapView.setCustomClickHandler(null); // Clear click handler
  
  const map = MapView.getMap();
  if (!map) return;

  clearCourseLayer();
  courseLayer = L.featureGroup().addTo(map);
  renderCourseOnMap(id);
  
  // Fit map to course
  const course = courses.find(c => c.id === id);
  if (course && course.points.length > 0) {
    const bounds = L.latLngBounds(course.points.map(p => [p.lat, p.lon]));
    map.fitBounds(bounds.pad(0.1));
  }
  
  renderCourses();
}

function deleteCourse(id: string) {
  if (!confirm('Are you sure you want to delete this course?')) return;
  courses = courses.filter(c => c.id !== id);
  if (activeCourseId === id) {
    activeCourseId = null;
    clearCourseLayer();
  }
  saveCourses();
  renderCourses();
}
