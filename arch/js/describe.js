// Arch Studio describer: a normalised spec → the one-line interpretation shown under the prompt, and varied exact
// captions (EN + one of DE/FR/IT) for the dataset the generator writes. Only facts that are in the spec, never guesses.
//   describe(spec) → "Ionic column · 3.60 m · 24 flutes · Attic base · marble"
//   captions(spec, seed = 0) → string[] (4–6)

import { ORDERS, columnDims, DEFAULT_D } from './orders.js';
import { effective } from './gen/surround.js';

const ORDER = { tuscan: 'Tuscan', doric: 'Doric', 'greek-doric': 'Greek Doric', ionic: 'Ionic', corinthian: 'Corinthian',
  composite: 'Composite', romanesque: 'Romanesque', gothic: 'Gothic', egyptian: 'Egyptian', solomonic: 'Solomonic',
  'art-deco': 'Art Deco', modern: 'modern' };
const STYLE = { greek: 'Greek', roman: 'Roman', renaissance: 'Renaissance', baroque: 'Baroque', neoclassical: 'Neoclassical',
  gothic: 'Gothic', romanesque: 'Romanesque', byzantine: 'Byzantine', russian: 'Russian', moorish: 'Moorish',
  egyptian: 'Egyptian', 'art-nouveau': 'Art Nouveau', 'art-deco': 'Art Deco', modern: 'modern' };
const GREEK = { 2: 'distyle', 4: 'tetrastyle', 6: 'hexastyle', 8: 'octastyle', 10: 'decastyle', 12: 'dodecastyle' };
const ARCH = { semicircular: 'semicircular', segmental: 'segmental', pointed: 'pointed', horseshoe: 'horseshoe', basket: 'basket-handle', tudor: 'Tudor' };
const DOME = { hemisphere: 'hemispherical', segmental: 'segmental', onion: 'onion', ribbed: 'ribbed' };
const PROFILE = { 'cyma-recta': 'cyma recta', 'cyma-reversa': 'cyma reversa', ovolo: 'ovolo', cavetto: 'cavetto', torus: 'torus', scotia: 'scotia', bead: 'bead (astragal)', crown: 'crown' };
const CORNICE = { plain: 'plain cornice', dentils: 'dentil cornice', modillions: 'modillion cornice', mutules: 'mutule cornice' };
const FRIEZE = { plain: 'plain frieze', triglyph: 'triglyph frieze', pulvinated: 'pulvinated frieze' };
const CLASSICAL = new Set(['tuscan', 'doric', 'greek-doric', 'ionic', 'corinthian', 'composite', 'solomonic']);

const fmt = (v) => (Math.round(Number(v) * 100) / 100).toFixed(2);
const m = (v) => `${fmt(v)} m`;
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const join = (...xs) => xs.filter(Boolean).join(' ');

/** The column proper (+ pedestal) as built: spec height, else from the order's proportions. */
function columnHeight(s) {
  if (s.height) return s.height;
  const d = columnDims(s.order, { diameter: s.diameter });
  return d.H * (s.pedestal ? 4 / 3 : 1);
}
function styleWord(s) { return s.style && STYLE[s.style] && (!s.order || STYLE[s.style] !== ORDER[s.order]) ? STYLE[s.style] : null; }

