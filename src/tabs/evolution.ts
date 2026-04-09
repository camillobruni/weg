// Copyright (c) 2026, Camillo Bruni.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

'use strict';

import uPlot from 'uplot';
import { TrackData } from '../parsers';
import { Storage } from '../storage';
import { fmtDuration, gaussianSmooth, hexToRgba } from '../utils';
import { Colors } from '../colors';

export function renderEvolution(currentTrack: TrackData | null, allTracks: TrackData[]) {
  const container = document.getElementById('evolution-view');
  if (!container) return;

  if (!currentTrack) {
    container.innerHTML = `
      <div class="empty-state">
        <span class="material-symbols-rounded empty-icon">no_sim</span>
        <div class="empty-text">Select a track for evolution analysis</div>
      </div>
    `;
    return;
  }

  container.innerHTML = `
    <div class="insights-grid" id="evolution-grid"></div>
  `;

  const grid = document.getElementById('evolution-grid');
  if (!grid) return;

  if (currentTrack.stats.powerCurve) {
    renderCurveEvolutionCard({
      grid,
      currentTrack,
      allTracks,
      metricKey: 'power',
      label: 'Power Curve Evolution',
      unit: 'W',
      color: Colors.power,
      icon: 'bolt',
    });
  }

  if (currentTrack.stats.hrCurve) {
    renderCurveEvolutionCard({
      grid,
      currentTrack,
      allTracks,
      metricKey: 'hr',
      label: 'Heart Rate Curve Evolution',
      unit: 'bpm',
      color: Colors.hr,
      icon: 'favorite',
    });
  }
}

interface CurveEvolutionCardOptions {
  grid: HTMLElement;
  currentTrack: TrackData;
  allTracks: TrackData[];
  metricKey: 'power' | 'hr';
  label: string;
  unit: string;
  color: string;
  icon: string;
}

