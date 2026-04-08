'use strict';

import { TrackData } from '../parsers';
import { fmtSecs, escHtml, fmtDateTime } from '../utils';

export function renderDetails(track: TrackData) {
  const container = document.getElementById('details-view');
  if (!container) return;

  const s = track.stats;
  const t0 = track.points[0].time;
  
  container.innerHTML = `
    <div id="details-header" style="margin-bottom: 24px;">
      <div class="details-title" style="font-size: 20px; font-weight: 800; margin-bottom: 4px;">${escHtml(track.name)}</div>
    </div>

    <div class="insights-grid" id="details-grid">
      <div class="insight-card">
        <div class="insight-title"><span class="material-symbols-rounded">analytics</span>Activity Summary</div>
        <div class="details-grid" style="grid-template-columns: repeat(2, 1fr); gap: 12px; margin-top: 4px">
          <div class="details-card" style="padding: 12px">
            <div class="details-card-label" style="font-size:10px">Distance</div>
            <div class="details-card-value" style="font-size:16px">${(s.totalDist / 1000).toFixed(2)} km</div>
          </div>
          <div class="details-card" style="padding: 12px">
            <div class="details-card-label" style="font-size:10px">Duration</div>
            <div class="details-card-value" style="font-size:16px">${s.duration ? fmtSecs(Math.floor(s.duration / 1000)) : '—'}</div>
          </div>
          <div class="details-card" style="padding: 12px">
            <div class="details-card-label" style="font-size:10px">Avg Speed</div>
            <div class="details-card-value" style="font-size:16px">${s.avgSpeed ? (s.avgSpeed * 3.6).toFixed(1) : '—'} km/h</div>
          </div>
          <div class="details-card" style="padding: 12px">
            <div class="details-card-label" style="font-size:10px">Max Speed</div>
            <div class="details-card-value" style="font-size:16px">${(s.maxSpeed * 3.6).toFixed(1)} km/h</div>
          </div>
        </div>
      </div>

      <div class="insight-card">
        <div class="insight-title"><span class="material-symbols-rounded">info</span>File Metadata</div>
        <div class="details-grid" style="grid-template-columns: 1fr; gap: 12px; margin-top: 4px">
          <div class="details-card" style="padding: 12px">
            <div class="details-card-label" style="font-size:10px">Format</div>
            <div class="details-card-value" style="font-size:16px">${track.format.toUpperCase()}</div>
          </div>
          <div class="details-card" style="padding: 12px">
            <div class="details-card-label" style="font-size:10px">Device / Creator</div>
            <div class="details-card-value" style="font-size:16px">${track.device || 'Unknown Device'}</div>
          </div>
          <div class="details-card" style="padding: 12px">
            <div class="details-card-label" style="font-size:10px">Start Time</div>
            <div class="details-card-value" style="font-size:16px">${t0 ? fmtDateTime(t0) : 'Unknown'}</div>
          </div>
        </div>
      </div>

      <div class="insight-card">
        <div class="insight-title"><span class="material-symbols-rounded">sensors</span>Sensor Info</div>
        <div class="details-grid" style="grid-template-columns: 1fr; gap: 12px; margin-top: 4px">
          <div class="details-card" style="padding: 12px">
            <div class="details-card-label" style="font-size:10px">Total Points</div>
            <div class="details-card-value" style="font-size:16px">${track.points.length.toLocaleString()} pts</div>
          </div>
          <div class="details-card" style="padding: 12px">
            <div class="details-card-label" style="font-size:10px">Sensors Found</div>
            <div class="details-card-value" style="font-size:14px; margin-top: 4px;">
              ${s.sensors.length ? s.sensors.join(', ') : 'GPS only'}
            </div>
          </div>
        </div>
      </div>

      ${
        s.avgHR || s.avgPower || s.avgCadence
          ? `
      <div class="insight-card">
        <div class="insight-title"><span class="material-symbols-rounded">monitoring</span>Biometric Averages</div>
        <div class="details-grid" style="grid-template-columns: repeat(2, 1fr); gap: 12px; margin-top: 4px">
          ${
            s.avgHR
              ? `<div class="details-card" style="padding: 12px">
                  <div class="details-card-label" style="font-size:10px">Avg HR</div>
                  <div class="details-card-value" style="font-size:16px">${s.avgHR} bpm</div>
                </div>`
              : ''
          }
          ${
            s.maxHR
              ? `<div class="details-card" style="padding: 12px">
                  <div class="details-card-label" style="font-size:10px">Max HR</div>
                  <div class="details-card-value" style="font-size:16px">${s.maxHR} bpm</div>
                </div>`
              : ''
          }
          ${
            s.avgPower
              ? `<div class="details-card" style="padding: 12px">
                  <div class="details-card-label" style="font-size:10px">Avg Power</div>
                  <div class="details-card-value" style="font-size:16px">${s.avgPower} W</div>
                </div>`
              : ''
          }
          ${
            s.maxPower
              ? `<div class="details-card" style="padding: 12px">
                  <div class="details-card-label" style="font-size:10px">Max Power</div>
                  <div class="details-card-value" style="font-size:16px">${s.maxPower} W</div>
                </div>`
              : ''
          }
          ${
            s.avgCadence
              ? `<div class="details-card" style="padding: 12px">
                  <div class="details-card-label" style="font-size:10px">Avg Cadence</div>
                  <div class="details-card-value" style="font-size:16px">${s.avgCadence} rpm</div>
                </div>`
              : ''
          }
        </div>
      </div>`
          : ''
      }
    </div>
  `;
}