/** Facts of a spec: a title and a list of short phrases; shared by describe() and captions(). */
function facts(spec) {
  const s = spec || {};
  const el = s.element || 'column';
  const o = s.order && ORDER[s.order];
  const st = styleWord(s);
  const f = { el, title: '', main: null, items: [], counts: [] };
  const mat = s.material || null;
  switch (el) {
    case 'column': case 'pilaster': {
      f.title = join(st, o, el);
      f.main = { field: 'height', v: columnHeight(s) };
      if (s.diameter) f.items.push(`Ø ${m(s.diameter)}`);
      const deflt = s.order && ORDERS[s.order] ? ORDERS[s.order].flutes : 0;
      if (s.flutes > 0) { f.items.push(`${s.flutes} flutes`); f.counts.push(['flutes', s.flutes]); }
      else if (s.flutes === 0 && deflt > 0) f.items.push('unfluted');
      if (s.base === 'none') f.items.push('no base');
      else if (s.base && CLASSICAL.has(s.order)) f.items.push(`${cap(s.base)} base`);
      if (s.pedestal) f.items.push('on a pedestal');
      if (s.entasis === false) f.items.push('no entasis');
      break;
    }
    case 'capital': {
      f.title = join(st, o, 'capital');
      const d = columnDims(s.order, { diameter: s.diameter });
      const h = s.height || (d.cap > 0 ? d.cap : 0.12 * (s.diameter || DEFAULT_D));
      f.main = { field: 'height', v: h };
      f.items.push(`for a Ø ${m(s.height && d.o.capD ? s.height / d.o.capD : d.D)} column`);
      break;
    }
    case 'base': {
      f.title = join(st, s.base && s.base !== 'none' ? cap(s.base) : null, 'base');
      if (o) f.items.push(`${o} order`);
      const d = columnDims(s.order, { diameter: s.diameter });
      f.main = { field: 'height', v: s.height || d.base || 0.05 * d.D };
      break;
    }
    case 'pedestal': {
      f.title = join(st, o, 'pedestal');
      f.main = { field: 'height', v: s.height || columnDims(s.order, {}).H / 3 };
      break;
    }
    case 'entablature': case 'cornice': {
      f.title = join(st, o, el);
      f.main = { field: 'length', v: s.length };
      if (el === 'entablature' && s.frieze) f.items.push(FRIEZE[s.frieze]);
      if (s.cornice) f.items.push(el === 'cornice' ? s.cornice : CORNICE[s.cornice]);
      if (s.enrichment && s.enrichment !== 'none') f.items.push(s.enrichment);
      if (s.returns) f.items.push('returns'); else if (s.returns === false) f.items.push('no returns');
      break;
    }
    case 'moulding': {
      f.title = join(st, PROFILE[s.profile], 'moulding');
      f.main = { field: 'length', v: s.length };
      f.items.push(`${m(s.height)} high`);
      if (s.enrichment) f.items.push(s.enrichment === 'none' ? 'plain' : s.enrichment);
      break;
    }
    case 'pediment': {
      // pediment 'none' builds the horizontal cornice alone
      f.title = s.pediment === 'none' ? join(st, 'cornice') : join(st, s.pediment, 'pediment');
      f.main = { field: 'width', v: s.width };
      if (o) f.items.push(o);
      if (s.pediment === 'none') f.items.push('no pediment');
      break;
    }
    case 'portico': {
      const n = s.columns;
      f.title = join(st, GREEK[n] || (n ? `${n}-column` : null), o, 'portico');
      if (n) f.counts.push(['columns', n]);
      if (s.width) f.main = { field: 'width', v: s.width };
      if (s.pediment) f.items.push(s.pediment === 'none' ? 'no pediment' : `${s.pediment} pediment`);
      if (s.steps !== undefined) { f.items.push(`${s.steps} step${s.steps === 1 ? '' : 's'}`); f.counts.push(['steps', s.steps]); }
      break;
    }
    case 'balustrade': {
      f.title = join(st, 'balustrade');
      f.main = { field: 'length', v: s.length };
      if (s.height) f.items.push(`${m(s.height)} high`);
      if (s.balusters) { f.items.push(`${s.balusters} ${s.baluster || ''} balusters`.replace(/\s+/g, ' ')); f.counts.push(['balusters', s.balusters]); }
      else if (s.baluster) f.items.push(`${s.baluster} balusters`);
      if (s.urns) f.items.push('urns');
      break;
    }
    case 'baluster': {
      f.title = join(st, s.baluster, 'baluster');
      f.main = { field: 'height', v: s.height };
      break;
    }
    case 'arch': case 'arcade': {
      const t = ARCH[s.archType] || '';
      if (el === 'arcade') { f.title = join(st, `arcade of ${s.bays || 3} ${t} arches`); f.counts.push(['bays', s.bays || 3]); }
      else f.title = join(st, t, 'arch');
      f.main = { field: 'span', v: s.span };
      if (el === 'arcade' && s.length) f.items.push(`${m(s.length)} long`);
      if (s.height) f.items.push(`${m(s.height)} high`);
      if (s.keystone) f.items.push('keystone'); else if (s.keystone === false) f.items.push('no keystone');
      if (s.supports) f.items.push(s.supports === 'columns' ? `on ${o ? o + ' ' : ''}columns` : 'on piers');
      break;
    }
    case 'window': case 'door': {
      f.title = join(st, el, `${fmt(s.width)} × ${m(s.height)}`);
      // as built (surround.js effective(), the builder's own rules, also before a build: the parser's line): the head,
      // the pediment the style gives it ("no pediment" only when the request said so: a Gothic or Modern window simply
      // has none), the keystone
      const b = { ...s, ...effective(s) };
      if (b.archType) f.items.push(`${ARCH[b.archType]} head`);
      if (b.pediment && b.pediment !== 'none') f.items.push(`${b.pediment} pediment`);
      else if (b.pediment === 'none' && (!s.given || s.given.includes('pediment'))) f.items.push('no pediment');
      if (b.keystone) f.items.push('keystone');
      break;
    }
    case 'roof': {
      f.title = join(st, s.roofType, 'roof');
      f.items.push(`${fmt(s.width)} × ${m(s.length)}`);
      if (s.pitch) f.items.push(`${Math.round(s.pitch)}°`);
      if (s.covering) f.items.push(s.covering === 'seam' ? 'standing seam' : s.covering);
      if (Number.isFinite(s.overhang)) f.items.push(s.overhang > 0 ? `${m(s.overhang)} overhang` : 'no overhang');
      if (s.dormers) f.items.push('dormers'); else if (s.dormers === false) f.items.push('no dormers');
      break;
    }
    case 'dome': case 'cupola': {
      f.title = join(st, DOME[s.domeType], el);
      f.main = { field: 'diameter', v: s.diameter };
      if (s.ribs) { f.items.push(`${s.ribs} ribs`); f.counts.push(['ribs', s.ribs]); }
      if (s.drum) f.items.push('drum');
      if (s.lantern) f.items.push('lantern');
      if (s.oculus) f.items.push('oculus');
      if (s.covering) f.items.push(s.covering === 'seam' ? 'standing seam' : s.covering);
      break;
    }
    case 'spire': {
      f.title = join(st, s.spireType, 'spire');
      f.main = { field: 'height', v: s.height };
      if (s.finial && s.finial !== 'none') f.items.push(`${s.finial} finial`); else if (s.finial === 'none') f.items.push('no finial');
      break;
    }
    case 'finial': {
      f.title = join(st, s.finial && s.finial !== 'none' ? s.finial : null, 'finial');
      f.main = { field: 'height', v: s.height };
      break;
    }
    case 'urn': case 'obelisk': {
      f.title = join(st, el);
      f.main = { field: 'height', v: s.height };
      break;
    }
    case 'console': {
      f.title = join(st, 'console');
      f.main = { field: 'height', v: s.height };
      if (s.depth) f.items.push(`${m(s.depth)} deep`);
      if (s.enrichment && s.enrichment !== 'none') f.items.push(s.enrichment);
      break;
    }
    default: f.title = el;
  }
  f.title = f.title.trim();
  f.mat = mat;
  return f;
}

