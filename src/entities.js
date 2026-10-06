// Dropped items, falling blocks and mobs (original box-model creatures).
import { moveEntity, entityBox, boxTouches } from './physics.js';
import { B, I, LIQUID, REPLACEABLE, itemDef } from './blocks.js';
import { boxMesh } from './mesher.js';
import { LAYERS } from './textures.js';
import { Mat4 } from './math.js';

const rand = Math.random;
const angleDiff = (a, b) => {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
};

export class Entity {
  constructor(x, y, z, w, h) {
    this.x = x; this.y = y; this.z = z;
    this.vx = 0; this.vy = 0; this.vz = 0;
    this.w = w; this.h = h;
    this.onGround = false;
    this.dead = false;
    this.age = 0;
  }
  lightAt(world) {
    const L = world.getLight(Math.floor(this.x), Math.floor(this.y + this.h * 0.5), Math.floor(this.z));
    return [(L >> 4) / 15, (L & 15) / 15];
  }
  liquidAt(world, dy = 0.1) {
    return LIQUID[world.getBlock(Math.floor(this.x), Math.floor(this.y + dy), Math.floor(this.z))];
  }
}

const M = new Mat4();

export class ItemEntity extends Entity {
  constructor(x, y, z, stack, toss) {
    super(x, y, z, 0.25, 0.25);
    this.stack = stack;
    this.pickup = toss ? 1.5 : 0.4;
    this.spin = rand() * 6;
    if (toss) { this.vx = toss[0]; this.vy = toss[1]; this.vz = toss[2]; }
    else { this.vx = (rand() - 0.5) * 3; this.vy = 3 + rand() * 1.5; this.vz = (rand() - 0.5) * 3; }
  }
  update(dt, g) {
    if (this.dead) return;
    this.age += dt;
    this.pickup -= dt;
    this.spin += dt * 1.6;
    if (this.age > 300) { this.dead = true; return; }
    const w = g.world;
    if (this.liquidAt(w)) { this.vy += (1.5 - this.vy) * Math.min(1, 4 * dt); this.vx *= 1 - 2 * dt; this.vz *= 1 - 2 * dt; }
    else this.vy -= 18 * dt;
    if (this.onGround) { const k = Math.max(0, 1 - 9 * dt); this.vx *= k; this.vz *= k; }
    const p = g.player;
    if (p.alive && this.pickup <= 0) {
      const dx = p.x - this.x, dy = p.y + 0.7 - this.y, dz = p.z - this.z;
      const d = Math.hypot(dx, dy, dz);
      if (d < 1.3) {
        const before = this.stack.count;
        const left = p.inv.add(this.stack);
        if (left < before) g.audio.play('pop', { vol: 0.4, pitch: 1 + rand() * 0.6 });
        if (left === 0) { this.dead = true; return; }
        this.stack.count = left;
      } else if (d < 2.6) {
        this.vx += (dx / d) * 30 * dt; this.vy += (dy / d) * 30 * dt; this.vz += (dz / d) * 30 * dt;
      }
    }
    if (this.y < -20) this.dead = true;
    moveEntity(w, this, this.vx * dt, this.vy * dt, this.vz * dt);
  }
  draws(g, cam) {
    const m = g.renderer.itemMesh(this.stack.id);
    const bob = Math.sin(this.age * 2.5) * 0.06 + 0.16;
    M.identity().translate(this.x - cam.x, this.y + bob - cam.y, this.z - cam.z).rotateY(this.spin).scale(m.flat ? 0.4 : 0.26);
    const light = this.lightAt(g.world);
    const out = [{ mesh: m.mesh, model: M.m.slice(), light, noCull: m.flat }];
    if (this.stack.count > 1 && !m.flat) {
      M.identity().translate(this.x - cam.x + 0.07, this.y + bob - cam.y + 0.08, this.z - cam.z + 0.05).rotateY(this.spin + 0.4).scale(0.26);
      out.push({ mesh: m.mesh, model: M.m.slice(), light });
    }
    return out;
  }
}

