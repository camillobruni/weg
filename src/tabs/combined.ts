// Copyright (c) 2026, Camillo Bruni.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

'use strict';

import uPlot from 'uplot';
import { TrackData, TrackPoint } from '../parsers';
import { ChartView } from '../charts';
import { hexToRgba, fmtSecs } from '../utils';

let currentTrack: TrackData | null = null;
let plot: uPlot | null = null;
let xMetric = 'power';
let yMetric = 'hr';
let currentSliderIdx: number | null = null;
let currentChronoData: [number, number, number, number, number][] = [];
let currentSortedData: [number, number, number, number, number][] = [];
let playIntervalId: number | null = null;

function updateSliderLabel() {
  const sliderVal = document.getElementById('combined-time-val');
  if (sliderVal && currentSliderIdx !== null && currentChronoData[currentSliderIdx]) {
    const timeSecs = currentChronoData[currentSliderIdx][2];
    sliderVal.textContent = `${fmtSecs(timeSecs)}`;
  }
}

export function initCombined() {
  // Initialize UI event listeners if needed
}

export function renderCombined(track: TrackData | null) {
  currentTrack = track;
  const container = document.getElementById('combined-view');
  if (!container) return;

  if (!track) {
    container.innerHTML = `
      <div class="empty-state">
        <span class="material-symbols-rounded empty-icon">no_sim</span>
        <div class="empty-text">Select a track for combined analysis</div>
      </div>
    `;
    return;
  }

  // Find available metrics in the track
  const metrics = ChartView.METRICS;
  const availableMetrics: string[] = [];
  for (const key in metrics) {
    const def = metrics[key];
    if (track.points.some(p => (p as any)[def.field] != null)) {
      availableMetrics.push(key);
    }
  }

  // Default to first two available if defaults are not available
  if (!availableMetrics.includes(xMetric) && availableMetrics.length > 0) {
    xMetric = availableMetrics[0];
  }
  if (!availableMetrics.includes(yMetric) && availableMetrics.length > 1) {
    yMetric = availableMetrics[1];
  } else if (!availableMetrics.includes(yMetric) && availableMetrics.length > 0) {
    yMetric = availableMetrics[0];
  }

  const xDef = metrics[xMetric];
  const yDef = metrics[yMetric];

  // Prevent scrolling and runaway size
  container.style.overflow = 'hidden';

  // Render UI with selectors and plot container
  container.innerHTML = `
    <div class="combined-controls" style="display: flex; align-items: center; padding: 6px 12px; gap: 12px; border-bottom: 1px solid var(--border); background: var(--bg); min-height: 40px; box-sizing: border-box;">
      <div class="selector-group" style="display: flex; align-items: center; gap: 6px;">
        <span class="material-symbols-rounded" style="font-size: 18px; color: var(--text-muted);">arrow_forward</span>
        <span style="font-size: 12px; font-weight: 600; color: var(--text-muted);">X Axis:</span>
        <button id="btn-combined-x" class="sort-select-btn" style="min-width: 150px;">
          <span class="material-symbols-rounded" style="color: ${xDef.color}">${xDef.icon}</span>
          <span class="item-label">${xDef.label}</span>
          <span class="material-symbols-rounded arrow">expand_more</span>
        </button>
      </div>
      <div class="selector-group" style="display: flex; align-items: center; gap: 6px;">
        <span class="material-symbols-rounded" style="font-size: 18px; color: var(--text-muted);">arrow_upward</span>
        <span style="font-size: 12px; font-weight: 600; color: var(--text-muted);">Y Axis:</span>
        <button id="btn-combined-y" class="sort-select-btn" style="min-width: 150px;">
          <span class="material-symbols-rounded" style="color: ${yDef.color}">${yDef.icon}</span>
          <span class="item-label">${yDef.label}</span>
          <span class="material-symbols-rounded arrow">expand_more</span>
        </button>
      </div>
      <div class="slider-group" style="display: flex; align-items: center; gap: 6px; flex: 1;">
        <span class="material-symbols-rounded" style="font-size: 18px; color: var(--text-muted);">schedule</span>
        <span style="font-size: 12px; font-weight: 600; color: var(--text-muted);">Time:</span>
        <input type="range" id="combined-time-slider" min="0" max="100" value="0" style="flex: 1;">
        <span id="combined-time-val" style="font-size: 11px; color: var(--text); background: var(--surface3); padding: 3px 8px; border-radius: 12px; border: 1px solid var(--border); min-width: 65px; text-align: center; flex-shrink: 0;">0:00</span>
        <button id="btn-combined-play" class="sort-select-btn" style="padding: 4px; flex: 0 0 28px; height: 28px; width: 28px; justify-content: center;">
          <span class="material-symbols-rounded">play_arrow</span>
        </button>
      </div>
    </div>
    <div id="combined-plot-container" style="width: 100%; flex: 1; min-height: 0; background: var(--surface2); padding: 0; overflow: hidden;"></div>
  `;

  document.getElementById('btn-combined-x')?.addEventListener('click', (e) => {
    e.stopPropagation();
    showMenu(e.currentTarget as HTMLElement, 'x');
  });

  document.getElementById('btn-combined-y')?.addEventListener('click', (e) => {
    e.stopPropagation();
    showMenu(e.currentTarget as HTMLElement, 'y');
  });

  const slider = document.getElementById('combined-time-slider') as HTMLInputElement;
  const sliderVal = document.getElementById('combined-time-val');
  const playBtn = document.getElementById('btn-combined-play');
  
  slider?.addEventListener('input', () => {
    currentSliderIdx = parseInt(slider.value, 10);
    updateSliderLabel();
    if (plot) {
      plot.redraw();
    }
  });

  function startPlaying() {
    if (playBtn) {
      playBtn.innerHTML = '<span class="material-symbols-rounded">pause</span>';
    }
    playIntervalId = window.setInterval(() => {
      if (currentSliderIdx !== null && currentSliderIdx < currentChronoData.length - 1) {
        currentSliderIdx = Math.min(currentSliderIdx + 5, currentChronoData.length - 1);
        slider.value = `${currentSliderIdx}`;
        updateSliderLabel();
        if (plot) plot.redraw();
      } else {
        stopPlaying();
      }
    }, 20); // 50 fps
  }

  function stopPlaying() {
    if (playIntervalId) {
      clearInterval(playIntervalId);
      playIntervalId = null;
    }
    if (playBtn) {
      playBtn.innerHTML = '<span class="material-symbols-rounded">play_arrow</span>';
    }
  }

  playBtn?.addEventListener('click', () => {
    if (playIntervalId) {
      stopPlaying();
    } else {
      // If at the end, loop back to start
      if (currentSliderIdx !== null && currentSliderIdx >= currentChronoData.length - 1) {
        currentSliderIdx = 0;
        slider.value = '0';
        updateSliderLabel();
        if (plot) plot.redraw();
      }
      startPlaying();
    }
  });

  updatePlot();
}

