// Bootstraps the audio layer: creates the (suspended-until-clicked) AudioContext and wires the
// "sound" HUD button. The piano transformer (~5M params, ~10MB) is loaded lazily, only on the first
// click, not eagerly at page load -- verified this doesn't measurably affect the visual decoder once
// loaded and running (a one-time load hiccup aside), but there is still no reason to make every
// visitor pay a 10MB fetch + GPU upload for a feature they may never turn on.

import { createPianoGenerator } from './piano.js';

(function boot() {
  const AC = window.AudioContext || window.webkitAudioContext;
  const stats = (window.__pmAudio = { ready: false, playing: false, errors: [] });
  if (!AC) return;

  let ctx, piano, loading = false;
  try {
    ctx = new AC();
    ctx.suspend().catch(() => {});
  } catch (e) {
    stats.errors.push(String(e));
    return;
  }

  const btn = document.getElementById('sound');
  if (btn) {
    btn.textContent = 'sound: off';
    btn.addEventListener('click', async () => {
      if (ctx.state === 'running') {
        ctx.suspend().then(() => { btn.textContent = 'sound: off'; stats.playing = false; });
        return;
      }
      if (!piano && !loading) {
        loading = true;
        btn.textContent = 'sound: loading…';
        try {
          piano = await createPianoGenerator(ctx);
          stats.ready = true;
          stats.errors = piano.errors; // live reference: generation-loop errors surface here too
        } catch (e) {
          stats.errors.push(String(e));
          btn.textContent = 'sound: unavailable';
          return;
        } finally {
          loading = false;
        }
      }
      ctx.resume().then(() => { btn.textContent = 'sound: on'; stats.playing = true; });
    });
  }
})();
