// DOM user interface: menus, HUD, inventory screens, chat and input wiring.
import { iconURL, hudIcon } from './textures.js';
import { itemDef, itemName, maxStackOf, creativeList, toolOf, I } from './blocks.js';
import { matchCraft, canMerge, SMELT, fuelTime, SMELT_TIME } from './crafting.js';
import { Store } from './save.js';

const $ = (id) => document.getElementById(id);
const TIPS = [
  'Sneaking with Shift keeps you from walking off ledges.',
  'Torches stop ghouls from appearing nearby.',
  'Smelt sand in a furnace to make glass.',
  'Cobblestone in a furnace becomes smooth stone.',
  'Leaves sometimes drop saplings. Plant them on grass or dirt.',
  'Diamonds hide deep underground, below height 16.',
  'Hold right click with food to eat.',
  'Press F3 to see your coordinates and the biome.',
];

function hashSeed(text) {
  if (!text) return Math.floor(Math.random() * 2147483647);
  if (/^-?\d+$/.test(text)) return parseInt(text, 10) | 0;
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (Math.imul(h, 31) + text.charCodeAt(i)) | 0;
  return h;
}

export class UI {
  constructor() {
    this.cursor = null;
    this.inv = null;
    this.slots = [];
    this.hovered = null;
    this.prevScreen = 'main';
    this.chatOpen = false;
    this.lines = [];
    this.hud = { inv: -1, sel: -1, health: -1, food: -1, air: -2, mode: '' };
    this.newMode = 'survival';
    this.noLock = false;
    this.suppressPause = false;
    this.lastTapW = 0;
    this.lastTapSpace = 0;
    this.nameT = 0;
    this.debugT = 0;
    this.icons = {};
    for (const k of ['heart_full', 'heart_half', 'heart_empty', 'food_full', 'food_half', 'food_empty', 'air']) this.icons[k] = hudIcon(k);
  }

  attach(game) {
    this.game = game;
    document.body.classList.toggle('touch', this.isTouch());
    this.buildHUD();
    this.wireMenus();
    this.wireInput();
    this.wireTouch();
  }

  // ------------------------------------------------------------ screens
  showMenu(name) {
    for (const el of document.querySelectorAll('.screen')) el.hidden = true;
    if (name) {
      const el = $(`menu-${name}`);
      if (el) el.hidden = false;
      if (name === 'worlds') this.renderWorlds();
      if (name === 'settings') this.renderSettings();
    }
    $('hud').hidden = !(this.game.state === 'play' || this.game.state === 'paused' || this.game.state === 'dead') || !!(name && name !== 'pause' && name !== 'death' && name !== 'settings' && name !== 'controls');
    this.updateTouchVisibility();
  }

  setLoading(p) {
    const el = $('loading');
    if (p === null) { el.hidden = true; return; }
    if (el.hidden) {
      for (const s of document.querySelectorAll('.screen')) s.hidden = true;
      el.hidden = false;
      $('loading-tip').textContent = TIPS[Math.floor(Math.random() * TIPS.length)];
      $('hud').hidden = true;
    }
    $('loading-bar').style.width = `${Math.round(p * 100)}%`;
  }

  onEnterPlay() {
    this.showMenu(null);
    $('hud').hidden = false;
    this.hud.inv = -1;
    this.lock();
    this.updateTouchVisibility();
  }

  pause() {
    const g = this.game;
    if (g.state !== 'play') return;
    this.closeInventory(true);
    this.closeChat();
    g.state = 'paused';
    g.saveAll();
    g.keys.clear();
    g.mouse.left = g.mouse.right = false;
    this.showMenu('pause');
  }

  resume() {
    const g = this.game;
    if (g.state !== 'paused') return;
    g.state = 'play';
    this.showMenu(null);
    $('hud').hidden = false;
    this.lock();
  }

  showDeath(cause) {
    $('death-cause').textContent = `You ${cause}.`;
    this.unlock();
    this.showMenu('death');
    $('hud').hidden = false;
  }

  // ------------------------------------------------------------ pointer lock
  isTouch() {
    return matchMedia('(pointer: coarse)').matches;
  }
  lock() {
    if (this.isTouch()) return;
    const c = this.game.canvas;
    if (document.pointerLockElement === c) { $('clicktoplay').hidden = true; return; }
    try {
      const r = c.requestPointerLock();
      if (r && r.catch) r.catch(() => this.lockFailed());
    } catch {
      this.lockFailed();
    }
  }
  unlock() {
    if (document.pointerLockElement) {
      this.suppressPause = true;
      document.exitPointerLock();
    }
  }
  lockFailed() {
    // Some embedded browsers refuse pointer lock; fall back to free mouse look.
    if (!document.pointerLockElement && this.game.state === 'play') {
      this.noLock = true;
      $('clicktoplay').hidden = true;
    }
  }

