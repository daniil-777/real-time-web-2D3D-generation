# Pixel Morph — real-time 2D & 3D generation in the browser

**Live:** https://daniil-777.github.io/real-time-web-2D3D-generation/

Two neural networks and a CAD kernel that run entirely on your device (TensorFlow.js with WebGPU or WebGL; Manifold
in WebAssembly with three.js). No server, no upload.

- **Drawings** (`pixel-morph/`) — a small convolutional decoder turns a 48×48 grid of codes into a 384-pixel drawing and
  wanders endlessly between the codes of 88 real photographs (11 subjects), drawing every step in dots, lines or cartoon.
  Optional piano music from a small transformer.
- **3D Objects** (`morph3d/`) — a triplane variational autoencoder packs real 3D models into 3 × 32 × 32 × 8 numbers
  (3 × 64 × 64 × 8 for architecture HD); a decoder turns any code into a coloured signed-distance field, evaluated on a
  dense grid (WebGPU compute or WebGL shaders), cleaned up by a calibrated level pass and sphere-traced every frame. The
  **model** menu switches between four trained networks (below).
- **Architecture** (`arch/`, Arch Studio) — text in English, German, French or Italian becomes a typed specification,
  and the Manifold CAD kernel builds the element exactly, to the rules of the classical orders and at real scale:
  columns, entablatures, porticoes, arches, balustrades, roofs, domes, spires, finials, windows, doors; parametric
  grips, free-form transforms, a 3D paint brush, GLB / OBJ / STL export and a dimensioned A3 drawing sheet.

## Layout

| path | what |
|---|---|
| `index.html` | the site: switches between the three apps (one runs at a time) |
| `pixel-morph/` | the drawing app (also works on its own; `pixel-morph.html` is a single-file version) |
| `morph3d/` | the 3D app (also works on its own); `model/` objects (default), `model-arch/` architecture, `model-arch3/` architecture HD, `model-v1/` the original objects network — the **model** menu switches between them, or link straight in with `?model=` |
| `arch/` | Arch Studio (also works on its own): `js/` the parser, spec, generators (`gen/`), kernel, viewer, grips, paint, deform, export and drawing; `test/` its unit tests and quality tools |
| `build.mjs`, `tools/`, `test/` | the build that writes the deployable site to `_site/`, a static server, the browser smoke test (below) |

Everything is static: any static file host serves the built tree (`_site/`, below) as it is.

## Build, test and deploy

The sources run as they are: serve the repository root (`node tools/serve.mjs . 8125`) and open `/arch/`, `/morph3d/` or
`/pixel-morph/`. Arch Studio's page then loads its modules one by one and takes three.js and the CAD kernel from the
jsDelivr CDN (pinned, with Subresource Integrity).

What visitors get is the built tree, `_site/`, written by `npm run build` (`build.mjs`) in about a second: Arch Studio's
thirty modules, three.js, N8AO and the Manifold kernel bundled by esbuild into a few minified, content-hashed files on
this one origin — no import map, no third-party host — with the viewer, the parser, each generator family and the
ambient occlusion still lazy chunks and the first screen's files preloaded from the page's head; the kernel's
WebAssembly gzipped (GitHub Pages compresses no `.wasm`) and inflated in the worker; the 3D objects app's thirteen
scripts in one file; each page's HTML rewritten to point at them (a rewrite that fails loudly when the markup it expects
has moved). `npm run serve` builds and serves it at http://127.0.0.1:8123/. `npm install` first (esbuild, three, n8ao,
manifold-3d, puppeteer-core — development only; nothing is installed on the site).

- `npm test` runs every `arch/test/*.test.mjs` (the generator families, the kernel, exports, grips, paint, the parser,
  read-backs…), each in its own process; about 10 minutes on a quiet machine. Manifold comes from the LaCie tool folder
  (`$ARCHKIT`) when it is mounted, else from `node_modules`. The build-time budgets (500 / 1500 ms) are set for the
  development machine: `ARCH_TIME_SCALE=3 npm test` relaxes them on a slower one (CI does).
- `npm run smoke` opens the built site in headless Chrome and checks what a visitor's browser sees: the site shell's
  three tabs become live, Arch Studio builds two prompts, the 3D objects and the drawings reach their first frame, and
  nothing errors in the console. `--url https://…/` checks a deployed site instead; screenshots go to `--out DIR`;
  `--only arch` is what CI runs (no GPU there: the neural apps cannot start at a useful speed on software rendering).

Deploy: push `main`. `.github/workflows/deploy.yml` builds, runs the smoke test and publishes `_site/` to GitHub Pages
(the Pages source is "GitHub Actions"); the unit tests run alongside and mark the commit without holding the deploy.
`version.json` on the live site names the commit it was built from.

