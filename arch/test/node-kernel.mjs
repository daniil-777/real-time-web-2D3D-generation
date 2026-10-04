// Loads Manifold in Node from the LaCie tool folder (or $ARCHKIT) and injects it into the kernel.
import { pathToFileURL } from 'node:url';
import { setKernel } from '../js/kernel.js';

export const ARCHKIT = process.env.ARCHKIT || '/Volumes/LaCie/morph3d/archkit';

export async function initKernel() {
  const { default: Module } = await import(pathToFileURL(`${ARCHKIT}/node_modules/manifold-3d/manifold.js`).href);
  const wasm = await Module();
  wasm.setup();
  setKernel(wasm);
  return wasm;
}
