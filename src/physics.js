// Axis-aligned box collision against the voxel grid, plus voxel raycasting.
import { TARGET, LIQUID, SHAPE, blockSpan } from './blocks.js';

const EPS = 1e-5;

function sweep(world, b, axis, d) {
  if (d === 0) return 0;
  let x0 = b[0], y0 = b[1], z0 = b[2], x1 = b[3], y1 = b[4], z1 = b[5];
  if (axis === 0) { if (d > 0) x1 += d; else x0 += d; }
  else if (axis === 1) { if (d > 0) y1 += d; else y0 += d; }
  else { if (d > 0) z1 += d; else z0 += d; }
  const bx0 = Math.floor(x0 + EPS), bx1 = Math.floor(x1 - EPS);
  const by0 = Math.floor(y0 + EPS) - 1, by1 = Math.floor(y1 - EPS);
  const bz0 = Math.floor(z0 + EPS), bz1 = Math.floor(z1 - EPS);
  for (let by = by0; by <= by1; by++) for (let bz = bz0; bz <= bz1; bz++) for (let bx = bx0; bx <= bx1; bx++) {
    const span = world.solidSpan(bx, by, bz);
    if (!span) continue;
    const lo = [bx, by + span[0], bz], hi = [bx + 1, by + span[1], bz + 1];
    let overlap = true;
    for (let a = 0; a < 3 && overlap; a++) {
      if (a === axis) continue;
      if (hi[a] <= b[a] + EPS || lo[a] >= b[3 + a] - EPS) overlap = false;
    }
    if (!overlap) continue;
    if (d > 0) {
      const lim = lo[axis] - b[3 + axis];
      if (lim >= -EPS && lim < d) d = Math.max(0, lim - EPS);
    } else {
      const lim = hi[axis] - b[axis];
      if (lim <= EPS && lim > d) d = Math.min(0, lim + EPS);
    }
  }
  return d;
}

export function entityBox(e) {
  const hw = e.w / 2;
  return [e.x - hw, e.y, e.z - hw, e.x + hw, e.y + e.h, e.z + hw];
}

function slide(world, b, dx, dy, dz) {
  dy = sweep(world, b, 1, dy);
  b[1] += dy; b[4] += dy;
  dx = sweep(world, b, 0, dx);
  b[0] += dx; b[3] += dx;
  dz = sweep(world, b, 2, dz);
  b[2] += dz; b[5] += dz;
  return [dx, dy, dz];
}

// Moves entity e by (dx,dy,dz) resolving collisions; sets onGround/hit flags.
// With `step`, a grounded entity walks up ledges up to that height (half blocks).
export function moveEntity(world, e, dx, dy, dz, step = 0) {
  const wasGround = e.onGround;
  let [rx, ry, rz] = slide(world, entityBox(e), dx, dy, dz);
  let hitX = Math.abs(rx - dx) > 1e-9, hitZ = Math.abs(rz - dz) > 1e-9;
  let grounded = dy < 0 && ry > dy + 1e-9;
  if (step > 0 && wasGround && (hitX || hitZ) && dy <= 0) {
    const b = entityBox(e);
    const up = sweep(world, b, 1, step);
    b[1] += up; b[4] += up;
    const sx = sweep(world, b, 0, dx); b[0] += sx; b[3] += sx;
    const sz = sweep(world, b, 2, dz); b[2] += sz; b[5] += sz;
    const down = sweep(world, b, 1, -up + Math.min(dy, 0));
    if (sx * sx + sz * sz > rx * rx + rz * rz + 1e-6 && up + down > 0.01) {
      rx = sx; rz = sz; ry = up + down;
      hitX = Math.abs(sx - dx) > 1e-9; hitZ = Math.abs(sz - dz) > 1e-9;
      grounded = true;
    }
  }
  e.x += rx; e.y += ry; e.z += rz;
  e.onGround = grounded;
  e.hitCeil = dy > 0 && ry < dy - 1e-9;
  e.hitX = hitX;
  e.hitZ = hitZ;
  if (e.onGround || e.hitCeil) e.vy = 0;
  if (e.hitX) e.vx = 0;
  if (e.hitZ) e.vz = 0;
}

