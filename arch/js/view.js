// Arch Studio viewer (three.js): a studio for exact architectural elements.
// - Geometry arrives Z-up in metres (the kernel's space); one Group turns it Y-up. Every part is an InstancedMesh.
// - Look: AgX tone mapping, RoomEnvironment reflections, a warm key "sun" with soft PCF shadows fitted to the element,
//   N8AO ambient occlusion (so flutes, dentils and leaves read), physically based stone and metal with procedural solid
//   noise (colour, roughness and a fine bump, computed in world space so every copy differs and nothing has seams).
// - The ground is not a lit surface: it writes "how much darker than the page" (shadow, contact AO, a faint 1 m grid)
//   into an alpha-keyed buffer; the final pass tone-maps the element and multiplies the page colour for the ground, so
//   the element sits on the page itself with no horizon and no colour mismatch.
// - Modes: stone (materials), white (architect's clay model), line (white + black feature edges > 30° + silhouettes).
// - Views: three-quarter (perspective, fov 30), front / side / top (orthographic elevations and plan).

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { PBR } from './export.js';
import { polar3 } from './deform.js';
import { CELL_CAP, FILL_MAX, LIVE_CELL_CAP, BRICK_N } from './paint.js';

const DEG = Math.PI / 180;
// view directions in the kernel's Z-up frame (az: 0 = from the front (-Y), negative = from the left; el above horizon)
export const VIEWS = {
  'three-quarter': { az: -35, el: 18, ortho: false, label: '3/4' },
  front: { az: 0, el: 0, ortho: true, label: 'front' },
  side: { az: -90, el: 0, ortho: true, label: 'side' },
  top: { az: 0, el: 90, ortho: true, label: 'top' },
};
export const MODES = ['stone', 'white', 'line'];
// elements that are runs: their three-quarter view frames the near end when they are much longer than their section
const LONG_RUNS = new Set(['moulding', 'cornice', 'entablature', 'balustrade']);
// key light: front-right and fairly high, about 70° from the 3/4 camera, so cylinders model from lit to shade and the
// shadow falls back-left where the 3/4 view sees it on the ground
const SUN = { az: 35, el: 43 };
// AgX needs a bright scene: sun : sky about 6 : 1 (strong form), exposure lifts lit white stone to ~95 % of the page
const LIGHT = { sun: 12, env: 0.25, exposure: 1.7 };
// per look: light stones get less exposure and a stronger key (form, veining and texture read instead of a white
// silhouette); the white model is the brighter, softer architect's model with deeper occlusion
const LOOKS = {
  stone: { sun: 12, env: 0.22, exposure: 1.6, ao: 3.0 },
  lightStone: { sun: 13, env: 0.15, exposure: 1.32, ao: 3.2 },
  white: { sun: 10, env: 0.42, exposure: 1.75, ao: 4.2 },
  line: { sun: 12, env: 0.25, exposure: 1.7, ao: 0 },
};
const LIGHT_STONES = new Set(['marble', 'limestone', 'plaster', 'travertine', 'concrete']);

// ------------------------------------------------------------------------------------------------ materials

const NOISE_GLSL = /* glsl */`
varying vec3 vArchP;
uniform vec3 uArchA;
uniform vec3 uArchB;
uniform vec4 uArchK;   // x: mottling amount, y: grain amount, z: roughness variation, w: bump height (m)
float aH(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float aN(vec3 x) {
  vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(aH(i), aH(i + vec3(1, 0, 0)), f.x), mix(aH(i + vec3(0, 1, 0)), aH(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(aH(i + vec3(0, 0, 1)), aH(i + vec3(1, 0, 1)), f.x), mix(aH(i + vec3(0, 1, 1)), aH(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
float aF(vec3 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { s += a * aN(p); p = p * 2.03 + vec3(1.7, 9.2, 3.1); a *= 0.5; } return s / 0.9375; }
`;

// colour + roughness + height per kind; P is the world position (Y up, metres); px = world size of one pixel. Every
// high-frequency term fades out once a pixel is larger than its feature (no shimmer at a distance), and the height
// (archH, a fine bump) is grit of a fraction of a millimetre, never a lump.
const KIND_GLSL = {
  STONE: /* glsl */`
    float m = aF(P * 1.1), g = aN(P * 260.0);
    float fine = 1.0 - smoothstep(0.0006, 0.003, px);
    diffuseColor.rgb *= 1.0 + uArchK.x * (m - 0.5) * 2.0 + uArchK.y * (g - 0.5) * fine;
    diffuseColor.rgb = mix(diffuseColor.rgb, uArchA, uArchK.x * smoothstep(0.55, 0.85, aF(P * 0.35 + 7.0)) * 0.8);
    archR = m; archH = g * fine;`,
  MARBLE: /* glsl */`
    // Carrara: a white ground with soft grey clouds and wispy veins where a warped noise field crosses a level (iso-
    // contours read as natural veining), a finer secondary network close up
    float m = aF(P * 1.6);
    float cloud = smoothstep(0.45, 0.85, aF(P * 0.9 + 4.0));
    vec3 W = P + vec3(aF(P * 0.7 + 1.3), aF(P * 0.7 + 7.1), aF(P * 0.7 + 3.9)) * 0.9;
    float f1 = aF(W * vec3(0.9, 0.55, 0.9));
    float w1 = max(fwidth(f1), 1e-4);
    float v1 = 1.0 - smoothstep(0.0, 0.012 + w1, abs(f1 - 0.5));
    v1 *= smoothstep(0.3, 0.6, aF(P * 0.5 + 9.0));
    float f2 = aF(W * 2.7 + 5.0);
    float w2 = max(fwidth(f2), 1e-4);
    float v2 = (1.0 - smoothstep(0.0, 0.008 + w2, abs(f2 - 0.47))) * smoothstep(0.45, 0.7, aF(P * 1.1 - 4.0));
    float fineV = 1.0 - smoothstep(0.003, 0.015, px);
    diffuseColor.rgb *= 1.0 - 0.06 * cloud + uArchK.x * (m - 0.5);
    diffuseColor.rgb = mix(diffuseColor.rgb, uArchA, clamp(v1 * 0.75 + v2 * 0.5 * fineV, 0.0, 1.0) * uArchK.y);
    archR = m; archH = 0.0;`,
  GRANITE: /* glsl */`
    // fine crystals: dark mica and hornblende, light quartz, a few pink feldspars
    float m = aF(P * 1.4), s = aN(P * 520.0), s2 = aN(P * 310.0 + 2.0);
    float fine = 1.0 - smoothstep(0.0004, 0.0025, px);
    float speck = s > 0.7 ? 0.55 : (s < 0.24 ? 1.22 : 1.0);
    diffuseColor.rgb *= mix(0.97, speck, fine) * (1.0 + uArchK.x * (m - 0.5) * 2.0);
    diffuseColor.rgb = mix(diffuseColor.rgb, uArchA, smoothstep(0.8, 0.88, s2) * 0.55 * fine + 0.08 * (1.0 - fine));
    archR = s; archH = 0.0;`,
  TRAV: /* glsl */`
    // travertine: warm bands along the bedding and a few elongated voids
    float m = aF(P * 1.2);
    float band = aF(vec3(P.x * 0.7, P.y * 16.0, P.z * 0.7));
    float fine = 1.0 - smoothstep(0.001, 0.005, px);
    float pit = smoothstep(0.86, 0.93, aN(P * vec3(28.0, 120.0, 28.0))) * fine;
    diffuseColor.rgb *= 1.0 + uArchK.x * (m - 0.5) * 2.0;
    diffuseColor.rgb = mix(diffuseColor.rgb, uArchA, smoothstep(0.45, 0.8, band) * 0.35 + pit * 0.45);
    archR = m; archH = -pit;`,
  SAND: /* glsl */`
    // sandstone: bedding strata and sandy grain
    float m = aF(P * 1.2), g = aN(P * 300.0);
    float layer = aF(vec3(P.x * 0.4, P.y * 9.0, P.z * 0.4));
    float fine = 1.0 - smoothstep(0.0005, 0.0025, px);
    diffuseColor.rgb = mix(diffuseColor.rgb, uArchA, smoothstep(0.42, 0.78, layer) * 0.5);
    diffuseColor.rgb *= 1.0 + uArchK.x * (m - 0.5) * 1.6 + uArchK.y * (g - 0.5) * fine;
    archR = m; archH = g * fine;`,
  COPPER: /* glsl */`
    float m = aF(P * 1.6);
    float streak = aF(vec3(P.x * 7.0, P.y * 0.5, P.z * 7.0));
    diffuseColor.rgb = mix(diffuseColor.rgb, uArchA, smoothstep(0.35, 0.7, m) * 0.55);
    diffuseColor.rgb = mix(diffuseColor.rgb, uArchB, smoothstep(0.6, 0.85, streak) * 0.4);
    diffuseColor.rgb *= 1.0 + uArchK.x * (aN(P * 22.0) - 0.5);
    archR = m; archH = 0.0;`,
  PATINA: /* glsl */`
    float m = aF(P * 1.8);
    diffuseColor.rgb = mix(diffuseColor.rgb, uArchB, smoothstep(0.4, 0.85, m) * uArchK.x);
    archR = m; archH = 0.0;`,
  WOOD: /* glsl */`
    float r = length(P.xz) * 48.0 + aF(P * vec3(3.0, 0.25, 3.0)) * 5.0;
    float g = sin(r) * 0.5 + 0.5;
    float fine = 1.0 - smoothstep(0.002, 0.008, px);
    diffuseColor.rgb = mix(diffuseColor.rgb, uArchA, (g * g * 0.6) * mix(0.4, 1.0, fine));
    diffuseColor.rgb *= 1.0 + uArchK.x * (aF(P * 0.8) - 0.5) * 2.0;
    archR = g; archH = g * fine;`,
  PLAIN: /* glsl */`archR = 0.5; archH = 0.0;`,
};

// per material key: noise kind, tints, amounts (k: mottling, grain/vein strength, roughness variation, bump m), extras
const LOOK = {
  marble: { kind: 'MARBLE', a: '#8a8d94', k: [0.02, 0.7, 0.06, 0], sheen: 0.3 },
  limestone: { kind: 'STONE', a: '#c4b69c', k: [0.04, 0.035, 0.08, 0.00015] },
  sandstone: { kind: 'SAND', a: '#9a6c37', k: [0.045, 0.05, 0.06, 0.0002] },
  granite: { kind: 'GRANITE', a: '#a5806f', k: [0.03, 0, 0.12, 0] },
  travertine: { kind: 'TRAV', a: '#b19d7b', k: [0.03, 0, 0.08, 0.0006] },
  plaster: { kind: 'STONE', a: '#e6e2da', k: [0.012, 0.012, 0.03, 0.00008] },
  concrete: { kind: 'STONE', a: '#8e8c88', k: [0.055, 0.06, 0.08, 0.00015] },
  terracotta: { kind: 'STONE', a: '#4f1f0f', k: [0.08, 0.05, 0.06, 0.0001] },
  brick: { kind: 'STONE', a: '#3f1a0f', k: [0.1, 0.07, 0.06, 0.00015] },
  slate: { kind: 'STONE', a: '#3b424c', k: [0.05, 0.03, 0.1, 0.00005] },
  copper: { kind: 'COPPER', a: '#244a41', b: '#4f3a2a', k: [0.06, 0, 0.1, 0] },
  lead: { kind: 'PATINA', b: '#b8bbbc', k: [0.35, 0, 0.12, 0] },
  zinc: { kind: 'PATINA', b: '#c4c8ca', k: [0.2, 0, 0.1, 0] },
  bronze: { kind: 'PATINA', b: '#4c5a3f', k: [0.35, 0, 0.12, 0] },
  gold: { kind: 'PATINA', b: '#c99a3a', k: [0.15, 0, 0.08, 0] },
  wood: { kind: 'WOOD', a: '#45301a', k: [0.06, 0, 0.06, 0.0002] },
  glass: { kind: 'PLAIN', k: [0, 0, 0, 0] },
};

