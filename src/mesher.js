// Builds chunk geometry with smooth lighting and ambient occlusion.
// Vertex layout: f32 [x,y,z,u,v,layer] + u8 [sky,block,bright,flags,r,g,b,0].
import { B, OPAQUE, RENDER, TINT, CULLSAME, LIQUID, LEAF, TEXL, FRONTL, BLOCKS, R } from './blocks.js';
import { CH } from './consts.js';
import { hash2 } from './noise.js';
import { BIRCH_TINT, SPRUCE_TINT } from './textures.js';

const PX = 18, OX = 1, OZ = PX, OY = PX * PX;
const PSIZE = PX * PX * (CH + 2);
const pb = new Uint8Array(PSIZE), pl = new Uint8Array(PSIZE), pm = new Uint8Array(PSIZE);
const P = (x, y, z) => (y + 1) * OY + (z + 1) * OZ + (x + 1);
for (let z = -1; z <= 16; z++) for (let x = -1; x <= 16; x++) {
  pb[P(x, -1, z)] = B.BEDROCK;
  pl[P(x, CH, z)] = 0xf0;
}
const ptint = new Uint8Array(18 * 18 * 3);

export class MeshBuf {
  constructor(n = 16384) {
    this.f = new Float32Array(n * 6);
    this.b = new Uint8Array(n * 8);
    this.n = 0;
  }
  reset() { this.n = 0; }
  ensure(extra) {
    if ((this.n + extra) * 6 <= this.f.length) return;
    const cap = Math.max(this.f.length / 6 * 2, this.n + extra);
    const f = new Float32Array(cap * 6); f.set(this.f); this.f = f;
    const b = new Uint8Array(cap * 8); b.set(this.b); this.b = b;
  }
  v(x, y, z, u, v, layer, sky, blk, bright, flags, r, g, bl) {
    const i = this.n * 6, j = this.n * 8, f = this.f, b = this.b;
    f[i] = x; f[i + 1] = y; f[i + 2] = z; f[i + 3] = u; f[i + 4] = v; f[i + 5] = layer;
    b[j] = sky; b[j + 1] = blk; b[j + 2] = bright; b[j + 3] = flags; b[j + 4] = r; b[j + 5] = g; b[j + 6] = bl; b[j + 7] = 0;
    this.n++;
  }
  slice() {
    return { f: this.f.slice(0, this.n * 6), b: this.b.slice(0, this.n * 8), quads: this.n / 4 };
  }
}

// Face table: normal, bottom-left corner, right and up vectors.
const FACES = [
  { n: [1, 0, 0], bl: [1, 0, 1], r: [0, 0, -1], u: [0, 1, 0] },
  { n: [-1, 0, 0], bl: [0, 0, 0], r: [0, 0, 1], u: [0, 1, 0] },
  { n: [0, 1, 0], bl: [0, 1, 1], r: [1, 0, 0], u: [0, 0, -1] },
  { n: [0, -1, 0], bl: [0, 0, 0], r: [1, 0, 0], u: [0, 0, 1] },
  { n: [0, 0, 1], bl: [0, 0, 1], r: [1, 0, 0], u: [0, 1, 0] },
  { n: [0, 0, -1], bl: [1, 0, 0], r: [-1, 0, 0], u: [0, 1, 0] },
];
export const SHADE = [0.62, 0.62, 1.0, 0.5, 0.82, 0.82];
const AO_F = [0.42, 0.62, 0.8, 1.0];
const CORNER = [[0, 0], [1, 0], [1, 1], [0, 1]];
const UVS = [[0, 1], [1, 1], [1, 0], [0, 0]];
const off = (v) => v[0] * OX + v[1] * OY + v[2] * OZ;
const NOFF = FACES.map((f) => off(f.n));
const S1 = [], S2 = [];
FACES.forEach((f, fi) => CORNER.forEach(([cr, cu], k) => {
  S1[fi * 4 + k] = (cr ? 1 : -1) * off(f.r);
  S2[fi * 4 + k] = (cu ? 1 : -1) * off(f.u);
}));
// Corner positions per face (12 floats).
const CPOS = FACES.map((f) => CORNER.map(([cr, cu]) => [
  f.bl[0] + f.r[0] * cr + f.u[0] * cu, f.bl[1] + f.r[1] * cr + f.u[1] * cu, f.bl[2] + f.r[2] * cr + f.u[2] * cu,
]));

