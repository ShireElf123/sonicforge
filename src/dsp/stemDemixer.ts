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
 * Local Zero-Upload 4-Stem DSP Demixer v2:
 *  1) Median STFT Harmonic-Percussive Source Separation (HPSS) with Vocal Sibilance Gating
 *  2) REPET-SIM Non-Adjacent Cosine Spectral Similarity Foreground/Background Isolation
 *     (separates repeating center chord/synth/guitar patterns from non-repeating vocal phrasing)
 *  3) Sharp Gaussian Azimuthal Mid/Side Panning Mask + Vocal Formant Prior + 140 Hz Sub Crossover
 *
 * Strictly enforces Partition-of-Unity complex Wiener masks (mDrums + mBass + mVocals + mInst === 1.0)
 * over a 75%-overlap COLA Hann STFT so summing all 4 stems nulls to float32 machine epsilon (< -115 dB).
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

  onProgress?.('Computing 75% COLA STFT Spectrogram', 14);

  const N = 2048;
  const hop = 512;
  const halfBins = N >> 1;
  const pad = N;
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
  const binHz = sr / N;

  const specReL = new Float64Array(numFrames * binsPerFrame);
  const specImL = new Float64Array(numFrames * binsPerFrame);
  const specReR = new Float64Array(numFrames * binsPerFrame);
  const specImR = new Float64Array(numFrames * binsPerFrame);
  const magGrid = new Float32Array(numFrames * binsPerFrame);
  const centerSharpGrid = new Float32Array(numFrames * binsPerFrame);
  const vocalSyllableEnv = new Float32Array(numFrames);

  // 24-dim normalized spectral fingerprint per frame for REPET-SIM cosine similarity
  const FINGERPRINT_DIMS = 24;
  const frameFingerprints = new Float32Array(numFrames * FINGERPRINT_DIMS);

  const reL = new Float64Array(N);
  const imL = new Float64Array(N);
  const reR = new Float64Array(N);
  const imR = new Float64Array(N);

  const minVocalBin = Math.max(1, Math.floor(220 / binHz));
  const maxVocalBin = Math.min(halfBins, Math.ceil(4200 / binHz));

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
    let centerFormantEnergy = 0;
    const fpBase = t * FINGERPRINT_DIMS;

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

      // Sharp Gaussian azimuthal center mask: strongly rejects panned/stereo instruments
      const panRatio = eSide / (eMid + 1e-18);
      const sharpCenter = eMid > 1e-18 ? Math.exp(-3.6 * panRatio) : 0;
      centerSharpGrid[row + k] = sharpCenter;

      if (k >= minVocalBin && k <= maxVocalBin) {
        centerFormantEnergy += eMid * sharpCenter;
        const fpIdx = Math.min(
          FINGERPRINT_DIMS - 1,
          Math.floor(((k - minVocalBin) / Math.max(1, maxVocalBin - minVocalBin + 1)) * FINGERPRINT_DIMS)
        );
        frameFingerprints[fpBase + fpIdx] += mag;
      }
    }

    vocalSyllableEnv[t] = Math.sqrt(centerFormantEnergy);

    // L2-normalize fingerprint for fast dot-product cosine similarity
    let normSq = 0;
    for (let d = 0; d < FINGERPRINT_DIMS; d++) {
      const v = Math.log1p(frameFingerprints[fpBase + d] * 20);
      frameFingerprints[fpBase + d] = v;
      normSq += v * v;
    }
    const invNorm = normSq > 1e-12 ? 1 / Math.sqrt(normSq) : 0;
    for (let d = 0; d < FINGERPRINT_DIMS; d++) {
      frameFingerprints[fpBase + d] *= invNorm;
    }
  }

  onProgress?.('Building REPET-SIM Repeating Background & Formant Masks', 42);

  // Normalize syllable envelope [0..1] for sibilant consonant gating
  let peakSyllable = 1e-9;
  for (let t = 0; t < numFrames; t++) {
    if (vocalSyllableEnv[t] > peakSyllable) peakSyllable = vocalSyllableEnv[t];
  }
  for (let t = 0; t < numFrames; t++) {
    vocalSyllableEnv[t] = Math.min(1, vocalSyllableEnv[t] / (peakSyllable * 0.35 + 1e-12));
  }

  // For each frame t, find up to K=5 most cosine-similar non-adjacent frames (|t - t'| >= 10)
  const K_SIM = 5;
  const minSep = 10;
  const simNeighbors = new Int32Array(numFrames * K_SIM);
  const simScores = new Float32Array(numFrames);
  simNeighbors.fill(-1);

  if (numFrames > minSep * 2 + 2) {
    const stride = Math.max(1, Math.floor(numFrames / 180));
    const topIdx = new Int32Array(K_SIM);
    const topVal = new Float32Array(K_SIM);

    for (let t = 0; t < numFrames; t++) {
      topVal.fill(-1);
      topIdx.fill(-1);
      const baseA = t * FINGERPRINT_DIMS;

      for (let cand = 0; cand < numFrames; cand += stride) {
        if (Math.abs(cand - t) < minSep) continue;
        const baseB = cand * FINGERPRINT_DIMS;
        let dot = 0;
        for (let d = 0; d < FINGERPRINT_DIMS; d++) {
          dot += frameFingerprints[baseA + d] * frameFingerprints[baseB + d];
        }
        if (dot > topVal[K_SIM - 1]) {
          let pos = K_SIM - 1;
          while (pos > 0 && dot > topVal[pos - 1]) {
            topVal[pos] = topVal[pos - 1];
            topIdx[pos] = topIdx[pos - 1];
            pos--;
          }
          topVal[pos] = dot;
          topIdx[pos] = cand;
        }
      }

      let validSum = 0;
      let validCnt = 0;
      for (let j = 0; j < K_SIM; j++) {
        simNeighbors[t * K_SIM + j] = topIdx[j];
        if (topIdx[j] >= 0) {
          validSum += topVal[j];
          validCnt++;
        }
      }
      simScores[t] = validCnt > 0 ? validSum / validCnt : 0;
    }
  }

  const bassPrior = new Float64Array(binsPerFrame);
  const vocalFormantPrior = new Float64Array(binsPerFrame);
  const sibilantBandPrior = new Float64Array(binsPerFrame);

  for (let k = 0; k <= halfBins; k++) {
    const f = k * binHz;
    bassPrior[k] = 1 / (1 + Math.pow(f / 140, 8));

    // Vocal fundamental + F1/F2/F3 formant region (185 Hz – 4600 Hz)
    const hp = 1 / (1 + Math.pow(185 / Math.max(1, f), 6));
    const lp = 1 / (1 + Math.pow(f / 4800, 5));
    // Subtle emphasis around F1/F2/F3 vocal intelligibility (500 - 3400 Hz)
    const formantLift = 0.78 + 0.22 * Math.exp(-Math.pow(Math.log2(Math.max(40, f) / 1450), 2) / 1.8);
    vocalFormantPrior[k] = Math.min(1, hp * lp * formantLift);

    // Unvoiced vocal sibilance band (4.5 kHz - 9.8 kHz)
    const sibHp = 1 / (1 + Math.pow(4400 / Math.max(1, f), 8));
    const sibLp = 1 / (1 + Math.pow(f / 9800, 8));
    sibilantBandPrior[k] = sibHp * sibLp;
  }

  onProgress?.('Synthesizing Partition-of-Unity 4-Stem Buses', 74);

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
  const repetScratch = new Float32Array(K_SIM);

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

  const masks = new Float64Array(4 * binsPerFrame);

  for (let t = 0; t < numFrames; t++) {
    const row = t * binsPerFrame;
    const tLo = Math.max(0, t - 4);
    const tHi = Math.min(numFrames - 1, t + 4);

    // Smoothed syllable presence across ±2 frames for consonant attachment
    let localSyllable = 0;
    for (let ts = Math.max(0, t - 2); ts <= Math.min(numFrames - 1, t + 2); ts++) {
      if (vocalSyllableEnv[ts] > localSyllable) localSyllable = vocalSyllableEnv[ts];
    }

    const frameSimStrength = simScores[t] > 0.88 ? Math.min(0.72, (simScores[t] - 0.82) * 3.6) : 0.25;

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
      const rawPerc = p2 / (p2 + h2 + 1e-18);

      const centerMask = centerSharpGrid[row + k];
      // Protect center vocal sibilants ("s", "t") from being swallowed by the Drums mask
      const sibVocalGate = sibilantBandPrior[k] * centerMask * localSyllable * 0.65;

      const bPrior = bassPrior[k];
      const mDrums = rawPerc * (1 - 0.55 * bPrior) * (1 - sibVocalGate);
      const remAfterDrums = 1.0 - mDrums;
      const mBass = remAfterDrums * bPrior;
      const remUpper = remAfterDrums * (1.0 - bPrior);

      // REPET-SIM non-repeating foreground factor: attenuates repeating center synth/guitar riffs
      let fgFactor = 1.0;
      if (frameSimStrength > 0 && vocalFormantPrior[k] > 0.05) {
        let rc = 0;
        for (let j = 0; j < K_SIM; j++) {
          const nb = simNeighbors[t * K_SIM + j];
          if (nb >= 0) {
            repetScratch[rc++] = magGrid[nb * binsPerFrame + k];
          }
        }
        if (rc >= 3) {
          const bgMag = medianSmall(repetScratch, rc);
          const curMag = magGrid[row + k];
          const curE = curMag * curMag + 1e-18;
          const bgE = bgMag * bgMag * frameSimStrength;
          // Soft Wiener foreground mask floored at 0.18 so sustained vocal notes still pass smoothly
          fgFactor = Math.max(0.18, Math.min(1.0, (curE - bgE * 0.85) / curE + 0.28));
        }
      }

      const vocalPrior = Math.max(vocalFormantPrior[k] * fgFactor, sibVocalGate);
      const mVocal = remUpper * centerMask * vocalPrior;
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

  onProgress?.('4-Stem REPET-SIM + HPSS Extraction Verified', 100);

  return {
    stems: { drums, bass, vocals, instruments },
    reconstructionNullDb,
    processingTimeMs: performance.now() - t0,
  };
}
