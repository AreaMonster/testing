// Minimal column-major 4x4 matrix helpers for WebGL.

export function multiply(out, a, b) {
  const t = TMP;
  for (let r = 0; r < 4; r++) {
    const a0 = a[r], a1 = a[4 + r], a2 = a[8 + r], a3 = a[12 + r];
    t[r] = a0 * b[0] + a1 * b[1] + a2 * b[2] + a3 * b[3];
    t[4 + r] = a0 * b[4] + a1 * b[5] + a2 * b[6] + a3 * b[7];
    t[8 + r] = a0 * b[8] + a1 * b[9] + a2 * b[10] + a3 * b[11];
    t[12 + r] = a0 * b[12] + a1 * b[13] + a2 * b[14] + a3 * b[15];
  }
  out.set(t);
  return out;
}
const TMP = new Float32Array(16);

export function invert(out, a) {
  const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
  const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
  const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
  const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return null;
  det = 1 / det;
  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
  return out;
}

export class Mat4 {
  constructor() {
    this.m = new Float32Array(16);
    this.identity();
  }
  identity() {
    const m = this.m;
    m.fill(0);
    m[0] = m[5] = m[10] = m[15] = 1;
    return this;
  }
  copy(o) {
    this.m.set(o.m);
    return this;
  }
  perspective(fovy, aspect, near, far) {
    const m = this.m, f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
    m.fill(0);
    m[0] = f / aspect;
    m[5] = f;
    m[10] = (far + near) * nf;
    m[11] = -1;
    m[14] = 2 * far * near * nf;
    return this;
  }
  mul(o) {
    multiply(this.m, this.m, o.m || o);
    return this;
  }
  translate(x, y, z) {
    const m = this.m;
    for (let r = 0; r < 4; r++) m[12 + r] += m[r] * x + m[4 + r] * y + m[8 + r] * z;
    return this;
  }
  scale(x, y = x, z = x) {
    const m = this.m;
    for (let r = 0; r < 4; r++) {
      m[r] *= x;
      m[4 + r] *= y;
      m[8 + r] *= z;
    }
    return this;
  }
  rotateX(a) {
    const m = this.m, c = Math.cos(a), s = Math.sin(a);
    for (let r = 0; r < 4; r++) {
      const m1 = m[4 + r], m2 = m[8 + r];
      m[4 + r] = c * m1 + s * m2;
      m[8 + r] = -s * m1 + c * m2;
    }
    return this;
  }
  rotateY(a) {
    const m = this.m, c = Math.cos(a), s = Math.sin(a);
    for (let r = 0; r < 4; r++) {
      const m0 = m[r], m2 = m[8 + r];
      m[r] = c * m0 - s * m2;
      m[8 + r] = s * m0 + c * m2;
    }
    return this;
  }
  rotateZ(a) {
    const m = this.m, c = Math.cos(a), s = Math.sin(a);
    for (let r = 0; r < 4; r++) {
      const m0 = m[r], m1 = m[4 + r];
      m[r] = c * m0 + s * m1;
      m[4 + r] = -s * m0 + c * m1;
    }
    return this;
  }
}

export class Frustum {
  constructor() {
    this.p = new Float32Array(24);
  }
  setFromMatrix(m) {
    const p = this.p;
    const rows = (i) => [m[i], m[4 + i], m[8 + i], m[12 + i]];
    const r0 = rows(0), r1 = rows(1), r2 = rows(2), r3 = rows(3);
    const planes = [
      [r3[0] + r0[0], r3[1] + r0[1], r3[2] + r0[2], r3[3] + r0[3]],
      [r3[0] - r0[0], r3[1] - r0[1], r3[2] - r0[2], r3[3] - r0[3]],
      [r3[0] + r1[0], r3[1] + r1[1], r3[2] + r1[2], r3[3] + r1[3]],
      [r3[0] - r1[0], r3[1] - r1[1], r3[2] - r1[2], r3[3] - r1[3]],
      [r3[0] + r2[0], r3[1] + r2[1], r3[2] + r2[2], r3[3] + r2[3]],
      [r3[0] - r2[0], r3[1] - r2[1], r3[2] - r2[2], r3[3] - r2[3]],
    ];
    planes.forEach((pl, i) => {
      const l = Math.hypot(pl[0], pl[1], pl[2]) || 1;
      p[i * 4] = pl[0] / l;
      p[i * 4 + 1] = pl[1] / l;
      p[i * 4 + 2] = pl[2] / l;
      p[i * 4 + 3] = pl[3] / l;
    });
  }
  boxVisible(x0, y0, z0, x1, y1, z1) {
    const p = this.p;
    for (let i = 0; i < 24; i += 4) {
      const a = p[i], b = p[i + 1], c = p[i + 2], d = p[i + 3];
      if (a * (a > 0 ? x1 : x0) + b * (b > 0 ? y1 : y0) + c * (c > 0 ? z1 : z0) + d < 0) return false;
    }
    return true;
  }
}

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smooth = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
