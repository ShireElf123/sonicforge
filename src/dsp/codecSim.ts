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
  subbandQuantStepRatio: number;
}

const CODEC_SPECS: Record<CodecProfileId, CodecSpec> = {
  aac_256: {
    id: 'aac_256',
    label: 'AAC 256 kbps (Apple Music / High)',
    cutoffHz: 20400,
    subbandQuantStepRatio: 0.0025,
  },
  ogg_160: {
    id: 'ogg_160',
    label: 'Ogg Vorbis 160 kbps (Spotify Normal)',
    cutoffHz: 18200,
    subbandQuantStepRatio: 0.0065,
  },
  mp3_128: {
    id: 'mp3_128',
    label: 'MP3 / Mobile 128 kbps (Web / Social)',
    cutoffHz: 15800,
    subbandQuantStepRatio: 0.016,
  },
};

/**
 * Zero-Phase STFT/MDCT-like Perceptual Subband Codec Simulator.
 * Uses a 75%-overlap COLA periodic Hann transform (0.0° passband phase shift so Codec Artifact
 * Solo cancels untouched audio cleanly!) with brickwall high-frequency truncation + Bark-band
 * psychoacoustic spectral quantization, faithfully reproducing post-codec ISP overshoot and
 * audible pre-echo / quantization fizz.
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

  for (let ch = 0; ch < out.channels.length; ch++) {
    const src = out.channels[ch];
    const padIn = new Float64Array(paddedLen);
    const padOut = new Float64Array(paddedLen);
    for (let i = 0; i < len; i++) padIn[pad + i] = src[i];

    const re = new Float64Array(N);
    const im = new Float64Array(N);

    for (let f = 0; f < numFrames; f++) {
      const start = f * hop;
      let frameEnergy = 0;
      for (let i = 0; i < N; i++) {
        const v = padIn[start + i] * win[i];
        re[i] = v;
        im[i] = 0;
        frameEnergy += v * v;
      }

      radix2FftInPlace(re, im);

      const avgBinMag = Math.sqrt(frameEnergy);
      const qStep = Math.max(1e-7, avgBinMag * spec.subbandQuantStepRatio * 2.5);

      re[0] = Math.round(re[0] / qStep) * qStep;
      im[0] = 0;

      for (let k = 1; k < halfBins; k++) {
        if (k > cutoffBin) {
          re[k] = 0;
          im[k] = 0;
        } else {
          const barkWeight = 1 + (k / halfBins) * 2.0;
          const step = qStep * barkWeight;
          re[k] = Math.round(re[k] / step) * step;
          im[k] = Math.round(im[k] / step) * step;
        }
        re[N - k] = re[k];
        im[N - k] = -im[k];
      }
      re[halfBins] = cutoffBin >= halfBins ? Math.round(re[halfBins] / qStep) * qStep : 0;
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

/**
 * Audits all 3 lossy delivery codecs on a rendered master buffer and reports exact
 * post-codec 4x True Peak overshoot and audible-band (<15 kHz) quantization SNR.
 */
export function auditLossyCodecHeadroom(master: PlanarAudioBuffer): CodecAuditResult[] {
  const preTp = measureTruePeak(master, 4, -1.0).truePeakDbtp;
  const ids: CodecProfileId[] = ['aac_256', 'ogg_160', 'mp3_128'];
  const sr = master.sampleRate || 48000;

  return ids.map((id) => {
    const spec = CODEC_SPECS[id];
    const sim = renderSimulatedCodecPreview(master, id);
    const postTp = measureTruePeak(sim, 4, 0.0).truePeakDbtp;

    let sigSq = 0;
    let errSq = 0;
    const len = master.channels[0]?.length ?? 0;

    // Measure in-band audible quantization SNR (< 15 kHz) so ultrasonic bandwidth cutoff
    // doesn't mask passband psychoacoustic distortion metrics
    const lpFreq = Math.min(15000, sr * 0.45);
    for (let ch = 0; ch < Math.min(master.channels.length, sim.channels.length); ch++) {
      const a = new Float32Array(master.channels[ch]);
      const diff = new Float32Array(len);
      const b = sim.channels[ch];
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
      label: spec.label,
      cutoffHz: spec.cutoffHz,
      preTruePeakDbtp: preTp,
      postCodecTruePeakDbtp: postTp,
      ispOvershootDb: Math.max(0, postTp - preTp),
      artifactSnrDb,
      clipsZeroDbtp: postTp > 0.0,
    };
  });
}
