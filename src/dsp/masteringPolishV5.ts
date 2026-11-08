import {
  BiquadFilter,
  designButterworthHighpass2,
  designButterworthLowpass2,
} from './biquad';
import type { MasteringPolishV5Params } from './types';

function dbToLinear(db: number): number {
  return Math.pow(10, db / 20);
}

/**
 * 1. Cubic Hermite Spline Waveform De-Clipper (iZotope RX De-Clip / Weiss style).
 * Detects flat-topped / saturated digital plateaus and reconstructs the missing natural
 * rounded crest from pre-clip and post-clip boundary slopes before gain staging.
 */
export function applyCubicHermiteDeclipper(
  left: Float32Array,
  right: Float32Array
): number {
  const n = left.length;
  if (n < 8) return 0;

  let globalPeak = 0;
  for (let i = 0; i < n; i++) {
    const al = Math.abs(left[i]);
    const ar = Math.abs(right[i]);
    if (al > globalPeak) globalPeak = al;
    if (ar > globalPeak) globalPeak = ar;
  }

  // Only engage if signal has hot peaks or flat-topped plateaus near full scale
  if (globalPeak < 0.35) return 0;

  let repairedSamples = 0;

  const declipChannel = (ch: Float32Array) => {
    let chMax = 0;
    for (let i = 0; i < n; i++) {
      const a = Math.abs(ch[i]);
      if (a > chMax) chMax = a;
    }
    if (chMax < 0.35) return;

    const rail = chMax * 0.982;
    let i = 2;
    while (i < n - 3) {
      if (Math.abs(ch[i]) >= rail) {
        const sign = ch[i] >= 0 ? 1 : -1;
        const a = i;
        let b = i;
        while (b + 1 < n - 2 && b - a < 64 && ch[b + 1] * sign >= rail) {
          b++;
        }
        const runLen = b - a + 1;
        // Reconstruct runs of >=2 flat-topped samples (or single-sample hard rail >= 0.992)
        if (runLen >= 2 || chMax >= 0.992) {
          const i0 = a - 1;
          const i1 = b + 1;
          const y0 = ch[i0];
          const y1 = ch[i1];
          if (y0 * sign > 0 && y1 * sign > 0) {
            const span = i1 - i0;
            // Incoming and outgoing slopes scaled to [0, 1] parameter interval
            const rawSlope0 = (ch[i0] - ch[i0 - 1]) * span;
            const rawSlope1 = (ch[i1 + 1] - ch[i1]) * span;

            // Ensure outward-arching crest curvature bounded to <= +4.0 dB (1.58x) peak recovery
            const maxSlope = chMax * 2.2;
            const m0 =
              sign > 0
                ? Math.max(0.02 * chMax, Math.min(maxSlope, rawSlope0))
                : Math.min(-0.02 * chMax, Math.max(-maxSlope, rawSlope0));
            const m1 =
              sign > 0
                ? Math.min(-0.02 * chMax, Math.max(-maxSlope, rawSlope1))
                : Math.max(0.02 * chMax, Math.min(maxSlope, rawSlope1));

            const maxAllowedAmp = chMax * 1.58;
            for (let k = a; k <= b; k++) {
              const t = (k - i0) / span;
              const t2 = t * t;
              const t3 = t2 * t;
              const h00 = 2 * t3 - 3 * t2 + 1;
              const h10 = t3 - 2 * t2 + t;
              const h01 = -2 * t3 + 3 * t2;
              const h11 = t3 - t2;
              const interp = h00 * y0 + h10 * m0 + h01 * y1 + h11 * m1;
              ch[k] = Math.max(-maxAllowedAmp, Math.min(maxAllowedAmp, interp));
              repairedSamples++;
            }
          }
        }
        i = b + 1;
      } else {
        i++;
      }
    }
  };

  declipChannel(left);
  declipChannel(right);

  if (repairedSamples > 0) {
    let postPeak = 0;
    for (let i = 0; i < n; i++) {
      const p = Math.max(Math.abs(left[i]), Math.abs(right[i]));
      if (p > postPeak) postPeak = p;
    }
    if (postPeak > 0.96) {
      const scale = 0.94 / postPeak;
      for (let i = 0; i < n; i++) {
        left[i] *= scale;
        right[i] *= scale;
      }
    }
  }

  return repairedSamples;
}

/**
 * 2. Band-Focused (65 Hz – 6.2 kHz) SPL-Style Differential Transient Recovery.
 * Restores lost kick & snare punch on over-squashed bedroom bounces without adding sub rumble or sibilance.
 */
