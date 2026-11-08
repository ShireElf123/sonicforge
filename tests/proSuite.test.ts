import { describe, expect, it } from 'vitest';
import { auditLossyCodecHeadroom } from '../src/dsp/codecSim';
import {
  applyLinearPhaseEq,
  applySpectralStabilizer,
} from '../src/dsp/linearPhaseAndStabilizer';
import { renderMasterChain } from '../src/dsp/processors';
import { createDefaultMasteringParams } from '../src/dsp/profiles';
import { demixStereoToFourStems } from '../src/dsp/stemDemixer';
import { generateStudioSession } from '../src/dsp/synthTestVectors';
import type { EqBandParams } from '../src/dsp/types';
import { encodeWav, verifyExportedWav } from '../src/dsp/wav';

describe('2049-Tap Zero-Phase Linear FIR Mastering EQ', () => {
  it('boosts target frequency accurately while preserving 0.0° phase alignment on untouched frequencies', () => {
    const sr = 48000;
    const n = sr; // 1.0 sec
    const left = new Float32Array(n);
    const right = new Float32Array(n);

    // Composite signal: 200 Hz untouched fundamental + 2000 Hz target bell frequency
    for (let i = 0; i < n; i++) {
      const s200 = 0.25 * Math.sin((2 * Math.PI * 200 * i) / sr);
      const s2k = 0.2 * Math.sin((2 * Math.PI * 2000 * i) / sr);
      left[i] = s200 + s2k;
      right[i] = s200 + s2k;
    }

    const dryCopy = new Float32Array(left);
    const bands: EqBandParams[] = [
      {
        id: 'bell_2k',
        label: '2k Presence',
        enabled: true,
        type: 'peaking',
        freqHz: 2000,
        gainDb: 6.0,
        q: 2.2,
        placement: 'stereo',
      },
    ];

    applyLinearPhaseEq(left, right, sr, bands);

    // Measure correlation of (wet - dry) against pure 2000 Hz sine in steady-state middle region:
    // Because Linear-Phase FIR has 0.0° phase shift, (wet - dry) is pure in-phase +2000 Hz!
    let dot2k = 0;
    let err200 = 0;
    const lo = Math.floor(n * 0.2);
    const hi = Math.floor(n * 0.8);
    for (let i = lo; i < hi; i++) {
      const delta = left[i] - dryCopy[i];
      const ref2k = Math.sin((2 * Math.PI * 2000 * i) / sr);
      const ref200 = Math.sin((2 * Math.PI * 200 * i) / sr);
      dot2k += delta * ref2k;
      err200 += delta * ref200;
    }

    const ampDelta2k = (2 * dot2k) / (hi - lo);
    const ampLeak200 = Math.abs((2 * err200) / (hi - lo));

    // +6.0 dB on 0.20 amplitude => ~0.399 amplitude => delta amplitude ~ +0.199 in-phase!
    expect(ampDelta2k).toBeGreaterThan(0.185);
    expect(ampDelta2k).toBeLessThan(0.215);
    // Untouched 200 Hz has virtually zero amplitude/phase change (< 0.003)
    expect(ampLeak200).toBeLessThan(0.005);
  });
});

