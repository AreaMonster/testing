// Deterministic terrain generation. Runs in a Web Worker (see genworker.js) and on
// the main thread for spawn search. The surface is a 3D density field:
//   density(x,y,z) = (baseHeight(x,z) - y) + amp(x,z) * noise3(x,y,z)
// so flat areas stay gentle while mountains grow cliffs, arches and overhangs.
import { Noise, hash2, hash3, mulberry32 } from './noise.js';
import { B } from './blocks.js';
import { CS, CH, SEA } from './consts.js';
import { smooth, clamp, lerp } from './math.js';

export const BIOME = {
  OCEAN: 0, BEACH: 1, PLAINS: 2, FOREST: 3, DESERT: 4, SNOWY: 5, PEAKS: 6, FROZEN_OCEAN: 7,
  RIVER: 8, SAVANNA: 9, BADLANDS: 10, SWAMP: 11, BIRCH_FOREST: 12, TAIGA: 13, MEADOW: 14,
  DEEP_OCEAN: 15, STONY_SHORE: 16, CHERRY: 17,
};
export const BIOME_NAMES = [
  'Ocean', 'Beach', 'Plains', 'Forest', 'Desert', 'Snowy Taiga', 'Peaks', 'Frozen Ocean',
  'River', 'Savanna', 'Badlands', 'Swamp', 'Birch Forest', 'Taiga', 'Meadow', 'Deep Ocean', 'Stony Shore', 'Cherry Grove',
];
const GRASSY = new Set([BIOME.PLAINS, BIOME.FOREST, BIOME.BIRCH_FOREST, BIOME.MEADOW, BIOME.TAIGA, BIOME.SNOWY, BIOME.SAVANNA, BIOME.SWAMP, BIOME.CHERRY]);

const idx = (x, y, z) => (y << 8) | (z << 4) | x;

// Terracotta strata for badlands, repeating with height.
const BANDS = (() => {
  const r = mulberry32(991);
  const opts = [B.TERRACOTTA, B.TERRACOTTA_ORANGE, B.TERRACOTTA, B.TERRACOTTA_YELLOW, B.TERRACOTTA_WHITE, B.TERRACOTTA_BROWN, B.TERRACOTTA_RED, B.TERRACOTTA, B.TERRACOTTA_ORANGE];
  const a = [];
  while (a.length < 40) {
    const id = opts[Math.floor(r() * opts.length)];
    const n = 1 + Math.floor(r() * 3);
    for (let k = 0; k < n; k++) a.push(id);
  }
  return a;
})();

// Shared trilinear blend so chunk generation and point queries agree exactly.
function tri(c000, c100, c010, c110, c001, c101, c011, c111, tx, ty, tz) {
  const a = c000 + (c100 - c000) * tx, b = c010 + (c110 - c010) * tx;
  const c = c001 + (c101 - c001) * tx, d = c011 + (c111 - c011) * tx;
  const e = a + (b - a) * ty, f = c + (d - c) * ty;
  return e + (f - e) * tz;
}

export class WorldGen {
  constructor(seed) {
    this.seed = seed | 0;
    const s = this.seed;
    this.cont = new Noise(s + 11);
    this.ero = new Noise(s + 23);
    this.detail = new Noise(s + 37);
    this.ridge = new Noise(s + 41);
    this.temp = new Noise(s + 53);
    this.hum = new Noise(s + 67);
    this.caveA = new Noise(s + 71);
    this.caveB = new Noise(s + 83);
    this.caveC = new Noise(s + 97);
    this.weird = new Noise(s + 101);
    this.rav = new Noise(s + 163);
    this.ravMask = new Noise(s + 167);
    this.river = new Noise(s + 113);
    this.dens = new Noise(s + 127);
    this.dens2 = new Noise(s + 131);
    this.patch = new Noise(s + 149);
    this.latCache = new Map();
    this.colCache = new Map();
  }

  // ---------------------------------------------------------------- columns
  column(x, z) {
    const key = x * 1e7 + z;
    const hit = this.colCache.get(key);
    if (hit) return hit;
    const C = this.cont.fbm2(x / 1000, z / 1000, 4);
    const E = this.ero.fbm2(x / 520, z / 520, 3);
    const pv = 1 - Math.abs(this.ridge.fbm2(x / 260, z / 260, 4));
    const D = this.detail.fbm2(x / 64, z / 64, 4);
    const T = this.temp.fbm2(x / 1300, z / 1300, 3) * 1.6 + D * 0.04;
    const H = this.hum.fbm2(x / 1100, z / 1100, 3) * 1.6;
    const Wd = this.weird.fbm2(x / 700, z / 700, 2) * 1.5;
    const land = smooth((C + 0.3) / 0.26);
    let h = lerp(SEA - 14 + (C + 0.14) * 14, SEA + 3 + (C + 0.22) * 14, land);
    const m = smooth((0.0 - E) / 0.45) * land;
    h += m * (12 + 46 * pv * pv);
    h += (1 - m) * land * D * 7 + D * 2;
    // Badlands: raised, terraced mesas.
    const bad = smooth((T - 0.4) / 0.15) * smooth((-0.05 - H) / 0.15) * smooth((Wd - 0.1) / 0.15) * land;
    if (bad > 0) {
      const plateau = h + 16 * smooth((D + 0.15) / 0.3);
      const t = plateau / 7, base = Math.floor(t);
      const stepped = base * 7 + 7 * smooth((t - base - 0.7) / 0.3);
      h = lerp(h, stepped, bad);
    }
    // Swamps: flattened just around sea level.
    const swamp = smooth((H - 0.38) / 0.12) * smooth((T + 0.1) / 0.12) * (1 - smooth((T - 0.42) / 0.1)) * land * (1 - m);
    if (swamp > 0) h = lerp(h, SEA + D * 1.6 - 0.2, swamp);
    // Rivers follow the zero line of a low-frequency noise.
    const rn = Math.abs(this.river.fbm2(x / 430, z / 430, 2));
    const riv = (1 - smooth(rn / 0.045)) * land * (1 - m * 0.7) * (1 - bad * 0.6);
    const bank = (1 - smooth(rn / 0.11)) * land * (1 - m) * (1 - bad);
    if (bank > 0) h = lerp(h, Math.min(h, SEA + 1.5), bank * 0.6);
    if (riv > 0) h = lerp(h, Math.min(h, SEA - 3 - Math.max(0, 1 - rn / 0.045) * 2), riv);
    h = clamp(h, 4, CH - 12);
    const amp = 1.2 + 14 * m * (0.35 + 0.65 * pv) + bad * 5;
    const col = { h, amp, T, H, W: Wd, m, C, land, riv, bad, swamp, D };
    if (this.colCache.size > 60000) this.colCache.clear();
    this.colCache.set(key, col);
    return col;
  }

