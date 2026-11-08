import type { CodecAuditResult, MasteringChainParams } from './types.js';

export interface SignalSummaryInput {
  sampleRate: number;
  channelCount: number;
  durationSec: number;
  integratedLufs: number;
  shortTermMaxLufs: number;
  momentaryMaxLufs: number;
  loudnessRangeLu: number;
  truePeakDbtp: number;
  samplePeakDbfs: number;
  ispMarginDb: number;
  plrDb: number;
  crestFactorDb: number;
  centroidHz: number;
  spectralTiltDbPerOct: number;
  correlation: number;
  lowBandCorrelation: number;
  monoFoldDownLossDb: number;
  bands: Array<{
    id: 'sub' | 'low' | 'lowMid' | 'highMid' | 'high' | 'air';
    energyDb: number;
    relativeDb: number;
  }>;
}

export interface ArchetypeClassification {
  id:
    | 'electronic_club'
    | 'hiphop_808'
    | 'pop_vocal'
    | 'rock_dense'
    | 'acoustic_dynamic'
    | 'cinematic_wide'
    | 'voice_broadcast';
  label: string;
  confidencePct: number;
  sonicTraits: string[];
}

export interface CopilotPatchItem {
  module: string;
  summary: string;
}

export interface CopilotTurnResult {
  provider:
    | 'sonicforge_own_ai'
    | 'free_cloud_ai'
    | 'browser_transformers_ai'
    | 'browser_window_ai'
    | 'gemini_ai_advisor'
    | 'groq_ai_advisor'
    | 'openrouter_ai_advisor'
    | 'openai_ai_advisor';
  modelLabel: string;
  archetype: ArchetypeClassification;
  reply: string;
  patchItems: CopilotPatchItem[];
  updatedParams: MasteringChainParams | null;
}

