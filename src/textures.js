// Procedural 16x16 pixel-art textures. Every block, item, mob skin and crack
// stage is painted here at startup into one texture array.
import { mulberry32, hashStr } from './noise.js';
import { WOOL_COLORS, TERRACOTTA_COLORS, BLOCKS, ITEMS, R, TEXL, FRONTL, itemDef } from './blocks.js';

export const LAYERS = {};
export const layerData = [];

class Px {
  constructor(d) { this.d = d; }
  set(x, y, c, a = 255) {
    if (x < 0 || y < 0 || x > 15 || y > 15) return;
    const i = (y * 16 + x) * 4, d = this.d;
    d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = a;
  }
  get(x, y) {
    const i = ((y & 15) * 16 + (x & 15)) * 4, d = this.d;
    return [d[i], d[i + 1], d[i + 2], d[i + 3]];
  }
  alpha(x, y) { return this.d[((y & 15) * 16 + (x & 15)) * 4 + 3]; }
  each(fn) { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) fn(x, y); }
}

const mul = (c, f) => [c[0] * f, c[1] * f, c[2] * f];
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const quant = (v, n) => Math.round(v * (n - 1)) / (n - 1);

function field(rnd, passes = 1) {
  let f = new Float32Array(256);
  for (let i = 0; i < 256; i++) f[i] = rnd();
  for (let p = 0; p < passes; p++) {
    const g = new Float32Array(256);
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      let s = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += f[((y + dy) & 15) * 16 + ((x + dx) & 15)];
      g[y * 16 + x] = s / 9;
    }
    f = g;
  }
  let mn = 1e9, mx = -1e9;
  for (const v of f) { if (v < mn) mn = v; if (v > mx) mx = v; }
  for (let i = 0; i < 256; i++) f[i] = (f[i] - mn) / (mx - mn || 1);
  return f;
}

function voronoi(rnd, n) {
  const pts = [];
  for (let i = 0; i < n; i++) pts.push([rnd() * 16, rnd() * 16, rnd()]);
  return (x, y) => {
    let d1 = 1e9, d2 = 1e9, id = 0;
    pts.forEach((p, i) => {
      for (let ox = -16; ox <= 16; ox += 16) for (let oy = -16; oy <= 16; oy += 16) {
        const d = Math.hypot(x + 0.5 - p[0] - ox, y + 0.5 - p[1] - oy);
        if (d < d1) { d2 = d1; d1 = d; id = i; } else if (d < d2) d2 = d;
      }
    });
    return { d1, d2, id, v: pts[id][2] };
  };
}

function noiseFill(px, rnd, base, amp, levels = 5, passes = 1) {
  const f = field(rnd, passes);
  px.each((x, y) => {
    const v = 1 + (quant(f[y * 16 + x] * 0.65 + rnd() * 0.35, levels) - 0.5) * amp;
    px.set(x, y, mul(base, v));
  });
}

function add(name, painter) {
  const d = new Uint8ClampedArray(16 * 16 * 4);
  const rnd = mulberry32(hashStr(name) ^ 0x51ed);
  painter(new Px(d), rnd);
  LAYERS[name] = layerData.length;
  layerData.push(d);
}

// ---------- terrain painters ----------
const paintStone = (px, rnd) => {
  noiseFill(px, rnd, [122, 122, 124], 0.32, 5, 1);
  for (let i = 0; i < 4; i++) {
    let x = Math.floor(rnd() * 16), y = Math.floor(rnd() * 16);
    for (let k = 0; k < 3; k++) { px.set(x, y, mul(px.get(x, y), 0.82)); x += rnd() < 0.5 ? 1 : 0; y += 1; }
  }
};
const paintDirt = (px, rnd) => {
  noiseFill(px, rnd, [122, 86, 58], 0.38, 5, 1);
  for (let i = 0; i < 14; i++) px.set(Math.floor(rnd() * 16), Math.floor(rnd() * 16), rnd() < 0.5 ? [150, 112, 80] : [92, 64, 42]);
};
const paintCobble = (px, rnd, tone = [128, 128, 128]) => {
  const vo = voronoi(rnd, 11);
  px.each((x, y) => {
    const c = vo(x, y);
    if (c.d2 - c.d1 < 1.1) px.set(x, y, mul(tone, 0.55 + rnd() * 0.08));
    else {
      const edge = Math.min(1, (c.d2 - c.d1) / 3);
      const v = (0.78 + c.v * 0.3) * (0.92 + edge * 0.12) * (0.95 + rnd() * 0.1);
      px.set(x, y, mul(tone, v));
    }
  });
};
const paintPlanks = (base) => (px, rnd) => {
  const f = field(rnd, 0);
  px.each((x, y) => {
    const board = y >> 2;
    let v = 0.9 + f[y * 16 + x] * 0.12 + Math.sin((x + board * 7) * 0.9) * 0.03;
    if (y % 4 === 3) v = 0.66;
    if (x === (board * 5 + 3) % 16 && y % 4 !== 3) v *= 0.72;
    px.set(x, y, mul(base, v));
  });
};
const paintBark = (base, dark) => (px, rnd) => {
  const cols = [];
  for (let x = 0; x < 16; x++) cols.push(0.82 + rnd() * 0.28);
  px.each((x, y) => {
    const crevice = (x % 5 === 1 || x % 7 === 4) && rnd() < 0.8;
    px.set(x, y, crevice ? mul(dark, 0.9 + rnd() * 0.15) : mul(base, cols[x] * (0.92 + rnd() * 0.14)));
  });
};
const paintLogTop = (ringA, ringB, bark) => (px) => {
  px.each((x, y) => {
    if (x === 0 || y === 0 || x === 15 || y === 15) return px.set(x, y, bark);
    const d = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5)) + Math.hypot(x - 7.5, y - 7.5) * 0.2;
    px.set(x, y, Math.floor(d * 0.9) % 2 ? ringA : ringB);
  });
};
const paintLeaves = (px, rnd) => {
  const f = field(rnd, 1);
  px.each((x, y) => {
    if (rnd() < 0.16) return px.set(x, y, [0, 0, 0], 0);
    const v = 0.55 + quant(f[y * 16 + x], 4) * 0.45 + rnd() * 0.08;
    px.set(x, y, [200 * v, 200 * v, 200 * v]);
  });
};
const paintOre = (color, hi) => (px, rnd) => {
  paintStone(px, rnd);
  const n = 4 + Math.floor(rnd() * 2);
  for (let i = 0; i < n; i++) {
    let x = 2 + Math.floor(rnd() * 12), y = 2 + Math.floor(rnd() * 12);
    const k = 2 + Math.floor(rnd() * 3);
    for (let j = 0; j < k; j++) {
      px.set(x, y, j === 0 ? hi : mul(color, 0.85 + rnd() * 0.25));
      if (rnd() < 0.5) x += rnd() < 0.5 ? 1 : -1; else y += rnd() < 0.5 ? 1 : -1;
    }
  }
};
const paintMetalBlock = (base, edge) => (px, rnd) => {
  px.each((x, y) => {
    let c = mul(base, 0.95 + rnd() * 0.07);
    if (x === 0 || y === 0) c = mul(base, 1.12);
    if (x === 15 || y === 15) c = edge;
    if ((x === 2 || x === 13) && (y === 2 || y === 13)) c = edge;
    if (y === 7 && x > 1 && x < 14) c = mul(base, 0.88);
    px.set(x, y, c);
  });
};

