'use strict';

import uPlot from 'uplot';
import { TrackData, Parsers } from '../parsers';
import { Storage } from '../storage';
import { MapView } from '../map';
import { UrlState } from '../url-state';
import { fmtSecs, escHtml } from '../utils';

// We need a reference to the showToast function, which is currently in app.ts.
// For now, we'll assume it's passed in or globally available, but better to move it to utils too.
// Actually, let's import it from app.ts if possible, or just move it to utils.
// Moving showToast to utils is better.

let toastFn: (msg: string, type?: string) => void = () => {};
export function initInsights(showToast: (msg: string, type?: string) => void) {
  toastFn = showToast;
}

export function renderInsights(track: TrackData) {
  const container = document.getElementById('insights-view');
  if (!container) return;

  const s = track.stats;
  if (!s.powerCurve && !s.hrZones) {
    container.innerHTML = `
      <div class="empty-state">
        <span class="material-symbols-rounded empty-icon">analytics</span>
        <div class="empty-text">No insights available for this track (requires Power or Heart Rate data)</div>
      </div>
    `;
    return;
  }

  container.innerHTML = `
    <div class="insights-grid" id="insights-grid"></div>
  `;

  const grid = document.getElementById('insights-grid');
  if (!grid) return;

  if (s.powerCurve) {
    const card = document.createElement('div');
    card.className = 'insight-card';
    card.innerHTML = `
      <div class="insight-title">
        <span class="material-symbols-rounded" style="color:#F7DC6F">bolt</span>Power Curve
      </div>
      <div id="power-curve-chart" class="insight-chart-container"></div>
      <table class="power-curve-table">
        <thead>
          <tr>
            <th>Duration</th>
            <th style="text-align:right">Peak Power</th>
            <th style="width:32px"></th>
          </tr>
        </thead>
        <tbody id="power-curve-tbody"></tbody>
      </table>
    `;
    grid.appendChild(card);

    // Populate table
    const tbody = card.querySelector('#power-curve-tbody');
    const curve = s.powerCurve;
    const durations = Object.keys(curve)
      .map(Number)
      .sort((a, b) => a - b);

    durations.forEach((d) => {
      const entry = curve[d];
      const row = document.createElement('tr');
      const label = d < 60 ? `${d}s` : d < 3600 ? `${d / 60}m` : `${d / 3600}h`;
      row.innerHTML = `
        <td>${label}</td>
        <td class="power-curve-val">${entry.power} W</td>
        <td style="text-align:right">
          <button class="icon-btn mini btn-show-peak" title="Highlight on Map" data-idx="${entry.idx}" data-len="${d}">
            <span class="material-symbols-rounded" style="font-size:14px">visibility</span>
          </button>
        </td>
      `;
      tbody?.appendChild(row);
    });

    tbody?.querySelectorAll('.btn-show-peak').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const b = e.currentTarget as HTMLElement;
        const startIdx = parseInt(b.dataset.idx!);
        const duration = parseInt(b.dataset.len!);
        const pts = track.points;
        const endIdx = Math.min(pts.length - 1, startIdx + duration - 1);

        const t0 = pts[0].time || 0;
        const tMin = ((pts[startIdx].time || t0) - t0) / 1000;
        const tMax = ((pts[endIdx].time || t0) - t0) / 1000;

        UrlState.patch({ sel: [tMin, tMax] });
        MapView.highlightSegment(track.id, pts, startIdx, endIdx, true);
        toastFn(`Highlighted ${duration}s peak power segment`);
      });
    });

    // Render Chart
    const chartEl = card.querySelector('#power-curve-chart') as HTMLElement;
    if (chartEl) {
      const xData = durations;
      const yData = durations.map((d) => curve[d].power);

      const curYVal = document.createElement('div');
      curYVal.className = 'cur-y-val';
      curYVal.style.cssText = 'color:#F7DC6F;display:none;border-color:#F7DC6F44';
      chartEl.style.position = 'relative';
      chartEl.appendChild(curYVal);

      const opts: uPlot.Options = {
        id: 'power-curve',
        width: 0, // Will be set by ResizeObserver
        height: 250,
        padding: [10, 10, 0, 10],
        scales: {
          x: { time: false, distr: 3, auto: true },
          y: { auto: true },
        },
        series: [
          {},
          {
            label: 'Power',
            stroke: '#F7DC6F',
            width: 2,
            fill: 'rgba(247, 220, 111, 0.1)',
            points: { show: true, size: 5, fill: '#F7DC6F' },
          },
        ],
        axes: [
          {
            stroke: '#555564',
            grid: { stroke: '#2e2e34', width: 1 },
            space: 100,
            splits: [1, 5, 10, 30, 60, 120, 300, 600, 1200, 1800, 3600].filter(d => d <= xData[xData.length - 1]),
            values: (_u, vals) =>
              vals.map((v) => {
                if (v < 60) return `${v}s`;
                if (v < 3600) return `${v / 60}m`;
                return `${v / 3600}h`;
              }),
          },
          {
            stroke: '#555564',
            grid: { stroke: '#2e2e34', width: 1 },
            values: (_u, vals) => vals.map((v) => `${v}W`),
          },
        ],
        cursor: {
          drag: { x: false, y: false },
          dataIdx: (u, seriesIdx, dataIdx) => dataIdx,
        },
        hooks: {
          setCursor: [
            (u: uPlot) => {
              const idx = u.cursor.idx;
              if (idx != null && yData[idx] != null) {
                const cx = u.valToPos(xData[idx], 'x', false);
                const cy = u.valToPos(yData[idx], 'y', false);
                curYVal.innerHTML = `${yData[idx]} W`;
                curYVal.style.transform = `translate(${cx}px, ${cy}px) translate(6px, -50%)`;
                curYVal.style.display = '';
              } else {
                curYVal.style.display = 'none';
              }
            }
          ]
        },
        legend: { show: false },
      };

      // Ensure chart has width before creating
      const obs = new ResizeObserver(() => {
        if (chartEl.clientWidth > 0) {
          opts.width = chartEl.clientWidth;
          new uPlot(opts, [xData, yData], chartEl);
          obs.disconnect();
        }
      });
      obs.observe(chartEl);
    }
  }

  if (s.powerZones) {
    const card = document.createElement('div');
    card.className = 'insight-card';
    const totalTime = s.powerZones.reduce((a, b) => a + b, 0);
    const zoneLabels = [
      'Active Recovery (Z1)',
      'Endurance (Z2)',
      'Tempo (Z3)',
      'Threshold (Z4)',
      'VO2 Max (Z5)',
      'Anaerobic (Z6)',
      'Neuromuscular (Z7)',
    ];
    const zoneColors = ['#82E0AA', '#A8C8A0', '#F7DC6F', '#F8C471', '#F39C12', '#E67E22', '#C0392B'];

    let zonesHtml = '';
    s.powerZones.forEach((time, i) => {
      const pct = totalTime > 0 ? (time / totalTime) * 100 : 0;
      zonesHtml += `
        <div style="margin-bottom:12px">
          <div style="display:flex; justify-content:space-between; font-size:12px; margin-bottom:4px">
            <span style="font-weight:600; color:var(--text-muted)">${zoneLabels[i]}</span>
            <span style="color:var(--text)">${fmtSecs(Math.round(time))} (${pct.toFixed(1)}%)</span>
          </div>
          <div style="height:8px; background:var(--surface); border-radius:4px; overflow:hidden">
            <div style="height:100%; width:${pct}%; background:${zoneColors[i]}"></div>
          </div>
        </div>
      `;
    });

    card.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px">
        <div class="insight-title" style="margin-bottom:0">
          <span class="material-symbols-rounded" style="color:#F7DC6F">bolt</span>Power Zones
        </div>
        <button class="icon-btn mini btn-pw-settings" title="Configure FTP">
          <span class="material-symbols-rounded" style="font-size:16px">settings</span>
        </button>
      </div>
      <div style="padding: 5px 0">${zonesHtml}</div>
    `;
    grid.appendChild(card);

    card.querySelector('.btn-pw-settings')?.addEventListener('click', (e) => {
      e.stopPropagation();
      showPowerZoneSettings(e.currentTarget as HTMLElement, track);
    });
  }

  if (s.hrZones) {
    const card = document.createElement('div');
    card.className = 'insight-card';
    const totalTime = s.hrZones.reduce((a, b) => a + b, 0);
    const zoneLabels = ['Z1 (<120)', 'Z2 (120-140)', 'Z3 (140-160)', 'Z4 (160-180)', 'Z5 (>180)'];
    const zoneColors = ['#82E0AA', '#F7DC6F', '#F8C471', '#FF6B6B', '#C0392B'];

    let zonesHtml = '';
    s.hrZones.forEach((time, i) => {
      const pct = totalTime > 0 ? (time / totalTime) * 100 : 0;
      zonesHtml += `
        <div style="margin-bottom:12px">
          <div style="display:flex; justify-content:space-between; font-size:12px; margin-bottom:4px">
            <span style="font-weight:600; color:var(--text-muted)">${zoneLabels[i]}</span>
            <span style="color:var(--text)">${fmtSecs(Math.round(time))} (${pct.toFixed(1)}%)</span>
          </div>
          <div style="height:8px; background:var(--surface); border-radius:4px; overflow:hidden">
            <div style="height:100%; width:${pct}%; background:${zoneColors[i]}"></div>
          </div>
        </div>
      `;
    });

    card.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px">
        <div class="insight-title" style="margin-bottom:0">
          <span class="material-symbols-rounded" style="color:#FF6B6B">favorite</span>Heart Rate Zones
        </div>
        <button class="icon-btn mini btn-hr-settings" title="Configure HR Zones">
          <span class="material-symbols-rounded" style="font-size:16px">settings</span>
        </button>
      </div>
      <div style="padding: 5px 0">${zonesHtml}</div>
    `;
    grid.appendChild(card);

    card.querySelector('.btn-hr-settings')?.addEventListener('click', (e) => {
      e.stopPropagation();
      showHRZoneSettings(e.currentTarget as HTMLElement, track);
    });
  }

  // Climbing Analysis
  const climbingCard = document.createElement('div');
  climbingCard.className = 'insight-card';
  const distKm = s.totalDist / 1000;
  const grade = distKm > 0 ? (s.elevGain / (distKm * 1000)) * 100 : 0;

  climbingCard.innerHTML = `
    <div class="insight-title">
      <span class="material-symbols-rounded" style="color:#4ECDC4">terrain</span>Climbing Analysis
    </div>
    <div class="details-grid" style="grid-template-columns: repeat(2, 1fr); gap: 12px; margin-top: 10px">
      <div class="details-card" style="padding: 12px">
        <div class="details-card-label" style="font-size:10px">Total Ascent</div>
        <div class="details-card-value" style="font-size:16px">${Math.round(s.elevGain)} m</div>
      </div>
      <div class="details-card" style="padding: 12px">
        <div class="details-card-label" style="font-size:10px">Total Descent</div>
        <div class="details-card-value" style="font-size:16px">${Math.round(s.elevLoss)} m</div>
      </div>
      <div class="details-card" style="padding: 12px">
        <div class="details-card-label" style="font-size:10px">Avg Grade</div>
        <div class="details-card-value" style="font-size:16px">${grade.toFixed(1)} %</div>
      </div>
      <div class="details-card" style="padding: 12px">
        <div class="details-card-label" style="font-size:10px">VAM</div>
        <div class="details-card-value" style="font-size:16px">${s.duration && s.duration > 0 ? Math.round((s.elevGain / s.duration) * 3600000) : 0} m/h</div>
      </div>
    </div>
  `;
  grid.appendChild(climbingCard);

  // Efficiency (if both power and HR exist)
  if (s.avgPower && s.avgHR) {
    const effCard = document.createElement('div');
    effCard.className = 'insight-card';
    const ef = s.avgPower / s.avgHR;

    effCard.innerHTML = `
      <div class="insight-title">
        <span class="material-symbols-rounded" style="color:var(--accent)">monitoring</span>Efficiency Factor
      </div>
      <div class="details-grid" style="grid-template-columns: repeat(1, 1fr); gap: 12px; margin-top: 10px">
        <div class="details-card" style="padding: 12px">
          <div class="details-card-label" style="font-size:10px">EF (Avg Power / Avg HR)</div>
          <div class="details-card-value" style="font-size:24px">${ef.toFixed(2)}</div>
          <div class="details-subtitle" style="margin-top:4px">Higher values indicate better aerobic fitness.</div>
        </div>
      </div>
    `;
    grid.appendChild(effCard);
  }
}

