// Morph 3D per-pixel detail: while an object rests, every hit pixel takes its surface point, normal and colour from the
// decoder itself -- its planes (a hardware-bilinear RGBA16F texture array) and MLP (uniform blocks) inside the tracing
// shader -- instead of from the R^3 grid, so the image shows every feature the planes hold (256^2 for the architecture
// model, 512^2 for arch3) at screen resolution. The grid still does the tracing, shadows and occlusion. v1 and v2
// decoders (v2: the field generated per decoder with M.glLayers of m3d-glgrid.js). Extends M.Renderer.
(function (M) {
  'use strict';
  const RP = M.Renderer.prototype;
  const BIND = 16;                         // uniform-buffer binding points 16+ (the grid shaders use 0..n, n < 16)

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

  // the v2 decoder (m3d-model2.js) at a point, weights in uniform blocks as GRID2's (M.glLayers, GLSL names prefixed
  // 'n'): nfield = geometry, relu([first](sum [+ product] of the 3 plane features) + b1) -> mlp_layers hidden layers ->
  // out_g = (sdf in world units, + rgb when chc = 0); ncol = colour, c3(relu(c2(relu(sum of the 3 colour features)))).
  // Texture layer p * CH4 + c holds channels 4c..4c+3 of plane p: the hid geometry channels, then the chc colour ones.
  const FIELD2 = (model) => {
    const F = model.F, D = model.meta.dec, H = model.meta.hid, C = D.chc, H4 = H / 4, C4 = C / 4, CH4 = H4 + C4;
    const lay = M.glLayers(F, 'n');
    const smp = (p, c) => `texture(uNP, vec3(${['q.y, q.x', 'q.z, q.x', 'q.z, q.y'][p]}, float(${p * CH4} + ${c})))`;
    let geo;
    if (D.prod) {
      lay.bias('first', Float32Array.from(F['first.b'], (v, n) => v + F['b1'][n]), H4);   // relu(first(sum + prod) + b1)
      geo = `for (int c = 0; c < ${H4}; c++) { vec4 a = ${smp(0, 'c')}, b = ${smp(1, 'c')}, e = ${smp(2, 'c')}; t[c] = a + b + e + a * b * e; }
    ${lay.mat('first.w', H, H, 't', 'h', 'first', true)}`;
    } else {
      const b1 = lay.bias('b1', F['b1'], H4);
      geo = `for (int c = 0; c < ${H4}; c++) h[c] = max(${smp(0, 'c')} + ${smp(1, 'c')} + ${smp(2, 'c')} + nbias[${b1} + c], 0.0);`;
    }
    for (let l = 0; l < D.mlp_layers; l++) {
      lay.bias('h' + l, F['hidden' + l + '.b'], H4);
      geo += `
    for (int c = 0; c < ${H4}; c++) t[c] = h[c];
    ${lay.mat('hidden' + l + '.w', H, H, 't', 'h', 'h' + l, true)}`;
    }
    lay.bias('og', F['out_g.b'], 1);
    geo += `
    ${lay.mat('out_g.w', H, C ? 1 : 4, 'h', 'og', 'og', false)}`;
    let col = '';
    if (C) {
      lay.bias('c2', F['c2.b'], 8); lay.bias('c3', F['c3.b'], 1);
      col = `
  vec3 ncol(vec3 p) {
    vec3 q = nq(p); vec4 hc[${C4}]; vec4 r1[8]; vec4 oc[1];
    for (int k = 0; k < ${C4}; k++) hc[k] = max(${smp(0, `${H4} + k`)} + ${smp(1, `${H4} + k`)} + ${smp(2, `${H4} + k`)}, 0.0);
    ${lay.mat('c2.w', C, 32, 'hc', 'r1', 'c2', true)}
    ${lay.mat('c3.w', 32, 3, 'r1', 'oc', 'c3', false)}
    return oc[0].xyz;
  }`;
    }
    const decl = lay.done();
    return { blocks: lay.blocks, hit: HIT2(C), decl: `
  uniform int uNeural; uniform highp sampler2DArray uNP; uniform float uNR, uNE;      // planes, their size, normal step
  ${decl}
  float ntc(float c) { return ((c * 0.5 + 0.5) * (uNR - 1.0) + 0.5) / uNR; }           // align_corners texel centres
  vec3 nq(vec3 p) { return vec3(ntc(p.x), ntc(p.y), ntc(p.z)); }
  vec4 nfield(vec3 p) {                    // plane texel (col, row) = (w, h) axes
    vec3 q = nq(p); vec4 h[${H4}]; vec4 t[${H4}]; vec4 og[1];
    ${geo}
    return og[0];
  }${col}
  vec4 field(vec3 p) { ${C ? 'return vec4(nfield(p).x, ncol(p));' : 'return nfield(p);'} }   // (sdf, rgb): the self-check probe` };
  };
  // as HIT; the colour stream (chc > 0) runs once, at the refined point
  const HIT2 = (C) => `
      if (uNeural == 1) {
        vec4 f0 = nfield(p);
        p -= n * clamp(f0.x, -uNE, uNE);                // at most one texel: never across a thin sheet
        vec2 k = vec2(1.0, -1.0) * uNE;
        vec3 g = k.xyy * nfield(p + k.xyy).x + k.yyx * nfield(p + k.yyx).x + k.yxy * nfield(p + k.yxy).x + k.xxx * nfield(p + k.xxx).x;
        if (dot(g, g) > 1e-14) n = normalize(g);
        alb = pow(clamp(${C ? 'ncol(p)' : 'f0.yzw'}, 0.0, 1.0), vec3(2.2));
      }`;

  RP.neuralInit = function (model) {       // -> true when the per-pixel shader is ready (v1 here, v2: neuralInit2)
    const gl = this.gl, meta = model.meta, H = meta.hid;
    if (meta.arch === 'v2') return this.neuralInit2(model);
    if (H % 4 || gl.getParameter(gl.MAX_UNIFORM_BUFFER_BINDINGS) < BIND + 8) return false;
    const H4 = H / 4, rows = Math.floor(1024 / H4 / 4) * 4, blocks = [];
    for (let r0 = 0; r0 < H; r0 += rows) blocks.push([r0, Math.min(H, r0 + rows)]);
    const decl = FIELD(H, blocks);
    try {
      this.marchN = M.glProg(gl, M.marchSource({ decl, hit: HIT }));
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
    this.nH4 = H4; this.nkey = null; this.ndecl = decl; this.nnames = names;
    return true;
  };

  RP.neuralInit2 = function (model) {      // v2 (m3d-model2.js): the field generated for this decoder
    const gl = this.gl, H = model.meta.hid, C = model.meta.dec.chc;
    if (H % 4 || C % 4) return false;
    const f = FIELD2(model), names = f.blocks.map(([name]) => 'B_' + name);
    if (gl.getParameter(gl.MAX_UNIFORM_BUFFER_BINDINGS) < BIND + names.length) return false;
    try {
      this.marchN = M.glProg(gl, M.marchSource({ decl: f.decl, hit: f.hit }));
    } catch (e) {
      console.warn('per-pixel detail unavailable:', e.message); return false;
    }
    const idx = names.map((n) => gl.getUniformBlockIndex(this.marchN.p, n));
    if (idx.includes(gl.INVALID_INDEX)) { console.warn('per-pixel detail: a uniform block is missing'); return false; }
    this.nubos = f.blocks.map(([, data], i) => {
      gl.uniformBlockBinding(this.marchN.p, idx[i], BIND + i);
      const b = gl.createBuffer(); gl.bindBuffer(gl.UNIFORM_BUFFER, b); gl.bufferData(gl.UNIFORM_BUFFER, data, gl.STATIC_DRAW);
      return b;
    });
    this.nH4 = (H + C) / 4; this.nkey = null; this.ndecl = f.decl; this.nnames = names;
    return true;
  };

  // WebGPU: planes P [3, Rp, Rp, CH] -> float16 in the texture's layout [3, CH/4, Rp, Rp, 4], packed on TF.js's own
  // device and read back (half the bytes of float32, and a HALF_FLOAT upload needs no conversion). -> { data, done }
  RP.halfPlanes = async function (P) {
    const dev = tf.backend().device, [, Rp, , CH] = P.shape, pairs = P.size / 2, bytes = 4 * pairs;
    if (!this.hpipe) this.hpipe = dev.createComputePipeline({ layout: 'auto', compute: { entryPoint: 'main', module: dev.createShaderModule({ code: `
      @group(0) @binding(0) var<storage, read> A: array<f32>;
      @group(0) @binding(1) var<storage, read_write> B: array<u32>;
      @group(0) @binding(2) var<uniform> U: vec4<u32>;                 // Rp, CH, pairs, dispatch width
      fn src(o: u32) -> u32 {                                          // texture-layout index -> planes index
        let k = o % 4u; let x = (o / 4u) % U.x; let y = (o / (4u * U.x)) % U.x; let q = o / (4u * U.x * U.x);
        return ((q / (U.y / 4u) * U.x + y) * U.x + x) * U.y + (q % (U.y / 4u)) * 4u + k;
      }
      @compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3<u32>) {
        let g = id.y * U.w + id.x;
        if (g >= U.z) { return; }
        B[g] = pack2x16float(vec2<f32>(A[src(2u * g)], A[src(2u * g + 1u)]));
      }` }) } });
    const src = P.dataToGPU(), mk = (size, usage) => dev.createBuffer({ size, usage });
    const out = mk(bytes, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC), rd = mk(bytes, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
    const u = mk(16, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST), groups = Math.ceil(pairs / 64), gx = Math.min(groups, 65535);
    dev.queue.writeBuffer(u, 0, new Uint32Array([Rp, CH, pairs, gx * 64]));
    const enc = dev.createCommandEncoder(), pass = enc.beginComputePass();
    pass.setPipeline(this.hpipe);
    pass.setBindGroup(0, dev.createBindGroup({ layout: this.hpipe.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: src.buffer, size: 4 * P.size } }, { binding: 1, resource: { buffer: out } }, { binding: 2, resource: { buffer: u } }] }));
    pass.dispatchWorkgroups(gx, Math.ceil(groups / gx)); pass.end();
    enc.copyBufferToBuffer(out, 0, rd, 0, bytes);
    dev.queue.submit([enc.finish()]);
    try { await rd.mapAsync(GPUMapMode.READ); } finally { src.tensorRef.dispose(); out.destroy(); u.destroy(); }
    return { data: new Uint16Array(rd.getMappedRange()), done: () => { rd.unmap(); rd.destroy(); } };
  };

  const BIG = 64 * 2 ** 20;                // float32 planes above this (arch3: 512^2 x 80 channels = 240 MB) stream in
  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

  // P: the resting object's planes (tf tensor [3, Rp, Rp, H]) -> the planes texture; key tags the volume it belongs to.
  // Big plane sets (one upload of arch3's stalled the page ~0.25 s) go up a few layers per frame -- as float16 packed by
  // halfPlanes when TF.js runs on WebGPU -- with the per-pixel pass off meanwhile; a newer call cancels an older one
  RP.neuralPlanes = async function (P, key) {
    const gl = this.gl, Rp = P.shape[1], H4 = P.shape[3] / 4, gen = this.ngen = (this.ngen || 0) + 1;
    if (4 * P.size > BIG) return this.neuralPlanesBig(P, key, gen);
    const t = tf.tidy(() => tf.transpose(tf.reshape(P, [3, Rp, Rp, H4, 4]), [0, 3, 1, 2, 4]));
    const data = await t.data(); t.dispose();
    this.neuralTex(Rp, H4);
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, 0, Rp, Rp, 3 * H4, gl.RGBA, gl.FLOAT, data);
    this.nkey = key;
  };

  RP.neuralTex = function (Rp, H4) {        // the planes texture (RGBA16F, hardware bilinear), bound for an upload
    const gl = this.gl;
    if (!this.ntex || this.ntexR !== Rp) {
      if (this.ntex) gl.deleteTexture(this.ntex);
      this.ntex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.ntex);
      gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA16F, Rp, Rp, 3 * H4);
      for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D_ARRAY, p, gl.LINEAR);
      for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D_ARRAY, p, gl.CLAMP_TO_EDGE);
      this.ntexR = Rp;
    }
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.ntex); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  };

  RP.neuralPlanesBig = async function (P, key, gen) {     // WebGL backend: float32 read back slice by slice too
    const gl = this.gl, Rp = P.shape[1], H4 = P.shape[3] / 4, layers = 3 * H4, layer = 4 * Rp * Rp;
    this.nkey = null;                                    // the texture is about to change under the old key
    let data = null, done = null, t = null, ty = gl.FLOAT;
    if (tf.getBackend() === 'webgpu') { ({ data, done } = await this.halfPlanes(P)); ty = gl.HALF_FLOAT; }
    else t = tf.tidy(() => tf.reshape(tf.transpose(tf.reshape(P, [3, Rp, Rp, H4, 4]), [0, 3, 1, 2, 4]), [layers, Rp, Rp, 4]));
    try {
      const per = Math.max(1, Math.floor(8 * 2 ** 20 / (layer * (ty === gl.FLOAT ? 4 : 2))));   // ~8 MB a frame
      for (let z = 0; z < layers && gen === this.ngen; z += per) {
        const n = Math.min(per, layers - z);
        if (z) await nextFrame();
        let d = data, off = z * layer;
        if (t) { const s = tf.slice(t, [z, 0, 0, 0], [n, Rp, Rp, 4]); d = await s.data(); s.dispose(); off = 0; }
        if (gen !== this.ngen) break;
        this.neuralTex(Rp, H4);
        gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, z, Rp, Rp, n, gl.RGBA, ty, d, off);
      }
    } finally { if (done) done(); if (t) t.dispose(); }
    if (gen === this.ngen) this.nkey = key;
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

  // ?check: the per-pixel field at the points x_i = -1 + 2i/(R-1) of the reference grid, from planes P exactly as the
  // tracing shader sees them (RGBA16F texture, hardware bilinear) -> { neuralErr: mean |sdf - the PyTorch ref|,
  // neuralVsTfjs: max |sdf, rgb - the TF.js grid gt of the same planes| (rgb at every 2nd point, as the grid decodes it) }
  RP.neuralCheck = async function (P, ref, gt) {
    const gl = this.gl, R = ref.R, n = R * R * R;
    await this.neuralPlanes(P, null);                    // tagged with no volume's key: never drawn
    if (!this.nprobe) {
      gl.getExtension('EXT_color_buffer_float');
      const q = this.nprobe = M.glProg(gl, `#version 300 es
  precision highp float; precision highp int;${this.ndecl}
  uniform int uLayer, uR; out vec4 o;
  void main() { o = field(-1.0 + 2.0 * vec3(float(uLayer), floor(gl_FragCoord.yx)) / float(uR - 1)); }`);
      this.nnames.forEach((name, i) => gl.uniformBlockBinding(q.p, gl.getUniformBlockIndex(q.p, name), BIND + i));
    }
    const q = this.nprobe, tex = gl.createTexture(), fbo = gl.createFramebuffer(), f = new Float32Array(4 * n), px = new Float32Array(4 * R * R);
    gl.bindTexture(gl.TEXTURE_2D, tex); gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, R, R);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindVertexArray(this.vao); gl.useProgram(q.p); gl.disable(gl.BLEND); gl.viewport(0, 0, R, R);
    this.bindNeural(q); gl.uniform1i(q.u.uR, R);
    for (let i = 0; i < R; i++) {                        // layer i = x, pixel (z, y)
      gl.uniform1i(q.u.uLayer, i); gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.readPixels(0, 0, R, R, gl.RGBA, gl.FLOAT, px); f.set(px, 4 * R * R * i);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.deleteFramebuffer(fbo); gl.deleteTexture(tex);
    let e = 0, m = 0;
    const L = this.far, cl = (v) => Math.max(-L, Math.min(L, v));   // the field as traced (m3d-render.js: meta.trunc)
    for (let x = 0; x < n; x++) { e += Math.abs(cl(f[4 * x]) - cl(ref.sdf[x])); m = Math.max(m, Math.abs(cl(f[4 * x]) - cl(gt.sdf[x]))); }
    const Rc = (R + 1) >> 1;
    for (let i = 0; i < R; i += 2) for (let j = 0; j < R; j += 2) for (let k = 0; k < R; k += 2) {
      const x = (i * R + j) * R + k, c = (((i >> 1) * Rc + (j >> 1)) * Rc + (k >> 1)) * 3;
      for (let ch = 0; ch < 3; ch++) m = Math.max(m, Math.abs(f[4 * x + 1 + ch] - gt.rgb[c + ch]));
    }
    return { neuralErr: e / n, neuralVsTfjs: m };
  };
})(window.M3D = window.M3D || {});
