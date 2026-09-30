// Morph 3D renderer: WebGL2 sphere tracing of two decoded keyframes (3D textures), blended per frame, into a
// low-resolution buffer; a second pass upsamples it ('lit') or turns it into coloured halftone dots ('dots').
(function (M) {
  'use strict';
  // delta(R) measured for the v1 decoder (research/postproc/page_patch/NOTES.md); other exports bring meta.post
  const V1_LEVELS = [[64, -0.004], [96, -0.0015], [128, -0.0015]];
  const VS = `#version 300 es
  out vec2 vP; void main() { vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2); vP = p * 2.0 - 1.0; gl_Position = vec4(vP, 0, 1); }`;

  // x.decl / x.hit: extensions (m3d-neural.js: the decoder per pixel) -- declarations, and code run at a hit that may
  // move p onto a finer surface and replace the normal n and the albedo alb
  const MARCH = (x = {}) => `#version 300 es
  precision highp float; precision highp sampler3D;
  uniform sampler3D uS0, uS1, uC0, uC1;
  uniform vec4 uGrid;          // R0, R1, colour-grid sizes Rc0, Rc1
  uniform float uT, uFloor, uAspect, uTanF, uIso, uDetail, uTexel;
  uniform vec3 uEye; uniform mat3 uRot; uniform vec3 uKey; uniform vec3 uPaper;
  in vec2 vP; out vec4 oC;${x.decl || ''}
  vec3 tc(vec3 p, float R) { return (((p * 0.5 + 0.5) * (R - 1.0)) + 0.5) / R; }
  vec3 tcc(vec3 p, float R, float Rc) { return (((p * 0.5 + 0.5) * (R - 1.0) * 0.5) + 0.5) / Rc; }
  // uIso: a coarse grid can straddle a thin sheet (the EPS shell) with no negative sample; tracing that much further
  // out keeps sheets closed (a sub-pixel dilation, zero at >= 1/EPS + 1 samples per axis)
  float S(vec3 p) { return mix(texture(uS0, tc(p, uGrid.x).zyx).r, texture(uS1, tc(p, uGrid.y).zyx).r, uT) - uIso; }
  vec3 C(vec3 p) { return mix(texture(uC0, tcc(p, uGrid.x, uGrid.z).zyx).rgb, texture(uC1, tcc(p, uGrid.y, uGrid.w).zyx).rgb, uT); }
  vec2 box(vec3 ro, vec3 rd, float b) {
    vec3 m = 1.0 / rd, n = m * ro, k = abs(m) * b, t1 = -n - k, t2 = -n + k;
    return vec2(max(max(t1.x, t1.y), t1.z), min(min(t2.x, t2.y), t2.z));
  }
  // normal: central differences over >= one plane texel (uTexel), the finest scale the decoder's planes carry. A finer
  // step picks up the sub-texel staircase a fine grid resolves on slanted parts (triplane aliasing), not detail.
  vec3 nrm(vec3 p) {
    float e = max(1.0 / max(uGrid.x, uGrid.y), uTexel);
    vec2 h = vec2(e, 0);
    return normalize(vec3(S(p + h.xyy) - S(p - h.xyy), S(p + h.yxy) - S(p - h.yxy), S(p + h.yyx) - S(p - h.yyx)));
  }
  float shadow(vec3 ro, vec3 rd) {                                  // soft shadow, marched only where the volume is
    vec2 hb = box(ro, rd, 0.999);
    if (hb.x > hb.y || hb.y < 0.0) return 1.0;
    float r = 1.0, t = max(hb.x, 0.03);
    for (int i = 0; i < 32; i++) {
      float h = S(ro + rd * t); t += clamp(h, 0.012, 0.12);
      if (h < 0.07) r = min(r, 9.0 * h / t);                        // the field is truncated at 0.1: far = unoccluded
      if (r < 0.02 || t > hb.y) break;
    }
    return clamp(r, 0.0, 1.0);
  }
  float occl(vec3 p, vec3 n) {
    float o = 0.0, w = 1.0;
    for (int i = 1; i <= 5; i++) { float h = 0.015 * float(i * i); o += (h - S(p + n * h)) * w; w *= 0.65; }
    return clamp(1.0 - 2.2 * o, 0.0, 1.0);
  }
  vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
  void main() {
    vec3 rd = normalize(uRot * vec3(vP.x * uAspect * uTanF, vP.y * uTanF, -1.0)), ro = uEye;
    vec3 L = normalize(uKey), col = uPaper;
    float cov = 0.0;
    vec2 hb = box(ro, rd, 0.999);
    bool hit = false; float t = 0.0;
    if (hb.x < hb.y && hb.y > 0.0) {
      t = max(hb.x, 0.0); float tp = t;
      for (int i = 0; i < 200; i++) {
        float d = S(ro + rd * t);
        if (d < 0.0) { float a = tp, b = t; for (int j = 0; j < 6; j++) { float m = 0.5 * (a + b); if (S(ro + rd * m) < 0.0) b = m; else a = m; } t = b; hit = true; break; }
        if (d < 4e-4) { hit = true; break; }
        tp = t; t += max(d * 0.9, 0.003);
        if (t > hb.y) break;
      }
    }
    if (hit) {
      vec3 p = ro + rd * t, n = nrm(p), alb = pow(clamp(C(p), 0.0, 1.0), vec3(2.2));${x.hit || ''}
      float dif = max(dot(n, L), 0.0), sh = dif > 0.0 ? shadow(p + n * 0.01, L) : 0.0, ao = occl(p, n);
      float sky = 0.5 + 0.5 * n.y, fre = pow(1.0 - max(dot(n, -rd), 0.0), 4.0);
      if (uDetail > 0.0) {             // curvature shading: the field's Laplacian (2 x mean curvature) over two plane
        float e = 2.0 * uTexel; vec2 q = vec2(e, 0.0);   // texels: creases and grooves between parts, not the staircase
        float lap = S(p + q.xyy) + S(p - q.xyy) + S(p + q.yxy) + S(p - q.yxy) + S(p + q.yyx) + S(p - q.yyx) - 6.0 * S(p);
        float k = clamp(lap / (e * e) * 0.012 * uDetail, -1.0, 1.0);   // < 0 creases and grooves, > 0 ridges and edges
        alb *= 1.0 - 0.5 * max(-k, 0.0); ao *= 1.0 - 0.35 * max(-k, 0.0); alb += 0.12 * max(k, 0.0) * (1.0 - alb);
      }
      vec3 h = normalize(L - rd);
      vec3 lin = alb * (vec3(0.42, 0.44, 0.48) * sky * ao + vec3(0.10, 0.09, 0.08) * (1.0 - sky) * ao + 1.25 * dif * sh * vec3(1.0, 0.96, 0.9))
               + 0.18 * pow(max(dot(n, h), 0.0), 40.0) * sh + 0.10 * fre * ao;
      col = pow(aces(lin * 1.1), vec3(1.0 / 2.2)); cov = 1.0;
    } else if (rd.y < 0.0) {                                           // floor: soft shadow + contact darkening
      float tf = (uFloor - ro.y) / rd.y; vec3 p = ro + rd * tf;
      float r = length(p.xz);
      if (tf > 0.0 && r < 2.2) {
        vec3 q = vec3(p.x, uFloor + 0.004, p.z);
        float s = shadow(q, L);
        float c = all(lessThan(abs(q.xz), vec2(0.99))) ? smoothstep(0.0, 0.03, S(q + vec3(0, 0.02, 0))) : 1.0;
        float f = mix(1.0, 0.72 + 0.28 * s, smoothstep(2.2, 0.8, r)) * mix(0.8 + 0.2 * c, 1.0, smoothstep(0.5, 1.4, r));
        col = uPaper * f; cov = 1.0 - f;
      }
    }
    oC = vec4(col, cov);
  }`;

  const POST = `#version 300 es
  precision highp float;
  uniform sampler2D uImg; uniform vec2 uOut, uIn; uniform int uMode; uniform float uCell; uniform vec3 uPaper;
  in vec2 vP; out vec4 oC;
  void main() {
    vec2 px = (vP * 0.5 + 0.5) * uOut;
    if (uMode == 0) { oC = vec4(texture(uImg, px / uOut).rgb, 1.0); return; }
    vec2 cell = floor(px / uCell), ctr = (cell + 0.5) * uCell;                 // one low-res texel per dot cell
    vec4 s = texture(uImg, (cell + 0.5) / uIn);
    float lum = dot(s.rgb, vec3(0.299, 0.587, 0.114)), dark = clamp(1.0 - lum / max(dot(uPaper, vec3(0.299, 0.587, 0.114)), 1e-3), 0.0, 1.0);
    dark = max(dark - 0.015, 0.0) / 0.985;                             // 8-bit rounding of the paper must not print dots
    float rad = uCell * 0.5 * 1.15 * sqrt(dark), d = length(px - ctr);
    float a = clamp(rad - d + 0.5, 0.0, 1.0) * clamp(2.0 * rad, 0.0, 1.0);   // zero radius = no dot, not half a pixel
    vec3 ink = uMode == 1 ? clamp(s.rgb * 0.75, 0.0, 1.0) : vec3(0.08);
    oC = vec4(mix(uPaper, ink, a), 1.0);
  }`;

  function prog(gl, fs) {
    const mk = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(s)); return s; };
    const p = gl.createProgram();
    gl.attachShader(p, mk(gl.VERTEX_SHADER, VS)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(p));
    const u = {}, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const name = gl.getActiveUniform(p, i).name; u[name] = gl.getUniformLocation(p, name); }
    return { p, u };
  }
  M.glProg = (gl, fs) => prog(gl, fs);      // for the renderer extensions (m3d-level.js, m3d-glgrid.js, m3d-neural.js)
  M.marchSource = MARCH;                    // the tracing shader with extensions (m3d-neural.js)

  M.Renderer = class {
    constructor(canvas) {
      // no preserveDrawingBuffer: readers (coverage, save png) read right after draw() in the same task
      const gl = this.gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false });
      if (!gl) throw new Error('WebGL2 is not available');
      this.pendingFloors = []; this.lastFloor = -0.9;
      this.canvas = canvas;
      this.march = prog(gl, MARCH()); this.post = prog(gl, POST);
      this.vao = gl.createVertexArray();
      this.fbo = gl.createFramebuffer(); this.img = null; this.imgSize = [0, 0];
      this.pool = [];                         // recycled volume textures, keyed by size
      this.paper = [0.965, 0.957, 0.945];
      this.eps = 0.01;                        // the SDF shell half-thickness (meta.eps)
      this.levels = V1_LEVELS;
      this.texel = 2 / 127;                   // a plane texel in world units (setLevels: from the export's planes)
    }

    // Upload one decoded keyframe; returns a handle {s, c, R, Rc} to pass to draw(). Textures are recycled via release().
    alloc(R, Rc, rgba) {                      // a pooled pair of volume textures; rgba = renderable colour (GL grid path)
      const gl = this.gl;
      const i = this.pool.findIndex((t) => t.R === R && t.Rc === Rc && t.rgba === rgba);
      if (i >= 0) { const v = this.pool.splice(i, 1)[0]; v.nkey = null; return v; }   // nkey: m3d-neural.js planes tag
      const s = gl.createTexture(), c = gl.createTexture();
      for (const [t, f, n] of [[s, gl.R16F, R], [c, rgba ? gl.RGBA16F : gl.RGB16F, Rc]]) {
        gl.bindTexture(gl.TEXTURE_3D, t); gl.texStorage3D(gl.TEXTURE_3D, 1, f, n, n, n);
        for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_3D, p, gl.LINEAR);
        for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, p, gl.CLAMP_TO_EDGE);
      }
      return { s, c, R, Rc, rgba };
    }

    volume(k) {
      const gl = this.gl, R = k.R, Rc = k.Rc, v = this.alloc(R, Rc, false);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      const ty = k.half ? gl.HALF_FLOAT : gl.FLOAT;                   // half grids upload without any conversion
      gl.bindTexture(gl.TEXTURE_3D, v.s); gl.texSubImage3D(gl.TEXTURE_3D, 0, 0, 0, 0, R, R, R, gl.RED, ty, k.sdf);
      gl.bindTexture(gl.TEXTURE_3D, v.c); gl.texSubImage3D(gl.TEXTURE_3D, 0, 0, 0, 0, Rc, Rc, Rc, gl.RGB, ty, k.rgb);
      return v;
    }

    release(v) {                              // pooled for reuse; at most two big (HD) volumes, ~45 MB each at 256^3
      const big = (t) => t.R > 192;
      if (v && this.pool.length < 8 && !(big(v) && this.pool.filter(big).length >= 2)) this.pool.push(v);
      else if (v) { this.gl.deleteTexture(v.s); this.gl.deleteTexture(v.c); }
    }

    // delta(R) of the drawn threshold per export: meta.post (m3d_eval.py --post, calibrated on the exported checkpoint's
    // selection half; the threshold-only runtime uses T_k0 = iso(R) + delta_k0), else the v1 measurement for a v1
    // export, else 0 (the plain iso: an uncalibrated model gets no correction)
    setLevels(meta) {
      const p = meta.post, iso = (R) => Math.max(0, 1 / (R - 1) - (meta.eps || 0.01));
      this.calibrated = !!p;
      this.texel = 2 / ((meta.planes_res || 128) - 1);              // one texel of this export's planes (normal, curvature)
      this.levels = p ? [64, 96, 128].map((R) => [R, p['R' + R].T_k0 - iso(R)]) : meta.arch === 'v2' ? [[64, 0], [96, 0], [128, 0]] : V1_LEVELS;
    }

    // a, b: volumes; t: blend; cam: {eye, rot(mat3 column-major), fov}; style: 'lit' | 'dots' | 'mono'; scale: internal resolution
    draw(a, b, t, floor, cam, style, scale, cell) {
      const gl = this.gl, W = this.canvas.width, H = this.canvas.height;
      const dots = style !== 'lit';
      const iw = dots ? Math.ceil(W / cell) : Math.max(1, Math.round(W * scale)), ih = dots ? Math.ceil(H / cell) : Math.max(1, Math.round(H * scale));
      if (!this.img || this.imgSize[0] !== iw || this.imgSize[1] !== ih) {
        if (this.img) gl.deleteTexture(this.img);
        this.img = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, this.img);
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, iw, ih);
        for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, p, gl.CLAMP_TO_EDGE);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.img, 0);
        this.imgSize = [iw, ih];
      }
      gl.bindTexture(gl.TEXTURE_2D, this.img);
      const filt = dots ? gl.NEAREST : gl.LINEAR;
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filt); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filt);
      gl.bindVertexArray(this.vao);
      // pass 1: sphere tracing into the low-res buffer
      const m = (this.pickMarch && this.pickMarch(a, b, t)) || this.march, u = m.u;     // m3d-neural.js: at rest
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo); gl.viewport(0, 0, iw, ih); gl.useProgram(m.p);
      [[a.s, 'uS0'], [b.s, 'uS1'], [a.c, 'uC0'], [b.c, 'uC1']].forEach(([tex, name], i) => {
        gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_3D, tex); gl.uniform1i(u[name], i); });
      gl.uniform4f(u.uGrid, a.R, b.R, a.Rc, b.Rc); gl.uniform1f(u.uT, t); gl.uniform1f(u.uFloor, floor);
      // threshold T(R) = max(0, 1/(R-1) - eps) + delta(R), delta at R 64/96/128 (this.levels, setLevels / setPost),
      // linear in 1/(R-1) between them and held beyond. A calibrated export (meta.post) is drawn at exactly that T.
      // The built-in v1 table (the measured share of the thin-sheet dilation the v1 decoder does not need: E1,
      // research/postproc/page_patch/NOTES.md) is clamped at level 0, so T never erodes below the network's surface,
      // never exceeds the old iso(R), never rises with R, is 0 from R 82 up and equals the old iso at R >= 101
      const iso = (R) => {
        const K = this.levels, v = (r) => 1 / (r - 1);
        let d = R <= K[0][0] ? K[0][1] : K[K.length - 1][1];
        for (let i = 1; i < K.length; i++) if (R > K[i - 1][0] && R <= K[i][0]) {
          d = K[i - 1][1] + (K[i][1] - K[i - 1][1]) * (v(R) - v(K[i - 1][0])) / (v(K[i][0]) - v(K[i - 1][0])); break; }
        const T = Math.max(0, 1 / (R - 1) - this.eps) + d;
        return this.calibrated ? T : Math.max(0, T);     // meta.post: exactly the T the notebook scored; v1 table: clamped
      };
      gl.uniform1f(u.uIso, iso(a.R) + (iso(b.R) - iso(a.R)) * t); gl.uniform1f(u.uDetail, this.detail || 0); gl.uniform1f(u.uTexel, this.texel);
      gl.uniform1f(u.uAspect, iw / ih); gl.uniform1f(u.uTanF, Math.tan(cam.fov / 2));
      gl.uniform3fv(u.uEye, cam.eye); gl.uniformMatrix3fv(u.uRot, false, cam.rot); gl.uniform3fv(u.uKey, cam.key); gl.uniform3fv(u.uPaper, this.paper);
      if (m !== this.march) this.bindNeural(m);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      // pass 2: to the canvas
      const q = this.post;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, W, H); gl.useProgram(q.p);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.img); gl.uniform1i(q.u.uImg, 0);
      gl.uniform2f(q.u.uOut, W, H); gl.uniform2f(q.u.uIn, iw, ih); gl.uniform1i(q.u.uMode, style === 'lit' ? 0 : style === 'dots' ? 1 : 2);
      gl.uniform1f(q.u.uCell, cell); gl.uniform3fv(q.u.uPaper, this.paper);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    // mean |ink| of the last frame over the whole canvas (for the self-check / harness)
    coverage() {
      const gl = this.gl, W = this.canvas.width, H = this.canvas.height, px = new Uint8Array(W * H * 4), p = this.paper.map((v) => v * 255);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
      let s = 0;
      for (let i = 0; i < px.length; i += 12) s += Math.abs(px[i] - p[0]) + Math.abs(px[i + 1] - p[1]) + Math.abs(px[i + 2] - p[2]);
      return s / (px.length / 12) / 255;
    }
  };
})(window.M3D = window.M3D || {});
