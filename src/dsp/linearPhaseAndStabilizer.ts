import { designEqBiquad, evaluateBiquadMagnitudeDb } from './biquad';
import { radix2FftInPlace } from './spectral';
import type { EqBandParams, StabilizerParams } from './types';

export function radix2IfftInPlace(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 0; i < n; i++) {
    im[i] = -im[i];
  }
  radix2FftInPlace(re, im);
  const invN = 1 / n;
  for (let i = 0; i < n; i++) {
    re[i] *= invN;
    im[i] = -im[i] * invN;
  }
}

/**
 * Designs a symmetric (Type I) Linear-Phase FIR kernel of odd length (2049 taps,
 * group delay = 1024 samples) matching the exact composite magnitude of active EqBandParams.
 */
function designLinearPhaseFirKernel(
  bands: EqBandParams[],
  sampleRate: number,
  targetChannel: 'mid' | 'side'
): Float64Array {
  const fftLen = 4096;
  const halfFft = fftLen >> 1;
  const halfOrder = 1024; // Total FIR length = 2049 taps
  const firLen = halfOrder * 2 + 1;

  const activeCoeffs = bands
    .filter(
      (b) =>
        b.enabled &&
        (b.type === 'highpass' || Math.abs(b.gainDb) > 0.01) &&
        (b.placement === 'stereo' || b.placement === targetChannel)
    )
    .map((b) => designEqBiquad(b.type, b.freqHz, sampleRate, b.gainDb, b.q));

  if (activeCoeffs.length === 0) {
    const identity = new Float64Array(firLen);
    identity[halfOrder] = 1.0;
    return identity;
  }

  const re = new Float64Array(fftLen);
  const im = new Float64Array(fftLen);

  for (let k = 0; k <= halfFft; k++) {
    const freqHz = (k * sampleRate) / fftLen;
    let totalDb = 0;
    if (k === 0) {
      // DC bin: check if any highpass is active
      const hasHp = bands.some(
        (b) =>
          b.enabled &&
          b.type === 'highpass' &&
          (b.placement === 'stereo' || b.placement === targetChannel)
      );
      totalDb = hasHp ? -96 : evaluateBiquadMagnitudeDbVec(activeCoeffs, 1, sampleRate);
    } else {
      totalDb = evaluateBiquadMagnitudeDbVec(activeCoeffs, Math.min(freqHz, sampleRate * 0.498), sampleRate);
    }
    const mag = Math.pow(10, totalDb / 20);
    re[k] = mag;
    if (k > 0 && k < halfFft) {
      re[fftLen - k] = mag;
    }
  }

  // Zero-phase IDFT -> circular shift by halfOrder -> 4-term Blackman-Harris window
  radix2IfftInPlace(re, im);

  const kernel = new Float64Array(firLen);
  for (let m = 0; m < firLen; m++) {
    const offset = m - halfOrder;
    const srcIdx = (offset + fftLen) & (fftLen - 1);
    const wPhase = (2 * Math.PI * m) / (firLen - 1);
    // 4-term Blackman-Harris (-92 dB sidelobes)
    const win =
      0.35875 -
      0.48829 * Math.cos(wPhase) +
      0.14128 * Math.cos(2 * wPhase) -
      0.01168 * Math.cos(3 * wPhase);
    kernel[m] = re[srcIdx] * win;
  }

  return kernel;
}

function evaluateBiquadMagnitudeDbVec(
  coeffsList: ReturnType<typeof designEqBiquad>[],
  freqHz: number,
  sampleRate: number
): number {
  let sum = 0;
  for (const c of coeffsList) {
    sum += evaluateBiquadMagnitudeDb(c, freqHz, sampleRate);
  }
  return sum;
}

/**
 * Overlap-Add FFT linear convolution with exact group-delay compensation so output has
 * 0.000° phase shift AND exact sample-index alignment with dry input.
 */