export class FallingBlock extends Entity {
  constructor(x, y, z, id) {
    super(x + 0.5, y, z + 0.5, 0.98, 0.98);
    this.id = id;
  }
  update(dt, g) {
    this.age += dt;
    this.vy = Math.max(this.vy - 30 * dt, -40);
    moveEntity(g.world, this, 0, this.vy * dt, 0);
    if (this.onGround || this.age > 20 || this.y < 0) {
      const bx = Math.floor(this.x), by = Math.floor(this.y + 0.5), bz = Math.floor(this.z);
      const cur = g.world.getBlock(bx, by, bz);
      if (cur === 0 || REPLACEABLE[cur]) g.world.setBlock(bx, by, bz, this.id);
      else g.dropItem(this.x, this.y + 0.5, this.z, { id: this.id, count: 1 });
      this.dead = true;
    }
  }
  draws(g, cam) {
    const m = g.renderer.itemMesh(this.id);
    M.identity().translate(this.x - cam.x, this.y + 0.49 - cam.y, this.z - cam.z).scale(0.98);
    return [{ mesh: m.mesh, model: M.m.slice(), light: this.lightAt(g.world) }];
  }
}

// ---------- Mob definitions (sizes in model pixels, 16 px = 1 block) ----------
const faceLayers = (all, front, top, back) => [all, all, top || all, all, back || all, front || all];
const quad = (x, y, z, layers) => ({ pivot: [x, y, z], box: [-2, -12, -2, 4, 12, 4], layers });
const legs4 = (dx, dz, y, h, layer) => ['fl', 'fr', 'bl', 'br'].map((n, i) => ({
  name: n, pivot: [(i % 2 ? 1 : -1) * dx, y, (i < 2 ? -1 : 1) * dz], box: [-2, -h, -2, 4, h, 4], layers: layer,
}));
const humanoid = (head, body, arm, leg) => [
  { name: 'head', pivot: [0, 24, 0], box: [-4, 0, -4, 8, 8, 8], layers: head },
  { name: 'body', pivot: [0, 12, 0], box: [-4, 0, -2, 8, 12, 4], layers: body },
  { name: 'ar', pivot: [-6, 22, 0], box: [-2, -10, -2, 4, 12, 4], layers: arm },
  { name: 'al', pivot: [6, 22, 0], box: [-2, -10, -2, 4, 12, 4], layers: arm },
  { name: 'fl', ...quad(-2, 12, 0, leg) },
  { name: 'fr', ...quad(2, 12, 0, leg) },
];

export const MOB_TYPES = {
  pig: {
    name: 'Pig', w: 0.85, h: 0.9, health: 10, speed: 1.4, scale: 1 / 16,
    parts: () => [
      { name: 'body', pivot: [0, 6, 0], box: [-5, 0, -8, 10, 8, 16], layers: L('pig_skin') },
      { name: 'head', pivot: [0, 10, -8], box: [-4, -4, -8, 8, 8, 8], layers: faceLayers(L('pig_skin'), L('pig_face')) },
      ...legs4(3, 5, 6, 6, L('pig_skin')),
    ],
    drops: () => [[I.RAW_PORK, 1 + Math.floor(rand() * 3)]],
  },
  cow: {
    name: 'Cow', w: 0.9, h: 1.4, health: 10, speed: 1.2, scale: 1 / 16,
    parts: () => [
      { name: 'body', pivot: [0, 12, 0], box: [-6, 0, -9, 12, 10, 18], layers: L('cow_skin') },
      { name: 'head', pivot: [0, 19, -9], box: [-4, -4, -6, 8, 8, 6], layers: faceLayers(L('cow_skin'), L('cow_face')) },
      ...legs4(4, 6, 12, 12, L('cow_skin')),
    ],
    drops: () => [[I.RAW_BEEF, 1 + Math.floor(rand() * 3)]],
  },
  sheep: {
    name: 'Sheep', w: 0.9, h: 1.3, health: 8, speed: 1.3, scale: 1 / 16,
    parts: () => [
      { name: 'body', pivot: [0, 12, 0], box: [-5, 0, -8, 10, 9, 16], layers: L('sheep_wool') },
      { name: 'head', pivot: [0, 19, -8], box: [-3, -3, -6, 6, 6, 7], layers: faceLayers(L('sheep_skin'), L('sheep_face'), L('sheep_wool'), L('sheep_wool')) },
      ...legs4(3, 5, 12, 12, L('sheep_skin')),
    ],
    drops: () => [[B.WOOL_WHITE, 1 + Math.floor(rand() * 2)], [I.RAW_MUTTON, 1 + Math.floor(rand() * 2)]],
  },
  ghoul: {
    name: 'Ghoul', w: 0.6, h: 1.85, health: 20, speed: 2.4, scale: 0.058, hostile: true, damage: 3,
    parts: () => humanoid(faceLayers(L('ghoul_skin'), L('ghoul_face')), L('ghoul_shirt'), L('ghoul_skin'), L('ghoul_pants')),
    drops: () => (rand() < 0.8 ? [[I.ROTTEN_FLESH, 1 + Math.floor(rand() * 2)]] : []),
  },
  player: {
    name: 'You', w: 0.6, h: 1.8, scale: 0.058,
    parts: () => humanoid(faceLayers(L('player_skin'), L('player_face'), L('player_hair'), L('player_hair')), L('player_jacket'), L('player_jacket'), L('player_pants')),
  },
};
function L(name) { return LAYERS[name]; }