describe('75%-COLA STFT Dynamic Spectral Stabilizer', () => {
  it('dynamically attenuates narrowband harsh resonance while preserving warm tonal fundamentals', () => {
    const sr = 48000;
    const n = sr; // 1.0 sec
    const left = new Float32Array(n);
    const right = new Float32Array(n);

    // Broadband pink-like harmonic bed + harsh +16 dB ringing resonance at 3800 Hz
    for (let i = 0; i < n; i++) {
      let bed = 0;
      for (const f of [180, 360, 720, 1400, 2200, 6200, 9000]) {
        bed += 0.03 * Math.sin((2 * Math.PI * f * i) / sr);
      }
      const harshSpike = 0.32 * Math.sin((2 * Math.PI * 3800 * i) / sr);
      left[i] = bed + harshSpike;
      right[i] = bed + harshSpike;
    }

    const dryL = new Float32Array(left);

    const attCurve = applySpectralStabilizer(left, right, sr, {
      enabled: true,
      mode: 'tame_harshness',
      amountPct: 80,
      sharpnessPct: 75,
      minFreqHz: 500,
      maxFreqHz: 12000,
      maxReductionDb: 8.0,
    });

    expect(attCurve).toHaveLength(64);
    expect(Math.max(...attCurve)).toBeGreaterThan(1.5);

    // Verify 3800 Hz energy dropped significantly while 180 Hz fundamental stayed intact
    let dry3800 = 0;
    let wet3800 = 0;
    let dry180 = 0;
    let wet180 = 0;
    const lo = Math.floor(n * 0.2);
    const hi = Math.floor(n * 0.85);
    for (let i = lo; i < hi; i++) {
      const c38 = Math.sin((2 * Math.PI * 3800 * i) / sr);
      const c18 = Math.sin((2 * Math.PI * 180 * i) / sr);
      dry3800 += dryL[i] * c38;
      wet3800 += left[i] * c38;
      dry180 += dryL[i] * c18;
      wet180 += left[i] * c18;
    }

    const reduction3800Db = 20 * Math.log10(Math.abs(dry3800) / Math.abs(wet3800));
    const change180Db = Math.abs(20 * Math.log10(Math.abs(dry180) / Math.abs(wet180)));

    expect(reduction3800Db).toBeGreaterThan(3.0);
    expect(change180Db).toBeLessThan(0.15);
  });
});

describe('Local Partition-of-Unity 4-Stem HPSS + M/S Demixer', () => {
  it('separates stereo mix into 4 stems whose unity sum nulls against the original to < -85 dB', () => {
    const session = generateStudioSession('neon_horizon_mix', 48000, 1);
    const demixed = demixStereoToFourStems(session.stereoMix);

    expect(demixed.reconstructionNullDb).toBeLessThan(-85);
    expect(demixed.stems.drums.channels[0].length).toBe(session.stereoMix.channels[0].length);
    expect(demixed.stems.bass.channels[0].length).toBe(session.stereoMix.channels[0].length);
    expect(demixed.stems.vocals.channels[0].length).toBe(session.stereoMix.channels[0].length);
    expect(demixed.stems.instruments.channels[0].length).toBe(session.stereoMix.channels[0].length);
  });
});

describe('IRC-V Transient/Sustain Split Club Master, Codec Audit & RIFF INFO Metadata', () => {
  it('renders -9.0 LUFS / -0.8 dBTP IRC-V club master with 8x True-Peak compliance, codec audit, and ISRC metadata', () => {
    const session = generateStudioSession('neon_horizon_mix', 48000, 2);
    const params = createDefaultMasteringParams('club_loud');
    params.limiter.oversampling = 8;
    params.limiter.releaseMode = 'irc_transient';
    params.limiter.transientEmphasisPct = 45;

    const rendered = renderMasterChain(session.stereoMix, params);
    expect(rendered.analysis.truePeak.truePeakDbtp).toBeLessThanOrEqual(-0.75);
    expect(rendered.analysis.truePeak.ceilingViolationCount).toBe(0);

    const codecs = auditLossyCodecHeadroom(rendered.buffer);
    expect(codecs).toHaveLength(3);
    // Because ceiling is safely -0.8 dBTP, AAC 256 kbps maintains safe headroom
    expect(codecs[0].id).toBe('aac_256');
    expect(codecs[0].artifactSnrDb).toBeGreaterThan(25);

    const wav = encodeWav(rendered.buffer, {
      bitDepth: 24,
      dither: 'tpdf_shaped',
      metadata: {
        title: 'Neon Horizon',
        artist: 'SonicForge Lab',
        album: 'Pro Benchmark EP',
        isrc: 'ZAA012600001',
        comment: 'Verified ITU-R BS.1770-5',
      },
    });

    const verified = verifyExportedWav(wav, params.limiter.ceilingDbtp, 8);
    expect(verified.validRiffHeader).toBe(true);
    expect(verified.hasInfoMetadata).toBe(true);
    expect(verified.ceilingCompliant).toBe(true);
  });
});