function showHRZoneSettings(anchorEl: HTMLElement, track: TrackData) {
  document.querySelectorAll('.hr-settings-popup').forEach((el) => el.remove());

  const popup = document.createElement('div');
  popup.className = 'hr-settings-popup';

  const zones = Parsers.getHRZones();

  popup.innerHTML = `
    <div style="font-size:12px; font-weight:700; margin-bottom:12px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px">Configure HR Zones (bpm)</div>
    <div style="display:flex; flex-direction:column; gap:10px">
      <div class="hr-input-row">
        <span>Z1 / Z2</span>
        <input type="number" class="hr-zone-input" value="${zones[0]}" data-idx="0">
      </div>
      <div class="hr-input-row">
        <span>Z2 / Z3</span>
        <input type="number" class="hr-zone-input" value="${zones[1]}" data-idx="1">
      </div>
      <div class="hr-input-row">
        <span>Z3 / Z4</span>
        <input type="number" class="hr-zone-input" value="${zones[2]}" data-idx="2">
      </div>
      <div class="hr-input-row">
        <span>Z4 / Z5</span>
        <input type="number" class="hr-zone-input" value="${zones[3]}" data-idx="3">
      </div>
      <button class="save-btn" style="margin-top:6px">Update Zones</button>
    </div>
  `;

  const rect = anchorEl.getBoundingClientRect();
  popup.style.cssText = `
    position: fixed;
    z-index: 10000;
    background: var(--surface2);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 16px;
    width: 200px;
    box-shadow: 0 8px 32px rgba(0,0,0,0.6);
    left: ${rect.right - 200}px;
    top: ${rect.bottom + 8}px;
  `;
  document.body.appendChild(popup);

  popup.querySelector('.save-btn')?.addEventListener('click', async () => {
    const inputs = popup.querySelectorAll('.hr-zone-input');
    const newZones = Array.from(inputs).map((i) => parseInt((i as HTMLInputElement).value) || 0);

    for (let i = 1; i < newZones.length; i++) {
      if (newZones[i] <= newZones[i - 1]) {
        toastFn('Zones must be in ascending order', 'error');
        return;
      }
    }

    Parsers.setHRZones(newZones);
    await Storage.set('hr_zones', newZones);

    track.stats = Parsers.computeStats(track.points);
    await Storage.save(track);

    renderInsights(track);
    popup.remove();
    toastFn('HR Zones updated');
  });

  const dismiss = (e: MouseEvent) => {
    if (!popup.contains(e.target as Node) && !anchorEl.contains(e.target as Node)) {
      popup.remove();
      document.removeEventListener('click', dismiss);
    }
  };
  setTimeout(() => document.addEventListener('click', dismiss), 10);
}

