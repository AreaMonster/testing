// World persistence in localStorage. Chunks store only the cells that differ
// from freshly generated terrain, packed as base64 (idx:u16, id:u8, meta:u8).
const P = 'blockhaven:';

function safeGet(k) {
  try { return localStorage.getItem(k); } catch { return null; }
}
function safeSet(k, v) {
  try { localStorage.setItem(k, v); return true; } catch { return false; }
}
function safeRemove(k) {
  try { localStorage.removeItem(k); } catch { /* storage unavailable */ }
}

function encodeMods(arr) {
  const n = arr.length / 2;
  const bytes = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const idx = arr[i * 2], v = arr[i * 2 + 1];
    bytes[i * 4] = idx & 255;
    bytes[i * 4 + 1] = idx >> 8;
    bytes[i * 4 + 2] = v & 255;
    bytes[i * 4 + 3] = (v >> 8) & 255;
  }
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function decodeMods(str) {
  const s = atob(str);
  const out = [];
  for (let i = 0; i + 3 < s.length; i += 4) {
    out.push(s.charCodeAt(i) | (s.charCodeAt(i + 1) << 8), s.charCodeAt(i + 2) | (s.charCodeAt(i + 3) << 8));
  }
  return out;
}

export const Store = {
  available() {
    try {
      localStorage.setItem(P + 'probe', '1');
      localStorage.removeItem(P + 'probe');
      return true;
    } catch { return false; }
  },
  listWorlds() {
    try { return JSON.parse(safeGet(P + 'worlds') || '[]'); } catch { return []; }
  },
  saveWorldList(list) {
    return safeSet(P + 'worlds', JSON.stringify(list));
  },
  upsertWorld(meta) {
    const list = this.listWorlds().filter((w) => w.id !== meta.id);
    list.unshift(meta);
    return this.saveWorldList(list);
  },
  deleteWorld(id) {
    this.saveWorldList(this.listWorlds().filter((w) => w.id !== id));
    try {
      const prefix = `${P}w:${id}:`;
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(prefix)) keys.push(k);
      }
      keys.forEach(safeRemove);
    } catch { /* storage unavailable */ }
  },
  forWorld(id) {
    const prefix = `${P}w:${id}:`;
    return {
      loadMods(cx, cz) {
        const s = safeGet(`${prefix}c:${cx},${cz}`);
        if (!s) return null;
        try { return decodeMods(s); } catch { return null; }
      },
      saveMods(cx, cz, arr) {
        if (!arr.length) { safeRemove(`${prefix}c:${cx},${cz}`); return true; }
        return safeSet(`${prefix}c:${cx},${cz}`, encodeMods(arr));
      },
      loadState() {
        try { return JSON.parse(safeGet(prefix + 'state') || 'null'); } catch { return null; }
      },
      saveState(state) {
        return safeSet(prefix + 'state', JSON.stringify(state));
      },
    };
  },
  loadSettings() {
    try { return JSON.parse(safeGet(P + 'settings') || '{}'); } catch { return {}; }
  },
  saveSettings(s) {
    safeSet(P + 'settings', JSON.stringify(s));
  },
};
