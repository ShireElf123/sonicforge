import {
  BiquadFilter,
  designButterworthHighpass2,
  designButterworthLowpass2,
  designEqBiquad,
} from './biquad';
import type { MasteringChainParams, MixDoctorIssue, PlanarAudioBuffer } from './types';

function formatSec(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`;
}

/**
 * Time-Stamped "Mix Doctor" Headroom Thief Detector.
 * Scans 250 ms frames across the mix to pinpoint exact moments stealing loudness,
 * causing phase cancellation on phones, or piercing ears — explained in plain English.
 */
export function diagnoseMixHeadroomThieves(buffer: PlanarAudioBuffer): MixDoctorIssue[] {
  const sr = buffer.sampleRate;
  const left = buffer.channels[0];
  const right = buffer.channels[1] ?? left;
  const n = left?.length ?? 0;
  if (n < sr * 0.4) return [];

  const frameSamples = Math.max(1024, Math.round(sr * 0.25));
  const numFrames = Math.floor(n / frameSamples);
  if (numFrames < 2) return [];

  const stSub = new BiquadFilter(designButterworthLowpass2(34, sr));
  const bassLp = designButterworthLowpass2(140, sr);
  const stBassL = new BiquadFilter(bassLp);
  const stBassR = new BiquadFilter(bassLp);
  const stMud = new BiquadFilter(designEqBiquad('peaking', 290, sr, 12, 1.8));
  const stHarsh = new BiquadFilter(designButterworthHighpass2(3600, sr));

  let sumRmsSq = 0;
  let worstCrestRatio = 0;
  let worstCrestFrame = -1;
  let worstPhaseCorr = 1.0;
  let worstPhaseFrame = -1;
  let worstMudRatio = 0;
  let worstMudFrame = -1;
  let worstHarshRatio = 0;
  let worstHarshFrame = -1;
  let worstSubRatio = 0;
  let worstSubFrame = -1;

  const frameRms = new Float32Array(numFrames);
  const framePeak = new Float32Array(numFrames);

  for (let f = 0; f < numFrames; f++) {
    const start = f * frameSamples;
    const end = start + frameSamples;

    let sqAll = 0;
    let peak = 0;
    let sqBassL = 0;
    let sqBassR = 0;
    let crossBass = 0;
    let sqMudDiff = 0;
    let sqHarsh = 0;
    let sqSub = 0;

    for (let i = start; i < end; i++) {
      const l = left[i];
      const r = right[i];
      const m = 0.5 * (l + r);
      const ap = Math.max(Math.abs(l), Math.abs(r));
      if (ap > peak) peak = ap;
      sqAll += 0.5 * (l * l + r * r);

      const bl = stBassL.processSample(l);
      const br = stBassR.processSample(r);
      sqBassL += bl * bl;
      sqBassR += br * br;
      crossBass += bl * br;

      const mudBoosted = stMud.processSample(m);
      const mudOnly = mudBoosted - m;
      sqMudDiff += mudOnly * mudOnly;

      const hi = stHarsh.processSample(m);
      sqHarsh += hi * hi;

      const sub = stSub.processSample(m);
      sqSub += sub * sub;
    }

    const rms = Math.sqrt(sqAll / frameSamples);
    frameRms[f] = rms;
    framePeak[f] = peak;
    sumRmsSq += rms * rms;

    if (rms > 0.015) {
      const crest = peak / (rms + 1e-9);
      if (crest > worstCrestRatio) {
        worstCrestRatio = crest;
        worstCrestFrame = f;
      }

      const bassDenom = Math.sqrt(sqBassL * sqBassR);
      if (bassDenom > 1e-6 * frameSamples) {
        const corr = crossBass / bassDenom;
        if (corr < worstPhaseCorr) {
          worstPhaseCorr = corr;
          worstPhaseFrame = f;
        }
      }

      const mudRatio = sqMudDiff / (sqAll + 1e-9);
      if (mudRatio > worstMudRatio) {
        worstMudRatio = mudRatio;
        worstMudFrame = f;
      }

      const harshRatio = sqHarsh / (sqAll + 1e-9);
      if (harshRatio > worstHarshRatio) {
        worstHarshRatio = harshRatio;
        worstHarshFrame = f;
      }

      const subRatio = sqSub / (sqAll + 1e-9);
      if (subRatio > worstSubRatio) {
        worstSubRatio = subRatio;
        worstSubFrame = f;
      }
    }
  }

  const globalRms = Math.sqrt(sumRmsSq / Math.max(1, numFrames));
  const issues: MixDoctorIssue[] = [];
  const durFrame = frameSamples / sr;

  // 1. Transient Headroom Thief (uncontrolled drum/vocal spike eating >11.5 dB crest in a single frame)
  if (worstCrestFrame >= 0 && worstCrestRatio > 3.7 && globalRms > 0.01) {
    const tSec = worstCrestFrame * durFrame;
    const crestDb = 20 * Math.log10(worstCrestRatio);
    const stolenDb = Math.max(1.2, crestDb - 10.5);
    issues.push({
      id: 'issue_headroom_thief',
      timestampSec: Number(tSec.toFixed(2)),
      endSec: Number((tSec + Math.max(1.2, durFrame * 3)).toFixed(2)),
      category: 'headroom_thief',
      severity: crestDb > 13.5 ? 'high' : 'medium',
      title: `Uncontrolled Peak Spike at ${formatSec(tSec)}`,
      plainEnglishWhy: `A sharp drum/snare spike jumps ${crestDb.toFixed(1)} dB above the music right here, forcing the limiter to duck your whole track and stealing ~${stolenDb.toFixed(1)} dB of clean loudness.`,
      dawMixAdvice: `In your DAW at ${formatSec(tSec)}, put a soft clipper on your Drum/Snare bus shaving 1.5–2.5 dB off the dry transient.`,
      measuredValueLabel: `${crestDb.toFixed(1)} dB Local Crest`,
      autoFixLabel: 'Enable 4x Soft Clipper to Shave Peak Cleanly',
    });
  }

  // 2. Sub-Bass Phase Cancellation (< 140 Hz stereo bass fighting itself)
  if (worstPhaseFrame >= 0 && worstPhaseCorr < 0.55) {
    const tSec = worstPhaseFrame * durFrame;
    issues.push({
      id: 'issue_phase_cancel',
      timestampSec: Number(tSec.toFixed(2)),
      endSec: Number((tSec + 1.5).toFixed(2)),
      category: 'phase_cancel',
      severity: worstPhaseCorr < 0.2 ? 'high' : 'medium',
      title: `Wide / Out-of-Phase Bass at ${formatSec(tSec)}`,
      plainEnglishWhy: `Left and Right bass speakers are pushing in opposite directions here (correlation ${worstPhaseCorr.toFixed(2)}). On club systems, Bluetooth speakers, and phones, your 808/bass will lose punch or disappear.`,
      dawMixAdvice: `Remove stereo chorus/widener plugins below 135 Hz on your 808 or synth bass at ${formatSec(tSec)}.`,
      measuredValueLabel: `${worstPhaseCorr.toFixed(2)} Bass Phase`,
      autoFixLabel: 'Lock Bass Mono Below 135 Hz',
    });
  }

  // 3. Low-Mid Boxiness / Mud Buildup around 250-350 Hz
  if (worstMudFrame >= 0 && worstMudRatio > 1.35) {
    const tSec = worstMudFrame * durFrame;
    issues.push({
      id: 'issue_mud_buildup',
      timestampSec: Number(tSec.toFixed(2)),
      endSec: Number((tSec + 1.5).toFixed(2)),
      category: 'mud_buildup',
      severity: worstMudRatio > 2.1 ? 'high' : 'medium',
      title: `Boxy Low-Mid Buildup (~290 Hz) at ${formatSec(tSec)}`,
      plainEnglishWhy: `Chords, bass harmonics, and lower vocals pile up around 290 Hz here, making the mix sound "boxy" or muffled and eating limiter headroom.`,
      dawMixAdvice: `Cut 2–3 dB around 280–320 Hz on rhythm guitars, pads, or keys at ${formatSec(tSec)} so vocals breathe.`,
      measuredValueLabel: `+${(10 * Math.log10(worstMudRatio)).toFixed(1)} dB @ 290 Hz`,
      autoFixLabel: 'Apply Smart Mid Dynamic EQ Cut @ 290 Hz',
    });
  }

  // 4. Harsh Sibilance / Hi-Hat Spike (> 3.6 kHz)
  if (worstHarshFrame >= 0 && worstHarshRatio > 0.24) {
    const tSec = worstHarshFrame * durFrame;
    issues.push({
      id: 'issue_harsh_spike',
      timestampSec: Number(tSec.toFixed(2)),
      endSec: Number((tSec + 1.4).toFixed(2)),
      category: 'harsh_spike',
      severity: worstHarshRatio > 0.38 ? 'high' : 'medium',
      title: `Sharp Vocal Sibilance / Hi-Hat Glare at ${formatSec(tSec)}`,
      plainEnglishWhy: `High frequencies (3.6–9 kHz) spike sharply here. When turned up loud on AirPods or car stereos, this moment can feel piercing on the ears.`,
      dawMixAdvice: `Add a de-esser on lead vocals or tame hi-hat/cymbal brightness by 1.5 dB around 6 kHz at ${formatSec(tSec)}.`,
      measuredValueLabel: `${Math.round(worstHarshRatio * 100)}% High-Freq Energy`,
      autoFixLabel: 'Engage Spectral De-Harsh Stabilizer',
    });
  }

  // 5. Subsonic Rumble (< 34 Hz invisible energy eating headroom)
  if (worstSubFrame >= 0 && worstSubRatio > 0.16) {
    const tSec = worstSubFrame * durFrame;
    issues.push({
      id: 'issue_sub_rumble',
      timestampSec: Number(tSec.toFixed(2)),
      endSec: Number((tSec + 1.5).toFixed(2)),
      category: 'sub_rumble',
      severity: 'medium',
      title: `Invisible Sub-Rumble (<32 Hz) at ${formatSec(tSec)}`,
      plainEnglishWhy: `Deep sub-32 Hz rumble that most speakers can't even play is eating up your limiter ceiling here, stopping the rest of your song from getting loud.`,
      dawMixAdvice: `Place a gentle 28–32 Hz high-pass filter on kick/808 and mic tracks to clear inaudible rumble.`,
      measuredValueLabel: `${Math.round(worstSubRatio * 100)}% Sub-34Hz Load`,
      autoFixLabel: 'Tighten 30 Hz Subsonic High-Pass Filter',
    });
  }

  return issues;
}