/** One line of a normalised spec: "Ionic column · 3.60 m · 24 flutes · Attic base · marble". */
export function describe(spec) {
  const f = facts(spec);
  const parts = [cap(f.title)];
  if (f.main && Number.isFinite(f.main.v)) parts.push(f.main.field === 'span' ? `span ${m(f.main.v)}` : f.main.field === 'diameter' ? `Ø ${m(f.main.v)}` : f.main.field === 'length' ? `${m(f.main.v)} long` : f.main.field === 'width' ? `${m(f.main.v)} wide` : m(f.main.v));
  parts.push(...f.items);
  if (f.mat) parts.push(f.mat);
  return parts.filter(Boolean).join(' · ');
}

// ================================================================================================= captions
const EL = {
  de: { column: 'Säule', pilaster: 'Pilaster', capital: 'Kapitell', base: 'Säulenbasis', pedestal: 'Postament', entablature: 'Gebälk',
    cornice: 'Kranzgesims', moulding: 'Profilleiste', pediment: 'Giebel', portico: 'Portikus', balustrade: 'Balustrade', baluster: 'Baluster',
    arch: 'Bogen', arcade: 'Arkade', window: 'Fenster', door: 'Tür', roof: 'Dach', dome: 'Kuppel', cupola: 'Dachreiter', spire: 'Turmhelm',
    finial: 'Bekrönung', urn: 'Urne', obelisk: 'Obelisk', console: 'Konsole' },
  fr: { column: 'colonne', pilaster: 'pilastre', capital: 'chapiteau', base: 'base', pedestal: 'piédestal', entablature: 'entablement',
    cornice: 'corniche', moulding: 'moulure', pediment: 'fronton', portico: 'portique', balustrade: 'balustrade', baluster: 'balustre',
    arch: 'arc', arcade: 'arcade', window: 'fenêtre', door: 'porte', roof: 'toit', dome: 'dôme', cupola: 'lanternon', spire: 'flèche',
    finial: 'épi de faîtage', urn: 'urne', obelisk: 'obélisque', console: 'console' },
  it: { column: 'colonna', pilaster: 'lesena', capital: 'capitello', base: 'base', pedestal: 'piedistallo', entablature: 'trabeazione',
    cornice: 'cornicione', moulding: 'modanatura', pediment: 'frontone', portico: 'pronao', balustrade: 'balaustrata', baluster: 'balaustro',
    arch: 'arco', arcade: 'arcata', window: 'finestra', door: 'porta', roof: 'tetto', dome: 'cupola', cupola: 'cupolino', spire: 'guglia',
    finial: 'puntale', urn: 'urna', obelisk: 'obelisco', console: 'mensola' },
};
const ORD = {
  de: { tuscan: 'toskanische Ordnung', doric: 'dorische Ordnung', 'greek-doric': 'griechisch-dorische Ordnung', ionic: 'ionische Ordnung',
    corinthian: 'korinthische Ordnung', composite: 'Kompositordnung', romanesque: 'romanisch', gothic: 'gotisch', egyptian: 'ägyptisch',
    solomonic: 'salomonisch gedreht', 'art-deco': 'Art déco', modern: 'modern' },
  fr: { tuscan: "d'ordre toscan", doric: "d'ordre dorique", 'greek-doric': "d'ordre dorique grec", ionic: "d'ordre ionique",
    corinthian: "d'ordre corinthien", composite: "d'ordre composite", romanesque: 'de style roman', gothic: 'de style gothique',
    egyptian: 'de style égyptien', solomonic: 'torse (salomonique)', 'art-deco': 'de style Art déco', modern: 'de style moderne' },
  it: { tuscan: 'di ordine tuscanico', doric: 'di ordine dorico', 'greek-doric': 'di ordine dorico greco', ionic: 'di ordine ionico',
    corinthian: 'di ordine corinzio', composite: 'di ordine composito', romanesque: 'in stile romanico', gothic: 'in stile gotico',
    egyptian: 'in stile egizio', solomonic: 'tortile (salomonica)', 'art-deco': 'in stile Art déco', modern: 'in stile moderno' },
};
const MAT = {
  de: { marble: 'Marmor', limestone: 'Kalkstein', sandstone: 'Sandstein', granite: 'Granit', travertine: 'Travertin', plaster: 'Stuck',
    concrete: 'Beton', terracotta: 'Terrakotta', brick: 'Backstein', slate: 'Schiefer', copper: 'Kupfer', lead: 'Blei', zinc: 'Zink',
    bronze: 'Bronze', gold: 'Gold', wood: 'Holz' },
  fr: { marble: 'marbre', limestone: 'calcaire', sandstone: 'grès', granite: 'granit', travertine: 'travertin', plaster: 'plâtre',
    concrete: 'béton', terracotta: 'terre cuite', brick: 'brique', slate: 'ardoise', copper: 'cuivre', lead: 'plomb', zinc: 'zinc',
    bronze: 'bronze', gold: 'or', wood: 'bois' },
  it: { marble: 'marmo', limestone: 'calcare', sandstone: 'arenaria', granite: 'granito', travertine: 'travertino', plaster: 'stucco',
    concrete: 'calcestruzzo', terracotta: 'terracotta', brick: 'mattoni', slate: 'ardesia', copper: 'rame', lead: 'piombo', zinc: 'zinco',
    bronze: 'bronzo', gold: 'oro', wood: 'legno' },
};
const DIMW = {
  de: { height: 'hoch', length: 'lang', width: 'breit', diameter: 'Durchmesser', span: 'Spannweite' },
  fr: { height: 'de haut', length: 'de long', width: 'de large', diameter: 'de diamètre', span: 'de portée' },
  it: { height: 'altezza', length: 'lunghezza', width: 'larghezza', diameter: 'diametro', span: 'luce' },
};
const CNT = {
  de: { flutes: 'Kanneluren', columns: 'Säulen', balusters: 'Baluster', ribs: 'Rippen', bays: 'Bögen', steps: 'Stufen' },
  fr: { flutes: 'cannelures', columns: 'colonnes', balusters: 'balustres', ribs: 'nervures', bays: 'travées', steps: 'marches' },
  it: { flutes: 'scanalature', columns: 'colonne', balusters: 'balaustri', ribs: 'costoloni', bays: 'campate', steps: 'gradini' },
};

