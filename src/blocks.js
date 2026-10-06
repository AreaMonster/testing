// Block and item registry plus fast lookup tables used by the hot paths.

export const R = { NONE: 0, CUBE: 1, CUTOUT: 2, CROSS: 3, LIQUID: 4, TORCH: 5 };
// Tint kinds: 1 grass (top face only), 2 grass (all faces), 3 oak foliage, 4 birch, 5 spruce
export const TINT_KIND = { GRASS_TOP: 1, GRASS_ALL: 2, OAK: 3, BIRCH: 4, SPRUCE: 5 };

export const B = {};
export const BLOCKS = [];
export const I = {};
export const ITEMS = {};

const BLOCK_DEFAULTS = {
  tex: null, render: R.CUBE, solid: true, opaque: true, light: 0, filter: 0,
  hardness: 1, tool: null, tier: 0, drop: undefined, sound: 'stone', replaceable: false,
  tint: 0, gravity: false, support: null, interact: null, fuel: 0, cullSame: false,
  liquid: 0, leaf: false, front: false, creative: true, maxStack: 64,
};

function blk(key, name, o = {}) {
  const id = BLOCKS.length;
  const d = Object.assign({ id, key, name, isBlock: true }, BLOCK_DEFAULTS, o);
  BLOCKS.push(d);
  B[key] = id;
  return d;
}

const plant = (tex, extra = {}) => Object.assign({
  tex, render: R.CROSS, solid: false, opaque: false, hardness: 0, sound: 'grass', support: 'plant',
}, extra);

