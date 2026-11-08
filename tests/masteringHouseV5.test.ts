import { describe, expect, it } from 'vitest';
import { computeAlbumCohesionPlan } from '../src/dsp/albumCohesion';
import { analyzeAudioBuffer } from '../src/dsp/analyzer';
import {
  applyCubicHermiteDeclipper,
  applyDifferentialTransientRecovery,
  applyParallelUpwardMicroLift,
  applySplitBandVocalDeEsser,
  applyStudioHeadTailDeClick,
} from '../src/dsp/masteringPolishV5';
import { applyHarmonicExciter, renderMasterChain } from '../src/dsp/processors';
import { createDefaultMasteringParams } from '../src/dsp/profiles';
import type { PlanarAudioBuffer } from '../src/dsp/types';

function rms(arr: Float32Array): number {
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += arr[i] * arr[i];
  return Math.sqrt(s / Math.max(1, arr.length));
}

function crestDb(arr: Float32Array): number {
  let pk = 0;
  for (let i = 0; i < arr.length; i++) {
    const a = Math.abs(arr[i]);
    if (a > pk) pk = a;
  }
  return 20 * Math.log10((pk + 1e-12) / (rms(arr) + 1e-12));
}

describe('SonicForge Pro v5.0 — Mastering-House Flagship DSP Suite', () => {
  it('Cubic Hermite Waveform De-Clipper reconstructs flat-topped clipped peaks and restores crest factor', () => {
    const sr = 48000;
    const N = 4800;
    const l = new Float32Array(N);
    const r = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      // 400 Hz tone hard-clipped at ±0.72 then normalized to 1.0 (classic flat-topped digital clip)
      const raw = 1.32 * Math.sin((2 * Math.PI * 400 * i) / sr);
      const clipped = Math.max(-0.72, Math.min(0.72, raw)) / 0.72;
      l[i] = clipped;
      r[i] = clipped;
    }

    const beforeCrest = crestDb(l);
    const repaired = applyCubicHermiteDeclipper(l, r);
    const afterCrest = crestDb(l);

    expect(repaired).toBeGreaterThan(100);
    // Reconstructed rounded waveform recovers > +1.0 dB of lost natural crest factor!
    expect(afterCrest).toBeGreaterThan(beforeCrest + 1.0);
  });

  it('Differential Drum Transient Recovery restores punch on squashed hits without sub/air noise', () => {
    const sr = 48000;
    const N = Math.floor(sr * 0.5);
    const l = new Float32Array(N);
    const r = new Float32Array(N);

    // Drum hit at t = 0.05s followed by steady sustain pad
    for (let i = 0; i < N; i++) {
      const t = i / sr;
      const pad = 0.18 * Math.sin(2 * Math.PI * 220 * t);
      const hitEnv = t >= 0.05 && t < 0.11 ? Math.exp(-(t - 0.05) * 65) : 0;
      const drum = 0.32 * hitEnv * Math.sin(2 * Math.PI * 140 * t);
      l[i] = pad + drum;
      r[i] = pad + drum;
    }

    const beforeCrest = crestDb(l);
    applyDifferentialTransientRecovery(l, r, sr, 60);
    const afterCrest = crestDb(l);

    expect(afterCrest).toBeGreaterThan(beforeCrest + 0.6);
  });

  it('Level-Independent Split-Band Mid Vocal De-Esser tames center 7.5 kHz sibilance while leaving stereo Side 100% untouched', () => {
    const sr = 48000;
    const N = Math.floor(sr * 0.6);
    const l = new Float32Array(N);
    const r = new Float32Array(N);

    for (let i = 0; i < N; i++) {
      const t = i / sr;
      // Mid: soft 450 Hz vocal body + piercing 7500 Hz 'S' sibilance spike
      const midBody = 0.08 * Math.sin(2 * Math.PI * 450 * t);
      const midSib = 0.35 * Math.sin(2 * Math.PI * 7500 * t);
      const mid = midBody + midSib;

      // Side: stereo 9200 Hz cymbal shimmer that MUST remain untouched
      const side = 0.18 * Math.sin(2 * Math.PI * 9200 * t);

      l[i] = mid + side;
      r[i] = mid - side;
    }

    const origSide = new Float32Array(N);
    const origMid = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      origMid[i] = 0.5 * (l[i] + r[i]);
      origSide[i] = 0.5 * (l[i] - r[i]);
    }

    applySplitBandVocalDeEsser(l, r, sr, 75);

    const newSide = new Float32Array(N);
    const newMid = new Float32Array(N);
    let sideErrSq = 0;
    for (let i = 0; i < N; i++) {
      newMid[i] = 0.5 * (l[i] + r[i]);
      newSide[i] = 0.5 * (l[i] - r[i]);
      const d = newSide[i] - origSide[i];
      sideErrSq += d * d;
    }

    const midAttenDb = 20 * Math.log10(rms(origMid) / rms(newMid));
    const sideNullDb = 10 * Math.log10(sideErrSq / N + 1e-24);

    expect(midAttenDb).toBeGreaterThan(2.2); // Piercing Mid sibilance cleanly tamed!
    expect(sideNullDb).toBeLessThan(-110); // Stereo Side cymbals 100% bit-exact untouched!
  });

  it('Parallel Upward Micro-Lift enhances -28 dBFS musical body while gating -65 dBFS noise floor', () => {
    const sr = 48000;
    const N = Math.floor(sr * 0.5);

    // 1. -28 dBFS musical detail (~0.04 amplitude)
    const bodyL = new Float32Array(N);
    const bodyR = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const s = 0.04 * Math.sin((2 * Math.PI * 440 * i) / sr);
      bodyL[i] = s;
      bodyR[i] = s;
    }
    const preBodyRms = rms(bodyL);
    applyParallelUpwardMicroLift(bodyL, bodyR, sr, 50);
    const postBodyRms = rms(bodyL);
    const bodyLiftDb = 20 * Math.log10(postBodyRms / preBodyRms);
    expect(bodyLiftDb).toBeGreaterThan(1.2);

    // 2. -65 dBFS quiet background floor (~0.00056 amplitude) -> noise gate leaves RMS unboosted
    const hissL = new Float32Array(N);
    const hissR = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const s = 0.0005 * Math.sin((2 * Math.PI * 4000 * i) / sr);
      hissL[i] = s;
      hissR[i] = s;
    }
    const preHiss = rms(hissL);
    applyParallelUpwardMicroLift(hissL, hissR, sr, 50);
    const postHiss = rms(hissL);
    // Only zero-order polynomial micro-blend (~0.5 dB max), zero upward compressor pumping
    expect(20 * Math.log10(postHiss / preHiss)).toBeLessThan(0.7);
  });

  it('4x Polyphase M/S Analog Harmonic Exciter & 2-Pass BS.1770 Solver lock loudness within ±0.15 LU', () => {
    const sr = 48000;
    const N = Math.floor(sr * 2.0);
    const l = new Float32Array(N);
    const r = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const t = i / sr;
      l[i] =
        0.22 * Math.sin(2 * Math.PI * 80 * t) +
        0.18 * Math.sin(2 * Math.PI * 620 * t) +
        0.12 * Math.sin(2 * Math.PI * 2400 * t);
      r[i] =
        0.22 * Math.sin(2 * Math.PI * 80 * t) +
        0.18 * Math.sin(2 * Math.PI * 620 * t + 0.35) +
        0.12 * Math.sin(2 * Math.PI * 2400 * t - 0.4);
    }

    const testL = new Float32Array(l);
    const testR = new Float32Array(r);
    applyHarmonicExciter(testL, testR, sr, {
      enabled: true,
      mode: 'tube',
      drivePct: 45,
      highFocusHz: 1200,
      mixPct: 40,
    });
    expect(Number.isFinite(rms(testL))).toBe(true);

    // Verify head/tail de-click zeroes abrupt step boundaries cleanly
    testL[0] = 0.4;
    testL[N - 1] = -0.35;
    applyStudioHeadTailDeClick(testL, testR, sr);
    expect(Math.abs(testL[0])).toBeLessThan(1e-6);
    expect(Math.abs(testL[N - 1])).toBeLessThan(1e-6);

    const params = createDefaultMasteringParams('spotify');
    params.limiter.targetLufs = -9.5;
    params.limiter.ceilingDbtp = -1.0;
    params.limiter.oversampling = 16;

    const res = renderMasterChain({ sampleRate: sr, duration: 2.0, channels: [l, r] }, params);
    expect(Math.abs(res.analysis.loudness.integratedLufs - -9.5)).toBeLessThanOrEqual(0.15);
    expect(res.analysis.truePeak.truePeakDbtp).toBeLessThanOrEqual(-0.98);
  });

  it('Multi-Track EP / Album Cohesion Planner sequences acoustic ballads gentler than club bangers while gluing tone', () => {
    const sr = 48000;
    const N = Math.floor(sr * 1.6);

    // Track 1: Dense, sub-heavy 808 banger (low PLR, heavy 70 Hz sub/low)
    const b1L = new Float32Array(N);
    const b1R = new Float32Array(N);
    // Track 2: Midtempo core album cut
    const b2L = new Float32Array(N);
    const b2R = new Float32Array(N);
    // Track 3: High-crest intimate acoustic guitar ballad (high PLR, sparse low end)
    const b3L = new Float32Array(N);
    const b3R = new Float32Array(N);

    for (let i = 0; i < N; i++) {
      const t = i / sr;
      const banger = Math.tanh(
        1.4 * Math.sin(2 * Math.PI * 70 * t) + 0.6 * Math.sin(2 * Math.PI * 1800 * t)
      ) * 0.45;
      b1L[i] = banger;
      b1R[i] = banger;

      const core =
        0.26 * Math.sin(2 * Math.PI * 110 * t) + 0.22 * Math.sin(2 * Math.PI * 900 * t);
      b2L[i] = core;
      b2R[i] = core;

      const pluckEnv = Math.exp(-((t % 0.4) * 14));
      const acoustic = 0.48 * pluckEnv * Math.sin(2 * Math.PI * 420 * t);
      b3L[i] = acoustic;
      b3R[i] = acoustic;
    }

    const buf1: PlanarAudioBuffer = { sampleRate: sr, duration: 1.6, channels: [b1L, b1R] };
    const buf2: PlanarAudioBuffer = { sampleRate: sr, duration: 1.6, channels: [b2L, b2R] };
    const buf3: PlanarAudioBuffer = { sampleRate: sr, duration: 1.6, channels: [b3L, b3R] };

    const plans = computeAlbumCohesionPlan({
      genre: 'pop_rnb',
      intensity: 'balanced_pro',
      albumTitle: 'Midnight Tapes EP',
      tracks: [
        { name: '01_808_Anthem.wav', buffer: buf1, analysis: analyzeAudioBuffer(buf1) },
        { name: '02_Neon_Drive.wav', buffer: buf2, analysis: analyzeAudioBuffer(buf2) },
        { name: '03_Acoustic_Outro.wav', buffer: buf3, analysis: analyzeAudioBuffer(buf3) },
      ],
    });

    expect(plans).toHaveLength(3);
    // Banger must target noticeably louder LUFS than the intimate acoustic ballad!
    expect(plans[0].targetLufs).toBeGreaterThan(plans[2].targetLufs + 0.9);
    expect(plans[2].roleLabel).toBe('Dynamic / Intimate Cut');
    expect(plans[0].params.exportFormat.metadata?.album).toBe('Midnight Tapes EP');
  });
});
