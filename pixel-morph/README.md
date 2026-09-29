# Pixel Morph

An endless, gently morphing stream of distinct objects (mountains, airliners, cars, spacecraft, lighthouses, windmills,
churches, towers, houses, the Earth and the Moon) drawn as fine dots along their contours, in the object's own colours
or in black, or as a flat‑coloured cartoon, generated live in the browser by a small neural network. Every object is
shown whole, floating on the page. Everything runs client‑side with TensorFlow.js; the first frame needs about 0.74 MB,
and more objects stream in while the page runs.

## Files

| file | purpose |
|---|---|
| `index.html` | the page: TensorFlow.js core plus the one backend this browser uses (WebGPU, else WebGL) from jsDelivr (SRI‑pinned), everything else inline (29 KB gzipped) |
| `pixel-morph.html` | same page with the decoder and the first 11 objects inlined (1.0 MB); works from a double‑click (`file://`) |
| `model/meta.json` | class names, grid/code sizes, decoder layer table, anchor chunk list, credit line (2 KB) |
| `model/decoder.bin.gz` | the conv decoder (252 k weights): int8 with per‑channel scales except the 4 layers whose precision matters most (fp16), plus the PCA basis of the codes (28 of 32 dims per cell; 298 KB) |
| `model/anchors-0.bin.gz` | the first objects, one each of mountain, airliner, car, spacecraft, lighthouse and Earth (240 KB) |
| `model/anchors-1.bin.gz` … | one object for every other class, then more views of every class (88 objects in all; 0.2–1.1 MB per chunk); fetched one chunk at a time while someone is watching |
| `model/sources.json` | the Wikimedia Commons photo behind every object (title, author, licence, link, and which anchor indices came from it); not loaded by the page |
| `model-hq/` | optional high‑quality model: residual decoder (708 k weights, 40 % lower reconstruction error, about half the keyframe rate, first frame ~1.2 MB): open `index.html?model=model-hq` |
| `samples/` | the three best settled drawings (colour dots, plus black‑dot twins), ranked by dot coverage and by how recognisable CLIP finds the rendered drawing; `samples.json` credits the exact source photo of each |

Serve the folder over HTTP (`python3 -m http.server`) and open `index.html`, or just open `pixel-morph.html`.
Query options: `?mode=dots|cartoon|lines|stipple&walk=drift|dream|tour|random&res=128..384&ink=1..10&tone=0..1&color=0|1&mix=0..1&trans=sweep|blend&scene=car,spacecraft&dots=line|band&speed=0.2..4&model=model-hq&backend=auto|webgpu|webgl|cpu&debug=1&f16=0|1&texpool=MB&gldots=1&hold=1&seed=N`.
Press **d** on the page to toggle the debug overlay.

Payload for a visitor until the first frame: about 0.74 MB (TensorFlow.js core 83 KB gzipped plus one backend, WebGPU
88 KB or WebGL 72 KB, preloaded in parallel; page 29 KB, decoder 298 KB, first six objects 240 KB); the other objects
arrive in four chunks, one every 15 s while the tab is visible. The page starts at the model's native 384 px and steps
down one level at a time (320, 256, 192, 128) on slow GPUs.

## How it works

* **Data**: a dataset of well‑distinct objects from 8,041 high‑resolution Wikimedia Commons featured and quality pictures
  and targeted searches (mountains, Airbus and Boeing airliners, 25 car makes and types from classic to Formula One,
  spacecraft and launchers from Saturn V to Crew Dragon, lighthouses, windmills, churches, towers, houses, Earth from
  space, the Moon; no busy landscapes). Objects are used **whole**: the photo is letterboxed to a square (edges are
  detected on a mirror‑padded square and the padding is masked, colour margins fade from the photo's border colour to
  paper white), so no car, airliner or tower is ever cut off; mountains, Earth and Moon use square crops. That gives
  9,072 crops; CLIP keeps the 5,101 whose photo shows the object clearly and whose drawing reads at a glance (at most
  1,400 per class). Each crop gives a contour drawing at 384×384 (bilateral texture smoothing → PiDiNet edge network at
  full 768‑px resolution → Steger ridge detector → contours longer than 20 px, so window frames, wheel rims, lattice
  sails and panel lines survive) and its colours at 192×192.
* **Model**: a conv encoder maps a crop to a 48×48 grid of local 32‑dim codes (each 8‑px cell describes its own bit of
  contour); the conv decoder has two 3×3 convs at 48, 96 and 192 px and one at 384 px (96,96 | 64,64 | 48,32 | 24
  channels, nearest‑neighbour ×2 upsampling between stages) and turns the grid into a 384×384 field: distance to the
  nearest contour (capped at 3 px) and the colour; about 3.8 GMAC per frame. It is fine‑tuned quantisation‑aware
  (int8 fake‑quantised weights with straight‑through gradients), and the exporter keeps in fp16 only the layers whose
  int8 version measurably changes the drawn contours (greedy, until the quantised decoder matches the float one at
  contour IoU ≥ 0.95). The optional `model-hq` decoder adds a residual block at 48, 96 and 192 px (8.8 GMAC).
