// A named period's balustrade: the baluster and urns a request gets when it names the style but not those fields.
// Pure (no kernel, no geometry), the one source of truth for the builder (balustrade.js) and every read-back:
// effective() is what generate() merges into the spec it returns and what describe() reads, so the parser's line
// before a build and every line after it tell the balustrade that is built (as surround.js does for windows and doors).
//
// Renaissance double-vase (Bramante, Sansovino), Baroque pear-shaped bottle balusters under urns, Art Deco square,
// Modern bars; stated fields win.
export const STYLE_BALUSTRADE = { renaissance: { baluster: 'double-vase' }, baroque: { baluster: 'bottle', urns: true },
  'art-deco': { baluster: 'square' }, modern: { baluster: 'bar' } };
const stated = (spec, f) => (spec.given ? spec.given.includes(f) : spec[f] !== undefined && spec[f] !== null);

/** The fields the style decides for a balustrade or baluster spec: baluster kind and urns, unless stated. Urns are
 *  decided once: a spec that already carries them (generate()'s, where a short run without pedestals has none) keeps
 *  them, so applying this again to a built spec gives it back. */
export function effective(spec) {
  const out = {}, st = Object.hasOwn(STYLE_BALUSTRADE, spec.style) ? STYLE_BALUSTRADE[spec.style] : {};
  for (const [k, v] of Object.entries(st)) {
    if (stated(spec, k) || (k === 'urns' && (spec.element === 'baluster' || spec.urns !== undefined))) continue;
    out[k] = v;
  }
  return out;
}