add('stone', paintStone);
add('dirt', paintDirt);
add('grass_top', (px, rnd) => {
  noiseFill(px, rnd, [196, 196, 196], 0.4, 5, 1);
  for (let i = 0; i < 18; i++) px.set(Math.floor(rnd() * 16), Math.floor(rnd() * 16), [224, 224, 224]);
});
add('grass_side', (px, rnd) => {
  paintDirt(px, rnd);
  for (let x = 0; x < 16; x++) {
    const h = 3 + (rnd() < 0.45 ? 1 : 0) + (rnd() < 0.15 ? 2 : 0);
    for (let y = 0; y < h; y++) px.set(x, y, mul([96, 150, 60], 0.85 + rnd() * 0.25));
  }
});
add('grass_side_snow', (px, rnd) => {
  paintDirt(px, rnd);
  for (let x = 0; x < 16; x++) {
    const h = 3 + (rnd() < 0.5 ? 1 : 0) + (rnd() < 0.12 ? 1 : 0);
    for (let y = 0; y < h; y++) px.set(x, y, mul([240, 246, 252], 0.94 + rnd() * 0.06));
  }
});
add('cobblestone', (px, rnd) => paintCobble(px, rnd));
add('mossy_cobble', (px, rnd) => {
  paintCobble(px, rnd);
  const f = field(rnd, 2);
  px.each((x, y) => { if (f[y * 16 + x] > 0.6) px.set(x, y, mul([78, 116, 48], 0.8 + rnd() * 0.35)); });
});
add('planks_oak', paintPlanks([168, 134, 82]));
add('planks_birch', paintPlanks([204, 186, 130]));
add('planks_spruce', paintPlanks([118, 86, 52]));
add('bedrock', (px, rnd) => {
  const f = field(rnd, 1);
  px.each((x, y) => { const v = quant(f[y * 16 + x] * 0.6 + rnd() * 0.4, 4); px.set(x, y, mul([120, 120, 124], 0.25 + v * 0.75)); });
});
add('sand', (px, rnd) => {
  noiseFill(px, rnd, [220, 206, 158], 0.14, 4, 1);
  for (let i = 0; i < 10; i++) px.set(Math.floor(rnd() * 16), Math.floor(rnd() * 16), [196, 180, 132]);
});
add('gravel', (px, rnd) => {
  const pal = [[134, 128, 124], [112, 106, 102], [156, 150, 146], [94, 90, 88], [142, 126, 112]];
  const vo = voronoi(rnd, 22);
  px.each((x, y) => {
    const c = vo(x, y);
    const base = pal[Math.floor(c.v * pal.length)];
    px.set(x, y, c.d2 - c.d1 < 0.7 ? mul(base, 0.7) : mul(base, 0.92 + rnd() * 0.14));
  });
});
add('log_oak', paintBark([108, 84, 52], [70, 54, 32]));
add('log_oak_top', paintLogTop([182, 146, 92], [154, 120, 72], [98, 76, 46]));
add('log_birch', (px, rnd) => {
  px.each((x, y) => px.set(x, y, mul([218, 216, 206], 0.92 + rnd() * 0.1)));
  for (let i = 0; i < 7; i++) {
    const x = Math.floor(rnd() * 14), y = Math.floor(rnd() * 16), l = 2 + Math.floor(rnd() * 3);
    for (let k = 0; k < l; k++) px.set(x + k, y, [52, 48, 44]);
  }
});
add('log_birch_top', paintLogTop([206, 186, 136], [184, 164, 116], [214, 212, 202]));
add('log_spruce', paintBark([78, 56, 36], [50, 36, 22]));
add('log_spruce_top', paintLogTop([142, 106, 66], [114, 82, 50], [62, 44, 28]));
add('leaves_oak', paintLeaves);
add('leaves_birch', paintLeaves);
add('leaves_spruce', paintLeaves);
add('glass', (px) => {
  px.each((x, y) => {
    const edge = x === 0 || y === 0 || x === 15 || y === 15;
    if (edge) px.set(x, y, [214, 236, 242], 255);
    else if ((x - y === 3 && x > 3 && x < 8) || (x - y === 5 && x > 6 && x < 10)) px.set(x, y, [255, 255, 255], 170);
    else px.set(x, y, [200, 230, 240], 18);
  });
});
add('water', (px, rnd) => {
  const f = field(rnd, 2);
  px.each((x, y) => {
    const v = f[y * 16 + x];
    const c = mix([38, 84, 200], [80, 140, 235], quant(v, 4));
    px.set(x, y, c, 170 + v * 30);
  });
});
add('lava', (px, rnd) => {
  const f = field(rnd, 2);
  px.each((x, y) => {
    const v = quant(f[y * 16 + x] * 0.85 + rnd() * 0.15, 5);
    const c = v < 0.5 ? mix([170, 40, 8], [232, 104, 22], v * 2) : mix([232, 104, 22], [255, 212, 70], (v - 0.5) * 2);
    px.set(x, y, c);
  });
});
add('coal_ore', paintOre([34, 34, 38], [70, 70, 76]));
add('iron_ore', paintOre([214, 168, 136], [240, 210, 186]));
add('gold_ore', paintOre([246, 210, 52], [255, 246, 160]));
add('diamond_ore', paintOre([84, 220, 214], [200, 255, 250]));
add('snow', (px, rnd) => noiseFill(px, rnd, [242, 248, 252], 0.06, 3, 1));
add('ice', (px, rnd) => {
  const f = field(rnd, 2);
  px.each((x, y) => {
    let c = mul([150, 188, 246], 0.92 + f[y * 16 + x] * 0.12);
    if ((x + y) % 11 === 0 && rnd() < 0.7) c = [214, 232, 255];
    px.set(x, y, c);
  });
});
add('cactus_side', (px, rnd) => {
  px.each((x, y) => {
    let c = mul([82, 138, 48], 0.92 + rnd() * 0.1);
    if (x === 3 || x === 8 || x === 12) c = [108, 168, 66];
    if (x === 0 || x === 15) c = [48, 88, 30];
    px.set(x, y, c);
  });
  for (let i = 0; i < 10; i++) px.set([2, 4, 7, 9, 11, 13][Math.floor(rnd() * 6)], Math.floor(rnd() * 16), [236, 230, 176]);
});
add('cactus_top', (px, rnd) => {
  px.each((x, y) => {
    const d = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5));
    let c = mul([96, 150, 58], 0.94 + rnd() * 0.08);
    if (d > 6.6) c = [48, 88, 30];
    else if (Math.floor(d) === 4) c = [74, 124, 42];
    px.set(x, y, c);
  });
});

