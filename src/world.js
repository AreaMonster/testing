// Chunk storage, block access, flood-fill lighting and fluid simulation.
import { B, BLOCKS, OPAQUE, SOLID, FILTER, EMIT, LIQUID, REPLACEABLE, SHAPE, blockSpan } from './blocks.js';

const FULL = [0, 1];
import { CS, CH } from './consts.js';

export const idx = (x, y, z) => (y << 8) | (z << 4) | x;
const DX = [1, -1, 0, 0, 0, 0], DY = [0, 0, 1, -1, 0, 0], DZ = [0, 0, 0, 0, 1, -1];
const DOWN = 3;
const HX = [1, -1, 0, 0], HZ = [0, 0, 1, -1];

export class Chunk {
  constructor(cx, cz) {
    this.cx = cx;
    this.cz = cz;
    const n = CS * CS * CH;
    this.blocks = new Uint8Array(n);
    this.meta = new Uint8Array(n);
    this.light = new Uint8Array(n); // high nibble sky, low nibble block
    this.tint = new Uint8Array(256 * 3);
    this.mods = new Map(); // index -> id | meta << 8 (player/sim changes vs generated)
    this.unsaved = false;
    this.dirty = true;
    this.mesh = null;
    this.fresh = true;
  }
}

export const ckey = (cx, cz) => (cx + 32768) * 65536 + (cz + 32768);

export class World {
  constructor(seed, gen, store) {
    this.seed = seed;
    this.gen = gen;
    this.store = store; // { loadMods(cx,cz) -> Array|null }
    this.chunks = new Map();
    this.time = 1000;
    this.tick = 0;
    this.tileEntities = new Map();
    this.fluidQueue = new Map();
    this.onChange = null;
    this._lc = null;
  }

  getChunk(cx, cz) {
    const c = this._lc;
    if (c && c.cx === cx && c.cz === cz) return c;
    const r = this.chunks.get(ckey(cx, cz));
    if (r) this._lc = r;
    return r;
  }

  getBlock(x, y, z) {
    if (y < 0 || y >= CH) return 0;
    const c = this.getChunk(x >> 4, z >> 4);
    return c ? c.blocks[idx(x & 15, y, z & 15)] : 0;
  }
  getMeta(x, y, z) {
    if (y < 0 || y >= CH) return 0;
    const c = this.getChunk(x >> 4, z >> 4);
    return c ? c.meta[idx(x & 15, y, z & 15)] : 0;
  }
  getLight(x, y, z) {
    if (y >= CH) return 0xf0;
    if (y < 0) return 0;
    const c = this.getChunk(x >> 4, z >> 4);
    return c ? c.light[idx(x & 15, y, z & 15)] : 0xf0;
  }
  isSolid(x, y, z) {
    if (y < 0) return true;
    if (y >= CH) return false;
    const c = this.getChunk(x >> 4, z >> 4);
    if (!c) return true;
    return BLOCKS[c.blocks[idx(x & 15, y, z & 15)]].solid;
  }
  // Vertical extent of a solid block, or null for passable cells.
  solidSpan(x, y, z) {
    if (y < 0) return FULL;
    if (y >= CH) return null;
    const c = this.getChunk(x >> 4, z >> 4);
    if (!c) return FULL;
    const i = idx(x & 15, y, z & 15), id = c.blocks[i];
    if (!SOLID[id]) return null;
    return SHAPE[id] ? blockSpan(id, c.meta[i]) : FULL;
  }
  // Highest non-air block in a column (cached per chunk; used for rain).
  topAt(x, z) {
    const c = this.getChunk(x >> 4, z >> 4);
    if (!c) return -1;
    if (!c.heights || c.hdirty) {
      const h = c.heights || (c.heights = new Int16Array(256));
      for (let i = 0; i < 256; i++) {
        let y = CH - 1;
        while (y >= 0 && c.blocks[(y << 8) | i] === 0) y--;
        h[i] = y;
      }
      c.hdirty = false;
    }
    return c.heights[((z & 15) << 4) | (x & 15)];
  }
  isLoaded(x, z) {
    return !!this.getChunk(x >> 4, z >> 4);
  }

  // ---------- chunk lifecycle ----------
  generateChunk(cx, cz) {
    const data = { blocks: new Uint8Array(CS * CS * CH), meta: new Uint8Array(CS * CS * CH), tint: new Uint8Array(768) };
    this.gen.generate({ cx, cz, ...data });
    return this.insertChunkData(cx, cz, data);
  }