const partMeshes = new Map();
export function mobParts(renderer, type) {
  let p = partMeshes.get(type);
  if (p) return p;
  p = MOB_TYPES[type].parts().map((part) => {
    const [x, y, z, w, h, d] = part.box;
    return { ...part, mesh: renderer.upload(boxMesh(x, y, z, w, h, d, part.layers)) };
  });
  partMeshes.set(type, p);
  return p;
}

// Shared pose renderer for mobs and the third-person player.
export function poseDraws(g, cam, type, e, pose) {
  const def = MOB_TYPES[type];
  const parts = mobParts(g.renderer, type);
  const light = e.lightAt(g.world);
  const out = [];
  for (const part of parts) {
    M.identity().translate(e.x - cam.x, e.y - cam.y, e.z - cam.z).rotateY(pose.yaw);
    if (pose.tilt) M.rotateZ(pose.tilt);
    M.scale(def.scale);
    M.translate(part.pivot[0], part.pivot[1], part.pivot[2]);
    const sw = Math.sin(pose.phase) * 0.7 * pose.amount;
    switch (part.name) {
      case 'head': M.rotateY(pose.headYaw || 0).rotateX(pose.headPitch || 0); break;
      case 'fl': case 'br': M.rotateX(sw); break;
      case 'fr': case 'bl': M.rotateX(-sw); break;
      case 'ar': M.rotateX(pose.armsUp ? -1.45 + sw * 0.15 : -sw + (pose.swing || 0)); break;
      case 'al': M.rotateX(pose.armsUp ? -1.45 - sw * 0.15 : sw); break;
    }
    out.push({ mesh: part.mesh, model: M.m.slice(), light, color: pose.color });
  }
  return out;
}

export class Mob extends Entity {
  constructor(type, x, y, z) {
    const d = MOB_TYPES[type];
    super(x, y, z, d.w, d.h);
    this.type = type;
    this.def = d;
    this.health = d.health;
    this.yaw = rand() * Math.PI * 2;
    this.targetYaw = this.yaw;
    this.headYaw = 0;
    this.timer = rand() * 3;
    this.wander = 0;
    this.hurt = 0;
    this.flee = 0;
    this.phase = 0;
    this.amount = 0;
    this.attackCd = 0;
    this.deathTime = 0;
    this.burnT = 0;
    this.lavaT = 0;
    this.soundT = 4 + rand() * 12;
  }

