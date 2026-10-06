// Deterministic terrain generation: height, biomes, caves, ores, trees, plants.
import { Noise, hash2, hash3, mulberry32 } from './noise.js';
import { B } from './blocks.js';
import { CS, CH, SEA } from './consts.js';
import { smooth, clamp } from './math.js';

export const BIOME = { OCEAN: 0, BEACH: 1, PLAINS: 2, FOREST: 3, DESERT: 4, SNOWY: 5, PEAKS: 6, FROZEN_OCEAN: 7 };
export const BIOME_NAMES = ['Ocean', 'Beach', 'Plains', 'Forest', 'Desert', 'Snowy Taiga', 'Peaks', 'Frozen Ocean'];

const idx = (x, y, z) => (y << 8) | (z << 4) | x;

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
  }

  heightAt(x, z) {
    const c = this.cont.fbm2(x / 800, z / 800, 4);
    const e = this.ero.fbm2(x / 420, z / 420, 3);
    const d = this.detail.fbm2(x / 70, z / 70, 4);
    const r = 1 - Math.abs(this.ridge.fbm2(x / 230, z / 230, 4));
    const land = smooth((c + 0.2) / 0.28);
    let h = SEA - 22 + land * 25 + c * 10;
    h += d * (3 + 8 * land);
    const m = smooth((e - 0.02) / 0.45) * land;
    h += m * (14 + 38 * r * r);
    return Math.floor(clamp(h, 3, CH - 6));
  }

  climate(x, z) {
    const t = this.temp.fbm2(x / 1100, z / 1100, 3) * 1.6 + this.detail.noise2(x / 40, z / 40) * 0.03;
    const hm = this.hum.fbm2(x / 900, z / 900, 3) * 1.6;
    return [t, hm];
  }

  biomeAt(x, z, h, t, hm) {
    if (t === undefined) [t, hm] = this.climate(x, z);
    if (h < SEA - 2) return t < -0.45 ? BIOME.FROZEN_OCEAN : BIOME.OCEAN;
    if (h <= SEA + 1 && t > -0.45) return BIOME.BEACH;
    if (h > 92) return BIOME.PEAKS;
    if (t < -0.35) return BIOME.SNOWY;
    if (t > 0.3 && hm < 0.05) return BIOME.DESERT;
    if (hm > 0.12) return BIOME.FOREST;
    return BIOME.PLAINS;
  }

  grassTint(t, hm) {
    let c = [118, 190, 78];
    const cold = [126, 172, 136], dry = [190, 184, 96], lush = [86, 170, 60];
    const lerpc = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
    if (t < 0) c = lerpc(c, cold, smooth(-t / 0.45));
    else c = lerpc(c, dry, smooth(t / 0.6) * (1 - smooth((hm + 0.1) / 0.4)));
    if (hm > 0) c = lerpc(c, lush, smooth(hm / 0.5) * 0.7);
    return c;
  }

  // Cave field values at an exact lattice point (lattice spacing 4).
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
  // Interpolated cave test at any world position (matches chunk generation).
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

  generate(chunk) {
    const bl = chunk.blocks, cx = chunk.cx * CS, cz = chunk.cz * CS;
    const heights = new Int16Array(18 * 18);
    for (let z = -1; z <= 16; z++) for (let x = -1; x <= 16; x++) heights[(z + 1) * 18 + x + 1] = this.heightAt(cx + x, cz + z);
    const H = (x, z) => heights[(z + 1) * 18 + x + 1];
    const biomes = new Uint8Array(256);

    for (let z = 0; z < CS; z++) for (let x = 0; x < CS; x++) {
      const wx = cx + x, wz = cz + z, h = H(x, z);
      const [t, hm] = this.climate(wx, wz);
      const biome = this.biomeAt(wx, wz, h, t, hm);
      biomes[z * 16 + x] = biome;
      const tint = this.grassTint(t, hm);
      chunk.tint[(z * 16 + x) * 3] = tint[0];
      chunk.tint[(z * 16 + x) * 3 + 1] = tint[1];
      chunk.tint[(z * 16 + x) * 3 + 2] = tint[2];
      const slope = Math.max(Math.abs(H(x + 1, z) - h), Math.abs(H(x - 1, z) - h), Math.abs(H(x, z + 1) - h), Math.abs(H(x, z - 1) - h));
      const r = hash2(wx, wz, this.seed);
      let top = B.GRASS, filler = B.DIRT, depth = 3 + (r < 0.5 ? 1 : 0);
      switch (biome) {
        case BIOME.OCEAN: case BIOME.FROZEN_OCEAN:
          top = r < 0.25 ? B.GRAVEL : r < 0.3 ? B.CLAY : B.SAND; filler = B.SAND; break;
        case BIOME.BEACH: top = B.SAND; filler = B.SAND; break;
        case BIOME.DESERT: top = B.SAND; filler = B.SAND; depth = 4; break;
        case BIOME.SNOWY: top = B.SNOWY_GRASS; break;
        case BIOME.PEAKS:
          top = h > 104 ? B.SNOW : B.STONE; filler = B.STONE; break;
      }
      if (slope > 3 && biome !== BIOME.OCEAN && biome !== BIOME.FROZEN_OCEAN) { top = B.STONE; filler = B.STONE; }
      for (let y = 0; y <= Math.max(h, SEA); y++) {
        let id;
        if (y === 0) id = B.BEDROCK;
        else if (y <= 3 && hash3(wx, y, wz, this.seed) < 0.6 - y * 0.15) id = B.BEDROCK;
        else if (y < h - depth) id = biome === BIOME.DESERT && y > h - depth - 4 ? B.SANDSTONE : B.STONE;
        else if (y < h) id = filler;
        else if (y === h) id = top;
        else id = (biome === BIOME.FROZEN_OCEAN || biome === BIOME.SNOWY) && y === SEA ? B.ICE : B.WATER;
        bl[idx(x, y, z)] = id;
      }
    }

    this.carveCaves(chunk, H);
    this.placeOres(chunk);
    this.decorate(chunk, H, biomes);
  }

  carveCaves(chunk, H) {
    const bl = chunk.blocks, cx = chunk.cx * CS, cz = chunk.cz * CS;
    const NY = CH / 4 + 1;
    const grid = new Float32Array(5 * 5 * NY * 3);
    let maxH = 0;
    for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) maxH = Math.max(maxH, H(x, z));
    const yLimit = Math.min(NY - 1, Math.floor(maxH / 4) + 1);
    for (let gz = 0; gz < 5; gz++) for (let gx = 0; gx < 5; gx++) for (let gy = 0; gy <= yLimit; gy++) {
      const s = this.caveSample(cx + gx * 4, gy * 4, cz + gz * 4);
      const i = ((gy * 5 + gz) * 5 + gx) * 3;
      grid[i] = s[0]; grid[i + 1] = s[1]; grid[i + 2] = s[2];
    }
    const G = (gx, gy, gz, k) => grid[((gy * 5 + gz) * 5 + gx) * 3 + k];
    for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
      const h = H(x, z);
      const wet = h < SEA + 2;
      const top = wet ? h - 5 : h;
      const gx = x >> 2, gz = z >> 2, tx = (x & 3) / 4, tz = (z & 3) / 4;
      for (let y = 1; y <= top; y++) {
        const gy = y >> 2, ty = (y & 3) / 4;
        const v = [0, 0, 0];
        for (let k = 0; k < 3; k++) {
          const c00 = G(gx, gy, gz, k) + (G(gx + 1, gy, gz, k) - G(gx, gy, gz, k)) * tx;
          const c10 = G(gx, gy + 1, gz, k) + (G(gx + 1, gy + 1, gz, k) - G(gx, gy + 1, gz, k)) * tx;
          const c01 = G(gx, gy, gz + 1, k) + (G(gx + 1, gy, gz + 1, k) - G(gx, gy, gz + 1, k)) * tx;
          const c11 = G(gx, gy + 1, gz + 1, k) + (G(gx + 1, gy + 1, gz + 1, k) - G(gx, gy + 1, gz + 1, k)) * tx;
          const c0 = c00 + (c10 - c00) * ty, c1 = c01 + (c11 - c01) * ty;
          v[k] = c0 + (c1 - c0) * tz;
        }
        if (!WorldGen.carveTest(v[0], v[1], v[2], y)) continue;
        const i = idx(x, y, z);
        if (bl[i] === B.BEDROCK || bl[i] === B.WATER || bl[i] === B.ICE) continue;
        bl[i] = y <= 10 ? B.LAVA : 0;
        // Do not leave sand floating over a fresh cave mouth.
        const above = idx(x, y + 1, z);
        if (y + 1 < CH && (bl[above] === B.SAND || bl[above] === B.GRAVEL)) bl[above] = B.SANDSTONE;
      }
    }
  }

  placeOres(chunk) {
    const bl = chunk.blocks;
    const rnd = mulberry32((Math.imul(chunk.cx, 341873128) ^ Math.imul(chunk.cz, 132897987) ^ this.seed) | 0);
    const ores = [
      [B.COAL_ORE, 18, 5, 110, 10],
      [B.IRON_ORE, 12, 5, 64, 7],
      [B.GOLD_ORE, 3, 5, 32, 6],
      [B.DIAMOND_ORE, 1.4, 4, 16, 5],
      [B.GRAVEL, 6, 5, 90, 14],
      [B.DIRT, 6, 5, 90, 14],
    ];
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

  treeAt(wx, wz) {
    const r = hash2(wx, wz, this.seed ^ 0x5eed);
    if (r > 0.05) return null;
    const h = this.heightAt(wx, wz);
    if (h <= SEA) return null;
    const biome = this.biomeAt(wx, wz, h);
    const density = { [BIOME.FOREST]: 0.05, [BIOME.PLAINS]: 0.004, [BIOME.SNOWY]: 0.022, [BIOME.PEAKS]: 0.003 }[biome] || 0;
    if (r >= density) return null;
    if (biome === BIOME.PEAKS && h > 98) return null;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (Math.abs(this.heightAt(wx + dx, wz + dz) - h) > 3) return null;
    if (this.isCave(wx, h, wz)) return null;
    const r2 = hash2(wx, wz, this.seed ^ 0x77);
    let type = 'oak';
    if (biome === BIOME.SNOWY || biome === BIOME.PEAKS) type = 'spruce';
    else if (biome === BIOME.FOREST && r2 < 0.35) type = 'birch';
    return { h, type, r2 };
  }

  decorate(chunk, H, biomes) {
    const bl = chunk.blocks, cx = chunk.cx * CS, cz = chunk.cz * CS;
    const set = (x, y, z, id, onlyAir) => {
      if (x < 0 || x > 15 || z < 0 || z > 15 || y < 1 || y >= CH) return;
      const i = idx(x, y, z);
      if (onlyAir && bl[i] !== 0 && bl[i] !== B.TALL_GRASS) return;
      bl[i] = id;
    };
    for (let lz = -3; lz <= 18; lz++) for (let lx = -3; lx <= 18; lx++) {
      const t = this.treeAt(cx + lx, cz + lz);
      if (!t) continue;
      if (lx >= 0 && lx < 16 && lz >= 0 && lz < 16) {
        const s = bl[idx(lx, t.h, lz)];
        if (s !== B.GRASS && s !== B.SNOWY_GRASS && s !== B.DIRT) continue;
      }
      placeTree(set, lx, t.h + 1, lz, t.type, t.r2);
      set(lx, t.h, lz, B.DIRT, false);
    }
    for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
      const wx = cx + x, wz = cz + z, h = H(x, z);
      if (h + 1 >= CH) continue;
      const top = bl[idx(x, h, z)], above = bl[idx(x, h + 1, z)];
      if (above !== 0) continue;
      const r = hash2(wx, wz, this.seed ^ 0xdec0);
      const biome = biomes[z * 16 + x];
      if (top === B.GRASS) {
        const g = biome === BIOME.FOREST ? 0.1 : 0.16;
        if (r < g) bl[idx(x, h + 1, z)] = B.TALL_GRASS;
        else if (r < g + 0.012) bl[idx(x, h + 1, z)] = r < g + 0.006 ? B.POPPY : B.BUTTERCUP;
      } else if (top === B.SAND && biome === BIOME.DESERT) {
        if (r < 0.006) {
          const ch = 1 + Math.floor(hash2(wx, wz, 99) * 3);
          for (let k = 1; k <= ch; k++) bl[idx(x, h + k, z)] = B.CACTUS;
        } else if (r < 0.014) bl[idx(x, h + 1, z)] = B.DEAD_BUSH;
      }
    }
  }

  findSpawn() {
    for (let r = 0; r < 400; r += 4) {
      for (let a = 0; a < 16; a++) {
        const x = Math.round(Math.cos((a / 16) * Math.PI * 2) * r), z = Math.round(Math.sin((a / 16) * Math.PI * 2) * r);
        const h = this.heightAt(x, z);
        const b = this.biomeAt(x, z, h);
        if (h <= SEA + 1 || (b !== BIOME.PLAINS && b !== BIOME.FOREST) || this.treeAt(x, z) || this.isCave(x, h, z)) continue;
        let flat = true;
        for (let dz = -2; dz <= 2 && flat; dz++) for (let dx = -2; dx <= 2; dx++) if (Math.abs(this.heightAt(x + dx, z + dz) - h) > 1) { flat = false; break; }
        if (flat) return [x + 0.5, h + 1, z + 0.5];
      }
    }
    return [0.5, this.heightAt(0, 0) + 2, 0.5];
  }
}

