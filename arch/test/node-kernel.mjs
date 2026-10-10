// Loads Manifold in Node and injects it into the kernel: from $ARCHKIT, else the LaCie tool folder (the dataset and
// report tools live there) when it is mounted, else this repo's own node_modules (npm install; what CI has).
// ARCHKIT=- stands for "no tool folder" (what CI sees), to rehearse that locally.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { setKernel } from '../js/kernel.js';

const LACIE = '/Volumes/LaCie/morph3d/archkit';
// build-time budgets (500 / 1500 ms on the development machine) scale by $ARCH_TIME_SCALE on slower machines (CI: 3)
export const TIME_SCALE = +process.env.ARCH_TIME_SCALE || 1;
export const ARCHKIT = process.env.ARCHKIT === '-' ? null : process.env.ARCHKIT || (fs.existsSync(`${LACIE}/node_modules/manifold-3d`) ? LACIE : null);
const MANIFOLD = ARCHKIT && fs.existsSync(`${ARCHKIT}/node_modules/manifold-3d/manifold.js`)
  ? pathToFileURL(`${ARCHKIT}/node_modules/manifold-3d/manifold.js`).href : import.meta.resolve('manifold-3d');

export async function initKernel() {
  const { default: Module } = await import(MANIFOLD);
  const wasm = await Module();
  wasm.setup();
  setKernel(wasm);
  return wasm;
}
