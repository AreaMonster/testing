// Crafting recipes, furnace smelting table and inventory container.
import { B, I, maxStackOf, itemDef } from './blocks.js';

const PLANKS = [B.PLANKS, B.BIRCH_PLANKS, B.SPRUCE_PLANKS, B.ACACIA_PLANKS, B.CHERRY_PLANKS];
const RECIPES = [];

function shaped(pattern, key, out, count = 1) {
  const w = Math.max(...pattern.map((r) => r.length));
  RECIPES.push({ shaped: true, pattern: pattern.map((r) => r.padEnd(w, ' ')), key, out, count });
}
function shapeless(ings, out, count = 1) {
  RECIPES.push({ shaped: false, ings, out, count });
}

shaped(['#'], { '#': [B.LOG] }, B.PLANKS, 4);
shaped(['#'], { '#': [B.BIRCH_LOG] }, B.BIRCH_PLANKS, 4);
shaped(['#'], { '#': [B.SPRUCE_LOG] }, B.SPRUCE_PLANKS, 4);
shaped(['#'], { '#': [B.ACACIA_LOG] }, B.ACACIA_PLANKS, 4);
shaped(['#', '#'], { '#': PLANKS }, I.STICK, 4);
shaped(['##', '##'], { '#': PLANKS }, B.CRAFTING_TABLE);
shaped(['###', '# #', '###'], { '#': [B.COBBLESTONE] }, B.FURNACE);
shaped(['###', '# #', '###'], { '#': PLANKS }, B.CHEST);
shaped(['C', 'S'], { C: [I.COAL], S: [I.STICK] }, B.TORCH, 4);

const TOOL_MATERIALS = [['WOODEN', PLANKS], ['STONE', [B.COBBLESTONE]], ['IRON', [I.IRON_INGOT]], ['DIAMOND', [I.DIAMOND]]];
for (const [m, mat] of TOOL_MATERIALS) {
  const key = { M: mat, S: [I.STICK] };
  shaped(['MMM', ' S ', ' S '], key, I[`${m}_PICKAXE`]);
  shaped(['MM', 'MS', ' S'], key, I[`${m}_AXE`]);
  shaped(['M', 'S', 'S'], key, I[`${m}_SHOVEL`]);
  shaped(['M', 'M', 'S'], key, I[`${m}_SWORD`]);
}

shaped(['##', '##'], { '#': [B.SAND] }, B.SANDSTONE);
shaped(['##', '##'], { '#': [B.STONE] }, B.STONE_BRICKS, 4);
shaped(['##', '##'], { '#': [B.CLAY] }, B.BRICKS);
shaped(['##', '##'], { '#': [B.SNOW] }, B.ICE);
shaped(['###', '#T#', '###'], { '#': [B.GLASS], T: [B.TORCH] }, B.LUMEN);
shaped(['###', 'SSS', '###'], { '#': PLANKS, S: [I.STICK] }, B.BOOKSHELF);
shaped(['# #', ' # '], { '#': [I.IRON_INGOT] }, I.BUCKET);
shaped(['###', '###', '###'], { '#': [I.IRON_INGOT] }, B.IRON_BLOCK);
shaped(['###', '###', '###'], { '#': [I.GOLD_INGOT] }, B.GOLD_BLOCK);
shaped(['###', '###', '###'], { '#': [I.DIAMOND] }, B.DIAMOND_BLOCK);
shapeless([B.IRON_BLOCK], I.IRON_INGOT, 9);
shapeless([B.GOLD_BLOCK], I.GOLD_INGOT, 9);
shapeless([B.DIAMOND_BLOCK], I.DIAMOND, 9);
shapeless([B.COBBLESTONE, B.LEAVES], B.MOSSY_COBBLE);
shapeless([B.WOOL_WHITE, B.POPPY], B.WOOL_RED);
shapeless([B.WOOL_WHITE, B.BUTTERCUP], B.WOOL_YELLOW);
shapeless([B.WOOL_WHITE, B.CACTUS], B.WOOL_GREEN);
shapeless([B.WOOL_WHITE, I.COAL], B.WOOL_BLACK);
shapeless([B.WOOL_WHITE, B.CORNFLOWER], B.WOOL_BLUE);
shapeless([B.WOOL_WHITE, B.ICE], B.WOOL_BLUE);
shapeless([B.PUMPKIN, B.TORCH], B.JACK_O_LANTERN);
shapeless([B.SUGAR_CANE], I.SUGAR);
shapeless([B.PUMPKIN, I.SUGAR], I.PUMPKIN_PIE);
shapeless([B.TERRACOTTA, B.POPPY], B.TERRACOTTA_RED);
shapeless([B.TERRACOTTA, B.BUTTERCUP], B.TERRACOTTA_YELLOW);
shapeless([B.TERRACOTTA, B.DAISY], B.TERRACOTTA_WHITE);
shapeless([B.TERRACOTTA, I.COAL], B.TERRACOTTA_BROWN);
shapeless([B.TERRACOTTA_RED, B.TERRACOTTA_YELLOW], B.TERRACOTTA_ORANGE, 2);
shapeless([B.WOOL_RED, B.WOOL_YELLOW], B.WOOL_ORANGE, 2);
shapeless([B.WOOL_RED, B.WOOL_BLUE], B.WOOL_PURPLE, 2);

