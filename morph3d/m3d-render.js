// Morph 3D renderer: WebGL2 sphere tracing of two decoded keyframes (3D textures), blended per frame, into a
// low-resolution buffer; a second pass upsamples it ('lit') or turns it into coloured halftone dots ('dots').
(function (M) {
  'use strict';
  // delta(R) measured for the v1 decoder (research/postproc/page_patch/NOTES.md); other exports bring meta.post
  const V1_LEVELS = [[64, -0.004], [96, -0.0015], [128, -0.0015]];
  const VS = `#version 300 es
  out vec2 vP; void main() { vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2); vP = p * 2.0 - 1.0; gl_Position = vec4(vP, 0, 1); }`;

  const MARCH = `#version 300 es
  precision highp float; precision highp sampler3D;
  uniform sampler3D uS0, uS1, uC0, uC1;
  uniform vec4 uGrid;          // R0, R1, colour-grid sizes Rc0, Rc1
  uniform float uT, uFloor, uAspect, uTanF, uIso;
  uniform vec3 uEye; uniform mat3 uRot; uniform vec3 uKey; uniform vec3 uPaper;
  in vec2 vP; out vec4 oC;
  vec3 tc(vec3 p, float R) { return (((p * 0.5 + 0.5) * (R - 1.0)) + 0.5) / R; }
  vec3 tcc(vec3 p, float R, float Rc) { return (((p * 0.5 + 0.5) * (R - 1.0) * 0.5) + 0.5) / Rc; }
  // uIso: a coarse grid can straddle a thin sheet (the EPS shell) with no negative sample; tracing that much further
  // out keeps sheets closed (a sub-pixel dilation, zero at >= 1/EPS + 1 samples per axis)
  float S(vec3 p) { return mix(texture(uS0, tc(p, uGrid.x).zyx).r, texture(uS1, tc(p, uGrid.y).zyx).r, uT) - uIso; }
  vec3 C(vec3 p) { return mix(texture(uC0, tcc(p, uGrid.x, uGrid.z).zyx).rgb, texture(uC1, tcc(p, uGrid.y, uGrid.w).zyx).rgb, uT); }
  vec2 box(vec3 ro, vec3 rd, float b) {
    vec3 m = 1.0 / rd, n = m * ro, k = abs(m) * b, t1 = -n - k, t2 = -n + k;
    return vec2(max(max(t1.x, t1.y), t1.z), min(min(t2.x, t2.y), t2.z));
  }
  vec3 nrm(vec3 p) {
    float e = 1.0 / max(uGrid.x, uGrid.y);
    vec2 h = vec2(e, 0);
    return normalize(vec3(S(p + h.xyy) - S(p - h.xyy), S(p + h.yxy) - S(p - h.yxy), S(p + h.yyx) - S(p - h.yyx)));
  }
  float shadow(vec3 ro, vec3 rd) {                                  // soft shadow, marched only where the volume is
    vec2 hb = box(ro, rd, 0.999);
    if (hb.x > hb.y || hb.y < 0.0) return 1.0;
    float r = 1.0, t = max(hb.x, 0.03);
    for (int i = 0; i < 32; i++) {
      float h = S(ro + rd * t); t += clamp(h, 0.012, 0.12);
      if (h < 0.07) r = min(r, 9.0 * h / t);                        // the field is truncated at 0.1: far = unoccluded
      if (r < 0.02 || t > hb.y) break;
    }
    return clamp(r, 0.0, 1.0);
  }
  float occl(vec3 p, vec3 n) {
    float o = 0.0, w = 1.0;
    for (int i = 1; i <= 5; i++) { float h = 0.015 * float(i * i); o += (h - S(p + n * h)) * w; w *= 0.65; }
    return clamp(1.0 - 2.2 * o, 0.0, 1.0);
  }
  vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
  void main() {
    vec3 rd = normalize(uRot * vec3(vP.x * uAspect * uTanF, vP.y * uTanF, -1.0)), ro = uEye;
    vec3 L = normalize(uKey), col = uPaper;
    float cov = 0.0;
    vec2 hb = box(ro, rd, 0.999);
    bool hit = false; float t = 0.0;
    if (hb.x < hb.y && hb.y > 0.0) {
      t = max(hb.x, 0.0); float tp = t;
      for (int i = 0; i < 200; i++) {
        float d = S(ro + rd * t);
        if (d < 0.0) { float a = tp, b = t; for (int j = 0; j < 6; j++) { float m = 0.5 * (a + b); if (S(ro + rd * m) < 0.0) b = m; else a = m; } t = b; hit = true; break; }
        if (d < 4e-4) { hit = true; break; }
        tp = t; t += max(d * 0.9, 0.003);
        if (t > hb.y) break;
      }
    }
    if (hit) {
      vec3 p = ro + rd * t, n = nrm(p), alb = pow(clamp(C(p), 0.0, 1.0), vec3(2.2));
      float dif = max(dot(n, L), 0.0), sh = dif > 0.0 ? shadow(p + n * 0.01, L) : 0.0, ao = occl(p, n);
      float sky = 0.5 + 0.5 * n.y, fre = pow(1.0 - max(dot(n, -rd), 0.0), 4.0);
      vec3 h = normalize(L - rd);
      vec3 lin = alb * (vec3(0.42, 0.44, 0.48) * sky * ao + vec3(0.10, 0.09, 0.08) * (1.0 - sky) * ao + 1.25 * dif * sh * vec3(1.0, 0.96, 0.9))
               + 0.18 * pow(max(dot(n, h), 0.0), 40.0) * sh + 0.10 * fre * ao;
      col = pow(aces(lin * 1.1), vec3(1.0 / 2.2)); cov = 1.0;
    } else if (rd.y < 0.0) {                                           // floor: soft shadow + contact darkening
      float tf = (uFloor - ro.y) / rd.y; vec3 p = ro + rd * tf;
      float r = length(p.xz);
      if (tf > 0.0 && r < 2.2) {
        vec3 q = vec3(p.x, uFloor + 0.004, p.z);
        float s = shadow(q, L);
        float c = all(lessThan(abs(q.xz), vec2(0.99))) ? smoothstep(0.0, 0.03, S(q + vec3(0, 0.02, 0))) : 1.0;
        float f = mix(1.0, 0.72 + 0.28 * s, smoothstep(2.2, 0.8, r)) * mix(0.8 + 0.2 * c, 1.0, smoothstep(0.5, 1.4, r));
        col = uPaper * f; cov = 1.0 - f;
      }
    }
    oC = vec4(col, cov);
  }`;

  const POST = `#version 300 es
  precision highp float;
  uniform sampler2D uImg; uniform vec2 uOut, uIn; uniform int uMode; uniform float uCell; uniform vec3 uPaper;
  in vec2 vP; out vec4 oC;
  void main() {
    vec2 px = (vP * 0.5 + 0.5) * uOut;
    if (uMode == 0) { oC = vec4(texture(uImg, px / uOut).rgb, 1.0); return; }
    vec2 cell = floor(px / uCell), ctr = (cell + 0.5) * uCell;                 // one low-res texel per dot cell
    vec4 s = texture(uImg, (cell + 0.5) / uIn);
    float lum = dot(s.rgb, vec3(0.299, 0.587, 0.114)), dark = clamp(1.0 - lum / max(dot(uPaper, vec3(0.299, 0.587, 0.114)), 1e-3), 0.0, 1.0);
    dark = max(dark - 0.015, 0.0) / 0.985;                             // 8-bit rounding of the paper must not print dots
    float rad = uCell * 0.5 * 1.15 * sqrt(dark), d = length(px - ctr);
    float a = clamp(rad - d + 0.5, 0.0, 1.0) * clamp(2.0 * rad, 0.0, 1.0);   // zero radius = no dot, not half a pixel
    vec3 ink = uMode == 1 ? clamp(s.rgb * 0.75, 0.0, 1.0) : vec3(0.08);
    oC = vec4(mix(uPaper, ink, a), 1.0);
  }`;

  // WebGL grid path: the decoder MLP per voxel, written straight into the 3D textures (no grid readback). Planes arrive
  // as a texture array: layer p*H4 + c holds channels 4c..4c+3 of plane p (xy, xz, yz), texel (col, row) = (w, h) axes.
  // Weights live in uniform blocks (broadcast from the constant cache; texelFetch per weight was 5x slower). W2 rows are
  // split into blocks of <= 1024 vec4 (the 16 KB every WebGL2 device supports); b1, b2, W3, b3 share one small block.
  const GRID = (H) => {
    const H4 = H / 4, rows = Math.floor(1024 / H4 / 4) * 4, blocks = [];
    for (let r0 = 0; r0 < H; r0 += rows) blocks.push([r0, Math.min(H, r0 + rows)]);
    const decl = blocks.map(([a, b], i) => `layout(std140) uniform W2_${i} { vec4 w2_${i}[${(b - a) * H4}]; };`).join('\n  ');
    const loops = blocks.map(([a, b], i) => `
      for (int c = ${a / 4}; c < ${b / 4}; c++) {
        vec4 v = h[c]; int r = (4 * c - ${a}) * H4 + m;
        s += v.x * w2_${i}[r] + v.y * w2_${i}[r + H4] + v.z * w2_${i}[r + 2 * H4] + v.w * w2_${i}[r + 3 * H4];
      }`).join('');
    return { blocks, src: `#version 300 es
  precision highp float; precision highp int; precision highp sampler2DArray;
  #define H ${H}
  #define H4 ${H4}
  uniform sampler2DArray uP; uniform int uLayer, uStride, uColor;
  ${decl}
  layout(std140) uniform Wsmall { vec4 b1[H4]; vec4 b2[H4]; vec4 w3[H]; vec4 b3; };
  out vec4 o;
  void main() {
    int i = uLayer * uStride, j = int(gl_FragCoord.y) * uStride, k = int(gl_FragCoord.x) * uStride;
    vec4 h[H4];
    for (int c = 0; c < H4; c++)
      h[c] = max(texelFetch(uP, ivec3(j, i, c), 0) + texelFetch(uP, ivec3(k, i, H4 + c), 0)
               + texelFetch(uP, ivec3(k, j, 2 * H4 + c), 0) + b1[c], 0.0);
    vec4 acc = b3;
    for (int m = 0; m < H4; m++) {
      vec4 s = b2[m];${loops}
      s = max(s, 0.0);
      acc += s.x * w3[4 * m] + s.y * w3[4 * m + 1] + s.z * w3[4 * m + 2] + s.w * w3[4 * m + 3];
    }
    o = uColor == 1 ? vec4(acc.yzw, 1.0) : vec4(acc.x, 0.0, 0.0, 1.0);
  }` };
  };
  // The same for the v2 family (m3d-model2.js): planes hold hid geometry + chc colour channels (layer p*CH4 + c);
  // geometry = [first (prod)] -> mlp_layers hidden layers -> out_g; colour (chc > 0, the stride-2 pass) = relu(sum of the
  // colour planes) -> c2 (-> 32) -> c3 (-> 3). Every [in, out] matrix is padded to whole vec4 outputs and split into
  // uniform blocks of <= 1024 vec4 (16 KB); all biases share one block. -> { src, blocks: [[name, Float32Array]] }.
  const GRID2 = (model) => {
    const F = model.F, D = model.meta.dec, H = model.meta.hid, C = D.chc, H4 = H / 4, C4 = C / 4, CH4 = H4 + C4;
    const blocks = [], decl = [], bias = [], boff = {};
    const addBias = (name, vals, n4) => { boff[name] = bias.length / 4; const b = new Float32Array(n4 * 4); b.set(vals); bias.push(...b); };
    const mat = (key, IN, OUT, src, dst, bname, relu) => {          // GLSL for dst[0..OUT4) = act(W src + bias)
      const OUT4 = Math.ceil(OUT / 4), w = F[key], rows = Math.max(4, Math.floor(1024 / OUT4 / 4) * 4);
      let code = `for (int m = 0; m < ${OUT4}; m++) { vec4 s = bias[${boff[bname]} + m];`;
      for (let a = 0, i = 0; a < IN; a += rows, i++) {
        const b = Math.min(IN, a + rows), nm = `${key.replace(/\W/g, '_')}_${i}`, pad = new Float32Array((b - a) * OUT4 * 4);
        for (let r = a; r < b; r++) pad.set(w.subarray(r * OUT, (r + 1) * OUT), (r - a) * OUT4 * 4);
        blocks.push([nm, pad]); decl.push(`layout(std140) uniform B_${nm} { vec4 ${nm}[${(b - a) * OUT4}]; };`);
        code += `
        for (int c = ${a / 4}; c < ${b / 4}; c++) { vec4 v = ${src}[c]; int r = (4 * c - ${a}) * ${OUT4} + m;
          s += v.x * ${nm}[r] + v.y * ${nm}[r + ${OUT4}] + v.z * ${nm}[r + ${2 * OUT4}] + v.w * ${nm}[r + ${3 * OUT4}]; }`;
      }
      return code + ` ${dst}[m] = ${relu ? 'max(s, 0.0)' : 's'}; }`;
    };
    const fetch = (p, c) => `texelFetch(uP, ivec3(${['j, i', 'k, i', 'k, j'][p]}, ${p} * ${CH4} + ${c}), 0)`;
    let geo;
    if (D.prod) {
      const fb = Float32Array.from(F['first.b'], (v, n) => v + F['b1'][n]);   // relu(first(sum + prod) + b1)
      addBias('first', fb, H4);
      geo = `for (int c = 0; c < H4; c++) { vec4 a = ${fetch(0, 'c')}, b = ${fetch(1, 'c')}, e = ${fetch(2, 'c')}; t[c] = a + b + e + a * b * e; }
        ${mat('first.w', H, H, 't', 'h', 'first', true)}`;
    } else {
      addBias('b1', F['b1'], H4);
      geo = `for (int c = 0; c < H4; c++) h[c] = max(${fetch(0, 'c')} + ${fetch(1, 'c')} + ${fetch(2, 'c')} + bias[${boff.b1} + c], 0.0);`;
    }
    for (let l = 0; l < D.mlp_layers; l++) {
      addBias('h' + l, F['hidden' + l + '.b'], H4);
      geo += `
        for (int c = 0; c < H4; c++) t[c] = h[c];
        ${mat('hidden' + l + '.w', H, H, 't', 'h', 'h' + l, true)}`;
    }
    addBias('og', F['out_g.b'], 1);
    geo += `
        ${mat('out_g.w', H, C ? 1 : 4, 'h', 'og', 'og', false)}
        o = uColor == 1 ? vec4(og[0].yzw, 1.0) : vec4(og[0].x, 0.0, 0.0, 1.0);`;
    let col = '';
    if (C) {
      addBias('c2', F['c2.b'], 8); addBias('c3', F['c3.b'], 1);
      col = `vec4 hc[${C4}]; vec4 r1[8]; vec4 oc[1];
        for (int q = 0; q < ${C4}; q++) hc[q] = max(${fetch(0, `${H4} + q`)} + ${fetch(1, `${H4} + q`)} + ${fetch(2, `${H4} + q`)}, 0.0);
        ${mat('c2.w', C, 32, 'hc', 'r1', 'c2', true)}
        ${mat('c3.w', 32, 3, 'r1', 'oc', 'c3', false)}
        o = vec4(oc[0].xyz, 1.0);`;
    }
    blocks.push(['small', Float32Array.from(bias)]);
    return { blocks, src: `#version 300 es
  precision highp float; precision highp int; precision highp sampler2DArray;
  #define H4 ${H4}
  uniform sampler2DArray uP; uniform int uLayer, uStride, uColor;
  ${decl.join('\n  ')}
  layout(std140) uniform B_small { vec4 bias[${bias.length / 4}]; };
  out vec4 o;
  void main() {
    int i = uLayer * uStride, j = int(gl_FragCoord.y) * uStride, k = int(gl_FragCoord.x) * uStride;
    if (uColor == 0 || ${C ? 'false' : 'true'}) {
      vec4 h[H4]; vec4 t[H4]; vec4 og[1];
      ${geo}
    } else {
      ${col || 'o = vec4(0.0);'}
    }
  }` };
  };
  // floor height in two parallel stages: (1) pixel (y=j, x=i) = min over z; (2) pixel j = min over x of stage 1
  const FLOOR1 = `#version 300 es
  precision highp float; precision highp int; precision highp sampler3D;
  uniform sampler3D uS; uniform int uR; out vec4 o;
  void main() {
    int j = int(gl_FragCoord.x), i = int(gl_FragCoord.y); float m = 1e9;
    for (int k = 0; k < uR; k++) m = min(m, texelFetch(uS, ivec3(k, j, i), 0).r);
    o = vec4(m);
  }`;
  const FLOOR2 = `#version 300 es
  precision highp float; precision highp int;
  uniform highp sampler2D uM; uniform int uR; out vec4 o;
  void main() {
    int j = int(gl_FragCoord.x); float m = 1e9;
    for (int i = 0; i < uR; i++) m = min(m, texelFetch(uM, ivec2(j, i), 0).r);
    o = vec4(m);
  }`;

  function prog(gl, fs) {
    const mk = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(s)); return s; };
    const p = gl.createProgram();
    gl.attachShader(p, mk(gl.VERTEX_SHADER, VS)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(p));
    const u = {}, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const name = gl.getActiveUniform(p, i).name; u[name] = gl.getUniformLocation(p, name); }
    return { p, u };
  }
  M.glProg = (gl, fs) => prog(gl, fs);      // for the renderer extensions (m3d-level.js)

  M.Renderer = class {
    constructor(canvas) {
      // no preserveDrawingBuffer: readers (coverage, save png) read right after draw() in the same task
      const gl = this.gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false });
      if (!gl) throw new Error('WebGL2 is not available');
      this.pendingFloors = []; this.lastFloor = -0.9;
      this.canvas = canvas;
      this.march = prog(gl, MARCH); this.post = prog(gl, POST);
      this.vao = gl.createVertexArray();
      this.fbo = gl.createFramebuffer(); this.img = null; this.imgSize = [0, 0];
      this.pool = [];                         // recycled volume textures, keyed by size
      this.paper = [0.965, 0.957, 0.945];
      this.eps = 0.01;                        // the SDF shell half-thickness (meta.eps)
      this.levels = V1_LEVELS;
    }

    // Upload one decoded keyframe; returns a handle {s, c, R, Rc} to pass to draw(). Textures are recycled via release().
    alloc(R, Rc, rgba) {                      // a pooled pair of volume textures; rgba = renderable colour (GL grid path)
      const gl = this.gl;
      const i = this.pool.findIndex((t) => t.R === R && t.Rc === Rc && t.rgba === rgba);
      if (i >= 0) return this.pool.splice(i, 1)[0];
      const s = gl.createTexture(), c = gl.createTexture();
      for (const [t, f, n] of [[s, gl.R16F, R], [c, rgba ? gl.RGBA16F : gl.RGB16F, Rc]]) {
        gl.bindTexture(gl.TEXTURE_3D, t); gl.texStorage3D(gl.TEXTURE_3D, 1, f, n, n, n);
        for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_3D, p, gl.LINEAR);
        for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, p, gl.CLAMP_TO_EDGE);
      }
      return { s, c, R, Rc, rgba };
    }

    volume(k) {
      const gl = this.gl, R = k.R, Rc = k.Rc, v = this.alloc(R, Rc, false);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      const ty = k.half ? gl.HALF_FLOAT : gl.FLOAT;                   // half grids upload without any conversion
      gl.bindTexture(gl.TEXTURE_3D, v.s); gl.texSubImage3D(gl.TEXTURE_3D, 0, 0, 0, 0, R, R, R, gl.RED, ty, k.sdf);
      gl.bindTexture(gl.TEXTURE_3D, v.c); gl.texSubImage3D(gl.TEXTURE_3D, 0, 0, 0, 0, Rc, Rc, Rc, gl.RGB, ty, k.rgb);
      return v;
    }

    release(v) { if (v && this.pool.length < 8) this.pool.push(v); else if (v) { this.gl.deleteTexture(v.s); this.gl.deleteTexture(v.c); } }

    // delta(R) of the drawn threshold per export: meta.post (m3d_eval.py --post, calibrated on the exported checkpoint's
    // selection half; the threshold-only runtime uses T_k0 = iso(R) + delta_k0), else the v1 measurement for a v1
    // export, else 0 (the plain iso: an uncalibrated model gets no correction)
    setLevels(meta) {
      const p = meta.post, iso = (R) => Math.max(0, 1 / (R - 1) - (meta.eps || 0.01));
      this.calibrated = !!p;
      this.levels = p ? [64, 96, 128].map((R) => [R, p['R' + R].T_k0 - iso(R)]) : meta.arch === 'v2' ? [[64, 0], [96, 0], [128, 0]] : V1_LEVELS;
    }

    // --- WebGL grid path -------------------------------------------------------------------------------------------
    gridInit(model) {                        // false when float render targets are missing (then TF.js does the grid)
      const gl = this.gl, W = model.W, H = model.meta.hid, H4 = H / 4, v2 = model.meta.arch === 'v2';
      if (!gl.getExtension('EXT_color_buffer_float') || H % 4 || (v2 && model.meta.dec.chc % 4)) return false;
      const d = (k) => (model.F && model.F[k]) || W[k].dataSync(), g = v2 ? GRID2(model) : GRID(H);
      this.gridProg = prog(gl, g.src); this.floor1 = prog(gl, FLOOR1); this.floor2 = prog(gl, FLOOR2);
      const ubo = (name, data, point) => {     // one uniform buffer per block, bound to its own binding point
        const idx = gl.getUniformBlockIndex(this.gridProg.p, name);
        if (idx === gl.INVALID_INDEX) throw new Error('uniform block ' + name + ' missing');
        gl.uniformBlockBinding(this.gridProg.p, idx, point);
        const b = gl.createBuffer(); gl.bindBuffer(gl.UNIFORM_BUFFER, b); gl.bufferData(gl.UNIFORM_BUFFER, data, gl.STATIC_DRAW);
        gl.bindBufferBase(gl.UNIFORM_BUFFER, point, b);
        return b;
      };
      if (v2) {                              // v2: every block comes ready from GRID2; planes carry hid + chc channels
        this.ubos = g.blocks.map(([name, data], i) => ubo('B_' + name, data, i));
        this.uboPoints = g.blocks.length; this.gfbo = gl.createFramebuffer(); this.ptex = {}; this.hid = H + model.meta.dec.chc;
        return true;
      }
      const w2 = d('l2.w');                                     // [in, out]: row n = input n, H outputs = H4 vec4
      this.ubos = g.blocks.map(([a, b], i) => ubo(`W2_${i}`, w2.slice(a * H, b * H), i));
      const small = new Float32Array((2 * H4 + H + 1) * 4), w3 = d('l3.w');
      small.set(d('b1'), 0); small.set(d('l2.b'), H4 * 4);
      for (let m = 0; m < H; m++) small.set(w3.subarray(m * 4, m * 4 + 4), (2 * H4 + m) * 4);
      small.set(d('l3.b'), (2 * H4 + H) * 4);
      this.ubos.push(ubo('Wsmall', small, g.blocks.length));
      this.uboPoints = g.blocks.length + 1;
      this.gfbo = gl.createFramebuffer(); this.ptex = {}; this.hid = H;
      return true;
    }

    async gridVolume(model, P, R, floorGuess) {   // P: tf tensor [3, Rp, Rp, H] on the WebGL backend -> volume handle (+ .floor)
      const gl = this.gl, H = this.hid, H4 = H / 4, Rc = (R + 1) >> 1, T = [performance.now()];
      const planes = tf.tidy(() => {         // [3, R, R, H] -> [3*H4, R, R, 4]: one texture layer per 4-channel chunk
        const Pr = R === P.shape[1] ? P : tf.image.resizeBilinear(P, [R, R], true);
        return tf.transpose(tf.reshape(Pr, [3, R, R, H4, 4]), [0, 3, 1, 2, 4]);
      });
      const data = await planes.data(); planes.dispose(); T.push(performance.now());
      let pt = this.ptex[R];
      if (!pt) {
        pt = this.ptex[R] = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D_ARRAY, pt);
        gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA32F, R, R, 3 * H4);
        for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D_ARRAY, p, gl.NEAREST);
      }
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, pt); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, 0, R, R, 3 * H4, gl.RGBA, gl.FLOAT, data);
      if (this.profile) { gl.finish(); T.push(performance.now()); }
      const v = this.alloc(R, Rc, true), g = this.gridProg;
      gl.bindVertexArray(this.vao); gl.useProgram(g.p); gl.disable(gl.BLEND);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D_ARRAY, pt); gl.uniform1i(g.u.uP, 0);
      this.ubos.forEach((b, i) => gl.bindBufferBase(gl.UNIFORM_BUFFER, i, b));
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.gfbo);
      for (const [tex, n, stride, col] of [[v.s, R, 1, 0], [v.c, Rc, 2, 1]]) {
        gl.viewport(0, 0, n, n); gl.uniform1i(g.u.uStride, stride); gl.uniform1i(g.u.uColor, col);
        for (let i = 0; i < n; i++) {        // one slice of the volume per draw: layer i = x, pixel (z, y)
          gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, tex, 0, i);
          gl.uniform1i(g.u.uLayer, i); gl.drawArrays(gl.TRIANGLES, 0, 3);
        }
      }
      if (this.profile) { const px = new Float32Array(4); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, px); T.push(performance.now()); }
      v.floor = this.floorOf(v, floorGuess);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      if (this.profile) { T.push(performance.now()); this.times = ['readback', 'upload', 'shader', 'floor'].map((k, i) => [k, +(T[i + 1] - T[i]).toFixed(1)]); }
      return v;
    }

    floorOf(v, guess) {                      // lowest grid height holding solid, from a two-stage GPU min per height
      const gl = this.gl, R = v.R;
      if (!this.ftex || this.ftexR !== R) {
        for (const t of [this.ftex, this.mtex]) if (t) gl.deleteTexture(t);
        const mk = (w, h) => { const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t); gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, w, h);
          for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, p, gl.NEAREST); return t; };
        this.mtex = mk(R, R); this.ftex = mk(R, 1); this.ftexR = R;
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.gfbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.mtex, 0);
      gl.viewport(0, 0, R, R); gl.useProgram(this.floor1.p);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_3D, v.s);
      gl.uniform1i(this.floor1.u.uS, 0); gl.uniform1i(this.floor1.u.uR, R);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.ftex, 0);
      gl.viewport(0, 0, R, 1); gl.useProgram(this.floor2.p);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.mtex);
      gl.uniform1i(this.floor2.u.uM, 1); gl.uniform1i(this.floor2.u.uR, R);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      // async read: the row goes into a pixel-pack buffer behind a fence (a plain readPixels here stalled the main
      // thread for the whole grid pass, 13-60 ms per keyframe); pollFloors() fills v.floor when the GPU is done
      const pbo = gl.createBuffer();
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo); gl.bufferData(gl.PIXEL_PACK_BUFFER, R * 16, gl.STREAM_READ);
      gl.readPixels(0, 0, R, 1, gl.RGBA, gl.FLOAT, 0); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0); gl.flush();
      v.fgen = (v.fgen || 0) + 1;
      this.pendingFloors.push({ v, gen: v.fgen, pbo, sync, R });
      return guess ?? this.lastFloor;                // until the GPU answers (a refine passes the floor it replaces)
    }

    pollFloors() {
      const gl = this.gl;
      this.pendingFloors = this.pendingFloors.filter((p) => {
        if (gl.clientWaitSync(p.sync, 0, 0) === gl.TIMEOUT_EXPIRED) return true;
        const px = new Float32Array(p.R * 4);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, p.pbo); gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, px); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        gl.deleteSync(p.sync); gl.deleteBuffer(p.pbo);
        let f = -0.9; for (let j = 0; j < p.R; j++) if (px[j * 4] < 0) { f = -1 + 2 * j / (p.R - 1) - 0.006; break; }
        if (p.v.fgen === p.gen) p.v.floor = f;          // the volume may have been recycled meanwhile
        this.lastFloor = f;
        return false;
      });
    }

    readVolume(v, colour) {                  // self-check only: a volume back to the CPU in (x, y, z) order (sdf or rgb)
      const gl = this.gl, R = colour ? v.Rc : v.R, ch = colour ? 3 : 1;
      const out = new Float32Array(R * R * R * ch), px = new Float32Array(R * R * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.gfbo || (this.gfbo = gl.createFramebuffer()));
      for (let i = 0; i < R; i++) {
        gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, colour ? v.c : v.s, 0, i);
        gl.readPixels(0, 0, R, R, gl.RGBA, gl.FLOAT, px);
        for (let j = 0; j < R; j++) for (let k = 0; k < R; k++)
          for (let c = 0; c < ch; c++) out[((i * R + j) * R + k) * ch + c] = px[(j * R + k) * 4 + c];
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return out;
    }

    // a, b: volumes; t: blend; cam: {eye, rot(mat3 column-major), fov}; style: 'lit' | 'dots' | 'mono'; scale: internal resolution
    draw(a, b, t, floor, cam, style, scale, cell) {
      const gl = this.gl, W = this.canvas.width, H = this.canvas.height;
      const dots = style !== 'lit';
      const iw = dots ? Math.ceil(W / cell) : Math.max(1, Math.round(W * scale)), ih = dots ? Math.ceil(H / cell) : Math.max(1, Math.round(H * scale));
      if (!this.img || this.imgSize[0] !== iw || this.imgSize[1] !== ih) {
        if (this.img) gl.deleteTexture(this.img);
        this.img = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, this.img);
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, iw, ih);
        for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, p, gl.CLAMP_TO_EDGE);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.img, 0);
        this.imgSize = [iw, ih];
      }
      gl.bindTexture(gl.TEXTURE_2D, this.img);
      const filt = dots ? gl.NEAREST : gl.LINEAR;
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filt); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filt);
      gl.bindVertexArray(this.vao);
      // pass 1: sphere tracing into the low-res buffer
      const m = this.march, u = m.u;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo); gl.viewport(0, 0, iw, ih); gl.useProgram(m.p);
      [[a.s, 'uS0'], [b.s, 'uS1'], [a.c, 'uC0'], [b.c, 'uC1']].forEach(([tex, name], i) => {
        gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_3D, tex); gl.uniform1i(u[name], i); });
      gl.uniform4f(u.uGrid, a.R, b.R, a.Rc, b.Rc); gl.uniform1f(u.uT, t); gl.uniform1f(u.uFloor, floor);
      // threshold T(R) = max(0, 1/(R-1) - eps) + delta(R), delta at R 64/96/128 (this.levels, setLevels / setPost),
      // linear in 1/(R-1) between them and held beyond. A calibrated export (meta.post) is drawn at exactly that T.
      // The built-in v1 table (the measured share of the thin-sheet dilation the v1 decoder does not need: E1,
      // research/postproc/page_patch/NOTES.md) is clamped at level 0, so T never erodes below the network's surface,
      // never exceeds the old iso(R), never rises with R, is 0 from R 82 up and equals the old iso at R >= 101
      const iso = (R) => {
        const K = this.levels, v = (r) => 1 / (r - 1);
        let d = R <= K[0][0] ? K[0][1] : K[K.length - 1][1];
        for (let i = 1; i < K.length; i++) if (R > K[i - 1][0] && R <= K[i][0]) {
          d = K[i - 1][1] + (K[i][1] - K[i - 1][1]) * (v(R) - v(K[i - 1][0])) / (v(K[i][0]) - v(K[i - 1][0])); break; }
        const T = Math.max(0, 1 / (R - 1) - this.eps) + d;
        return this.calibrated ? T : Math.max(0, T);     // meta.post: exactly the T the notebook scored; v1 table: clamped
      };
      gl.uniform1f(u.uIso, iso(a.R) + (iso(b.R) - iso(a.R)) * t);
      gl.uniform1f(u.uAspect, iw / ih); gl.uniform1f(u.uTanF, Math.tan(cam.fov / 2));
      gl.uniform3fv(u.uEye, cam.eye); gl.uniformMatrix3fv(u.uRot, false, cam.rot); gl.uniform3fv(u.uKey, cam.key); gl.uniform3fv(u.uPaper, this.paper);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      // pass 2: to the canvas
      const q = this.post;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, W, H); gl.useProgram(q.p);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.img); gl.uniform1i(q.u.uImg, 0);
      gl.uniform2f(q.u.uOut, W, H); gl.uniform2f(q.u.uIn, iw, ih); gl.uniform1i(q.u.uMode, style === 'lit' ? 0 : style === 'dots' ? 1 : 2);
      gl.uniform1f(q.u.uCell, cell); gl.uniform3fv(q.u.uPaper, this.paper);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    // mean |ink| of the last frame over the whole canvas (for the self-check / harness)
    coverage() {
      const gl = this.gl, W = this.canvas.width, H = this.canvas.height, px = new Uint8Array(W * H * 4), p = this.paper.map((v) => v * 255);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
      let s = 0;
      for (let i = 0; i < px.length; i += 12) s += Math.abs(px[i] - p[0]) + Math.abs(px[i + 1] - p[1]) + Math.abs(px[i + 2] - p[2]);
      return s / (px.length / 12) / 255;
    }
  };
})(window.M3D = window.M3D || {});
