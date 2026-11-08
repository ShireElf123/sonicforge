import {
  createDefaultMasteringParams,
  DELIVERY_PROFILES,
  TONAL_PRESET_TARGETS,
} from './profiles';
import type {
  AudioAnalysisReport,
  DeliveryProfileId,
  MasteringChainParams,
  TonalBandId,
  TonalPresetId,
} from './types';

export interface AssistantRecommendation {
  params: MasteringChainParams;
  rationale: string[];
  warnings: string[];
  tonalDeltasDb: Record<TonalBandId, number>;
}

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

function round1(val: number): number {
  return Math.round(val * 10) / 10;
}

export function computeSignalDrivenAssistant(
  source: AudioAnalysisReport,
  deliveryProfile: DeliveryProfileId,
  tonalPreset: TonalPresetId,
  reference?: AudioAnalysisReport | null
): AssistantRecommendation {
  const params = createDefaultMasteringParams(deliveryProfile);
  params.tonalPreset =
    reference && tonalPreset === 'reference_match'
      ? 'reference_match'
      : tonalPreset === 'reference_match'
        ? 'transparent'
        : tonalPreset;

  const spec = DELIVERY_PROFILES[deliveryProfile];
  const rationale: string[] = [];
  const warnings: string[] = [];

  const useRef = Boolean(reference && tonalPreset === 'reference_match');
  const targetBands: Record<TonalBandId, number> = useRef
    ? (Object.fromEntries(
        reference!.spectral.bands.map((b) => [b.id, b.relativeDb])
      ) as Record<TonalBandId, number>)
    : TONAL_PRESET_TARGETS[
        params.tonalPreset === 'reference_match' ? 'transparent' : params.tonalPreset
      ].bands;

  // Choose Linear-Phase FIR EQ for transparent/reference accuracy, Minimum-Phase for analog/punchy character
  params.eqPhaseMode =
    params.tonalPreset === 'warm_analog' || deliveryProfile === 'club_loud' ? 'minimum' : 'linear';

  if (useRef && reference) {
    rationale.push(
      `Reference Match active (${params.eqPhaseMode}-phase EQ): targeting measured 6-band spectral curve of reference (${reference.loudness.integratedLufs.toFixed(1)} LUFS, centroid ${Math.round(reference.spectral.centroidHz)} Hz).`
    );
  } else {
    const presetMeta =
      TONAL_PRESET_TARGETS[
        params.tonalPreset === 'reference_match' ? 'transparent' : params.tonalPreset
      ];
    rationale.push(
      `Tonal target: ${presetMeta.name} curve (${params.eqPhaseMode}-phase FIR/IIR EQ) with ${spec.name} staging.`
    );
  }

  const srcEnergy = Object.fromEntries(
    source.spectral.bands.map((b) => [b.id, b.energyDb])
  ) as Record<TonalBandId, number>;

  const refBody = 0.5 * ((targetBands.low ?? 4.5) + (targetBands.lowMid ?? 4.0));
  const lowE = srcEnergy.low ?? -24;
  const lowMidE = srcEnergy.lowMid ?? -24;
  const peakBody = Math.max(lowE, lowMidE);
  const srcBody = Math.abs(lowE - lowMidE) < 18 ? 0.5 * (lowE + lowMidE) : peakBody - 1.2;

  const tonalDeltasDb: Record<TonalBandId, number> = {
    sub: round1((targetBands.sub ?? -2.5) - refBody - ((srcEnergy.sub ?? srcBody - 7) - srcBody)),
    low: round1((targetBands.low ?? 4.5) - refBody - ((srcEnergy.low ?? srcBody) - srcBody)),
    lowMid: round1(
      (targetBands.lowMid ?? 4.0) - refBody - ((srcEnergy.lowMid ?? srcBody) - srcBody)
    ),
    highMid: round1(
      (targetBands.highMid ?? 1.5) - refBody - ((srcEnergy.highMid ?? srcBody - 3) - srcBody)
    ),
    high: round1(
      (targetBands.high ?? -1.5) - refBody - ((srcEnergy.high ?? srcBody - 6) - srcBody)
    ),
    air: round1(
      (targetBands.air ?? -6.0) - refBody - ((srcEnergy.air ?? srcBody - 10) - srcBody)
    ),
  };

  // Pre-stage internal operating level to -16.5 LUFS so Dynamic EQ, Multiband & Exciter hit calibrated thresholds
  if (Number.isFinite(source.loudness.integratedLufs) && source.loudness.integratedLufs > -60) {
    const stageGain = round1(clamp(-16.5 - source.loudness.integratedLufs, -9.0, 9.0));
    params.inputGainDb = stageGain;
    if (Math.abs(stageGain) >= 0.8) {
      rationale.push(
        `Pre-chain gain staging: ${stageGain > 0 ? '+' : ''}${stageGain.toFixed(1)} dB input trim toward -16.5 LUFS studio operating level.`
      );
    }
  }

  if (Math.abs(source.dynamics.dcOffset) > 0.0015) {
    params.dcBlockEnabled = true;
    rationale.push(
      `Detected DC offset (${(source.dynamics.dcOffset * 100).toFixed(2)}% FS); engaged 5 Hz DC blocker.`
    );
  }

  const subExcess = -tonalDeltasDb.sub;
  const hpBand = params.eqBands[0];
  if (subExcess > 3.5) {
    hpBand.freqHz = 34;
    hpBand.enabled = true;
    rationale.push(
      `Excess subsonic energy (+${subExcess.toFixed(1)} dB in 20–60 Hz); raised sub high-pass to 34 Hz.`
    );
  } else {
    hpBand.freqHz = 25;
    hpBand.enabled = true;
  }

  // Detect MP3 >16 kHz brickwall roll-off so we don't boost empty codec hiss
  const isMp3Brickwall = (srcEnergy.air ?? -90) < srcBody - 28;
  const lowGain = round1(clamp(tonalDeltasDb.low * 0.5, -3.5, 3.5));
  const lowMidGain = round1(clamp(tonalDeltasDb.lowMid * 0.55, -4.2, 3.0));
  const highMidGain = round1(clamp(tonalDeltasDb.highMid * 0.5, -3.2, 3.5));
  const highGain = round1(clamp(tonalDeltasDb.high * 0.5, -3.5, 3.8));
  const airGain = round1(clamp(tonalDeltasDb.air * 0.45, -3.0, isMp3Brickwall ? 1.5 : 4.0));

  params.eqBands[1].gainDb = lowGain;
  params.eqBands[2].gainDb = lowMidGain;
  params.eqBands[3].gainDb = highMidGain;
  params.eqBands[4].gainDb = highGain;
  params.eqBands[5].gainDb = airGain;

  const notableEqMoves = params.eqBands
    .slice(1)
    .filter((b) => Math.abs(b.gainDb) >= 0.4)
    .map((b) => `${b.label} ${b.gainDb > 0 ? '+' : ''}${b.gainDb.toFixed(1)} dB @ ${b.freqHz} Hz`);
  if (notableEqMoves.length > 0) {
    rationale.push(`Corrective EQ: ${notableEqMoves.join(', ')}.`);
  }

  // Configure STFT Dynamic Spectral Stabilizer from measured spectral peaks
  const maxPeakProminence = Math.max(
    0,
    ...source.spectral.bins
      .filter((b) => b.freqHz >= 250 && b.freqHz <= 10000)
      .map((b) => b.relativeDb)
  );
  if (maxPeakProminence > 5.5) {
    params.stabilizer.enabled = true;
    params.stabilizer.mode = 'tame_harshness';
    params.stabilizer.amountPct = 48;
    params.stabilizer.sharpnessPct = 68;
    rationale.push(
      `Detected narrowband spectral prominence (+${maxPeakProminence.toFixed(1)} dB); engaged STFT Dynamic Spectral Stabilizer (48%) to suppress ringing resonances dynamically.`
    );
  } else {
    params.stabilizer.enabled = true;
    params.stabilizer.mode = 'tame_harshness';
    params.stabilizer.amountPct = 28;
    params.stabilizer.sharpnessPct = 55;
  }

  const plr = source.dynamics.plrDb;
  const lra = source.loudness.loudnessRangeLu;
  const isHotDenseMix = plr < 9.2 || source.loudness.integratedLufs > -10.5;

  if (isHotDenseMix) {
    warnings.push(
      `Source is already dense/hot (${source.loudness.integratedLufs.toFixed(1)} LUFS, PLR ${plr.toFixed(1)} dB). Multiband ratios lowered to 1.22:1 & transients protected to prevent double-compression.`
    );
    for (const b of params.multiband.bands) {
      b.ratio = 1.22;
      b.thresholdDb = -14.5;
      b.makeupDb = 0;
    }
  } else if (plr > 15.5 || lra > 9.0) {
    rationale.push(
      `Wide source dynamics (PLR ${plr.toFixed(1)} dB, LRA ${lra.toFixed(1)} LU); engaged 4-band LR4 glue compression.`
    );
    params.multiband.bands[0].ratio = 2.3;
    params.multiband.bands[0].thresholdDb = -21;
    params.multiband.bands[1].ratio = 1.85;
    params.multiband.bands[1].thresholdDb = -22;
    params.multiband.bands[2].ratio = 1.75;
    params.multiband.bands[2].thresholdDb = -22;
  }

  const lowCorr = source.stereo.lowBandCorrelation;
  const corr = source.stereo.correlation;

  if (lowCorr < 0.82) {
    params.stereo.bassMonoEnabled = true;
    params.stereo.bassMonoHz = lowCorr < 0.5 ? 145 : 125;
    rationale.push(
      `Measured low-band (<150 Hz) correlation is ${lowCorr.toFixed(2)}; engaged 24 dB/oct LR4 Elliptical Bass Mono below ${params.stereo.bassMonoHz} Hz.`
    );
  } else {
    params.stereo.bassMonoEnabled = true;
    params.stereo.bassMonoHz = 95;
  }

  if (corr < 0.25) {
    warnings.push(
      `Source stereo correlation is low (${corr.toFixed(2)}, mono fold-down loss ${source.stereo.monoFoldDownLossDb.toFixed(1)} dB). Narrowed width to 92%.`
    );
    params.stereo.widthPct = 92;
    params.stereo.highWidthPct = 96;
  } else if (corr > 0.94) {
    params.stereo.widthPct = 112;
    params.stereo.highWidthPct = 124;
    rationale.push(`Source image is narrow (${corr.toFixed(2)}); opened M/S width to 112%.`);
  } else {
    const targetCorr = useRef && reference ? reference.stereo.correlation : 0.68;
    const widthAdj = clamp(Math.round((corr - targetCorr) * 40), -10, 18);
    params.stereo.widthPct = 100 + widthAdj;
    params.stereo.highWidthPct = clamp(106 + widthAdj, 95, 130);
  }

  const tilt = source.spectral.spectralTiltDbPerOct;
  if (tilt < -4.5) {
    params.exciter.enabled = true;
    params.exciter.mode = 'tape';
    params.exciter.drivePct = isHotDenseMix ? 14 : 26;
    params.exciter.mixPct = 36;
    rationale.push(
      `Dark spectral tilt (${tilt.toFixed(1)} dB/oct); increased 2x oversampled Tape harmonic excitation.`
    );
  } else if (params.tonalPreset === 'warm_analog') {
    params.exciter.enabled = true;
    params.exciter.mode = 'tube';
    params.exciter.drivePct = isHotDenseMix ? 14 : 24;
    params.exciter.mixPct = 32;
  } else {
    params.exciter.enabled = true;
    params.exciter.mode = 'tape';
    params.exciter.drivePct = 14;
    params.exciter.mixPct = 24;
  }

  params.limiter.enabled = true;
  params.limiter.autoGainToTarget = true;
  params.limiter.targetLufs = spec.targetLufs;
  params.limiter.ceilingDbtp = spec.ceilingDbtp;
  params.limiter.oversampling = 16;
  params.limiter.releaseMode =
    deliveryProfile === 'club_loud' || plr > 13.5 || isHotDenseMix
      ? 'irc_transient'
      : 'transparent';
  params.limiter.transientEmphasisPct = isHotDenseMix
    ? 52
    : params.limiter.releaseMode === 'irc_transient'
      ? 35
      : 15;
  params.exportFormat.bitDepth = 24;
  params.exportFormat.dither = 'tpdf_shaped';

  if (Number.isFinite(source.loudness.integratedLufs)) {
    const neededLu = spec.targetLufs - source.loudness.integratedLufs;
    if (neededLu > params.limiter.maxAutoDriveDb) {
      warnings.push(
        `Source is ${source.loudness.integratedLufs.toFixed(1)} LUFS (${neededLu.toFixed(1)} LU below target). Auto-drive capped at +${params.limiter.maxAutoDriveDb} dB to protect transients.`
      );
    } else {
      rationale.push(
        `Closed-loop staging (${params.limiter.releaseMode.toUpperCase()}): driving ${neededLu >= 0 ? '+' : ''}${neededLu.toFixed(1)} dB toward ${spec.targetLufs.toFixed(1)} LUFS / ${spec.ceilingDbtp.toFixed(1)} dBTP.`
      );
    }
  }

  return {
    params,
    rationale,
    warnings,
    tonalDeltasDb,
  };
}