/**
 * Applies a targeted 1-click mastering chain fix for a detected Mix Doctor issue.
 */
export function applyMixDoctorAutoFix(
  current: MasteringChainParams,
  issue: MixDoctorIssue
): MasteringChainParams {
  const next: MasteringChainParams = JSON.parse(JSON.stringify(current));

  switch (issue.category) {
    case 'headroom_thief':
      next.limiter.softClipEnabled = true;
      next.limiter.softClipMode = 'crisp_cubic';
      next.limiter.softClipThresholdDb = -1.7;
      next.limiter.softClipAmountPct = Math.max(next.limiter.softClipAmountPct ?? 0, 50);
      next.limiter.releaseMode = 'irc_spectral';
      next.limiter.oversampling = Math.max(next.limiter.oversampling, 8) as 4 | 8 | 16;
      break;

    case 'phase_cancel':
      next.stereo.enabled = true;
      next.stereo.bassMonoEnabled = true;
      next.stereo.bassMonoHz = Math.max(next.stereo.bassMonoHz, 138);
      break;

    case 'mud_buildup':
      next.eqEnabled = true;
      if (next.eqBands[2]) {
        next.eqBands[2].enabled = true;
        next.eqBands[2].freqHz = 290;
        next.eqBands[2].q = 1.65;
        next.eqBands[2].placement = 'mid';
        next.eqBands[2].dynEnabled = true;
        next.eqBands[2].dynThresholdDb = -21;
        next.eqBands[2].dynRangeDb = -3.5;
      }
      break;

    case 'harsh_spike':
      next.stabilizer.enabled = true;
      next.stabilizer.mode = 'tame_harshness';
      next.stabilizer.amountPct = Math.max(next.stabilizer.amountPct, 48);
      next.stabilizer.maxReductionDb = Math.max(next.stabilizer.maxReductionDb, 5.0);
      break;

    case 'sub_rumble':
      next.eqEnabled = true;
      next.dcBlockEnabled = true;
      if (next.eqBands[0]) {
        next.eqBands[0].enabled = true;
        next.eqBands[0].type = 'highpass';
        next.eqBands[0].freqHz = Math.max(next.eqBands[0].freqHz, 30);
      }
      break;
  }

  return next;
}
