// The classical-piano transformer (trained offline on MAESTRO, see /Volumes/LaCie/pixel-morph-music/
// work/train_perf.py), running through the *same* TF.js runtime the visual decoder already loaded --
// unlike the tiny Phase-2 GRU, this model (~5M params, a 512-token causal self-attention window every
// step) needs GPU matmuls to run in real time; a hand-rolled scalar JS loop would take seconds per
// step. `tf` is the global the page's own <script src=".../tf-core...">+ backend already set up.
//
// Token vocabulary (must match work/perf_tokens.py): 0..87 NOTE_ON pitch 21..108, 88..175 NOTE_OFF
// pitch 21..108, 176..275 TIME_SHIFT bucket 0..99 (10ms each), 276..307 VELOCITY bucket 0..31.

export const NOTE_ON_BASE = 0, PITCH_LO = 21, PITCH_HI = 108, N_PITCH = 88;
export const NOTE_OFF_BASE = 88;
export const TIME_SHIFT_BASE = 176, N_TIME_BUCKETS = 100, TIME_BUCKET_MS = 10;
export const VELOCITY_BASE = 276, N_VEL_BUCKETS = 32;
export const VOCAB_SIZE = 308;

function f16(h) {
  const e = (h >> 10) & 0x1f, m = h & 0x3ff, s = h & 0x8000 ? -1 : 1;
  return e === 0 ? s * m * 5.960464477539063e-8 : e === 31 ? (m ? NaN : s * Infinity) : s * (1 + m / 1024) * Math.pow(2, e - 15);
}

async function unpackGz(buf) {
  const b = new Uint8Array(buf, 0, 2);
  if (b[0] !== 0x1f || b[1] !== 0x8b) return buf;
  return new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
}

