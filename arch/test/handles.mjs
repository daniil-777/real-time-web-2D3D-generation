// Kernel handle accounting for the tests: wraps the public static constructors and methods of Manifold and CrossSection
// (along their prototype chains) so every kernel object a piece of code makes is recorded, with the call that made it.
//   const t = trackHandles(wasm); ...code...; t.stop(); t.made → Set of handles; t.calls → [{ k, self, args, r }]
export function trackHandles(wasm) {
  const made = new Set(), calls = [], undo = [];
  const isObj = (r) => !!r && typeof r.delete === 'function' && typeof r.isDeleted === 'function';
  const note = (r) => { if (isObj(r)) made.add(r); else if (Array.isArray(r)) r.forEach(note); return r; };
  const SKIP = new Set(['constructor', 'prototype', 'length', 'name', 'delete', 'isDeleted', 'deleteLater', 'isAliasOf']);
  for (const C of [wasm.Manifold, wasm.CrossSection]) {
    const objs = [C];
    for (let p = C.prototype; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) objs.push(p);
    for (const obj of objs) for (const k of Object.getOwnPropertyNames(obj)) {
      const d = Object.getOwnPropertyDescriptor(obj, k);
      if (SKIP.has(k) || k.startsWith('_') || !d || typeof d.value !== 'function' || !d.writable) continue;
      const f = d.value;
      obj[k] = function (...args) { const r = f.apply(this, args); if (isObj(r) || Array.isArray(r)) calls.push({ k, self: this, args, r }); return note(r); };
      undo.push([obj, k, f]);
    }
  }
  return { made, calls, stop() { for (const [o, k, f] of undo.reverse()) o[k] = f; undo.length = 0; } };
}
