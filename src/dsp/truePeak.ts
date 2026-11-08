import type { PlanarAudioBuffer, TruePeakMetrics } from './types';

function besselI0(x: number): number {
  let sum = 1.0;
  let term = 1.0;
  const halfX = x * 0.5;
  for (let k = 1; k <= 25; k++) {
    term *= (halfX * halfX) / (k * k);
    sum += term;
    if (term < 1e-15 * sum) break;
  }
  return sum;
}

function sinc(x: number): number {
  if (Math.abs(x) < 1e-12) return 1.0;
  const pix = Math.PI * x;
  return Math.sin(pix) / pix;
}

export interface PolyphaseBank {
  factor: 4 | 8;
  tapsPerPhase: number;
  phases: Float64Array[]; // length = factor, each length = tapsPerPhase
}

const cachedBanks = new Map<number, PolyphaseBank>();

/**
 * Builds a polyphase Kaiser-windowed sinc interpolator bank (12 taps/phase:
 * 48 taps for 4x per ITU-R BS.1770-5 Annex 2, 96 taps for 8x).
 */
export function getPolyphaseBank(factor: 4 | 8): PolyphaseBank {
  const existing = cachedBanks.get(factor);
  if (existing) return existing;

  const tapsPerPhase = 12;
  const totalTaps = factor * tapsPerPhase;
  const beta = 7.0;
  const denomI0 = besselI0(beta);
  const centerSample = tapsPerPhase / 2 - 1; // 5 (0-indexed among 0..11)

  const phases: Float64Array[] = [];

  for (let p = 0; p < factor; p++) {
    const coeffs = new Float64Array(tapsPerPhase);
    if (p === 0) {
      // Exact passthrough of integer sample at center delay
      coeffs[centerSample] = 1.0;
    } else {
      const frac = p / factor;
      let dcSum = 0;
      for (let k = 0; k < tapsPerPhase; k++) {
        // Sample offset relative to interpolated instant (centerSample + frac)
        const u = k - (centerSample + frac);
        // Map into overall prototype index [0, totalTaps - 1]
        const protoIdx = (k * factor + (factor - p)) - 0.5;
        const normPos = (2 * protoIdx) / totalTaps - 1;
        const winArg = Math.max(0, 1 - normPos * normPos);
        const w = besselI0(beta * Math.sqrt(winArg)) / denomI0;
        // Cutoff slightly below Nyquist (0.96) to suppress Gibbs ripple while keeping 20kHz @ 44.1/48k flat
        const val = sinc(u * 0.98) * w;
        coeffs[k] = val;
        dcSum += val;
      }
      if (Math.abs(dcSum) > 1e-12) {
        for (let k = 0; k < tapsPerPhase; k++) {
          coeffs[k] /= dcSum;
        }
      }
    }
    phases.push(coeffs);
  }

  const bank: PolyphaseBank = { factor, tapsPerPhase, phases };
  cachedBanks.set(factor, bank);
  return bank;
}

export function linearToDb(amp: number): number {
  if (amp <= 1e-12) return -120;
  return 20 * Math.log10(amp);
}

/**
 * Computes per-sample maximum oversampled true-peak amplitude across all channels.
 * Used by both TruePeakMeter and the Look-Ahead Brickwall True-Peak Limiter.
 */
export function computePerFrameTruePeakLinear(
  channels: Float32Array[],
  factor: 4 | 8 = 4
): Float32Array {
  const numCh = channels.length;
  const n = numCh > 0 ? channels[0].length : 0;
  const out = new Float32Array(n);
  if (numCh === 0 || n === 0) return out;

  const bank = getPolyphaseBank(factor);
  const taps = bank.tapsPerPhase; // 12
  const center = taps / 2 - 1; // 5
  const phases = bank.phases;

  for (let ch = 0; ch < numCh; ch++) {
    const src = channels[ch];
    for (let i = 0; i < n; i++) {
      // Sample peak at i is guaranteed lower bound
      let maxAmp = Math.abs(src[i]);

      // Evaluate fractional phases p = 1..factor-1 between sample i and i+1
      for (let p = 1; p < factor; p++) {
        const h = phases[p];
        let acc = 0;
        for (let k = 0; k < taps; k++) {
          const idx = i - center + k;
          if (idx >= 0 && idx < n) {
            acc += src[idx] * h[k];
          }
        }
        const absVal = Math.abs(acc);
        if (absVal > maxAmp) {
          maxAmp = absVal;
        }
      }

      if (maxAmp > out[i]) {
        out[i] = maxAmp;
      }
    }
  }

  return out;
}

