'use strict';

// ── URL State ─────────────────────────────────────────────────────
// Handles reading/writing application state to the URL.
// Uses an incremental "patch" approach to preserve existing params.

export interface AppState {
  track?: string;
  map?: string;
  xaxis?: string;
  metrics?: string[];
  f_date?: (string | null)[];
  f_dist?: (number | null)[];
  f_dur?: (number | null)[];
  f_mets?: string[];
  f_tags?: string[];
  q?: string;
  re?: boolean;
  sort?: string;
  map_pos?: [number, number, number];
  sel?: [number, number];
  tab?: string;
}

export const UrlState = (() => {
  // Internal state object, initialized from current URL.
  let _state: AppState = {};
  let _lastSearch: string | null = null;
  let _syncTimeout: any = null;

  function read(): AppState {
    const p = new URLSearchParams(location.search);
    const s: AppState = {};

    if (p.has('track')) s.track = p.get('track')!;
    if (p.has('map')) s.map = p.get('map')!;
    if (p.has('xaxis')) s.xaxis = p.get('xaxis')!;
    if (p.has('tab')) s.tab = p.get('tab')!;
    if (p.has('metrics')) s.metrics = p.get('metrics')!.split(',');

    if (p.has('f_date'))
      s.f_date = p
        .get('f_date')!
        .split(',')
        .map((v) => v || null);
    if (p.has('f_dist'))
      s.f_dist = p
        .get('f_dist')!
        .split(',')
        .map((v) => (v ? Number(v) : null));
    if (p.has('f_dur'))
      s.f_dur = p
        .get('f_dur')!
        .split(',')
        .map((v) => (v ? Number(v) : null));
    if (p.has('f_mets')) s.f_mets = p.get('f_mets')!.split(',');
    if (p.has('f_tags')) s.f_tags = p.get('f_tags')!.split(',');

    if (p.has('q')) s.q = p.get('q')!;
    if (p.has('re')) s.re = p.get('re') === '1';
    if (p.has('sort')) {
      const v = p.get('sort')!;
      const isDesc = v.startsWith('-');
      const field = isDesc ? v.substring(1) : v;
      s.sort = `${field}-${isDesc ? 'desc' : 'asc'}`;
    }

    if (p.has('map_pos')) {
      const parts = p.get('map_pos')!.split(',').map(Number);
      if (parts.length === 3 && parts.every(isFinite))
        s.map_pos = parts as [number, number, number];
    }

    if (p.has('sel')) {
      const parts = p.get('sel')!.split(',').map(Number);
      if (parts.length === 2 && parts.every(isFinite)) s.sel = parts as [number, number];
    }

    return s;
  }

  // Sync _state to browser URL
  function _sync() {
    if (_syncTimeout) clearTimeout(_syncTimeout);

    _syncTimeout = setTimeout(() => {
      const p = new URLSearchParams();

      // Add standard encoded params
      if (_state.track) p.set('track', _state.track);
      if (_state.map) p.set('map', _state.map);
      if (_state.xaxis && _state.xaxis !== 'time') p.set('xaxis', _state.xaxis);
      if (_state.tab) p.set('tab', _state.tab);
      if (_state.q) p.set('q', _state.q);
      if (_state.re) p.set('re', '1');

      if (_state.sort) {
        const parts = _state.sort.split('-');
        const field = parts[0];
        const dir = parts[1];
        p.set('sort', (dir === 'desc' ? '-' : '') + field);
      }

      let search = p.toString();

      // Add comma-separated params (literal commas for cleaner URL)
      if (_state.metrics) {
        search += (search ? '&' : '') + 'metrics=' + _state.metrics.join(',');
      }
      if (_state.f_date) {
        search += (search ? '&' : '') + 'f_date=' + _state.f_date.map((v) => v || '').join(',');
      }
      if (_state.f_dist) {
        search += (search ? '&' : '') + 'f_dist=' + _state.f_dist.map((v) => v ?? '').join(',');
      }
      if (_state.f_dur) {
        search += (search ? '&' : '') + 'f_dur=' + _state.f_dur.map((v) => v ?? '').join(',');
      }
      if (_state.f_mets) {
        search += (search ? '&' : '') + 'f_mets=' + _state.f_mets.join(',');
      }
      if (_state.f_tags) {
        search += (search ? '&' : '') + 'f_tags=' + _state.f_tags.join(',');
      }

      if (_state.map_pos) {
        const val =
          (+_state.map_pos[0]).toFixed(5) +
          ',' +
          (+_state.map_pos[1]).toFixed(5) +
          ',' +
          _state.map_pos[2];
        search += (search ? '&' : '') + 'map_pos=' + val;
      }
      if (_state.sel) {
        const val = +_state.sel[0].toFixed(4) + ',' + +_state.sel[1].toFixed(4);
        search += (search ? '&' : '') + 'sel=' + val;
      }

      if (search !== _lastSearch) {
        const url = location.pathname + (search ? '?' + search : '');
        history.replaceState(null, '', url);
        _lastSearch = search;
      }
      _syncTimeout = null;
    }, 100);
  }

  // Initial read
  _state = read();

  function get(): AppState {
    return { ..._state };
  }

  function patch(partial: Partial<Record<keyof AppState, any>>) {
    for (const [k, v] of Object.entries(partial)) {
      const key = k as keyof AppState;
      if (v === null || v === undefined) {
        delete _state[key];
      } else {
        (_state as any)[key] = v;
      }
    }
    _sync();
  }

  return { get, patch };
})();
