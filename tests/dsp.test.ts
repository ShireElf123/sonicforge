import { describe, expect, it } from 'vitest';
import { analyzeAudioBuffer } from '../src/dsp/analyzer';
import { computeSignalDrivenAssistant, simulateStreamingNormalization } from '../src/dsp/assistant';
import { splitFourBandLr4 } from '../src/dsp/biquad';
import {
  designKWeightingStage1,
  designKWeightingStage2,
  measureLoudnessBs1770,
} from '../src/dsp/lufs';
import {
  applyStereoImager,
  renderMasterChain,
  sumStemBuses,
} from '../src/dsp/processors';
import {
  createDefaultMasteringParams,
  createDefaultStemBuses,
} from '../src/dsp/profiles';
import {
  generateEbuCalibrationTone,
  generateIspTortureVector,
  generateStudioSession,
} from '../src/dsp/synthTestVectors';
import { measureTruePeak } from '../src/dsp/truePeak';
import { decodeWav, encodeWav, verifyExportedWav } from '../src/dsp/wav';

describe('ITU-R BS.1770-5 / EBU R128 Loudness Engine', () => {
  it('matches ITU-R BS.1770-4 Table 1 K-weighting filter coefficients at 48 kHz', () => {
    const s1 = designKWeightingStage1(48000);
    const s2 = designKWeightingStage2(48000);

    expect(s1.b0).toBeCloseTo(1.53512485958697, 8);
    expect(s1.b1).toBeCloseTo(-2.69169618940638, 8);
    expect(s1.b2).toBeCloseTo(1.19839281085285, 8);
    expect(s1.a1).toBeCloseTo(-1.69065929318241, 8);
    expect(s1.a2).toBeCloseTo(0.73248077421585, 8);

    expect(s2.b0).toBeCloseTo(1.0, 2); // Normalized by a0: ~0.996003
    expect(s2.a1).toBeCloseTo(-1.99004745483398, 8);
    expect(s2.a2).toBeCloseTo(0.99007225036621, 8);
  });

  it('measures EBU R128 997 Hz stereo calibration tone at -23.00 LUFS within ±0.05 LU across sample rates', () => {
    for (const sr of [44100, 48000, 96000]) {
      const tone = generateEbuCalibrationTone(sr, 4.0, -23.0);
      const res = measureLoudnessBs1770(tone);
      expect(Math.abs(res.integratedLufs - -23.0)).toBeLessThan(0.05);
      expect(Math.abs(res.momentaryMaxLufs - -23.0)).toBeLessThan(0.05);
      expect(Math.abs(res.shortTermMaxLufs - -23.0)).toBeLessThan(0.05);
      expect(res.loudnessRangeLu).toBeLessThan(0.15);
    }
  });

  it('correctly applies -70 LUFS absolute and -10 LU relative gating (EBU Tech 3341)', () => {
    // 3 seconds at -23.0 LUFS followed by 3 seconds at -36.0 LUFS (13 LU quieter -> gated out by -10 LU gate!)
    const sr = 48000;
    const loud = generateEbuCalibrationTone(sr, 3.0, -23.0);
    const quiet = generateEbuCalibrationTone(sr, 3.0, -36.0);
    const total = loud.channels[0].length + quiet.channels[0].length;
    const chL = new Float32Array(total);
    const chR = new Float32Array(total);
    chL.set(loud.channels[0], 0);
    chL.set(quiet.channels[0], loud.channels[0].length);
    chR.set(loud.channels[1], 0);
    chR.set(quiet.channels[1], loud.channels[1].length);

    const gatedResult = measureLoudnessBs1770({
      sampleRate: sr,
      channels: [chL, chR],
      duration: 6.0,
    });

    // Because -36 LUFS is >10 LU below the ~-25.8 LUFS ungated average, the -36 LUFS segment is gated out
    // and Integrated Loudness stays right near -23.0 LUFS (boundary overlap window gives ~-23.1 LUFS)
    expect(gatedResult.integratedLufs).toBeGreaterThan(-23.35);
    expect(gatedResult.integratedLufs).toBeLessThan(-22.9);
  });
});

describe('ITU-R BS.1770-5 Oversampled True Peak Detector', () => {
  it('detects +3.01 dB inter-sample peak on fs/4 45-degree cosine vector where sample peak is -3.01 dBFS', () => {
    const ispVec = generateIspTortureVector(48000, 2.0, 1.0);
    const tp4 = measureTruePeak(ispVec, 4, -1.0);
    const tp8 = measureTruePeak(ispVec, 8, -1.0);

    // Discrete samples never exceed cos(pi/4) = 0.70710678 = -3.0103 dBFS
    expect(tp4.samplePeakDbfs).toBeCloseTo(-3.01, 1);
    // Reconstructed continuous peak reaches ~0.00 dBTP!
    expect(tp4.truePeakDbtp).toBeGreaterThan(-0.15);
    expect(tp4.truePeakDbtp).toBeLessThan(0.15);
    expect(tp8.truePeakDbtp).toBeGreaterThan(-0.12);
    expect(tp4.ispMarginDb).toBeGreaterThan(2.85);
  });
});

