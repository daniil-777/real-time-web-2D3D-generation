// Morph 3D page controls: walk / speed / style / transport / find / map / save / share / about, keyboard shortcuts,
// the label and morph progress, the walk explanation, a live status line, per-object credits (CC-BY) and URL state.
(function (M) {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const SAFE = /^https:\/\/([a-z0-9-]+\.)*(sketchfab\.com|objaverse\.allenai\.org|huggingface\.co)\//i;
  const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'shape';
  const link = (href, text) => Object.assign(document.createElement('a'), { href, target: '_blank', rel: 'noopener', textContent: text });

  // the exporter's credit line, rebuilt from text and links only (https links, or sources.json next to the model)
  function creditNodes(html, dir) {
    const out = document.createDocumentFragment(), doc = new DOMParser().parseFromString(`<div>${html || ''}</div>`, 'text/html');
    for (const n of doc.body.firstChild.childNodes) {
      const h = n.nodeName === 'A' ? n.getAttribute('href') || '' : '';
      if (h === 'sources.json') out.append(link(dir + '/sources.json', n.textContent));
      else if (/^https:\/\/[^\s"'<>]+$/i.test(h)) out.append(link(h, n.textContent));
      else out.append(n.textContent);
    }
    return out;
  }

  M.UI = class {
    constructor(app) {
      this.app = app; this.lastLabel = ''; this.lastCredit = ''; this.lastHint = ''; this.lastSaid = ''; this.sources = null; this.user = false;
      const { meta, qs, walker } = app;
      this.test = ['check', 'bench', 'debug', 'freeze', 'soak'].some((k) => qs.has(k));
      // model: picks the trained network (a folder of this site, ?model=), reloading the page to boot it fresh --
      // switching decoders mid-session would mean tearing down every tf tensor, GL/WebGPU resource, the walker and
      // the map by hand, for a choice visitors make rarely. The reload reuses the same preloader every link does.
      const modelEl = this.modelEl = $('model3d');
      if (modelEl) {
        if ([...modelEl.options].some((o) => o.value === app.dir)) modelEl.value = app.dir;
        modelEl.addEventListener('change', () => {
          const u = new URL(location.href); u.searchParams.set('model', modelEl.value); location.href = u.toString();
        });
      }
      this.styleEl = $('style');
      this.styleEl.value = ['lit', 'dots', 'mono'].includes(qs.get('style')) ? qs.get('style') : 'lit';
      const walk = this.walkEl = $('walk');
      for (const [k, d] of Object.entries(M.WALKS)) { const o = document.createElement('option'); o.value = k; o.textContent = k; o.title = d; walk.appendChild(o); }
      walk.value = walker.mode;
      walk.addEventListener('change', () => { app.setMode(walk.value); this.touched(); });
      const speed = $('speed'); speed.value = app.speed;
      speed.addEventListener('input', () => { app.setSpeed(+speed.value); this.touched(); });
      this.styleEl.addEventListener('change', () => this.touched());
      $('next').addEventListener('click', () => { app.next(); this.touched(); });
      $('back').addEventListener('click', () => { this.back(); this.touched(); });
      $('pause').addEventListener('click', () => app.setPaused(!app.paused));
      app.onpause = (p) => { $('pause').textContent = p ? 'play' : 'pause'; };
      $('spin').setAttribute('aria-pressed', String(!!app.spin));
      $('spin').addEventListener('click', () => this.toggleSpin());
      $('hd').setAttribute('aria-pressed', String(app.hd));
      $('hd').addEventListener('click', () => this.toggleHD());
      app.oninteract = () => this.fadeHint();
      if (matchMedia('(pointer: coarse)').matches) $('hint').textContent = 'drag to orbit · pinch to zoom';
      // find: the class labels; committing travels to a loaded object of that class not seen lately
      const dl = $('classes');
      for (const l of [...new Set(meta.class_labels)].sort()) { const o = document.createElement('option'); o.value = l; dl.appendChild(o); }
      const find = $('find');
      let entered = false;
      const go = () => {
        const label = find.value.trim().toLowerCase(), k = meta.class_labels.indexOf(label); if (k < 0) return;
        const cls = meta.classes[k], seen = new Set(walker.recent.slice(-24));
        const cand = meta.anchors.map((a, i) => i).filter((i) => meta.anchors[i].cls === cls && app.model.loaded(i));
        const i = cand.find((j) => !seen.has(j)) ?? cand[0];
        if (i === undefined) return this.say(`no ${label} loaded yet, try again in a moment`);
        app.travel(i); this.touched();
      };
      find.addEventListener('change', () => { if (!entered) go(); });   // a pick from the list, or leaving the field
      find.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { find.value = ''; find.blur(); }
        else if (e.key === 'Enter') { go(); entered = true; find.blur(); setTimeout(() => { entered = false; }); }   // every Enter commits, once
      });
      // map
      this.map = new M.MapView($('map'), $('maptip'), app);
      this.setMap(qs.get('map') ? qs.get('map') === '1' : innerWidth >= 900 && !app.st.phone);
      $('mapBtn').addEventListener('click', () => this.setMap(!this.map.visible));
      $('save').addEventListener('click', () => this.save());
      $('share').addEventListener('click', () => this.share());
      // about: closes on its close button, Escape, or a click outside the box (not on its padding or a text selection)
      const dlg = $('about');
      $('aboutBtn').addEventListener('click', () => this.about());
      dlg.addEventListener('click', (e) => {
        if (e.target.hasAttribute && e.target.hasAttribute('data-close')) return dlg.close();
        const r = dlg.getBoundingClientRect(), out = e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
        if (e.target === dlg && out && !String(getSelection())) dlg.close();
      });
      const wt = $('walkTable');
      for (const [k, d] of Object.entries(M.WALKS)) { const tr = wt.insertRow(); tr.insertCell().textContent = k; tr.insertCell().textContent = d; }
      this.creditLine = document.createElement('div');
      $('credit').append(this.creditLine, creditNodes(meta.credit_html, app.dir));
      $('aboutCredit').append(creditNodes(meta.credit_html, app.dir));
      // the 2d|3d switch keeps the walk where the names mean the same thing on both pages
      $('to2d').addEventListener('click', (e) => {
        const u = new URL(e.currentTarget.getAttribute('href'), location.href), w = walker.mode;
        if (['drift', 'dream', 'tour', 'random'].includes(w)) u.searchParams.set('walk', w);
        e.currentTarget.href = u.toString();
      });
      for (const el of [walk, this.styleEl, speed]) {
        el.addEventListener('pointerdown', () => { el.ptr = true; });
        el.addEventListener('change', () => { if (el.ptr) { el.ptr = false; el.blur(); } });
      }
      addEventListener('keydown', (e) => this.key(e));
      setInterval(() => this.status(), 1000);
      this.status();
    }

    style() { return this.styleEl.value; }
    toggleSpin() {                                        // spin button / r: always turn (at the last rate) <-> the default
      const app = this.app, on = !app.spin;
      if (app.spin) this.lastSpin = app.spin;
      app.setSpin(on ? this.lastSpin || 1 : null);
      $('spin').setAttribute('aria-pressed', String(on));
      this.touched();
    }
    toggleHD() {                                          // HD button / h: 256^3 resting grids + curvature shading
      const on = !this.app.hd;
      this.app.setHD(on);
      $('hd').setAttribute('aria-pressed', String(on));
      this.touched();
    }
    setMap(v) { this.map.show(v); $('mapBtn').setAttribute('aria-pressed', String(v)); }
    fadeHint() { $('hint').style.opacity = '0'; }
    firstFrame() {
      setTimeout(() => this.fadeHint(), 7000);
      setTimeout(() => fetch(this.app.dir + '/sources.json').then((r) => r.json()).then((rows) => {
        this.sources = new Map(rows.map((r) => [r.anchor, r])); this.lastCredit = '';
      }).catch(() => {}), 1500);
    }
    say(text) { this.flash = { text, until: performance.now() + 2500 }; }
    back() { if (!this.app.back()) this.say(this.app.walker.mode === 'dream' ? 'dream never rests, so there is nothing to go back to' : 'nothing to go back to yet'); }
    touched() {                                           // after a visitor's first change: URL state (debounced), announcements
      this.user = true;
      if (this.test) return;
      clearTimeout(this.urlT); this.urlT = setTimeout(() => this.writeURL(), 300);
    }
    writeURL() {
      const u = new URL(location.href), p = u.searchParams;
      p.set('walk', this.app.walker.mode);
      if (this.style() !== 'lit') p.set('style', this.style()); else p.delete('style');
      if (this.app.speed !== 1) p.set('speed', String(this.app.speed)); else p.delete('speed');
      if (this.app.spin !== null) p.set('spin', String(this.app.spin)); else p.delete('spin');
      if (this.app.hd) p.set('hd', '1'); else p.delete('hd');
      history.replaceState(null, '', u);
    }

    frame(s) {
      if (!s) return;
      const spec = s.t < 0.5 ? s.A.spec : s.B.spec, app = this.app, lab = spec.label || '';
      if (lab !== this.lastLabel) { this.lastLabel = lab; $('label').textContent = lab; app.st.label = lab; $('c').setAttribute('aria-label', '3D shape: ' + lab); }
      if (spec.still && this.user && lab !== this.lastSaid) { this.lastSaid = lab; $('sr').textContent = lab; }   // announce rests only
      $('progress').firstChild.style.width = spec.prog == null ? '0' : (100 * spec.prog).toFixed(1) + '%';
      const route = spec.route;
      const hint = this.flash && performance.now() < this.flash.until ? this.flash.text
        : app.st.steering ? 'steering: the three nearest objects on the map blend as you drag'
        : route && route.length > 2 ? 'voyage: ' + route.map((i) => app.meta.anchors[i].label).join(' → ')
          : app.walker.mode + ': ' + M.WALKS[app.walker.mode];
      if (hint !== this.lastHint) { this.lastHint = hint; $('walkhint').textContent = hint; }
      if (this.walkEl.value !== app.walker.mode) this.walkEl.value = app.walker.mode;
      this.credit(spec);
      const xa = s.A.spec.xy, xb = s.B.spec.xy;
      this.map.frame(xa && xb ? [xa[0] + (xb[0] - xa[0]) * s.t, xa[1] + (xb[1] - xa[1]) * s.t] : xa || xb, route, performance.now());
    }
    credit(spec) {                                        // "‹model› by ‹author› (cc-by)" for the objects on screen
      if (!this.sources) return;
      const ids = spec.top.filter(([, m]) => m >= 0.2).slice(0, 2).map(([i]) => i), key = ids.join(',');
      if (key === this.lastCredit) return;
      this.lastCredit = key;
      const el = this.creditLine; el.textContent = '';
      ids.forEach((i, k) => {
        const r = this.sources.get(i); if (!r) return;
        if (k) el.append(' · ');
        const name = String(r.name || r.label || 'object');
        el.append(SAFE.test(r.url || '') ? link(r.url, name) : name, ` by ${r.author || 'unknown'} (${r.license === 'cc0' ? 'cc0' : 'cc-by'})`);
      });
    }
    status() {
      const { st, meta, model } = this.app;
      if (st.errors.length) return;                       // keep the error message where the visitor can read it
      if (st.firstFrameMs === null) {
        const p = window.__M3D_PROG;
        $('msg').textContent = p && p.total && p.got < p.total ? `loading the decoder… ${(p.got / 2 ** 20).toFixed(1)} / ${(p.total / 2 ** 20).toFixed(1)} MB` : 'decoding the first shape…';
        return;
      }
      const fb = $('fpsBadge');                           // always-on frame-rate badge (green >= 50, orange >= 30, red below)
      fb.hidden = false; fb.textContent = `${st.fps} fps`; fb.dataset.q = st.fps >= 50 ? 'good' : st.fps >= 30 ? 'ok' : 'low';
      $('status').textContent = `${meta.classes.length} classes · ${model.nLoaded}/${meta.anchors.length} objects · ${(st.decoderParams / 1e6).toFixed(2)} M weights · ` +
        `decoded live on your gpu (${st.backend}${st.glgrid ? ' shaders' : ''} · ${st.keyHz.toFixed(0)} shapes/s · ${st.fps} fps)`;
    }
    about() {
      $('about').showModal();
      if (this.acc) return;
      this.acc = fetch(this.app.dir + '/report.json').then((r) => r.json()).then((rep) => {
        const a = rep.accuracy && (rep.accuracy.shipped || rep.accuracy.fp32); if (!a) throw new Error('no accuracy');
        const f = (x, d = 3) => (+x).toFixed(d), worst = (a.worst_classes_f2 || []).slice(0, 4).map((w) => String(w[0]).replace(/_\(.*?\)/g, '').replace(/_/g, ' '));
        $('acc').textContent = `F-score@2% ${f(a.f2)} ± ${f(a.f2_se)} · F-score@1% ${f(a.f1)} · IoU ${f(a.iou)} · Chamfer ${f(a.chamfer, 4)} · ` +
          `normal consistency ${f(a.nc)} · colour PSNR ${f(a.psnr, 1)} dB, on ${a.objects} objects in ${a.classes} classes` +
          (rep.weights_grid_iou ? ` · int8 vs float32 grid IoU ${f(rep.weights_grid_iou)}` : '') + (worst.length ? ` · hardest: ${worst.join(', ')}` : '');
      }).catch(() => { $('acc').textContent = 'the accuracy report is not available'; });
    }
    save() { this.app.savePNG(`pixel-morph-3d-${slug(this.lastLabel || 'shape')}.png`); }
    async share() {
      const u = new URL(location.href), p = u.searchParams, s = this.app.shown();
      p.set('walk', this.app.walker.mode); p.set('seed', String(this.app.st.seed));
      if (s) p.set('anchor', String((s.t < 0.5 ? s.A.spec : s.B.spec).dom));
      for (const k of ['check', 'bench', 'debug', 'soak', 'freeze']) p.delete(k);
      const url = u.toString(), b = $('share');
      const say = (t) => { b.textContent = t; setTimeout(() => { b.textContent = 'copy link'; }, 1800); };
      try {
        if (navigator.share && matchMedia('(pointer: coarse)').matches) await navigator.share({ title: 'pixel morph · 3d', url });
        else { await navigator.clipboard.writeText(url); say('link copied'); }
      } catch (e) { if (e && e.name !== 'AbortError') { history.replaceState(null, '', url); say('link in address bar'); } }
    }
    key(e) {
      if (this.app.qs.has('bench') || e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = e.target && e.target.tagName;
      if ($('about').open || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (tag === 'INPUT' && (e.target.type !== 'range' || /^(Arrow|Home|End|Page)/.test(e.key))) return;
      if (e.repeat) { if (e.key === ' ') e.preventDefault(); return; }   // holding a key acts once
      if (tag === 'BUTTON' && (e.key === ' ' || e.key === 'Enter')) return;   // the focused button handles its own activation
      const app = this.app, walks = Object.keys(M.WALKS);
      if (e.key === ' ') { e.preventDefault(); app.setPaused(!app.paused); }
      else if (e.key === 'ArrowRight' || e.key === 'n') { app.next(); this.touched(); }
      else if (e.key === 'ArrowLeft' || e.key === 'p') { this.back(); this.touched(); }
      else if (/^[1-9]$/.test(e.key) && walks[+e.key - 1]) { app.setMode(walks[+e.key - 1]); this.touched(); }
      else if (e.key === 's') this.save();
      else if (e.key === '/') { e.preventDefault(); $('find').focus(); }
      else if (e.key === 'm') this.setMap(!this.map.visible);
      else if (e.key === 'r') this.toggleSpin();
      else if (e.key === 'h') this.toggleHD();
      else if (e.key === 'i') this.about();
      else if (e.key === 'd') $('dbg').hidden = !$('dbg').hidden;
      else return;
      this.fadeHint();
    }
  };
})(window.M3D = window.M3D || {});
