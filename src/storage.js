'use strict';

// ── IndexedDB Storage ─────────────────────────────────────────────
// Stores parsed track objects (not raw file bytes).
// Tracks can be several MB each, so localStorage is unsuitable.

export const Storage = (() => {
  const DB_NAME    = 'strasse';
  const DB_VERSION = 1;
  const STORE      = 'tracks';
  let   db         = null;

  function open() {
    if (db) return Promise.resolve(db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = e => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains(STORE)) {
          d.createObjectStore(STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = e => { db = e.target.result; resolve(db); };
      req.onerror   = e => reject(e.target.error);
    });
  }

  async function getAll() {
    const d    = await open();
    const tx   = d.transaction(STORE, 'readonly');
    const req  = tx.objectStore(STORE).getAll();
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result || []);
      req.onerror   = () => reject(req.error);
    });
  }

  async function put(track) {
    const d   = await open();
    const tx  = d.transaction(STORE, 'readwrite');
    const req = tx.objectStore(STORE).put(track);
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve();
      req.onerror   = () => reject(req.error);
    });
  }

  async function remove(id) {
    const d   = await open();
    const tx  = d.transaction(STORE, 'readwrite');
    const req = tx.objectStore(STORE).delete(id);
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve();
      req.onerror   = () => reject(req.error);
    });
  }

  async function clear() {
    const d   = await open();
    const tx  = d.transaction(STORE, 'readwrite');
    const req = tx.objectStore(STORE).clear();
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve();
      req.onerror   = () => reject(req.error);
    });
  }

  return { getAll, put, remove, clear };
})();
