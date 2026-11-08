import { describe, expect, it } from 'vitest';
import { analyzeAudioBuffer } from '../src/dsp/analyzer';
import { computeSignalDrivenAssistant } from '../src/dsp/assistant';
import {
  buildAutopilotMasteringChain,
  computeAdaptiveAutoMasterParams,
  computeArtistReadinessScorecard,
} from '../src/dsp/autopilotEngine';
import { BiquadFilter, designButterworthHighpass2 } from '../src/dsp/biquad';
import {
  applyMacroDynamicAutomation,
  detectArrangementSections,
} from '../src/dsp/macroDynamics';
import {
  applyMixDoctorAutoFix,
  diagnoseMixHeadroomThieves,
} from '../src/dsp/mixDoctor';
import { applyPhantomBassTranslator, renderMasterChain } from '../src/dsp/processors';
import { createDefaultMasteringParams } from '../src/dsp/profiles';
import { scanLoudnessSweetSpot } from '../src/dsp/sweetSpotScanner';
import { generateStudioSession } from '../src/dsp/synthTestVectors';
import type { PlanarAudioBuffer } from '../src/dsp/types';
import { crc32, createZipArchive } from '../src/dsp/zipBuilder';

describe('SonicForge Pro v4.0 — Guided Artist Autopilot & Next-Gen Mastering Engines', () => {
  it('Section-Aware Macro-Dynamics detects Verse vs Chorus and blooms Chorus stereo width & lift', () => {
    const sr = 48000;
    const dur = 6.0;
    const N = sr * dur;
    const left = new Float32Array(N);
    const right = new Float32Array(N);

    // 0..3s = intimate Verse (-20 dBFS), 3..6s = energetic Chorus (-9 dBFS + bright harmonics)
    for (let i = 0; i < N; i++) {
      const t = i / sr;
      const isChorus = t >= 3.0;
      const amp = isChorus ? 0.34 : 0.09;
      const mid = amp * Math.sin(2 * Math.PI * 220 * t);
      const side = (isChorus ? 0.14 : 0.04) * Math.sin(2 * Math.PI * 660 * t);
      const air = isChorus ? 0.08 * Math.sin(2 * Math.PI * 5200 * t) : 0;
      left[i] = mid + side + air;
      right[i] = mid - side + air;
    }

    const buf: PlanarAudioBuffer = { sampleRate: sr, duration: dur, channels: [left, right] };
    const sections = detectArrangementSections(buf);

    expect(sections.some((s) => s.type === 'verse' || s.type === 'intro')).toBe(true);
    expect(sections.some((s) => s.type === 'chorus')).toBe(true);

    const dryChorusSideSq = (() => {
      let s = 0;
      for (let i = sr * 4; i < sr * 5; i++) {
        const side = 0.5 * (left[i] - right[i]);
        s += side * side;
      }
      return s;
    })();

    applyMacroDynamicAutomation(
      left,
      right,
      sr,
      {
        enabled: true,
        chorusLiftDb: 1.4,
        chorusWidthBoostPct: 22,
        chorusAirBoostDb: 1.2,
        verseIntimacyPct: 40,
      },
      sections
    );

    const wetChorusSideSq = (() => {
      let s = 0;
      for (let i = sr * 4; i < sr * 5; i++) {
        const side = 0.5 * (left[i] - right[i]);
        s += side * side;
      }
      return s;
    })();

    expect(wetChorusSideSq).toBeGreaterThan(dryChorusSideSq * 1.45);
  });

  it('Phantom-Fundamental Bass Translator synthesizes 100-180 Hz phone-audible upper harmonics from a 52 Hz 808', () => {
    const sr = 48000;
    const N = sr;
    const left = new Float32Array(N);
    const right = new Float32Array(N);

    for (let i = 0; i < N; i++) {
      const s52 = 0.35 * Math.sin((2 * Math.PI * 52 * i) / sr);
      left[i] = s52;
      right[i] = s52;
    }

    const measurePhoneBandRms = (ch: Float32Array) => {
      // Simulate tiny phone speaker high-pass at 95 Hz (2 stages = 4th order)
      const hp1 = new BiquadFilter(designButterworthHighpass2(95, sr));
      const hp2 = new BiquadFilter(designButterworthHighpass2(95, sr));
      let sq = 0;
      const start = Math.floor(N * 0.25);
      for (let i = 0; i < N; i++) {
        const y = hp2.processSample(hp1.processSample(ch[i]));
        if (i >= start) sq += y * y;
      }
      return Math.sqrt(sq / (N - start));
    };

    const phoneBefore = measurePhoneBandRms(left);
    applyPhantomBassTranslator(left, right, sr, {
      enabled: true,
      cutoffHz: 80,
      amountPct: 75,
      character: 'warm_808',
    });
    const phoneAfter = measurePhoneBandRms(left);

    // Upper harmonics (>95 Hz) increase dramatically so phone speakers reproduce the 808 pitch!
    expect(phoneAfter).toBeGreaterThan(phoneBefore * 1.6);
  });

  it('Mix Doctor detects out-of-phase bass & sharp headroom-thief spikes and auto-fixes them', () => {
    const sr = 48000;
    const dur = 2.5;
    const N = Math.floor(sr * dur);
    const left = new Float32Array(N);
    const right = new Float32Array(N);

    for (let i = 0; i < N; i++) {
      const t = i / sr;
      // Out-of-phase 65 Hz bass between 0.5s and 1.0s
      if (t >= 0.5 && t < 1.0) {
        const b = 0.22 * Math.sin(2 * Math.PI * 65 * t);
        left[i] += b;
        right[i] -= b; // 180 deg inverted!
      } else {
        const m = 0.12 * Math.sin(2 * Math.PI * 220 * t);
        left[i] += m;
        right[i] += m;
      }
    }
    // Sharp headroom-thief snare spike at 1.6s
    const spikeIdx = Math.floor(1.6 * sr);
    left[spikeIdx] = 0.98;
    right[spikeIdx] = 0.98;

    const issues = diagnoseMixHeadroomThieves({
      sampleRate: sr,
      duration: dur,
      channels: [left, right],
    });

    expect(issues.some((x) => x.category === 'phase_cancel')).toBe(true);
    expect(issues.some((x) => x.category === 'headroom_thief')).toBe(true);

    let fixed = createDefaultMasteringParams('custom');
    fixed.stereo.bassMonoEnabled = false;
    fixed.limiter.softClipEnabled = false;
    for (const iss of issues) {
      fixed = applyMixDoctorAutoFix(fixed, iss);
    }
    expect(fixed.stereo.bassMonoEnabled).toBe(true);
    expect(fixed.limiter.softClipEnabled).toBe(true);
  });

  it('Loudness-vs-Punch Breaking-Point Scanner sweeps 5 targets and identifies clean Sweet Spot', () => {
    const mix = generateStudioSession('neon_horizon_mix', 48000, 2.0).stereoMix;
    const report = scanLoudnessSweetSpot(mix, createDefaultMasteringParams('spotify'));

    expect(report.points).toHaveLength(5);
    expect(report.points[4].achievedLufs).toBeGreaterThan(report.points[0].achievedLufs + 4.0);
    expect(report.points.some((p) => p.isSweetSpot)).toBe(true);
    expect(report.recommendedLufs).toBeLessThanOrEqual(-6.5);
    expect(report.recommendedLufs).toBeGreaterThanOrEqual(-14.0);
  });

  it('Guided Artist Autopilot produces a 90+/100 Release-Ready Master & valid PKZIP Release Pack archive', () => {
    const mix = generateStudioSession('neon_horizon_mix', 48000, 1.8).stereoMix;
    const srcAnalysis = analyzeAudioBuffer(mix);

    const chain = buildAutopilotMasteringChain(
      {
        genre: 'trap_hiphop',
        releaseGoal: 'streaming',
        loudnessSlamPct: 72,
        vocalUpfrontPct: 68,
        bassPhonePunchPct: 78,
        chorusBloomWidthPct: 64,
      },
      srcAnalysis,
      null
    );

    const rendered = renderMasterChain(mix, chain);
    const scorecard = computeArtistReadinessScorecard(rendered.analysis, chain);

    expect(rendered.analysis.truePeak.truePeakDbtp).toBeLessThanOrEqual(-0.92);
    expect(scorecard.score).toBeGreaterThanOrEqual(90);

    // Verify PKZIP archive structure & IEEE 802.3 CRC-32 ("123456789" -> 0xCBF43926)
    const testPayload = new TextEncoder().encode('123456789');
    expect(crc32(testPayload)).toBe(0xcbf43926);

    const zipBuf = createZipArchive([
      { filename: '01_Streaming_Master.wav', data: new Uint8Array([82, 73, 70, 70]) },
      { filename: 'QC_Certificate.html', data: testPayload },
    ]);
    const dv = new DataView(zipBuf);
    expect(dv.getUint32(0, true)).toBe(0x04034b50); // Local File Header signature
    expect(dv.getUint32(zipBuf.byteLength - 22, true)).toBe(0x06054b50); // EOCD signature
    expect(dv.getUint16(zipBuf.byteLength - 12, true)).toBe(2); // 2 entries in central directory
  });

  it('1-Click Genre Auto-Master solves signal-adaptive spectral balance & Mix Doctor auto-fixes', () => {
    const mix = generateStudioSession('neon_horizon_mix', 48000, 1.8).stereoMix;
    const srcAnalysis = analyzeAudioBuffer(mix);
    const issues = diagnoseMixHeadroomThieves(mix);

    const warmAcoustic = computeAdaptiveAutoMasterParams({
      genre: 'acoustic_chill',
      intensity: 'warm_smooth',
      source: srcAnalysis,
      issues,
    });
    const loudAfro = computeAdaptiveAutoMasterParams({
      genre: 'afro_amapiano',
      intensity: 'loud_punchy',
      source: srcAnalysis,
      issues,
    });

    expect(loudAfro.params.limiter.targetLufs).toBeGreaterThan(
      warmAcoustic.params.limiter.targetLufs + 2.5
    );
    expect(loudAfro.summaryActions.length).toBeGreaterThan(0);

    const rendered = renderMasterChain(mix, loudAfro.params);
    expect(rendered.analysis.truePeak.truePeakDbtp).toBeLessThanOrEqual(-0.75);
  });

  it('Easy Auto-Master turns both muddy/quiet bedroom mixes AND hot pre-clipped bounces into commercial masters', () => {
    const sr = 48000;
    const N = Math.floor(sr * 1.8);
    const muddyL = new Float32Array(N);
    const muddyR = new Float32Array(N);

    // 1. Quiet (-23 LUFS), muddy (heavy 290 Hz), out-of-phase bass bedroom bounce
    for (let i = 0; i < N; i++) {
      const t = i / sr;
      const outOfPhaseSub = 0.045 * Math.sin(2 * Math.PI * 72 * t);
      const boxyMud = 0.095 * Math.sin(2 * Math.PI * 290 * t);
      const dullVocal = 0.015 * Math.sin(2 * Math.PI * 2800 * t);
      muddyL[i] = outOfPhaseSub + boxyMud + dullVocal;
      muddyR[i] = -outOfPhaseSub + boxyMud + dullVocal;
    }
    const muddyMix: PlanarAudioBuffer = { sampleRate: sr, duration: 1.8, channels: [muddyL, muddyR] };
    const muddySrcRep = analyzeAudioBuffer(muddyMix);
    const muddyIssues = diagnoseMixHeadroomThieves(muddyMix);

    const solvedMuddy = computeAdaptiveAutoMasterParams({
      genre: 'trap_hiphop',
      intensity: 'balanced_pro',
      source: muddySrcRep,
      issues: muddyIssues,
    });

    expect(solvedMuddy.params.eqPhaseMode).toBe('linear');
    expect(solvedMuddy.params.limiter.oversampling).toBe(16);
    expect(solvedMuddy.params.exportFormat.dither).toBe('tpdf_shaped');
    expect(solvedMuddy.params.inputGainDb).toBeGreaterThan(2.0); // Pre-gain staged up into sweet spot
    expect(solvedMuddy.params.eqBands[2].gainDb).toBeLessThan(-0.8); // Cut 290 Hz mud automatically!
    expect(solvedMuddy.params.eqBands[3].gainDb).toBeGreaterThan(0.5); // Lifted dull vocal clarity!

    const masteredMuddy = renderMasterChain(muddyMix, solvedMuddy.params);
    expect(masteredMuddy.analysis.stereo.lowBandCorrelation).toBeGreaterThan(0.8); // Phase fixed!
    expect(masteredMuddy.analysis.truePeak.truePeakDbtp).toBeLessThanOrEqual(-0.95);

    // 2. Already-hot / pre-clipped FL Studio bounce (-7.8 LUFS, low PLR)
    const hotL = new Float32Array(N);
    const hotR = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const t = i / sr;
      const raw =
        0.6 * Math.sin(2 * Math.PI * 65 * t) +
        0.45 * Math.sin(2 * Math.PI * 440 * t) +
        0.35 * Math.sin(2 * Math.PI * 3000 * t);
      hotL[i] = Math.tanh(raw * 1.8) * 0.72;
      hotR[i] = Math.tanh(raw * 1.8) * 0.72;
    }
    const hotMix: PlanarAudioBuffer = { sampleRate: sr, duration: 1.8, channels: [hotL, hotR] };
    const hotRep = analyzeAudioBuffer(hotMix);

    const solvedHot = computeAdaptiveAutoMasterParams({
      genre: 'trap_hiphop',
      intensity: 'balanced_pro',
      source: hotRep,
    });

    // Backs off input gain and relaxes multiband ratios to 1.22:1 so it NEVER double-squashes!
    expect(solvedHot.params.inputGainDb).toBeLessThan(-2.0);
    expect(solvedHot.params.multiband.bands[0].ratio).toBeLessThanOrEqual(1.25);
  });

  it('Pro Studio Rack Guided Autopilot & AI Signal Assistant share -16.5 LUFS staging, hot-mix protection & 16x True-Peak', () => {
    const sr = 48000;
    const N = Math.floor(sr * 1.5);
    const hotL = new Float32Array(N);
    const hotR = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const t = i / sr;
      const raw =
        0.58 * Math.sin(2 * Math.PI * 65 * t) +
        0.45 * Math.sin(2 * Math.PI * 320 * t) +
        0.3 * Math.sin(2 * Math.PI * 2800 * t);
      hotL[i] = Math.tanh(raw * 1.8) * 0.72;
      hotR[i] = Math.tanh(raw * 1.8) * 0.72;
    }
    const hotMix: PlanarAudioBuffer = { sampleRate: sr, duration: 1.5, channels: [hotL, hotR] };
    const hotRep = analyzeAudioBuffer(hotMix);

    // 1. Pro Studio Guided Autopilot
    const proGuided = buildAutopilotMasteringChain(
      {
        genre: 'trap_hiphop',
        releaseGoal: 'streaming',
        loudnessSlamPct: 70,
        vocalUpfrontPct: 65,
        bassPhonePunchPct: 72,
        chorusBloomWidthPct: 60,
      },
      hotRep,
      null
    );
    expect(proGuided.inputGainDb).toBeLessThan(-2.0);
    expect(proGuided.multiband.bands[0].ratio).toBeLessThanOrEqual(1.25);
    expect(proGuided.limiter.oversampling).toBe(16);
    expect(proGuided.exportFormat.dither).toBe('tpdf_shaped');

    // 2. Pro Studio AI Signal Assistant
    const proAssist = computeSignalDrivenAssistant(hotRep, 'spotify', 'modern_punch');
    expect(proAssist.params.inputGainDb).toBeLessThan(-2.0);
    expect(proAssist.params.multiband.bands[0].ratio).toBeLessThanOrEqual(1.25);
    expect(proAssist.params.limiter.oversampling).toBe(16);
    expect(proAssist.params.exportFormat.dither).toBe('tpdf_shaped');
  });
});