// ------------------------------------------------------------------------------------------------ paint (paint.js)
//
// The dab field, evaluated per fragment in the part's own coordinates (the position before the instance transform):
// the part's header (3 texels) gives its grid; the fragment's cell lists the dabs that reach it, in order, merged with
// the part's fills; dabs of one stroke build up to the stroke's opacity, strokes go over each other, erase strokes
// remove paint. The stroke in progress is a uniform list evaluated directly (merged into the textures when it fills).
// Any material can carry it (stone and the white model do); a mesh without the aPaintPart attribute reads 0: no paint.
const PAINT_U = {
  uPaintOn: { value: 0 },
  // seven samplers in all (a lit material has 16 texture units, its own maps take up to 5): the headers, the cell
  // tables and index lists are packed into one float and one integer texture with offsets
  uPDab: { value: null }, uPMeta: { value: null }, uPUint: { value: null },
  uPLDab: { value: null }, uPLUint: { value: null }, uFCol: { value: null }, uFFin: { value: null },
  uPOff: { value: new THREE.Vector4() }, uPOff2: { value: new THREE.Vector4() },
  uFieldOn: { value: 0 },
  uPLiveG: { value: new THREE.Vector4(0, 0, 0, 1) }, uPLiveH: { value: new THREE.Vector4() },
  uPLiveA: { value: new Float32Array(48 * 4) }, uPLiveB: { value: new Float32Array(48 * 4) },
  uPLiveC: { value: new THREE.Vector4() }, uPLiveD: { value: new THREE.Vector4() },
};
const PAINT_VERT_HEAD = /* glsl */`
attribute float aPaintPart;
varying vec3 vPaintP;
flat varying float vPaintPart;
flat varying float vPaintI;`;
const PAINT_VERT = /* glsl */`
vPaintP = transformed; vPaintPart = aPaintPart;
#ifdef USE_INSTANCING
  vPaintI = float(gl_InstanceID);
#else
  vPaintI = 0.0;
#endif`;
// the same hash as paint.js hash3 (uint arithmetic wraps like Math.imul)
const PAINT_FRAG_HEAD = /* glsl */`
uniform float uPaintOn;
uniform highp sampler2D uPDab; uniform highp sampler2D uPMeta; uniform highp usampler2D uPUint;
uniform highp sampler2D uPLDab; uniform highp usampler2D uPLUint; uniform vec4 uPOff; uniform vec4 uPOff2;
uniform vec4 uPLiveG; uniform vec4 uPLiveH;
uniform highp sampler2D uFCol; uniform highp sampler2D uFFin; uniform float uFieldOn;
uniform vec4 uPLiveA[48]; uniform vec4 uPLiveB[48]; uniform vec4 uPLiveC; uniform vec4 uPLiveD;
varying vec3 vPaintP;
flat varying float vPaintPart;
flat varying float vPaintI;
vec3 apC; float apA; float apT; vec2 apF;
float apId; float apAcc; float apLim; float apCap; float apKind; vec3 apCol; vec2 apFin; float apHard; float apFlow;
ivec2 apAt(int j) { return ivec2(j & 1023, j >> 10); }
vec2 apFinish(float f) { return f < 0.5 ? vec2(0.82, 0.0) : f < 1.5 ? vec2(0.16, 0.0) : vec2(0.26, 1.0); }
void apFlush() {
  if (apId < 0.0) return;
  float s = apCap * min(apAcc, apLim);
  if (apKind < 0.5 || apKind > 1.5) { apC += apT * s * apCol; apA += apT * s; apF += apT * s * apFin; }
  apT *= 1.0 - s;
  apId = -1.0; apAcc = 0.0; apLim = 0.0;
}
void apStart(float id, vec3 col, float cap, float kf, float hf) {
  if (id == apId) return;
  apFlush();
  apId = id; apCol = col; apCap = cap; apKind = floor(kf / 4.0 + 0.01); apFin = apFinish(kf - apKind * 4.0);
  apHard = mod(hf, 256.0) / 255.0; apFlow = floor(hf / 256.0 + 0.001) / 255.0;
}
void apDab(vec3 c, float r, float p, float px) {
  float w = max(r * (1.0 - apHard), px);
  float cov = 1.0 - smoothstep(r - w, r, length(vPaintP - c));
  apAcc += cov * apFlow * (1.0 - apAcc);
  apLim = max(apLim, cov * p);
}
uint apHash(ivec3 c) { return (uint(c.x) * 73856093u) ^ (uint(c.y) * 19349663u) ^ (uint(c.z) * 83492791u); }
// the committed grid's cell: start and count in the index list
ivec2 apCell(ivec3 c, int hoff, int hsize) {
  if (hsize == 0 || any(lessThan(c, ivec3(0))) || any(greaterThan(c, ivec3(65535, 65535, 65534)))) return ivec2(0);
  uint k0 = uint(c.x) | (uint(c.y) << 16), k1 = uint(c.z) + 1u, mask = uint(hsize - 1), h = apHash(c) & mask;
  for (int i = 0; i < 32; i++) {
    uvec4 e = texelFetch(uPUint, apAt(hoff + int(h)), 0);
    if (e.y == 0u) break;
    if (e.x == k0 && e.y == k1) return ivec2(e.z, e.w);
    h = (h + 1u) & mask;
  }
  return ivec2(0);
}
// the live grid's cell: the head of its list (1-based, newest first)
int apLiveHead(ivec3 c, int hsize) {
  if (hsize == 0 || any(lessThan(c, ivec3(0))) || any(greaterThan(c, ivec3(65535, 65535, 65534)))) return 0;
  uint k0 = uint(c.x) | (uint(c.y) << 16), k1 = uint(c.z) + 1u, mask = uint(hsize - 1), h = apHash(c) & mask;
  for (int i = 0; i < 32; i++) {
    uvec4 e = texelFetch(uPLUint, apAt(int(h)), 0);
    if (e.y == 0u) break;
    if (e.x == k0 && e.y == k1) return int(e.z);
    h = (h + 1u) & mask;
  }
  return 0;
}
// the flattened field (paint.js packField): its layer for this part and copy, then a trilinear sample inside one brick
int apBrick(ivec3 c, int hoff, int hsize) {
  if (hsize == 0 || any(lessThan(c, ivec3(0))) || any(greaterThan(c, ivec3(65535, 65535, 65534)))) return -1;
  uint k0 = uint(c.x) | (uint(c.y) << 16), k1 = uint(c.z) + 1u, mask = uint(hsize - 1), h = apHash(c) & mask;
  for (int i = 0; i < 32; i++) {
    uvec4 e = texelFetch(uPUint, apAt(int(uPOff2.y + 0.5) + hoff + int(h)), 0);
    if (e.y == 0u) break;
    if (e.x == k0 && e.y == k1) return int(e.z);
    h = (h + 1u) & mask;
  }
  return -1;
}
void apField(int pi) {
  int oH = int(uPOff.x + 0.5), oL = int(uPOff.y + 0.5), oC = int(uPOff.z + 0.5);
  vec4 h0 = texelFetch(uPMeta, apAt(oH + pi * 3), 0);
  if (h0.w < 0.5) return;
  int layer = int(h0.x + 0.5) - 1, cs = int(h0.y + 0.5), cc = int(h0.z + 0.5);
  for (int i = 0; i < 64; i++) {
    if (i >= cc) break;
    vec4 e = texelFetch(uPMeta, apAt(oC + cs + i), 0);
    if (abs(e.x - vPaintI) < 0.5) { layer = int(e.y + 0.5); break; }
  }
  vec4 h1 = texelFetch(uPMeta, apAt(oH + pi * 3 + 1), 0), h2 = texelFetch(uPMeta, apAt(oH + pi * 3 + 2), 0);
  vec4 L0 = texelFetch(uPMeta, apAt(oL + layer * 4), 0), L1 = texelFetch(uPMeta, apAt(oL + layer * 4 + 1), 0);
  vec3 g = (vPaintP * h1.xyz + h2.xyz - L0.xyz) / L0.w;
  ivec3 b = ivec3(floor(g / 8.0));
  int bi = apBrick(b, int(L1.x + 0.5), int(L1.y + 0.5));
  vec4 fc; vec2 ff;
  if (bi < 0) { fc = texelFetch(uPMeta, apAt(oL + layer * 4 + 2), 0); ff = texelFetch(uPMeta, apAt(oL + layer * 4 + 3), 0).xy; }
  else {
    vec3 l = g - vec3(b) * 8.0;
    ivec3 l0 = min(ivec3(floor(l)), ivec3(7));
    vec3 t = clamp(l - vec3(l0), 0.0, 1.0);
    int base = bi * ${BRICK_N} + l0.x + 9 * (l0.y + 9 * l0.z);
    vec4 c000 = texelFetch(uFCol, apAt(base), 0), c100 = texelFetch(uFCol, apAt(base + 1), 0);
    vec4 c010 = texelFetch(uFCol, apAt(base + 9), 0), c110 = texelFetch(uFCol, apAt(base + 10), 0);
    vec4 c001 = texelFetch(uFCol, apAt(base + 81), 0), c101 = texelFetch(uFCol, apAt(base + 82), 0);
    vec4 c011 = texelFetch(uFCol, apAt(base + 90), 0), c111 = texelFetch(uFCol, apAt(base + 91), 0);
    fc = mix(mix(mix(c000, c100, t.x), mix(c010, c110, t.x), t.y), mix(mix(c001, c101, t.x), mix(c011, c111, t.x), t.y), t.z);
    vec2 f000 = texelFetch(uFFin, apAt(base), 0).xy, f100 = texelFetch(uFFin, apAt(base + 1), 0).xy;
    vec2 f010 = texelFetch(uFFin, apAt(base + 9), 0).xy, f110 = texelFetch(uFFin, apAt(base + 10), 0).xy;
    vec2 f001 = texelFetch(uFFin, apAt(base + 81), 0).xy, f101 = texelFetch(uFFin, apAt(base + 82), 0).xy;
    vec2 f011 = texelFetch(uFFin, apAt(base + 90), 0).xy, f111 = texelFetch(uFFin, apAt(base + 91), 0).xy;
    ff = mix(mix(mix(f000, f100, t.x), mix(f010, f110, t.x), t.y), mix(mix(f001, f101, t.x), mix(f011, f111, t.x), t.y), t.z);
  }
  apC += apT * fc.rgb; apA += apT * fc.a; apF += apT * ff;
}
void archPaint(float px) {
  apC = vec3(0.0); apA = 0.0; apT = 1.0; apF = vec2(0.0); apId = -1.0; apAcc = 0.0; apLim = 0.0;
  int pi = int(vPaintPart + 0.5) - 1;
  if (pi < 0) return;
  // 1. the stroke in progress: its newest dabs (uniforms), then its live grid (newest first)
  int n = int(uPLiveD.z + 0.5);
  for (int q = 0; q < 48; q++) {
    if (q >= n) break;
    int k = n - 1 - q;
    vec4 b = uPLiveB[k];
    if (abs(b.z - vPaintPart) > 0.5 || (b.y >= 0.0 && abs(b.y - vPaintI) > 0.5)) continue;
    apStart(uPLiveD.w, uPLiveC.rgb, uPLiveC.a, uPLiveD.y, uPLiveD.x);
    vec4 a = uPLiveA[k];
    apDab(a.xyz, a.w, b.x, px);
  }
  if (uPLiveH.y > 0.5) {
    int e = apLiveHead(ivec3(floor((vPaintP - uPLiveG.xyz) / uPLiveG.w)), int(uPLiveH.x + 0.5));
    for (int it = 0; it < ${LIVE_CELL_CAP}; it++) {
      if (e == 0) break;
      uvec4 en = texelFetch(uPLUint, apAt(int(uPLiveH.z + 0.5) + ((e - 1) >> 1)), 0);
      bool odd = ((e - 1) & 1) == 1;
      int d = int(odd ? en.z : en.x);
      e = int(odd ? en.w : en.y);
      vec4 t1 = texelFetch(uPLDab, apAt(d * 2 + 1), 0);
      if (abs(t1.x - vPaintPart) > 0.5 || (t1.y >= 0.0 && abs(t1.y - vPaintI) > 0.5)) continue;
      vec4 t0 = texelFetch(uPLDab, apAt(d * 2), 0);
      apStart(uPLiveD.w, uPLiveC.rgb, uPLiveC.a, uPLiveD.y, uPLiveD.x);
      apDab(t0.xyz, t0.w, t1.z, px);
    }
  }
  // 2. the committed paint, newest first (the cell's list merged with the part's fills), until it is covered
  vec4 h0 = texelFetch(uPMeta, apAt(pi * 3), 0), h1 = texelFetch(uPMeta, apAt(pi * 3 + 1), 0), h2 = texelFetch(uPMeta, apAt(pi * 3 + 2), 0);
  if (h2.x > 0.5) {
    ivec2 sc = apCell(ivec3(floor((vPaintP - h0.xyz) / h0.w)), int(h1.x + 0.5), int(h1.y + 0.5));
    int st = sc.x, i = sc.y - 1, fs = int(h1.z + 0.5), j = int(h1.w + 0.5) - 1;
    for (int it = 0; it < ${CELL_CAP + FILL_MAX}; it++) {
      if ((i < 0 && j < 0) || apT < 1e-3) break;
      int oI = int(uPOff2.x + 0.5);
      uint di = i >= 0 ? texelFetch(uPUint, apAt(oI + ((st + i) >> 2)), 0)[(st + i) & 3] : 0u;
      uint dj = j >= 0 ? texelFetch(uPUint, apAt(oI + ((fs + j) >> 2)), 0)[(fs + j) & 3] : 0u;
      int d;
      if (i >= 0 && (j < 0 || di > dj)) { d = int(di); i--; } else { d = int(dj); j--; }
      vec4 t2 = texelFetch(uPDab, apAt(d * 3 + 2), 0);
      float cp = floor(t2.y / 16.0 + 0.001) - 1.0;
      if (cp >= 0.0 && abs(cp - vPaintI) > 0.5) continue;
      vec4 t1 = texelFetch(uPDab, apAt(d * 3 + 1), 0);
      float kf = t2.y - (cp + 1.0) * 16.0;
      apStart(t2.z, t1.rgb, t1.a, kf, t2.x);
      if (kf > 7.5) { apAcc = 1.0; apLim = 1.0; continue; }
      vec4 t0 = texelFetch(uPDab, apAt(d * 3), 0);
      apDab(t0.xyz, t0.w, t2.w, px);
    }
  }
  apFlush();
  if (uFieldOn > 0.5 && apT >= 1e-3) apField(pi);
}`;
const PAINT_FRAG = /* glsl */`
if (uPaintOn > 0.5) {
  archPaint(max(length(fwidth(vPaintP)) * 0.75, 1e-5));
  if (apA > 0.001) {
    vec3 pc = apC / apA; vec2 pf = apF / apA;
    // pigment on the material: a little of the stone's own mottling shows through (limewash, not plastic)
    float lum0 = max(dot(diffuse, vec3(0.2126, 0.7152, 0.0722)), 1e-3);
    float tex = clamp(dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722)) / lum0, 0.7, 1.3);
    diffuseColor.rgb = diffuseColor.rgb * (1.0 - apA) + pc * mix(1.0, tex, 0.4 * (1.0 - pf.y)) * apA;
    roughnessFactor = mix(roughnessFactor, pf.x, apA);
    metalnessFactor = mix(metalnessFactor, pf.y, apA);
  }
}`;
/** Shader edits that add the paint to a lit material (call from its onBeforeCompile). */
function injectPaint(sh) {
  Object.assign(sh.uniforms, PAINT_U);
  sh.vertexShader = sh.vertexShader
    .replace('#include <common>', '#include <common>\n' + PAINT_VERT_HEAD)
    .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + PAINT_VERT);
  sh.fragmentShader = sh.fragmentShader
    .replace('#include <common>', '#include <common>\n' + PAINT_FRAG_HEAD)
    .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n' + PAINT_FRAG);
}
const TEX_FMT = {
  rgba32f: [THREE.RGBAFormat, THREE.FloatType, 4, Float32Array],
  rgba16f: [THREE.RGBAFormat, THREE.HalfFloatType, 4, Uint16Array],
  rgba8: [THREE.RGBAFormat, THREE.UnsignedByteType, 4, Uint8Array],
  rgba32ui: [THREE.RGBAIntegerFormat, THREE.UnsignedIntType, 4, Uint32Array],
  rg32ui: [THREE.RGIntegerFormat, THREE.UnsignedIntType, 2, Uint32Array],
  r32ui: [THREE.RedIntegerFormat, THREE.UnsignedIntType, 1, Uint32Array],
};
const INTERNAL = { rgba32f: 'RGBA32F', rgba16f: 'RGBA16F', rgba8: 'RGBA8', rgba32ui: 'RGBA32UI', rg32ui: 'RG32UI', r32ui: 'R32UI' };
function paintTex(data, rows, kind) {
  const [format, type] = TEX_FMT[kind];
  const t = new THREE.DataTexture(data, 1024, rows, format, type);
  t.internalFormat = INTERNAL[kind];
  t.minFilter = t.magFilter = THREE.NearestFilter; t.generateMipmaps = false; t.flipY = false; t.unpackAlignment = 1;
  t.needsUpdate = true;
  return t;
}
/** Every paint sampler needs a texture of its own kind from the first frame (an integer sampler with the default
 *  float texture bound fails the draw). */