// ---- content update recipes ----
shaped(['#'], { '#': [B.CHERRY_LOG] }, B.CHERRY_PLANKS, 4);
shaped(['##', '##'], { '#': [B.GRANITE] }, B.POLISHED_GRANITE, 4);
shaped(['##', '##'], { '#': [B.MARBLE] }, B.POLISHED_MARBLE, 4);
shaped(['##', '##'], { '#': [B.SLATE] }, B.POLISHED_SLATE, 4);
shapeless([B.STONE_BRICKS, B.MOSS_BLOCK], B.MOSSY_STONE_BRICKS);
shapeless([B.STONE_BRICKS, B.LEAVES], B.MOSSY_STONE_BRICKS);
shapeless([B.COBBLESTONE, B.MOSS_BLOCK], B.MOSSY_COBBLE);
shaped(['#', '#'], { '#': [B.STONE_BRICK_SLAB] }, B.CHISELED_STONE_BRICKS);
shaped(['###', '###', '###'], { '#': [I.COPPER_INGOT] }, B.COPPER_BLOCK);
shapeless([B.COPPER_BLOCK], I.COPPER_INGOT, 9);
for (const [k] of [['WHITE'], ['RED'], ['ORANGE'], ['YELLOW'], ['GREEN'], ['BLUE'], ['PURPLE'], ['BLACK']]) {
  shaped(['###', '#W#', '###'], { '#': [B.GLASS], W: [B[`WOOL_${k}`]] }, B[`GLASS_${k}`], 8);
}
const SLABS = [['STONE_SLAB', B.SMOOTH_STONE], ['COBBLE_SLAB', B.COBBLESTONE], ['OAK_SLAB', B.PLANKS], ['BRICK_SLAB', B.BRICKS],
  ['STONE_BRICK_SLAB', B.STONE_BRICKS], ['SANDSTONE_SLAB', B.SANDSTONE], ['SPRUCE_SLAB', B.SPRUCE_PLANKS], ['CHERRY_SLAB', B.CHERRY_PLANKS]];
for (const [k, src] of SLABS) shaped(['###'], { '#': [src] }, B[k], 6);
shaped(['S S', 'SSS', 'S S'], { S: [I.STICK] }, B.LADDER, 3);
shaped(['III', 'ITI', 'III'], { I: [I.COPPER_INGOT, I.IRON_INGOT], T: [B.TORCH] }, B.LANTERN);
shaped(['###', '###', '###'], { '#': [I.WHEAT] }, B.HAY_BALE);
shapeless([B.HAY_BALE], I.WHEAT, 9);
shaped(['###'], { '#': [I.WHEAT] }, I.BREAD);
shaped(['###', '###', '###'], { '#': [I.MELON_SLICE] }, B.MELON);
shapeless([B.RED_MUSHROOM, B.BROWN_MUSHROOM], I.MUSHROOM_STEW);
shapeless([I.MELON_SLICE], I.SEEDS);
shaped(['WWW', 'PPP'], { W: [B.WOOL_WHITE, B.WOOL_RED, B.WOOL_BLUE, B.WOOL_GREEN, B.WOOL_YELLOW, B.WOOL_ORANGE, B.WOOL_PURPLE, B.WOOL_BLACK], P: PLANKS }, B.BEDROLL);
shaped(['###', '   ', '###'], { '#': PLANKS }, B.BOOKSHELF_EMPTY);
shaped(['##', '##'], { '#': [B.CRYSTAL_CLUSTER] }, B.CRYSTAL_BLOCK);
for (const [m, mat] of TOOL_MATERIALS) {
  shaped(['MM', ' S', ' S'], { M: mat, S: [I.STICK] }, I[`${m}_HOE`]);
}

