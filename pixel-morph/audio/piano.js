// Orchestrates the classical-piano layer: loads the trained transformer (piano-model.js), drives a
// synthesized piano voice (piano-synth.js) from its generated token stream. Self-paced, like the
// earlier notegen.js loop: every generated token is applied instantly except TIME_SHIFT, which is the
// only token that advances real wall-clock time -- so the model's own output paces playback.

import { loadPianoModel, NOTE_OFF_BASE, TIME_SHIFT_BASE, TIME_BUCKET_MS, VELOCITY_BASE, N_VEL_BUCKETS, PITCH_LO } from './piano-model.js';
import { createPianoSynth } from './piano-synth.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function createPianoGenerator(ctx, { temperature = 0.95, topK = 24 } = {}) {
  const model = await loadPianoModel();
  const synth = createPianoSynth(ctx);
  const tokens = [];
  let currentVelBucket = N_VEL_BUCKETS >> 1, running = true;
  const errors = [];

  async function step() {
    if (ctx.state !== 'running') { await sleep(300); return; } // paused/muted: don't drift ahead of real time
    const context = (tokens.length ? tokens : [VELOCITY_BASE + currentVelBucket]).slice(-model.context);
    const token = await model.sampleNext(context, { temperature, topK });
    tokens.push(token);
    if (tokens.length > model.context * 2) tokens.splice(0, tokens.length - model.context);

    if (token < NOTE_OFF_BASE) {
      synth.noteOn(PITCH_LO + token, currentVelBucket);
    } else if (token < TIME_SHIFT_BASE) {
      synth.noteOff(PITCH_LO + (token - NOTE_OFF_BASE));
    } else if (token < VELOCITY_BASE) {
      await sleep((token - TIME_SHIFT_BASE + 1) * TIME_BUCKET_MS);
    } else {
      currentVelBucket = token - VELOCITY_BASE;
    }
  }

  async function loop() {
    while (running) {
      try {
        await step();
      } catch (e) {
        // A single failed step (e.g. a transient WebGPU upload hiccup) must not silently end
        // generation for the rest of the session -- log it and keep going, same as the visual
        // pipeline's own error log, not a fatal condition.
        errors.push(String(e));
        await sleep(300);
      }
    }
  }
  loop();
  return { errors, stop() { running = false; } };
}