const opaqueBuf = new MeshBuf(65536), waterBuf = new MeshBuf(16384);
const ao = [0, 0, 0, 0], sk = [0, 0, 0, 0], bk = [0, 0, 0, 0];

function fill(world, chunk) {
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
    const c = world.getChunk(chunk.cx + dx, chunk.cz + dz);
    const x0 = dx < 0 ? 15 : 0, x1 = dx > 0 ? 0 : 15, z0 = dz < 0 ? 15 : 0, z1 = dz > 0 ? 0 : 15;
    for (let lz = z0; lz <= z1; lz++) for (let lx = x0; lx <= x1; lx++) {
      const px = dx * 16 + lx, pz = dz * 16 + lz;
      let d = P(px, 0, pz), s = (lz << 4) | lx;
      if (c) {
        const cb = c.blocks, cl = c.light, cm = c.meta;
        for (let y = 0; y < CH; y++, d += OY, s += 256) { pb[d] = cb[s]; pl[d] = cl[s]; pm[d] = cm[s]; }
        const ti = ((pz + 1) * 18 + px + 1) * 3, si = ((lz << 4) | lx) * 3;
        ptint[ti] = c.tint[si]; ptint[ti + 1] = c.tint[si + 1]; ptint[ti + 2] = c.tint[si + 2];
      } else {
        for (let y = 0; y < CH; y++, d += OY) { pb[d] = 0; pl[d] = 0xf0; pm[d] = 0; }
      }
    }
  }
}

function liquidHeight(p, kind) {
  if (LIQUID[pb[p]] !== kind) return -1;
  if (LIQUID[pb[p + OY]] === kind) return 1;
  const m = pm[p];
  return m === 0 || m === 8 ? 0.875 : (8 - m) / 9;
}
function cornerHeight(p, kind, cx, cz) {
  // cells sharing the corner at (cx,cz) in {0,1}
  const ox = cx ? 0 : -OX, oz = cz ? 0 : -OZ;
  const cells = [p + ox + oz, p + ox + oz + OX, p + ox + oz + OZ, p + ox + oz + OX + OZ];
  let h = 0;
  for (const c of cells) {
    const v = liquidHeight(c, kind);
    if (v === 1) return 1;
    if (v > h) h = v;
  }
  return h;
}

export function buildChunkMesh(world, chunk, opts = {}) {
  fill(world, chunk);
  const fancy = opts.fancyLeaves !== false;
  const ob = opaqueBuf, wb = waterBuf;
  ob.reset(); wb.reset();
  let minY = CH, maxY = 0;
  for (let y = 0; y < CH; y++) {
    for (let z = 0; z < 16; z++) {
      let p = P(0, y, z);
      for (let x = 0; x < 16; x++, p++) {
        const b = pb[p];
        if (!b) continue;
        const rt = RENDER[b];
        const before = ob.n + wb.n;
        if (rt === R.CUBE || rt === R.CUTOUT) cubeFaces(ob, b, p, x, y, z, rt, fancy);
        else if (rt === R.CROSS) cross(ob, b, p, x, y, z);
        else if (rt === R.TORCH) torch(ob, b, p, x, y, z);
        else if (rt === R.LIQUID) liquid(LIQUID[b] === 1 ? wb : ob, b, p, x, y, z);
        if (ob.n + wb.n !== before) { if (y < minY) minY = y; if (y > maxY) maxY = y; }
      }
    }
  }
  return { o: ob.slice(), w: wb.slice(), minY, maxY: maxY + 1 };
}

