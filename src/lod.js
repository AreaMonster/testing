// Far terrain: coarse tiles sampled straight from the terrain functions, so the
// view can reach far beyond the loaded chunks. Each tile is N x N cells of
// `step` blocks; cells are flat-topped columns with walls where the ground
// drops, plus rough tree canopies and a water surface.
import { B, TEXL } from './blocks.js';
import { MeshBuf, SHADE } from './mesher.js';
import { BIOME, GRASSY, TREE_DENSITY, BANDS } from './worldgen.js';
import { hash2 } from './noise.js';
import { SEA } from './consts.js';

export const LOD_N = 32;

const CANOPY = {
  [BIOME.FOREST]: [B.LEAVES, 5], [BIOME.PLAINS]: [B.LEAVES, 5], [BIOME.MEADOW]: [B.BIRCH_LEAVES, 6], [BIOME.SWAMP]: [B.LEAVES, 5],
  [BIOME.BIRCH_FOREST]: [B.BIRCH_LEAVES, 6], [BIOME.TAIGA]: [B.SPRUCE_LEAVES, 8], [BIOME.SNOWY]: [B.SPRUCE_LEAVES, 7], [BIOME.PEAKS]: [B.SPRUCE_LEAVES, 6],
  [BIOME.SAVANNA]: [B.ACACIA_LEAVES, 5], [BIOME.CHERRY]: [B.CHERRY_LEAVES, 5], [BIOME.JUNGLE]: [B.JUNGLE_LEAVES, 10], [BIOME.DARK_FOREST]: [B.DARK_OAK_LEAVES, 7],
};
const FOLIAGE = { [B.BIRCH_LEAVES]: [128, 167, 85], [B.SPRUCE_LEAVES]: [97, 140, 97], [B.CHERRY_LEAVES]: [255, 255, 255] };
// Side texture for a surface block's walls.
const WALL = { [B.GRASS]: B.DIRT, [B.PODZOL]: B.DIRT, [B.SNOWY_GRASS]: B.DIRT, [B.SNOW]: B.SNOW };

