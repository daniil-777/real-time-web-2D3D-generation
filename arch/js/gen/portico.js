// Portico (one row of columns, a temple front): stylobate with steps, N columns of an order at the order's axis spacing
// (Vignola via Ware: eustyle 3.25 D for Tuscan / Ionic / Corinthian / Composite; Doric ditriglyph 3.75 D so a triglyph
// falls over every column axis; Greek Doric monotriglyph 2.5 D), the entablature across the colonnade with returns,
// and a pediment (triangular, segmental, broken or none) whose horizontal cornice is the entablature's cornice.
// Z-up, metres; origin at the base centre (z = 0 at the foot of the lowest step), the front faces -Y, columns on y = 0.
//
// Layout: the frieze face is plumb with the front of the upper shaft (Vignola), so the entablature runs over the
// colonnade for (N - 1)·axis + upper diameter; the roof block (entablature + pediment) and the stylobate reach back to
// y = 0.75 D (they cover the capitals' abaci); the stylobate top extends 0.3 D beyond the column plinths; steps are of
// human scale (riser 0.16 m, tread 0.32 m, Blondel 2R + T = 0.64 m) and wrap the front and both flanks.

import { ORDERS, columnDims } from '../orders.js';
import { normalize } from '../spec.js';
import { build as buildColumn } from './column.js';
import { mat, instances, box, union, part, placeParts, partTris, partsBBox } from '../kernel.js';
import { entablaturePlan, entablatureParts, pedimentPlan, pedimentParts, porticoKinds, roleFor, tagRigid } from './entablature.js';

export const ELEMENTS = ['portico'];

const RISER = 0.16, TREAD = 0.32, EPS = 0.001, DEFAULT_PORTICO_D = 0.6, TRI_BUDGET = 1.9e6;
const PLINTH = { attic: 0.67, tuscan: 0.66, none: 0.52 };   // plinth half-width in D (column.js bases)

/** Everything the portico needs to know, without geometry (used by build and expected). */
export function porticoPlan(spec) {
  const order = ORDERS[spec.order] ? spec.order : 'ionic', O = ORDERS[order];
  const n = spec.columns || 4, steps = spec.steps ?? 3, pedKind = spec.pediment || 'triangular';
  const k = porticoKinds(spec, order);
  const base = spec.base ?? (O.base === 'attic' || O.base === 'tuscan' || O.base === 'none' ? O.base : 'attic');
  const hp = (PLINTH[base] ?? 0.67) + 0.3;                  // stylobate edge beyond the outer axis, in D
  const plat = steps > 0 ? steps - 1 : 0;                   // treads below the stylobate top
  // widths as linear functions of D (axis spacing in D fixed by the order) for a given D
  const geom = (D, axis) => {
    const top = O.shaftTop * D, Le = (n - 1) * axis + top, Bd = spec.depth ? Math.max(spec.depth, top) : top / 2 + 0.75 * D;
    const roof = pedKind === 'none'
      ? entablaturePlan({ order, D, L: Le, B: Bd, returns: true, fk: k.fk, ck: k.ck, enrich: k.enrich, detail: k.detail, parts: 'all' }).size.x
      : pedimentPlan({ order, D, W: Le, B: Bd, kind: pedKind, pitch: spec.pitch, ck: k.ck, enrich: k.enrich, detail: k.detail }).size.x;
    const stylo = steps > 0 ? (n - 1) * axis + 2 * hp * D + 2 * plat * TREAD : 0;
    return Math.max(roof, stylo, (n - 1) * axis + 2 * (PLINTH[base] ?? 0.67) * D);
  };
  let D, axis;
  if (spec.height) {
    D = spec.height / O.colD;
    axis = O.axis * D;
    if (spec.width) {                                       // both given: the intercolumniation takes up the width
      const extra = geom(D, 0);
      axis = n > 1 ? Math.max(1.5 * D, (spec.width - extra) / (n - 1)) : axis;
    }
  } else if (spec.width) {
    // width(D) is increasing and piecewise linear: bisect for the D that gives the asked width
    let lo = 0.02, hi = 20;
    for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (geom(mid, O.axis * mid) < spec.width) lo = mid; else hi = mid; }
    D = (lo + hi) / 2; axis = O.axis * D;
  } else { D = spec.diameter || DEFAULT_PORTICO_D; axis = O.axis * D; }
  const cd = columnDims(order, { height: O.colD * D });
  // roof block depth behind the frieze face: `depth` when given (at least the upper diameter), else to y = 0.75 D
  const top = O.shaftTop * D, Le = (n - 1) * axis + top, yf = -top / 2, B = spec.depth ? Math.max(spec.depth, top) : 0.75 * D - yf, yb = yf + B;
  // the columns (column.js, memoised: a scale of a cached unit build) stand 1 mm into the stylobate; the entablature
  // sits 1 mm into the real top of the capitals and the pediment 1 mm into the frieze, so the assembly is one solid
  const cspec = normalize({ element: 'column', order, height: cd.H, flutes: spec.flutes, base: spec.base,
    pedestal: false, entasis: spec.entasis, material: spec.material, detail: spec.detail }).spec;
  const col = buildColumn(cspec), colTop = partsBBox(col).max[2];
  const zs = steps * RISER, zcol = steps > 0 ? zs - EPS : zs, zc = zcol + colTop - EPS;
  const axes = Array.from({ length: n }, (_, i) => (i - (n - 1) / 2) * axis);
  const ent = entablaturePlan({ order, D, L: Le, B, returns: true, fk: k.fk, ck: k.ck, enrich: k.enrich, detail: k.detail,
    parts: pedKind === 'none' ? 'all' : 'lower', axes });
  const ped = pedKind === 'none' ? null
    : pedimentPlan({ order, D, W: Le, B, kind: pedKind, pitch: spec.pitch, ck: k.ck, enrich: k.enrich, detail: k.detail, axes });
  const Xs = axes[n - 1] + hp * D;
  const width = geom(D, axis);
  const zp = zc + ent.size.z - EPS, z = ped ? zp + ped.size.z : zc + ent.size.z;
  return { order, O, n, steps, D, axis, cd, top, Le, yf, yb, B, zs, zcol, zc, zp, col, axes, ent, ped, Xs, plat, base, k,
    size: { x: width, z } };
}

