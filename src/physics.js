// Axis-aligned box collision against the voxel grid, plus voxel raycasting.
import { TARGET, LIQUID } from './blocks.js';

const EPS = 1e-5;

function sweep(world, b, axis, d) {
  if (d === 0) return 0;
  let x0 = b[0], y0 = b[1], z0 = b[2], x1 = b[3], y1 = b[4], z1 = b[5];
  if (axis === 0) { if (d > 0) x1 += d; else x0 += d; }
  else if (axis === 1) { if (d > 0) y1 += d; else y0 += d; }
  else { if (d > 0) z1 += d; else z0 += d; }
  const bx0 = Math.floor(x0 + EPS), bx1 = Math.floor(x1 - EPS);
  const by0 = Math.floor(y0 + EPS), by1 = Math.floor(y1 - EPS);
  const bz0 = Math.floor(z0 + EPS), bz1 = Math.floor(z1 - EPS);
  for (let by = by0; by <= by1; by++) for (let bz = bz0; bz <= bz1; bz++) for (let bx = bx0; bx <= bx1; bx++) {
    if (!world.isSolid(bx, by, bz)) continue;
    const lo = axis === 0 ? bx : axis === 1 ? by : bz;
    if (d > 0) {
      const lim = lo - b[3 + axis];
      if (lim >= -EPS && lim < d) d = Math.max(0, lim - EPS);
    } else {
      const lim = lo + 1 - b[axis];
      if (lim <= EPS && lim > d) d = Math.min(0, lim + EPS);
    }
  }
  return d;
}

export function entityBox(e) {
  const hw = e.w / 2;
  return [e.x - hw, e.y, e.z - hw, e.x + hw, e.y + e.h, e.z + hw];
}

// Moves entity e by (dx,dy,dz) resolving collisions; sets onGround/hit flags.
export function moveEntity(world, e, dx, dy, dz) {
  const b = entityBox(e);
  const ody = dy, odx = dx, odz = dz;
  dy = sweep(world, b, 1, dy);
  b[1] += dy; b[4] += dy;
  dx = sweep(world, b, 0, dx);
  b[0] += dx; b[3] += dx;
  dz = sweep(world, b, 2, dz);
  b[2] += dz; b[5] += dz;
  e.x += dx; e.y += dy; e.z += dz;
  e.onGround = ody < 0 && dy > ody + 1e-9;
  e.hitCeil = ody > 0 && dy < ody - 1e-9;
  e.hitX = Math.abs(dx - odx) > 1e-9;
  e.hitZ = Math.abs(dz - odz) > 1e-9;
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
    if (id && (TARGET[id] || (liquids && LIQUID[id] && world.getMeta(x, y, z) === 0))) return { x, y, z, nx, ny, nz, id, t };
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
