// Morph 3D latent map: every object is a dot at the t-SNE position of its latent (map.json), coloured by class; the
// marker is the walk's current mixture (the weighted mean of its objects' positions, exact for linear blends) with a
// fading trail. Hover names a dot, click travels there through similar shapes, drag steers: the three nearest loaded
// objects blend by inverse squared distance.
(function (M) {
  'use strict';
  M.MapView = class {
    constructor(cv, tip, app) {
      Object.assign(this, { cv, tip, app, xy: app.map.xy, N: app.map.xy.length, trail: [], visible: false, down: null, baseKey: '', last: 0 });
      const { meta } = app, cen = meta.classes.map(() => [0, 0, 0]);
      this.ci = meta.anchors.map((a) => meta.classes.indexOf(a.cls));
      this.ci.forEach((k, i) => { cen[k][0] += this.xy[i][0]; cen[k][1] += this.xy[i][1]; cen[k][2]++; });
      this.hue = cen.map(([x, y, n]) => (Math.atan2(y / n - 0.5, x / n - 0.5) * 180 / Math.PI + 360) % 360);
      // one primary pointer at a time; a touch has to travel 10 px (a mouse 4 px) before a tap becomes a steer
      cv.addEventListener('pointerdown', (e) => {
        if (!e.isPrimary || this.down) return;
        this.down = { id: e.pointerId, x: e.offsetX, y: e.offsetY, moved: false, slop: e.pointerType === 'mouse' ? 4 : 10 };
        cv.setPointerCapture(e.pointerId); e.preventDefault();
      });
      cv.addEventListener('pointermove', (e) => {
        const d = this.down;
        if (d) {
          if (e.pointerId !== d.id) return;
          if (!d.moved && Math.hypot(e.offsetX - d.x, e.offsetY - d.y) > d.slop) d.moved = true;
          if (d.moved) { this.app.steer(this.blend(e.offsetX, e.offsetY)); this.hideTip(); }
          return;
        }
        const n = this.nearest(e.offsetX, e.offsetY, false)[0];
        if (n && n.d < 12) this.showTip(n.i); else this.hideTip();
      });
      const end = (e, tap) => {
        const d = this.down; if (!d || e.pointerId !== d.id) return;
        this.down = null;
        if (d.moved) return this.app.release();
        if (!tap) return;
        const n = this.nearest(e.offsetX, e.offsetY, true)[0];
        if (n && n.d < 14) this.app.travel(n.i);
      };
      cv.addEventListener('pointerup', (e) => end(e, true));
      cv.addEventListener('pointercancel', (e) => end(e, false));
      cv.addEventListener('lostpointercapture', (e) => end(e, false));
      cv.addEventListener('pointerleave', () => { if (!this.down) this.hideTip(); });
    }
    size() { return [this.cv.clientWidth, this.cv.clientHeight]; }
    toPx(p) { const [w, h] = this.size(), pad = 8; return [pad + p[0] * (w - 2 * pad), pad + p[1] * (h - 2 * pad)]; }
    nearest(x, y, loadedOnly) {
      const out = [];
      for (let i = 0; i < this.N; i++) {
        if (loadedOnly && !this.app.model.loaded(i)) continue;
        const [px, py] = this.toPx(this.xy[i]); out.push({ i, d: Math.hypot(px - x, py - y) });
      }
      return out.sort((a, b) => a.d - b.d);
    }
    // the three nearest loaded objects, weights ∝ 1 / (d² + ε) in map units; the 2D map keeps only ~25 % of true
    // neighbourhoods (knn_keep10 in map.json), so objects that are not shape neighbours of the nearest one count ×0.15 (measured with
    // test/steer_trace.js + m3d_walkeval.py replay: floating debris 0.017 -> 0.008, frames with >5 % debris 9 % -> 3.5 %)
    blend(x, y) {
      const [w] = this.size(), s = w - 16, n = this.nearest(x, y, true).slice(0, 3);
      const nb = new Set(n.length && this.app.map.sknn ? this.app.map.sknn[n[0].i] : []);
      const ws = n.map((e, k) => (k === 0 || !nb.size || nb.has(e.i) ? 1 : 0.15) / ((e.d / s) ** 2 + 0.0004)), tot = ws.reduce((a, b) => a + b, 0);
      return n.map((e, k) => [e.i, ws[k] / tot]).filter(([, v]) => v > 0.01);
    }
    showTip(i) {
      const [px, py] = this.toPx(this.xy[i]);
      this.tip.textContent = this.app.meta.anchors[i].label + (this.app.model.loaded(i) ? '' : ' (loading)');
      this.tip.style.left = this.cv.offsetLeft + px + 'px'; this.tip.style.top = this.cv.offsetTop + py + 'px'; this.tip.hidden = false;
    }
    hideTip() { this.tip.hidden = true; }
    show(v) { this.visible = v; this.cv.hidden = !v; if (!v) this.hideTip(); this.baseKey = ''; }
    base(w, h, dpr) {                                // dots, redrawn only when the loaded set or the size changes
      const key = `${w}x${h}x${dpr}x${this.app.model.nLoaded}`;
      if (key === this.baseKey) return this.bc;
      this.baseKey = key;
      const c = this.bc || (this.bc = document.createElement('canvas')); c.width = w * dpr; c.height = h * dpr;
      const g = c.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
      for (let i = 0; i < this.N; i++) {
        const [x, y] = this.toPx(this.xy[i]); g.beginPath(); g.arc(x, y, 2.4, 0, 6.2832);
        if (this.app.model.loaded(i)) { g.fillStyle = `hsl(${this.hue[this.ci[i]].toFixed(0)} 45% 55%)`; g.fill(); }
        else { g.strokeStyle = '#d8d8d8'; g.lineWidth = 1; g.stroke(); }
      }
      return c;
    }
    frame(xy, route, now) {
      if (!this.visible || now - this.last < 33) return;       // 30 fps is plenty for the map
      this.last = now;
      const [w, h] = this.size(), dpr = Math.min(2, devicePixelRatio || 1), cv = this.cv;
      if (!w || !h) return;
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
      const g = cv.getContext('2d'); g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, cv.width, cv.height);
      g.drawImage(this.base(w, h, dpr), 0, 0); g.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (route && route.length > 1) {
        g.strokeStyle = 'rgba(0,0,0,0.55)'; g.lineWidth = 1; g.setLineDash([3, 3]); g.beginPath();
        route.forEach((i, k) => { const [x, y] = this.toPx(this.xy[i]); if (k) g.lineTo(x, y); else g.moveTo(x, y); }); g.stroke(); g.setLineDash([]);
        for (const i of route) { const [x, y] = this.toPx(this.xy[i]); g.beginPath(); g.arc(x, y, 3.2, 0, 6.2832); g.strokeStyle = '#000'; g.stroke(); }
      }
      if (xy) {
        const t = this.trail, lp = t[t.length - 1];
        if (!lp || Math.hypot(lp[0] - xy[0], lp[1] - xy[1]) > 0.002) { t.push(xy); if (t.length > 64) t.shift(); }
        for (let k = 1; k < t.length; k++) {
          const [x0, y0] = this.toPx(t[k - 1]), [x1, y1] = this.toPx(t[k]);
          g.strokeStyle = `rgba(0,0,0,${(0.5 * k / t.length).toFixed(3)})`; g.lineWidth = 1.5; g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
        }
        const [x, y] = this.toPx(xy);
        g.beginPath(); g.arc(x, y, 5.5, 0, 6.2832); g.strokeStyle = '#000'; g.lineWidth = 1.5; g.stroke();
        g.beginPath(); g.arc(x, y, 2, 0, 6.2832); g.fillStyle = '#000'; g.fill();
      }
    }
  };
})(window.M3D = window.M3D || {});
