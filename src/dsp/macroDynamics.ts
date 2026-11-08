import { BiquadFilter, designButterworthHighpass2 } from './biquad';
import type {
  ArrangementSectionType,
  DetectedSection,
  MacroDynamicsParams,
  PlanarAudioBuffer,
} from './types';

function dbFromRms(rms: number): number {
  return rms > 1e-7 ? 20 * Math.log10(rms) : -96;
}

/**
 * Automatically segments a stereo track into Intro / Verse / Build / Chorus-Drop / Outro
 * using 0.5-second macro-energy & high-frequency density contours.
 */
export function detectArrangementSections(buffer: PlanarAudioBuffer): DetectedSection[] {
  const sr = buffer.sampleRate;
  const left = buffer.channels[0];
  const right = buffer.channels[1] ?? left;
  const n = left?.length ?? 0;
  const dur = n / Math.max(1, sr);

  if (n === 0 || dur < 1.2) {
    return [
      {
        id: 'sec_0',
        type: 'chorus',
        label: 'Full Program',
        startSec: 0,
        endSec: dur,
        rmsDb: -18,
        relativeLiftDb: 0,
      },
    ];
  }

  const winSamples = Math.max(1024, Math.round(sr * 0.5));
  const numWins = Math.max(1, Math.ceil(n / winSamples));
  const winDb = new Float32Array(numWins);
  const winAirRatio = new Float32Array(numWins);

  const airState = new BiquadFilter(designButterworthHighpass2(3800, sr));

  for (let w = 0; w < numWins; w++) {
    const start = w * winSamples;
    const end = Math.min(n, start + winSamples);
    let sqAll = 0;
    let sqAir = 0;
    for (let i = start; i < end; i++) {
      const m = 0.5 * (left[i] + right[i]);
      const s = 0.5 * (left[i] - right[i]);
      const e = m * m + s * s;
      sqAll += e;
      const hi = airState.processSample(m);
      sqAir += hi * hi;
    }
    const len = Math.max(1, end - start);
    const rms = Math.sqrt(sqAll / len);
    winDb[w] = dbFromRms(rms);
    winAirRatio[w] = sqAir / (sqAll + 1e-12);
  }

  // Smooth contour with 3-window moving average
  const smoothDb = new Float32Array(numWins);
  for (let w = 0; w < numWins; w++) {
    const a = winDb[Math.max(0, w - 1)];
    const b = winDb[w];
    const c = winDb[Math.min(numWins - 1, w + 1)];
    smoothDb[w] = 0.25 * a + 0.5 * b + 0.25 * c + winAirRatio[w] * 2.5;
  }

  const activeVals = Array.from(smoothDb).filter((v) => v > -65).sort((a, b) => a - b);
  if (activeVals.length < 3) {
    return [
      {
        id: 'sec_0',
        type: 'verse',
        label: 'Main Section',
        startSec: 0,
        endSec: dur,
        rmsDb: smoothDb[0] ?? -20,
        relativeLiftDb: 0,
      },
    ];
  }

  const medianDb = activeVals[Math.floor(activeVals.length * 0.5)];
  const chorusThreshDb = activeVals[Math.floor(activeVals.length * 0.68)];
  const quietThreshDb = activeVals[Math.floor(activeVals.length * 0.22)];

  const rawTypes: ArrangementSectionType[] = new Array(numWins);
  for (let w = 0; w < numWins; w++) {
    const relPos = w / Math.max(1, numWins - 1);
    const val = smoothDb[w];
    if (relPos < 0.12 && val <= quietThreshDb + 1.2) {
      rawTypes[w] = 'intro';
    } else if (relPos > 0.88 && val <= quietThreshDb + 1.5) {
      rawTypes[w] = 'outro';
    } else if (val >= Math.max(chorusThreshDb, medianDb + 0.8)) {
      rawTypes[w] = 'chorus';
    } else if (w < numWins - 1 && smoothDb[w + 1] - val > 1.8) {
      rawTypes[w] = 'build';
    } else {
      rawTypes[w] = 'verse';
    }
  }

  // Merge contiguous windows of the same type (and absorb 1-window blips < 1.0s)
  for (let w = 1; w < numWins - 1; w++) {
    if (rawTypes[w] !== rawTypes[w - 1] && rawTypes[w - 1] === rawTypes[w + 1]) {
      rawTypes[w] = rawTypes[w - 1];
    }
  }

  const sections: DetectedSection[] = [];
  let segStart = 0;
  let verseIdx = 1;
  let chorusIdx = 1;

  const pushSeg = (wStart: number, wEnd: number, type: ArrangementSectionType) => {
    const sSec = (wStart * winSamples) / sr;
    const eSec = Math.min(dur, (wEnd * winSamples) / sr);
    if (eSec - sSec < 0.15) return;
    let sumDb = 0;
    for (let k = wStart; k < wEnd; k++) sumDb += winDb[k];
    const avgDb = sumDb / Math.max(1, wEnd - wStart);

    let label = 'Section';
    if (type === 'intro') label = 'Intro';
    else if (type === 'outro') label = 'Outro';
    else if (type === 'build') label = 'Pre-Chorus / Build';
    else if (type === 'chorus') label = `Chorus / Drop ${chorusIdx++}`;
    else label = `Verse ${verseIdx++}`;

    sections.push({
      id: `sec_${sections.length}`,
      type,
      label,
      startSec: Number(sSec.toFixed(2)),
      endSec: Number(eSec.toFixed(2)),
      rmsDb: Number(avgDb.toFixed(1)),
      relativeLiftDb: Number((avgDb - medianDb).toFixed(2)),
    });
  };

  for (let w = 1; w <= numWins; w++) {
    if (w === numWins || rawTypes[w] !== rawTypes[segStart]) {
      pushSeg(segStart, w, rawTypes[segStart]);
      segStart = w;
    }
  }

  return sections;
}

