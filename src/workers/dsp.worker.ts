import { analyzeAudioBuffer } from '../dsp/analyzer';
import { auditLossyCodecHeadroom, renderSimulatedCodecPreview } from '../dsp/codecSim';
import { diagnoseMixHeadroomThieves } from '../dsp/mixDoctor';
import { renderMasterChain, sumStemBuses } from '../dsp/processors';
import { demixStereoToFourStems, type LocalDemixResult } from '../dsp/stemDemixer';
import { scanLoudnessSweetSpot } from '../dsp/sweetSpotScanner';
import type {
  AudioAnalysisReport,
  CodecAuditResult,
  CodecProfileId,
  LoudnessSweetSpotReport,
  MasteringChainParams,
  MasterRenderResult,
  MixDoctorIssue,
  PlanarAudioBuffer,
  StemBusParams,
  StemSlotId,
} from '../dsp/types';

export type WorkerRequest =
  | {
      id: number;
      type: 'analyze';
      buffer: PlanarAudioBuffer;
      ceilingDbtp: number;
      oversampling: 4 | 8 | 16;
    }
  | {
      id: number;
      type: 'render_stereo';
      source: PlanarAudioBuffer;
      params: MasteringChainParams;
    }
  | {
      id: number;
      type: 'render_stems';
      stems: Partial<Record<StemSlotId, PlanarAudioBuffer>>;
      busParams: Record<StemSlotId, StemBusParams>;
      params: MasteringChainParams;
    }
  | {
      id: number;
      type: 'demix_stems';
      source: PlanarAudioBuffer;
    }
  | {
      id: number;
      type: 'audit_codecs';
      master: PlanarAudioBuffer;
      previewCodec?: CodecProfileId;
    }
  | {
      id: number;
      type: 'diagnose_source';
      source: PlanarAudioBuffer;
      params: MasteringChainParams;
    };

export type WorkerResponse =
  | { id: number; type: 'progress'; stage: string; pct: number }
  | { id: number; type: 'analyze_done'; report: AudioAnalysisReport }
  | { id: number; type: 'render_stereo_done'; result: MasterRenderResult }
  | {
      id: number;
      type: 'render_stems_done';
      summedSource: PlanarAudioBuffer;
      sourceAnalysis: AudioAnalysisReport;
      result: MasterRenderResult;
      alignmentWarnings: string[];
    }
  | {
      id: number;
      type: 'demix_stems_done';
      demixed: LocalDemixResult;
    }
  | {
      id: number;
      type: 'audit_codecs_done';
      audits: CodecAuditResult[];
      previewBuffer?: PlanarAudioBuffer;
    }
  | {
      id: number;
      type: 'diagnose_source_done';
      issues: MixDoctorIssue[];
      sweetSpot: LoudnessSweetSpotReport;
    }
  | { id: number; type: 'error'; message: string };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;
  try {
    if (msg.type === 'analyze') {
      const report = analyzeAudioBuffer(msg.buffer, {
        ceilingDbtp: msg.ceilingDbtp,
        oversamplingFactor: msg.oversampling,
      });
      ctx.postMessage({ id: msg.id, type: 'analyze_done', report } satisfies WorkerResponse);
    } else if (msg.type === 'render_stereo') {
      const result = renderMasterChain(msg.source, msg.params, (stage, pct) => {
        ctx.postMessage({ id: msg.id, type: 'progress', stage, pct } satisfies WorkerResponse);
      });
      ctx.postMessage({ id: msg.id, type: 'render_stereo_done', result } satisfies WorkerResponse);
    } else if (msg.type === 'render_stems') {
      ctx.postMessage({
        id: msg.id,
        type: 'progress',
        stage: 'Summing & aligning 4-stem console buses',
        pct: 5,
      } satisfies WorkerResponse);
      const { summed, alignmentWarnings } = sumStemBuses(msg.stems, msg.busParams);
      const sourceAnalysis = analyzeAudioBuffer(summed, {
        ceilingDbtp: msg.params.limiter.ceilingDbtp,
        oversamplingFactor: msg.params.limiter.oversampling,
      });
      const result = renderMasterChain(summed, msg.params, (stage, pct) => {
        ctx.postMessage({ id: msg.id, type: 'progress', stage, pct } satisfies WorkerResponse);
      });
      ctx.postMessage({
        id: msg.id,
        type: 'render_stems_done',
        summedSource: summed,
        sourceAnalysis,
        result,
        alignmentWarnings,
      } satisfies WorkerResponse);
    } else if (msg.type === 'demix_stems') {
      const demixed = demixStereoToFourStems(msg.source, (stage, pct) => {
        ctx.postMessage({ id: msg.id, type: 'progress', stage, pct } satisfies WorkerResponse);
      });
      ctx.postMessage({ id: msg.id, type: 'demix_stems_done', demixed } satisfies WorkerResponse);
    } else if (msg.type === 'audit_codecs') {
      const audits = auditLossyCodecHeadroom(msg.master);
      const previewBuffer = msg.previewCodec
        ? renderSimulatedCodecPreview(msg.master, msg.previewCodec)
        : undefined;
      ctx.postMessage({
        id: msg.id,
        type: 'audit_codecs_done',
        audits,
        previewBuffer,
      } satisfies WorkerResponse);
    } else if (msg.type === 'diagnose_source') {
      const issues = diagnoseMixHeadroomThieves(msg.source);
      const sweetSpot = scanLoudnessSweetSpot(msg.source, msg.params);
      ctx.postMessage({
        id: msg.id,
        type: 'diagnose_source_done',
        issues,
        sweetSpot,
      } satisfies WorkerResponse);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'DSP Worker processing error';
    ctx.postMessage({ id: msg.id, type: 'error', message } satisfies WorkerResponse);
  }
};