// ---------- plants ----------
const clear = (px) => px.each((x, y) => px.set(x, y, [0, 0, 0], 0));
add('tall_grass', (px, rnd) => {
  clear(px);
  for (let i = 0; i < 22; i++) {
    let x = 1.5 + rnd() * 13;
    const h = 3 + Math.floor(rnd() * 10), lean = (rnd() - 0.5) * 0.35;
    for (let k = 0; k < h; k++) {
      const v = 0.5 + (k / h) * 0.5 + rnd() * 0.08;
      px.set(Math.round(x), 15 - k, [190 * v, 190 * v, 190 * v]);
      x += lean * (k / h + 0.3);
    }
  }
});
const flower = (petal, center) => (px) => {
  clear(px);
  for (let y = 8; y < 16; y++) px.set(7, y, [56, 116, 38]);
  px.set(6, 11, [70, 136, 46]); px.set(5, 10, [70, 136, 46]); px.set(8, 13, [70, 136, 46]); px.set(9, 12, [70, 136, 46]);
  const pts = [[6, 4], [7, 4], [8, 4], [5, 5], [6, 5], [8, 5], [9, 5], [5, 6], [6, 6], [8, 6], [9, 6], [6, 7], [7, 7], [8, 7], [7, 3]];
  for (const [x, y] of pts) px.set(x, y, mul(petal, y < 5 ? 1.08 : 0.94));
  px.set(7, 5, center); px.set(7, 6, center);
};
add('poppy', flower([206, 34, 38], [40, 24, 20]));
add('buttercup', flower([244, 214, 46], [214, 140, 20]));
add('dead_bush', (px) => {
  clear(px);
  const c = [124, 88, 42], d = [96, 66, 30];
  for (let y = 9; y < 16; y++) px.set(7, y, c);
  [[6, 8], [5, 7], [4, 6], [3, 5], [8, 8], [9, 7], [10, 6], [11, 5], [12, 4], [7, 8], [7, 7], [7, 6], [6, 5], [8, 5], [9, 4], [4, 9], [3, 8], [10, 10], [11, 9]].forEach(([x, y], i) => px.set(x, y, i % 3 ? c : d));
});
const sapling = (leaf, stem) => (px, rnd) => {
  clear(px);
  for (let y = 9; y < 16; y++) px.set(7, y, stem);
  for (let y = 2; y < 11; y++) for (let x = 3; x < 12; x++) {
    const d = Math.hypot(x - 7, y - 6);
    if (d < 4.2 && rnd() < 0.85) px.set(x, y, mul(leaf, 0.75 + rnd() * 0.35));
  }
};
add('sapling_oak', sapling([64, 132, 40], [108, 84, 52]));
add('sapling_birch', sapling([110, 160, 70], [214, 212, 200]));
add('sapling_spruce', (px, rnd) => {
  clear(px);
  for (let y = 10; y < 16; y++) px.set(7, y, [78, 56, 36]);
  for (let y = 1; y < 12; y++) {
    const w = Math.floor((y - 1) / 2) + (y % 2);
    for (let x = 7 - w; x <= 7 + w; x++) px.set(x, y, mul([46, 92, 52], 0.75 + rnd() * 0.35));
  }
});
add('torch', (px) => {
  clear(px);
  for (let y = 8; y < 16; y++) { px.set(7, y, [138, 104, 62]); px.set(8, y, [100, 74, 42]); }
  px.set(7, 6, [255, 244, 170]); px.set(8, 6, [255, 222, 110]);
  px.set(7, 7, [255, 182, 60]); px.set(8, 7, [236, 136, 36]);
});

// ---------- crafted blocks ----------
add('crafting_top', (px, rnd) => {
  paintPlanks([168, 134, 82])(px, rnd);
  px.each((x, y) => {
    if (x === 0 || y === 0 || x === 15 || y === 15) px.set(x, y, [96, 64, 34]);
    else if ((x === 5 || x === 10 || y === 5 || y === 10) && x > 1 && x < 14 && y > 1 && y < 14) px.set(x, y, [118, 84, 46]);
  });
});
const craftSide = (front) => (px, rnd) => {
  paintPlanks([150, 116, 70])(px, rnd);
  for (let x = 0; x < 16; x++) { px.set(x, 0, [96, 64, 34]); px.set(x, 1, [124, 92, 52]); }
  const metal = [178, 178, 184], handle = [90, 60, 32];
  if (front) {
    for (let y = 4; y < 12; y++) px.set(3, y, metal);
    for (let y = 4; y < 9; y++) px.set(4, y, [150, 150, 156]);
    px.set(3, 12, handle); px.set(3, 13, handle);
    for (let x = 9; x < 14; x++) px.set(x, 4, metal);
    for (let y = 5; y < 13; y++) px.set(11, y, handle);
  } else {
    for (let x = 4; x < 12; x++) px.set(x, 6, [110, 78, 40]);
    for (let y = 7; y < 13; y++) { px.set(5, y, handle); px.set(10, y, handle); }
  }
};
add('crafting_side', craftSide(false));
add('crafting_front', craftSide(true));
const paintSmooth = (px, rnd) => {
  noiseFill(px, rnd, [128, 128, 130], 0.12, 4, 2);
  px.each((x, y) => { if (y === 0 || y === 15) px.set(x, y, [96, 96, 98]); });
};
add('furnace_side', paintSmooth);
add('furnace_top', (px, rnd) => noiseFill(px, rnd, [138, 138, 140], 0.12, 4, 2));
add('furnace_front', (px, rnd) => {
  paintSmooth(px, rnd);
  for (let x = 3; x < 13; x++) { px.set(x, 7, [86, 86, 88]); for (let y = 8; y < 14; y++) px.set(x, y, y > 11 ? [40, 34, 30] : [22, 20, 20]); }
  for (let y = 7; y < 14; y++) { px.set(2, y, [92, 92, 94]); px.set(13, y, [92, 92, 94]); }
  for (let x = 4; x < 12; x++) { px.set(x, 2, [80, 80, 82]); px.set(x, 4, [80, 80, 82]); }
});
const chestWood = (px, rnd) => {
  px.each((x, y) => {
    let c = mul([170, 116, 52], 0.9 + rnd() * 0.12);
    if (x === 0 || y === 0 || x === 15 || y === 15) c = [86, 56, 24];
    px.set(x, y, c);
  });
};
add('chest_top', chestWood);
add('chest_side', (px, rnd) => { chestWood(px, rnd); for (let x = 0; x < 16; x++) px.set(x, 5, [86, 56, 24]); });
add('chest_front', (px, rnd) => {
  chestWood(px, rnd);
  for (let x = 0; x < 16; x++) px.set(x, 5, [86, 56, 24]);
  for (let y = 4; y < 8; y++) { px.set(7, y, [210, 210, 214]); px.set(8, y, [170, 170, 176]); }
});
add('bricks', (px, rnd) => {
  const tones = [];
  for (let i = 0; i < 16; i++) tones.push(0.82 + rnd() * 0.28);
  px.each((x, y) => {
    const row = y >> 2, off = row % 2 ? 4 : 0;
    if (y % 4 === 3 || (x + off) % 8 === 7) return px.set(x, y, mul([176, 168, 156], 0.92 + rnd() * 0.1));
    const id = row * 2 + (((x + off) >> 3) & 1);
    px.set(x, y, mul([150, 70, 52], tones[id] * (0.94 + rnd() * 0.1)));
  });
});
add('stone_bricks', (px, rnd) => {
  px.each((x, y) => {
    const row = y >> 3, off = row ? 4 : 0;
    if (y % 8 === 7 || (x + off) % 8 === 7) return px.set(x, y, [84, 84, 86]);
    let v = 0.92 + rnd() * 0.1;
    if (y % 8 === 0 || (x + off) % 8 === 0) v = 1.08;
    px.set(x, y, mul([124, 124, 126], v));
  });
});
add('sandstone_side', (px, rnd) => {
  px.each((x, y) => {
    let c = mul([216, 200, 148], 0.95 + rnd() * 0.07);
    if (y < 3) c = mul([226, 212, 162], 0.97 + rnd() * 0.05);
    if (y === 3 || y === 12) c = [190, 172, 120];
    px.set(x, y, c);
  });
});
add('sandstone_top', (px, rnd) => noiseFill(px, rnd, [222, 208, 158], 0.08, 3, 2));
add('lumen', (px, rnd) => {
  const vo = voronoi(rnd, 9);
  px.each((x, y) => {
    const c = vo(x, y);
    if (c.d2 - c.d1 < 0.8) return px.set(x, y, [150, 104, 50]);
    const v = Math.max(0, 1 - c.d1 / 4);
    px.set(x, y, mix([226, 166, 70], [255, 246, 196], v * (0.8 + c.v * 0.3)));
  });
});
add('bookshelf', (px, rnd) => {
  paintPlanks([168, 134, 82])(px, rnd);
  const cols = [[150, 40, 40], [40, 80, 150], [62, 122, 62], [168, 134, 50], [112, 60, 132], [60, 54, 50]];
  for (const top of [1, 9]) {
    let x = 1;
    while (x < 15) {
      const w = rnd() < 0.7 ? 1 : 2, h = 5 + (rnd() < 0.3 ? 1 : 0), c = cols[Math.floor(rnd() * cols.length)];
      for (let i = 0; i < w && x + i < 15; i++) for (let y = 0; y < h; y++) px.set(x + i, top + 6 - h + y, y === 1 ? mul(c, 1.25) : c);
      x += w;
    }
  }
  for (let x = 0; x < 16; x++) { px.set(x, 0, [110, 82, 46]); px.set(x, 7, [110, 82, 46]); px.set(x, 8, [140, 108, 64]); px.set(x, 15, [110, 82, 46]); }
});
add('clay', (px, rnd) => noiseFill(px, rnd, [160, 166, 180], 0.1, 4, 2));
add('obsidian', (px, rnd) => {
  const f = field(rnd, 1);
  px.each((x, y) => {
    const v = f[y * 16 + x];
    px.set(x, y, v > 0.75 ? [74, 52, 104] : v > 0.55 ? [44, 30, 66] : mul([20, 16, 30], 0.85 + rnd() * 0.3));
  });
});
add('iron_block', paintMetalBlock([218, 218, 222], [166, 166, 172]));
add('gold_block', paintMetalBlock([250, 212, 64], [196, 150, 30]));
add('diamond_block', paintMetalBlock([104, 226, 220], [48, 172, 168]));
for (const [k, , col] of WOOL_COLORS) {
  add(`wool_${k.toLowerCase()}`, (px, rnd) => {
    const f = field(rnd, 1);
    px.each((x, y) => {
      let v = 0.88 + f[y * 16 + x] * 0.14;
      if ((x + y * 2) % 5 === 0) v *= 0.95;
      px.set(x, y, mul(col, v));
    });
  });
}

