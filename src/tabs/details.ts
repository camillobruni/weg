'use strict';

import { TrackData } from '../parsers';
import { fmtSecs, escHtml } from '../utils';

export function renderDetails(track: TrackData) {
  const container = document.getElementById('details-view');
  if (!container) return;

  const s = track.stats;
  const t0 = track.points[0].time;
  const dateStr = t0 ? new Date(t0).toLocaleString() : 'Unknown';

  container.innerHTML = `
    <div id="details-header" style="margin-bottom: 32px;">
      <div class="details-title" style="font-size: 24px; font-weight: 800; margin-bottom: 4px;">${escHtml(track.name)}</div>
      <div class="details-subtitle" style="font-size: 13px; color: var(--text-muted);">${dateStr} • ${track.format.toUpperCase()} ${track.device ? '• ' + track.device : ''}</div>
    </div>

    <div class="details-grid">
      <div class="details-card">
        <div class="details-card-label">Distance</div>
        <div class="details-card-value">${(s.totalDist / 1000).toFixed(2)} km</div>
      </div>
      <div class="details-card">
        <div class="details-card-label">Duration</div>
        <div class="details-card-value">${s.duration ? fmtSecs(Math.floor(s.duration / 1000)) : '—'}</div>
      </div>
      <div class="details-card">
        <div class="details-card-label">Avg Speed</div>
        <div class="details-card-value">${s.avgSpeed ? (s.avgSpeed * 3.6).toFixed(1) : '—'} km/h</div>
      </div>
      <div class="details-card">
        <div class="details-card-label">Elevation Gain</div>
        <div class="details-card-value">${Math.round(s.elevGain)} m</div>
      </div>
      ${
        s.avgPower
          ? `
      <div class="details-card">
        <div class="details-card-label">Avg Power</div>
        <div class="details-card-value">${s.avgPower} W (Max ${s.maxPower}W)</div>
      </div>`
          : ''
      }
      ${
        s.avgHR
          ? `
      <div class="details-card">
        <div class="details-card-label">Avg Heart Rate</div>
        <div class="details-card-value">${s.avgHR} bpm (Max ${s.maxHR}bpm)</div>
      </div>`
          : ''
      }
      ${
        s.avgCadence
          ? `
      <div class="details-card">
        <div class="details-card-label">Avg Cadence</div>
        <div class="details-card-value">${s.avgCadence} rpm</div>
      </div>`
          : ''
      }
    </div>

    <div class="details-card" style="margin-top: 24px;">
      <div class="details-card-label">Sensors Detected</div>
      <div class="details-card-value" style="font-size: 14px; margin-top: 8px;">
        ${s.sensors.length ? s.sensors.join(', ') : 'No sensor data available (GPS only)'}
      </div>
    </div>
  `;
}
