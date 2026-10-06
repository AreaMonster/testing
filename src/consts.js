// World dimensions and timing shared by every module.
export const CS = 16;          // chunk width/depth in blocks
export const CH = 128;         // world height in blocks
export const SEA = 62;         // sea level (top water block y)
export const TICK = 1 / 20;    // game tick length in seconds
export const DAY_TICKS = 24000;

// Face indices used by the mesher, lighting and placement code.
export const FACE = { PX: 0, NX: 1, PY: 2, NY: 3, PZ: 4, NZ: 5 };
export const FACE_DIRS = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
];
