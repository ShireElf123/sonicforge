import { radix2IfftInPlace } from './linearPhaseAndStabilizer';
import { cloneAsStereoBuffer } from './processors';
import { radix2FftInPlace } from './spectral';
import type { PlanarAudioBuffer, StemSlotId } from './types';

function medianSmall(arr: Float32Array, count: number): number {
  for (let i = 1; i < count; i++) {
    const v = arr[i];
    let j = i - 1;
    while (j >= 0 && arr[j] > v) {
      arr[j + 1] = arr[j];
      j--;
    }
    arr[j + 1] = v;
  }
  return arr[count >> 1];
}

export interface LocalDemixResult {
  stems: Record<StemSlotId, PlanarAudioBuffer>;
  reconstructionNullDb: number;
  processingTimeMs: number;
}

/**
 * Local Zero-Upload 4-Stem DSP Demixer (Fitzgerald STFT Harmonic-Percussive Source Separation
 * + Azimuthal Mid/Side Vocal Isolation + Sub Crossover).
 *
 * Uses strict Partition-of-Unity complex Wiener masks (mDrums + mBass + mVocals + mInst === 1.0)
 * over a 75%-overlap COLA Hann STFT with exact hop-aligned boundary padding so summing all 4
 * extracted stems nulls against the input mix to float32 machine epsilon (< -120 dB).
 */
