// Morph 3D app: loads the decoder, anchors and latent map, asks the walker (m3d-walk.js) where the walk is at each
// keyframe time, decodes keyframes ahead of the display (coarse grid while moving, fine grid on holds and while paused)
// and hands them to the renderer, which blends the two keyframes around the display time every frame.
(function (M) {
  'use strict';
  const qs = new URLSearchParams(location.search);
  const $ = (id) => document.getElementById(id);
  const st = window.__m3d = { ready: false, errors: [], warnings: [], backend: null, fps: 0, frames: 0, keyHz: 0, decodeMs: 0,
    renderMs: 0, refErr: null, res: 0, resHi: 0, anchors: 0, chunks: 0, label: '', firstFrameMs: null, numTensors: 0, ink: 0,
    style: '', decoderParams: 0, walk: '', speed: 1, restarts: 0, smooth: null, visible: true, steering: false, seed: 0, failed: false };
  const fail = (e) => { console.error(e); st.failed = true; st.errors.push(String((e && e.message) || e)); $('msg').textContent = String((e && e.message) || e); $('msg').hidden = false; };
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  // resume after the frame is presented (a promise resolved in rAF would run the decode setup inside the frame)
  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  const TEST = ['check', 'bench', 'soak'].some((k) => qs.has(k));
  const seed = st.seed = (+qs.get('seed') || (Date.now() % 1e9)) >>> 0;
  const rnd = (() => { let s = seed; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); })();

  function loadScript(src, integrity) {
    return new Promise((ok, no) => { const s = document.createElement('script'); s.src = src; s.integrity = integrity; s.crossOrigin = 'anonymous';
      s.onload = ok; s.onerror = () => no(new Error('could not load ' + src)); document.head.appendChild(s); });
  }
  async function backend() {
    if (window.__tfLoadError || typeof tf === 'undefined') throw new Error(window.__tfLoadError || 'TensorFlow.js did not load');
    const BE = window.__M3D_BE, want = qs.get('backend') || 'auto';
    const known = ['webgpu', 'webgl', 'cpu'].includes(want);
    for (const b of want === 'auto' || !known ? (navigator.gpu ? ['webgpu', 'webgl'] : ['webgl']) : [want]) {
      try { await loadScript(...BE[b]); if (await tf.setBackend(b)) { await tf.ready(); return b; } } catch (e) { console.warn(b, e); }
    }
    await loadScript(...BE.cpu); await tf.setBackend('cpu'); return 'cpu';
  }
  function watchGPU(b) {                                  // a lost device must say so instead of freezing
    try {
      if (b === 'webgpu') tf.backend().device.lost.then((i) => { if (i.reason !== 'destroyed') fail('The GPU device was lost — reload the page'); });
      if (b === 'webgl') tf.backend().gpgpu.gl.canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); fail('The GPU context was lost — reload the page'); });
    } catch (e) { console.warn('gpu watch', e); }
  }
  // lowest occupied grid y (the object rests on the floor), scanned in memory order (x slabs, z contiguous) and only
  // below the best height found so far; hintY (the previous keyframe's floor) bounds the first pass
  function floorOf(g, hintY) {
    const R = g.R, s = g.sdf, half = g.half;
    const scan = (lim) => {
      let b = lim;
      for (let i = 0; i < R; i++) for (let j = 0; j < b; j++) {
        const o = (i * R + j) * R;
        if (half) { for (let k = 0; k < R; k++) if (s[o + k] > 0x8000) { b = j; break; } }   // half: sign bit set, not -0
        else { for (let k = 0; k < R; k++) if (s[o + k] < 0) { b = j; break; } }
      }
      return b;
    };
    const lim = hintY === undefined ? R : clamp(Math.ceil(((hintY + 1.006) / 2) * (R - 1)) + 3, 1, R);
    let b = scan(lim);
    if (b === lim && lim < R) b = scan(R);
    return b < R ? -1 + 2 * b / (R - 1) - 0.006 : -0.9;
  }
  function fallbackMap(meta) {                            // no map.json: classes on a circle, class members as neighbours
    const K = meta.classes.length, ci = meta.anchors.map((a) => meta.classes.indexOf(a.cls));
    const xy = ci.map((k, i) => { const a = 6.2832 * k / K, r = 0.38 + 0.02 * (i % 6); return [0.5 + r * Math.cos(a), 0.5 + r * Math.sin(a)]; });
    const knn = ci.map((k, i) => ci.map((c, j) => (c === k && j !== i ? j : -1)).filter((j) => j >= 0));
    return { xy, knn };
  }

  const num = (k, d, lo, hi) => { const x = parseFloat(qs.get(k)); return Number.isFinite(x) ? clamp(x, lo, hi) : d; };   // validated ?k=

  async function main() {
    const t0 = performance.now();
    $('msg').textContent = 'loading the decoder…';
    const tick = setInterval(() => {                     // byte progress while the files download (the UI starts later)
      const p = window.__M3D_PROG;
      if (st.errors.length || st.firstFrameMs !== null) return clearInterval(tick);
      if (p && p.total && p.got < p.total) $('msg').textContent = `loading the decoder… ${(p.got / 2 ** 20).toFixed(1)} / ${(p.total / 2 ** 20).toFixed(1)} MB`;
    }, 150);
    st.backend = await backend(); watchGPU(st.backend);
    const F = window.__M3D_FETCH, meta = await F.meta;
    const model = M.createModel(meta, await M.gunzip(await F.decoder));       // v1 or v2 runtime, from meta.arch
    model.addAnchors(await M.gunzip(await F.a0), 0);
    const map = (await F.map.catch(() => null)) || fallbackMap(meta);
    st.decoderParams = model.params; st.anchors = model.nLoaded; st.chunks = 1;
    const canvas = $('c'), R3 = new M.Renderer(canvas);
    R3.eps = meta.eps || 0.01;
    R3.setLevels(meta);
    st.level = !!(R3.setPost && R3.setPost(meta));      // meta.post: the calibrated slope-term pass (m3d-level.js)
    const lev = (v) => (st.level ? R3.level(v) : v);
    const paper = qs.get('paper');
    R3.paper = /^[0-9a-f]{6}$/i.test(paper || '') ? [0, 2, 4].map((k) => parseInt(paper.slice(k, k + 2), 16) / 255) : [1, 1, 1];
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); fail('The GPU context was lost — reload the page'); });
    const phone = matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 700;
    const tier = (phone ? { webgpu: [64, 96], webgl: [56, 80], cpu: [32, 48] } : { webgpu: [96, 160], webgl: [80, 128], cpu: [40, 56] })[st.backend];
    let resLo = Math.round(num('res', tier[0], 32, 160)), resHi = Math.round(Math.max(resLo, num('hi', tier[1], 32, 192)));
    const resTop = resLo, LADDER = [48, 56, 64, 80, 96, 128].filter((r) => r <= resTop);
    st.res = resLo; st.resHi = resHi; st.phone = phone;
    const fast = st.backend === 'webgpu' && qs.get('fast') !== '0';
    // HD (?hd=1, the HD button, h): a resting object's grid at 256^3 (WebGPU kernel or WebGL shaders), plus curvature
    // shading (?detail=0..3 sets that on its own). A narrow band runs the network only within tau of the coarse 64^3
    // surface (research/hd256: lossless from tau 0.04, ~15% of the voxels), so 256^3 costs what a dense 160^3 did
    const BAND = { Rg: 64, tau: 0.06 }, hiBase = resHi, band = (R) => (R > 192 ? BAND : null);
    const grid = (P, R) => (fast ? model.gridGPU(P, R, band(R)) : model.grid(P, R));
    const glgrid = st.backend === 'webgl' && qs.get('glgrid') !== '0' && R3.gridInit(model);
    st.fast = fast; st.glgrid = !!glgrid;
    // per-pixel detail (m3d-neural.js): a resting object's surface, normal and colour from the decoder itself -- on with
    // HD and for 256^2-plane models; ?neural=0 / 1 decides alone
    const neural = !!(R3.neuralInit && R3.neuralInit(model)), nflag = qs.get('neural');
    let hd = qs.get('hd') === '1';
    const setHD = (on) => {
      hd = on; st.hd = on;
      resHi = on ? Math.max(hiBase, fast || glgrid ? 256 : hiBase) : hiBase; st.resHi = resHi;
      R3.detail = num('detail', on ? 1 : 0, 0, 3);
      R3.neuralOn = neural && (nflag !== null ? nflag !== '0' : on || meta.planes_res >= 256); st.neural = R3.neuralOn;
    };
    const neuralFor = (vol, spec) => {                   // tag a resting grid; its planes go up to the texture meanwhile
      if (!R3.neuralOn) return;
      vol.nkey = spec.key;
      R3.neuralPlanes(planesFor(spec), spec.key).catch((e) => console.warn('per-pixel detail:', e));
    };
    setHD(hd);

    let pc = null, floorHint;                            // planes of the last latent: a hold's fine grid reuses them
    const planesFor = (spec) => {
      if (pc && pc.key === spec.key) return pc.P;
      const z = model.tensor(spec); let P;
      try { P = model.planes(z); } finally { z.dispose(); }
      if (pc) pc.P.dispose();
      pc = { key: spec.key, P };
      return P;
    };
    const decode = async (spec, R, floorGuess) => {
      const P = planesFor(spec);
      if (glgrid) return lev(await R3.gridVolume(model, P, R, floorGuess, band(R)));   // its exact floor arrives a frame or two later
      const g = await grid(P, R);
      try { const v = R3.volume(g); v.floor = floorHint = floorOf(g, floorHint); return lev(v); } finally { if (g.done) g.done(); }
    };

    if (qs.has('check')) {                               // numeric self-check against the exporter's PyTorch reference
      try {
        const ref = await (await fetch(F.dir + '/ref.json')).json(), z = model.tensor({ terms: [[ref.anchor, 1]] }), P = model.planes(z); z.dispose();
        let g;
        if (glgrid) { const v = await R3.gridVolume(model, P, ref.R); g = { sdf: R3.readVolume(v), rgb: R3.readVolume(v, true) }; R3.release(v); }
        else g = M.Model.toFloat(await grid(P, ref.R));
        const gt = fast || glgrid ? await model.grid(P, ref.R) : g; P.dispose();
        let e = 0, f = 0; for (let i = 0; i < g.sdf.length; i++) { e += Math.abs(g.sdf[i] - ref.sdf[i]); f = Math.max(f, Math.abs(g.sdf[i] - gt.sdf[i])); }
        for (let i = 0; i < g.rgb.length; i++) f = Math.max(f, Math.abs(g.rgb[i] - gt.rgb[i]));
        st.refErr = e / g.sdf.length; st.fastVsTfjs = f;
        const want = ref.rgb_mean_c2 || ref.rgb_mean, mean = [0, 0, 0], n3 = g.rgb.length / 3;   // colour vs PyTorch too
        if (want) { for (let i = 0; i < g.rgb.length; i++) mean[i % 3] += g.rgb[i] / n3; st.rgbErr = Math.max(...mean.map((m, c) => Math.abs(m - want[c]))); }
        if (st.level && ref.sdf_level) {                 // the level pass vs m3d_post.grid_level on the same grid
          const v = R3.level(R3.volume(gt)), lv = R3.readVolume(v); R3.release(v);
          let m = 0; for (let i = 0; i < lv.length; i++) m = Math.max(m, Math.abs(lv[i] - ref.sdf_level[i]));
          st.levelErr = m;
        }
        if (hd && (fast || glgrid)) {                    // the narrow band against the dense 256^3 grid of the same shape
          const z2 = model.tensor({ terms: [[ref.anchor, 1]] }), P2 = model.planes(z2); z2.dispose();
          const sdf = async (R, bd) => {                 // a grid's sdf from this page's fast path, as float32
            if (fast) return M.Model.toFloat(await model.gridGPU(P2, R, bd)).sdf;
            const v = await R3.gridVolume(model, P2, R, undefined, bd), s = R3.readVolume(v); R3.release(v); return s;
          };
          const d = await sdf(256, null), b = await sdf(256, BAND);
          let mism = 0, err = 0;
          for (let i = 0; i < d.length; i++) {
            if ((d[i] < 0) !== (b[i] < 0)) mism++;
            if (Math.abs(d[i]) < 0.01) err = Math.max(err, Math.abs(d[i] - b[i]));
          }
          st.bandMism = mism; st.bandErr = err;
          if (glgrid) {                                  // WebGL: planes resized on the GPU vs by TF.js, a dense 160^3 grid
            R3.gpuResize = false; const t = await sdf(160, null); R3.gpuResize = true; const u = await sdf(160, null);
            let m = 0; for (let i = 0; i < t.length; i++) if (Math.abs(t[i]) < 0.05) m = Math.max(m, Math.abs(t[i] - u[i]));
            st.resizeErr = m;
          }
          P2.dispose();
        }
      } catch (e) { console.warn('no reference', e); }
    }
    if (qs.has('bench')) {
      R3.profile = true;
      const sync = async (t) => { const s = tf.slice(t, [0, 0, 0, 0], [1, 1, 1, 1]); await s.data(); s.dispose(); }, out = {};
      const sizes = [[64], [96], [128], [160]].concat(hd && (fast || glgrid) ? [[256], [256, 'dense']] : []);
      for (let rep = 0; rep < 2; rep++) for (const [R, how] of sizes) {
        const z = model.tensor({ terms: [[0, 1]] }), t1 = performance.now(), P = model.planes(z); z.dispose(); await sync(P);
        const t2 = performance.now(); let v;
        if (glgrid) v = lev(await R3.gridVolume(model, P, R, undefined, how ? null : band(R)));
        else { const g = how ? await model.gridGPU(P, R) : await grid(P, R); v = lev(R3.volume(g)); if (g.done) g.done(); }
        R3.gl.finish(); const t3 = performance.now(); R3.release(v); P.dispose();
        if (glgrid && R3.times) out['gl' + R + (how || '')] = Object.fromEntries(R3.times);
        if (rep) out[R + (how ? how : '')] = { planes: +(t2 - t1).toFixed(1), grid: +(t3 - t2).toFixed(1) };
      }
      st.bench = out; R3.profile = false;
    }

    // one promise per anchor chunk (nothing is fetched twice); a failed chunk is retried 3 times with backoff, and
    // model.streaming turns false once every chunk has loaded or given up (the walker stops waiting for partners)
    const chunkP = [], tries = [];
    const loadChunk = (c) => chunkP[c] || (chunkP[c] = (async () => {
      const r = await fetch(F.dir + '/' + meta.anchor_chunks[c].file); if (!r.ok) throw new Error('chunk ' + c + ' ' + r.status);
      model.addAnchors(await M.gunzip(await r.arrayBuffer()), c); st.anchors = model.nLoaded; st.chunks++;
    })().catch(async (e) => {
      console.warn(e); tries[c] = (tries[c] || 0) + 1;
      if (tries[c] > 3) return;
      await new Promise((r) => setTimeout(r, 1500 * 2 ** tries[c]));
      chunkP[c] = null; return loadChunk(c);
    }));
    model.streaming = true;
    const loadChunks = () => Promise.all(meta.anchor_chunks.map((_, c) => (c ? loadChunk(c) : null))).then(() => { model.streaming = false; });
    const chunkOf = (i) => { let c = 0; while (c + 1 < model.first.length && model.first[c + 1] <= i) c++; return c; };
    const only = qs.get('cls') ? new Set(qs.get('cls').split(',')) : null;
    let start = qs.get('anchor') != null ? clamp(+qs.get('anchor') | 0, 0, meta.anchors.length - 1) : Math.floor(rnd() * model.nLoaded);
    if (qs.has('wait') || only) await loadChunks(); else if (!model.loaded(start)) await loadChunk(chunkOf(start));
    if (!model.loaded(start)) start = 0;
    if (only && !only.has(meta.anchors[start].cls)) { const i = meta.anchors.findIndex((a, k) => only.has(a.cls) && model.loaded(k)); if (i >= 0) start = i; }
    const rm = matchMedia('(prefers-reduced-motion: reduce)');
    const walker = new M.Walker(model, meta, map, { rnd, mode: qs.get('walk') || 'drift', trans: qs.get('trans'), only, reduced: rm.matches, start });
    st.walk = walker.mode;

    // ---- keyframe producer ----
    const queue = [];                                    // {tau, spec, step, R, vol}
    let gen = 0, paused = false, tauDisp = 0, speed = clamp(+qs.get('speed') || 1, 0.25, 3), refineAt = null, last = null, decEma = 0, hiEma = 0;
    const keyTimes = [], busy = [], starve = { morph: 0, hold: 0 };
    st.speed = speed;
    const hold = (v) => { v.ref = (v.ref || 0) + 1; return v; };
    const drop = (v) => { if (v && --v.ref === 0) R3.release(v); };
    const LEAD = st.backend === 'webgpu' ? 0.5 : 0.8;
    const stepAfter = (spec, tau) => {                   // keyframes about 1/24 of a morph apart, never faster than decoding
      const dec = (Math.max(decEma, 8) / 1000) * 1.25 * speed;
      let s = spec.live ? Math.max(dec, 1 / 30) : spec.still ? 0.4 : clamp(Math.max(1 / 24 / Math.max(spec.rate || 0, 1e-3), dec), 1 / 30, 0.4);
      const seg = walker.segAt(tau);
      if (!spec.live && seg && seg.t1 - tau > 1 / 60) s = Math.min(s, seg.t1 - tau);   // land on every segment boundary
      return s;
    };
    async function produceOnce() {
      if (st.failed) return new Promise(() => {});      // stop for good after a fatal error
      if (!st.visible) return nextFrame();
      if (paused) return refine();
      const tail = queue[queue.length - 1], lead = st.steering ? 0.15 : LEAD;
      if (queue.length >= 8 || (tail && tail.tau - tauDisp >= lead)) return nextFrame();
      const g = gen, tau = tail ? Math.max(tail.tau + tail.step, tauDisp) : tauDisp;
      const spec = walker.at(tau), step = stepAfter(spec, tau);
      const R = st.steering ? Math.min(resLo, 64) : spec.still && last && last.key === spec.key ? resHi : resLo;
      if (last && last.key === spec.key && last.R >= R) { queue.push({ tau, spec, step, R: last.R, vol: hold(last.vol) }); return; }
      const t1 = performance.now(), vol = await decode(spec, R), ms = performance.now() - t1;
      busy.push([performance.now(), ms]);
      if (g !== gen) { R3.release(vol); return; }        // the walk changed course while this was decoding
      if (R === resHi && spec.still) neuralFor(vol, spec);
      if (R === resLo) decEma = decEma ? 0.8 * decEma + 0.2 * ms : ms;
      else if (R === resHi && R > resLo) {               // a slow fine grid steps down (160 -> 128 -> 96) instead of stalling holds
        hiEma = hiEma ? 0.7 * hiEma + 0.3 * ms : ms;
        if (hiEma > (hd ? 700 : 150) && resHi > Math.max(resLo, 96) && !qs.get('hi')) {   // HD waits longer, steps 256 -> 192 -> 160
          resHi = hd ? (resHi > 192 ? 192 : 160) : resHi > 128 ? 128 : 96; st.resHi = resHi; hiEma = 0;
        }
      }
      st.decodeMs = +decEma.toFixed(1); keyTimes.push(performance.now());
      if (last) drop(last.vol);
      last = { key: spec.key, R, vol: hold(vol) };
      queue.push({ tau, spec, step, R, vol: hold(vol) });
    }
    async function refine() {                            // paused: show the nearer keyframe exactly, then sharpen it in place
      const s = shown();
      if (!s || refineAt === tauDisp) return nextFrame();
      const k = s.t < 0.5 ? s.A : s.B, g = gen;
      if (k === s.B) drop(queue.shift().vol);
      tauDisp = k.tau;
      if (k.R >= resHi) { refineAt = tauDisp; return nextFrame(); }
      const at = tauDisp, vol = await decode(k.spec, resHi, k.vol.floor);
      if (g !== gen || !paused || tauDisp !== at || queue[0] !== k) { R3.release(vol); return; }
      drop(k.vol); k.vol = hold(vol); k.R = resHi;
      neuralFor(vol, k.spec);
      refineAt = at;
    }
    async function produce() {
      for (;;) {
        try { await produceOnce(); }
        catch (e) {                                      // retry a few times before giving up with a visible message
          if (++st.restarts > 3) throw e;
          console.warn('decode failed, retrying', e); st.warnings.push(String((e && e.message) || e));
          if (pc) { pc.P.dispose(); pc = null; }
          await new Promise((r) => setTimeout(r, 400));
        }
      }
    }
    function retarget(fn, steering = false) {           // keep the two keyframes around the display, change course after them
      for (const q of queue.splice(Math.min(2, queue.length))) drop(q.vol);
      const tail = queue[queue.length - 1], tr = tail ? Math.max(tail.tau, tauDisp) : tauDisp;
      if (tail) tail.step = 1 / 30;
      gen++; refineAt = null; st.steering = steering;
      fn(tr);
      if (paused) setPaused(false);
    }
    const setPaused = (p) => { paused = p; refineAt = null; if (app.onpause) app.onpause(p); };

    // ---- camera ----
    if (rm.addEventListener) rm.addEventListener('change', () => { walker.reduced = rm.matches; });
    const cam = { az: num('az', 0.6, -1e4, 1e4) % 6.2832, el: num('el', 0.32, -0.2, 1.2), dist: 4.4, fov: 0.52, key: [0, 0, 0], eye: [0, 0, 0], rot: new Float32Array(9) };
    // turntable: null = the default (turns unless paused or the system asks for reduced motion); ?spin / ?spin=1 (or the
    // spin button) = always turns, also paused and with reduced motion, at spin x the normal rate (?spin=2 twice as
    // fast); ?spin=0 = never. Dragging always holds it.
    let spin = qs.has('spin') ? num('spin', 1, 0, 8) : null;
    st.spin = spin;
    function camera() {
      const ce = Math.cos(cam.el), port = canvas.width < canvas.height ? canvas.height / canvas.width : 1;
      const d = cam.dist * Math.min(1.6, port), e = [d * ce * Math.sin(cam.az), d * Math.sin(cam.el), d * ce * Math.cos(cam.az)];
      const f = e.map((x) => -x / d), r = [-f[2], 0, f[0]].map((x, _, a) => x / Math.hypot(...a));
      const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
      cam.eye = e; cam.rot.set([...r, ...u, -f[0], -f[1], -f[2]]);
      const k = [-0.45, 0.78, 0.45];                     // key light fixed relative to the viewer (turntable studio)
      cam.key = [0, 1, 2].map((i) => r[i] * k[0] + u[i] * k[1] - f[i] * k[2]);
    }
    const pts = new Map(); let drag = null, pinch = 0;
    canvas.addEventListener('pointerdown', (e) => { pts.set(e.pointerId, [e.clientX, e.clientY]); drag = pts.size === 1 ? [e.clientX, e.clientY] : null; canvas.setPointerCapture(e.pointerId); if (app.oninteract) app.oninteract(); });
    canvas.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, [e.clientX, e.clientY]);
      if (pts.size === 2) { const [a, b] = [...pts.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]); if (pinch) cam.dist = clamp(cam.dist * pinch / d, 2.6, 7); pinch = d; return; }
      if (!drag) return;
      cam.az -= (e.clientX - drag[0]) * 0.008; cam.el = clamp(cam.el + (e.clientY - drag[1]) * 0.006, -0.2, 1.2); drag = [e.clientX, e.clientY];
    });
    for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) canvas.addEventListener(ev, (e) => {
      pts.delete(e.pointerId); pinch = 0;
      drag = pts.size === 1 ? [...pts.values()][0].slice() : null;       // the finger left after a pinch orbits from where it is
    });
    canvas.addEventListener('wheel', (e) => { e.preventDefault(); cam.dist = clamp(cam.dist * Math.exp(e.deltaY * 0.001), 2.6, 7); }, { passive: false });
    canvas.addEventListener('dblclick', () => { cam.dist = 4.4; cam.el = 0.32; });
    new IntersectionObserver((es) => { for (const e of es) st.visible = e.intersectionRatio >= 0.1; }, { threshold: [0, 0.1, 0.5] }).observe(canvas);

    // ---- frame loop ----
    let prev = performance.now(), scale = phone ? 0.55 : 0.75, nextDbg = 0, nextSec = 0, refreshMs = 0, starveMark = 0, calm = 0, lastSig = '', drawn = 0;
    const fpsT = [], ft = [], idleFt = [], starveWin = [];   // ft: intervals of drawn frames; idleFt: of frames with nothing to draw
    // the display refresh, from frames that drew nothing (before the first keyframe, unchanged frames): a GPU-bound
    // page would otherwise measure its own slow frames; fallback after 300 frames: the fastest tenth, snapped to a rate
    const refresh = () => {
      if (idleFt.length >= 20) return idleFt.slice().sort((x, y) => x - y)[idleFt.length >> 1];
      if (st.frames < 300 || ft.length < 100) return 0;
      const p10 = ft.slice().sort((x, y) => x - y)[ft.length / 10 | 0];
      return [6.94, 8.33, 11.11, 13.33, 16.67, 33.33].reduce((b, r) => (Math.abs(r - p10) < Math.abs(b - p10) ? r : b));
    };
    const idle = (ms) => { if (idleFt.length < 60) idleFt.push(ms); };
    const dpr = () => Math.min(phone ? 1.5 : 2, devicePixelRatio || 1);
    const floorAt = (A, B, t) => { const a = A.vol.floor ?? -0.9, b = B.vol.floor ?? -0.9; return a + (b - a) * t; };
    const shown = () => { const A = queue[0], B = queue[1] || A; return A && { A, B, t: B === A ? 0 : clamp((tauDisp - A.tau) / (B.tau - A.tau), 0, 1) }; };
    function draw(sc) { const s = shown(); if (!s) return null; camera(); R3.draw(s.A.vol, s.B.vol, s.t, floorAt(s.A, s.B, s.t), cam, ui.style(), sc, Math.round(5 * dpr())); return s; }
    function perSecond(now) {
      while (busy.length && busy[0][0] < now - 5000) busy.shift();
      while (keyTimes.length && keyTimes[0] < now - 2000) keyTimes.shift();
      st.keyHz = keyTimes.length / 2;
      const w = ft.slice(-300), a = w.slice().sort((x, y) => x - y), q = (p) => +a[Math.min(a.length - 1, Math.floor(p * a.length))].toFixed(1);
      const secs = w.reduce((s, x) => s + x, 0) / 1000, m = tf.memory();
      st.numTensors = m.numTensors;
      st.smooth = { p50: q(0.5), p95: q(0.95), p99: q(0.99), longPerS: +(w.filter((x) => x > 1.5 * (refreshMs || 16.7)).length / secs).toFixed(2),
        refreshMs: +refreshMs.toFixed(2), starveMorphMs: Math.round(starve.morph), starveHoldMs: Math.round(starve.hold),
        duty: +(busy.reduce((s, b) => s + b[1], 0) / 5000).toFixed(3), tensors: m.numTensors, gpuMB: +(m.numBytes / 2 ** 20).toFixed(1), resLo, resHi, scale: +scale.toFixed(2) };
      starveWin.push(starve.morph - starveMark); starveMark = starve.morph; if (starveWin.length > 3) starveWin.shift();
      const recent = starveWin.reduce((s, x) => s + x, 0);   // step the morph grid down when the display runs dry
      if (recent > 250 && resLo > LADDER[0] && !qs.get('res')) { resLo = LADDER[Math.max(0, LADDER.indexOf(resLo) - 1)]; starveWin.length = 0; calm = 0; st.res = resLo; }
      else if (recent === 0 && st.smooth.duty < 0.25 && ++calm > 20 && resLo < resTop) { resLo = LADDER[LADDER.indexOf(resLo) + 1] || resTop; calm = 0; st.res = resLo; }
    }
    function frame(now) {
      requestAnimationFrame(frame);
      const dtMs = now - prev, dt = Math.min(0.1, dtMs / 1000); prev = now;
      if (!st.visible || st.failed) return;
      if (!refreshMs) refreshMs = refresh();
      const W = Math.round(canvas.clientWidth * dpr()), H = Math.round(canvas.clientHeight * dpr());
      if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; lastSig = ''; }
      if (R3.pollFloors) R3.pollFloors();
      if (!queue.length) { if (dtMs < 200) idle(dtMs); return; }   // the clock starts with the first keyframe
      if (!paused && qs.get('freeze') !== '1') tauDisp += dt * speed;
      const tail = queue[queue.length - 1];
      if (tauDisp > tail.tau) { if (!paused) starve[tail.spec.still ? 'hold' : 'morph'] += ((tauDisp - tail.tau) / speed) * 1000; tauDisp = tail.tau; }
      while (queue.length >= 2 && queue[1].tau <= tauDisp) drop(queue.shift().vol);
      const turn = spin === null ? (paused || rm.matches ? 0 : 1) : spin;
      if (!drag && turn) cam.az += dt * 0.22 * turn;
      const s0 = shown(), style = ui.style();
      // an unchanged frame (paused, reduced motion) is not traced again: the canvas keeps its last image
      const oneVol = s0.A.vol === s0.B.vol, tt = oneVol ? 0 : s0.t, fl = oneVol ? s0.A.vol.floor ?? -0.9 : floorAt(s0.A, s0.B, s0.t);
      const sig = `${tt.toFixed(4)}|${style}|${scale}|${W}x${H}|${cam.az.toFixed(5)}|${cam.el.toFixed(5)}|${cam.dist.toFixed(4)}|${fl.toFixed(4)}`;
      const same = s0.A.vol === app.lastA && s0.B.vol === app.lastB && sig === lastSig && !TEST;
      if (same) idle(dtMs); else { ft.push(dtMs); if (ft.length > 600) ft.shift(); drawn++; }
      const r0 = performance.now(), s = same ? s0 : draw(scale);
      app.lastA = s0.A.vol; app.lastB = s0.B.vol; lastSig = sig;
      if (!same) st.renderMs = +(0.9 * st.renderMs + 0.1 * (performance.now() - r0)).toFixed(2);
      st.style = style;
      if (st.firstFrameMs === null) {
        st.firstFrameMs = Math.round(performance.now() - t0); if (!st.errors.length) $('msg').hidden = true;
        starve.morph = starve.hold = 0; starveMark = 0; starveWin.length = 0;   // the cold first decode is not a stall
        loadChunks(); ui.firstFrame();
      }
      st.frames++; fpsT.push(now); while (fpsT[0] < now - 1000) fpsT.shift(); st.fps = fpsT.length;
      if (style === 'lit' && refreshMs && !paused && !same && drawn % 30 === 0) {   // trace resolution vs the refresh, drawn frames only
        const w = ft.slice(-30).sort((x, y) => x - y), p90 = w[26];
        if (p90 > 1.3 * refreshMs) scale = Math.max(0.3, scale * 0.9); else if (p90 < 1.08 * refreshMs) scale = Math.min(phone ? 0.8 : 1, scale * 1.03);
      }
      if (st.frames === 20) { if (TEST) st.ink = R3.coverage(); st.ready = true; }
      if (s.A.spec.still) walker.reached(s.A.spec, s.A.tau);   // the back button returns to objects actually shown
      ui.frame(s, tauDisp);
      if (now > nextSec) { nextSec = now + 1000; perSecond(now); walker.prune(tauDisp); }
      if (now > nextDbg && !$('dbg').hidden) {
        nextDbg = now + 500; const m = tf.memory(), sm = st.smooth || {};
        $('dbg').textContent = `${st.backend}${phone ? ' (phone tier)' : ''} · grid ${resLo}³ / ${resHi}³ · decode ${st.decodeMs} ms · ${st.keyHz} key/s · duty ${sm.duty}\n` +
          `${st.fps} fps · p95 ${sm.p95} ms · render ${st.renderMs} ms · trace ${(scale * 100).toFixed(0)}% · ${canvas.width}×${canvas.height}\n` +
          `walk ${walker.mode} · queue ${queue.length} · starved ${sm.starveMorphMs} ms · anchors ${model.nLoaded}/${meta.anchors.length}\n` +
          `tensors ${m.numTensors} · GPU ${(m.numBytes / 2 ** 20).toFixed(0)} MB` + (st.refErr !== null ? ` · refErr ${st.refErr.toExponential(2)}` : '');
      }
    }

    const app = M.app = {
      st, meta, map, model, walker, R3, qs, dir: F.dir, lastA: null, lastB: null,
      text: meta.clip && M.Text ? new M.Text(F.dir, meta) : null,      // m3d-text.js: descriptions in the find box
      get tau() { return tauDisp; }, get paused() { return paused; }, get speed() { return speed; }, get spin() { return spin; }, cam,
      shown, setPaused, loadChunks,
      setSpin(v) { spin = st.spin = v === null ? null : clamp(+v, 0, 8); },
      get hd() { return hd; },
      setHD(on) { setHD(!!on); refineAt = null; },          // the next resting grid (or the paused keyframe) uses it
      setSpeed(x) { speed = st.speed = clamp(x, 0.25, 3); },
      setMode(m) { if (!M.isWalk(m)) return; retarget((tr) => walker.setMode(tr, m)); st.walk = walker.mode; },
      next() { retarget((tr) => walker.next(tr)); },
      back() {                                           // judged from the keyframe on screen; a no-op press changes nothing
        const s = shown(), d = s && (s.t < 0.5 ? s.A.spec : s.B.spec);
        if (!d || !walker.canBack(d)) return false;
        retarget((tr) => walker.back(tr, d)); return true;
      },
      travel(i) { if (model.loaded(i)) retarget((tr) => walker.travel(tr, i)); },
      steer(terms) {                                     // (re)arms through retarget when another control ended steering
        if (!terms.length) return;
        if (paused) setPaused(false);                    // steering shows the blend live, so it plays
        if (!st.steering || walker.steerAt === null) retarget((tr) => walker.steer(tr, terms), true); else walker.steer(tauDisp, terms);
        if (walker.steerSpec) walker.steerSpec.live = true;
      },
      release() { if (!st.steering) return; retarget((tr) => walker.release(tr)); },
      savePNG(name) {                                    // one full-resolution frame, read in the same task as the draw
        if (!draw(1)) return;
        lastSig = '';
        canvas.toBlob((b) => { if (!b) return; const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = name || 'pixel-morph-3d.png'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); });
      },
    };
    // m3d-create.js: descriptions -> new objects, when this model ships a text prior for its own latent space
    app.creator = meta.prior && app.text && M.Creator ? new M.Creator(app) : null;
    const ui = new M.UI(app);
    produce().catch(fail);
    requestAnimationFrame(frame);
  }

  main().catch(fail);
})(window.M3D = window.M3D || {});