export function resizeCombined() {
  const container = document.getElementById('tab-combined');
  const plotContainer = document.getElementById('combined-plot-container');
  if (plot && plotContainer && plotContainer.clientWidth > 0) {
    const w = plotContainer.clientWidth;
    const h = plotContainer.clientHeight;
    
    if (w > 0 && h > 0) {
      plot.setSize({ width: w, height: h });
    }
  }
}

function showMenu(anchorEl: HTMLElement, axis: 'x' | 'y') {
  document.querySelectorAll('.metric-menu-popup').forEach((el) => el.remove());

  const popup = document.createElement('div');
  popup.className = 'metric-menu-popup';

  const metrics = ChartView.METRICS;
  const track = currentTrack;
  if (!track) return;

  const availableMetrics: string[] = [];
  for (const key in metrics) {
    const def = metrics[key];
    if (track.points.some(p => (p as any)[def.field] != null)) {
      availableMetrics.push(key);
    }
  }

  availableMetrics.forEach((key) => {
    const def = metrics[key];
    const item = document.createElement('div');
    const currentVal = axis === 'x' ? xMetric : yMetric;
    item.className = `menu-item ${currentVal === key ? 'active' : ''}`;
    item.innerHTML = `
      <span class="material-symbols-rounded" style="color:${def.color}">${def.icon}</span>
      <span class="item-label">${def.label}</span>
      <span class="material-symbols-rounded check">${currentVal === key ? 'check' : ''}</span>
    `;
    item.addEventListener('click', () => {
      if (axis === 'x') {
        xMetric = key;
      } else {
        yMetric = key;
      }
      popup.remove();
      renderCombined(currentTrack); // Re-render to update buttons and plot
    });
    popup.appendChild(item);
  });

  const rect = anchorEl.getBoundingClientRect();
  popup.style.top = `${rect.bottom + 5}px`;
  popup.style.left = `${rect.left}px`;
  document.body.appendChild(popup);

  const close = (e: MouseEvent) => {
    if (!popup.contains(e.target as Node) && !anchorEl.contains(e.target as Node)) {
      popup.remove();
      document.removeEventListener('click', close);
    }
  };
  setTimeout(() => document.addEventListener('click', close), 0);
}

