// The spec: the typed description of one element, shared by the parser, the UI, the generators and the tests.
// Lengths in metres, angles in degrees. A parsed spec holds only what the text said; normalize() fills the rest.

import { ORDERS, ORDER_KEYS } from './orders.js';

export const ELEMENTS = [
  'column', 'pilaster', 'capital', 'base', 'pedestal',
  'entablature', 'cornice', 'moulding', 'pediment', 'portico',
  'balustrade', 'baluster',
  'arch', 'arcade', 'window', 'door',
  'roof', 'dome', 'cupola', 'spire',
  'finial', 'urn', 'obelisk', 'console',
];

export const MATERIALS = ['marble', 'limestone', 'sandstone', 'granite', 'travertine', 'plaster', 'concrete', 'terracotta',
  'brick', 'slate', 'copper', 'lead', 'zinc', 'bronze', 'gold', 'wood'];

export const SCHEMA = {
  element: { type: 'enum', values: ELEMENTS },
  order: { type: 'enum', values: ORDER_KEYS },
  style: { type: 'enum', values: ['greek', 'roman', 'renaissance', 'baroque', 'neoclassical', 'gothic', 'romanesque',
    'byzantine', 'russian', 'moorish', 'egyptian', 'art-nouveau', 'art-deco', 'modern'] },
  material: { type: 'enum', values: MATERIALS },
  height: { type: 'number', min: 0.05, max: 120, unit: 'm' },
  width: { type: 'number', min: 0.05, max: 80, unit: 'm' },
  length: { type: 'number', min: 0.1, max: 120, unit: 'm' },
  depth: { type: 'number', min: 0.05, max: 80, unit: 'm' },
  diameter: { type: 'number', min: 0.05, max: 60, unit: 'm' },
  span: { type: 'number', min: 0.3, max: 40, unit: 'm' },
  columns: { type: 'int', min: 2, max: 16 },
  balusters: { type: 'int', min: 1, max: 300 },
  bays: { type: 'int', min: 1, max: 20 },
  flutes: { type: 'int', min: 0, max: 48 },
  ribs: { type: 'int', min: 0, max: 48 },
  steps: { type: 'int', min: 0, max: 8 },
  pitch: { type: 'number', min: 5, max: 75, unit: '°' },
  overhang: { type: 'number', min: 0, max: 3, unit: 'm' },
  dormers: { type: 'bool' },
  base: { type: 'enum', values: ['attic', 'tuscan', 'none'] },
  pedestal: { type: 'bool' },
  entasis: { type: 'bool' },
  pediment: { type: 'enum', values: ['triangular', 'segmental', 'broken', 'none'] },
  archType: { type: 'enum', values: ['semicircular', 'segmental', 'pointed', 'horseshoe', 'basket', 'tudor'] },
  supports: { type: 'enum', values: ['piers', 'columns'] },
  roofType: { type: 'enum', values: ['gable', 'hip', 'mansard', 'gambrel', 'pyramid', 'shed'] },
  covering: { type: 'enum', values: ['tiles', 'pantiles', 'slate', 'seam', 'shingles'] },
  domeType: { type: 'enum', values: ['hemisphere', 'segmental', 'onion', 'ribbed'] },
  drum: { type: 'bool' },
  lantern: { type: 'bool' },
  oculus: { type: 'bool' },
  spireType: { type: 'enum', values: ['octagonal', 'square', 'broach'] },
  baluster: { type: 'enum', values: ['vase', 'double-vase', 'bottle', 'square', 'bar'] },
  profile: { type: 'enum', values: ['cyma-recta', 'cyma-reversa', 'ovolo', 'cavetto', 'torus', 'scotia', 'bead', 'crown'] },
  enrichment: { type: 'enum', values: ['none', 'egg-and-dart', 'bead-and-reel', 'dentils', 'acanthus'] },
  frieze: { type: 'enum', values: ['plain', 'triglyph', 'pulvinated'] },
  cornice: { type: 'enum', values: ['plain', 'dentils', 'modillions', 'mutules'] },
  keystone: { type: 'bool' },
  finial: { type: 'enum', values: ['ball', 'pineapple', 'acorn', 'urn', 'flame', 'cross', 'spike', 'none'] },
  urns: { type: 'bool' },
  returns: { type: 'bool' },
  detail: { type: 'enum', values: ['low', 'medium', 'high'] },
  seed: { type: 'int', min: 0, max: 2 ** 31 - 1 },
};