// Break-progress cracks (10 stages).
{
  const rnd = mulberry32(777);
  const order = [];
  const seen = new Set();
  const walkers = [];
  for (let i = 0; i < 7; i++) walkers.push({ x: 7.5, y: 7.5, a: (i / 7) * Math.PI * 2 + rnd() * 0.6 });
  for (let step = 0; step < 12; step++) {
    for (const w of walkers) {
      w.a += (rnd() - 0.5) * 1.1;
      w.x += Math.cos(w.a);
      w.y += Math.sin(w.a);
      const x = Math.round(w.x), y = Math.round(w.y);
      if (x < 0 || y < 0 || x > 15 || y > 15) continue;
      const k = y * 16 + x;
      if (!seen.has(k)) { seen.add(k); order.push([x, y]); }
    }
  }
  for (let s = 0; s < 10; s++) {
    add(`destroy_${s}`, (px) => {
      clear(px);
      const n = Math.floor(((s + 1) / 10) * order.length);
      for (let i = 0; i < n; i++) px.set(order[i][0], order[i][1], [20, 20, 20], 210);
    });
  }
}
add('white', (px) => px.each((x, y) => px.set(x, y, [255, 255, 255])));

// ---------- new terrain textures ----------
add('red_sand', (px, rnd) => {
  noiseFill(px, rnd, [190, 104, 52], 0.14, 4, 1);
  for (let i = 0; i < 10; i++) px.set(Math.floor(rnd() * 16), Math.floor(rnd() * 16), [160, 84, 40]);
});
for (const [k, , col] of TERRACOTTA_COLORS) {
  add(k ? `terracotta_${k.toLowerCase()}` : 'terracotta', (px, rnd) => noiseFill(px, rnd, col, 0.07, 3, 2));
}
add('log_acacia', paintBark([104, 98, 90], [72, 66, 60]));
add('log_acacia_top', paintLogTop([206, 116, 64], [180, 96, 50], [104, 98, 90]));
add('leaves_acacia', paintLeaves);
add('planks_acacia', paintPlanks([176, 96, 54]));
add('podzol_top', (px, rnd) => {
  const f = field(rnd, 1);
  px.each((x, y) => {
    const v = f[y * 16 + x];
    px.set(x, y, v > 0.7 ? [140, 100, 48] : v > 0.4 ? mul([98, 66, 34], 0.9 + rnd() * 0.2) : mul([76, 52, 30], 0.9 + rnd() * 0.2));
  });
});
add('podzol_side', (px, rnd) => {
  paintDirt(px, rnd);
  for (let x = 0; x < 16; x++) {
    const h = 2 + (rnd() < 0.5 ? 1 : 0);
    for (let y = 0; y < h; y++) px.set(x, y, mul([92, 62, 32], 0.85 + rnd() * 0.3));
  }
});
const pumpkinSide = (px, rnd) => {
  px.each((x, y) => {
    let c = mul([214, 122, 30], 0.92 + rnd() * 0.08);
    if (x % 4 === 0) c = mul([180, 96, 22], 0.95 + rnd() * 0.08);
    if (y === 0 || y === 15) c = mul(c, 0.85);
    px.set(x, y, c);
  });
};
add('pumpkin_side', pumpkinSide);
add('pumpkin_top', (px, rnd) => {
  px.each((x, y) => {
    const d = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5));
    px.set(x, y, mul(d > 6 ? [190, 104, 24] : [214, 122, 30], 0.92 + rnd() * 0.08));
  });
  for (let y = 6; y < 10; y++) for (let x = 7; x < 9; x++) px.set(x, y, [96, 82, 34]);
});
add('pumpkin_face', (px, rnd) => {
  pumpkinSide(px, rnd);
  const glow = (x, y) => px.set(x, y, [255, 216, 90]);
  [[3, 4], [4, 4], [3, 5], [4, 5], [5, 5], [11, 4], [12, 4], [10, 5], [11, 5], [12, 5], [7, 7], [8, 7]].forEach(([x, y]) => glow(x, y));
  for (let x = 3; x < 13; x++) { glow(x, 10); if (x % 3 !== 0) glow(x, 11); }
  glow(4, 9); glow(11, 9);
});
add('sugar_cane', (px) => {
  clear(px);
  for (const sx of [3, 7, 11]) for (let y = 0; y < 16; y++) {
    const knot = (y + sx) % 5 === 0;
    px.set(sx, y, knot ? [150, 196, 96] : [120, 176, 76]);
    px.set(sx + 1, y, knot ? [120, 166, 76] : [92, 146, 56]);
  }
  [[2, 3], [1, 2], [6, 9], [5, 8], [13, 6], [14, 5]].forEach(([x, y]) => px.set(x, y, [110, 170, 70]));
});
add('fern', (px, rnd) => {
  clear(px);
  for (let i = 0; i < 6; i++) {
    let x = 4 + rnd() * 8, y = 15;
    const dx = (rnd() - 0.5) * 0.8, len = 7 + Math.floor(rnd() * 7);
    for (let k = 0; k < len; k++) {
      const v = 0.55 + (k / len) * 0.4;
      px.set(Math.round(x), y, [200 * v, 200 * v, 200 * v]);
      if (k > 2 && k % 2 === 0) { px.set(Math.round(x) - 1, y, [170 * v, 170 * v, 170 * v]); px.set(Math.round(x) + 1, y, [170 * v, 170 * v, 170 * v]); }
      x += dx; y--;
    }
  }
});
add('cornflower', flower([70, 110, 220], [230, 230, 250]));
add('daisy', flower([244, 244, 238], [236, 196, 52]));
add('shadow', (px) => px.each((x, y) => {
  const d = Math.hypot(x - 7.5, y - 7.5) / 7.5;
  px.set(x, y, [0, 0, 0], Math.max(0, 1 - d * d) * 200);
}));
add('flame', (px) => px.each((x, y) => {
  const d = Math.hypot(x - 7.5, (y - 8.5) * 0.8) / 7;
  px.set(x, y, d < 0.45 ? [255, 246, 190] : [255, 170, 60], d < 1 ? 255 : 0);
}));

