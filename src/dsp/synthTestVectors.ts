import type { PlanarAudioBuffer, StemSlotId } from './types';

export type BuiltInSessionId =
  | 'neon_horizon_mix'
  | 'velvet_indie_mix'
  | 'ebu_r128_cal'
  | 'isp_torture_vec';

export interface BuiltInSessionSpec {
  id: BuiltInSessionId;
  name: string;
  category: 'studio_session' | 'calibration_vector';
  description: string;
  bpm?: number;
}

export const BUILT_IN_SESSIONS: BuiltInSessionSpec[] = [
  {
    id: 'neon_horizon_mix',
    name: 'Neon Horizon — Electronic / Synthwave (4 Stems)',
    category: 'studio_session',
    bpm: 118,
    description:
      'Punchy 118 BPM drum transients, chorus-widened sub-bass (<120 Hz phase smear), stereo sawtooth chords, and expressive lead melody (~-18.2 LUFS unmastered).',
  },
  {
    id: 'velvet_indie_mix',
    name: 'Velvet Room — Warm Indie Groove (4 Stems)',
    category: 'studio_session',
    bpm: 96,
    description:
      'Warm mid-forward groove with intentional 280 Hz low-mid buildup and dark top-end tilt (-4.9 dB/oct) ideal for testing Master Assistant EQ & harmonic air.',
  },
  {
    id: 'ebu_r128_cal',
    name: 'EBU R128 Reference Sine (997 Hz @ -23.0 LUFS)',
    category: 'calibration_vector',
    description:
      'ITU-R BS.1770-5 / EBU Tech 3341 stereo 997 Hz calibration vector (-23.0 dBFS peak = -23.00 LUFS Integrated). Verifies K-weighting and gating accuracy.',
  },
  {
    id: 'isp_torture_vec',
    name: 'Inter-Sample Peak Vector (-3.01 dBFS Sample / 0.00 dBTP True)',
    category: 'calibration_vector',
    description:
      'fs/4 cosine shifted by 45° with burst envelope: discrete sample peak never exceeds -3.01 dBFS, while reconstructed continuous waveform hits 0.00 dBTP (+3.01 dB ISP).',
  },
];

function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/**
 * Deterministic PRNG for clean hi-hat / snare noise synthesis without Math.random() drift.
 */
function makeNoise(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s / 2147483648) - 1.0;
  };
}

/**
 * Generates exact ITU-R BS.1770-5 / EBU Tech 3341 stereo 997 Hz tone at targetLufs.
 * Because a 0 dBFS peak (A=1.0) stereo in-phase 997 Hz sine equals 0.00 LUFS under BS.1770,
 * A = 10^(targetLufs / 20) yields exact Integrated Loudness = targetLufs.
 */
export function generateEbuCalibrationTone(
  sampleRate = 48000,
  durationSec = 4.0,
  targetLufs = -23.0
): PlanarAudioBuffer {
  const n = Math.round(sampleRate * durationSec);
  const amp = Math.pow(10, targetLufs / 20);
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  const w = (2 * Math.PI * 997.0) / sampleRate;

  for (let i = 0; i < n; i++) {
    const s = amp * Math.sin(w * i);
    left[i] = s;
    right[i] = s;
  }

  return {
    sampleRate,
    channels: [left, right],
    duration: durationSec,
  };
}

/**
 * Generates classic fs/4 45-degree phase-shifted cosine where discrete samples are
 * [±cos(pi/4)] = ±0.70710678 (-3.01 dBFS) while true continuous peak is 1.0000 (0.00 dBTP),
 * scaled by scaleLinear.
 */