function renderCurveEvolutionCard(opts: CurveEvolutionCardOptions) {
  const { grid, currentTrack, allTracks, metricKey, label, unit, color, icon } = opts;

  const card = document.createElement('div');
  const trackName = currentTrack ? (currentTrack.name || 'Current Track') : 'Current Track';

  card.className = 'insight-card';
  card.style.setProperty('--chart-color', color);
  card.style.gap = '0';
  card.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0">
      <div style="display:flex; align-items:center; gap:8px">
        <div class="insight-title" style="margin-bottom:0">
          <span class="material-symbols-rounded" style="color:${color}">${icon}</span>${label}
        </div>
      </div>
    </div>
    <div id="${metricKey}-evolution-chart" class="insight-chart-container" style="margin-bottom: 0;"></div>
    <div class="evolution-legend" style="display:flex; gap:16px; font-size:12px; color:var(--text-dim); margin-top:0; margin-bottom:0; justify-content:center">
      <div style="display:flex; align-items:center; gap:6px">
        <span style="width:16px; height:0; border-top:2px solid ${color}; display:inline-block"></span>
        <span>${trackName}</span>
      </div>
      <div style="display:flex; align-items:center; gap:6px">
        <span style="width:16px; height:0; border-top:2px dashed #888888; display:inline-block"></span>
        <span>All-Time Max</span>
      </div>
    </div>
    <div id="${metricKey}-timeline-chart" class="insight-chart-container" style="height: 150px; margin-top: 0;"></div>
    <div id="${metricKey}-timeline-label" style="text-align: center; color: var(--text-dim); font-size: 12px; margin-top: 4px;">Evolution ${metricKey === 'power' ? 'Power' : 'HR'}</div>
  `;
  grid.appendChild(card);

  const chartEl = card.querySelector(`#${metricKey}-evolution-chart`) as HTMLElement;
  if (!chartEl) return;

  // 1. Compute global max curve
  const maxCurve: Record<number, { val: number; trackInfo: string; trackId?: string; idx?: number }> = {};
  allTracks.forEach(t => {
    const curve = metricKey === 'power' ? t.stats.powerCurve : t.stats.hrCurve;
    if (!curve) return;
    const name = t.name || 'Unnamed Track';
    const date = t.addedAt ? new Date(t.addedAt).toLocaleDateString() : 'Unknown Date';
    const trackInfo = `${name} (${date})`;

    Object.entries(curve).forEach(([dur, data]) => {
      const d = Number(dur);
      const val = (data as any).power || (data as any).hr;
      if (!maxCurve[d] || val > maxCurve[d].val) {
        maxCurve[d] = { val, trackInfo, trackId: t.id, idx: (data as any).idx };
      }
    });
  });

  // 2. Get current track curve
  const currentCurve = (metricKey === 'power' ? currentTrack.stats.powerCurve : currentTrack.stats.hrCurve) || {};

  // 3. Combine durations
  const allDurations = new Set<number>();
  Object.keys(maxCurve).forEach(d => allDurations.add(Number(d)));
  Object.keys(currentCurve).forEach(d => allDurations.add(Number(d)));
  const durations = Array.from(allDurations).sort((a, b) => a - b);

  const xData = durations;
  const yDataCurrent = durations.map(d => {
    const entry = currentCurve[d];
    return entry ? ((entry as any).power || (entry as any).hr) : null;
  });
  const yDataMax = durations.map(d => maxCurve[d]?.val || null);

  // Precompute timeline data for all tracks
  const validTracks = allTracks.filter(t => t.addedAt != null);
  validTracks.sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));

  const xTimeline: number[] = [];
  const yTimelineData: Record<number, (number | null)[]> = {};
  durations.forEach(d => yTimelineData[d] = []);

  validTracks.forEach(t => {
    const curve = metricKey === 'power' ? t.stats.powerCurve : t.stats.hrCurve;
    if (!curve) return;
    
    xTimeline.push(t.addedAt! / 1000); // seconds
    durations.forEach(d => {
      const entry = curve[d];
      const val = entry ? ((entry as any).power || (entry as any).hr) : null;
      yTimelineData[d].push(val);
    });
  });

  const xIndices = xTimeline.map((_, i) => i);
  let timelineChart: uPlot | null = null;

  const curYVal = document.createElement('div');
  curYVal.className = 'cur-y-val';
  curYVal.style.cssText = `position:absolute;background:rgba(14, 14, 16, 0.9);color:#fff;padding:8px 12px;border-radius:4px;font-size:12px;font-family:system-ui;pointer-events:none;z-index:1000;box-shadow:0 4px 6px rgba(0,0,0,0.3);border:1px solid #2e2e34;display:none;`;
  chartEl.style.position = 'relative';
  chartEl.appendChild(curYVal);

  requestAnimationFrame(() => {
    const optsUPlot: uPlot.Options = {
      id: `${metricKey}-evolution`,
      width: chartEl.clientWidth || 500,
      height: 250,
      padding: [0, 10, 0, 10],
      scales: {
        x: { time: false, distr: 3, auto: true },
        y: { auto: true },
      },
      series: [
        {},
        {
          label: 'Current Track',
          stroke: color,
          width: 2,
          fill: hexToRgba(color, 0.1),
          points: { show: true, size: 5, fill: color },
        },
        {
          label: 'All-Time Max',
          stroke: '#888888',
          width: 1,
          fill: 'transparent',
          points: { show: true, size: 3, fill: '#888888' },
          dash: [5, 5],
        },
      ],
      axes: [
        {
          stroke: '#555564',
          grid: { stroke: '#2e2e34', width: 1 },
          show: true,
          values: () => [],
          ticks: { show: false },
          font: '10px system-ui, sans-serif',
        },
        {
          stroke: '#555564',
          grid: { stroke: '#2e2e34', width: 1 },
          values: (_u, vals) => vals.map((v) => `${v}${unit}`),
          font: '10px system-ui, sans-serif',
        },
      ],
      cursor: {
        drag: { x: false, y: false },
        dataIdx: (u, seriesIdx, dataIdx) => dataIdx,
      },
      hooks: {
        draw: [
          (u: uPlot) => {
            const ctx = u.ctx;
            const dpr = window.devicePixelRatio || 1;
            const bb = u.bbox;
            const benchmarks = [1, 2, 5, 10, 20, 30, 60, 120, 300, 600, 1200, 1800, 3600, 7200, 10800];
            const maxDur = xData[xData.length - 1];

            ctx.save();
            ctx.fillStyle = '#555564';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            ctx.font = `${10 * dpr}px system-ui, sans-serif`;

            let lastX = -100;
            benchmarks.forEach(d => {
              if (d > maxDur) return;
              const x = u.valToPos(d, 'x', true);
              if (x > lastX + 30 * dpr && x < bb.left + bb.width + 5 * dpr) {
                ctx.fillText(fmtDuration(d), x, bb.top + bb.height + 6 * dpr);
                lastX = x;
              }
            });
            ctx.restore();
          }
        ],
        setCursor: [
          (u: uPlot) => {
            u.redraw(false);
            const idx = u.cursor.idx;
            const ctx = u.ctx;
            const dpr = window.devicePixelRatio || 1;
            const bb = u.bbox;

            const hasFocus = idx != null && xData[idx] != null && u.cursor.left! >= 0;

            if (hasFocus) {
              const cx = u.valToPos(xData[idx!]!, 'x', false);
              const cy = u.valToPos(yDataCurrent[idx!]! || yDataMax[idx!]!, 'y', false); // Fallback to max if current is null

              const durVal = xData[idx!];
              const curVal = yDataCurrent[idx!];
              const mxVal = yDataMax[idx!];
              
              let html = `<div style="font-weight: bold; margin-bottom: 4px;">${fmtDuration(durVal)}</div>`;
              if (curVal !== null) {
                html += `
                  <div style="display: flex; justify-content: space-between; gap: 15px;">
                    <span style="color: #8a8a93;">Current:</span>
                    <span style="font-weight: bold;">${curVal} ${unit}</span>
                  </div>
                `;
              }
              if (mxVal !== null) {
                html += `
                  <div style="display: flex; justify-content: space-between; gap: 15px;">
                    <span style="color: #8a8a93;">Max:</span>
                    <span style="font-weight: bold;">${mxVal} ${unit}</span>
                  </div>
                `;
              }

              curYVal.innerHTML = html;

              if (timelineChart) {
                const rawY = yTimelineData[durVal];
                const smoothedY = gaussianSmooth(rawY, 2);
                timelineChart.setData([xTimeline, rawY, smoothedY]);
                
                const labelEl = card.querySelector(`#${metricKey}-timeline-label`);
                if (labelEl) {
                  labelEl.textContent = `Evolution ${fmtDuration(durVal)} ${metricKey === 'power' ? 'Power' : 'HR'}`;
                }
              }
              curYVal.style.transform = `translate(${cx}px, ${cy}px) translate(6px, -50%)`;
              curYVal.style.display = '';

              // Draw vertical line
              const pcx = u.valToPos(xData[idx!]!, 'x', true);
              ctx.save();
              ctx.beginPath();
              ctx.setLineDash([2 * dpr, 2 * dpr]);
              ctx.strokeStyle = hexToRgba(color, 0.4);
              ctx.moveTo(pcx, bb.top);
              ctx.lineTo(pcx, bb.top + bb.height);
              ctx.stroke();
              ctx.restore();
            } else {
              curYVal.style.display = 'none';
            }
          }
        ]
      }
    };

    new uPlot(optsUPlot, [xData, yDataCurrent, yDataMax], chartEl);

    // 4. Add expandable table
    const detailsEl = document.createElement('details');
    detailsEl.style.marginTop = '15px';
    detailsEl.innerHTML = `
      <summary style="cursor:pointer; font-size:12px; color:var(--text-dim)">Show Data Table</summary>
      <table class="power-curve-table" style="margin-top:10px; width:100%; border-collapse:collapse; font-size:12px;">
        <thead>
          <tr style="text-align:left; color:var(--text-dim)">
            <th style="padding:4px 8px">Duration</th>
            <th style="padding:4px 8px">Current</th>
            <th style="padding:4px 8px">All-Time Max</th>
          </tr>
        </thead>
        <tbody>
          ${durations.map(d => {
            const cur = currentCurve[d] ? ((currentCurve[d] as any).power || (currentCurve[d] as any).hr) : '-';
            const mx = maxCurve[d]?.val || '-';
            const mxId = maxCurve[d]?.trackId;
            const mxIdx = maxCurve[d]?.idx;
            return `
              <tr style="border-top:1px solid #2e2e34">
                <td style="padding:4px 8px">${fmtDuration(d)}</td>
                <td style="padding:4px 8px">${cur} ${unit}</td>
                <td style="padding:4px 8px">
                  ${mx} ${unit}
                  ${mxId ? `<button class="evolution-select-btn" data-id="${mxId}" data-idx="${mxIdx}" data-dur="${d}" style="background:none; border:none; cursor:pointer; color:var(--chart-color); padding:0; font-size:14px; vertical-align:middle; margin-left:4px;" title="Select track and range">🎯</button>` : ''}
                </td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    `;
    card.appendChild(detailsEl);

    detailsEl.querySelectorAll('.evolution-select-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const id = btn.getAttribute('data-id');
        const idx = btn.getAttribute('data-idx');
        const dur = btn.getAttribute('data-dur');
        if (id) {
          document.dispatchEvent(new CustomEvent('select-track', { 
            detail: { 
              id, 
              idx: idx ? Number(idx) : null, 
              dur: dur ? Number(dur) : null 
            } 
          }));
        }
      });
    });

    // 5. Render timeline chart
    const timelineEl = card.querySelector(`#${metricKey}-timeline-chart`) as HTMLElement;
    if (timelineEl) {
      timelineEl.style.position = 'relative';
      const timelineTooltip = document.createElement('div');
      timelineTooltip.className = 'timeline-tooltip';
      timelineTooltip.style.cssText = `position:absolute;background:rgba(14, 14, 16, 0.9);color:#fff;padding:8px 12px;border-radius:4px;font-size:12px;font-family:system-ui;pointer-events:none;z-index:1000;box-shadow:0 4px 6px rgba(0,0,0,0.3);border:1px solid #2e2e34;display:none;`;
      timelineEl.appendChild(timelineTooltip);

      if (xTimeline.length > 0) {
        const series: any[] = [
          { value: (u: any, v: number) => {
            const idx = Math.round(v);
            if (idx >= 0 && idx < xTimeline.length) {
              return new Date(xTimeline[idx]! * 1000).toLocaleDateString();
            }
            return '-';
          } },
          {
            label: 'Value',
            stroke: color,
            width: 0,
            points: { show: true, size: 4, fill: hexToRgba(color, 0.8) }
          },
          {
            label: 'Trend',
            stroke: color,
            width: 2,
            points: { show: false }
          }
        ];

        // Default to the first duration in durations
        const defaultDur = durations[0] || 5;
        const rawY = yTimelineData[defaultDur];
        const smoothedY = gaussianSmooth(rawY, 2);
        const dataTimeline = [xTimeline, rawY, smoothedY];

        const labelEl = card.querySelector(`#${metricKey}-timeline-label`);
        if (labelEl) {
          labelEl.textContent = `Evolution ${fmtDuration(defaultDur)} ${metricKey === 'power' ? 'Power' : 'HR'}`;
        }

        const optsTimeline: uPlot.Options = {
          width: chartEl.clientWidth,
          height: 150,
          padding: [0, 10, 0, 10],
          scales: {
            x: {
              time: true,
              range: () => {
                const min = xTimeline[0] || 0;
                const max = xTimeline[xTimeline.length - 1] || 0;
                if (min === max) {
                  return [min - 3600, max + 3600];
                }
                return [min, max];
              }
            },
            y: { range: (u: any, min: number, max: number) => [min * 0.9, max * 1.1] }
          },
          series: series,
          hooks: {
            setCursor: [
              (u: uPlot) => {
                const idx = u.cursor.idx;
                if (idx != null && xTimeline[idx] != null && u.cursor.left! >= 0) {
                  const track = validTracks[idx];
                  const cx = u.valToPos(idx, 'x', false);
                  const cy = u.valToPos(u.data[1][idx]!, 'y', false);
                  
                  const d = new Date(xTimeline[idx]! * 1000);
                  const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
                  
                  const val = u.data[1][idx];
                  const valStr = val != null ? `${val} ${unit}` : '—';
                  
                  timelineTooltip.innerHTML = `
                    <div style="display: flex; justify-content: space-between; gap: 15px;">
                      <span style="color: #8a8a93;">Date:</span>
                      <span style="font-weight: bold;">${dateStr}</span>
                    </div>
                    <div style="display: flex; justify-content: space-between; gap: 15px;">
                      <span style="color: #8a8a93;">Value:</span>
                      <span style="font-weight: bold;">${valStr}</span>
                    </div>
                  `;
                  timelineTooltip.style.display = 'block';
                  timelineTooltip.style.transform = `translate(${cx}px, ${cy}px) translate(6px, -50%)`;
                } else {
                  timelineTooltip.style.display = 'none';
                }
              }
            ]
          },
          axes: [
            {
              space: 50,
              stroke: '#555564',
              grid: { stroke: '#2e2e34' },
              show: true,
              font: '10px system-ui, sans-serif',
              values: (u: any, vals: any[]) => vals.map(v => {
                const d = new Date(v * 1000);
                return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
              })
            },
            {
              stroke: '#555564',
              grid: { stroke: '#2e2e34' },
              font: '10px system-ui, sans-serif',
              values: (u: any, vals: any[]) => vals.map(v => `${v} ${unit}`),
              show: true,
              space: 15
            }
          ],
          cursor: {
            drag: { setScale: false }
          }
        };

        timelineChart = new uPlot(optsTimeline, dataTimeline as any, timelineEl);
      } else {
        timelineEl.innerHTML = `<div style="color:var(--text-dim); font-size:12px; text-align:center; margin-top:20px;">No data for the past year</div>`;
      }
    }
  });
}