function tintOf(b, f, x, z) {
  const t = TINT[b];
  if (!t || (t === 1 && f !== 2)) return [255, 255, 255];
  if (t === 4) return BIRCH_TINT;
  if (t === 5) return SPRUCE_TINT;
  const i = ((z + 1) * 18 + x + 1) * 3;
  if (t === 3) return [ptint[i] * 0.85, ptint[i + 1] * 0.88, ptint[i + 2] * 0.8];
  return [ptint[i], ptint[i + 1], ptint[i + 2]];
}

function cubeFaces(buf, b, p, x, y, z, rt, fancy) {
  const isLeaf = LEAF[b];
  const front = BLOCKS[b].front;
  for (let f = 0; f < 6; f++) {
    const np = p + NOFF[f];
    const nb = pb[np];
    if (OPAQUE[nb]) continue;
    if (nb === b && CULLSAME[b]) continue;
    if (isLeaf && !fancy && LEAF[nb]) continue;
    const layer = front && f === (pm[p] || 0) ? FRONTL[b] : TEXL[b * 6 + f];
    const [tr, tg, tb] = tintOf(b, f, x, z);
    const L0 = pl[np];
    for (let k = 0; k < 4; k++) {
      const s1 = np + S1[f * 4 + k], s2 = np + S2[f * 4 + k];
      const o1 = OPAQUE[pb[s1]], o2 = OPAQUE[pb[s2]];
      let ls = L0 >> 4, lb = L0 & 15, n = 1;
      if (!o1) { ls += pl[s1] >> 4; lb += pl[s1] & 15; n++; }
      if (!o2) { ls += pl[s2] >> 4; lb += pl[s2] & 15; n++; }
      let oc = 1;
      if (!(o1 && o2)) {
        const c = s1 + S2[f * 4 + k];
        oc = OPAQUE[pb[c]];
        if (!oc) { ls += pl[c] >> 4; lb += pl[c] & 15; n++; }
      }
      ao[k] = o1 && o2 ? 0 : 3 - (o1 + o2 + oc);
      sk[k] = (ls * 17) / n;
      bk[k] = (lb * 17) / n;
    }
    buf.ensure(4);
    const flip = ao[1] + ao[3] > ao[0] + ao[2];
    const cp = CPOS[f], sh = SHADE[f] * 255;
    for (let j = 0; j < 4; j++) {
      const k = flip ? (j + 1) & 3 : j;
      const c = cp[k];
      buf.v(x + c[0], y + c[1], z + c[2], UVS[k][0], UVS[k][1], layer, sk[k], bk[k], sh * AO_F[ao[k]], 0, tr, tg, tb);
    }
  }
}

function cross(buf, b, p, x, y, z) {
  const L = pl[p], s = (L >> 4) * 17, bl = (L & 15) * 17;
  const layer = TEXL[b * 6];
  const [tr, tg, tb] = tintOf(b, 0, x, z);
  const wx = x, wz = z;
  const ox = (hash2(wx * 3 + y, wz, 17) - 0.5) * 0.3, oz = (hash2(wx, wz * 5 + y, 31) - 0.5) * 0.3;
  const a = 0.15, c = 0.85, br = 235;
  const sway = b === B.DEAD_BUSH ? 0 : 4;
  const planes = [[a, a, c, c], [c, a, a, c]];
  buf.ensure(16);
  for (const [x0, z0, x1, z1] of planes) {
    const X0 = x + x0 + ox, Z0 = z + z0 + oz, X1 = x + x1 + ox, Z1 = z + z1 + oz;
    buf.v(X0, y, Z0, 0, 1, layer, s, bl, br, 0, tr, tg, tb);
    buf.v(X1, y, Z1, 1, 1, layer, s, bl, br, 0, tr, tg, tb);
    buf.v(X1, y + 1, Z1, 1, 0, layer, s, bl, br, sway, tr, tg, tb);
    buf.v(X0, y + 1, Z0, 0, 0, layer, s, bl, br, sway, tr, tg, tb);
    buf.v(X1, y, Z1, 1, 1, layer, s, bl, br, 0, tr, tg, tb);
    buf.v(X0, y, Z0, 0, 1, layer, s, bl, br, 0, tr, tg, tb);
    buf.v(X0, y + 1, Z0, 0, 0, layer, s, bl, br, sway, tr, tg, tb);
    buf.v(X1, y + 1, Z1, 1, 0, layer, s, bl, br, sway, tr, tg, tb);
  }
}

