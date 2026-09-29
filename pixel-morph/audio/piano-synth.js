// A synthesized (not sampled) piano voice: two oscillators per note -- a triangle fundamental that
// carries the note's natural register-dependent decay, and a quiet sine one octave up that fades
// fast to give a brighter attack transient, roughly approximating how a real piano's upper partials
// decay faster than the fundamental. No sample assets, so this stays self-contained like the rest of
// the audio layer; real piano samples are a natural follow-up if this isn't convincing enough.

import { createReverb } from './reverb.js';

const PITCH_LO = 21;
const N_VEL_BUCKETS = 32;
const MAX_VOICES = 24; // safety cap: force-release the oldest note if the model never emits NOTE_OFF

const midiToFreq = (pitch) => 440 * Math.pow(2, (pitch - 69) / 12);

export function createPianoSynth(ctx) {
  const master = ctx.createGain(); master.gain.value = 0.9;
  const dry = ctx.createGain(); dry.gain.value = 0.82;
  const wet = ctx.createGain(); wet.gain.value = 0.22;
  const reverb = createReverb(ctx, { feedback: 0.7, dampingHz: 4500 }); // a brighter, shorter room than the old ambient bed
  dry.connect(master); reverb.output.connect(wet); wet.connect(master); master.connect(ctx.destination);

  const voices = new Map(); // pitch -> { osc1, osc2, gain }
  const order = []; // pitch creation order, for the polyphony cap

  function quickRelease(voice, release) {
    const t = ctx.currentTime;
    voice.gain.gain.cancelScheduledValues(t);
    voice.gain.gain.setValueAtTime(voice.gain.gain.value, t);
    voice.gain.gain.setTargetAtTime(0, t, release / 3);
    voice.osc1.stop(t + release + 0.05);
    voice.osc2.stop(t + release + 0.05);
  }

  return {
    noteOn(pitch, velBucket) {
      const existing = voices.get(pitch);
      if (existing) { quickRelease(existing, 0.03); voices.delete(pitch); }
      if (voices.size >= MAX_VOICES) {
        const oldest = order.shift();
        const v = voices.get(oldest);
        if (v) { quickRelease(v, 0.15); voices.delete(oldest); }
      }

      const freq = midiToFreq(pitch);
      const vel = (velBucket + 0.5) / N_VEL_BUCKETS;
      const peak = 0.05 + 0.22 * vel;
      const t = ctx.currentTime;

      const g = ctx.createGain(); g.gain.value = 0;
      g.connect(dry); g.connect(reverb.input);

      const osc1 = ctx.createOscillator(); osc1.type = 'triangle'; osc1.frequency.value = freq;
      const o1g = ctx.createGain(); o1g.gain.value = 1;
      osc1.connect(o1g); o1g.connect(g);

      const osc2 = ctx.createOscillator(); osc2.type = 'sine'; osc2.frequency.value = freq * 2;
      const o2g = ctx.createGain(); o2g.gain.value = 0.35;
      osc2.connect(o2g); o2g.connect(g);
      o2g.gain.setTargetAtTime(0, t, 0.12); // bright overtone fades fast -- the attack transient

      osc1.start(); osc2.start();
      g.gain.linearRampToValueAtTime(peak, t + 0.004);
      const decayTau = 0.5 + 2.2 * (1 - (pitch - PITCH_LO) / 87); // bass rings longer than treble, like a real piano
      g.gain.setTargetAtTime(peak * 0.02, t + 0.004, decayTau);

      voices.set(pitch, { osc1, osc2, gain: g });
      order.push(pitch);
    },
    noteOff(pitch) {
      const v = voices.get(pitch);
      if (!v) return;
      quickRelease(v, 0.25);
      voices.delete(pitch);
      const i = order.indexOf(pitch); if (i >= 0) order.splice(i, 1);
    },
  };
}