  // ------------------------------------------------------------ menus
  wireMenus() {
    const g = this.game;
    const click = (id, fn) => $(id).addEventListener('click', () => { g.audio.init(); g.audio.play('click'); fn(); });
    click('btn-play', () => this.showMenu('worlds'));
    click('btn-settings-main', () => { this.prevScreen = 'main'; this.showMenu('settings'); });
    click('btn-controls', () => { this.prevScreen = 'main'; this.showMenu('controls'); });
    click('btn-controls-pause', () => { this.prevScreen = 'pause'; this.showMenu('controls'); });
    click('btn-controls-back', () => this.showMenu(this.prevScreen));
    click('btn-worlds-back', () => this.showMenu('main'));
    click('btn-new-world', () => {
      const n = Store.listWorlds().length;
      $('new-name').value = n ? `World ${n + 1}` : 'New World';
      $('new-seed').value = '';
      this.showMenu('create');
      $('new-name').focus();
    });
    click('btn-create-cancel', () => this.showMenu('worlds'));
    for (const b of document.querySelectorAll('#mode-seg .seg-btn')) {
      b.addEventListener('click', () => {
        this.newMode = b.dataset.mode;
        for (const o of document.querySelectorAll('#mode-seg .seg-btn')) {
          o.classList.toggle('on', o === b);
          o.setAttribute('aria-checked', o === b ? 'true' : 'false');
        }
        $('mode-desc').textContent = this.newMode === 'survival'
          ? 'Gather resources, craft tools, keep fed and survive the nights.'
          : 'Unlimited blocks, instant mining and flight. Build anything.';
      });
    }
    $('create-form').addEventListener('submit', (e) => {
      e.preventDefault();
      g.audio.init();
      const name = $('new-name').value.trim() || 'New World';
      const seed = hashSeed($('new-seed').value.trim());
      const meta = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name, seed, mode: this.newMode, created: Date.now(), lastPlayed: Date.now() };
      this.startWorld(meta);
    });
    click('btn-resume', () => this.resume());
    click('btn-settings-pause', () => { this.prevScreen = 'pause'; this.showMenu('settings'); });
    click('btn-quit', () => { g.quitToTitle(); });
    click('btn-settings-done', () => { this.showMenu(this.prevScreen); });
    click('btn-respawn', () => { g.respawn(); });
    click('btn-death-title', () => { g.quitToTitle(); });
    $('clicktoplay').addEventListener('click', () => this.lock());

