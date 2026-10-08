// Procedural audio: layered material sounds, ambient soundscapes (birds, crickets,
// wind, rain, thunder, caves, water) and a generative score. Everything is
// synthesised with Web Audio at runtime; there are no sound files.

// Per material: noise band for the body, optional tonal knock, grain clicks.
const MATERIAL = {
  stone: { f: 1500, q: 1.6, dur: 0.1, type: 'bandpass', thump: 120, grains: 2, grainF: 3200 },
  gravel: { f: 900, q: 0.7, dur: 0.14, type: 'bandpass', grains: 7, grainF: 2600 },
  grass: { f: 650, q: 0.5, dur: 0.16, type: 'lowpass', swish: 2400 },
  wood: { f: 800, q: 1.3, dur: 0.09, type: 'bandpass', knock: [196, 470], thump: 90 },
  sand: { f: 2600, q: 0.45, dur: 0.17, type: 'highpass', grains: 5, grainF: 5200 },
  snow: { f: 1100, q: 0.5, dur: 0.18, type: 'lowpass', grains: 4, grainF: 2000 },
  wool: { f: 420, q: 0.45, dur: 0.15, type: 'lowpass' },
  glass: { f: 4800, q: 2.2, dur: 0.07, type: 'bandpass', ring: true },
  metal: { f: 2200, q: 3.5, dur: 0.09, type: 'bandpass', knock: [690, 1720, 2810] },
};
// Gentle modes for the score: intervals in semitones.
const MODES = { day: [0, 2, 4, 7, 9], dusk: [0, 2, 3, 7, 9], night: [0, 2, 3, 5, 7, 10], cave: [0, 1, 5, 7, 8] };
const PROGRESSIONS = [[0, 9, 5, 7], [0, 5, 9, 7], [0, 7, 9, 5], [0, 4, 5, 7]];