export async function loadPianoModel(baseUrl = 'audio/') {
  const tf = window.tf;
  const meta = await fetch(baseUrl + 'piano-transformer.meta.json').then((r) => r.json());
  const gz = await fetch(baseUrl + 'piano-transformer.bin.gz').then((r) => r.arrayBuffer());
  const buf = await unpackGz(gz);

  function tensor(name, shape) {
    const { offset } = meta.tensors[name], n = shape.reduce((a, b) => a * b, 1);
    const raw = new Uint16Array(buf, offset, n), out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = f16(raw[i]);
    return shape.length === 1 ? tf.tensor1d(out) : tf.tensor2d(out, shape);
  }

  const D = meta.dModel, H = meta.nHeads, VOCAB = meta.vocab, CONTEXT = meta.context;
  const t = (name, shape) => tensor(name, shape);
  const W = {
    tokEmb: t('tok_emb.weight', [VOCAB, D]),
    posEmb: t('pos_emb.weight', [CONTEXT, D]),
    lnF: { w: t('ln_f.weight', [D]), b: t('ln_f.bias', [D]) },
    head: { w: t('head.weight', [VOCAB, D]), b: t('head.bias', [VOCAB]) },
    blocks: [],
  };
  for (let i = 0; i < meta.nLayers; i++) {
    const p = `blocks.${i}.`;
    W.blocks.push({
      ln1: { w: t(p + 'ln1.weight', [D]), b: t(p + 'ln1.bias', [D]) },
      q: { w: t(p + 'q.weight', [D, D]), b: t(p + 'q.bias', [D]) },
      k: { w: t(p + 'k.weight', [D, D]), b: t(p + 'k.bias', [D]) },
      v: { w: t(p + 'v.weight', [D, D]), b: t(p + 'v.bias', [D]) },
      proj: { w: t(p + 'proj.weight', [D, D]), b: t(p + 'proj.bias', [D]) },
      ln2: { w: t(p + 'ln2.weight', [D]), b: t(p + 'ln2.bias', [D]) },
      fc1: { w: t(p + 'fc1.weight', [meta.dFF, D]), b: t(p + 'fc1.bias', [meta.dFF]) },
      fc2: { w: t(p + 'fc2.weight', [D, meta.dFF]), b: t(p + 'fc2.bias', [D]) },
    });
  }

  const maskCache = new Map();
  function causalMask(T) {
    let m = maskCache.get(T);
    if (m) return m;
    const data = new Float32Array(T * T);
    for (let i = 0; i < T; i++) for (let j = 0; j < T; j++) data[i * T + j] = j > i ? -1e9 : 0;
    // causalMask() is called from inside forwardLastLogits's tf.tidy() -- without tf.keep(), tidy
    // disposes this the moment that call returns, and the *next* call with the same T (every call
    // once the context window fills to a constant length) reuses an already-disposed tensor, which
    // fails deep inside the backend (e.g. "Cannot read properties of undefined (reading 'backend')")
    // rather than at the point of misuse. Caught by calling logits() repeatedly with the same context
    // length, which the very first hand-off to a browser test happened not to do.
    m = tf.keep(tf.tensor2d(data, [T, T]));
    maskCache.set(T, m);
    return m;
  }

  const linear = (x, l) => tf.add(tf.matMul(x, l.w, false, true), l.b); // x:[T,in], w:[out,in] (PyTorch nn.Linear layout)
  function layerNorm(x, l, eps = 1e-5) {
    const { mean, variance } = tf.moments(x, -1, true);
    return tf.add(tf.mul(tf.div(tf.sub(x, mean), tf.sqrt(tf.add(variance, eps))), l.w), l.b);
  }
  function gelu(x) {
    const c = Math.sqrt(2 / Math.PI);
    const inner = tf.mul(c, tf.add(x, tf.mul(0.044715, tf.pow(x, 3))));
    return tf.mul(0.5, tf.mul(x, tf.add(1, tf.tanh(inner))));
  }
  function selfAttention(x, blk, T) {
    const hd = D / H;
    const split = (lin) => tf.transpose(tf.reshape(linear(x, lin), [T, H, hd]), [1, 0, 2]); // [H,T,hd]
    const qh = split(blk.q), kh = split(blk.k), vh = split(blk.v);
    const scores = tf.div(tf.matMul(qh, kh, false, true), Math.sqrt(hd)); // [H,T,T]
    const weights = tf.softmax(tf.add(scores, causalMask(T)), -1);
    const merged = tf.reshape(tf.transpose(tf.matMul(weights, vh), [1, 0, 2]), [T, D]); // [T,D]
    return linear(merged, blk.proj);
  }

  // Returns logits [VOCAB] for the next token after `tokenIds` (a plain JS array, length <= CONTEXT).
  // Always runs on a fixed CONTEXT-length window (right-padded) and reads position n-1: under the causal mask
  // padding after n-1 cannot change it, and a single shape means one cached mask and one set of compiled
  // shaders. A growing length kept a new T x T mask per step (~180 MB by T=512) and recompiled shaders on the
  // GPU the visual decoder shares, until the page stepped its resolution down and finally lost the device.
  function forwardLastLogits(tokenIds) {
    return tf.tidy(() => {
      const n = tokenIds.length, T = CONTEXT;
      const idx = tf.tensor1d(n < T ? tokenIds.concat(new Array(T - n).fill(0)) : tokenIds, 'int32');
      let x = tf.add(tf.gather(W.tokEmb, idx), tf.slice(W.posEmb, [0, 0], [T, D]));
      for (const blk of W.blocks) {
        x = tf.add(x, selfAttention(layerNorm(x, blk.ln1), blk, T));
        const ff = linear(gelu(linear(layerNorm(x, blk.ln2), blk.fc1)), blk.fc2);
        x = tf.add(x, ff);
      }
      const logitsAll = linear(layerNorm(x, W.lnF), W.head); // [T,VOCAB]
      return tf.reshape(tf.slice(logitsAll, [n - 1, 0], [1, VOCAB]), [VOCAB]);
    });
  }

  return {
    context: CONTEXT,
    step: meta.step,
    // Raw next-token logits for a fixed input -- a debug/verification hook (used to numerically check
    // this port against the PyTorch reference), not needed for normal generation.
    async logits(tokenIds) {
      const logitsT = forwardLastLogits(tokenIds);
      const out = await logitsT.data();
      logitsT.dispose();
      return out;
    },
    async sampleNext(tokenIds, { temperature = 0.95, topK = 24 } = {}) {
      const logits = await this.logits(tokenIds);
      const idxs = Array.from({ length: logits.length }, (_, i) => i).sort((a, b) => logits[b] - logits[a]).slice(0, topK);
      let max = -Infinity; for (const i of idxs) if (logits[i] > max) max = logits[i];
      let sum = 0; const probs = idxs.map((i) => { const p = Math.exp((logits[i] - max) / temperature); sum += p; return p; });
      let r = Math.random() * sum, acc = 0;
      for (let n = 0; n < idxs.length; n++) { acc += probs[n]; if (r <= acc) return idxs[n]; }
      return idxs[idxs.length - 1];
    },
  };
}
