// Web Worker that generates raw chunk data off the main thread.
import { WorldGen } from './worldgen.js';

let gen = null;
self.onmessage = (e) => {
  const { id, seed, cx, cz } = e.data;
  if (!gen || gen.seed !== (seed | 0)) gen = new WorldGen(seed);
  const c = { cx, cz, blocks: new Uint8Array(32768), meta: new Uint8Array(32768), tint: new Uint8Array(768) };
  gen.generate(c);
  self.postMessage({ id, seed, cx, cz, blocks: c.blocks, meta: c.meta, tint: c.tint }, [c.blocks.buffer, c.meta.buffer, c.tint.buffer]);
};
