import { classifyProgramArchetype } from './ownAiEngine';
import { createDefaultMasteringParams } from './profiles';
import type {
  AudioAnalysisReport,
  LoudnessSweetSpotReport,
  MasteringChainParams,
} from './types';

export type AutopilotGenreId =
  | 'auto'
  | 'trap_hiphop'
  | 'afro_amapiano'
  | 'pop_rnb'
  | 'club_edm'
  | 'rock_indie'
  | 'acoustic_chill';

export type AutopilotReleaseGoal = 'streaming' | 'club_loud' | 'social_mobile';

export interface AutopilotFeelMacros {
  genre: AutopilotGenreId;
  releaseGoal: AutopilotReleaseGoal;
  loudnessSlamPct: number; // 0..100
  vocalUpfrontPct: number; // 0..100
  bassPhonePunchPct: number; // 0..100
  chorusBloomWidthPct: number; // 0..100
}

export interface ReadinessCheckItem {
  label: string;
  passed: boolean;
  detail: string;
}

export interface ReadinessScorecard {
  score: number;
  gradeLabel: string;
  checks: ReadinessCheckItem[];
}

export const AUTOPILOT_GENRE_CARDS: Array<{
  id: AutopilotGenreId;
  title: string;
  subtitle: string;
  defaultSlam: number;
  defaultVocal: number;
  defaultBass: number;
  defaultBloom: number;
}> = [
  {
    id: 'auto',
    title: 'Auto-Detect My Song',
    subtitle: 'Reads your drums, vocals & bass automatically',
    defaultSlam: 62,
    defaultVocal: 58,
    defaultBass: 58,
    defaultBloom: 60,
  },
  {
    id: 'trap_hiphop',
    title: 'Trap / Hip-Hop / Drill',
    subtitle: 'Hard 808s on phones + crisp upfront vocals',
    defaultSlam: 74,
    defaultVocal: 68,
    defaultBass: 78,
    defaultBloom: 52,
  },
  {
    id: 'afro_amapiano',
    title: 'Afrobeats / Amapiano',
    subtitle: 'Warm log-drum bounce, silky vocals & wide percussion',
    defaultSlam: 68,
    defaultVocal: 62,
    defaultBass: 74,
    defaultBloom: 68,
  },
  {
    id: 'pop_rnb',
    title: 'Pop / R&B / Melodic',
    subtitle: 'Silky radio vocal shine, smooth warmth & chorus lift',
    defaultSlam: 60,
    defaultVocal: 75,
    defaultBass: 52,
    defaultBloom: 72,
  },
  {
    id: 'club_edm',
    title: 'Club / House / EDM',
    subtitle: 'Festival loudness, mono-locked sub & massive drops',
    defaultSlam: 84,
    defaultVocal: 48,
    defaultBass: 76,
    defaultBloom: 82,
  },
  {
    id: 'rock_indie',
    title: 'Indie / Rock / Band',
    subtitle: 'Punchy live snare, analog tape glue & guitar width',
    defaultSlam: 58,
    defaultVocal: 60,
    defaultBass: 50,
    defaultBloom: 65,
  },
  {
    id: 'acoustic_chill',
    title: 'Acoustic / Lo-Fi / Chill',
    subtitle: 'Natural breathing dynamics, warm tube air & zero harshness',
    defaultSlam: 35,
    defaultVocal: 62,
    defaultBass: 38,
    defaultBloom: 45,
  },
];

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function resolveAutoGenre(source: AudioAnalysisReport | null): Exclude<AutopilotGenreId, 'auto'> {
  if (!source) return 'pop_rnb';
  const summary = {
    sampleRate: source.sampleRate,
    channelCount: source.channelCount,
    durationSec: source.durationSec,
    integratedLufs: source.loudness.integratedLufs,
    shortTermMaxLufs: source.loudness.shortTermMaxLufs,
    momentaryMaxLufs: source.loudness.momentaryMaxLufs,
    loudnessRangeLu: source.loudness.loudnessRangeLu,
    truePeakDbtp: source.truePeak.truePeakDbtp,
    samplePeakDbfs: source.truePeak.samplePeakDbfs,
    ispMarginDb: source.truePeak.ispMarginDb,
    plrDb: source.dynamics.plrDb,
    crestFactorDb: source.dynamics.crestFactorDb,
    centroidHz: source.spectral.centroidHz,
    spectralTiltDbPerOct: source.spectral.spectralTiltDbPerOct,
    correlation: source.stereo.correlation,
    lowBandCorrelation: source.stereo.lowBandCorrelation,
    monoFoldDownLossDb: source.stereo.monoFoldDownLossDb,
    bands: source.spectral.bands.map((b) => ({
      id: b.id,
      energyDb: b.energyDb,
      relativeDb: b.relativeDb,
    })),
  };
  const arch = classifyProgramArchetype(summary);
  switch (arch.id) {
    case 'hiphop_808':
      return 'trap_hiphop';
    case 'electronic_club':
      return 'club_edm';
    case 'pop_vocal':
      return 'pop_rnb';
    case 'rock_dense':
      return 'rock_indie';
    case 'acoustic_dynamic':
    case 'voice_broadcast':
      return 'acoustic_chill';
    default:
      return 'afro_amapiano';
  }
}

