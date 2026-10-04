// Connectivity check: union every part (instances expanded) and report the separate solids.
//   import { solids } from './solid.mjs'; solids(parts) -> [{ volume, bbox }] largest first
import { K } from '../js/kernel.js';
export function solids(parts) {
  const { Manifold } = K();
  const all = [];
  for (const p of parts) {
    const n = p.transforms ? p.transforms.length / 16 : 1;
    for (let i = 0; i < n; i++) all.push(p.transforms ? p.manifold.transform(Array.from(p.transforms.subarray(16 * i, 16 * i + 16))) : p.manifold);
  }
  const u = Manifold.union(all);
  // separate solids only: negative components are internal voids, sub-mm³ ones are boolean noise
  return u.decompose().map((m) => ({ volume: m.volume(), bbox: m.boundingBox() })).filter((c) => c.volume > 1e-9).sort((a, b) => b.volume - a.volume);
}