function paintDefaults() {
  const U = PAINT_U;
  if (!U.uPLDab.value) { putTex('uPLDab', new Float32Array(4), 'rgba32f'); putTex('uPLUint', new Uint32Array(4), 'rgba32ui'); }
  if (!U.uFCol.value) { putTex('uFCol', new Uint16Array(4), 'rgba16f'); putTex('uFFin', new Uint8Array(4), 'rgba8'); }
  if (!U.uPDab.value) { putTex('uPDab', new Float32Array(4), 'rgba32f'); putTex('uPMeta', new Float32Array(4), 'rgba32f'); putTex('uPUint', new Uint32Array(4), 'rgba32ui'); }
}
/** A paint texture from a typed array (padded to whole rows of 1024 texels); reused while its size holds. */
function putTex(name, data, kind) {
  const per = TEX_FMT[kind][2], rows = Math.max(1, Math.ceil(data.length / (1024 * per)));
  let arr = data;
  if (data.length !== rows * 1024 * per) { arr = new (TEX_FMT[kind][3])(rows * 1024 * per); arr.set(data.subarray ? data.subarray(0, Math.min(data.length, arr.length)) : data); }
  const u = PAINT_U[name], t = u.value;
  if (t && t.image.height === rows && t.userData.kind === kind) { t.image.data = arr; t.needsUpdate = true; return; }
  if (t) t.dispose();
  u.value = paintTex(arr, rows, kind);
  u.value.userData.kind = kind;
}
// the pick pass: part-local position (float bits) and part | copy << 12 per pixel, in an integer target (core WebGL2)
const PICK_VERT = /* glsl */`
attribute float aPaintPart;
varying vec3 vP;
flat varying int vPart;
flat varying int vI;
void main() {
  vec4 p = vec4(position, 1.0);
  #ifdef USE_INSTANCING
    p = instanceMatrix * p;
    vI = gl_InstanceID;
  #else
    vI = 0;
  #endif
  vP = position; vPart = int(aPaintPart + 0.5);
  gl_Position = projectionMatrix * modelViewMatrix * p;
}`;
const PICK_FRAG = /* glsl */`
layout(location = 0) out highp uvec4 pickOut;
varying vec3 vP;
flat varying int vPart;
flat varying int vI;
void main() { pickOut = uvec4(floatBitsToUint(vP.x), floatBitsToUint(vP.y), floatBitsToUint(vP.z), uint(vPart) | (uint(vI) << 12)); }`;