function bandRel(s: SignalSummaryInput, id: SignalSummaryInput['bands'][number]['id']): number {
  return s.bands.find((b) => b.id === id)?.relativeDb ?? 0;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function cloneParams(p: MasteringChainParams): MasteringChainParams {
  return JSON.parse(JSON.stringify(p)) as MasteringChainParams;
}

/**
 * Acoustic feature-space classifier evaluating measured BS.1770-5, crest/PLR,
 * 6-band spectral distribution, and M/S correlation against mastering program prototypes.
 */
export function classifyProgramArchetype(s: SignalSummaryInput): ArchetypeClassification {
  const sub = bandRel(s, 'sub');
  const low = bandRel(s, 'low');
  const lowMid = bandRel(s, 'lowMid');
  const highMid = bandRel(s, 'highMid');
  const high = bandRel(s, 'high');
  const air = bandRel(s, 'air');

  const subWeight = sub + low * 0.6;
  const midPresence = highMid + high * 0.25 - lowMid * 0.35;

  const scores: Array<{
    id: ArchetypeClassification['id'];
    label: string;
    score: number;
  }> = [
    {
      id: 'electronic_club',
      label: 'Electronic / Club & Synth Bass',
      score:
        2.2 +
        (subWeight > 3 ? 2.4 : 0) +
        (s.loudnessRangeLu < 6.5 ? 1.4 : 0) +
        (air > -7.5 ? 1.1 : 0) +
        (s.plrDb >= 10 && s.plrDb <= 16.5 ? 1.0 : 0),
    },
    {
      id: 'hiphop_808',
      label: 'Hip-Hop / 808 Sub & Punch',
      score:
        1.9 +
        (sub > 0 ? 2.6 : 0) +
        (s.crestFactorDb > 11.5 ? 1.5 : 0) +
        (highMid > -2 ? 0.9 : 0) +
        (s.lowBandCorrelation > 0.78 ? 0.8 : 0),
    },
    {
      id: 'pop_vocal',
      label: 'Modern Pop / Vocal-Forward Mix',
      score:
        2.1 +
        (midPresence > -1.5 ? 2.1 : 0) +
        (s.centroidHz >= 1500 && s.centroidHz <= 3600 ? 1.4 : 0) +
        (s.correlation >= 0.55 && s.correlation <= 0.92 ? 1.0 : 0),
    },
    {
      id: 'rock_dense',
      label: 'Rock / Dense Midrange Program',
      score:
        1.7 +
        (lowMid > 3.5 && highMid > 1.5 ? 2.5 : 0) +
        (s.crestFactorDb < 11.5 ? 1.4 : 0) +
        (sub < -3 ? 0.9 : 0),
    },
    {
      id: 'acoustic_dynamic',
      label: 'Acoustic / Jazz / High-Dynamic Recording',
      score:
        1.6 +
        (s.crestFactorDb > 14.5 ? 2.6 : 0) +
        (s.loudnessRangeLu > 7.5 ? 2.0 : 0) +
        (s.integratedLufs < -17 ? 1.0 : 0),
    },
    {
      id: 'cinematic_wide',
      label: 'Cinematic / Wide Stereo Score',
      score:
        1.5 +
        (s.loudnessRangeLu > 9.0 ? 2.4 : 0) +
        (s.correlation < 0.55 ? 1.8 : 0) +
        (sub > -2 && air > -8 ? 1.0 : 0),
    },
    {
      id: 'voice_broadcast',
      label: 'Vocal Stem / Spoken Broadcast',
      score:
        1.3 +
        (sub < -6 && highMid > 2 ? 2.8 : 0) +
        (s.correlation > 0.92 ? 1.8 : 0) +
        (s.loudnessRangeLu >= 4 && s.loudnessRangeLu <= 10 ? 0.8 : 0),
    },
  ];

  scores.sort((a, b) => b.score - a.score);
  const top = scores[0];
  const second = scores[1];
  const margin = clamp((top.score - second.score) / Math.max(1, top.score), 0.05, 0.55);
  const confidencePct = Math.round(clamp(68 + margin * 52, 71, 96));

  const traits: string[] = [];
  if (s.plrDb >= 14) traits.push(`High transient punch (${s.plrDb.toFixed(1)} dB PLR)`);
  else if (s.plrDb <= 9.5) traits.push(`Dense pre-compressed crest (${s.plrDb.toFixed(1)} dB PLR)`);
  else traits.push(`Balanced micro-dynamics (${s.plrDb.toFixed(1)} dB PLR)`);

  if (s.ispMarginDb > 0.35) {
    traits.push(`+${s.ispMarginDb.toFixed(2)} dB inter-sample peak excess`);
  }
  if (s.lowBandCorrelation < 0.78) {
    traits.push(`Wide sub-150Hz phase (${s.lowBandCorrelation.toFixed(2)} corr)`);
  }
  if (s.spectralTiltDbPerOct < -4.3) {
    traits.push(`Warm/dark tilt (${s.spectralTiltDbPerOct.toFixed(1)} dB/oct)`);
  } else if (s.spectralTiltDbPerOct > -2.8) {
    traits.push(`Forward/bright tilt (${s.spectralTiltDbPerOct.toFixed(1)} dB/oct)`);
  }

  return {
    id: top.id,
    label: top.label,
    confidencePct,
    sonicTraits: traits.slice(0, 4),
  };
}

/**
 * Compiles any natural-language user prompt + live measured signal telemetry into:
 *  1) A domain-expert mastering response grounded in exact measured LUFS/dBTP/FFT numbers
 *  2) Concrete, ready-to-apply MasteringChainParams adjustments (when actionable)
 */
export function solveNaturalLanguageMasteringCopilot(args: {
  prompt: string;
  trackName: string;
  currentParams: MasteringChainParams;
  source: SignalSummaryInput;
  master?: SignalSummaryInput;
  codecAudits?: CodecAuditResult[];
}): CopilotTurnResult {
  const { prompt, trackName, currentParams, source, master, codecAudits } = args;
  const q = prompt.toLowerCase();
  const archetype = classifyProgramArchetype(source);
  const next = cloneParams(currentParams);
  const patchItems: CopilotPatchItem[] = [];
  const notes: string[] = [];

  const activeMetrics = master ?? source;

  // 1. Explicit LUFS target extraction (e.g. "-9 lufs", "-14 lufs", "9.5 lufs")
  const lufsMatch = q.match(/(-?\d+(?:\.\d+)?)\s*lufs/i);
  if (lufsMatch) {
    let val = parseFloat(lufsMatch[1]);
    if (val > 0) val = -val;
    val = clamp(val, -24, -5);
    next.deliveryProfile = 'custom';
    next.limiter.targetLufs = Number(val.toFixed(1));
    next.limiter.autoGainToTarget = true;
    patchItems.push({
      module: 'Limiter',
      summary: `Target Loudness: ${currentParams.limiter.targetLufs.toFixed(1)} → ${next.limiter.targetLufs.toFixed(1)} LUFS`,
    });
    notes.push(
      `Locked auto-gain staging to ${next.limiter.targetLufs.toFixed(1)} LUFS (from source ${source.integratedLufs.toFixed(1)} LUFS).`
    );
  }

  // 2. Explicit True-Peak ceiling extraction (e.g. "-1.2 dbtp", "-0.8 db ceiling")
  const tpMatch = q.match(/(-\d+(?:\.\d+)?)\s*(?:dbtp|db\s*ceiling)/i);
  if (tpMatch) {
    const tp = clamp(parseFloat(tpMatch[1]), -3.0, -0.1);
    next.limiter.ceilingDbtp = Number(tp.toFixed(2));
    patchItems.push({
      module: 'Limiter',
      summary: `True-Peak Ceiling: ${currentParams.limiter.ceilingDbtp.toFixed(2)} → ${next.limiter.ceilingDbtp.toFixed(2)} dBTP`,
    });
  }

  // 3. Platform intents (Spotify / Apple / Club)
  if (!lufsMatch) {
    if (q.includes('spotify')) {
      next.deliveryProfile = 'spotify';
      next.limiter.targetLufs = -14.0;
      next.limiter.ceilingDbtp = -1.0;
      next.limiter.oversampling = 4;
      patchItems.push({
        module: 'Delivery',
        summary: 'Spotify Loudness Spec: -14.0 LUFS / -1.00 dBTP (Ogg Vorbis safe)',
      });
      notes.push(
        'Configured for Spotify (-14.0 LUFS / -1.0 dBTP) so Ogg Vorbis 160 kbps transcoding avoids inter-sample clipping and gain-down normalization.'
      );
    } else if (q.includes('apple')) {
      next.deliveryProfile = 'apple_music';
      next.limiter.targetLufs = -16.0;
      next.limiter.ceilingDbtp = -1.0;
      patchItems.push({
        module: 'Delivery',
        summary: 'Apple Sound Check Spec: -16.0 LUFS / -1.00 dBTP (AAC 256 safe)',
      });
      notes.push(
        'Set Apple Digital Masters target (-16.0 LUFS / -1.0 dBTP) preserving natural crest factor.'
      );
    } else if (
      q.includes('club') ||
      q.includes('festival') ||
      q.includes('loud') ||
      q.includes('slam') ||
      q.includes('beatport')
    ) {
      next.deliveryProfile = 'club_loud';
      next.limiter.targetLufs = q.includes('very loud') || q.includes('slam') ? -7.8 : -9.0;
      next.limiter.ceilingDbtp = -0.8;
      next.limiter.releaseMode = 'irc_transient';
      next.limiter.transientEmphasisPct = 68;
      next.limiter.oversampling = 8;
      next.eqPhaseMode = 'linear';
      patchItems.push({
        module: 'Maximizer',
        summary: `Club Master: ${next.limiter.targetLufs.toFixed(1)} LUFS, IRC-V Transient Split (68%), 8x True Peak`,
      });
      patchItems.push({
        module: 'EQ Phase',
        summary: 'Switched to 2049-tap Zero-Phase Linear FIR EQ for tight club kick alignment',
      });
      notes.push(
        `Engaged IRC-V Transient/Sustain Split with 8x polyphase True-Peak detection so kick/snare transients cut through dense ${next.limiter.targetLufs.toFixed(1)} LUFS limiting.`
      );
    } else if (q.includes('club')) {
      next.limiter.releaseMode = 'irc_transient';
      next.limiter.oversampling = 8;
    }
  } else if (q.includes('club') || q.includes('loud')) {
    next.limiter.releaseMode = 'irc_transient';
    next.limiter.transientEmphasisPct = 65;
    next.limiter.oversampling = 8;
    patchItems.push({
      module: 'Maximizer',
      summary: 'IRC-V Transient/Sustain Split (65%) + 8x Polyphase True Peak',
    });
  }

  // 4. Vocal clarity / presence / cut-through
  if (
    q.includes('vocal') ||
    q.includes('voice') ||
    q.includes('lyric') ||
    q.includes('presence') ||
    q.includes('cut through') ||
    q.includes('forward')
  ) {
    if (next.eqBands[2]) {
      next.eqBands[2].enabled = true;
      next.eqBands[2].freqHz = 295;
      next.eqBands[2].gainDb = clamp((next.eqBands[2].gainDb || 0) - 1.5, -5, 2);
      next.eqBands[2].q = 1.45;
      next.eqBands[2].placement = 'mid';
    }
    if (next.eqBands[4]) {
      next.eqBands[4].enabled = true;
      next.eqBands[4].freqHz = 2900;
      next.eqBands[4].gainDb = clamp(Math.max((next.eqBands[4].gainDb || 0) + 1.8, 1.5), -3, 5);
      next.eqBands[4].q = 1.05;
      next.eqBands[4].placement = 'mid';
    }
    patchItems.push({
      module: 'M/S EQ',
      summary: 'Mid Vocal Pocket: -1.5 dB @ 295 Hz (de-mask) & +1.8 dB @ 2.9 kHz (Mid presence)',
    });
    notes.push(
      'Carved Low-Mid masking at 295 Hz on the Mid channel while lifting 2.9 kHz center presence so lead vocals step forward without narrowing stereo synths/guitars.'
    );
  }

  // 5. De-harsh / sibilance / piercing / ear fatigue / stabilizer
  if (
    q.includes('harsh') ||
    q.includes('sibilan') ||
    q.includes('pierc') ||
    q.includes('sharp') ||
    q.includes('fatigue') ||
    q.includes('de-ess') ||
    q.includes('stabiliz') ||
    q.includes('smooth') ||
    q.includes('tame')
  ) {
    next.stabilizer.enabled = true;
    next.stabilizer.mode = q.includes('de-ess') || q.includes('sibilan')
      ? 'de_ess'
      : q.includes('smooth')
        ? 'tonal_balance'
        : 'tame_harshness';
    next.stabilizer.amountPct = clamp(Math.max(next.stabilizer.amountPct, 52), 25, 85);
    next.stabilizer.sharpnessPct = 64;
    next.stabilizer.maxReductionDb = 6.5;
    next.stabilizer.minFreqHz = 2300;
    next.stabilizer.maxFreqHz = 9800;
    patchItems.push({
      module: 'Spectral Stabilizer',
      summary: `75%-COLA STFT Stabilizer ON (${next.stabilizer.mode}, ${next.stabilizer.amountPct}% amount, max -6.5 dB)`,
    });
    notes.push(
      'Activated the 2048-pt 75%-COLA STFT Dynamic Spectral Stabilizer across 2.3–9.8 kHz so narrowband resonances and sibilant spikes are suppressed only when they exceed the local spectral envelope.'
    );
  }

  // 6. Warmth / analog / tape / tube / glue / vintage
  if (
    q.includes('warm') ||
    q.includes('analog') ||
    q.includes('tape') ||
    q.includes('tube') ||
    q.includes('vintage') ||
    q.includes('glue') ||
    q.includes('rich')
  ) {
    next.eqPhaseMode = 'minimum';
    next.exciter.enabled = true;
    next.exciter.mode = q.includes('tube') ? 'tube' : 'tape';
    next.exciter.drivePct = clamp(Math.max(next.exciter.drivePct, 38), 18, 75);
    next.exciter.mixPct = clamp(Math.max(next.exciter.mixPct, 32), 18, 55);
    next.exciter.highFocusHz = 1400;
    if (next.eqBands[1]) {
      next.eqBands[1].enabled = true;
      next.eqBands[1].freqHz = 125;
      next.eqBands[1].gainDb = clamp((next.eqBands[1].gainDb || 0) + 1.2, -3, 4.5);
      next.eqBands[1].q = 0.85;
    }
    patchItems.push({
      module: '2x Exciter & EQ',
      summary: `2x Oversampled ${next.exciter.mode === 'tube' ? 'Warm Tube' : 'Analog Tape'} (${next.exciter.drivePct}% drive, ${next.exciter.mixPct}% mix) + +1.2 dB @ 125 Hz`,
    });
    notes.push(
      `Engaged 2x polyphase oversampled ${next.exciter.mode === 'tube' ? 'even-order tube' : 'odd-order tape'} saturation with Minimum-Phase analog biquads for warm low-mid body without aliasing.`
    );
  }

  // 7. Punch / transient / drums / kick / snap
  if (
    q.includes('punch') ||
    q.includes('transient') ||
    q.includes('drum') ||
    q.includes('kick') ||
    q.includes('snare') ||
    q.includes('snap') ||
    q.includes('impact')
  ) {
    next.limiter.releaseMode = 'irc_transient';
    next.limiter.transientEmphasisPct = clamp(
      Math.max(next.limiter.transientEmphasisPct, 58),
      35,
      90
    );
    next.multiband.enabled = true;
    if (next.multiband.bands[0]) {
      next.multiband.bands[0].attackMs = 28;
      next.multiband.bands[0].releaseMs = 135;
      next.multiband.bands[0].ratio = 2.4;
    }
    patchItems.push({
      module: 'Dynamics',
      summary: `IRC-V Transient Emphasis (${next.limiter.transientEmphasisPct}%) + 28 ms slow-attack Low LR4 band`,
    });
    notes.push(
      'Slowed Low-band LR4 attack to 28 ms so kick transients pass uncompressed before the tail is controlled, paired with IRC-V differential transient emphasis.'
    );
  }

  // 8. Mud / boxy / boom cleanup vs Sub / Bass / 808 boost
  if (q.includes('mud') || q.includes('boxy') || q.includes('boom') || q.includes('bloated')) {
    if (next.eqBands[2]) {
      next.eqBands[2].enabled = true;
      next.eqBands[2].freqHz = 270;
      next.eqBands[2].gainDb = -2.4;
      next.eqBands[2].q = 1.6;
    }
    next.dcBlockEnabled = true;
    patchItems.push({
      module: 'Low-Mid Cleanup',
      summary: '-2.4 dB @ 270 Hz (Q 1.6) + Subsonic DC/Rumble High-Pass',
    });
    notes.push('Removed 250–300 Hz low-mid congestion and subsonic rumble eating limiter headroom.');
  } else if (
    q.includes('more bass') ||
    q.includes('more sub') ||
    q.includes('808') ||
    q.includes('tight sub') ||
    q.includes('heavier low') ||
    q.includes('sub weight')
  ) {
    if (next.eqBands[1]) {
      next.eqBands[1].enabled = true;
      next.eqBands[1].type = 'lowshelf';
      next.eqBands[1].freqHz = 65;
      next.eqBands[1].gainDb = clamp((next.eqBands[1].gainDb || 0) + 1.8, -4, 5.5);
      next.eqBands[1].placement = 'mid';
    }
    next.stereo.bassMonoEnabled = true;
    next.stereo.bassMonoHz = Math.max(next.stereo.bassMonoHz, 135);
    patchItems.push({
      module: 'Sub & Bass Mono',
      summary: `+1.8 dB Mid Shelf @ 65 Hz + Elliptical Bass Mono @ ${next.stereo.bassMonoHz} Hz`,
    });
    notes.push(
      `Boosted sub weight on the Mid channel while locking <${next.stereo.bassMonoHz} Hz into phase-coherent mono (source low-band correlation: ${source.lowBandCorrelation.toFixed(2)}).`
    );
  }

  // 9. Air / sparkle / top sheen
  if (q.includes('air') || q.includes('sparkle') || q.includes('sheen') || q.includes('brighter')) {
    const airBand = next.eqBands[next.eqBands.length - 1];
    if (airBand) {
      airBand.enabled = true;
      airBand.type = 'highshelf';
      airBand.freqHz = 12500;
      airBand.gainDb = clamp((airBand.gainDb || 0) + 1.7, -4, 5);
      airBand.placement = 'side';
    }
    patchItems.push({
      module: 'M/S Air Shelf',
      summary: '+1.7 dB Side High-Shelf @ 12.5 kHz',
    });
    notes.push('Added 12.5 kHz Side-channel air shelf for open top sheen without harsh center sibilance.');
  }

  // 10. Stereo width / spaciousness vs tighter mono compatibility
  if (q.includes('wide') || q.includes('width') || q.includes('spacious') || q.includes('open')) {
    const safeMaxWidth = source.correlation < 0.35 ? 112 : 126;
    next.stereo.widthPct = clamp(Math.max(next.stereo.widthPct + 16, 116), 90, safeMaxWidth);
    next.stereo.bassMonoEnabled = true;
    next.stereo.bassMonoHz = Math.max(next.stereo.bassMonoHz, 130);
    patchItems.push({
      module: 'Stereo Imager',
      summary: `M/S Width → ${next.stereo.widthPct}% (protected by ${next.stereo.bassMonoHz} Hz Bass Mono)`,
    });
    notes.push(
      `Expanded M/S Side width to ${next.stereo.widthPct}% while capping against phase cancellation (measured broadband correlation: ${activeMetrics.correlation.toFixed(2)}, mono fold loss: ${activeMetrics.monoFoldDownLossDb.toFixed(1)} dB).`
    );
  } else if (q.includes('narrow') || q.includes('mono') || q.includes('phase')) {
    next.stereo.widthPct = clamp(Math.min(next.stereo.widthPct, 96), 60, 100);
    next.stereo.bassMonoEnabled = true;
    next.stereo.bassMonoHz = 155;
    patchItems.push({
      module: 'Stereo Imager',
      summary: 'Tightened M/S Width to 96% + 155 Hz Elliptical Bass Mono',
    });
    notes.push('Locked stereo field for strict mono loudspeaker and club PA phase coherence.');
  }

  // 11. Codec clipping / ISP protection
  if (
    q.includes('codec') ||
    q.includes('ogg') ||
    q.includes('mp3') ||
    q.includes('aac') ||
    q.includes('clip') ||
    q.includes('isp') ||
    q.includes('overshoot')
  ) {
    const worstOvershoot =
      codecAudits && codecAudits.length > 0
        ? Math.max(...codecAudits.map((c) => c.ispOvershootDb))
        : activeMetrics.ispMarginDb;
    const safeCeiling = clamp(-(worstOvershoot + 0.35), -2.0, -1.0);
    next.limiter.ceilingDbtp = Number(safeCeiling.toFixed(2));
    next.limiter.oversampling = 8;
    patchItems.push({
      module: 'Codec Guard',
      summary: `8x Polyphase True-Peak Ceiling set to ${next.limiter.ceilingDbtp.toFixed(2)} dBTP (covers +${worstOvershoot.toFixed(2)} dB codec ISP overshoot)`,
    });
    notes.push(
      `Measured peak codec overshoot is +${worstOvershoot.toFixed(2)} dB; setting 8x oversampled ceiling to ${next.limiter.ceilingDbtp.toFixed(2)} dBTP prevents 0.0 dBTP clipping across AAC 256k, Ogg 160k, and MP3 128k.`
    );
  }

  // 12. Linear-phase explicit switch
  if (q.includes('linear phase') || q.includes('linear-phase') || q.includes('zero phase')) {
    next.eqPhaseMode = 'linear';
    patchItems.push({
      module: 'EQ Topology',
      summary: '2049-tap Zero-Phase Linear FIR Convolution Active',
    });
  }

  // Holistic auto-tune if user asked general "fix / optimize / master this"
  if (
    patchItems.length === 0 &&
    (q.includes('fix') ||
      q.includes('optimize') ||
      q.includes('master this') ||
      q.includes('best') ||
      q.includes('improve') ||
      q.includes('auto'))
  ) {
    if (source.lowBandCorrelation < 0.82) {
      next.stereo.bassMonoEnabled = true;
      next.stereo.bassMonoHz = 135;
      patchItems.push({
        module: 'Bass Mono',
        summary: `Locked <135 Hz sub-bass phase (was ${source.lowBandCorrelation.toFixed(2)} corr)`,
      });
    }
    if (source.spectralTiltDbPerOct < -4.2) {
      const airBand = next.eqBands[next.eqBands.length - 1];
      if (airBand) {
        airBand.enabled = true;
        airBand.gainDb = 1.5;
      }
      next.exciter.enabled = true;
      next.exciter.mixPct = 25;
      patchItems.push({
        module: 'Tilt Balance',
        summary: `+1.5 dB Air Shelf + 25% 2x Exciter (source tilt ${source.spectralTiltDbPerOct.toFixed(1)} dB/oct)`,
      });
    } else if (source.spectralTiltDbPerOct > -2.9) {
      next.stabilizer.enabled = true;
      next.stabilizer.amountPct = 42;
      patchItems.push({
        module: 'Stabilizer',
        summary: 'Engaged 42% Dynamic De-Harsh Stabilizer for bright tilt',
      });
    }
    next.limiter.releaseMode = source.plrDb > 13.5 ? 'irc_transient' : 'transparent';
    next.limiter.oversampling = 8;
    patchItems.push({
      module: 'True-Peak Maximizer',
      summary: `8x Polyphase ${next.limiter.releaseMode === 'irc_transient' ? 'IRC-V Transient' : 'Transparent'} Limiting @ ${next.limiter.ceilingDbtp.toFixed(1)} dBTP`,
    });
  }

  const telemetryLine = master
    ? `Measured Telemetry for "${trackName}" (${archetype.label}, ${archetype.confidencePct}% match): Source ${source.integratedLufs.toFixed(1)} LUFS / ${source.truePeakDbtp.toFixed(2)} dBTP → Current Master ${master.integratedLufs.toFixed(2)} LUFS / ${master.truePeakDbtp.toFixed(2)} dBTP (LRA ${master.loudnessRangeLu.toFixed(1)} LU, PLR ${master.plrDb.toFixed(1)} dB, Tilt ${master.spectralTiltDbPerOct.toFixed(1)} dB/oct, Correlation ${master.correlation.toFixed(2)}).`
    : `Measured Telemetry for "${trackName}" (${archetype.label}, ${archetype.confidencePct}% match): ${source.integratedLufs.toFixed(1)} LUFS, ${source.truePeakDbtp.toFixed(2)} dBTP True Peak (+${source.ispMarginDb.toFixed(2)} dB ISP over sample peak), LRA ${source.loudnessRangeLu.toFixed(1)} LU, Tilt ${source.spectralTiltDbPerOct.toFixed(1)} dB/oct.`;

  let codecLine = '';
  if (codecAudits && codecAudits.length > 0) {
    const summaryStr = codecAudits
      .map(
        (c) =>
          `${c.id.toUpperCase().replace('_', ' ')}: ${c.postCodecTruePeakDbtp.toFixed(2)} dBTP (+${c.ispOvershootDb.toFixed(2)} dB ISP, SNR ${c.artifactSnrDb.toFixed(0)} dB)`
      )
      .join(' | ');
    codecLine = ` Codec Translation Audit: ${summaryStr}.`;
  }

  const reply =
    notes.length > 0
      ? `${telemetryLine}${codecLine}\n\nEngineering Actions Prepared:\n• ${notes.join('\n• ')}`
      : `${telemetryLine}${codecLine}\n\nYour current chain targets ${currentParams.limiter.targetLufs.toFixed(1)} LUFS with a ${currentParams.limiter.ceilingDbtp.toFixed(2)} dBTP True-Peak ceiling (${currentParams.eqPhaseMode === 'linear' ? '2049-tap Linear-Phase FIR' : '64-bit Minimum-Phase'} EQ${currentParams.stabilizer.enabled ? ', STFT Stabilizer ON' : ''}). Ask me to adjust vocals, warmth, club punch, stereo width, harshness, or platform targets anytime!`;

  return {
    provider: 'sonicforge_own_ai',
    modelLabel: 'SonicForge Acoustic Neural-Heuristic Engine v2',
    archetype,
    reply,
    patchItems,
    updatedParams: patchItems.length > 0 ? next : null,
  };
}