// ---------- creature & character skins (original designs) ----------
// Each box face is painted at native resolution into the top-left w×h pixels of
// its own layer; the mesher maps 1 texel to 1 model pixel.
const rect = (px, x0, y0, w, h, c) => { for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) px.set(x, y, c); };
const speck = (px, rnd, base, amp) => px.each((x, y) => px.set(x, y, mul(base, 1 - amp / 2 + rnd() * amp)));
function skinLayer(name, base, amp, paint) {
  add(name, (px, rnd) => { speck(px, rnd, base, amp); if (paint) paint(px, rnd); });
}

// The Wanderer: auburn hair, teal scarf, ochre field jacket with a satchel strap.
const W = {
  skin: [214, 160, 118], skinD: [186, 132, 96], hair: [110, 58, 32], hairD: [82, 42, 24], hairHi: [140, 78, 44],
  eye: [44, 140, 132], white: [242, 240, 234], brow: [74, 38, 22], mouth: [168, 98, 82],
  jacket: [200, 126, 50], jacketD: [166, 98, 36], jacketHi: [222, 150, 72], patch: [132, 84, 46],
  scarf: [44, 126, 132], scarfD: [30, 94, 100], strap: [96, 62, 36], buckle: [212, 180, 86],
  pants: [60, 82, 54], pantsD: [46, 64, 42], boots: [98, 64, 40], sole: [50, 36, 26],
};
const hairNoise = (px, rnd, x0, y0, w, h) => { for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) px.set(x, y, rnd() < 0.25 ? W.hairHi : rnd() < 0.3 ? W.hairD : W.hair); };
skinLayer('wd_head_front', W.skin, 0.05, (px, rnd) => {
  hairNoise(px, rnd, 0, 0, 8, 2);
  hairNoise(px, rnd, 0, 2, 5, 1);
  px.set(0, 3, W.hair); px.set(0, 4, W.hairD); px.set(7, 2, W.hair); px.set(7, 3, W.hairD);
  px.set(1, 3, W.brow); px.set(2, 3, W.brow); px.set(5, 3, W.brow); px.set(6, 3, W.brow);
  px.set(1, 4, W.white); px.set(2, 4, W.eye); px.set(5, 4, W.eye); px.set(6, 4, W.white);
  px.set(3, 5, W.skinD); px.set(4, 5, W.skinD);
  px.set(3, 6, W.mouth); px.set(4, 6, W.mouth);
  px.set(1, 6, [222, 150, 120]); px.set(6, 6, [222, 150, 120]);
});
skinLayer('wd_head_right', W.skin, 0.05, (px, rnd) => { hairNoise(px, rnd, 0, 0, 8, 3); hairNoise(px, rnd, 0, 3, 3, 4); px.set(4, 4, W.skinD); px.set(4, 5, W.skinD); });
skinLayer('wd_head_left', W.skin, 0.05, (px, rnd) => { hairNoise(px, rnd, 0, 0, 8, 3); hairNoise(px, rnd, 5, 3, 3, 4); px.set(3, 4, W.skinD); px.set(3, 5, W.skinD); });
skinLayer('wd_head_back', W.hair, 0.2, (px, rnd) => { hairNoise(px, rnd, 0, 0, 8, 7); rect(px, 0, 7, 8, 1, W.skinD); px.set(3, 5, W.scarf); px.set(4, 5, W.scarf); });
skinLayer('wd_head_top', W.hair, 0.2, (px, rnd) => { hairNoise(px, rnd, 0, 0, 8, 8); for (let y = 0; y < 8; y++) px.set(5, y, W.hairD); });
skinLayer('wd_head_bottom', W.skinD, 0.05);
const jacketBody = (px, rnd, w, strapDir) => {
  for (let y = 2; y < 9; y++) for (let x = 0; x < w; x++) px.set(x, y, rnd() < 0.15 ? W.jacketD : W.jacket);
  rect(px, 0, 0, w, 2, W.scarf);
  for (let x = 0; x < w; x++) if (rnd() < 0.3) px.set(x, 1, W.scarfD);
  rect(px, 0, 9, w, 1, W.strap);
  rect(px, 0, 10, w, 2, W.pants);
  if (strapDir) for (let k = 0; k < 8; k++) px.set(strapDir > 0 ? k : 7 - k, 2 + k, W.strap);
};
skinLayer('wd_body_front', W.jacket, 0.08, (px, rnd) => {
  jacketBody(px, rnd, 8, 1);
  for (let y = 2; y < 9; y++) if (px.get(3, y)[0] !== W.strap[0]) px.set(3, y, W.jacketD);
  px.set(5, 2, W.scarfD); px.set(5, 3, W.scarf); px.set(6, 3, W.scarfD); px.set(5, 4, W.scarfD);
  rect(px, 5, 6, 2, 2, W.jacketD); px.set(5, 6, W.jacketHi);
  px.set(3, 9, W.buckle); px.set(4, 9, W.buckle);
  px.set(1, 11, W.pantsD); px.set(6, 11, W.pantsD);
});
skinLayer('wd_body_back', W.jacket, 0.08, (px, rnd) => { jacketBody(px, rnd, 8, -1); px.set(3, 10, W.pantsD); px.set(4, 10, W.pantsD); });
skinLayer('wd_body_side', W.jacket, 0.08, (px, rnd) => { jacketBody(px, rnd, 4, 0); });
skinLayer('wd_body_side_bag', W.jacket, 0.08, (px, rnd) => {
  jacketBody(px, rnd, 4, 0);
  rect(px, 0, 6, 4, 4, [120, 82, 46]); rect(px, 0, 6, 4, 1, [92, 60, 34]); px.set(1, 7, W.buckle);
});
skinLayer('wd_body_top', W.scarf, 0.1);
skinLayer('wd_body_bottom', W.pants, 0.1);
skinLayer('wd_arm_side', W.jacket, 0.1, (px, rnd) => {
  rect(px, 0, 8, 4, 1, W.jacketD);
  rect(px, 0, 9, 4, 3, W.skin);
  rect(px, 0, 11, 4, 1, W.skinD);
  px.set(1, 5, W.patch); px.set(2, 5, W.patch); px.set(1, 6, W.patch); px.set(2, 6, W.patch);
});
skinLayer('wd_arm_inner', W.jacket, 0.1, (px) => { rect(px, 0, 8, 4, 1, W.jacketD); rect(px, 0, 9, 4, 3, W.skin); rect(px, 0, 11, 4, 1, W.skinD); });
skinLayer('wd_arm_top', W.jacketHi, 0.08);
skinLayer('wd_arm_bottom', W.skinD, 0.05);
skinLayer('wd_leg_side', W.pants, 0.12, (px) => {
  rect(px, 0, 5, 4, 1, W.pantsD);
  rect(px, 0, 8, 4, 1, [72, 48, 30]);
  rect(px, 0, 9, 4, 2, W.boots);
  rect(px, 0, 11, 4, 1, W.sole);
});
skinLayer('wd_leg_top', W.pants, 0.1);
skinLayer('wd_leg_bottom', W.sole, 0.1);

