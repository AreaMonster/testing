// Web Worker that generates raw chunk data (and far-terrain tiles) off the main thread.
import { WorldGen } from './worldgen.js';
import { bindTextures } from './blocks.js';
import { buildLod } from './lod.js';

let gen = null;
self.onmessage = (e) => {
  const d = e.data;
  if (d.layers) { bindTextures(d.layers); return; }
  const { id, seed, cx, cz } = d;
  if (!gen || gen.seed !== (seed | 0)) gen = new WorldGen(seed);
  if (d.lod) {
    const m = buildLod(gen, d.x0, d.z0, d.step);
    self.postMessage({ lod: true, id, key: d.key, minY: m.minY, maxY: m.maxY, o: m.o, w: m.w }, [m.o.f.buffer, m.o.b.buffer, m.w.f.buffer, m.w.b.buffer]);
    return;
  }
  const c = { cx, cz, blocks: new Uint8Array(32768), meta: new Uint8Array(32768), tint: new Uint8Array(768) };
  gen.generate(c);
  self.postMessage({ id, seed, cx, cz, blocks: c.blocks, meta: c.meta, tint: c.tint }, [c.blocks.buffer, c.meta.buffer, c.tint.buffer]);
};
