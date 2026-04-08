'use strict';

// ── URL State ─────────────────────────────────────────────────────
// Handles reading/writing application state to the URL.
// Uses an incremental "patch" approach to preserve existing params.

const UrlState = (() => {

  // Internal state object, initialized from current URL.
  let _state = {};

  function read() {
    const p = new URLSearchParams(location.search);
    const s = {};

    if (p.has('track'))   s.track   = p.get('track');
    if (p.has('map'))     s.map     = p.get('map');
    if (p.has('xaxis'))   s.xaxis   = p.get('xaxis');
    if (p.has('metrics')) s.metrics = p.get('metrics').split(',');

    if (p.has('f_date'))  s.f_date = p.get('f_date').split(',');
    if (p.has('f_dist'))  s.f_dist = p.get('f_dist').split(',').map(Number);
    if (p.has('f_dur'))   s.f_dur  = p.get('f_dur').split(',').map(Number);
    if (p.has('f_mets'))  s.f_mets = p.get('f_mets').split(',');

    if (p.has('q'))       s.q       = p.get('q');
    if (p.has('re'))      s.re      = p.get('re') === '1';
    if (p.has('sort')) {
      const v = p.get('sort');
      const isDesc = v.startsWith('-');
      const field = isDesc ? v.substring(1) : v;
      s.sort = `${field}-${isDesc ? 'desc' : 'asc'}`;
    }

    if (p.has('map_pos')) {
      const parts = p.get('map_pos').split(',').map(Number);
      if (parts.length === 3 && parts.every(isFinite)) s.map_pos = parts;
    }

    if (p.has('sel')) {
      const parts = p.get('sel').split(',').map(Number);
      if (parts.length === 2 && parts.every(isFinite)) s.sel = parts;
    }

    return s;
  }

  // Sync _state to browser URL
  function _sync() {
    const p = new URLSearchParams();

    // Add standard encoded params
    if (_state.track) p.set('track', _state.track);
    if (_state.map)   p.set('map',   _state.map);
    if (_state.xaxis) p.set('xaxis', _state.xaxis);
    if (_state.q)     p.set('q',     _state.q);
    if (_state.re)    p.set('re',    '1');
    
    if (_state.sort) {
      const [field, dir] = _state.sort.split('-');
      p.set('sort', (dir === 'desc' ? '-' : '') + field);
    }

    let search = p.toString();

    // Add comma-separated params (literal commas for cleaner URL)
    if (_state.metrics) {
      search += (search ? '&' : '') + 'metrics=' + _state.metrics.join(',');
    }
    if (_state.f_date) {
      search += (search ? '&' : '') + 'f_date=' + _state.f_date.join(',');
    }
    if (_state.f_dist) {
      search += (search ? '&' : '') + 'f_dist=' + _state.f_dist.join(',');
    }
    if (_state.f_dur) {
      search += (search ? '&' : '') + 'f_dur=' + _state.f_dur.join(',');
    }
    if (_state.f_mets) {
      search += (search ? '&' : '') + 'f_mets=' + _state.f_mets.join(',');
    }

    if (_state.map_pos) {
      const val = (+_state.map_pos[0]).toFixed(5) + ',' + (+_state.map_pos[1]).toFixed(5) + ',' + _state.map_pos[2];
      search += (search ? '&' : '') + 'map_pos=' + val;
    }
    if (_state.sel) {
      const val = (+_state.sel[0].toFixed(4)) + ',' + (+_state.sel[1].toFixed(4));
      search += (search ? '&' : '') + 'sel=' + val;
    }

    const url = location.pathname + (search ? '?' + search : '');
    history.replaceState(null, '', url);
  }

  // Initial read
  _state = read();

  function get() {
    return { ..._state };
  }

  function patch(partial) {
    for (const [k, v] of Object.entries(partial)) {
      if (v === null || v === undefined) {
        delete _state[k];
      } else {
        _state[k] = v;
      }
    }
    _sync();
  }

  return { get, patch };
})();
