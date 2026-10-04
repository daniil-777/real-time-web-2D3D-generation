// The orders, after Vignola (Regola delli cinque ordini, 1562) as tabulated by W. R. Ware, The American Vignola
// (1903): every measure is in lower diameters D of the column (one module M = D/2). Non-classical column styles use
// typical proportions of their period. Nothing outside this file hard-codes an order's proportions.

export const ORDERS = {
  tuscan: {
    label: 'Tuscan', colD: 7, baseD: 0.5, capD: 0.5, shaftTop: 0.8, flutes: 0, flute: 'none', base: 'tuscan',
    ent: { arch: 0.5, frieze: 7 / 12, cornice: 2 / 3 }, frieze: 'plain', cornice: 'plain', axis: 3.25, classical: true,
  },
  doric: {
    label: 'Doric', colD: 8, baseD: 0.5, capD: 0.5, shaftTop: 5 / 6, flutes: 20, flute: 'arris', base: 'attic',
    ent: { arch: 0.5, frieze: 0.75, cornice: 0.75 }, frieze: 'triglyph', cornice: 'mutules', axis: 3.75, classical: true,
  },
  'greek-doric': {
    label: 'Greek Doric', colD: 5.5, baseD: 0, capD: 0.45, shaftTop: 0.78, flutes: 20, flute: 'arris', base: 'none',
    ent: { arch: 0.7, frieze: 0.7, cornice: 0.3 }, frieze: 'triglyph', cornice: 'mutules', axis: 2.5, classical: true,
  },
  ionic: {
    label: 'Ionic', colD: 9, baseD: 0.5, capD: 1 / 3, shaftTop: 5 / 6, flutes: 24, flute: 'fillet', base: 'attic',
    ent: { arch: 0.625, frieze: 0.75, cornice: 0.875 }, frieze: 'plain', cornice: 'dentils', axis: 3.25, classical: true,
  },
  corinthian: {
    label: 'Corinthian', colD: 10, baseD: 0.5, capD: 7 / 6, shaftTop: 5 / 6, flutes: 24, flute: 'fillet', base: 'attic',
    ent: { arch: 0.75, frieze: 0.75, cornice: 1 }, frieze: 'plain', cornice: 'modillions', axis: 3.25, classical: true,
  },
  composite: {
    label: 'Composite', colD: 10, baseD: 0.5, capD: 7 / 6, shaftTop: 5 / 6, flutes: 24, flute: 'fillet', base: 'attic',
    ent: { arch: 0.75, frieze: 0.75, cornice: 1 }, frieze: 'plain', cornice: 'modillions', axis: 3.25, classical: true,
  },
  romanesque: {
    label: 'Romanesque', colD: 6, baseD: 0.4, capD: 0.8, shaftTop: 1, flutes: 0, flute: 'none', base: 'attic',
    ent: { arch: 0.5, frieze: 0.4, cornice: 0.5 }, frieze: 'plain', cornice: 'plain', axis: 3, classical: false,
  },
  gothic: {
    label: 'Gothic clustered', colD: 11, baseD: 0.6, capD: 0.5, shaftTop: 1, flutes: 0, flute: 'none', base: 'gothic',
    ent: { arch: 0.5, frieze: 0.4, cornice: 0.5 }, frieze: 'plain', cornice: 'plain', axis: 3.5, classical: false,
  },
  egyptian: {
    label: 'Egyptian papyrus', colD: 6, baseD: 0.25, capD: 1, shaftTop: 0.85, flutes: 8, flute: 'reed', base: 'disc',
    ent: { arch: 0.5, frieze: 0.5, cornice: 0.6 }, frieze: 'plain', cornice: 'gorge', axis: 2.5, classical: false,
  },
  solomonic: {
    label: 'Solomonic', colD: 9, baseD: 0.5, capD: 7 / 6, shaftTop: 5 / 6, flutes: 0, flute: 'none', base: 'attic',
    ent: { arch: 0.75, frieze: 0.75, cornice: 1 }, frieze: 'plain', cornice: 'modillions', axis: 3.5, classical: false,
  },
  'art-deco': {
    label: 'Art Deco', colD: 9, baseD: 0.5, capD: 0.5, shaftTop: 1, flutes: 16, flute: 'reed', base: 'stepped',
    ent: { arch: 0.4, frieze: 0.5, cornice: 0.4 }, frieze: 'plain', cornice: 'plain', axis: 3, classical: false,
  },
  modern: {
    label: 'Modern', colD: 12, baseD: 0, capD: 0, shaftTop: 1, flutes: 0, flute: 'none', base: 'none',
    ent: { arch: 0.5, frieze: 0, cornice: 0.2 }, frieze: 'plain', cornice: 'plain', axis: 4, classical: false,
  },
};

export const ORDER_KEYS = Object.keys(ORDERS);

/** Default lower diameter (m) when neither height nor diameter is given. */
export const DEFAULT_D = 0.45;

/**
 * Dimensions of a column in metres. `height` is the column proper (base + shaft + capital, without pedestal);
 * when absent, `diameter` (lower shaft diameter) is used; when both are absent D = DEFAULT_D.
 */
export function columnDims(order, { height, diameter, pedestal } = {}) {
  const o = ORDERS[order] || ORDERS.tuscan;
  const D = height ? height / o.colD : diameter || DEFAULT_D;
  const H = D * o.colD;
  const base = o.baseD * D, cap = o.capD * D;
  const ped = pedestal ? (H / 3) : 0;
  return { D, H, base, cap, shaft: H - base - cap, ped, total: H + ped, top: o.shaftTop * D, o };
}

/** Entablature heights (m) of an order for lower diameter D: { arch, frieze, cornice, total }. */
export function entablatureDims(order, D) {
  const e = (ORDERS[order] || ORDERS.tuscan).ent;
  const arch = e.arch * D, frieze = e.frieze * D, cornice = e.cornice * D;
  return { arch, frieze, cornice, total: arch + frieze + cornice };
}