function showPowerZoneSettings(anchorEl: HTMLElement, track: TrackData) {
  document.querySelectorAll('.pw-settings-popup').forEach((el) => el.remove());

  const popup = document.createElement('div');
  popup.className = 'pw-settings-popup';

  const ftp = Parsers.getFTP();

  popup.innerHTML = `
    <div style="font-size:12px; font-weight:700; margin-bottom:12px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px">Configure FTP (Watts)</div>
    <div style="display:flex; flex-direction:column; gap:10px">
      <div class="hr-input-row">
        <span>Your FTP</span>
        <input type="number" class="hr-zone-input" value="${ftp}" id="ftp-input">
      </div>
      <button class="save-btn" style="margin-top:6px">Update FTP</button>
    </div>
  `;

  const rect = anchorEl.getBoundingClientRect();
  popup.style.cssText = `
    position: fixed;
    z-index: 10000;
    background: var(--surface2);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 16px;
    width: 200px;
    box-shadow: 0 8px 32px rgba(0,0,0,0.6);
    left: ${rect.right - 200}px;
    top: ${rect.bottom + 8}px;
  `;
  document.body.appendChild(popup);

  popup.querySelector('.save-btn')?.addEventListener('click', async () => {
    const input = popup.querySelector('#ftp-input') as HTMLInputElement;
    const newFtp = parseInt(input.value) || 200;

    Parsers.setFTP(newFtp);
    await Storage.set('ftp', newFtp);

    track.stats = Parsers.computeStats(track.points);
    await Storage.save(track);

    renderInsights(track);
    popup.remove();
    toastFn(`FTP updated to ${newFtp}W`);
  });

  const dismiss = (e: MouseEvent) => {
    if (!popup.contains(e.target as Node) && !anchorEl.contains(e.target as Node)) {
      popup.remove();
      document.removeEventListener('click', dismiss);
    }
  };
  setTimeout(() => document.addEventListener('click', dismiss), 10);
}
