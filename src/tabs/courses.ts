// Copyright (c) 2026, Camillo Bruni.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

'use strict';

import { MapView } from '../map';
import { Storage } from '../storage';
import { UrlState } from '../url-state';
import { escHtml } from '../utils';
import L from 'leaflet';

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
let activeCourseId: string | null = null;
let isEditMode = false;
let openCourseId: string | null = null;
let toastFn: (msg: string, type?: string) => void = () => {};
let courseLayer: L.FeatureGroup | null = null;

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

function findCourseRange(track: any, coursePoints: CoursePoint[]): {startIdx: number, endIdx: number} | null {
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

function calculateCourseStats(track: any, startIdx: number, endIdx: number) {
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
  
  for (const p of points) {
    if (p.power !== null) {
      totalPower += p.power;
      powerCount++;
    }
    if (p.hr !== null) {
      totalHR += p.hr;
      hrCount++;
    }
    if (p.speed !== null) {
      totalSpeed += p.speed;
      speedCount++;
    }
  }
  
  return {
    duration,
    avgWatts: powerCount > 0 ? Math.round(totalPower / powerCount) : null,
    avgHR: hrCount > 0 ? Math.round(totalHR / hrCount) : null,
    avgSpeed: speedCount > 0 ? totalSpeed / speedCount : null,
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
          const isOpen = c.id === openCourseId;
          let tracksHtml = '';
          if (isOpen) {
            const pts = c.points.map(p => ({ lat: p.lat, lng: p.lon }));
            const matchingIds = MapView.findTracksPassingThroughPoints(pts, c.points[0]?.radius || 20);
            
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
                        <th><span class="material-symbols-rounded metric-icon date" title="Date">calendar_today</span> Date</th>
                        <th><span class="material-symbols-rounded metric-icon duration" title="Duration">timer</span> Duration</th>
                        <th><span class="material-symbols-rounded metric-icon speed" title="Avg Speed">speed</span> Speed</th>
                        <th><span class="material-symbols-rounded metric-icon power" title="Avg Power">bolt</span> Power</th>
                        <th><span class="material-symbols-rounded metric-icon hr" title="Avg Heart Rate">favorite</span> HR</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${matchedTracksWithStats.map(t => `
                        <tr class="course-track-row" data-track-id="${t.id}" data-start="${t.startIdx}" data-end="${t.endIdx}">
                          <td class="track-name-cell clickable">${escHtml(t.displayName)}</td>
                          <td>${t.date}</td>
                          <td>${formatDuration(t.duration)}</td>
                          <td>${t.avgSpeed !== null ? (t.avgSpeed * 3.6).toFixed(1) + '&nbsp;km/h' : '-'}</td>
                          <td>${t.avgWatts !== null ? t.avgWatts + '&nbsp;W' : '-'}</td>
                          <td>${t.avgHR !== null ? t.avgHR + '&nbsp;bpm' : '-'}</td>
                        </tr>
                      `).join('')}
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
                <div class="course-meta"><span class="material-symbols-rounded" style="font-size: 14px; vertical-align: middle;" title="Distance">straighten</span> ${calculateCourseDistance(c).toFixed(2)} km | ${c.points.length} points</div>
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
          MapView.setSelectedTrack(trackId, false);
          MapView.highlightSegment(trackId, track.points, startIdx, endIdx, true);
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
  const newName = prompt('Enter new course name:', course.name);
  if (newName && newName.trim() !== '') {
    course.name = newName.trim();
    saveCourses();
    renderCourses();
  }
}

function editCourse(id: string) {
  activeCourseId = id;
  isEditMode = true;
  toastFn('Click on map to add points. Drag to move.', 'info');
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
    L.polyline(latlngs, { color: '#ff0055', weight: 4 }).addTo(cl);
  }

  course.points.forEach((p, idx) => {
    const isStart = idx === 0;
    const isEnd = idx === course.points.length - 1 && idx > 0;
    const isCheckpoint = !isStart && !isEnd;

    let color = '#ff0055';
    let iconHtml = 'fiber_manual_record';
    if (isStart) { color = '#00cc44'; iconHtml = 'play_circle'; }
    if (isEnd) { color = '#cc0000'; iconHtml = 'stop_circle'; }
    if (isCheckpoint) { color = '#ffaa00'; iconHtml = 'location_on'; }

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
        renderCourseOnMap(courseId); // redraw to update polyline
      });
    }
  });
}

function selectCourse(id: string) {
  activeCourseId = id;
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