// Ghoul: mottled grey-green skin, ember eyes, rags and a rope belt.
const G = { skin: [116, 132, 102], skinD: [88, 104, 78], cloth: [84, 88, 98], clothD: [62, 64, 72], vest: [94, 70, 46], rope: [150, 130, 86], pants: [58, 54, 52], eye: [255, 112, 40], socket: [24, 22, 22], hair: [44, 42, 36] };
const mottled = (px, rnd) => px.each((x, y) => px.set(x, y, rnd() < 0.3 ? G.skinD : mul(G.skin, 0.94 + rnd() * 0.1)));
add('gh_head_front', (px, rnd) => {
  mottled(px, rnd);
  for (let x = 0; x < 8; x++) if (rnd() < 0.6) px.set(x, 0, G.hair);
  rect(px, 1, 3, 2, 2, G.socket); rect(px, 5, 3, 2, 2, G.socket);
  px.set(2, 4, G.eye); px.set(5, 4, G.eye);
  px.set(3, 5, G.skinD); px.set(4, 5, G.skinD);
  for (let x = 2; x < 6; x++) px.set(x, 6, x % 2 ? G.socket : [196, 190, 160]);
  px.set(6, 1, [140, 80, 70]); px.set(6, 2, [140, 80, 70]);
});
add('gh_head_side', (px, rnd) => { mottled(px, rnd); for (let x = 0; x < 8; x++) if (rnd() < 0.5) px.set(x, 0, G.hair); px.set(3, 4, G.skinD); });
add('gh_head_back', (px, rnd) => { mottled(px, rnd); for (let x = 0; x < 8; x++) for (let y = 0; y < 3; y++) if (rnd() < 0.5) px.set(x, y, G.hair); });
add('gh_head_top', (px, rnd) => { mottled(px, rnd); px.each((x, y) => { if (rnd() < 0.45) px.set(x, y, G.hair); }); });
const rags = (px, rnd, w, front) => {
  px.each((x, y) => px.set(x, y, rnd() < 0.2 ? G.clothD : G.cloth));
  if (front) { rect(px, 0, 0, 2, 9, G.vest); rect(px, w - 2, 0, 2, 9, G.vest); }
  for (let i = 0; i < 4; i++) px.set(2 + Math.floor(rnd() * (w - 4 > 0 ? w - 4 : 1)), 2 + Math.floor(rnd() * 6), G.skinD);
  rect(px, 0, 9, w, 1, G.rope);
  rect(px, 0, 10, w, 6, G.pants);
};
add('gh_body_front', (px, rnd) => rags(px, rnd, 8, true));
add('gh_body_back', (px, rnd) => rags(px, rnd, 8, false));
add('gh_body_side', (px, rnd) => rags(px, rnd, 4, false));
add('gh_body_top', (px, rnd) => speck(px, rnd, G.cloth, 0.15));
add('gh_arm', (px, rnd) => {
  mottled(px, rnd);
  for (let x = 0; x < 4; x++) { const h = 2 + Math.floor(rnd() * 3); for (let y = 0; y < h; y++) px.set(x, y, G.cloth); }
  rect(px, 0, 11, 4, 1, G.skinD);
});
add('gh_leg', (px, rnd) => {
  px.each((x, y) => px.set(x, y, rnd() < 0.2 ? [46, 42, 40] : G.pants));
  for (let x = 0; x < 4; x++) { const h = 9 + Math.floor(rnd() * 2); for (let y = h; y < 16; y++) px.set(x, y, y > 10 ? G.skinD : G.skin); }
});

// Pig
const P_ = { skin: [238, 166, 160], skinD: [214, 136, 136], hoof: [120, 78, 80], snout: [226, 128, 134], nostril: [120, 52, 62] };
const pigSkin = (px, rnd) => px.each((x, y) => px.set(x, y, rnd() < 0.08 ? P_.skinD : mul(P_.skin, 0.96 + rnd() * 0.06)));
add('pig_skin', pigSkin);
add('pig_head_front', (px, rnd) => { pigSkin(px, rnd); px.set(1, 2, [250, 250, 250]); px.set(2, 2, [30, 20, 30]); px.set(5, 2, [30, 20, 30]); px.set(6, 2, [250, 250, 250]); });
add('pig_snout', (px) => { px.each((x, y) => px.set(x, y, P_.snout)); px.set(1, 1, P_.nostril); px.set(2, 1, P_.nostril); px.set(0, 0, P_.skinD); px.set(3, 0, P_.skinD); });
add('pig_leg', (px, rnd) => { pigSkin(px, rnd); rect(px, 0, 5, 4, 2, P_.hoof); });

// Cow
const C_ = { brown: [92, 64, 44], white: [236, 234, 228], muzzle: [212, 180, 156], horn: [232, 222, 194], hoof: [52, 40, 34], udder: [236, 160, 160] };
const cowSkin = (px, rnd) => { const f = field(rnd, 2); px.each((x, y) => px.set(x, y, f[y * 16 + x] > 0.5 ? mul(C_.white, 0.95 + rnd() * 0.05) : mul(C_.brown, 0.9 + rnd() * 0.15))); };
add('cow_skin', cowSkin);
add('cow_head_front', (px, rnd) => {
  px.each((x, y) => px.set(x, y, mul(C_.brown, 0.9 + rnd() * 0.12)));
  rect(px, 3, 0, 2, 5, C_.white); rect(px, 2, 1, 4, 2, C_.white);
  px.set(1, 3, [20, 16, 16]); px.set(6, 3, [20, 16, 16]); px.set(0, 3, C_.white); px.set(7, 3, C_.white);
});
add('cow_muzzle', (px) => { px.each((x, y) => px.set(x, y, C_.muzzle)); px.set(1, 1, [80, 50, 44]); px.set(4, 1, [80, 50, 44]); });
add('cow_horn', (px) => { px.each((x, y) => px.set(x, y, y === 0 ? [180, 170, 140] : C_.horn)); });
add('cow_leg', (px, rnd) => { cowSkin(px, rnd); rect(px, 0, 10, 4, 6, C_.hoof); });
add('cow_udder', (px) => px.each((x, y) => px.set(x, y, C_.udder)));

// Sheep
const S_ = { wool: [236, 234, 226], woolD: [214, 212, 204], face: [206, 184, 160], faceD: [182, 158, 134], hoof: [70, 60, 54] };
const wool = (px, rnd) => { const vo = voronoi(rnd, 18); px.each((x, y) => { const c = vo(x, y); px.set(x, y, c.d2 - c.d1 < 0.6 ? S_.woolD : mul(S_.wool, 0.95 + c.v * 0.06)); }); };
add('sheep_wool', wool);
add('sheep_face', (px, rnd) => {
  px.each((x, y) => px.set(x, y, mul(S_.face, 0.95 + rnd() * 0.08)));
  px.set(1, 2, [250, 250, 250]); px.set(2, 2, [40, 30, 30]); px.set(3, 2, [40, 30, 30]); px.set(4, 2, [250, 250, 250]);
  px.set(2, 4, S_.faceD); px.set(3, 4, S_.faceD);
});
add('sheep_skin', (px, rnd) => px.each((x, y) => px.set(x, y, mul(S_.face, 0.94 + rnd() * 0.08))));
add('sheep_leg', (px, rnd) => { wool(px, rnd); rect(px, 0, 5, 4, 7, S_.face); rect(px, 0, 10, 4, 2, S_.hoof); });

