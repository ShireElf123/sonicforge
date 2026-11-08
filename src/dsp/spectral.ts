import { BiquadFilter, designButterworthHighpass2, designButterworthLowpass2 } from './biquad';
import type {
  DynamicsMetrics,
  PlanarAudioBuffer,
  SpectralBandSummary,
  SpectralMetrics,
  SpectrumBinPoint,
  StereoMetrics,
  TonalBandId,
  WaveformEnvelopePoint,
} from './types';

const FFT_SIZE = 4096;

/**
 * In-place Radix-2 Cooley-Tukey complex FFT.
 */
export function radix2FftInPlace(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  let j = 0;
  for (let i = 1; i < n; i++) {
    let bit = n >> 1;
    while (j & bit) {
      j ^= bit;
      bit >>= 1;
    }
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wlenRe = Math.cos(ang);
    const wlenIm = Math.sin(ang);
    const half = len >> 1;

    for (let i = 0; i < n; i += len) {
      let wRe = 1.0;
      let wIm = 0.0;
      for (let k = 0; k < half; k++) {
        const uRe = re[i + k];
        const uIm = im[i + k];
        const vIdx = i + k + half;
        const vRe = re[vIdx] * wRe - im[vIdx] * wIm;
        const vIm = re[vIdx] * wIm + im[vIdx] * wRe;

        re[i + k] = uRe + vRe;
        im[i + k] = uIm + vIm;
        re[vIdx] = uRe - vRe;
        im[vIdx] = uIm - vIm;

        const nextWRe = wRe * wlenRe - wIm * wlenIm;
        wIm = wRe * wlenIm + wIm * wlenRe;
        wRe = nextWRe;
      }
    }
  }
}

const hannWindow = (() => {
  const w = new Float64Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) {
    w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1)));
  }
  return w;
})();

const TONAL_BAND_DEFS: Array<{
  id: TonalBandId;
  label: string;
  rangeHz: [number, number];
}> = [
  { id: 'sub', label: 'Sub', rangeHz: [20, 60] },
  { id: 'low', label: 'Low', rangeHz: [60, 250] },
  { id: 'lowMid', label: 'Low-Mid', rangeHz: [250, 1000] },
  { id: 'highMid', label: 'High-Mid', rangeHz: [1000, 4000] },
  { id: 'high', label: 'High', rangeHz: [4000, 10000] },
  { id: 'air', label: 'Air', rangeHz: [10000, 20000] },
];