* **Backend**: WebGPU where the browser has it (exact float32, 2–4× the keyframe rate of WebGL), else WebGL 2 with half‑float textures and the texture reuse pool capped at 64 MB (`?texpool=`;
  uncapped it grows to ~300 MB for no speed gain), else the CPU. Only the chosen backend is downloaded.
* **Per frame**: the GPU decodes keyframes back to back (two in flight, fused conv ops on tfjs-core, no tfjs-layers); only the distance field comes back at full resolution, the colour is averaged to half
  resolution on the GPU first. Every animation frame draws an interpolation between the two keyframes around
  (now − latency), so the drawing moves at display rate even when the GPU delivers only 10–25 keyframes a second.
  **Dots** (default) runs the Steger valley detector on the distance channel and walks the detected contours, dropping an
  anti‑aliased dot wherever no dot sits within the spacing radius, so evenly spaced dots follow every curve (`?dots=band`
  gives a hexagonal‑lattice variant). Contours are linked with hysteresis and dots sit at the sub‑pixel valley position.
  The **tone** slider adds a pen‑and‑ink stipple on top (blue‑noise, density following the scene's darkness after
  per‑frame auto‑levels). With **colour** on, each dot takes the scene's colour at that point. **Lines** draws the
  detected contours as 1‑px lines; **stipple** dithers the distance channel. Dots sit 2 px apart at the native
  resolution, 192 across the drawing. **Cartoon** turns the same decoded frame into flat colour areas with ink
  outlines, with no change to the model: the detected contours (and everything within a third of a pixel of one) act as
  walls, the rest of the image floods into connected regions (union‑find), and each region is painted with its mean
  colour, saturated a little and posterised into three cel shades by its tone (four greys with colour off); large areas
  such as sky or a fuselage keep a soft blurred gradient instead of one flat colour. The outlines are the contours thinned
  to one pixel, stripped of spurs and specks, and inked as round strokes whose width follows the ink slider (about 20 ms
  per frame at 384 px, 40 fps). The CPU side is tuned for large retina canvases (branch‑free separable blur,
  detector skipping empty regions, precomputed anti‑aliased dot masks): about 15 ms per frame on a 1536‑px canvas and
  12 ms at 768 px on an M3 Pro, 53–60 fps with 24–30 keyframes a second at 384 px. `?gldots=1` draws the dots as WebGL2
  point sprites instead (less CPU, but it competes with the decoder for the GPU, so it is off by default).
* **Which objects ship**: every crop is scored with CLIP (ViT‑B/32, LAION‑2B) twice, as the photo and as the contour
  drawing the page shows, against one prompt per class plus distractor prompts (signs with text, textures, scribbles,
  interiors, crowds, blank pages). The anchors are the crops whose photo is confirmed as its class and whose contour
  drawing is most recognisable, one per source photo, spread out in CLIP space so a class never repeats one view (eight
  per class, fewer when a class has only a few clear views). A title list keeps sensitive photos out (crashes, disasters,
  memorials, politicians).
* **Endless walk**: a Catmull‑Rom spline through anchor codes of real objects, smootherstep easing so it lingers on
  each object, and a light "breathing" drift. How the next object is sampled is the **walk** style (menu or `?walk=`):
  * `drift` (default): one of the four nearest objects in code space not shown yet; three times in four it stays in the
    class, otherwise it moves to one of the two classes CLIP finds most alike (`class_sim` in `meta.json`: airliner →
    spacecraft or car, Earth → Moon or spacecraft, lighthouse → windmill or tower, church → tower or house), so an
    airliner turns into another airliner, then a spacecraft, never straight into the Earth.
  * `dream`: never leaves the class; every stop is a new composite of two nearby objects of that class, a slow drift
    through variations that never existed.
  * `tour`: the nearest object of a class not seen recently, so every class comes round in turn.
  * `random`: any object of any class.
  Transitions **sweep**: a soft, slightly wavy boundary at a random angle crosses the image and each grid cell switches
  from one object's code to the next as it passes (norm‑preserving inside the band), so every region is one real drawing
  at any moment (`?trans=blend` shows the old all‑at‑once dissolve, which decodes into faded, fragmented contours).
  In the other walks 20 % of the destinations (`mix`) are composites that never existed: two objects of the same class blended across a
  soft random ramp, one of them shifted; classes are never mixed into chimeras.