blk('AIR', 'Air', { render: R.NONE, solid: false, opaque: false, hardness: -1, replaceable: true, creative: false });
blk('STONE', 'Stone', { tex: 'stone', hardness: 1.5, tool: 'pickaxe', tier: 1, drop: 'COBBLESTONE' });
blk('GRASS', 'Grass Block', { tex: { top: 'grass_top', side: 'grass_side', bottom: 'dirt' }, tint: 1, hardness: 0.6, tool: 'shovel', drop: 'DIRT', sound: 'grass' });
blk('DIRT', 'Dirt', { tex: 'dirt', hardness: 0.5, tool: 'shovel', sound: 'gravel' });
blk('COBBLESTONE', 'Cobblestone', { tex: 'cobblestone', hardness: 2, tool: 'pickaxe', tier: 1 });
blk('PLANKS', 'Oak Planks', { tex: 'planks_oak', hardness: 2, tool: 'axe', sound: 'wood', fuel: 15 });
blk('BIRCH_PLANKS', 'Birch Planks', { tex: 'planks_birch', hardness: 2, tool: 'axe', sound: 'wood', fuel: 15 });
blk('SPRUCE_PLANKS', 'Spruce Planks', { tex: 'planks_spruce', hardness: 2, tool: 'axe', sound: 'wood', fuel: 15 });
blk('BEDROCK', 'Bedrock', { tex: 'bedrock', hardness: -1 });
blk('SAND', 'Sand', { tex: 'sand', hardness: 0.5, tool: 'shovel', sound: 'sand', gravity: true });
blk('GRAVEL', 'Gravel', { tex: 'gravel', hardness: 0.6, tool: 'shovel', sound: 'gravel', gravity: true });
blk('LOG', 'Oak Log', { tex: { top: 'log_oak_top', side: 'log_oak' }, hardness: 2, tool: 'axe', sound: 'wood', fuel: 15 });
blk('BIRCH_LOG', 'Birch Log', { tex: { top: 'log_birch_top', side: 'log_birch' }, hardness: 2, tool: 'axe', sound: 'wood', fuel: 15 });
blk('SPRUCE_LOG', 'Spruce Log', { tex: { top: 'log_spruce_top', side: 'log_spruce' }, hardness: 2, tool: 'axe', sound: 'wood', fuel: 15 });
blk('LEAVES', 'Oak Leaves', { tex: 'leaves_oak', render: R.CUTOUT, opaque: false, filter: 1, hardness: 0.2, sound: 'grass', tint: 3, drop: 'leaves', leaf: true });
blk('BIRCH_LEAVES', 'Birch Leaves', { tex: 'leaves_birch', render: R.CUTOUT, opaque: false, filter: 1, hardness: 0.2, sound: 'grass', tint: 4, drop: 'leaves', leaf: true });
blk('SPRUCE_LEAVES', 'Spruce Leaves', { tex: 'leaves_spruce', render: R.CUTOUT, opaque: false, filter: 1, hardness: 0.2, sound: 'grass', tint: 5, drop: 'leaves', leaf: true });
blk('GLASS', 'Glass', { tex: 'glass', render: R.CUTOUT, opaque: false, hardness: 0.3, sound: 'glass', drop: null, cullSame: true });
blk('WATER', 'Water', { tex: 'water', render: R.LIQUID, solid: false, opaque: false, filter: 1, hardness: -1, replaceable: true, liquid: 1, creative: false });
blk('LAVA', 'Lava', { tex: 'lava', render: R.LIQUID, solid: false, opaque: false, light: 15, hardness: -1, replaceable: true, liquid: 2, creative: false });
blk('COAL_ORE', 'Coal Ore', { tex: 'coal_ore', hardness: 3, tool: 'pickaxe', tier: 1, drop: 'COAL' });
blk('IRON_ORE', 'Iron Ore', { tex: 'iron_ore', hardness: 3, tool: 'pickaxe', tier: 2 });
blk('GOLD_ORE', 'Gold Ore', { tex: 'gold_ore', hardness: 3, tool: 'pickaxe', tier: 3 });
blk('DIAMOND_ORE', 'Diamond Ore', { tex: 'diamond_ore', hardness: 3, tool: 'pickaxe', tier: 3, drop: 'DIAMOND' });
blk('SNOWY_GRASS', 'Snowy Grass', { tex: { top: 'snow', side: 'grass_side_snow', bottom: 'dirt' }, hardness: 0.6, tool: 'shovel', drop: 'DIRT', sound: 'snow' });
blk('SNOW', 'Snow Block', { tex: 'snow', hardness: 0.2, tool: 'shovel', sound: 'snow' });
blk('ICE', 'Ice', { tex: 'ice', hardness: 0.5, tool: 'pickaxe', sound: 'glass', drop: null });
blk('CACTUS', 'Cactus', { tex: { top: 'cactus_top', side: 'cactus_side', bottom: 'cactus_top' }, hardness: 0.4, sound: 'wool', support: 'cactus' });
blk('TALL_GRASS', 'Tall Grass', plant('tall_grass', { tint: 2, replaceable: true, drop: null }));
blk('POPPY', 'Poppy', plant('poppy'));
blk('BUTTERCUP', 'Buttercup', plant('buttercup'));
blk('DEAD_BUSH', 'Dead Bush', plant('dead_bush', { replaceable: true, drop: 'STICK', support: 'desert' }));
blk('OAK_SAPLING', 'Oak Sapling', plant('sapling_oak'));
blk('BIRCH_SAPLING', 'Birch Sapling', plant('sapling_birch'));
blk('SPRUCE_SAPLING', 'Spruce Sapling', plant('sapling_spruce'));
blk('TORCH', 'Torch', { tex: 'torch', render: R.TORCH, solid: false, opaque: false, light: 14, hardness: 0, sound: 'wood', support: 'torch' });
blk('CRAFTING_TABLE', 'Crafting Table', { tex: { top: 'crafting_top', side: 'crafting_side', front: 'crafting_front', bottom: 'planks_oak' }, front: true, hardness: 2.5, tool: 'axe', sound: 'wood', interact: 'craft', fuel: 15 });
blk('FURNACE', 'Furnace', { tex: { top: 'furnace_top', side: 'furnace_side', front: 'furnace_front', bottom: 'furnace_top' }, front: true, hardness: 3.5, tool: 'pickaxe', tier: 1, interact: 'furnace' });
blk('CHEST', 'Chest', { tex: { top: 'chest_top', side: 'chest_side', front: 'chest_front', bottom: 'chest_top' }, front: true, hardness: 2.5, tool: 'axe', sound: 'wood', interact: 'chest', fuel: 15 });
blk('BRICKS', 'Bricks', { tex: 'bricks', hardness: 2, tool: 'pickaxe', tier: 1 });
blk('STONE_BRICKS', 'Stone Bricks', { tex: 'stone_bricks', hardness: 1.5, tool: 'pickaxe', tier: 1 });
blk('MOSSY_COBBLE', 'Mossy Cobblestone', { tex: 'mossy_cobble', hardness: 2, tool: 'pickaxe', tier: 1 });
blk('SANDSTONE', 'Sandstone', { tex: { top: 'sandstone_top', side: 'sandstone_side', bottom: 'sandstone_top' }, hardness: 0.8, tool: 'pickaxe', tier: 1 });
blk('LUMEN', 'Lumen Block', { tex: 'lumen', light: 15, hardness: 0.3, sound: 'glass' });
blk('BOOKSHELF', 'Bookshelf', { tex: { top: 'planks_oak', side: 'bookshelf' }, hardness: 1.5, tool: 'axe', sound: 'wood', fuel: 15 });
blk('CLAY', 'Clay', { tex: 'clay', hardness: 0.6, tool: 'shovel', sound: 'gravel' });
blk('OBSIDIAN', 'Obsidian', { tex: 'obsidian', hardness: 50, tool: 'pickaxe', tier: 4 });
blk('IRON_BLOCK', 'Block of Iron', { tex: 'iron_block', hardness: 5, tool: 'pickaxe', tier: 2, sound: 'metal' });
blk('GOLD_BLOCK', 'Block of Gold', { tex: 'gold_block', hardness: 5, tool: 'pickaxe', tier: 3, sound: 'metal' });
blk('DIAMOND_BLOCK', 'Block of Diamond', { tex: 'diamond_block', hardness: 5, tool: 'pickaxe', tier: 3, sound: 'metal' });
export const WOOL_COLORS = [
  ['WHITE', 'White', [232, 232, 228]], ['RED', 'Red', [176, 46, 38]], ['ORANGE', 'Orange', [226, 120, 30]],
  ['YELLOW', 'Yellow', [236, 200, 52]], ['GREEN', 'Green', [86, 138, 40]], ['BLUE', 'Blue', [52, 72, 170]],
  ['PURPLE', 'Purple', [122, 52, 168]], ['BLACK', 'Black', [30, 30, 36]],
];
for (const [k, n] of WOOL_COLORS) blk(`WOOL_${k}`, `${n} Wool`, { tex: `wool_${k.toLowerCase()}`, hardness: 0.8, sound: 'wool' });