export function measureSpectrum(buffer: PlanarAudioBuffer): SpectralMetrics {
  const { sampleRate, channels } = buffer;
  const numCh = channels.length;
  const frameCount = numCh > 0 ? channels[0].length : 0;
  const halfBins = FFT_SIZE >> 1;

  if (numCh === 0 || frameCount === 0 || sampleRate <= 0) {
    return {
      bins: [],
      bands: TONAL_BAND_DEFS.map((b) => ({
        ...b,
        energyDb: -120,
        relativeDb: 0,
      })),
      centroidHz: 0,
      spectralTiltDbPerOct: 0,
    };
  }

  // Up to 96 evenly distributed analysis windows across the full track
  const maxFrames = 96;
  const availableStarts = Math.max(1, frameCount - FFT_SIZE);
  const numWindows = frameCount <= FFT_SIZE ? 1 : Math.min(maxFrames, Math.max(8, Math.floor(frameCount / (FFT_SIZE >> 1))));
  const hop = numWindows > 1 ? Math.floor(availableStarts / (numWindows - 1)) : 0;

  const accumMagSq = new Float64Array(halfBins + 1);
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  // Coherent gain of Hann window is 0.5; single-sided scale = 2 / (FFT_SIZE * 0.5) = 4 / FFT_SIZE
  const normScale = 4.0 / FFT_SIZE;
  const normScaleSq = normScale * normScale;

  let activeWindowCount = 0;

  for (let w = 0; w < numWindows; w++) {
    const start = w * hop;
    let frameEnergy = 0;

    for (let i = 0; i < FFT_SIZE; i++) {
      const idx = start + i;
      let mono = 0;
      if (idx < frameCount) {
        for (let ch = 0; ch < numCh; ch++) {
          mono += channels[ch][idx];
        }
        mono /= numCh;
      }
      frameEnergy += mono * mono;
      re[i] = mono * hannWindow[i];
      im[i] = 0;
    }

    const frameRms = Math.sqrt(frameEnergy / FFT_SIZE);
    // Skip near-silent intro/outro frames unless the entire track is silent
    if (frameRms < 1e-4 && w < numWindows - 1 && activeWindowCount > 0) {
      continue;
    }

    radix2FftInPlace(re, im);
    for (let k = 0; k <= halfBins; k++) {
      accumMagSq[k] += (re[k] * re[k] + im[k] * im[k]) * normScaleSq;
    }
    activeWindowCount++;
  }

  if (activeWindowCount === 0) {
    // Fallback: process first window even if very quiet
    for (let i = 0; i < FFT_SIZE; i++) {
      let mono = 0;
      if (i < frameCount) {
        for (let ch = 0; ch < numCh; ch++) mono += channels[ch][i];
        mono /= numCh;
      }
      re[i] = mono * hannWindow[i];
      im[i] = 0;
    }
    radix2FftInPlace(re, im);
    for (let k = 0; k <= halfBins; k++) {
      accumMagSq[k] = (re[k] * re[k] + im[k] * im[k]) * normScaleSq;
    }
    activeWindowCount = 1;
  }

  for (let k = 0; k <= halfBins; k++) {
    accumMagSq[k] /= activeWindowCount;
  }

  const binHz = sampleRate / FFT_SIZE;

  // Spectral centroid (20 Hz .. 20 kHz)
  let weightedFreqSum = 0;
  let magSum = 0;
  const maxBin = Math.min(halfBins, Math.floor(20000 / binHz));
  const minBin = Math.max(1, Math.ceil(20 / binHz));
  for (let k = minBin; k <= maxBin; k++) {
    const mag = Math.sqrt(accumMagSq[k]);
    weightedFreqSum += k * binHz * mag;
    magSum += mag;
  }
  const centroidHz = magSum > 1e-18 ? weightedFreqSum / magSum : 0;

  // 64 logarithmically spaced bins from 20 Hz to min(20000, Nyquist * 0.98)
  const numLogBins = 64;
  const minF = 20;
  const maxF = Math.min(20000, sampleRate * 0.49);
  const rawBinDbs: Array<{ freqHz: number; db: number }> = [];

  for (let b = 0; b < numLogBins; b++) {
    const fLo = minF * Math.pow(maxF / minF, b / numLogBins);
    const fHi = minF * Math.pow(maxF / minF, (b + 1) / numLogBins);
    const fCenter = Math.sqrt(fLo * fHi);

    const kLo = Math.max(1, Math.floor(fLo / binHz));
    const kHi = Math.min(halfBins, Math.max(kLo, Math.ceil(fHi / binHz)));

    let sumPower = 0;
    let count = 0;
    for (let k = kLo; k <= kHi; k++) {
      sumPower += accumMagSq[k];
      count++;
    }
    const meanPower = count > 0 ? sumPower / count : 0;
    const db = meanPower > 1e-20 ? 10 * Math.log10(meanPower) : -120;
    rawBinDbs.push({ freqHz: fCenter, db });
  }

  // Reference anchor: mean dB across 200 Hz .. 4000 Hz so tonal shape compares independent of overall loudness
  const midRefBins = rawBinDbs.filter((p) => p.freqHz >= 200 && p.freqHz <= 4000 && p.db > -115);
  const anchorDb =
    midRefBins.length > 0
      ? midRefBins.reduce((s, p) => s + p.db, 0) / midRefBins.length
      : -60;

  const bins: SpectrumBinPoint[] = rawBinDbs.map((p) => ({
    freqHz: p.freqHz,
    db: p.db,
    relativeDb: p.db > -115 ? p.db - anchorDb : -60,
  }));

  // Linear regression in log2(f) vs dB (60 Hz .. 16 kHz) for spectral tilt (dB/octave)
  const tiltPoints = rawBinDbs.filter((p) => p.freqHz >= 60 && p.freqHz <= 16000 && p.db > -110);
  let spectralTiltDbPerOct = 0;
  if (tiltPoints.length >= 4) {
    let sumX = 0;
    let sumY = 0;
    for (const p of tiltPoints) {
      sumX += Math.log2(p.freqHz / 1000);
      sumY += p.db;
    }
    const meanX = sumX / tiltPoints.length;
    const meanY = sumY / tiltPoints.length;
    let num = 0;
    let den = 0;
    for (const p of tiltPoints) {
      const dx = Math.log2(p.freqHz / 1000) - meanX;
      num += dx * (p.db - meanY);
      den += dx * dx;
    }
    if (den > 1e-12) {
      spectralTiltDbPerOct = num / den;
    }
  }

  // 6 Mastering Tonal Bands (integrated band power in dBFS + relative to mid-band anchor)
  const rawBands = TONAL_BAND_DEFS.map((def) => {
    const [fLo, fHi] = def.rangeHz;
    const kLo = Math.max(1, Math.ceil(fLo / binHz));
    const kHi = Math.min(halfBins, Math.floor(Math.min(fHi, sampleRate * 0.495) / binHz));
    let bandPower = 0;
    for (let k = kLo; k <= kHi; k++) {
      bandPower += accumMagSq[k];
    }
    // Convert single-sided FFT power sum (where sine amplitude A gave A^2) to RMS power = 0.5 * sum
    const rmsPower = 0.5 * bandPower;
    const energyDb = rmsPower > 1e-20 ? 10 * Math.log10(rmsPower) : -120;
    return { ...def, energyDb };
  });

  const activeBandMean =
    rawBands.filter((b) => b.energyDb > -115).reduce((s, b) => s + b.energyDb, 0) /
    Math.max(1, rawBands.filter((b) => b.energyDb > -115).length);

  const bands: SpectralBandSummary[] = rawBands.map((b) => ({
    ...b,
    relativeDb: b.energyDb > -115 ? b.energyDb - activeBandMean : -60,
  }));

  return {
    bins,
    bands,
    centroidHz,
    spectralTiltDbPerOct,
  };
}