// grid: array of stacks (or null), size w*w. Returns {id, count} or null.
export function matchCraft(grid, w) {
  let minx = w, miny = w, maxx = -1, maxy = -1;
  for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) {
    if (grid[y * w + x]) {
      minx = Math.min(minx, x); maxx = Math.max(maxx, x);
      miny = Math.min(miny, y); maxy = Math.max(maxy, y);
    }
  }
  if (maxx < 0) return null;
  const gw = maxx - minx + 1, gh = maxy - miny + 1;
  const filled = grid.filter(Boolean);
  for (const r of RECIPES) {
    if (r.shaped) {
      if (r.pattern.length !== gh || r.pattern[0].length !== gw) continue;
      for (const mirror of [false, true]) {
        let ok = true;
        for (let y = 0; y < gh && ok; y++) for (let x = 0; x < gw && ok; x++) {
          const ch = r.pattern[y][mirror ? gw - 1 - x : x];
          const st = grid[(miny + y) * w + minx + x];
          if (ch === ' ') { if (st) ok = false; }
          else if (!st || !r.key[ch].includes(st.id)) ok = false;
        }
        if (ok) return { id: r.out, count: r.count };
      }
    } else {
      if (filled.length !== r.ings.length) continue;
      const used = new Array(filled.length).fill(false);
      let ok = true;
      for (const ing of r.ings) {
        const i = filled.findIndex((s, k) => !used[k] && s.id === ing);
        if (i < 0) { ok = false; break; }
        used[i] = true;
      }
      if (ok) return { id: r.out, count: r.count };
    }
  }
  return null;
}

export const SMELT = {
  [B.IRON_ORE]: I.IRON_INGOT, [B.GOLD_ORE]: I.GOLD_INGOT, [B.SAND]: B.GLASS,
  [B.COBBLESTONE]: B.STONE, [B.COPPER_ORE]: I.COPPER_INGOT, [B.STONE_BRICKS]: B.CRACKED_STONE_BRICKS, [I.RAW_PORK]: I.COOKED_PORK, [I.RAW_BEEF]: I.STEAK,
  [I.RAW_MUTTON]: I.COOKED_MUTTON, [B.LOG]: I.COAL, [B.BIRCH_LOG]: I.COAL,
  [B.SPRUCE_LOG]: I.COAL, [B.ACACIA_LOG]: I.COAL, [B.CLAY]: B.TERRACOTTA, [B.RED_SAND]: B.GLASS, [B.STONE]: B.SMOOTH_STONE, [B.CHERRY_LOG]: I.COAL,
  [B.DIAMOND_ORE]: I.DIAMOND, [B.COAL_ORE]: I.COAL,
};
export const SMELT_TIME = 8;
export function fuelTime(id) {
  const d = itemDef(id);
  return d ? d.fuel : 0;
}

export const canMerge = (a, b) => a && b && a.id === b.id && !a.dmg && !b.dmg && maxStackOf(a.id) > 1;

export class Inventory {
  constructor(n = 36) {
    this.slots = new Array(n).fill(null);
    this.version = 0;
  }
  get(i) {
    return this.slots[i];
  }
  set(i, s) {
    this.slots[i] = s && s.count > 0 ? s : null;
    this.version++;
  }
  changed() {
    this.version++;
  }
  // Adds a stack; returns how many items did not fit.
  add(stack, order) {
    let left = stack.count;
    const max = maxStackOf(stack.id);
    const idx = order || this.slots.map((_, i) => i);
    if (max > 1 && !stack.dmg) {
      for (const i of idx) {
        const s = this.slots[i];
        if (s && s.id === stack.id && !s.dmg && s.count < max) {
          const t = Math.min(max - s.count, left);
          s.count += t;
          left -= t;
          if (!left) break;
        }
      }
    }
    if (left) {
      for (const i of idx) {
        if (!this.slots[i]) {
          const t = Math.min(max, left);
          this.slots[i] = { id: stack.id, count: t, dmg: stack.dmg || 0 };
          left -= t;
          if (!left) break;
        }
      }
    }
    this.version++;
    return left;
  }
  count(id) {
    return this.slots.reduce((n, s) => n + (s && s.id === id ? s.count : 0), 0);
  }
  find(id) {
    return this.slots.findIndex((s) => s && s.id === id);
  }
  clear() {
    this.slots.fill(null);
    this.version++;
  }
  toJSON() {
    return this.slots;
  }
  load(arr) {
    if (!Array.isArray(arr)) return;
    for (let i = 0; i < this.slots.length; i++) {
      const s = arr[i];
      this.slots[i] = s && itemDef(s.id) ? { id: s.id, count: s.count, dmg: s.dmg || 0 } : null;
    }
    this.version++;
  }
}