// type words for the foreign caption (only the facts that are in the spec)
const TYPE = {
  de: { domeType: { hemisphere: 'Halbkugel', segmental: 'Flachkuppel', onion: 'Zwiebelform', ribbed: 'mit Rippen' },
    archType: { semicircular: 'Rundbogen', segmental: 'Segmentbogen', pointed: 'Spitzbogen', horseshoe: 'Hufeisenbogen', basket: 'Korbbogen', tudor: 'Tudorbogen' },
    roofType: { gable: 'Satteldach', hip: 'Walmdach', mansard: 'Mansarddach', gambrel: 'Scheunendach', pyramid: 'Zeltdach', shed: 'Pultdach' },
    spireType: { octagonal: 'achteckig', square: 'quadratisch', broach: 'Broach-Helm' },
    pediment: { triangular: 'Dreiecksgiebel', segmental: 'Segmentgiebel', broken: 'gesprengter Giebel', none: 'ohne Giebel' } },
  fr: { domeType: { hemisphere: 'hémisphérique', segmental: 'surbaissé', onion: 'à bulbe', ribbed: 'à côtes' },
    archType: { semicircular: 'en plein cintre', segmental: 'segmentaire', pointed: 'brisé', horseshoe: 'outrepassé', basket: 'en anse de panier', tudor: 'Tudor' },
    roofType: { gable: 'à deux pans', hip: 'à quatre pans', mansard: 'mansardé', gambrel: 'à la hollandaise', pyramid: 'en pavillon', shed: 'en appentis' },
    spireType: { octagonal: 'octogonale', square: 'carrée', broach: 'à broches' },
    pediment: { triangular: 'fronton triangulaire', segmental: 'fronton cintré', broken: 'fronton brisé', none: 'sans fronton' } },
  it: { domeType: { hemisphere: 'emisferica', segmental: 'ribassata', onion: 'a cipolla', ribbed: 'costolonata' },
    archType: { semicircular: 'a tutto sesto', segmental: 'ribassato', pointed: 'a sesto acuto', horseshoe: 'a ferro di cavallo', basket: 'a manico di cesto', tudor: 'Tudor' },
    roofType: { gable: 'a capanna', hip: 'a padiglione', mansard: 'a mansarda', gambrel: 'olandese', pyramid: 'a piramide', shed: 'a una falda' },
    spireType: { octagonal: 'ottagonale', square: 'quadrata', broach: 'a broccia' },
    pediment: { triangular: 'frontone triangolare', segmental: 'frontone curvo', broken: 'frontone spezzato', none: 'senza frontone' } },
};
const TYPE_FIELD = { dome: 'domeType', cupola: 'domeType', arch: 'archType', arcade: 'archType', roof: 'roofType', spire: 'spireType', window: 'pediment', door: 'pediment', pediment: 'pediment', portico: 'pediment' };