  lat(gx, gy, gz) {
    const key = gx * 1e9 + gz * 100 + gy;
    let v = this.latCache.get(key);
    if (v !== undefined) return v;
    v = this.dens.noise3(gx / 8.5, gy / 6.5, gz / 8.5) + 0.5 * this.dens2.noise3(gx / 3.5, gy / 3, gz / 3.5);
    if (this.latCache.size > 300000) this.latCache.clear();
    this.latCache.set(key, v);
    return v;
  }

  // Interpolated 3D noise at a block position (lattice spacing 4).
  noiseAt(x, y, z) {
    const gx = Math.floor(x / 4), gy = Math.floor(y / 4), gz = Math.floor(z / 4);
    const tx = (x - gx * 4) / 4, ty = (y - gy * 4) / 4, tz = (z - gz * 4) / 4;
    return tri(
      this.lat(gx, gy, gz), this.lat(gx + 1, gy, gz), this.lat(gx, gy + 1, gz), this.lat(gx + 1, gy + 1, gz),
      this.lat(gx, gy, gz + 1), this.lat(gx + 1, gy, gz + 1), this.lat(gx, gy + 1, gz + 1), this.lat(gx + 1, gy + 1, gz + 1),
      tx, ty, tz,
    );
  }

  band(col) {
    return [Math.max(1, Math.floor(col.h - col.amp - 1)), Math.min(CH - 2, Math.floor(col.h + col.amp + 1))];
  }

  // Exact top solid block of a column (matches generate()).
  surfaceAt(x, z, col = this.column(x, z)) {
    const [lo, hi] = this.band(col);
    for (let y = hi; y >= lo; y--) if (col.h - y + col.amp * this.noiseAt(x, y, z) > 0) return y;
    return lo - 1;
  }
  heightAt(x, z) { return this.surfaceAt(x, z); }

  steep(x, z, col) {
    const h = col.h;
    return Math.max(
      Math.abs(this.column(x + 1, z).h - h), Math.abs(this.column(x - 1, z).h - h),
      Math.abs(this.column(x, z + 1).h - h), Math.abs(this.column(x, z - 1).h - h),
    ) > 3.2;
  }

  biomeOf(col, surf, steep) {
    const { T, H, W } = col;
    if (col.swamp > 0.5 && surf >= SEA - 3 && col.m < 0.3) return BIOME.SWAMP;
    if (surf < SEA - 1) {
      if (col.riv > 0.45) return BIOME.RIVER;
      if (col.C < -0.55) return BIOME.DEEP_OCEAN;
      return T < -0.45 ? BIOME.FROZEN_OCEAN : BIOME.OCEAN;
    }
    if (col.riv > 0.6) return BIOME.RIVER;
    if (surf <= SEA + 2 && col.land < 0.97 && col.swamp < 0.5) {
      if (T < -0.45) return BIOME.SNOWY;
      return steep ? BIOME.STONY_SHORE : BIOME.BEACH;
    }
    if (surf > 97 || (col.m > 0.55 && surf > 88)) return BIOME.PEAKS;
    if (T < -0.45) return BIOME.SNOWY;
    if (T < -0.15) return BIOME.TAIGA;
    if (col.bad > 0.5) return BIOME.BADLANDS;
    if (T > 0.45 && H < -0.05) return BIOME.DESERT;
    if (T > 0.25 && H < 0.12) return BIOME.SAVANNA;
    if (col.swamp > 0.5) return BIOME.SWAMP;
    if (H > 0.2) return W < -0.1 ? BIOME.BIRCH_FOREST : BIOME.FOREST;
    if (W > 0.3 && surf > 72 && T > -0.1 && T < 0.3) return BIOME.CHERRY;
    if (W > 0.35) return BIOME.MEADOW;
    return BIOME.PLAINS;
  }

  biomeAt(x, z) {
    const col = this.column(x, z);
    const s = this.surfaceAt(x, z, col);
    return this.biomeOf(col, s, this.steep(x, z, col));
  }

  grassTint(col) {
    const { T, H } = col;
    const lerpc = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
    let c = [118, 190, 78];
    if (T < 0) c = lerpc(c, [124, 170, 136], smooth(-T / 0.45));
    else c = lerpc(c, [188, 182, 92], smooth(T / 0.6) * (1 - smooth((H + 0.1) / 0.4)));
    if (H > 0) c = lerpc(c, [80, 166, 58], smooth(H / 0.5) * 0.7);
    if (col.swamp > 0) c = lerpc(c, [106, 122, 64], col.swamp);
    if (col.bad > 0) c = lerpc(c, [160, 150, 86], col.bad);
    return c;
  }

  // ---------------------------------------------------------------- caves
  caveSample(x, y, z) {
    return [
      this.caveA.noise3(x / 52, y / 34, z / 52),
      this.caveB.noise3(x / 52, y / 34, z / 52),
      this.caveC.noise3(x / 84, y / 50, z / 84),
    ];
  }
  static carveTest(a, b, c, y) {
    return a * a + b * b < 0.011 || (c > 0.6 && y < 52);
  }
  isCave(x, y, z) {
    const x0 = Math.floor(x / 4) * 4, y0 = Math.floor(y / 4) * 4, z0 = Math.floor(z / 4) * 4;
    const tx = (x - x0) / 4, ty = (y - y0) / 4, tz = (z - z0) / 4;
    const v = [0, 0, 0];
    for (let i = 0; i < 8; i++) {
      const dx = i & 1, dy = (i >> 1) & 1, dz = (i >> 2) & 1;
      const w = (dx ? tx : 1 - tx) * (dy ? ty : 1 - ty) * (dz ? tz : 1 - tz);
      const s = this.caveSample(x0 + dx * 4, y0 + dy * 4, z0 + dz * 4);
      v[0] += s[0] * w; v[1] += s[1] * w; v[2] += s[2] * w;
    }
    return WorldGen.carveTest(v[0], v[1], v[2], y);
  }

  // ---------------------------------------------------------------- chunks
  generate(chunk) {
    const bl = chunk.blocks, cx = chunk.cx * CS, cz = chunk.cz * CS;
    const cols = [];
    let ymin = CH, ymax = 0;
    for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
      const col = this.column(cx + x, cz + z);
      cols.push(col);
      const [lo, hi] = this.band(col);
      ymin = Math.min(ymin, lo); ymax = Math.max(ymax, hi);
    }
    // Local lattice for the density band.
    const gy0 = Math.floor(ymin / 4), gy1 = Math.floor(ymax / 4) + 1;
    const NY = gy1 - gy0 + 1;
    const gxb = Math.floor(cx / 4), gzb = Math.floor(cz / 4);
    const L = new Float64Array(5 * 5 * NY);
    for (let gz = 0; gz < 5; gz++) for (let gx = 0; gx < 5; gx++) for (let gy = 0; gy < NY; gy++) {
      L[(gy * 5 + gz) * 5 + gx] = this.lat(gxb + gx, gy0 + gy, gzb + gz);
    }
    const LA = (gx, gy, gz) => L[((gy - gy0) * 5 + gz) * 5 + gx];
    const surf = new Int16Array(256);
    const biomes = new Uint8Array(256);