export interface StreamingPlatformSimulation {
  platform: string;
  referenceLufs: number;
  recommendedMaxTruePeakDbtp: number;
  playbackGainDeltaDb: number;
  effectivePlaybackPeakDbtp: number;
  transcodeClipRisk: 'low' | 'moderate' | 'high';
  verdict: string;
}

export function simulateStreamingNormalization(
  measuredLufs: number,
  measuredTruePeakDbtp: number
): StreamingPlatformSimulation[] {
  const platforms = [
    { platform: 'Spotify (Normal)', ref: -14.0, maxTp: -1.0, turnsUpQuiet: true },
    { platform: 'Apple Music (Sound Check)', ref: -16.0, maxTp: -1.0, turnsUpQuiet: true },
    { platform: 'YouTube', ref: -14.0, maxTp: -1.0, turnsUpQuiet: false },
    { platform: 'TIDAL / Amazon Music', ref: -14.0, maxTp: -1.0, turnsUpQuiet: false },
    { platform: 'EBU R128 Broadcast', ref: -23.0, maxTp: -1.0, turnsUpQuiet: true },
  ];

  if (!Number.isFinite(measuredLufs)) {
    return platforms.map((p) => ({
      platform: p.platform,
      referenceLufs: p.ref,
      recommendedMaxTruePeakDbtp: p.maxTp,
      playbackGainDeltaDb: 0,
      effectivePlaybackPeakDbtp: -120,
      transcodeClipRisk: 'low',
      verdict: 'Signal below gating threshold (-70 LUFS).',
    }));
  }

  return platforms.map((p) => {
    const rawDelta = p.ref - measuredLufs;
    let appliedDelta = rawDelta;
    if (rawDelta > 0) {
      if (!p.turnsUpQuiet) {
        appliedDelta = 0;
      } else {
        const maxPositiveBeforeClip = Math.max(0, p.maxTp - measuredTruePeakDbtp);
        appliedDelta = Math.min(rawDelta, maxPositiveBeforeClip);
      }
    }

    const effectivePeak = measuredTruePeakDbtp + appliedDelta;
    const transcodeClipRisk: 'low' | 'moderate' | 'high' =
      measuredTruePeakDbtp > -0.2
        ? 'high'
        : measuredTruePeakDbtp > -0.9 && measuredLufs > -11
          ? 'moderate'
          : 'low';

    const verdict =
      Math.abs(appliedDelta) < 0.4
        ? 'Plays near unity gain (0.0 dB penalty)'
        : appliedDelta < 0
          ? `Turned down by ${Math.abs(appliedDelta).toFixed(1)} dB`
          : `Turned up by +${appliedDelta.toFixed(1)} dB (headroom-limited)`;

    return {
      platform: p.platform,
      referenceLufs: p.ref,
      recommendedMaxTruePeakDbtp: p.maxTp,
      playbackGainDeltaDb: round1(appliedDelta),
      effectivePlaybackPeakDbtp: round1(effectivePeak),
      transcodeClipRisk,
      verdict,
    };
  });
}