/**
 * Translates plain-English Artist Autopilot macros + measured track acoustics
 * into a complete, studio-calibrated MasteringChainParams configuration.
 */
export function buildAutopilotMasteringChain(
  macros: AutopilotFeelMacros,
  source: AudioAnalysisReport | null,
  sweetSpot: LoudnessSweetSpotReport | null,
  currentMeta?: MasteringChainParams['exportFormat']
): MasteringChainParams {
  const effectiveGenre = macros.genre === 'auto' ? resolveAutoGenre(source) : macros.genre;
  const baseProfile =
    macros.releaseGoal === 'club_loud'
      ? 'club_loud'
      : macros.releaseGoal === 'streaming'
        ? 'spotify'
        : 'custom';

  const next = createDefaultMasteringParams(baseProfile);
  if (currentMeta) {
    next.exportFormat = JSON.parse(JSON.stringify(currentMeta));
  }

  const slam = clamp(macros.loudnessSlamPct, 0, 100) / 100;
  const vox = clamp(macros.vocalUpfrontPct, 0, 100) / 100;
  const bass = clamp(macros.bassPhonePunchPct, 0, 100) / 100;
  const bloom = clamp(macros.chorusBloomWidthPct, 0, 100) / 100;

  // 1. Target Loudness & Ceiling calibrated to Release Goal + Sweet Spot Scanner
  const sweetLufs = sweetSpot?.recommendedLufs ?? -9.5;
  if (macros.releaseGoal === 'streaming') {
    // -14.0 LUFS at 0% slam -> sweetSpot/-9.2 LUFS at 100% competitive streaming slam
    const maxCompetitive = Math.min(-8.5, Math.max(-11.0, sweetLufs + 0.8));
    next.limiter.targetLufs = Number((-14.0 + slam * (maxCompetitive - -14.0)).toFixed(1));
    next.limiter.ceilingDbtp = -1.0; // Codec-safe for Spotify / Apple Music / DistroKid
  } else if (macros.releaseGoal === 'club_loud') {
    next.limiter.targetLufs = Number((-10.5 + slam * 3.3).toFixed(1)); // -10.5 -> -7.2 LUFS
    next.limiter.ceilingDbtp = -0.6;
  } else {
    // TikTok / Reels / Shorts: loud & punchy mobile translation with -1.0 dBTP AAC headroom
    next.limiter.targetLufs = Number((-11.5 + slam * 2.8).toFixed(1)); // -11.5 -> -8.7 LUFS
    next.limiter.ceilingDbtp = -1.0;
  }

  next.limiter.autoGainToTarget = true;
  next.limiter.maxAutoDriveDb = 16.5;
  next.limiter.releaseMode = slam > 0.55 ? 'irc_spectral' : 'irc_transient';
  next.limiter.transientEmphasisPct = Math.round(25 + slam * 45);
  next.limiter.oversampling = slam > 0.65 ? 16 : 8;
  next.limiter.softClipEnabled = slam > 0.42;
  next.limiter.softClipMode = effectiveGenre === 'acoustic_chill' ? 'warm_tanh' : 'crisp_cubic';
  next.limiter.softClipThresholdDb = -1.7;
  next.limiter.softClipAmountPct = Math.round(clamp((slam - 0.3) * 80, 15, 60));

  // 2. 808 / Bass Phone Translation + Sub Tightness
  next.eqEnabled = true;
  next.eqPhaseMode = slam > 0.6 || effectiveGenre === 'club_edm' ? 'linear' : 'minimum';

  // Band 0: Subsonic clean-up HPF
  if (next.eqBands[0]) {
    next.eqBands[0].enabled = true;
    next.eqBands[0].freqHz = effectiveGenre === 'trap_hiphop' || effectiveGenre === 'afro_amapiano' ? 25 : 29;
  }

  // Band 1: Sub/Low weight adapted to source low-band energy
  const srcSubRel = source?.spectral.bands.find((b) => b.id === 'sub')?.relativeDb ?? -4;
  const subTrim = srcSubRel > 2.0 ? -0.8 : 0.4;
  if (next.eqBands[1]) {
    next.eqBands[1].enabled = true;
    next.eqBands[1].freqHz = effectiveGenre === 'afro_amapiano' ? 68 : 60;
    next.eqBands[1].gainDb = Number(clamp((bass - 0.4) * 3.4 + subTrim, -1.5, 2.8).toFixed(1));
    next.eqBands[1].placement = 'mid';
  }

  // Phantom-Fundamental Bass Translator (makes 808s/log-drums audible on iPhone/TikTok speakers!)
  next.phantomBass = {
    enabled: bass > 0.25 || macros.releaseGoal === 'social_mobile',
    cutoffHz: effectiveGenre === 'afro_amapiano' ? 85 : 75,
    amountPct: Math.round(
      clamp(bass * 68 + (macros.releaseGoal === 'social_mobile' ? 18 : 0), 0, 85)
    ),
    character:
      effectiveGenre === 'trap_hiphop' || effectiveGenre === 'afro_amapiano'
        ? 'warm_808'
        : 'tight_punch',
  };

  // Stereo Bass Mono Lock (< 135 Hz phase-coherent punch)
  next.stereo.enabled = true;
  next.stereo.bassMonoEnabled = true;
  next.stereo.bassMonoHz =
    source && source.stereo.lowBandCorrelation < 0.78 ? 145 : 128;

  // 3. Vocal Upfront & Clarity (Mid de-mud Dynamic EQ + Mid Presence + Automatic De-Harsh Safety)
  if (next.eqBands[2]) {
    next.eqBands[2].enabled = true;
    next.eqBands[2].freqHz = 290;
    next.eqBands[2].q = 1.55;
    next.eqBands[2].placement = 'mid';
    next.eqBands[2].gainDb = Number((-0.4 - vox * 1.4).toFixed(1));
    next.eqBands[2].dynEnabled = vox > 0.35;
    next.eqBands[2].dynThresholdDb = -21;
    next.eqBands[2].dynRangeDb = Number((-1.5 - vox * 2.5).toFixed(1));
  }

  if (next.eqBands[3]) {
    next.eqBands[3].enabled = true;
    next.eqBands[3].freqHz = effectiveGenre === 'trap_hiphop' ? 3100 : 2800;
    next.eqBands[3].q = 1.05;
    next.eqBands[3].placement = 'mid';
    next.eqBands[3].gainDb = Number(((vox - 0.35) * 3.6).toFixed(1));
  }

  // Automatic Spectral Stabilizer protects ears whenever vocals/loudness are pushed
  const isSourceBright = (source?.spectral.spectralTiltDbPerOct ?? -3.6) > -3.1;
  next.stabilizer.enabled = true;
  next.stabilizer.mode = vox > 0.65 ? 'de_ess' : 'tame_harshness';
  next.stabilizer.amountPct = Math.round(
    clamp(28 + vox * 26 + (isSourceBright ? 14 : 0), 20, 68)
  );
  next.stabilizer.maxReductionDb = Number((3.5 + vox * 2.5).toFixed(1));

  // 4. Chorus Bloom, Stereo Width & Analog Harmonic Polish
  next.stereo.widthPct = Math.round(clamp(98 + (bloom - 0.3) * 26, 95, 122));
  next.stereo.highWidthPct = Math.round(clamp(104 + bloom * 28, 100, 134));

  if (next.eqBands[5]) {
    next.eqBands[5].enabled = true;
    next.eqBands[5].freqHz = 11500;
    next.eqBands[5].placement = 'side';
    next.eqBands[5].gainDb = Number(clamp((bloom - 0.25) * 2.8, 0, 2.4).toFixed(1));
  }

  next.exciter.enabled = true;
  next.exciter.mode =
    effectiveGenre === 'pop_rnb' || effectiveGenre === 'acoustic_chill'
      ? 'tube'
      : effectiveGenre === 'club_edm'
        ? 'transformer'
        : 'tape';
  next.exciter.drivePct = Math.round(clamp(14 + bloom * 24 + slam * 10, 10, 46));
  next.exciter.mixPct = Math.round(clamp(22 + bloom * 22, 18, 48));

  // Section-Aware Macro-Dynamics so Chorus explodes wider & louder than Verse!
  next.macroDynamics = {
    enabled: bloom > 0.2,
    chorusLiftDb: Number(clamp(0.4 + bloom * 1.3, 0.3, 1.8).toFixed(2)),
    chorusWidthBoostPct: Math.round(clamp(6 + bloom * 18, 4, 24)),
    chorusAirBoostDb: Number(clamp(0.4 + bloom * 1.2, 0.2, 1.7).toFixed(2)),
    verseIntimacyPct: Math.round(clamp(20 + bloom * 35, 15, 55)),
  };

  return next;
}