// Places a tree with `set(x,y,z,id,onlyAir)`; used by generation and sapling growth.
export function placeTree(set, x, y, z, type, r) {
  const log = type === 'birch' ? B.BIRCH_LOG : type === 'spruce' ? B.SPRUCE_LOG : B.LOG;
  const leaf = type === 'birch' ? B.BIRCH_LEAVES : type === 'spruce' ? B.SPRUCE_LEAVES : B.LEAVES;
  const rr = (k) => hash2(x * 7 + k, z * 13 - k, Math.floor(r * 1e6));
  if (type === 'spruce') {
    const h = 6 + (Math.floor(r * 60) % 4);
    set(x, y + h, z, leaf, true);
    for (let dy = h - 1; dy >= 2; dy--) {
      const k = h - 1 - dy;
      const rad = k < 2 ? 1 : k % 2 ? 2 : 1;
      for (let dz = -rad; dz <= rad; dz++) for (let dx = -rad; dx <= rad; dx++) {
        if (Math.abs(dx) === rad && Math.abs(dz) === rad) continue;
        set(x + dx, y + dy, z + dz, leaf, true);
      }
    }
    for (let k = 0; k < h; k++) set(x, y + k, z, log, false);
    return;
  }
  const h = (type === 'birch' ? 5 : 4) + Math.floor(r * 100) % 3;
  for (let dy = h - 3; dy <= h; dy++) {
    const rad = dy >= h - 1 ? 1 : 2;
    for (let dz = -rad; dz <= rad; dz++) for (let dx = -rad; dx <= rad; dx++) {
      const corner = Math.abs(dx) === rad && Math.abs(dz) === rad;
      if (corner && (dy === h || rr(dx * 5 + dz + dy * 31) < 0.5)) continue;
      set(x + dx, y + dy, z + dz, leaf, true);
    }
  }
  for (let k = 0; k < h; k++) set(x, y + k, z, log, false);
}