// True if a solid block lies directly beneath the box (used for sneaking at edges).
export function groundBelow(world, x0, z0, x1, z1, y) {
  const by = Math.floor(y - 0.05);
  for (let bz = Math.floor(z0 + EPS); bz <= Math.floor(z1 - EPS); bz++)
    for (let bx = Math.floor(x0 + EPS); bx <= Math.floor(x1 - EPS); bx++)
      if (world.isSolid(bx, by, bz)) return true;
  return false;
}

export function boxTouches(world, b, pred) {
  for (let by = Math.floor(b[1]); by <= Math.floor(b[4] - EPS); by++)
    for (let bz = Math.floor(b[2]); bz <= Math.floor(b[5] - EPS); bz++)
      for (let bx = Math.floor(b[0]); bx <= Math.floor(b[3] - EPS); bx++)
        if (pred(world.getBlock(bx, by, bz), bx, by, bz)) return true;
  return false;
}

export function raycast(world, ox, oy, oz, dx, dy, dz, maxDist, liquids = false) {
  let x = Math.floor(ox), y = Math.floor(oy), z = Math.floor(oz);
  const sx = dx > 0 ? 1 : -1, sy = dy > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1;
  const tdx = dx !== 0 ? Math.abs(1 / dx) : Infinity;
  const tdy = dy !== 0 ? Math.abs(1 / dy) : Infinity;
  const tdz = dz !== 0 ? Math.abs(1 / dz) : Infinity;
  let tmx = dx > 0 ? (x + 1 - ox) * tdx : dx < 0 ? (ox - x) * tdx : Infinity;
  let tmy = dy > 0 ? (y + 1 - oy) * tdy : dy < 0 ? (oy - y) * tdy : Infinity;
  let tmz = dz > 0 ? (z + 1 - oz) * tdz : dz < 0 ? (oz - z) * tdz : Infinity;
  let nx = 0, ny = 0, nz = 0, t = 0;
  while (t <= maxDist) {
    const id = world.getBlock(x, y, z);
    if (id && SHAPE[id] && TARGET[id]) {
      // Partial blocks (slabs, bedrolls): hit only their real box.
      const [y0, y1] = blockSpan(id, world.getMeta(x, y, z));
      const h = rayBoxNormal(ox, oy, oz, dx, dy, dz, [x, y + y0, z, x + 1, y + y1, z + 1]);
      if (h && h.t <= maxDist) return { x, y, z, nx: h.n[0], ny: h.n[1], nz: h.n[2], id, t: h.t };
    } else if (id && (TARGET[id] || (liquids && LIQUID[id] && world.getMeta(x, y, z) === 0))) return { x, y, z, nx, ny, nz, id, t };
    if (tmx < tmy && tmx < tmz) { x += sx; t = tmx; tmx += tdx; nx = -sx; ny = 0; nz = 0; }
    else if (tmy < tmz) { y += sy; t = tmy; tmy += tdy; nx = 0; ny = -sy; nz = 0; }
    else { z += sz; t = tmz; tmz += tdz; nx = 0; ny = 0; nz = -sz; }
  }
  return null;
}

// Ray vs AABB; returns distance or -1.
export function rayBox(ox, oy, oz, dx, dy, dz, b) {
  let tmin = 0, tmax = Infinity;
  const o = [ox, oy, oz], d = [dx, dy, dz];
  for (let a = 0; a < 3; a++) {
    if (Math.abs(d[a]) < 1e-9) {
      if (o[a] < b[a] || o[a] > b[a + 3]) return -1;
    } else {
      let t1 = (b[a] - o[a]) / d[a], t2 = (b[a + 3] - o[a]) / d[a];
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return -1;
    }
  }
  return tmin;
}

// Ray vs AABB returning the entry distance and the face normal that was hit.
function rayBoxNormal(ox, oy, oz, dx, dy, dz, b) {
  let tmin = -Infinity, tmax = Infinity, axis = 0, sign = 0;
  const o = [ox, oy, oz], d = [dx, dy, dz];
  for (let a = 0; a < 3; a++) {
    if (Math.abs(d[a]) < 1e-9) {
      if (o[a] < b[a] || o[a] > b[a + 3]) return null;
      continue;
    }
    let t1 = (b[a] - o[a]) / d[a], t2 = (b[a + 3] - o[a]) / d[a];
    let s = -1;
    if (t1 > t2) { [t1, t2] = [t2, t1]; s = 1; }
    if (t1 > tmin) { tmin = t1; axis = a; sign = s; }
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  if (tmin < 0) return null;
  const n = [0, 0, 0];
  n[axis] = sign;
  return { t: tmin, n };
}