// Torch: a 2x10x2 pixel stick; wall torches lean away from their wall.
const TORCH_WALL = [null, [-1, 0], [1, 0], [0, -1], [0, 1]];
function torch(buf, b, p, x, y, z) {
  const L = pl[p], s = (L >> 4) * 17, bl = (L & 15) * 17;
  const layer = TEXL[b * 6];
  const meta = pm[p];
  const w = TORCH_WALL[meta] || null;
  const x0 = 7 / 16, x1 = 9 / 16, y1 = 10 / 16;
  buf.ensure(24);
  for (let f = 0; f < 6; f++) {
    const cp = CPOS[f];
    for (let k = 0; k < 4; k++) {
      const c = cp[k];
      let lx = c[0] ? x1 : x0, ly = c[1] ? y1 : 0, lz = c[2] ? x1 : x0;
      let u, v;
      if (f === 2) { u = c[0] ? x1 : x0; v = c[2] ? 8 / 16 : 6 / 16; }
      else if (f === 3) { u = c[0] ? x1 : x0; v = c[2] ? 16 / 16 : 14 / 16; }
      else { u = UVS[k][0] ? x1 : x0; v = UVS[k][1] ? 1 : 6 / 16; }
      if (w) {
        lx += w[0] * 0.36 - w[0] * ly * 0.45;
        lz += w[1] * 0.36 - w[1] * ly * 0.45;
        ly += 0.22;
      }
      buf.v(x + lx, y + ly, z + lz, u, v, layer, s, bl, SHADE[f] * 255, 0, 255, 255, 255);
    }
  }
}

function liquid(buf, b, p, x, y, z) {
  const kind = LIQUID[b];
  const layer = TEXL[b * 6];
  const flags = kind === 1 ? 1 : 2;
  const h00 = cornerHeight(p, kind, 0, 0), h10 = cornerHeight(p, kind, 1, 0);
  const h01 = cornerHeight(p, kind, 0, 1), h11 = cornerHeight(p, kind, 1, 1);
  const H = (cx, cz) => (cx ? (cz ? h11 : h10) : (cz ? h01 : h00));
  for (let f = 0; f < 6; f++) {
    const np = p + NOFF[f], nb = pb[np];
    if (LIQUID[nb] === kind) continue;
    if (OPAQUE[nb]) continue;
    if (f === 2 && h00 === 1 && h10 === 1 && h01 === 1 && h11 === 1 && LIQUID[pb[p + OY]] === kind) continue;
    const L = f === 2 ? pl[p + OY] > pl[p] ? pl[p + OY] : pl[p] : pl[np];
    const s = (L >> 4) * 17, bl = (L & 15) * 17, sh = SHADE[f] * 255;
    const cp = CPOS[f];
    buf.ensure(4);
    for (let k = 0; k < 4; k++) {
      const c = cp[k];
      let cy = c[1];
      if (c[1] === 1) cy = H(c[0], c[2]);
      let v = UVS[k][1];
      if (f !== 2 && f !== 3 && c[1] === 1) v = 1 - cy;
      buf.v(x + c[0], y + cy, z + c[2], UVS[k][0], v, layer, s, bl, sh, flags, 255, 255, 255);
    }
  }
}

