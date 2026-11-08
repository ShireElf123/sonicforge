import { BiquadFilter, type BiquadCoeffs } from './biquad';
import type { LoudnessMetrics, PlanarAudioBuffer } from './types';

/**
 * Exact ITU-R BS.1770-4 / BS.1770-5 K-weighting filter design for arbitrary sample rates.
 * At fs = 48000 Hz, reproduces ITU-R BS.1770-4 Table 1 coefficients to 14 decimal digits.
 */
export function designKWeightingStage1(sampleRate: number): BiquadCoeffs {
  const f0 = 1681.974450955533;
  const G = 3.999843853973347;
  const Q = 0.7071752369554196;

  const K = Math.tan((Math.PI * f0) / sampleRate);
  const K2 = K * K;
  const Vh = Math.pow(10, G / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);

  const a0 = 1 + K / Q + K2;
  return {
    b0: (Vh + (Vb * K) / Q + K2) / a0,
    b1: (2 * (K2 - Vh)) / a0,
    b2: (Vh - (Vb * K) / Q + K2) / a0,
    a1: (2 * (K2 - 1)) / a0,
    a2: (1 - K / Q + K2) / a0,
  };
}

export function designKWeightingStage2(sampleRate: number): BiquadCoeffs {
  const f0 = 38.13547087602444;
  const Q = 0.5003270373238773;

  const K = Math.tan((Math.PI * f0) / sampleRate);
  const K2 = K * K;
  const a0 = 1 + K / Q + K2;

  return {
    b0: 1 / a0,
    b1: -2 / a0,
    b2: 1 / a0,
    a1: (2 * (K2 - 1)) / a0,
    a2: (1 - K / Q + K2) / a0,
  };
}

function getChannelWeights(channelCount: number): number[] {
  if (channelCount === 1) return [1.0];
  if (channelCount === 2) return [1.0, 1.0];
  if (channelCount === 6) return [1.0, 1.0, 1.0, 0.0, 1.41, 1.41];
  return Array.from({ length: channelCount }, () => 1.0);
}

function energyToLufs(weightedMeanSquareSum: number): number {
  if (weightedMeanSquareSum <= 1e-20) {
    return -Infinity;
  }
  return -0.691 + 10 * Math.log10(weightedMeanSquareSum);
}

