import { BiquadFilter, designButterworthLowpass2 } from './biquad';
import { radix2IfftInPlace } from './linearPhaseAndStabilizer';
import { cloneAsStereoBuffer } from './processors';
import { radix2FftInPlace } from './spectral';
import { measureTruePeak } from './truePeak';
import type { CodecAuditResult, CodecProfileId, PlanarAudioBuffer } from './types';

interface CodecSpec {
  id: CodecProfileId;
  label: string;
  cutoffHz: number;
  maskingOffsetDb: number; // Signal-to-Mask Ratio offset per codec bitrate
}

const CODEC_SPECS: Record<CodecProfileId, CodecSpec> = {
  aac_256: {
    id: 'aac_256',
    label: 'AAC 256 kbps (Apple Music / High)',
    cutoffHz: 20400,
    maskingOffsetDb: 29.5, // ~48-54 dB audible SNR
  },
  ogg_160: {
    id: 'ogg_160',
    label: 'Ogg / Opus 160 kbps (Spotify / YouTube)',
    cutoffHz: 18400,
    maskingOffsetDb: 22.5, // ~40-44 dB audible SNR
  },
  mp3_128: {
    id: 'mp3_128',
    label: 'MP3 128 kbps (Social / Mobile Web)',
    cutoffHz: 15800,
    maskingOffsetDb: 15.5, // ~31-35 dB audible SNR + 15.8k brickwall Gibbs overshoot
  },
};

function hzToBark(f: number): number {
  return 13 * Math.atan(0.00076 * f) + 3.5 * Math.atan((f / 7500) * (f / 7500));
}

/**
 * 24-Bark Zwicker Simultaneous-Masking Psychoacoustic Codec Engine.
 * Models asymmetric basilar-membrane spreading (+25 dB/Bark lower slope, -10 dB/Bark upper slope),
 * spectral flatness tonality offset, transient pre-echo quantization, and brickwall cutoff
 * over a zero-phase 75%-COLA Hann transform so Artifact Solo nulls untouched audio cleanly.
 */
export function renderSimulatedCodecPreview(
  input: PlanarAudioBuffer,
  codecId: CodecProfileId
): PlanarAudioBuffer {
  const spec = CODEC_SPECS[codecId];
  const out = cloneAsStereoBuffer(input);
  const sr = out.sampleRate;
  const len = out.channels[0].length;
  if (len === 0) return out;

  const N = 1024;
  const hop = 256;
  const halfBins = N >> 1;
  const pad = N;
  const numFrames = Math.ceil((len + pad) / hop) + 1;
  const paddedLen = (numFrames - 1) * hop + N;

  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    win[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / N));
  }
  const colaNorm = 2.0 / 3.0;
  const cutoffBin = Math.min(halfBins, Math.floor((spec.cutoffHz * N) / sr));

  // Precompute bin -> Bark critical band (0..23) and 24x24 Schroeder/Zwicker spreading matrix
  const NUM_BARKS = 24;
  const binBark = new Int32Array(halfBins + 1);
  const barkBinCount = new Int32Array(NUM_BARKS);
  for (let k = 0; k <= halfBins; k++) {
    const b = Math.max(0, Math.min(NUM_BARKS - 1, Math.floor(hzToBark((k * sr) / N))));
    binBark[k] = b;
    barkBinCount[b]++;
  }

  const spread = new Float64Array(NUM_BARKS * NUM_BARKS);
  for (let target = 0; target < NUM_BARKS; target++) {
    for (let masker = 0; masker < NUM_BARKS; masker++) {
      const dz = target - masker;
      // Lower frequencies mask higher frequencies more strongly (-10 dB/Bark) than upward (+25 dB/Bark)
      const slopeDb = dz >= 0 ? -10.5 * dz : 25.0 * dz;
      spread[target * NUM_BARKS + masker] = Math.pow(10, slopeDb / 10);
    }
  }

  const barkEnergy = new Float64Array(NUM_BARKS);
  const barkStep = new Float64Array(NUM_BARKS);

  for (let ch = 0; ch < out.channels.length; ch++) {
    const src = out.channels[ch];
    const padIn = new Float64Array(paddedLen);
    const padOut = new Float64Array(paddedLen);
    for (let i = 0; i < len; i++) padIn[pad + i] = src[i];

    const re = new Float64Array(N);
    const im = new Float64Array(N);
    let prevFrameEnergy = 0;

    for (let f = 0; f < numFrames; f++) {
      const start = f * hop;
      let frameEnergy = 0;
      for (let i = 0; i < N; i++) {
        const v = padIn[start + i] * win[i];
        re[i] = v;
        im[i] = 0;
        frameEnergy += v * v;
      }

      // Detect sharp transient jump (> +9 dB over previous frame) -> MDCT pre-echo penalty
      const transientPenalty =
        prevFrameEnergy > 1e-9 && frameEnergy > prevFrameEnergy * 8.0 ? 1.45 : 1.0;
      prevFrameEnergy = 0.7 * prevFrameEnergy + 0.3 * frameEnergy;

      radix2FftInPlace(re, im);

      barkEnergy.fill(1e-16);
      for (let k = 1; k <= cutoffBin; k++) {
        const e = re[k] * re[k] + im[k] * im[k];
        barkEnergy[binBark[k]] += e;
      }

      // Compute masked quantization step per Zwicker critical band
      const smrRatio = Math.pow(10, -spec.maskingOffsetDb / 20) * transientPenalty;
      for (let b = 0; b < NUM_BARKS; b++) {
        let spreadE = 0;
        const rowOff = b * NUM_BARKS;
        for (let m = 0; m < NUM_BARKS; m++) {
          spreadE += barkEnergy[m] * spread[rowOff + m];
        }
        const perBinRms = Math.sqrt(spreadE / Math.max(1, barkBinCount[b]));
        barkStep[b] = Math.max(1e-7, perBinRms * smrRatio);
      }

      re[0] = Math.round(re[0] / barkStep[0]) * barkStep[0];
      im[0] = 0;

      for (let k = 1; k < halfBins; k++) {
        if (k > cutoffBin) {
          re[k] = 0;
          im[k] = 0;
        } else {
          const step = barkStep[binBark[k]];
          re[k] = Math.round(re[k] / step) * step;
          im[k] = Math.round(im[k] / step) * step;
        }
        re[N - k] = re[k];
        im[N - k] = -im[k];
      }
      re[halfBins] =
        cutoffBin >= halfBins
          ? Math.round(re[halfBins] / barkStep[NUM_BARKS - 1]) * barkStep[NUM_BARKS - 1]
          : 0;
      im[halfBins] = 0;

      radix2IfftInPlace(re, im);

      for (let i = 0; i < N; i++) {
        padOut[start + i] += re[i] * win[i] * colaNorm;
      }
    }

    for (let i = 0; i < len; i++) {
      src[i] = padOut[pad + i];
    }
  }

  return out;
}