function rng(seed) {
  let a = (seed >>> 0) + 0x9e3779b9;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const article = (w) => (/^[aeiou]/i.test(w) && !/^(uni|eu)/i.test(w) ? 'an' : 'a');
const num = (v, lang) => fmt(v).replace('.', lang === 'en' ? '.' : ',');

function foreign(spec, f, lang) {
  const el = EL[lang][f.el] || f.el;
  const parts = [cap(el)];
  const tf = TYPE_FIELD[f.el], t = { ...spec, ...effective(spec) }[tf];   // a window's pediment as built
  if (tf && t && TYPE[lang][tf][t]) parts.push(TYPE[lang][tf][t]);
  if (spec.order && ORD[lang][spec.order] && f.el !== 'base') parts.push(ORD[lang][spec.order]);
  if (f.mat) parts.push(lang === 'de' ? `aus ${MAT.de[f.mat]}` : lang === 'fr' ? `en ${MAT.fr[f.mat]}` : `in ${MAT.it[f.mat]}`);
  if (f.main && Number.isFinite(f.main.v) && DIMW[lang][f.main.field]) {
    const v = `${num(f.main.v, lang)} m`, w = DIMW[lang][f.main.field];
    parts.push(lang === 'de' ? (f.main.field === 'diameter' || f.main.field === 'span' ? `${w} ${v}` : `${v} ${w}`) : lang === 'fr' ? `${v} ${w}` : `${w} ${v}`);
  }
  for (const [k, n] of f.counts) if (CNT[lang][k]) parts.push(`${n} ${CNT[lang][k]}`);
  return parts.join(lang === 'de' ? ', ' : lang === 'fr' ? ', ' : ', ');
}

/** 4–6 varied captions with exact facts (EN, plus one of DE / FR / IT chosen by the seed). */
export function captions(spec, seed = 0) {
  const f = facts(spec);
  const r = rng(seed);
  const pick = (xs) => xs[Math.floor(r() * xs.length)];
  const mainTxt = f.main && Number.isFinite(f.main.v)
    ? ({ height: `${m(f.main.v)} tall`, length: `${m(f.main.v)} long`, width: `${m(f.main.v)} wide`, diameter: `${m(f.main.v)} in diameter`, span: `spanning ${m(f.main.v)}` })[f.main.field]
    : null;
  const title = f.title;
  const items = f.items.slice();
  const out = [];
  out.push(describe(spec));
  const lead = pick(['', '3D model of ', 'Procedural ', 'A render of ']);
  const mat = f.mat ? pick([`in ${f.mat}`, `made of ${f.mat}`]) : '';
  const s1 = lead ? `${lead}${lead.startsWith('3D') || lead.startsWith('A') ? article(title) + ' ' : ''}${title}` : `${cap(article(title))} ${title}`;
  // sizes and states read as they are ("0.95 m high", "on a pedestal", "no keystone"); features follow "with"
  const bare = items.filter((x) => /^(\d|Ø|span|on |no |unfluted|for a )/.test(x));
  const feats = items.filter((x) => !bare.includes(x));
  out.push(cap([s1, mat, mainTxt, ...bare, feats.length ? `with ${feats.join(', ')}` : null].filter(Boolean).join(', ')) + '.');
  out.push(cap([f.mat, title].filter(Boolean).join(' ')));
  const kv = [`element: ${f.el}`];
  if (spec.order) kv.push(`order: ${spec.order}`);
  if (spec.style) kv.push(`style: ${spec.style}`);
  if (f.main && Number.isFinite(f.main.v)) kv.push(`${f.main.field}: ${m(f.main.v)}`);
  for (const [k, n] of f.counts) kv.push(`${k}: ${n}`);
  if (f.mat) kv.push(`material: ${f.mat}`);
  out.push(kv.join('; '));
  if (items.length > 1 || r() < 0.5) out.push(cap([title, ...shuffle(items, r)].join(', ')) + (f.mat ? `; ${f.mat}` : ''));
  out.push(foreign(spec, f, pick(['de', 'fr', 'it'])));
  return [...new Set(out.map((s) => s.replace(/\s+/g, ' ').trim()))].slice(0, 6);
}
function shuffle(xs, r) { const a = xs.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
