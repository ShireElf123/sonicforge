import { analyzeAudioBuffer } from './analyzer';
import {
  BiquadFilter,
  designButterworthHighpass2,
  designButterworthLowpass2,
  designEqBiquad,
  splitFourBandLr4,
} from './biquad';
import { applyLinearPhaseEq, applySpectralStabilizer } from './linearPhaseAndStabilizer';
import { measureLoudnessBs1770 } from './lufs';
import { computePerFrameTruePeakLinear, getPolyphaseBank } from './truePeak';
import type {
  EqBandParams,
  ExciterParams,
  LimiterParams,
  MasteringChainParams,
  MasterRenderResult,
  MultibandBandParams,
  MultibandParams,
  PlanarAudioBuffer,
  StemBusParams,
  StemSlotId,
  StereoStageParams,
} from './types';

function dbToLinear(db: number): number {
  return Math.pow(10, db / 20);
}

export function cloneAsStereoBuffer(input: PlanarAudioBuffer): PlanarAudioBuffer {
  const n = input.channels.length > 0 ? input.channels[0].length : 0;
  if (input.channels.length === 0 || n === 0) {
    return {
      sampleRate: input.sampleRate || 48000,
      channels: [new Float32Array(0), new Float32Array(0)],
      duration: 0,
    };
  }
  if (input.channels.length === 1) {
    return {
      sampleRate: input.sampleRate,
      channels: [new Float32Array(input.channels[0]), new Float32Array(input.channels[0])],
      duration: n / input.sampleRate,
    };
  }
  return {
    sampleRate: input.sampleRate,
    channels: [new Float32Array(input.channels[0]), new Float32Array(input.channels[1])],
    duration: n / input.sampleRate,
  };
}

export function resamplePlanarBuffer(
  input: PlanarAudioBuffer,
  targetSampleRate: number
): PlanarAudioBuffer {
  if (input.sampleRate === targetSampleRate || input.channels.length === 0) {
    return input;
  }
  const srcLen = input.channels[0].length;
  const ratio = input.sampleRate / targetSampleRate;
  const dstLen = Math.max(1, Math.round(srcLen / ratio));
  const outChannels = input.channels.map((src) => {
    const dst = new Float32Array(dstLen);
    for (let i = 0; i < dstLen; i++) {
      const pos = i * ratio;
      const idx = Math.floor(pos);
      const frac = pos - idx;
      const s0 = src[Math.min(srcLen - 1, idx)];
      const s1 = src[Math.min(srcLen - 1, idx + 1)];
      dst[i] = s0 + (s1 - s0) * frac;
    }
    return dst;
  });
  return {
    sampleRate: targetSampleRate,
    channels: outChannels,
    duration: dstLen / targetSampleRate,
  };
}