export function applyDifferentialTransientRecovery(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
  recoveryPct: number
): void {
  const amt = Math.max(0, Math.min(1, recoveryPct / 100));
  const n = left.length;
  if (amt < 0.02 || n === 0) return;

  const punchL = new Float32Array(left);
  const punchR = new Float32Array(right);

  const hp = designButterworthHighpass2(65, sampleRate);
  const lp = designButterworthLowpass2(6200, sampleRate);

  new BiquadFilter(hp).processInPlace(punchL);
  new BiquadFilter(lp).processInPlace(punchL);
  new BiquadFilter(hp).processInPlace(punchR);
  new BiquadFilter(lp).processInPlace(punchR);

  const fastAtt = Math.exp(-1 / Math.max(1, 0.0014 * sampleRate));
  const fastRel = Math.exp(-1 / Math.max(1, 0.016 * sampleRate));
  const slowAtt = Math.exp(-1 / Math.max(1, 0.026 * sampleRate));
  const slowRel = Math.exp(-1 / Math.max(1, 0.14 * sampleRate));

  let envFast = 0;
  let envSlow = 0;

  for (let i = 0; i < n; i++) {
    const pk = Math.max(Math.abs(punchL[i]), Math.abs(punchR[i]));
    envFast =
      pk > envFast
        ? fastAtt * envFast + (1 - fastAtt) * pk
        : fastRel * envFast + (1 - fastRel) * pk;
    envSlow =
      pk > envSlow
        ? slowAtt * envSlow + (1 - slowAtt) * pk
        : slowRel * envSlow + (1 - slowRel) * pk;

    if (envSlow > 1e-4 && envFast > envSlow * 1.05) {
      const crestDb = Math.min(8.5, 20 * Math.log10(envFast / envSlow));
      const boostDb = crestDb * amt * 0.52;
      const deltaG = dbToLinear(boostDb) - 1.0;
      left[i] += punchL[i] * deltaG;
      right[i] += punchR[i] * deltaG;
    }
  }
}

/**
 * 3. Level-Independent Mid-Channel Split-Band Vocal Sibilance De-Esser (FabFilter Pro-DS / Weiss style).
 * Compares Mid 5.4–10.2 kHz sibilance energy against Mid 280–3800 Hz vocal body so ONLY actual
 * consonant 'S'/'T'/'Sh' spikes on the center vocal are smoothed — zero phase shift when idle,
 * and stereo Side cymbals/hi-hats remain 100% untouched!
 */
export function applySplitBandVocalDeEsser(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
  amountPct: number
): void {
  const amt = Math.max(0, Math.min(1, amountPct / 100));
  const n = left.length;
  if (amt < 0.02 || n === 0) return;

  const sibHp = new BiquadFilter(designButterworthHighpass2(5400, sampleRate));
  const sibLp = new BiquadFilter(designButterworthLowpass2(Math.min(10200, sampleRate * 0.45), sampleRate));

  const bodyHp = new BiquadFilter(designButterworthHighpass2(280, sampleRate));
  const bodyLp = new BiquadFilter(designButterworthLowpass2(3800, sampleRate));

  const sibAtt = Math.exp(-1 / Math.max(1, 0.0007 * sampleRate));
  const sibRel = Math.exp(-1 / Math.max(1, 0.028 * sampleRate));
  const bodyAtt = Math.exp(-1 / Math.max(1, 0.004 * sampleRate));
  const bodyRel = Math.exp(-1 / Math.max(1, 0.055 * sampleRate));

  // Relative threshold: +2.0 dB at gentle settings down to -4.5 dB at aggressive de-essing
  const relThreshDb = 2.0 - amt * 6.5;
  const maxReductionDb = 1.5 + amt * 4.8;

  let envSib = 0;
  let envBody = 0;

  for (let i = 0; i < n; i++) {
    const mid = 0.5 * (left[i] + right[i]);
    const side = 0.5 * (left[i] - right[i]);

    const sibSample = sibLp.processSample(sibHp.processSample(mid));
    const bodySample = bodyLp.processSample(bodyHp.processSample(mid));

    const absSib = Math.abs(sibSample);
    const absBody = Math.abs(bodySample);

    envSib =
      absSib > envSib
        ? sibAtt * envSib + (1 - sibAtt) * absSib
        : sibRel * envSib + (1 - sibRel) * absSib;
    envBody =
      absBody > envBody
        ? bodyAtt * envBody + (1 - bodyAtt) * absBody
        : bodyRel * envBody + (1 - bodyRel) * absBody;

    let midOut = mid;
    if (envSib > 2.5e-4) {
      const sibOverBodyDb = 20 * Math.log10((envSib + 1e-6) / (envBody + 1e-5));
      if (sibOverBodyDb > relThreshDb) {
        const overDb = sibOverBodyDb - relThreshDb;
        const redDb = Math.min(maxReductionDb, overDb * (0.55 + 0.35 * amt));
        const gSib = dbToLinear(-redDb);
        // Subtract ONLY the excess sibilance component from Mid!
        midOut = mid - sibSample * (1.0 - gSib);
      }
    }

    left[i] = midOut + side;
    right[i] = midOut - side;
  }
}

