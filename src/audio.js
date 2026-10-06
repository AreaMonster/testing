// Procedural sound effects and a gentle generative ambient score (Web Audio).

const MATERIAL = {
  stone: { f: 1700, q: 1.4, dur: 0.11, type: 'bandpass' },
  gravel: { f: 1100, q: 0.7, dur: 0.14, type: 'bandpass' },
  grass: { f: 700, q: 0.5, dur: 0.15, type: 'lowpass' },
  wood: { f: 900, q: 1.2, dur: 0.1, type: 'bandpass', knock: 210 },
  sand: { f: 2800, q: 0.4, dur: 0.16, type: 'highpass' },
  snow: { f: 1300, q: 0.4, dur: 0.15, type: 'lowpass' },
  wool: { f: 450, q: 0.4, dur: 0.14, type: 'lowpass' },
  glass: { f: 5200, q: 2.0, dur: 0.08, type: 'bandpass', ring: true },
  metal: { f: 2400, q: 3, dur: 0.1, type: 'bandpass', knock: 820 },
};
const SCALE = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21];

export class Audio {
  constructor() {
    this.ctx = null;
    this.sfxVol = 0.8;
    this.musicVol = 0.4;
    this.nextPhrase = 20;
    this.musicT = 0;
  }

  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.ctx = ctx;
      this.master = ctx.createGain();
      this.master.connect(ctx.destination);
      this.sfx = ctx.createGain();
      this.sfx.gain.value = this.sfxVol;
      this.sfx.connect(this.master);
      this.music = ctx.createGain();
      this.music.gain.value = this.musicVol * 0.5;
      const len = ctx.sampleRate;
      this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      // Simple generated reverb for the music bus.
      const irLen = ctx.sampleRate * 3;
      const ir = ctx.createBuffer(2, irLen, ctx.sampleRate);
      for (let ch = 0; ch < 2; ch++) {
        const c = ir.getChannelData(ch);
        for (let i = 0; i < irLen; i++) c[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / irLen, 2.6);
      }
      this.reverb = ctx.createConvolver();
      this.reverb.buffer = ir;
      const wet = ctx.createGain();
      wet.gain.value = 0.55;
      this.music.connect(this.reverb);
      this.reverb.connect(wet);
      wet.connect(this.master);
      this.music.connect(this.master);
    } catch (e) {
      this.ctx = null;
    }
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

  burst(dest, { f, q, dur, type }, vol, pitch = 1, delay = 0) {
    const ctx = this.ctx, t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = pitch;
    const filt = ctx.createBiquadFilter();
    filt.type = type;
    filt.frequency.value = f * pitch;
    filt.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(filt);
    filt.connect(g);
    g.connect(dest);
    src.start(t, Math.random() * 0.5, dur + 0.05);
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
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g);
    g.connect(dest);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  block(material, kind, pos) {
    if (!this.ctx) return;
    const m = MATERIAL[material] || MATERIAL.stone;
    const dest = pos ? this.out(pos[0], pos[1], pos[2], pos[3]) : this.out();
    const vol = kind === 'step' ? 0.16 : kind === 'hit' ? 0.22 : 0.42;
    const pitch = (kind === 'place' ? 0.9 : 1) * (0.85 + Math.random() * 0.3);
    const dur = kind === 'break' ? m.dur * 1.6 : m.dur;
    this.burst(dest, { ...m, dur }, vol, pitch);
    if (kind === 'break') this.burst(dest, { ...m, dur: m.dur * 1.2 }, vol * 0.6, pitch * 0.8, 0.05);
    if (m.knock) this.tone(dest, { f: m.knock * pitch, f2: m.knock * 0.6, dur: 0.09, type: 'triangle', vol: vol * 0.7 });
    if (m.ring && kind === 'break') for (let i = 0; i < 4; i++) this.tone(dest, { f: 2200 + Math.random() * 3000, dur: 0.25, vol: 0.05, delay: i * 0.03 });
  }

  play(name, o = {}) {
    if (!this.ctx) return;
    const dest = this.out();
    const vol = o.vol ?? 0.5, p = o.pitch ?? 1;
    switch (name) {
      case 'pop': this.tone(dest, { f: 500 * p, f2: 1100 * p, dur: 0.08, vol: vol * 0.5 }); break;
      case 'click': this.tone(dest, { f: 1300, f2: 900, dur: 0.04, type: 'square', vol: 0.06 }); break;
      case 'hurt':
        this.tone(dest, { f: 330, f2: 160, dur: 0.22, type: 'sawtooth', vol: 0.18 });
        this.burst(dest, { f: 600, q: 0.8, dur: 0.15, type: 'lowpass' }, 0.25);
        break;
      case 'eat':
        for (let i = 0; i < 3; i++) this.burst(dest, { f: 1500, q: 1, dur: 0.07, type: 'bandpass' }, 0.25, 0.8 + Math.random() * 0.4, i * 0.12);
        break;
      case 'burp': this.tone(dest, { f: 120, f2: 80, dur: 0.3, type: 'sawtooth', vol: 0.12 }); break;
      case 'splash': this.burst(dest, { f: 1200, q: 0.4, dur: 0.5, type: 'lowpass' }, 0.35); break;
      case 'swing': this.burst(dest, { f: 2200, q: 0.6, dur: 0.09, type: 'highpass' }, 0.07); break;
      case 'toolbreak':
        this.burst(dest, { f: 3000, q: 2, dur: 0.2, type: 'bandpass' }, 0.4);
        this.tone(dest, { f: 900, f2: 300, dur: 0.25, type: 'square', vol: 0.08 });
        break;
      case 'fizz': this.burst(dest, { f: 4000, q: 0.3, dur: 0.6, type: 'highpass' }, 0.2); break;
      case 'level': [0, 4, 7].forEach((s, i) => this.tone(dest, { f: 523 * 2 ** (s / 12), dur: 0.35, vol: 0.12, delay: i * 0.09 })); break;
    }
  }

  mob(type, x, y, z, yaw, hurt) {
    if (!this.ctx) return;
    const dest = this.out(x, y, z, yaw);
    const ctx = this.ctx, t = ctx.currentTime;
    const voice = (f0, f1, dur, formant, vib = 0, vol = 0.18) => {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(f0, t);
      o.frequency.linearRampToValueAtTime(f1, t + dur);
      if (vib) {
        const l = ctx.createOscillator(), lg = ctx.createGain();
        l.frequency.value = vib; lg.gain.value = f0 * 0.06;
        l.connect(lg); lg.connect(o.frequency); l.start(t); l.stop(t + dur + 0.05);
      }
      const filt = ctx.createBiquadFilter();
      filt.type = 'bandpass'; filt.frequency.value = formant; filt.Q.value = 1.6;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(vol, t + 0.04);
      g.gain.setValueAtTime(vol, t + dur * 0.7);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      o.connect(filt); filt.connect(g); g.connect(dest);
      o.start(t); o.stop(t + dur + 0.05);
    };
    const k = hurt ? 1.3 : 1;
    switch (type) {
      case 'pig': voice(180 * k, 120 * k, 0.25, 700, 28); break;
      case 'cow': voice(130 * k, 95 * k, hurt ? 0.4 : 0.9, 500, 0, 0.22); break;
      case 'sheep': voice(300 * k, 280 * k, 0.55, 1100, 7); break;
      case 'ghoul': voice(90 * k, 70 * k, hurt ? 0.3 : 0.8, 380, 4, 0.25); this.burst(dest, { f: 500, q: 0.6, dur: 0.6, type: 'lowpass' }, 0.08); break;
    }
  }

  // Sparse generative ambient: soft pentatonic phrases with reverb.
  update(dt, enabled, mood = 0) {
    if (!this.ctx || !enabled || this.musicVol <= 0) return;
    this.musicT += dt;
    if (this.musicT < this.nextPhrase) return;
    this.musicT = 0;
    this.nextPhrase = 40 + Math.random() * 70;
    const ctx = this.ctx;
    const root = [196, 220, 174.6, 233.1][Math.floor(Math.random() * 4)] * (mood ? 0.75 : 1);
    const n = 6 + Math.floor(Math.random() * 9);
    let t = 0.2, step = Math.floor(Math.random() * 4);
    for (let i = 0; i < n; i++) {
      step = Math.max(0, Math.min(SCALE.length - 1, step + Math.floor(Math.random() * 5) - 2));
      const f = root * 2 ** (SCALE[step] / 12);
      const dur = 2.5 + Math.random() * 2;
      const o = ctx.createOscillator(), o2 = ctx.createOscillator();
      o.type = 'sine'; o2.type = 'triangle';
      o.frequency.value = f; o2.frequency.value = f * 2.001;
      const g = ctx.createGain(), g2 = ctx.createGain();
      const st = ctx.currentTime + t;
      g.gain.setValueAtTime(0, st);
      g.gain.linearRampToValueAtTime(0.12, st + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0008, st + dur);
      g2.gain.value = 0.25;
      o.connect(g); o2.connect(g2); g2.connect(g); g.connect(this.music);
      o.start(st); o2.start(st); o.stop(st + dur + 0.1); o2.stop(st + dur + 0.1);
      if (Math.random() < 0.3) {
        const lo = ctx.createOscillator(), lg = ctx.createGain();
        lo.type = 'sine'; lo.frequency.value = f / 2;
        lg.gain.setValueAtTime(0, st);
        lg.gain.linearRampToValueAtTime(0.06, st + 0.05);
        lg.gain.exponentialRampToValueAtTime(0.0008, st + dur * 1.4);
        lo.connect(lg); lg.connect(this.music);
        lo.start(st); lo.stop(st + dur * 1.4 + 0.1);
      }
      t += [0.45, 0.6, 0.9, 1.2][Math.floor(Math.random() * 4)];
    }
  }
}
