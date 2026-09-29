# Pixel Morph — real-time 2D & 3D generation in the browser

**Live:** https://daniil-777.github.io/real-time-web-2D3D-generation/

Two neural networks that run entirely on your device (TensorFlow.js with WebGPU or WebGL). No server, no upload.

- **Drawings** (`pixel-morph/`) — a small convolutional decoder turns a 48×48 grid of codes into a 384-pixel drawing and
  wanders endlessly between the codes of 88 real photographs (11 subjects), drawing every step in dots, lines or cartoon.
  Optional piano music from a small transformer.
- **3D Objects** (`morph3d/`) — a triplane variational autoencoder packs each of 588 real 3D models (98 classes) into
  3 × 32 × 32 × 8 numbers; a 1.31 M-weight decoder turns any code into a coloured signed-distance field, evaluated on a
  dense grid (WebGPU compute or WebGL shaders), cleaned up by a calibrated level pass and sphere-traced every frame.

## Layout

| path | what |
|---|---|
| `index.html` | the site: switches between the two apps (one runs at a time) |
| `pixel-morph/` | the drawing app (also works on its own; `pixel-morph.html` is a single-file version) |
| `morph3d/` | the 3D app (also works on its own; `?model=model-v1` loads the previous model) |

Everything is static: any static file host serves it as it is.

## Flags (3D)

| URL | effect |
|---|---|
| `?spin` or `?spin=1` | the object always rotates — also while paused and with the system's "reduce motion" on (the **spin** button and the `r` key toggle it) |
| `?spin=2` | rotates twice as fast (any rate from 0 to 8) |
| `?spin=0` | never rotates |

The site passes its URL on to the app, so https://daniil-777.github.io/real-time-web-2D3D-generation/?spin=1#objects works.
The frame rate is always shown in the top-right corner of the 3D view.

## Credits and licences

- 3D shapes: [Objaverse](https://objaverse.allenai.org) models under CC-BY / CC0, re-encoded by the network — authors and
  licences of every object in `morph3d/model/sources.json` (and `morph3d/model-v1/sources.json`).
- Drawings: distilled from [Wikimedia Commons](https://commons.wikimedia.org/wiki/Category:Featured_pictures) featured and
  quality pictures (CC licences) — sources in `pixel-morph/model*/sources.json`.
- Music: the piano transformer in `pixel-morph/audio/` was trained on the [MAESTRO](https://magenta.tensorflow.org/datasets/maestro)
  dataset (CC BY-NC-SA 4.0); its weights are shared under the same licence, for non-commercial use.
- [TensorFlow.js](https://github.com/tensorflow/tfjs) (Apache-2.0), loaded from the jsDelivr CDN.