function percentileSorted(sorted: number[], p: number): number {
  if (sorted.length === 0) return -Infinity;
  if (sorted.length === 1) return sorted[0];
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const frac = idx - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

/**
 * Measures ITU-R BS.1770-5 / EBU R128 Integrated Loudness (with -70 LUFS absolute
 * and -10 LU relative gating), Momentary Max (400 ms), Short-Term Max (3.0 s),
 * and EBU Tech 3342 Loudness Range (LRA).
 */
export function measureLoudnessBs1770(buffer: PlanarAudioBuffer): LoudnessMetrics {
  const { sampleRate, channels } = buffer;
  const numChannels = channels.length;
  const frameCount = numChannels > 0 ? channels[0].length : 0;

  if (numChannels === 0 || frameCount === 0 || sampleRate <= 0) {
    return {
      integratedLufs: -Infinity,
      shortTermMaxLufs: -Infinity,
      momentaryMaxLufs: -Infinity,
      loudnessRangeLu: 0,
      momentaryTimeline: [],
      shortTermTimeline: [],
    };
  }

  const stage1Coeffs = designKWeightingStage1(sampleRate);
  const stage2Coeffs = designKWeightingStage2(sampleRate);
  const weights = getChannelWeights(numChannels);

  // Build 64-bit cumulative squared K-weighted energy prefix sum across all weighted channels
  // weightedEnergyPrefix[k] = sum_{n=0}^{k-1} sum_{ch} G_ch * y_ch[n]^2
  const weightedPrefix = new Float64Array(frameCount + 1);

  for (let ch = 0; ch < numChannels; ch++) {
    const g = weights[ch];
    if (g === 0) continue;

    const stage1 = new BiquadFilter(stage1Coeffs);
    const stage2 = new BiquadFilter(stage2Coeffs);
    const src = channels[ch];

    for (let i = 0; i < frameCount; i++) {
      const y1 = stage1.processSample(src[i]);
      const y2 = stage2.processSample(y1);
      weightedPrefix[i + 1] += g * y2 * y2;
    }
  }

  // Convert per-sample weighted squared contributions into a true prefix sum
  let running = 0;
  for (let i = 1; i <= frameCount; i++) {
    running += weightedPrefix[i];
    weightedPrefix[i] = running;
  }

  const block400Samples = Math.max(1, Math.round(0.4 * sampleRate));
  const step100Samples = Math.max(1, Math.round(0.1 * sampleRate));
  const block3000Samples = Math.max(1, Math.round(3.0 * sampleRate));

  // 1. 400 ms gating blocks (75% overlap = 100 ms hop)
  const blockEnergies: number[] = [];
  const momentaryTimeline: number[] = [];
  let momentaryMaxLufs = -Infinity;

  if (frameCount < block400Samples) {
    const meanEnergy = weightedPrefix[frameCount] / frameCount;
    const lufs = energyToLufs(meanEnergy);
    blockEnergies.push(meanEnergy);
    momentaryTimeline.push(lufs);
    momentaryMaxLufs = lufs;
  } else {
    for (let start = 0; start + block400Samples <= frameCount; start += step100Samples) {
      const end = start + block400Samples;
      const meanEnergy = (weightedPrefix[end] - weightedPrefix[start]) / block400Samples;
      const lufs = energyToLufs(meanEnergy);
      blockEnergies.push(meanEnergy);
      momentaryTimeline.push(lufs);
      if (lufs > momentaryMaxLufs) {
        momentaryMaxLufs = lufs;
      }
    }
  }

  // Absolute gate: Gamma_a = -70.0 LUFS
  const absGateThresholdLufs = -70.0;
  const absGatedEnergies: number[] = [];
  let absGatedSum = 0;

  for (let j = 0; j < blockEnergies.length; j++) {
    const lufs = momentaryTimeline[j];
    if (lufs > absGateThresholdLufs) {
      absGatedEnergies.push(blockEnergies[j]);
      absGatedSum += blockEnergies[j];
    }
  }

  let integratedLufs = -Infinity;
  if (absGatedEnergies.length > 0) {
    const ungatedAboveAbsMean = absGatedSum / absGatedEnergies.length;
    const relativeGateLufs = energyToLufs(ungatedAboveAbsMean) - 10.0;

    let relGatedSum = 0;
    let relGatedCount = 0;
    for (let k = 0; k < absGatedEnergies.length; k++) {
      const e = absGatedEnergies[k];
      if (energyToLufs(e) > relativeGateLufs) {
        relGatedSum += e;
        relGatedCount++;
      }
    }

    if (relGatedCount > 0) {
      integratedLufs = energyToLufs(relGatedSum / relGatedCount);
    }
  }

  // 2. Short-term (3.0 s window, 100 ms step) & EBU Tech 3342 Loudness Range (LRA)
  const shortTermTimeline: number[] = [];
  const stEnergies: number[] = [];
  let shortTermMaxLufs = -Infinity;

  if (frameCount < block3000Samples) {
    shortTermMaxLufs = momentaryMaxLufs;
    shortTermTimeline.push(momentaryMaxLufs);
  } else {
    for (let start = 0; start + block3000Samples <= frameCount; start += step100Samples) {
      const end = start + block3000Samples;
      const meanEnergy = (weightedPrefix[end] - weightedPrefix[start]) / block3000Samples;
      const lufs = energyToLufs(meanEnergy);
      stEnergies.push(meanEnergy);
      shortTermTimeline.push(lufs);
      if (lufs > shortTermMaxLufs) {
        shortTermMaxLufs = lufs;
      }
    }
  }

  // LRA per EBU Tech 3342: -70 LUFS absolute gate, -20 LU relative gate, P95 - P10
  let loudnessRangeLu = 0;
  if (stEnergies.length >= 2) {
    const stAbsGated: number[] = [];
    let stAbsSum = 0;
    for (let j = 0; j < stEnergies.length; j++) {
      if (shortTermTimeline[j] >= -70.0) {
        stAbsGated.push(stEnergies[j]);
        stAbsSum += stEnergies[j];
      }
    }

    if (stAbsGated.length >= 2) {
      const stRelGateLufs = energyToLufs(stAbsSum / stAbsGated.length) - 20.0;
      const stRelGatedLufs: number[] = [];
      for (const e of stAbsGated) {
        const l = energyToLufs(e);
        if (l >= stRelGateLufs) {
          stRelGatedLufs.push(l);
        }
      }

      if (stRelGatedLufs.length >= 2) {
        stRelGatedLufs.sort((a, b) => a - b);
        const p10 = percentileSorted(stRelGatedLufs, 10);
        const p95 = percentileSorted(stRelGatedLufs, 95);
        loudnessRangeLu = Math.max(0, p95 - p10);
      }
    }
  }

  return {
    integratedLufs,
    shortTermMaxLufs,
    momentaryMaxLufs,
    loudnessRangeLu,
    momentaryTimeline,
    shortTermTimeline,
  };
}
