import { z } from 'zod';

const finiteDb = z.number().min(-140).max(30);

export const MeasuredBandSchema = z
  .object({
    id: z.enum(['sub', 'low', 'lowMid', 'highMid', 'high', 'air']),
    energyDb: finiteDb,
    relativeDb: z.number().min(-80).max(80),
  })
  .strict();

export const SignalSummarySchema = z
  .object({
    sampleRate: z.number().int().min(8000).max(384000),
    channelCount: z.number().int().min(1).max(8),
    durationSec: z.number().min(0.01).max(7200),
    integratedLufs: z.number().min(-120).max(12),
    shortTermMaxLufs: z.number().min(-120).max(12),
    momentaryMaxLufs: z.number().min(-120).max(15),
    loudnessRangeLu: z.number().min(0).max(80),
    truePeakDbtp: z.number().min(-120).max(24),
    samplePeakDbfs: z.number().min(-120).max(24),
    ispMarginDb: z.number().min(0).max(24),
    plrDb: z.number().min(-10).max(80),
    crestFactorDb: z.number().min(0).max(80),
    centroidHz: z.number().min(0).max(96000),
    spectralTiltDbPerOct: z.number().min(-24).max(12),
    correlation: z.number().min(-1).max(1),
    lowBandCorrelation: z.number().min(-1).max(1),
    monoFoldDownLossDb: z.number().min(0).max(80),
    bands: z.array(MeasuredBandSchema).length(6),
  })
  .strict();

export const MasteringAdviseRequestSchema = z
  .object({
    trackName: z.string().trim().min(1).max(160),
    workflowMode: z.enum(['stereo', 'stems']),
    deliveryProfile: z.enum([
      'spotify',
      'apple_music',
      'youtube',
      'ebu_r128',
      'club_loud',
      'custom',
    ]),
    tonalPreset: z.enum([
      'transparent',
      'warm_analog',
      'modern_punch',
      'vocal_presence',
      'reference_match',
    ]),
    targetLufs: z.number().min(-36).max(-3),
    ceilingDbtp: z.number().min(-6).max(0),
    preferEngine: z.enum(['auto', 'own_ai', 'free_cloud', 'custom_key']).optional(),
    source: SignalSummarySchema,
    renderedMaster: SignalSummarySchema.optional(),
    reference: SignalSummarySchema.optional(),
  })
  .strict();

export type MasteringAdviseRequest = z.infer<typeof MasteringAdviseRequestSchema>;

const CodecAuditSchema = z
  .object({
    id: z.enum(['aac_256', 'ogg_160', 'mp3_128']),
    label: z.string().max(120),
    cutoffHz: z.number().min(1000).max(48000),
    preTruePeakDbtp: z.number().min(-120).max(24),
    postCodecTruePeakDbtp: z.number().min(-120).max(24),
    ispOvershootDb: z.number().min(0).max(24),
    artifactSnrDb: z.number().min(0).max(140),
    clipsZeroDbtp: z.boolean(),
    engineType: z.enum(['webcodecs_hardware', 'psychoacoustic_24bark']).optional(),
  })
  .strict();

export const MasteringChatRequestSchema = z
  .object({
    prompt: z.string().trim().min(1).max(1200),
    trackName: z.string().trim().min(1).max(160),
    preferEngine: z.enum(['auto', 'own_ai', 'free_cloud', 'custom_key']).optional(),
    currentParams: z.record(z.unknown()),
    source: SignalSummarySchema,
    renderedMaster: SignalSummarySchema.optional(),
    codecAudits: z.array(CodecAuditSchema).max(6).optional(),
    history: z
      .array(
        z
          .object({
            role: z.enum(['user', 'assistant']),
            content: z.string().max(1600),
          })
          .strict()
      )
      .max(8)
      .optional(),
  })
  .strict();

export type MasteringChatRequest = z.infer<typeof MasteringChatRequestSchema>;