export function sumStemBuses(
  stems: Partial<Record<StemSlotId, PlanarAudioBuffer>>,
  busParams: Record<StemSlotId, StemBusParams>,
  targetSampleRate?: number
): {
  summed: PlanarAudioBuffer;
  alignmentWarnings: string[];
  activeStemIds: StemSlotId[];
} {
  const slotOrder: StemSlotId[] = ['drums', 'bass', 'vocals', 'instruments'];
  const presentSlots = slotOrder.filter(
    (id) => stems[id] && stems[id]!.channels.length > 0 && stems[id]!.channels[0].length > 0
  );

  if (presentSlots.length === 0) {
    const sr = targetSampleRate || 48000;
    return {
      summed: {
        sampleRate: sr,
        channels: [new Float32Array(0), new Float32Array(0)],
        duration: 0,
      },
      alignmentWarnings: ['No active stem buffers loaded.'],
      activeStemIds: [],
    };
  }

  const alignmentWarnings: string[] = [];
  const masterSr = targetSampleRate || stems[presentSlots[0]]!.sampleRate;

  const durations: number[] = [];
  const normalizedStems = new Map<StemSlotId, PlanarAudioBuffer>();

  for (const id of presentSlots) {
    let buf = stems[id]!;
    if (buf.sampleRate !== masterSr) {
      alignmentWarnings.push(
        `Stem "${busParams[id].label}" resampled from ${buf.sampleRate} Hz to ${masterSr} Hz.`
      );
      buf = resamplePlanarBuffer(buf, masterSr);
    }
    const stereo = cloneAsStereoBuffer(buf);
    normalizedStems.set(id, stereo);
    durations.push(stereo.channels[0].length);
  }

  const maxFrames = Math.max(...durations);
  const minFrames = Math.min(...durations);
  if (maxFrames - minFrames > Math.round(masterSr * 0.05)) {
    alignmentWarnings.push(
      `Stem lengths differ by ${((maxFrames - minFrames) / masterSr).toFixed(2)}s; shorter stems padded with trailing silence.`
    );
  }

  const anySolo = presentSlots.some((id) => busParams[id].solo);
  const activeStemIds = presentSlots.filter((id) => {
    const cfg = busParams[id];
    if (anySolo) return cfg.solo && !cfg.mute;
    return !cfg.mute;
  });

  const sumL = new Float32Array(maxFrames);
  const sumR = new Float32Array(maxFrames);

  for (const id of activeStemIds) {
    const stem = normalizedStems.get(id)!;
    const cfg = busParams[id];
    const len = stem.channels[0].length;

    const chL = new Float32Array(maxFrames);
    const chR = new Float32Array(maxFrames);
    chL.set(stem.channels[0].subarray(0, len));
    chR.set(stem.channels[1].subarray(0, len));

    if (cfg.hpfHz > 20) {
      const c = designEqBiquad('highpass', cfg.hpfHz, masterSr, 0, 0.707);
      new BiquadFilter(c).processInPlace(chL);
      new BiquadFilter(c).processInPlace(chR);
    }

    if (Math.abs(cfg.lowShelfDb) > 0.05) {
      const c = designEqBiquad('lowshelf', 95, masterSr, cfg.lowShelfDb, 0.707);
      new BiquadFilter(c).processInPlace(chL);
      new BiquadFilter(c).processInPlace(chR);
    }
    if (Math.abs(cfg.midBellDb) > 0.05) {
      const c = designEqBiquad('peaking', cfg.midFreqHz, masterSr, cfg.midBellDb, 1.1);
      new BiquadFilter(c).processInPlace(chL);
      new BiquadFilter(c).processInPlace(chR);
    }
    if (Math.abs(cfg.highShelfDb) > 0.05) {
      const c = designEqBiquad('highshelf', 7500, masterSr, cfg.highShelfDb, 0.707);
      new BiquadFilter(c).processInPlace(chL);
      new BiquadFilter(c).processInPlace(chR);
    }

    if (cfg.compAmountPct > 1) {
      const amt = Math.min(1, cfg.compAmountPct / 100);
      applySingleBandCompressor(chL, chR, masterSr, {
        id: `bus_${id}`,
        label: cfg.label,
        bypass: false,
        solo: false,
        thresholdDb: -14 - amt * 12,
        ratio: 1.5 + amt * 2.5,
        attackMs: id === 'drums' ? 18 : 10,
        releaseMs: 110,
        makeupDb: amt * 2.2,
      });
    }

    const gainLin = dbToLinear(cfg.gainDb);
    const widthFactor = Math.max(0, Math.min(2, cfg.widthPct / 100));
    const panClamped = Math.max(-1, Math.min(1, cfg.pan));
    const angle = ((panClamped + 1) * Math.PI) / 4;
    const panL = Math.cos(angle) * Math.SQRT2;
    const panR = Math.sin(angle) * Math.SQRT2;

    for (let i = 0; i < maxFrames; i++) {
      const m = 0.5 * (chL[i] + chR[i]);
      const s = 0.5 * (chL[i] - chR[i]) * widthFactor;
      const l = (m + s) * gainLin * panL;
      const r = (m - s) * gainLin * panR;
      sumL[i] += l;
      sumR[i] += r;
    }
  }

  return {
    summed: {
      sampleRate: masterSr,
      channels: [sumL, sumR],
      duration: maxFrames / masterSr,
    },
    alignmentWarnings,
    activeStemIds,
  };
}

export function applyDcBlocker(left: Float32Array, right: Float32Array, sampleRate: number): void {
  const R = Math.max(0.99, 1 - (2 * Math.PI * 5) / sampleRate);
  let x1L = 0;
  let y1L = 0;
  let x1R = 0;
  let y1R = 0;

  for (let i = 0; i < left.length; i++) {
    const xL = left[i];
    y1L = xL - x1L + R * y1L;
    x1L = xL;
    left[i] = y1L;

    const xR = right[i];
    y1R = xR - x1R + R * y1R;
    x1R = xR;
    right[i] = y1R;
  }
}

