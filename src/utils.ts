'use strict';

export function fmtSecs(s: number): string {
  const h = Math.floor(s / 3600),
    m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
}

export function escHtml(str: string): string {
  const p = document.createElement('p');
  p.textContent = str;
  return p.innerHTML;
}