function pearsonCorrelation(a: Float32Array, b: Float32Array): number {
  let sumAB = 0;
  let sumA2 = 0;
  let sumB2 = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i];
    const y = b[i];
    sumAB += x * y;
    sumA2 += x * x;
    sumB2 += y * y;
  }
  const denom = Math.sqrt(sumA2 * sumB2);
  if (denom <= 1e-18) return 1.0;
  return Math.max(-1, Math.min(1, sumAB / denom));
}

export function measureStereoField(buffer: PlanarAudioBuffer): StereoMetrics {
  const { sampleRate, channels } = buffer;
  const n = channels.length > 0 ? channels[0].length : 0;

  if (channels.length === 0 || n === 0) {
    return {
      correlation: 1,
      lowBandCorrelation: 1,
      midBandCorrelation: 1,
      highBandCorrelation: 1,
      midSideRatioDb: 60,
      balanceDb: 0,
      monoFoldDownLossDb: 0,
      vectorscopePoints: [],
    };
  }

  if (channels.length === 1) {
    const mono = channels[0];
    const pts: Array<{ m: number; s: number }> = [];
    const step = Math.max(1, Math.floor(n / 200));
    for (let i = 0; i < n && pts.length < 200; i += step) {
      pts.push({ m: Math.max(-1, Math.min(1, mono[i])), s: 0 });
    }
    return {
      correlation: 1.0,
      lowBandCorrelation: 1.0,
      midBandCorrelation: 1.0,
      highBandCorrelation: 1.0,
      midSideRatioDb: 60,
      balanceDb: 0,
      monoFoldDownLossDb: 0,
      vectorscopePoints: pts,
    };
  }

  const left = channels[0];
  const right = channels[1];

  const correlation = pearsonCorrelation(left, right);

  // Sub/Low (<150 Hz), Mid (150-2500 Hz), High (>2500 Hz) correlation
  const lowL = new Float32Array(left);
  const lowR = new Float32Array(right);
  new BiquadFilter(designButterworthLowpass2(150, sampleRate)).processInPlace(lowL);
  new BiquadFilter(designButterworthLowpass2(150, sampleRate)).processInPlace(lowR);
  const lowBandCorrelation = pearsonCorrelation(lowL, lowR);

  const highL = new Float32Array(left);
  const highR = new Float32Array(right);
  new BiquadFilter(designButterworthHighpass2(2500, sampleRate)).processInPlace(highL);
  new BiquadFilter(designButterworthHighpass2(2500, sampleRate)).processInPlace(highR);
  const highBandCorrelation = pearsonCorrelation(highL, highR);

  const midL = new Float32Array(n);
  const midR = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    midL[i] = left[i] - lowL[i] - highL[i];
    midR[i] = right[i] - lowR[i] - highR[i];
  }
  const midBandCorrelation = pearsonCorrelation(midL, midR);

  let sumL2 = 0;
  let sumR2 = 0;
  let sumMid2 = 0;
  let sumSide2 = 0;
  let peakAbs = 0;

  for (let i = 0; i < n; i++) {
    const l = left[i];
    const r = right[i];
    sumL2 += l * l;
    sumR2 += r * r;
    const m = 0.5 * (l + r);
    const s = 0.5 * (l - r);
    sumMid2 += m * m;
    sumSide2 += s * s;
    const a = Math.max(Math.abs(l), Math.abs(r));
    if (a > peakAbs) peakAbs = a;
  }

  const balanceDb =
    sumL2 > 1e-18 && sumR2 > 1e-18 ? 10 * Math.log10(sumL2 / sumR2) : 0;

  const midSideRatioDb =
    sumSide2 > 1e-18
      ? Math.max(-40, Math.min(60, 10 * Math.log10(Math.max(1e-18, sumMid2) / sumSide2)))
      : 60;

  // Average stereo channel power vs mono fold-down (0.5*(L+R))^2:
  // In-phase L===R => avgStereoPower = L^2, sumMid2 = L^2 => 0.0 dB loss!
  // Uncorrelated => sumMid2 = 0.5 * avgStereoPower => 3.01 dB loss.
  // Out-of-phase => > 6 dB loss.
  const avgStereoEnergy = 0.5 * (sumL2 + sumR2);
  const monoFoldDownLossDb =
    avgStereoEnergy > 1e-18 && sumMid2 > 1e-18
      ? Math.max(0, 10 * Math.log10(avgStereoEnergy / sumMid2))
      : avgStereoEnergy > 1e-18
        ? 60
        : 0;

  // Sample 260 real Lissajous coordinates normalized to peak for clean vectorscope display
  const vectorscopePoints: Array<{ m: number; s: number }> = [];
  const norm = peakAbs > 1e-6 ? 1 / peakAbs : 1;
  const maxPts = 260;
  const stride = Math.max(1, Math.floor(n / (maxPts * 2)));

  for (let i = 0; i < n && vectorscopePoints.length < maxPts; i += stride) {
    const l = left[i] * norm;
    const r = right[i] * norm;
    const m = (l + r) * Math.SQRT1_2;
    const s = (l - r) * Math.SQRT1_2;
    if (Math.abs(m) > 0.015 || Math.abs(s) > 0.015) {
      vectorscopePoints.push({
        m: Math.max(-1, Math.min(1, m)),
        s: Math.max(-1, Math.min(1, s)),
      });
    }
  }

  return {
    correlation,
    lowBandCorrelation,
    midBandCorrelation,
    highBandCorrelation,
    midSideRatioDb,
    balanceDb,
    monoFoldDownLossDb,
    vectorscopePoints,
  };
}

