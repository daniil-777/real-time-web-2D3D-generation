// Morph 3D WebGL grid path, the decoder where WebGPU is missing: the MLP per voxel as fragment shaders, written straight
// into the renderer's 3D textures (no grid readback). Extends M.Renderer; loads after m3d-render.js.
(function (M) {
  'use strict';
  // HD narrow band (m3d-app.js), as the WebGPU kernel in m3d-model.js: a voxel whose coarse (trilinear) value lies more
  // than tau from the surface keeps that value and skips the network; i, j, k are its indices in the fine grid. uLim:
  // the sdf a pass writes is clamped to it -- the coarse pass of a meta.trunc export (band.lim), else no clamp
  const BAND_DECL = 'uniform highp sampler3D uCo; uniform int uBand; uniform float uTau, uLim; uniform vec2 uCoMap;';
  const BAND = `
    if (uBand == 1) {
      float cv = texture(uCo, vec3(k, j, i) * uCoMap.x + uCoMap.y).r;
      if (abs(cv) > uTau) { o = uColor == 1 ? vec4(0.5, 0.5, 0.5, 1.0) : vec4(cv, 0.0, 0.0, 1.0); return; }
    }`;
  // Planes arrive as a texture array: layer p*H4 + c holds channels 4c..4c+3 of plane p (xy, xz, yz), texel (col, row)
  // = (w, h) axes. Weights live in uniform blocks (broadcast from the constant cache; texelFetch per weight was 5x slower). W2 rows are
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
  ${BAND_DECL}
  ${decl}
  layout(std140) uniform Wsmall { vec4 b1[H4]; vec4 b2[H4]; vec4 w3[H]; vec4 b3; };
  out vec4 o;
  void main() {
    int i = uLayer * uStride, j = int(gl_FragCoord.y) * uStride, k = int(gl_FragCoord.x) * uStride;${BAND}
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
    o = uColor == 1 ? vec4(acc.yzw, 1.0) : vec4(clamp(acc.x, -uLim, uLim), 0.0, 0.0, 1.0);
  }` };
  };
  // Small [in, out] matrix layers in GLSL with every weight in std140 uniform blocks: each matrix is padded to whole vec4
  // outputs and split into blocks of <= 1024 vec4 (16 KB); all biases share one block, added last by done(). pre prefixes
  // every GLSL name (GRID2: none; the v2 per-pixel field of m3d-neural.js: 'n'). -> { bias(name, values, n4) -> its vec4
  // offset, mat(...) -> GLSL, done() -> the declarations, blocks: [[name, Float32Array]] for uniform blocks B_<name> }
  M.glLayers = (F, pre = '') => {
    const blocks = [], decl = [], bv = [], boff = {};
    return {
      blocks, boff,
      bias(name, vals, n4) { boff[name] = bv.length / 4; const b = new Float32Array(n4 * 4); b.set(vals); bv.push(...b); return boff[name]; },
      mat(key, IN, OUT, src, dst, bname, relu) {          // GLSL for dst[0..OUT4) = act(W src + bias)
        const OUT4 = Math.ceil(OUT / 4), w = F[key], rows = Math.max(4, Math.floor(1024 / OUT4 / 4) * 4);
        let code = `for (int m = 0; m < ${OUT4}; m++) { vec4 s = ${pre}bias[${boff[bname]} + m];`;
        for (let a = 0, i = 0; a < IN; a += rows, i++) {
          const b = Math.min(IN, a + rows), nm = `${pre}${key.replace(/\W/g, '_')}_${i}`, pad = new Float32Array((b - a) * OUT4 * 4);
          for (let r = a; r < b; r++) pad.set(w.subarray(r * OUT, (r + 1) * OUT), (r - a) * OUT4 * 4);
          blocks.push([nm, pad]); decl.push(`layout(std140) uniform B_${nm} { vec4 ${nm}[${(b - a) * OUT4}]; };`);
          code += `
        for (int c = ${a / 4}; c < ${b / 4}; c++) { vec4 v = ${src}[c]; int r = (4 * c - ${a}) * ${OUT4} + m;
          s += v.x * ${nm}[r] + v.y * ${nm}[r + ${OUT4}] + v.z * ${nm}[r + ${2 * OUT4}] + v.w * ${nm}[r + ${3 * OUT4}]; }`;
        }
        return code + ` ${dst}[m] = ${relu ? 'max(s, 0.0)' : 's'}; }`;
      },
      done() {
        blocks.push([pre + 'small', Float32Array.from(bv)]);
        return decl.concat([`layout(std140) uniform B_${pre}small { vec4 ${pre}bias[${bv.length / 4}]; };`]).join('\n  ');
      },
    };
  };
  // The same for the v2 family (m3d-model2.js): planes hold hid geometry + chc colour channels (layer p*CH4 + c);
  // geometry = [first (prod)] -> mlp_layers hidden layers -> out_g; colour (chc > 0, the stride-2 pass) = relu(sum of the
  // colour planes) -> c2 (-> 32) -> c3 (-> 3); weights as M.glLayers. -> { src, blocks: [[name, Float32Array]] }.
  const GRID2 = (model) => {
    const F = model.F, D = model.meta.dec, H = model.meta.hid, C = D.chc, H4 = H / 4, C4 = C / 4, CH4 = H4 + C4;
    const lay = M.glLayers(F), addBias = lay.bias, mat = lay.mat, boff = lay.boff;
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
        o = uColor == 1 ? vec4(og[0].yzw, 1.0) : vec4(clamp(og[0].x, -uLim, uLim), 0.0, 0.0, 1.0);`;
    let col = '';
    if (C) {
      addBias('c2', F['c2.b'], 8); addBias('c3', F['c3.b'], 1);
      col = `vec4 hc[${C4}]; vec4 r1[8]; vec4 oc[1];
        for (int q = 0; q < ${C4}; q++) hc[q] = max(${fetch(0, `${H4} + q`)} + ${fetch(1, `${H4} + q`)} + ${fetch(2, `${H4} + q`)}, 0.0);
        ${mat('c2.w', C, 32, 'hc', 'r1', 'c2', true)}
        ${mat('c3.w', 32, 3, 'r1', 'oc', 'c3', false)}
        o = vec4(oc[0].xyz, 1.0);`;
    }
    const decl = lay.done();
    return { blocks: lay.blocks, src: `#version 300 es
  precision highp float; precision highp int; precision highp sampler2DArray;
  #define H4 ${H4}
  uniform sampler2DArray uP; uniform int uLayer, uStride, uColor;
  ${BAND_DECL}
  ${decl}
  out vec4 o;
  void main() {
    int i = uLayer * uStride, j = int(gl_FragCoord.y) * uStride, k = int(gl_FragCoord.x) * uStride;${BAND}
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
  // planes src^2 -> R^2 per texture layer, exactly tf.image.resizeBilinear(P, [R, R], true): source = out * (src-1)/(R-1)
  const RESIZE = `#version 300 es
  precision highp float; precision highp int; precision highp sampler2DArray;
  uniform sampler2DArray uSrc; uniform int uL, uLast; uniform float uSc; out vec4 o;
  void main() {
    vec2 s = floor(gl_FragCoord.xy) * uSc; ivec2 a = ivec2(s), b = min(a + 1, ivec2(uLast)); vec2 f = s - vec2(a);
    vec4 tl = texelFetch(uSrc, ivec3(a, uL), 0), tr = texelFetch(uSrc, ivec3(b.x, a.y, uL), 0);
    vec4 bl = texelFetch(uSrc, ivec3(a.x, b.y, uL), 0), br = texelFetch(uSrc, ivec3(b, uL), 0);
    vec4 top = tl + (tr - tl) * f.x, bot = bl + (br - bl) * f.x;
    o = top + (bot - top) * f.y;
  }`;
  const tex3D = (gl, fmt, n, filter) => {
    const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_3D, t); gl.texStorage3D(gl.TEXTURE_3D, 1, fmt, n, n, n);
    for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_3D, p, filter);
    for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, p, gl.CLAMP_TO_EDGE);
    return t;
  };
  const RP = M.Renderer.prototype;

  RP.gridInit = function (model) {          // false when float render targets are missing (then TF.js does the grid)
    const gl = this.gl, W = model.W, H = model.meta.hid, H4 = H / 4, v2 = model.meta.arch === 'v2';
    if (!gl.getExtension('EXT_color_buffer_float') || H % 4 || (v2 && model.meta.dec.chc % 4)) return false;
    const d = (k) => (model.F && model.F[k]) || W[k].dataSync(), g = v2 ? GRID2(model) : GRID(H);
    this.gridProg = M.glProg(gl, g.src); this.floor1 = M.glProg(gl, FLOOR1); this.floor2 = M.glProg(gl, FLOOR2);
    this.resizeProg = M.glProg(gl, RESIZE); this.nocoarse = tex3D(gl, gl.R16F, 1, gl.NEAREST);
    this.gfbo = gl.createFramebuffer(); this.ptex = {};
    const ubo = (name, data, point) => {     // one uniform buffer per block, bound to its own binding point
      const idx = gl.getUniformBlockIndex(this.gridProg.p, name);
      if (idx === gl.INVALID_INDEX) throw new Error('uniform block ' + name + ' missing');
      gl.uniformBlockBinding(this.gridProg.p, idx, point);
      const b = gl.createBuffer(); gl.bindBuffer(gl.UNIFORM_BUFFER, b); gl.bufferData(gl.UNIFORM_BUFFER, data, gl.STATIC_DRAW);
      gl.bindBufferBase(gl.UNIFORM_BUFFER, point, b);
      return b;
    };
    if (v2) {                                // v2: every block comes ready from GRID2; planes carry hid + chc channels
      this.ubos = g.blocks.map(([name, data], i) => ubo('B_' + name, data, i));
      this.hid = H + model.meta.dec.chc;
      return true;
    }
    const w2 = d('l2.w');                                       // [in, out]: row n = input n, H outputs = H4 vec4
    this.ubos = g.blocks.map(([a, b], i) => ubo(`W2_${i}`, w2.slice(a * H, b * H), i));
    const small = new Float32Array((2 * H4 + H + 1) * 4), w3 = d('l3.w');
    small.set(d('b1'), 0); small.set(d('l2.b'), H4 * 4);
    for (let m = 0; m < H; m++) small.set(w3.subarray(m * 4, m * 4 + 4), (2 * H4 + m) * 4);
    small.set(d('l3.b'), (2 * H4 + H) * 4);
    this.ubos.push(ubo('Wsmall', small, g.blocks.length));
    this.hid = H;
    return true;
  };

  RP.planeTex = function (r, H4) {          // the planes at size r: one float texture array per size, made once
    let t = this.ptex[r];
    if (!t) {
      const gl = this.gl; t = this.ptex[r] = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D_ARRAY, t);
      gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA32F, r, r, 3 * H4);
      for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D_ARRAY, p, gl.NEAREST);
    }
    return t;
  };

  RP.resizePlanes = function (pt, src, r, H4) {   // planes texture pt (src^2) -> the size-r planes texture, on the GPU
    const gl = this.gl, q = this.resizeProg, out = this.planeTex(r, H4);
    gl.bindVertexArray(this.vao); gl.useProgram(q.p); gl.disable(gl.BLEND);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D_ARRAY, pt); gl.uniform1i(q.u.uSrc, 0);
    gl.uniform1f(q.u.uSc, (src - 1) / (r - 1)); gl.uniform1i(q.u.uLast, src - 1);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.gfbo); gl.viewport(0, 0, r, r);
    for (let l = 0; l < 3 * H4; l++) {
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, out, 0, l);
      gl.uniform1i(q.u.uL, l); gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    return out;
  };

  // the grid program over the n layers of the 3D texture tex (layer i = x, pixel (z, y)); bd: the band, if any. The
  // band sampler always gets its own unit and a texture that is not being drawn into (a feedback loop is an error).
  // lim: the written sdf is clamped to +-lim (the band's coarse pass of a meta.trunc export)
  RP.slices = function (tex, n, stride, col, pt, bd, lim = 1e4) {
    const gl = this.gl, g = this.gridProg;
    gl.bindVertexArray(this.vao); gl.useProgram(g.p); gl.disable(gl.BLEND);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D_ARRAY, pt); gl.uniform1i(g.u.uP, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_3D, bd ? bd.co : this.nocoarse); gl.uniform1i(g.u.uCo, 1);
    gl.uniform1i(g.u.uBand, bd ? 1 : 0); gl.uniform1f(g.u.uLim, lim);
    if (bd) { gl.uniform1f(g.u.uTau, bd.tau); gl.uniform2f(g.u.uCoMap, bd.map[0], bd.map[1]); }
    this.ubos.forEach((b, i) => gl.bindBufferBase(gl.UNIFORM_BUFFER, i, b));
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.gfbo);
    gl.viewport(0, 0, n, n); gl.uniform1i(g.u.uStride, stride); gl.uniform1i(g.u.uColor, col);
    for (let i = 0; i < n; i++) {
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, tex, 0, i);
      gl.uniform1i(g.u.uLayer, i); gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
  };

  // P (tf, [3, Rp, Rp, H]) at size r, resized by TF.js, -> the size-r planes texture ([3*H4, r, r, 4]: one texture layer
  // per 4-channel chunk); T: profile marks after the readback and the upload
  RP.upPlanes = async function (P, r, H4, T) {
    const gl = this.gl, planes = tf.tidy(() => {
      const Pr = r === P.shape[1] ? P : tf.image.resizeBilinear(P, [r, r], true);
      return tf.transpose(tf.reshape(Pr, [3, r, r, H4, 4]), [0, 3, 1, 2, 4]);
    });
    const data = await planes.data(); planes.dispose(); if (T) T.push(performance.now());
    const pt = this.planeTex(r, H4);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, pt); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, 0, r, r, 3 * H4, gl.RGBA, gl.FLOAT, data);
    if (T && this.profile) { gl.finish(); T.push(performance.now()); }
    return pt;
  };

  // P: tf tensor [3, Rp, Rp, H] on the WebGL backend -> volume handle (+ .floor). band = { Rg, tau } (HD): a dense Rg^3
  // sdf pass first, then the R^3 grid runs the network only near the coarse surface. Planes go up at R (resized by
  // TF.js) up to their own size Rp; above it, and for a band, they go up once at Rp -- at most max(R, UP): arch3's 512^2
  // x 80 channels would be ~250 MB of RGBA32F -- and the GPU resizes them (a 256^3 grid would otherwise read 50 MB back
  // out of TF.js). When that cap binds, the band's coarse planes come from TF.js as well (4 MB at 64^2): a GPU resize of
  // the capped planes samples them twice, up to ~0.01 off in the coarse field, against a margin of 0.005 in tau.
  // ?check compares the two routes on a dense grid (gpuResize = false).
  const UP = 256;
  RP.gridVolume = async function (model, P, R, floorGuess, band) {
    const gl = this.gl, H4 = this.hid / 4, Rp = P.shape[1], Rc = (R + 1) >> 1, T = [performance.now()];
    const src = (R > Rp || band) && this.gpuResize !== false ? Math.min(Rp, Math.max(R, UP)) : R;
    const pt = await this.upPlanes(P, src, H4, T), cpt = band && src < Rp && band.Rg !== src ? await this.upPlanes(P, band.Rg, H4) : null;
    const at = (r) => (r === src ? pt : cpt && r === band.Rg ? cpt : this.resizePlanes(pt, src, r, H4)), v = this.alloc(R, Rc, true);
    let bd = null;
    if (band) {
      if (this.coR !== band.Rg) { if (this.co) gl.deleteTexture(this.co); this.co = tex3D(gl, gl.R16F, band.Rg, gl.LINEAR); this.coR = band.Rg; }
      this.slices(this.co, band.Rg, 1, 0, at(band.Rg), null, band.lim);
      bd = { co: this.co, tau: band.tau, map: [(band.Rg - 1) / ((R - 1) * band.Rg), 0.5 / band.Rg] };   // index -> texcoord
    }
    const pr = at(R);
    this.slices(v.s, R, 1, 0, pr, bd); this.slices(v.c, Rc, 2, 1, pr, bd);
    if (this.profile) { const px = new Float32Array(4); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, px); T.push(performance.now()); }
    v.floor = this.floorOf(v, floorGuess);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (this.profile) { T.push(performance.now()); this.times = ['readback', 'upload', 'shader', 'floor'].map((k, i) => [k, +(T[i + 1] - T[i]).toFixed(1)]); }
    return v;
  };

  RP.floorOf = function (v, guess) {                      // lowest grid height holding solid, from a two-stage GPU min per height
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
  };

  RP.pollFloors = function () {
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
  };

  RP.readVolume = function (v, colour) {                  // self-check only: a volume back to the CPU in (x, y, z) order (sdf or rgb)
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
  };
})(window.M3D = window.M3D || {});