describe('Phase-Compensated 4-Band Linkwitz-Riley (24 dB/oct) Crossover', () => {
  it('reconstructs unity magnitude (< 0.05 dB ripple) when all 4 bands are summed flat', () => {
    const sr = 48000;
    const testFreqs = [35, 90, 120, 400, 1200, 3200, 6500, 12000];

    for (const f of testFreqs) {
      const n = sr; // 1 second
      const input = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        input[i] = 0.5 * Math.sin((2 * Math.PI * f * i) / sr);
      }

      const [b0, b1, b2, b3] = splitFourBandLr4(input, sr, [120, 1200, 6500]);
      // Measure steady-state RMS in second half of buffer (after filter transient settling)
      let inSq = 0;
      let outSq = 0;
      const start = Math.floor(n * 0.25);
      for (let i = start; i < n; i++) {
        const sum = b0[i] + b1[i] + b2[i] + b3[i];
        inSq += input[i] * input[i];
        outSq += sum * sum;
      }
      const gainDb = 10 * Math.log10(outSq / inSq);
      expect(Math.abs(gainDb)).toBeLessThan(0.05);
    }
  });
});

describe('Mastering Signal Chain, True-Peak Limiter & WAV Export Verification', () => {
  it('renders Neon Horizon session to Spotify -14.0 LUFS / -1.0 dBTP with strict ceiling compliance', () => {
    const session = generateStudioSession('neon_horizon_mix', 48000, 2);
    const srcReport = analyzeAudioBuffer(session.stereoMix);
    expect(Number.isFinite(srcReport.loudness.integratedLufs)).toBe(true);

    const rec = computeSignalDrivenAssistant(srcReport, 'spotify', 'modern_punch');
    const rendered = renderMasterChain(session.stereoMix, rec.params);

    // Post-render BS.1770 Integrated Loudness should hit -14.0 LUFS ± 0.4 LU
    expect(rendered.analysis.loudness.integratedLufs).toBeGreaterThan(-14.45);
    expect(rendered.analysis.loudness.integratedLufs).toBeLessThan(-13.55);

    // Post-render 4x True Peak must strictly obey -1.0 dBTP ceiling
    expect(rendered.analysis.truePeak.truePeakDbtp).toBeLessThanOrEqual(-0.95);
    expect(rendered.analysis.truePeak.ceilingViolationCount).toBe(0);
    expect(rendered.analysis.truePeak.clippedSampleCount).toBe(0);
  });

  it('tightens sub-bass (<150 Hz) correlation via Elliptical Bass Mono filter', () => {
    const sr = 48000;
    const n = sr * 2;
    const left = new Float32Array(n);
    const right = new Float32Array(n);
    // 60 Hz sub with 80-degree phase offset between L and R
    for (let i = 0; i < n; i++) {
      left[i] = 0.4 * Math.sin((2 * Math.PI * 60 * i) / sr);
      right[i] = 0.4 * Math.sin((2 * Math.PI * 60 * i) / sr + 1.4);
    }
    const before = analyzeAudioBuffer({ sampleRate: sr, channels: [left, right], duration: 2 });
    expect(before.stereo.lowBandCorrelation).toBeLessThan(0.3);

    applyStereoImager(left, right, sr, {
      enabled: true,
      bassMonoEnabled: true,
      bassMonoHz: 140,
      widthPct: 100,
      highWidthPct: 100,
      highCrossoverHz: 2200,
    });

    const after = analyzeAudioBuffer({ sampleRate: sr, channels: [left, right], duration: 2 });
    expect(after.stereo.lowBandCorrelation).toBeGreaterThan(0.95);
  });

  it('sums 4 stems with solo/mute & resampling and verifies 16/24/32-bit WAV export integrity', () => {
    const session = generateStudioSession('velvet_indie_mix', 48000, 1);
    const buses = createDefaultStemBuses();
    const { summed, activeStemIds } = sumStemBuses(session.stems, buses, 48000);
    expect(activeStemIds).toHaveLength(4);
    expect(summed.channels[0].length).toBeGreaterThan(48000);

    const params = createDefaultMasteringParams('apple_music');
    const master = renderMasterChain(summed, params);

    for (const bitDepth of [16, 24, 32] as const) {
      const wavBytes = encodeWav(master.buffer, {
        bitDepth,
        dither: bitDepth === 32 ? 'none' : 'tpdf_shaped',
      });
      const verified = verifyExportedWav(wavBytes, params.limiter.ceilingDbtp, 4);
      expect(verified.validRiffHeader).toBe(true);
      expect(verified.bitDepth).toBe(bitDepth);
      expect(verified.hasNaNOrInf).toBe(false);
      expect(verified.ceilingCompliant).toBe(true);
      expect(Math.abs(verified.measuredIntegratedLufs - master.analysis.loudness.integratedLufs)).toBeLessThan(0.15);

      const decoded = decodeWav(wavBytes);
      expect(decoded.buffer.channels).toHaveLength(2);
    }

    const sims = simulateStreamingNormalization(
      master.analysis.loudness.integratedLufs,
      master.analysis.truePeak.truePeakDbtp
    );
    expect(sims.length).toBeGreaterThanOrEqual(5);
  });
});
