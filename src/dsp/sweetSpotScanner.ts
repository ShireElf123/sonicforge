import { renderMasterChain } from './processors';
import type {
  LoudnessSweetSpotReport,
  MasteringChainParams,
  PlanarAudioBuffer,
  SweetSpotOperatingPoint,
} from './types';

function extractPeakChorusSegment(source: PlanarAudioBuffer, maxWindowSec = 4.0): PlanarAudioBuffer {
  const sr = source.sampleRate;
  const total = source.channels[0]?.length ?? 0;
  const winLen = Math.min(total, Math.round(sr * maxWindowSec));
  if (total <= winLen || winLen === 0) return source;

  const left = source.channels[0];
  const right = source.channels[1] ?? left;
  const step = Math.max(1024, Math.round(sr * 0.5));

  let bestStart = 0;
  let bestEnergy = -1;

  for (let start = 0; start + winLen <= total; start += step) {
    let e = 0;
    for (let i = start; i < start + winLen; i += 4) {
      e += left[i] * left[i] + right[i] * right[i];
    }
    if (e > bestEnergy) {
      bestEnergy = e;
      bestStart = start;
    }
  }

  return {
    sampleRate: sr,
    duration: winLen / sr,
    channels: source.channels.map((ch) => ch.slice(bestStart, bestStart + winLen)),
  };
}

/**
 * Sweeps 5 real loudness targets on the song's loudest chorus segment to measure
 * Transient Punch Retention vs Loudness and identify the exact physical Sweet Spot
 * before drums/vocals start choking.
 */
export function scanLoudnessSweetSpot(
  source: PlanarAudioBuffer,
  baseParams: MasteringChainParams
): LoudnessSweetSpotReport {
  const probeClip = extractPeakChorusSegment(source, 2.2);
  const targets = [-14.0, -11.5, -9.5, -8.0, -6.5];

  // Fast minimum-phase 4x probe chain for sub-300ms sweep responsiveness
  const fastBase: MasteringChainParams = {
    ...JSON.parse(JSON.stringify(baseParams)),
    eqPhaseMode: 'minimum',
    macroDynamics: undefined,
  };
  fastBase.stabilizer.enabled = false;
  fastBase.limiter.oversampling = 4;
  fastBase.limiter.maxAutoDriveDb = 18.0;
  fastBase.limiter.autoGainToTarget = true;
  fastBase.limiter.softClipEnabled = true;
  fastBase.limiter.softClipMode = 'crisp_cubic';
  fastBase.limiter.softClipThresholdDb = -1.7;
  fastBase.limiter.softClipAmountPct = 45;
  fastBase.limiter.releaseMode = 'irc_spectral';

  const rawPoints: Array<{
    targetLufs: number;
    achievedLufs: number;
    plrDb: number;
    maxGrDb: number;
  }> = [];

  for (const tgt of targets) {
    const p: MasteringChainParams = {
      ...fastBase,
      limiter: {
        ...fastBase.limiter,
        targetLufs: tgt,
      },
    };
    const res = renderMasterChain(probeClip, p);
    rawPoints.push({
      targetLufs: tgt,
      achievedLufs: Number(res.analysis.loudness.integratedLufs.toFixed(2)),
      plrDb: Number(res.analysis.dynamics.plrDb.toFixed(2)),
      maxGrDb: Number(res.maxGainReductionDb.toFixed(2)),
    });
  }

  const baselinePlr = Math.max(6.5, rawPoints[0]?.plrDb ?? 12);

  // Pick highest loudness point that retains >= 76% of natural drum punch and <= 7.2 dB max GR
  let sweetIdx = 1; // default -11.5 LUFS
  let cliffIdx = rawPoints.length - 1;

  for (let i = 0; i < rawPoints.length; i++) {
    const pt = rawPoints[i];
    const retention = Math.min(100, Math.max(25, (pt.plrDb / baselinePlr) * 100));
    if (retention >= 75 && pt.maxGrDb <= 7.2) {
      sweetIdx = i;
    } else if (cliffIdx === rawPoints.length - 1 && i > 0) {
      cliffIdx = i;
    }
  }

  const points: SweetSpotOperatingPoint[] = rawPoints.map((pt, idx) => ({
    targetLufs: pt.targetLufs,
    achievedLufs: pt.achievedLufs,
    plrDb: pt.plrDb,
    punchRetentionPct: Math.round(Math.min(100, Math.max(25, (pt.plrDb / baselinePlr) * 100))),
    maxGainReductionDb: pt.maxGrDb,
    isSweetSpot: idx === sweetIdx,
  }));

  const sweet = points[sweetIdx];
  const cliff = points[cliffIdx];

  return {
    points,
    recommendedLufs: sweet.targetLufs,
    cliffLufs: cliff.targetLufs,
    explanation: `Your song hits its loudest clean sweet spot around ${sweet.targetLufs.toFixed(1)} LUFS while keeping ${sweet.punchRetentionPct}% of natural drum punch (${sweet.plrDb.toFixed(1)} dB crest). Pushing past ${cliff.targetLufs.toFixed(1)} LUFS triggers heavy gain reduction (-${cliff.maxGainReductionDb.toFixed(1)} dB) where kicks begin softening.`,
  };
}