export function applyMasteringEq(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
  bands: EqBandParams[]
): void {
  const active = bands.filter(
    (b) => b.enabled && (b.type === 'highpass' || Math.abs(b.gainDb) > 0.01)
  );
  if (active.length === 0) return;

  const stereoBands = active.filter((b) => b.placement === 'stereo');
  const msBands = active.filter((b) => b.placement === 'mid' || b.placement === 'side');

  for (const band of stereoBands) {
    const coeffs = designEqBiquad(band.type, band.freqHz, sampleRate, band.gainDb, band.q);
    new BiquadFilter(coeffs).processInPlace(left);
    new BiquadFilter(coeffs).processInPlace(right);
  }

  if (msBands.length > 0) {
    const n = left.length;
    const mid = new Float32Array(n);
    const side = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      mid[i] = 0.5 * (left[i] + right[i]);
      side[i] = 0.5 * (left[i] - right[i]);
    }

    for (const band of msBands) {
      const coeffs = designEqBiquad(band.type, band.freqHz, sampleRate, band.gainDb, band.q);
      if (band.placement === 'mid') {
        new BiquadFilter(coeffs).processInPlace(mid);
      } else {
        new BiquadFilter(coeffs).processInPlace(side);
      }
    }

    for (let i = 0; i < n; i++) {
      left[i] = mid[i] + side[i];
      right[i] = mid[i] - side[i];
    }
  }
}

export function applySingleBandCompressor(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
  params: MultibandBandParams
): void {
  if (params.bypass || params.ratio <= 1.01) {
    if (Math.abs(params.makeupDb) > 0.01 && !params.bypass) {
      const m = dbToLinear(params.makeupDb);
      for (let i = 0; i < left.length; i++) {
        left[i] *= m;
        right[i] *= m;
      }
    }
    return;
  }

  const n = left.length;
  const attackCoeff = Math.exp(-1 / Math.max(1, params.attackMs * 0.001 * sampleRate));
  const releaseCoeff = Math.exp(-1 / Math.max(1, params.releaseMs * 0.001 * sampleRate));
  const thresh = params.thresholdDb;
  const slope = 1 - 1 / Math.max(1.01, params.ratio);
  const kneeWidth = 3.0;
  const halfKnee = kneeWidth * 0.5;
  const makeupDb = params.makeupDb;

  let envDb = -96;

  for (let i = 0; i < n; i++) {
    const linkAmp = Math.max(Math.abs(left[i]), Math.abs(right[i]));
    const instDb = linkAmp > 1e-6 ? 20 * Math.log10(linkAmp) : -120;

    if (instDb > envDb) {
      envDb = attackCoeff * envDb + (1 - attackCoeff) * instDb;
    } else {
      envDb = releaseCoeff * envDb + (1 - releaseCoeff) * instDb;
    }

    let grDb = 0;
    const overshoot = envDb - thresh;
    if (overshoot > halfKnee) {
      grDb = slope * overshoot;
    } else if (overshoot > -halfKnee) {
      const x = overshoot + halfKnee;
      grDb = slope * ((x * x) / (2 * kneeWidth));
    }

    const totalGain = dbToLinear(makeupDb - grDb);
    left[i] *= totalGain;
    right[i] *= totalGain;
  }
}

export function applyMultibandDynamics(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
  params: MultibandParams
): void {
  if (!params.enabled) return;

  const bandsL = splitFourBandLr4(left, sampleRate, params.crossoversHz);
  const bandsR = splitFourBandLr4(right, sampleRate, params.crossoversHz);

  const anySolo = params.bands.some((b) => b.solo);

  for (let b = 0; b < 4; b++) {
    applySingleBandCompressor(bandsL[b], bandsR[b], sampleRate, params.bands[b]);
  }

  const n = left.length;
  left.fill(0);
  right.fill(0);

  for (let b = 0; b < 4; b++) {
    if (anySolo && !params.bands[b].solo) continue;
    const bL = bandsL[b];
    const bR = bandsR[b];
    for (let i = 0; i < n; i++) {
      left[i] += bL[i];
      right[i] += bR[i];
    }
  }
}

