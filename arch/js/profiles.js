// Moulding profiles as a small "turtle" in the (p, h) plane: p = projection outward from a reference surface, h = height.
// The classical vocabulary: fillet, torus, scotia, ovolo, cavetto, cyma recta, cyma reversa, bead (astragal), fascia.
// A Prof is drawn bottom to top; toRevolve() closes it to the axis for a lathe, toRun() closes it to the wall for a
// straight moulding (front = -Y), toRings() gives square/rectangular rings for "square lathes" (plinths, pedestals).

const N = 12; // segments per curved member (a lathe adds its own circular segments)

export class Prof {
  constructor(p0 = 0, h0 = 0) { this.pts = [[p0, h0]]; }
  get p() { return this.pts[this.pts.length - 1][0]; }
  get h() { return this.pts[this.pts.length - 1][1]; }
  to(p, h) { this.pts.push([p, h]); return this; }
  /** vertical face of height dh (a fillet or fascia), after stepping out by dp (negative = in) */
  fillet(dh, dp = 0) { if (dp) this.to(this.p + dp, this.h); return this.to(this.p, this.h + dh); }
  /** horizontal step out (or in) */
  out(dp) { return this.to(this.p + dp, this.h); }
  /** inclined straight line */
  slope(dp, dh) { return this.to(this.p + dp, this.h + dh); }
  _curve(fn, n = N) { const p0 = this.p, h0 = this.h; for (let i = 1; i <= n; i++) { const [a, b] = fn(i / n); this.pts.push([p0 + a, h0 + b]); } return this; }
  /** convex quarter round rising and projecting by (dp, dh): echinus, ovolo */
  ovolo(dp, dh, n) { return this._curve((t) => [dp * Math.sin((t * Math.PI) / 2), dh * (1 - Math.cos((t * Math.PI) / 2))], n); }
  /** concave quarter round (dp may be negative for an inward cavetto) */
  cavetto(dp, dh, n) { return this._curve((t) => [dp * (1 - Math.cos((t * Math.PI) / 2)), dh * Math.sin((t * Math.PI) / 2)], n); }
  /** cyma recta: convex below, concave above (the sima of a cornice) */
  cymaRecta(dp, dh, n = N) { this.ovolo(dp / 2, dh / 2, n >> 1); return this.cavetto(dp / 2, dh / 2, n >> 1); }
  /** cyma reversa (talon): concave below, convex above */
  cymaReversa(dp, dh, n = N) { this.cavetto(dp / 2, dh / 2, n >> 1); return this.ovolo(dp / 2, dh / 2, n >> 1); }
  /** torus: half round bulging out by k·dh/2 (k=1 semicircle) */
  torus(dh, k = 1, n = N + 4) { return this._curve((t) => [((k * dh) / 2) * Math.sin(t * Math.PI), (dh / 2) * (1 - Math.cos(t * Math.PI))], n); }
  /** bead / astragal: a small torus */
  bead(dh) { return this.torus(dh, 1, N); }
  /** scotia: concave hollow of height dh, dp_in deep, ending dp_end from start (asymmetric trochilus) */
  scotia(dh, depth, dpEnd = 0, n = N + 4) {
    return this._curve((t) => [-depth * Math.sin(t * Math.PI) + dpEnd * t, (dh / 2) * (1 - Math.cos(t * Math.PI))], n);
  }
  points() { return this.pts.map((q) => q.slice()); }
  /** Closed polygon for revolve(): r = r0 + p, z = z0 + h, closed through the axis. */
  toRevolve(r0 = 0, z0 = 0) {
    const pts = this.pts.map(([p, h]) => [Math.max(0, r0 + p), z0 + h]);
    const top = pts[pts.length - 1][1], bot = pts[0][1];
    return [[0, bot], ...pts, [0, top]];
  }
  /** Closed polygon in (y, z) for extrudeProfileX(): projects toward -Y from the wall plane y = back. */
  toRun(back = 0, z0 = 0) {
    const pts = this.pts.map(([p, h]) => [-p, z0 + h]);
    const top = pts[pts.length - 1][1], bot = pts[0][1];
    return [[back, bot], ...pts, [back, top]];
  }
  /** Rings for loft(): a rectangle of half-sizes (ax + p, ay + p) at each profile point; returns { rings, zs }. */
  toRings(ax, ay = ax, z0 = 0) {
    const rings = [], zs = [];
    for (const [p, h] of this.pts) {
      const x = ax + p, y = ay + p;
      rings.push([[-x, -y], [x, -y], [x, y], [-x, y]]);
      zs.push(z0 + h);
    }
    return { rings, zs };
  }
}

/** A profile built by a callback on a fresh Prof starting at (p0, 0). */
export function prof(p0, draw) { const p = new Prof(p0, 0); draw(p); return p; }
