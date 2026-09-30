// Morph 3D text: the find box understands descriptions ("a red sports car", "something with wings"). The CLIP text tower
// (OpenCLIP ViT-B/32 laion2b, weight-only 8-bit ONNX, ~66 MB, in clip-laion-b32/; transformers.js on WASM, loaded on first
// use) embeds the query; objects are ranked by cosine against model/clip.bin -- CLIP image embeddings of their DECODED
// renders from the same CLIP (research/text3d: class-name search top-1 75.5 %, top-5 93.9 %). The text generator will
// condition on the same embedding.
(function (M) {
  'use strict';
  const TJS = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0/dist/transformers.min.js';
  const ENCODER = 'clip-laion-b32';

  const half = (u16) => {                  // IEEE fp16 -> float32
    const out = new Float32Array(u16.length);
    for (let i = 0; i < u16.length; i++) {
      const h = u16[i], s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 31, f = h & 1023;
      out[i] = s * (e === 0 ? f * 2 ** -24 : e === 31 ? (f ? NaN : Infinity) : (1 + f / 1024) * 2 ** (e - 15));
    }
    return out;
  };

  M.Text = class {
    constructor(dir, meta) {                // meta.clip = {file, n, dim}
      this.dir = dir; this.meta = meta; this.clip = meta.clip; this.enc = null; this.tab = null;
    }

    table() {                               // anchor image embeddings [n x dim], unit length
      return this.tab || (this.tab = fetch(`${this.dir}/${this.clip.file}`).then((r) => {
        if (!r.ok) throw new Error(`${this.clip.file}: ${r.status}`);
        return r.arrayBuffer();
      }).then((b) => half(new Uint16Array(b))));
    }

    encoder() {                             // {tok, model}, loaded once (the ~66 MB model downloads on first use)
      return this.enc || (this.enc = (async () => {
        const T = await import(TJS);                 // this site is the model hub: <page folder>/<model>/<file> (plain
        T.env.allowLocalModels = false; T.env.allowRemoteModels = true;   // fetches, cached by the browser; transformers.js
        T.env.remoteHost = new URL('./', location.href).href;            // 4's local-model path never fetched here)
        T.env.remotePathTemplate = '{model}/';
        const tok = await T.AutoTokenizer.from_pretrained(ENCODER);        // one after the other: concurrent loads of
        const model = await T.CLIPTextModelWithProjection.from_pretrained(ENCODER, { dtype: 'q8', device: 'wasm' });
        return { tok, model };                                              // the same folder race in transformers.js 4
      })().catch((e) => { this.enc = null; throw e; }));
    }

    async embed(text) {                     // -> unit-length Float32Array(dim)
      const { tok, model } = await this.encoder();
      const { text_embeds: t } = await model(tok([text], { padding: true, truncation: true }));
      const v = Float32Array.from(t.data);
      const n = Math.hypot(...v) || 1;
      return v.map((x) => x / n);
    }

    // -> [{i, score}] best first: every object, cosine of the query to its decoded render
    async search(text) {
      const [q, tab] = await Promise.all([this.embed(`a 3D render of ${text}`), this.table()]);
      const d = this.clip.dim, n = tab.length / d, out = [];
      for (let i = 0; i < n; i++) {
        let s = 0;
        for (let k = 0; k < d; k++) s += q[k] * tab[i * d + k];
        out.push({ i, score: s });
      }
      return out.sort((a, b) => b.score - a.score);
    }
  };
})(window.M3D = window.M3D || {});
