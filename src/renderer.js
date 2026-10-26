// WebGL2 renderer: terrain, entities, sky, clouds, particles and the held item.
import { Mat4, Frustum, multiply, invert } from './math.js';
import { textureArrayData, LAYER_COUNT, LAYERS, layerData, cloudData, DEFAULT_GRASS } from './textures.js';
import { blockItemMesh, spriteMesh, MeshBuf } from './mesher.js';
import { BLOCKS, ITEMS, R, TEXL, TINT } from './blocks.js';

// Plant, leaf and water vertex motion shared by the colour and shadow passes.
const ANIMATE = `
vec3 animate(vec3 wp, vec3 ap, int flags, float t) {
  if ((flags & 4) != 0) {
    wp.x += sin(t * 1.7 + ap.x * 0.7 + ap.z * 0.45) * 0.06;
    wp.z += cos(t * 1.3 + ap.z * 0.6 + ap.x * 0.3) * 0.045;
  }
  if ((flags & 8) != 0) {
    wp.y += (sin(t * 1.6 + ap.x * 0.9 + ap.z * 0.6) + sin(t * 1.1 - ap.x * 0.4 + ap.z * 1.2)) * 0.022 - 0.045;
  }
  if ((flags & 16) != 0) {
    wp.x += sin(t * 1.2 + ap.y * 0.8 + ap.z * 0.6) * 0.022;
    wp.z += cos(t * 0.9 + ap.x * 0.7 + ap.y * 0.5) * 0.018;
  }
  return wp;
}`;