// ---- Items (ids from 256) ----
let nextItem = 256;
function itm(key, name, o = {}) {
  const id = nextItem++;
  ITEMS[id] = Object.assign({ id, key, name, isBlock: false, tex: key.toLowerCase(), maxStack: 64, tool: null, food: 0, fuel: 0, creative: true }, o);
  I[key] = id;
  return ITEMS[id];
}
itm('STICK', 'Stick', { fuel: 5 });
itm('COAL', 'Coal', { fuel: 80 });
itm('IRON_INGOT', 'Iron Ingot');
itm('GOLD_INGOT', 'Gold Ingot');
itm('DIAMOND', 'Diamond');
export const TOOL_MATS = [
  ['WOODEN', 'Wooden', 1, 2, 59], ['STONE', 'Stone', 2, 4, 131],
  ['IRON', 'Iron', 3, 6, 250], ['DIAMOND', 'Diamond', 4, 8, 1561],
];
export const TOOL_TYPES = [
  ['PICKAXE', 'Pickaxe', 'pickaxe', [2, 3, 4, 5]], ['AXE', 'Axe', 'axe', [3, 4, 5, 6]],
  ['SHOVEL', 'Shovel', 'shovel', [1.5, 2.5, 3.5, 4.5]], ['SWORD', 'Sword', 'sword', [4, 5, 6, 7]],
];
TOOL_MATS.forEach((m, mi) => TOOL_TYPES.forEach((t) => itm(`${m[0]}_${t[0]}`, `${m[1]} ${t[1]}`, {
  tex: `${m[0].toLowerCase()}_${t[0].toLowerCase()}`, maxStack: 1,
  tool: { type: t[2], tier: m[2], speed: m[3], dmg: t[3][mi], dur: m[4] }, fuel: mi === 0 ? 10 : 0,
})));
itm('RAW_PORK', 'Raw Porkchop', { food: 3 });
itm('COOKED_PORK', 'Cooked Porkchop', { food: 8 });
itm('RAW_BEEF', 'Raw Beef', { food: 3 });
itm('STEAK', 'Steak', { food: 8 });
itm('RAW_MUTTON', 'Raw Mutton', { food: 2 });
itm('COOKED_MUTTON', 'Cooked Mutton', { food: 6 });
itm('APPLE', 'Apple', { food: 4 });
itm('ROTTEN_FLESH', 'Rotten Flesh', { food: 2 });
itm('BUCKET', 'Bucket', { maxStack: 16 });
itm('WATER_BUCKET', 'Water Bucket', { maxStack: 1 });
itm('LAVA_BUCKET', 'Lava Bucket', { maxStack: 1, fuel: 1000 });