function updatePlot() {
  if (!currentTrack) return;
  const container = document.getElementById('combined-plot-container');
  if (!container) return;

  const metrics = ChartView.METRICS;
  const xDef = metrics[xMetric];
  const yDef = metrics[yMetric];

  const pts = currentTrack.points;
  const t0 = pts[0].time || 0;
  currentChronoData = pts
    .map((p, idx) => [(p as any)[xDef.field], (p as any)[yDef.field], (p.time! - t0) / 1000, (p.dist || 0) / 1000, idx])
    .filter(([x, y, t, d]) => x != null && y != null) as [number, number, number, number, number][];

  const chronoData = currentChronoData;

  if (chronoData.length === 0) {
    container.innerHTML = '<div class="empty-text" style="display: flex; align-items: center; justify-content: center; height: 100%; color: var(--text-dim);">No data for selected metrics</div>';
    return;
  }

  // Update slider
  const slider = document.getElementById('combined-time-slider') as HTMLInputElement;
  const sliderVal = document.getElementById('combined-time-val');
  if (slider) {
    slider.max = `${chronoData.length - 1}`;
    if (currentSliderIdx === null || currentSliderIdx >= chronoData.length) {
      currentSliderIdx = chronoData.length - 1;
      slider.value = slider.max;
    }
    updateSliderLabel();
  }

  // Sort by X for uPlot
  currentSortedData = [...chronoData].sort((a, b) => a[0] - b[0]);
  const sortedData = currentSortedData;

  const xData = sortedData.map(d => d[0]);
  const yData = sortedData.map(d => d[1]);

  const plotContainer = document.getElementById('combined-plot-container');
  const opts: uPlot.Options = {
    width: (plotContainer && plotContainer.clientWidth > 0) ? plotContainer.clientWidth : 600,
    height: (plotContainer && plotContainer.clientHeight > 0) ? plotContainer.clientHeight : 400,
    padding: [10, 15, 0, 0],
    scales: {
      x: { time: false, auto: true },
      y: { auto: true },
    },
    series: [
      {},
      {
        label: yDef.label,
        width: 0,
        points: { show: true, size: 3, fill: hexToRgba(yDef.color, 0.3) },
      },
    ],
    axes: [
      {
        side: 2, // bottom
        label: `${xDef.label} (${xDef.unit})`,
        stroke: '#555564',
        grid: { stroke: '#2e2e34', width: 1 },
        font: '10px system-ui',
        values: (u, vals) => vals.map(v => v != null ? xDef.fmtAxis(v) : ''),
        size: 30,
      },
      {
        side: 3, // left
        label: `${yDef.label} (${yDef.unit})`,
        stroke: '#555564',
        grid: { stroke: '#2e2e34', width: 1 },
        font: '10px system-ui',
        values: (u, vals) => vals.map(v => v != null ? yDef.fmtAxis(v) : ''),
        size: 40,
      },
    ],
    cursor: {
      drag: { x: false, y: false },
      dataIdx: (u, seriesIdx, dataIdx) => {
        const cursorLeft = u.cursor.left;
        const cursorTop = u.cursor.top;
        if (cursorLeft != null && cursorTop != null && cursorLeft >= 0 && cursorTop >= 0) {
          let minD2 = Infinity;
          let closestIdx = -1;

          for (let i = 0; i < currentSortedData.length; i++) {
            const [xVal, yVal] = currentSortedData[i];
            const cx = u.valToPos(xVal, 'x');
            const cy = u.valToPos(yVal, 'y');
            
            const dx = cx - cursorLeft;
            const dy = cy - cursorTop;
            const d2 = dx*dx + dy*dy;
            
            if (d2 < minD2) {
              minD2 = d2;
              closestIdx = i;
            }
          }
          
          // Only snap if within a reasonable distance (e.g. 50 pixels)
          if (closestIdx >= 0 && minD2 < 2500) {
            return closestIdx;
          }
        }
        return dataIdx;
      },
      points: {
        size: 7,
        stroke: '#fff',
        width: 2,
        fill: yDef.color,
      }
    },
    legend: { show: false },
    hooks: {
      draw: [
        (u: uPlot) => {
          const ctx = u.ctx;
          const dpr = window.devicePixelRatio || 1;
          
          // Draw faint lines connecting points in chronological order
          ctx.save();
          ctx.beginPath();
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
          ctx.lineWidth = 1 * dpr;
          
          let started = false;
          for (let i = 0; i < chronoData.length; i++) {
            const [xVal, yVal] = chronoData[i];
            const cx = u.valToPos(xVal, 'x', true);
            const cy = u.valToPos(yVal, 'y', true);
            
            if (started) {
              ctx.lineTo(cx, cy);
            } else {
              ctx.moveTo(cx, cy);
              started = true;
            }
          }
          ctx.stroke();
          ctx.restore();

          // Draw trail if slider is active
          if (currentSliderIdx !== null) {
            ctx.save();
            const windowSize = 100; // Longer trail
            const startIdx = Math.max(0, currentSliderIdx - windowSize);
            const endIdx = currentSliderIdx;
            
            // 1. Draw increasingly thicker connection line for the trail
            for (let i = startIdx; i < endIdx; i++) {
              const [xVal1, yVal1] = chronoData[i];
              const [xVal2, yVal2] = chronoData[i+1];
              const cx1 = u.valToPos(xVal1, 'x', true);
              const cy1 = u.valToPos(yVal1, 'y', true);
              const cx2 = u.valToPos(xVal2, 'x', true);
              const cy2 = u.valToPos(yVal2, 'y', true);
              
              const progress = (i - startIdx) / (endIdx - startIdx || 1);
              const lineWidth = 1 + 5 * progress; // Grow from 1 to 6
              const alpha = 0.15 + 0.6 * progress; // Fade from 0.15 to 0.75
              
              ctx.beginPath();
              ctx.moveTo(cx1, cy1);
              ctx.lineTo(cx2, cy2);
              ctx.strokeStyle = hexToRgba(yDef.color, alpha);
              ctx.lineWidth = lineWidth * dpr;
              ctx.stroke();
            }

            // 2. Draw dots on top
            for (let i = startIdx; i <= endIdx; i++) {
              const [xVal, yVal] = chronoData[i];
              const cx = u.valToPos(xVal, 'x', true);
              const cy = u.valToPos(yVal, 'y', true);
              
              const progress = (i - startIdx) / (endIdx - startIdx || 1);
              const size = 3 + 7 * progress; // Grow from 3 to 10
              const fillAlpha = 0.01 + 0.14 * progress; // Fade from 0.01 to 0.15
              
              ctx.beginPath();
              ctx.arc(cx, cy, size * dpr, 0, Math.PI * 2);
              ctx.fillStyle = hexToRgba(yDef.color, fillAlpha);
              ctx.fill();
              
              ctx.strokeStyle = yDef.color;
              ctx.lineWidth = 1 * dpr;
              ctx.stroke();
            }
            ctx.restore();
          }
        }
      ],
      setCursor: [
        (u: uPlot) => {
          const idx = u.cursor.idx;
          
          let tooltip = document.getElementById('combined-tooltip');
          if (!tooltip) {
            tooltip = document.createElement('div');
            tooltip.id = 'combined-tooltip';
            tooltip.style.position = 'absolute';
            tooltip.style.background = 'rgba(14, 14, 16, 0.9)';
            tooltip.style.color = '#fff';
            tooltip.style.padding = '8px 12px';
            tooltip.style.borderRadius = '4px';
            tooltip.style.fontSize = '12px';
            tooltip.style.fontFamily = 'system-ui';
            tooltip.style.pointerEvents = 'none';
            tooltip.style.zIndex = '1000';
            tooltip.style.boxShadow = '0 4px 6px rgba(0,0,0,0.3)';
            tooltip.style.border = '1px solid #2e2e34';
            document.body.appendChild(tooltip);
          }

          if (idx != null && currentSortedData[idx] && u.cursor.left! >= 0) {
            const [xVal, yVal, timeSecs, distKm] = currentSortedData[idx];
            tooltip.innerHTML = `
              <div style="color: #8a8a93; margin-bottom: 4px;">Point #${idx}</div>
              <div style="display: flex; justify-content: space-between; gap: 15px;">
                <span>Time:</span>
                <span style="font-weight: bold;">${fmtSecs(timeSecs)}</span>
              </div>
              <div style="display: flex; justify-content: space-between; gap: 15px;">
                <span>Distance:</span>
                <span style="font-weight: bold;">${distKm.toFixed(2)} km</span>
              </div>
              <div style="display: flex; justify-content: space-between; gap: 15px;">
                <span>${xDef.label}:</span>
                <span style="font-weight: bold;">${xDef.fmtAxis(xVal)} ${xDef.unit}</span>
              </div>
              <div style="display: flex; justify-content: space-between; gap: 15px;">
                <span>${yDef.label}:</span>
                <span style="font-weight: bold; color: ${yDef.color}">${yDef.fmtAxis(yVal)} ${yDef.unit}</span>
              </div>
            `;
            tooltip.style.display = 'block';
            
            const canvasRect = u.over.getBoundingClientRect();
            tooltip.style.left = `${canvasRect.left + window.scrollX + u.cursor.left! + 15}px`;
            tooltip.style.top = `${canvasRect.top + window.scrollY + u.cursor.top! + 15}px`;
          } else {
            tooltip.style.display = 'none';
          }
        }
      ]
    }
  };

  // Clear container before rendering (except when uPlot does it)
  // uPlot handles its own canvas, but we need to clear any previous empty state message
  if (container.querySelector('.empty-text')) {
    container.innerHTML = '';
  }

  if (plot) {
    plot.destroy();
  }

  plot = new uPlot(opts, [xData, yData], container);
  
  plot.over.addEventListener('click', () => {
    if (plot) {
      const idx = plot.cursor.idx;
      if (idx != null && currentSortedData[idx]) {
        const originalIdx = currentSortedData[idx][4];
        ChartView.setCursorAt(originalIdx);
      }
    }
  });
  
  // Ensure initial size is set correctly
  setTimeout(() => {
    resizeCombined();
  }, 0);
}
