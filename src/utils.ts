// Copyright (c) 2026, Camillo Bruni.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

'use strict';

export function fmtSecs(s: number): string {
  const h = Math.floor(s / 3600),
    m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
}

export function fmtDuration(s: number): string {
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

export function fmtDate(ts: number | string | Date): string {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return 'Unknown date';
  return d.toISOString().split('T')[0];
}

export function fmtDateTime(ts: number | string | Date): string {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return 'Unknown';
  const iso = d.toISOString();
  return iso.split('T')[0] + ' ' + iso.split('T')[1].slice(0, 5);
}

export function escHtml(str: string): string {
  const p = document.createElement('p');
  p.textContent = str;
  return p.innerHTML;
}
