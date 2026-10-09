// Dropped items, falling blocks and mobs (original box-model creatures).
import { moveEntity, entityBox, boxTouches } from './physics.js';
import { B, I, BLOCKS, LIQUID, REPLACEABLE, itemDef } from './blocks.js';
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

// Arrows fly ballistically, damage what they hit and stick in blocks (player can pick them up).
export class Arrow extends Entity {
  constructor(x, y, z, vx, vy, vz, owner, dmg) {
    super(x, y, z, 0.15, 0.15);
    this.vx = vx; this.vy = vy; this.vz = vz;
    this.owner = owner;
    this.dmg = dmg;
    this.stuck = false;
  }
  update(dt, g) {
    if (this.dead) return;
    this.age += dt;
    if (this.age > (this.stuck ? 40 : 10)) { this.dead = true; return; }
    const p = g.player;
    if (this.stuck) {
      if (p.alive && Math.hypot(p.x - this.x, p.y + 0.8 - this.y, p.z - this.z) < 1.2 && this.owner === p && p.inv.add({ id: I.ARROW, count: 1 }) === 0) { this.dead = true; g.audio.play('pop', { vol: 0.3 }); }
      return;
    }
    this.vy -= 18 * dt;
    const steps = 4;
    for (let k = 0; k < steps; k++) {
      this.x += this.vx * dt / steps; this.y += this.vy * dt / steps; this.z += this.vz * dt / steps;
      if (g.world.isSolid(Math.floor(this.x), Math.floor(this.y), Math.floor(this.z))) {
        this.stuck = true; this.age = 0; g.audio.block('wood', 'hit');
        return;
      }
      const targets = this.owner === p ? g.entities : [p];
      for (const t of targets) {
        if (t === this || t === this.owner || t.dead || !(t.health > 0)) continue;
        if (t !== p && !(t instanceof Mob)) continue;
        const hw = t.w / 2 + 0.1;
        if (Math.abs(t.x - this.x) < hw && Math.abs(t.z - this.z) < hw && this.y > t.y && this.y < t.y + t.h) {
          if (t === p) g.damagePlayer(this.dmg, null, 'was shot by a Bone Archer');
          else t.damage(this.dmg, this, g);
          this.dead = true;
          return;
        }
      }
    }
  }
  draws(g, cam) {
    const m = g.renderer.itemMesh(I.ARROW);
    const yaw = Math.atan2(this.vx, this.vz), pitch = Math.atan2(this.vy, Math.hypot(this.vx, this.vz));
    M.identity().translate(this.x - cam.x, this.y - cam.y, this.z - cam.z).rotateY(yaw - Math.PI / 2).rotateZ(this.stuck ? 0 : pitch).rotateZ(-Math.PI / 4).scale(0.55);
    return [{ mesh: m.mesh, model: M.m.slice(), light: this.lightAt(g.world), noCull: true }];
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

// ---------- Models (sizes in model pixels, 16 px = 1 block) ----------
// Each part has a pivot (in its parent's space) and a box relative to that pivot.
// Face order matches boxMesh: [right(+x), left(-x), top, bottom, back(+z), front(-z)].
// Models face -Z, so a character's right side is +X.
function L(name) { return LAYERS[name]; }
const F = (right, left, top, bottom, back, front) => [right, left, top, bottom, back, front];
const all = (n) => F(n, n, n, n, n, n);

function humanoid(p) {
  return [
    { name: 'body', pivot: [0, 12, 0], box: [-4, 0, -2, 8, 12, 4], faces: F(p.bodyR, p.bodyL, p.bodyTop, p.bodyBottom, p.bodyBack, p.bodyFront) },
    { name: 'head', parent: 'body', pivot: [0, 12, 0], box: [-4, 0, -4, 8, 8, 8], faces: F(p.headR, p.headL, p.headTop, p.headBottom, p.headBack, p.headFront) },
    { name: 'armR', parent: 'body', pivot: [6, 10, 0], box: [-2, -10, -2, 4, 12, 4], faces: F(p.armOut, p.armIn, p.armTop, p.armBottom, p.armIn, p.armIn) },
    { name: 'armL', parent: 'body', pivot: [-6, 10, 0], box: [-2, -10, -2, 4, 12, 4], faces: F(p.armIn, p.armOut, p.armTop, p.armBottom, p.armIn, p.armIn) },
    { name: 'legR', pivot: [2, 12, 0], box: [-2, -12, -2, 4, 12, 4], faces: F(p.leg, p.leg, p.legTop, p.legBottom, p.leg, p.leg) },
    { name: 'legL', pivot: [-2, 12, 0], box: [-2, -12, -2, 4, 12, 4], faces: F(p.leg, p.leg, p.legTop, p.legBottom, p.leg, p.leg) },
  ];
}
const quadLegs = (dx, dzF, dzB, y, h, layer) => [
  ['legFR', dx, -dzF], ['legFL', -dx, -dzF], ['legBR', dx, dzB], ['legBL', -dx, dzB],
].map(([name, x, z]) => ({ name, pivot: [x, y, z], box: [-2, -h, -2, 4, h, 4], faces: all(layer) }));

export const MOB_TYPES = {
  pig: {
    name: 'Pig', w: 0.85, h: 0.9, health: 10, speed: 1.4, scale: 1 / 16, quad: true,
    parts: () => [
      { name: 'body', pivot: [0, 6, 0], box: [-5, 0, -8, 10, 8, 16], faces: all('pig_skin') },
      { name: 'head', parent: 'body', pivot: [0, 4, -8], box: [-4, -4, -8, 8, 8, 8], faces: F('pig_skin', 'pig_skin', 'pig_skin', 'pig_skin', 'pig_skin', 'pig_head_front') },
      { name: 'snout', parent: 'head', pivot: [0, 0, 0], box: [-2, -3, -9, 4, 3, 1], faces: F('pig_skin', 'pig_skin', 'pig_skin', 'pig_skin', 'pig_skin', 'pig_snout') },
      { name: 'earR', parent: 'head', pivot: [0, 0, 0], box: [2, 3, -5, 2, 2, 1], faces: all('pig_skin') },
      { name: 'earL', parent: 'head', pivot: [0, 0, 0], box: [-4, 3, -5, 2, 2, 1], faces: all('pig_skin') },
      ...quadLegs(3, 5, 5, 6, 6, 'pig_leg'),
    ],
    drops: () => [[I.RAW_PORK, 1 + Math.floor(rand() * 3)]],
  },
  cow: {
    name: 'Cow', w: 0.9, h: 1.4, health: 10, speed: 1.2, scale: 1 / 16, quad: true,
    parts: () => [
      { name: 'body', pivot: [0, 12, 0], box: [-6, 0, -9, 12, 10, 18], faces: all('cow_skin') },
      { name: 'head', parent: 'body', pivot: [0, 7, -9], box: [-4, -4, -6, 8, 8, 6], faces: F('cow_skin', 'cow_skin', 'cow_skin', 'cow_skin', 'cow_skin', 'cow_head_front') },
      { name: 'muzzle', parent: 'head', pivot: [0, 0, 0], box: [-3, -4, -7, 6, 3, 1], faces: all('cow_muzzle') },
      { name: 'hornR', parent: 'head', pivot: [0, 0, 0], box: [4, 2, -4, 2, 1, 1], faces: all('cow_horn') },
      { name: 'hornL', parent: 'head', pivot: [0, 0, 0], box: [-6, 2, -4, 2, 1, 1], faces: all('cow_horn') },
      { name: 'hornRt', parent: 'head', pivot: [0, 0, 0], box: [5, 3, -4, 1, 2, 1], faces: all('cow_horn') },
      { name: 'hornLt', parent: 'head', pivot: [0, 0, 0], box: [-6, 3, -4, 1, 2, 1], faces: all('cow_horn') },
      { name: 'udder', parent: 'body', pivot: [0, 0, 0], box: [-2, -1, 3, 4, 1, 4], faces: all('cow_udder') },
      ...quadLegs(4, 6, 6, 12, 12, 'cow_leg'),
    ],
    drops: () => [[I.RAW_BEEF, 1 + Math.floor(rand() * 3)]],
  },
  sheep: {
    name: 'Sheep', w: 0.9, h: 1.3, health: 8, speed: 1.3, scale: 1 / 16, quad: true,
    parts: () => [
      { name: 'body', pivot: [0, 12, 0], box: [-5, 0, -8, 10, 9, 16], faces: all('sheep_wool') },
      { name: 'head', parent: 'body', pivot: [0, 7, -8], box: [-3, -3, -6, 6, 6, 6], faces: F('sheep_skin', 'sheep_skin', 'sheep_skin', 'sheep_skin', 'sheep_skin', 'sheep_face') },
      { name: 'cap', parent: 'head', pivot: [0, 0, 0], box: [-3.5, 1, -5.5, 7, 3, 6], faces: all('sheep_wool') },
      ...quadLegs(3, 5, 5, 12, 12, 'sheep_leg'),
    ],
    drops: () => [[B.WOOL_WHITE, 1 + Math.floor(rand() * 2)], [I.RAW_MUTTON, 1 + Math.floor(rand() * 2)]],
  },
  ghoul: {
    name: 'Ghoul', w: 0.6, h: 1.85, health: 20, speed: 2.4, scale: 0.058, hostile: true, damage: 3,
    parts: () => humanoid({
      bodyR: 'gh_body_side', bodyL: 'gh_body_side', bodyTop: 'gh_body_top', bodyBottom: 'gh_body_top', bodyBack: 'gh_body_back', bodyFront: 'gh_body_front',
      headR: 'gh_head_side', headL: 'gh_head_side', headTop: 'gh_head_top', headBottom: 'gh_head_side', headBack: 'gh_head_back', headFront: 'gh_head_front',
      armOut: 'gh_arm', armIn: 'gh_arm', armTop: 'gh_body_top', armBottom: 'gh_arm', leg: 'gh_leg', legTop: 'gh_leg', legBottom: 'gh_leg',
    }),
    drops: () => (rand() < 0.8 ? [[I.ROTTEN_FLESH, 1 + Math.floor(rand() * 2)]] : []),
  },
  chicken: {
    name: 'Chicken', w: 0.45, h: 0.7, health: 4, speed: 1.1, scale: 1 / 16, flaps: true,
    parts: () => [
      { name: 'body', pivot: [0, 5, 0], box: [-3, 0, -4, 6, 5, 7], faces: all('ck_body') },
      { name: 'head', parent: 'body', pivot: [0, 4, -4], box: [-2, 0, -2, 4, 5, 3], faces: F('ck_body', 'ck_body', 'ck_body', 'ck_body', 'ck_body', 'ck_head_front') },
      { name: 'beak', parent: 'head', pivot: [0, 0, 0], box: [-1, 2, -4, 2, 1, 2], faces: all('ck_beak') },
      { name: 'wattle', parent: 'head', pivot: [0, 0, 0], box: [-0.5, 0.5, -3, 1, 1.5, 1], faces: all('ck_wattle') },
      { name: 'wingR', parent: 'body', pivot: [3, 4, 0], box: [0, -4, -3, 1, 4, 5], faces: all('ck_body') },
      { name: 'wingL', parent: 'body', pivot: [-3, 4, 0], box: [-1, -4, -3, 1, 4, 5], faces: all('ck_body') },
      { name: 'legR', pivot: [1.5, 5, 0], box: [-0.5, -5, -0.5, 1, 5, 1], faces: all('ck_leg') },
      { name: 'legL', pivot: [-1.5, 5, 0], box: [-0.5, -5, -0.5, 1, 5, 1], faces: all('ck_leg') },
    ],
    drops: () => [[I.FEATHER, Math.floor(rand() * 3)], [I.RAW_CHICKEN, 1]],
  },
  rabbit: {
    name: 'Rabbit', w: 0.45, h: 0.5, health: 3, speed: 2.4, scale: 1 / 16, hops: true, skittish: true,
    parts: () => [
      { name: 'body', pivot: [0, 3, 0], box: [-2.5, 0, -3.5, 5, 4, 7], faces: all('rb_fur') },
      { name: 'head', parent: 'body', pivot: [0, 3, -3.5], box: [-2, -1, -3.5, 4, 4, 4], faces: F('rb_fur', 'rb_fur', 'rb_fur', 'rb_fur', 'rb_fur', 'rb_face') },
      { name: 'earR', parent: 'head', pivot: [0, 0, 0], box: [0.5, 3, -1.5, 1, 4, 1], faces: all('rb_ear') },
      { name: 'earL', parent: 'head', pivot: [0, 0, 0], box: [-1.5, 3, -1.5, 1, 4, 1], faces: all('rb_ear') },
      { name: 'tail', parent: 'body', pivot: [0, 0, 0], box: [-1, 2, 3.5, 2, 2, 1.5], faces: all('rb_tail') },
      { name: 'legBR', pivot: [1.8, 3, 2.5], box: [-1, -3, -1.5, 2, 3, 3], faces: all('rb_fur') },
      { name: 'legBL', pivot: [-1.8, 3, 2.5], box: [-1, -3, -1.5, 2, 3, 3], faces: all('rb_fur') },
      { name: 'legFR', pivot: [1.3, 3, -2.5], box: [-0.5, -3, -0.5, 1, 3, 1], faces: all('rb_fur') },
      { name: 'legFL', pivot: [-1.3, 3, -2.5], box: [-0.5, -3, -0.5, 1, 3, 1], faces: all('rb_fur') },
    ],
    drops: () => [[I.RAW_RABBIT, 1]],
  },
  goat: {
    name: 'Goat', w: 0.8, h: 1.2, health: 10, speed: 1.4, scale: 1 / 16, quad: true, climber: true,
    parts: () => [
      { name: 'body', pivot: [0, 10, 0], box: [-4, 0, -7, 8, 8, 14], faces: all('gt_coat') },
      { name: 'head', parent: 'body', pivot: [0, 7, -7], box: [-2.5, -2, -6, 5, 5, 6], faces: F('gt_coat', 'gt_coat', 'gt_coat', 'gt_coat', 'gt_coat', 'gt_face') },
      { name: 'hornR', parent: 'head', pivot: [1.5, 3, -2], box: [-0.5, 0, -0.5, 1, 4, 1], faces: all('gt_horn'), rot: [0.5, 0, -0.2] },
      { name: 'hornL', parent: 'head', pivot: [-1.5, 3, -2], box: [-0.5, 0, -0.5, 1, 4, 1], faces: all('gt_horn'), rot: [0.5, 0, 0.2] },
      { name: 'beard', parent: 'head', pivot: [0, 0, 0], box: [-1, -4, -5.5, 2, 2, 1], faces: all('gt_coat') },
      ...quadLegs(2.5, 5, 5, 10, 10, 'gt_leg'),
    ],
    drops: () => [],
  },
  fox: {
    name: 'Fox', w: 0.6, h: 0.7, health: 8, speed: 2.2, scale: 1 / 16, quad: true, skittish: true,
    parts: () => [
      { name: 'body', pivot: [0, 6, 0], box: [-3, 0, -5, 6, 6, 10], faces: all('fx_fur') },
      { name: 'head', parent: 'body', pivot: [0, 4, -5], box: [-3, -2, -5, 6, 5, 5], faces: F('fx_fur', 'fx_fur', 'fx_fur', 'fx_fur', 'fx_fur', 'fx_face') },
      { name: 'snout', parent: 'head', pivot: [0, 0, 0], box: [-1, -2, -7, 2, 2, 2], faces: all('fx_snout') },
      { name: 'earR', parent: 'head', pivot: [0, 0, 0], box: [1, 3, -2, 2, 2, 1], faces: all('fx_fur') },
      { name: 'earL', parent: 'head', pivot: [0, 0, 0], box: [-3, 3, -2, 2, 2, 1], faces: all('fx_fur') },
      { name: 'tail', parent: 'body', pivot: [0, 4, 5], box: [-1.5, -1.5, 0, 3, 3, 8], faces: all('fx_tail'), rot: [-0.6, 0, 0] },
      ...quadLegs(1.8, 3.5, 3.5, 6, 6, 'fx_leg'),
    ],
    drops: () => [],
  },
  spider: {
    name: 'Spider', w: 1.2, h: 0.85, health: 16, speed: 3, scale: 1 / 16, hostile: true, damage: 2, leaps: true, nightOnly: true,
    parts: () => [
      { name: 'body', pivot: [0, 7, 0], box: [-3, -3, -3, 6, 6, 6], faces: all('sp_body') },
      { name: 'abdomen', parent: 'body', pivot: [0, 0, 0], box: [-5, -3, 3, 10, 8, 11], faces: all('sp_body') },
      { name: 'head', parent: 'body', pivot: [0, 0, -3], box: [-4, -3, -7, 8, 7, 7], faces: F('sp_body', 'sp_body', 'sp_body', 'sp_body', 'sp_body', 'sp_face') },
      ...[0, 1, 2, 3, 4, 5, 6, 7].map((k) => {
        const side = k < 4 ? 1 : -1, j = k % 4;
        return { name: `sleg${k}`, sleg: k, parent: 'body', pivot: [side * 3, 0, -2 + j * 1.4], box: side > 0 ? [0, -1, -1, 15, 2, 2] : [-15, -1, -1, 15, 2, 2], faces: all('sp_leg') };
      }),
    ],
    drops: () => [[I.STRING, Math.floor(rand() * 3)]],
  },
  archer: {
    name: 'Bone Archer', w: 0.6, h: 1.85, health: 18, speed: 2.2, scale: 0.058, hostile: true, damage: 3, ranged: true, burns: true,
    parts: () => humanoid({
      bodyR: 'ba_hood', bodyL: 'ba_hood', bodyTop: 'ba_hood', bodyBottom: 'ba_hood', bodyBack: 'ba_hood', bodyFront: 'ba_body',
      headR: 'ba_hood', headL: 'ba_hood', headTop: 'ba_hood', headBottom: 'ba_limb', headBack: 'ba_hood', headFront: 'ba_head_front',
      armOut: 'ba_sleeve', armIn: 'ba_sleeve', armTop: 'ba_hood', armBottom: 'ba_limb', leg: 'ba_limb', legTop: 'ba_limb', legBottom: 'ba_limb',
    }),
    drops: () => [[I.BONE, Math.floor(rand() * 3)], [I.ARROW, Math.floor(rand() * 3)]],
  },
  settler: {
    name: 'Settler', w: 0.6, h: 1.85, health: 20, speed: 1.1, scale: 0.058, homebound: true,
    parts: () => [
      ...humanoid({
        bodyR: 'st_side', bodyL: 'st_side', bodyTop: 'st_side', bodyBottom: 'st_side', bodyBack: 'st_side', bodyFront: 'st_body',
        headR: 'st_head', headL: 'st_head', headTop: 'st_head', headBottom: 'st_head', headBack: 'st_head', headFront: 'st_head_front',
        armOut: 'st_arm', armIn: 'st_arm', armTop: 'st_side', armBottom: 'st_arm', leg: 'st_leg', legTop: 'st_leg', legBottom: 'st_leg',
      }),
      { name: 'brim', parent: 'head', pivot: [0, 0, 0], box: [-6, 7, -6, 12, 1, 12], faces: all('st_hat') },
      { name: 'crown', parent: 'head', pivot: [0, 0, 0], box: [-4, 8, -4, 8, 2, 8], faces: all('st_hat') },
    ],
    drops: () => [],
  },
  player: {
    name: 'You', w: 0.6, h: 1.8, scale: 0.056,
    parts: () => humanoid({
      bodyR: 'wd_body_side_bag', bodyL: 'wd_body_side', bodyTop: 'wd_body_top', bodyBottom: 'wd_body_bottom', bodyBack: 'wd_body_back', bodyFront: 'wd_body_front',
      headR: 'wd_head_right', headL: 'wd_head_left', headTop: 'wd_head_top', headBottom: 'wd_head_bottom', headBack: 'wd_head_back', headFront: 'wd_head_front',
      armOut: 'wd_arm_side', armIn: 'wd_arm_inner', armTop: 'wd_arm_top', armBottom: 'wd_arm_bottom', leg: 'wd_leg_side', legTop: 'wd_leg_top', legBottom: 'wd_leg_bottom',
    }),
  },
};

const partMeshes = new Map();
export function mobParts(renderer, type) {
  let p = partMeshes.get(type);
  if (p) return p;
  p = MOB_TYPES[type].parts().map((part) => {
    const [x, y, z, w, h, d] = part.box;
    return { ...part, mesh: renderer.upload(boxMesh(x, y, z, w, h, d, part.faces.map(L))) };
  });
  partMeshes.set(type, p);
  return p;
}

const PM = new Map();
const matFor = (name) => { let m = PM.get(name); if (!m) PM.set(name, (m = new Mat4())); return m; };

// Builds draw calls for a posed model.
// pose: { bodyYaw, headYaw (relative to body), headPitch, phase, amount, swing (0..1, 0 = idle),
//         armsForward, sneak, tilt, color, held (item id), shadow }
export function poseDraws(g, cam, type, e, pose) {
  const def = MOB_TYPES[type];
  const parts = mobParts(g.renderer, type);
  const light = e.lightAt(g.world);
  const out = [];
  const sw = Math.sin(pose.phase) * pose.amount;
  const lean = pose.sneak ? -0.45 : 0;
  const s = pose.swing > 0 && pose.swing < 1 ? pose.swing : 0;
  const attack = Math.sin(Math.sqrt(s) * Math.PI);
  const root = matFor('root').identity().translate(e.x - cam.x, e.y - cam.y, e.z - cam.z).rotateY(pose.bodyYaw);
  if (pose.tilt) root.rotateZ(pose.tilt);
  root.scale(def.scale);
  if (pose.sneak) root.translate(0, -2.5, 1.5);
  for (const part of parts) {
    const m = matFor(part.name).copy(part.parent ? matFor(part.parent) : root);
    m.translate(part.pivot[0], part.pivot[1], part.pivot[2]);
    switch (part.name) {
      case 'body': if (lean) m.rotateX(lean); break;
      case 'head': m.rotateY(pose.headYaw || 0).rotateX((pose.headPitch || 0) - lean); break;
      case 'legR': case 'legFL': case 'legBR': m.rotateX(sw * 1.1); break;
      case 'legL': case 'legFR': case 'legBL': m.rotateX(-sw * 1.1); break;
      case 'armR':
        if (pose.armsForward) m.rotateX(1.45 + sw * 0.12 + attack * 0.6);
        else m.rotateX(-sw * 0.9 + (pose.held ? 0.32 : 0) + attack * 1.5 - lean * 0.6).rotateY(-attack * 0.35).rotateZ(0.06 + attack * 0.2);
        break;
      case 'armL':
        if (pose.armsForward) m.rotateX(1.45 - sw * 0.12 + attack * 0.6);
        else m.rotateX(sw * 0.9 - lean * 0.6).rotateZ(-0.06);
        break;
      case 'wingR': m.rotateZ(-(pose.flap || 0)); break;
      case 'wingL': m.rotateZ(pose.flap || 0); break;
    }
    if (part.sleg !== undefined) {
      const k = part.sleg, side = k < 4 ? 1 : -1, j = k % 4;
      m.rotateY(side * (0.75 - j * 0.5) + Math.sin(pose.phase * 1.7 + j * 1.6 + (side > 0 ? 0 : Math.PI)) * 0.4 * pose.amount);
      m.rotateZ(side * -0.5 + Math.abs(Math.sin(pose.phase * 1.7 + j * 1.6)) * 0.15 * pose.amount * side);
    }
    if (part.rot) m.rotateX(part.rot[0]).rotateY(part.rot[1]).rotateZ(part.rot[2]);
    out.push({ mesh: part.mesh, model: m.m.slice(), light, color: pose.color });
  }
  if (pose.held !== undefined && pose.held !== null) {
    const im = g.renderer.itemMesh(pose.held);
    const h = matFor('held').copy(matFor('armR')).translate(0, -9.5, -1);
    if (im.flat) h.rotateX(-Math.PI / 4 + 0.35).rotateY(Math.PI / 2).scale(10).translate(0.5, 0.5, 0);
    else h.translate(0, -1.5, -1.5).rotateY(Math.PI / 4).scale(5.5);
    out.push({ mesh: im.mesh, model: h.m.slice(), light, noCull: im.flat, color: pose.color });
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
    this.swing = 0;
    this.headPitch = 0;
    this.home = [x, z];
    this.shootT = 1 + rand() * 2;
    this.eggT = 200 + rand() * 300;
    this.flap = 0;
    this.leapT = 0;
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
    if (this.def.ranged && p.alive && p.mode === 'survival' && dist < 22) {
      // Keep a firing distance and shoot when the player is in sight.
      this.targetYaw = Math.atan2(-dxp, -dzp);
      if (dist > 11) moving = true;
      else if (dist < 6) { moving = true; this.targetYaw += Math.PI; }
      this.shootT -= dt;
      if (this.shootT <= 0 && dist < 18 && g.canSee(this.x, this.y + 1.6, this.z, p.x, p.y + 1.4, p.z)) {
        this.shootT = 1.6 + rand() * 1.2;
        this.swing = 0.01;
        const dy = p.y + 1.2 - (this.y + 1.5), flat = Math.hypot(dxp, dzp);
        const sp = 22, aim = Math.atan2(dy + flat * flat * 0.012, flat);
        g.entities.push(new Arrow(this.x, this.y + 1.5, this.z, (dxp / flat) * Math.cos(aim) * sp, Math.sin(aim) * sp, (dzp / flat) * Math.cos(aim) * sp, this, 3));
        g.audio.play('swing', { vol: 0.6 });
      }
    } else if (this.def.hostile && p.alive && p.mode === 'survival' && dist < 20) {
      this.targetYaw = Math.atan2(-dxp, -dzp);
      moving = dist > 0.8;
      if (this.def.leaps && dist < 5 && dist > 1.4 && this.onGround && (this.leapT -= dt) <= 0) {
        this.leapT = 1.5 + rand();
        this.vy = 6.5;
        this.vx = (dxp / dist) * 7; this.vz = (dzp / dist) * 7;
      }
      if (dist < (this.def.leaps ? 1.8 : 1.5) && Math.abs(p.y - this.y) < 1.6 && this.attackCd <= 0) {
        g.damagePlayer(this.def.damage, this);
        this.attackCd = 1;
        this.swing = 0.01;
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
      // Settlers drift back toward home when they wander too far.
      if (this.def.homebound && Math.hypot(this.x - this.home[0], this.z - this.home[1]) > 14) {
        this.targetYaw = Math.atan2(-(this.home[0] - this.x), -(this.home[1] - this.z));
        moving = true;
      }
      // Skittish animals bolt when the player gets close.
      if (this.def.skittish && dist < 4 && p.alive && !p.sneaking) { this.flee = 2; this.timer = 0; }
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
    if (BLOCKS[w.getBlock(Math.floor(this.x), Math.floor(this.y + 0.3), Math.floor(this.z))].web && this.type !== 'spider') { mx *= 0.15; mz *= 0.15; }
    const k = Math.min(1, (this.onGround ? 10 : liquid ? 4 : 2) * dt);
    this.vx += (mx * (liquid ? 0.5 : 1) - this.vx) * k;
    this.vz += (mz * (liquid ? 0.5 : 1) - this.vz) * k;
    if (liquid) this.vy = Math.min(this.vy + 22 * dt, 2.2);
    else this.vy = Math.max(this.vy - 28 * dt, -50);
    if (moving && (this.hitX || this.hitZ) && this.onGround) this.vy = this.def.climber ? 10 : 8.6;
    if (this.def.hops && moving && this.onGround && !liquid) this.vy = 5.2;
    if (this.def.flaps) {
      if (!this.onGround && this.vy < -2 && !liquid) this.vy = -2;
      this.flap = this.onGround ? this.flap * 0.8 : Math.abs(Math.sin(this.age * 22)) * 1.2;
      this.eggT -= dt;
      if (this.eggT <= 0) { this.eggT = 300 + rand() * 300; g.dropItem(this.x, this.y + 0.3, this.z, { id: I.EGG, count: 1 }); }
    }
    moveEntity(w, this, this.vx * dt, this.vy * dt, this.vz * dt, 0.55);
    const hs = Math.hypot(this.vx, this.vz);
    this.phase += hs * dt * 4.5;
    this.amount += (Math.min(1, hs / 1.5) - this.amount) * Math.min(1, 10 * dt);
    const looking = dist < 8 && p.alive;
    this.headYaw = looking ? Math.max(-0.9, Math.min(0.9, angleDiff(Math.atan2(-dxp, -dzp), this.yaw))) : this.headYaw * 0.95;
    const eyeY = this.y + this.h * 0.85;
    this.headPitch = looking ? Math.max(-0.7, Math.min(0.7, Math.atan2(p.y + p.eye - eyeY, Math.hypot(dxp, dzp)))) : (this.headPitch || 0) * 0.95;
    if (this.swing > 0) { this.swing += dt * 3.2; if (this.swing >= 1) this.swing = 0; }

    if (liquid === 2) { this.lavaT += dt; if (this.lavaT > 0.5) { this.lavaT = 0; this.damage(4, null, g); } }
    if ((this.def.burns || this.type === 'ghoul') && g.daylight > 0.75 && !liquid) {
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
      bodyYaw: this.yaw, headYaw: this.headYaw, headPitch: this.headPitch || 0, phase: this.phase, amount: this.amount,
      tilt: this.health <= 0 ? Math.min(1, this.deathTime * 2.4) * (Math.PI / 2) : 0,
      armsForward: this.type === 'ghoul' || this.type === 'archer', swing: this.swing, flap: this.flap,
      held: this.type === 'archer' ? I.BOW : null,
      color: this.hurt > 0 || this.health <= 0 ? [1, 0.45, 0.45, 1] : null,
    });
  }

  box() { return entityBox(this); }
}

export { boxTouches };