// Defaults per element; order-dependent fields (base, flutes, frieze, cornice) come from ORDERS in normalize().
export const DEFAULTS = {
  column: { order: 'ionic', pedestal: false, entasis: true, material: 'marble' },
  pilaster: { order: 'corinthian', pedestal: false, entasis: false, material: 'limestone' },
  capital: { order: 'corinthian', material: 'marble' },
  base: { order: 'ionic', material: 'marble' },
  pedestal: { order: 'tuscan', material: 'limestone' },
  entablature: { order: 'ionic', length: 3, returns: true, material: 'limestone' },
  cornice: { order: 'corinthian', length: 3, returns: true, material: 'limestone' },
  moulding: { profile: 'ovolo', enrichment: 'egg-and-dart', length: 1.2, height: 0.16, material: 'plaster' },
  pediment: { pediment: 'triangular', order: 'ionic', width: 5, material: 'limestone' },
  portico: { order: 'ionic', columns: 4, pediment: 'triangular', steps: 3, material: 'limestone' },
  balustrade: { baluster: 'vase', length: 3, height: 0.95, urns: false, material: 'limestone' },
  baluster: { baluster: 'vase', height: 0.7, material: 'limestone' },
  arch: { archType: 'semicircular', span: 2.4, keystone: true, supports: 'piers', order: 'tuscan', material: 'sandstone' },
  arcade: { archType: 'semicircular', span: 2.4, bays: 3, keystone: true, supports: 'piers', order: 'tuscan', material: 'sandstone' },
  window: { width: 1.2, height: 2.1, pediment: 'triangular', keystone: false, material: 'limestone' },
  door: { width: 1.6, height: 3.0, pediment: 'segmental', keystone: false, material: 'limestone' },
  roof: { roofType: 'hip', width: 8, length: 12, pitch: 35, covering: 'tiles', material: 'terracotta' },
  dome: { domeType: 'hemisphere', diameter: 8, drum: true, lantern: true, oculus: false, ribs: 0, material: 'copper' },
  cupola: { domeType: 'hemisphere', diameter: 2.4, drum: true, lantern: false, ribs: 0, material: 'copper' },
  spire: { spireType: 'octagonal', height: 14, width: 3, finial: 'cross', material: 'slate' },
  finial: { finial: 'pineapple', height: 0.8, material: 'limestone' },
  urn: { finial: 'urn', height: 0.9, material: 'limestone' },
  obelisk: { height: 6, material: 'granite' },
  console: { height: 0.6, depth: 0.42, width: 0.26, material: 'limestone' },
};

/** Fill defaults and clamp out-of-range values. Returns { spec, warnings }. Never throws on user values. */
export function normalize(input) {
  const warnings = [];
  const element = ELEMENTS.includes(input.element) ? input.element : 'column';
  if (input.element && input.element !== element) warnings.push(`unknown element "${input.element}", made a column`);
  const spec = { ...DEFAULTS[element], ...strip(input), element };
  if (spec.order && !ORDERS[spec.order]) { warnings.push(`unknown order "${spec.order}"`); spec.order = DEFAULTS[element].order || 'tuscan'; }
  const o = ORDERS[spec.order || 'tuscan'];
  if (['column', 'pilaster', 'capital', 'base', 'pedestal', 'portico', 'arcade', 'entablature', 'cornice'].includes(element)) {
    if (spec.base === undefined) spec.base = o.base === 'attic' || o.base === 'tuscan' || o.base === 'none' ? o.base : 'attic';
    if (spec.flutes === undefined) spec.flutes = o.flutes;
    if (spec.frieze === undefined) spec.frieze = o.frieze;
    if (spec.cornice === undefined) spec.cornice = o.cornice === 'gorge' ? 'plain' : o.cornice;
  }
  for (const [k, v] of Object.entries(spec)) {
    const s = SCHEMA[k];
    if (!s || v === undefined || v === null) continue;
    if (s.type === 'number' || s.type === 'int') {
      let x = Number(v);
      if (!Number.isFinite(x)) { warnings.push(`${k}: "${v}" is not a number, ignored`); delete spec[k]; continue; }
      if (s.type === 'int') x = Math.round(x);
      if (x < s.min || x > s.max) {
        const c = Math.min(s.max, Math.max(s.min, x));
        warnings.push(`${k} ${x}${s.unit || ''} is outside ${s.min}–${s.max}${s.unit || ''}, used ${c}${s.unit || ''}`);
        x = c;
      }
      spec[k] = x;
    } else if (s.type === 'enum' && !s.values.includes(v)) {
      warnings.push(`${k} "${v}" is not one of ${s.values.join(', ')}, ignored`);
      delete spec[k];
    } else if (s.type === 'bool') spec[k] = !!v;
  }
  if (spec.flutes > 0 && spec.flutes < 6) { warnings.push(`${spec.flutes} flutes is too few, used 6`); spec.flutes = 6; }
  return { spec, warnings };
}

function strip(o) {
  const out = {};
  for (const [k, v] of Object.entries(o || {})) if (v !== undefined && v !== null && k in SCHEMA) out[k] = v;
  return out;
}