const BLOCK_VS = `#version 300 es
precision highp float;
${ANIMATE}
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
  if ((flags & 32) != 0) uv.y += uTime * 0.9;
  wp.xyz = animate(wp.xyz, aPos + uChunk, flags, uTime);
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
precision highp sampler2DShadow;
uniform sampler2DArray uTex;
uniform sampler2DShadow uShadowMap;
uniform float uDaylight;
uniform vec3 uFogColor;
uniform vec2 uFog;
uniform float uAlphaTest;
uniform vec4 uColorMul;
uniform float uGamma;
uniform vec3 uSunDir;
uniform float uFlicker;
uniform float uOpaque;
uniform float uShade;
uniform mat4 uLightVP;
uniform vec3 uLightDir;
uniform vec3 uSunCol;
uniform vec3 uAmbCol;
uniform vec3 uShadowInfo;
uniform vec3 uSkyTop;
uniform vec3 uSkyHorizon;
uniform vec3 uCamPos;
uniform float uTime;
uniform float uLod;
uniform highp sampler2D uLodMask;
uniform vec2 uMaskOrigin;
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
// 0 = fully shadowed, 1 = lit; fades to lit at the edge of the shadow map.
float shadowAt(vec3 p, vec3 n) {
  // uShadowInfo: x = texel size in blocks, y = texel size in uv, z = extra taps
  vec4 s = uLightVP * vec4(p + n * (uShadowInfo.x * 1.5 + 0.02), 1.0);
  float edge = max(abs(s.x), abs(s.y));
  if (edge >= 1.0 || s.z > 1.0) return 1.0;
  vec3 c = s.xyz * 0.5 + 0.5;
  float d = uShadowInfo.y;
  float sh = texture(uShadowMap, vec3(c.xy, c.z - 0.0004));
  if (uShadowInfo.z > 0.5) {
    sh += texture(uShadowMap, vec3(c.xy + vec2(-d, -d) * 1.2, c.z - 0.0006));
    sh += texture(uShadowMap, vec3(c.xy + vec2(d, -d) * 1.2, c.z - 0.0006));
    sh += texture(uShadowMap, vec3(c.xy + vec2(-d, d) * 1.2, c.z - 0.0006));
    sh += texture(uShadowMap, vec3(c.xy + vec2(d, d) * 1.2, c.z - 0.0006));
    sh *= 0.2;
  }
  return mix(sh, 1.0, smoothstep(0.82, 1.0, edge));
}
void main() {
  if (uLod > 0.5) {
    // Far terrain steps aside wherever a real chunk is loaded.
    ivec2 m = ivec2(floor((vRel.xz - uMaskOrigin) / 16.0));
    if (m.x >= 0 && m.y >= 0 && m.x < 128 && m.y < 128 && texelFetch(uLodMask, m, 0).r > 0.5) discard;
  }
  vec4 c = texture(uTex, vUV);
  if (c.a < uAlphaTest) discard;
  c.rgb *= vTint;
  float s = curve(vSky) * uDaylight;
  float b = curve(vBlk) * uFlicker;
  vec3 skyCol = mix(vec3(0.52, 0.6, 0.95), vec3(1.0), clamp(uDaylight * 1.3 - 0.2, 0.0, 1.0));
  vec3 skyLight = vec3(s) * skyCol;
  float sunVis = 0.0;
  vec3 n = vec3(0.0, 1.0, 0.0);
  if (uShade > 0.5) {
    n = normalize(cross(dFdx(vRel), dFdy(vRel)));
    float ndl = dot(n, uLightDir);
    bool plant = (vFlags & 4) != 0;
    bool leaf = (vFlags & 16) != 0;
    if (plant) ndl = 0.75;
    else if (leaf) ndl = abs(ndl) * 0.6 + 0.35;
    float gate = smoothstep(0.45, 0.9, vSky);
    if (ndl > 0.0 && gate > 0.0) sunVis = ndl * gate * shadowAt(vRel, plant ? uLightDir : n * sign(dot(n, uLightDir) + 1e-4));
    skyLight = curve(vSky) * uAmbCol + uSunCol * sunVis;
  }
  vec3 light = max(skyLight, vec3(b) * vec3(1.0, 0.86, 0.64));
  light = pow(light * 0.94 + 0.05, vec3(uGamma));
  c.rgb *= light * vBright;
  if ((vFlags & 1) != 0) {
    vec3 v = normalize(vRel);
    float fres = pow(1.0 - abs(v.y), 4.0);
    if ((vFlags & 8) != 0) {
      // Surface: reflect the sky gradient with a ripple-perturbed normal.
      vec3 w = vRel + uCamPos;
      float t = uTime;
      vec3 wn = normalize(vec3(sin(w.x * 1.7 + w.z + t * 1.3) * 0.05 + sin((w.z + w.x) * 3.1 - t * 2.1) * 0.025,
                               1.0, cos(w.z * 1.9 - w.x + t * 1.1) * 0.05 + cos((w.x - w.z) * 2.7 + t * 1.7) * 0.025));
      vec3 r = reflect(v, wn);
      vec3 sky = mix(uSkyHorizon, uSkyTop, pow(clamp(r.y, 0.0, 1.0), 0.6));
      float f2 = 0.04 + 0.96 * pow(1.0 - max(dot(-v, wn), 0.0), 5.0);
      float open = curve(vSky);
      c.rgb = mix(c.rgb, sky * open, clamp(f2 * 0.9, 0.0, 0.85));
      c.a = mix(c.a, 0.97, clamp(f2 * 1.2, 0.0, 1.0));
      if (uLightDir.y > 0.0) {
        float lit = uShade > 0.5 ? shadowAt(vRel, vec3(0.0, 1.0, 0.0)) * smoothstep(0.45, 0.9, vSky) : open;
        float spec = pow(max(dot(r, uLightDir), 0.0), 120.0) * lit;
        c.rgb += (uShade > 0.5 ? uSunCol * 2.2 : vec3(1.0, 0.95, 0.8) * 1.4) * spec;
        c.a = max(c.a, min(spec, 1.0));
      }
    } else {
      c.rgb = mix(c.rgb, uFogColor * max(s, 0.08), fres * 0.45);
      c.a = mix(c.a, 0.94, fres * 0.85);
    }
  }
  c *= uColorMul;
  float fog = smoothstep(uFog.x, uFog.y, vDist);
  c.rgb = mix(c.rgb, uFogColor, fog);
  if (uOpaque > 0.5) c.a = (clamp((vBlk - 0.8) * 5.0, 0.0, 0.7) + ((vFlags & 2) != 0 ? 0.75 : 0.0)) * (1.0 - fog);
  outColor = c;
}`;