/**
 * 4. Parallel Upward Micro-Lift & Oxford-Style Harmonic Density ("Streaming Loudness Enhancer").
 * Gently lifts low-to-mid level musical detail (-46 dBFS .. -12 dBFS) with a noise-floor gate at -54 dBFS
 * and zero peak clamping above -6 dBFS, making masters sound fuller, closer, and louder even when
 * Spotify/Apple Music turn loud tracks down to -14 LUFS!
 */
export function applyParallelUpwardMicroLift(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
  amountPct: number
): void {
  const amt = Math.max(0, Math.min(1, amountPct / 100));
  const n = left.length;
  if (amt < 0.02 || n === 0) return;

  const att = Math.exp(-1 / Math.max(1, 0.01 * sampleRate));
  const rel = Math.exp(-1 / Math.max(1, 0.085 * sampleRate));
  const maxLiftDb = 2.8 * amt;
  const inflatorBlend = 0.14 * amt;

  let envSq = 0;

  for (let i = 0; i < n; i++) {
    const l = left[i];
    const r = right[i];
    const pSq = 0.5 * (l * l + r * r);
    envSq = pSq > envSq ? att * envSq + (1 - att) * pSq : rel * envSq + (1 - rel) * pSq;

    const rmsDb = 10 * Math.log10(envSq + 1e-12);
    let liftGain = 1.0;

    // Active window: -52 dBFS (noise gate) -> peaks at -28 dBFS -> tapers smoothly to 0 dB at -8 dBFS
    if (rmsDb > -52 && rmsDb < -8) {
      let windowWeight = 0;
      if (rmsDb < -28) {
        windowWeight = (rmsDb - -52) / 24; // 0 -> 1 from -52 to -28 dBFS
      } else {
        windowWeight = (-8 - rmsDb) / 20; // 1 -> 0 from -28 to -8 dBFS
      }
      // Smoothstep S-curve
      const w = windowWeight * windowWeight * (3 - 2 * windowWeight);
      liftGain = dbToLinear(maxLiftDb * w);
    }

    let outL = l * liftGain;
    let outR = r * liftGain;

    // Subtle Sonnox Oxford Inflator polynomial warmth (1.5x - 0.5x^3 for |x| < 1)
    if (inflatorBlend > 0.005) {
      const clL = Math.max(-1, Math.min(1, outL));
      const clR = Math.max(-1, Math.min(1, outR));
      outL += (1.5 * clL - 0.5 * clL * clL * clL - clL) * inflatorBlend;
      outR += (1.5 * clR - 0.5 * clR * clR * clR - clR) * inflatorBlend;
    }

    left[i] = outL;
    right[i] = outR;
  }
}

/**
 * 5. Studio Zero-Crossing / Raised-Cosine Head & Tail De-Click Polish.
 * Eliminates digital boundary pops/clicks on abrupt DAW bounces without altering already-faded masters.
 */
export function applyStudioHeadTailDeClick(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number
): void {
  const n = left.length;
  if (n < 64) return;

  const headSamples = Math.min(Math.floor(n * 0.05), Math.max(16, Math.round(0.005 * sampleRate)));
  const tailSamples = Math.min(Math.floor(n * 0.05), Math.max(32, Math.round(0.014 * sampleRate)));

  const hasAbruptHead = Math.max(Math.abs(left[0]), Math.abs(right[0])) > 1.5e-4;
  if (hasAbruptHead) {
    for (let i = 0; i < headSamples; i++) {
      const w = 0.5 * (1 - Math.cos((Math.PI * i) / headSamples));
      left[i] *= w;
      right[i] *= w;
    }
  }

  const hasAbruptTail = Math.max(Math.abs(left[n - 1]), Math.abs(right[n - 1])) > 1.5e-4;
  if (hasAbruptTail) {
    for (let i = 0; i < tailSamples; i++) {
      const idx = n - 1 - i;
      const w = 0.5 * (1 - Math.cos((Math.PI * i) / tailSamples));
      left[idx] *= w;
      right[idx] *= w;
    }
  }
}

export function applyMasteringPolishFrontStage(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
  params?: MasteringPolishV5Params
): void {
  if (!params) return;
  if (params.declipEnabled) {
    applyCubicHermiteDeclipper(left, right);
  }
  if (params.transientRecoveryPct > 1) {
    applyDifferentialTransientRecovery(left, right, sampleRate, params.transientRecoveryPct);
  }
}

export function applyMasteringPolishVocalAndDensityStage(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
  params?: MasteringPolishV5Params
): void {
  if (!params) return;
  if (params.vocalDeEsserEnabled && params.vocalDeEsserAmountPct > 1) {
    applySplitBandVocalDeEsser(left, right, sampleRate, params.vocalDeEsserAmountPct);
  }
  if (params.upwardMicroLiftPct > 1) {
    applyParallelUpwardMicroLift(left, right, sampleRate, params.upwardMicroLiftPct);
  }
}
