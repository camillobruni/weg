// Copyright (c) 2026, Camillo Bruni.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

'use strict';

/**
 * Returns a compact string representation of a timestamp using a URL-safe base64-like encoding.
 */
export function compactId(ts: number): string {
  const seconds = Math.floor(ts / 1000);
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_';
  let res = '';
  let n = seconds;
  while (n > 0) {
    res = chars[n % 64] + res;
    n = Math.floor(n / 64);
  }
  return res || '0';
}

/**
 * Returns a short random string (4 chars).
 */
export function shortRandom(): string {
  return Math.random().toString(36).substring(2, 6);
}

/**
 * Returns a UUID v4 string.
 * Falls back to a manual implementation if crypto.randomUUID is not available (e.g., non-secure context).
 */
export function generateId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for non-secure contexts (HTTP) or older browsers
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

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

export function getTagColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const h = Math.abs(hash % 360);
  return `hsl(${h}, 70%, 65%)`;
}

/**
 * Smoothes a numeric array using a simple Gaussian kernel.
 * sigma: standard deviation (radius of smoothing)
 */
export function gaussianSmooth(data: (number | null)[], sigma: number = 2): (number | null)[] {
  if (sigma <= 0) return data;
  
  const size = Math.ceil(sigma * 3) * 2 + 1;
  const kernel = new Float32Array(size);
  const half = Math.floor(size / 2);
  let sum = 0;

  for (let i = 0; i < size; i++) {
    const x = i - half;
    kernel[i] = Math.exp(-(x * x) / (2 * sigma * sigma));
    sum += kernel[i];
  }
  for (let i = 0; i < size; i++) kernel[i] /= sum;

  const result: (number | null)[] = new Array(data.length);
  for (let i = 0; i < data.length; i++) {
    if (data[i] === null) {
      result[i] = null;
      continue;
    }

    let val = 0;
    let weightSum = 0;
    for (let k = 0; k < size; k++) {
      const idx = i + k - half;
      if (idx >= 0 && idx < data.length && data[idx] !== null) {
        val += data[idx]! * kernel[k];
        weightSum += kernel[k];
      }
    }
    result[i] = weightSum > 0 ? val / weightSum : data[i];
  }
  return result;
}