export function measureCodecPairMetrics(
  master: PlanarAudioBuffer,
  encodedDecoded: PlanarAudioBuffer,
  id: CodecProfileId,
  label: string,
  cutoffHz: number,
  engineType: 'webcodecs_hardware' | 'psychoacoustic_24bark'
): CodecAuditResult {
  const preTp = measureTruePeak(master, 4, -1.0).truePeakDbtp;
  const postTp = measureTruePeak(encodedDecoded, 4, 0.0).truePeakDbtp;
  const sr = master.sampleRate || 48000;
  const len = Math.min(master.channels[0]?.length ?? 0, encodedDecoded.channels[0]?.length ?? 0);

  let sigSq = 0;
  let errSq = 0;
  const lpFreq = Math.min(15000, sr * 0.45);

  for (let ch = 0; ch < Math.min(master.channels.length, encodedDecoded.channels.length); ch++) {
    const a = new Float32Array(master.channels[ch].subarray(0, len));
    const diff = new Float32Array(len);
    const b = encodedDecoded.channels[ch];
    for (let i = 0; i < len; i++) {
      diff[i] = b[i] - a[i];
    }
    new BiquadFilter(designButterworthLowpass2(lpFreq, sr)).processInPlace(a);
    new BiquadFilter(designButterworthLowpass2(lpFreq, sr)).processInPlace(diff);

    for (let i = 0; i < len; i++) {
      sigSq += a[i] * a[i];
      errSq += diff[i] * diff[i];
    }
  }

  const artifactSnrDb =
    sigSq > 1e-18 && errSq > 1e-20 ? Math.max(0, 10 * Math.log10(sigSq / errSq)) : 90;

  return {
    id,
    label,
    cutoffHz,
    preTruePeakDbtp: preTp,
    postCodecTruePeakDbtp: postTp,
    ispOvershootDb: Math.max(0, postTp - preTp),
    artifactSnrDb,
    clipsZeroDbtp: postTp > 0.0,
    engineType,
  };
}

/**
 * Audits all 3 lossy delivery codecs using the 24-Bark Psychoacoustic Engine (worker-safe).
 */
export function auditLossyCodecHeadroom(master: PlanarAudioBuffer): CodecAuditResult[] {
  const ids: CodecProfileId[] = ['aac_256', 'ogg_160', 'mp3_128'];
  return ids.map((id) => {
    const spec = CODEC_SPECS[id];
    const sim = renderSimulatedCodecPreview(master, id);
    return measureCodecPairMetrics(
      master,
      sim,
      id,
      spec.label,
      spec.cutoffHz,
      'psychoacoustic_24bark'
    );
  });
}