function stoneMaterial(key) {
  const p = PBR[key] || PBR.limestone, look = LOOK[key] || LOOK.limestone;
  const mat = new THREE.MeshPhysicalMaterial({ color: new THREE.Color(p.color), roughness: p.roughness, metalness: p.metalness });
  if (look.sheen) { mat.sheen = look.sheen; mat.sheenRoughness = 0.55; mat.sheenColor = new THREE.Color('#fff4ea'); }
  if (key === 'glass') { mat.ior = 1.52; mat.specularIntensity = 1; mat.envMapIntensity = 1.4; }
  const uniforms = {
    uArchA: { value: new THREE.Color(look.a || p.color) }, uArchB: { value: new THREE.Color(look.b || p.color) },
    uArchK: { value: new THREE.Vector4(...look.k) },
  };
  mat.userData.arch = uniforms;
  const bump = look.k[3] > 0;
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    injectPaint(sh);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vArchP;')
      .replace('#include <project_vertex>', `#include <project_vertex>
        vec4 archP = vec4(transformed, 1.0);
        #if defined(USE_INSTANCING) && !defined(ARCH_DEFORM)
          archP = instanceMatrix * archP;
        #endif
        vArchP = (modelMatrix * archP).xyz;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + NOISE_GLSL)
      .replace('#include <color_fragment>', `#include <color_fragment>
        float archR = 0.5, archH = 0.0;
        { vec3 P = vArchP; float px = length(fwidth(vArchP)); ${KIND_GLSL[look.kind]} }`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = clamp(roughnessFactor + uArchK.z * (archR - 0.5) * 2.0, 0.04, 1.0);`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        ${bump ? `{
          float hh = archH * uArchK.w;
          vec3 sx = dFdx(-vViewPosition), sy = dFdy(-vViewPosition);
          vec3 r1 = cross(sy, normal), r2 = cross(normal, sx);
          float det = dot(sx, r1) * faceDirection;
          vec3 grad = sign(det) * (dFdx(hh) * r1 + dFdy(hh) * r2);
          normal = normalize(abs(det) * normal - grad);
        }` : ''}`);
  };
  mat.customProgramCacheKey = () => 'arch-p-' + look.kind + (bump ? '-b' : '') + (look.sheen ? '-s' : '');
  return mat;
}

/** The material key covering the largest surface (triangle areas × instances). */
function dominantMaterial(meshes) {
  const area = new Map();
  for (const m of meshes) {
    const P = m.positions, T = m.indices;
    let a = 0;
    for (let t = 0; t < T.length; t += 3) {
      const i = T[t] * 3, j = T[t + 1] * 3, k = T[t + 2] * 3;
      const ux = P[j] - P[i], uy = P[j + 1] - P[i + 1], uz = P[j + 2] - P[i + 2];
      const vx = P[k] - P[i], vy = P[k + 1] - P[i + 1], vz = P[k + 2] - P[i + 2];
      a += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    }
    const n = m.transforms ? m.transforms.length / 16 : 1;
    area.set(m.material, (area.get(m.material) || 0) + a * n);
  }
  let best = null, bestA = -1;
  for (const [k, a] of area) if (a > bestA) { best = k; bestA = a; }
  return best;
}

// ------------------------------------------------------------------------------------------------ GPU deformation preview
//
// While a transform slider or a lattice handle moves, the undeformed element is drawn deformed by a vertex shader that
// evaluates the same map as deform.js (the worker bakes the exact, refined, watertight result on release). Bend, twist,
// taper, shear (lean) and stretch are all "axis ops": a point's image depends on its coordinate t along the op's axis
// and is affine in the two cross coordinates (Barr's deformations). So each op is sampled from deform.js's own compiled
// map into a table over t — T(t) = image of the axis point, P(t), Q(t) = images of the two cross unit vectors — and the
// shader interpolates it: no maths is duplicated, the preview is the engine's map (1024 samples over the op's input
// frame; a table step of L/850 bends a 3 m rail to within micrometres). FFD is evaluated directly (Bernstein sums
// over the control-point offsets). Normals come from the Jacobian of the whole chain (forward differences, cofactor
// matrix). Rigid ornament is moved on the CPU by the engine's own instance formula (point + polar rotation of J).

const DEF_MAX_OPS = 8, DEF_SAMPLES = 1024, DEF_MAX_DEG = 6;
const AXIS = { x: 0, y: 1, z: 2 };

const DEFORM_GLSL = /* glsl */`
uniform highp sampler2D uDefTab;
uniform highp sampler2D uDefOff;
uniform int uDefN;
uniform int uDefSamples;
uniform int uDefAxis[${DEF_MAX_OPS}];
uniform vec3 uDefC[${DEF_MAX_OPS}];
uniform vec2 uDefDom[${DEF_MAX_OPS}];
uniform int uDefFFD;
uniform ivec3 uDefDims;
uniform vec3 uDefMin;
uniform vec3 uDefSize;
uniform float uDefGround;
uniform float uDefH;
float archAx(vec3 v, int a) { return a == 0 ? v.x : (a == 1 ? v.y : v.z); }
vec3 archRow(int row, float s) {
  int N = uDefSamples; float hi = float(N - 1);
  if (s <= 0.0) { vec3 a = texelFetch(uDefTab, ivec2(0, row), 0).xyz, b = texelFetch(uDefTab, ivec2(1, row), 0).xyz; return a + (b - a) * s; }
  if (s >= hi) { vec3 a = texelFetch(uDefTab, ivec2(N - 2, row), 0).xyz, b = texelFetch(uDefTab, ivec2(N - 1, row), 0).xyz; return b + (b - a) * (s - hi); }
  int i = int(s); float f = s - float(i);
  return mix(texelFetch(uDefTab, ivec2(i, row), 0).xyz, texelFetch(uDefTab, ivec2(i + 1, row), 0).xyz, f);
}
vec3 archOp(int k, vec3 v) {
  int a = uDefAxis[k]; vec3 c = uDefC[k]; vec2 dom = uDefDom[k];
  float s = (archAx(v, a) - dom.x) / (dom.y - dom.x) * float(uDefSamples - 1);
  int p = a == 0 ? 1 : (a == 1 ? 2 : 0), q = a == 0 ? 2 : (a == 1 ? 0 : 1);
  return archRow(3 * k, s) + archRow(3 * k + 1, s) * (archAx(v, p) - archAx(c, p)) + archRow(3 * k + 2, s) * (archAx(v, q) - archAx(c, q));
}
void archBern(int deg, float x, out float b[${DEF_MAX_DEG + 1}]) {
  float px[${DEF_MAX_DEG + 1}], qx[${DEF_MAX_DEG + 1}];
  px[0] = 1.0; qx[0] = 1.0;
  for (int i = 1; i <= ${DEF_MAX_DEG}; i++) { px[i] = px[i - 1] * x; qx[i] = qx[i - 1] * (1.0 - x); }
  float c = 1.0;
  for (int i = 0; i <= ${DEF_MAX_DEG}; i++) {
    b[i] = 0.0;
    if (i <= deg) { b[i] = c * px[i] * qx[deg - i]; c = c * float(deg - i) / float(i + 1); }
  }
}
vec3 archFFD(vec3 v) {
  vec3 s = clamp((v - uDefMin) / uDefSize, 0.0, 1.0);
  float bs[${DEF_MAX_DEG + 1}], bt[${DEF_MAX_DEG + 1}], bu[${DEF_MAX_DEG + 1}];
  archBern(uDefDims.x, s.x, bs); archBern(uDefDims.y, s.y, bt); archBern(uDefDims.z, s.z, bu);
  vec3 d = vec3(0.0); int id = 0;
  for (int k = 0; k <= ${DEF_MAX_DEG}; k++) { if (k > uDefDims.z) break;
    for (int j = 0; j <= ${DEF_MAX_DEG}; j++) { if (j > uDefDims.y) break;
      float w2 = bu[k] * bt[j];
      for (int i = 0; i <= ${DEF_MAX_DEG}; i++) { if (i > uDefDims.x) break;
        d += w2 * bs[i] * texelFetch(uDefOff, ivec2(id, 0), 0).xyz; id++; } } }
  return v + d;
}
vec3 archDeform(vec3 v) {
  for (int k = 0; k < ${DEF_MAX_OPS}; k++) { if (k >= uDefN) break; v = archOp(k, v); }
  if (uDefFFD > 0) v = archFFD(v);
  v.z += uDefGround;
  return v;
}
vec3 archInst(vec3 p) {
  #ifdef USE_INSTANCING
    return (instanceMatrix * vec4(p, 1.0)).xyz;
  #else
    return p;
  #endif
}
vec3 archInstN(vec3 n) {
  #ifdef USE_INSTANCING
    mat3 im = mat3(instanceMatrix);
    n /= vec3(dot(im[0], im[0]), dot(im[1], im[1]), dot(im[2], im[2]));
    return im * n;
  #else
    return n;
  #endif
}
`;

/** Shader edits that move a material's vertices (and normals) through the deformation, in kernel space. */
function injectDeform(sh) {
  let v = sh.vertexShader.replace('#include <common>', '#include <common>\n' + DEFORM_GLSL);
  v = v.replace('#include <beginnormal_vertex>', `
    #define ARCH_HAS_N
    vec3 archQ = archInst(position);
    vec3 archF0 = archDeform(archQ);
    vec3 archJx = (archDeform(archQ + vec3(uDefH, 0.0, 0.0)) - archF0) / uDefH;
    vec3 archJy = (archDeform(archQ + vec3(0.0, uDefH, 0.0)) - archF0) / uDefH;
    vec3 archJz = (archDeform(archQ + vec3(0.0, 0.0, uDefH)) - archF0) / uDefH;
    vec3 archNi = archInstN(vec3(normal));
    vec3 archN = archNi.x * cross(archJy, archJz) + archNi.y * cross(archJz, archJx) + archNi.z * cross(archJx, archJy);
    archN = dot(archN, archN) > 1e-30 ? normalize(archN) : archNi;
    archQ = archF0;
    vec3 objectNormal = archN;`);
  v = v.replace('#include <defaultnormal_vertex>', `
    vec3 transformedNormal = normalMatrix * objectNormal;
    #ifdef FLIP_SIDED
      transformedNormal = - transformedNormal;
    #endif`);
  v = v.replace('#include <begin_vertex>', `
    #ifndef ARCH_HAS_N
      vec3 archQ = archDeform(archInst(position));
    #endif
    vec3 transformed = archQ;`);
  v = v.replace('#include <project_vertex>', `
    vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0);
    gl_Position = projectionMatrix * mvPosition;`);
  v = v.replace('#include <worldpos_vertex>', `
    #if defined( USE_ENVMAP ) || defined( DISTANCE ) || defined ( USE_SHADOWMAP ) || defined ( USE_TRANSMISSION ) || NUM_SPOT_LIGHT_COORDS > 0
      vec4 worldPosition = modelMatrix * vec4(transformed, 1.0);
    #endif`);
  sh.vertexShader = v;
}

/** The uniforms every deforming material shares, filled from deform.js's deformer. */
class DeformUniforms {
  constructor() {
    this.tab = new Float32Array(DEF_SAMPLES * 3 * DEF_MAX_OPS * 4);
    this.tabTex = new THREE.DataTexture(this.tab, DEF_SAMPLES, 3 * DEF_MAX_OPS, THREE.RGBAFormat, THREE.FloatType);
    this.off = new Float32Array(343 * 4);
    this.offTex = new THREE.DataTexture(this.off, 343, 1, THREE.RGBAFormat, THREE.FloatType);
    for (const t of [this.tabTex, this.offTex]) { t.minFilter = t.magFilter = THREE.NearestFilter; t.generateMipmaps = false; t.needsUpdate = true; }
    this.u = {
      uDefTab: { value: this.tabTex }, uDefOff: { value: this.offTex }, uDefN: { value: 0 }, uDefSamples: { value: DEF_SAMPLES },
      uDefAxis: { value: new Array(DEF_MAX_OPS).fill(2) }, uDefC: { value: Array.from({ length: DEF_MAX_OPS }, () => new THREE.Vector3()) },
      uDefDom: { value: Array.from({ length: DEF_MAX_OPS }, () => new THREE.Vector2(0, 1)) }, uDefFFD: { value: 0 },
      uDefDims: { value: new THREE.Vector3(1, 1, 1) }, uDefMin: { value: new THREE.Vector3() }, uDefSize: { value: new THREE.Vector3(1, 1, 1) },
      uDefGround: { value: 0 }, uDefH: { value: 1e-3 },
    };
  }

  /** Fill from ops (resolved list) and D = makeDeformer(ops, bbox). Returns false when an op cannot run on the GPU. */
  set(ops, D, ground) {
    const u = this.u, diag = Math.hypot(...[0, 1, 2].map((k) => D.bbox.max[k] - D.bbox.min[k])) || 1;
    let n = 0, ci = 0, ffd = null;
    const v = new Float64Array(3);
    for (let k = 0; k < ops.length; k++) {
      const F = D.frames[k];
      if (!F) continue;
      const c = D.compiled[ci++], type = c.type;
      if (type === 'ffd') {
        if (ffd || ci < D.compiled.length) return false;   // the shader runs FFD after the axis ops: it must be last
        ffd = c; continue;
      }
      if (n >= DEF_MAX_OPS) return false;
      const op = ops[k], ai = Number.isInteger(c.axis) ? c.axis : AXIS[op.axis ?? (type === 'bend' ? 'x' : 'z')];
      const p = (ai + 1) % 3, q = (ai + 2) % 3, cen = [0, 1, 2].map((a) => (F.min[a] + F.max[a]) / 2);
      // 1024 samples over the input frame (+10 % each side), interpolated linearly: the table follows the map to within
      // (sample step)^2 x curvature / 8. Where the map has a kink — a stretch with ease 0 between its keep zone and the
      // stretched zone, or a shear's range end — the preview rounds it over one sample step (L / 850, ~4 mm on a 3.6 m
      // column), invisible at any zoom the viewer allows; the bake places the kink exactly.
      const L = Math.max(F.max[ai] - F.min[ai], 1e-6), t0 = F.min[ai] - 0.1 * L, t1 = F.max[ai] + 0.1 * L;
      const base = 3 * n * DEF_SAMPLES * 4;
      for (let i = 0; i < DEF_SAMPLES; i++) {
        const t = t0 + ((t1 - t0) * i) / (DEF_SAMPLES - 1);
        v[0] = cen[0]; v[1] = cen[1]; v[2] = cen[2]; v[ai] = t;
        c.map(v);
        const T0 = v[0], T1 = v[1], T2 = v[2];
        for (const [row, axis] of [[1, p], [2, q]]) {
          v[0] = cen[0]; v[1] = cen[1]; v[2] = cen[2]; v[ai] = t; v[axis] += 1;
          c.map(v);
          const o = base + (row * DEF_SAMPLES + i) * 4;
          this.tab[o] = v[0] - T0; this.tab[o + 1] = v[1] - T1; this.tab[o + 2] = v[2] - T2;
        }
        const o = base + i * 4;
        this.tab[o] = T0; this.tab[o + 1] = T1; this.tab[o + 2] = T2;
      }
      u.uDefAxis.value[n] = ai;
      u.uDefC.value[n].set(cen[0], cen[1], cen[2]);
      u.uDefDom.value[n].set(t0, t1);
      n++;
    }
    u.uDefN.value = n;
    if (ffd) {
      const { dims, min, size } = ffd.lattice;
      if (Math.max(...dims) > DEF_MAX_DEG) return false;
      u.uDefFFD.value = 1;
      u.uDefDims.value.set(dims[0], dims[1], dims[2]);
      u.uDefMin.value.set(min[0], min[1], min[2]);
      u.uDefSize.value.set(size[0], size[1], size[2]);
      const off = ffd.offsets;
      for (let i = 0; i < off.length / 3; i++) { this.off[4 * i] = off[3 * i]; this.off[4 * i + 1] = off[3 * i + 1]; this.off[4 * i + 2] = off[3 * i + 2]; }
      this.offTex.needsUpdate = true;
    } else u.uDefFFD.value = 0;
    u.uDefGround.value = ground || 0;
    u.uDefH.value = 2e-4 * diag;
    this.tabTex.needsUpdate = true;
    return true;
  }
}

// ------------------------------------------------------------------------------------------------ passes

/** Final pass: tone-map the element (alpha 1) and multiply the page colour by the ground factor (alpha 0). */
class StudioOutputPass extends Pass {
  constructor(bg) {
    super();
    this.quad = new FullScreenQuad(new THREE.RawShaderMaterial({
      uniforms: { tDiffuse: { value: null }, uBg: { value: new THREE.Vector3(...bg) }, uTone: { value: 1 }, toneMappingExposure: { value: 1 } },
      vertexShader: /* glsl */`
        precision highp float;
        uniform mat4 modelViewMatrix; uniform mat4 projectionMatrix;
        attribute vec3 position; attribute vec2 uv; varying vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */`
        precision highp float;
        uniform sampler2D tDiffuse; uniform vec3 uBg; uniform float uTone;
        #include <tonemapping_pars_fragment>
        #include <colorspace_pars_fragment>
        varying vec2 vUv;
        void main() {
          vec4 t = texture2D(tDiffuse, vUv);
          vec3 c = max(t.rgb, vec3(0.0));
          vec3 obj = uTone > 0.5 ? AgXToneMapping(c) : clamp(c, 0.0, 1.0);
          obj = sRGBTransferOETF(vec4(obj, 1.0)).rgb;
          vec3 ground = uBg * clamp(c, 0.0, 1.0);
          gl_FragColor = vec4(mix(ground, obj, clamp(t.a, 0.0, 1.0)), 1.0);
        }`,
      depthTest: false, depthWrite: false,
    }));
    this.uniforms = this.quad.material.uniforms;
  }
  render(renderer, writeBuffer, readBuffer) {
    this.uniforms.tDiffuse.value = readBuffer.texture;
    this.uniforms.toneMappingExposure.value = renderer.toneMappingExposure;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }
  dispose() { this.quad.dispose(); }
}

/** Line drawing: renders the scene (white faces + black feature lines) and inks depth discontinuities (silhouettes,
 *  occluding contours) from the Laplacian of inverse depth, which is zero on every plane. */
class InkPass extends Pass {
  constructor(scene, camera) {
    super();
    this.scene = scene; this.camera = camera;
    this.rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
    this.rt.depthTexture = new THREE.DepthTexture(1, 1, THREE.UnsignedIntType);
    this.quad = new FullScreenQuad(new THREE.ShaderMaterial({
      uniforms: { tColor: { value: null }, tDepth: { value: null }, uTexel: { value: new THREE.Vector2() }, uNear: { value: 0.1 },
        uFar: { value: 100 }, uOrtho: { value: 0 }, uScale: { value: 1 } },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: /* glsl */`
        #include <packing>
        uniform sampler2D tColor; uniform sampler2D tDepth; uniform vec2 uTexel; uniform float uNear, uFar, uOrtho, uScale;
        varying vec2 vUv;
        float q(vec2 uv) {
          float d = texture2D(tDepth, uv).r;
          if (uOrtho > 0.5) return -orthographicDepthToViewZ(d, uNear, uFar) / (uFar - uNear);
          return 1.0 / -perspectiveDepthToViewZ(d, uNear, uFar);
        }
        void main() {
          vec4 c = texture2D(tColor, vUv);
          vec2 o = uTexel * uScale;
          float qc = q(vUv);
          float lx = q(vUv + vec2(o.x, 0.0)) + q(vUv - vec2(o.x, 0.0)) - 2.0 * qc;
          float ly = q(vUv + vec2(0.0, o.y)) + q(vUv - vec2(0.0, o.y)) - 2.0 * qc;
          float e = (abs(lx) + abs(ly)) / max(qc, 1e-6);
          // only where the element is (alpha 1) or touches it: the ground and the horizon get no ink
          float near = max(max(c.a, texture2D(tColor, vUv + vec2(o.x, 0.0)).a), max(texture2D(tColor, vUv - vec2(o.x, 0.0)).a,
                       max(texture2D(tColor, vUv + vec2(0.0, o.y)).a, texture2D(tColor, vUv - vec2(0.0, o.y)).a)));
          float ink = smoothstep(0.004, 0.02, e) * step(0.5, near);
          gl_FragColor = vec4(c.rgb * (1.0 - 0.92 * ink), c.a);
        }`,
      depthTest: false, depthWrite: false,
    }));
  }
  setSize(w, h) { this.rt.setSize(w, h); this.quad.material.uniforms.uTexel.value.set(1 / w, 1 / h); }
  render(renderer, writeBuffer) {
    renderer.setRenderTarget(this.rt);
    renderer.clear();
    renderer.render(this.scene, this.camera);
    const u = this.quad.material.uniforms;
    u.tColor.value = this.rt.texture; u.tDepth.value = this.rt.depthTexture;
    u.uNear.value = this.camera.near; u.uFar.value = this.camera.far; u.uOrtho.value = this.camera.isOrthographicCamera ? 1 : 0;
    u.uScale.value = Math.max(1, renderer.getPixelRatio() * 0.75);
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }
  dispose() { this.rt.dispose(); this.quad.dispose(); }
}

// ------------------------------------------------------------------------------------------------ ground

function groundMaterial() {
  const mat = new THREE.ShadowMaterial({ transparent: false, depthWrite: true });
  mat.blending = THREE.NoBlending;
  mat.toneMapped = false;
  const u = { uShadow: { value: 0.42 }, uGrid: { value: 0.05 }, uGridC: { value: new THREE.Vector2() }, uGridR: { value: 20 } };
  mat.userData.u = u;
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGW;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvGW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGW; uniform float uShadow, uGrid, uGridR; uniform vec2 uGridC;')
      .replace(/gl_FragColor = vec4\( color, opacity \* \( 1\.0 - getShadowMask\(\) \) \);/, `
        float f = 1.0 - uShadow * (1.0 - getShadowMask());
        vec2 w = fwidth(vGW.xz);
        vec2 g = abs(fract(vGW.xz - 0.5) - 0.5) / max(w, vec2(1e-5));
        float line = 1.0 - min(min(g.x, g.y), 1.0);
        line *= 1.0 - smoothstep(0.06, 0.2, max(w.x, w.y));
        line *= 1.0 - smoothstep(uGridR * 0.45, uGridR, length(vGW.xz - uGridC));
        line *= smoothstep(0.06, 0.3, abs(normalize(cameraPosition - vGW).y));   // no moiré toward the horizon
        f *= 1.0 - uGrid * line;
        gl_FragColor = vec4(vec3(f), 0.0);`);
  };
  mat.customProgramCacheKey = () => 'arch-ground';
  return mat;
}

// ------------------------------------------------------------------------------------------------ scale figure

/** A 1.80 m standing figure (Z-up, feet at the origin, facing -Y): a smooth mannequin like the people of an
 *  architect's model, the scale reference. */
function makeFigure(mat) {
  const g = new THREE.Group();
  const put = (geo, x, y, z, rx = 0, ry = 0, sx = 1, sy = 1, sz = 1) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z); m.rotation.set(rx, ry, 0); m.scale.set(sx, sy, sz);
    m.castShadow = true; m.receiveShadow = true;
    g.add(m);
    return m;
  };
  const up = Math.PI / 2; // three's lathes and cylinders run along Y; turn them to Z
  // torso: a lathe from hips to sloping shoulders, flattened front to back
  const torso = new THREE.LatheGeometry([[0, 0.88], [0.15, 0.9], [0.163, 0.98], [0.14, 1.1], [0.15, 1.24], [0.172, 1.35],
    [0.185, 1.41], [0.165, 1.465], [0.12, 1.505], [0.06, 1.53], [0, 1.535]].map(([r, z]) => new THREE.Vector2(r, z)), 32);
  put(torso, 0, 0, 0, up, 0, 1, 1, 0.62);
  // legs: tapered from the hips, slightly apart, with feet
  const leg = new THREE.CylinderGeometry(0.08, 0.045, 0.88, 18);
  for (const sgn of [-1, 1]) {
    put(leg, sgn * 0.082, 0, 0.5, up, 0, 1, 1, 1).rotation.y = sgn * -0.035;
    put(new THREE.SphereGeometry(0.05, 14, 10), sgn * 0.09, -0.045, 0.035, 0, 0, 0.8, 1.9, 0.7);
  }
  // arms hang from rounded shoulders, a little away from the body, with hands
  const arm = new THREE.CylinderGeometry(0.043, 0.031, 0.6, 14);
  for (const sgn of [-1, 1]) {
    put(new THREE.SphereGeometry(0.052, 16, 12), sgn * 0.19, 0, 1.425, 0, 0, 1, 0.9, 1);
    put(arm, sgn * 0.21, 0, 1.13, up, sgn * -0.06);
    put(new THREE.SphereGeometry(0.037, 12, 10), sgn * 0.228, 0, 0.8, 0, 0, 0.8, 0.6, 1.25);
  }
  put(new THREE.CylinderGeometry(0.045, 0.05, 0.1, 14), 0, 0, 1.56, up);
  put(new THREE.SphereGeometry(0.094, 24, 18), 0, 0.005, 1.80 - 0.094 * 1.15, 0, 0, 0.88, 1, 1.15);
  g.userData.width = 0.5;
  return g;
}

// ------------------------------------------------------------------------------------------------ viewer

export class Viewer {
  /** canvas: the drawing surface; opts: { shot, background: [r,g,b] display 0..1, pixelRatio, insets: () => { top,
   *  bottom, left, right } (CSS px of the canvas the page's overlays cover: framing keeps the element clear of them) } */
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.opts = opts;
    this.mode = 'stone';
    this.view = 'three-quarter';
    this.figureWanted = null;          // null = automatic (on for elements > 1.5 m)
    this.bg = opts.background || [0.957, 0.957, 0.949];
    this.sunAngles = { ...SUN };
    this.dirty = 0;
    this.waiters = [];
    this.meshes = [];
    this.edges = null;
    this.aoReady = false;
    this.box = new THREE.Box3(new THREE.Vector3(-0.5, 0, -0.5), new THREE.Vector3(0.5, 1, 0.5));

    // premultipliedAlpha off: the clear colour (1, 1, 1, alpha 0) marks "page" pixels and must not be premultiplied to black
    const r = this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, premultipliedAlpha: false,
      powerPreference: 'high-performance', preserveDrawingBuffer: !!opts.shot });
    // flutes, dentils and leaves alias at one sample per pixel: desktops render at least 1.5x (frames are drawn only
    // while something moves, so the cost is paid only then); phones keep their native ratio, capped at 2
    const fine = !matchMedia('(pointer: coarse)').matches;
    r.setPixelRatio(opts.pixelRatio || Math.min(Math.max(window.devicePixelRatio || 1, fine ? 1.5 : 1), 2));
    r.setClearColor(0xffffff, 0);
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap;
    // the shadow map is drawn only when the light or the model moved (shadowsDirty), not every frame
    r.shadowMap.autoUpdate = false;
    r.shadowMap.needsUpdate = true;
    r.toneMapping = THREE.AgXToneMapping;   // applied by StudioOutputPass (composer targets are linear)
    r.toneMappingExposure = LIGHT.exposure;
    r.outputColorSpace = THREE.SRGBColorSpace;

    const s = this.scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(r);
    this.envMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    s.environment = this.envMap;
    s.environmentIntensity = LIGHT.env;
    s.environmentRotation.set(0, 0.6, 0);
    // white fog beyond the element: the far ground fades into the page and N8AO fades its (false, grazing-angle)
    // occlusion with it, so the ground has no visible edge; near and far follow the camera (updateClip)
    s.fog = new THREE.Fog(0xffffff, 50, 100);

    this.root = new THREE.Group();               // Z-up content -> Y-up world: (x, y, z) -> (x, z, -y)
    this.root.rotation.x = -Math.PI / 2;
    s.add(this.root);
    this.model = new THREE.Group();
    this.root.add(this.model);

    const sun = this.sun = new THREE.DirectionalLight(0xfff1df, LIGHT.sun);
    sun.castShadow = true;
    const big = r.capabilities.maxTextureSize >= 8192 && !matchMedia('(pointer: coarse)').matches;
    sun.shadow.mapSize.set(big ? 4096 : 2048, big ? 4096 : 2048);
    sun.shadow.radius = 2.2;
    s.add(sun, sun.target);

    this.groundMat = groundMaterial();
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.groundMat);
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true;
    s.add(this.ground);

    this.figMats = { stone: new THREE.MeshStandardMaterial({ color: 0x77797c, roughness: 0.85 }),
      white: new THREE.MeshStandardMaterial({ color: 0x9c9c9a, roughness: 0.9 }), line: new THREE.MeshBasicMaterial({ color: 0xffffff }) };
    this.figure = makeFigure(this.figMats.stone);
    this.figure.visible = false;
    this.root.add(this.figure);

    this.mats = new Map();
    this.whiteMat = new THREE.MeshStandardMaterial({ color: 0xf6f6f4, roughness: 0.95, metalness: 0 });
    this.whiteMat.onBeforeCompile = (sh) => injectPaint(sh);
    this.whiteMat.customProgramCacheKey = () => 'white-p';
    paintDefaults();
    this.paintVersion = 0; this.modelVersion = 0; this.pickRT = null; this.pickTiles = new Map(); this.pickKey = '';
    this.pickMat = new THREE.ShaderMaterial({ vertexShader: PICK_VERT, fragmentShader: PICK_FRAG, glslVersion: THREE.GLSL3, blending: THREE.NoBlending });
    this.pickCam = { mw: new THREE.Matrix4(), pm: new THREE.Matrix4(), key: '' };
    this.pickV = { m: new THREE.Matrix4(), v: new THREE.Vector3(), a: new THREE.Vector3(), b: new THREE.Vector3(), n: new THREE.Vector3(), c: new THREE.Vector3() };
    this.lineFaceMat = new THREE.MeshBasicMaterial({ color: 0xffffff, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    this.lineMat = new THREE.LineBasicMaterial({ color: 0x1b1b1d });
    this.defU = new DeformUniforms();
    this.deformDepth = this.withDeform(new THREE.MeshDepthMaterial());
    this.preview = null; this.previewGroup = null; this.previewing = false;
    this.lattice = null; this.handleCb = null; this.drag = null;
    this.onFrame = null;                         // called after every rendered frame (the page's grips follow the camera)

    this.persp = new THREE.PerspectiveCamera(30, 1, 0.05, 500);
    this.ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.05, 500);
    this.camera = this.persp;
    this.controls = new OrbitControls(this.persp, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.09;
    this.controls.maxPolarAngle = Math.PI * 0.53;
    this.controls.screenSpacePanning = true;
    this.controls.addEventListener('change', () => { this.dirty = Math.max(this.dirty, 10); this.updateClip(); });

    this.composer = new EffectComposer(r, new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType }));
    this.renderPass = new RenderPass(s, this.camera);
    this.inkPass = new InkPass(s, this.camera);
    this.outPass = new StudioOutputPass(this.bg);
    this.smaa = r.getPixelRatio() < 1.75 ? new SMAAPass() : null;   // high-DPI screens are their own anti-aliasing
    this.ao = null;
    this.setPipeline();

    this.resize();
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => this.resize()).observe(canvas.parentElement || canvas);
    else window.addEventListener('resize', () => this.resize());
    const loop = () => { requestAnimationFrame(loop); this.tick(); };
    requestAnimationFrame(loop);
  }

  /** Load N8AO (fails soft: the viewer then renders without ambient occlusion). */
  async init(timeoutMs = 9000) {
    try {
      const mod = await Promise.race([import('n8ao'), new Promise((_, rej) => setTimeout(() => rej(new Error('N8AO timed out')), timeoutMs))]);
      const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
      const ao = new mod.N8AOPass(this.scene, this.camera, size.x, size.y);
      ao.configuration.transparencyAware = false;
      ao.configuration.gammaCorrection = false;   // stay linear: StudioOutputPass tone-maps and encodes once
      ao.configuration.aoSamples = 16;
      ao.configuration.denoiseSamples = 8;
      ao.configuration.denoiseRadius = 10;
      ao.configuration.intensity = 3.2;
      ao.configuration.color = new THREE.Color(0x000000);
      ao.configuration.accumulate = true;
      // (no MSAA on N8AO's beauty target: its depth texture would not resolve; SMAA or 2x supersampling smooth the edges)
      this.ao = ao;
      this.aoReady = true;
      this.setPipeline();
      this.fitAO();
    } catch (e) {
      console.warn('[arch] ambient occlusion unavailable:', e && e.message ? e.message : e);
      this.aoReady = false;
    }
    this.dirty = Math.max(this.dirty, 12);
    return this.aoReady;
  }

  setPipeline() {
    const c = this.composer;
    while (c.passes.length) c.removePass(c.passes[0]);
    if (this.mode === 'line') c.addPass(this.inkPass);
    else if (this.ao) c.addPass(this.ao);
    else c.addPass(this.renderPass);
    c.addPass(this.outPass);
    if (this.smaa) c.addPass(this.smaa);
    this.outPass.uniforms.uTone.value = this.mode === 'line' ? 0 : 1;
    this.syncCamera();
    this.resize();
  }

  syncCamera() {
    const cam = this.camera;
    this.renderPass.camera = cam;
    this.inkPass.camera = cam;
    if (this.ao && this.ao.camera !== cam) {
      this.ao.camera = cam;
      const t = this.ao.configuration.depthBufferType, o = !!cam.isOrthographicCamera;
      this.ao.configureAOPass(t, o); this.ao.configureDenoisePass(t, o); this.ao.configureEffectCompositer(t, o);
      this.ao.firstFrame();
    }
    if (this.controls.object !== cam) { this.controls.object = cam; this.controls.update(); }
  }

  resize() {
    const el = this.canvas, w = Math.max(1, el.clientWidth), h = Math.max(1, el.clientHeight);
    if (this._w === w && this._h === h && this._mode === this.mode) return;
    this._w = w; this._h = h; this._mode = this.mode;
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(w, h);
    this.persp.aspect = w / h;
    this.persp.updateProjectionMatrix();
    this.orthoAspect();
    this.dirty = Math.max(this.dirty, 10);
  }

  // ---------------------------------------------------------------------------------------------- model

  material(key) {
    const k = this.mode + ':' + key;
    if (!this.mats.has(k)) this.mats.set(k, this.mode === 'stone' ? stoneMaterial(key) : this.mode === 'white' ? this.whiteMat : this.lineFaceMat);
    return this.mats.get(k);
  }

  /** Show a built element. meshes: worker meshes (Z-up); stats: { bbox: {min, max} Z-up, size, spec }.
   *  opts: { keepCamera } (a deformation bake keeps the view), { keepPreview } (a drag is still going on: the GPU
   *  preview stays on screen and the new model waits behind it).
   *  Resolves after the new geometry has been rendered (and the AO has settled). */
  async setModel(meshes, stats = {}, opts = {}) {
    for (const m of this.model.children) { m.geometry.dispose(); m.dispose(); }   // dispose() frees the instance buffers
    this.model.clear();
    this.clearEdges();
    const tmp = new THREE.Matrix4();
    this.modelVersion++;
    for (const mesh of meshes) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(mesh.normals, 3));
      const nv = mesh.positions.length / 3;
      geo.setIndex(new THREE.BufferAttribute(nv < 65536 ? Uint16Array.from(mesh.indices) : mesh.indices, 1));
      const n = mesh.transforms ? mesh.transforms.length / 16 : 1;
      const im = new THREE.InstancedMesh(geo, this.material(mesh.material), n);
      // the paint's part index (paint.js: the first mesh of that name), the same on every copy
      // the paint's part index: this mesh (paint.js partsOf: one part per mesh), the same on every copy
      geo.setAttribute('aPaintPart', new THREE.InstancedBufferAttribute(new Float32Array(n).fill(this.model.children.length + 1), 1));
      for (let i = 0; i < n; i++) im.setMatrixAt(i, mesh.transforms ? tmp.fromArray(mesh.transforms, 16 * i) : tmp.identity());
      im.instanceMatrix.needsUpdate = true;
      im.castShadow = true; im.receiveShadow = true;
      im.frustumCulled = false;
      im.name = mesh.name;
      im.userData.key = mesh.material;
      this.model.add(im);
    }
    if (this.revealPlane) this.revealMats();       // a model that rises: its materials (and its shadow) are clipped too
    this.meshes = meshes;
    this.dominant = dominantMaterial(meshes);
    this.applyLook();
    // bounds in Y-up world
    const bb = stats.bbox || this.measure();
    const prev = this.box.clone();
    this.box.set(new THREE.Vector3(bb.min[0], bb.min[2], -bb.max[1]), new THREE.Vector3(bb.max[0], bb.max[2], -bb.min[1]));
    this.size = [bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]];
    const element = stats.spec && stats.spec.element;
    this.placeFigure();
    // keep the camera when only details changed; re-frame for a new element or a clearly different size
    const s0 = prev.getSize(new THREE.Vector3()), s1 = this.box.getSize(new THREE.Vector3());
    const changed = element !== this.element || !this.framed || Math.abs(s0.length() - s1.length()) / Math.max(s1.length(), 1e-3) > 0.12;
    this.element = element;
    this.fitLights();
    this.fitAO();
    // a deformation bake keeps the view unless the shape left the frame (then all of it is framed); otherwise re-frame
    // for a new element or a clearly different size
    // keepCamera 'hold': never re-frame (a grip is being dragged: the view must not move under the pointer)
    if (opts.keepCamera === 'hold') { /* the view stays */ }
    else if (opts.keepCamera) { if (!this.fits()) this.setView(this.view, true); }
    else if (changed) this.setView(this.view);
    this.shadowsDirty();
    if (!opts.keepPreview) this.showPreview(false);
    try { await this.renderer.compileAsync(this.scene, this.camera); } catch (e) { /* compiles on first render instead */ }
    if (this.ao) this.ao.firstFrame();
    // the first frame with the new geometry is drawn now (not left to requestAnimationFrame, which a hidden or
    // throttled page may not run); a few more let the ambient occlusion settle, but never hold the caller long
    this.controls.update();
    this.composer.render();
    if (this.onFrame) this.onFrame();
    const settle = this.frames(this.opts.shot ? 24 : 3);
    return Promise.race([settle, new Promise((r) => setTimeout(r, this.opts.shot ? 2500 : 600))]);
  }

  measure() {
    const b = new THREE.Box3().setFromObject(this.model, true);
    // back to Z-up numbers
    return { min: [b.min.x, -b.max.z, b.min.y], max: [b.max.x, -b.min.z, b.max.y] };
  }

  /** Feature edges per mesh (Float32Array of segment ends, local Z-up), expanded over the instances. */
  setEdges(list) {
    this.clearEdges();
    if (!list || list.length !== this.meshes.length) return;
    let total = 0;
    list.forEach((e, i) => { const t = this.meshes[i].transforms; total += e.length * (t ? t.length / 16 : 1); });
    const out = new Float32Array(total);
    let o = 0;
    list.forEach((e, i) => {
      const t = this.meshes[i].transforms, n = t ? t.length / 16 : 1;
      for (let k = 0; k < n; k++) {
        if (!t) { out.set(e, o); o += e.length; continue; }
        const m = t.subarray(16 * k, 16 * k + 16);
        for (let j = 0; j < e.length; j += 3) {
          const x = e[j], y = e[j + 1], z = e[j + 2];
          out[o++] = m[0] * x + m[4] * y + m[8] * z + m[12];
          out[o++] = m[1] * x + m[5] * y + m[9] * z + m[13];
          out[o++] = m[2] * x + m[6] * y + m[10] * z + m[14];
        }
      }
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(out, 3));
    this.edges = new THREE.LineSegments(geo, this.lineMat);
    this.edges.frustumCulled = false;
    this.edges.visible = this.mode === 'line';
    this.root.add(this.edges);
    this.dirty = Math.max(this.dirty, 10);
  }
  clearEdges() {
    if (this.edges) { this.root.remove(this.edges); this.edges.geometry.dispose(); this.edges = null; }
  }
  needsEdges() { return this.mode === 'line' && !this.edges && this.meshes.length > 0; }

  // ---------------------------------------------------------------------------------------------- modes, figure

  setMode(mode) {
    if (!MODES.includes(mode) || mode === this.mode) return;
    this.mode = mode;
    for (const m of this.model.children) m.material = this.material(m.userData.key);
    if (this.previewGroup) for (const m of this.previewGroup.children) m.material = m.userData.rigid ? this.material(m.userData.key) : this.deformMaterial(m.userData.key);
    for (const m of this.figure.children) m.material = this.figMats[mode];
    if (this.edges) this.edges.visible = mode === 'line';
    const lit = mode !== 'line';
    this.sun.castShadow = lit;
    this.shadowsDirty();
    this.groundMat.userData.u.uShadow.value = lit ? 0.42 : 0;
    this.setPipeline();
    this.applyLook();
    if (this.ao) this.ao.firstFrame();
    this.dirty = Math.max(this.dirty, 12);
  }

  /** Exposure, sun, sky and occlusion for the current mode and the element's main material. */
  applyLook() {
    const L = LOOKS[this.mode === 'stone' && LIGHT_STONES.has(this.dominant) ? 'lightStone' : this.mode] || LOOKS.stone;
    this.look = L;
    this.renderer.toneMappingExposure = L.exposure;
    this.scene.environmentIntensity = L.env;
    this.sun.intensity = L.sun;
    if (this.ao) this.ao.configuration.intensity = L.ao || 3;
    this.dirty = Math.max(this.dirty, 10);
  }

  /** on: true / false, or null for automatic (shown for elements larger than 1.5 m). */
  setFigure(on) {
    this.figureWanted = on;
    this.placeFigure();
    this.fitLights();
    this.dirty = Math.max(this.dirty, 10);
  }
  figureShown() { return this.figure.visible; }

  placeFigure() {
    const s = this.size || [1, 1, 1];
    const auto = Math.max(...s) > 1.5;
    this.figure.visible = this.figureWanted === null ? auto : !!this.figureWanted;
    this.shadowsDirty();
    // at the front-right of the element, half a metre clear and near its front face (Z-up numbers): the three-quarter
    // camera (front-left) sees it in front of anything round or deep, never hidden behind it
    const gap = 0.45 + this.figure.userData.width / 2, front = -this.box.max.z, depth = this.box.max.z - this.box.min.z;
    this.figure.position.set(this.box.max.x + gap, front + Math.min(0.3, depth / 2), 0);
  }

  bounds() {
    const b = this.box.clone();
    if (this.lattice && this.lattice.points) {
      const P = this.lattice.points, v = new THREE.Vector3();
      for (let i = 0; i < P.length; i += 3) b.expandByPoint(v.set(P[i], P[i + 2], -P[i + 1]));   // Z-up -> Y-up
    }
    if (this.figure.visible) {
      const p = this.figure.position; // Z-up -> Y-up
      b.expandByPoint(new THREE.Vector3(p.x - 0.3, 0, -p.y - 0.2));
      b.expandByPoint(new THREE.Vector3(p.x + 0.3, 1.8, -p.y + 0.2));
    }
    return b;
  }

  // ---------------------------------------------------------------------------------------------- lights, AO

  fitLights() {
    const b = this.bounds(), c = b.getCenter(new THREE.Vector3()), size = b.getSize(new THREE.Vector3());
    const R = Math.max(size.length() / 2, 0.05);
    // sun direction in Y-up world from SUN (Z-up az/el)
    const az = this.sunAngles.az * DEG, el = this.sunAngles.el * DEG;
    const dz = new THREE.Vector3(Math.sin(az) * Math.cos(el), -Math.cos(az) * Math.cos(el), Math.sin(el)); // Z-up, toward the sun
    const L = new THREE.Vector3(dz.x, dz.z, -dz.y).normalize();
    const sun = this.sun;
    sun.target.position.copy(c);
    sun.position.copy(c).addScaledVector(L, R * 4);
    sun.updateMatrixWorld(); sun.target.updateMatrixWorld();
    // the shadow camera covers the element and the shadow it throws on the ground
    const pts = [];
    for (let i = 0; i < 8; i++) {
      const p = new THREE.Vector3(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z);
      pts.push(p);
      if (p.y > 0) pts.push(p.clone().addScaledVector(L, -p.y / L.y));
    }
    const cam = sun.shadow.camera;
    cam.position.copy(sun.position); cam.lookAt(c); cam.updateMatrixWorld();
    const inv = cam.matrixWorldInverse;
    const mn = new THREE.Vector3(Infinity, Infinity, Infinity), mx = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    for (const p of pts) { const q = p.clone().applyMatrix4(inv); mn.min(q); mx.max(q); }
    const pad = R * 0.04;
    cam.left = mn.x - pad; cam.right = mx.x + pad; cam.bottom = mn.y - pad; cam.top = mx.y + pad;
    cam.near = Math.max(0.01, -mx.z - R); cam.far = -mn.z + R;
    cam.updateProjectionMatrix();
    const texel = Math.max(cam.right - cam.left, cam.top - cam.bottom) / sun.shadow.mapSize.x;
    sun.shadow.normalBias = texel * 1.6;
    sun.shadow.bias = -0.00015;
    sun.shadow.needsUpdate = true;
    this.shadowsDirty();
    // ground under everything; grid centred on the element
    const span = Math.max(R * 60, 60);
    this.ground.scale.set(span, span, 1);
    this.ground.position.set(c.x, 0, c.z);
    const u = this.groundMat.userData.u;
    u.uGridC.value.set(c.x, c.z);
    u.uGridR.value = THREE.MathUtils.clamp(R * 2.5, 4, 30);
  }

  fitAO() {
    if (!this.ao) return;
    const s = this.box.getSize(new THREE.Vector3());
    // ornament-scale occlusion: a fraction of the element's smaller extents, clamped to a sensible range
    const ref = Math.min(Math.max(s.x, s.z), s.y);
    const r = THREE.MathUtils.clamp(ref * 0.28, 0.03, 1.2);
    this.ao.configuration.aoRadius = r;
    this.ao.configuration.distanceFalloff = 1.0;
    this.ao.configuration.intensity = (this.look && this.look.ao) || 3;
  }

  // ---------------------------------------------------------------------------------------------- camera

  // ---------------------------------------------------------------------------------------------- reveal

  /** Hide everything above the ground before a new model is shown (the reveal then raises a clipping plane through
   *  it). A global clipping plane, so the ambient occlusion and the ink lines rise with the model; the same plane on the
   *  model's materials (clipShadows) makes its shadow rise too (global planes do not reach the shadow pass). */
  beginReveal() {
    this.endReveal();
    this.revealPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 1e-4);   // keeps y <= constant
    this.renderer.clippingPlanes = [this.revealPlane];
    this.renderer.localClippingEnabled = true;
    this.revealMats();
    this.shadowsDirty();
    this.dirty = Math.max(this.dirty, 2);
  }
  /** The reveal plane on every material of the model (called again when a new model brings new materials). */
  revealMats() {
    const planes = this.revealPlane ? [this.revealPlane] : null;
    for (const m of this.model.children) {
      if (!m.material) continue;
      m.material.clippingPlanes = planes;
      m.material.clipShadows = !!planes;
    }
  }
  /** Raise the clipping plane from the foot to the top of the model in ms (ease-out), then remove it. */
  reveal(ms = 1000) {
    if (!this.revealPlane) this.beginReveal();
    this.revealMats();
    const plane = this.revealPlane, y0 = Math.min(0, this.box.min.y) - 0.01, y1 = this.box.max.y + 0.01, t0 = performance.now();
    const step = () => {
      if (this.revealPlane !== plane) return;
      const t = Math.min(1, (performance.now() - t0) / ms), e = 1 - (1 - t) ** 3;
      plane.constant = Math.max(1e-4, y0 + e * (y1 - y0));
      this.shadowsDirty();                       // the shadow rises with the model (clipShadows)
      if (this.ao) this.ao.firstFrame();
      this.dirty = Math.max(this.dirty, 2);
      if (t < 1) this.revealRAF = requestAnimationFrame(step); else this.endReveal();
    };
    step();
  }
  endReveal() {
    if (!this.revealPlane) return;
    cancelAnimationFrame(this.revealRAF);
    this.revealPlane = null;
    this.revealMats();
    this.renderer.clippingPlanes = [];
    this.renderer.localClippingEnabled = false;
    this.shadowsDirty();
    if (this.ao) this.ao.firstFrame();
    this.dirty = Math.max(this.dirty, 12);
  }

  /** Frame a named view. The three-quarter view of a long run (moulding, cornice, entablature, balustrade much longer
   *  than its section) frames the near end so the profile reads; all = true frames the whole element instead. */
  setView(name, all = false) {
    const v = VIEWS[name] || VIEWS['three-quarter'];
    this.view = VIEWS[name] ? name : 'three-quarter';
    const full = this.bounds();
    const run = !v.ortho && !all ? this.nearEnd() : null;
    const b = run || full, c = b.getCenter(new THREE.Vector3());
    // a low, wide element (a roof) is seen from higher up, so its planes fill the frame instead of a thin band
    const sz = full.getSize(new THREE.Vector3()), low = sz.y / Math.max(sz.x, sz.z, 1e-6);
    const elDeg = v.ortho ? v.el : v.el + 14 * THREE.MathUtils.clamp((0.6 - low) / 0.45, 0, 1);
    const az = v.az * DEG, el = Math.min(elDeg, 89.9) * DEG;
    const dz = [Math.sin(az) * Math.cos(el), -Math.cos(az) * Math.cos(el), Math.sin(el)];
    const dir = new THREE.Vector3(dz[0], dz[2], -dz[1]).normalize();      // Y-up, from target toward the camera
    this.camera = v.ortho ? this.ortho : this.persp;
    // elevations and plan use the draughtsman's convention (light over the viewer's left shoulder, shadows at 45°);
    // the perspective keeps a side light that models round forms
    this.sunAngles = name === 'top' ? { az: -135, el: 50 } : v.ortho ? { az: v.az - 45, el: 35.26 } : { ...SUN };
    this.fitLights();
    this.controls.target.copy(c);
    if (v.ortho) {
      const R = b.getSize(new THREE.Vector3()).length();
      this.ortho.position.copy(c).addScaledVector(dir, R * 2 + 1);
      this.ortho.up.set(0, 1, 0);
      this.ortho.lookAt(c);
      this.ortho.zoom = 1;
      this.fitOrtho();
    } else this.fitPersp(b, dir, run ? 0.8 : 0.84);
    this.framed = true;
    this.updateClip();          // distance limits for the new size first, or OrbitControls clamps to the old ones
    this.syncCamera();
    this.controls.update();
    this.updateClip();
    this.dirty = Math.max(this.dirty, 12);
  }

  /** Whether the element's box (with the figure) is inside the frame, with a little slack. */
  fits(slack = 1.06) {
    const b = this.bounds(), v = new THREE.Vector3();
    this.camera.updateMatrixWorld();
    for (let i = 0; i < 8; i++) {
      v.set(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z).project(this.camera);
      if (Math.abs(v.x) > slack || Math.abs(v.y) > slack || v.z > 1) return false;
    }
    return true;
  }

  /** The whole element (and the figure) in the current view. */
  frameAll() { this.setView(this.view, true); }

  /** For a long run seen in three-quarter: the near (left) end with its return, long enough that the section fills
   *  about a third of the frame's height; null when the element is not a long run. */
  nearEnd() {
    if (!LONG_RUNS.has(this.element)) return null;
    const b = this.box, sz = b.getSize(new THREE.Vector3());
    const sec = Math.max(sz.y, sz.z);                     // the section: height (Y) or projection (Z)
    if (sz.x < 4 * sec) return null;
    const aspect = this._w / this._h || 1;
    // width of run whose projection makes the section ~36 % of the frame height (cos 35° ≈ 0.82, sin 35° ≈ 0.57)
    const w = THREE.MathUtils.clamp((2.3 * sz.y * aspect - 0.57 * sz.z) / 0.82, 2 * sec, sz.x);
    return new THREE.Box3(b.min.clone(), new THREE.Vector3(b.min.x + w, b.max.y, b.max.z));
  }

  /** The part of the frame (NDC) a fit may fill: `margin` of it, and clear of the page's overlays (opts.insets, 8 px
   *  of air): on a large stage the margin binds and nothing changes; on a phone the bars and the size pill would sit
   *  on a pediment's apex or a lantern, so the element is framed smaller, between them. */
  fitRect(margin) {
    const w = this._w || 1, h = this._h || 1, i = (this.opts.insets && this.opts.insets()) || {}, air = 8;
    const cut = (px, len) => (px > 0 ? (2 * (px + air)) / len : 0);
    const r = { x0: Math.max(-margin, -1 + cut(i.left, w)), x1: Math.min(margin, 1 - cut(i.right, w)),
      y0: Math.max(-margin, -1 + cut(i.bottom, h)), y1: Math.min(margin, 1 - cut(i.top, h)) };
    // overlays that leave less than half the frame (a very low stage) are let overlap rather than shrink it further
    if (r.x1 - r.x0 < margin) { r.x0 = -margin; r.x1 = margin; }
    if (r.y1 - r.y0 < margin) { r.y0 = -margin; r.y1 = margin; }
    return r;
  }

  /** Perspective framing of box b seen along -dir: the projected outline (not the 3D centre) is centred in the fit
   *  rectangle (fitRect) and fills it. A few fixed-point steps; the first guess bounds the corners conservatively. */
  fitPersp(b, dir, margin = 0.84) {
    const cam = this.persp, target = b.getCenter(new THREE.Vector3());
    let d = this.fitDistance(b, target, dir, margin);
    const corners = [];
    for (let i = 0; i < 8; i++) corners.push(new THREE.Vector3(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z));
    const tv = Math.tan((cam.fov * DEG) / 2), th = tv * cam.aspect, q = new THREE.Vector3();
    const right = new THREE.Vector3(), up = new THREE.Vector3();
    const R = this.fitRect(margin), cx = (R.x0 + R.x1) / 2, cy = (R.y0 + R.y1) / 2;
    for (let it = 0; it < 5; it++) {
      cam.position.copy(target).addScaledVector(dir, d);
      cam.lookAt(target);
      cam.near = d * 0.001; cam.far = d * 10;
      cam.updateMatrixWorld(); cam.updateProjectionMatrix();
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const p of corners) {
        q.copy(p).project(cam);
        x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y);
      }
      const ext = Math.max((x1 - x0) / (R.x1 - R.x0), (y1 - y0) / (R.y1 - R.y0));
      right.setFromMatrixColumn(cam.matrixWorld, 0); up.setFromMatrixColumn(cam.matrixWorld, 1);
      target.addScaledVector(right, ((x0 + x1) / 2 - cx) * th * d).addScaledVector(up, ((y0 + y1) / 2 - cy) * tv * d);
      d *= THREE.MathUtils.clamp(ext, 0.5, 2);
    }
    cam.position.copy(target).addScaledVector(dir, d);
    cam.lookAt(target);
    this.controls.target.copy(target);
  }

  /** Orbit by degrees (keyboard): azimuth around the vertical, elevation within the controls' limits. */
  orbit(dAzDeg, dElDeg) {
    const cam = this.camera, t = this.controls.target;
    const off = cam.position.clone().sub(t), sph = new THREE.Spherical().setFromVector3(off);
    sph.theta += dAzDeg * DEG;
    sph.phi = THREE.MathUtils.clamp(sph.phi - dElDeg * DEG, 0.02, this.controls.maxPolarAngle);
    cam.position.copy(t).add(new THREE.Vector3().setFromSpherical(sph));
    cam.lookAt(t);
    this.updateClip();
    this.dirty = Math.max(this.dirty, 10);
  }

  /** Zoom by a factor (< 1 closer). */
  zoom(f) {
    if (this.camera.isOrthographicCamera) { this.ortho.zoom /= f; this.ortho.updateProjectionMatrix(); }
    else {
      const t = this.controls.target, off = this.persp.position.clone().sub(t);
      const len = THREE.MathUtils.clamp(off.length() * f, this.controls.minDistance, this.controls.maxDistance);
      this.persp.position.copy(t).addScaledVector(off.normalize(), len);
    }
    this.updateClip();
    this.dirty = Math.max(this.dirty, 10);
  }

  /** Distance at which every corner of box b fits the perspective frustum (looking along -dir at c), with a margin. */
  fitDistance(b, c, dir, margin = 0.82) {
    const cam = this.persp, up0 = new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(up0, dir);
    if (right.lengthSq() < 1e-8) right.set(1, 0, 0);
    right.normalize();
    const up = new THREE.Vector3().crossVectors(dir, right).normalize();
    const tv = Math.tan((cam.fov * DEG) / 2) * margin, th = tv * cam.aspect;
    let d = 0;
    for (let i = 0; i < 8; i++) {
      const p = new THREE.Vector3(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z).sub(c);
      const x = Math.abs(p.dot(right)), y = Math.abs(p.dot(up)), z = p.dot(dir);
      d = Math.max(d, z + x / th, z + y / tv);
    }
    return Math.max(d, 0.1);
  }

  fitOrtho(margin = 1.12) {
    const cam = this.ortho, b = this.bounds();
    cam.updateMatrixWorld();
    const inv = cam.matrixWorldInverse;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < 8; i++) {
      const p = new THREE.Vector3(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z).applyMatrix4(inv);
      x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
    }
    const aspect = this._w / this._h || 1, R = this.fitRect(1 / margin);
    const hh = Math.max((y1 - y0) / (R.y1 - R.y0), (x1 - x0) / (R.x1 - R.x0) / aspect, 0.05);
    // move camera and target sideways so the box is centred in the fit rectangle, then a symmetric frustum
    const off = new THREE.Vector3((x0 + x1) / 2 - ((R.x0 + R.x1) / 2) * hh * aspect, (y0 + y1) / 2 - ((R.y0 + R.y1) / 2) * hh, 0)
      .applyMatrix3(new THREE.Matrix3().setFromMatrix4(cam.matrixWorld));
    cam.position.add(off);
    this.controls.target.add(off);
    this.orthoAspect(hh);
  }

  orthoAspect(hh = (this.ortho.top - this.ortho.bottom) / 2) {
    const cam = this.ortho, aspect = this._w / this._h || 1;
    cam.left = -hh * aspect; cam.right = hh * aspect; cam.top = hh; cam.bottom = -hh;
    cam.updateProjectionMatrix();
    this.updateClip();
  }

  updateClip() {
    const b = this.bounds(), R = Math.max(b.getSize(new THREE.Vector3()).length() / 2, 0.05);
    const cam = this.camera, d = cam.position.distanceTo(this.controls.target);
    if (cam.isPerspectiveCamera) {
      cam.near = Math.max(0.005, (d - R * 1.5) * 0.5, d * 0.01);
      cam.far = d + R * 40;
    } else {
      cam.near = 0.01;
      cam.far = d + R * 40;
    }
    cam.updateProjectionMatrix();
    this.scene.fog.near = d + R * 2.5;
    this.scene.fog.far = d + R * 16;
    const sz = this.box.getSize(new THREE.Vector3());
    this.controls.minDistance = Math.min(R * 0.04, Math.max(Math.min(sz.x, sz.y, sz.z), 0.05) * 0.6);
    this.controls.maxDistance = R * 30;
  }

  // ---------------------------------------------------------------------------------------------- deformation preview

  /** A material that runs the deformation (shared uniforms) after its own shader edits. */
  withDeform(mat) {
    const prev = mat.onBeforeCompile, U = this.defU.u;
    const key = mat.customProgramCacheKey && mat.customProgramCacheKey !== THREE.Material.prototype.customProgramCacheKey
      ? mat.customProgramCacheKey() : mat.type;
    mat.defines = { ...(mat.defines || {}), ARCH_DEFORM: '' };
    mat.onBeforeCompile = (sh, r) => { if (prev) prev.call(mat, sh, r); Object.assign(sh.uniforms, U); injectDeform(sh); };
    mat.customProgramCacheKey = () => key + '-deform';
    return mat;
  }

  deformMaterial(key) {
    const k = this.mode + ':deform:' + key;
    if (!this.mats.has(k)) {
      const m = this.mode === 'stone' ? stoneMaterial(key) : this.mode === 'white' ? this.whiteMat.clone() : this.lineFaceMat.clone();
      this.mats.set(k, this.withDeform(m));
    }
    return this.mats.get(k);
  }

  /** The undeformed element the GPU preview deforms: refined meshes from the worker (rigid parts flagged, with the
   *  centre of their mesh box). Built once per spec; hidden until a drag starts. */
  setPreviewBase(key, meshes) {
    this.clearPreview();
    const g = this.previewGroup = new THREE.Group();
    g.visible = false;
    this.root.add(g);
    this.preview = { key, rigid: [], meshes };
    const tmp = new THREE.Matrix4();
    for (const mesh of meshes) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(mesh.normals, 3));
      const nv = mesh.positions.length / 3;
      geo.setIndex(new THREE.BufferAttribute(nv < 65536 ? Uint16Array.from(mesh.indices) : mesh.indices, 1));
      const n = mesh.transforms ? mesh.transforms.length / 16 : 1;
      const im = new THREE.InstancedMesh(geo, mesh.rigid ? this.material(mesh.material) : this.deformMaterial(mesh.material), n);
      for (let i = 0; i < n; i++) im.setMatrixAt(i, mesh.transforms ? tmp.fromArray(mesh.transforms, 16 * i) : tmp.identity());
      im.instanceMatrix.needsUpdate = true;
      if (!mesh.rigid) im.customDepthMaterial = this.deformDepth;
      im.castShadow = true; im.receiveShadow = true; im.frustumCulled = false;
      im.userData.key = mesh.material; im.userData.rigid = !!mesh.rigid;
      if (mesh.rigid && mesh.transforms) this.preview.rigid.push({ im, T: Float64Array.from(mesh.transforms), centre: mesh.centre });
      g.add(im);
    }
  }
  hasPreview(key) { return !!(this.preview && this.preview.key === key); }
  clearPreview() {
    if (this.previewGroup) {
      for (const m of this.previewGroup.children) { m.geometry.dispose(); m.dispose(); }
      this.root.remove(this.previewGroup);
    }
    this.previewGroup = null; this.preview = null; this.previewing = false;
    this.model.visible = true;
    this.shadowsDirty();
  }

  /**
   * Show the preview deformed by ops (resolved) through D = makeDeformer(ops, bbox): shader tables for the warped parts,
   * the engine's instance formula for the rigid ones. box: the deformed bbox (Z-up) for lights and clipping.
   * Returns false when the preview cannot show it (no base, or an op the shader does not run).
   */
  previewDeform(ops, D, ground = 0, box = null) {
    if (!this.preview) return false;
    if (!this.defU.set(ops, D, ground)) return false;
    const J = new Float64Array(9), Q = new Float64Array(16), m4 = new THREE.Matrix4();
    for (const r of this.preview.rigid) {
      const n = r.T.length / 16, cl = r.centre;
      for (let i = 0; i < n; i++) {
        const M = r.T.subarray(16 * i, 16 * i + 16);
        if (D.identity) { r.im.setMatrixAt(i, m4.fromArray(M)); continue; }
        const c = [M[0] * cl[0] + M[4] * cl[1] + M[8] * cl[2] + M[12], M[1] * cl[0] + M[5] * cl[1] + M[9] * cl[2] + M[13],
          M[2] * cl[0] + M[6] * cl[1] + M[10] * cl[2] + M[14]];
        const fc = D.point(c);
        D.jacobian(c, J);
        const { R, s } = polar3(J);
        let k = Math.abs(s[1]);                                  // deformParts' scaleInstances 'auto'
        if (!(k > 0) || !Number.isFinite(k) || Math.abs(k - 1) < 1e-6) k = 1;
        const A = R.map((x) => x * k), Ml = [M[0], M[4], M[8], M[1], M[5], M[9], M[2], M[6], M[10]];
        for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) {
          Q[col * 4 + row] = A[3 * row] * Ml[col] + A[3 * row + 1] * Ml[3 + col] + A[3 * row + 2] * Ml[6 + col];
        }
        const tm = [M[12] - c[0], M[13] - c[1], M[14] - c[2]];
        for (let row = 0; row < 3; row++) Q[12 + row] = fc[row] + A[3 * row] * tm[0] + A[3 * row + 1] * tm[1] + A[3 * row + 2] * tm[2];
        Q[14] += ground;
        Q[3] = Q[7] = Q[11] = 0; Q[15] = 1;
        r.im.setMatrixAt(i, m4.fromArray(Q));
      }
      r.im.instanceMatrix.needsUpdate = true;
    }
    if (box) {
      this.box.set(new THREE.Vector3(box.min[0], box.min[2], -box.max[1]), new THREE.Vector3(box.max[0], box.max[2], -box.min[1]));
      this.fitLights();
    }
    this.showPreview(true);
    this.shadowsDirty();
    if (this.ao) this.ao.firstFrame();
    this.dirty = Math.max(this.dirty, 3);
    return true;
  }

  showPreview(on) {
    on = !!(on && this.previewGroup);
    this.previewing = on;
    if (this.previewGroup) this.previewGroup.visible = on;
    this.model.visible = !on;
    if (this.edges) this.edges.visible = !on && this.mode === 'line';
    this.shadowsDirty();
    this.dirty = Math.max(this.dirty, 3);
  }

  // ---------------------------------------------------------------------------------------------- FFD lattice handles

  /** Show the control points (Float64Array xyz, Z-up, as drawn: rest + offsets + ground) of an l x m x n lattice, or
   *  hide them (null). selected: indices drawn larger (the dragged / pinned points). */
  setLattice(points, dims, selected = [], current = null) {
    if (!points) {
      if (this.lattice) { this.root.remove(this.lattice.group); this.lattice.dots.geometry.dispose(); this.lattice.dots.dispose(); this.lattice.lines.geometry.dispose(); }
      this.lattice = null; this.dirty = Math.max(this.dirty, 2);
      return;
    }
    const count = points.length / 3, [l, m] = dims;
    if (!this.lattice || this.lattice.count !== count) {
      this.setLattice(null);
      const group = new THREE.Group();
      const dots = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 16, 12),
        new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, depthWrite: false, transparent: true, toneMapped: false }), count);
      dots.renderOrder = 20; dots.frustumCulled = false;
      const lines = new THREE.LineSegments(new THREE.BufferGeometry(),
        new THREE.LineBasicMaterial({ color: 0x0a84ff, transparent: true, opacity: 0.32, depthTest: false, depthWrite: false, toneMapped: false }));
      lines.renderOrder = 19; lines.frustumCulled = false;
      // edges of the lattice graph
      const pairs = [], id = (i, j, k) => i + (l + 1) * (j + (m + 1) * k), n = dims[2];
      for (let k = 0; k <= n; k++) for (let j = 0; j <= m; j++) for (let i = 0; i <= l; i++) {
        if (i < l) pairs.push(id(i, j, k), id(i + 1, j, k));
        if (j < m) pairs.push(id(i, j, k), id(i, j + 1, k));
        if (k < n) pairs.push(id(i, j, k), id(i, j, k + 1));
      }
      lines.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pairs.length * 3), 3));
      group.add(lines, dots);
      this.root.add(group);
      this.lattice = { group, dots, lines, pairs, count, points: null };
    }
    const L = this.lattice, diag = this.box.getSize(new THREE.Vector3()).length() || 1, r = Math.max(0.0055 * diag, 0.004);
    L.points = Float64Array.from(points);
    const sel = new Set(selected), m4 = new THREE.Matrix4(), col = new THREE.Color();
    for (let i = 0; i < count; i++) {
      const k = i === current ? 1.8 : sel.has(i) ? 1.45 : 1;
      m4.makeScale(r * k, r * k, r * k).setPosition(points[3 * i], points[3 * i + 1], points[3 * i + 2]);
      L.dots.setMatrixAt(i, m4);
      L.dots.setColorAt(i, col.set(i === current ? 0xff3b30 : sel.has(i) ? 0xff8a00 : 0x0a84ff));
    }
    L.dots.instanceMatrix.needsUpdate = true;
    if (L.dots.instanceColor) L.dots.instanceColor.needsUpdate = true;
    const pos = L.lines.geometry.attributes.position.array;
    L.pairs.forEach((p, i) => { pos[3 * i] = points[3 * p]; pos[3 * i + 1] = points[3 * p + 1]; pos[3 * i + 2] = points[3 * p + 2]; });
    L.lines.geometry.attributes.position.needsUpdate = true;
    this.dirty = Math.max(this.dirty, 2);
  }

  /** Screen position (CSS px in the canvas) of lattice point i, or null. */
  handleScreen(i) {
    if (!this.lattice || !this.lattice.points) return null;
    const P = this.lattice.points, v = new THREE.Vector3(P[3 * i], P[3 * i + 1], P[3 * i + 2]);
    this.root.localToWorld(v).project(this.camera);
    return { x: (v.x + 1) / 2 * this._w, y: (1 - v.y) / 2 * this._h, z: v.z };
  }

  /** Dragging lattice points: cb = { down(i, shift), move(i, [x, y, z] Z-up as drawn, shift), up(i) }; null turns it off. */
  enableHandles(cb) {
    this.handleCb = cb;
    if (this._handleListeners) return;
    this._handleListeners = true;
    const el = this.canvas, ray = new THREE.Raycaster(), plane = new THREE.Plane(), hit = new THREE.Vector3();
    const nearest = (e) => {
      if (!this.handleCb || !this.lattice || !this.lattice.points) return -1;
      const rc = el.getBoundingClientRect(), x = e.clientX - rc.left, y = e.clientY - rc.top;
      let best = -1, bd = (e.pointerType === 'touch' ? 22 : 12) ** 2;
      for (let i = 0; i < this.lattice.count; i++) {
        const p = this.handleScreen(i);
        if (!p || p.z > 1) continue;
        const d = (p.x - x) ** 2 + (p.y - y) ** 2;
        if (d < bd) { bd = d; best = i; }
      }
      return best;
    };
    const toLocal = (e) => {
      const rc = el.getBoundingClientRect();
      ray.setFromCamera(new THREE.Vector2(((e.clientX - rc.left) / rc.width) * 2 - 1, -((e.clientY - rc.top) / rc.height) * 2 + 1), this.camera);
      if (!ray.ray.intersectPlane(plane, hit)) return null;
      const q = this.root.worldToLocal(hit.clone());
      return [q.x, q.y, q.z];
    };
    el.addEventListener('pointerdown', (e) => {
      const i = nearest(e);
      if (i < 0) return;
      e.stopImmediatePropagation(); e.preventDefault();
      const P = this.lattice.points, w = this.root.localToWorld(new THREE.Vector3(P[3 * i], P[3 * i + 1], P[3 * i + 2]));
      plane.setFromNormalAndCoplanarPoint(this.camera.getWorldDirection(new THREE.Vector3()), w);
      this.drag = { i, id: e.pointerId };
      this.controls.enabled = false;
      try { el.setPointerCapture(e.pointerId); } catch (err) { /* synthetic events */ }
      this.handleCb.down(i, e.shiftKey);
    }, { capture: true });
    el.addEventListener('pointermove', (e) => {
      if (this.drag && e.pointerId === this.drag.id) {
        const q = toLocal(e);
        if (q) this.handleCb.move(this.drag.i, q, e.shiftKey);
        e.stopImmediatePropagation();
        return;
      }
      if (e.buttons === 0) el.style.cursor = nearest(e) >= 0 ? 'pointer' : '';
    }, { capture: true });
    const end = (e) => {
      if (!this.drag || e.pointerId !== this.drag.id) return;
      const i = this.drag.i;
      this.drag = null;
      this.controls.enabled = true;
      e.stopImmediatePropagation();
      if (this.handleCb) this.handleCb.up(i);
    };
    el.addEventListener('pointerup', end, { capture: true });
    el.addEventListener('pointercancel', end, { capture: true });
  }

  /** End a handle drag that lost its pointer (window blur): the capture is released, orbiting comes back, the
   *  callback's up() is not called. */
  cancelDrag() {
    if (!this.drag) return;
    try { this.canvas.releasePointerCapture(this.drag.id); } catch (err) { /* already released */ }
    this.drag = null;
    this.controls.enabled = true;
  }

  // ---------------------------------------------------------------------------------------------- paint

  /** The paint textures from paint.js build(); colour only: the shadows are not redrawn. */
  setPaint(B) {
    putTex('uPDab', B.dab, 'rgba32f');
    const F = B.field, ROW = 1024 * 4;
    const pad = (a, Ctor) => { const n = Math.max(ROW, Math.ceil(a.length / ROW) * ROW); if (a.length === n) return a; const o = new Ctor(n); o.set(a); return o; };
    // floats: exact part headers | field part headers | layers | copy lists
    const parts = [pad(B.head, Float32Array), ...(F ? [pad(F.head, Float32Array), pad(F.lay, Float32Array), pad(F.copy, Float32Array)] : [])];
    const meta = new Float32Array(parts.reduce((n, a) => n + a.length, 0));
    let o = 0; const offs = [];
    for (const a of parts) { offs.push(o / 4); meta.set(a, o); o += a.length; }
    putTex('uPMeta', meta, 'rgba32f');
    PAINT_U.uPOff.value.set(offs[1] || 0, offs[2] || 0, offs[3] || 0, 0);
    // integers: exact cell tables | exact index lists (4 per texel) | field brick tables
    const idx4 = pad(B.idx, Uint32Array), uparts = [pad(B.hash, Uint32Array), idx4, ...(F ? [pad(F.hash, Uint32Array)] : [])];
    const uint = new Uint32Array(uparts.reduce((n, a) => n + a.length, 0));
    o = 0; const uoffs = [];
    for (const a of uparts) { uoffs.push(o / 4); uint.set(a, o); o += a.length; }
    putTex('uPUint', uint, 'rgba32ui');
    PAINT_U.uPOff2.value.set(uoffs[1], uoffs[2] || 0, 0, 0);
    if (F && F !== this._field) {            // the field's samples change only when strokes are flattened
      this._field = F;
      putTex('uFCol', F.col, 'rgba16f'); putTex('uFFin', F.fin, 'rgba8');
    }
    PAINT_U.uFieldOn.value = F && F.layers ? 1 : 0;
    this.paintHas = B.dabs > 0 || !!(F && F.layers);
    this.paintOn();
  }
  paintOn() {
    const U = PAINT_U;
    paintDefaults();
    U.uPaintOn.value = this.paintHas || U.uPLiveD.value.z > 0 || U.uPLiveH.value.y > 0 ? 1 : 0;
    this.dirty = Math.max(this.dirty, 2);
  }
  /** The stroke in progress (paint.js live): uniforms every call, the live grid's textures when it changed. */
  setPaintLive(L) {
    const U = PAINT_U, g = L.grid;
    U.uPLiveA.value.set(L.a); U.uPLiveB.value.set(L.b);
    U.uPLiveC.value.set(L.c[0], L.c[1], L.c[2], L.c[3]); U.uPLiveD.value.set(L.d[0], L.d[1], L.n, L.d[3]);
    if (this._liveGridV !== L.gridVersion) {
      this._liveGridV = L.gridVersion;
      if (g.n) {
        putTex('uPLDab', g.dab.subarray(0, g.n * 8), 'rgba32f');
        const hs = g.T.t.length, ent = g.ent.subarray(0, Math.max(4, g.m * 2 + (g.m & 1) * 2)), lu = new Uint32Array(hs + ent.length);
        lu.set(g.T.t); lu.set(ent, hs);
        putTex('uPLUint', lu, 'rgba32ui');
        this._liveEntOff = hs / 4;
      }
      U.uPLiveG.value.set(g.origin[0], g.origin[1], g.origin[2], g.cell);
      U.uPLiveH.value.set(g.n ? g.T.size : 0, g.n, this._liveEntOff || 0, 0);
    }
    this.paintOn();
  }

  /** The surface under canvas point (x, y) (CSS px): { mesh (index), name, copy, p (part-local), n (part-local normal),
   *  world (Y-up world point), nw (world normal, towards the camera), scale } or null. An integer pick pass (the
   *  part-local position's float bits, part | copy << 12 per pixel; core WebGL2, exact for any copy count) is drawn once
   *  per view and read back in 64 px tiles as the pointer needs them. */
  pick(x, y) {
    const W = this._w, H = this._h;
    if (!this.model.children.length || !(x >= 0) || !(y >= 0) || x >= W || y >= H) return null;
    const cam = this.camera, PC = this.pickCam, r = this.renderer;
    cam.updateMatrixWorld();
    if (!PC.mw.equals(cam.matrixWorld) || !PC.pm.equals(cam.projectionMatrix) || PC.w !== W || PC.h !== H || PC.model !== this.modelVersion || PC.cam !== cam) {
      PC.mw.copy(cam.matrixWorld); PC.pm.copy(cam.projectionMatrix); PC.w = W; PC.h = H; PC.model = this.modelVersion; PC.cam = cam;
      this.pickTiles.clear();
      if (!this.pickRT) this.pickRT = new THREE.WebGLRenderTarget(W, H, { type: THREE.UnsignedIntType, format: THREE.RGBAIntegerFormat, internalFormat: 'RGBA32UI',
        minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false });
      if (this.pickRT.width !== W || this.pickRT.height !== H) this.pickRT.setSize(W, H);
      const mats = this.model.children.map((m) => m.material), cc = r.getClearColor(this._cc || (this._cc = new THREE.Color())), ca = r.getClearAlpha();
      const sh = r.shadowMap.enabled;
      for (const m of this.model.children) m.material = this.pickMat;
      // the 1.80 m figure stands in front of the element: it occludes (part 0: no paint) instead of being painted through
      const fig = [];
      if (this.figure.visible) this.figure.traverse((o) => { if (o.isMesh) { fig.push([o, o.material]); o.material = this.pickMat; } });
      // only the model and the figure are drawn (edges, lattice, previews have float outputs: not into an integer target)
      const others = this.root.children.filter((o) => o !== this.model && o !== this.figure).map((o) => [o, o.visible]);
      for (const [o] of others) o.visible = false;
      r.shadowMap.enabled = false;
      r.setRenderTarget(this.pickRT);
      r.setClearColor(0x000000, 0); r.clear();
      r.render(this.root, cam);
      r.setRenderTarget(null);
      r.setClearColor(cc, ca); r.shadowMap.enabled = sh;
      this.model.children.forEach((m, i) => { m.material = mats[i]; });
      for (const [o, m] of fig) o.material = m;
      for (const [o, v] of others) o.visible = v;
      this.pickRenders = (this.pickRenders || 0) + 1;
    }
    const T = 64, px = Math.min(W - 1, Math.max(0, Math.floor(x))), py = Math.min(H - 1, Math.max(0, H - 1 - Math.floor(y)));
    const at = (qx, qy) => {
      if (qx < 0 || qy < 0 || qx >= W || qy >= H) return null;
      const tx = Math.floor(qx / T), ty = Math.floor(qy / T), k = tx * 65536 + ty;
      let tile = this.pickTiles.get(k);
      if (!tile) {
        const w = Math.min(T, W - tx * T), h = Math.min(T, H - ty * T), u = new Uint32Array(w * h * 4);
        r.readRenderTargetPixels(this.pickRT, tx * T, ty * T, w, h, u);
        tile = { w, h, u, f: new Float32Array(u.buffer) };
        this.pickTiles.set(k, tile);
      }
      const o = ((qy - ty * T) * tile.w + (qx - tx * T)) * 4, id = tile.u[o + 3];
      return id & 4095 ? { o, f: tile.f, id } : null;
    };
    const c = at(px, py);
    if (!c) return null;
    const part = c.id & 4095, copy = c.id >>> 12, mesh = part - 1;
    const im = this.model.children[mesh];
    if (!im) return null;
    const P = (e) => [e.f[e.o], e.f[e.o + 1], e.f[e.o + 2]];
    // sub-pixel position: bilinear over the 2 x 2 texels around the point when they are all on this copy of this part
    const fx = x - 0.5, fy = H - y - 0.5, x0 = Math.floor(fx), y0 = Math.floor(fy), u = fx - x0, v = fy - y0;
    const q = [at(x0, y0), at(x0 + 1, y0), at(x0, y0 + 1), at(x0 + 1, y0 + 1)];
    let p = P(c);
    if (q.every((e) => e && e.id === c.id)) { const Q = q.map(P); p = [0, 1, 2].map((a) => (Q[0][a] * (1 - u) + Q[1][a] * u) * (1 - v) + (Q[2][a] * (1 - u) + Q[3][a] * u) * v); }
    // normal: the local surface's tangents from the neighbouring texels
    const nb = (e) => (e && e.id === c.id ? P(e) : P(c));
    const dx = nb(at(px + 1, py)), dx0 = nb(at(px - 1, py)), dy = nb(at(px, py + 1)), dy0 = nb(at(px, py - 1));
    const V = this.pickV, n = V.n.set(0, 0, 0);
    V.a.set(dx[0] - dx0[0], dx[1] - dx0[1], dx[2] - dx0[2]); V.b.set(dy[0] - dy0[0], dy[1] - dy0[1], dy[2] - dy0[2]);
    n.crossVectors(V.a, V.b);
    const M = V.m;
    im.getMatrixAt(copy, M);
    M.premultiply(im.matrixWorld);
    const world = new THREE.Vector3(p[0], p[1], p[2]).applyMatrix4(M);
    const toCam = V.c.subVectors(cam.position, world);
    const nw = n.lengthSq() > 1e-30 ? n.clone().transformDirection(M) : toCam.clone().normalize();
    if (nw.dot(toCam) < 0) { nw.negate(); n.negate(); }
    const sx = V.a.setFromMatrixColumn(M, 0).length(), sy = V.a.setFromMatrixColumn(M, 1).length(), sz = V.a.setFromMatrixColumn(M, 2).length();
    return { mesh, name: im.name, copy, p, n: n.lengthSq() > 1e-30 ? n.normalize().toArray() : [0, 0, 1], world, nw, scale: (sx + sy + sz) / 3 };
  }

  /** Screen points (CSS px) of a circle of world radius r around a pick, lying on the surface (the brush cursor). */
  ring(hit, r, n = 48) {
    const t1 = new THREE.Vector3(), t2 = new THREE.Vector3(), v = new THREE.Vector3(), out = [];
    const nw = hit.nw;
    t1.set(Math.abs(nw.y) < 0.9 ? 0 : 1, Math.abs(nw.y) < 0.9 ? 1 : 0, 0).cross(nw).normalize();
    t2.crossVectors(nw, t1);
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2;
      v.copy(hit.world).addScaledVector(t1, Math.cos(a) * r).addScaledVector(t2, Math.sin(a) * r).addScaledVector(nw, r * 0.02).project(this.camera);
      out.push([(v.x + 1) / 2 * this._w, (1 - v.y) / 2 * this._h]);
    }
    return out;
  }
  /** Screen pixels per metre at a world point (the size slider's preview). */
  pxPerMetre(world) {
    const a = world.clone().project(this.camera), right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
    const b = world.clone().add(right).project(this.camera);
    return Math.hypot((b.x - a.x) / 2 * this._w, (b.y - a.y) / 2 * this._h);
  }

  // ---------------------------------------------------------------------------------------------- grips (projection)

  /** The shadow map is redrawn on the next frame (the light, the model, its visibility or its clipping changed). */
  shadowsDirty() {
    this.renderer.shadowMap.needsUpdate = true;
    this.dirty = Math.max(this.dirty, 1);
  }

  /** Screen position (CSS px in the canvas) of a point in element coordinates (Z-up metres), z the NDC depth (> 1:
   *  behind the camera or beyond the far plane). */
  project(p, out = { x: 0, y: 0, z: 0 }) {
    const v = this._pv || (this._pv = new THREE.Vector3());
    v.set(p[0], p[1], p[2]);
    this.root.localToWorld(v).project(this.camera);
    out.x = (v.x + 1) / 2 * this._w; out.y = (1 - v.y) / 2 * this._h; out.z = v.z;
    return out;
  }

  /** How a drag direction looks on screen at element point p: { x, y } the point, { vx, vy } the screen image of one
   *  metre along dir (CSS px), ref the screen length of one metre across the view at p (for a direction that points
   *  at the camera, whose image is too short to drag along). */
  screenAxis(p, dir) {
    const cam = this.camera;
    cam.updateMatrixWorld();
    const a = this.project(p, {}), h = 0.05 * (this.box.getSize(new THREE.Vector3()).length() || 1);
    const b = this.project([p[0] + dir[0] * h, p[1] + dir[1] * h, p[2] + dir[2] * h], {});
    // a metre across the view: the camera's right vector, taken back to element coordinates (Y-up -> Z-up)
    const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
    const c = this.project([p[0] + right.x * h, p[1] - right.z * h, p[2] + right.y * h], {});
    return { x: a.x, y: a.y, z: a.z, vx: (b.x - a.x) / h, vy: (b.y - a.y) / h, ref: Math.hypot(c.x - a.x, c.y - a.y) / h };
  }

  // ---------------------------------------------------------------------------------------------- frames

  /** Resolves after n more frames have been rendered. */
  frames(n) {
    this.dirty = Math.max(this.dirty, n);
    return new Promise((resolve) => this.waiters.push({ n, resolve }));
  }

  tick() {
    this.resize();
    const moved = this.controls.update();
    if (!moved && this.dirty <= 0) return;
    if (moved) this.updateClip();
    this.composer.render();
    if (this.onFrame) this.onFrame();
    this.dirty = moved ? Math.max(this.dirty, 8) : this.dirty - 1;
    if (this.waiters.length) {
      for (const w of this.waiters) w.n--;
      const done = this.waiters.filter((w) => w.n <= 0);
      this.waiters = this.waiters.filter((w) => w.n > 0);
      done.forEach((w) => w.resolve());
    }
  }

}
