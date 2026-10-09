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
  DEEP_OCEAN: 15, STONY_SHORE: 16, CHERRY: 17, JUNGLE: 18,
};
export const BIOME_NAMES = [
  'Ocean', 'Beach', 'Plains', 'Forest', 'Desert', 'Snowy Taiga', 'Peaks', 'Frozen Ocean',
  'River', 'Savanna', 'Badlands', 'Swamp', 'Birch Forest', 'Taiga', 'Meadow', 'Deep Ocean', 'Stony Shore', 'Cherry Grove', 'Jungle',
];
const GRASSY = new Set([BIOME.PLAINS, BIOME.FOREST, BIOME.BIRCH_FOREST, BIOME.MEADOW, BIOME.TAIGA, BIOME.SNOWY, BIOME.SAVANNA, BIOME.SWAMP, BIOME.CHERRY, BIOME.JUNGLE]);

const idx = (x, y, z) => (y << 8) | (z << 4) | x;
const BLOCKS_LEAFY = new Set([B.LEAVES, B.BIRCH_LEAVES, B.SPRUCE_LEAVES, B.ACACIA_LEAVES, B.CHERRY_LEAVES, B.JUNGLE_LEAVES]);
const BLOCKS_WOOD = new Set([B.LOG, B.BIRCH_LOG, B.SPRUCE_LOG, B.ACACIA_LOG, B.CHERRY_LOG, B.JUNGLE_LOG, B.CACTUS, B.PUMPKIN, B.MELON]);

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