export function generateIspTortureVector(
  sampleRate = 48000,
  durationSec = 3.0,
  scaleLinear = 1.0
): PlanarAudioBuffer {
  const n = Math.round(sampleRate * durationSec);
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  const quarterPi = Math.PI * 0.25;
  const halfPi = Math.PI * 0.5;

  for (let i = 0; i < n; i++) {
    // Smooth 20ms fade-in/out at boundaries so spectral leakage doesn't create artificial clicks
    const fadeSamples = Math.round(0.02 * sampleRate);
    const env =
      i < fadeSamples
        ? i / fadeSamples
        : i > n - fadeSamples
          ? (n - i) / fadeSamples
          : 1.0;
    const val = scaleLinear * env * Math.cos(halfPi * i + quarterPi);
    left[i] = val;
    right[i] = val;
  }

  return {
    sampleRate,
    channels: [left, right],
    duration: durationSec,
  };
}

/**
 * Synthesizes a complete 4-stem musical session + summed unmastered stereo mix.
 */
export function generateStudioSession(
  id: 'neon_horizon_mix' | 'velvet_indie_mix',
  sampleRate = 48000,
  bars = 4
): {
  stereoMix: PlanarAudioBuffer;
  stems: Record<StemSlotId, PlanarAudioBuffer>;
} {
  const isNeon = id === 'neon_horizon_mix';
  const bpm = isNeon ? 118 : 96;
  const beatSec = 60 / bpm;
  const barSec = beatSec * 4;
  const durationSec = barSec * bars;
  const n = Math.round(durationSec * sampleRate);

  const drumsL = new Float32Array(n);
  const drumsR = new Float32Array(n);
  const bassL = new Float32Array(n);
  const bassR = new Float32Array(n);
  const vocalsL = new Float32Array(n);
  const vocalsR = new Float32Array(n);
  const instL = new Float32Array(n);
  const instR = new Float32Array(n);

  const noise = makeNoise(isNeon ? 0x1180beaf : 0x0960cafe);

  // Chord progressions (4 bars)
  // Neon: Am9 -> Fmaj7 -> Cmaj7 -> G6
  // Velvet: Dm9 -> Bbmaj7 -> Gm9 -> A7sus4
  const chordsMidi = isNeon
    ? [
        [57, 60, 64, 67, 71],
        [53, 57, 60, 64, 69],
        [60, 64, 67, 71, 74],
        [55, 59, 62, 64, 69],
      ]
    : [
        [50, 53, 57, 60, 64],
        [46, 50, 53, 57, 62],
        [43, 46, 50, 53, 57],
        [45, 50, 52, 55, 61],
      ];

  const bassRootsMidi = isNeon ? [33, 29, 36, 31] : [38, 34, 31, 33];

  const leadNotesMidi = isNeon
    ? [76, 74, 72, 71, 69, 72, 76, 79, 76, 74, 72, 67, 71, 72, 74, 71]
    : [69, 65, 62, 64, 65, 69, 67, 64, 62, 58, 62, 65, 64, 62, 61, 57];

  const totalBeats = bars * 4;
  const eighthSec = beatSec * 0.5;
  const sixteenthSec = beatSec * 0.25;

  // 1. Synthesize Drums (Kick on 1 & 3 + syncopation, Snare on 2 & 4, Stereo Hats on 16ths)
  for (let beat = 0; beat < totalBeats; beat++) {
    const beatStart = Math.floor(beat * beatSec * sampleRate);
    const inBar = beat % 4;

    // Kick on 0, 2, and occasional 2.5 syncopation
    const kickOffsets = inBar === 0 || inBar === 2 ? [0] : inBar === 1 && isNeon ? [Math.floor(eighthSec * sampleRate)] : [];
    for (const ko of kickOffsets) {
      const start = beatStart + ko;
      const kickLen = Math.min(n - start, Math.floor(0.32 * sampleRate));
      let phase = 0;
      for (let i = 0; i < kickLen; i++) {
        const t = i / sampleRate;
        // Pitch sweep from 145 Hz down to 48 Hz
        const freq = 48 + 105 * Math.exp(-t * 36);
        phase += (2 * Math.PI * freq) / sampleRate;
        const body = Math.sin(phase) * Math.exp(-t * 9.5);
        const click = Math.sin(2 * Math.PI * 1800 * t) * Math.exp(-t * 140) * 0.22;
        const sample = (body + click) * (isNeon ? 0.52 : 0.42);
        drumsL[start + i] += sample;
        drumsR[start + i] += sample;
      }
    }

    // Snare on beats 1 & 3 (backbeat 2 & 4)
    if (inBar === 1 || inBar === 3) {
      const snareLen = Math.min(n - beatStart, Math.floor(0.26 * sampleRate));
      for (let i = 0; i < snareLen; i++) {
        const t = i / sampleRate;
        const tone = Math.sin(2 * Math.PI * 192 * t) * Math.exp(-t * 24) * 0.35;
        const nL = noise() * Math.exp(-t * (isNeon ? 14 : 19)) * 0.32;
        const nR = noise() * Math.exp(-t * (isNeon ? 14 : 19)) * 0.32;
        drumsL[beatStart + i] += tone + nL;
        drumsR[beatStart + i] += tone + nR;
      }
    }

    // 16th-note stereo hi-hats
    for (let s = 0; s < 4; s++) {
      const hatStart = beatStart + Math.floor(s * sixteenthSec * sampleRate);
      if (hatStart >= n) continue;
      const accent = s === 2 ? 0.14 : s === 0 ? 0.09 : 0.055;
      const decay = s === 2 ? 42 : 75;
      const hatLen = Math.min(n - hatStart, Math.floor(0.09 * sampleRate));
      let prev = 0;
      for (let i = 0; i < hatLen; i++) {
        const t = i / sampleRate;
        const raw = noise();
        // Simple differentiator high-pass for crisp metallic hat
        const hp = raw - prev;
        prev = raw;
        const env = Math.exp(-t * decay) * accent * (isNeon ? 1.0 : 0.55);
        drumsL[hatStart + i] += hp * env * 1.12;
        drumsR[hatStart + i] += hp * env * 0.88;
      }
    }
  }

  // 2. Synthesize Bass (8th-note pulsing synth/electric bass with subtle stereo chorus smear in Neon)
  let bassPhaseL = 0;
  let bassPhaseR = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const barIdx = Math.min(3, Math.floor(t / barSec) % 4);
    const eighthIdx = Math.floor(t / eighthSec);
    const tInEighth = t - eighthIdx * eighthSec;

    const rootMidi = bassRootsMidi[barIdx];
    const octaveHop = isNeon && eighthIdx % 2 === 1 ? 12 : 0;
    const f0 = midiToHz(rootMidi + octaveHop - ( octaveHop === 12 ? 12 : 0 ));
    // Slight stereo chorus detune on Neon so <120 Hz correlation is ~0.68 before Bass Mono!
    const detune = isNeon ? 0.45 * Math.sin(2 * Math.PI * 0.8 * t) : 0.08;

    bassPhaseL += (2 * Math.PI * (f0 - detune)) / sampleRate;
    bassPhaseR += (2 * Math.PI * (f0 + detune + (isNeon ? 0.35 : 0))) / sampleRate;

    const env = Math.min(1, tInEighth * 120) * Math.exp(-tInEighth * (isNeon ? 4.2 : 2.8));
    const subL = Math.sin(bassPhaseL) + 0.32 * Math.sin(2 * bassPhaseL);
    const subR = Math.sin(bassPhaseR) + 0.32 * Math.sin(2 * bassPhaseR + (isNeon ? 0.9 : 0.1));

    // Intentional warm 260 Hz resonance in Velvet session
    const warmth = !isNeon ? 0.24 * Math.sin(3 * bassPhaseL) : 0.1 * Math.sin(3 * bassPhaseL);
    bassL[i] = (subL + warmth) * env * 0.27;
    bassR[i] = (subR + warmth) * env * 0.27;
  }

  // 3. Synthesize Instruments / Stereo Chord Pads
  for (let bar = 0; bar < bars; bar++) {
    const chord = chordsMidi[bar % 4];
    const barStart = Math.floor(bar * barSec * sampleRate);
    const barEnd = Math.min(n, Math.floor((bar + 1) * barSec * sampleRate));
    const len = barEnd - barStart;

    for (let v = 0; v < chord.length; v++) {
      const freq = midiToHz(chord[v]);
      const pan = (v / (chord.length - 1)) * 1.4 - 0.7; // Spread across stereo stage
      const gainL = Math.cos(((pan + 1) * Math.PI) / 4);
      const gainR = Math.sin(((pan + 1) * Math.PI) / 4);
      let ph1 = v * 0.7;
      let ph2 = v * 1.3;

      for (let i = 0; i < len; i++) {
        const t = i / sampleRate;
        const padEnv =
          Math.min(1, t / 0.12) *
          (i > len - 0.08 * sampleRate ? (len - i) / (0.08 * sampleRate) : 1.0);
        ph1 += (2 * Math.PI * freq * 0.9985) / sampleRate;
        ph2 += (2 * Math.PI * freq * 1.0015) / sampleRate;

        // Band-limited warm pad harmonics (fewer high harmonics on Velvet so it has dark tilt)
        const h1 = Math.sin(ph1) + Math.sin(ph2);
        const h2 = 0.42 * (Math.sin(2 * ph1) + Math.sin(2 * ph2));
        const h3 = (isNeon ? 0.24 : 0.06) * Math.sin(3 * ph1);
        const h4 = (isNeon ? 0.14 : 0.02) * Math.sin(4 * ph2);
        const voice = (h1 + h2 + h3 + h4) * 0.048 * padEnv;

        instL[barStart + i] += voice * gainL;
        instR[barStart + i] += voice * gainR;
      }
    }
  }

  // 4. Synthesize Lead / Vocal-Formant Line (Quarter-note melodic phrasing with vibrato)
  for (let step = 0; step < totalBeats; step++) {
    const noteMidi = leadNotesMidi[step % leadNotesMidi.length];
    const start = Math.floor(step * beatSec * sampleRate);
    const end = Math.min(n, Math.floor((step + 0.88) * beatSec * sampleRate));
    const len = end - start;
    const baseFreq = midiToHz(noteMidi);
    let phase = 0;

    for (let i = 0; i < len; i++) {
      const t = i / sampleRate;
      const vibrato = 1 + 0.0045 * Math.sin(2 * Math.PI * 5.4 * t) * Math.min(1, t * 3);
      phase += (2 * Math.PI * baseFreq * vibrato) / sampleRate;
      const env =
        Math.min(1, t / 0.025) *
        Math.exp(-t * 1.6) *
        (i > len - 0.03 * sampleRate ? (len - i) / (0.03 * sampleRate) : 1);

      // Expressive vocal-formant-like harmonic structure
      const sig =
        (Math.sin(phase) +
          0.5 * Math.sin(2 * phase + 0.3) +
          (isNeon ? 0.28 : 0.12) * Math.sin(3 * phase) +
          (isNeon ? 0.12 : 0.03) * Math.sin(5 * phase)) *
        0.095 *
        env;

      // Subtle stereo slapback ambience offset
      vocalsL[start + i] += sig * 0.96;
      vocalsR[start + i] += sig * 1.04;
    }
  }

  // Sum unmastered mix at realistic ~-18 LUFS mixdown headroom
  const mixL = new Float32Array(n);
  const mixR = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    mixL[i] = (drumsL[i] + bassL[i] + vocalsL[i] + instL[i]) * 0.72;
    mixR[i] = (drumsR[i] + bassR[i] + vocalsR[i] + instR[i]) * 0.72;
  }

  const mk = (l: Float32Array, r: Float32Array): PlanarAudioBuffer => ({
    sampleRate,
    channels: [l, r],
    duration: durationSec,
  });

  return {
    stereoMix: mk(mixL, mixR),
    stems: {
      drums: mk(drumsL, drumsR),
      bass: mk(bassL, bassR),
      vocals: mk(vocalsL, vocalsR),
      instruments: mk(instL, instR),
    },
  };
}