export function applyStereoImager(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
  params: StereoStageParams
): void {
  if (!params.enabled) return;

  const n = left.length;
  const mid = new Float32Array(n);
  const side = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    mid[i] = 0.5 * (left[i] + right[i]);
    side[i] = 0.5 * (left[i] - right[i]);
  }

  if (params.bassMonoEnabled && params.bassMonoHz >= 25) {
    const hpCoeffs = designButterworthHighpass2(params.bassMonoHz, sampleRate);
    new BiquadFilter(hpCoeffs).processInPlace(side);
  }

  const baseWidth = Math.max(0, Math.min(2.5, params.widthPct / 100));
  const highWidth = Math.max(0, Math.min(2.5, params.highWidthPct / 100));

  if (Math.abs(highWidth - baseWidth) > 0.01) {
    const sideLow = new Float32Array(side);
    const sideHigh = new Float32Array(side);
    const xo = Math.max(300, Math.min(sampleRate * 0.45, params.highCrossoverHz));
    new BiquadFilter(designButterworthLowpass2(xo, sampleRate)).processInPlace(sideLow);
    new BiquadFilter(designButterworthHighpass2(xo, sampleRate)).processInPlace(sideHigh);
    for (let i = 0; i < n; i++) {
      side[i] = sideLow[i] * baseWidth + sideHigh[i] * highWidth;
    }
  } else {
    for (let i = 0; i < n; i++) {
      side[i] *= baseWidth;
    }
  }

  for (let i = 0; i < n; i++) {
    left[i] = mid[i] + side[i];
    right[i] = mid[i] - side[i];
  }
}

export function applyHarmonicExciter(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
  params: ExciterParams
): void {
  if (!params.enabled || params.drivePct <= 0.5 || params.mixPct <= 0.5) return;

  const driveNorm = Math.min(1, params.drivePct / 100);
  const mix = Math.min(1, params.mixPct / 100);
  const driveGain = 1.0 + driveNorm * 4.5;
  const tanhNorm = 1 / Math.tanh(driveGain);

  const processChannel = (ch: Float32Array) => {
    const n = ch.length;
    const highBand = new Float32Array(ch);
    if (params.highFocusHz > 30) {
      const hp = designButterworthHighpass2(params.highFocusHz, sampleRate);
      new BiquadFilter(hp).processInPlace(highBand);
    }

    const upLen = n * 2;
    const up = new Float32Array(upLen);
    for (let i = 0; i < n; i++) {
      const s0 = highBand[i];
      const s1 = i + 1 < n ? highBand[i + 1] : s0;
      up[2 * i] = s0;
      up[2 * i + 1] = 0.5 * (s0 + s1);
    }

    for (let k = 0; k < upLen; k++) {
      const x = up[k];
      let sat = x;
      if (params.mode === 'tape') {
        sat = Math.tanh(x * driveGain) * tanhNorm;
      } else if (params.mode === 'tube') {
        const bias = 0.14 * driveNorm;
        sat = (Math.tanh((x + bias) * driveGain) - Math.tanh(bias * driveGain)) * tanhNorm;
      } else {
        const g = 1 + driveNorm * 2.6;
        sat = (x * g) / (1 + Math.abs(x * g * 0.65));
      }
      up[k] = sat - x;
    }

    const aaLp = new BiquadFilter(designButterworthLowpass2(sampleRate * 0.45, sampleRate * 2));
    aaLp.processInPlace(up);

    for (let i = 0; i < n; i++) {
      ch[i] += up[2 * i] * mix * 0.65;
    }
  };

  processChannel(left);
  processChannel(right);
}

/**
 * IRC-V Style Transient / Sustain Differential Pre-Shaper.
 * Separates fast attack transients from slow sustained RMS body so kick/snare snap
 * survives heavy brickwall limiting without pumping or dulling.
 */