  update(dt, g) {
    const w = g.world, p = g.player;
    this.age += dt;
    if (this.health <= 0) {
      this.deathTime += dt;
      this.vy -= 28 * dt;
      moveEntity(w, this, 0, this.vy * dt, 0);
      if (this.deathTime > 0.9) { this.dead = true; g.onMobDeath(this); }
      return;
    }
    this.hurt = Math.max(0, this.hurt - dt);
    this.attackCd -= dt;
    this.timer -= dt;
    let moving = false, speed = this.def.speed;
    const dxp = p.x - this.x, dzp = p.z - this.z;
    const dist = Math.hypot(dxp, p.y - this.y, dzp);
    if (this.def.hostile && p.alive && p.mode === 'survival' && dist < 20) {
      this.targetYaw = Math.atan2(-dxp, -dzp);
      moving = dist > 0.8;
      if (dist < 1.5 && Math.abs(p.y - this.y) < 1.6 && this.attackCd <= 0) {
        g.damagePlayer(this.def.damage, this);
        this.attackCd = 1;
      }
    } else if (this.flee > 0) {
      this.flee -= dt;
      if (this.timer <= 0) { this.targetYaw = Math.atan2(dxp, dzp) + (rand() - 0.5) * 1.5; this.timer = 0.8; }
      moving = true;
      speed *= 1.9;
    } else {
      if (this.timer <= 0) {
        this.timer = 3 + rand() * 6;
        if (rand() < 0.55) { this.targetYaw = rand() * Math.PI * 2; this.wander = 1 + rand() * 3; } else this.wander = 0;
      }
      if (this.wander > 0) { this.wander -= dt; moving = true; }
    }
    this.yaw += angleDiff(this.targetYaw, this.yaw) * Math.min(1, 5 * dt);
    let mx = 0, mz = 0;
    if (moving) {
      mx = -Math.sin(this.yaw) * speed;
      mz = -Math.cos(this.yaw) * speed;
      // Passive mobs avoid walking off tall drops.
      if (!this.def.hostile && this.onGround) {
        const ax = Math.floor(this.x - Math.sin(this.yaw) * 0.8), az = Math.floor(this.z - Math.cos(this.yaw) * 0.8);
        const by = Math.floor(this.y);
        if (!w.isSolid(ax, by - 1, az) && !w.isSolid(ax, by - 2, az) && !w.isSolid(ax, by, az)) {
          mx = mz = 0;
          this.targetYaw += Math.PI * (0.5 + rand());
        }
      }
    }
    const liquid = this.liquidAt(w, 0.4);
    const k = Math.min(1, (this.onGround ? 10 : liquid ? 4 : 2) * dt);
    this.vx += (mx * (liquid ? 0.5 : 1) - this.vx) * k;
    this.vz += (mz * (liquid ? 0.5 : 1) - this.vz) * k;
    if (liquid) this.vy = Math.min(this.vy + 22 * dt, 2.2);
    else this.vy = Math.max(this.vy - 28 * dt, -50);
    if (moving && (this.hitX || this.hitZ) && this.onGround) this.vy = 8.6;
    moveEntity(w, this, this.vx * dt, this.vy * dt, this.vz * dt);
    const hs = Math.hypot(this.vx, this.vz);
    this.phase += hs * dt * 4.5;
    this.amount += (Math.min(1, hs / 1.5) - this.amount) * Math.min(1, 10 * dt);
    this.headYaw = dist < 7 ? Math.max(-0.8, Math.min(0.8, angleDiff(Math.atan2(-dxp, -dzp), this.yaw))) : this.headYaw * 0.95;

    if (liquid === 2) { this.lavaT += dt; if (this.lavaT > 0.5) { this.lavaT = 0; this.damage(4, null, g); } }
    if (this.def.hostile && g.daylight > 0.75 && !liquid) {
      const L = w.getLight(Math.floor(this.x), Math.floor(this.y + 1.6), Math.floor(this.z));
      if (L >> 4 === 15) { this.burnT += dt; if (this.burnT > 1) { this.burnT = 0; this.damage(2, null, g); g.spawnPoof(this.x, this.y + 1, this.z, 3, [60, 60, 60]); } }
    }
    this.soundT -= dt;
    if (this.soundT < 0) { this.soundT = 6 + rand() * 14; if (dist < 20) g.audio.mob(this.type, this.x - p.x, this.y - p.y, this.z - p.z, p.yaw); }
    if (this.y < -30) this.dead = true;
  }

  damage(n, src, g) {
    if (this.health <= 0 || this.hurt > 0.25) return false;
    this.health -= n;
    this.hurt = 0.45;
    if (!this.def.hostile) { this.flee = 5; this.timer = 0; }
    if (src) {
      const dx = this.x - src.x, dz = this.z - src.z, d = Math.hypot(dx, dz) || 1;
      this.vx = (dx / d) * 7; this.vz = (dz / d) * 7; this.vy = 5.5;
    }
    g.audio.mob(this.type, 0, 0, 0, 0, true);
    return true;
  }

  draws(g, cam) {
    return poseDraws(g, cam, this.type, this, {
      yaw: this.yaw, headYaw: this.headYaw, phase: this.phase, amount: this.amount,
      tilt: this.health <= 0 ? Math.min(1, this.deathTime * 2.4) * (Math.PI / 2) : 0,
      armsUp: this.type === 'ghoul',
      color: this.hurt > 0 || this.health <= 0 ? [1, 0.45, 0.45, 1] : null,
    });
  }

  box() { return entityBox(this); }
}

export { boxTouches };
