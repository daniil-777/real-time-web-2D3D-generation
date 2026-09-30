// Morph 3D create: a description -> a NEW object. The text prior (m3d-prior.js: a rectified flow over this model's
// latents, conditioned on the CLIP text embedding of m3d-text.js; trained by work/m3d_text.py) samples a latent, which
// joins the walk as an anchor beside the objects the description is closest to, so the page morphs there like to any
// other object. The model declares it: meta.prior = the folder (inside the model folder) of prior.json + prior.bin.gz,
// whose model_sha16 must be this model's checkpoint fingerprint -- a prior only fits the decoder it was trained for.
(function (M) {
  'use strict';
  M.Creator = class {
    constructor(app) { this.app = app; this.dir = `${app.dir}/${app.meta.prior}`; this.P = null; this.ok = null; }

    available() {                           // -> Promise<boolean>: readable, a known format, the same latent space
      return this.ok || (this.ok = fetch(`${this.dir}/prior.json`).then((r) => (r.ok ? r.json() : null)).then((m) => {
        const post = this.app.meta.post, mine = post && post.model && post.model.ckpt_sha16;
        return !!(m && m.format === 'm3d-prior1' && m.cz === this.app.meta.cz && (!m.model_sha16 || m.model_sha16 === mine));
      }).catch(() => false));
    }

    load() { return this.P || (this.P = M.Prior.load(this.dir).catch((e) => { this.P = null; throw e; })); }

    // -> index of the new anchor. seed: a number for a reproducible sample; by default every call is a new variation
    async create(q, { seed = null } = {}) {
      const text = this.app.text, [P, e, hits] = await Promise.all([this.load(), text.embed(q), text.search(q)]);
      const noise = seed === null ? null : tf.randomNormal([3, 32, 32, P.cz], 0, 1, 'float32', seed);
      const { z, x0 } = await P.sample(e, { noise });
      const zf = await z.data();
      for (const t of [z, x0, noise]) if (t) t.dispose();
      return this.add(zf, q, hits);
    }

    // a new anchor: a float model slot (exact: s = 1), meta, walk tables and a map position among its nearest objects
    add(z, q, hits) {
      const { model, meta, walker, map } = this.app, i = meta.anchors.length, label = `✦ ${q}`;
      const near = hits.filter((h) => h.i < i && model.loaded(h.i)).slice(0, 8);
      const cls = near.length ? meta.anchors[near[0].i].cls : meta.anchors[walker.cur].cls;
      model.A[i] = { s: new Float32Array(meta.cz).fill(1), q: z }; model.nLoaded++;
      meta.anchors.push({ cls, label, gen: true });
      const w = near.map((h) => Math.exp((h.score - near[0].score) / 0.02)), tw = w.reduce((a, b) => a + b, 0);
      map.xy.push(near.length ? [0, 1].map((d) => near.reduce((s, h, k) => s + w[k] * map.xy[h.i][d], 0) / tw) : map.xy[walker.cur].slice());
      walker.add(i, cls, label, near.map((h) => h.i));
      return i;
    }
  };
})(window.M3D = window.M3D || {});
