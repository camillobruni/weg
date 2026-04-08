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
    if (p.has('basemap')) s.basemap = p.get('basemap');
    if (p.has('xaxis'))   s.xaxis   = p.get('xaxis');

    if (p.has('map')) {
      const parts = p.get('map').split(',').map(Number);
      if (parts.length === 3 && parts.every(isFinite)) s.map = parts;
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
    if (_state.track)   p.set('track',   _state.track);
    if (_state.basemap) p.set('basemap', _state.basemap);
    if (_state.xaxis)   p.set('xaxis',   _state.xaxis);

    let search = p.toString();

    // Add comma-separated params (literal commas)
    if (_state.map) {
      const val = (+_state.map[0]).toFixed(5) + ',' + (+_state.map[1]).toFixed(5) + ',' + _state.map[2];
      search += (search ? '&' : '') + 'map=' + val;
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