* **Debug** (`?debug=1` or the **d** key): an overlay with the backend, GPU memory as TensorFlow.js reports it (live
  tensors, allocated GPU buffers/textures including the reuse pool), decoder weight bytes, canvas pixel buffer, JS heap,
  decode and render timings with a per‑stage split, and the walk state.

## Measurements

`work/eval_realism.py` decodes the endpoints and midpoints of 120 same‑class and 120 cross‑class pairs of training
objects and scores the contour drawings with CLIP (line‑drawing prompts); speeds and GPU memory are headless Chromium
on an M3 Pro at 384 px.

| model | reconstruction error | objects | mid‑sweep, same / cross class | mid‑blend, same / cross class | keyframes/s WebGPU / WebGL | GPU memory WebGPU / WebGL |
|---|---|---|---|---|---|---|
| default (`model/`) | 0.0060 | 0.74 | 0.71 / 0.56 | 0.44 / 0.27 | 40–55 / 18–24 | 75 / 60 MB |
| `model-hq/` | 0.0035 | 0.74 | 0.69 / 0.58 | 0.44 / 0.27 | 35–44 / 10–12 | 147 / 62 MB |

## Retraining

Training code and data live on the LaCie drive: `/Volumes/LaCie/pixel-morph/work`. Use the pyenv python that has torch
(`~/.pyenv/versions/3.11.9/bin/python3`). The dataset build runs photo decoding and smoothing in parallel workers and the
edge network in fp16 (8,041 photos in 30 min); training keeps the whole dataset on the GPU as uint8 and assembles batches
there (about 0.2 s per step for the default decoder, 45 s per epoch):

```
PM_CONTACT=<your email> python3 fetch_commons.py --out ../data/hires --max 14000 --per-cat 900 --per-search 80 --width 1920 \
        --labels car,spacecraft,lighthouse,windmill,church,house,tower       # photos + manifest.json (licences); 1920 = a cached Commons thumbnail size
python3 build_hires_dataset.py --src ../data/hires --out ../data/objects384_v2.npz --out-rgb ../data/objects_rgb192_v2.npz \
        --labels mountain,airliner,lighthouse,windmill,house,church,tower,earth,moon,spacecraft,car --merge rocket:spacecraft \
        --fit-labels car,airliner,spacecraft,lighthouse,windmill,church,house,tower \
        --size 384 --edge 768 --detect 768 --low 0.015 --high 0.05 --min-size 20 --rgb 96 --rgb-hi 192 --no-tone --half
python3 fade_margins.py --data ../data/objects384_v2.npz --rgb ../data/objects_rgb192_v2.npz --out ../data/objects_rgb192_v2f.npz
python3 score_clip.py --data ../data/objects384_v2.npz --src ../data/hires --out ../data/clip_objects_v2.npz
python3 train_conv.py --data ../data/objects384_v2.npz --rgb --rgb-file ../data/objects_rgb192_v2f.npz --out ../runs/my_run \
        --epochs 40 --batch 24 --lr 5e-4 --warmup 200 --beta 0.003 --fixed-noise 0.2 --code 32 --stages '96,96|64,64|48,32|24' \
        --enc-ch 48 --mix 192 --dmax 3 --crop 256 --amp --amp-dtype float16 --flip --noun objects --export-every 0 \
        --scores ../data/clip_objects_v2.npz --min-own 0.5 --min-own-line 0.02 --cap-per-class 1400   # [--init <ckpt.pt>]
python3 train_conv.py <same data and model flags> --out ../runs/my_run_q --init ../runs/my_run/ckpt.pt --qat --epochs 5 --lr 1e-4 --warmup 50
SCORES=../data/clip_objects_v2.npz HEROES=mountain,airliner,car,spacecraft,lighthouse,earth \
SCENES=mountain,airliner,car,spacecraft,lighthouse,windmill,church,earth EXPORT_EXTRA="--per-class 8 --mix 0.2 --mix-same-class --pca 28" \
        zsh finalize_lean.sh ../runs/my_run_q --install <portfolio>/pixel-morph   # export, browser checks, standalone, samples; installs only if all pass
```

The high‑quality model uses `--stages '128,r|96,r|48,r|24,24'` and `--pca 32`. The page is built from
`index_next.tpl.html` (the blue‑noise mask in `bluenoise64.b64` is inlined by `finalize_lean.sh`). Earlier models (the
scenes model with cities and castles, the first objects models) are backed up under `/Volumes/LaCie/pixel-morph/backups/`.

Credits: photos from Wikimedia Commons featured and quality pictures (CC BY / CC BY‑SA / CC0, per‑photo credits in
`model/sources.json`); edge maps by PiDiNet (Z. Su et al.).