## Flags (3D)

| URL | effect |
|---|---|
| `?model=model-arch` | loads a folder of this site as the decoder — `model` (default), `model-arch` (architecture), `model-arch3` (architecture HD), `model-v1` (the original objects network), or any future model dropped in beside them (the **model** menu sets this) |
| `?spin` or `?spin=1` | the object always rotates — also while paused and with the system's "reduce motion" on (the **spin** button and the `r` key toggle it) |
| `?spin=2` | rotates twice as fast (any rate from 0 to 8) |
| `?spin=0` | never rotates |
| `?hd=1` | HD: a resting object is decoded on a 256³ grid instead of 160³, with curvature shading that brings out creases and grooves (the **HD** button and the `h` key toggle it). A narrow band runs the network only near the surface — exact, and as fast as the old 160³ |
| `?detail=0` … `3` | the curvature shading on its own: 0 off, 1 as in HD, up to 3 stronger |
| `?neural=1` / `?neural=0` | per-pixel detail on / off: a resting object's surface, normal and colour come from the network itself at every pixel, not from the grid (on with HD, and for models with 256² planes) |

**Describe an object:** the 3D view's *find* box also takes a description ("a red sports car", "something that flies"):
a CLIP text encoder running in the browser (OpenCLIP ViT-B/32, 66 MB, loaded on first use) picks the object whose decoded
shape matches it best.

**Create an object:** a model that ships a *text prior* (`"prior"` in its `meta.json`) also shows a **✦ create** button
(or Shift+Enter in the find box): a small generator of latents — a rectified-flow U-Net over the three latent planes,
conditioned on the same CLIP text embedding (`morph3d/m3d-prior.js`, ~20 MB int8, ~0.4 s on WebGPU) — samples a *new*
object for the description, and the walk morphs to it and carries on through similar objects. Every press is a new
variation. The prior only works with the decoder it was trained for (its `model_sha16` must match the model's
checkpoint fingerprint).

**Architecture HD** (`model-arch3/`, the **architecture HD** menu entry): 782 buildings in 12 classes on 64² latents and
512² planes, with a detail stage on the colour planes too — IoU 0.91 against 0.83 for `model-arch` (1.14 M weights). Its
anchors stream in two chunks at a time after the first frame. The decoder was trained on distances clamped to 0.05 on
both sides, so beyond that band its field only says "outside" (and reaches hundreds): `meta.json` declares
`"trunc": 0.05`, and the page then reads the field truncated at 0.1, keeps every tracing step within 0.045, and clamps the
HD band's coarse pass. Exports without `trunc` render exactly as before. Descriptions work in the find box (`clip.bin`
from `research/text3d/clip_table_arch3.py`); it has no text prior yet, so no create button.

The site passes its URL on to the app, so https://daniil-777.github.io/real-time-web-2D3D-generation/?hd=1&spin=1#objects works.
The frame rate is always shown in the top-right corner of the 3D view.

## Credits and licences

- 3D shapes: [Objaverse](https://objaverse.allenai.org) models under CC-BY / CC0, re-encoded by the network — authors and
  licences of every object in `morph3d/model/sources.json` (also `morph3d/model-arch/sources.json`,
  `morph3d/model-arch3/sources.json` and `morph3d/model-v1/sources.json`).
- Drawings: distilled from [Wikimedia Commons](https://commons.wikimedia.org/wiki/Category:Featured_pictures) featured and
  quality pictures (CC licences) — sources in `pixel-morph/model*/sources.json`.
- Music: the piano transformer in `pixel-morph/audio/` was trained on the [MAESTRO](https://magenta.tensorflow.org/datasets/maestro)
  dataset (CC BY-NC-SA 4.0); its weights are shared under the same licence, for non-commercial use.
- [TensorFlow.js](https://github.com/tensorflow/tfjs) (Apache-2.0), loaded from the jsDelivr CDN.
- Architecture: the [Manifold](https://github.com/elalish/manifold) CAD kernel (Apache-2.0), [three.js](https://threejs.org)
  (MIT) and [N8AO](https://github.com/N8python/n8ao) (MIT), bundled into the site by `build.mjs` (their licence
  notices in `arch/dist/*.LEGAL.txt`); the orders after Vignola.
- Text: the text tower of [OpenCLIP](https://github.com/mlfoundations/open_clip) ViT-B/32 laion2b_s34b_b79k (MIT), exported
  to ONNX with 8-bit weights (`morph3d/clip-laion-b32/`), run by [transformers.js](https://github.com/huggingface/transformers.js)
  (Apache-2.0) and ONNX Runtime Web (MIT) from jsDelivr.