/**
 * Applies smooth, click-free (350 ms raised-cosine crossfaded) section-aware macro mastering:
 * - Choruses / Drops bloom wider in Side width, gain subtle >9.5 kHz air shimmer, and +lift dB impact.
 * - Verses preserve vocal center intimacy and breathing room so the Chorus hits harder emotionally.
 */
export function applyMacroDynamicAutomation(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
  params: MacroDynamicsParams | undefined,
  sections: DetectedSection[]
): void {
  if (!params || !params.enabled || sections.length === 0) return;

  const n = left.length;
  if (n === 0) return;

  const chorusLiftLin = Math.pow(10, Math.max(0, Math.min(2.5, params.chorusLiftDb)) / 20);
  const verseDipLin = Math.pow(
    10,
    (-0.45 * Math.max(0, Math.min(100, params.verseIntimacyPct))) / 100 / 20
  );
  const chorusWidthRatio = 1 + Math.max(0, Math.min(35, params.chorusWidthBoostPct)) / 100;
  const verseWidthRatio = 1 - (0.08 * Math.max(0, Math.min(100, params.verseIntimacyPct))) / 100;

  // High-frequency >9.5 kHz extractor for Chorus Air Shimmer (differential parallel shelf)
  const airHpCoeffs = designButterworthHighpass2(9500, sampleRate);
  const airStateL = new BiquadFilter(airHpCoeffs);
  const airStateR = new BiquadFilter(airHpCoeffs);
  const maxAirAddGain = Math.pow(10, Math.max(0, Math.min(3.0, params.chorusAirBoostDb)) / 20) - 1;

  // Build piecewise target parameters per section and smooth with 1-pole ~180 ms envelope
  const smoothAlpha = Math.exp(-1 / Math.max(1, sampleRate * 0.18));
  let curGain = 1.0;
  let curWidth = 1.0;
  let curAir = 0.0;

  let secIdx = 0;

  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    while (secIdx < sections.length - 1 && t >= sections[secIdx].endSec) {
      secIdx++;
    }
    const sec = sections[secIdx];

    let tgtGain = 1.0;
    let tgtWidth = 1.0;
    let tgtAir = 0.0;

    if (sec.type === 'chorus') {
      tgtGain = chorusLiftLin;
      tgtWidth = chorusWidthRatio;
      tgtAir = maxAirAddGain;
    } else if (sec.type === 'build') {
      tgtGain = 1.0 + (chorusLiftLin - 1.0) * 0.35;
      tgtWidth = 1.0 + (chorusWidthRatio - 1.0) * 0.35;
      tgtAir = maxAirAddGain * 0.4;
    } else if (sec.type === 'verse') {
      tgtGain = verseDipLin;
      tgtWidth = verseWidthRatio;
      tgtAir = 0.0;
    } else {
      tgtGain = 0.98;
      tgtWidth = 0.96;
      tgtAir = 0.0;
    }

    curGain = smoothAlpha * curGain + (1 - smoothAlpha) * tgtGain;
    curWidth = smoothAlpha * curWidth + (1 - smoothAlpha) * tgtWidth;
    curAir = smoothAlpha * curAir + (1 - smoothAlpha) * tgtAir;

    const hiL = airStateL.processSample(left[i]);
    const hiR = airStateR.processSample(right[i]);

    const lAir = left[i] + curAir * hiL;
    const rAir = right[i] + curAir * hiR;

    const mid = 0.5 * (lAir + rAir) * curGain;
    const side = 0.5 * (lAir - rAir) * curGain * curWidth;

    left[i] = mid + side;
    right[i] = mid - side;
  }
}
