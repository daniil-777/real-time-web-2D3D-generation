// In-browser geometric post-processing of each decoded keyframe: the calibrated slope-term level rule of
// m3d_post.grid_level (row F1b of m3d_eval.py --post; research/postproc/REPORT.md):
//   G2 = G - kappa * eps * (clip(|grad G|_upwind, gmin, 1) - 1),   drawn where G2 < T(R) = iso(R) + delta(R)
// |grad G|_upwind is the Osher-Fedkiw magnitude of m3d_post.grad_mag_grid (per axis max(|D+|, |D-|), one-sided at the
// borders, spacing 2/(R-1)). One WebGL2 pass over the half-float volume texture, whatever decoded it (WebGPU kernel,
// TF.js or the GL grid shader); needs float render targets, else the page stays threshold-only (T_k0).
// Settings come from meta.json['post'] (calibrated for exactly this export's checkpoint); ?level=0 turns the pass off.
// meta.post.cc (connected-component floater removal) is not run here: +0.0005 IoU in the REPORT, not worth a
// per-keyframe labelling pass.
(function (M) {
  'use strict';
  const LEVEL = `#version 300 es
  precision highp float; precision highp int; precision highp sampler3D;
  uniform sampler3D uS; uniform int uLayer, uR; uniform float uKE, uGmin, uInvH;
  out vec4 o;
  float g(int i, int j, int k) { return texelFetch(uS, ivec3(k, j, i), 0).r; }       // volume texel = (z, y, x)
  void main() {
    int i = uLayer, j = int(gl_FragCoord.y), k = int(gl_FragCoord.x), n = uR - 1;
    float c = g(i, j, k);
    float ax = max(i < n ? abs(g(i + 1, j, k) - c) : 0.0, i > 0 ? abs(c - g(i - 1, j, k)) : 0.0);
    float ay = max(j < n ? abs(g(i, j + 1, k) - c) : 0.0, j > 0 ? abs(c - g(i, j - 1, k)) : 0.0);
    float az = max(k < n ? abs(g(i, j, k + 1) - c) : 0.0, k > 0 ? abs(c - g(i, j, k - 1)) : 0.0);
    float gn = sqrt(ax * ax + ay * ay + az * az) * uInvH;
    o = vec4(c - uKE * (clamp(gn, uGmin, 1.0) - 1.0), 0.0, 0.0, 1.0);
  }`;
  const CAL = [64, 96, 128];                 // the calibrated resolutions of meta.post
  const P = M.Renderer.prototype;

  // the calibrated resolution whose rule applies at R: nearest in 1/(R-1) (m3d_export2.ref_level uses the same)
  const nearest = (R) => CAL.reduce((b, c) => (Math.abs(1 / (R - 1) - 1 / (c - 1)) < Math.abs(1 / (R - 1) - 1 / (b - 1)) ? c : b));

  // meta.post -> the full rule: slope pass on, drawn threshold T instead of T_k0. false = threshold-only stays.
  P.setPost = function (meta) {
    const p = meta.post, gl = this.gl;
    this.levelOn = false;
    if (!p || new URLSearchParams(location.search).get('level') === '0' || !gl.getExtension('EXT_color_buffer_float')) return false;
    this.levelProg = M.glProg(gl, LEVEL);
    this.rule = Object.fromEntries(CAL.map((R) => [R, { ke: p['R' + R].kappa * p['R' + R].eps, gmin: p['R' + R].gmin }]));
    const iso = (R) => Math.max(0, 1 / (R - 1) - (meta.eps || 0.01));
    this.levels = CAL.map((R) => [R, p['R' + R].T - iso(R)]);      // delta of the full rule (valid with the pass only)
    this.levelOn = true;
    return true;
  };

  // run the pass on volume v (in place: v.s becomes a fresh texture, the old one is kept as the spare for this R)
  P.level = function (v) {
    const r = this.levelOn && this.rule[nearest(v.R)];
    if (!r || !r.ke) return v;                // kappa 0 at this R: the calibrated rule is threshold-only there
    const gl = this.gl, R = v.R, sp = this.spare || (this.spare = {});
    let t = sp[R];
    if (!t) {
      t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_3D, t); gl.texStorage3D(gl.TEXTURE_3D, 1, gl.R16F, R, R, R);
      for (const q of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_3D, q, gl.LINEAR);
      for (const q of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, q, gl.CLAMP_TO_EDGE);
    }
    const q = this.levelProg;
    this.lfbo = this.lfbo || gl.createFramebuffer();
    gl.bindVertexArray(this.vao); gl.useProgram(q.p); gl.disable(gl.BLEND);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_3D, v.s); gl.uniform1i(q.u.uS, 0);
    gl.uniform1i(q.u.uR, R); gl.uniform1f(q.u.uKE, r.ke); gl.uniform1f(q.u.uGmin, r.gmin); gl.uniform1f(q.u.uInvH, (R - 1) / 2);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.lfbo); gl.viewport(0, 0, R, R);
    for (let i = 0; i < R; i++) {            // one slice per draw: layer i = x, pixel (z, y)
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, t, 0, i);
      gl.uniform1i(q.u.uLayer, i); gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    sp[R] = v.s; v.s = t;
    return v;
  };
})(window.M3D = window.M3D || {});
