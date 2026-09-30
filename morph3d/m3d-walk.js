// Morph 3D walks: where the page is in latent space at walk time tau. A walk is a chain of segments on the tau clock;
// each segment maps tau to a spec {terms: [[anchor, w]], key, still, label, rate, xy, top}, w a number or a
// Float32Array(3·L·L) weight per latent cell. Blends, height sweeps, chimeras and mixes of them are all linear in the
// anchors, so every spec is a term list that model.compose() turns into one latent.
// Partners come from the decoded-shape neighbours in map.json (sknn/siou). Measured offline on the shipped model
// (work/m3d_walkeval.py, 64^3, 32 pairs): blending shape neighbours keeps midpoints whole (thin 0.97, debris 0.03),
// latent-L2 neighbours collapse (thin p10 0.05), a bottom-up height sweep halves the debris again; replaying these
// walks (test/walk_trace.js + m3d_walkeval.py replay) keeps them at the real objects' own debris level.
(function (M) {
  'use strict';
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const ease = (x) => x * x * x * (x * (6 * x - 15) + 10);
  const dease = (x) => 30 * x * x * (x - 1) * (x - 1);

  M.WALKS = {
    drift: 'rests on a real object, then morphs into one of the most similar shapes',
    tour: 'a new, related class every stop: it grows up from the floor through the old one',
    dream: 'never stops: a slowly changing mix of similar objects, shapes that are not in the data',
    voyage: 'a journey to a distant class through the shapes in between',
    hybrid: 'objects that never existed: the top of one standing on the bottom of another',
    random: 'anywhere in the space: the raw straight path between two unrelated objects',
  };
  M.isWalk = (k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(M.WALKS, k);
  const TIMES = { drift: [2.0, 3.6, 'blend'], tour: [2.4, 4.0, 'sweep'], random: [2.4, 3.2, 'blend'] };

  // ---- per-cell weight fields (height_weight / spatial_w of m3d_walkeval.py, so its numbers hold here) ----
  function hashF(f) { let h = 2166136261; for (let x = 0; x < f.length; x++) { h ^= Math.round(f[x] * 1e4); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }
  function field(W) { let m = 0; for (let x = 0; x < W.length; x++) m += W[x]; W.mean = m / W.length; W.tag = 'h' + hashF(W); return W; }
  function fromHeight(wy, L) {
    const W = new Float32Array(3 * L * L);
    let m = 0; for (let k = 0; k < L; k++) m += wy[k] / L;
    for (let h = 0; h < L; h++) for (let w = 0; w < L; w++) {
      W[h * L + w] = wy[w]; W[L * L + h * L + w] = m; W[2 * L * L + h * L + w] = wy[h];   // Pxy: y = w axis, Pxz: none, Pyz: y = h axis
    }
    return field(W);
  }
  function sweepField(t, L, band = 0.35) {
    const wy = new Float32Array(L), f = -1 - band + t * (2 + 2 * band);
    for (let k = 0; k < L; k++) { const x = clamp((f - (-1 + 2 * k / (L - 1))) / (2 * band) + 0.5, 0, 1); wy[k] = x * x * (3 - 2 * x); }
    return fromHeight(wy, L);
  }
  function lowerField(L) { const wy = new Float32Array(L); for (let k = 0; k < L; k++) wy[k] = -1 + 2 * k / (L - 1) < 0 ? 1 : 0; return fromHeight(wy, L); }
  function comp(W) { const C = new Float32Array(W.length); for (let x = 0; x < W.length; x++) C[x] = 1 - W[x]; return field(C); }
  const isF = (w) => typeof w !== 'number';

  // weighted sum of specs; a weight may itself be a field (then it multiplies cell by cell). Terms whose weight is
  // below eps everywhere are dropped and constant fields fold into numbers, so repeated retargets stay small.
  function lin(parts, eps = 1e-4) {
    const acc = new Map();
    for (const [sp, c] of parts) {
      if (c === 0) continue;
      for (const [i, w] of sp.terms) {
        let e = acc.get(i); if (!e) acc.set(i, (e = { s: 0, f: null }));
        if (!isF(w) && !isF(c)) { e.s += c * w; continue; }
        const n = isF(w) ? w.length : c.length;
        if (!e.f) e.f = new Float32Array(n);
        for (let x = 0; x < n; x++) e.f[x] += (isF(c) ? c[x] : c) * (isF(w) ? w[x] : w);
      }
    }
    const terms = [];
    for (const [i, e] of acc) {
      if (e.f) {
        let lo = Infinity, hi = -Infinity;
        for (let x = 0; x < e.f.length; x++) { e.f[x] += e.s; if (e.f[x] < lo) lo = e.f[x]; if (e.f[x] > hi) hi = e.f[x]; }
        if (Math.max(Math.abs(lo), Math.abs(hi)) < eps) continue;
        if (hi - lo < 1e-6) terms.push([i, (hi + lo) / 2]); else terms.push([i, field(e.f)]);
      } else if (Math.abs(e.s) >= eps) terms.push([i, e.s]);
    }
    return { terms };
  }
  const one = (i) => ({ terms: [[i, 1]] });

  M.Walker = class {
    constructor(model, meta, map, o) {
      Object.assign(this, { model, meta, map, rnd: o.rnd, L: meta.lat });
      this.cls = meta.anchors.map((a) => a.cls); this.lab = meta.anchors.map((a) => a.label);
      const ci = new Map(meta.classes.map((c, k) => [c, k]));
      this.ci = this.cls.map((c) => ci.get(c));
      this.members = meta.classes.map(() => []); this.ci.forEach((k, i) => this.members[k].push(i));
      this.sk = map.sknn || map.knn; this.si = map.siou || null;
      this.mode = M.isWalk(o.mode) ? o.mode : 'drift';
      this.trans = o.trans === 'blend' || o.trans === 'sweep' ? o.trans : null;   // ?trans= override
      this.only = o.only || null;                   // Set of class names (?cls=)
      this.reduced = !!o.reduced;
      this.segs = []; this.tEnd = 0; this.gen = 0; this.waits = 0;
      this.cur = o.start; this.recent = [o.start]; this.recentCls = [this.cls[o.start]]; this.shown = [];
      this.lower = lowerField(this.L); this.blend = null; this.skipHold = false; this.held = false;
      this.dream = null; this.hyb = null; this.voy = null; this.steerAt = null; this.steerSpec = null;
    }
    R() { return this.reduced ? [3, 2] : [1, 1]; }  // hold and morph factors under prefers-reduced-motion

    // ---- candidates ----
    ok(i) { return this.model.loaded(i) && (!this.only || this.only.has(this.cls[i])); }
    nb(i) {
      const s = this.sk[i] || [], w = this.si && this.si[i];
      return s.map((j, k) => ({ j, s: w ? w[k] : 1 - k / s.length })).filter((e) => e.j !== i && this.ok(e.j));
    }
    fresh(list) { const r = new Set(this.recent.slice(-24)); const f = list.filter((e) => !r.has(e.j)); return f.length ? f : list; }
    pick(list, k) { list = list.slice(0, k); return list.length ? list[Math.floor(this.rnd() * list.length)].j : null; }
    anyLoaded(except) {
      const r = new Set(this.recent.slice(-24)), p = [], q = [];
      for (let i = 0; i < this.cls.length; i++) if (i !== except && this.ok(i)) (r.has(i) ? q : p).push(i);
      const pool = p.length ? p : q;
      return pool.length ? pool[Math.floor(this.rnd() * pool.length)] : except;
    }
    related(i, avoid) {                             // a loaded object of a class close by class_sim (shape of class means)
      const row = this.meta.class_sim[this.ci[i]], ks = row.map((v, k) => [v, k]).sort((a, b) => b[0] - a[0]);
      const top = ks.filter(([, k]) => k !== this.ci[i] && !avoid.has(this.meta.classes[k])).slice(0, 6);
      for (let n = top.length; n > 0; n--) {
        const [, k] = top.splice(Math.floor(this.rnd() * n), 1)[0], m = this.members[k].filter((j) => this.ok(j));
        if (m.length) return m[Math.floor(this.rnd() * m.length)];
      }
      return this.anyLoaded(i);
    }
    // null = no good partner loaded yet: the caller rests a little longer (anchors stream in after the first frame)
    partner(i, mode) {
      if (mode === 'random') return this.anyLoaded(i);
      const nb = this.fresh(this.nb(i)), wait = this.streaming();
      let n = null;
      if (mode === 'tour') {
        const rc = new Set(this.recentCls.slice(-8)), c = this.cls[i];
        const other = nb.filter((e) => this.cls[e.j] !== c && !rc.has(this.cls[e.j]));
        n = other.length ? this.pick(other, 3) : wait ? null : this.related(i, rc);
      } else n = nb.length ? this.pick(nb, 4) : wait ? null : this.anyLoaded(i);
      if (n === null) this.waits++; else this.waits = 0;
      return n === i ? null : n;
    }
    // anchors are still streaming in (the app clears model.streaming once every chunk has loaded or given up)
    streaming() { return this.model.streaming !== false && this.model.nLoaded < this.cls.length && this.waits < 6; }
    add(i, cls, label, nbs) {                       // a created object (m3d-create.js) joins: its class, label, neighbours
      this.cls[i] = cls; this.lab[i] = label; this.ci[i] = this.meta.classes.indexOf(cls); this.members[this.ci[i]].push(i);
      this.sk[i] = nbs.slice(); if (this.si) this.si[i] = nbs.map(() => 0.5);   // its shape IoU is unknown: a middling edge
      this.adj = null;                              // routes are rebuilt with its edges
    }
    visit(i) {
      this.cur = i; this.recent.push(i); this.recentCls.push(this.cls[i]);
      for (const a of [this.recent, this.recentCls]) if (a.length > 64) a.shift();
    }
    // the app: a hold keyframe (spec sp, walk time tau) is on screen. The history keeps the shapes actually shown
    // (a chimera stays a chimera); keyframes kept from before the latest retarget are ignored (they would push back
    // the shape that back() just left).
    reached(sp, tau) {
      if (this.blend && tau <= this.blend.t0) return;
      const h = this.shown, last = h[h.length - 1];
      if (!last || last.key !== sp.key) { h.push({ key: sp.key, dom: sp.dom, terms: sp.terms, label: sp.label, hyb: sp.hyb || null }); if (h.length > 64) h.shift(); }
      if (sp.key === this.backTo) this.backTo = null;
    }

    // ---- segments ----
    push(dur, kind, f) { const s = { t0: this.tEnd, t1: this.tEnd + dur, kind, f }; this.segs.push(s); this.tEnd = s.t1; return s; }
    hold(spec, dur, label, extra) { const sp = this.finish({ ...spec, still: true, rate: 0, label, ...extra }); this.push(dur, 'hold', () => sp); }
    move(A, B, dur, how, label, extra) {
      const t0 = this.tEnd;
      this.push(dur, how, (tau) => {
        const x = clamp((tau - t0) / dur, 0, 1), e = ease(x);
        const sp = how === 'sweep' ? (() => { const W = sweepField(e, this.L); return lin([[A, comp(W)], [B, W]]); })() : lin([[A, 1 - e], [B, e]]);
        return this.finish(Object.assign(sp, { still: false, rate: dease(x) / dur, prog: x, label, ...extra }));
      });
    }
    finish(sp) {
      let key = '', x = 0, y = 0, tw = 0; const top = [];
      for (const [i, w] of sp.terms) {
        const m = isF(w) ? w.mean : w, p = this.map.xy[i];
        key += `${i}:${isF(w) ? w.tag : w.toFixed(3)};`;
        if (m > 0) { x += m * p[0]; y += m * p[1]; tw += m; }
        top.push([i, m]);
      }
      top.sort((a, b) => b[1] - a[1]);
      return Object.assign(sp, { key, xy: tw > 0 ? [x / tw, y / tw] : null, top, dom: sp.domHint ?? (top.length ? top[0][0] : this.cur) });
    }
    segAt(tau) { for (let k = this.segs.length - 1; k >= 0; k--) if (this.segs[k].t0 <= tau) return this.segs[k]; return this.segs[0]; }

    at(tau) {
      let sp;
      if (this.steerAt !== null && tau >= this.steerAt) sp = this.steerSpec;
      else { let guard = 0; while (this.tEnd <= tau && guard++ < 64) this.extend(); sp = this.segAt(tau).f(tau); }
      const b = this.blend;
      if (b && tau >= b.t0 && tau < b.t0 + b.T) {                  // retargets fade in from what was on screen
        const x = (tau - b.t0) / b.T, e = ease(x);
        sp = this.finish(Object.assign(lin([[b.s0, 1 - e], [sp, e]]), { label: sp.label, route: sp.route, still: false, rate: Math.max(sp.rate || 0, dease(x) / b.T), prog: sp.prog, domHint: sp.domHint }));
      }
      return sp;
    }
    prune(tau) { while (this.segs.length > 2 && this.segs[1].t1 < tau - 20) this.segs.shift(); }

    // ---- planning: a rest is planned first and the partner only when the rest ends (about the producer's lead
    // before the morph), so partners come from every anchor that has streamed in by then ----
    restFirst(dur) {
      if (this.skipHold || this.held) { this.skipHold = false; return false; }
      this.hold(one(this.cur), dur, this.lab[this.cur]); this.held = true; return true;
    }
    extend() {
      const R = this.R(), c = this.cur;
      if (this.mode === 'dream') return this.extendDream();
      if (this.mode === 'hybrid') return this.extendHybrid(R);
      if (this.mode === 'voyage') return this.extendVoyage(R);
      const T = TIMES[this.mode];
      if (this.restFirst(T[0] * R[0])) return;
      const n = this.partner(c, this.mode);
      if (n === null) { this.hold(one(c), 0.6, this.lab[c]); this.held = true; return; }
      this.held = false;
      this.move(one(c), one(n), T[1] * R[1], this.trans || T[2], `${this.lab[c]} → ${this.lab[n]}`);
      this.visit(n);
    }

    extendVoyage(R) {
      const c = this.cur;
      if (!this.voy || this.voy.k >= this.voy.path.length - 1) {
        this.voy = null;
        if (this.restFirst(2.4 * R[0])) return;
        const row = this.meta.class_sim[this.ci[c]], rs = new Set(this.recent.slice(-24)), far = [];
        for (let i = 0; i < this.cls.length; i++) if (this.ok(i) && row[this.ci[i]] < 0 && !rs.has(i)) far.push(i);
        const target = far.length ? far[Math.floor(this.rnd() * far.length)] : this.anyLoaded(c);
        const path = target !== c && this.pathTo(c, target, true);
        this.held = false;
        if (!path || path.length < 2) {             // no route yet: one tour step instead
          const n = this.partner(c, 'tour');
          if (n === null) { this.hold(one(c), 0.6, this.lab[c]); this.held = true; return; }
          this.move(one(c), one(n), 3.2 * R[1], 'blend', `${this.lab[c]} → ${this.lab[n]}`);
          return this.visit(n);
        }
        this.voy = { path, k: 0 };
      }
      const p = this.voy.path, a = p[this.voy.k], b = p[this.voy.k + 1];
      this.move(one(a), one(b), 2.8 * R[1], 'blend', `${this.lab[a]} → ${this.lab[b]}`, { route: p });
      this.voy.k++; this.visit(b);
      if (this.voy.k < p.length - 1) this.hold(one(b), 0.6 * R[0], this.lab[b], { route: p });
    }

    chim(top, bot) { return { terms: [[top, comp(this.lower)], [bot, this.lower]] }; }
    hybPartner(i, keep) {                           // a shape neighbour of the replaced part, of a class new to the pair
      const bad = new Set([this.cls[i], this.cls[keep]]), nb = this.fresh(this.nb(i)).filter((e) => !bad.has(this.cls[e.j]) && e.j !== keep);
      if (nb.length) { this.waits = 0; return this.pick(nb, 4); }
      if (this.streaming()) { this.waits++; return null; }        // wait for the neighbours to stream in
      const n = this.anyLoaded(keep); return n === keep || n === i ? null : n;
    }
    extendHybrid(R) {
      const lab = (h) => `${this.lab[h.top]} on ${this.lab[h.bot]}`;
      if (!this.hyb) {                              // enter: a new lower half grows under the current object
        if (this.restFirst(2.0 * R[0])) return;
        const bot = this.hybPartner(this.cur, this.cur);
        if (bot === null) { this.hold(one(this.cur), 0.6, this.lab[this.cur]); this.held = true; return; }
        this.held = false;
        const h = { top: this.cur, bot, flip: true };
        this.move(one(h.top), this.chim(h.top, h.bot), 3.2 * R[1], 'blend', lab(h), { domHint: h.top });
        this.hold(this.chim(h.top, h.bot), 3.0 * R[0], lab(h), { domHint: h.top, hyb: { ...h } });
        this.hyb = h; this.visit(h.bot); this.cur = h.top; return;
      }
      const h = this.hyb, part = h.flip ? 'top' : 'bot', keep = h.flip ? h.bot : h.top, n = this.hybPartner(h[part], keep);
      if (n === null) return this.hold(this.chim(h.top, h.bot), 0.6, lab(h), { domHint: h.top, hyb: { ...h } });
      const nh = { ...h, [part]: n, flip: !h.flip };
      this.move(this.chim(h.top, h.bot), this.chim(nh.top, nh.bot), 3.2 * R[1], 'blend', `${lab(h)} → ${lab(nh)}`, { domHint: nh.top });
      this.hold(this.chim(nh.top, nh.bot), 3.0 * R[0], lab(nh), { domHint: nh.top, hyb: { ...nh } });
      this.hyb = nh; this.visit(nh[part]); this.cur = nh.top;
    }

    // dream: the current object and 3 shape neighbours, each weighted gate · (0.02 + ((1 + mean of 3 slow sines) / 2)^P),
    // normalised. The weights are bounded (at most ~50:1 apart), so one object usually leads while a newcomer, whose
    // gate opens over RAMP seconds, can only grow as fast as its gate (an exponential softmax let a newcomer with a
    // high logit take over within ~60 ms). A leaver's gate closes the same way; it is replaced by a fresh neighbour.
    extendDream() {
      const t0 = this.tEnd, SEG = 1, RAMP = 3, P = 6;
      const newV = (i, born) => ({ i, born, die: Infinity, ph: [0, 1, 2].map(() => this.rnd() * 6.2832) });
      if (!this.dream) {
        const V = [newV(this.cur, -1e9)];
        for (const e of this.fresh(this.nb(this.cur)).slice(0, 3)) { V.push(newV(e.j, t0)); this.recent.push(e.j); }
        this.dream = V; this.dreamOm = [0.13, 0.21, 0.37].map((w) => w * (this.reduced ? 0.5 : 1));
      }
      const V = this.dream.map((v) => ({ ...v })), om = this.dreamOm;
      const gate = (v, tau) => { const a = clamp((tau - v.born) / RAMP, 0, 1), d = clamp((tau - v.die) / RAMP, 0, 1); return (a * a * (3 - 2 * a)) * (1 - d * d * (3 - 2 * d)); };
      const weights = (tau) => {
        const u = V.map((v) => gate(v, tau) * (0.02 + ((1 + om.reduce((s, w, j) => s + Math.sin(w * tau + v.ph[j]), 0) / 3) / 2) ** P));
        const S = u.reduce((a, b) => a + b, 0);
        return S > 0 ? u.map((x) => x / S) : u.map((_, k) => (k === 0 ? 1 : 0));
      };
      const spec = (tau) => {
        const w = weights(tau), w2 = weights(tau + 0.05);
        const sp = this.finish({ terms: V.map((v, k) => [v.i, w[k]]).filter(([, x]) => x > 1e-4), still: false });
        sp.rate = w.reduce((s, x, k) => s + Math.abs(w2[k] - x), 0) / 0.1;
        sp.label = sp.top.filter(([, m]) => m >= 0.15).map(([i]) => this.lab[i]).filter((l, k, a) => a.indexOf(l) === k).join(' · ');
        return sp;
      };
      this.push(SEG, 'dream', spec);
      const t1 = t0 + SEG, w = weights(t1);
      const D = this.dream.filter((v) => !(v.die + RAMP <= t1)).map((v) => ({ ...v }));
      const dom = V[w.indexOf(Math.max(...w))].i;
      const wOf = (v) => w[V.findIndex((u) => u.i === v.i && u.born === v.born)] || 0;
      const alive = D.filter((v) => v.die === Infinity);
      const weak = alive.filter((v) => wOf(v) < 0.03 && t1 - v.born > RAMP && v.i !== dom);
      if (weak.length && alive.length > 2) weak[0].die = t1;
      if (D.filter((v) => v.die === Infinity).length < 4) {
        const have = new Set(D.map((v) => v.i)), n = this.fresh(this.nb(dom)).find((e) => !have.has(e.j));
        if (n) { D.push(newV(n.j, t1)); this.recent.push(n.j); if (this.recent.length > 64) this.recent.shift(); }
      }
      this.dream = D; this.cur = dom;
    }

    // ---- routes over the shape-neighbour graph (edge cost 1 - IoU, recently seen +0.3); strict = respect ?cls= ----
    pathTo(a, b, strict) {
      const N = this.cls.length;
      if (!this.adj) {
        this.adj = Array.from({ length: N }, () => new Map());
        this.sk.forEach((row, i) => row.forEach((j, k) => {
          const c = Math.max(0.05, 1 - (this.si ? this.si[i][k] : 0.5));
          if (!(this.adj[i].get(j) <= c)) { this.adj[i].set(j, c); this.adj[j].set(i, c); }
        }));
      }
      const dist = new Float64Array(N).fill(Infinity), prev = new Int32Array(N).fill(-1), done = new Uint8Array(N), rs = new Set(this.recent.slice(-24));
      const usable = (v) => v === b || (strict ? this.ok(v) : this.model.loaded(v));
      dist[a] = 0;
      for (;;) {
        let u = -1, best = Infinity;
        for (let i = 0; i < N; i++) if (!done[i] && dist[i] < best) { best = dist[i]; u = i; }
        if (u < 0 || u === b) break;
        done[u] = 1;
        for (const [v, c] of this.adj[u]) if (usable(v)) {
          const d = best + c + (rs.has(v) && v !== b ? 0.3 : 0);
          if (d < dist[v]) { dist[v] = d; prev[v] = u; }
        }
      }
      if (!isFinite(dist[b])) return null;
      const p = [b]; while (p[0] !== a) p.unshift(prev[p[0]]);
      return p.length > 10 ? null : p;
    }

    // ---- control: every change fades in from what is on screen at tau ----
    retarget(tau, plan, T = 1.6) {
      const on = this.at(tau), s0 = this.finish(lin([[on, 1]], 1e-3));
      if (on.domHint !== undefined) s0.dom = on.domHint;
      this.steerAt = null; this.steerSpec = null;   // any retarget ends steering (steer() re-arms it afterwards)
      this.segs = this.segs.filter((s) => s.t0 < tau);
      const last = this.segs[this.segs.length - 1]; if (last && last.t1 > tau) last.t1 = tau;
      this.tEnd = tau; this.cur = s0.dom; this.dream = this.hyb = this.voy = null; this.skipHold = false; this.held = false;
      this.s0 = s0; this.backTo = null;
      if (plan) plan.call(this);
      this.blend = { t0: tau, T: T * (this.reduced ? 1.5 : 1), s0 };
      this.gen++;
    }
    setMode(tau, m) { if (M.isWalk(m)) { this.mode = m; this.retarget(tau); } }
    next(tau) {                                     // in hybrid, the next part swap starts from the chimera on screen
      const h = this.mode === 'hybrid' ? this.hyb : null;
      this.retarget(tau, function () { this.skipHold = true; if (h) { this.hyb = h; this.cur = h.top; } });
    }
    // back: resting on X -> the object shown before X; moving -> back to where it came from; pressed again while
    // already heading back -> one more step. disp is the keyframe on screen (what the visitor sees decides).
    backTarget(disp) {
      const h = this.shown; let k = h.length;
      if (disp.still) while (k > 1 && h[k - 1].key === disp.key) k--;
      else if (this.backTo != null && k > 1 && h[k - 1].key === this.backTo) k--;
      const b = h[k - 1];
      return !b || (disp.still && b.key === disp.key) ? null : { b, k };
    }
    canBack(disp) { return !!this.backTarget(disp); }
    back(tau, disp) {
      const t = this.backTarget(disp || this.at(tau)); if (!t) return false;
      const b = t.b; this.shown.length = t.k;
      this.retarget(tau, function () {
        const R = this.R(), shape = { terms: b.terms };
        this.move(this.s0, shape, 2.4 * R[1], 'blend', `${this.lab[this.s0.dom]} → ${b.label}`, { domHint: b.dom });   // from exactly what is on screen
        this.hold(shape, 1.6 * R[0], b.label, { domHint: b.dom, hyb: b.hyb });
        this.cur = b.dom; if (b.hyb) this.hyb = { ...b.hyb }; this.skipHold = true;
      });
      this.backTo = b.key;
      return true;
    }
    travel(tau, target) {                           // map click / find: through similar shapes when a path exists
      if (!this.model.loaded(target)) return;
      this.retarget(tau, function () {
        const R = this.R(), path = (target !== this.cur && this.pathTo(this.cur, target, false)) || [this.cur, target];
        for (let k = 0; k + 1 < path.length; k++) {
          const a = path[k], b = path[k + 1];
          if (a !== b) this.move(one(a), one(b), (path.length > 2 ? 1.8 : 2.4) * R[1], 'blend', `${this.lab[a]} → ${this.lab[b]}`, { route: path });
          this.visit(b);
          if (k + 2 < path.length) this.hold(one(b), 0.4 * R[0], this.lab[b], { route: path });
        }
        this.hold(one(target), 3.0 * R[0], this.lab[target], { route: path });
        this.cur = target; this.skipHold = true;
      }, 1.0);
    }
    steer(tau, terms) {                             // live map steering; the first call fades in from the screen
      const sp = this.finish({ terms, still: false, rate: 0 });
      sp.label = sp.top.filter(([, m]) => m >= 0.2).map(([i]) => this.lab[i]).join(' · ');
      if (this.steerAt === null) { this.retarget(tau, null, 0.4); this.steerAt = tau; }
      this.steerSpec = sp;
    }
    release(tau) {
      const s = this.steerSpec; if (this.steerAt === null || !s) return;
      this.retarget(tau, function () {
        const R = this.R();
        this.hold({ terms: s.terms }, 6 * R[0], s.label);   // you made this shape: hold it (and sharpen it), then walk on
        this.move({ terms: s.terms }, one(s.dom), 1.6 * R[1], 'blend', `${s.label} → ${this.lab[s.dom]}`);
        this.visit(s.dom); this.skipHold = true;
      }, 0.3);
    }
  };
  M.Walker.lin = lin; M.Walker.sweepField = sweepField;
})(window.M3D = window.M3D || {});
