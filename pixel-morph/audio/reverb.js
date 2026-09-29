// A small algorithmic reverb (parallel Schroeder-style comb filters), built entirely from native
// Web Audio nodes -- no impulse-response asset to fetch, so the audio layer adds ~0 KB to the page.

function combFilter(ctx, delayTime, feedback, dampingHz) {
  const input = ctx.createGain();
  const delay = ctx.createDelay(1);
  delay.delayTime.value = delayTime;
  const damp = ctx.createBiquadFilter();
  damp.type = 'lowpass';
  damp.frequency.value = dampingHz;
  const fb = ctx.createGain();
  fb.gain.value = feedback;
  input.connect(delay);
  delay.connect(damp);
  damp.connect(fb);
  fb.connect(delay);
  return { input, output: damp };
}

const DELAY_TIMES = [0.0297, 0.0371, 0.0411, 0.0437, 0.0507, 0.0577]; // seconds, mutually near-coprime (no metallic flutter)

export function createReverb(ctx, { feedback = 0.82, dampingHz = 3200 } = {}) {
  const input = ctx.createGain();
  const output = ctx.createGain();
  for (const dt of DELAY_TIMES) {
    const comb = combFilter(ctx, dt, feedback, dampingHz);
    input.connect(comb.input);
    comb.output.connect(output);
  }
  return { input, output };
}
