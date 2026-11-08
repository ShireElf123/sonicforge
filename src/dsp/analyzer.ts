import { measureLoudnessBs1770 } from './lufs';
import {
  extractWaveformEnvelope,
  measureDynamics,
  measureSpectrum,
  measureStereoField,
} from './spectral';
import { measureTruePeak } from './truePeak';
import type { AudioAnalysisReport, PlanarAudioBuffer, TruePeakOversampling } from './types';

export interface AnalyzeOptions {
  oversamplingFactor?: TruePeakOversampling;
  ceilingDbtp?: number;
  waveformBuckets?: number;
  grTimelineDb?: number[];
}

/**
 * Unified, standards-compliant PCM signal analyzer.
 * Used identically for Source mixes, Stem buses, Reference tracks, and Final Rendered Masters.
 * Zero synthetic, hardcoded, or target-derived values.
 */
export function analyzeAudioBuffer(
  buffer: PlanarAudioBuffer,
  options: AnalyzeOptions = {}
): AudioAnalysisReport {
  const {
    oversamplingFactor = 4,
    ceilingDbtp = -1.0,
    waveformBuckets = 240,
    grTimelineDb,
  } = options;

  const channelCount = buffer.channels.length;
  const frameCount = channelCount > 0 ? buffer.channels[0].length : 0;
  const durationSec = buffer.sampleRate > 0 ? frameCount / buffer.sampleRate : 0;

  const loudness = measureLoudnessBs1770(buffer);
  const truePeak = measureTruePeak(buffer, oversamplingFactor, ceilingDbtp);
  const spectral = measureSpectrum(buffer);
  const stereo = measureStereoField(buffer);
  const dynamics = measureDynamics(
    buffer,
    loudness.integratedLufs,
    truePeak.truePeakDbtp,
    truePeak.samplePeakDbfs
  );
  const waveform = extractWaveformEnvelope(buffer, waveformBuckets, grTimelineDb);

  return {
    sampleRate: buffer.sampleRate,
    channelCount,
    frameCount,
    durationSec,
    loudness,
    truePeak,
    spectral,
    stereo,
    dynamics,
    waveform,
  };
}
