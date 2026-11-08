import { analyzeAudioBuffer } from '../dsp/analyzer';
import { auditLossyCodecHeadroom, renderSimulatedCodecPreview } from '../dsp/codecSim';
import { renderMasterChain, sumStemBuses } from '../dsp/processors';
import { demixStereoToFourStems, type LocalDemixResult } from '../dsp/stemDemixer';
import type {
  AudioAnalysisReport,
  CodecAuditResult,
  CodecProfileId,
  MasteringChainParams,
  MasterRenderResult,
  PlanarAudioBuffer,
  StemBusParams,
  StemSlotId,
} from '../dsp/types';
import type { WorkerRequest, WorkerResponse } from '../workers/dsp.worker';

class DspWorkerClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<
    number,
    {
      resolve: (val: any) => void;
      reject: (err: Error) => void;
      onProgress?: (stage: string, pct: number) => void;
    }
  >();

  private ensureWorker(): Worker | null {
    if (typeof Worker === 'undefined') return null;
    if (!this.worker) {
      try {
        this.worker = new Worker(new URL('../workers/dsp.worker.ts', import.meta.url), {
          type: 'module',
        });
        this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
          const msg = e.data;
          const entry = this.pending.get(msg.id);
          if (!entry) return;
          if (msg.type === 'progress') {
            entry.onProgress?.(msg.stage, msg.pct);
            return;
          }
          this.pending.delete(msg.id);
          if (msg.type === 'error') {
            entry.reject(new Error(msg.message));
          } else if (msg.type === 'analyze_done') {
            entry.resolve(msg.report);
          } else if (msg.type === 'render_stereo_done') {
            entry.resolve(msg.result);
          } else if (msg.type === 'render_stems_done') {
            entry.resolve({
              summedSource: msg.summedSource,
              sourceAnalysis: msg.sourceAnalysis,
              result: msg.result,
              alignmentWarnings: msg.alignmentWarnings,
            });
          } else if (msg.type === 'demix_stems_done') {
            entry.resolve(msg.demixed);
          } else if (msg.type === 'audit_codecs_done') {
            entry.resolve({ audits: msg.audits, previewBuffer: msg.previewBuffer });
          }
        };
      } catch {
        this.worker = null;
      }
    }
    return this.worker;
  }

  async analyze(
    buffer: PlanarAudioBuffer,
    ceilingDbtp = -1.0,
    oversampling: 4 | 8 = 4
  ): Promise<AudioAnalysisReport> {
    const w = this.ensureWorker();
    if (!w) {
      return analyzeAudioBuffer(buffer, { ceilingDbtp, oversamplingFactor: oversampling });
    }
    const id = this.nextId++;
    return new Promise<AudioAnalysisReport>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      w.postMessage({
        id,
        type: 'analyze',
        buffer,
        ceilingDbtp,
        oversampling,
      } satisfies WorkerRequest);
    });
  }

  async renderStereo(
    source: PlanarAudioBuffer,
    params: MasteringChainParams,
    onProgress?: (stage: string, pct: number) => void
  ): Promise<MasterRenderResult> {
    const w = this.ensureWorker();
    if (!w) {
      return renderMasterChain(source, params, onProgress);
    }
    const id = this.nextId++;
    return new Promise<MasterRenderResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      w.postMessage({
        id,
        type: 'render_stereo',
        source,
        params,
      } satisfies WorkerRequest);
    });
  }

  async renderStems(
    stems: Partial<Record<StemSlotId, PlanarAudioBuffer>>,
    busParams: Record<StemSlotId, StemBusParams>,
    params: MasteringChainParams,
    onProgress?: (stage: string, pct: number) => void
  ): Promise<{
    summedSource: PlanarAudioBuffer;
    sourceAnalysis: AudioAnalysisReport;
    result: MasterRenderResult;
    alignmentWarnings: string[];
  }> {
    const w = this.ensureWorker();
    if (!w) {
      const { summed, alignmentWarnings } = sumStemBuses(stems, busParams);
      const sourceAnalysis = analyzeAudioBuffer(summed, {
        ceilingDbtp: params.limiter.ceilingDbtp,
        oversamplingFactor: params.limiter.oversampling,
      });
      const result = renderMasterChain(summed, params, onProgress);
      return { summedSource: summed, sourceAnalysis, result, alignmentWarnings };
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      w.postMessage({
        id,
        type: 'render_stems',
        stems,
        busParams,
        params,
      } satisfies WorkerRequest);
    });
  }

  async demixStems(
    source: PlanarAudioBuffer,
    onProgress?: (stage: string, pct: number) => void
  ): Promise<LocalDemixResult> {
    const w = this.ensureWorker();
    if (!w) {
      return demixStereoToFourStems(source, onProgress);
    }
    const id = this.nextId++;
    return new Promise<LocalDemixResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      w.postMessage({ id, type: 'demix_stems', source } satisfies WorkerRequest);
    });
  }

  async auditCodecs(
    master: PlanarAudioBuffer,
    previewCodec?: CodecProfileId
  ): Promise<{ audits: CodecAuditResult[]; previewBuffer?: PlanarAudioBuffer }> {
    const w = this.ensureWorker();
    if (!w) {
      return {
        audits: auditLossyCodecHeadroom(master),
        previewBuffer: previewCodec ? renderSimulatedCodecPreview(master, previewCodec) : undefined,
      };
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      w.postMessage({
        id,
        type: 'audit_codecs',
        master,
        previewCodec,
      } satisfies WorkerRequest);
    });
  }
}

export const dspWorker = new DspWorkerClient();