export function build(spec) {
  const pp = porticoPlan(spec), parts = [];
  // stylobate and steps (front and flanks), the top step being the stylobate
  if (pp.steps > 0) {
    const blocks = [];
    for (let i = 0; i < pp.steps; i++) {                    // i = 0 is the top step
      const g = i * TREAD, z1 = (pp.steps - i) * RISER, z0 = z1 - RISER - (i < pp.steps - 1 ? EPS : 0);
      blocks.push(box(-pp.Xs - g, -(pp.Xs - pp.axes[pp.n - 1]) - g, Math.max(0, z0), pp.Xs + g, pp.yb, z1));
    }
    parts.push(part('stylobate', 'stone', union(blocks), null, { rigid: false }));   // the platform is one continuous member
  }
  // columns: built once by the column family, placed as instances
  const col = pp.col;
  for (const p of col) {
    const local = p.transforms ? Array.from({ length: p.transforms.length / 16 }, (_, i) => p.transforms.subarray(16 * i, 16 * i + 16)) : [mat.I()];
    const xf = pp.axes.flatMap((x) => local.map((m) => mat.mul(mat.T(x, 0, pp.zcol), m)));
    parts.push(part(p.name, p.role, p.manifold, instances(xf), { ...p.meta, rigid: true }));   // every part of a placed column is rigid
  }
  // entablature (with its cornice when there is no pediment) and the pediment on the frieze
  parts.push(...placeParts(tagRigid(entablatureParts(pp.ent)), mat.T(0, pp.yf, pp.zc)));
  if (pp.ped) parts.push(...placeParts(tagRigid(pedimentParts(pp.ped)), mat.T(0, pp.yf, pp.zp)));
  const role = roleFor(spec.material), fitted = fitBudget(parts, TRI_BUDGET, pp.D);
  return role === 'stone' ? fitted : fitted.map((p) => ({ ...p, role }));
}

/**
 * Keep the assembly under the triangle budget: simplify the heaviest instanced parts first (capitals' leaves and
 * volutes, shafts, modillions, eggs), one at a time, until the total fits; a further pass doubles the tolerance and works
 * on the previous result. Tolerances D/700, D/350, ... (0.9, 1.7, 3.4 mm at D = 0.6 m); no surface moves by more than
 * the sum of the tolerances used, invisible at the scale of a portico.
 */
function fitBudget(parts, budget, D) {
  const total = (ps) => ps.reduce((s, p) => s + partTris(p), 0);
  const out = parts.slice();
  let sum = total(out);
  for (let k = 700; sum > budget && k >= 80; k /= 2) {
    const order = out.map((p, i) => i).sort((a, b) => partTris(out[b]) - partTris(out[a]));
    for (const i of order) {
      if (sum <= budget || partTris(out[i]) < 0.02 * budget) break;
      const before = partTris(out[i]);
      out[i] = { ...out[i], manifold: out[i].manifold.simplify(D / k) };
      sum += partTris(out[i]) - before;
    }
  }
  return out;
}

/** Columns counted by their shafts; size x = overall width (the wider of stylobate and roof), z = foot of the steps to
 *  the apex of the pediment (or the top of the cornice when there is none). */
export function expected(spec) {
  const pp = porticoPlan(spec);
  return { size: { x: pp.size.x, z: pp.size.z }, counts: { shaft: pp.n }, tol: 0.005 };
}