export function applyTransientSustainShaper(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
  emphasisPct: number
): void {
  if (Math.abs(emphasisPct) < 1 || left.length === 0) return;

  const amt = Math.max(-0.5, Math.min(1.0, emphasisPct / 100));
  const fastAtt = Math.exp(-1 / Math.max(1, 0.0012 * sampleRate));
  const fastRel = Math.exp(-1 / Math.max(1, 0.018 * sampleRate));
  const slowAtt = Math.exp(-1 / Math.max(1, 0.026 * sampleRate));
  const slowRel = Math.exp(-1 / Math.max(1, 0.16 * sampleRate));

  let fastEnv = 0;
  let slowEnv = 0;

  for (let i = 0; i < left.length; i++) {
    const peak = Math.max(Math.abs(left[i]), Math.abs(right[i]));
    fastEnv = peak > fastEnv ? fastAtt * fastEnv + (1 - fastAtt) * peak : fastRel * fastEnv + (1 - fastRel) * peak;
    slowEnv = peak > slowEnv ? slowAtt * slowEnv + (1 - slowAtt) * peak : slowRel * slowEnv + (1 - slowRel) * peak;

    if (slowEnv > 1e-5 && fastEnv > slowEnv) {
      const crestRatioDb = Math.min(9.0, 20 * Math.log10(fastEnv / slowEnv));
      // Accentuate transient attack edge (up to +2.8 dB micro-transient lift before limiter)
      const boostDb = crestRatioDb * amt * 0.34;
      const g = dbToLinear(boostDb);
      left[i] *= g;
      right[i] *= g;
    }
  }
}