export function buildLod(gen, x0, z0, step, n = LOD_N) {
  const W = n + 2;
  const H = new Int16Array(W * W), top = new Uint8Array(W * W), tint = new Uint8Array(W * W * 3);
  const canopy = new Int16Array(W * W), leaf = new Uint8Array(W * W);
  const cols = new Array(W * W), biome = new Uint8Array(W * W);
  for (let j = 0; j < W; j++) for (let i = 0; i < W; i++) {
    const wx = x0 + (i - 1) * step + (step >> 1), wz = z0 + (j - 1) * step + (step >> 1);
    const col = gen.column(wx, wz);
    cols[j * W + i] = col;
    H[j * W + i] = Math.round(col.h);
  }
  for (let j = 0; j < W; j++) for (let i = 0; i < W; i++) {
    const k = j * W + i, col = cols[k], h = H[k];
    const wx = x0 + (i - 1) * step + (step >> 1), wz = z0 + (j - 1) * step + (step >> 1);
    // Steepness from neighbouring samples (cheaper than the exact test).
    let d = 0;
    if (i > 0) d = Math.max(d, Math.abs(H[k - 1] - h)); if (i < W - 1) d = Math.max(d, Math.abs(H[k + 1] - h));
    if (j > 0) d = Math.max(d, Math.abs(H[k - W] - h)); if (j < W - 1) d = Math.max(d, Math.abs(H[k + W] - h));
    const steep = d / step > 1.4;
    const b = gen.biomeOf(col, h, steep);
    biome[k] = b;
    let t = gen.surfaceBlocks(col, b, steep, h, wx, wz)[0];
    if (b === BIOME.BADLANDS) t = !steep && h < 96 ? B.RED_SAND : BANDS[((h % BANDS.length) + BANDS.length) % BANDS.length];
    if (h < SEA - 1 && GRASSY.has(b)) t = B.DIRT;
    top[k] = t;
    const g = gen.grassTint(col);
    tint[k * 3] = g[0]; tint[k * 3 + 1] = g[1]; tint[k * 3 + 2] = g[2];
    const c = CANOPY[b];
    if (c && h >= SEA && !steep && hash2(wx, wz, gen.seed ^ 0x10d) < Math.min(0.85, (TREE_DENSITY[b] || 0) * 20)) {
      canopy[k] = h + c[1]; leaf[k] = c[0];
    } else canopy[k] = -1;
  }
  const ob = new MeshBuf(4096), wb = new MeshBuf(1024);
  let minY = 999, maxY = 0;
  const S = step;
  const quad = (buf, pts, layer, uvw, uvh, f, flags, c) => {
    buf.ensure(4);
    const sh = SHADE[f] * 255;
    const uv = [[0, uvh], [uvw, uvh], [uvw, 0], [0, 0]];
    for (let q = 0; q < 4; q++) buf.v(pts[q][0], pts[q][1], pts[q][2], uv[q][0], uv[q][1], layer, 255, 0, sh, flags, c[0], c[1], c[2]);
  };
  const WHITE = [255, 255, 255];
  const tintFor = (id, k, face) => {
    if (id === B.GRASS && face === 2) return [tint[k * 3], tint[k * 3 + 1], tint[k * 3 + 2]];
    if (id === B.DIRT || id === B.STONE || id === B.SAND) return WHITE;
    if (LEAFLIKE.has(id)) { const f = FOLIAGE[id]; return f || [tint[k * 3] * 0.85, tint[k * 3 + 1] * 0.88, tint[k * 3 + 2] * 0.8]; }
    return WHITE;
  };
  // Wall from y0 to y1 on side f of cell (i, j) in local block units.
  const wall = (cx, cz, f, y0, y1, id, k) => {
    if (y1 <= y0) return;
    const layer = TEXL[id * 6 + (f === 2 ? 0 : f)];
    const c = tintFor(id, k, f), h = y1 - y0;
    let pts;
    if (f === 0) pts = [[cx + S, y0, cz + S], [cx + S, y0, cz], [cx + S, y1, cz], [cx + S, y1, cz + S]];
    else if (f === 1) pts = [[cx, y0, cz], [cx, y0, cz + S], [cx, y1, cz + S], [cx, y1, cz]];
    else if (f === 4) pts = [[cx, y0, cz + S], [cx + S, y0, cz + S], [cx + S, y1, cz + S], [cx, y1, cz + S]];
    else pts = [[cx + S, y0, cz], [cx, y0, cz], [cx, y1, cz], [cx + S, y1, cz]];
    quad(ob, pts, layer, S, h, f, 0, c);
  };
  const NB = [[1, 0, 0], [-1, 0, 1], [0, 1, 4], [0, -1, 5]];
  for (let j = 1; j <= n; j++) for (let i = 1; i <= n; i++) {
    const k = j * W + i, h = H[k] + 1, t = top[k];
    const cx = (i - 1) * S, cz = (j - 1) * S;
    const cTop = canopy[k] >= 0 ? canopy[k] + 1 : -1;
    const surf = cTop > 0 ? cTop : h;
    minY = Math.min(minY, h - S * 2); maxY = Math.max(maxY, surf, SEA + 1);
    // Top face: canopy or ground.
    const ttop = cTop > 0 ? leaf[k] : t;
    quad(ob, [[cx, surf, cz + S], [cx + S, surf, cz + S], [cx + S, surf, cz], [cx, surf, cz]], TEXL[ttop * 6 + 2], S, S, 2, cTop > 0 ? 16 : 0, tintFor(ttop, k, 2));
    // Walls toward lower neighbours; tile edges get a skirt to hide cracks between detail levels.
    for (const [di, dj, f] of NB) {
      const ni = i + di, nj = j + dj, nk = nj * W + ni;
      const edge = ni < 1 || nj < 1 || ni > n || nj > n;
      const nh = H[nk] + 1, ncan = canopy[nk] >= 0 ? canopy[nk] + 1 : -1;
      const nSurf = ncan > 0 ? ncan : nh;
      const lo = edge ? Math.min(nSurf, h - S * 2) : nSurf;
      if (lo < h) wall(cx, cz, f, lo, h, WALL[t] ?? t, k);
      if (cTop > 0) wall(cx, cz, f, Math.max(lo, h), cTop, leaf[k], k);
    }
    // Water surface (or ice in cold seas).
    if (H[k] < SEA) {
      const col = cols[k], frozen = col.T < -0.6;
      const y = frozen ? SEA + 1 : SEA + 0.875;
      if (frozen) quad(ob, [[cx, y, cz + S], [cx + S, y, cz + S], [cx + S, y, cz], [cx, y, cz]], TEXL[B.ICE * 6 + 2], S, S, 2, 0, WHITE);
      else quad(wb, [[cx, y, cz + S], [cx + S, y, cz + S], [cx + S, y, cz], [cx, y, cz]], TEXL[B.WATER * 6 + 2], S, S, 2, 1 | 8, WHITE);
    }
  }
  return { o: ob.slice(), w: wb.slice(), minY, maxY };
}

const LEAFLIKE = new Set([B.LEAVES, B.BIRCH_LEAVES, B.SPRUCE_LEAVES, B.ACACIA_LEAVES, B.CHERRY_LEAVES, B.JUNGLE_LEAVES, B.DARK_OAK_LEAVES]);
