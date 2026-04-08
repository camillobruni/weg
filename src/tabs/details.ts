'use strict';

import { TrackData } from '../parsers';
import { Storage } from '../storage';
import { fmtSecs, escHtml, fmtDateTime } from '../utils';

let onTagsChangeCb: () => void = () => {};
export function initDetails(onTagsChange: () => void) {
  onTagsChangeCb = onTagsChange;
}

export function renderDetails(track: TrackData, globalTags: string[] = []) {
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
        <div class="insight-title"><span class="material-symbols-rounded">label</span>Tags</div>
        <div id="tag-container" style="display:flex; flex-wrap:wrap; gap:6px; margin-top:4px"></div>
        <div style="margin-top:12px; display:flex; gap:8px">
          <input type="text" id="new-tag-input" list="global-tags-list" placeholder="Add tag..." style="flex:1; background:var(--surface); border:1px solid var(--border); border-radius:4px; padding:4px 8px; color:var(--text); font-size:12px; outline:none; border:1px solid var(--border)">
          <datalist id="global-tags-list">
            ${globalTags.map(t => `<option value="${escHtml(t)}">`).join('')}
          </datalist>
          <button id="btn-add-tag" class="icon-btn mini" style="background:var(--surface2); border:1px solid var(--border); height:26px; width:26px"><span class="material-symbols-rounded" style="font-size:16px">add</span></button>
        </div>
      </div>

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

  const tagContainer = document.getElementById('tag-container')!;
  const tagInput = document.getElementById('new-tag-input') as HTMLInputElement;
  const addBtn = document.getElementById('btn-add-tag')!;

  const renderTags = () => {
    tagContainer.innerHTML = '';
    const tags = track.tags || [];
    if (tags.length === 0) {
      tagContainer.innerHTML = '<span style="color:var(--text-dim); font-size:11px; font-style:italic">No tags added</span>';
      return;
    }
    tags.forEach((tag) => {
      const el = document.createElement('div');
      el.className = 'tag-pill';
      el.style.cssText = `
        background: var(--surface2);
        border: 1px solid var(--border);
        color: var(--text-muted);
        padding: 2px 8px;
        border-radius: 4px;
        font-size: 11px;
        font-weight: 600;
        display: flex;
        align-items: center;
        gap: 6px;
      `;
      el.innerHTML = `
        <span>${escHtml(tag)}</span>
        <span class="material-symbols-rounded btn-remove-tag" data-tag="${tag}" style="font-size:14px; cursor:pointer; color:var(--text-dim)">close</span>
      `;
      tagContainer.appendChild(el);
    });

    tagContainer.querySelectorAll('.btn-remove-tag').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        const tag = (e.currentTarget as HTMLElement).dataset.tag!;
        track.tags = (track.tags || []).filter((t) => t !== tag);
        await Storage.save(track);
        renderTags();
        onTagsChangeCb();
      });
    });
  };

  const addTag = async () => {
    const val = tagInput.value.trim().toLowerCase();
    if (!val) return;
    const tags = new Set(track.tags || []);
    if (tags.has(val)) {
      tagInput.value = '';
      return;
    }
    tags.add(val);
    track.tags = Array.from(tags).sort();
    await Storage.save(track);
    tagInput.value = '';
    renderTags();
    onTagsChangeCb();
  };

  addBtn.addEventListener('click', addTag);
  tagInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addTag();
  });

  renderTags();
}
