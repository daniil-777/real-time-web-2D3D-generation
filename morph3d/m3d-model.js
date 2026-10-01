// Morph 3D decoder in TensorFlow.js: latent triplane [3, L, L, cz] -> feature planes [3, 4L, 4L, hid] -> dense
// signed-distance + colour grids. Mirrors m3d_model.Decoder op for op (see m3d_export.py for the weight layout).
(function (M) {
  'use strict';
  const H2F = (() => {                       // float16 bit pattern -> float32, as a 64K lookup table
    const t = new Float32Array(65536);
    for (let h = 0; h < 65536; h++) {
      const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 31, m = h & 1023;
      t[h] = e === 0 ? s * m * 5.960464477539063e-8 : e === 31 ? (m ? NaN : s * Infinity) : s * (1 + m / 1024) * 2 ** (e - 15);
    }
    return t;
  })();
  const half = (u16) => { const o = new Float32Array(u16.length); for (let i = 0; i < u16.length; i++) o[i] = H2F[u16[i]]; return o; };

  // hosts that serve .gz with Content-Encoding: gzip hand us the bytes already inflated: check the gzip magic first
  M.gunzip = async (buf) => {
    const u = new Uint8Array(buf);
    if (u[0] !== 0x1f || u[1] !== 0x8b) return u;
    return new Uint8Array(await new Response(new Blob([u]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  };

  M.Model = class {
    constructor(meta, raw) {
      this.meta = meta;
      this.W = {}; this.F = {};
      this.params = 0;
      for (const e of meta.weights) {
        const n = e.shape.reduce((a, b) => a * b, 1);
        let f;
        if (e.dtype === 'f16') f = half(new Uint16Array(raw.buffer, raw.byteOffset + e.offset, n));
        else {
          const q = new Int8Array(raw.buffer, raw.byteOffset + e.offset, n), oc = e.shape[e.shape.length - 1];
          const s = half(new Uint16Array(raw.buffer, raw.byteOffset + e.scale_offset, oc));
          f = new Float32Array(n);
          for (let i = 0; i < n; i++) f[i] = q[i] * s[i % oc];
        }
        this.W[e.name] = tf.tensor(f, e.shape);
        this.F[e.name] = f;                  // CPU copy for the shader paths (no dataSync)
        this.params += n;
      }
      const W = this.W, c0 = meta.dec_ch[0];
      this.inpBias = tf.tidy(() => tf.reshape(tf.add(W['pemb'], W['inp.b']), [3, 1, 1, c0]));   // conv bias + plane embedding
      // anchors stay int8 on the CPU (12.7 MB instead of 50 MB of float32 GPU tensors); each keyframe's latent is
      // composed from them in JS and uploaded as one tensor. Chunks may arrive in any order: slots are fixed by meta.
      this.A = new Array(meta.anchors.length).fill(null);
      this.first = []; let k = 0;
      for (const c of meta.anchor_chunks) { this.first.push(k); k += c.n; }
      this.nLoaded = 0;
      this.perPlane = tf.getBackend() === 'webgl';
    }

    addAnchors(bytes, chunk) {               // concatenated anchors: cz fp16 channel scales + int8 [3, L, L, cz]
      const { cz, lat: L } = this.meta, per = this.meta.anchor_bytes, n = bytes.byteLength / per, a0 = this.first[chunk];
      for (let a = 0; a < n; a++) {
        const o = bytes.byteOffset + a * per;
        if (this.A[a0 + a]) continue;
        this.A[a0 + a] = { s: half(new Uint16Array(bytes.buffer.slice(o, o + 2 * cz))), q: new Int8Array(bytes.buffer, o + 2 * cz, 3 * L * L * cz) };
        this.nLoaded++;
      }
      return n;
    }

    loaded(i) { return !!this.A[i]; }

    // spec.terms: [[anchor, w], ...], w a number or a Float32Array(3·L·L) weight per latent cell -> Float32Array latent
    // [3, L, L, cz] (the TF.js layout). Linear, so walks, sweeps, chimeras and blends of them are all just term lists.
    compose(spec) {
      const { cz, lat: L } = this.meta, n = 3 * L * L * cz, z = new Float32Array(n);   // fresh: TF.js may upload lazily
      for (const [i, w] of spec.terms) {
        const a = this.A[i]; if (!a) throw new Error('anchor ' + i + ' not loaded');
        const q = a.q, s = a.s;
        if (typeof w === 'number') { if (w) for (let x = 0; x < n; x++) z[x] += w * q[x] * s[x % cz]; }
        else for (let c = 0, x = 0; c < 3 * L * L; c++) { const wc = w[c]; for (let k = 0; k < cz; k++, x++) z[x] += wc * q[x] * s[k]; }
      }
      return z;
    }

    tensor(spec) { const { cz, lat: L } = this.meta; return tf.tensor(this.compose(spec), [3, L, L, cz]); }

    conv(x, k, act) {
      const f = (t) => tf.fused.conv2d({ x: t, filter: this.W[k + '.w'], strides: 1, pad: 'same', bias: this.W[k + '.b'], activation: act || 'linear' });
      // WebGL runs convs through im2col; for the 3 big planes at once that texture outgrows GPU limits (256^2: ~450 MB),
      // one plane at a time needs a third
      if (this.perPlane && x.shape[0] === 3 && x.shape[1] >= 128) return tf.concat(tf.split(x, 3, 0).map(f), 0);
      return f(x);
    }

    res(x, k) { return tf.relu(tf.add(x, this.conv(this.conv(x, k + '.c1', 'relu'), k + '.c2'))); }

    exchange(x) {                            // x [3, R, R, C], planes xy (h=x,w=y), xz (h=x,w=z), yz (h=y,w=z)
      const W = this.W, [R, C] = [x.shape[1], x.shape[3]];
      const [xy, xz, yz] = tf.split(x, 3, 0).map((t) => tf.reshape(t, [R, R, C]));
      const mm = (v, k) => tf.matMul(v, W[k]);
      const along = (v, h) => tf.reshape(v, h ? [1, R, 1, C] : [1, 1, R, C]);
      const a = tf.concat([along(mm(tf.mean(xz, 1), 'ex.wa'), 1), along(mm(tf.mean(xy, 1), 'ex.wa'), 1), along(mm(tf.mean(xy, 0), 'ex.wa'), 1)], 0);
      const b = tf.concat([along(mm(tf.mean(yz, 1), 'ex.wb'), 0), along(mm(tf.mean(yz, 0), 'ex.wb'), 0), along(mm(tf.mean(xz, 0), 'ex.wb'), 0)], 0);
      const own = tf.reshape(tf.matMul(tf.reshape(x, [3 * R * R, C]), W['ex.w0']), [3, R, R, C]);
      return tf.add(x, tf.relu(tf.add(tf.add(own, W['ex.b']), tf.add(a, b))));
    }

    planes(z) {                              // z [3, L, L, cz] -> P [3, planes_res, planes_res, hid]
      return tf.tidy(() => {                 // stage i > 0: nearest x2 + conv, residual block on all but the last stage
        const n = this.meta.dec_ch.length;
        let x = tf.relu(tf.add(tf.conv2d(z, this.W['inp.w'], 1, 'same'), this.inpBias));
        x = this.res(this.exchange(x), 'res0');
        for (let i = 1; i < n; i++) {
          const r = 2 * x.shape[1];
          x = this.conv(tf.image.resizeNearestNeighbor(x, [r, r]), 'up' + i, 'relu');
          if (i < n - 1) x = this.res(x, 'res' + i);
        }
        return tf.concat([0, 1, 2].map((p) => this.conv(tf.slice(x, [p, 0, 0, 0], [1, -1, -1, -1]), 'head' + p)), 0);
      });
    }

    // Dense grid x_i = -1 + 2i/(R-1) (same for y, z) -> {sdf [R^3] (x slowest, z fastest), rgb at every 2nd point}.
    async grid(P, R, budget = 6e6) {
      const W = this.W, hid = this.meta.hid;
      const parts = tf.tidy(() => {
        const Pr = R === P.shape[1] ? P : tf.image.resizeBilinear(P, [R, R], true);
        const [pxy, pxz, pyz] = tf.split(Pr, 3, 0);
        const yz = tf.add(pyz, W['b1']);                          // [1, R, R, hid]
        let n = Math.max(2, Math.floor(budget / (R * R * hid))); n -= n % 2;
        const sd = [], cl = [];
        for (let i0 = 0; i0 < R; i0 += n) {
          const m = Math.min(n, R - i0);
          const h = tf.relu(tf.add(tf.add(tf.reshape(tf.slice(pxy, [0, i0, 0, 0], [1, m, R, hid]), [m, R, 1, hid]),
            tf.reshape(tf.slice(pxz, [0, i0, 0, 0], [1, m, R, hid]), [m, 1, R, hid])), yz));
          const h2 = tf.fused.matMul({ a: tf.reshape(h, [m * R * R, hid]), b: W['l2.w'], bias: W['l2.b'], activation: 'relu' });
          const o = tf.reshape(tf.fused.matMul({ a: h2, b: W['l3.w'], bias: W['l3.b'] }), [m, R, R, 4]);
          sd.push(tf.slice(o, [0, 0, 0, 0], [m, R, R, 1]));
          cl.push(tf.stridedSlice(o, [0, 0, 0, 1], [m, R, R, 4], [2, 2, 2, 1]));
        }
        return [tf.concat(sd, 0), tf.concat(cl, 0)];
      });
      const [sdf, rgb] = await Promise.all(parts.map((t) => t.data()));
      const Rc = parts[1].shape[1];
      tf.dispose(parts);
      return { sdf, rgb, R, Rc };
    }

    // this model's per-point field in WGSL: fn field(a, b, c, colour) -> (sdf, r, g, b), a / b / c the offsets of the
    // point's texels in the xy / xz / yz planes, reading P (planes) and Wt (the weights returned alongside)
    gpuField() {
      const hid = this.meta.hid, F = this.F;
      return { CH: hid, weights: Float32Array.from(['b1', 'l2.w', 'l2.b', 'l3.w', 'l3.b'].flatMap((k) => Array.from(F[k]))), code: `
        const H = ${hid}u;                                           // Wt: b1[H] W2[H*H] b2[H] W3[H*4] b3[4]
        fn field(a: u32, b: u32, c: u32, colour: bool) -> vec4<f32> {
          var h: array<f32, ${hid}>;
          for (var n = 0u; n < H; n++) { h[n] = max(P[a + n] + P[b + n] + P[c + n] + Wt[n], 0.0); }
          let w2 = H; let b2 = H + H * H; let w3 = b2 + H; let b3 = w3 + 4u * H;
          var o = vec4<f32>(Wt[b3], Wt[b3 + 1u], Wt[b3 + 2u], Wt[b3 + 3u]);
          for (var m = 0u; m < H; m++) {
            var s = Wt[b2 + m];
            for (var n = 0u; n < H; n++) { s += h[n] * Wt[w2 + n * H + m]; }
            s = max(s, 0.0);
            let q = w3 + m * 4u;
            o += s * vec4<f32>(Wt[q], Wt[q + 1u], Wt[q + 2u], Wt[q + 3u]);
          }
          return o;
        }` };
    }

    // WebGPU fast path: the whole grid as compute dispatches on TensorFlow.js's own device, reading the planes' GPU
    // buffer directly. band = { Rg, tau }: narrow band (MISE-style) -- a dense Rg^3 pass first, then the R^3 grid in 4x4x4
    // bricks where only points whose coarse (trilinear) value lies within tau of the surface run the network; the rest
    // keep the coarse value. tau above sqrt(3) x the coarse spacing keeps every surface (the field is ~1-Lipschitz).
    // band.lim (a meta.trunc export, whose field is not Lipschitz beyond its band): coarse values are read clamped to it.
    async gridGPU(P, R, band) {
      const dev = tf.backend().device, f = this.gpuField(), CH = f.CH;
      if (!this.gp) {
        const wbuf = dev.createBuffer({ size: f.weights.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
        dev.queue.writeBuffer(wbuf, 0, f.weights);
        const code = `
          @group(0) @binding(0) var<storage, read> P: array<f32>;
          @group(0) @binding(1) var<storage, read> Wt: array<f32>;
          @group(0) @binding(2) var<storage, read_write> S: array<f32>;
          @group(0) @binding(3) var<storage, read_write> Cc: array<f32>;
          @group(0) @binding(4) var<uniform> U: vec4<u32>;             // R, colour-grid size, threads, dispatch width
          @group(0) @binding(5) var<storage, read> Co: array<f32>;     // band: the coarse sdf grid
          @group(0) @binding(6) var<uniform> V: vec4<u32>;             // mode (0 dense, 1 band), coarse size, tau bits, lim bits
          const CH = ${CH}u;
          ${f.code}
          @compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3<u32>) {
            let R = U.x; let t = id.y * U.w + id.x;
            if (t >= U.z) { return; }
            var i = t / (R * R); var j = (t / R) % R; var k = t % R;
            if (V.x == 1u) {                                           // one workgroup = one 4x4x4 brick
              let nb = (R + 3u) / 4u; let q = t / 64u; let l = t % 64u;
              i = (q / (nb * nb)) * 4u + l / 16u; j = ((q / nb) % nb) * 4u + (l / 4u) % 4u; k = (q % nb) * 4u + l % 4u;
              if (i >= R || j >= R || k >= R) { return; }
            }
            let g = (i * R + j) * R + k; let even = (i & 1u) == 0u && (j & 1u) == 0u && (k & 1u) == 0u;
            let gc = (((i >> 1u) * U.y + (j >> 1u)) * U.y + (k >> 1u)) * 3u;
            if (V.x == 1u) {                                           // far from the surface: the coarse value
              let Rg = V.y; let s = f32(Rg - 1u) / f32(R - 1u);
              let x = f32(i) * s; let y = f32(j) * s; let z = f32(k) * s;
              let x0 = min(u32(x), Rg - 2u); let y0 = min(u32(y), Rg - 2u); let z0 = min(u32(z), Rg - 2u);
              let fx = x - f32(x0); let fy = y - f32(y0); let fz = z - f32(z0);
              let o0 = (x0 * Rg + y0) * Rg + z0; let o1 = o0 + Rg * Rg; let L = bitcast<f32>(V.w);
              let c000 = clamp(Co[o0], -L, L); let c001 = clamp(Co[o0 + 1u], -L, L);
              let c010 = clamp(Co[o0 + Rg], -L, L); let c011 = clamp(Co[o0 + Rg + 1u], -L, L);
              let c100 = clamp(Co[o1], -L, L); let c101 = clamp(Co[o1 + 1u], -L, L);
              let c110 = clamp(Co[o1 + Rg], -L, L); let c111 = clamp(Co[o1 + Rg + 1u], -L, L);
              let cv = mix(mix(mix(c000, c001, fz), mix(c010, c011, fz), fy), mix(mix(c100, c101, fz), mix(c110, c111, fz), fy), fx);
              if (abs(cv) > bitcast<f32>(V.z)) {
                S[g] = cv;
                if (even) { Cc[gc] = 0.5; Cc[gc + 1u] = 0.5; Cc[gc + 2u] = 0.5; }
                return;
              }
            }
            let o = field((i * R + j) * CH, ((R + i) * R + k) * CH, ((2u * R + j) * R + k) * CH, even);
            S[g] = o.x;
            if (even) { Cc[gc] = o.y; Cc[gc + 1u] = o.z; Cc[gc + 2u] = o.w; }
          }`;
        const pipe = dev.createComputePipeline({ layout: 'auto', compute: { module: dev.createShaderModule({ code }), entryPoint: 'main' } });
        const pack = dev.createComputePipeline({ layout: 'auto', compute: { entryPoint: 'main', module: dev.createShaderModule({ code: `
          @group(0) @binding(0) var<storage, read> A: array<f32>;
          @group(0) @binding(1) var<storage, read_write> B: array<u32>;
          @group(0) @binding(2) var<uniform> U: vec4<u32>;             // count, pairs, dispatch width
          @compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3<u32>) {
            let g = id.y * U.z + id.x;
            if (g >= U.y) { return; }
            let i = 2u * g;
            B[g] = pack2x16float(vec2<f32>(A[i], select(0.0, A[min(i + 1u, U.x - 1u)], i + 1u < U.x)));
          }` }) } });
        this.gp = { pipe, pack, wbuf, bufs: {}, none: dev.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE }) };
      }
      const bufsFor = (r) => {                                         // per-resolution buffers, made once
        if (this.gp.bufs[r]) return this.gp.bufs[r];
        const n = r * r * r, rc = (r + 1) >> 1, nc = rc * rc * rc * 3, mk = (bytes, usage) => dev.createBuffer({ size: bytes, usage });
        const SU = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC, RD = GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST;
        const hs = 4 * Math.ceil(n / 2), hc = 4 * Math.ceil(nc / 2), UU = GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST;
        return (this.gp.bufs[r] = { s: mk(n * 4, GPUBufferUsage.STORAGE), c: mk(nc * 4, GPUBufferUsage.STORAGE), hs: mk(hs, SU), hc: mk(hc, SU),
          rs: mk(hs, RD), rc: mk(hc, RD), u: mk(16, UU), v: mk(16, UU), us: mk(16, UU), uc: mk(16, UU) });
      };
      const Rc = (R + 1) >> 1, n = R * R * R, nc = Rc * Rc * Rc * 3, bf = bufsFor(R), temps = [];
      const enc = dev.createCommandEncoder(), pass = enc.beginComputePass();
      const [tauBits, limBits] = new Uint32Array(new Float32Array([band ? band.tau : 0, (band && band.lim) || 1e4]).buffer);
      const run = (r, b, co) => {                                      // the field kernel over r^3 into b; co: band source
        const Pr = r === P.shape[1] ? P : tf.image.resizeBilinear(P, [r, r], true), src = Pr.dataToGPU();
        temps.push([Pr, src]);
        const nb = (r + 3) >> 2, threads = co ? nb * nb * nb * 64 : r * r * r;
        const groups = Math.ceil(threads / 64), gx = Math.min(groups, 65535), gy = Math.ceil(groups / gx);
        dev.queue.writeBuffer(b.u, 0, new Uint32Array([r, (r + 1) >> 1, threads, gx * 64]));
        dev.queue.writeBuffer(b.v, 0, new Uint32Array([co ? 1 : 0, band ? band.Rg : 0, tauBits, limBits]));
        const bind = dev.createBindGroup({ layout: this.gp.pipe.getBindGroupLayout(0), entries: [
          { binding: 0, resource: { buffer: src.buffer, size: 3 * r * r * CH * 4 } }, { binding: 1, resource: { buffer: this.gp.wbuf } },
          { binding: 2, resource: { buffer: b.s } }, { binding: 3, resource: { buffer: b.c } }, { binding: 4, resource: { buffer: b.u } },
          { binding: 5, resource: { buffer: co || this.gp.none } }, { binding: 6, resource: { buffer: b.v } }] });
        pass.setPipeline(this.gp.pipe); pass.setBindGroup(0, bind); pass.dispatchWorkgroups(gx, gy);
      };
      if (band) { const cb = bufsFor(band.Rg); run(band.Rg, cb, null); run(R, bf, cb.s); } else run(R, bf, null);
      for (const [a, h, u, cnt] of [[bf.s, bf.hs, bf.us, n], [bf.c, bf.hc, bf.uc, nc]]) {      // float32 -> packed float16
        const pairs = Math.ceil(cnt / 2), pg = Math.ceil(pairs / 64), px = Math.min(pg, 65535);
        dev.queue.writeBuffer(u, 0, new Uint32Array([cnt, pairs, px * 64, 0]));
        pass.setPipeline(this.gp.pack);
        pass.setBindGroup(0, dev.createBindGroup({ layout: this.gp.pack.getBindGroupLayout(0), entries: [
          { binding: 0, resource: { buffer: a } }, { binding: 1, resource: { buffer: h } }, { binding: 2, resource: { buffer: u } }] }));
        pass.dispatchWorkgroups(px, Math.ceil(pg / px));
      }
      pass.end();
      enc.copyBufferToBuffer(bf.hs, 0, bf.rs, 0, bf.hs.size); enc.copyBufferToBuffer(bf.hc, 0, bf.rc, 0, bf.hc.size);
      dev.queue.submit([enc.finish()]);
      await Promise.all([bf.rs.mapAsync(GPUMapMode.READ), bf.rc.mapAsync(GPUMapMode.READ)]);
      for (const [Pr, src] of temps) { src.tensorRef.dispose(); if (Pr !== P) Pr.dispose(); }
      // views straight onto the mapped buffers (no 4-11 MB copies): the caller uploads them, then must call done()
      const sdf = new Uint16Array(bf.rs.getMappedRange(), 0, n), rgb = new Uint16Array(bf.rc.getMappedRange(), 0, nc);
      let open = true;
      return { sdf, rgb, R, Rc, half: true, done: () => { if (open) { open = false; bf.rs.unmap(); bf.rc.unmap(); } } };
    }

    static toFloat(g) {                      // for code that reads values (self-check): half grids -> float32 copies
      const f = g.half ? { ...g, sdf: half(g.sdf), rgb: half(g.rgb), half: false, done: null } : g;
      if (g.half && g.done) g.done();
      return f;
    }
  };
})(window.M3D = window.M3D || {});