/**
 * Full ITU-R BS.1770-5 True Peak & Sample Peak analysis with ceiling compliance check.
 */
export function measureTruePeak(
  buffer: PlanarAudioBuffer,
  oversamplingFactor: 4 | 8 = 4,
  ceilingDbtp = -1.0
): TruePeakMetrics {
  const { channels } = buffer;
  const numCh = channels.length;
  const n = numCh > 0 ? channels[0].length : 0;

  if (numCh === 0 || n === 0) {
    return {
      truePeakDbtp: -120,
      truePeakPerChannelDbtp: [],
      samplePeakDbfs: -120,
      samplePeakPerChannelDbfs: [],
      ispMarginDb: 0,
      oversamplingFactor,
      clippedSampleCount: 0,
      truePeakOverZeroCount: 0,
      ceilingViolationCount: 0,
    };
  }

  const bank = getPolyphaseBank(oversamplingFactor);
  const taps = bank.tapsPerPhase;
  const center = taps / 2 - 1;
  const phases = bank.phases;

  // Small 0.02 dB tolerance for float32 rounding
  const ceilingLinear = Math.pow(10, (ceilingDbtp + 0.02) / 20);

  const truePeakPerChannelDbtp: number[] = [];
  const samplePeakPerChannelDbfs: number[] = [];

  let globalSamplePeak = 0;
  let globalTruePeak = 0;
  let clippedSampleCount = 0;
  let truePeakOverZeroCount = 0;
  let ceilingViolationCount = 0;

  for (let ch = 0; ch < numCh; ch++) {
    const src = channels[ch];
    let chSamplePeak = 0;
    let chTruePeak = 0;

    for (let i = 0; i < n; i++) {
      const sAbs = Math.abs(src[i]);
      if (sAbs > chSamplePeak) chSamplePeak = sAbs;
      if (sAbs >= 1.0) clippedSampleCount++;

      let frameTp = sAbs;
      for (let p = 1; p < oversamplingFactor; p++) {
        const h = phases[p];
        let acc = 0;
        for (let k = 0; k < taps; k++) {
          const idx = i - center + k;
          if (idx >= 0 && idx < n) {
            acc += src[idx] * h[k];
          }
        }
        const tpAbs = Math.abs(acc);
        if (tpAbs > frameTp) frameTp = tpAbs;
      }

      if (frameTp > chTruePeak) chTruePeak = frameTp;
      if (frameTp > 1.0) truePeakOverZeroCount++;
      if (frameTp > ceilingLinear) ceilingViolationCount++;
    }

    samplePeakPerChannelDbfs.push(linearToDb(chSamplePeak));
    truePeakPerChannelDbtp.push(linearToDb(chTruePeak));
    if (chSamplePeak > globalSamplePeak) globalSamplePeak = chSamplePeak;
    if (chTruePeak > globalTruePeak) globalTruePeak = chTruePeak;
  }

  const samplePeakDbfs = linearToDb(globalSamplePeak);
  const truePeakDbtp = linearToDb(globalTruePeak);

  return {
    truePeakDbtp,
    truePeakPerChannelDbtp,
    samplePeakDbfs,
    samplePeakPerChannelDbfs,
    ispMarginDb: Math.max(0, truePeakDbtp - samplePeakDbfs),
    oversamplingFactor,
    clippedSampleCount,
    truePeakOverZeroCount,
    ceilingViolationCount,
  };
}
