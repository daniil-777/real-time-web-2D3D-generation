// Morph 3D per-pixel detail: while an object rests, every hit pixel takes its surface point, normal and colour from the
// decoder itself -- its planes (a hardware-bilinear RGBA16F texture array) and MLP (uniform blocks) inside the tracing
// shader -- instead of from the R^3 grid, so the image shows every feature the planes hold (256^2 for the architecture
// model) at screen resolution. The grid still does the tracing, shadows and occlusion. v1 decoders. Extends M.Renderer.
(function (M) {
  'use strict';
  const RP = M.Renderer.prototype;
  const BIND = 16;                         // uniform-buffer binding points 16+ (the grid shaders use 0..3)

  // the v1 decoder at a point, in GLSL: h = relu(sum of the 3 plane features + b1) -> relu(W2 h + b2) -> W3 -> (sdf, rgb)
  const FIELD = (H, blocks) => {
    const H4 = H / 4;
    const decl = blocks.map(([a, b], i) => `layout(std140) uniform NW2_${i} { vec4 nw2_${i}[${(b - a) * H4}]; };`).join('\n  ');
    const loops = blocks.map(([a, b], i) => `
      for (int c = ${a / 4}; c < ${b / 4}; c++) {
        vec4 v = h[c]; int r = (4 * c - ${a}) * ${H4} + m;
        s += v.x * nw2_${i}[r] + v.y * nw2_${i}[r + ${H4}] + v.z * nw2_${i}[r + ${2 * H4}] + v.w * nw2_${i}[r + ${3 * H4}];
      }`).join('');
    return `
  uniform int uNeural; uniform highp sampler2DArray uNP; uniform float uNR, uNE;      // planes, their size, normal step
  ${decl}
  layout(std140) uniform NWsmall { vec4 nb1[${H4}]; vec4 nb2[${H4}]; vec4 nw3[${H}]; vec4 nb3; };
  float ntc(float c) { return ((c * 0.5 + 0.5) * (uNR - 1.0) + 0.5) / uNR; }           // align_corners texel centres
  vec4 field(vec3 p) {                     // -> (sdf in world units, rgb); plane texel (col, row) = (w, h) axes
    vec3 q = vec3(ntc(p.x), ntc(p.y), ntc(p.z));
    vec4 h[${H4}];
    for (int c = 0; c < ${H4}; c++)
      h[c] = max(texture(uNP, vec3(q.y, q.x, float(c))) + texture(uNP, vec3(q.z, q.x, float(${H4} + c)))
               + texture(uNP, vec3(q.z, q.y, float(${2 * H4} + c))) + nb1[c], 0.0);
    vec4 acc = nb3;
    for (int m = 0; m < ${H4}; m++) {
      vec4 s = nb2[m];${loops}
      s = max(s, 0.0);
      acc += s.x * nw3[4 * m] + s.y * nw3[4 * m + 1] + s.z * nw3[4 * m + 2] + s.w * nw3[4 * m + 3];
    }
    return acc;
  }`;
  };
  // at a hit: one (clamped) Newton step onto the decoder's own zero level, its normal (tetrahedral differences over one plane
  // texel -- finer steps pick up the triplane staircase, not detail) and its colour at full plane resolution
  const HIT = `
      if (uNeural == 1) {
        vec4 f0 = field(p);
        p -= n * clamp(f0.x, -uNE, uNE);                // at most one texel: never across a thin sheet
        vec2 k = vec2(1.0, -1.0) * uNE;
        vec3 g = k.xyy * field(p + k.xyy).x + k.yyx * field(p + k.yyx).x + k.yxy * field(p + k.yxy).x + k.xxx * field(p + k.xxx).x;
        if (dot(g, g) > 1e-14) n = normalize(g);
        alb = pow(clamp(f0.yzw, 0.0, 1.0), vec3(2.2));
      }`;

  RP.neuralInit = function (model) {       // -> true when the per-pixel shader is ready (v1 decoders only)
    const gl = this.gl, meta = model.meta, H = meta.hid;
    if (meta.arch === 'v2' || H % 4 || gl.getParameter(gl.MAX_UNIFORM_BUFFER_BINDINGS) < BIND + 8) return false;
    const H4 = H / 4, rows = Math.floor(1024 / H4 / 4) * 4, blocks = [];
    for (let r0 = 0; r0 < H; r0 += rows) blocks.push([r0, Math.min(H, r0 + rows)]);
    try {
      this.marchN = M.glProg(gl, M.marchSource({ decl: FIELD(H, blocks), hit: HIT }));
    } catch (e) {
      console.warn('per-pixel detail unavailable:', e.message); return false;
    }
    const d = (k) => (model.F && model.F[k]) || model.W[k].dataSync();
    const w2 = d('l2.w'), w3 = d('l3.w'), small = new Float32Array((2 * H4 + H + 1) * 4);
    small.set(d('b1'), 0); small.set(d('l2.b'), H4 * 4);
    for (let m = 0; m < H; m++) small.set(w3.subarray(m * 4, m * 4 + 4), (2 * H4 + m) * 4);
    small.set(d('l3.b'), (2 * H4 + H) * 4);
    const data = blocks.map(([a, b]) => w2.slice(a * H, b * H)).concat([small]);
    const names = blocks.map((_, i) => `NW2_${i}`).concat(['NWsmall']);
    this.nubos = data.map((arr, i) => {
      const idx = gl.getUniformBlockIndex(this.marchN.p, names[i]);
      if (idx === gl.INVALID_INDEX) throw new Error('uniform block ' + names[i] + ' missing');
      gl.uniformBlockBinding(this.marchN.p, idx, BIND + i);
      const b = gl.createBuffer(); gl.bindBuffer(gl.UNIFORM_BUFFER, b); gl.bufferData(gl.UNIFORM_BUFFER, arr, gl.STATIC_DRAW);
      return b;
    });
    this.nH4 = H4; this.nkey = null;
    return true;
  };

  // P: the resting object's planes (tf tensor [3, Rp, Rp, H]) -> the planes texture; key tags the volume it belongs to
  RP.neuralPlanes = async function (P, key) {
    const gl = this.gl, Rp = P.shape[1], H4 = P.shape[3] / 4;
    const t = tf.tidy(() => tf.transpose(tf.reshape(P, [3, Rp, Rp, H4, 4]), [0, 3, 1, 2, 4]));
    const data = await t.data(); t.dispose();
    if (!this.ntex || this.ntexR !== Rp) {
      if (this.ntex) gl.deleteTexture(this.ntex);
      this.ntex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.ntex);
      gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA16F, Rp, Rp, 3 * H4);
      for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D_ARRAY, p, gl.LINEAR);
      for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D_ARRAY, p, gl.CLAMP_TO_EDGE);
      this.ntexR = Rp;
    }
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.ntex); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, 0, Rp, Rp, 3 * H4, gl.RGBA, gl.FLOAT, data);
    this.nkey = key;
  };

  // draw(): the per-pixel program when the picture is exactly one volume (blend at 0 or 1, or a hold) whose planes are
  // in the texture -- anywhere in between the field is a blend of two decoders and the grid shading stays
  RP.pickMarch = function (a, b, t) {
    if (!this.marchN || !this.neuralOn || this.nkey == null) return null;
    const v = a === b || t < 1e-4 ? a : t > 1 - 1e-4 ? b : null;
    return v && v.nkey === this.nkey ? this.marchN : null;
  };

  RP.bindNeural = function (m) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.ntex); gl.uniform1i(m.u.uNP, 4);
    gl.uniform1i(m.u.uNeural, 1); gl.uniform1f(m.u.uNR, this.ntexR); gl.uniform1f(m.u.uNE, 2 / (this.ntexR - 1));
    this.nubos.forEach((b, i) => gl.bindBufferBase(gl.UNIFORM_BUFFER, BIND + i, b));
  };
})(window.M3D = window.M3D || {});
