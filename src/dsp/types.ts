export interface PlanarAudioBuffer {
  sampleRate: number;
  channels: Float32Array[];
  duration: number;
}

export type TruePeakOversampling = 4 | 8 | 16;

export type DeliveryProfileId =
  | 'spotify'
  | 'apple_music'
  | 'youtube'
  | 'ebu_r128'
  | 'club_loud'
  | 'custom';

export type TonalPresetId =
  | 'transparent'
  | 'warm_analog'
  | 'modern_punch'
  | 'vocal_presence'
  | 'reference_match';

export interface DeliveryProfileSpec {
  id: DeliveryProfileId;
  name: string;
  targetLufs: number;
  ceilingDbtp: number;
  minRecommendedPlrDb: number;
  notes: string;
}

export interface LoudnessMetrics {
  integratedLufs: number;
  shortTermMaxLufs: number;
  momentaryMaxLufs: number;
  loudnessRangeLu: number;
  momentaryTimeline: number[];
  shortTermTimeline: number[];
}

export interface TruePeakMetrics {
  truePeakDbtp: number;
  truePeakPerChannelDbtp: number[];
  samplePeakDbfs: number;
  samplePeakPerChannelDbfs: number[];
  ispMarginDb: number;
  oversamplingFactor: TruePeakOversampling;
  clippedSampleCount: number;
  truePeakOverZeroCount: number;
  ceilingViolationCount: number;
}

export type TonalBandId = 'sub' | 'low' | 'lowMid' | 'highMid' | 'high' | 'air';

export interface SpectralBandSummary {
  id: TonalBandId;
  label: string;
  rangeHz: [number, number];
  energyDb: number;
  relativeDb: number;
}

export interface SpectrumBinPoint {
  freqHz: number;
  db: number;
  relativeDb: number;
}

export interface SpectralMetrics {
  bins: SpectrumBinPoint[];
  bands: SpectralBandSummary[];
  centroidHz: number;
  spectralTiltDbPerOct: number;
}

export interface StereoMetrics {
  correlation: number;
  lowBandCorrelation: number;
  midBandCorrelation: number;
  highBandCorrelation: number;
  midSideRatioDb: number;
  balanceDb: number;
  monoFoldDownLossDb: number;
  vectorscopePoints: Array<{ m: number; s: number }>;
}

export interface DynamicsMetrics {
  rmsDbfs: number;
  crestFactorDb: number;
  plrDb: number;
  dcOffset: number;
}

export interface WaveformEnvelopePoint {
  min: number;
  max: number;
  rms: number;
  grDb?: number;
}

export interface AudioAnalysisReport {
  sampleRate: number;
  channelCount: number;
  frameCount: number;
  durationSec: number;
  loudness: LoudnessMetrics;
  truePeak: TruePeakMetrics;
  spectral: SpectralMetrics;
  stereo: StereoMetrics;
  dynamics: DynamicsMetrics;
  waveform: WaveformEnvelopePoint[];
}

export type EqFilterType = 'highpass' | 'lowshelf' | 'peaking' | 'highshelf';
export type EqPlacement = 'stereo' | 'mid' | 'side';
export type EqPhaseMode = 'minimum' | 'linear';

export interface EqBandParams {
  id: string;
  label: string;
  enabled: boolean;
  type: EqFilterType;
  freqHz: number;
  gainDb: number;
  q: number;
  placement: EqPlacement;
  /** Pro-Q 4 style per-band dynamic EQ (compress < 0 dB or upward expand > 0 dB) */
  dynEnabled?: boolean;
  dynThresholdDb?: number;
  dynRangeDb?: number;
}

export interface StabilizerParams {
  enabled: boolean;
  mode: 'tame_harshness' | 'tonal_balance' | 'de_ess';
  amountPct: number;
  sharpnessPct: number;
  minFreqHz: number;
  maxFreqHz: number;
  maxReductionDb: number;
}

export interface MultibandBandParams {
  id: string;
  label: string;
  bypass: boolean;
  solo: boolean;
  thresholdDb: number;
  ratio: number;
  attackMs: number;
  releaseMs: number;
  makeupDb: number;
}