// Piecewise-linear curve through [t, value] points.
function spline(t, pts) {
  if (t <= pts[0][0]) return pts[0][1];
  for (let i = 0; i < pts.length - 1; i++) {
    const [t0, v0] = pts[i], [t1, v1] = pts[i + 1];
    if (t <= t1) return v0 + (v1 - v0) * ((t - t0) / (t1 - t0));
  }
  return pts[pts.length - 1][1];
}

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
    this.hillsN = new Noise(s + 171);
    this.ravMask = new Noise(s + 167);
    this.river = new Noise(s + 113);
    this.dens = new Noise(s + 127);
    this.dens2 = new Noise(s + 131);
    this.patch = new Noise(s + 149);
    this.latCache = new Map();
    this.villages = new Map();
    this.shafts = new Map();
    this.colCache = new Map();
  }

  // ---------------------------------------------------------------- columns
  column(x, z) {
    const key = x * 1e7 + z;
    const hit = this.colCache.get(key);
    if (hit) return hit;
    // Large-scale shaping noises, in the spirit of modern voxel terrain:
    // continentalness (ocean vs inland), erosion (flat vs mountainous) and ridges.
    const C = this.cont.fbm2(x / 1500, z / 1500, 5) * 1.25 + 0.12;
    const E = this.ero.fbm2(x / 760, z / 760, 4) * 1.3;
    const R = this.ridge.fbm2(x / 380, z / 380, 4);
    const ridged = 1 - Math.abs(R) * 1.6;
    const hills = this.hillsN.fbm2(x / 170, z / 170, 3);
    const D = this.detail.fbm2(x / 48, z / 48, 3);
    const T = this.temp.fbm2(x / 2300, z / 2300, 3) * 1.7 + D * 0.03 + 0.08;
    const H = this.hum.fbm2(x / 2000, z / 2000, 3) * 1.7;
    const Wd = this.weird.fbm2(x / 1100, z / 1100, 2) * 1.5;
    // Base height from continentalness: deep ocean, ocean, coast, lowlands, inland.
    const base = spline(C, [[-1.1, 26], [-0.55, 34], [-0.35, 46], [-0.2, 56], [-0.12, 61], [-0.05, 64], [0.1, 67], [0.35, 72], [0.7, 80], [1.2, 88]]);
    const land = smooth((C + 0.1) / 0.25);
    const coast = smooth((C + 0.22) / 0.14);
    // Erosion decides how mountainous an area may be.
    const er = spline(E, [[-1, 1], [-0.45, 0.8], [-0.2, 0.45], [0.05, 0.18], [0.35, 0.04], [0.7, 0]]);
    const m = er * land;
    const peak = Math.max(0, ridged);
    let h = base;
    h += m * (6 + 50 * Math.pow(peak, 1.8));
    h -= m * Math.pow(1 - peak, 2) * 5;
    h += (1 - m * 0.8) * coast * (hills * 7 + D * 1.4);
    // Badlands: raised, terraced mesas.
    const bad = smooth((T - 0.42) / 0.12) * smooth((-0.08 - H) / 0.14) * smooth((Wd - 0.05) / 0.15) * land;
    if (bad > 0) {
      const plateau = h + 18 * smooth((hills + 0.1) / 0.35);
      const t = plateau / 7, b0 = Math.floor(t);
      h = lerp(h, b0 * 7 + 7 * smooth((t - b0 - 0.72) / 0.28), bad);
    }
    // Swamps: flattened right at sea level.
    const swamp = smooth((H - 0.32) / 0.12) * smooth((T + 0.05) / 0.12) * (1 - smooth((T - 0.32) / 0.08)) * land * (1 - m * 1.5);
    if (swamp > 0) h = lerp(h, SEA + D * 1.4 - 0.3, Math.min(1, swamp));
    // Rivers: wide, shallow channels with sloping banks, fading out in mountains.
    const rn = Math.abs(this.river.fbm2(x / 520, z / 520, 3));
    const fade = (1 - smooth((m - 0.35) / 0.4)) * coast * (1 - bad * 0.7);
    const riv = (1 - smooth(rn / 0.05)) * fade;
    const bank = (1 - smooth(rn / 0.13)) * fade;
    if (bank > 0) h = lerp(h, Math.min(h, SEA + 1 + rn * 20), bank * 0.75);
    if (riv > 0) h = lerp(h, Math.min(h, SEA - 2.5 - Math.max(0, 1 - rn / 0.05) * 2.5), riv);
    h = clamp(h, 4, CH - 10);
    // Cliffs and overhangs only where mountains rise; elsewhere the surface stays clean.
    const amp = 0.6 + m * peak * 8 + bad * 3;
    const col = { h, amp, T, H, W: Wd, m, C, land: coast, riv, bad, swamp, D };
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
      return T < -0.6 ? BIOME.FROZEN_OCEAN : BIOME.OCEAN;
    }
    if (col.riv > 0.6) return BIOME.RIVER;
    if (surf <= SEA + 2 && col.land < 0.97 && col.swamp < 0.5) {
      if (T < -0.6) return BIOME.SNOWY;
      return steep ? BIOME.STONY_SHORE : BIOME.BEACH;
    }
    if (surf > 100 || (col.m > 0.6 && surf > 92)) return BIOME.PEAKS;
    if (T < -0.6) return BIOME.SNOWY;
    if (T < -0.3) return BIOME.TAIGA;
    if (col.bad > 0.5) return BIOME.BADLANDS;
    if (T > 0.28 && H > 0.3) return BIOME.JUNGLE;
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
    this.paintMineshafts(chunk);
    for (const v of this.villagesNear(chunk.cx, chunk.cz)) this.paintVillage(chunk, v);
  }

  // Replaces stone near the surface with biome materials, adds water and ice.
  paintColumn(bl, x, z, wx, wz, col, biome, steep, top) {
    const r = hash2(wx, wz, this.seed);
    const cold = col.T < -0.6;
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
    if (r > 0.11) return null;
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
      [BIOME.TAIGA]: 0.05, [BIOME.SNOWY]: 0.016, [BIOME.SAVANNA]: 0.012, [BIOME.SWAMP]: 0.022, [BIOME.PEAKS]: 0.004, [BIOME.CHERRY]: 0.03, [BIOME.JUNGLE]: 0.075,
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
      case BIOME.JUNGLE: type = r2 < 0.12 ? 'megajungle' : r2 < 0.55 ? 'jungle' : 'junglebush'; break;
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
    for (let lz = -8; lz <= 23; lz++) for (let lx = -8; lx <= 23; lx++) {
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
    this.smallStructures(chunk, surf, biomes, rnd, set);
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
        if (biome === BIOME.SWAMP && this.patch.noise2(wx / 7, wz / 7) > 0.72) { bl[idx(x, h, z)] = B.MOSS_BLOCK; continue; }
        if (biome === BIOME.JUNGLE) { grass = 0.32; flower = 0.004; }
        if (r < flower) {
          const k = Math.floor(hash2(wx, wz, 7) * 4);
          bl[ai] = [B.POPPY, B.BUTTERCUP, B.CORNFLOWER, B.DAISY][(k + (flowers > 0.2 ? 2 : 0)) % 4];
        } else if (r < flower + grass) bl[ai] = biome === BIOME.TAIGA || (biome === BIOME.SWAMP && r > flower + grass * 0.6) ? B.FERN : B.TALL_GRASS;
        else if (r > 0.9985 && (biome === BIOME.PLAINS || biome === BIOME.FOREST || biome === BIOME.SAVANNA)) { bl[ai] = B.PUMPKIN; me[ai] = [0, 1, 4, 5][Math.floor(hash2(wx, wz, 3) * 4)]; }
        else if (r > 0.9975 && r <= 0.9985 && (biome === BIOME.SAVANNA || biome === BIOME.SWAMP || biome === BIOME.PLAINS || biome === BIOME.JUNGLE)) bl[ai] = B.MELON;
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
    if (dry && rnd() > 0.12) return;
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

  // ---------------------------------------------------------------- villages
  // Each 288-block region may hold one village. The layout is a pure function of
  // the region, so every chunk paints its own slice of the same village.
  villageAt(rx, rz) {
    const key = rx * 100000 + rz;
    if (this.villages.has(key)) return this.villages.get(key);
    let v = null;
    const RS = 288;
    if (hash2(rx, rz, this.seed ^ 0x7111) < 0.5) {
      const cx = rx * RS + 56 + Math.floor(hash2(rx, rz, this.seed ^ 1) * 176);
      const cz = rz * RS + 56 + Math.floor(hash2(rx, rz, this.seed ^ 2) * 176);
      const col = this.column(cx, cz), y = this.surfaceAt(cx, cz, col);
      const biome = this.biomeOf(col, y, this.steep(cx, cz, col));
      const styles = { [BIOME.PLAINS]: 'oak', [BIOME.MEADOW]: 'oak', [BIOME.SAVANNA]: 'acacia', [BIOME.DESERT]: 'desert', [BIOME.TAIGA]: 'spruce', [BIOME.SNOWY]: 'spruce', [BIOME.FOREST]: 'oak' };
      if (styles[biome] && y > SEA + 1 && col.m < 0.3 && col.riv < 0.2) v = this.layoutVillage(rx, rz, cx, cz, styles[biome]);
    }
    if (this.villages.size > 400) this.villages.clear();
    this.villages.set(key, v);
    return v;
  }

  layoutVillage(rx, rz, cx, cz, style) {
    const rng = mulberry32((Math.imul(rx, 9137) ^ Math.imul(rz, 5503) ^ this.seed ^ 0xa11) | 0);
    const pieces = [], roads = [];
    const box = (x0, z0, w, d) => ({ x0, z0, x1: x0 + w - 1, z1: z0 + d - 1 });
    const free = (b) => pieces.every((p) => b.x1 + 1 < p.x0 || b.x0 - 1 > p.x1 || b.z1 + 1 < p.z0 || b.z0 - 1 > p.z1)
      && roads.every((r) => b.x1 < r.x0 || b.x0 > r.x1 || b.z1 < r.z0 || b.z0 > r.z1);
    const add = (type, x0, z0, w, d, rot, extra = {}) => {
      const fw = rot % 2 ? d : w, fd = rot % 2 ? w : d;
      const b = box(x0, z0, fw, fd);
      if (!free(b)) return false;
      const y = this.surfaceAt(x0 + (fw >> 1), z0 + (fd >> 1));
      if (y <= SEA) return false;
      pieces.push({ type, rot, w, d, y, ...b, ...extra });
      return true;
    };
    add('well', cx - 2, cz - 2, 5, 5, 0);
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const [dx, dz] of dirs) {
      if (rng() > 0.85) continue;
      const len = 16 + Math.floor(rng() * 22);
      const sx = cx + dx * 3, sz = cz + dz * 3, ex = cx + dx * (3 + len), ez = cz + dz * (3 + len);
      roads.push({ x0: Math.min(sx, ex) - (dz ? 1 : 0), x1: Math.max(sx, ex) + (dz ? 1 : 0), z0: Math.min(sz, ez) - (dx ? 1 : 0), z1: Math.max(sz, ez) + (dx ? 1 : 0) });
      for (let t = 6; t < len - 2; t += 8 + Math.floor(rng() * 4)) {
        const px = cx + dx * (3 + t), pz = cz + dz * (3 + t);
        for (const side of [-1, 1]) {
          if (rng() < 0.25) continue;
          const roll = rng();
          const [type, w, d] = roll < 0.45 ? ['house', 5, 5] : roll < 0.65 ? ['bighouse', 7, 7] : roll < 0.88 ? ['farm', 7, 9] : ['lamp', 1, 1];
          // Front of each piece faces the road.
          let x0, z0, rot;
          if (dx) {
            rot = side < 0 ? 2 : 0;
            const fw = w, fd = d;
            x0 = px - (fw >> 1);
            z0 = side < 0 ? cz - 2 - fd : cz + 2;
          } else {
            rot = side < 0 ? 1 : 3;
            const fw = d, fd = w;
            z0 = pz - (fd >> 1);
            x0 = side < 0 ? cx - 2 - fw : cx + 2;
          }
          add(type, x0, z0, w, d, rot);
        }
        if (rng() < 0.5) add('lamp', px + (dz ? 2 : 0), pz + (dx ? 2 : 0), 1, 1, 0);
      }
    }
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const p of [...pieces, ...roads]) { x0 = Math.min(x0, p.x0); z0 = Math.min(z0, p.z0); x1 = Math.max(x1, p.x1); z1 = Math.max(z1, p.z1); }
    return { cx, cz, style, pieces, roads, x0: x0 - 2, z0: z0 - 2, x1: x1 + 2, z1: z1 + 2 };
  }

  villagesNear(cx, cz) {
    const out = [], RS = 288;
    const x0 = cx * 16, z0 = cz * 16;
    for (let rx = Math.floor((x0 - 80) / RS); rx <= Math.floor((x0 + 95) / RS); rx++)
      for (let rz = Math.floor((z0 - 80) / RS); rz <= Math.floor((z0 + 95) / RS); rz++) {
        const v = this.villageAt(rx, rz);
        if (v && v.x1 >= x0 && v.x0 <= x0 + 15 && v.z1 >= z0 && v.z0 <= z0 + 15) out.push(v);
      }
    return out;
  }

  paintVillage(chunk, v) {
    const bl = chunk.blocks, me = chunk.meta, X0 = chunk.cx * 16, Z0 = chunk.cz * 16;
    const inChunk = (x, z) => x >= X0 && x < X0 + 16 && z >= Z0 && z < Z0 + 16;
    const get = (x, y, z) => bl[idx(x - X0, y, z - Z0)];
    const put = (x, y, z, id, meta = 0) => { if (!inChunk(x, z) || y < 1 || y >= CH) return; const i = idx(x - X0, y, z - Z0); bl[i] = id; me[i] = meta; };
    const soft = (id) => id === 0 || id === B.WATER || id === B.TALL_GRASS || id === B.FERN || id === B.SNOW || BLOCKS_LEAFY.has(id) || (id >= B.POPPY && id <= B.SPRUCE_SAPLING) || id === B.DAISY || id === B.CORNFLOWER || id === B.VINES;
    const S = {
      oak: { wall: B.PLANKS, post: B.LOG, floor: B.COBBLESTONE, roof: B.SPRUCE_PLANKS, slab: B.SPRUCE_SLAB, path: B.PATH },
      spruce: { wall: B.SPRUCE_PLANKS, post: B.SPRUCE_LOG, floor: B.COBBLESTONE, roof: B.SPRUCE_PLANKS, slab: B.SPRUCE_SLAB, path: B.PATH },
      acacia: { wall: B.ACACIA_PLANKS, post: B.ACACIA_LOG, floor: B.TERRACOTTA, roof: B.ACACIA_PLANKS, slab: B.OAK_SLAB, path: B.PATH },
      desert: { wall: B.SANDSTONE, post: B.SMOOTH_STONE, floor: B.SANDSTONE, roof: B.SANDSTONE, slab: B.SANDSTONE_SLAB, path: B.SMOOTH_STONE },
    }[v.style];
    // Roads follow the terrain; bridges cross water.
    for (const r of v.roads) {
      for (let x = Math.max(r.x0, X0); x <= Math.min(r.x1, X0 + 15); x++) for (let z = Math.max(r.z0, Z0); z <= Math.min(r.z1, Z0 + 15); z++) {
        const y = this.surfaceAt(x, z);
        if (y < SEA) { put(x, SEA, z, S.wall); continue; }
        put(x, y, z, S.path);
        for (let k = 1; k <= 5; k++) if (soft(get(x, y + k, z)) || BLOCKS_WOOD.has(get(x, y + k, z))) put(x, y + k, z, 0);
      }
    }
    for (const p of v.pieces) {
      if (p.x1 < X0 || p.x0 > X0 + 15 || p.z1 < Z0 || p.z0 > Z0 + 15) continue;
      const fw = p.rot % 2 ? p.d : p.w;
      // local (lx, ly, lz) -> world; lz = 0 is the front (door side).
      const T = (lx, lz) => {
        switch (p.rot) {
          case 0: return [p.x0 + lx, p.z0 + lz];
          case 1: return [p.x0 + (p.d - 1 - lz), p.z0 + lx];
          case 2: return [p.x0 + (p.w - 1 - lx), p.z0 + (p.d - 1 - lz)];
          default: return [p.x0 + lz, p.z0 + (p.w - 1 - lx)];
        }
      };
      const at = (lx, ly, lz, id, meta = 0) => { const [x, z] = T(lx, lz); put(x, p.y + ly, z, id, meta); };
      const foundation = () => {
        for (let lz = 0; lz < p.d; lz++) for (let lx = 0; lx < p.w; lx++) {
          const [x, z] = T(lx, lz);
          if (!inChunk(x, z)) continue;
          for (let y = p.y; y > p.y - 9 && y > 0; y--) { if (y < p.y && !soft(get(x, y, z))) break; put(x, y, z, y === p.y ? S.floor : B.COBBLESTONE); }
          for (let k = 1; k <= 9; k++) put(x, p.y + k, z, 0);
        }
      };
      const front = [5, 0, 4, 1][p.rot];
      if (p.type === 'house' || p.type === 'bighouse') {
        const big = p.type === 'bighouse', W = p.w, D = p.d, H = big ? 4 : 3;
        foundation();
        for (let lz = 0; lz < D; lz++) for (let lx = 0; lx < W; lx++) {
          const edge = lx === 0 || lz === 0 || lx === W - 1 || lz === D - 1;
          if (!edge) { at(lx, 0, lz, big ? S.wall : S.floor); continue; }
          const corner = (lx === 0 || lx === W - 1) && (lz === 0 || lz === D - 1);
          for (let ly = 1; ly <= H; ly++) {
            const door = lz === 0 && lx === (W >> 1) && ly <= 2;
            const window = !corner && ly === 2 && (lx === 1 || lx === W - 2 || lz === D >> 1) && !(lz === 0 && Math.abs(lx - (W >> 1)) < 1);
            if (door) continue;
            at(lx, ly, lz, corner ? S.post : window ? B.GLASS : S.wall, corner ? 0 : 0);
          }
        }
        // Stepped roof.
        for (let layer = 0; layer <= (W >> 1); layer++) for (let lz = layer - 1; lz <= D - layer; lz++) for (let lx = layer - 1; lx <= W - layer; lx++) {
          const ring = lx === layer - 1 || lz === layer - 1 || lx === W - layer || lz === D - layer;
          if (!ring && layer < (W >> 1)) continue;
          at(lx, H + 1 + layer, lz, ring ? S.slab : S.roof, 0);
        }
        at(1, 1, D - 2, B.BEDROLL, front);
        at(W - 2, 1, D - 2, (p.x0 + p.z0) % 3 ? B.CRAFTING_TABLE : B.CHEST, front);
        at(W >> 1, H, D >> 1, B.LANTERN, 1);
        if (big) { at(1, 1, 1, B.FURNACE, front); at(W - 2, 1, 1, B.BOOKSHELF, 0); }
        for (let k = 1; k <= 2; k++) { const [x, z] = T(W >> 1, -k); const y = this.surfaceAt(x, z); if (inChunk(x, z) && Math.abs(y - p.y) <= 2) put(x, y, z, S.path); }
      } else if (p.type === 'farm') {
        foundation();
        for (let lz = 0; lz < p.d; lz++) for (let lx = 0; lx < p.w; lx++) {
          const edge = lx === 0 || lz === 0 || lx === p.w - 1 || lz === p.d - 1;
          if (edge) { at(lx, 0, lz, S.post, (lx === 0 || lx === p.w - 1) ? 2 : 1); continue; }
          if (lx === p.w >> 1) { at(lx, 0, lz, B.WATER); continue; }
          at(lx, 0, lz, B.FARMLAND);
          at(lx, 1, lz, B.WHEAT, 3 + Math.floor(hash2(p.x0 + lx, p.z0 + lz, 4) * 5));
        }
      } else if (p.type === 'well') {
        foundation();
        for (let lz = 0; lz < 5; lz++) for (let lx = 0; lx < 5; lx++) {
          const inner = lx >= 1 && lx <= 3 && lz >= 1 && lz <= 3, core = lx === 2 && lz === 2;
          if (core) { for (let k = -4; k <= 0; k++) at(lx, k, lz, B.WATER); continue; }
          at(lx, 0, lz, B.COBBLESTONE);
          if (inner) at(lx, 1, lz, B.COBBLESTONE);
          if ((lx === 1 || lx === 3) && (lz === 1 || lz === 3)) { at(lx, 2, lz, B.FENCE_POST); at(lx, 3, lz, B.FENCE_POST); }
          if (inner) at(lx, 4, lz, S.slab, 0);
        }
        at(2, 3, 2, B.LANTERN, 1);
      } else if (p.type === 'lamp') {
        const [x, z] = T(0, 0);
        if (!inChunk(x, z)) continue;
        const y = this.surfaceAt(x, z);
        put(x, y, z, B.COBBLESTONE);
        for (let k = 1; k <= 3; k++) put(x, y + k, z, B.FENCE_POST);
        put(x, y + 4, z, B.LANTERN, 0);
      }
    }
  }

  // ---------------------------------------------------------------- mineshafts
  mineshaftAt(rx, rz) {
    const key = rx * 100000 + rz;
    if (this.shafts.has(key)) return this.shafts.get(key);
    let m = null;
    const RS = 224;
    if (hash2(rx, rz, this.seed ^ 0x3a17) < 0.4) {
      const rng = mulberry32((Math.imul(rx, 7349) ^ Math.imul(rz, 3911) ^ this.seed ^ 0x5af7) | 0);
      const cx = rx * RS + 40 + Math.floor(rng() * 144), cz = rz * RS + 40 + Math.floor(rng() * 144), y = 16 + Math.floor(rng() * 20);
      const cors = [];
      const q = [[cx, cz, 0, 0], [cx, cz, 1, 0], [cx, cz, 2, 0], [cx, cz, 3, 0]];
      const D = [[1, 0], [0, 1], [-1, 0], [0, -1]];
      while (q.length && cors.length < 28) {
        const [sx, sz, dir, depth] = q.shift();
        if (rng() < 0.15 && depth > 0) continue;
        const len = 10 + Math.floor(rng() * 22), [dx, dz] = D[dir];
        const ex = sx + dx * len, ez = sz + dz * len;
        if (Math.abs(ex - cx) > 96 || Math.abs(ez - cz) > 96) continue;
        const cy = y + (depth % 2 && rng() < 0.4 ? (rng() < 0.5 ? -3 : 3) : 0);
        cors.push({ x0: Math.min(sx, ex) - (dz ? 1 : 0), x1: Math.max(sx, ex) + (dz ? 1 : 0), z0: Math.min(sz, ez) - (dx ? 1 : 0), z1: Math.max(sz, ez) + (dx ? 1 : 0), y: cy, alongX: !!dx });
        if (depth < 4) for (const nd of [dir, (dir + 1) % 4, (dir + 3) % 4]) if (rng() < (nd === dir ? 0.5 : 0.55)) q.push([ex, ez, nd, depth + 1]);
      }
      let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
      for (const c of cors) { x0 = Math.min(x0, c.x0); z0 = Math.min(z0, c.z0); x1 = Math.max(x1, c.x1); z1 = Math.max(z1, c.z1); }
      m = { cors, x0, z0, x1, z1 };
    }
    if (this.shafts.size > 400) this.shafts.clear();
    this.shafts.set(key, m);
    return m;
  }

  paintMineshafts(chunk) {
    const bl = chunk.blocks, me = chunk.meta, X0 = chunk.cx * 16, Z0 = chunk.cz * 16, RS = 224;
    for (let rx = Math.floor((X0 - 110) / RS); rx <= Math.floor((X0 + 125) / RS); rx++)
      for (let rz = Math.floor((Z0 - 110) / RS); rz <= Math.floor((Z0 + 125) / RS); rz++) {
        const m = this.mineshaftAt(rx, rz);
        if (!m || m.x1 < X0 || m.x0 > X0 + 15 || m.z1 < Z0 || m.z0 > Z0 + 15) continue;
        for (const c of m.cors) {
          if (c.x1 < X0 || c.x0 > X0 + 15 || c.z1 < Z0 || c.z0 > Z0 + 15) continue;
          for (let x = Math.max(c.x0, X0); x <= Math.min(c.x1, X0 + 15); x++) for (let z = Math.max(c.z0, Z0); z <= Math.min(c.z1, Z0 + 15); z++) {
            const lx = x - X0, lz = z - Z0;
            const along = c.alongX ? x : z;
            const side = c.alongX ? (z === c.z0 ? -1 : z === c.z1 ? 1 : 0) : (x === c.x0 ? -1 : x === c.x1 ? 1 : 0);
            if (bl[idx(lx, c.y + 3, lz)] === B.WATER) continue;
            let wet = false;
            for (let y = c.y; y <= c.y + 2; y++) { const id = bl[idx(lx, y, lz)]; if (id === B.WATER || id === B.LAVA) wet = true; }
            if (wet) continue;
            const support = ((along % 5) + 5) % 5 === 0;
            for (let y = c.y; y <= c.y + 2; y++) {
              const i = idx(lx, y, lz);
              if (bl[i] === B.BEDROCK) continue;
              let id = 0;
              if (support && side !== 0 && y < c.y + 2) id = B.FENCE_POST;
              else if (support && y === c.y + 2) id = B.PLANKS;
              else if (!support && side !== 0 && y === c.y + 2 && hash3(x, y, z, this.seed ^ 0xc0b) < 0.12) id = B.COBWEB;
              bl[i] = id; me[i] = 0;
            }
            const fi = idx(lx, c.y - 1, lz);
            if (bl[fi] === 0 || bl[fi] === B.LAVA || bl[fi] === B.WATER) bl[fi] = B.PLANKS;
            if (side !== 0 && !support && hash3(x, c.y, z, this.seed ^ 0xc4e) < 0.006) { bl[idx(lx, c.y, lz)] = B.CHEST; me[idx(lx, c.y, lz)] = 0; }
            else if (side === 0 && support && hash3(x, c.y, z, this.seed ^ 0x1a7) < 0.35) { bl[idx(lx, c.y + 1, lz)] = B.LANTERN; me[idx(lx, c.y + 1, lz)] = 1; }
          }
        }
      }
  }

  // ---------------------------------------------------------------- small builds (inside one chunk)
  smallStructures(chunk, surf, biomes, rnd, set) {
    const bl = chunk.blocks;
    const flat = (x0, z0, w, d) => {
      let lo = 999, hi = 0;
      for (let z = z0; z < z0 + d; z++) for (let x = x0; x < x0 + w; x++) { const s = surf[z * 16 + x]; lo = Math.min(lo, s); hi = Math.max(hi, s); }
      return hi - lo <= 1 && lo > SEA ? hi : -1;
    };
    const roll = rnd();
    const x0 = 4 + Math.floor(rnd() * 4), z0 = 4 + Math.floor(rnd() * 4);
    const b = biomes[(z0 + 3) * 16 + x0 + 3];
    if (b === BIOME.DESERT && roll < 0.012) {
      const y = flat(x0, z0, 4, 4);
      if (y < 0) return;
      for (let z = 0; z < 4; z++) for (let x = 0; x < 4; x++) {
        const inner = x > 0 && x < 3 && z > 0 && z < 3;
        set(x0 + x, y, z0 + z, inner ? B.WATER : B.SANDSTONE, false);
        if (inner) for (let k = 1; k < 4; k++) set(x0 + x, y - k, z0 + z, B.WATER, false);
        else { set(x0 + x, y + 1, z0 + z, B.SANDSTONE_SLAB, false); }
        if ((x === 0 || x === 3) && (z === 0 || z === 3)) { set(x0 + x, y + 2, z0 + z, B.SANDSTONE, false); set(x0 + x, y + 3, z0 + z, B.SANDSTONE, false); }
        set(x0 + x, y + 4, z0 + z, B.SANDSTONE_SLAB, false);
      }
    } else if (b === BIOME.SNOWY && roll < 0.02) {
      const y = flat(x0, z0, 7, 7);
      if (y < 0) return;
      for (let dy = 0; dy <= 4; dy++) for (let dz = -3; dz <= 3; dz++) for (let dx = -3; dx <= 3; dx++) {
        const d = Math.hypot(dx, dy * 1.25, dz);
        const x = x0 + 3 + dx, z = z0 + 3 + dz;
        if (d < 3.4 && d >= 2.4) set(x, y + 1 + dy, z, dy === 1 && dx === 3 && dz === 0 ? B.ICE : B.SNOW, false);
        else if (d < 2.4) set(x, y + 1 + dy, z, 0, false);
      }
      set(x0 + 3, y + 1, z0, 0, false); set(x0 + 3, y + 2, z0, 0, false);
      set(x0 + 3, y + 1, z0 + 5, B.CHEST, false, 5); set(x0 + 2, y + 1, z0 + 4, B.BEDROLL, false, 4); set(x0 + 4, y + 1, z0 + 4, B.TORCH, false, 0);
    } else if (b === BIOME.SWAMP && roll < 0.04) {
      const y = SEA + 3;
      for (let z = 0; z < 5; z++) for (let x = 0; x < 5; x++) {
        if ((x === 0 || x === 4) && (z === 0 || z === 4)) for (let k = y; k > SEA - 3; k--) if (bl[idx(x0 + x, k, z0 + z)] === 0 || bl[idx(x0 + x, k, z0 + z)] === B.WATER || k >= y) set(x0 + x, k, z0 + z, B.SPRUCE_LOG, false);
        set(x0 + x, y, z0 + z, B.SPRUCE_PLANKS, false);
        const edge = x === 0 || z === 0 || x === 4 || z === 4;
        for (let k = 1; k <= 3; k++) set(x0 + x, y + k, z0 + z, edge ? (k === 2 && (x === 2 || z === 2) ? B.GLASS : B.SPRUCE_PLANKS) : 0, false);
        set(x0 + x, y + 4, z0 + z, B.SPRUCE_SLAB, false);
      }
      set(x0 + 2, y + 1, z0, 0, false); set(x0 + 2, y + 2, z0, 0, false);
      set(x0 + 2, y + 1, z0 + 3, B.CHEST, false, 5); set(x0 + 1, y + 3, z0 + 2, B.LANTERN, false, 1);
      for (let k = 1; k <= 3; k++) set(x0 + 2, y - k + 1, z0 - 1, B.LADDER, false, 4);
    } else if ((b === BIOME.PLAINS || b === BIOME.FOREST || b === BIOME.TAIGA || b === BIOME.MEADOW) && roll < 0.01) {
      const y = flat(x0, z0, 3, 3);
      if (y < 0) return;
      const H = 9;
      for (let k = 0; k <= H; k++) for (let z = 0; z < 3; z++) for (let x = 0; x < 3; x++) {
        const corner = (x === 0 || x === 2) && (z === 0 || z === 2);
        if (corner) set(x0 + x, y + k, z0 + z, B.LOG, false);
        else if (x === 1 && z === 1) set(x0 + x, y + k, z0 + z, k === 0 ? B.COBBLESTONE : 0, false);
        else set(x0 + x, y + k, z0 + z, k === 0 || k === H ? B.PLANKS : k % 3 === 2 && x === 1 && z === 0 ? 0 : 0, false);
      }
      for (let k = 1; k <= H; k++) set(x0 + 1, y + k, z0 + 1, B.LADDER, false, 4);
      set(x0 + 1, y + H, z0 + 1, 0, false);
      for (let z = -1; z <= 3; z++) for (let x = -1; x <= 3; x++) {
        set(x0 + x, y + H, z0 + z, x === 1 && z === 1 ? 0 : B.PLANKS, false);
        if (x === -1 || z === -1 || x === 3 || z === 3) set(x0 + x, y + H + 1, z0 + z, B.FENCE_POST, false);
      }
      set(x0 + 3, y + H + 2, z0 + 3, B.LANTERN, false, 0);
      set(x0 + 2, y + H + 1, z0 + 2, B.CHEST, false, 4);
    }
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
    case 'jungle': case 'megajungle': {
      const mega = type === 'megajungle';
      const h = mega ? 16 + Math.floor(rng() * 8) : 8 + Math.floor(rng() * 5);
      const w = mega ? 2 : 1;
      for (let k = 0; k < h; k++) for (let dz = 0; dz < w; dz++) for (let dx = 0; dx < w; dx++) set(x + dx, y + k, z + dz, B.JUNGLE_LOG, false);
      const cx0 = x + (w - 1) / 2, cz0 = z + (w - 1) / 2;
      blob(Math.round(cx0), y + h, Math.round(cz0), mega ? 4.2 : 2.6, B.JUNGLE_LEAVES, 2.2);
      if (mega) for (let b = 0; b < 3; b++) {
        const a = rng() * 6.283, by = y + Math.floor(h * (0.55 + rng() * 0.25));
        const ex = Math.round(cx0 + Math.cos(a) * 4), ez = Math.round(cz0 + Math.sin(a) * 4);
        for (let k = 1; k <= 3; k++) set(Math.round(cx0 + Math.cos(a) * k), by + Math.floor(k / 2), Math.round(cz0 + Math.sin(a) * k), B.JUNGLE_LOG, false, Math.abs(Math.cos(a)) > 0.7 ? 1 : 2);
        blob(ex, by + 2, ez, 2.4, B.JUNGLE_LEAVES, 2);
      }
      // Vines hang from the trunk sides and the canopy edge.
      const vine = (vx, vy, vz, meta, len) => { for (let k = 0; k < len; k++) set(vx, vy - k, vz, B.VINES, true, meta); };
      for (let k = 2; k < h - 1; k++) {
        if (rng() < 0.35) vine(x - 1, y + k, z, 2, 1);
        if (rng() < 0.35) vine(x + w, y + k, z, 1, 1);
        if (rng() < 0.3) vine(x, y + k, z - 1, 4, 1);
        if (rng() < 0.3) vine(x, y + k, z + w, 3, 1);
      }
      const R = mega ? 5 : 3;
      for (let i = 0; i < (mega ? 14 : 6); i++) {
        const a = rng() * 6.283, vx = Math.round(cx0 + Math.cos(a) * R), vz = Math.round(cz0 + Math.sin(a) * R);
        const dir = Math.abs(Math.cos(a)) > Math.abs(Math.sin(a)) ? (Math.cos(a) > 0 ? 1 : 2) : (Math.sin(a) > 0 ? 3 : 4);
        vine(vx, y + h - 1, vz, dir, 2 + Math.floor(rng() * 5));
      }
      return;
    }
    case 'junglebush': {
      blob(x, y + 1, z, 1.8, B.JUNGLE_LEAVES, 1.4);
      set(x, y, z, B.JUNGLE_LOG, false);
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
