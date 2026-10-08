// WebGL2 renderer: terrain, entities, sky, clouds, particles and the held item.
import { Mat4, Frustum, multiply, invert } from './math.js';
import { textureArrayData, LAYER_COUNT, LAYERS, layerData, cloudData, DEFAULT_GRASS } from './textures.js';
import { blockItemMesh, spriteMesh, MeshBuf } from './mesher.js';
import { BLOCKS, ITEMS, R, TEXL, TINT } from './blocks.js';

const BLOCK_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aUV;
layout(location=2) in vec4 aLight;
layout(location=3) in vec3 aTint;
uniform mat4 uProjView;
uniform mat4 uModel;
uniform vec3 uOffset;
uniform float uTime;
uniform vec2 uEntLight;
uniform vec3 uChunk;
out vec3 vUV;
out vec3 vRel;
flat out int vFlags;
out float vSky;
out float vBlk;
out float vBright;
out vec3 vTint;
out float vDist;
void main() {
  vec4 wp = uModel * vec4(aPos, 1.0);
  wp.xyz += uOffset;
  int flags = int(aLight.w * 255.0 + 0.5);
  vec3 uv = aUV;
  if ((flags & 1) != 0) uv.xy += vec2(uTime * 0.025, uTime * 0.05);
  if ((flags & 2) != 0) uv.xy += vec2(uTime * 0.006, uTime * 0.012);
  vec3 ap = aPos + uChunk;
  if ((flags & 4) != 0) {
    wp.x += sin(uTime * 1.7 + ap.x * 0.7 + ap.z * 0.45) * 0.06;
    wp.z += cos(uTime * 1.3 + ap.z * 0.6 + ap.x * 0.3) * 0.045;
  }
  if ((flags & 8) != 0) {
    wp.y += (sin(uTime * 1.6 + ap.x * 0.9 + ap.z * 0.6) + sin(uTime * 1.1 - ap.x * 0.4 + ap.z * 1.2)) * 0.022 - 0.045;
  }
  if ((flags & 16) != 0) {
    wp.x += sin(uTime * 1.2 + ap.y * 0.8 + ap.z * 0.6) * 0.022;
    wp.z += cos(uTime * 0.9 + ap.x * 0.7 + ap.y * 0.5) * 0.018;
  }
  gl_Position = uProjView * wp;
  vUV = uv;
  if (uEntLight.x >= 0.0) { vSky = uEntLight.x; vBlk = uEntLight.y; }
  else { vSky = aLight.x; vBlk = aLight.y; }
  vBright = aLight.z;
  vTint = aTint;
  vDist = length(wp.xyz);
  vRel = wp.xyz;
  vFlags = flags;
}`;

const BLOCK_FS = `#version 300 es
precision highp float;
precision highp sampler2DArray;
uniform sampler2DArray uTex;
uniform float uDaylight;
uniform vec3 uFogColor;
uniform vec2 uFog;
uniform float uAlphaTest;
uniform vec4 uColorMul;
uniform float uGamma;
uniform vec3 uSunDir;
uniform float uFlicker;
uniform float uOpaque;
in vec3 vUV;
in vec3 vRel;
flat in int vFlags;
in float vSky;
in float vBlk;
in float vBright;
in vec3 vTint;
in float vDist;
out vec4 outColor;
float curve(float l) { return l / (4.0 - 3.0 * l); }
void main() {
  vec4 c = texture(uTex, vUV);
  if (c.a < uAlphaTest) discard;
  c.rgb *= vTint;
  float s = curve(vSky) * uDaylight;
  float b = curve(vBlk) * uFlicker;
  vec3 skyCol = mix(vec3(0.52, 0.6, 0.95), vec3(1.0), clamp(uDaylight * 1.3 - 0.2, 0.0, 1.0));
  vec3 light = max(vec3(s) * skyCol, vec3(b) * vec3(1.0, 0.86, 0.64));
  light = pow(light * 0.94 + 0.05, vec3(uGamma));
  c.rgb *= light * vBright;
  if ((vFlags & 1) != 0) {
    vec3 v = normalize(vRel);
    float fres = pow(1.0 - abs(v.y), 4.0);
    c.rgb = mix(c.rgb, uFogColor * max(s, 0.08), fres * 0.45);
    c.a = mix(c.a, 0.94, fres * 0.85);
    if ((vFlags & 8) != 0 && uSunDir.y > 0.0) {
      vec3 r = reflect(v, normalize(vec3(sin(vRel.x * 1.7 + vRel.z) * 0.04, 1.0, cos(vRel.z * 1.9 - vRel.x) * 0.04)));
      float spec = pow(max(dot(r, uSunDir), 0.0), 90.0) * curve(vSky);
      c.rgb += vec3(1.0, 0.95, 0.8) * spec * 1.4;
      c.a = max(c.a, spec);
    }
  }
  c *= uColorMul;
  float fog = smoothstep(uFog.x, uFog.y, vDist);
  c.rgb = mix(c.rgb, uFogColor, fog);
  if (uOpaque > 0.5) c.a = (clamp((vBlk - 0.8) * 5.0, 0.0, 0.7) + ((vFlags & 2) != 0 ? 0.75 : 0.0)) * (1.0 - fog);
  outColor = c;
}`;

const SKY_VS = `#version 300 es
const vec2 P[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
out vec2 vNdc;
void main() { vNdc = P[gl_VertexID]; gl_Position = vec4(vNdc, 0.99999, 1.0); }`;

const SKY_FS = `#version 300 es
precision highp float;
uniform mat4 uInvVP;
uniform vec3 uSunDir;
uniform vec3 uTop;
uniform vec3 uHorizon;
uniform vec3 uSunset;
uniform float uNight;
uniform float uStarRot;
uniform vec3 uFogColor;
uniform float uUnder;
uniform float uMoonPhase;
in vec2 vNdc;
out vec4 o;
float hash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
void main() {
  vec4 p = uInvVP * vec4(vNdc, 1.0, 1.0);
  vec3 d = normalize(p.xyz / p.w);
  float h = d.y;
  vec3 col = mix(uHorizon, uTop, pow(clamp(h, 0.0, 1.0), 0.5));
  if (h < 0.0) col = mix(uHorizon, uHorizon * 0.55, clamp(-h * 2.5, 0.0, 1.0));
  float sd = max(dot(d, uSunDir), 0.0);
  col += uSunset * pow(sd, 5.0) * (1.0 - clamp(abs(h) * 1.6, 0.0, 1.0));
  vec3 s = uSunDir;
  vec3 e1 = normalize(vec3(-s.y, s.x, 0.0));
  vec3 e2 = vec3(0.0, 0.0, 1.0);
  float ds = dot(d, s);
  float glow = 0.0;
  if (h < -0.01) {
  } else if (ds > 0.0) {
    vec2 q = vec2(dot(d, e1), dot(d, e2)) / ds;
    float m = max(abs(q.x), abs(q.y));
    if (m < 0.075) { col = vec3(1.0, 0.97, 0.82) * 1.25; glow = 1.0; }
    glow = max(glow, exp(-m * 9.0) * 0.5);
    col += vec3(1.0, 0.85, 0.55) * exp(-m * 14.0) * 0.35 * (1.0 - uNight);
  } else {
    vec2 q = vec2(dot(d, e1), dot(d, e2)) / -ds;
    float m = max(abs(q.x), abs(q.y));
    if (m < 0.055) {
      float cr = hash(floor(vec3(q * 28.0, 3.0)));
      vec3 moon = mix(vec3(0.86, 0.88, 0.94), vec3(0.62, 0.64, 0.72), step(0.72, cr));
      float pp = uMoonPhase / 8.0, edge = cos(pp * 6.2832), u = q.x / 0.055;
      float lit = (pp < 0.5 ? u : -u) > -edge ? 1.0 : 0.12;
      col = mix(col, moon, lit);
      glow = 0.35 * lit;
    }
    col += vec3(0.5, 0.6, 0.9) * exp(-m * 18.0) * 0.12 * uNight;
  }
  if (uNight > 0.01 && h > -0.05) {
    float c = cos(uStarRot), sn = sin(uStarRot);
    vec3 r = vec3(c * d.x - sn * d.y, sn * d.x + c * d.y, d.z);
    vec3 a = abs(r);
    vec2 uv; float face;
    if (a.x > a.y && a.x > a.z) { uv = r.yz / a.x; face = sign(r.x); }
    else if (a.y > a.z) { uv = r.xz / a.y; face = 2.0 + sign(r.y); }
    else { uv = r.xy / a.z; face = 4.0 + sign(r.z); }
    vec2 g = uv * 80.0;
    vec2 cell = floor(g);
    float hs = hash(vec3(cell, face));
    if (hs > 0.993) {
      vec2 f = fract(g) - 0.5;
      float star = smoothstep(0.22, 0.0, length(f)) * (0.5 + 0.5 * hash(vec3(cell, face + 9.0)));
      col += vec3(star) * uNight * clamp(h * 4.0 + 0.2, 0.0, 1.0);
    }
  }
  col = mix(col, uFogColor, uUnder);
  o = vec4(col, glow * (1.0 - uUnder));
}`;

const CLOUD_VS = `#version 300 es
layout(location=0) in vec2 aPos;
uniform mat4 uProjView;
uniform vec3 uCam;
uniform float uY;
uniform float uSize;
out vec2 vXZ;
out float vDist;
void main() {
  vec3 rel = vec3(aPos.x * uSize, uY - uCam.y, aPos.y * uSize);
  vXZ = rel.xz + uCam.xz;
  vDist = length(rel.xz);
  gl_Position = uProjView * vec4(rel, 1.0);
}`;

const CLOUD_FS = `#version 300 es
precision highp float;
uniform sampler2D uCloud;
uniform vec2 uOffset;
uniform vec3 uColor;
uniform float uFar;
uniform float uCover;
uniform float uLayer;
in vec2 vXZ;
in float vDist;
out vec4 o;
void main() {
  vec2 uv = (vXZ + uOffset) / (12.0 * 128.0);
  float a = texture(uCloud, uv).r;
  float thr = mix(0.57, 0.4, uCover) + uLayer * 0.03;
  if (a < thr) discard;
  float thick = clamp((a - thr) / (1.0 - thr) * 2.5, 0.0, 1.0);
  vec3 col = uColor * mix(1.0, mix(0.86, 0.62, uCover), thick) * (1.0 - uLayer * 0.06);
  float fade = 1.0 - smoothstep(uFar * 0.55, uFar, vDist);
  o = vec4(col, (0.8 + uCover * 0.15) * fade * (1.0 - uLayer * 0.25));
}`;

const LINE_VS = `#version 300 es
layout(location=0) in vec3 aPos;
uniform mat4 uProjView;
uniform mat4 uModel;
void main() { gl_Position = uProjView * uModel * vec4(aPos, 1.0); }`;
const LINE_FS = `#version 300 es
precision mediump float;
uniform vec4 uColor;
out vec4 o;
void main() { o = uColor; }`;

const POST_VS = `#version 300 es
const vec2 P[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
out vec2 vUV;
void main() { vec2 p = P[gl_VertexID]; vUV = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }`;

// Downsample the scene, keeping only what the glow mask (alpha) marks as emissive.
const BRIGHT_FS = `#version 300 es
precision mediump float;
uniform sampler2D uScene;
uniform vec2 uTexel;
in vec2 vUV;
out vec4 o;
void main() {
  vec3 c = vec3(0.0);
  for (int i = 0; i < 4; i++) {
    vec2 off = vec2(float(i & 1) * 2.0 - 1.0, float(i >> 1) * 2.0 - 1.0) * uTexel;
    vec4 s = texture(uScene, vUV + off);
    c += s.rgb * s.a;
  }
  o = vec4(c * 0.25, 1.0);
}`;

const BLUR_FS = `#version 300 es
precision mediump float;
uniform sampler2D uTex;
uniform vec2 uDir;
in vec2 vUV;
out vec4 o;
void main() {
  vec3 c = texture(uTex, vUV).rgb * 0.227;
  c += (texture(uTex, vUV + uDir * 1.385).rgb + texture(uTex, vUV - uDir * 1.385).rgb) * 0.316;
  c += (texture(uTex, vUV + uDir * 3.231).rgb + texture(uTex, vUV - uDir * 3.231).rgb) * 0.07;
  o = vec4(c, 1.0);
}`;

const COMPOSITE_FS = `#version 300 es
precision highp float;
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform float uBloomStr;
uniform float uTime;
uniform float uUnder;
uniform float uLava;
uniform float uHurt;
uniform float uWet;
in vec2 vUV;
out vec4 o;
void main() {
  vec2 uv = vUV;
  if (uUnder > 0.5) uv += vec2(sin(uv.y * 26.0 + uTime * 2.1), cos(uv.x * 21.0 + uTime * 1.7)) * 0.0022;
  if (uLava > 0.5) uv += vec2(sin(uv.y * 14.0 + uTime * 3.0), 0.0) * 0.004;
  vec3 c = texture(uScene, uv).rgb;
  c += texture(uBloom, uv).rgb * uBloomStr;
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  c = mix(vec3(l), c, 1.1 - uWet * 0.25);
  c = c * (1.0 + 0.06 * (c - 0.5));
  vec2 d = vUV - 0.5;
  c *= 1.0 - dot(d, d) * (0.55 + uWet * 0.2);
  if (uUnder > 0.5) c *= vec3(0.75, 0.92, 1.1);
  c = mix(c, vec3(0.55, 0.02, 0.0), uHurt * smoothstep(0.2, 0.65, length(d)));
  o = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

export class Renderer {
  constructor(canvas) {
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    this.gl = gl;
    this.canvas = canvas;
    this.block = this.program(BLOCK_VS, BLOCK_FS);
    this.sky = this.program(SKY_VS, SKY_FS);
    this.cloud = this.program(CLOUD_VS, CLOUD_FS);
    this.line = this.program(LINE_VS, LINE_FS);
    this.bright = this.program(POST_VS, BRIGHT_FS);
    this.blur = this.program(POST_VS, BLUR_FS);
    this.composite = this.program(POST_VS, COMPOSITE_FS);
    this.post = null;
    this.weatherMesh = null;
    this.proj = new Mat4();
    this.view = new Mat4();
    this.pv = new Mat4();
    this.handProj = new Mat4();
    this.frustum = new Frustum();
    this.ident = new Mat4();
    this.tmp = new Mat4();
    this.invVP = new Float32Array(16);
    this.eboQuads = 0;
    this.ebo = gl.createBuffer();
    this.ensureEBO(65536);
    this.initTextures();
    this.initStatic();
    this.itemMeshes = new Map();
    this.particleBuf = new MeshBuf(4096);
    this.particleMesh = null;
    this.stats = { chunks: 0, quads: 0 };
  }

  program(vs, fs) {
    const gl = this.gl;
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      u[info.name] = gl.getUniformLocation(p, info.name);
    }
    return { p, u };
  }

  ensureEBO(quads) {
    if (quads <= this.eboQuads) return;
    const gl = this.gl;
    const n = Math.max(quads, this.eboQuads * 2);
    const idx = new Uint32Array(n * 6);
    for (let q = 0, i = 0; q < n; q++) {
      const v = q * 4;
      idx[i++] = v; idx[i++] = v + 1; idx[i++] = v + 2;
      idx[i++] = v; idx[i++] = v + 2; idx[i++] = v + 3;
    }
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ebo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    this.eboQuads = n;
  }

  initTextures() {
    const gl = this.gl;
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.tex);
    gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.RGBA8, 16, 16, LAYER_COUNT, 0, gl.RGBA, gl.UNSIGNED_BYTE, textureArrayData());
    gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAX_LEVEL, 4);
    this.cloudTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.cloudTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 128, 128, 0, gl.RED, gl.UNSIGNED_BYTE, cloudData());
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  }

  initStatic() {
    const gl = this.gl;
    this.skyVAO = gl.createVertexArray();
    // cloud quad
    this.cloudVAO = gl.createVertexArray();
    gl.bindVertexArray(this.cloudVAO);
    const cb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, cb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    // selection box edges
    this.lineVAO = gl.createVertexArray();
    gl.bindVertexArray(this.lineVAO);
    const e = [];
    const c = [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1], [0, 1, 0], [1, 1, 0], [1, 1, 1], [0, 1, 1]];
    [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]].forEach(([a, b]) => e.push(...c[a], ...c[b]));
    const lb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, lb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(e), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    // blob shadow quad
    {
      const buf = new MeshBuf(4), L = LAYERS.shadow;
      [[-0.5, 0.5, 0, 1], [0.5, 0.5, 1, 1], [0.5, -0.5, 1, 0], [-0.5, -0.5, 0, 0]].forEach(([x, z, u, v]) => buf.v(x, 0, z, u, v, L, 255, 0, 255, 0, 255, 255, 255));
      this.shadowMesh = this.upload(buf.slice());
    }
    // crack overlay cubes
    this.crackMeshes = [];
    for (let s = 0; s < 10; s++) {
      const buf = new MeshBuf(24);
      const m = blockItemMesh(1, DEFAULT_GRASS);
      buf.f.set(m.f);
      buf.b.set(m.b);
      buf.n = 24;
      for (let i = 0; i < 24; i++) {
        buf.f[i * 6 + 5] = LAYERS[`destroy_${s}`];
        buf.b[i * 8 + 2] = 255;
      }
      this.crackMeshes.push(this.upload(buf.slice()));
    }
  }

  upload(data, dynamic = false) {
    if (!data || !data.quads) return null;
    const gl = this.gl;
    this.ensureEBO(data.quads);
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const b1 = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b1);
    gl.bufferData(gl.ARRAY_BUFFER, data.f, dynamic ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    const b2 = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b2);
    gl.bufferData(gl.ARRAY_BUFFER, data.b, dynamic ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.UNSIGNED_BYTE, true, 8, 0);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 3, gl.UNSIGNED_BYTE, true, 8, 4);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ebo);
    gl.bindVertexArray(null);
    return { vao, b1, b2, count: data.quads * 6, quads: data.quads };
  }

  free(m) {
    if (!m) return;
    const gl = this.gl;
    gl.deleteBuffer(m.b1);
    gl.deleteBuffer(m.b2);
    gl.deleteVertexArray(m.vao);
  }

  setChunkMesh(chunk, built) {
    this.freeChunk(chunk);
    chunk.mesh = { o: this.upload(built.o), w: this.upload(built.w), minY: built.minY, maxY: built.maxY };
  }
  freeChunk(chunk) {
    if (!chunk.mesh) return;
    this.free(chunk.mesh.o);
    this.free(chunk.mesh.w);
    chunk.mesh = null;
  }

  itemMesh(id) {
    let m = this.itemMeshes.get(id);
    if (m) return m;
    const d = id < 256 ? BLOCKS[id] : ITEMS[id];
    let data, flat = true;
    if (d.isBlock && (d.render === R.CUBE || d.render === R.CUTOUT)) {
      data = blockItemMesh(id, DEFAULT_GRASS);
      flat = false;
    } else {
      const layer = d.isBlock ? TEXL[id * 6] : d.layer;
      const ld = layerData[layer];
      const tint = d.isBlock && TINT[id] === 2 ? DEFAULT_GRASS : [255, 255, 255];
      data = spriteMesh(layer, (x, y) => ld[(y * 16 + x) * 4 + 3], tint);
    }
    m = { mesh: this.upload(data), flat };
    this.itemMeshes.set(id, m);
    return m;
  }

  makeTarget(w, h, depth) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    let rb = null;
    if (depth) {
      rb = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rb);
    }
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return ok ? { tex, fb, rb, w, h } : null;
  }

  freeTarget(t) {
    if (!t) return;
    const gl = this.gl;
    gl.deleteTexture(t.tex);
    gl.deleteFramebuffer(t.fb);
    if (t.rb) gl.deleteRenderbuffer(t.rb);
  }

  // (Re)creates the scene and bloom render targets to match the canvas.
  ensurePost(enabled) {
    const c = this.canvas;
    if (!enabled || this.postFailed) {
      if (this.post) { [this.post.scene, this.post.a, this.post.b].forEach((t) => this.freeTarget(t)); this.post = null; }
      return null;
    }
    if (this.post && this.post.scene.w === c.width && this.post.scene.h === c.height) return this.post;
    if (this.post) [this.post.scene, this.post.a, this.post.b].forEach((t) => this.freeTarget(t));
    const qw = Math.max(1, c.width >> 2), qh = Math.max(1, c.height >> 2);
    const scene = this.makeTarget(c.width, c.height, true), a = this.makeTarget(qw, qh), b = this.makeTarget(qw, qh);
    if (!scene || !a || !b) { this.postFailed = true; this.post = null; return null; }
    this.post = { scene, a, b };
    return this.post;
  }

  postProcess(f) {
    const gl = this.gl, P = this.post;
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    gl.bindVertexArray(this.skyVAO);
    const pass = (prog, target, setup) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fb : null);
      gl.viewport(0, 0, target ? target.w : this.canvas.width, target ? target.h : this.canvas.height);
      gl.useProgram(prog.p);
      setup(prog.u);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    gl.activeTexture(gl.TEXTURE0);
    pass(this.bright, P.a, (u) => {
      gl.bindTexture(gl.TEXTURE_2D, P.scene.tex);
      gl.uniform1i(u.uScene, 0);
      gl.uniform2f(u.uTexel, 1 / P.scene.w, 1 / P.scene.h);
    });
    for (let i = 0; i < 2; i++) {
      pass(this.blur, P.b, (u) => { gl.bindTexture(gl.TEXTURE_2D, P.a.tex); gl.uniform1i(u.uTex, 0); gl.uniform2f(u.uDir, (1 + i) / P.a.w, 0); });
      pass(this.blur, P.a, (u) => { gl.bindTexture(gl.TEXTURE_2D, P.b.tex); gl.uniform1i(u.uTex, 0); gl.uniform2f(u.uDir, 0, (1 + i) / P.a.h); });
    }
    pass(this.composite, null, (u) => {
      gl.bindTexture(gl.TEXTURE_2D, P.scene.tex);
      gl.uniform1i(u.uScene, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, P.a.tex);
      gl.uniform1i(u.uBloom, 1);
      gl.activeTexture(gl.TEXTURE0);
      gl.uniform1f(u.uBloomStr, 1.7);
      gl.uniform1f(u.uTime, f.time);
      gl.uniform1f(u.uUnder, f.underwater ? 1 : 0);
      gl.uniform1f(u.uLava, f.inLava ? 1 : 0);
      gl.uniform1f(u.uHurt, Math.min(1, (f.hurt || 0) * 2));
      gl.uniform1f(u.uWet, f.cloudCover || 0);
    });
    gl.enable(gl.DEPTH_TEST);
  }

  resize(scale) {
    const c = this.canvas;
    const w = Math.max(1, Math.floor(c.clientWidth * scale)), h = Math.max(1, Math.floor(c.clientHeight * scale));
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
  }

  setupCamera(cam, far) {
    const c = this.canvas;
    const aspect = c.width / c.height;
    this.proj.perspective((cam.fov * Math.PI) / 180, aspect, 0.05, far);
    this.view.identity().rotateZ(-(cam.roll || 0)).rotateX(-cam.pitch).rotateY(-cam.yaw);
    multiply(this.pv.m, this.proj.m, this.view.m);
    this.frustum.setFromMatrix(this.pv.m);
    invert(this.invVP, this.pv.m);
    this.handProj.perspective((70 * Math.PI) / 180, aspect, 0.01, 10);
  }

  // f: frame description assembled by the game each frame.
  render(f) {
    const gl = this.gl;
    const cam = f.cam;
    const post = this.ensurePost(f.post);
    gl.bindFramebuffer(gl.FRAMEBUFFER, post ? post.scene.fb : null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    this.setupCamera(cam, f.far);
    gl.clearColor(f.fog.color[0], f.fog.color[1], f.fog.color[2], 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    // Sky
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.useProgram(this.sky.p);
    const su = this.sky.u;
    gl.uniformMatrix4fv(su.uInvVP, false, this.invVP);
    gl.uniform3fv(su.uSunDir, f.sky.sunDir);
    gl.uniform3fv(su.uTop, f.sky.top);
    gl.uniform3fv(su.uHorizon, f.sky.horizon);
    gl.uniform3fv(su.uSunset, f.sky.sunset);
    gl.uniform1f(su.uNight, f.sky.night);
    gl.uniform1f(su.uStarRot, f.sky.starRot);
    gl.uniform3fv(su.uFogColor, f.fog.color);
    gl.uniform1f(su.uUnder, f.underwater ? 1 : 0);
    gl.uniform1f(su.uMoonPhase, f.moonPhase || 0);
    gl.bindVertexArray(this.skyVAO);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.depthMask(true);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);

    // Terrain
    const bp = this.block, u = bp.u;
    gl.useProgram(bp.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.tex);
    gl.uniform1i(u.uTex, 0);
    gl.uniformMatrix4fv(u.uProjView, false, this.pv.m);
    gl.uniformMatrix4fv(u.uModel, false, this.ident.m);
    gl.uniform1f(u.uTime, f.time);
    gl.uniform1f(u.uDaylight, f.daylight);
    gl.uniform3fv(u.uFogColor, f.fog.color);
    gl.uniform2f(u.uFog, f.fog.start, f.fog.end);
    gl.uniform1f(u.uAlphaTest, 0.5);
    gl.uniform4f(u.uColorMul, 1, 1, 1, 1);
    gl.uniform2f(u.uEntLight, -1, -1);
    gl.uniform1f(u.uGamma, f.gamma);
    gl.uniform3fv(u.uSunDir, f.sky.sunDir);
    gl.uniform1f(u.uFlicker, f.flicker || 1);
    gl.uniform1f(u.uOpaque, 1);
    gl.uniform3f(u.uChunk, 0, 0, 0);
    gl.enable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    let drawn = 0, quads = 0;
    const visible = [];
    for (const c of f.chunks) {
      const m = c.mesh;
      if (!m) continue;
      const x0 = c.cx * 16 - cam.x, z0 = c.cz * 16 - cam.z;
      if (!this.frustum.boxVisible(x0, m.minY - cam.y, z0, x0 + 16, m.maxY - cam.y, z0 + 16)) continue;
      visible.push(c);
      if (!m.o) continue;
      gl.uniform3f(u.uOffset, x0, -cam.y, z0);
      gl.uniform3f(u.uChunk, c.cx * 16, 0, c.cz * 16);
      gl.bindVertexArray(m.o.vao);
      gl.drawElements(gl.TRIANGLES, m.o.count, gl.UNSIGNED_INT, 0);
      drawn++;
      quads += m.o.quads;
    }
    this.stats.chunks = drawn;
    this.stats.quads = quads;

    gl.uniform3f(u.uChunk, 0, 0, 0);
    // Entities
    for (const e of f.entities) {
      if (!e.mesh) continue;
      gl.uniform3f(u.uOffset, 0, 0, 0);
      gl.uniformMatrix4fv(u.uModel, false, e.model);
      gl.uniform2f(u.uEntLight, e.light[0], e.light[1]);
      const cm = e.color || [1, 1, 1, 1];
      gl.uniform4f(u.uColorMul, cm[0], cm[1], cm[2], cm[3]);
      if (e.noCull) gl.disable(gl.CULL_FACE);
      gl.bindVertexArray(e.mesh.vao);
      gl.drawElements(gl.TRIANGLES, e.mesh.count, gl.UNSIGNED_INT, 0);
      if (e.noCull) gl.enable(gl.CULL_FACE);
    }
    gl.uniformMatrix4fv(u.uModel, false, this.ident.m);
    gl.uniform2f(u.uEntLight, -1, -1);
    gl.uniform4f(u.uColorMul, 1, 1, 1, 1);

    // Blob shadows under entities
    if (f.shadows && f.shadows.length) {
      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
      gl.depthMask(false);
      gl.enable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(-2, -2);
      gl.uniform2f(u.uEntLight, 1, 0);
      gl.uniform1f(u.uAlphaTest, 0.01);
      gl.bindVertexArray(this.shadowMesh.vao);
      for (const sh of f.shadows) {
        this.tmp.identity().translate(sh.x - cam.x, sh.y + 0.01 - cam.y, sh.z - cam.z).scale(sh.r, 1, sh.r);
        gl.uniformMatrix4fv(u.uModel, false, this.tmp.m);
        gl.uniform4f(u.uColorMul, 1, 1, 1, sh.a);
        gl.drawElements(gl.TRIANGLES, this.shadowMesh.count, gl.UNSIGNED_INT, 0);
      }
      gl.disable(gl.POLYGON_OFFSET_FILL);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
      gl.uniformMatrix4fv(u.uModel, false, this.ident.m);
      gl.uniform2f(u.uEntLight, -1, -1);
      gl.uniform4f(u.uColorMul, 1, 1, 1, 1);
      gl.uniform1f(u.uAlphaTest, 0.5);
    }

    // Particles
    if (f.particles.length) this.drawParticles(f, u);

    // Block crack overlay
    if (f.crack) {
      const m = this.crackMeshes[Math.min(9, f.crack.stage)];
      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
      gl.enable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(-1, -1);
      this.tmp.identity().translate(f.crack.x + 0.5 - cam.x, f.crack.y + 0.5 - cam.y, f.crack.z + 0.5 - cam.z).scale(1.003);
      gl.uniformMatrix4fv(u.uModel, false, this.tmp.m);
      gl.uniform2f(u.uEntLight, 1, 1);
      gl.uniform1f(u.uAlphaTest, 0.05);
      gl.bindVertexArray(m.vao);
      gl.drawElements(gl.TRIANGLES, m.count, gl.UNSIGNED_INT, 0);
      gl.disable(gl.POLYGON_OFFSET_FILL);
      gl.uniformMatrix4fv(u.uModel, false, this.ident.m);
      gl.uniform2f(u.uEntLight, -1, -1);
      gl.disable(gl.BLEND);
    }

    // Clouds
    if (f.clouds) {
      gl.useProgram(this.cloud.p);
      const cu = this.cloud.u;
      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
      gl.disable(gl.CULL_FACE);
      gl.depthMask(false);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.cloudTex);
      gl.uniform1i(cu.uCloud, 1);
      gl.uniformMatrix4fv(cu.uProjView, false, this.pv.m);
      gl.uniform3f(cu.uCam, cam.x, cam.y, cam.z);
      gl.uniform1f(cu.uY, 124);
      gl.uniform1f(cu.uSize, f.far);
      gl.uniform2f(cu.uOffset, f.clouds.offset, 0);
      gl.uniform3fv(cu.uColor, f.clouds.color);
      gl.uniform1f(cu.uFar, f.far);
      gl.uniform1f(cu.uCover, f.cloudCover || 0);
      gl.bindVertexArray(this.cloudVAO);
      for (let layer = 1; layer >= 0; layer--) {
        gl.uniform1f(cu.uLayer, layer);
        gl.uniform1f(cu.uY, 124 + layer * 3.5);
        gl.uniform2f(cu.uOffset, f.clouds.offset + layer * 37, layer * 53);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      }
      gl.depthMask(true);
      gl.activeTexture(gl.TEXTURE0);
      gl.useProgram(bp.p);
    }

    // Water (back to front)
    gl.uniform1f(u.uOpaque, 0);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
    gl.disable(gl.CULL_FACE);
    gl.depthMask(false);
    gl.uniform1f(u.uAlphaTest, 0.01);
    for (let i = visible.length - 1; i >= 0; i--) {
      const c = visible[i], m = c.mesh;
      if (!m.w) continue;
      gl.uniform3f(u.uOffset, c.cx * 16 - cam.x, -cam.y, c.cz * 16 - cam.z);
      gl.uniform3f(u.uChunk, c.cx * 16, 0, c.cz * 16);
      gl.bindVertexArray(m.w.vao);
      gl.drawElements(gl.TRIANGLES, m.w.count, gl.UNSIGNED_INT, 0);
    }
    if (f.weather) {
      if (!this.weatherMesh) this.weatherMesh = this.upload(f.weather, true);
      else {
        this.ensureEBO(f.weather.quads);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.weatherMesh.b1);
        gl.bufferData(gl.ARRAY_BUFFER, f.weather.f, gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.weatherMesh.b2);
        gl.bufferData(gl.ARRAY_BUFFER, f.weather.b, gl.DYNAMIC_DRAW);
      }
      gl.uniform3f(u.uOffset, 0, 0, 0);
      gl.uniform3f(u.uChunk, 0, 0, 0);
      gl.bindVertexArray(this.weatherMesh.vao);
      gl.drawElements(gl.TRIANGLES, f.weather.quads * 6, gl.UNSIGNED_INT, 0);
    }
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.enable(gl.CULL_FACE);

    // Selection outline
    if (f.selection) {
      const s = f.selection;
      gl.useProgram(this.line.p);
      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
      const y0 = s.y0 || 0, y1 = s.y1 === undefined ? 1 : s.y1;
      this.tmp.identity().translate(s.x - 0.002 - cam.x, s.y + y0 - 0.002 - cam.y, s.z - 0.002 - cam.z).scale(1.004, y1 - y0 + 0.004, 1.004);
      gl.uniformMatrix4fv(this.line.u.uProjView, false, this.pv.m);
      gl.uniformMatrix4fv(this.line.u.uModel, false, this.tmp.m);
      gl.uniform4f(this.line.u.uColor, 0.05, 0.05, 0.05, 0.6);
      gl.bindVertexArray(this.lineVAO);
      gl.drawArrays(gl.LINES, 0, 24);
      gl.disable(gl.BLEND);
      gl.useProgram(bp.p);
    }

    // Held item / arm
    if (f.hand && f.hand.mesh) {
      gl.clear(gl.DEPTH_BUFFER_BIT);
      gl.uniformMatrix4fv(u.uProjView, false, this.handProj.m);
      gl.uniformMatrix4fv(u.uModel, false, f.hand.model);
      gl.uniform3f(u.uOffset, 0, 0, 0);
      gl.uniform2f(u.uEntLight, f.hand.light[0], f.hand.light[1]);
      gl.uniform2f(u.uFog, 1e5, 1e5 + 1);
      gl.uniform1f(u.uAlphaTest, 0.5);
      if (f.hand.noCull) gl.disable(gl.CULL_FACE);
      gl.uniform1f(u.uOpaque, 1);
      gl.bindVertexArray(f.hand.mesh.vao);
      gl.drawElements(gl.TRIANGLES, f.hand.mesh.count, gl.UNSIGNED_INT, 0);
      gl.enable(gl.CULL_FACE);
    }
    if (post) this.postProcess(f);
    gl.bindVertexArray(null);
  }

  drawParticles(f, u) {
    const gl = this.gl, cam = f.cam;
    const buf = this.particleBuf;
    buf.reset();
    const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw), cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
    const rx = cy, rz = -sy;
    const ux = sy * sp, uy = cp, uz = cy * sp;
    for (const p of f.particles) {
      const s = p.size;
      const x = p.x - cam.x, y = p.y - cam.y, z = p.z - cam.z;
      const u0 = p.u, v0 = p.v, u1 = p.u + p.uvs, v1 = p.v + p.uvs;
      buf.ensure(4);
      const L = p.light;
      buf.v(x - rx * s - ux * s, y - uy * s, z - rz * s - uz * s, u0, v1, p.layer, L[0], L[1], p.bright, 0, p.tint[0], p.tint[1], p.tint[2]);
      buf.v(x + rx * s - ux * s, y - uy * s, z + rz * s - uz * s, u1, v1, p.layer, L[0], L[1], p.bright, 0, p.tint[0], p.tint[1], p.tint[2]);
      buf.v(x + rx * s + ux * s, y + uy * s, z + rz * s + uz * s, u1, v0, p.layer, L[0], L[1], p.bright, 0, p.tint[0], p.tint[1], p.tint[2]);
      buf.v(x - rx * s + ux * s, y + uy * s, z - rz * s + uz * s, u0, v0, p.layer, L[0], L[1], p.bright, 0, p.tint[0], p.tint[1], p.tint[2]);
    }
    const data = buf.slice();
    if (!this.particleMesh) this.particleMesh = this.upload(data, true);
    else {
      this.ensureEBO(data.quads);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.particleMesh.b1);
      gl.bufferData(gl.ARRAY_BUFFER, data.f, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.particleMesh.b2);
      gl.bufferData(gl.ARRAY_BUFFER, data.b, gl.DYNAMIC_DRAW);
    }
    gl.uniform3f(u.uOffset, 0, 0, 0);
    gl.disable(gl.CULL_FACE);
    gl.bindVertexArray(this.particleMesh.vao);
    gl.drawElements(gl.TRIANGLES, data.quads * 6, gl.UNSIGNED_INT, 0);
    gl.enable(gl.CULL_FACE);
  }
}