export interface MultibandParams {
  enabled: boolean;
  crossoversHz: [number, number, number];
  bands: [
    MultibandBandParams,
    MultibandBandParams,
    MultibandBandParams,
    MultibandBandParams,
  ];
}

export interface StereoStageParams {
  enabled: boolean;
  bassMonoEnabled: boolean;
  bassMonoHz: number;
  widthPct: number;
  highWidthPct: number;
  highCrossoverHz: number;
}

export interface ExciterParams {
  enabled: boolean;
  mode: 'tape' | 'tube' | 'transformer';
  drivePct: number;
  highFocusHz: number;
  mixPct: number;
}

export type LimiterReleaseMode =
  | 'transparent'
  | 'irc_transient'
  | 'irc_spectral'
  | 'punchy'
  | 'dynamic';

export type SoftClipCurveMode = 'crisp_cubic' | 'warm_tanh' | 'diode_even';

export interface LimiterParams {
  enabled: boolean;
  autoGainToTarget: boolean;
  targetLufs: number;
  maxAutoDriveDb: number;
  manualDriveDb: number;
  ceilingDbtp: number;
  lookaheadMs: number;
  releaseMode: LimiterReleaseMode;
  transientEmphasisPct: number;
  oversampling: TruePeakOversampling;
  /** 4x Polyphase Oversampled Pre-Limiter Mastering Soft Clipper (StandardCLIP / KClip style) */
  softClipEnabled?: boolean;
  softClipMode?: SoftClipCurveMode;
  softClipThresholdDb?: number;
  softClipAmountPct?: number;
}

export interface WavMetadata {
  title?: string;
  artist?: string;
  album?: string;
  isrc?: string;
  comment?: string;
}

export interface ExportFormatParams {
  bitDepth: 16 | 24 | 32;
  dither: 'none' | 'tpdf' | 'tpdf_shaped';
  metadata?: WavMetadata;
}

export interface MasteringChainParams {
  deliveryProfile: DeliveryProfileId;
  tonalPreset: TonalPresetId;
  inputGainDb: number;
  dcBlockEnabled: boolean;
  eqEnabled: boolean;
  eqPhaseMode: EqPhaseMode;
  eqBands: EqBandParams[];
  stabilizer: StabilizerParams;
  multiband: MultibandParams;
  stereo: StereoStageParams;
  exciter: ExciterParams;
  limiter: LimiterParams;
  exportFormat: ExportFormatParams;
}

export type StemSlotId = 'drums' | 'bass' | 'vocals' | 'instruments';

export interface StemBusParams {
  id: StemSlotId;
  label: string;
  gainDb: number;
  pan: number;
  mute: boolean;
  solo: boolean;
  hpfHz: number;
  lowShelfDb: number;
  midBellDb: number;
  midFreqHz: number;
  highShelfDb: number;
  compAmountPct: number;
  widthPct: number;
}

export interface MasterRenderResult {
  buffer: PlanarAudioBuffer;
  analysis: AudioAnalysisReport;
  appliedLimiterDriveDb: number;
  autoDriveCapped: boolean;
  maxGainReductionDb: number;
  gainReductionTimelineDb: number[];
  stabilizerAttenuationDb: number[];
  processingTimeMs: number;
}

export interface WavVerificationReport {
  validRiffHeader: boolean;
  formatCode: 1 | 3;
  bitDepth: 16 | 24 | 32;
  sampleRate: number;
  channels: number;
  frameCount: number;
  durationSec: number;
  byteLength: number;
  hasNaNOrInf: boolean;
  hasInfoMetadata: boolean;
  measuredIntegratedLufs: number;
  measuredTruePeakDbtp: number;
  measuredSamplePeakDbfs: number;
  ceilingCompliant: boolean;
}

export type CodecProfileId = 'aac_256' | 'ogg_160' | 'mp3_128';

export interface CodecAuditResult {
  id: CodecProfileId;
  label: string;
  cutoffHz: number;
  preTruePeakDbtp: number;
  postCodecTruePeakDbtp: number;
  ispOvershootDb: number;
  artifactSnrDb: number;
  clipsZeroDbtp: boolean;
  engineType?: 'webcodecs_hardware' | 'psychoacoustic_24bark';
}
