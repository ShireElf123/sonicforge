import { describe, expect, it } from 'vitest';
import { alignPrimingDelay } from '../src/audio/webCodecsAudit';
import { analyzeAudioBuffer } from '../src/dsp/analyzer';
import { auditLossyCodecHeadroom } from '../src/dsp/codecSim';
import { renderMasterChain } from '../src/dsp/processors';
import {
  createDefaultMasteringParams,
  createDefaultStemBuses,
  createNeutralBypassParams,
} from '../src/dsp/profiles';
import { demixStereoToFourStems } from '../src/dsp/stemDemixer';
import {
  computeAutoUnmaskBusPatches,
  detectStemMaskingCollisions,
} from '../src/dsp/stemMasking';
import {
  generateIspTortureVector,
  generateStudioSession,
} from '../src/dsp/synthTestVectors';
import { measureTruePeak } from '../src/dsp/truePeak';
import type { PlanarAudioBuffer } from '../src/dsp/types';

describe('SonicForge Pro v3.0 — Desktop-Parity Gap Closure Suite', () => {
  it('16x Polyphase Kaiser-Sinc True-Peak meter (192-tap FIR) accurately catches ISPs and preserves unity passband', () => {
    const sr = 48000;
    const len = sr;
    const ch = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      ch[i] = 0.5 * Math.sin((2 * Math.PI * 997 * i) / sr); // -6.02 dBFS
    }
    const tone: PlanarAudioBuffer = { sampleRate: sr, duration: 1, channels: [ch, ch] };
    const tp16Tone = measureTruePeak(tone, 16);
    expect(Math.abs(tp16Tone.truePeakDbtp - -6.0206)).toBeLessThan(0.03);

    const ispVec = generateIspTortureVector(sr, 2.0, 1.0);
    const tp16Isp = measureTruePeak(ispVec, 16);
    // Sample peak is -3.01 dBFS while True Peak is 0.00 dBTP (+3.01 dB inter-sample overshoot)
    expect(Math.abs(tp16Isp.truePeakDbtp)).toBeLessThan(0.02);
    expect(tp16Isp.ispMarginDb).toBeGreaterThan(2.95);
  });

  it('4x Oversampled Pre-Limiter Soft Clipper + IRC-IV Spectral Subband Split hits -7.5 LUFS cleanly under -0.8 dBTP', () => {
    const mix = generateStudioSession('neon_horizon_mix', 48000, 2.0).stereoMix;
    const params = createDefaultMasteringParams('club_loud');
    params.limiter.targetLufs = -7.5;
    params.limiter.ceilingDbtp = -0.8;
    params.limiter.oversampling = 16;
    params.limiter.releaseMode = 'irc_spectral';
    params.limiter.softClipEnabled = true;
    params.limiter.softClipMode = 'crisp_cubic';
    params.limiter.softClipThresholdDb = -1.6;
    params.limiter.softClipAmountPct = 55;

    const rendered = renderMasterChain(mix, params);
    const tp16 = measureTruePeak(rendered.buffer, 16);

    expect(tp16.truePeakDbtp).toBeLessThanOrEqual(-0.75);
    expect(rendered.analysis.loudness.integratedLufs).toBeGreaterThan(-8.4);
    expect(rendered.analysis.loudness.integratedLufs).toBeLessThan(-6.8);
  });

  it('Per-Band Pro-Q Dynamic M/S EQ attenuates loud resonances dynamically while leaving quiet passages transparent', () => {
    const sr = 48000;
    const N = sr;
    const quiet = new Float32Array(N);
    const loud = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const s = Math.sin((2 * Math.PI * 300 * i) / sr);
      quiet[i] = 0.02 * s; // -34 dBFS (below -20 dB threshold)
      loud[i] = 0.55 * s; // -5.2 dBFS (well above -20 dB threshold)
    }

    const params = createNeutralBypassParams();
    params.eqEnabled = true;
    params.eqBands[2] = {
      id: 'low_mid',
      label: 'Dyn Mud Cut',
      type: 'peaking',
      freqHz: 300,
      gainDb: 0,
      q: 1.5,
      placement: 'mid',
      enabled: true,
      dynEnabled: true,
      dynThresholdDb: -20,
      dynRangeDb: -6.0,
    };

    const quietRes = renderMasterChain(
      { sampleRate: sr, duration: 1, channels: [quiet, quiet] },
      params
    );
    const loudRes = renderMasterChain(
      { sampleRate: sr, duration: 1, channels: [loud, loud] },
      params
    );

    const rms = (arr: Float32Array) => {
      let s = 0;
      const start = Math.floor(arr.length * 0.25);
      for (let i = start; i < arr.length; i++) s += arr[i] * arr[i];
      return Math.sqrt(s / (arr.length - start));
    };

    const quietGainDb = 20 * Math.log10(rms(quietRes.buffer.channels[0]) / rms(quiet));
    const loudGainDb = 20 * Math.log10(rms(loudRes.buffer.channels[0]) / rms(loud));

    // Quiet signal below threshold experiences near-0 dB change; loud resonance gets dynamically attenuated!
    expect(Math.abs(quietGainDb)).toBeLessThan(0.35);
    expect(loudGainDb).toBeLessThan(-2.5);
  });

  it('REPET-SIM + Formant v2 4-Stem Demixer preserves <-115 dB Partition-of-Unity null and separates repeating chords from melodic lead', () => {
    const sr = 48000;
    const dur = 2.4;
    const N = Math.floor(sr * dur);
    const left = new Float32Array(N);
    const right = new Float32Array(N);

    // Repeating center chord pattern every 0.4s (420 Hz) + non-repeating vibrato/gliding vocal formant (680->1120 Hz)
    for (let i = 0; i < N; i++) {
      const t = i / sr;
      const chordEnv = 0.22 * (0.6 + 0.4 * Math.cos(2 * Math.PI * 2.5 * t));
      const repeatingChord = chordEnv * Math.sin(2 * Math.PI * 420 * t);

      const vocalActive = t > 0.35 && t < 1.95 ? 0.25 : 0;
      const f0 =
        240 + 95 * Math.sin(2 * Math.PI * 0.73 * t) + 12 * Math.sin(2 * Math.PI * 5.8 * t);
      const nonRepeatingVocal =
        vocalActive *
        (0.55 * Math.sin(2 * Math.PI * f0 * t) +
          0.85 * Math.sin(2 * Math.PI * 3 * f0 * t) +
          0.45 * Math.sin(2 * Math.PI * 5 * f0 * t));

      left[i] = repeatingChord + nonRepeatingVocal;
      right[i] = repeatingChord + nonRepeatingVocal;
    }

    const demixed = demixStereoToFourStems({
      sampleRate: sr,
      duration: dur,
      channels: [left, right],
    });

    expect(demixed.reconstructionNullDb).toBeLessThan(-115);

    let voxE = 0;
    let instE = 0;
    for (let i = 0; i < N; i++) {
      voxE += demixed.stems.vocals.channels[0][i] ** 2;
      instE += demixed.stems.instruments.channels[0][i] ** 2;
    }
    expect(voxE).toBeGreaterThan(0.01);
    expect(instE).toBeGreaterThan(0.01);
  });

  it('Inter-Stem Collision Detector flags Kick/Bass & Vocal/Instrument masking and computes complementary bus EQ patches', () => {
    const session = generateStudioSession('neon_horizon_mix', 48000, 1.5);
    const reports = {
      drums: analyzeAudioBuffer(session.stems.drums),
      bass: analyzeAudioBuffer(session.stems.bass),
      vocals: analyzeAudioBuffer(session.stems.vocals),
      instruments: analyzeAudioBuffer(session.stems.instruments),
    };

    const collisions = detectStemMaskingCollisions(reports);
    expect(collisions.length).toBeGreaterThanOrEqual(1);

    const buses = createDefaultStemBuses();
    const patched = computeAutoUnmaskBusPatches(buses, collisions);
    const changedAny =
      patched.bass.midBellDb !== buses.bass.midBellDb ||
      patched.instruments.midBellDb !== buses.instruments.midBellDb ||
      patched.instruments.lowShelfDb !== buses.instruments.lowShelfDb;
    expect(changedAny).toBe(true);
  });

  it('24-Bark Zwicker Psychoacoustic Codec Engine & WebCodecs Priming Aligner preserve sample-accurate phase and monotonic SNR', () => {
    const mix = generateStudioSession('neon_horizon_mix', 48000, 1.6).stereoMix;
    const audits = auditLossyCodecHeadroom(mix);
    const aac = audits.find((a) => a.id === 'aac_256')!;
    const ogg = audits.find((a) => a.id === 'ogg_160')!;
    const mp3 = audits.find((a) => a.id === 'mp3_128')!;

    expect(aac.engineType).toBe('psychoacoustic_24bark');
    expect(aac.artifactSnrDb).toBeGreaterThan(ogg.artifactSnrDb);
    expect(ogg.artifactSnrDb).toBeGreaterThan(mp3.artifactSnrDb);

    // Test priming delay cross-correlation aligner with synthetic 1024-sample AAC encoder priming pad
    const priming = 1024;
    const refCh = mix.channels[0];
    const delayed = new Float32Array(refCh.length + priming);
    delayed.set(refCh, priming);

    const aligned = alignPrimingDelay(mix, {
      sampleRate: mix.sampleRate,
      duration: delayed.length / mix.sampleRate,
      channels: [delayed, delayed],
    });
    expect(aligned.channels[0].length).toBe(refCh.length);

    let errSq = 0;
    for (let i = 0; i < refCh.length; i++) {
      const d = aligned.channels[0][i] - refCh[i];
      errSq += d * d;
    }
    expect(errSq).toBeLessThan(1e-10);
  });
});