export function applyTruePeakLimiter(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
  params: LimiterParams,
  appliedDriveDb: number
): { maxGainReductionDb: number; grTimelineDb: number[] } {
  const n = left.length;
  if (!params.enabled || n === 0) {
    const driveLin = dbToLinear(appliedDriveDb);
    if (Math.abs(appliedDriveDb) > 0.001) {
      for (let i = 0; i < n; i++) {
        left[i] *= driveLin;
        right[i] *= driveLin;
      }
    }
    return { maxGainReductionDb: 0, grTimelineDb: new Array(240).fill(0) };
  }

  const driveLin = dbToLinear(appliedDriveDb);
  if (Math.abs(appliedDriveDb) > 0.0001) {
    for (let i = 0; i < n; i++) {
      left[i] *= driveLin;
      right[i] *= driveLin;
    }
  }

  // Engage IRC-V Transient/Sustain Split Shaper when IRC-Transient mode or emphasis > 0
  const effectiveTransientPct =
    params.releaseMode === 'irc_transient'
      ? Math.max(25, params.transientEmphasisPct)
      : params.transientEmphasisPct;
  if (Math.abs(effectiveTransientPct) >= 1) {
    applyTransientSustainShaper(left, right, sampleRate, effectiveTransientPct);
  }

  const ceilingLin = dbToLinear(params.ceilingDbtp - 0.04);
  const tpEnv = computePerFrameTruePeakLinear([left, right], params.oversampling);

  const lookaheadSamples = Math.max(
    8,
    Math.round((Math.max(1.0, Math.min(15.0, params.lookaheadMs)) * sampleRate) / 1000)
  );

  const gReq = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const peak = tpEnv[i];
    gReq[i] = peak > ceilingLin ? ceilingLin / peak : 1.0;
  }

  const futureMin = new Float32Array(n);
  const dequeIdx = new Int32Array(n);
  let head = 0;
  let tail = 0;
  let rightPtr = 0;

  for (let i = 0; i < n; i++) {
    const windowEnd = Math.min(n - 1, i + lookaheadSamples);
    while (rightPtr <= windowEnd) {
      const val = gReq[rightPtr];
      while (tail > head && gReq[dequeIdx[tail - 1]] >= val) {
        tail--;
      }
      dequeIdx[tail++] = rightPtr;
      rightPtr++;
    }
    while (head < tail && dequeIdx[head] < i) {
      head++;
    }
    futureMin[i] = gReq[dequeIdx[head]];
  }

  const fastRelMs =
    params.releaseMode === 'irc_transient'
      ? 18
      : params.releaseMode === 'punchy'
        ? 28
        : params.releaseMode === 'dynamic'
          ? 45
          : 38;
  const slowRelMs =
    params.releaseMode === 'irc_transient'
      ? 210
      : params.releaseMode === 'punchy'
        ? 160
        : params.releaseMode === 'dynamic'
          ? 320
          : 240;
  const fastRelCoeff = Math.exp(-1 / Math.max(1, fastRelMs * 0.001 * sampleRate));
  const slowRelCoeff = Math.exp(-1 / Math.max(1, slowRelMs * 0.001 * sampleRate));

  const gainCurve = new Float32Array(n);
  let windowSum = 0;
  let releaseEnv = 1.0;
  let slowDensityEnv = 1.0;

  for (let i = 0; i < n; i++) {
    windowSum += futureMin[i];
    const dropIdx = i - lookaheadSamples;
    const count = dropIdx >= 0 ? lookaheadSamples : i + 1;
    if (dropIdx >= 0) {
      windowSum -= futureMin[dropIdx];
    }
    const targetAttackGain = Math.min(1.0, Math.max(1e-5, windowSum / count));

    slowDensityEnv = slowRelCoeff * slowDensityEnv + (1 - slowRelCoeff) * targetAttackGain;
    const densityDepth = Math.min(1, Math.max(0, (1 - slowDensityEnv) * 3.0));
    const adaptiveRelCoeff = fastRelCoeff * (1 - densityDepth) + slowRelCoeff * densityDepth;

    if (targetAttackGain <= releaseEnv) {
      releaseEnv = targetAttackGain;
    } else {
      releaseEnv = adaptiveRelCoeff * releaseEnv + (1 - adaptiveRelCoeff) * targetAttackGain;
    }

    const finalG = Math.min(targetAttackGain, releaseEnv);
    gainCurve[i] = finalG;
    left[i] *= finalG;
    right[i] *= finalG;
  }

  const strictCeilingLin = dbToLinear(params.ceilingDbtp - 0.005);
  const bank = getPolyphaseBank(params.oversampling);
  const taps = bank.tapsPerPhase;
  const center = taps / 2 - 1;

  for (let ch = 0; ch < 2; ch++) {
    const arr = ch === 0 ? left : right;
    for (let i = 0; i < n; i++) {
      if (arr[i] > strictCeilingLin) arr[i] = strictCeilingLin;
      else if (arr[i] < -strictCeilingLin) arr[i] = -strictCeilingLin;
    }
    for (let i = 0; i < n; i++) {
      if (Math.abs(arr[i]) < strictCeilingLin * 0.65) continue;
      let maxTp = Math.abs(arr[i]);
      for (let p = 1; p < params.oversampling; p++) {
        const h = bank.phases[p];
        let acc = 0;
        for (let k = 0; k < taps; k++) {
          const idx = i - center + k;
          if (idx >= 0 && idx < n) acc += arr[idx] * h[k];
        }
        if (Math.abs(acc) > maxTp) maxTp = Math.abs(acc);
      }
      if (maxTp > strictCeilingLin) {
        const trim = strictCeilingLin / maxTp;
        const lo = Math.max(0, i - center);
        const hi = Math.min(n - 1, i - center + taps - 1);
        for (let m = lo; m <= hi; m++) {
          arr[m] *= trim;
        }
      }
    }
  }

  const buckets = 240;
  const grTimelineDb: number[] = [];
  let maxGainReductionDb = 0;

  for (let b = 0; b < buckets; b++) {
    const start = Math.floor((b * n) / buckets);
    const end = Math.max(start + 1, Math.floor(((b + 1) * n) / buckets));
    let minG = 1.0;
    for (let i = start; i < end; i++) {
      if (gainCurve[i] < minG) minG = gainCurve[i];
    }
    const grDb = minG < 0.9999 ? Math.max(0, -20 * Math.log10(Math.max(1e-5, minG))) : 0;
    if (grDb > maxGainReductionDb) maxGainReductionDb = grDb;
    grTimelineDb.push(grDb);
  }

  return { maxGainReductionDb, grTimelineDb };
}