    for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
      const wx = cx + x, wz = cz + z, col = cols[z * 16 + x];
      const [lo, hi] = this.band(col);
      const gx = x >> 2, gz = z >> 2, tx = (x & 3) / 4, tz = (z & 3) / 4;
      let top = -1;
      for (let y = 0; y < CH; y++) {
        let solid;
        if (y < lo) solid = true;
        else if (y > hi) solid = false;
        else {
          const gy = Math.floor(y / 4), ty = (y - gy * 4) / 4;
          const n = tri(LA(gx, gy, gz), LA(gx + 1, gy, gz), LA(gx, gy + 1, gz), LA(gx + 1, gy + 1, gz),
            LA(gx, gy, gz + 1), LA(gx + 1, gy, gz + 1), LA(gx, gy + 1, gz + 1), LA(gx + 1, gy + 1, gz + 1), tx, ty, tz);
          solid = col.h - y + col.amp * n > 0;
        }
        if (solid) { bl[idx(x, y, z)] = B.STONE; top = y; }
      }
      surf[z * 16 + x] = top;
      const steep = this.steep(wx, wz, col);
      const biome = this.biomeOf(col, top, steep);
      biomes[z * 16 + x] = biome;
      const tint = this.grassTint(col);
      chunk.tint.set([tint[0], tint[1], tint[2]], (z * 16 + x) * 3);
      this.paintColumn(bl, x, z, wx, wz, col, biome, steep, top);
    }
    this.carveCaves(chunk, surf);
    this.placeOres(chunk, biomes);
    this.decorate(chunk, surf, biomes);
  }

  // Replaces stone near the surface with biome materials, adds water and ice.
  paintColumn(bl, x, z, wx, wz, col, biome, steep, top) {
    const r = hash2(wx, wz, this.seed);
    const cold = col.T < -0.45;
    let topB = B.GRASS, filler = B.DIRT, depth = 3 + (r < 0.5 ? 1 : 0), under = 0, underDepth = 0;
    switch (biome) {
      case BIOME.OCEAN: case BIOME.DEEP_OCEAN: case BIOME.FROZEN_OCEAN: {
        const p = this.patch.noise2(wx / 24, wz / 24);
        topB = cold || biome === BIOME.DEEP_OCEAN ? (p > 0.3 ? B.SAND : B.GRAVEL) : p > 0.45 ? B.CLAY : p < -0.4 ? B.GRAVEL : B.SAND;
        filler = topB === B.CLAY ? B.CLAY : topB; depth = 3;
        break;
      }
      case BIOME.RIVER: {
        const p = this.patch.noise2(wx / 12, wz / 12);
        topB = p > 0.35 ? B.CLAY : p < -0.3 ? B.GRAVEL : B.SAND; filler = topB; depth = 2;
        if (top >= SEA) { topB = B.GRASS; filler = B.DIRT; }
        break;
      }
      case BIOME.BEACH: topB = B.SAND; filler = B.SAND; depth = 4; under = B.SANDSTONE; underDepth = 3; break;
      case BIOME.STONY_SHORE: topB = B.STONE; filler = B.STONE; break;
      case BIOME.DESERT: topB = B.SAND; filler = B.SAND; depth = 4; under = B.SANDSTONE; underDepth = 5; break;
      case BIOME.SNOWY: topB = top <= SEA + 2 ? B.SNOW : B.SNOWY_GRASS; break;
      case BIOME.TAIGA: topB = this.patch.noise2(wx / 9, wz / 9) > 0.25 ? B.PODZOL : B.GRASS; break;
      case BIOME.SWAMP: topB = B.GRASS; break;
      case BIOME.PEAKS: {
        const snowLine = 100 + Math.max(0, col.T) * 40 + this.detail.noise2(wx / 20, wz / 20) * 4;
        topB = top > snowLine ? B.SNOW : this.patch.noise2(wx / 10, wz / 10) > 0.5 ? B.GRAVEL : top < 92 && !steep ? B.GRASS : B.STONE;
        filler = topB === B.GRASS ? B.DIRT : topB === B.GRAVEL ? B.GRAVEL : B.STONE;
        depth = topB === B.SNOW ? 2 : 3;
        break;
      }
    }
    if (steep && biome !== BIOME.BADLANDS && biome !== BIOME.PEAKS && top > SEA) { topB = B.STONE; filler = B.STONE; }
    const badlands = biome === BIOME.BADLANDS;
    const bandOff = Math.floor(this.patch.noise2(wx / 40, wz / 40) * 2);
    let depthLeft = -1, airAbove = true, first = true;
    for (let y = CH - 1; y > 0; y--) {
      const i = idx(x, y, z);
      if (bl[i] !== B.STONE) { airAbove = true; continue; }
      if (airAbove) {
        airAbove = false;
        depthLeft = 0;
      }
      if (badlands) {
        if (depthLeft === 0 && first && !steep && top < 96) bl[i] = B.RED_SAND;
        else if (depthLeft < 28) bl[i] = BANDS[((y + bandOff) % BANDS.length + BANDS.length) % BANDS.length];
      } else if (depthLeft === 0) bl[i] = first ? (y < SEA - 1 && GRASSY.has(biome) ? B.DIRT : topB) : (topB === B.GRASS || topB === B.SNOWY_GRASS || topB === B.PODZOL ? B.DIRT : filler);
      else if (depthLeft <= depth) bl[i] = filler === B.GRASS ? B.DIRT : filler;
      else if (under && depthLeft <= depth + underDepth) bl[i] = under;
      depthLeft++;
      first = false;
    }
    // Bedrock floor and sea water.
    bl[idx(x, 0, z)] = B.BEDROCK;
    for (let y = 1; y <= 3; y++) if (hash3(wx, y, wz, this.seed) < 0.6 - y * 0.15) bl[idx(x, y, z)] = B.BEDROCK;
    if (top < SEA) {
      for (let y = SEA; y > top; y--) {
        const i = idx(x, y, z);
        if (bl[i] === 0) bl[i] = y === SEA && (cold || biome === BIOME.SNOWY) ? B.ICE : B.WATER;
      }
    }
  }

  carveCaves(chunk, surf) {
    const bl = chunk.blocks, cx = chunk.cx * CS, cz = chunk.cz * CS;
    const NY = CH / 4 + 1;
    const grid = new Float32Array(5 * 5 * NY * 3);
    let maxS = 0;
    for (let i = 0; i < 256; i++) maxS = Math.max(maxS, surf[i]);
    const yLimit = Math.min(NY - 1, Math.floor(maxS / 4) + 1);
    for (let gz = 0; gz < 5; gz++) for (let gx = 0; gx < 5; gx++) for (let gy = 0; gy <= yLimit; gy++) {
      const s = this.caveSample(cx + gx * 4, gy * 4, cz + gz * 4);
      const i = ((gy * 5 + gz) * 5 + gx) * 3;
      grid[i] = s[0]; grid[i + 1] = s[1]; grid[i + 2] = s[2];
    }
    const G = (gx, gy, gz, k) => grid[((gy * 5 + gz) * 5 + gx) * 3 + k];
    // Ravines: long narrow canyons following the zero line of a 2D noise.
    for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
      const wx = cx + x, wz = cz + z, s = surf[z * 16 + x];
      if (s < SEA + 3) continue;
      const mask = this.ravMask.noise2(wx / 420, wz / 420);
      if (mask < 0.42) continue;
      const rv = Math.abs(this.rav.noise2(wx / 150, wz / 150));
      const width = 0.018 * smooth((mask - 0.42) / 0.1);
      if (rv >= width) continue;
      const k = 1 - rv / width;
      const bottom = Math.floor(14 + (1 - k) * 34 + hash2(wx, wz, 3) * 2);
      for (let y = bottom; y <= s; y++) {
        const i = idx(x, y, z);
        if (bl[i] === B.WATER || bl[i] === B.BEDROCK) continue;
        if (y + 1 < CH && bl[i + 256] === B.WATER) break;
        bl[i] = y <= 10 ? B.LAVA : 0;
      }
    }
    for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
      const s = surf[z * 16 + x];
      const top = s < SEA + 2 ? s - 5 : s;
      const gx = x >> 2, gz = z >> 2, tx = (x & 3) / 4, tz = (z & 3) / 4;
      for (let y = 1; y <= top; y++) {
        const gy = y >> 2, ty = (y & 3) / 4;
        const v = [0, 0, 0];
        for (let k = 0; k < 3; k++) {
          v[k] = tri(G(gx, gy, gz, k), G(gx + 1, gy, gz, k), G(gx, gy + 1, gz, k), G(gx + 1, gy + 1, gz, k),
            G(gx, gy, gz + 1, k), G(gx + 1, gy, gz + 1, k), G(gx, gy + 1, gz + 1, k), G(gx + 1, gy + 1, gz + 1, k), tx, ty, tz);
        }
        if (!WorldGen.carveTest(v[0], v[1], v[2], y)) continue;
        const i = idx(x, y, z);
        const id = bl[i];
        if (id === B.BEDROCK || id === B.WATER || id === B.ICE || id === 0) continue;
        if (y + 1 < CH && (bl[i + 256] === B.WATER || bl[i + 256] === B.ICE)) continue;
        bl[i] = y <= 10 ? B.LAVA : 0;
        if (y > 10 && y < s - 6 && y > 1 && (bl[i - 256] === B.STONE || bl[i - 256] === B.SLATE) && hash3(cx + x, y, cz + z, this.seed ^ 0x3c0) < 0.012) {
          bl[i] = hash3(cx + x, y, cz + z, 11) < 0.5 ? B.RED_MUSHROOM : B.BROWN_MUSHROOM;
        }
        const above = i + 256;
        if (y + 1 < CH && (bl[above] === B.SAND || bl[above] === B.GRAVEL || bl[above] === B.RED_SAND)) bl[above] = bl[above] === B.RED_SAND ? B.TERRACOTTA : B.SANDSTONE;
      }
    }
  }

  placeOres(chunk, biomes) {
    const bl = chunk.blocks;
    const rnd = mulberry32((Math.imul(chunk.cx, 341873128) ^ Math.imul(chunk.cz, 132897987) ^ this.seed) | 0);
    const badlands = biomes.includes(BIOME.BADLANDS);
    const ores = [
      [B.COAL_ORE, 20, 5, 120, 10],
      [B.IRON_ORE, 13, 5, 70, 7],
      [B.GOLD_ORE, badlands ? 8 : 3, 5, badlands ? 80 : 32, 6],
      [B.DIAMOND_ORE, 1.5, 4, 16, 5],
      [B.GRAVEL, 6, 5, 100, 14],
      [B.DIRT, 6, 5, 100, 14],
      [B.CLAY, 1.2, 30, 64, 10],
      [B.COPPER_ORE, 9, 20, 96, 9],
      [B.GLOW_LICHEN_STONE, 1.2, 4, 34, 6],
    ];
    // Rock variety: large blobs of granite, marble, slate and (deep) basalt.
    for (const [id, count, ymin, ymax, rad] of [[B.GRANITE, 1.6, 6, 90, 3.2], [B.MARBLE, 1.2, 6, 80, 3], [B.SLATE, 1.5, 4, 40, 3.4], [B.BASALT, 0.7, 4, 18, 2.8]]) {
      let n = Math.floor(count) + (rnd() < count % 1 ? 1 : 0);
      while (n-- > 0) {
        const cx0 = 3 + rnd() * 10, cy0 = ymin + rnd() * (ymax - ymin), cz0 = 3 + rnd() * 10, r = rad * (0.7 + rnd() * 0.5);
        for (let y = Math.floor(cy0 - r); y <= cy0 + r; y++) for (let z = Math.floor(cz0 - r); z <= cz0 + r; z++) for (let x = Math.floor(cx0 - r); x <= cx0 + r; x++) {
          if (x < 0 || x > 15 || z < 0 || z > 15 || y < 1 || y >= CH) continue;
          if ((x - cx0) ** 2 + ((y - cy0) * 1.3) ** 2 + (z - cz0) ** 2 > r * r) continue;
          const i = idx(x, y, z);
          if (bl[i] === B.STONE) bl[i] = id;
        }
      }
    }
    // Deep slate floor.
    const wx0 = chunk.cx * 16, wz0 = chunk.cz * 16;
    for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
      const top = 7 + Math.floor(hash2(wx0 + x, wz0 + z, this.seed ^ 0x51a7e) * 4);
      for (let y = 1; y < top; y++) { const i = idx(x, y, z); if (bl[i] === B.STONE) bl[i] = B.SLATE; }
    }
    for (const [id, count, ymin, ymax, size] of ores) {
      let n = Math.floor(count) + (rnd() < count % 1 ? 1 : 0);
      while (n-- > 0) {
        let x = Math.floor(rnd() * 16), y = ymin + Math.floor(rnd() * (ymax - ymin)), z = Math.floor(rnd() * 16);
        const len = 2 + Math.floor(rnd() * size);
        for (let k = 0; k < len; k++) {
          if (x >= 0 && x < 16 && z >= 0 && z < 16 && y > 0 && y < CH) {
            const i = idx(x, y, z);
            if (bl[i] === B.STONE) bl[i] = id;
          }
          const d = Math.floor(rnd() * 6);
          if (d === 0) x++; else if (d === 1) x--; else if (d === 2) y++; else if (d === 3) y--; else if (d === 4) z++; else z--;
        }
      }
    }
  }

  // ---------------------------------------------------------------- features
  treeAt(wx, wz) {
    const r = hash2(wx, wz, this.seed ^ 0x5eed);
    if (r > 0.07) return null;
    const col = this.column(wx, wz);
    if (col.riv > 0.3) return null;
    const h = this.surfaceAt(wx, wz, col);
    if (h < SEA) return null;
    const steep = this.steep(wx, wz, col);
    if (steep) return null;
    const biome = this.biomeOf(col, h, steep);
    if (!GRASSY.has(biome) && !(biome === BIOME.PEAKS && h < 92)) return null;
    const density = {
      [BIOME.FOREST]: 0.06, [BIOME.BIRCH_FOREST]: 0.06, [BIOME.PLAINS]: 0.006, [BIOME.MEADOW]: 0.003,
      [BIOME.TAIGA]: 0.05, [BIOME.SNOWY]: 0.016, [BIOME.SAVANNA]: 0.012, [BIOME.SWAMP]: 0.022, [BIOME.PEAKS]: 0.004, [BIOME.CHERRY]: 0.03,
    }[biome] || 0;
    if (r >= density) return null;
    if (this.isCave(wx, h, wz) || this.isCave(wx, h - 1, wz)) return null;
    const r2 = hash2(wx, wz, this.seed ^ 0x77);
    let type = 'oak';
    switch (biome) {
      case BIOME.FOREST: type = r2 < 0.25 ? 'birch' : r2 < 0.37 ? 'bigoak' : r2 < 0.45 ? 'bush' : 'oak'; break;
      case BIOME.BIRCH_FOREST: type = r2 < 0.35 ? 'tallbirch' : 'birch'; break;
      case BIOME.PLAINS: type = r2 < 0.3 ? 'bigoak' : r2 < 0.5 ? 'bush' : 'oak'; break;
      case BIOME.MEADOW: type = r2 < 0.5 ? 'birch' : 'oak'; break;
      case BIOME.TAIGA: type = r2 < 0.35 ? 'tallspruce' : r2 < 0.42 ? 'sprucebush' : 'spruce'; break;
      case BIOME.SNOWY: case BIOME.PEAKS: type = r2 < 0.25 ? 'tallspruce' : 'spruce'; break;
      case BIOME.SAVANNA: type = r2 < 0.75 ? 'acacia' : 'bush'; break;
      case BIOME.SWAMP: type = 'swamp'; break;
      case BIOME.CHERRY: type = r2 < 0.85 ? 'cherry' : 'bush'; break;
    }
    return { h, type, r2, biome };
  }

  decorate(chunk, surf, biomes) {
    const bl = chunk.blocks, me = chunk.meta, cx = chunk.cx * CS, cz = chunk.cz * CS;
    const set = (x, y, z, id, onlyAir, meta = 0) => {
      if (x < 0 || x > 15 || z < 0 || z > 15 || y < 1 || y >= CH) return;
      const i = idx(x, y, z);
      if (onlyAir && bl[i] !== 0 && bl[i] !== B.TALL_GRASS && bl[i] !== B.FERN) return;
      bl[i] = id;
      me[i] = meta;
    };
    for (let lz = -6; lz <= 21; lz++) for (let lx = -6; lx <= 21; lx++) {
      const t = this.treeAt(cx + lx, cz + lz);
      if (!t) continue;
      placeTree(set, lx, t.h + 1, lz, t.type, t.r2);
      set(lx, t.h, lz, B.DIRT, false);
    }
    const rnd = mulberry32((Math.imul(chunk.cx, 0x2f6b3) ^ Math.imul(chunk.cz, 0x5bd1e995) ^ this.seed ^ 0xdec) | 0);
    // Fallen logs and boulders stay inside the chunk so neighbours never disagree.
    if (rnd() < 0.18) {
      const x = 3 + Math.floor(rnd() * 10), z = 3 + Math.floor(rnd() * 10), s = surf[z * 16 + x];
      const b = biomes[z * 16 + x];
      if (s >= SEA && (b === BIOME.FOREST || b === BIOME.TAIGA || b === BIOME.BIRCH_FOREST)) {
        const alongX = rnd() < 0.5, len = 3 + Math.floor(rnd() * 3);
        const log = b === BIOME.TAIGA ? B.SPRUCE_LOG : b === BIOME.BIRCH_FOREST ? B.BIRCH_LOG : B.LOG;
        let ok = true;
        for (let k = 0; k < len && ok; k++) {
          const px = alongX ? x + k - 1 : x, pz = alongX ? z : z + k - 1;
          if (px > 15 || pz > 15 || bl[idx(px, s + 1, pz)] !== 0 && bl[idx(px, s + 1, pz)] !== B.TALL_GRASS && bl[idx(px, s + 1, pz)] !== B.FERN) ok = false;
          else if (bl[idx(px, s, pz)] === 0 || bl[idx(px, s, pz)] === B.WATER) ok = false;
        }
        if (ok) for (let k = 0; k < len; k++) set(alongX ? x + k - 1 : x, s + 1, alongX ? z : z + k - 1, log, false, alongX ? 1 : 2);
      }
    }
    if (rnd() < 0.25) {
      const x = 3 + Math.floor(rnd() * 10), z = 3 + Math.floor(rnd() * 10), s = surf[z * 16 + x];
      const b = biomes[z * 16 + x];
      if (s >= SEA && (b === BIOME.TAIGA || b === BIOME.SNOWY || b === BIOME.PEAKS || (b === BIOME.PLAINS && rnd() < 0.3))) {
        const rad = 1 + rnd() * 1.4;
        for (let dy = -1; dy <= 2; dy++) for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
          if (dx * dx + dy * dy * 1.3 + dz * dz > rad * rad + rnd() * 0.8) continue;
          set(x + dx, s + dy, z + dz, rnd() < 0.55 ? B.MOSSY_COBBLE : B.COBBLESTONE, false);
        }
      }
    }
    this.lakes(chunk, surf, biomes, rnd, set);
    this.geode(chunk, rnd);
    this.ruins(chunk, surf, biomes, rnd, set);
    this.crypt(chunk, rnd, set);
    // Ground cover.
    for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
      const wx = cx + x, wz = cz + z, h = surf[z * 16 + x];
      if (h < 1 || h + 3 >= CH) continue;
      const top = bl[idx(x, h, z)], ai = idx(x, h + 1, z);
      if (bl[ai] !== 0) continue;
      const r = hash2(wx, wz, this.seed ^ 0xdec0);
      const biome = biomes[z * 16 + x];
      const flowers = this.patch.noise2(wx / 18, wz / 18);
      if (top === B.GRASS || top === B.PODZOL) {
        let grass = 0.12, flower = 0.008;
        if (biome === BIOME.FOREST || biome === BIOME.BIRCH_FOREST) { grass = 0.1; flower = 0.012; }
        if (biome === BIOME.MEADOW) { grass = 0.28; flower = flowers > 0 ? 0.18 : 0.06; }
        if (biome === BIOME.PLAINS && flowers > 0.45) flower = 0.08;
        if (biome === BIOME.SAVANNA) { grass = 0.3; flower = 0.002; }
        if (biome === BIOME.SWAMP) { grass = 0.16; flower = 0.003; }
        if (biome === BIOME.TAIGA) { grass = 0.06; flower = 0.002; }
        if (biome === BIOME.CHERRY) { grass = 0.2; flower = 0.07; }
        if ((biome === BIOME.SWAMP || biome === BIOME.FOREST) && this.patch.noise2(wx / 7, wz / 7) > 0.62) { bl[idx(x, h, z)] = B.MOSS_BLOCK; continue; }
        if (r < flower) {
          const k = Math.floor(hash2(wx, wz, 7) * 4);
          bl[ai] = [B.POPPY, B.BUTTERCUP, B.CORNFLOWER, B.DAISY][(k + (flowers > 0.2 ? 2 : 0)) % 4];
        } else if (r < flower + grass) bl[ai] = biome === BIOME.TAIGA || (biome === BIOME.SWAMP && r > flower + grass * 0.6) ? B.FERN : B.TALL_GRASS;
        else if (r > 0.9985 && (biome === BIOME.PLAINS || biome === BIOME.FOREST || biome === BIOME.SAVANNA)) { bl[ai] = B.PUMPKIN; me[ai] = [0, 1, 4, 5][Math.floor(hash2(wx, wz, 3) * 4)]; }
        else if (r > 0.9975 && r <= 0.9985 && (biome === BIOME.SAVANNA || biome === BIOME.SWAMP || biome === BIOME.PLAINS)) bl[ai] = B.MELON;
      } else if (top === B.SAND || top === B.RED_SAND || (top >= B.TERRACOTTA && top <= B.TERRACOTTA_RED && biome === BIOME.BADLANDS)) {
        if (biome === BIOME.DESERT && r < 0.006) {
          const ch = 1 + Math.floor(hash2(wx, wz, 99) * 3);
          for (let k = 1; k <= ch; k++) bl[idx(x, h + k, z)] = B.CACTUS;
        } else if ((biome === BIOME.DESERT || biome === BIOME.BADLANDS) && r < 0.016) bl[ai] = B.DEAD_BUSH;
      }
      // Sugar cane along water edges at sea level.
      if (h === SEA && (top === B.GRASS || top === B.SAND || top === B.DIRT) && bl[ai] === 0 && r > 0.6 && r < 0.75) {
        let wet = false;
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx, nz = z + dz;
          if (nx >= 0 && nx < 16 && nz >= 0 && nz < 16 && bl[idx(nx, h, nz)] === B.WATER) wet = true;
        }
        if (wet) { const ch = 1 + Math.floor(hash2(wx, wz, 5) * 3); for (let k = 1; k <= ch; k++) bl[idx(x, h + k, z)] = B.SUGAR_CANE; }
      }
    }
  }

  // Ponds in flat grassy spots (and rare lava pools in dry lands), kept inside the chunk.
  lakes(chunk, surf, biomes, rnd, set) {
    if (rnd() > 0.07) return;
    const bl = chunk.blocks;
    const cx0 = 6 + Math.floor(rnd() * 4), cz0 = 6 + Math.floor(rnd() * 4), r = 3 + rnd() * 2;
    const level = surf[cz0 * 16 + cx0], b = biomes[cz0 * 16 + cx0];
    const dry = b === BIOME.DESERT || b === BIOME.BADLANDS || b === BIOME.SAVANNA;
    if (!GRASSY.has(b) && !dry) return;
    if (dry && rnd() > 0.35) return;
    if (level <= SEA || level > 110) return;
    const R = Math.ceil(r) + 1;
    for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
      const s = surf[(cz0 + dz) * 16 + cx0 + dx];
      if (Math.hypot(dx, dz) <= r + 1 && (s < level || s > level + 3)) return;
    }
    const fluid = dry ? B.LAVA : B.WATER;
    for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
      const d = Math.hypot(dx * (1 + 0.15 * Math.sin(dz)), dz) / r;
      if (d >= 1) continue;
      const x = cx0 + dx, z = cz0 + dz, depth = Math.max(1, Math.round((1 - d * d) * 3.2));
      for (let y = level + 1; y <= surf[z * 16 + x] + 2 && y < CH; y++) bl[idx(x, y, z)] = 0;
      for (let y = level - depth + 1; y <= level; y++) bl[idx(x, y, z)] = fluid;
      const floor = idx(x, level - depth, z);
      if (bl[floor] !== 0) bl[floor] = fluid === B.LAVA ? B.STONE : rnd() < 0.3 ? B.CLAY : rnd() < 0.5 ? B.SAND : B.DIRT;
    }
  }

  // Crystal geodes: basalt shell, marble lining, crystal blocks and clusters inside.
  geode(chunk, rnd) {
    if (rnd() > 0.035) return;
    const bl = chunk.blocks;
    const cx0 = 5.5 + rnd() * 5, cy0 = 14 + rnd() * 24, cz0 = 5.5 + rnd() * 5;
    for (let y = Math.floor(cy0 - 5); y <= cy0 + 5; y++) for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
      if (y < 2) continue;
      const d = Math.hypot(x + 0.5 - cx0, (y + 0.5 - cy0) * 1.1, z + 0.5 - cz0);
      if (d > 4.6) continue;
      const i = idx(x, y, z);
      if (bl[i] === 0 || bl[i] === B.WATER || bl[i] === B.LAVA) continue;
      bl[i] = d > 3.9 ? B.BASALT : d > 3.2 ? B.MARBLE : d > 2.5 ? B.CRYSTAL_BLOCK : 0;
    }
    for (let y = Math.floor(cy0 - 3); y <= cy0 + 3; y++) for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
      const i = idx(x, y, z);
      if (bl[i] === 0 && y > 1 && bl[i - 256] === B.CRYSTAL_BLOCK && rnd() < 0.45) bl[i] = B.CRYSTAL_CLUSTER;
    }
  }

  // Overgrown ruined towers on the surface with a loot chest (filled when opened).
  ruins(chunk, surf, biomes, rnd, set) {
    if (rnd() > 0.022) return;
    const bl = chunk.blocks;
    const x0 = 4 + Math.floor(rnd() * 4), z0 = 4 + Math.floor(rnd() * 4);
    const b = biomes[(z0 + 2) * 16 + x0 + 2];
    if (!GRASSY.has(b) && b !== BIOME.DESERT && b !== BIOME.BADLANDS) return;
    let base = 999, hi = 0;
    for (let dz = 0; dz < 7; dz++) for (let dx = 0; dx < 7; dx++) { const s = surf[(z0 + dz) * 16 + x0 + dx]; base = Math.min(base, s); hi = Math.max(hi, s); }
    if (hi - base > 2 || base <= SEA) return;
    const desert = b === BIOME.DESERT || b === BIOME.BADLANDS;
    const wall = () => desert ? (rnd() < 0.7 ? B.SANDSTONE : B.SMOOTH_STONE) : [B.STONE_BRICKS, B.MOSSY_STONE_BRICKS, B.CRACKED_STONE_BRICKS, B.MOSSY_COBBLE][Math.floor(rnd() * 4)];
    const H = 5 + Math.floor(rnd() * 4);
    for (let dz = 0; dz < 7; dz++) for (let dx = 0; dx < 7; dx++) {
      const x = x0 + dx, z = z0 + dz;
      for (let y = surf[z * 16 + x]; y <= base; y++) bl[idx(x, y, z)] = desert ? B.SANDSTONE : B.COBBLESTONE;
      for (let y = base + 1; y <= base + H + 2; y++) bl[idx(x, y, z)] = 0;
      bl[idx(x, base, z)] = desert ? B.SANDSTONE : rnd() < 0.3 ? B.MOSSY_COBBLE : B.COBBLESTONE;
      const edge = dx === 0 || dz === 0 || dx === 6 || dz === 6;
      if (!edge) continue;
      const door = dz === 0 && dx === 3;
      const colH = H - Math.floor(rnd() * 3) - ((dx + dz) % 3 === 0 ? 0 : Math.floor(rnd() * 3));
      for (let y = base + 1; y <= base + colH; y++) {
        if (door && y <= base + 2) continue;
        if ((y === base + 3) && (dx === 3 || dz === 3) && !door) continue;
        if (rnd() < 0.08) continue;
        bl[idx(x, y, z)] = wall();
      }
    }
    for (let dz = 1; dz < 6; dz++) for (let dx = 1; dx < 6; dx++) if (rnd() < 0.18) set(x0 + dx, base + 1, z0 + dz, desert ? B.DEAD_BUSH : B.TALL_GRASS, true);
    set(x0 + 3, base + 1, z0 + 5, B.CHEST, false, 4);
    if (rnd() < 0.5) set(x0 + 1, base + 1, z0 + 5, B.LANTERN, false, 0);
  }

  // Small underground rooms of mossy stone with a chest.
  crypt(chunk, rnd, set) {
    if (rnd() > 0.03) return;
    const bl = chunk.blocks;
    const x0 = 4 + Math.floor(rnd() * 3), z0 = 4 + Math.floor(rnd() * 3), y0 = 16 + Math.floor(rnd() * 22);
    for (let dy = 0; dy < 6; dy++) for (let dz = 0; dz < 8; dz++) for (let dx = 0; dx < 8; dx++) {
      const i = idx(x0 + dx, y0 + dy, z0 + dz);
      if (bl[i] === B.WATER) return;
    }
    for (let dy = 0; dy < 6; dy++) for (let dz = 0; dz < 8; dz++) for (let dx = 0; dx < 8; dx++) {
      const shell = dy === 0 || dy === 5 || dx === 0 || dz === 0 || dx === 7 || dz === 7;
      const i = idx(x0 + dx, y0 + dy, z0 + dz);
      if (shell) { if (bl[i] !== 0 || dy === 0 || rnd() < 0.85) bl[i] = rnd() < 0.5 ? B.MOSSY_COBBLE : rnd() < 0.5 ? B.MOSSY_STONE_BRICKS : B.COBBLESTONE; }
      else bl[i] = 0;
    }
    set(x0 + 1, y0 + 1, z0 + 1, B.CHEST, false, 0);
    if (rnd() < 0.6) set(x0 + 6, y0 + 1, z0 + 6, B.CHEST, false, 1);
    set(x0 + 4, y0 + 4, z0 + 4, B.LANTERN, false, 1);
    for (let k = 0; k < 4; k++) if (rnd() < 0.5) set(x0 + 1 + Math.floor(rnd() * 6), y0 + 1, z0 + 1 + Math.floor(rnd() * 6), B.BROWN_MUSHROOM, true);
  }

  findSpawn() {
    for (let r = 0; r < 600; r += 4) {
      for (let a = 0; a < 16; a++) {
        const x = Math.round(Math.cos((a / 16) * Math.PI * 2) * r), z = Math.round(Math.sin((a / 16) * Math.PI * 2) * r);
        const col = this.column(x, z);
        const h = this.surfaceAt(x, z, col);
        if (h <= SEA + 1 || col.amp > 4) continue;
        const b = this.biomeOf(col, h, this.steep(x, z, col));
        if ((b !== BIOME.PLAINS && b !== BIOME.FOREST && b !== BIOME.MEADOW && b !== BIOME.BIRCH_FOREST && b !== BIOME.SAVANNA) || this.isCave(x, h, z)) continue;
        let flat = true;
        for (let dz = -2; dz <= 2 && flat; dz++) for (let dx = -2; dx <= 2; dx++) {
          if (Math.abs(this.surfaceAt(x + dx, z + dz) - h) > 1 || this.treeAt(x + dx, z + dz)) { flat = false; break; }
        }
        if (flat) return [x + 0.5, h + 1, z + 0.5];
      }
    }
    return [0.5, this.surfaceAt(0, 0) + 2, 0.5];
  }
}