// Resolve string drops to ids.
for (const d of BLOCKS) {
  if (typeof d.drop === 'string' && d.drop !== 'leaves') d.drop = B[d.drop] ?? I[d.drop];
}

// ---- Lookup tables ----
export const OPAQUE = new Uint8Array(256);
export const SOLID = new Uint8Array(256);
export const FILTER = new Uint8Array(256);
export const EMIT = new Uint8Array(256);
export const RENDER = new Uint8Array(256);
export const TINT = new Uint8Array(256);
export const CULLSAME = new Uint8Array(256);
export const LIQUID = new Uint8Array(256);
export const LEAF = new Uint8Array(256);
export const TARGET = new Uint8Array(256);
export const REPLACEABLE = new Uint8Array(256);
for (const d of BLOCKS) {
  OPAQUE[d.id] = d.opaque ? 1 : 0;
  SOLID[d.id] = d.solid ? 1 : 0;
  FILTER[d.id] = d.filter;
  EMIT[d.id] = d.light;
  RENDER[d.id] = d.render;
  TINT[d.id] = d.tint;
  CULLSAME[d.id] = d.cullSame ? 1 : 0;
  LIQUID[d.id] = d.liquid;
  LEAF[d.id] = d.leaf ? 1 : 0;
  TARGET[d.id] = d.render !== R.NONE && !d.liquid ? 1 : 0;
  REPLACEABLE[d.id] = d.replaceable ? 1 : 0;
}

// Per-face texture layers: TEXL[id*6+face]; FRONTL[id] for blocks with a front face.
export const TEXL = new Uint16Array(256 * 6);
export const FRONTL = new Uint16Array(256);
export function bindTextures(LAYERS) {
  const L = (n) => {
    if (LAYERS[n] === undefined) throw new Error('missing texture ' + n);
    return LAYERS[n];
  };
  for (const d of BLOCKS) {
    if (!d.tex) continue;
    const t = typeof d.tex === 'string' ? { top: d.tex, side: d.tex, bottom: d.tex } : d.tex;
    const top = L(t.top), side = L(t.side || t.top), bottom = L(t.bottom || t.top);
    const f = [side, side, top, bottom, side, side];
    for (let i = 0; i < 6; i++) TEXL[d.id * 6 + i] = f[i];
    FRONTL[d.id] = t.front ? L(t.front) : side;
  }
  for (const id in ITEMS) ITEMS[id].layer = L(ITEMS[id].tex);
}

export function itemDef(id) {
  return id < 256 ? BLOCKS[id] : ITEMS[id];
}
export function itemName(id) {
  const d = itemDef(id);
  return d ? d.name : '?';
}
export function maxStackOf(id) {
  const d = itemDef(id);
  return d ? d.maxStack : 64;
}
export function toolOf(stack) {
  if (!stack || stack.id < 256) return null;
  return ITEMS[stack.id].tool;
}

export function canHarvest(blockId, stack) {
  const d = BLOCKS[blockId];
  if (!d.tier) return true;
  const t = toolOf(stack);
  return !!t && t.type === d.tool && t.tier >= d.tier;
}

export function breakTime(blockId, stack) {
  const d = BLOCKS[blockId];
  if (d.hardness < 0) return Infinity;
  if (d.hardness === 0) return 0.05;
  const t = toolOf(stack);
  let speed = 1;
  if (t && t.type === d.tool) speed = t.speed;
  if (t && t.type === 'sword' && d.leaf) speed = 1.5;
  return (d.hardness * (canHarvest(blockId, stack) ? 1.5 : 5)) / speed;
}

// Items shown in the creative menu, grouped.
export function creativeList() {
  const blocks = BLOCKS.filter((d) => d.creative && d.id !== 0).map((d) => d.id);
  const items = Object.values(ITEMS).filter((d) => d.creative).map((d) => d.id);
  return { blocks, items };
}

export function nameToId(name) {
  const k = String(name).toUpperCase().replace(/[\s-]/g, '_');
  if (B[k] !== undefined) return B[k];
  if (I[k] !== undefined) return I[k];
  const lower = String(name).toLowerCase();
  for (const d of BLOCKS) if (d.name.toLowerCase() === lower) return d.id;
  for (const id in ITEMS) if (ITEMS[id].name.toLowerCase() === lower) return +id;
  return undefined;
}