// Depth-only pass from the sun (or moon); cutout textures keep their holes.
const SHADOW_VS = `#version 300 es
precision highp float;
${ANIMATE}
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aUV;
layout(location=2) in vec4 aLight;
uniform mat4 uLightVP;
uniform mat4 uModel;
uniform vec3 uOffset;
uniform vec3 uChunk;
uniform float uTime;
out vec3 vUV;
void main() {
  vec4 wp = uModel * vec4(aPos, 1.0);
  wp.xyz += uOffset;
  int flags = int(aLight.w * 255.0 + 0.5);
  wp.xyz = animate(wp.xyz, aPos + uChunk, flags, uTime);
  vUV = aUV;
  gl_Position = uLightVP * wp;
}`;

const SHADOW_FS = `#version 300 es
precision mediump float;
precision mediump sampler2DArray;
uniform sampler2DArray uTex;
in vec3 vUV;
out vec4 o;
void main() {
  if (texture(uTex, vUV).a < 0.5) discard;
  o = vec4(1.0);
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
uniform vec3 uSunAxis;
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
  vec3 e2 = uSunAxis;
  vec3 e1 = normalize(cross(e2, s));
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

// Light shafts: march from each pixel toward the sun, collecting open sky.
const RAYS_FS = `#version 300 es
precision highp float;
uniform sampler2D uScene;
uniform sampler2D uDepth;
uniform vec2 uSun;
uniform float uAspect;
in vec2 vUV;
out vec4 o;
void main() {
  vec2 delta = (uSun - vUV) / 40.0;
  vec2 uv = vUV + delta * fract(sin(dot(vUV, vec2(12.9898, 78.233))) * 43758.5453);
  float acc = 0.0, w = 1.0;
  for (int i = 0; i < 40; i++) {
    if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) break;
    if (texture(uDepth, uv).r > 0.99999) {
      vec4 sc = texture(uScene, uv);
      acc += (0.04 + sc.a * sc.a) * w;
    }
    w *= 0.955;
    uv += delta;
  }
  vec2 d = (vUV - uSun) * vec2(uAspect, 1.0);
  float near = exp(-dot(d, d) * 2.5);
  o = vec4(vec3(acc / 40.0 * (0.5 + near * 0.5)), 1.0);
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
uniform sampler2D uRays;
uniform vec3 uRayCol;
uniform float uHDR;
in vec2 vUV;
out vec4 o;
vec3 shoulder(vec3 c) {
  // Leaves the midtones alone and rolls highlights off smoothly instead of clipping.
  vec3 k = max(c - 0.75, 0.0);
  return min(c, 0.75) + 0.3 * (1.0 - exp(-k / 0.3));
}
void main() {
  vec2 uv = vUV;
  if (uUnder > 0.5) uv += vec2(sin(uv.y * 26.0 + uTime * 2.1), cos(uv.x * 21.0 + uTime * 1.7)) * 0.0022;
  if (uLava > 0.5) uv += vec2(sin(uv.y * 14.0 + uTime * 3.0), 0.0) * 0.004;
  vec3 c = texture(uScene, uv).rgb;
  c += texture(uBloom, uv).rgb * uBloomStr;
  c += texture(uRays, uv).rgb * uRayCol;
  if (uHDR > 0.5) c = shoulder(c * 1.04);
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
    this.shadowProg = this.program(SHADOW_VS, SHADOW_FS);
    this.rays = this.program(POST_VS, RAYS_FS);
    this.canHDR = !!gl.getExtension('EXT_color_buffer_float');
    this.post = null;
    this.shadow = null;
    this.lightVP = new Float32Array(16);
    this.dummyShadow = this.makeShadowTex(1);
    this.projFar = new Mat4();
    this.pvFar = new Mat4();
    this.frustumFar = new Frustum();
    this.maskTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 128, 128, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array(128 * 128));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
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
    if (d.isBlock && !d.iconLayer && (d.render === R.CUBE || d.render === R.CUTOUT || d.render === R.GLASS || d.render === R.SLAB || d.render === R.SHAPED)) {
      data = blockItemMesh(id, DEFAULT_GRASS);
      flat = false;
    } else {
      const layer = d.isBlock ? d.iconLayer || TEXL[id * 6] : d.layer;
      const ld = layerData[layer];
      const tint = d.isBlock && TINT[id] === 2 ? DEFAULT_GRASS : [255, 255, 255];
      data = spriteMesh(layer, (x, y) => ld[(y * 16 + x) * 4 + 3], tint);
    }
    m = { mesh: this.upload(data), flat };
    this.itemMeshes.set(id, m);
    return m;
  }

  makeTarget(w, h, depth, hdr) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (hdr) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    let depthTex = null;
    if (depth) {
      // A sampled depth texture, so the light-shaft pass can tell open sky apart.
      depthTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, depthTex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT24, w, h);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depthTex, 0);
    }
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const t = { tex, fb, depthTex, w, h };
    if (!ok) { this.freeTarget(t); return null; }
    return t;
  }

  freeTarget(t) {
    if (!t) return;
    const gl = this.gl;
    gl.deleteTexture(t.tex);
    gl.deleteFramebuffer(t.fb);
    if (t.depthTex) gl.deleteTexture(t.depthTex);
  }

  makeShadowTex(size) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT24, size, size);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
    return tex;
  }

  // Shadow map sized for the quality level; returns null when shadows are off or unsupported.
  ensureShadow(size) {
    const gl = this.gl;
    if (!size || this.shadowFailed) {
      if (this.shadow) { gl.deleteTexture(this.shadow.tex); gl.deleteFramebuffer(this.shadow.fb); this.shadow = null; }
      return null;
    }
    if (this.shadow && this.shadow.size === size) return this.shadow;
    if (this.shadow) { gl.deleteTexture(this.shadow.tex); gl.deleteFramebuffer(this.shadow.fb); }
    const tex = this.makeShadowTex(size);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, tex, 0);
    gl.drawBuffers([gl.NONE]);
    gl.readBuffer(gl.NONE);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (!ok) { gl.deleteTexture(tex); gl.deleteFramebuffer(fb); this.shadowFailed = true; this.shadow = null; return null; }
    this.shadow = { tex, fb, size };
    return this.shadow;
  }

  // Orthographic light view centred on the camera, snapped to whole texels so
  // shadow edges stay put while walking. Works in camera-relative space.
  lightMatrix(cam, L, radius, size) {
    const m = this.lightVP;
    // Basis perpendicular to the light: X = L x (0,0,1), Y = X x L.
    let xx = L[1], xy = -L[0], xz = 0;
    const len = Math.hypot(xx, xy, xz) || 1;
    xx /= len; xy /= len; xz /= len;
    const yx = xy * L[2] - xz * L[1], yy = xz * L[0] - xx * L[2], yz = xx * L[1] - xy * L[0];
    const texel = (radius * 2) / size;
    const px = cam.x * xx + cam.y * xy + cam.z * xz, py = cam.x * yx + cam.y * yy + cam.z * yz;
    const ox = px - Math.round(px / texel) * texel, oy = py - Math.round(py / texel) * texel;
    const D = 200;
    m[0] = xx / radius; m[4] = xy / radius; m[8] = xz / radius; m[12] = ox / radius;
    m[1] = yx / radius; m[5] = yy / radius; m[9] = yz / radius; m[13] = oy / radius;
    m[2] = -L[0] / D; m[6] = -L[1] / D; m[10] = -L[2] / D; m[14] = 0;
    m[3] = 0; m[7] = 0; m[11] = 0; m[15] = 1;
    this.lightBasis = [xx, xy, xz, yx, yy, yz];
    return texel;
  }

  renderShadow(f, S, radius) {
    const gl = this.gl, cam = f.cam, L = f.light.shadowDir;
    const texel = this.lightMatrix(cam, L, radius, S.size);
    gl.bindFramebuffer(gl.FRAMEBUFFER, S.fb);
    gl.viewport(0, 0, S.size, S.size);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.FRONT);
    const sp = this.shadowProg, u = sp.u;
    gl.useProgram(sp.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.tex);
    gl.uniform1i(u.uTex, 0);
    gl.uniformMatrix4fv(u.uLightVP, false, this.lightVP);
    gl.uniformMatrix4fv(u.uModel, false, this.ident.m);
    gl.uniform1f(u.uTime, f.time);
    const [xx, xy, xz, yx, yy, yz] = this.lightBasis;
    const reach = radius + 15;
    let n = 0;
    for (const c of f.chunks) {
      const m = c.mesh;
      if (!m || !m.o) continue;
      const cx = c.cx * 16 + 8 - cam.x, cz = c.cz * 16 + 8 - cam.z, cy = (m.minY + m.maxY) * 0.5 - cam.y;
      const hy = (m.maxY - m.minY) * 0.5;
      const lx = cx * xx + cy * xy + cz * xz, ly = cx * yx + cy * yy + cz * yz;
      const ext = 11.4 + hy;
      if (Math.abs(lx) > reach + ext - 15 || Math.abs(ly) > reach + ext - 15) continue;
      gl.uniform3f(u.uOffset, c.cx * 16 - cam.x, -cam.y, c.cz * 16 - cam.z);
      gl.uniform3f(u.uChunk, c.cx * 16, 0, c.cz * 16);
      gl.bindVertexArray(m.o.vao);
      gl.drawElements(gl.TRIANGLES, m.o.count, gl.UNSIGNED_INT, 0);
      n++;
    }
    gl.uniform3f(u.uChunk, 0, 0, 0);
    gl.uniform3f(u.uOffset, 0, 0, 0);
    gl.disable(gl.CULL_FACE);
    for (const e of f.entities) {
      if (!e.mesh || e.noShadow) continue;
      gl.uniformMatrix4fv(u.uModel, false, e.model);
      gl.bindVertexArray(e.mesh.vao);
      gl.drawElements(gl.TRIANGLES, e.mesh.count, gl.UNSIGNED_INT, 0);
    }
    gl.cullFace(gl.BACK);
    gl.enable(gl.CULL_FACE);
    this.stats.shadowChunks = n;
    return texel;
  }

  // (Re)creates the scene, bloom and light-shaft render targets to match the canvas.
  ensurePost(enabled, hdr) {
    const c = this.canvas;
    hdr = !!hdr && this.canHDR;
    const all = (P) => [P.scene, P.a, P.b, P.r];
    if (!enabled || this.postFailed) {
      if (this.post) { all(this.post).forEach((t) => this.freeTarget(t)); this.post = null; }
      return null;
    }
    if (this.post && this.post.scene.w === c.width && this.post.scene.h === c.height && this.post.hdr === hdr) return this.post;
    if (this.post) all(this.post).forEach((t) => this.freeTarget(t));
    const qw = Math.max(1, c.width >> 2), qh = Math.max(1, c.height >> 2);
    let scene = this.makeTarget(c.width, c.height, true, hdr);
    if (!scene && hdr) { hdr = false; this.canHDR = false; scene = this.makeTarget(c.width, c.height, true, false); }
    const a = this.makeTarget(qw, qh, false, hdr), b = this.makeTarget(qw, qh, false, hdr);
    const r = this.makeTarget(Math.max(1, c.width >> 1), Math.max(1, c.height >> 1));
    if (!scene || !a || !b || !r) { [scene, a, b, r].forEach((t) => this.freeTarget(t)); this.postFailed = true; this.post = null; return null; }
    this.post = { scene, a, b, r, hdr };
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
    const rays = f.rays && this.sunScreen(f.rays.dir);
    if (rays) {
      pass(this.rays, P.r, (u) => {
        gl.bindTexture(gl.TEXTURE_2D, P.scene.tex);
        gl.uniform1i(u.uScene, 0);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, P.scene.depthTex);
        gl.uniform1i(u.uDepth, 1);
        gl.activeTexture(gl.TEXTURE0);
        gl.uniform2f(u.uSun, rays[0], rays[1]);
        gl.uniform1f(u.uAspect, P.scene.w / P.scene.h);
      });
    }
    pass(this.composite, null, (u) => {
      gl.bindTexture(gl.TEXTURE_2D, P.scene.tex);
      gl.uniform1i(u.uScene, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, P.a.tex);
      gl.uniform1i(u.uBloom, 1);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, P.r.tex);
      gl.uniform1i(u.uRays, 2);
      const k = rays ? rays[2] * f.rays.strength : 0;
      const rc = f.rays ? f.rays.color : [0, 0, 0];
      gl.uniform3f(u.uRayCol, rc[0] * k, rc[1] * k, rc[2] * k);
      gl.uniform1f(u.uHDR, P.hdr ? 1 : 0);
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

  // Screen position of a direction (uv) and a 0..1 fade for how on-screen it is.
  sunScreen(d) {
    const m = this.pv.m;
    const x = m[0] * d[0] + m[4] * d[1] + m[8] * d[2], y = m[1] * d[0] + m[5] * d[1] + m[9] * d[2], w = m[3] * d[0] + m[7] * d[1] + m[11] * d[2];
    if (w <= 0.05) return null;
    const sx = x / w * 0.5 + 0.5, sy = y / w * 0.5 + 0.5;
    const out = Math.max(0, Math.abs(sx - 0.5) - 0.5, Math.abs(sy - 0.5) - 0.5);
    const fade = Math.max(0, 1 - out * 1.6) * Math.min(1, w * 2);
    return fade > 0.01 ? [sx, sy, fade] : null;
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

  // Projection for the far terrain, which gets its own slice of the depth buffer.
  setupFarCamera(cam, far) {
    const aspect = this.canvas.width / this.canvas.height;
    this.projFar.perspective((cam.fov * Math.PI) / 180, aspect, 4, far);
    multiply(this.pvFar.m, this.projFar.m, this.view.m);
    this.frustumFar.setFromMatrix(this.pvFar.m);
  }

  // f: frame description assembled by the game each frame.
  render(f) {
    const gl = this.gl;
    const cam = f.cam;
    const shade = f.light ? f.shade | 0 : 0;
    const S = this.ensureShadow(shade ? (shade > 1 ? 2048 : 1024) : 0);
    const radius = shade > 1 ? 80 : 44;
    const lit = S && f.light.strength > 0.001;
    let texel = 0;
    if (lit) texel = this.renderShadow(f, S, radius);
    const post = this.ensurePost(f.post, shade > 0);
    gl.depthRange(0, 1);
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
    gl.uniform3fv(su.uSunAxis, f.sky.axis || [0, 0, 1]);
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
    gl.uniform3f(u.uCamPos, cam.x % 4096, cam.y, cam.z % 4096);
    gl.uniform3fv(u.uSkyTop, f.sky.top);
    gl.uniform3fv(u.uSkyHorizon, f.sky.horizon);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, lit ? S.tex : this.dummyShadow);
    gl.uniform1i(u.uShadowMap, 2);
    gl.activeTexture(gl.TEXTURE0);
    if (shade && f.light) {
      const Lt = f.light;
      gl.uniform1f(u.uShade, 1);
      gl.uniformMatrix4fv(u.uLightVP, false, this.lightVP);
      gl.uniform3fv(u.uLightDir, Lt.dir);
      gl.uniform3fv(u.uSunCol, Lt.sun);
      gl.uniform3fv(u.uAmbCol, Lt.amb);
      // Without a fresh shadow map, park every lookup outside the map (fully lit).
      if (!lit) this.lightVP.fill(0), this.lightVP[12] = 2, this.lightVP[15] = 1, gl.uniformMatrix4fv(u.uLightVP, false, this.lightVP);
      gl.uniform3f(u.uShadowInfo, texel || 0.1, S ? 1 / S.size : 0, shade > 1 ? 1 : 0);
    } else {
      gl.uniform1f(u.uShade, 0);
      gl.uniform3fv(u.uLightDir, f.sky.sunDir);
    }
    gl.enable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    gl.uniform1f(u.uLod, 0);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
    gl.uniform1i(u.uLodMask, 3);
    gl.activeTexture(gl.TEXTURE0);
    let cloudsDone = false;
    if (f.lod) {
      cloudsDone = this.drawLod(f, u) && f.clouds && cam.y < 118;
      if (cloudsDone) this.drawClouds(f, this.pvFar, f.cloudFar);
    }
    // Everything near goes in front of the far terrain.
    gl.depthRange(0, 0.5);
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
    if (f.clouds && !cloudsDone) this.drawClouds(f, this.pv, f.far);

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
      const b = s.b || [0, 0, 0, 1, 1, 1];
      this.tmp.identity().translate(s.x + b[0] - 0.002 - cam.x, s.y + b[1] - 0.002 - cam.y, s.z + b[2] - 0.002 - cam.z).scale(b[3] - b[0] + 0.004, b[4] - b[1] + 0.004, b[5] - b[2] + 0.004);
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
      // The held item gets the very front of the depth range instead of a depth clear,
      // so the depth buffer still tells sky from terrain for the light shafts.
      gl.depthRange(0, 0.02);
      gl.uniformMatrix4fv(u.uProjView, false, this.handProj.m);
      gl.uniformMatrix4fv(u.uModel, false, f.hand.model);
      gl.uniform3f(u.uOffset, 0, 0, 0);
      gl.uniform2f(u.uEntLight, f.hand.light[0], f.hand.light[1]);
      gl.uniform2f(u.uFog, 1e5, 1e5 + 1);
      gl.uniform1f(u.uAlphaTest, 0.5);
      gl.uniform1f(u.uShade, 0);
      if (f.hand.noCull) gl.disable(gl.CULL_FACE);
      gl.uniform1f(u.uOpaque, 1);
      gl.bindVertexArray(f.hand.mesh.vao);
      gl.drawElements(gl.TRIANGLES, f.hand.mesh.count, gl.UNSIGNED_INT, 0);
      gl.enable(gl.CULL_FACE);
    }
    gl.depthRange(0, 1);
    if (post) this.postProcess(f);
    gl.bindVertexArray(null);
  }

  drawClouds(f, pv, far) {
    const gl = this.gl, cam = f.cam, bp = this.block;
    gl.useProgram(this.cloud.p);
    const cu = this.cloud.u;
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
    gl.disable(gl.CULL_FACE);
    gl.depthMask(false);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.cloudTex);
    gl.uniform1i(cu.uCloud, 1);
    gl.uniformMatrix4fv(cu.uProjView, false, pv.m);
    gl.uniform3f(cu.uCam, cam.x, cam.y, cam.z);
    gl.uniform1f(cu.uY, 124);
    gl.uniform1f(cu.uSize, far);
    gl.uniform2f(cu.uOffset, f.clouds.offset, 0);
    gl.uniform3fv(cu.uColor, f.clouds.color);
    gl.uniform1f(cu.uFar, far);
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
    gl.disable(gl.BLEND);
    gl.enable(gl.CULL_FACE);
  }

  // Far terrain tiles (opaque, then water) in the back half of the depth range.
  drawLod(f, u) {
    const gl = this.gl, cam = f.cam, L = f.lod;
    this.setupFarCamera(cam, L.far);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 128, 128, gl.RED, gl.UNSIGNED_BYTE, L.mask.data);
    gl.activeTexture(gl.TEXTURE0);
    gl.depthRange(0.5, 1);
    gl.uniformMatrix4fv(u.uProjView, false, this.pvFar.m);
    gl.uniform1f(u.uLod, 1);
    gl.uniform2f(u.uMaskOrigin, L.mask.x, L.mask.z);
    const vis = [];
    let quads = 0;
    for (const t of L.tiles) {
      const m = t.mesh;
      const x0 = t.x0 - cam.x, z0 = t.z0 - cam.z, S = t.step * 32;
      if (!this.frustumFar.boxVisible(x0, m.minY - cam.y, z0, x0 + S, m.maxY - cam.y, z0 + S)) continue;
      vis.push(t);
      if (!m.o) continue;
      gl.uniform3f(u.uOffset, x0, -cam.y, z0);
      gl.uniform3f(u.uChunk, t.x0, 0, t.z0);
      gl.bindVertexArray(m.o.vao);
      gl.drawElements(gl.TRIANGLES, m.o.count, gl.UNSIGNED_INT, 0);
      quads += m.o.quads;
    }
    this.stats.lodTiles = vis.length;
    this.stats.lodQuads = quads;
    // Far water, blended.
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
    gl.depthMask(false);
    gl.uniform1f(u.uOpaque, 0);
    gl.uniform1f(u.uAlphaTest, 0.01);
    for (const t of vis) {
      const m = t.mesh;
      if (!m.w) continue;
      gl.uniform3f(u.uOffset, t.x0 - cam.x, -cam.y, t.z0 - cam.z);
      gl.uniform3f(u.uChunk, t.x0, 0, t.z0);
      gl.bindVertexArray(m.w.vao);
      gl.drawElements(gl.TRIANGLES, m.w.count, gl.UNSIGNED_INT, 0);
    }
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.uniform1f(u.uOpaque, 1);
    gl.uniform1f(u.uAlphaTest, 0.5);
    gl.uniform1f(u.uLod, 0);
    gl.uniformMatrix4fv(u.uProjView, false, this.pv.m);
    gl.uniform3f(u.uChunk, 0, 0, 0);
    return true;
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