  // Adopts generated arrays (from a worker or generateChunk), applies saved edits and lights it.
  insertChunkData(cx, cz, data) {
    const c = new Chunk(cx, cz);
    c.blocks = data.blocks;
    c.meta = data.meta;
    c.tint = data.tint;
    const mods = this.store && this.store.loadMods(cx, cz);
    if (mods) {
      for (let i = 0; i < mods.length; i += 2) {
        const v = mods[i + 1];
        c.blocks[mods[i]] = v & 255;
        c.meta[mods[i]] = v >> 8;
        c.mods.set(mods[i], v);
      }
      c.fresh = false;
    }
    this.chunks.set(ckey(cx, cz), c);
    this.initLight(c);
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const n = this.getChunk(cx + dx, cz + dz);
      if (n) n.dirty = true;
    }
    return c;
  }

  unloadChunk(c) {
    this.chunks.delete(ckey(c.cx, c.cz));
    if (this._lc === c) this._lc = null;
  }

  // ---------- lighting ----------
  markLightDirty(c, lx, lz) {
    c.dirty = true;
    if (lx === 0 || lx === 15 || lz === 0 || lz === 15) {
      const ox = lx === 0 ? -1 : lx === 15 ? 1 : 0;
      const oz = lz === 0 ? -1 : lz === 15 ? 1 : 0;
      let n;
      if (ox && (n = this.getChunk(c.cx + ox, c.cz))) n.dirty = true;
      if (oz && (n = this.getChunk(c.cx, c.cz + oz))) n.dirty = true;
      if (ox && oz && (n = this.getChunk(c.cx + ox, c.cz + oz))) n.dirty = true;
    }
  }

  propagate(q, sky) {
    const shift = sky ? 4 : 0, keep = sky ? 0x0f : 0xf0;
    for (let i = 0; i < q.length; i += 3) {
      const x = q[i], y = q[i + 1], z = q[i + 2];
      const c = this.getChunk(x >> 4, z >> 4);
      if (!c) continue;
      const level = (c.light[idx(x & 15, y, z & 15)] >> shift) & 15;
      if (level <= 1) continue;
      for (let d = 0; d < 6; d++) {
        const ny = y + DY[d];
        if (ny < 0 || ny >= CH) continue;
        const nx = x + DX[d], nz = z + DZ[d];
        const nc = nx >> 4 === c.cx && nz >> 4 === c.cz ? c : this.getChunk(nx >> 4, nz >> 4);
        if (!nc) continue;
        const ni = idx(nx & 15, ny, nz & 15);
        const b = nc.blocks[ni];
        if (OPAQUE[b]) continue;
        let nl = level - 1 - FILTER[b];
        if (sky && d === DOWN && level === 15 && FILTER[b] === 0) nl = 15;
        if (nl > ((nc.light[ni] >> shift) & 15)) {
          nc.light[ni] = (nc.light[ni] & keep) | (nl << shift);
          this.markLightDirty(nc, nx & 15, nz & 15);
          q.push(nx, ny, nz);
        }
      }
    }
  }

  removeLight(x, y, z, sky) {
    const shift = sky ? 4 : 0, keep = sky ? 0x0f : 0xf0;
    const c = this.getChunk(x >> 4, z >> 4);
    if (!c) return;
    const i0 = idx(x & 15, y, z & 15);
    const lvl = (c.light[i0] >> shift) & 15;
    if (!lvl) return;
    c.light[i0] &= keep;
    this.markLightDirty(c, x & 15, z & 15);
    const rq = [x, y, z, lvl], aq = [];
    for (let k = 0; k < rq.length; k += 4) {
      const px = rq[k], py = rq[k + 1], pz = rq[k + 2], level = rq[k + 3];
      for (let d = 0; d < 6; d++) {
        const ny = py + DY[d];
        if (ny < 0 || ny >= CH) continue;
        const nx = px + DX[d], nz = pz + DZ[d];
        const nc = this.getChunk(nx >> 4, nz >> 4);
        if (!nc) continue;
        const ni = idx(nx & 15, ny, nz & 15);
        const nl = (nc.light[ni] >> shift) & 15;
        if (!nl) continue;
        if (nl < level || (sky && d === DOWN && level === 15 && nl === 15)) {
          nc.light[ni] &= keep;
          this.markLightDirty(nc, nx & 15, nz & 15);
          rq.push(nx, ny, nz, nl);
          if (!sky) {
            const em = EMIT[nc.blocks[ni]];
            if (em) { nc.light[ni] |= em; aq.push(nx, ny, nz); }
          }
        } else aq.push(nx, ny, nz);
      }
    }
    this.propagate(aq, sky);
  }

  initLight(c) {
    const L = c.light, bl = c.blocks;
    const top = new Int16Array(256); // lowest y that still has full sky
    for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
      let level = 15, full = CH;
      for (let y = CH - 1; y >= 0; y--) {
        const i = idx(x, y, z), b = bl[i];
        if (OPAQUE[b]) break;
        level -= FILTER[b];
        if (level <= 0) break;
        L[i] = level << 4;
        if (level === 15) full = y;
      }
      top[z * 16 + x] = full;
    }
    const sq = [], bq = [];
    const wx = c.cx * 16, wz = c.cz * 16;
    for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
      const edge = x === 0 || x === 15 || z === 0 || z === 15;
      let hi = 0;
      if (edge) hi = CH - 1;
      else hi = Math.max(top[z * 16 + x + 1], top[z * 16 + x - 1], top[(z + 1) * 16 + x], top[(z - 1) * 16 + x]);
      for (let y = 0; y < CH; y++) {
        const s = L[idx(x, y, z)] >> 4;
        if (!s) continue;
        if (s < 15 || y <= hi) sq.push(wx + x, y, wz + z);
      }
    }
    for (let i = 0; i < bl.length; i++) {
      const em = EMIT[bl[i]];
      if (em) {
        L[i] = (L[i] & 0xf0) | em;
        bq.push(wx + (i & 15), i >> 8, wz + ((i >> 4) & 15));
      }
    }
    // Pull light in from already-loaded neighbours.
    const sides = [[-1, 0], [1, 0], [0, -1], [0, 1]];
    for (const [ox, oz] of sides) {
      const n = this.getChunk(c.cx + ox, c.cz + oz);
      if (!n) continue;
      for (let k = 0; k < 16; k++) {
        const lx = ox === -1 ? 15 : ox === 1 ? 0 : k;
        const lz = oz === -1 ? 15 : oz === 1 ? 0 : k;
        const gx = (c.cx + ox) * 16 + lx, gz = (c.cz + oz) * 16 + lz;
        for (let y = 0; y < CH; y++) {
          const v = n.light[idx(lx, y, lz)];
          if (v >> 4 > 1) sq.push(gx, y, gz);
          if ((v & 15) > 1) bq.push(gx, y, gz);
        }
      }
    }
    this.propagate(sq, true);
    this.propagate(bq, false);
  }

  updateLight(x, y, z, oldId, newId) {
    const c = this.getChunk(x >> 4, z >> 4);
    const i = idx(x & 15, y, z & 15);
    const neighbours = [];
    for (let d = 0; d < 6; d++) {
      const ny = y + DY[d];
      if (ny >= 0 && ny < CH) neighbours.push(x + DX[d], ny, z + DZ[d]);
    }
    // block light
    if (c.light[i] & 15) this.removeLight(x, y, z, false);
    const em = EMIT[newId];
    if (em) {
      c.light[i] = (c.light[i] & 0xf0) | em;
      this.propagate([x, y, z], false);
    } else if (!OPAQUE[newId]) this.propagate(neighbours.slice(), false);
    // sky light
    if (c.light[i] >> 4 && (OPAQUE[newId] || FILTER[newId] > FILTER[oldId])) this.removeLight(x, y, z, true);
    if (!OPAQUE[newId]) {
      if (y === CH - 1) {
        c.light[i] = (c.light[i] & 0x0f) | ((15 - FILTER[newId]) << 4);
        neighbours.push(x, y, z);
      }
      this.propagate(neighbours, true);
    }
  }

  // ---------- block changes ----------
  setBlock(x, y, z, id, meta = 0) {
    if (y < 0 || y >= CH) return false;
    const c = this.getChunk(x >> 4, z >> 4);
    if (!c) return false;
    const i = idx(x & 15, y, z & 15);
    const old = c.blocks[i], oldMeta = c.meta[i];
    if (old === id && oldMeta === meta) return false;
    c.blocks[i] = id;
    c.meta[i] = meta;
    c.mods.set(i, id | (meta << 8));
    c.unsaved = true;
    c.hdirty = true;
    if (old !== id) this.updateLight(x, y, z, old, id);
    this.markLightDirty(c, x & 15, z & 15);
    if (LIQUID[id]) this.scheduleFluid(x, y, z);
    for (let d = 0; d < 6; d++) {
      const nx = x + DX[d], ny = y + DY[d], nz = z + DZ[d];
      if (LIQUID[this.getBlock(nx, ny, nz)]) this.scheduleFluid(nx, ny, nz);
    }
    if (old !== id && this.onChange) this.onChange(x, y, z, old, id);
    return true;
  }

  // ---------- fluids ----------
  scheduleFluid(x, y, z) {
    const k = `${x},${y},${z}`;
    if (this.fluidQueue.has(k)) return;
    const lava = this.getBlock(x, y, z) === B.LAVA;
    this.fluidQueue.set(k, this.tick + (lava ? 30 : 5));
  }

  tickFluids() {
    if (!this.fluidQueue.size) return;
    const due = [];
    for (const [k, t] of this.fluidQueue) if (t <= this.tick) due.push(k);
    let n = 0;
    for (const k of due) {
      this.fluidQueue.delete(k);
      const [x, y, z] = k.split(',').map(Number);
      this.fluidUpdate(x, y, z);
      if (++n > 400) break;
    }
  }

  fluidUpdate(x, y, z) {
    if (!this.isLoaded(x, z)) return;
    const id = this.getBlock(x, y, z);
    const kind = LIQUID[id];
    if (!kind) return;
    const meta = this.getMeta(x, y, z);
    const maxLevel = kind === 1 ? 7 : 3;
    const eff = (m) => (m === 0 || m === 8 ? 0 : m);
    if (meta !== 0) {
      let want;
      const falling = LIQUID[this.getBlock(x, y + 1, z)] === kind;
      if (falling) want = 8;
      else {
        let minL = 99, sources = 0;
        for (let d = 0; d < 4; d++) {
          const nx = x + HX[d], nz = z + HZ[d];
          if (LIQUID[this.getBlock(nx, y, nz)] !== kind) continue;
          const m = this.getMeta(nx, y, nz);
          if (m === 0) sources++;
          minL = Math.min(minL, eff(m));
        }
        const below = this.getBlock(x, y - 1, z);
        if (kind === 1 && sources >= 2 && (BLOCKS[below].solid || (LIQUID[below] === 1 && this.getMeta(x, y - 1, z) === 0))) want = 0;
        else want = minL + 1;
      }
      if (!falling && want > maxLevel) { this.setBlock(x, y, z, 0); return; }
      if (want !== meta) { this.setBlock(x, y, z, id, want); return; }
    }
    // Flow down first.
    const below = this.getBlock(x, y - 1, z);
    if (y > 0) {
      if (LIQUID[below] && LIQUID[below] !== kind) { this.mixLiquids(x, y - 1, z, kind, below); return; }
      if (LIQUID[below] === kind) return;
      if (!LIQUID[below] && (below === 0 || REPLACEABLE[below])) { this.setBlock(x, y - 1, z, id, 8); return; }
    }
    const e = eff(meta);
    if (e >= maxLevel) return;
    for (let d = 0; d < 4; d++) {
      const nx = x + HX[d], nz = z + HZ[d];
      if (!this.isLoaded(nx, nz)) continue;
      const nb = this.getBlock(nx, y, nz);
      if (LIQUID[nb] && LIQUID[nb] !== kind) { this.mixLiquids(nx, y, nz, kind, nb); continue; }
      if (LIQUID[nb] === kind) {
        const nm = this.getMeta(nx, y, nz);
        if (nm !== 0 && nm !== 8 && nm > e + 1) this.setBlock(nx, y, nz, id, e + 1);
        continue;
      }
      if (nb === 0 || REPLACEABLE[nb]) this.setBlock(nx, y, nz, id, e + 1);
    }
  }

  mixLiquids(x, y, z, incoming, existingId) {
    // Water meeting lava hardens it; lava flowing into water makes stone.
    const m = this.getMeta(x, y, z);
    if (LIQUID[existingId] === 2) this.setBlock(x, y, z, m === 0 ? B.OBSIDIAN : B.COBBLESTONE);
    else if (incoming === 2) this.setBlock(x, y, z, B.STONE);
  }

  // ---------- persistence helpers ----------
  modsArray(c) {
    const out = [];
    for (const [i, v] of c.mods) out.push(i, v);
    return out;
  }
}