function convolveZeroPhaseInPlace(signal: Float32Array, kernel: Float64Array): void {
  const n = signal.length;
  if (n === 0) return;

  const firLen = kernel.length; // 2049
  const groupDelay = (firLen - 1) >> 1; // 1024
  const fftLen = 4096; // >= blockLen (2048) + firLen (2049) - 1 = 4096
  const blockLen = fftLen - firLen + 1; // 2048

  const hRe = new Float64Array(fftLen);
  const hIm = new Float64Array(fftLen);
  hRe.set(kernel, 0);
  radix2FftInPlace(hRe, hIm);

  const fullConv = new Float64Array(n + firLen + blockLen);
  const xRe = new Float64Array(fftLen);
  const xIm = new Float64Array(fftLen);

  for (let pos = 0; pos < n; pos += blockLen) {
    xRe.fill(0);
    xIm.fill(0);
    const end = Math.min(n, pos + blockLen);
    for (let i = pos; i < end; i++) {
      xRe[i - pos] = signal[i];
    }

    radix2FftInPlace(xRe, xIm);

    for (let k = 0; k < fftLen; k++) {
      const a = xRe[k];
      const b = xIm[k];
      const c = hRe[k];
      const d = hIm[k];
      xRe[k] = a * c - b * d;
      xIm[k] = a * d + b * c;
    }

    radix2IfftInPlace(xRe, xIm);

    for (let k = 0; k < fftLen; k++) {
      fullConv[pos + k] += xRe[k];
    }
  }

  // Strip exact symmetric groupDelay (1024 samples) -> pure zero-phase aligned output!
  for (let i = 0; i < n; i++) {
    signal[i] = fullConv[i + groupDelay];
  }
}

/**
 * Zero-Phase / Linear-Phase Mastering M/S Parametric EQ (FabFilter Pro-Q 4 Linear Phase topology).
 */
export function applyLinearPhaseEq(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
  bands: EqBandParams[]
): void {
  const anyActive = bands.some(
    (b) => b.enabled && (b.type === 'highpass' || Math.abs(b.gainDb) > 0.01)
  );
  if (!anyActive || left.length === 0) return;

  const n = left.length;
  const mid = new Float32Array(n);
  const side = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    mid[i] = 0.5 * (left[i] + right[i]);
    side[i] = 0.5 * (left[i] - right[i]);
  }

  const midKernel = designLinearPhaseFirKernel(bands, sampleRate, 'mid');
  const sideKernel = designLinearPhaseFirKernel(bands, sampleRate, 'side');

  convolveZeroPhaseInPlace(mid, midKernel);
  convolveZeroPhaseInPlace(side, sideKernel);

  for (let i = 0; i < n; i++) {
    left[i] = mid[i] + side[i];
    right[i] = mid[i] - side[i];
  }
}

/**
 * Per-Bin Dynamic Spectral Resonance Suppressor ("Spectral Stabilizer").
 * Uses a 75%-overlap COLA periodic Hann STFT (exact identity at 0 dB reduction) to detect
 * narrowband resonant spikes above a local smoothed tonal envelope and attenuate them smoothly
 * with stereo-linked zero-phase gains (Ozone 12 Stabilizer / Soothe2 working logic).
 */
