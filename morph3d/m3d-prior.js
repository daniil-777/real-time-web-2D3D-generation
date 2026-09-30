// Morph 3D text -> 3D generator: the rectified-flow prior over latents (work/m3d_text.py TriUNet) in TF.js. Plane-shared
// convs (planes batched as [B*3, H, W, C]), Exchange cross-plane mixing, joint attention over the 3 x 8 x 8 tokens,
// adaptive group norm on time + the CLIP text embedding; Euler steps from noise to data with classifier-free guidance
// inside a band of t. Weights: prior.bin.gz (PyTorch layouts, converted here; the big tensors int8 per output channel with
// fp16 scales, the rest fp16) + prior.json (m3d_text.py export).
(function (M) {
  'use strict';

  const half = (u16) => {
    const out = new Float32Array(u16.length);
    for (let i = 0; i < u16.length; i++) {
      const h = u16[i], s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 31, f = h & 1023;
      out[i] = s * (e === 0 ? f * 2 ** -24 : e === 31 ? (f ? NaN : Infinity) : (1 + f / 1024) * 2 ** (e - 15));
    }
    return out;
  };
  const silu = (v) => tf.mul(v, tf.sigmoid(v));
  const int8 = (buf, off0, w, n) => {       // q x scale of its output channel (axis 0 of the PyTorch layout)
    const q = new Int8Array(buf, off0 + w.offset, n), s = half(new Uint16Array(buf, off0 + w.scale_offset, w.shape[0]));
    const per = n / w.shape[0], out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = q[i] * s[(i / per) | 0];
    return out;
  };

  M.Prior = class {
    static async load(dir) {
      const meta = await (await fetch(`${dir}/prior.json`)).json();
      const raw = await M.gunzip(await (await fetch(`${dir}/prior.bin.gz`)).arrayBuffer());
      return new M.Prior(meta, raw, dir);
    }

    constructor(meta, raw, dir) {
      this.meta = meta; this.dir = dir; this.W = {};
      const buf = raw.buffer || raw, off0 = raw.byteOffset || 0;
      for (const w of meta.weights) {
        const n = w.shape.reduce((a, b) => a * b, 1), shape = w.shape;
        const v = w.dtype === 'i8' ? int8(buf, off0, w, n) : half(new Uint16Array(buf, off0 + w.offset, n));
        if (w.name === 'pemb') this.W[w.name] = tf.tensor(v, [1, 3, 1, 1, shape[1]]);        // [3, C0, 1, 1]
        else if (shape.length === 4) this.W[w.name] = tf.tidy(() => tf.transpose(tf.tensor(v, shape), [2, 3, 1, 0]));   // conv -> [kh, kw, ci, co]
        else if (shape.length === 2 && w.name.endsWith('.weight')) this.W[w.name] = tf.tidy(() => tf.transpose(tf.tensor(v, shape)));   // linear -> [in, out]
        else this.W[w.name] = tf.tensor(v, shape);
      }
      this.cz = meta.cz; this.d = meta.d;
      this.mean = tf.tensor(meta.mean.flat(), [3, 1, 1, meta.cz]); this.std = tf.tensor(meta.std.flat(), [3, 1, 1, meta.cz]);
      this.freq = tf.tensor(Array.from({ length: 128 }, (_, k) => 1000 * Math.exp(-Math.log(10000) * k / 128)));
    }

    lin(x, k) { return tf.add(tf.matMul(x, this.W[k + '.weight']), this.W[k + '.bias']); }

    conv(x, k, stride = 1) {                 // PyTorch padding (k - 1) / 2; stride 2 pads explicitly (TF 'same' is asymmetric)
      const W = this.W[k + '.weight'], p = (W.shape[0] - 1) / 2;
      const y = stride > 1 ? tf.conv2d(tf.pad(x, [[0, 0], [p, p], [p, p], [0, 0]]), W, stride, 'valid') : tf.conv2d(x, W, 1, 'same');
      return tf.add(y, this.W[k + '.bias']);
    }

    gn(x, groups, k) {                       // GroupNorm (eps 1e-5); affine when k has weights
      const [N, H, W, C] = x.shape, G = Math.min(groups, C);
      const r = tf.reshape(x, [N, H * W, G, C / G]), { mean, variance } = tf.moments(r, [1, 3], true);
      const y = tf.reshape(tf.div(tf.sub(r, mean), tf.sqrt(tf.add(variance, 1e-5))), [N, H, W, C]);
      return k ? tf.add(tf.mul(y, this.W[k + '.weight']), this.W[k + '.bias']) : y;
    }

    adagn(x, c, k) {                         // c [N, d] -> (1 + a) GN(x) + b
      const C = x.shape[3], [a, b] = tf.split(this.lin(c, k + '.proj'), 2, 1);
      return tf.add(tf.mul(this.gn(x, 32), tf.reshape(tf.add(a, 1), [-1, 1, 1, C])), tf.reshape(b, [-1, 1, 1, C]));
    }

    exchange(x, k) {                         // each plane gets the other planes' axis means (m3d_model.Exchange), batched
      const [B3, R, , C] = x.shape, B = B3 / 3;
      const [W0, Wa, Wb] = tf.split(tf.reshape(this.W[k + '.mix.weight'], [3 * C, C]), 3, 0);
      const [xy, xz, yz] = tf.unstack(tf.reshape(x, [B, 3, R, R, C]), 1);
      const mW = (t) => tf.mean(t, 2), mH = (t) => tf.mean(t, 1);              // [B, R, C]: a function of h / of w
      const mm = (t, m) => tf.reshape(tf.matMul(tf.reshape(t, [B * R, C]), m), [B, R, C]);
      const a = [mm(mW(xz), Wa), mm(mW(xy), Wa), mm(mH(xy), Wa)].map((t) => tf.reshape(t, [B, R, 1, C]));
      const b = [mm(mW(yz), Wb), mm(mH(yz), Wb), mm(mH(xz), Wb)].map((t) => tf.reshape(t, [B, 1, R, C]));
      const own = tf.reshape(tf.matMul(tf.reshape(x, [B3 * R * R, C]), W0), [B3, R, R, C]);
      const ctx = tf.reshape(tf.stack([0, 1, 2].map((p) => tf.add(a[p], b[p])), 1), [B3, R, R, C]);
      // the bias add stays rank 4: TF.js WebGPU adds a 1-D operand under 128 wide through a shared-memory shader that
      // cannot index rank-5 coordinates (WGSL "cannot index type 'vec5'"), which silently drops the whole command batch
      return tf.add(x, tf.relu(tf.add(tf.add(own, ctx), this.W[k + '.mix.bias'])));
    }

    blk(x, c, k) {
      let h = this.conv(silu(this.adagn(x, c, k + '.n1')), k + '.c1');
      h = this.conv(silu(this.adagn(h, c, k + '.n2')), k + '.c2');
      const s = this.W[k + '.skip.weight'] ? this.conv(x, k + '.skip') : x;
      return this.exchange(tf.add(s, h), k + '.ex');
    }

    attn(x, k, heads = 4) {                  // joint self-attention over the 3 x H x W tokens of each latent
      const [B3, H, W, C] = x.shape, B = B3 / 3, T = 3 * H * W, dh = C / heads;
      const t = tf.reshape(this.gn(x, 32, k + '.norm'), [B, T, C]);
      const [q, kk, v] = tf.unstack(tf.transpose(tf.reshape(this.lin(t, k + '.qkv'), [B, T, 3, heads, dh]), [2, 0, 3, 1, 4]), 0);
      const att = tf.softmax(tf.div(tf.matMul(q, kk, false, true), Math.sqrt(dh)));
      const o = tf.reshape(tf.transpose(tf.matMul(att, v), [0, 2, 1, 3]), [B, T, C]);
      return tf.add(x, tf.reshape(this.lin(o, k + '.out'), [B3, H, W, C]));
    }

    // x [B*3, L, L, cz] normalised latents, t: number[] (B), e [B, emb] -> velocity [B*3, L, L, cz]
    forward(x, t, e) {
      const B = e.shape[0], ch = this.meta.ch;
      const a = tf.mul(tf.reshape(tf.tensor(t), [B, 1]), this.freq);
      const tfeat = tf.concat([tf.sin(a), tf.cos(a)], 1);
      const c0 = tf.add(this.lin(silu(this.lin(tfeat, 'temb.0')), 'temb.2'), this.lin(silu(this.lin(e, 'cemb.0')), 'cemb.2'));
      const c = tf.reshape(tf.tile(tf.reshape(c0, [B, 1, this.d]), [1, 3, 1]), [B * 3, this.d]);
      let h = this.conv(x, 'inp');
      const [, R, , C0] = h.shape;
      h = tf.reshape(tf.add(tf.reshape(h, [B, 3, R, R, C0]), this.W.pemb), [B * 3, R, R, C0]);
      const skips = [];
      for (let i = 0; i < ch.length; i++) {
        for (let j = 0; j < 2; j++) { h = this.blk(h, c, `down.${i}.${j}`); skips.push(h); }
        if (i < ch.length - 1) h = this.conv(h, `ds.${i}`, 2);
      }
      h = this.blk(this.attn(this.blk(h, c, 'mid1'), 'attn'), c, 'mid2');
      for (let u = 0; u < ch.length; u++) {
        h = this.blk(tf.concat([h, skips.pop()], 3), c, `up.${u}.0`);
        h = this.blk(tf.concat([h, skips.pop()], 3), c, `up.${u}.1`);
        if (u < ch.length - 1) h = this.conv(tf.image.resizeNearestNeighbor(h, [2 * h.shape[1], 2 * h.shape[2]]), `us.${u}`);
      }
      return this.conv(silu(this.gn(h, 32, 'outn')), 'out');
    }

    schedule(steps) {                        // t from 1 (noise) to 0 (data), shifted towards noise
      const s = this.meta.shift;
      return Array.from({ length: steps + 1 }, (_, i) => { const u = 1 - i / steps; return s * u / (1 + (s - 1) * u); });
    }

    // e: Float32Array(emb), a unit text embedding -> {z: [3, L, L, cz] latent for the decoder, x0: normalised}
    async sample(e, { steps = this.meta.steps, w = this.meta.guidance, noise = null } = {}) {
      const [lo, hi] = this.meta.guidance_band, ts = this.schedule(steps);
      const et = tf.tensor(e, [1, e.length]), e2 = tf.tidy(() => tf.concat([et, tf.reshape(this.W.null, [1, -1])], 0));
      let x = noise ? tf.clone(noise) : tf.randomNormal([3, 32, 32, this.cz]);
      for (let i = 0; i < steps; i++) {
        const nx = tf.tidy(() => {
          let v;
          if (ts[i] >= lo && ts[i] <= hi && w !== 1) {
            const [vc, vu] = tf.split(this.forward(tf.concat([x, x], 0), [ts[i], ts[i]], e2), 2, 0);
            v = tf.add(vu, tf.mul(w, tf.sub(vc, vu)));
          } else v = this.forward(x, [ts[i]], et);
          return tf.add(x, tf.mul(ts[i + 1] - ts[i], v));
        });
        x.dispose(); x = nx;
        if (i % 3 === 2) await tf.nextFrame();               // keep the page responsive
      }
      const z = tf.tidy(() => tf.add(tf.mul(x, this.std), this.mean));
      et.dispose(); e2.dispose();
      return { z, x0: x };
    }
  };
})(window.M3D = window.M3D || {});