export class Audio {
  constructor() {
    this.ctx = null;
    this.sfxVol = 0.8;
    this.musicVol = 0.4;
    this.nextPhrase = 25;
    this.musicT = 0;
    this.amb = null;
    this.birdT = 3;
    this.cricketT = 2;
    this.dripT = 4;
    this.lapT = 2;
  }

  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.ctx = ctx;
      this.master = ctx.createGain();
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.ratio.value = 3;
      this.master.connect(comp);
      comp.connect(ctx.destination);
      this.sfx = ctx.createGain();
      this.sfx.gain.value = this.sfxVol;
      this.sfx.connect(this.master);
      this.music = ctx.createGain();
      this.music.gain.value = this.musicVol * 0.5;
      const len = ctx.sampleRate * 2;
      this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      // Brown noise for wind and rumbles.
      this.brown = ctx.createBuffer(1, len, ctx.sampleRate);
      const bd = this.brown.getChannelData(0);
      let last = 0;
      for (let i = 0; i < len; i++) { last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; bd[i] = last * 3.5; }
      this.reverb = ctx.createConvolver();
      this.reverb.buffer = this.impulse(3.2, 2.6);
      this.caveVerb = ctx.createConvolver();
      this.caveVerb.buffer = this.impulse(2.2, 1.8);
      const wet = ctx.createGain();
      wet.gain.value = 0.6;
      this.music.connect(this.reverb);
      this.reverb.connect(wet);
      wet.connect(this.master);
      this.music.connect(this.master);
      this.caveWet = ctx.createGain();
      this.caveWet.gain.value = 0;
      this.sfx.connect(this.caveVerb);
      this.caveVerb.connect(this.caveWet);
      this.caveWet.connect(this.master);
      this.startAmbience();
    } catch {
      this.ctx = null;
    }
  }

  impulse(seconds, decay) {
    const ctx = this.ctx, n = Math.floor(ctx.sampleRate * seconds);
    const ir = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const c = ir.getChannelData(ch);
      for (let i = 0; i < n; i++) c[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, decay);
    }
    return ir;
  }

  setVolumes(sfx, music) {
    this.sfxVol = sfx;
    this.musicVol = music;
    if (this.ctx) {
      this.sfx.gain.value = sfx;
      this.music.gain.value = music * 0.5;
    }
  }

  out(x = 0, y = 0, z = 0, yaw = 0) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    const d = Math.hypot(x, y, z);
    g.gain.value = d > 0 ? Math.max(0, 1 - d / 24) : 1;
    if (d > 0 && ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      const rx = Math.cos(yaw), rz = -Math.sin(yaw);
      p.pan.value = Math.max(-1, Math.min(1, (x * rx + z * rz) / (d + 1)));
      g.connect(p);
      p.connect(this.sfx);
    } else g.connect(this.sfx);
    return g;
  }

  burst(dest, { f, q, dur, type }, vol, pitch = 1, delay = 0, buffer) {
    const ctx = this.ctx, t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = buffer || this.noise;
    src.playbackRate.value = pitch;
    const filt = ctx.createBiquadFilter();
    filt.type = type;
    filt.frequency.value = f * pitch;
    filt.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    src.connect(filt);
    filt.connect(g);
    g.connect(dest);
    src.start(t, Math.random() * 1.5, dur + 0.05);
  }

  tone(dest, { f, f2, dur, type = 'sine', vol = 0.3, delay = 0, attack = 0.005 }) {
    const ctx = this.ctx, t = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f, t);
    if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    o.connect(g);
    g.connect(dest);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  block(material, kind, pos) {
    if (!this.ctx) return;
    const m = MATERIAL[material] || MATERIAL.stone;
    const dest = pos ? this.out(pos[0], pos[1], pos[2], pos[3]) : this.out();
    const vol = kind === 'step' ? 0.13 : kind === 'hit' ? 0.2 : kind === 'place' ? 0.34 : 0.4;
    const pitch = (kind === 'place' ? 0.85 : 1) * (0.88 + Math.random() * 0.24);
    const dur = kind === 'break' ? m.dur * 1.7 : m.dur;
    this.burst(dest, { ...m, dur }, vol, pitch);
    if (m.thump && kind !== 'step') this.tone(dest, { f: m.thump * pitch, f2: m.thump * 0.55, dur: 0.12, vol: vol * 0.7 });
    if (kind === 'place') this.tone(dest, { f: 110 * pitch, f2: 60, dur: 0.1, vol: 0.18 });
    if (m.knock) m.knock.forEach((k, i) => this.tone(dest, { f: k * pitch, f2: k * 0.82, dur: 0.12 - i * 0.02, type: i ? 'sine' : 'triangle', vol: vol * (0.55 - i * 0.12) }));
    if (m.swish) this.burst(dest, { f: m.swish, q: 0.8, dur: dur * 0.8, type: 'bandpass' }, vol * 0.35, pitch, 0.01);
    const grains = (m.grains || 0) * (kind === 'break' ? 2 : 1);
    for (let i = 0; i < grains; i++) this.burst(dest, { f: m.grainF, q: 2, dur: 0.02, type: 'bandpass' }, vol * 0.4, 0.8 + Math.random() * 0.5, i * 0.012 + Math.random() * 0.02);
    if (m.ring && kind === 'break') for (let i = 0; i < 5; i++) this.tone(dest, { f: 2200 + Math.random() * 3200, dur: 0.3, vol: 0.05, delay: i * 0.025 });
    if (kind === 'break') for (let i = 0; i < 4; i++) this.burst(dest, { f: m.f * 0.8, q: 1, dur: 0.04, type: 'bandpass' }, vol * 0.3, 0.7 + Math.random() * 0.6, 0.06 + i * 0.035);
  }

  play(name, o = {}) {
    if (!this.ctx) return;
    const dest = this.out();
    const vol = o.vol ?? 0.5, p = o.pitch ?? 1;
    switch (name) {
      case 'pop':
        this.tone(dest, { f: 520 * p, f2: 1250 * p, dur: 0.07, vol: vol * 0.45 });
        this.tone(dest, { f: 1040 * p, f2: 2000 * p, dur: 0.05, vol: vol * 0.15, delay: 0.01 });
        break;
      case 'click': this.tone(dest, { f: 1400, f2: 950, dur: 0.035, type: 'square', vol: 0.05 }); break;
      case 'hurt':
        this.tone(dest, { f: 300, f2: 150, dur: 0.22, type: 'sawtooth', vol: 0.14 });
        this.burst(dest, { f: 500, q: 0.8, dur: 0.16, type: 'lowpass' }, 0.3);
        break;
      case 'eat':
        for (let i = 0; i < 3; i++) this.burst(dest, { f: 1400, q: 1.2, dur: 0.06, type: 'bandpass' }, 0.22, 0.8 + Math.random() * 0.4, i * 0.1);
        break;
      case 'burp': this.tone(dest, { f: 120, f2: 80, dur: 0.3, type: 'sawtooth', vol: 0.1 }); break;
      case 'splash':
        this.burst(dest, { f: 1300, q: 0.5, dur: 0.5, type: 'lowpass' }, vol * 0.7);
        for (let i = 0; i < 6; i++) this.tone(dest, { f: 600 + Math.random() * 900, f2: 1400 + Math.random() * 600, dur: 0.06, vol: 0.04, delay: 0.05 + i * 0.04 });
        break;
      case 'swing': this.burst(dest, { f: 2000, q: 0.7, dur: 0.1, type: 'bandpass' }, 0.08, 0.9 + Math.random() * 0.2); break;
      case 'toolbreak':
        this.burst(dest, { f: 3000, q: 2, dur: 0.2, type: 'bandpass' }, 0.4);
        this.tone(dest, { f: 900, f2: 300, dur: 0.25, type: 'square', vol: 0.07 });
        break;
      case 'fizz': this.burst(dest, { f: 4000, q: 0.3, dur: 0.6, type: 'highpass' }, 0.2); break;
      case 'level': [0, 4, 7].forEach((s, i) => this.tone(dest, { f: 523 * 2 ** (s / 12), dur: 0.35, vol: 0.12, delay: i * 0.09 })); break;
      case 'door': this.tone(dest, { f: 220, f2: 140, dur: 0.18, type: 'triangle', vol: 0.2 }); break;
    }
  }

  thunder(delay, vol = 1) {
    if (!this.ctx) return;
    const dest = this.out();
    this.burst(dest, { f: 2400, q: 0.4, dur: 0.25, type: 'highpass' }, 0.35 * vol, 1, delay);
    const ctx = this.ctx, t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.brown;
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(600, t);
    lp.frequency.exponentialRampToValueAtTime(90, t + 3.5);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.9 * vol, t + 0.08);
    g.gain.setValueAtTime(0.9 * vol, t + 0.4);
    g.gain.exponentialRampToValueAtTime(0.001, t + 4.5);
    src.connect(lp); lp.connect(g); g.connect(dest);
    src.start(t);
    src.stop(t + 4.6);
  }

  mob(type, x, y, z, yaw, hurt) {
    if (!this.ctx) return;
    const dest = this.out(x, y, z, yaw);
    const ctx = this.ctx, t = ctx.currentTime;
    const voice = (f0, f1, dur, formants, vib = 0, vol = 0.18) => {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(f0, t);
      o.frequency.linearRampToValueAtTime(f1, t + dur);
      if (vib) {
        const l = ctx.createOscillator(), lg = ctx.createGain();
        l.frequency.value = vib; lg.gain.value = f0 * 0.06;
        l.connect(lg); lg.connect(o.frequency); l.start(t); l.stop(t + dur + 0.05);
      }
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(vol, t + 0.04);
      g.gain.setValueAtTime(vol, t + dur * 0.7);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      for (const [ff, q, k] of formants) {
        const filt = ctx.createBiquadFilter();
        filt.type = 'bandpass'; filt.frequency.value = ff; filt.Q.value = q;
        const fg = ctx.createGain(); fg.gain.value = k;
        o.connect(filt); filt.connect(fg); fg.connect(g);
      }
      g.connect(dest);
      o.start(t); o.stop(t + dur + 0.05);
    };
    const k = hurt ? 1.3 : 1;
    switch (type) {
      case 'pig': voice(170 * k, 120 * k, 0.24, [[700, 2, 1], [1500, 3, 0.4]], 30); break;
      case 'cow': voice(125 * k, 92 * k, hurt ? 0.4 : 0.95, [[450, 2, 1], [900, 3, 0.5]], 0, 0.22); break;
      case 'sheep': voice(290 * k, 270 * k, 0.6, [[900, 2.5, 1], [2200, 4, 0.4]], 7); break;
      case 'ghoul':
        voice(88 * k, 66 * k, hurt ? 0.3 : 0.9, [[380, 2, 1], [760, 3, 0.4]], 4, 0.26);
        this.burst(dest, { f: 450, q: 0.6, dur: 0.6, type: 'lowpass' }, 0.08);
        break;
    }
  }

  // ---------------------------------------------------------------- ambience
  loop(buffer, type, freq, q) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = ctx.createGain();
    g.gain.value = 0;
    src.connect(f); f.connect(g); g.connect(this.sfx);
    src.start(0, Math.random());
    return { src, f, g };
  }

  startAmbience() {
    this.amb = {
      rain: this.loop(this.noise, 'bandpass', 2600, 0.5),
      rainLow: this.loop(this.brown, 'lowpass', 500, 0.7),
      wind: this.loop(this.brown, 'bandpass', 420, 0.9),
      cave: this.loop(this.brown, 'lowpass', 120, 1),
      water: this.loop(this.brown, 'lowpass', 700, 0.8),
    };
  }

  // env: { rain, wind, cave, day, exposure, underwater, water, forest } in 0..1
  ambience(env, dt) {
    if (!this.ctx || !this.amb) return;
    const t = this.ctx.currentTime, a = this.amb;
    const set = (node, v) => node.g.gain.setTargetAtTime(v, t, 0.6);
    const muffle = env.underwater ? 0.25 : 1;
    set(a.rain, env.rain * 0.22 * muffle);
    set(a.rainLow, env.rain * 0.28 * muffle);
    const gust = 0.6 + 0.4 * Math.sin(t * 0.37) * Math.sin(t * 0.23 + 1);
    set(a.wind, env.wind * 0.22 * gust * muffle);
    a.wind.f.frequency.setTargetAtTime(300 + gust * 400, t, 1.5);
    set(a.cave, env.cave * 0.12);
    set(a.water, env.water * env.exposure * 0.09 * (0.7 + 0.3 * Math.sin(t * 0.8)));
    this.caveWet.gain.setTargetAtTime(env.cave * 0.35, t, 1);
    if (env.underwater) return;
    // Birds by day in leafy places, crickets at night, drips in caves, lapping water.
    this.birdT -= dt;
    if (this.birdT <= 0) {
      this.birdT = 2.5 + Math.random() * 7;
      if (env.day > 0.6 && env.exposure > 0.6 && env.rain < 0.2 && Math.random() < 0.3 + env.forest * 0.7) this.bird();
    }
    this.cricketT -= dt;
    if (this.cricketT <= 0) {
      this.cricketT = 0.8 + Math.random() * 2.5;
      if (env.day < 0.35 && env.exposure > 0.5 && env.rain < 0.3) this.cricket();
    }
    this.dripT -= dt;
    if (this.dripT <= 0) {
      this.dripT = 1.5 + Math.random() * 5;
      if (env.cave > 0.5) this.drip();
    }
    this.lapT -= dt;
    if (this.lapT <= 0) {
      this.lapT = 0.7 + Math.random() * 1.6;
      if (env.water > 0.2 && env.exposure > 0.5) this.burst(this.out((Math.random() - 0.5) * 12, -2, (Math.random() - 0.5) * 12), { f: 900, q: 0.6, dur: 0.5, type: 'lowpass' }, 0.06 * env.water, 0.6 + Math.random() * 0.3);
    }
  }

  bird() {
    const ctx = this.ctx;
    const dest = this.out((Math.random() - 0.5) * 30, 6 + Math.random() * 6, (Math.random() - 0.5) * 30);
    const base = 2200 + Math.random() * 2200, n = 2 + Math.floor(Math.random() * 5);
    const style = Math.floor(Math.random() * 3);
    for (let i = 0; i < n; i++) {
      const t = ctx.currentTime + i * (0.09 + Math.random() * 0.08);
      const o = ctx.createOscillator();
      o.type = 'sine';
      const f0 = base * (style === 2 ? 1 + i * 0.06 : 1 + (Math.random() - 0.5) * 0.15);
      o.frequency.setValueAtTime(style === 1 ? f0 * 1.4 : f0, t);
      o.frequency.exponentialRampToValueAtTime(style === 1 ? f0 * 0.8 : f0 * 1.35, t + 0.07);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.05, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0008, t + 0.08);
      o.connect(g); g.connect(dest);
      o.start(t); o.stop(t + 0.1);
    }
  }

  cricket() {
    const ctx = this.ctx;
    const dest = this.out((Math.random() - 0.5) * 20, -1, (Math.random() - 0.5) * 20);
    const f = 4200 + Math.random() * 600, t0 = ctx.currentTime;
    for (let i = 0; i < 3 + Math.floor(Math.random() * 3); i++) {
      const t = t0 + i * 0.06;
      const o = ctx.createOscillator();
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.025, t + 0.008);
      g.gain.linearRampToValueAtTime(0, t + 0.035);
      o.connect(g); g.connect(dest);
      o.start(t); o.stop(t + 0.04);
    }
  }

  drip() {
    const dest = this.out((Math.random() - 0.5) * 16, 3, (Math.random() - 0.5) * 16);
    const f = 900 + Math.random() * 900;
    this.tone(dest, { f, f2: f * 1.9, dur: 0.12, vol: 0.12 });
  }

  // ---------------------------------------------------------------- music
  // Sparse generative pieces: a soft pad under a few chords, with a plucked
  // melody drawn from the current mood's scale.
  update(dt, enabled, mood = 'day') {
    if (!this.ctx || !enabled || this.musicVol <= 0) return;
    this.musicT += dt;
    if (this.musicT < this.nextPhrase) return;
    this.musicT = 0;
    this.nextPhrase = 60 + Math.random() * 90;
    this.piece(mood);
  }

  piece(mood) {
    const ctx = this.ctx;
    const scale = MODES[mood] || MODES.day;
    const root = [174.6, 196, 220, 146.8][Math.floor(Math.random() * 4)] * (mood === 'cave' ? 0.75 : 1);
    const prog = PROGRESSIONS[Math.floor(Math.random() * PROGRESSIONS.length)];
    const barLen = 4.2 + Math.random() * 1.4;
    const bars = 4 + Math.floor(Math.random() * 3);
    const start = ctx.currentTime + 0.3;
    const minor = mood !== 'day';
    for (let b = 0; b < bars; b++) {
      const deg = prog[b % prog.length];
      const t = start + b * barLen;
      const third = minor && (deg === 0 || deg === 5) ? 3 : 4;
      [0, third, 7].forEach((iv, i) => this.pad(root * 2 ** ((deg + iv - 12) / 12), t, barLen * 1.15, 0.035 - i * 0.006));
      const notes = 2 + Math.floor(Math.random() * 4);
      for (let k = 0; k < notes; k++) {
        if (Math.random() < 0.2) continue;
        const s = scale[Math.floor(Math.random() * scale.length)] + (Math.random() < 0.3 ? 12 : 0);
        const nt = t + (k / notes) * barLen + Math.random() * 0.15;
        this.pluck(root * 2 ** ((s + 12) / 12), nt, 0.06 + Math.random() * 0.03);
      }
    }
  }

  pad(f, t, dur, vol) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + dur * 0.35);
    g.gain.linearRampToValueAtTime(0, t + dur);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 900;
    for (const det of [-6, 5]) {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = f;
      o.detune.value = det;
      o.connect(lp);
      o.start(t);
      o.stop(t + dur + 0.1);
    }
    lp.connect(g);
    g.connect(this.music);
  }

  pluck(f, t, vol) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0006, t + 2.6);
    for (const [mult, k] of [[1, 1], [2, 0.35], [3, 0.12], [4.01, 0.06]]) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f * mult;
      const og = ctx.createGain();
      og.gain.value = k;
      o.connect(og); og.connect(g);
      o.start(t); o.stop(t + 2.7);
    }
    g.connect(this.music);
  }
}