export function applySpectralStabilizer(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
  params: StabilizerParams
): number[] {
  const numLogBins = 64;
  if (!params.enabled || params.amountPct <= 0.5 || left.length === 0) {
    return new Array(numLogBins).fill(0);
  }

  const N = 2048;
  const hop = 512; // 75% overlap => sum(w^2) === 1.5 everywhere!
  const halfBins = N >> 1;
  const pad = N - hop; // 1536 boundary pad guarantees zero edge droop!
  const len = left.length;
  const paddedLen = len + 2 * pad;

  const padL = new Float64Array(paddedLen);
  const padR = new Float64Array(paddedLen);
  for (let i = 0; i < len; i++) {
    padL[pad + i] = left[i];
    padR[pad + i] = right[i];
  }

  const outL = new Float64Array(paddedLen + N);
  const outR = new Float64Array(paddedLen + N);

  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    // Periodic Hann window for exact COLA
    win[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / N));
  }
  const colaNorm = 2.0 / 3.0; // Because sum_{m} w^2[n - m*512] === 1.5

  const binHz = sampleRate / N;
  const effectiveMinHz =
    params.mode === 'de_ess' ? Math.max(3200, params.minFreqHz) : params.minFreqHz;
  const effectiveMaxHz =
    params.mode === 'de_ess' ? Math.min(12500, params.maxFreqHz) : params.maxFreqHz;

  const minBin = Math.max(2, Math.floor(effectiveMinHz / binHz));
  const maxBin = Math.min(halfBins - 2, Math.ceil(effectiveMaxHz / binHz));

  const amount = Math.min(1, params.amountPct / 100);
  const sharpness = Math.min(1, Math.max(0, params.sharpnessPct / 100));
  const maxRedDb = Math.max(0.5, Math.min(14, params.maxReductionDb));
  // Prominence threshold above smoothed neighborhood before dynamic suppression engages
  const prominenceThreshDb =
    params.mode === 'tonal_balance' ? 1.8 - amount * 1.1 : 3.2 - amount * 1.8;

  // Temporal smoothing per bin (~10 ms hop at 48 kHz)
  const frameSec = hop / sampleRate;
  const attackCoeff = Math.exp(-frameSec / 0.008);
  const releaseCoeff = Math.exp(-frameSec / 0.065);

  const smoothRedDb = new Float64Array(halfBins + 1);
  const accumRedDb = new Float64Array(halfBins + 1);
  let activeFrames = 0;

  const reL = new Float64Array(N);
  const imL = new Float64Array(N);
  const reR = new Float64Array(N);
  const imR = new Float64Array(N);
  const magDb = new Float64Array(halfBins + 1);
  const prefixDb = new Float64Array(halfBins + 2);

  for (let start = 0; start + N <= paddedLen; start += hop) {
    let framePower = 0;
    for (let i = 0; i < N; i++) {
      const w = win[i];
      const l = padL[start + i] * w;
      const r = padR[start + i] * w;
      reL[i] = l;
      imL[i] = 0;
      reR[i] = r;
      imR[i] = 0;
      framePower += l * l + r * r;
    }

    radix2FftInPlace(reL, imL);
    radix2FftInPlace(reR, imR);

    for (let k = 0; k <= halfBins; k++) {
      const p = 0.5 * (reL[k] * reL[k] + imL[k] * imL[k] + reR[k] * reR[k] + imR[k] * imR[k]);
      magDb[k] = p > 1e-18 ? 10 * Math.log10(p) : -120;
      prefixDb[k + 1] = prefixDb[k] + magDb[k];
    }

    const isAudibleFrame = framePower / N > 1e-8;
    if (isAudibleFrame) activeFrames++;

    for (let k = 1; k < halfBins; k++) {
      let targetRed = 0;
      if (isAudibleFrame && k >= minBin && k <= maxBin) {
        // Frequency-proportional neighborhood radius: narrower at high sharpness, wider for tonal balance
        const baseSpan =
          params.mode === 'tonal_balance'
            ? Math.max(6, Math.round(k * 0.48))
            : Math.max(3, Math.round(k * (0.36 - 0.24 * sharpness)));
        const lo = Math.max(1, k - baseSpan);
        const hi = Math.min(halfBins, k + baseSpan);
        const localMeanDb = (prefixDb[hi + 1] - prefixDb[lo]) / (hi - lo + 1);

        const prominence = magDb[k] - localMeanDb - prominenceThreshDb;
        if (prominence > 0 && magDb[k] > -85) {
          targetRed = Math.min(maxRedDb, prominence * amount * 0.85);
        }
      }

      const prev = smoothRedDb[k];
      const nextRed =
        targetRed > prev
          ? attackCoeff * prev + (1 - attackCoeff) * targetRed
          : releaseCoeff * prev + (1 - releaseCoeff) * targetRed;
      smoothRedDb[k] = nextRed;

      if (isAudibleFrame) {
        accumRedDb[k] += nextRed;
      }

      if (nextRed > 0.01) {
        const g = Math.pow(10, -nextRed / 20);
        reL[k] *= g;
        imL[k] *= g;
        reR[k] *= g;
        imR[k] *= g;
        // Maintain conjugate symmetry for real inverse FFT
        const sym = N - k;
        reL[sym] *= g;
        imL[sym] *= g;
        reR[sym] *= g;
        imR[sym] *= g;
      }
    }

    radix2IfftInPlace(reL, imL);
    radix2IfftInPlace(reR, imR);

    for (let i = 0; i < N; i++) {
      const ws = win[i] * colaNorm;
      outL[start + i] += reL[i] * ws;
      outR[start + i] += reR[i] * ws;
    }
  }

  for (let i = 0; i < len; i++) {
    left[i] = outL[pad + i];
    right[i] = outR[pad + i];
  }

  // Summarize average dynamic reduction across 64 log bins (20 Hz .. 20 kHz)
  const minF = 20;
  const maxF = Math.min(20000, sampleRate * 0.49);
  const summary: number[] = [];
  const denomFrames = Math.max(1, activeFrames);

  for (let b = 0; b < numLogBins; b++) {
    const fLo = minF * Math.pow(maxF / minF, b / numLogBins);
    const fHi = minF * Math.pow(maxF / minF, (b + 1) / numLogBins);
    const kLo = Math.max(1, Math.floor(fLo / binHz));
    const kHi = Math.min(halfBins - 1, Math.max(kLo, Math.ceil(fHi / binHz)));
    let sum = 0;
    let cnt = 0;
    for (let k = kLo; k <= kHi; k++) {
      sum += accumRedDb[k] / denomFrames;
      cnt++;
    }
    summary.push(cnt > 0 ? sum / cnt : 0);
  }

  return summary;
}