/**
 * Computes a plain-English 0-100 Release Readiness Score for amateurs & independent artists.
 */
export function computeArtistReadinessScorecard(
  master: AudioAnalysisReport | null,
  params: MasteringChainParams
): ReadinessScorecard {
  if (!master) {
    return {
      score: 0,
      gradeLabel: 'Analyzing Track...',
      checks: [],
    };
  }

  const checks: ReadinessCheckItem[] = [];
  let score = 100;

  const tpOk = master.truePeak.truePeakDbtp <= -0.35;
  if (!tpOk) score -= 22;
  checks.push({
    label: 'Zero Digital Clipping (DistroKid / Spotify / Apple Safe)',
    passed: tpOk,
    detail: `True Peak at ${master.truePeak.truePeakDbtp.toFixed(2)} dBTP`,
  });

  const lufs = master.loudness.integratedLufs;
  const lufsOk = lufs >= -16.5 && lufs <= -6.2;
  if (!lufsOk) score -= 20;
  checks.push({
    label: 'Competitive Release Volume',
    passed: lufsOk,
    detail: `Playing at ${lufs.toFixed(1)} LUFS`,
  });

  const punchOk = master.dynamics.plrDb >= 6.8;
  if (!punchOk) score -= 18;
  checks.push({
    label: 'Drum Punch & Vocal Breathing Room Preserved',
    passed: punchOk,
    detail: `${master.dynamics.plrDb.toFixed(1)} dB Dynamic Crest (${punchOk ? 'Punchy' : 'Over-Squashed'})`,
  });

  const monoOk = master.stereo.lowBandCorrelation >= 0.72 && master.stereo.correlation >= 0.25;
  if (!monoOk) score -= 20;
  checks.push({
    label: 'Phone, Bluetooth & Club Mono-Safe Bass',
    passed: monoOk,
    detail: `Bass Phase Lock ${(master.stereo.lowBandCorrelation * 100).toFixed(0)}%`,
  });

  const phoneBassActive = Boolean(params.phantomBass?.enabled && (params.phantomBass.amountPct ?? 0) > 10);
  const chorusMacroActive = Boolean(params.macroDynamics?.enabled);
  checks.push({
    label: 'Small-Speaker 808 Harmonics & Chorus Macro Lift',
    passed: phoneBassActive || chorusMacroActive,
    detail: `${phoneBassActive ? 'Phantom 808 ON' : 'Natural Sub'} • ${chorusMacroActive ? 'Chorus Bloom ON' : 'Static'}`,
  });

  const clampedScore = clamp(score, 35, 100);
  const gradeLabel =
    clampedScore >= 92
      ? 'Release-Ready Pro Master'
      : clampedScore >= 80
        ? 'Strong Commercial Balance'
        : 'Needs Quick Tweak (Check Mix Doctor)';

  return {
    score: clampedScore,
    gradeLabel,
    checks,
  };
}