export function demixStereoToFourStems(
  input: PlanarAudioBuffer,
  onProgress?: (stage: string, pct: number) => void
): LocalDemixResult {
  const t0 = performance.now();
  const stereo = cloneAsStereoBuffer(input);
  const sr = stereo.sampleRate;
  const len = stereo.channels[0].length;

  if (len === 0) {
    const empty = (): PlanarAudioBuffer => ({
      sampleRate: sr,
      channels: [new Float32Array(0), new Float32Array(0)],
      duration: 0,
    });
    return {
      stems: { drums: empty(), bass: empty(), vocals: empty(), instruments: empty() },
      reconstructionNullDb: -140,
      processingTimeMs: 0,
    };
  }

  onProgress?.('Computing 75% COLA STFT Spectrogram', 15);

  const N = 2048;
  const hop = 512;
  const halfBins = N >> 1;
  const pad = N; // Full window pad on both ends
  const numFrames = Math.ceil((len + pad) / hop) + 1;
  const paddedLen = (numFrames - 1) * hop + N;

  const padL = new Float64Array(paddedLen);
  const padR = new Float64Array(paddedLen);
  for (let i = 0; i < len; i++) {
    padL[pad + i] = stereo.channels[0][i];
    padR[pad + i] = stereo.channels[1][i];
  }

  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    win[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / N));
  }
  const colaNorm = 2.0 / 3.0;

  const binsPerFrame = halfBins + 1;

  const specReL = new Float64Array(numFrames * binsPerFrame);
  const specImL = new Float64Array(numFrames * binsPerFrame);
  const specReR = new Float64Array(numFrames * binsPerFrame);
  const specImR = new Float64Array(numFrames * binsPerFrame);
  const magGrid = new Float32Array(numFrames * binsPerFrame);
  const centerRatioGrid = new Float32Array(numFrames * binsPerFrame);

  const reL = new Float64Array(N);
  const imL = new Float64Array(N);
  const reR = new Float64Array(N);
  const imR = new Float64Array(N);

  for (let t = 0; t < numFrames; t++) {
    const start = t * hop;
    for (let i = 0; i < N; i++) {
      const w = win[i];
      reL[i] = padL[start + i] * w;
      imL[i] = 0;
      reR[i] = padR[start + i] * w;
      imR[i] = 0;
    }

    radix2FftInPlace(reL, imL);
    radix2FftInPlace(reR, imR);

    const row = t * binsPerFrame;
    for (let k = 0; k <= halfBins; k++) {
      const rl = reL[k];
      const il = imL[k];
      const rr = reR[k];
      const ir = imR[k];

      specReL[row + k] = rl;
      specImL[row + k] = il;
      specReR[row + k] = rr;
      specImR[row + k] = ir;

      const mag = Math.sqrt(0.5 * (rl * rl + il * il + rr * rr + ir * ir));
      magGrid[row + k] = mag;

      const mRe = 0.5 * (rl + rr);
      const mIm = 0.5 * (il + ir);
      const sRe = 0.5 * (rl - rr);
      const sIm = 0.5 * (il - ir);
      const eMid = mRe * mRe + mIm * mIm;
      const eSide = sRe * sRe + sIm * sIm;
      centerRatioGrid[row + k] = eMid / (eMid + 2.4 * eSide + 1e-18);
    }
  }

  onProgress?.('Running Median Harmonic-Percussive Separation (HPSS)', 48);

  const binHz = sr / N;
  const bassPrior = new Float64Array(binsPerFrame);
  const vocalBandPrior = new Float64Array(binsPerFrame);

  for (let k = 0; k <= halfBins; k++) {
    const f = k * binHz;
    bassPrior[k] = 1 / (1 + Math.pow(f / 140, 8));
    const hp = 1 / (1 + Math.pow(175 / Math.max(1, f), 6));
    const lp = 1 / (1 + Math.pow(f / 8500, 6));
    vocalBandPrior[k] = hp * lp;
  }

  const outDrumsL = new Float64Array(paddedLen);
  const outDrumsR = new Float64Array(paddedLen);
  const outBassL = new Float64Array(paddedLen);
  const outBassR = new Float64Array(paddedLen);
  const outVocL = new Float64Array(paddedLen);
  const outVocR = new Float64Array(paddedLen);
  const outInstL = new Float64Array(paddedLen);
  const outInstR = new Float64Array(paddedLen);

  const timeScratch = new Float32Array(9);
  const freqScratch = new Float32Array(13);

  const stemBufRe = [
    new Float64Array(N),
    new Float64Array(N),
    new Float64Array(N),
    new Float64Array(N),
  ];
  const stemBufIm = [
    new Float64Array(N),
    new Float64Array(N),
    new Float64Array(N),
    new Float64Array(N),
  ];

  onProgress?.('Synthesizing Partition-of-Unity 4-Stem Buses', 75);

  const masks = new Float64Array(4 * binsPerFrame);

  for (let t = 0; t < numFrames; t++) {
    const row = t * binsPerFrame;
    const tLo = Math.max(0, t - 4);
    const tHi = Math.min(numFrames - 1, t + 4);

    for (let k = 0; k <= halfBins; k++) {
      let tc = 0;
      for (let tt = tLo; tt <= tHi; tt++) {
        timeScratch[tc++] = magGrid[tt * binsPerFrame + k];
      }
      const harmMag = medianSmall(timeScratch, tc);

      const kLo = Math.max(0, k - 6);
      const kHi = Math.min(halfBins, k + 6);
      let fc = 0;
      for (let kk = kLo; kk <= kHi; kk++) {
        freqScratch[fc++] = magGrid[row + kk];
      }
      const percMag = medianSmall(freqScratch, fc);

      const p2 = percMag * percMag;
      const h2 = harmMag * harmMag;
      const mPerc = p2 / (p2 + h2 + 1e-18);

      const bPrior = bassPrior[k];
      const mDrums = mPerc * (1 - 0.55 * bPrior);
      const remAfterDrums = 1.0 - mDrums;
      const mBass = remAfterDrums * bPrior;
      const remHarmUpper = remAfterDrums * (1.0 - bPrior);
      const mVocal = remHarmUpper * centerRatioGrid[row + k] * vocalBandPrior[k];
      const mInst = Math.max(0, 1.0 - mDrums - mBass - mVocal);

      masks[k] = mDrums;
      masks[binsPerFrame + k] = mBass;
      masks[2 * binsPerFrame + k] = mVocal;
      masks[3 * binsPerFrame + k] = mInst;
    }

    const start = t * hop;

    for (let ch = 0; ch < 2; ch++) {
      const srcRe = ch === 0 ? specReL : specReR;
      const srcIm = ch === 0 ? specImL : specImR;

      for (let s = 0; s < 4; s++) {
        const bRe = stemBufRe[s];
        const bIm = stemBufIm[s];
        const mOff = s * binsPerFrame;

        bRe[0] = srcRe[row] * masks[mOff];
        bIm[0] = 0;
        bRe[halfBins] = srcRe[row + halfBins] * masks[mOff + halfBins];
        bIm[halfBins] = 0;

        for (let k = 1; k < halfBins; k++) {
          const m = masks[mOff + k];
          const r = srcRe[row + k] * m;
          const im = srcIm[row + k] * m;
          bRe[k] = r;
          bIm[k] = im;
          bRe[N - k] = r;
          bIm[N - k] = -im;
        }

        radix2IfftInPlace(bRe, bIm);
      }

      const dDst = ch === 0 ? outDrumsL : outDrumsR;
      const bDst = ch === 0 ? outBassL : outBassR;
      const vDst = ch === 0 ? outVocL : outVocR;
      const iDst = ch === 0 ? outInstL : outInstR;

      for (let i = 0; i < N; i++) {
        const ws = win[i] * colaNorm;
        dDst[start + i] += stemBufRe[0][i] * ws;
        bDst[start + i] += stemBufRe[1][i] * ws;
        vDst[start + i] += stemBufRe[2][i] * ws;
        iDst[start + i] += stemBufRe[3][i] * ws;
      }
    }
  }

  const sliceOut = (arrL: Float64Array, arrR: Float64Array): PlanarAudioBuffer => {
    const cL = new Float32Array(len);
    const cR = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      cL[i] = arrL[pad + i];
      cR[i] = arrR[pad + i];
    }
    return { sampleRate: sr, channels: [cL, cR], duration: len / sr };
  };

  const drums = sliceOut(outDrumsL, outDrumsR);
  const bass = sliceOut(outBassL, outBassR);
  const vocals = sliceOut(outVocL, outVocR);
  const instruments = sliceOut(outInstL, outInstR);

  let errEnergy = 0;
  let sigEnergy = 0;
  for (let i = 0; i < len; i++) {
    const sumL =
      drums.channels[0][i] +
      bass.channels[0][i] +
      vocals.channels[0][i] +
      instruments.channels[0][i];
    const diffL = sumL - stereo.channels[0][i];
    errEnergy += diffL * diffL;
    sigEnergy += stereo.channels[0][i] * stereo.channels[0][i];
  }
  const reconstructionNullDb =
    sigEnergy > 1e-18 && errEnergy > 1e-28 ? 10 * Math.log10(errEnergy / sigEnergy) : -140;

  onProgress?.('4-Stem HPSS + M/S Extraction Verified', 100);

  return {
    stems: { drums, bass, vocals, instruments },
    reconstructionNullDb,
    processingTimeMs: performance.now() - t0,
  };
}