// Places a tree with `set(x, y, z, id, onlyAir, meta)`. Randomness comes only from
// `r`, so every chunk that touches the tree draws exactly the same shape.
export function placeTree(set, x, y, z, type, r) {
  const rng = mulberry32(Math.floor(r * 2147483647) ^ 0x9e37);
  const blob = (bx, by, bz, rad, leaf, flat = 1) => {
    const R = Math.ceil(rad);
    for (let dy = -R; dy <= R; dy++) for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
      const d = dx * dx + dy * dy * flat + dz * dz;
      if (d <= rad * rad + 0.5 && (d < (rad - 0.6) * (rad - 0.6) || rng() < 0.8)) set(bx + dx, by + dy, bz + dz, leaf, true);
    }
  };
  const trunk = (log, h) => { for (let k = 0; k < h; k++) set(x, y + k, z, log, false); };
  const roundCanopy = (log, leaf, h) => {
    for (let dy = h - 3; dy <= h; dy++) {
      const rad = dy >= h - 1 ? 1 : 2;
      for (let dz = -rad; dz <= rad; dz++) for (let dx = -rad; dx <= rad; dx++) {
        const corner = Math.abs(dx) === rad && Math.abs(dz) === rad;
        if (corner && (dy === h || rng() < 0.5)) continue;
        set(x + dx, y + dy, z + dz, leaf, true);
      }
    }
    trunk(log, h);
  };
  switch (type) {
    case 'oak': roundCanopy(B.LOG, B.LEAVES, 4 + Math.floor(rng() * 3)); return;
    case 'birch': roundCanopy(B.BIRCH_LOG, B.BIRCH_LEAVES, 5 + Math.floor(rng() * 3)); return;
    case 'tallbirch': roundCanopy(B.BIRCH_LOG, B.BIRCH_LEAVES, 8 + Math.floor(rng() * 3)); return;
    case 'swamp': {
      const h = 5 + Math.floor(rng() * 2);
      for (let dy = h - 2; dy <= h; dy++) {
        const rad = dy === h ? 2 : 3;
        for (let dz = -rad; dz <= rad; dz++) for (let dx = -rad; dx <= rad; dx++) {
          if (Math.abs(dx) === rad && Math.abs(dz) === rad) continue;
          if (rad === 3 && (Math.abs(dx) === 3 || Math.abs(dz) === 3) && rng() < 0.3) continue;
          set(x + dx, y + dy, z + dz, B.LEAVES, true);
        }
      }
      trunk(B.LOG, h);
      return;
    }
    case 'bush': case 'sprucebush': {
      const leaf = type === 'bush' ? B.LEAVES : B.SPRUCE_LEAVES;
      blob(x, y + 1, z, 1.6, leaf, 1.6);
      set(x, y, z, type === 'bush' ? B.LOG : B.SPRUCE_LOG, false);
      return;
    }
    case 'spruce': case 'tallspruce': {
      const tall = type === 'tallspruce';
      const h = tall ? 10 + Math.floor(rng() * 4) : 6 + Math.floor(rng() * 4);
      set(x, y + h, z, B.SPRUCE_LEAVES, true);
      for (let dy = h - 1; dy >= (tall ? 3 : 2); dy--) {
        const k = h - 1 - dy;
        let rad = k < 2 ? 1 : k % 2 ? 2 : 1;
        if (tall && k > 5 && k % 2) rad = 3;
        for (let dz = -rad; dz <= rad; dz++) for (let dx = -rad; dx <= rad; dx++) {
          if (Math.abs(dx) === rad && Math.abs(dz) === rad) continue;
          if (rad === 3 && Math.abs(dx) + Math.abs(dz) > 4) continue;
          set(x + dx, y + dy, z + dz, B.SPRUCE_LEAVES, true);
        }
      }
      trunk(B.SPRUCE_LOG, h);
      return;
    }
    case 'bigoak': {
      const h = 7 + Math.floor(rng() * 5);
      const branches = 2 + Math.floor(rng() * 3);
      for (let b = 0; b < branches; b++) {
        const a = rng() * Math.PI * 2, start = Math.floor(h * (0.5 + rng() * 0.3)), len = 2 + Math.floor(rng() * 3);
        const dx = Math.cos(a), dz = Math.sin(a);
        let bx = x, bz = z, by = y + start;
        for (let k = 1; k <= len; k++) {
          bx = x + Math.round(dx * k); bz = z + Math.round(dz * k); by = y + start + Math.floor(k * 0.7);
          set(bx, by, bz, B.LOG, false, Math.abs(dx) > Math.abs(dz) ? 1 : 2);
        }
        blob(bx, by + 1, bz, 2.2, B.LEAVES, 1.8);
      }
      blob(x, y + h, z, 2.8, B.LEAVES, 1.5);
      trunk(B.LOG, h);
      return;
    }
    case 'cherry': {
      const h = 4 + Math.floor(rng() * 3);
      const lean = rng() < 0.5 ? 1 : -1, alongX = rng() < 0.5;
      let tx = x, tz = z;
      for (let k = 0; k < h; k++) {
        if (k === h - 2) { if (alongX) tx += lean; else tz += lean; }
        set(tx, y + k, tz, B.CHERRY_LOG, false);
      }
      const top = y + h;
      for (let dy = -1; dy <= 1; dy++) {
        const rad = dy === 1 ? 2 : 3;
        for (let dz = -rad; dz <= rad; dz++) for (let dx = -rad; dx <= rad; dx++) {
          if (dx * dx + dz * dz > rad * rad + 1) continue;
          if (dy === -1 && dx * dx + dz * dz < (rad - 1) * (rad - 1)) continue;
          if (rng() < 0.12) continue;
          set(tx + dx, top + dy, tz + dz, B.CHERRY_LEAVES, true);
        }
      }
      for (let k = 0; k < 6; k++) {
        const a = rng() * Math.PI * 2;
        set(tx + Math.round(Math.cos(a) * 3), top - 2, tz + Math.round(Math.sin(a) * 3), B.CHERRY_LEAVES, true);
      }
      return;
    }
    case 'acacia': {
      const h = 2 + Math.floor(rng() * 2);
      trunk(B.ACACIA_LOG, h);
      const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]];
      const [ddx, ddz] = dirs[Math.floor(rng() * dirs.length)];
      const bend = 2 + Math.floor(rng() * 2);
      let tx = x, ty = y + h - 1, tz = z;
      for (let k = 0; k < bend; k++) { tx += ddx; tz += ddz; ty++; set(tx, ty, tz, B.ACACIA_LOG, false); }
      const canopy = (cx0, cy0, cz0, big) => {
        const R = big ? 3 : 2;
        for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
          if (Math.abs(dx) + Math.abs(dz) > R + 1) continue;
          if (Math.abs(dx) === R && Math.abs(dz) === R) continue;
          set(cx0 + dx, cy0 + 1, cz0 + dz, B.ACACIA_LEAVES, true);
        }
        for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) set(cx0 + dx, cy0 + 2, cz0 + dz, B.ACACIA_LEAVES, true);
      };
      canopy(tx, ty, tz, true);
      if (rng() < 0.5) {
        let ox = x, oy = y + h - 1, oz = z;
        for (let k = 0; k < 2; k++) { ox -= ddx; oz -= ddz; oy++; set(ox, oy, oz, B.ACACIA_LOG, false); }
        canopy(ox, oy, oz, false);
      }
      return;
    }
  }
}