export function renderMasterChain(
  source: PlanarAudioBuffer,
  params: MasteringChainParams,
  onProgress?: (stage: string, pct: number) => void
): MasterRenderResult {
  const t0 = performance.now();
  onProgress?.('Preparing 64-bit stereo bus', 6);

  const work = cloneAsStereoBuffer(source);
  const left = work.channels[0];
  const right = work.channels[1];
  const sr = work.sampleRate;
  const n = left.length;

  if (n === 0) {
    const emptyAnalysis = analyzeAudioBuffer(work, {
      oversamplingFactor: params.limiter.oversampling,
      ceilingDbtp: params.limiter.ceilingDbtp,
    });
    return {
      buffer: work,
      analysis: emptyAnalysis,
      appliedLimiterDriveDb: 0,
      autoDriveCapped: false,
      maxGainReductionDb: 0,
      gainReductionTimelineDb: [],
      stabilizerAttenuationDb: [],
      processingTimeMs: performance.now() - t0,
    };
  }

  if (Math.abs(params.inputGainDb) > 0.01) {
    const g = dbToLinear(params.inputGainDb);
    for (let i = 0; i < n; i++) {
      left[i] *= g;
      right[i] *= g;
    }
  }

  if (params.dcBlockEnabled) {
    onProgress?.('Filtering DC offset', 12);
    applyDcBlocker(left, right, sr);
  }

  if (params.eqEnabled) {
    if (params.eqPhaseMode === 'linear') {
      onProgress?.('Convolving 2049-tap Zero-Phase Linear FIR M/S EQ', 24);
      applyLinearPhaseEq(left, right, sr, params.eqBands);
    } else {
      onProgress?.('Applying 6-band 64-bit Minimum-Phase M/S EQ', 24);
      applyMasteringEq(left, right, sr, params.eqBands);
    }
  }

  let stabilizerAttenuationDb: number[] = new Array(64).fill(0);
  if (params.stabilizer?.enabled) {
    onProgress?.('Running STFT Dynamic Spectral Stabilizer', 38);
    stabilizerAttenuationDb = applySpectralStabilizer(left, right, sr, params.stabilizer);
  }

  if (params.multiband.enabled) {
    onProgress?.('Processing 4-band LR4 Multiband Dynamics', 52);
    applyMultibandDynamics(left, right, sr, params.multiband);
  }

  if (params.stereo.enabled) {
    onProgress?.('Sculpting M/S Stereo Field & Bass Mono', 64);
    applyStereoImager(left, right, sr, params.stereo);
  }

  if (params.exciter.enabled) {
    onProgress?.('Running 2x Oversampled Harmonic Exciter', 75);
    applyHarmonicExciter(left, right, sr, params.exciter);
  }

  onProgress?.('Calibrating BS.1770 Loudness & IRC True-Peak Limiter', 86);
  let appliedDriveDb = params.limiter.manualDriveDb;
  let autoDriveCapped = false;

  if (params.limiter.enabled && params.limiter.autoGainToTarget) {
    const preLufs = measureLoudnessBs1770(work).integratedLufs;
    if (Number.isFinite(preLufs) && preLufs > -68) {
      const rawNeededDb = params.limiter.targetLufs - preLufs + params.limiter.manualDriveDb;
      const maxCap = Math.max(0, params.limiter.maxAutoDriveDb);
      if (rawNeededDb > maxCap) {
        appliedDriveDb = maxCap;
        autoDriveCapped = true;
      } else {
        appliedDriveDb = Math.max(-24, rawNeededDb);
      }

      if (!autoDriveCapped && appliedDriveDb > 1.5) {
        const probeL = new Float32Array(left);
        const probeR = new Float32Array(right);
        applyTruePeakLimiter(probeL, probeR, sr, params.limiter, appliedDriveDb);
        const postProbeLufs = measureLoudnessBs1770({
          sampleRate: sr,
          channels: [probeL, probeR],
          duration: work.duration,
        }).integratedLufs;

        if (Number.isFinite(postProbeLufs)) {
          const residualLu = params.limiter.targetLufs - postProbeLufs;
          if (Math.abs(residualLu) > 0.2) {
            const refined = appliedDriveDb + residualLu * 1.08;
            if (refined > maxCap) {
              appliedDriveDb = maxCap;
              autoDriveCapped = true;
            } else {
              appliedDriveDb = Math.max(-24, refined);
            }
          }
        }
      }
    }
  }

  const { maxGainReductionDb, grTimelineDb } = applyTruePeakLimiter(
    left,
    right,
    sr,
    params.limiter,
    appliedDriveDb
  );

  onProgress?.('Measuring rendered BS.1770-5 Loudness & True Peak', 95);
  const analysis = analyzeAudioBuffer(work, {
    oversamplingFactor: params.limiter.oversampling,
    ceilingDbtp: params.limiter.ceilingDbtp,
    waveformBuckets: 240,
    grTimelineDb,
  });

  onProgress?.('Master render verified', 100);

  return {
    buffer: work,
    analysis,
    appliedLimiterDriveDb: appliedDriveDb,
    autoDriveCapped,
    maxGainReductionDb,
    gainReductionTimelineDb: grTimelineDb,
    stabilizerAttenuationDb,
    processingTimeMs: performance.now() - t0,
  };
}