// Small standalone meshes (held items, dropped items, falling blocks).
export function blockItemMesh(id, defaultTint) {
  const d = BLOCKS[id];
  const buf = new MeshBuf(64);
  if (d.render === R.CUBE || d.render === R.CUTOUT) {
    for (let f = 0; f < 6; f++) {
      const layer = d.front && f === 4 ? FRONTL[id] : TEXL[id * 6 + f];
      const tint = TINT[id] === 4 ? BIRCH_TINT : TINT[id] === 5 ? SPRUCE_TINT : (TINT[id] && (TINT[id] !== 1 || f === 2)) ? defaultTint : [255, 255, 255];
      const cp = CPOS[f];
      for (let k = 0; k < 4; k++) {
        const c = cp[k];
        buf.v(c[0] - 0.5, c[1] - 0.5, c[2] - 0.5, UVS[k][0], UVS[k][1], layer, 255, 0, SHADE[f] * 255, 0, tint[0], tint[1], tint[2]);
      }
    }
    return buf.slice();
  }
  return null;
}

// Extruded sprite: front/back quads plus 1px-thick edges for each opaque pixel.
export function spriteMesh(layer, alphaAt, tint = [255, 255, 255]) {
  const buf = new MeshBuf(2048);
  const t = 1 / 32;
  const quad = (pts, uvs, sh) => {
    buf.ensure(4);
    for (let k = 0; k < 4; k++) buf.v(pts[k][0], pts[k][1], pts[k][2], uvs[k][0], uvs[k][1], layer, 255, 0, sh, 0, tint[0], tint[1], tint[2]);
  };
  quad([[-0.5, -0.5, t], [0.5, -0.5, t], [0.5, 0.5, t], [-0.5, 0.5, t]], [[0, 1], [1, 1], [1, 0], [0, 0]], 255);
  quad([[0.5, -0.5, -t], [-0.5, -0.5, -t], [-0.5, 0.5, -t], [0.5, 0.5, -t]], [[1, 1], [0, 1], [0, 0], [1, 0]], 200);
  const solid = (x, y) => x >= 0 && y >= 0 && x < 16 && y < 16 && alphaAt(x, y) > 127;
  for (let py = 0; py < 16; py++) for (let px = 0; px < 16; px++) {
    if (!solid(px, py)) continue;
    const x0 = px / 16 - 0.5, x1 = (px + 1) / 16 - 0.5, y0 = 0.5 - (py + 1) / 16, y1 = 0.5 - py / 16;
    const u0 = (px + 0.25) / 16, u1 = (px + 0.75) / 16, v0 = (py + 0.25) / 16, v1 = (py + 0.75) / 16;
    const uv = [[u0, v1], [u1, v1], [u1, v0], [u0, v0]];
    if (!solid(px - 1, py)) quad([[x0, y0, -t], [x0, y0, t], [x0, y1, t], [x0, y1, -t]], uv, 160);
    if (!solid(px + 1, py)) quad([[x1, y0, t], [x1, y0, -t], [x1, y1, -t], [x1, y1, t]], uv, 160);
    if (!solid(px, py - 1)) quad([[x0, y1, t], [x1, y1, t], [x1, y1, -t], [x0, y1, -t]], uv, 230);
    if (!solid(px, py + 1)) quad([[x0, y0, -t], [x1, y0, -t], [x1, y0, t], [x0, y0, t]], uv, 130);
  }
  return buf.slice();
}

// Box model part for mobs: size and offset in pixels, per-face layers.
export function boxMesh(x, y, z, w, h, d, layers, scaleUV = true) {
  const buf = new MeshBuf(24);
  const size = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) {
    const cp = CPOS[f];
    const [su, sv] = scaleUV ? size[f].map((s) => s / 16) : [1, 1];
    const layer = Array.isArray(layers) ? layers[f] : layers;
    for (let k = 0; k < 4; k++) {
      const c = cp[k];
      buf.v(x + c[0] * w, y + c[1] * h, z + c[2] * d, UVS[k][0] * su, UVS[k][1] * sv, layer, 255, 0, SHADE[f] * 255, 0, 255, 255, 255);
    }
  }
  return buf.slice();
}
