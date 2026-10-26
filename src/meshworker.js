// Web Worker that turns a chunk's padded neighbourhood into vertex buffers.
import { bindTextures } from './blocks.js';
import { meshPacked } from './mesher.js';

self.onmessage = (e) => {
  const d = e.data;
  if (d.layers) { bindTextures(d.layers); return; }
  const m = meshPacked(d, d.opts);
  const out = { key: d.key, uid: d.uid, ver: d.ver, epoch: d.epoch, minY: m.minY, maxY: m.maxY, o: m.o, w: m.w };
  self.postMessage(out, [m.o.f.buffer, m.o.b.buffer, m.w.f.buffer, m.w.b.buffer]);
};