// ---------- item sprites ----------
function sprite(name, fn) {
  add(name, (px, rnd) => { clear(px); fn(px, rnd); });
}
const HANDLE = [146, 108, 60], HANDLE_D = [100, 70, 36];
function handle(px, len, sx = 2, sy = 13) {
  for (let k = 0; k < len; k++) { px.set(sx + k, sy - k, HANDLE); px.set(sx + 1 + k, sy - k, HANDLE_D); }
}
const MAT_COLORS = {
  wooden: [[184, 146, 88], [140, 106, 58], [214, 180, 120]],
  stone: [[132, 132, 134], [96, 96, 98], [170, 170, 172]],
  iron: [[214, 214, 220], [160, 160, 170], [250, 250, 255]],
  diamond: [[90, 228, 218], [40, 160, 156], [190, 255, 250]],
};
const reflect = (pts) => pts.concat(pts.map(([x, y]) => [15 - y, 15 - x]));
for (const [mat, [base, dark, light]] of Object.entries(MAT_COLORS)) {
  sprite(`${mat}_pickaxe`, (px) => {
    handle(px, 9);
    const outer = reflect([[3, 3], [4, 2], [5, 2], [6, 1], [7, 1], [8, 1], [9, 1], [10, 2], [11, 2], [12, 3]]);
    const inner = reflect([[4, 3], [5, 3], [6, 2], [7, 2], [8, 2], [9, 2], [10, 3], [11, 3], [11, 4]]);
    outer.forEach(([x, y]) => px.set(x, y, light));
    inner.forEach(([x, y]) => px.set(x, y, base));
    px.set(12, 4, dark); px.set(11, 5, dark); px.set(3, 4, dark); px.set(11, 12, dark);
  });
  sprite(`${mat}_axe`, (px) => {
    handle(px, 10);
    const rows = { 1: [7, 9], 2: [6, 10], 3: [5, 10], 4: [5, 10], 5: [6, 9], 6: [7, 8] };
    for (const [y, [a, b]] of Object.entries(rows)) for (let x = a; x <= b; x++) px.set(x, +y, x === a ? light : x === b ? dark : base);
    px.set(12, 2, dark); px.set(13, 3, dark); px.set(12, 3, base);
  });
  sprite(`${mat}_shovel`, (px) => {
    handle(px, 8);
    for (let y = 0; y < 8; y++) for (let x = 8; x < 16; x++) {
      const d = Math.hypot(x - 11.5, y - 3.5);
      if (d < 2.9) px.set(x, y, d < 1.4 ? light : d < 2.3 ? base : dark);
    }
    px.set(9, 6, dark);
  });
  sprite(`${mat}_sword`, (px) => {
    for (let k = 0; k < 9; k++) { px.set(5 + k, 10 - k, base); px.set(6 + k, 10 - k, dark); px.set(5 + k, 9 - k, light); }
    px.set(14, 1, light);
    [[2, 8], [3, 9], [4, 10], [5, 11], [6, 12]].forEach(([x, y]) => px.set(x, y, [70, 54, 40]));
    px.set(3, 12, HANDLE); px.set(2, 13, HANDLE); px.set(4, 11, HANDLE_D); px.set(1, 14, [70, 54, 40]);
  });
}
sprite('stick', (px) => { for (let k = 0; k < 9; k++) { px.set(3 + k, 12 - k, HANDLE); px.set(4 + k, 12 - k, HANDLE_D); } });
sprite('coal', (px, rnd) => {
  for (let y = 3; y < 14; y++) for (let x = 3; x < 14; x++) {
    const d = Math.hypot(x - 8, (y - 8) * 1.15) + rnd() * 0.8;
    if (d < 5.2) px.set(x, y, d < 2 && rnd() < 0.5 ? [86, 86, 92] : mul([38, 38, 42], 0.8 + rnd() * 0.4));
  }
});
const ingot = (base, light, dark) => (px) => {
  for (let x = 6; x < 13; x++) px.set(x, 6, light);
  for (let y = 7; y < 10; y++) for (let x = 4; x < 13; x++) px.set(x, y, x === 12 ? dark : base);
  for (let x = 3; x < 12; x++) px.set(x, 10, dark);
  px.set(5, 6, base);
};
sprite('iron_ingot', ingot([214, 214, 220], [250, 250, 255], [150, 150, 160]));
sprite('gold_ingot', ingot([248, 206, 60], [255, 244, 160], [190, 140, 30]));
sprite('diamond', (px) => {
  const rows = [[3, 6, 9], [4, 4, 11], [5, 3, 12], [6, 3, 12], [7, 4, 11], [8, 5, 10], [9, 6, 9], [10, 7, 8]];
  for (const [y, a, b] of rows) for (let x = a; x <= b; x++) px.set(x, y, y < 5 ? [200, 255, 250] : x < 8 ? [96, 230, 220] : [44, 170, 166]);
});
const slab = (c1, c2, fat) => (px, rnd) => {
  for (let y = 4; y < 13; y++) for (let x = 2; x < 14; x++) {
    const d = Math.hypot((x - 7.5) / 6, (y - 8.5) / 4.5);
    if (d < 1) px.set(x, y, d > 0.8 ? fat : mul(rnd() < 0.2 ? c2 : c1, 0.92 + rnd() * 0.12));
  }
};
sprite('raw_pork', slab([238, 150, 150], [250, 196, 196], [252, 214, 210]));
sprite('cooked_pork', slab([186, 116, 76], [214, 162, 112], [226, 190, 140]));
sprite('raw_beef', slab([186, 46, 46], [236, 224, 220], [150, 30, 30]));
sprite('steak', slab([120, 70, 40], [80, 46, 26], [150, 96, 60]));
sprite('raw_mutton', slab([200, 80, 84], [236, 200, 200], [240, 236, 228]));
sprite('cooked_mutton', slab([150, 92, 60], [176, 120, 80], [210, 190, 160]));
sprite('rotten_flesh', slab([126, 112, 62], [86, 120, 54], [104, 88, 50]));
sprite('apple', (px) => {
  for (let y = 4; y < 15; y++) for (let x = 2; x < 14; x++) {
    const d = Math.hypot(x - 7.5, y - 9.2);
    if (d < 5.3) px.set(x, y, x + y < 13 ? [236, 92, 92] : x + y > 20 ? [150, 20, 30] : [204, 34, 44]);
  }
  px.set(5, 6, [255, 190, 190]); px.set(7, 2, [96, 66, 32]); px.set(7, 3, [96, 66, 32]);
  px.set(8, 2, [60, 140, 40]); px.set(9, 1, [60, 140, 40]); px.set(9, 2, [80, 170, 50]);
});
const bucket = (fill) => (px) => {
  for (let y = 5; y < 14; y++) {
    const inset = Math.floor((y - 5) * 0.34);
    for (let x = 3 + inset; x <= 12 - inset; x++) {
      const edge = x === 3 + inset || x === 12 - inset;
      px.set(x, y, edge ? [120, 120, 128] : y === 5 ? [230, 230, 236] : [184, 184, 192]);
    }
  }
  [[3, 4], [4, 3], [5, 2], [6, 2], [7, 2], [8, 2], [9, 2], [10, 2], [11, 3], [12, 4]].forEach(([x, y]) => px.set(x, y, [100, 100, 108]));
  if (fill) for (let x = 4; x < 12; x++) { px.set(x, 5, fill[0]); px.set(x, 6, fill[1]); }
};
sprite('sugar', (px, rnd) => {
  for (let y = 6; y < 14; y++) for (let x = 2; x < 14; x++) {
    const d = Math.hypot((x - 7.5) / 5.5, (y - 11) / 3.5);
    if (d < 1 && rnd() < 0.9) px.set(x, y, rnd() < 0.3 ? [214, 214, 226] : [250, 250, 252]);
  }
  [[4, 5], [9, 4], [12, 6], [6, 3]].forEach(([x, y]) => px.set(x, y, [250, 250, 252]));
});
sprite('pumpkin_pie', (px, rnd) => {
  for (let y = 5; y < 13; y++) for (let x = 1; x < 15; x++) {
    const top = y < 8;
    const edge = x === 1 || x === 14 || y === 12;
    if (top && (x + y) % 2 === 0 && y === 5) continue;
    px.set(x, y, edge ? [150, 92, 40] : top ? mul([214, 120, 44], 0.92 + rnd() * 0.1) : [234, 196, 130]);
  }
  for (let x = 2; x < 14; x++) px.set(x, 8, [196, 150, 90]);
  px.set(5, 6, [246, 236, 210]); px.set(10, 6, [246, 236, 210]);
});
sprite('bucket', bucket(null));
sprite('water_bucket', bucket([[70, 120, 230], [44, 86, 200]]));
sprite('lava_bucket', bucket([[255, 180, 50], [226, 90, 20]]));

