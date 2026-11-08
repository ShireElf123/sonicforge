import type { EqBandParams, EqFilterType } from './types';

export interface BiquadCoeffs {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/**
 * 64-bit internal-precision Transposed Direct Form II Biquad filter.
 * Prevents float32 quantization noise and instability on low-frequency mastering filters (20-60 Hz).
 */
export class BiquadFilter {
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private z1 = 0;
  private z2 = 0;

  constructor(coeffs?: BiquadCoeffs) {
    if (coeffs) {
      this.setCoeffs(coeffs);
    }
  }

  setCoeffs(c: BiquadCoeffs): void {
    this.b0 = c.b0;
    this.b1 = c.b1;
    this.b2 = c.b2;
    this.a1 = c.a1;
    this.a2 = c.a2;
  }

  reset(): void {
    this.z1 = 0;
    this.z2 = 0;
  }

  processSample(x: number): number {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }

  processInPlace(buf: Float32Array): void {
    const { b0, b1, b2, a1, a2 } = this;
    let z1 = this.z1;
    let z2 = this.z2;
    for (let i = 0; i < buf.length; i++) {
      const x = buf[i];
      const y = b0 * x + z1;
      z1 = b1 * x - a1 * y + z2;
      z2 = b2 * x - a2 * y;
      buf[i] = y;
    }
    this.z1 = z1;
    this.z2 = z2;
  }
}

const SQRT2_INV = Math.SQRT1_2;

function clampFreq(freqHz: number, sampleRate: number): number {
  return Math.max(5, Math.min(sampleRate * 0.495, freqHz));
}

/**
 * RBJ Audio EQ Cookbook exact bilinear design in double precision.
 */
export function designEqBiquad(
  type: EqFilterType,
  freqHz: number,
  sampleRate: number,
  gainDb: number,
  q: number
): BiquadCoeffs {
  const f0 = clampFreq(freqHz, sampleRate);
  const safeQ = Math.max(0.1, Math.min(24, q));
  const w0 = (2 * Math.PI * f0) / sampleRate;
  const cosW0 = Math.cos(w0);
  const sinW0 = Math.sin(w0);
  const alpha = sinW0 / (2 * safeQ);
  const A = Math.pow(10, gainDb / 40);

  let b0 = 1;
  let b1 = 0;
  let b2 = 0;
  let a0 = 1;
  let a1 = 0;
  let a2 = 0;

  switch (type) {
    case 'highpass': {
      b0 = (1 + cosW0) / 2;
      b1 = -(1 + cosW0);
      b2 = (1 + cosW0) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cosW0;
      a2 = 1 - alpha;
      break;
    }
    case 'peaking': {
      b0 = 1 + alpha * A;
      b1 = -2 * cosW0;
      b2 = 1 - alpha * A;
      a0 = 1 + alpha / A;
      a1 = -2 * cosW0;
      a2 = 1 - alpha / A;
      break;
    }
    case 'lowshelf': {
      const twoSqrtAAlpha = 2 * Math.sqrt(A) * alpha;
      b0 = A * (A + 1 - (A - 1) * cosW0 + twoSqrtAAlpha);
      b1 = 2 * A * (A - 1 - (A + 1) * cosW0);
      b2 = A * (A + 1 - (A - 1) * cosW0 - twoSqrtAAlpha);
      a0 = A + 1 + (A - 1) * cosW0 + twoSqrtAAlpha;
      a1 = -2 * (A - 1 + (A + 1) * cosW0);
      a2 = A + 1 + (A - 1) * cosW0 - twoSqrtAAlpha;
      break;
    }
    case 'highshelf': {
      const twoSqrtAAlpha = 2 * Math.sqrt(A) * alpha;
      b0 = A * (A + 1 + (A - 1) * cosW0 + twoSqrtAAlpha);
      b1 = -2 * A * (A - 1 + (A + 1) * cosW0);
      b2 = A * (A + 1 + (A - 1) * cosW0 - twoSqrtAAlpha);
      a0 = A + 1 - (A - 1) * cosW0 + twoSqrtAAlpha;
      a1 = 2 * (A - 1 - (A + 1) * cosW0);
      a2 = A + 1 - (A - 1) * cosW0 - twoSqrtAAlpha;
      break;
    }
  }

  return {
    b0: b0 / a0,
    b1: b1 / a0,
    b2: b2 / a0,
    a1: a1 / a0,
    a2: a2 / a0,
  };
}

export function designButterworthLowpass2(freqHz: number, sampleRate: number): BiquadCoeffs {
  const f0 = clampFreq(freqHz, sampleRate);
  const K = Math.tan((Math.PI * f0) / sampleRate);
  const K2 = K * K;
  const norm = 1 / (1 + Math.SQRT2 * K + K2);
  return {
    b0: K2 * norm,
    b1: 2 * K2 * norm,
    b2: K2 * norm,
    a1: 2 * (K2 - 1) * norm,
    a2: (1 - Math.SQRT2 * K + K2) * norm,
  };
}

export function designButterworthHighpass2(freqHz: number, sampleRate: number): BiquadCoeffs {
  const f0 = clampFreq(freqHz, sampleRate);
  const K = Math.tan((Math.PI * f0) / sampleRate);
  const K2 = K * K;
  const norm = 1 / (1 + Math.SQRT2 * K + K2);
  return {
    b0: norm,
    b1: -2 * norm,
    b2: norm,
    a1: 2 * (K2 - 1) * norm,
    a2: (1 - Math.SQRT2 * K + K2) * norm,
  };
}

/**
 * Exact 2nd-order Butterworth allpass matching the phase of LP4(z) + HP4(z).
 * Guarantees 0.000 dB magnitude ripple when summing multi-way LR4 crossovers.
 */
export function designLr4PhaseAllpass(freqHz: number, sampleRate: number): BiquadCoeffs {
  const f0 = clampFreq(freqHz, sampleRate);
  const K = Math.tan((Math.PI * f0) / sampleRate);
  const K2 = K * K;
  const a0 = 1 + Math.SQRT2 * K + K2;
  const b0Raw = 1 - Math.SQRT2 * K + K2;
  return {
    b0: b0Raw / a0,
    b1: (2 * (K2 - 1)) / a0,
    b2: 1,
    a1: (2 * (K2 - 1)) / a0,
    a2: b0Raw / a0,
  };
}

/**
 * Evaluates exact complex magnitude response |H(e^{jw})| in dB for a biquad at freqHz.
 */
export function evaluateBiquadMagnitudeDb(
  coeffs: BiquadCoeffs,
  freqHz: number,
  sampleRate: number
): number {
  const w = (2 * Math.PI * freqHz) / sampleRate;
  const cosW = Math.cos(w);
  const sinW = Math.sin(w);
  const cos2W = Math.cos(2 * w);
  const sin2W = Math.sin(2 * w);

  const numRe = coeffs.b0 + coeffs.b1 * cosW + coeffs.b2 * cos2W;
  const numIm = -(coeffs.b1 * sinW + coeffs.b2 * sin2W);
  const denRe = 1 + coeffs.a1 * cosW + coeffs.a2 * cos2W;
  const denIm = -(coeffs.a1 * sinW + coeffs.a2 * sin2W);

  const numMag2 = numRe * numRe + numIm * numIm;
  const denMag2 = Math.max(1e-24, denRe * denRe + denIm * denIm);
  return 10 * Math.log10(Math.max(1e-24, numMag2 / denMag2));
}

/**
 * Evaluates composite mastering EQ curve across arbitrary frequency array for real UI plotting.
 */
export function evaluateEqCurveDb(
  bands: EqBandParams[],
  frequenciesHz: number[],
  sampleRate: number,
  placementFilter?: 'stereo' | 'mid' | 'side'
): number[] {
  const activeCoeffs = bands
    .filter(
      (b) =>
        b.enabled &&
        (!placementFilter || b.placement === placementFilter || b.placement === 'stereo')
    )
    .map((b) =>
      designEqBiquad(
        b.type,
        b.freqHz,
        sampleRate,
        b.gainDb,
        b.type === 'highpass' ? Math.max(0.5, b.q || SQRT2_INV) : b.q
      )
    );

  return frequenciesHz.map((f) => {
    let totalDb = 0;
    for (const c of activeCoeffs) {
      totalDb += evaluateBiquadMagnitudeDb(c, f, sampleRate);
    }
    return totalDb;
  });
}

/**
 * Phase-compensated 4-band Linkwitz-Riley 24 dB/oct (LR4) splitter.
 * Splits a single channel buffer into [low, lowMid, highMid, high] such that their
 * direct sample-by-sample sum reconstructs an exact unity-gain allpass version of the input.
 */
export function splitFourBandLr4(
  input: Float32Array,
  sampleRate: number,
  crossoversHz: [number, number, number]
): [Float32Array, Float32Array, Float32Array, Float32Array] {
  const [f1, f2, f3] = crossoversHz;
  const n = input.length;

  // Stage A: Split input at middle crossover f2 into lowerHalf and upperHalf
  const lowerHalf = new Float32Array(input);
  const upperHalf = new Float32Array(input);

  const lp2A = new BiquadFilter(designButterworthLowpass2(f2, sampleRate));
  const lp2B = new BiquadFilter(designButterworthLowpass2(f2, sampleRate));
  lp2A.processInPlace(lowerHalf);
  lp2B.processInPlace(lowerHalf);

  const hp2A = new BiquadFilter(designButterworthHighpass2(f2, sampleRate));
  const hp2B = new BiquadFilter(designButterworthHighpass2(f2, sampleRate));
  hp2A.processInPlace(upperHalf);
  hp2B.processInPlace(upperHalf);

  // All-pass compensate lowerHalf for f3, and upperHalf for f1
  const apF3 = new BiquadFilter(designLr4PhaseAllpass(f3, sampleRate));
  apF3.processInPlace(lowerHalf);

  const apF1 = new BiquadFilter(designLr4PhaseAllpass(f1, sampleRate));
  apF1.processInPlace(upperHalf);

  // Stage B: Split lowerHalf at f1 -> Band 0 (Low) & Band 1 (Low-Mid)
  const band0 = new Float32Array(lowerHalf);
  const band1 = new Float32Array(lowerHalf);

  new BiquadFilter(designButterworthLowpass2(f1, sampleRate)).processInPlace(band0);
  new BiquadFilter(designButterworthLowpass2(f1, sampleRate)).processInPlace(band0);

  new BiquadFilter(designButterworthHighpass2(f1, sampleRate)).processInPlace(band1);
  new BiquadFilter(designButterworthHighpass2(f1, sampleRate)).processInPlace(band1);

  // Stage C: Split upperHalf at f3 -> Band 2 (High-Mid) & Band 3 (High)
  const band2 = new Float32Array(upperHalf);
  const band3 = new Float32Array(upperHalf);

  new BiquadFilter(designButterworthLowpass2(f3, sampleRate)).processInPlace(band2);
  new BiquadFilter(designButterworthLowpass2(f3, sampleRate)).processInPlace(band2);

  new BiquadFilter(designButterworthHighpass2(f3, sampleRate)).processInPlace(band3);
  new BiquadFilter(designButterworthHighpass2(f3, sampleRate)).processInPlace(band3);

  // Guard against denormals
  for (let i = 0; i < n; i++) {
    if (Math.abs(band0[i]) < 1e-20) band0[i] = 0;
    if (Math.abs(band1[i]) < 1e-20) band1[i] = 0;
    if (Math.abs(band2[i]) < 1e-20) band2[i] = 0;
    if (Math.abs(band3[i]) < 1e-20) band3[i] = 0;
  }

  return [band0, band1, band2, band3];
}