    const keys = ['renderDist', 'fov', 'sensitivity', 'gamma', 'music', 'sfx', 'scale'];
    const fmt = {
      renderDist: (v) => `${v} chunks`, fov: (v) => `${v}°`, sensitivity: (v) => `${Math.round(v * 100)}%`,
      gamma: (v) => `${Math.round(v * 100)}%`, music: (v) => `${Math.round(v * 100)}%`, sfx: (v) => `${Math.round(v * 100)}%`,
      scale: (v) => `${Math.round(v * 100)}%`,
    };
    for (const k of keys) {
      $(`set-${k}`).addEventListener('input', (e) => {
        g.settings[k] = parseFloat(e.target.value);
        $(`out-${k}`).textContent = fmt[k](g.settings[k]);
        g.applySettings();
      });
    }
    this.fmt = fmt;
    for (const k of ['bob', 'fancyLeaves', 'clouds', 'invertY', 'post']) {
      $(`set-${k}`).addEventListener('change', (e) => { g.settings[k] = e.target.checked; g.applySettings(); });
    }
  }

  renderSettings() {
    const s = this.game.settings;
    for (const k of ['renderDist', 'fov', 'sensitivity', 'gamma', 'music', 'sfx', 'scale']) {
      $(`set-${k}`).value = s[k];
      $(`out-${k}`).textContent = this.fmt[k](s[k]);
    }
    for (const k of ['bob', 'fancyLeaves', 'clouds', 'invertY', 'post']) $(`set-${k}`).checked = !!s[k];
  }

  renderWorlds() {
    const list = $('world-list');
    list.innerHTML = '';
    const worlds = Store.listWorlds();
    if (!Store.available()) {
      const p = document.createElement('p');
      p.className = 'empty-note';
      p.textContent = 'Browser storage is blocked here, so worlds will not be saved after you close the page.';
      list.appendChild(p);
    }
    if (!worlds.length) {
      const p = document.createElement('p');
      p.className = 'empty-note';
      p.textContent = 'No worlds yet. Create one to start playing.';
      list.appendChild(p);
      return;
    }
    for (const w of worlds) {
      const row = document.createElement('div');
      row.className = 'world';
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = w.name;
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = `${w.mode === 'creative' ? 'Creative' : 'Survival'} · last played ${new Date(w.lastPlayed).toLocaleDateString()}`;
      const acts = document.createElement('div');
      acts.className = 'acts';
      const play = document.createElement('button');
      play.className = 'btn primary small';
      play.textContent = 'Play';
      play.addEventListener('click', () => { this.game.audio.init(); this.startWorld(w); });
      const del = document.createElement('button');
      del.className = 'btn small';
      del.textContent = 'Delete';
      del.addEventListener('click', () => {
        if (del.dataset.confirm) { Store.deleteWorld(w.id); this.renderWorlds(); return; }
        del.dataset.confirm = '1';
        del.textContent = 'Confirm';
        del.classList.add('danger');
        setTimeout(() => { if (del.isConnected) { delete del.dataset.confirm; del.textContent = 'Delete'; del.classList.remove('danger'); } }, 3000);
      });
      acts.append(play, del);
      row.append(name, meta, acts);
      list.appendChild(row);
    }
  }

  startWorld(meta) {
    this.lock();
    this.game.startWorld(meta);
    this.chat(this.isTouch()
      ? `Welcome to ${meta.name}. Drag to look, tap to place, press and hold to mine. ☰ opens your inventory.`
      : `Welcome to ${meta.name}. Press E for your inventory, T for chat, and Esc for the menu.`);
  }

  // ------------------------------------------------------------ HUD
  buildHUD() {
    const hb = $('hotbar');
    this.hotbarEls = [];
    for (let i = 0; i < 9; i++) {
      const el = document.createElement('div');
      el.className = 'slot';
      el.addEventListener('pointerdown', (e) => { if (this.isTouch()) { this.game.player.sel = i; e.stopPropagation(); } });
      hb.appendChild(el);
      this.hotbarEls.push(el);
    }
    const mk = (id, n) => {
      const row = $(id), arr = [];
      for (let i = 0; i < n; i++) { const img = document.createElement('img'); img.alt = ''; row.appendChild(img); arr.push(img); }
      return arr;
    };
    this.heartEls = mk('hearts', 10);
    this.foodEls = mk('food', 10);
    this.airEls = mk('air', 10);
  }

  renderSlot(el, s) {
    const sig = s ? `${s.id}:${s.count}:${s.dmg || 0}` : '';
    if (el._sig === sig) return;
    el._sig = sig;
    el.innerHTML = '';
    if (!s) return;
    const img = document.createElement('img');
    img.src = iconURL(s.id);
    img.alt = itemName(s.id);
    el.appendChild(img);
    if (s.count > 1) {
      const c = document.createElement('span');
      c.className = 'count';
      c.textContent = s.count;
      el.appendChild(c);
    }
    const tool = toolOf(s);
    if (tool && s.dmg) {
      const f = 1 - s.dmg / tool.dur;
      const bar = document.createElement('div');
      bar.className = 'dur';
      const i = document.createElement('i');
      i.style.width = `${Math.max(4, f * 100)}%`;
      i.style.background = `hsl(${Math.round(f * 120)}, 80%, 50%)`;
      bar.appendChild(i);
      el.appendChild(bar);
    }
  }

  updateHUD(g) {
    const p = g.player, h = this.hud;
    if (h.inv !== p.inv.version || h.sel !== p.sel) {
      if (h.sel !== p.sel || (h.heldId ?? -1) !== (p.held() ? p.held().id : -1)) {
        const held = p.held();
        $('itemname').textContent = held ? itemName(held.id) : '';
        $('itemname').style.opacity = held ? 1 : 0;
        this.nameT = 2;
        h.heldId = held ? held.id : -1;
      }
      h.inv = p.inv.version;
      h.sel = p.sel;
      this.hotbarEls.forEach((el, i) => { this.renderSlot(el, p.inv.get(i)); el.classList.toggle('sel', i === p.sel); });
    }
    if (this.nameT > 0) { this.nameT -= 1 / 60; if (this.nameT <= 0) $('itemname').style.opacity = 0; }
    const survival = p.mode === 'survival';
    if (h.mode !== p.mode) { h.mode = p.mode; $('stats').style.visibility = survival ? 'visible' : 'hidden'; }
    const hp = Math.ceil(p.health);
    if (h.health !== hp) {
      h.health = hp;
      this.heartEls.forEach((img, i) => { img.src = this.icons[hp >= i * 2 + 2 ? 'heart_full' : hp === i * 2 + 1 ? 'heart_half' : 'heart_empty']; });
      $('hearts').classList.toggle('low', hp <= 4);
    }
    const fd = Math.ceil(p.hunger);
    if (h.food !== fd) {
      h.food = fd;
      this.foodEls.forEach((img, i) => { img.src = this.icons[fd >= i * 2 + 2 ? 'food_full' : fd === i * 2 + 1 ? 'food_half' : 'food_empty']; });
    }
    const air = p.eyeLiquid === 1 || p.air < 15 ? Math.max(0, Math.ceil((p.air / 15) * 10)) : -1;
    if (h.air !== air) {
      h.air = air;
      this.airEls.forEach((img, i) => { img.hidden = air < 0 || i >= air; img.src = this.icons.air; });
    }
    $('vignette').style.opacity = p.hurtT > 0 ? p.hurtT * 1.6 : survival && p.health <= 4 ? 0.25 : 0;
    const tint = $('tint');
    const want = p.eyeLiquid === 1 && g.cameraMode === 0 ? 'water' : p.eyeLiquid === 2 ? 'lava' : '';
    if (tint.className !== want) tint.className = want;
    $('crosshair').hidden = g.hudHidden || g.cameraMode !== 0;
    $('bottom').hidden = g.hudHidden;
    $('debug').hidden = !g.showDebug;
    if (g.showDebug) {
      this.debugT -= 1;
      if (this.debugT <= 0) { this.debugT = 10; $('debug').textContent = g.debugText(); }
    }
    const now = performance.now();
    for (const l of this.lines) if (!l.faded && now - l.t > 9000) { l.faded = true; l.el.classList.add('faded'); }
    if (this.inv) this.refreshInventory();
  }

  sleepFade() {
    const el = $('sleep-fade');
    el.classList.remove('on');
    void el.offsetWidth;
    el.classList.add('on');
  }

  chat(msg, kind) {
    const el = document.createElement('div');
    el.className = 'chat-line' + (kind ? ` ${kind}` : '');
    el.textContent = msg;
    $('chat-log').appendChild(el);
    this.lines.push({ el, t: performance.now(), faded: false });
    while (this.lines.length > 12) this.lines.shift().el.remove();
  }

  openChat(prefix) {
    const g = this.game;
    if (g.state !== 'play') return;
    this.chatOpen = true;
    g.keys.clear();
    this.unlock();
    const input = $('chat-input');
    input.hidden = false;
    input.value = prefix || '';
    $('chat').classList.add('open');
    setTimeout(() => input.focus(), 0);
  }
  closeChat(relock) {
    if (!this.chatOpen) return;
    this.chatOpen = false;
    const input = $('chat-input');
    input.hidden = true;
    input.blur();
    $('chat').classList.remove('open');
    if (relock) this.lock();
  }

  // ------------------------------------------------------------ input
  wireInput() {
    const g = this.game, c = g.canvas;
    document.addEventListener('pointerlockchange', () => {
      const locked = document.pointerLockElement === c;
      if (locked) { $('clicktoplay').hidden = true; this.noLock = false; return; }
      if (this.suppressPause) { this.suppressPause = false; return; }
      if (g.state === 'play' && !this.inv && !this.chatOpen) this.pause();
    });
    document.addEventListener('pointerlockerror', () => this.lockFailed());

    document.addEventListener('mousemove', (e) => {
      if (this.inv) {
        const cs = $('cursor-stack');
        cs.style.left = `${e.clientX}px`;
        cs.style.top = `${e.clientY}px`;
        const tt = $('tooltip');
        if (!tt.hidden) { tt.style.left = `${e.clientX + 14}px`; tt.style.top = `${e.clientY - 30}px`; }
        return;
      }
      if (g.state !== 'play' && g.state !== 'loading') return;
      if (document.pointerLockElement !== c && !this.noLock) return;
      this.look(e.movementX, e.movementY);
    });
    c.addEventListener('mousedown', (e) => {
      g.audio.init();
      if (g.state !== 'play' || this.inv || this.chatOpen) return;
      if (document.pointerLockElement !== c && !this.noLock && !this.isTouch()) { this.lock(); return; }
      if (e.button === 0) { g.mouse.left = true; g.mouse.leftPressed = true; }
      if (e.button === 2) { g.mouse.right = true; g.mouse.rightPressed = true; }
      if (e.button === 1) { e.preventDefault(); g.pickBlock(); }
    });
    document.addEventListener('mouseup', (e) => {
      if (e.button === 0) g.mouse.left = false;
      if (e.button === 2) g.mouse.right = false;
    });
    document.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('wheel', (e) => {
      if (g.state !== 'play' || this.inv) return;
      const d = Math.sign(e.deltaY);
      if (d) g.player.sel = (g.player.sel + d + 9) % 9;
    }, { passive: true });

    window.addEventListener('keydown', (e) => this.keydown(e));
    window.addEventListener('keyup', (e) => g.keys.delete(e.code));
    window.addEventListener('blur', () => { g.keys.clear(); g.mouse.left = g.mouse.right = false; });
    const save = () => { if (g.state !== 'menu') g.saveAll(); };
    window.addEventListener('pagehide', save);
    document.addEventListener('visibilitychange', () => { if (document.hidden) { save(); if (g.state === 'play' && this.noLock) this.pause(); } });
  }

  look(dx, dy) {
    const g = this.game, s = g.settings.sensitivity * 0.0024;
    g.player.yaw -= dx * s;
    g.player.pitch -= dy * s * (g.settings.invertY ? -1 : 1);
    g.player.pitch = Math.max(-1.55, Math.min(1.55, g.player.pitch));
  }

  keydown(e) {
    const g = this.game;
    if (this.chatOpen) {
      if (e.code === 'Enter') {
        const v = $('chat-input').value.trim();
        if (v) { if (v.startsWith('/')) { this.chat(v); g.command(v); } else this.chat(`<You> ${v}`); }
        this.closeChat(true);
        e.preventDefault();
      } else if (e.code === 'Escape') { this.closeChat(true); e.preventDefault(); }
      return;
    }
    if (e.target && e.target.tagName === 'INPUT' && e.target.type === 'text') return;
    const game = ['play', 'paused', 'dead'].includes(g.state);
    if (['F1', 'F3', 'F5', 'Tab', 'Space'].includes(e.code) && game) e.preventDefault();
    if (this.inv) {
      if (e.code === 'KeyE' || e.code === 'Escape') { this.closeInventory(); e.preventDefault(); }
      else if (/^Digit[1-9]$/.test(e.code) && this.hovered) this.swapWithHotbar(this.hovered, +e.code.slice(5) - 1);
      else if (e.code === 'KeyQ' && this.hovered) this.dropFromSlot(this.hovered, e.ctrlKey);
      return;
    }
    if (g.state === 'paused' && e.code === 'Escape') { this.resume(); return; }
    if (g.state !== 'play') return;
    if (e.code === 'Escape' && this.noLock) { this.pause(); return; }
    if (e.repeat && !['KeyW', 'KeyA', 'KeyS', 'KeyD'].includes(e.code)) { g.keys.add(e.code); return; }
    const p = g.player, now = performance.now();
    switch (e.code) {
      case 'KeyE': this.openInventory(p.mode === 'creative' ? 'creative' : 'player'); return;
      case 'KeyT': e.preventDefault(); this.openChat(''); return;
      case 'Slash': e.preventDefault(); this.openChat('/'); return;
      case 'KeyQ': g.dropHeld(e.ctrlKey || e.metaKey); return;
      case 'F1': g.hudHidden = !g.hudHidden; return;
      case 'F3': g.showDebug = !g.showDebug; return;
      case 'F5': g.cameraMode = (g.cameraMode + 1) % 3; return;
      case 'Space':
        if (p.mode === 'creative' && now - this.lastTapSpace < 300) { p.flying = !p.flying; p.vy = 0; this.lastTapSpace = 0; }
        else this.lastTapSpace = now;
        break;
      case 'KeyW':
        if (now - this.lastTapW < 280) p.sprinting = true;
        this.lastTapW = now;
        break;
    }
    if (/^Digit[1-9]$/.test(e.code)) p.sel = +e.code.slice(5) - 1;
    g.keys.add(e.code);
  }

  // ------------------------------------------------------------ inventory screens
  invRefs() {
    const inv = this.game.player.inv;
    return inv.slots.map((_, i) => ({ get: () => inv.get(i), set: (s) => inv.set(i, s), group: i < 9 ? 'hot' : 'main', index: i }));
  }

  openInventory(kind, ctx = {}) {
    const g = this.game;
    if (this.inv) this.closeInventory(true);
    this.inv = { kind, ctx, grid: null };
    g.keys.clear();
    g.mouse.left = g.mouse.right = false;
    this.unlock();
    const top = $('inv-top');
    top.innerHTML = '';
    this.slots = [];
    const mkSlot = (parent, ref, cls) => {
      const el = document.createElement('div');
      el.className = 'slot' + (cls ? ` ${cls}` : '');
      el._ref = ref;
      ref.el = el;
      el.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); this.slotClick(ref, e); });
      el.addEventListener('pointerenter', () => { this.hovered = ref; this.showTooltip(ref); });
      el.addEventListener('pointerleave', () => { if (this.hovered === ref) this.hovered = null; $('tooltip').hidden = true; });
      parent.appendChild(el);
      this.slots.push(ref);
      return el;
    };
    const title = (t) => { const d = document.createElement('div'); d.className = 'inv-title'; d.textContent = t; top.appendChild(d); };

    if (kind === 'player' || kind === 'craft') {
      const size = kind === 'craft' ? 3 : 2;
      title(kind === 'craft' ? 'Crafting table' : 'Crafting');
      const row = document.createElement('div');
      row.className = 'inv-top-row';
      const grid = document.createElement('div');
      grid.className = 'craft-grid';
      grid.style.gridTemplateColumns = `repeat(${size}, var(--slot-size))`;
      this.inv.grid = new Array(size * size).fill(null);
      this.inv.size = size;
      const G = this.inv.grid;
      for (let i = 0; i < size * size; i++) mkSlot(grid, { get: () => G[i], set: (s) => { G[i] = s && s.count > 0 ? s : null; }, group: 'craft' });
      const arrow = document.createElement('div');
      arrow.className = 'arrow';
      arrow.textContent = '→';
      row.append(grid, arrow);
      const out = { get: () => matchCraft(G, size), set: () => {}, output: true, group: 'out', onTake: () => { for (let i = 0; i < G.length; i++) if (G[i]) { G[i].count--; if (G[i].count <= 0) G[i] = null; } } };
      mkSlot(row, out, 'out');
      top.appendChild(row);
    } else if (kind === 'furnace') {
      title('Furnace');
      const te = ctx.te;
      const f = document.createElement('div');
      f.className = 'furnace';
      const inSlot = { get: () => te.slots[0], set: (s) => { te.slots[0] = s && s.count > 0 ? s : null; }, group: 'fin' };
      const fuelSlot = { get: () => te.slots[1], set: (s) => { te.slots[1] = s && s.count > 0 ? s : null; }, group: 'ffuel' };
      const outSlot = { get: () => te.slots[2], set: (s) => { te.slots[2] = s && s.count > 0 ? s : null; }, output: true, group: 'fout', onTake: () => { te.slots[2] = null; } };
      mkSlot(f, inSlot);
      const prog = document.createElement('div');
      prog.className = 'progress';
      prog.style.gridRow = '1 / span 3';
      prog.style.gridColumn = '2';
      prog.innerHTML = '<i></i>';
      f.appendChild(prog);
      const outEl = mkSlot(f, outSlot, 'out');
      outEl.style.gridRow = '1 / span 3';
      outEl.style.gridColumn = '3';
      const flame = document.createElement('div');
      flame.className = 'flame';
      flame.innerHTML = '<i></i>';
      flame.style.gridColumn = '1';
      f.appendChild(flame);
      const fuelEl = mkSlot(f, fuelSlot);
      fuelEl.style.gridColumn = '1';
      top.appendChild(f);
      this.inv.flame = flame.firstChild;
      this.inv.prog = prog.firstChild;
    } else if (kind === 'chest') {
      title('Chest');
      const te = ctx.te;
      const grid = document.createElement('div');
      grid.className = 'grid9';
      for (let i = 0; i < 27; i++) mkSlot(grid, { get: () => te.slots[i], set: (s) => { te.slots[i] = s && s.count > 0 ? s : null; }, group: 'chest' });
      top.appendChild(grid);
    } else if (kind === 'creative') {
      this.buildCreative(top, mkSlot);
    }
    for (const ref of this.invRefs()) mkSlot(ref.index < 9 ? $('inv-hot') : $('inv-main'), ref);
    // Order the DOM so the main grid is filled before the hotbar.
    $('inv-main').innerHTML = '';
    $('inv-hot').innerHTML = '';
    for (const ref of this.slots) if (ref.group === 'main') $('inv-main').appendChild(ref.el);
    for (const ref of this.slots) if (ref.group === 'hot') $('inv-hot').appendChild(ref.el);
    $('inventory').hidden = false;
    $('inventory').onpointerdown = (e) => {
      if (e.target === $('inventory') && this.cursor) {
        const n = e.button === 2 ? 1 : this.cursor.count;
        this.game.tossStack({ ...this.cursor, count: n });
        this.cursor.count -= n;
        if (this.cursor.count <= 0) this.cursor = null;
        this.renderCursor();
      }
    };
    this.refreshInventory(true);
  }

  buildCreative(top, mkSlot) {
    const { blocks, items } = creativeList();
    const row = document.createElement('div');
    row.className = 'tabs';
    const tabs = [['All', [...blocks, ...items]], ['Blocks', blocks], ['Items', items]];
    let current = tabs[0][1], query = '';
    const pal = document.createElement('div');
    pal.className = 'palette';
    const render = () => {
      pal.innerHTML = '';
      this.slots = this.slots.filter((r) => r.group !== 'palette');
      const q = query.toLowerCase();
      for (const id of current) {
        if (q && !itemName(id).toLowerCase().includes(q)) continue;
        mkSlot(pal, { get: () => ({ id, count: 1 }), set: () => {}, palette: true, group: 'palette', id });
      }
      this.refreshInventory(true);
    };
    tabs.forEach(([name, list], i) => {
      const b = document.createElement('button');
      b.className = 'tab' + (i === 0 ? ' on' : '');
      b.textContent = name;
      b.addEventListener('click', () => {
        current = list;
        for (const o of row.querySelectorAll('.tab')) o.classList.toggle('on', o === b);
        render();
      });
      row.appendChild(b);
    });
    const search = document.createElement('input');
    search.className = 'search';
    search.id = 'creative-search';
    search.placeholder = 'Search items';
    search.addEventListener('input', () => { query = search.value; render(); });
    search.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.code === 'Escape') { search.blur(); } });
    row.appendChild(search);
    const trash = document.createElement('div');
    trash.className = 'trash';
    mkSlot(trash, { get: () => null, set: () => {}, trash: true, group: 'trash' }, 'trash-slot');
    trash.append('Delete');
    row.appendChild(trash);
    top.append(row, pal);
    render();
  }

  showTooltip(ref) {
    const s = ref.get();
    const tt = $('tooltip');
    if (!s) { tt.hidden = true; return; }
    const tool = toolOf(s);
    tt.innerHTML = '';
    tt.append(itemName(s.id));
    const def = itemDef(s.id);
    const extra = tool ? `Durability ${tool.dur - (s.dmg || 0)} / ${tool.dur}` : def.food ? `Restores ${def.food / 2} food` : '';
    if (extra) { const sm = document.createElement('small'); sm.textContent = extra; tt.appendChild(sm); }
    tt.hidden = false;
  }

  refreshInventory(force) {
    if (!this.inv) return;
    for (const ref of this.slots) {
      if (force) ref.el._sig = undefined;
      this.renderSlot(ref.el, ref.trash ? null : ref.get());
    }
    if (this.inv.kind === 'furnace') {
      const te = this.inv.ctx.te;
      this.inv.flame.style.height = `${te.burn > 0 ? (te.burn / te.burnMax) * 100 : 0}%`;
      this.inv.prog.style.width = `${(te.cook / SMELT_TIME) * 100}%`;
    }
  }

  renderCursor() {
    const el = $('cursor-stack');
    el._sig = undefined;
    this.renderSlot(el, this.cursor);
  }

  slotClick(ref, e) {
    const right = e.button === 2;
    const shift = e.shiftKey;
    const g = this.game;
    g.audio.play('click');
    if (ref.trash) { this.cursor = null; this.renderCursor(); return; }
    if (ref.palette) {
      if (this.cursor) { this.cursor = null; }
      else if (shift) { g.player.inv.add({ id: ref.id, count: maxStackOf(ref.id) }); }
      else this.cursor = { id: ref.id, count: right ? 1 : maxStackOf(ref.id) };
      this.renderCursor();
      return;
    }
    if (shift) { this.quickMove(ref); this.refreshInventory(); return; }
    const s = ref.get();
    const c = this.cursor;
    if (ref.output) {
      if (!s) return;
      if (c && !(canMerge(c, s) && c.count + s.count <= maxStackOf(s.id))) return;
      if (c) c.count += s.count;
      else this.cursor = { id: s.id, count: s.count, dmg: s.dmg || 0 };
      ref.onTake();
      g.player.inv.changed();
    } else if (!right) {
      if (!c) { this.cursor = s; ref.set(null); }
      else if (!s) { ref.set(c); this.cursor = null; }
      else if (canMerge(c, s)) {
        const t = Math.min(maxStackOf(s.id) - s.count, c.count);
        s.count += t;
        c.count -= t;
        ref.set(s);
        if (c.count <= 0) this.cursor = null;
      } else { ref.set(c); this.cursor = s; }
    } else {
      if (!c && s) {
        const half = Math.ceil(s.count / 2);
        this.cursor = { id: s.id, count: half, dmg: s.dmg || 0 };
        s.count -= half;
        ref.set(s.count > 0 ? s : null);
      } else if (c && !s) {
        ref.set({ id: c.id, count: 1, dmg: c.dmg || 0 });
        c.count--;
        if (c.count <= 0) this.cursor = null;
      } else if (c && canMerge(c, s) && s.count < maxStackOf(s.id)) {
        s.count++;
        ref.set(s);
        c.count--;
        if (c.count <= 0) this.cursor = null;
      } else if (c) { ref.set(c); this.cursor = s; }
    }
    g.player.inv.changed();
    this.renderCursor();
    this.refreshInventory();
    this.showTooltip(ref);
  }

  // Shift-click: move a stack between the player inventory and the open container.
  quickMove(ref) {
    const g = this.game, p = g.player;
    const all = this.slots;
    const into = (stack, targets) => {
      const max = maxStackOf(stack.id);
      for (const t of targets) {
        const s = t.get();
        if (s && canMerge(s, stack) && s.count < max) {
          const n = Math.min(max - s.count, stack.count);
          s.count += n; stack.count -= n; t.set(s);
          if (!stack.count) return 0;
        }
      }
      for (const t of targets) {
        if (!t.get()) {
          const n = Math.min(max, stack.count);
          t.set({ id: stack.id, count: n, dmg: stack.dmg || 0 });
          stack.count -= n;
          if (!stack.count) return 0;
        }
      }
      return stack.count;
    };
    const hot = all.filter((r) => r.group === 'hot'), main = all.filter((r) => r.group === 'main');
    if (ref.output) {
      for (let k = 0; k < 64; k++) {
        const s = ref.get();
        if (!s) break;
        const copy = { ...s };
        const left = into(copy, [...hot, ...main]);
        if (left) break;
        ref.onTake();
        if (this.inv.kind === 'furnace') break;
      }
      p.inv.changed();
      return;
    }
    const s = ref.get();
    if (!s) return;
    let targets;
    const kind = this.inv.kind;
    if (ref.group === 'hot' || ref.group === 'main') {
      if (kind === 'chest') targets = all.filter((r) => r.group === 'chest');
      else if (kind === 'furnace') targets = SMELT[s.id] !== undefined ? all.filter((r) => r.group === 'fin') : fuelTime(s.id) ? all.filter((r) => r.group === 'ffuel') : null;
      if (!targets) targets = ref.group === 'hot' ? main : hot;
    } else targets = [...hot, ...main];
    const copy = { ...s };
    const left = into(copy, targets);
    ref.set(left ? { ...s, count: left } : null);
    p.inv.changed();
  }

  swapWithHotbar(ref, i) {
    if (ref.output || ref.palette || ref.trash) {
      if (ref.palette) { this.game.player.inv.set(i, { id: ref.id, count: maxStackOf(ref.id) }); this.refreshInventory(); }
      return;
    }
    const inv = this.game.player.inv;
    const a = ref.get(), b = inv.get(i);
    ref.set(b);
    inv.set(i, a);
    this.refreshInventory();
  }

  dropFromSlot(ref, all) {
    if (ref.palette || ref.trash || ref.output) return;
    const s = ref.get();
    if (!s) return;
    const n = all ? s.count : 1;
    this.game.tossStack({ id: s.id, count: n, dmg: s.dmg || 0 });
    s.count -= n;
    ref.set(s.count > 0 ? s : null);
    this.game.player.inv.changed();
    this.refreshInventory();
  }

  closeInventory(silent) {
    if (!this.inv) return;
    const g = this.game, p = g.player;
    const give = (s) => { if (!s) return; const left = p.inv.add(s); if (left) g.tossStack({ ...s, count: left }); };
    if (this.inv.grid) this.inv.grid.forEach(give);
    give(this.cursor);
    this.cursor = null;
    this.renderCursor();
    this.inv = null;
    this.slots = [];
    this.hovered = null;
    $('inventory').hidden = true;
    $('tooltip').hidden = true;
    $('inv-top').innerHTML = '';
    $('inv-main').innerHTML = '';
    $('inv-hot').innerHTML = '';
    if (!silent && g.state === 'play') this.lock();
  }

  containerRemoved(key) {
    if (this.inv && this.inv.ctx && this.inv.ctx.key === key) this.closeInventory();
  }

  // ------------------------------------------------------------ touch controls
  updateTouchVisibility() {
    const show = this.isTouch() && this.game && this.game.state === 'play';
    $('touch').hidden = !show;
  }

  wireTouch() {
    const g = this.game;
    const stick = $('stick'), knob = $('stick-knob');
    let stickId = null, sx = 0, sy = 0;
    stick.addEventListener('pointerdown', (e) => {
      stickId = e.pointerId; sx = e.clientX; sy = e.clientY;
      stick.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    stick.addEventListener('pointermove', (e) => {
      if (e.pointerId !== stickId) return;
      let dx = e.clientX - sx, dy = e.clientY - sy;
      const d = Math.hypot(dx, dy), m = 48;
      if (d > m) { dx = (dx / d) * m; dy = (dy / d) * m; }
      knob.style.transform = `translate(${dx}px, ${dy}px)`;
      g.touch.s = dx / m;
      g.touch.f = -dy / m;
    });
    const endStick = (e) => {
      if (e.pointerId !== stickId) return;
      stickId = null;
      knob.style.transform = '';
      g.touch.f = g.touch.s = 0;
    };
    stick.addEventListener('pointerup', endStick);
    stick.addEventListener('pointercancel', endStick);
    const hold = (id, key, toggle) => {
      const b = $(id);
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        g.audio.init();
        if (toggle) { g.touch[key] = !g.touch[key]; b.classList.toggle('on', g.touch[key]); return; }
        g.touch[key] = true;
        if (key === 'jump') {
          const now = performance.now();
          if (g.player.mode === 'creative' && now - this.lastTapSpace < 300) { g.player.flying = !g.player.flying; g.player.vy = 0; }
          this.lastTapSpace = now;
        }
      });
      const up = () => { if (!toggle) g.touch[key] = false; };
      b.addEventListener('pointerup', up);
      b.addEventListener('pointercancel', up);
      b.addEventListener('pointerleave', up);
    };
    hold('t-jump', 'jump');
    hold('t-sneak', 'sneak');
    hold('t-sprint', 'sprint', true);
    $('t-inv').addEventListener('click', () => { if (g.state === 'play') this.inv ? this.closeInventory() : this.openInventory(g.player.mode === 'creative' ? 'creative' : 'player'); });
    $('t-drop').addEventListener('click', () => g.state === 'play' && g.dropHeld(false));
    $('t-pause').addEventListener('click', () => this.pause());

    // Look by dragging on the canvas; tap to use/place; long-press to mine/attack.
    const c = g.canvas;
    const touches = new Map();
    c.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch' || g.state !== 'play') return;
      g.audio.init();
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY, t: performance.now(), moved: 0, mining: false });
      const id = e.pointerId;
      setTimeout(() => {
        const t = touches.get(id);
        if (t && t.moved < 12) { t.mining = true; g.mouse.left = true; g.mouse.leftPressed = true; }
      }, 280);
    });
    c.addEventListener('pointermove', (e) => {
      const t = touches.get(e.pointerId);
      if (!t) return;
      const dx = e.clientX - t.x, dy = e.clientY - t.y;
      t.moved += Math.abs(dx) + Math.abs(dy);
      t.x = e.clientX; t.y = e.clientY;
      this.look(dx * 1.6, dy * 1.6);
    });
    const end = (e) => {
      const t = touches.get(e.pointerId);
      if (!t) return;
      touches.delete(e.pointerId);
      if (t.mining) g.mouse.left = false;
      else if (t.moved < 12 && performance.now() - t.t < 280) {
        g.mouse.right = true; g.mouse.rightPressed = true;
        setTimeout(() => { g.mouse.right = false; }, 60);
      }
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
  }
}