export const LAYER_COUNT = layerData.length;

export function textureArrayData() {
  const out = new Uint8Array(16 * 16 * 4 * LAYER_COUNT);
  layerData.forEach((d, i) => out.set(d, i * 1024));
  return out;
}

// ---------- tints ----------
export const DEFAULT_GRASS = [124, 189, 82];
export const BIRCH_TINT = [128, 167, 85];
export const SPRUCE_TINT = [97, 140, 97];

// ---------- UI icons ----------
const iconCache = new Map();
function layerCanvas(layer, tint) {
  const c = document.createElement('canvas');
  c.width = c.height = 16;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(16, 16);
  img.data.set(layerData[layer]);
  if (tint) for (let i = 0; i < 1024; i += 4) {
    img.data[i] = (img.data[i] * tint[0]) / 255;
    img.data[i + 1] = (img.data[i + 1] * tint[1]) / 255;
    img.data[i + 2] = (img.data[i + 2] * tint[2]) / 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}
function tintFor(kind) {
  return kind === 4 ? BIRCH_TINT : kind === 5 ? SPRUCE_TINT : kind === 3 ? [104, 168, 66] : DEFAULT_GRASS;
}

export function iconURL(id) {
  if (iconCache.has(id)) return iconCache.get(id);
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  const d = itemDef(id);
  if (!d) return '';
  if (d.isBlock && (d.render === R.CUBE || d.render === R.CUTOUT)) {
    const top = layerCanvas(TEXL[id * 6 + 2], d.tint && d.tint !== 2 ? tintFor(d.tint) : null);
    const sideTint = d.tint >= 3 ? tintFor(d.tint) : null;
    const left = layerCanvas(d.front ? FRONTL[id] : TEXL[id * 6 + 4], sideTint);
    const right = layerCanvas(TEXL[id * 6], sideTint);
    const k = 30 / 16, h = 15 / 16;
    const face = (img, a, b, cc, dd, e, f, shade) => {
      ctx.setTransform(a, b, cc, dd, e, f);
      ctx.drawImage(img, 0, 0);
      if (shade) { ctx.fillStyle = `rgba(0,0,0,${shade})`; ctx.fillRect(0, 0, 16, 16); }
    };
    face(top, k, -h, k, h, 2, 17, 0);
    face(left, k, h, 0, k, 2, 17, 0.22);
    face(right, k, -h, 0, k, 32, 32, 0.42);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  } else {
    const layer = d.isBlock ? TEXL[id * 6] : d.layer;
    const tint = d.isBlock && d.tint === 2 ? DEFAULT_GRASS : null;
    ctx.drawImage(layerCanvas(layer, tint), 4, 4, 56, 56);
  }
  const url = c.toDataURL();
  iconCache.set(id, url);
  return url;
}

// Pixel-art HUD icons (hearts, food, air) drawn from small maps.
export function hudIcon(kind) {
  const c = document.createElement('canvas');
  c.width = c.height = 9;
  const ctx = c.getContext('2d');
  const put = (x, y, col) => { ctx.fillStyle = col; ctx.fillRect(x, y, 1, 1); };
  const heart = ['.##...##.', '#hh#.#hh#', '#hhh#hhh#', '#hhhhhhh#', '.#hhhhh#.', '..#hhh#..', '...#h#...', '....#....'];
  const food = ['...###...', '..#lll#..', '.#lllll#.', '#llmmmll#', '#lmmmmml#', '#mmmmmmm#', '.#mmmmm#.', '..#####..'];
  const air = ['..###..', '.#lll#.', '#ll.mm#', '#l.mmm#', '#mmmmm#', '.#mmm#.', '..###..'];
  const maps = {
    heart_full: [heart, { '#': '#1a0a0a', h: '#e0302c' }],
    heart_empty: [heart, { '#': '#1a0a0a', h: '#3a2626' }],
    heart_half: [heart, { '#': '#1a0a0a', h: 'half' }],
    food_full: [food, { '#': '#2a1606', l: '#f0c070', m: '#c27a2a' }],
    food_empty: [food, { '#': '#2a1606', l: '#3a2a20', m: '#30221a' }],
    food_half: [food, { '#': '#2a1606', l: 'halfl', m: 'halfm' }],
    air: [air, { '#': '#10305a', l: '#d8f0ff', m: '#5aa6f0' }],
  };
  const [map, pal] = maps[kind];
  map.forEach((row, y) => [...row].forEach((ch, x) => {
    let col = pal[ch];
    if (!col) return;
    if (col === 'half') col = x < 4 ? '#e0302c' : '#3a2626';
    if (col === 'halfl') col = x < 4 ? '#f0c070' : '#3a2a20';
    if (col === 'halfm') col = x < 4 ? '#c27a2a' : '#30221a';
    put(x, y, col);
  }));
  return c.toDataURL();
}

// Tileable cloud coverage map (R8, 128x128).
export function cloudData() {
  const N = 128, rnd = mulberry32(4242);
  const out = new Uint8Array(N * N);
  const octave = (cells) => {
    const g = new Float32Array(cells * cells);
    for (let i = 0; i < g.length; i++) g[i] = rnd();
    return (x, y) => {
      const fx = (x / N) * cells, fy = (y / N) * cells;
      const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
      const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
      const at = (a, b) => g[(b % cells) * cells + (a % cells)];
      const top = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * sx;
      const bot = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * sx;
      return top + (bot - top) * sy;
    };
  };
  const o1 = octave(8), o2 = octave(16), o3 = octave(32);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const v = o1(x, y) * 0.55 + o2(x, y) * 0.3 + o3(x, y) * 0.15;
    out[y * N + x] = v > 0.56 ? 255 : 0;
  }
  return out;
}