export function measureDynamics(
  buffer: PlanarAudioBuffer,
  integratedLufs: number,
  truePeakDbtp: number,
  samplePeakDbfs: number
): DynamicsMetrics {
  const { channels } = buffer;
  const numCh = channels.length;
  const n = numCh > 0 ? channels[0].length : 0;

  if (numCh === 0 || n === 0) {
    return {
      rmsDbfs: -120,
      crestFactorDb: 0,
      plrDb: 0,
      dcOffset: 0,
    };
  }

  let totalSq = 0;
  let totalSum = 0;
  for (let ch = 0; ch < numCh; ch++) {
    const c = channels[ch];
    let chSq = 0;
    let chSum = 0;
    for (let i = 0; i < n; i++) {
      const v = c[i];
      chSq += v * v;
      chSum += v;
    }
    totalSq += chSq;
    totalSum += chSum;
  }

  const totalSamples = numCh * n;
  const meanSq = totalSq / totalSamples;
  const rmsDbfs = meanSq > 1e-24 ? 10 * Math.log10(meanSq) : -120;
  const dcOffset = totalSum / totalSamples;
  const crestFactorDb =
    rmsDbfs > -119 && samplePeakDbfs > -119 ? Math.max(0, samplePeakDbfs - rmsDbfs) : 0;
  const plrDb =
    Number.isFinite(integratedLufs) && truePeakDbtp > -119
      ? truePeakDbtp - integratedLufs
      : crestFactorDb;

  return {
    rmsDbfs,
    crestFactorDb,
    plrDb,
    dcOffset,
  };
}

/**
 * Extracts real multi-bucket min/max/RMS waveform envelope directly from PCM samples.
 */
export function extractWaveformEnvelope(
  buffer: PlanarAudioBuffer,
  bucketCount = 240,
  grTimelineDb?: number[]
): WaveformEnvelopePoint[] {
  const { channels } = buffer;
  const numCh = channels.length;
  const n = numCh > 0 ? channels[0].length : 0;
  if (numCh === 0 || n === 0 || bucketCount <= 0) return [];

  const actualBuckets = Math.min(bucketCount, n);
  const points: WaveformEnvelopePoint[] = [];

  for (let b = 0; b < actualBuckets; b++) {
    const start = Math.floor((b * n) / actualBuckets);
    const end = Math.max(start + 1, Math.floor(((b + 1) * n) / actualBuckets));
    let minVal = 1.0;
    let maxVal = -1.0;
    let sqSum = 0;
    let count = 0;

    for (let i = start; i < end; i++) {
      let mono = 0;
      for (let ch = 0; ch < numCh; ch++) {
        const s = channels[ch][i];
        if (s < minVal) minVal = s;
        if (s > maxVal) maxVal = s;
        mono += s;
      }
      mono /= numCh;
      sqSum += mono * mono;
      count++;
    }

    const grDb =
      grTimelineDb && grTimelineDb.length > 0
        ? grTimelineDb[Math.min(grTimelineDb.length - 1, Math.floor((b * grTimelineDb.length) / actualBuckets))]
        : undefined;

    points.push({
      min: minVal,
      max: maxVal,
      rms: count > 0 ? Math.sqrt(sqSum / count) : 0,
      grDb,
    });
  }

  return points;
}
