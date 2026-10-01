# Pixel Morph — real-time 2D & 3D generation in the browser

**Live:** https://daniil-777.github.io/real-time-web-2D3D-generation/

Two neural networks that run entirely on your device (TensorFlow.js with WebGPU or WebGL). No server, no upload.

- **Drawings** (`pixel-morph/`) — a small convolutional decoder turns a 48×48 grid of codes into a 384-pixel drawing and
  wanders endlessly between the codes of 88 real photographs (11 subjects), drawing every step in dots, lines or cartoon.
  Optional piano music from a small transformer.
- **3D Objects** (`morph3d/`) — a triplane variational autoencoder packs real 3D models into 3 × 32 × 32 × 8 numbers
  (3 × 64 × 64 × 8 for architecture HD); a decoder turns any code into a coloured signed-distance field, evaluated on a
  dense grid (WebGPU compute or WebGL shaders), cleaned up by a calibrated level pass and sphere-traced every frame. The
  **model** menu switches between four trained networks (below).

## Layout

| path | what |
|---|---|
| `index.html` | the site: switches between the two apps (one runs at a time) |
| `pixel-morph/` | the drawing app (also works on its own; `pixel-morph.html` is a single-file version) |
| `morph3d/` | the 3D app (also works on its own); `model/` objects (default), `model-arch/` architecture, `model-arch3/` architecture HD, `model-v1/` the original objects network — the **model** menu switches between them, or link straight in with `?model=` |

Everything is static: any static file host serves it as it is.

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
- Text: the text tower of [OpenCLIP](https://github.com/mlfoundations/open_clip) ViT-B/32 laion2b_s34b_b79k (MIT), exported
  to ONNX with 8-bit weights (`morph3d/clip-laion-b32/`), run by [transformers.js](https://github.com/huggingface/transformers.js)
  (Apache-2.0) and ONNX Runtime Web (MIT) from jsDelivr.
