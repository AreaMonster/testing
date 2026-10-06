// Game orchestration: worlds, player, interaction, simulation ticks and frames.
import { Renderer } from './renderer.js';
import { buildChunkMesh } from './mesher.js';
import { World, ckey } from './world.js';
import { WorldGen, BIOME_NAMES, placeTree } from './worldgen.js';
import { B, I, BLOCKS, ITEMS, OPAQUE, SOLID, LIQUID, REPLACEABLE, TEXL, LOG, itemDef, itemName, maxStackOf, canHarvest, breakTime, toolOf, nameToId } from './blocks.js';
import { Inventory, SMELT, SMELT_TIME, fuelTime } from './crafting.js';
import { Entity, ItemEntity, FallingBlock, Mob, MOB_TYPES, poseDraws, mobParts } from './entities.js';
import { moveEntity, raycast, rayBox, entityBox, groundBelow, boxTouches } from './physics.js';
import { Mat4, clamp, smooth, lerp } from './math.js';
import { CH, SEA, TICK } from './consts.js';
import { Store } from './save.js';
import { DEFAULT_GRASS, LAYERS } from './textures.js';
import { boxMesh } from './mesher.js';
const L = (n) => LAYERS[n];

const rand = Math.random;
const angleDiff = (a, b) => {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
};

class Player extends Entity {
  constructor() {
    super(0, 80, 0, 0.6, 1.8);
    this.eye = 1.62;
    this.yaw = 0;
    this.pitch = 0;
    this.flying = false;
    this.sneaking = false;
    this.sprinting = false;
    this.health = 20;
    this.hunger = 20;
    this.sat = 5;
    this.exhaustion = 0;
    this.air = 15;
    this.mode = 'survival';
    this.inv = new Inventory(36);
    this.sel = 0;
    this.alive = true;
    this.hurtT = 0;
    this.invuln = 0;
    this.regenT = 0;
    this.starveT = 0;
    this.drownT = 0;
    this.lavaT = 0;
    this.cactusT = 0;
    this.peakY = 80;
    this.bobPhase = 0;
    this.bobAmt = 0;
    this.stepDist = 0;
    this.swing = 1;
    this.eating = 0;
    this.attackCd = 0;
    this.jumpCd = 0;
    this.spawn = [0.5, 80, 0.5];
    this.wasInWater = false;
    this.eyeLiquid = 0;
    this.fovBoost = 0;
    this.bodyYaw = 0;
    this.limbPhase = 0;
    this.limbAmt = 0;
  }
  held() { return this.inv.get(this.sel); }
}

// Generates chunks in Web Workers; falls back to the main thread if workers fail.
class GenPool {
  constructor() {
    this.workers = [];
    this.pending = new Map();
    this.ready = [];
    this.failed = false;
    const n = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 4) - 1));
    try {
      for (let i = 0; i < n; i++) {
        const w = new Worker(new URL('./genworker.js', import.meta.url), { type: 'module' });
        const slot = { w, jobs: 0 };
        w.onmessage = (e) => this.done(slot, e.data);
        w.onerror = (e) => { e.preventDefault?.(); this.fail(); };
        this.workers.push(slot);
      }
    } catch {
      this.fail();
    }
  }
  fail() {
    this.failed = true;
    this.pending.clear();
    for (const s of this.workers) s.w.terminate();
    this.workers = [];
  }
  key(epoch, cx, cz) { return `${epoch}:${cx},${cz}`; }
  has(epoch, cx, cz) { return this.pending.has(this.key(epoch, cx, cz)); }
  get capacity() { return this.workers.length * 3; }
  request(epoch, seed, cx, cz) {
    let best = this.workers[0];
    for (const s of this.workers) if (s.jobs < best.jobs) best = s;
    best.jobs++;
    this.pending.set(this.key(epoch, cx, cz), best);
    best.w.postMessage({ id: epoch, seed, cx, cz });
  }
  done(slot, d) {
    slot.jobs--;
    this.pending.delete(this.key(d.id, d.cx, d.cz));
    this.ready.push(d);
  }
}

const DEFAULT_SETTINGS = {
  renderDist: 8, fov: 75, sensitivity: 1, gamma: 0.85, music: 0.4, sfx: 0.8,
  bob: true, fancyLeaves: true, clouds: true, invertY: false, scale: 1,
};

export class Game {
  constructor(canvas, ui, audio) {
    this.canvas = canvas;
    this.ui = ui;
    this.audio = audio;
    this.renderer = new Renderer(canvas);
    this.settings = Object.assign({}, DEFAULT_SETTINGS, Store.loadSettings());
    if (matchMedia('(pointer: coarse)').matches && !Store.loadSettings().renderDist) this.settings.renderDist = 5;
    this.state = 'menu';
    this.world = null;
    this.player = new Player();
    this.entities = [];
    this.particles = [];
    this.checks = [];
    this.keys = new Set();
    this.mouse = { left: false, right: false, leftPressed: false, rightPressed: false };
    this.touch = { f: 0, s: 0, jump: false, sneak: false };
    this.time = 0;
    this.tickAcc = 0;
    this.last = performance.now();
    this.cameraMode = 0;
    this.hudHidden = false;
    this.showDebug = false;
    this.mining = null;
    this.breakCd = 0;
    this.useCd = 0;
    this.daylight = 1;
    this.fps = 0;
    this.fpsAcc = 0;
    this.fpsN = 0;
    this.lastTap = {};
    this.offsets = [];
    for (let dz = -20; dz <= 20; dz++) for (let dx = -20; dx <= 20; dx++) this.offsets.push([dx, dz, dx * dx + dz * dz]);
    this.offsets.sort((a, b) => a[2] - b[2]);
    this.M = new Mat4();
    this.unloadT = 0;
    this.saveT = 0;
    this.spawnT = 0;
    this.equip = 0;
    this.lastSel = 0;
    this.lastHeldId = -1;
    this.target = null;
    this.targetMob = null;
    this.cloudOffset = 0;
    this.loadStart = 0;
    this.pool = new GenPool();
    this.epoch = 0;
    this.applySettings();
  }

  applySettings() {
    const s = this.settings;
    this.audio.setVolumes(s.sfx, s.music);
    Store.saveSettings(s);
    if (this.world) for (const c of this.world.chunks.values()) c.dirty = true;
  }

  // ---------------------------------------------------------------- worlds
  disposeWorld() {
    this.epoch++;
    this.pool.ready.length = 0;
    if (!this.world) return;
    for (const c of this.world.chunks.values()) this.renderer.freeChunk(c);
    this.world = null;
    this.entities = [];
    this.particles = [];
    this.checks = [];
    this.mining = null;
  }

  startMenuWorld() {
    this.disposeWorld();
    const seed = 1337 + Math.floor(rand() * 1e6);
    this.gen = new WorldGen(seed);
    this.world = new World(seed, this.gen, null);
    this.world.time = 2600 + Math.floor(rand() * 4000);
    const [x, y, z] = this.gen.findSpawn();
    const p = this.player = new Player();
    p.x = x; p.z = z; p.y = Math.max(y + 12, SEA + 20);
    p.yaw = rand() * 6;
    p.pitch = -0.2;
    this.meta = null;
    this.store = null;
    this.state = 'menu';
  }

  startWorld(meta) {
    this.disposeWorld();
    this.meta = meta;
    this.store = Store.forWorld(meta.id);
    this.gen = new WorldGen(meta.seed);
    this.world = new World(meta.seed, this.gen, this.store);
    this.world.onChange = (x, y, z) => this.checks.push(x, y, z);
    const st = this.store.loadState();
    const p = this.player = new Player();
    p.mode = meta.mode || 'survival';
    if (st) {
      Object.assign(p, {
        x: st.x, y: st.y, z: st.z, yaw: st.yaw || 0, pitch: st.pitch || 0, health: st.health ?? 20,
        hunger: st.hunger ?? 20, sat: st.sat ?? 5, mode: st.mode || p.mode, sel: st.sel || 0,
        spawn: st.spawn || [st.x, st.y, st.z], flying: !!st.flying && st.mode === 'creative',
      });
      p.inv.load(st.inv);
      this.world.time = st.time ?? 1000;
      this.world.day = st.day || 0;
      if (st.tiles) for (const [k, v] of Object.entries(st.tiles)) this.world.tileEntities.set(k, v);
      if (p.health <= 0) { p.health = 20; [p.x, p.y, p.z] = p.spawn; }
    } else {
      const s = this.gen.findSpawn();
      [p.x, p.y, p.z] = s;
      p.spawn = s.slice();
      this.world.time = 1000;
      this.world.day = 0;
    }
    p.peakY = p.y;
    meta.lastPlayed = Date.now();
    Store.upsertWorld(meta);
    this.state = 'loading';
    this.loadStart = performance.now();
    this.ui.setLoading(0);
  }

