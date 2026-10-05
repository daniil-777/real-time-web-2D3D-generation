// Window and door surrounds: the head, treatment, pediment and keystone a request gets. Pure (no kernel, no geometry),
// the one source of truth for the builder (entablature.js surroundKind adds the order and the cornice kind) and for
// every read-back: effective() is what generate() merges into the spec it returns, and what describe() reads, so the
// parser's line before a build and every line after it tell the model that is built.
//
// Style -> head and treatment (controller ruling 22). archType, when given, sets the head's curve; the style sets the
// treatment. Gothic: pointed head, chamfered reveals, hood mould with label stops. Romanesque / Byzantine: round head,
// plain archivolt in two orders with a roll, impost blocks. Renaissance: round head, the architrave turned as an
// archivolt. Moorish: horseshoe head, plain archivolt framed by an alfiz. Art Nouveau: basket head, soft frame.
// Baroque: flat head with ears and keystone, pulvinated frieze, broken pediment (a broken segmental one over a door)
// with an urn. Egyptian / Art Deco / Modern: flat head, plain frame, gorge / stepped / slab cornice, no pediment.
export const STYLE_SURROUND = {
  gothic: { arch: 'pointed', tr: 'gothic' }, romanesque: { arch: 'semicircular', tr: 'romanesque' },
  byzantine: { arch: 'semicircular', tr: 'romanesque' }, renaissance: { arch: 'semicircular', tr: 'classical' },
  moorish: { arch: 'horseshoe', tr: 'moorish' }, 'art-nouveau': { arch: 'basket', tr: 'nouveau' },
  baroque: { arch: null, tr: 'baroque' }, egyptian: { arch: null, tr: 'egyptian' }, 'art-deco': { arch: null, tr: 'deco' },
  modern: { arch: null, tr: 'modern' },
};
const ARCH_TREATMENT = { pointed: 'gothic', tudor: 'gothic', horseshoe: 'moorish' };   // an arch without a style
const stated = (spec, f) => (spec.given ? spec.given.includes(f) : spec[f] !== undefined && spec[f] !== null);

/** Head, treatment, pediment, keystone, ears... of a window or door spec. "Asked for" = stated in the request
 *  (spec.given): an arched or Egyptian / Deco / Modern head takes a pediment only when one was asked for. */
export function surroundHead(spec) {
  const door = spec.element === 'door', st = Object.hasOwn(STYLE_SURROUND, spec.style) ? STYLE_SURROUND[spec.style] : null;
  const arch = spec.archType || (st && st.arch) || null;
  let tr = st ? st.tr : arch ? ARCH_TREATMENT[arch] || 'classical' : 'classical';
  if (arch && ['baroque', 'egyptian', 'deco', 'modern'].includes(tr)) tr = tr === 'baroque' ? 'classical' : 'plain';
  const asked = stated(spec, 'pediment') && !!spec.pediment;
  let ped;
  if (arch || ['egyptian', 'deco', 'modern'].includes(tr)) ped = asked ? spec.pediment : 'none';
  // a Baroque door's broken pediment is segmental, asked for or not (so its exported spec, 'broken', rebuilds it)
  else if (tr === 'baroque') ped = door && (!asked || spec.pediment === 'broken') ? 'broken-segmental' : asked ? spec.pediment : 'broken';
  else ped = spec.pediment ?? (door ? 'segmental' : 'triangular');   // classical: the spec's value (spec.js default)
  const flatOrder = { egyptian: 'egyptian', deco: 'art-deco', modern: 'modern' }[tr];
  const classicalBottom = tr === 'classical' || tr === 'baroque';
  const round = arch && arch !== 'pointed' && arch !== 'tudor';
  return { door, arch, tr, ped, flatOrder, ears: !arch && classicalBottom, fasciae: classicalBottom,
    keystone: tr === 'baroque' && !stated(spec, 'keystone') ? true : !!spec.keystone && (!arch || round) && tr !== 'gothic',
    frieze: spec.frieze === 'pulvinated' || (tr === 'baroque' && !stated(spec, 'frieze')) ? 'pulvinated' : 'plain',
    consoles: !door && classicalBottom, plinths: door && classicalBottom };
}

/** The fields a window or door is built with where the style decides them: the pediment ('none' over an arched or
 *  Egyptian / Deco / Modern head unless one was asked for, 'broken' for a Baroque one, the door's broken segmental
 *  included), the head's arch type (from the style when not stated) and the keystone. Other elements: null. Applied to
 *  a spec that already carries them (spec.given unchanged) it gives them back. */
export function effective(spec) {
  if (!spec || (spec.element !== 'window' && spec.element !== 'door')) return null;
  const k = surroundHead(spec), out = { pediment: k.ped === 'broken-segmental' ? 'broken' : k.ped, keystone: k.keystone };
  if (k.arch) out.archType = k.arch;
  return out;
}