  saveAll() {
    if (!this.world || !this.store) return true;
    let ok = true;
    for (const c of this.world.chunks.values()) {
      if (c.unsaved) {
        ok = this.store.saveMods(c.cx, c.cz, this.world.modsArray(c)) && ok;
        c.unsaved = false;
      }
    }
    const p = this.player;
    ok = this.store.saveState({
      x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch, health: p.health, hunger: p.hunger, sat: p.sat,
      mode: p.mode, sel: p.sel, inv: p.inv.toJSON(), spawn: p.spawn, flying: p.flying,
      time: this.world.time, day: this.world.day, tiles: Object.fromEntries(this.world.tileEntities),
    }) && ok;
    if (this.meta) { this.meta.lastPlayed = Date.now(); this.meta.mode = p.mode; Store.upsertWorld(this.meta); }
    if (!ok && !this.warnedStorage) {
      this.warnedStorage = true;
      this.ui.chat('Browser storage is full or blocked, so recent changes may not be saved.', 'warn');
    }
    return ok;
  }

  quitToTitle() {
    this.saveAll();
    this.startMenuWorld();
    this.ui.showMenu('main');
  }

  // ---------------------------------------------------------------- chunks
  neighborsReady(c) {
    const w = this.world;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) if (!w.getChunk(c.cx + dx, c.cz + dz)) return false;
    return true;
  }

  streamChunks(budget) {
    const w = this.world, p = this.player;
    const R = this.state === 'menu' ? Math.min(this.settings.renderDist, 7) : this.settings.renderDist;
    const pcx = Math.floor(p.x / 16), pcz = Math.floor(p.z / 16);
    const t0 = performance.now();
    const genR2 = (R + 1.5) ** 2, meshR2 = (R + 0.5) ** 2;
    let busy = false;
    const pool = this.pool;
    // Adopt finished worker results; lighting does not depend on arrival order.
    while (pool.ready.length && performance.now() - t0 < budget) {
      const d = pool.ready.shift();
      if (d.id !== this.epoch || w.getChunk(d.cx, d.cz)) continue;
      if ((d.cx - pcx) ** 2 + (d.cz - pcz) ** 2 > (R + 3) ** 2) continue;
      const c = w.insertChunkData(d.cx, d.cz, d);
      if (c.fresh && this.state !== 'menu') this.spawnInitialAnimals(c);
      busy = true;
    }
    for (const [dx, dz, d2] of this.offsets) {
      if (d2 > genR2) break;
      const cx = pcx + dx, cz = pcz + dz;
      if (w.getChunk(cx, cz)) continue;
      if (pool.failed) {
        if (performance.now() - t0 > budget) break;
        const c = w.generateChunk(cx, cz);
        if (c.fresh && this.state !== 'menu') this.spawnInitialAnimals(c);
        busy = true;
      } else if (!pool.has(this.epoch, cx, cz)) {
        if (pool.pending.size >= pool.capacity) break;
        pool.request(this.epoch, w.seed, cx, cz);
        busy = true;
      }
    }
    const t1 = performance.now();
    const opts = { fancyLeaves: this.settings.fancyLeaves };
    for (const [dx, dz, d2] of this.offsets) {
      if (d2 > meshR2) break;
      const c = w.getChunk(pcx + dx, pcz + dz);
      if (c && c.dirty && this.neighborsReady(c)) {
        this.renderer.setChunkMesh(c, buildChunkMesh(w, c, opts));
        c.dirty = false;
        busy = true;
        // Nearby edits must never wait; far chunks share the frame budget.
        if (d2 > 2 && performance.now() - t1 > budget) break;
      }
    }
    this.unloadT -= 1;
    if (this.unloadT <= 0) {
      this.unloadT = 60;
      const lim = R + 3;
      for (const c of [...w.chunks.values()]) {
        if (Math.abs(c.cx - pcx) > lim || Math.abs(c.cz - pcz) > lim) {
          if (c.unsaved && this.store) this.store.saveMods(c.cx, c.cz, w.modsArray(c));
          this.renderer.freeChunk(c);
          w.unloadChunk(c);
        }
      }
    }
    this.chunkList = [];
    for (const [dx, dz, d2] of this.offsets) {
      if (d2 > meshR2) break;
      const c = w.getChunk(pcx + dx, pcz + dz);
      if (c && c.mesh) this.chunkList.push(c);
    }
    return busy;
  }

  loadingProgress() {
    const w = this.world, p = this.player;
    const pcx = Math.floor(p.x / 16), pcz = Math.floor(p.z / 16);
    let total = 0, ready = 0;
    for (const [dx, dz, d2] of this.offsets) {
      if (d2 > 9) break;
      total++;
      const c = w.getChunk(pcx + dx, pcz + dz);
      if (c && c.mesh) ready++;
    }
    return ready / total;
  }

  spawnInitialAnimals(c) {
    if (rand() > 0.1) return;
    const types = ['pig', 'cow', 'sheep'];
    const type = types[Math.floor(rand() * 3)];
    const n = 2 + Math.floor(rand() * 3);
    for (let i = 0; i < n; i++) {
      const lx = Math.floor(rand() * 16), lz = Math.floor(rand() * 16);
      for (let y = CH - 2; y > SEA; y--) {
        const id = c.blocks[(y << 8) | (lz << 4) | lx];
        if (!id) continue;
        if (id === B.GRASS) this.entities.push(new Mob(type, c.cx * 16 + lx + 0.5, y + 1, c.cz * 16 + lz + 0.5));
        break;
      }
    }
  }

  // ---------------------------------------------------------------- frame
  frame(now) {
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.time += dt;
    this.fpsAcc += dt;
    this.fpsN++;
    if (this.fpsAcc >= 0.5) { this.fps = Math.round(this.fpsN / this.fpsAcc); this.fpsAcc = 0; this.fpsN = 0; }
    this.renderer.resize(Math.min(window.devicePixelRatio || 1, 2) * this.settings.scale);
    if (!this.world) return;
    const p = this.player;

    if (this.state === 'menu') {
      p.yaw += dt * 0.04;
      this.world.time += dt * 4;
      this.streamChunks(8);
      this.render(dt);
      return;
    }
    if (this.state === 'loading') {
      this.streamChunks(40);
      const prog = this.loadingProgress();
      this.ui.setLoading(prog);
      if (prog >= 1 || performance.now() - this.loadStart > 25000) {
        this.ui.setLoading(null);
        this.safeSpawn();
        this.state = 'play';
        this.ui.onEnterPlay();
      }
      this.render(dt);
      return;
    }

    const running = this.state !== 'paused';
    if (running) {
      if (this.state === 'play' && p.alive) this.updatePlayer(dt);
      else if (p.alive) this.updatePlayerPassive(dt);
      if (this.state === 'play' && p.alive) this.interact(dt);
      if (p.swing < 1) p.swing = Math.min(1, p.swing + dt * 3.4);
      else { this.mining = null; this.mouse.leftPressed = this.mouse.rightPressed = false; }
      this.tickAcc += dt;
      let n = 0;
      while (this.tickAcc >= TICK && n++ < 5) { this.tickAcc -= TICK; this.gameTick(); }
      for (const e of this.entities) e.update(dt, this);
      this.entities = this.entities.filter((e) => !e.dead);
      this.torchEffects(dt);
      this.updateParticles(dt);
      this.processChecks();
      this.saveT += dt;
      if (this.saveT > 30) { this.saveT = 0; this.saveAll(); }
    }
    this.streamChunks(running ? 6 : 10);
    this.audio.update(dt, this.settings.music > 0, this.daylight < 0.5 ? 1 : 0);
    this.render(dt);
    this.ui.updateHUD(this);
  }

  safeSpawn() {
    const p = this.player, w = this.world;
    const bx = Math.floor(p.x), bz = Math.floor(p.z);
    let y = Math.floor(p.y);
    let guard = 0;
    while (guard++ < CH && (w.isSolid(bx, y, bz) || w.isSolid(bx, y + 1, bz))) y++;
    p.y = Math.max(p.y, y);
    p.peakY = p.y;
  }

  // ---------------------------------------------------------------- player
  updatePlayerPassive(dt) {
    const p = this.player;
    p.vx *= 0.8; p.vz *= 0.8;
    if (!p.flying) p.vy = Math.max(p.vy - 32 * dt, -78);
    else p.vy *= 0.8;
    moveEntity(this.world, p, p.vx * dt, p.vy * dt, p.vz * dt);
    this.survival(dt, p.liquidAt(this.world, 0.1));
  }

  updatePlayer(dt) {
    const p = this.player, w = this.world, k = this.keys, t = this.touch;
    let f = t.f, s = t.s;
    if (k.has('KeyW') || k.has('ArrowUp')) f += 1;
    if (k.has('KeyS') || k.has('ArrowDown')) f -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) s += 1;
    if (k.has('KeyA') || k.has('ArrowLeft')) s -= 1;
    const jump = k.has('Space') || t.jump;
    const sneakKey = k.has('ShiftLeft') || k.has('ShiftRight') || t.sneak;
    p.jumpCd -= dt;
    p.attackCd -= dt;
    if ((k.has('ControlLeft') || k.has('ControlRight') || t.sprint) && f > 0) p.sprinting = true;
    if (f <= 0 || sneakKey || (p.mode === 'survival' && p.hunger <= 6)) p.sprinting = false;
    p.sneaking = sneakKey && !p.flying;
    const liquid = p.liquidAt(w, 0.2);
    const sinY = Math.sin(p.yaw), cosY = Math.cos(p.yaw);
    let wx = -sinY * f + cosY * s, wz = -cosY * f - sinY * s;
    const len = Math.hypot(wx, wz);
    if (len > 1) { wx /= len; wz /= len; }
    const prevGround = p.onGround;
    const x0 = p.x, z0 = p.z;

    if (p.flying) {
      const sp = p.sprinting ? 21 : 10.9, kk = Math.min(1, 8 * dt);
      p.vx += (wx * sp - p.vx) * kk;
      p.vz += (wz * sp - p.vz) * kk;
      p.vy += (((jump ? 1 : 0) - (sneakKey ? 1 : 0)) * 8 - p.vy) * kk;
      moveEntity(w, p, p.vx * dt, p.vy * dt, p.vz * dt);
      if (p.onGround) p.flying = false;
    } else if (liquid) {
      const sp = p.sneaking ? 1.2 : p.sprinting ? 3.2 : 2.3, kk = Math.min(1, 5 * dt);
      p.vx += (wx * sp - p.vx) * kk;
      p.vz += (wz * sp - p.vz) * kk;
      if (jump) p.vy = Math.min(p.vy + 24 * dt, liquid === 2 ? 2 : 3.4);
      else p.vy = Math.max(p.vy - 10 * dt, sneakKey ? -4 : -2.4);
      moveEntity(w, p, p.vx * dt, p.vy * dt, p.vz * dt);
      if (jump && (p.hitX || p.hitZ)) p.vy = 6.5;
    } else {
      const sp = p.sneaking ? 1.3 : p.sprinting ? 5.6 : 4.3;
      const kk = Math.min(1, (p.onGround ? 16 : 3.2) * dt);
      p.vx += (wx * sp - p.vx) * kk;
      p.vz += (wz * sp - p.vz) * kk;
      p.vy = Math.max(p.vy - 32 * dt, -78);
      if (jump && p.onGround && p.jumpCd <= 0) {
        p.vy = 8.7;
        p.jumpCd = 0.08;
        if (p.sprinting) { p.vx += wx * 1.6; p.vz += wz * 1.6; }
        p.exhaustion += p.sprinting ? 0.2 : 0.05;
      }
      let dx = p.vx * dt, dz = p.vz * dt;
      if (p.sneaking && p.onGround) {
        const hw = p.w / 2;
        if (!groundBelow(w, p.x + dx - hw, p.z - hw, p.x + dx + hw, p.z + hw, p.y)) { dx = 0; p.vx = 0; }
        if (!groundBelow(w, p.x + dx - hw, p.z + dz - hw, p.x + dx + hw, p.z + dz + hw, p.y)) { dz = 0; p.vz = 0; }
      }
      moveEntity(w, p, dx, p.vy * dt, dz);
    }
    if ((p.hitX || p.hitZ) && !p.flying) p.sprinting = false;

    // Fall damage
    if (p.onGround || liquid || p.flying) {
      if (p.onGround && !prevGround && !liquid && !p.flying) {
        const fall = p.peakY - p.y;
        if (fall > 3.4 && p.mode === 'survival') this.damagePlayer(Math.floor(fall - 3), null, 'fell from a high place');
        if (fall > 1.2) this.footstep(true);
      }
      p.peakY = p.y;
    } else p.peakY = Math.max(p.peakY, p.y);

    if (liquid && !p.wasInWater && p.vy < -4) { this.audio.play('splash'); this.spawnSplash(p.x, p.y, p.z); }
    p.wasInWater = !!liquid;

    // View bob & footsteps
    const moved = Math.hypot(p.x - x0, p.z - z0);
    if (p.onGround && !p.flying) {
      p.bobPhase += moved * 2.2;
      p.stepDist += moved;
      if (p.stepDist > (p.sprinting ? 2.1 : 1.7)) { p.stepDist = 0; this.footstep(false); }
      p.exhaustion += moved * (p.sprinting ? 0.1 : 0.01);
    }
    p.bobAmt += ((p.onGround && moved > 0.001 ? 1 : 0) - p.bobAmt) * Math.min(1, 8 * dt);
    p.fovBoost += ((p.sprinting ? 1 : 0) - p.fovBoost) * Math.min(1, 6 * dt);
    this.animatePlayer(dt, moved);
    if (p.y < -64) this.damagePlayer(4, null, 'fell out of the world');
    this.survival(dt, liquid);
  }

  // Third-person body animation: legs/arms swing with distance walked, and the
  // body turns toward the walking direction but never more than ~50° from the head.
  animatePlayer(dt, moved) {
    const p = this.player;
    const speed = moved / Math.max(dt, 1e-4);
    p.limbPhase += moved * 2.4;
    const target = p.flying ? Math.min(0.4, speed / 20) : Math.min(1, speed / 4.3);
    p.limbAmt += (target - p.limbAmt) * Math.min(1, 10 * dt);
    if (speed > 0.6) {
      let my = Math.atan2(-p.vx, -p.vz);
      if (Math.abs(angleDiff(my, p.yaw)) > Math.PI / 2) my += Math.PI;
      p.bodyYaw += angleDiff(my, p.bodyYaw) * Math.min(1, 7 * dt);
    }
    const d = angleDiff(p.yaw, p.bodyYaw), lim = 0.87;
    if (d > lim) p.bodyYaw = p.yaw - lim;
    else if (d < -lim) p.bodyYaw = p.yaw + lim;
  }

  survival(dt, liquid) {
    const p = this.player, w = this.world;
    p.hurtT = Math.max(0, p.hurtT - dt);
    p.invuln = Math.max(0, p.invuln - dt);
    p.eyeLiquid = LIQUID[w.getBlock(Math.floor(p.x), Math.floor(p.y + p.eye), Math.floor(p.z))];
    if (p.mode !== 'survival') { p.air = 15; return; }
    // Hunger and regeneration
    p.exhaustion += dt * 0.012;
    if (p.exhaustion >= 4) {
      p.exhaustion -= 4;
      if (p.sat > 0) p.sat = Math.max(0, p.sat - 1);
      else p.hunger = Math.max(0, p.hunger - 1);
    }
    p.regenT += dt;
    if (p.hunger >= 18 && p.health < 20 && p.regenT > 4) { p.regenT = 0; p.health = Math.min(20, p.health + 1); p.exhaustion += 3; }
    if (p.hunger <= 0 && p.regenT > 4) { p.regenT = 0; if (p.health > 1) this.damagePlayer(1, null, 'starved', true); }
    // Air
    if (p.eyeLiquid === 1) {
      p.air -= dt;
      if (p.air <= 0) { p.drownT += dt; if (p.drownT > 1) { p.drownT = 0; this.damagePlayer(2, null, 'drowned', true); } }
    } else p.air = Math.min(15, p.air + dt * 5);
    // Lava
    if (liquid === 2 || p.eyeLiquid === 2) {
      p.lavaT += dt;
      if (p.lavaT > 0.5) { p.lavaT = 0; this.damagePlayer(4, null, 'tried to swim in lava', true); }
    }
    // Cactus
    const b = entityBox(p);
    b[0] -= 0.02; b[2] -= 0.02; b[3] += 0.02; b[5] += 0.02; b[1] -= 0.02;
    if (boxTouches(w, b, (id) => id === B.CACTUS)) {
      p.cactusT += dt;
      if (p.cactusT > 0.5) { p.cactusT = 0; this.damagePlayer(1, null, 'was pricked to death'); }
    }
  }

  damagePlayer(n, src, cause = 'was slain', bypass = false) {
    const p = this.player;
    if (!p.alive || p.mode !== 'survival' || n <= 0) return;
    if (p.invuln > 0 && !bypass) return;
    p.health -= n;
    p.hurtT = 0.4;
    p.invuln = 0.5;
    p.exhaustion += 0.1;
    this.audio.play('hurt');
    if (src) {
      const dx = p.x - src.x, dz = p.z - src.z, d = Math.hypot(dx, dz) || 1;
      p.vx = (dx / d) * 6; p.vz = (dz / d) * 6; p.vy = 5;
      cause = `was slain by a ${src.def.name}`;
    }
    if (p.health <= 0) this.die(cause);
  }

  die(cause) {
    const p = this.player;
    p.health = 0;
    p.alive = false;
    for (let i = 0; i < p.inv.slots.length; i++) {
      const s = p.inv.slots[i];
      if (s) this.dropItem(p.x, p.y + 1, p.z, s, [(rand() - 0.5) * 6, 3 + rand() * 3, (rand() - 0.5) * 6]);
    }
    p.inv.clear();
    this.mining = null;
    this.ui.closeInventory(true);
    this.state = 'dead';
    this.ui.showDeath(cause);
  }

  respawn() {
    const p = this.player;
    p.alive = true;
    p.health = 20; p.hunger = 20; p.sat = 5; p.air = 15; p.exhaustion = 0;
    p.vx = p.vy = p.vz = 0;
    [p.x, p.y, p.z] = p.spawn;
    p.peakY = p.y;
    this.state = 'loading';
    this.loadStart = performance.now();
    this.ui.setLoading(0);
  }

  footstep(land) {
    const p = this.player;
    const id = this.world.getBlock(Math.floor(p.x), Math.floor(p.y - 0.2), Math.floor(p.z));
    if (!id || LIQUID[id]) return;
    this.audio.block(BLOCKS[id].sound, land ? 'hit' : 'step');
  }

  lookDir() {
    const p = this.player, cp = Math.cos(p.pitch);
    return [-Math.sin(p.yaw) * cp, Math.sin(p.pitch), -Math.cos(p.yaw) * cp];
  }

  // ---------------------------------------------------------------- interaction
  interact(dt) {
    const p = this.player, w = this.world;
    this.breakCd -= dt;
    this.useCd -= dt;
    const [dx, dy, dz] = this.lookDir();
    const ex = p.x, ey = p.y + p.eye, ez = p.z;
    const reach = p.mode === 'creative' ? 6 : 5;
    const hit = raycast(w, ex, ey, ez, dx, dy, dz, reach);
    let mob = null, mobT = 3.6;
    for (const e of this.entities) {
      if (!(e instanceof Mob) || e.health <= 0) continue;
      const t = rayBox(ex, ey, ez, dx, dy, dz, e.box());
      if (t >= 0 && t < mobT) { mob = e; mobT = t; }
    }
    if (mob && hit && hit.t < mobT) mob = null;
    this.target = hit;
    this.targetMob = mob;
    const held = p.held();
    if (!held || held.id !== this.lastHeldId || p.sel !== this.lastSel) {
      if (p.sel !== this.lastSel || (held ? held.id : -1) !== this.lastHeldId) this.equip = 1;
      this.lastSel = p.sel;
      this.lastHeldId = held ? held.id : -1;
      p.eating = 0;
    }

    // Left button: attack or mine
    if (this.mouse.left) {
      if (mob) {
        if (p.attackCd <= 0) {
          p.attackCd = 0.4;
          this.swing();
          const tool = toolOf(held);
          const dmg = tool ? tool.dmg : 1;
          if (mob.damage(dmg, p, this)) {
            if (tool && p.mode === 'survival') this.damageTool(tool.type === 'sword' ? 1 : 2);
            p.exhaustion += 0.1;
            this.spawnPoof(mob.x, mob.y + mob.h * 0.6, mob.z, 4, [180, 30, 30]);
          }
        }
        this.mining = null;
      } else if (hit) {
        this.mine(hit, dt);
      } else {
        this.mining = null;
        if (this.mouse.leftPressed) { this.swing(); this.audio.play('swing'); }
      }
    } else this.mining = null;
    this.mouse.leftPressed = false;

    // Right button: use / place / eat
    const def = held ? itemDef(held.id) : null;
    if (this.mouse.right && def && def.food && (p.hunger < 20 || p.mode === 'creative') && !(hit && BLOCKS[hit.id].interact && !p.sneaking)) {
      p.eating += dt;
      if (Math.floor(p.eating * 4) !== Math.floor((p.eating - dt) * 4)) { this.audio.play('eat'); this.swing(0.3); }
      if (p.eating >= 1.4) {
        p.eating = 0;
        p.hunger = Math.min(20, p.hunger + def.food);
        p.sat = Math.min(p.hunger, p.sat + def.food * 0.6);
        if (p.mode === 'survival') this.consumeHeld();
        this.audio.play('burp');
      }
    } else {
      p.eating = 0;
      if (this.mouse.right && (this.mouse.rightPressed || this.useCd <= 0)) {
        this.useCd = 0.22;
        this.use(hit, mob);
      }
    }
    this.mouse.rightPressed = false;
  }

  swing(amount = 1) {
    if (this.player.swing >= 1 || amount < 1) this.player.swing = 0;
  }

  mine(hit, dt) {
    const p = this.player;
    const m = this.mining;
    if (!m || m.x !== hit.x || m.y !== hit.y || m.z !== hit.z || m.id !== hit.id) {
      this.mining = { x: hit.x, y: hit.y, z: hit.z, id: hit.id, progress: 0, soundT: 0 };
      if (p.mode === 'creative' && this.mouse.leftPressed) this.breakCd = 0;
    }
    const mm = this.mining;
    if (p.mode === 'creative') {
      if (this.breakCd <= 0) { this.breakBlock(hit.x, hit.y, hit.z, false); this.breakCd = 0.22; this.swing(); }
      return;
    }
    if (this.breakCd > 0) return;
    const bt = breakTime(hit.id, p.held());
    if (!isFinite(bt)) return;
    mm.progress += dt / bt;
    mm.soundT -= dt;
    if (p.swing >= 1) this.swing();
    if (mm.soundT <= 0) {
      mm.soundT = 0.24;
      this.audio.block(BLOCKS[hit.id].sound, 'hit');
      this.spawnBlockParticles(hit.x + 0.5 + hit.nx * 0.52, hit.y + 0.5 + hit.ny * 0.52, hit.z + 0.5 + hit.nz * 0.52, hit.id, 3, 0.4);
    }
    if (mm.progress >= 1) {
      this.breakBlock(hit.x, hit.y, hit.z, true);
      this.mining = null;
      this.breakCd = 0.15;
    }
  }

  breakBlock(x, y, z, survival) {
    const w = this.world, p = this.player;
    const id = w.getBlock(x, y, z);
    if (!id || BLOCKS[id].hardness < 0) return;
    const key = `${x},${y},${z}`;
    const te = w.tileEntities.get(key);
    if (te) {
      for (const s of te.slots) if (s) this.dropItem(x + 0.5, y + 0.5, z + 0.5, s);
      w.tileEntities.delete(key);
      this.ui.containerRemoved(key);
    }
    const below = w.getBlock(x, y - 1, z);
    w.setBlock(x, y, z, id === B.ICE && survival && below !== 0 ? B.WATER : 0);
    this.audio.block(BLOCKS[id].sound, 'break');
    this.spawnBlockParticles(x + 0.5, y + 0.5, z + 0.5, id, 26, 1);
    if (survival) {
      const held = p.held();
      if (canHarvest(id, held)) for (const [did, n] of this.dropsFor(id)) this.dropItem(x + 0.5, y + 0.4, z + 0.5, { id: did, count: n });
      const tool = toolOf(held);
      if (tool && BLOCKS[id].hardness > 0) this.damageTool(tool.type === 'sword' ? 2 : 1);
      p.exhaustion += 0.005;
    }
  }

  dropsFor(id) {
    const d = BLOCKS[id];
    if (d.drop === null) return [];
    if (d.drop === 'leaves') {
      const out = [];
      if (rand() < 0.06) out.push([id === B.BIRCH_LEAVES ? B.BIRCH_SAPLING : id === B.SPRUCE_LEAVES ? B.SPRUCE_SAPLING : B.OAK_SAPLING, 1]);
      if (id === B.LEAVES && rand() < 0.03) out.push([I.APPLE, 1]);
      return out;
    }
    if (id === B.DEAD_BUSH) return rand() < 0.6 ? [[I.STICK, 1 + Math.floor(rand() * 2)]] : [];
    if (id === B.GRAVEL && rand() < 0.1) return [[B.GRAVEL, 1]];
    return [[d.drop === undefined ? id : d.drop, 1]];
  }

  damageTool(n) {
    const p = this.player, held = p.held();
    const tool = toolOf(held);
    if (!tool) return;
    held.dmg = (held.dmg || 0) + n;
    if (held.dmg >= tool.dur) {
      p.inv.set(p.sel, null);
      this.audio.play('toolbreak');
      this.ui.chat(`Your ${itemName(held.id)} broke.`);
    } else p.inv.changed();
  }

  consumeHeld(replaceWith) {
    const p = this.player, held = p.held();
    if (!held) return;
    held.count--;
    if (held.count <= 0) p.inv.set(p.sel, replaceWith ? { id: replaceWith, count: 1 } : null);
    else {
      p.inv.changed();
      if (replaceWith && p.inv.add({ id: replaceWith, count: 1 })) this.dropItem(p.x, p.y + 1.2, p.z, { id: replaceWith, count: 1 });
    }
  }

  use(hit, mob) {
    const p = this.player, w = this.world;
    const held = p.held();
    if (hit && BLOCKS[hit.id].interact && !p.sneaking) {
      this.openContainer(BLOCKS[hit.id].interact, hit);
      return;
    }
    if (!held) return;
    const def = itemDef(held.id);
    const [dx, dy, dz] = this.lookDir();
    if (held.id === I.BUCKET) {
      const lh = raycast(w, p.x, p.y + p.eye, p.z, dx, dy, dz, 5, true);
      if (lh && LIQUID[lh.id]) {
        w.setBlock(lh.x, lh.y, lh.z, 0);
        this.audio.play('splash', { vol: 0.3 });
        if (p.mode === 'survival') this.consumeHeld(lh.id === B.WATER ? I.WATER_BUCKET : I.LAVA_BUCKET);
        this.swing();
      }
      return;
    }
    if (!hit) return;
    let tx = hit.x + hit.nx, ty = hit.y + hit.ny, tz = hit.z + hit.nz;
    if (REPLACEABLE[hit.id] && !LIQUID[hit.id]) { tx = hit.x; ty = hit.y; tz = hit.z; }
    if (ty < 0 || ty >= CH) return;
    const cur = w.getBlock(tx, ty, tz);
    if (cur && !REPLACEABLE[cur]) return;
    if (held.id === I.WATER_BUCKET || held.id === I.LAVA_BUCKET) {
      w.setBlock(tx, ty, tz, held.id === I.WATER_BUCKET ? B.WATER : B.LAVA, 0);
      this.audio.play('splash', { vol: 0.3 });
      if (p.mode === 'survival') this.consumeHeld(I.BUCKET);
      this.swing();
      return;
    }
    if (!def.isBlock) return;
    const bd = BLOCKS[held.id];
    if (bd.solid) {
      const bb = [tx, ty, tz, tx + 1, ty + 1, tz + 1];
      const overlap = (e) => {
        const a = entityBox(e);
        return a[0] < bb[3] - 1e-3 && a[3] > bb[0] + 1e-3 && a[1] < bb[4] - 1e-3 && a[4] > bb[1] + 1e-3 && a[2] < bb[5] - 1e-3 && a[5] > bb[2] + 1e-3;
      };
      if (overlap(p)) return;
      for (const e of this.entities) if (e instanceof Mob && e.health > 0 && overlap(e)) return;
    }
    let meta = 0;
    if (LOG[held.id]) meta = hit.nx ? 1 : hit.nz ? 2 : 0;
    if (bd.support === 'torch') {
      const support = w.getBlock(hit.x, hit.y, hit.z);
      if (hit.ny === 1 && OPAQUE[support]) meta = 0;
      else if (hit.ny === 0 && OPAQUE[support]) meta = hit.nx === 1 ? 1 : hit.nx === -1 ? 2 : hit.nz === 1 ? 3 : 4;
      else if (OPAQUE[w.getBlock(tx, ty - 1, tz)]) meta = 0;
      else return;
    } else if (bd.support && !this.supported(tx, ty, tz, held.id, 0)) return;
    if (bd.front) {
      const lx = dx, lz = dz;
      meta = Math.abs(lx) > Math.abs(lz) ? (lx > 0 ? 1 : 0) : lz > 0 ? 5 : 4;
    }
    w.setBlock(tx, ty, tz, held.id, meta);
    if (bd.interact === 'chest') w.tileEntities.set(`${tx},${ty},${tz}`, { type: 'chest', slots: new Array(27).fill(null) });
    if (bd.interact === 'furnace') w.tileEntities.set(`${tx},${ty},${tz}`, { type: 'furnace', slots: [null, null, null], burn: 0, burnMax: 0, cook: 0 });
    this.audio.block(bd.sound, 'place');
    this.swing();
    if (p.mode === 'survival') this.consumeHeld();
  }

  supported(x, y, z, id, meta) {
    const w = this.world, d = BLOCKS[id];
    const below = w.getBlock(x, y - 1, z);
    switch (d.support) {
      case 'plant': return below === B.GRASS || below === B.DIRT || below === B.SNOWY_GRASS || below === B.PODZOL;
      case 'desert': return below === B.SAND || below === B.RED_SAND || below === B.GRASS || below === B.DIRT || below === B.TERRACOTTA;
      case 'cane': {
        if (below === B.SUGAR_CANE) return true;
        if (below !== B.GRASS && below !== B.DIRT && below !== B.SAND && below !== B.RED_SAND && below !== B.PODZOL) return false;
        return [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => w.getBlock(x + dx, y - 1, z + dz) === B.WATER);
      }
      case 'cactus': return below === B.SAND || below === B.CACTUS;
      case 'torch': {
        if (!meta) return !!OPAQUE[below];
        const off = [null, [-1, 0], [1, 0], [0, -1], [0, 1]][meta];
        return !!OPAQUE[w.getBlock(x + off[0], y, z + off[1])];
      }
    }
    return true;
  }

  processChecks() {
    const w = this.world, q = this.checks;
    let n = 0;
    while (q.length && n++ < 120) {
      const z = q.pop(), y = q.pop(), x = q.pop();
      this.checkCell(x, y, z);
      this.checkCell(x, y + 1, z);
      this.checkCell(x + 1, y, z);
      this.checkCell(x - 1, y, z);
      this.checkCell(x, y, z + 1);
      this.checkCell(x, y, z - 1);
    }
    if (q.length > 3000) q.length = 0;
  }

  checkCell(x, y, z) {
    const w = this.world;
    const id = w.getBlock(x, y, z);
    if (!id) return;
    const d = BLOCKS[id];
    if (d.gravity) {
      const below = w.getBlock(x, y - 1, z);
      if (y > 0 && (below === 0 || LIQUID[below] || REPLACEABLE[below])) {
        w.setBlock(x, y, z, 0);
        this.entities.push(new FallingBlock(x, y, z, id));
      }
      return;
    }
    if (d.support && !this.supported(x, y, z, id, w.getMeta(x, y, z))) {
      w.setBlock(x, y, z, 0);
      if (this.player.mode === 'survival' || id === B.CACTUS) for (const [did, n] of this.dropsFor(id)) this.dropItem(x + 0.5, y + 0.3, z + 0.5, { id: did, count: n });
      this.spawnBlockParticles(x + 0.5, y + 0.5, z + 0.5, id, 8, 0.6);
    }
  }

  dropItem(x, y, z, stack, toss) {
    if (!stack || stack.count <= 0) return;
    this.entities.push(new ItemEntity(x, y, z, { id: stack.id, count: stack.count, dmg: stack.dmg || 0 }, toss));
  }

  dropHeld(all) {
    const p = this.player, held = p.held();
    if (!held) return;
    const n = all ? held.count : 1;
    const [dx, dy, dz] = this.lookDir();
    this.dropItem(p.x, p.y + p.eye - 0.3, p.z, { id: held.id, count: n, dmg: held.dmg }, [dx * 6, dy * 6 + 2, dz * 6]);
    held.count -= n;
    if (held.count <= 0) p.inv.set(p.sel, null);
    else p.inv.changed();
    this.swing();
  }

  tossStack(stack) {
    const p = this.player;
    const [dx, dy, dz] = this.lookDir();
    this.dropItem(p.x, p.y + p.eye - 0.3, p.z, stack, [dx * 5, dy * 5 + 2, dz * 5]);
  }

  pickBlock() {
    const p = this.player, hit = this.target;
    if (!hit) return;
    let id = hit.id;
    if (!BLOCKS[id].creative) return;
    const idx = p.inv.find(id);
    if (idx >= 0 && idx < 9) { p.sel = idx; return; }
    if (p.mode === 'creative') {
      const empty = p.inv.slots.slice(0, 9).findIndex((s) => !s);
      const slot = p.inv.get(p.sel) && empty >= 0 ? empty : p.sel;
      p.inv.set(slot, { id, count: maxStackOf(id) });
      p.sel = slot;
    } else if (idx >= 9) {
      const tmp = p.inv.get(p.sel);
      p.inv.set(p.sel, p.inv.get(idx));
      p.inv.set(idx, tmp);
    }
  }

  openContainer(kind, hit) {
    const key = `${hit.x},${hit.y},${hit.z}`;
    const w = this.world;
    let te = w.tileEntities.get(key);
    if (kind === 'chest' && !te) w.tileEntities.set(key, (te = { type: 'chest', slots: new Array(27).fill(null) }));
    if (kind === 'furnace' && !te) w.tileEntities.set(key, (te = { type: 'furnace', slots: [null, null, null], burn: 0, burnMax: 0, cook: 0 }));
    this.audio.block('wood', 'place');
    this.ui.openInventory(kind, { key, te });
  }

  // ---------------------------------------------------------------- ticks
  gameTick() {
    const w = this.world;
    w.tick++;
    w.time += 1;
    if (w.time >= 24000) { w.time -= 24000; w.day = (w.day || 0) + 1; }
    w.tickFluids();
    this.randomTicks();
    this.tickFurnaces();
    this.spawnT++;
    if (this.spawnT >= 20) { this.spawnT = 0; this.spawnMobs(); }
  }

  randomTicks() {
    const w = this.world, p = this.player;
    const pcx = Math.floor(p.x / 16), pcz = Math.floor(p.z / 16);
    for (let dz = -4; dz <= 4; dz++) for (let dx = -4; dx <= 4; dx++) {
      const c = w.getChunk(pcx + dx, pcz + dz);
      if (!c) continue;
      for (let k = 0; k < 20; k++) {
        const i = (rand() * 32768) | 0;
        const id = c.blocks[i];
        if (id === B.SUGAR_CANE) {
          if (rand() < 0.15 && i + 256 < 32768 && c.blocks[i + 256] === 0) {
            const x = c.cx * 16 + (i & 15), y = i >> 8, z = c.cz * 16 + ((i >> 4) & 15);
            let h = 1;
            while (h < 4 && w.getBlock(x, y - h, z) === B.SUGAR_CANE) h++;
            if (h < 3) w.setBlock(x, y + 1, z, B.SUGAR_CANE);
          }
          continue;
        }
        if (id !== B.GRASS && id !== B.DIRT && id !== B.OAK_SAPLING && id !== B.BIRCH_SAPLING && id !== B.SPRUCE_SAPLING) continue;
        const x = c.cx * 16 + (i & 15), y = i >> 8, z = c.cz * 16 + ((i >> 4) & 15);
        const above = y < CH - 1 ? c.blocks[i + 256] : 0;
        if (id === B.GRASS) {
          if (OPAQUE[above] || LIQUID[above]) w.setBlock(x, y, z, B.DIRT);
        } else if (id === B.DIRT) {
          if (OPAQUE[above] || LIQUID[above] || (y < CH - 1 && c.light[i + 256] >> 4) < 4) continue;
          const nx = x + Math.floor(rand() * 3) - 1, ny = y + Math.floor(rand() * 3) - 1, nz = z + Math.floor(rand() * 3) - 1;
          if (w.getBlock(nx, ny, nz) === B.GRASS) w.setBlock(x, y, z, B.GRASS);
        } else if (rand() < 0.12) this.growSapling(x, y, z, id);
      }
    }
  }

  growSapling(x, y, z, id) {
    const w = this.world;
    for (let k = 1; k < 7; k++) {
      const b = w.getBlock(x, y + k, z);
      if (b && !REPLACEABLE[b] && !BLOCKS[b].leaf) return;
    }
    const type = id === B.BIRCH_SAPLING ? 'birch' : id === B.SPRUCE_SAPLING ? 'spruce' : 'oak';
    w.setBlock(x, y, z, 0);
    placeTree((tx, ty, tz, bid, onlyAir, meta = 0) => {
      const cur = w.getBlock(tx, ty, tz);
      if (onlyAir && cur !== 0 && !REPLACEABLE[cur]) return;
      w.setBlock(tx, ty, tz, bid, meta);
    }, x, y, z, type, rand());
  }

  tickFurnaces() {
    const w = this.world;
    for (const [key, te] of w.tileEntities) {
      if (te.type !== 'furnace') continue;
      const [x, , z] = key.split(',').map(Number);
      if (!w.isLoaded(x, z)) continue;
      const [input, fuel, output] = te.slots;
      const res = input ? SMELT[input.id] : undefined;
      const can = res !== undefined && (!output || (output.id === res && output.count < maxStackOf(res)));
      if (te.burn > 0) te.burn -= TICK;
      if (te.burn <= 0 && can && fuel && fuelTime(fuel.id) > 0) {
        te.burn = te.burnMax = fuelTime(fuel.id);
        if (fuel.id === I.LAVA_BUCKET) te.slots[1] = { id: I.BUCKET, count: 1 };
        else { fuel.count--; if (fuel.count <= 0) te.slots[1] = null; }
        te.v = (te.v || 0) + 1;
      }
      if (te.burn > 0 && can) {
        te.cook += TICK;
        if (te.cook >= SMELT_TIME) {
          te.cook = 0;
          input.count--;
          if (input.count <= 0) te.slots[0] = null;
          if (output) output.count++;
          else te.slots[2] = { id: res, count: 1 };
          te.v = (te.v || 0) + 1;
        }
      } else te.cook = Math.max(0, te.cook - TICK * 2);
    }
  }

  spawnMobs() {
    const p = this.player, w = this.world;
    let hostile = 0, passive = 0;
    for (const e of this.entities) {
      if (!(e instanceof Mob)) continue;
      const d = Math.hypot(e.x - p.x, e.z - p.z);
      if (d > 110 || (e.def.hostile && d > 50 && rand() < 0.05) || (e.def.hostile && this.daylight > 0.8 && d > 24 && rand() < 0.02)) { e.dead = true; continue; }
      if (e.def.hostile) hostile++; else passive++;
    }
    if (hostile < 10) {
      for (let attempt = 0; attempt < 6; attempt++) {
        const a = rand() * Math.PI * 2, r = 18 + rand() * 26;
        const x = Math.floor(p.x + Math.cos(a) * r), z = Math.floor(p.z + Math.sin(a) * r);
        if (!w.isLoaded(x, z)) continue;
        let y;
        if (rand() < 0.5) {
          for (y = CH - 2; y > 1 && !w.isSolid(x, y - 1, z); y--);
        } else y = Math.floor(p.y) + Math.floor(rand() * 24) - 16;
        if (y < 2 || y >= CH - 2) continue;
        if (!OPAQUE[w.getBlock(x, y - 1, z)] || w.getBlock(x, y, z) !== 0 || w.getBlock(x, y + 1, z) !== 0) continue;
        const L = w.getLight(x, y, z);
        if (Math.max((L >> 4) * this.daylight, L & 15) >= 7) continue;
        this.entities.push(new Mob('ghoul', x + 0.5, y, z + 0.5));
        break;
      }
    }
    if (passive < 14 && this.daylight > 0.6 && rand() < 0.06) {
      const a = rand() * Math.PI * 2, r = 30 + rand() * 30;
      const x = Math.floor(p.x + Math.cos(a) * r), z = Math.floor(p.z + Math.sin(a) * r);
      if (!w.isLoaded(x, z)) return;
      let y;
      for (y = CH - 2; y > 1 && !w.isSolid(x, y - 1, z); y--);
      if (w.getBlock(x, y - 1, z) !== B.GRASS) return;
      const type = ['pig', 'cow', 'sheep'][Math.floor(rand() * 3)];
      const n = 2 + Math.floor(rand() * 3);
      for (let i = 0; i < n; i++) this.entities.push(new Mob(type, x + 0.5 + rand() - 0.5, y, z + 0.5 + rand() - 0.5));
    }
  }

  onMobDeath(m) {
    this.spawnPoof(m.x, m.y + m.h * 0.5, m.z, 14, [230, 230, 230]);
    for (const [id, n] of m.def.drops()) this.dropItem(m.x, m.y + 0.5, m.z, { id, count: n });
  }

  // ---------------------------------------------------------------- particles
  spawnBlockParticles(x, y, z, id, n, spread) {
    const d = BLOCKS[id];
    const layer = TEXL[id * 6 + (id === B.GRASS ? 3 : 0)];
    const tint = d.tint >= 2 ? [124, 189, 82] : [255, 255, 255];
    for (let i = 0; i < n; i++) {
      if (this.particles.length > 800) break;
      this.particles.push({
        x: x + (rand() - 0.5) * spread, y: y + (rand() - 0.5) * spread, z: z + (rand() - 0.5) * spread,
        vx: (rand() - 0.5) * 4, vy: rand() * 4 + 1, vz: (rand() - 0.5) * 4,
        life: 0.4 + rand() * 0.7, size: 0.05 + rand() * 0.04, layer, u: rand() * 0.75, v: rand() * 0.75, uvs: 0.25,
        tint, bright: 230, light: [255, 0], grav: 18,
      });
    }
  }
  spawnPoof(x, y, z, n, color) {
    for (let i = 0; i < n; i++) {
      this.particles.push({
        x: x + (rand() - 0.5) * 0.6, y: y + (rand() - 0.5) * 0.6, z: z + (rand() - 0.5) * 0.6,
        vx: (rand() - 0.5) * 2, vy: rand() * 1.5, vz: (rand() - 0.5) * 2,
        life: 0.5 + rand() * 0.5, size: 0.08 + rand() * 0.08, layer: TEXL[B.WOOL_WHITE * 6], u: 0, v: 0, uvs: 1,
        tint: color, bright: 255, light: [255, 0], grav: -1,
      });
    }
  }
  spawnSplash(x, y, z) {
    for (let i = 0; i < 16; i++) {
      this.particles.push({
        x: x + (rand() - 0.5), y: y + 0.2, z: z + (rand() - 0.5), vx: (rand() - 0.5) * 2, vy: 2 + rand() * 3, vz: (rand() - 0.5) * 2,
        life: 0.6, size: 0.05, layer: TEXL[B.WATER * 6], u: rand() * 0.75, v: rand() * 0.75, uvs: 0.25, tint: [255, 255, 255], bright: 255, light: [255, 0], grav: 16,
      });
    }
  }
  // Small flames and smoke rising from torches near the player.
  torchEffects(dt) {
    const p = this.player, w = this.world;
    this.torchScanT = (this.torchScanT || 0) - dt;
    if (this.torchScanT <= 0) {
      this.torchScanT = 2;
      const list = [];
      const pcx = Math.floor(p.x / 16), pcz = Math.floor(p.z / 16);
      const y0 = Math.max(0, Math.floor(p.y) - 20), y1 = Math.min(CH - 1, Math.floor(p.y) + 20);
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        const c = w.getChunk(pcx + dx, pcz + dz);
        if (!c) continue;
        for (let i = y0 << 8; i < (y1 + 1) << 8; i++) {
          if (c.blocks[i] === B.TORCH) list.push([c.cx * 16 + (i & 15), i >> 8, c.cz * 16 + ((i >> 4) & 15), c.meta[i]]);
        }
      }
      this.torches = list;
    }
    if (!this.torches || !this.torches.length) return;
    this.flameT = (this.flameT || 0) - dt;
    while (this.flameT <= 0) {
      this.flameT += 0.6 / this.torches.length + 0.02;
      const [x, y, z, m] = this.torches[Math.floor(rand() * this.torches.length)];
      if (w.getBlock(x, y, z) !== B.TORCH) continue;
      const off = [null, [-1, 0], [1, 0], [0, -1], [0, 1]][m] || [0, 0];
      const tx = x + 0.5 + off[0] * 0.08, ty = y + (m ? 0.86 : 0.66), tz = z + 0.5 + off[1] * 0.08;
      const smoke = rand() < 0.4;
      this.particles.push({
        x: tx + (rand() - 0.5) * 0.04, y: ty, z: tz + (rand() - 0.5) * 0.04, vx: 0, vy: smoke ? 0.5 : 0.08, vz: 0,
        life: smoke ? 1 + rand() * 0.6 : 0.35, size: smoke ? 0.045 : 0.035, layer: LAYERS[smoke ? 'white' : 'flame'],
        u: 0, v: 0, uvs: 1, tint: smoke ? [70, 70, 70] : [255, 255, 255], bright: 255, light: [255, 255], grav: smoke ? -0.3 : 0, glow: !smoke,
      });
    }
  }

  updateParticles(dt) {
    const w = this.world;
    for (const p of this.particles) {
      p.life -= dt;
      p.vy -= p.grav * dt;
      const nx = p.x + p.vx * dt, ny = p.y + p.vy * dt, nz = p.z + p.vz * dt;
      if (w.isSolid(Math.floor(nx), Math.floor(ny), Math.floor(nz))) { p.vx *= 0.3; p.vz *= 0.3; p.vy = 0; }
      else { p.x = nx; p.y = ny; p.z = nz; }
      if (p.glow) continue;
      const L = w.getLight(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
      p.light = [(L >> 4) * 17, (L & 15) * 17];
    }
    this.particles = this.particles.filter((p) => p.life > 0);
  }

  // ---------------------------------------------------------------- rendering
  skyState(cam) {
    const t = this.world.time / 24000;
    const ang = t * Math.PI * 2;
    const sunDir = [Math.cos(ang), Math.sin(ang), 0];
    const sh = sunDir[1];
    const day = smooth((sh + 0.2) / 0.5);
    this.daylight = 0.18 + 0.82 * smooth((sh + 0.12) / 0.4);
    const mixc = (a, b, k) => [lerp(a[0], b[0], k), lerp(a[1], b[1], k), lerp(a[2], b[2], k)];
    const top = mixc([0.01, 0.014, 0.04], [0.32, 0.56, 0.98], day);
    const horizon = mixc([0.035, 0.05, 0.1], [0.7, 0.83, 1.0], day);
    const sunsetK = Math.exp(-((sh / 0.2) ** 2));
    const sunset = [1.0 * sunsetK * 0.9, 0.42 * sunsetK * 0.9, 0.16 * sunsetK * 0.9];
    const [lx, , lz] = this.lookDir();
    const toward = Math.max(0, lx * sunDir[0] + lz * sunDir[2]);
    const fog = [horizon[0] + sunset[0] * toward * 0.45, horizon[1] + sunset[1] * toward * 0.45, horizon[2] + sunset[2] * toward * 0.45];
    const cloud = mixc([0.1, 0.11, 0.16], [1, 1, 1], day);
    cloud[0] += sunset[0] * 0.4; cloud[1] += sunset[1] * 0.3;
    return { sunDir, top, horizon, sunset, night: 1 - smooth((sh + 0.28) / 0.3), starRot: ang, fog, cloud };
  }

  cameraState() {
    const p = this.player;
    let x = p.x, y = p.y + (p.sneaking ? p.eye - 0.12 : p.eye), z = p.z;
    let yaw = p.yaw, pitch = p.pitch, roll = 0;
    if (this.settings.bob && this.state !== 'menu' && this.cameraMode === 0) {
      const b = p.bobAmt;
      const s = Math.sin(p.bobPhase), c = Math.cos(p.bobPhase);
      x += Math.cos(yaw) * s * 0.045 * b;
      z += -Math.sin(yaw) * s * 0.045 * b;
      y += Math.abs(c) * 0.07 * b - 0.03 * b;
      roll = s * 0.008 * b;
    }
    if (p.hurtT > 0) roll += Math.sin(p.hurtT * 20) * p.hurtT * 0.12;
    if (this.cameraMode !== 0) {
      const back = this.cameraMode === 1 ? 1 : -1;
      const [dx, dy, dz] = this.lookDir();
      const hit = raycast(this.world, x, y, z, -dx * back, -dy * back, -dz * back, 4);
      const dist = hit ? Math.max(0.3, hit.t - 0.3) : 4;
      x -= dx * back * dist; y -= dy * back * dist; z -= dz * back * dist;
      if (this.cameraMode === 2) { yaw += Math.PI; pitch = -pitch; }
    }
    const fov = this.settings.fov * (1 + p.fovBoost * 0.12) * (p.flying && p.sprinting ? 1.08 : 1);
    return { x, y, z, yaw, pitch, roll, fov };
  }

  render(dt) {
    const p = this.player, w = this.world;
    const cam = this.cameraState();
    const sky = this.skyState(cam);
    const R = this.state === 'menu' ? Math.min(this.settings.renderDist, 7) : this.settings.renderDist;
    const far = R * 16 + 24;
    let fog = { color: sky.fog, start: R * 16 * 0.55, end: R * 16 * 0.95 };
    const eyeLiquid = LIQUID[w.getBlock(Math.floor(cam.x), Math.floor(cam.y), Math.floor(cam.z))];
    if (eyeLiquid === 1) fog = { color: [0.06 * this.daylight + 0.01, 0.16 * this.daylight + 0.02, 0.38 * this.daylight + 0.05], start: 0, end: 28 };
    else if (eyeLiquid === 2) fog = { color: [0.85, 0.3, 0.05], start: 0, end: 2.5 };
    const ents = [];
    for (const e of this.entities) {
      if (Math.abs(e.x - p.x) > far || Math.abs(e.z - p.z) > far) continue;
      for (const d of e.draws(this, cam)) ents.push(d);
    }
    if (this.cameraMode !== 0 && this.state !== 'menu' && p.alive) {
      const held = p.held();
      for (const d of poseDraws(this, cam, 'player', p, {
        bodyYaw: p.bodyYaw, headYaw: angleDiff(p.yaw, p.bodyYaw), headPitch: p.pitch,
        phase: p.limbPhase, amount: p.limbAmt, swing: p.swing, sneak: p.sneaking,
        held: held ? held.id : null, color: p.hurtT > 0 ? [1, 0.5, 0.5, 1] : null,
      })) ents.push(d);
    }
    const shadows = [];
    const addShadow = (e, r) => {
      const bx = Math.floor(e.x), bz = Math.floor(e.z);
      for (let by = Math.floor(e.y + 0.01); by > e.y - 4; by--) {
        if (SOLID[w.getBlock(bx, by - 1, bz)] && !SOLID[w.getBlock(bx, by, bz)]) {
          const a = 0.55 * (1 - (e.y - by) / 4);
          if (a > 0.02) shadows.push({ x: e.x, y: by, z: e.z, r, a });
          return;
        }
      }
    };
    for (const e of this.entities) {
      if (Math.abs(e.x - p.x) > 40 || Math.abs(e.z - p.z) > 40) continue;
      if (e instanceof Mob) addShadow(e, e.w * 1.5);
      else if (e instanceof ItemEntity) addShadow(e, 0.45);
    }
    if (this.cameraMode !== 0 && this.state !== 'menu' && p.alive) addShadow(p, 0.9);
    this.cloudOffset += dt * 1.2;
    const L = w.getLight(Math.floor(p.x), Math.floor(p.y + p.eye), Math.floor(p.z));
    const frame = {
      cam, far, fog, daylight: this.daylight, time: this.time, gamma: this.settings.gamma,
      sky: { sunDir: sky.sunDir, top: sky.top, horizon: sky.horizon, sunset: sky.sunset, night: sky.night, starRot: sky.starRot },
      chunks: this.chunkList || [], entities: ents, particles: this.particles, shadows,
      selection: this.state === 'play' && this.target && !this.hudHidden ? this.target : null,
      crack: this.mining && this.mining.progress > 0 ? { x: this.mining.x, y: this.mining.y, z: this.mining.z, stage: Math.floor(this.mining.progress * 10) } : null,
      clouds: this.settings.clouds ? { offset: this.cloudOffset, color: sky.cloud } : null,
      underwater: eyeLiquid === 1,
      hand: this.state !== 'menu' && this.cameraMode === 0 && p.alive && !this.hudHidden ? this.handState(dt, [(L >> 4) / 15, (L & 15) / 15]) : null,
    };
    this.renderer.render(frame);
  }

  handState(dt, light) {
    const p = this.player, M = this.M;
    this.equip = Math.max(0, this.equip - dt * 5);
    const held = p.held();
    const s = p.swing < 1 ? p.swing : 0;
    const sw = Math.sin(s * Math.PI), sw2 = Math.sin(Math.sqrt(s) * Math.PI);
    const bob = this.settings.bob ? p.bobAmt : 0;
    const bx = Math.sin(p.bobPhase) * 0.02 * bob, by = -Math.abs(Math.cos(p.bobPhase)) * 0.025 * bob;
    const eat = p.eating > 0 ? Math.sin(p.eating * 16) * 0.03 : 0;
    const drop = this.equip * 0.4;
    M.identity();
    if (!held) {
      if (!this.armMesh) this.armMesh = this.renderer.upload(boxMesh(-2, -12, -2, 4, 12, 4, ['wd_arm_side', 'wd_arm_inner', 'wd_arm_top', 'wd_arm_bottom', 'wd_arm_inner', 'wd_arm_inner'].map(L)));
      M.translate(0.5 + bx - sw2 * 0.2, -0.5 + by - drop + sw * 0.12, -0.12 - sw2 * 0.12)
        .rotateY(0.36 + sw2 * 0.35).rotateX(1.95 - sw * 0.5).rotateZ(-0.1).scale(0.045);
      return { mesh: this.armMesh, model: M.m, light };
    }
    const m = this.renderer.itemMesh(held.id);
    if (!m.flat) {
      M.translate(0.48 + bx - sw2 * 0.25, -0.44 + by - drop + sw * 0.15 + eat, -0.72 - sw2 * 0.15)
        .rotateX(-sw * 0.6).rotateY(0.78 - sw2 * 0.3).scale(0.36);
      return { mesh: m.mesh, model: M.m, light };
    }
    M.translate(0.54 + bx - sw2 * 0.25, -0.4 + by - drop + sw * 0.1 + eat, -0.72 - sw2 * 0.1)
      .rotateY(-1.15).rotateZ(0.25 + sw * 0.9).rotateX(-sw2 * 0.25).scale(0.5);
    return { mesh: m.mesh, model: M.m, light, noCull: true };
  }

  // ---------------------------------------------------------------- commands
  command(text) {
    const p = this.player, w = this.world;
    const [cmd, ...args] = text.slice(1).trim().split(/\s+/);
    const say = (m, kind) => this.ui.chat(m, kind);
    switch ((cmd || '').toLowerCase()) {
      case 'help':
        say('/gamemode survival|creative, /time set day|night|<n>, /give <item> [count], /tp x y z, /spawn, /setspawn, /seed, /kill, /clear');
        break;
      case 'gamemode': case 'gm': {
        const m = (args[0] || '').toLowerCase();
        const mode = m.startsWith('c') || m === '1' ? 'creative' : m.startsWith('s') || m === '0' ? 'survival' : null;
        if (!mode) return say('Usage: /gamemode survival|creative', 'warn');
        p.mode = mode;
        if (mode === 'survival') p.flying = false;
        say(`Game mode set to ${mode}.`);
        break;
      }
      case 'time': {
        const v = (args[1] || args[0] || '').toLowerCase();
        const map = { day: 1000, noon: 6000, sunset: 12000, night: 13500, midnight: 18000, sunrise: 23500 };
        const t = map[v] ?? parseInt(v, 10);
        if (Number.isNaN(t)) return say('Usage: /time set day|noon|night|midnight|<0-23999>', 'warn');
        w.time = ((t % 24000) + 24000) % 24000;
        say(`Time set to ${w.time}.`);
        break;
      }
      case 'give': {
        const count = parseInt(args[args.length - 1], 10);
        const name = (Number.isNaN(count) ? args : args.slice(0, -1)).join(' ');
        const id = nameToId(name);
        if (id === undefined || !itemDef(id) || id === B.AIR) return say(`Unknown item "${name}". Try names like stone, torch, diamond_pickaxe.`, 'warn');
        const n = Number.isNaN(count) ? 1 : clamp(count, 1, 64 * 36);
        const left = p.inv.add({ id, count: n });
        if (left) this.dropItem(p.x, p.y + 1, p.z, { id, count: left });
        say(`Gave ${n} ${itemName(id)}.`);
        break;
      }
      case 'tp': {
        const [x, y, z] = args.map(Number);
        if ([x, y, z].some((v) => Number.isNaN(v))) return say('Usage: /tp x y z', 'warn');
        p.x = x; p.y = y; p.z = z; p.vy = 0; p.peakY = y;
        say(`Teleported to ${x} ${y} ${z}.`);
        break;
      }
      case 'spawn': [p.x, p.y, p.z] = p.spawn; p.peakY = p.y; say('Teleported to spawn.'); break;
      case 'setspawn': p.spawn = [p.x, p.y, p.z]; say('Spawn point set here.'); break;
      case 'seed': say(`Seed: ${w.seed}`); break;
      case 'kill': p.mode === 'survival' ? this.die('gave up') : say('You are in creative mode.'); break;
      case 'clear': p.inv.clear(); say('Inventory cleared.'); break;
      default: say(`Unknown command /${cmd}. Type /help.`, 'warn');
    }
  }

  debugText() {
    const p = this.player, w = this.world;
    const bx = Math.floor(p.x), by = Math.floor(p.y), bz = Math.floor(p.z);
    const L = w.getLight(bx, by, bz);
    const h = this.gen.heightAt(bx, bz);
    const [dx, , dz] = this.lookDir();
    const facing = Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? 'east (+X)' : 'west (-X)') : dz > 0 ? 'south (+Z)' : 'north (-Z)';
    const t = this.target;
    return [
      `Blockhaven  ${this.fps} fps`,
      `XYZ: ${p.x.toFixed(2)} / ${p.y.toFixed(2)} / ${p.z.toFixed(2)}`,
      `Block: ${bx} ${by} ${bz}  Chunk: ${bx >> 4} ${bz >> 4}`,
      `Facing: ${facing}`,
      `Biome: ${BIOME_NAMES[this.gen.biomeAt(bx, bz, h)]}`,
      `Light: sky ${L >> 4}, block ${L & 15}`,
      `Day ${(w.day || 0) + 1}, time ${Math.floor(w.time)}`,
      `Chunks: ${w.chunks.size} loaded, ${this.renderer.stats.chunks} drawn, ${(this.renderer.stats.quads / 1000).toFixed(0)}k faces`,
      `Entities: ${this.entities.length}  Particles: ${this.particles.length}`,
      t ? `Looking at: ${BLOCKS[t.id].name} (${t.x}, ${t.y}, ${t.z})` : 'Looking at: nothing',
      `Seed: ${w.seed}`,
    ].join('\n');
  }
}

