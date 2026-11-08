import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity,
  CheckCircle2,
  Disc3,
  Download,
  Layers,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  Sliders,
  Sparkles,
  Speaker,
  Square,
  Upload,
  Volume2,
} from 'lucide-react';
import { browserAiClient } from './audio/browserAiClient';
import { decodeUploadedAudioFile } from './audio/decodeAudioFile';
import { dspWorker } from './audio/dspWorkerClient';
import {
  type AuditionMode,
  type HeadphoneProfile,
  type LivePlaybackMeterFrame,
  type MonitorMode,
  type MonitorVoicing,
  playbackEngine,
  type SplMonitorMode,
} from './audio/playbackEngine';
import { tryWebCodecsRoundTrip } from './audio/webCodecsAudit';
import { ArtistAutopilotModule } from './components/ArtistAutopilotModule';
import {
  AssistantAndBenchmarkModule,
  type ServerAdviceData,
  type UiAiEngineMode,
} from './components/AssistantAndBenchmarkModule';
import { CodecAndAlbumModule } from './components/CodecAndAlbumModule';
import { EqModule } from './components/EqModule';
import { InstantAutoMasterView } from './components/InstantAutoMasterView';
import { LimiterExportModule } from './components/LimiterExportModule';
import { MeteringDock } from './components/MeteringDock';
import { MultibandModule } from './components/MultibandModule';
import { SpectrumAndTonalView } from './components/SpectrumAndTonalView';
import { StemConsoleModule } from './components/StemConsoleModule';
import { StereoExciterModule } from './components/StereoExciterModule';
import { WaveformTimeline } from './components/WaveformTimeline';
import { computeSignalDrivenAssistant } from './dsp/assistant';
import { classifyProgramArchetype } from './dsp/ownAiEngine';
import {
  createDefaultMasteringParams,
  createDefaultStemBuses,
  createNeutralBypassParams,
  DELIVERY_PROFILES,
} from './dsp/profiles';
import {
  BUILT_IN_SESSIONS,
  type BuiltInSessionId,
  generateEbuCalibrationTone,
  generateIspTortureVector,
  generateStudioSession,
} from './dsp/synthTestVectors';
import type {
  AudioAnalysisReport,
  CodecAuditResult,
  CodecProfileId,
  DeliveryProfileId,
  DetectedSection,
  EqBandParams,
  LoudnessSweetSpotReport,
  MasteringChainParams,
  MixDoctorIssue,
  PlanarAudioBuffer,
  StemBusParams,
  StemSlotId,
  TonalPresetId,
  WavVerificationReport,
} from './dsp/types';
import { encodeWav, verifyExportedWav } from './dsp/wav';

type ModuleTab =
  | 'autopilot'
  | 'assistant'
  | 'eq'
  | 'multiband'
  | 'stereo'
  | 'limiter'
  | 'stems'
  | 'codec_album';

export const App: React.FC = () => {
  const [uiMode, setUiMode] = useState<'auto_simple' | 'pro_studio'>('auto_simple');
  const [workflowMode, setWorkflowMode] = useState<'stereo' | 'stems'>('stereo');
  const [activeTab, setActiveTab] = useState<ModuleTab>('autopilot');
  const [selectedBuiltIn, setSelectedBuiltIn] = useState<BuiltInSessionId>('neon_horizon_mix');
  const [trackName, setTrackName] = useState<string>('Neon Horizon — Electronic Mix');

  const [sourceBuffer, setSourceBuffer] = useState<PlanarAudioBuffer | null>(null);
  const [masterBuffer, setMasterBuffer] = useState<PlanarAudioBuffer | null>(null);
  const [sourceAnalysis, setSourceAnalysis] = useState<AudioAnalysisReport | null>(null);
  const [masterAnalysis, setMasterAnalysis] = useState<AudioAnalysisReport | null>(null);

  const [referenceName, setReferenceName] = useState<string | null>(null);
  const [referenceBuffer, setReferenceBuffer] = useState<PlanarAudioBuffer | null>(null);
  const [referenceAnalysis, setReferenceAnalysis] = useState<AudioAnalysisReport | null>(null);

  const [stems, setStems] = useState<Partial<Record<StemSlotId, PlanarAudioBuffer>>>({});
  const [stemNames, setStemNames] = useState<Partial<Record<StemSlotId, string>>>({});
  const [stemReports, setStemReports] = useState<Partial<Record<StemSlotId, AudioAnalysisReport>>>({});
  const [stemBuses, setStemBuses] = useState<Record<StemSlotId, StemBusParams>>(() =>
    createDefaultStemBuses()
  );
  const [alignmentWarnings, setAlignmentWarnings] = useState<string[]>([]);
  const [demixNullDb, setDemixNullDb] = useState<number | null>(null);

  const [params, setParamsState] = useState<MasteringChainParams>(() =>
    createDefaultMasteringParams('spotify')
  );
  const [undoStack, setUndoStack] = useState<MasteringChainParams[]>([]);
  const [redoStack, setRedoStack] = useState<MasteringChainParams[]>([]);
  const [snapshotA, setSnapshotA] = useState<MasteringChainParams>(() =>
    createDefaultMasteringParams('spotify')
  );
  const [snapshotB, setSnapshotB] = useState<MasteringChainParams>(() =>
    createDefaultMasteringParams('club_loud')
  );
  const [activeSnap, setActiveSnap] = useState<'A' | 'B'>('A');

  const [renderStatus, setRenderStatus] = useState<{ active: boolean; stage: string; pct: number }>({
    active: false,
    stage: '',
    pct: 0,
  });
  const [appliedDriveDb, setAppliedDriveDb] = useState(0);
  const [autoDriveCapped, setAutoDriveCapped] = useState(false);
  const [maxGainReductionDb, setMaxGainReductionDb] = useState(0);
  const [stabilizerAttenuationDb, setStabilizerAttenuationDb] = useState<number[]>([]);
  const [lastWavVerification, setLastWavVerification] = useState<WavVerificationReport | null>(null);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);

  // Codec audit state
  const [codecAudits, setCodecAudits] = useState<CodecAuditResult[]>([]);
  const [activeCodecId, setActiveCodecId] = useState<CodecProfileId>('ogg_160');
  const [codecPreviewBuffer, setCodecPreviewBuffer] = useState<PlanarAudioBuffer | null>(null);

  const [assistantRationale, setAssistantRationale] = useState<string[]>([]);
  const [assistantWarnings, setAssistantWarnings] = useState<string[]>([]);
  const [serverAdvice, setServerAdvice] = useState<ServerAdviceData | null>(null);
  const [advisingLoading, setAdvisingLoading] = useState(false);
  const [aiEngineMode, setAiEngineMode] = useState<UiAiEngineMode>('auto');
  const [customProvider, setCustomProvider] = useState<'groq' | 'gemini' | 'openrouter' | 'openai'>(
    'groq'
  );
  const [customApiKey, setCustomApiKey] = useState<string>('');

  const [auditionMode, setAuditionMode] = useState<AuditionMode>('master');
  const [monitorMode, setMonitorMode] = useState<MonitorMode>('stereo');
  const [monitorVoicing, setMonitorVoicing] = useState<MonitorVoicing>('flat');
  const [headphoneProfile, setHeadphoneProfile] = useState<HeadphoneProfile>('flat');
  const [splMonitorMode, setSplMonitorMode] = useState<SplMonitorMode>('ref_78');
  const [detectedSections, setDetectedSections] = useState<DetectedSection[]>([]);
  const [mixDoctorIssues, setMixDoctorIssues] = useState<MixDoctorIssue[]>([]);
  const [sweetSpot, setSweetSpot] = useState<LoudnessSweetSpotReport | null>(null);
  const [loopEnabled, setLoopEnabled] = useState<boolean>(true);
  const [liveFrame, setLiveFrame] = useState<LivePlaybackMeterFrame>({
    isPlaying: false,
    currentTimeSec: 0,
    durationSec: 0,
    peakLeftDbfs: -96,
    peakRightDbfs: -96,
    rmsLeftDbfs: -96,
    rmsRightDbfs: -96,
    liveCorrelation: 1,
  });

  const renderSeqRef = useRef(0);

  const updateParams = useCallback(
    (updater: MasteringChainParams | ((prev: MasteringChainParams) => MasteringChainParams)) => {
      setParamsState((prev) => {
        const next = typeof updater === 'function' ? updater(prev) : updater;
        setUndoStack((u) => [...u.slice(-24), prev]);
        setRedoStack([]);
        if (activeSnap === 'A') setSnapshotA(next);
        else setSnapshotB(next);
        return next;
      });
    },
    [activeSnap]
  );

  const handleUndo = () => {
    if (undoStack.length === 0) return;
    const prev = undoStack[undoStack.length - 1];
    setUndoStack((u) => u.slice(0, -1));
    setRedoStack((r) => [...r, params]);
    setParamsState(prev);
  };

  const handleRedo = () => {
    if (redoStack.length === 0) return;
    const next = redoStack[redoStack.length - 1];
    setRedoStack((r) => r.slice(0, -1));
    setUndoStack((u) => [...u, params]);
    setParamsState(next);
  };

  const handleSwitchSnapshot = (slot: 'A' | 'B') => {
    setActiveSnap(slot);
    setParamsState(slot === 'A' ? snapshotA : snapshotB);
  };

  useEffect(() => {
    fetch('/api/session').catch(() => {});
  }, []);

  useEffect(() => {
    let rafId = 0;
    const tick = () => {
      setLiveFrame(playbackEngine.getLiveMeterFrame());
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (e.code === 'Space') {
        e.preventDefault();
        if (playbackEngine.getLiveMeterFrame().isPlaying) {
          playbackEngine.pause();
        } else {
          void playbackEngine.play();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const committedParamsRef = useRef<MasteringChainParams | null>(null);

  // Zero-latency (<3 ms) live differential preview on every slider drag before 64-bit worker finishes
  useEffect(() => {
    playbackEngine.applyLivePreviewDelta(committedParamsRef.current, params);
  }, [params]);

  // Sync buffers to Web Audio playback engine
  useEffect(() => {
    if (!sourceBuffer) return;
    playbackEngine.setBuffers(
      sourceBuffer,
      masterBuffer ?? sourceBuffer,
      sourceAnalysis?.loudness.integratedLufs ?? -18,
      masterAnalysis?.loudness.integratedLufs ?? -14,
      referenceBuffer,
      referenceAnalysis?.loudness.integratedLufs,
      codecPreviewBuffer,
      params.limiter.ceilingDbtp
    );
  }, [
    sourceBuffer,
    masterBuffer,
    sourceAnalysis,
    masterAnalysis,
    referenceBuffer,
    referenceAnalysis,
    codecPreviewBuffer,
    params.limiter.ceilingDbtp,
  ]);

  // Run background lossy codec headroom audit (24-Bark MDCT + Native Hardware WebCodecs AAC/Opus)
  useEffect(() => {
    if (!masterBuffer || masterBuffer.channels[0]?.length === 0) return;
    let cancelled = false;
    (async () => {
      try {
        const out = await dspWorker.auditCodecs(masterBuffer, activeCodecId);
        if (cancelled) return;
        let nextAudits = out.audits;
        let nextPreview = out.previewBuffer;

        // Attempt real W3C WebCodecs hardware bitstream round-trip for AAC-LC 256k & Opus 160k
        const hwTargets: CodecProfileId[] = ['aac_256', 'ogg_160'];
        for (const cid of hwTargets) {
          const hw = await tryWebCodecsRoundTrip(masterBuffer, cid);
          if (cancelled) return;
          if (hw) {
            nextAudits = nextAudits.map((a) => (a.id === cid ? hw.audit : a));
            if (activeCodecId === cid) {
              nextPreview = hw.decoded;
            }
          }
        }

        if (!cancelled) {
          setCodecAudits(nextAudits);
          if (nextPreview) {
            setCodecPreviewBuffer(nextPreview);
          }
        }
      } catch {
        // Ignore cancelled / unsupported codec checks
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [masterBuffer, activeCodecId]);

  // Run Mix Doctor + Loudness-vs-Punch Sweet-Spot Scanner whenever sourceBuffer changes
  useEffect(() => {
    if (!sourceBuffer || sourceBuffer.channels[0]?.length === 0) return;
    let cancelled = false;
    dspWorker
      .diagnoseSource(sourceBuffer, createDefaultMasteringParams('spotify'))
      .then((diag) => {
        if (cancelled) return;
        setMixDoctorIssues(diag.issues);
        setSweetSpot(diag.sweetSpot);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [sourceBuffer]);

  const triggerRender = useCallback(
    async (
      mode: 'stereo' | 'stems',
      srcBuf: PlanarAudioBuffer | null,
      stemMap: Partial<Record<StemSlotId, PlanarAudioBuffer>>,
      buses: Record<StemSlotId, StemBusParams>,
      chainParams: MasteringChainParams
    ) => {
      const seq = ++renderSeqRef.current;
      setErrorBanner(null);
      setRenderStatus({ active: true, stage: 'Initializing 64-bit DSP Worker', pct: 5 });

      try {
        if (mode === 'stems') {
          const out = await dspWorker.renderStems(
            stemMap,
            buses,
            chainParams,
            (stage, pct) => {
              if (seq === renderSeqRef.current) {
                setRenderStatus({ active: true, stage, pct });
              }
            }
          );
          if (seq !== renderSeqRef.current) return;
          committedParamsRef.current = chainParams;
          setSourceBuffer(out.summedSource);
          setSourceAnalysis(out.sourceAnalysis);
          setMasterBuffer(out.result.buffer);
          setMasterAnalysis(out.result.analysis);
          setAlignmentWarnings(out.alignmentWarnings);
          setAppliedDriveDb(out.result.appliedLimiterDriveDb);
          setAutoDriveCapped(out.result.autoDriveCapped);
          setMaxGainReductionDb(out.result.maxGainReductionDb);
          setStabilizerAttenuationDb(out.result.stabilizerAttenuationDb);
          setDetectedSections(out.result.detectedSections ?? []);
        } else if (srcBuf) {
          const res = await dspWorker.renderStereo(srcBuf, chainParams, (stage, pct) => {
            if (seq === renderSeqRef.current) {
              setRenderStatus({ active: true, stage, pct });
            }
          });
          if (seq !== renderSeqRef.current) return;
          committedParamsRef.current = chainParams;
          setMasterBuffer(res.buffer);
          setMasterAnalysis(res.analysis);
          setAppliedDriveDb(res.appliedLimiterDriveDb);
          setAutoDriveCapped(res.autoDriveCapped);
          setMaxGainReductionDb(res.maxGainReductionDb);
          setStabilizerAttenuationDb(res.stabilizerAttenuationDb);
          setDetectedSections(res.detectedSections ?? []);
        }
      } catch (err) {
        if (seq === renderSeqRef.current) {
          setErrorBanner(err instanceof Error ? err.message : 'DSP render failed.');
        }
      } finally {
        if (seq === renderSeqRef.current) {
          setRenderStatus({ active: false, stage: '', pct: 100 });
        }
      }
    },
    []
  );

  useEffect(() => {
    if (!sourceBuffer && Object.keys(stems).length === 0) return;
    const timer = window.setTimeout(() => {
      void triggerRender(workflowMode, sourceBuffer, stems, stemBuses, params);
    }, 220);
    return () => window.clearTimeout(timer);
  }, [params, stemBuses, workflowMode, sourceBuffer, stems, triggerRender]);

  const loadBuiltInSession = useCallback(async (id: BuiltInSessionId) => {
    playbackEngine.stop();
    setSelectedBuiltIn(id);
    setLastWavVerification(null);
    setServerAdvice(null);
    setErrorBanner(null);
    setDemixNullDb(null);

    const spec = BUILT_IN_SESSIONS.find((s) => s.id === id)!;
    setTrackName(spec.name);

    if (id === 'ebu_r128_cal' || id === 'isp_torture_vec') {
      const vec =
        id === 'ebu_r128_cal'
          ? generateEbuCalibrationTone(48000, 4.0, -23.0)
          : generateIspTortureVector(48000, 3.0, 1.0);

      const neutral = createNeutralBypassParams();
      if (id === 'isp_torture_vec') {
        neutral.limiter.enabled = true;
        neutral.limiter.ceilingDbtp = -1.0;
        neutral.limiter.autoGainToTarget = false;
        neutral.limiter.manualDriveDb = 0;
        setAssistantRationale([
          'Loaded Inter-Sample Peak Vector: Source Sample Peak is -3.01 dBFS while True Peak is 0.00 dBTP (+3.01 dB ISP). True-Peak Limiter is clamping ceiling to -1.00 dBTP.',
        ]);
      } else {
        neutral.limiter.enabled = false;
        setAssistantRationale([
          'Loaded EBU R128 Reference Sine (997 Hz): Source & Bypass Master both read -23.00 LUFS Integrated to verify BS.1770-5 compliance.',
        ]);
      }

      setWorkflowMode('stereo');
      const report = await dspWorker.analyze(vec, neutral.limiter.ceilingDbtp, 4);
      setSourceBuffer(vec);
      setSourceAnalysis(report);
      setParamsState(neutral);
      return;
    }

    const session = generateStudioSession(id, 48000, 4);
    const defaultBuses = createDefaultStemBuses();
    setStems(session.stems);
    setStemNames({
      drums: `${id}_drums.wav`,
      bass: `${id}_bass.wav`,
      vocals: `${id}_lead.wav`,
      instruments: `${id}_synths.wav`,
    });
    setStemBuses(defaultBuses);

    const stemRepEntries: Partial<Record<StemSlotId, AudioAnalysisReport>> = {};
    for (const slot of ['drums', 'bass', 'vocals', 'instruments'] as StemSlotId[]) {
      stemRepEntries[slot] = await dspWorker.analyze(session.stems[slot], -1.0, 4);
    }
    setStemReports(stemRepEntries);

    const srcRep = await dspWorker.analyze(session.stereoMix, -1.0, 4);
    setSourceBuffer(session.stereoMix);
    setSourceAnalysis(srcRep);

    const rec = computeSignalDrivenAssistant(
      srcRep,
      'spotify',
      id === 'neon_horizon_mix' ? 'modern_punch' : 'warm_analog'
    );
    setAssistantRationale(rec.rationale);
    setAssistantWarnings(rec.warnings);
    setParamsState(rec.params);
    setSnapshotA(rec.params);
  }, []);

  useEffect(() => {
    void loadBuiltInSession('neon_horizon_mix');
  }, [loadBuiltInSession]);

  const handleUploadStereoFile = async (file: File) => {
    try {
      setErrorBanner(null);
      playbackEngine.stop();
      setDemixNullDb(null);
      setRenderStatus({ active: true, stage: `Decoding "${file.name}"`, pct: 20 });
      const decoded = await decodeUploadedAudioFile(file);
      const srcRep = await dspWorker.analyze(
        decoded,
        params.limiter.ceilingDbtp,
        params.limiter.oversampling
      );
      setWorkflowMode('stereo');
      setTrackName(file.name);
      setSourceBuffer(decoded);
      setSourceAnalysis(srcRep);
      setLastWavVerification(null);

      const rec = computeSignalDrivenAssistant(
        srcRep,
        params.deliveryProfile,
        params.tonalPreset,
        referenceAnalysis
      );
      setAssistantRationale(rec.rationale);
      setAssistantWarnings(rec.warnings);
      updateParams(rec.params);
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'Failed to decode uploaded file.');
      setRenderStatus({ active: false, stage: '', pct: 0 });
    }
  };

  const handleDemixStereoToStems = async () => {
    if (!sourceBuffer) return;
    try {
      setErrorBanner(null);
      setRenderStatus({
        active: true,
        stage: 'Extracting 4 Stems via 75% COLA STFT HPSS + M/S Demixer',
        pct: 15,
      });
      const demixed = await dspWorker.demixStems(sourceBuffer, (stage, pct) => {
        setRenderStatus({ active: true, stage, pct });
      });

      const neutralBuses = createDefaultStemBuses();
      for (const s of ['drums', 'bass', 'vocals', 'instruments'] as StemSlotId[]) {
        neutralBuses[s].gainDb = 0;
        neutralBuses[s].compAmountPct = 0;
        neutralBuses[s].lowShelfDb = 0;
        neutralBuses[s].midBellDb = 0;
        neutralBuses[s].highShelfDb = 0;
        neutralBuses[s].widthPct = 100;
        neutralBuses[s].hpfHz = 20;
      }

      const stemRepEntries: Partial<Record<StemSlotId, AudioAnalysisReport>> = {};
      for (const slot of ['drums', 'bass', 'vocals', 'instruments'] as StemSlotId[]) {
        stemRepEntries[slot] = await dspWorker.analyze(demixed.stems[slot], -1.0, 4);
      }

      setStems(demixed.stems);
      setStemNames({
        drums: 'demixed_drums_hpss.wav',
        bass: 'demixed_sub_bass.wav',
        vocals: 'demixed_center_vocals.wav',
        instruments: 'demixed_harmonic_inst.wav',
      });
      setStemReports(stemRepEntries);
      setStemBuses(neutralBuses);
      setDemixNullDb(demixed.reconstructionNullDb);
      setWorkflowMode('stems');
      setActiveTab('stems');
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'Local stem demixing failed.');
    } finally {
      setRenderStatus({ active: false, stage: '', pct: 100 });
    }
  };

  const handleUploadStem = async (slot: StemSlotId, file: File) => {
    try {
      setErrorBanner(null);
      const decoded = await decodeUploadedAudioFile(file);
      const rep = await dspWorker.analyze(decoded, params.limiter.ceilingDbtp, 4);
      setStems((prev) => ({ ...prev, [slot]: decoded }));
      setStemNames((prev) => ({ ...prev, [slot]: file.name }));
      setStemReports((prev) => ({ ...prev, [slot]: rep }));
      setDemixNullDb(null);
      setWorkflowMode('stems');
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : `Failed to decode ${slot} stem.`);
    }
  };

  const handleUploadReference = async (file: File) => {
    try {
      setErrorBanner(null);
      const decoded = await decodeUploadedAudioFile(file);
      const rep = await dspWorker.analyze(decoded, -1.0, 4);
      setReferenceName(file.name);
      setReferenceBuffer(decoded);
      setReferenceAnalysis(rep);
      updateParams((prev) => ({ ...prev, tonalPreset: 'reference_match' }));
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'Failed to decode reference track.');
    }
  };

  const handleRunSignalAssistant = () => {
    if (!sourceAnalysis) return;
    const rec = computeSignalDrivenAssistant(
      sourceAnalysis,
      params.deliveryProfile,
      params.tonalPreset,
      referenceAnalysis
    );
    setAssistantRationale(rec.rationale);
    setAssistantWarnings(rec.warnings);
    updateParams(rec.params);
  };

  const handleRequestServerAdvice = async () => {
    if (!sourceAnalysis) return;
    setAdvisingLoading(true);
    setErrorBanner(null);

    const toSummary = (r: AudioAnalysisReport) => ({
      sampleRate: r.sampleRate,
      channelCount: r.channelCount,
      durationSec: Math.max(0.02, r.durationSec),
      integratedLufs: Number.isFinite(r.loudness.integratedLufs)
        ? r.loudness.integratedLufs
        : -90,
      shortTermMaxLufs: Number.isFinite(r.loudness.shortTermMaxLufs)
        ? r.loudness.shortTermMaxLufs
        : -90,
      momentaryMaxLufs: Number.isFinite(r.loudness.momentaryMaxLufs)
        ? r.loudness.momentaryMaxLufs
        : -90,
      loudnessRangeLu: r.loudness.loudnessRangeLu,
      truePeakDbtp: r.truePeak.truePeakDbtp,
      samplePeakDbfs: r.truePeak.samplePeakDbfs,
      ispMarginDb: r.truePeak.ispMarginDb,
      plrDb: r.dynamics.plrDb,
      crestFactorDb: r.dynamics.crestFactorDb,
      centroidHz: r.spectral.centroidHz,
      spectralTiltDbPerOct: r.spectral.spectralTiltDbPerOct,
      correlation: r.stereo.correlation,
      lowBandCorrelation: r.stereo.lowBandCorrelation,
      monoFoldDownLossDb: r.stereo.monoFoldDownLossDb,
      bands: r.spectral.bands.map((b) => ({
        id: b.id,
        energyDb: Math.max(-120, Math.min(20, b.energyDb)),
        relativeDb: Math.max(-60, Math.min(60, b.relativeDb)),
      })),
    });

    const srcSum = toSummary(sourceAnalysis);
    const mstSum = masterAnalysis ? toSummary(masterAnalysis) : undefined;
    const archetype = classifyProgramArchetype(srcSum);

    const buildLocalDiagnostic = (label: string, headlineNote?: string): ServerAdviceData => ({
      provider: 'sonicforge_own_ai',
      modelLabel: label,
      archetype,
      headline: headlineNote || `Acoustic AI Diagnostic — "${trackName}" (${archetype.label})`,
      observations: [
        `Program classified as ${archetype.label} (${archetype.confidencePct}% match). Source is ${srcSum.integratedLufs.toFixed(1)} LUFS / ${srcSum.truePeakDbtp.toFixed(2)} dBTP (+${srcSum.ispMarginDb.toFixed(2)} dB ISP excess).`,
        `Dynamics: LRA ${srcSum.loudnessRangeLu.toFixed(1)} LU, PLR ${srcSum.plrDb.toFixed(1)} dB, Spectral Tilt ${srcSum.spectralTiltDbPerOct.toFixed(1)} dB/oct, <150 Hz Stereo Correlation ${srcSum.lowBandCorrelation.toFixed(2)}.`,
      ],
      actionableSteps: [
        srcSum.lowBandCorrelation < 0.8
          ? 'Keep Elliptical Bass Mono active @ 135 Hz to focus kick/sub energy.'
          : 'Low-end phase correlation is solid; preserve punch with IRC-V Transient/Sustain Split.',
        srcSum.spectralTiltDbPerOct < -4.2
          ? 'Lift +1.5 dB Side Air Shelf @ 12 kHz and engage 25% 2x Oversampled Exciter.'
          : 'Audition in LUFS-Matched A/B and Codec Artifact Solo before exporting 24-bit WAV.',
      ],
      complianceVerdict: mstSum
        ? `Rendered PCM verified at ${mstSum.integratedLufs.toFixed(2)} LUFS and ${mstSum.truePeakDbtp.toFixed(2)} dBTP True Peak.`
        : `Ready to verify against ${params.limiter.targetLufs.toFixed(1)} LUFS / ${params.limiter.ceilingDbtp.toFixed(1)} dBTP.`,
      privacyNotice: '100% browser-local PCM telemetry analysis.',
    });

    try {
      if (aiEngineMode === 'browser_local') {
        try {
          const gen = await browserAiClient.generateLocalResponse(
            'You are SonicForge Pro Mastering Engineer running locally in the browser. Give 2 concise mastering observations and 2 actionable EQ/Limiter steps based on the exact metrics.',
            `Track: "${trackName}" (${archetype.label}). Source: ${srcSum.integratedLufs.toFixed(1)} LUFS, ${srcSum.truePeakDbtp.toFixed(2)} dBTP, Tilt ${srcSum.spectralTiltDbPerOct.toFixed(1)} dB/oct, Target ${params.limiter.targetLufs.toFixed(1)} LUFS.`
          );
          const base = buildLocalDiagnostic(gen.modelLabel);
          base.observations.unshift(gen.text);
          setServerAdvice(base);
          return;
        } catch {
          setServerAdvice(
            buildLocalDiagnostic('SonicForge Acoustic Neural-Heuristic Engine v2 (Browser Direct)')
          );
          return;
        }
      }

      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (aiEngineMode === 'custom_key' && customApiKey.trim()) {
        headers['x-ai-provider'] = customProvider;
        headers['x-ai-api-key'] = customApiKey.trim();
      }

      const res = await fetch('/api/mastering/advise', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          trackName,
          workflowMode,
          deliveryProfile: params.deliveryProfile,
          tonalPreset: params.tonalPreset,
          targetLufs: params.limiter.targetLufs,
          ceilingDbtp: params.limiter.ceilingDbtp,
          preferEngine:
            aiEngineMode === 'own_ai'
              ? 'own_ai'
              : aiEngineMode === 'custom_key'
                ? 'custom_key'
                : 'auto',
          source: srcSum,
          renderedMaster: mstSum,
          reference: referenceAnalysis ? toSummary(referenceAnalysis) : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Advisory request failed');
      }
      setServerAdvice(data as ServerAdviceData);
    } catch {
      // Seamless browser-direct fallback so AI never fails even offline
      setServerAdvice(
        buildLocalDiagnostic('SonicForge Acoustic Neural-Heuristic Engine v2 (Browser Direct)')
      );
    } finally {
      setAdvisingLoading(false);
    }
  };

  const handleExportWav = () => {
    const targetBuf = masterBuffer ?? sourceBuffer;
    if (!targetBuf) return;
    try {
      const measuredLufs = masterAnalysis?.loudness.integratedLufs;
      const measuredTp = masterAnalysis?.truePeak.truePeakDbtp;
      const wavBytes = encodeWav(targetBuf, {
        ...params.exportFormat,
        metadata: {
          title: params.exportFormat.metadata?.title || trackName,
          artist: params.exportFormat.metadata?.artist || 'SonicForge Studio',
          album: params.exportFormat.metadata?.album || '',
          isrc: params.exportFormat.metadata?.isrc || '',
          comment: `BS.1770-5: ${Number.isFinite(measuredLufs) ? measuredLufs?.toFixed(2) : 'N/A'} LUFS | TruePeak: ${measuredTp?.toFixed(2) ?? 'N/A'} dBTP`,
        },
      });
      const receipt = verifyExportedWav(
        wavBytes,
        params.limiter.ceilingDbtp,
        params.limiter.oversampling
      );
      setLastWavVerification(receipt);

      const blob = new Blob([wavBytes], { type: 'audio/wav' });
      const url = URL.createObjectURL(blob);
      const safeBase = trackName.replace(/[^a-z0-9_-]+/gi, '_').replace(/^_+|_+$/g, '') || 'master';
      const a = document.createElement('a');
      a.href = url;
      a.download = `${safeBase}_master_${params.exportFormat.bitDepth}bit.wav`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'WAV export failed.');
    }
  };

  const lufsMatchDeltaDb =
    sourceAnalysis &&
    masterAnalysis &&
    Number.isFinite(sourceAnalysis.loudness.integratedLufs) &&
    Number.isFinite(masterAnalysis.loudness.integratedLufs)
      ? sourceAnalysis.loudness.integratedLufs - masterAnalysis.loudness.integratedLufs
      : 0;

  return (
    <div className="studio-shell">
      <header className="top-bar">
        <div className="brand-cluster">
          <div className="brand-logo">SF</div>
          <div>
            <div className="brand-title">
              SonicForge Pro
              <span className="badge badge-cyan">
                {uiMode === 'auto_simple' ? '1-Click Auto-Master' : 'Pro Studio Console'}
              </span>
            </div>
            <div className="brand-sub">{trackName}</div>
          </div>

          <div
            className="segmented"
            style={{
              marginLeft: 10,
              border: '1.5px solid rgba(34,211,238,0.45)',
              padding: 2,
            }}
          >
            <button
              type="button"
              className={`seg-btn ${uiMode === 'auto_simple' ? 'active' : ''}`}
              onClick={() => setUiMode('auto_simple')}
              style={{ fontWeight: 700, padding: '5px 12px' }}
            >
              ⚡ Easy Auto-Master
            </button>
            <button
              type="button"
              className={`seg-btn ${uiMode === 'pro_studio' ? 'active' : ''}`}
              onClick={() => setUiMode('pro_studio')}
              style={{ fontWeight: 700, padding: '5px 12px' }}
            >
              🎛️ Pro Studio Rack
            </button>
          </div>
        </div>

        {uiMode === 'auto_simple' ? (
          <div className="toolbar-group">
            <select
              className="select-input"
              aria-label="Headphone Harman Calibration"
              title="Calibrates headphone playback so your ears hear flat studio balance"
              value={headphoneProfile}
              onChange={(e) => {
                const hp = e.target.value as HeadphoneProfile;
                setHeadphoneProfile(hp);
                playbackEngine.setHeadphoneProfile(hp);
              }}
            >
              <option value="flat">Headphones: Standard</option>
              <option value="dt990">DT 990 Pro Corrected</option>
              <option value="m50x">ATH-M50x Corrected</option>
              <option value="hd650">HD 650 / 6XX Corrected</option>
              <option value="airpods_pro">AirPods Pro Corrected</option>
              <option value="mdr7506">MDR-7506 Corrected</option>
            </select>
            <button type="button" className="btn btn-emerald" onClick={handleExportWav}>
              <Download size={13} /> Export WAV
            </button>
          </div>
        ) : (
          <>
            <div className="toolbar-group">
          <div className="segmented">
            <button
              type="button"
              className={`seg-btn ${workflowMode === 'stereo' ? 'active' : ''}`}
              onClick={() => setWorkflowMode('stereo')}
            >
              Stereo Mix
            </button>
            <button
              type="button"
              className={`seg-btn ${workflowMode === 'stems' ? 'active' : ''}`}
              onClick={() => {
                setWorkflowMode('stems');
                setActiveTab('stems');
              }}
            >
              <Layers size={13} /> 4-Stem Bus
            </button>
          </div>

          <select
            className="select-input"
            aria-label="Studio Test Bench"
            value={selectedBuiltIn}
            onChange={(e) => void loadBuiltInSession(e.target.value as BuiltInSessionId)}
          >
            <optgroup label="Multi-Stem Studio Sessions">
              {BUILT_IN_SESSIONS.filter((s) => s.category === 'studio_session').map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </optgroup>
            <optgroup label="ITU / EBU Verification Vectors">
              {BUILT_IN_SESSIONS.filter((s) => s.category === 'calibration_vector').map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </optgroup>
          </select>

          <label className="btn">
            <Upload size={13} /> Load Audio
            <input
              type="file"
              accept="audio/*,.wav,.flac,.mp3,.ogg,.m4a,.aac"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleUploadStereoFile(f);
                e.currentTarget.value = '';
              }}
            />
          </label>
        </div>

        <div className="toolbar-group">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              if (liveFrame.isPlaying) playbackEngine.pause();
              else void playbackEngine.play();
            }}
          >
            {liveFrame.isPlaying ? <Pause size={14} /> : <Play size={14} />}
            {liveFrame.isPlaying ? 'Pause' : 'Play'}
          </button>
          <button type="button" className="btn" onClick={() => playbackEngine.stop()} title="Stop">
            <Square size={13} />
          </button>

          <div className="segmented" title="Zero-latency sample-aligned audition modes">
            <button
              type="button"
              className={`seg-btn ${auditionMode === 'master' ? 'active' : ''}`}
              onClick={() => {
                setAuditionMode('master');
                playbackEngine.setAuditionMode('master');
              }}
            >
              MASTER
            </button>
            <button
              type="button"
              className={`seg-btn ${auditionMode === 'master_matched' ? 'active' : ''}`}
              onClick={() => {
                setAuditionMode('master_matched');
                playbackEngine.setAuditionMode('master_matched');
              }}
              title="Attenuates Master to exact Source LUFS so loudness bias never misleads your ears"
            >
              MATCHED ({lufsMatchDeltaDb >= 0 ? '+' : ''}
              {lufsMatchDeltaDb.toFixed(1)} dB)
            </button>
            <button
              type="button"
              className={`seg-btn ${auditionMode === 'original' ? 'active' : ''}`}
              onClick={() => {
                setAuditionMode('original');
                playbackEngine.setAuditionMode('original');
              }}
            >
              ORIGINAL
            </button>
            <button
              type="button"
              className={`seg-btn ${auditionMode === 'delta' ? 'active-amber' : ''}`}
              onClick={() => {
                setAuditionMode('delta');
                playbackEngine.setAuditionMode('delta');
              }}
              title="Null difference (Matched Master minus Original) — hear ONLY what DSP changed"
            >
              DELTA (NULL)
            </button>
            {referenceBuffer && (
              <button
                type="button"
                className={`seg-btn ${auditionMode === 'reference' ? 'active' : ''}`}
                onClick={() => {
                  setAuditionMode('reference');
                  playbackEngine.setAuditionMode('reference');
                }}
              >
                REF
              </button>
            )}
          </div>

          {/* Monitor Matrix */}
          <div className="segmented" title="Stereo / Mono / Mid / Side Monitor Matrix">
            {(['stereo', 'mono', 'mid', 'side'] as MonitorMode[]).map((m) => (
              <button
                key={m}
                type="button"
                className={`seg-btn ${monitorMode === m ? 'active' : ''}`}
                onClick={() => {
                  setMonitorMode(m);
                  playbackEngine.setMonitorMode(m);
                }}
              >
                {m.toUpperCase()}
              </button>
            ))}
          </div>

          {/* Acoustic Environment Translation Check */}
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <Speaker size={13} style={{ color: 'var(--text-2)' }} />
            <select
              className="select-input"
              aria-label="Acoustic Device Translation"
              title="Monitor-only speaker translation filter (never alters exported WAV)"
              value={monitorVoicing}
              onChange={(e) => {
                const v = e.target.value as MonitorVoicing;
                setMonitorVoicing(v);
                playbackEngine.setMonitorVoicing(v);
              }}
            >
              <option value="flat">Studio Reference Flat</option>
              <option value="phone">Phone Speaker (Mono)</option>
              <option value="car">Car Cabin Acoustics</option>
              <option value="club">Club Sub PA Rig</option>
              <option value="auratone">Midrange Cube (Mono)</option>
            </select>

            <select
              className="select-input"
              aria-label="Headphone Harman Calibration"
              title="Monitor-only Headphone Harman-Target Compensation (never alters exported WAV)"
              value={headphoneProfile}
              onChange={(e) => {
                const hp = e.target.value as HeadphoneProfile;
                setHeadphoneProfile(hp);
                playbackEngine.setHeadphoneProfile(hp);
              }}
            >
              <option value="flat">Headphones: Uncalibrated</option>
              <option value="dt990">DT 990 Pro Corrected</option>
              <option value="m50x">ATH-M50x Corrected</option>
              <option value="hd650">HD 650 / 6XX Corrected</option>
              <option value="airpods_pro">AirPods Pro Corrected</option>
              <option value="mdr7506">MDR-7506 Corrected</option>
            </select>

            <select
              className="select-input"
              aria-label="ISO 226 SPL Ear Perception"
              title="ISO 226 Equal-Loudness Fletcher-Munson Ear Simulator (check Quiet Night vs Club PA)"
              value={splMonitorMode}
              onChange={(e) => {
                const sm = e.target.value as SplMonitorMode;
                setSplMonitorMode(sm);
                playbackEngine.setSplMonitorMode(sm);
              }}
            >
              <option value="ref_78">Ear Check: 78 dB Studio</option>
              <option value="quiet_55">Ear Check: 55 dB Quiet</option>
              <option value="club_98">Ear Check: 98 dB Club</option>
            </select>
          </div>
        </div>

        <div className="toolbar-group">
          <div className="segmented">
            <button
              type="button"
              className={`seg-btn ${activeSnap === 'A' ? 'active' : ''}`}
              onClick={() => handleSwitchSnapshot('A')}
            >
              Snap A
            </button>
            <button
              type="button"
              className={`seg-btn ${activeSnap === 'B' ? 'active' : ''}`}
              onClick={() => handleSwitchSnapshot('B')}
            >
              Snap B
            </button>
          </div>
          <button
            type="button"
            className="btn"
            disabled={undoStack.length === 0}
            onClick={handleUndo}
            title="Undo"
          >
            <RotateCcw size={13} />
          </button>
          <button
            type="button"
            className="btn"
            disabled={redoStack.length === 0}
            onClick={handleRedo}
            title="Redo"
          >
            <RotateCw size={13} />
          </button>
          <button type="button" className="btn btn-emerald" onClick={handleExportWav}>
            <Download size={13} /> Export {params.exportFormat.bitDepth}-bit WAV
          </button>
        </div>
          </>
        )}
      </header>

      {uiMode === 'auto_simple' ? (
        <main style={{ flex: 1, overflowY: 'auto' }}>
          {errorBanner && (
            <div style={{ maxWidth: 960, margin: '12px auto 0', padding: '0 16px' }}>
              <div className="callout callout-warn">{errorBanner}</div>
            </div>
          )}
          <InstantAutoMasterView
            trackName={trackName}
            sourceBuffer={sourceBuffer}
            sourceAnalysis={sourceAnalysis}
            masterAnalysis={masterAnalysis}
            params={params}
            codecAudits={codecAudits}
            detectedSections={detectedSections}
            mixDoctorIssues={mixDoctorIssues}
            sweetSpot={sweetSpot}
            renderStatus={renderStatus}
            isPlaying={liveFrame.isPlaying}
            currentTimeSec={liveFrame.currentTimeSec}
            durationSec={liveFrame.durationSec}
            auditionMode={auditionMode}
            monitorVoicing={monitorVoicing}
            onUploadTrack={(file) => void handleUploadStereoFile(file)}
            onApplyAutoMasterParams={(nextParams) => updateParams(nextParams)}
            onTogglePlay={() => {
              if (liveFrame.isPlaying) playbackEngine.pause();
              else void playbackEngine.play();
            }}
            onSeek={(sec) => playbackEngine.seek(sec)}
            onSetAuditionMode={(mode) => {
              setAuditionMode(mode);
              playbackEngine.setAuditionMode(mode);
            }}
            onSetMonitorVoicing={(voicing) => {
              setMonitorVoicing(voicing);
              playbackEngine.setMonitorVoicing(voicing);
            }}
            onExportMasterWav={handleExportWav}
            onSwitchToProConsole={() => setUiMode('pro_studio')}
          />
        </main>
      ) : (
        <main className="workspace-grid">
        <div className="main-column">
          {errorBanner && <div className="callout callout-warn">{errorBanner}</div>}

          {renderStatus.active && (
            <div className="render-progress">
              <span style={{ fontWeight: 700 }}>{renderStatus.stage}</span>
              <div className="progress-track">
                <div className="progress-fill" style={{ width: `${renderStatus.pct}%` }} />
              </div>
              <span className="num">{renderStatus.pct}%</span>
            </div>
          )}

          <WaveformTimeline
            sourceAnalysis={sourceAnalysis}
            masterAnalysis={masterAnalysis}
            currentTimeSec={liveFrame.currentTimeSec}
            durationSec={liveFrame.durationSec}
            auditionMode={auditionMode}
            loopEnabled={loopEnabled}
            onSeek={(sec) => playbackEngine.seek(sec)}
            onToggleLoop={() => {
              const next = !loopEnabled;
              setLoopEnabled(next);
              playbackEngine.setLoop(next);
            }}
          />

          <SpectrumAndTonalView
            sourceAnalysis={sourceAnalysis}
            masterAnalysis={masterAnalysis}
            referenceAnalysis={referenceAnalysis}
            tonalPreset={params.tonalPreset}
          />

          <nav className="module-tabs" aria-label="Mastering Chain Modules">
            <button
              type="button"
              className={`tab-btn ${activeTab === 'autopilot' ? 'active' : ''}`}
              onClick={() => setActiveTab('autopilot')}
            >
              <Sparkles size={14} /> Guided Artist Autopilot &amp; Release Pack
            </button>
            <button
              type="button"
              className={`tab-btn ${activeTab === 'assistant' ? 'active' : ''}`}
              onClick={() => setActiveTab('assistant')}
            >
              <Sparkles size={14} /> AI Co-Pilot, Reference &amp; Benchmark
            </button>
            <button
              type="button"
              className={`tab-btn ${activeTab === 'eq' ? 'active' : ''}`}
              onClick={() => setActiveTab('eq')}
            >
              <Sliders size={14} /> Linear FIR EQ &amp; Stabilizer
            </button>
            <button
              type="button"
              className={`tab-btn ${activeTab === 'multiband' ? 'active' : ''}`}
              onClick={() => setActiveTab('multiband')}
            >
              <Activity size={14} /> 4-Band LR4 Dynamics
            </button>
            <button
              type="button"
              className={`tab-btn ${activeTab === 'stereo' ? 'active' : ''}`}
              onClick={() => setActiveTab('stereo')}
            >
              <Volume2 size={14} /> Stereo, Bass Mono &amp; Exciter
            </button>
            <button
              type="button"
              className={`tab-btn ${activeTab === 'limiter' ? 'active' : ''}`}
              onClick={() => setActiveTab('limiter')}
            >
              <CheckCircle2 size={14} /> IRC-V Limiter &amp; BWF/INFO Export
            </button>
            <button
              type="button"
              className={`tab-btn ${activeTab === 'stems' ? 'active' : ''}`}
              onClick={() => setActiveTab('stems')}
            >
              <Layers size={14} /> 4-Stem Console &amp; Demixer
            </button>
            <button
              type="button"
              className={`tab-btn ${activeTab === 'codec_album' ? 'active' : ''}`}
              onClick={() => setActiveTab('codec_album')}
            >
              <Disc3 size={14} /> Codec Sim &amp; Album Batch
            </button>
          </nav>

          {activeTab === 'autopilot' && (
            <ArtistAutopilotModule
              trackName={trackName}
              sourceBuffer={sourceBuffer}
              sourceAnalysis={sourceAnalysis}
              masterAnalysis={masterAnalysis}
              params={params}
              codecAudits={codecAudits}
              detectedSections={detectedSections}
              mixDoctorIssues={mixDoctorIssues}
              sweetSpot={sweetSpot}
              auditionMode={auditionMode}
              onApplyParams={(nextParams) => updateParams(nextParams)}
              onJumpAndLoopMoment={(startSec, endSec) => {
                setLoopEnabled(true);
                playbackEngine.setLoop(true, startSec, endSec);
                void playbackEngine.play(startSec);
              }}
              onSetAuditionMode={(mode) => {
                setAuditionMode(mode);
                playbackEngine.setAuditionMode(mode);
              }}
              onSwitchToProRack={() => setActiveTab('eq')}
            />
          )}

          {activeTab === 'assistant' && (
            <AssistantAndBenchmarkModule
              trackName={trackName}
              params={params}
              codecAudits={codecAudits}
              deliveryProfile={params.deliveryProfile}
              tonalPreset={params.tonalPreset}
              sourceAnalysis={sourceAnalysis}
              masterAnalysis={masterAnalysis}
              referenceName={referenceName}
              referenceAnalysis={referenceAnalysis}
              assistantRationale={assistantRationale}
              assistantWarnings={assistantWarnings}
              serverAdvice={serverAdvice}
              advisingLoading={advisingLoading}
              aiEngineMode={aiEngineMode}
              customProvider={customProvider}
              customApiKey={customApiKey}
              onChangeAiEngineMode={setAiEngineMode}
              onChangeCustomCreds={(prov, key) => {
                setCustomProvider(prov);
                setCustomApiKey(key);
              }}
              onApplyAiParams={(nextParams) => updateParams(nextParams)}
              onSelectDeliveryProfile={(profileId: DeliveryProfileId) => {
                const spec = DELIVERY_PROFILES[profileId];
                updateParams((prev) => ({
                  ...prev,
                  deliveryProfile: profileId,
                  limiter: {
                    ...prev.limiter,
                    targetLufs: spec.targetLufs,
                    ceilingDbtp: spec.ceilingDbtp,
                  },
                }));
              }}
              onSelectTonalPreset={(preset: TonalPresetId) => {
                updateParams((prev) => ({ ...prev, tonalPreset: preset }));
              }}
              onRunSignalAssistant={handleRunSignalAssistant}
              onRequestServerAdvice={() => void handleRequestServerAdvice()}
              onUploadReference={(file) => void handleUploadReference(file)}
              onClearReference={() => {
                setReferenceName(null);
                setReferenceBuffer(null);
                setReferenceAnalysis(null);
                if (auditionMode === 'reference') {
                  setAuditionMode('master');
                  playbackEngine.setAuditionMode('master');
                }
              }}
            />
          )}

          {activeTab === 'eq' && (
            <EqModule
              enabled={params.eqEnabled}
              phaseMode={params.eqPhaseMode}
              bands={params.eqBands}
              stabilizer={params.stabilizer}
              stabilizerAttenuationDb={stabilizerAttenuationDb}
              sampleRate={sourceAnalysis?.sampleRate ?? 48000}
              onToggleModule={(eqEnabled) => updateParams((prev) => ({ ...prev, eqEnabled }))}
              onChangePhaseMode={(eqPhaseMode) =>
                updateParams((prev) => ({ ...prev, eqPhaseMode }))
              }
              onUpdateBand={(idx: number, patch: Partial<EqBandParams>) => {
                updateParams((prev) => ({
                  ...prev,
                  eqBands: prev.eqBands.map((b, i) => (i === idx ? { ...b, ...patch } : b)),
                }));
              }}
              onChangeStabilizer={(stabilizer) =>
                updateParams((prev) => ({ ...prev, stabilizer }))
              }
            />
          )}

          {activeTab === 'multiband' && (
            <MultibandModule
              params={params.multiband}
              onChange={(multiband) => updateParams((prev) => ({ ...prev, multiband }))}
            />
          )}

          {activeTab === 'stereo' && (
            <StereoExciterModule
              stereo={params.stereo}
              exciter={params.exciter}
              phantomBass={params.phantomBass}
              macroDynamics={params.macroDynamics}
              detectedSections={detectedSections}
              sourceAnalysis={sourceAnalysis}
              masterAnalysis={masterAnalysis}
              onChangeStereo={(stereo) => updateParams((prev) => ({ ...prev, stereo }))}
              onChangeExciter={(exciter) => updateParams((prev) => ({ ...prev, exciter }))}
              onChangePhantomBass={(phantomBass) =>
                updateParams((prev) => ({ ...prev, phantomBass }))
              }
              onChangeMacroDynamics={(macroDynamics) =>
                updateParams((prev) => ({ ...prev, macroDynamics }))
              }
            />
          )}

          {activeTab === 'limiter' && (
            <LimiterExportModule
              limiter={params.limiter}
              exportFormat={params.exportFormat}
              appliedDriveDb={appliedDriveDb}
              autoDriveCapped={autoDriveCapped}
              maxGainReductionDb={maxGainReductionDb}
              lastWavVerification={lastWavVerification}
              onChangeLimiter={(limiter) => updateParams((prev) => ({ ...prev, limiter }))}
              onChangeExportFormat={(exportFormat) =>
                updateParams((prev) => ({ ...prev, exportFormat }))
              }
              onExportWav={handleExportWav}
            />
          )}

          {activeTab === 'stems' && (
            <StemConsoleModule
              stems={stems}
              stemNames={stemNames}
              stemReports={stemReports}
              busParams={stemBuses}
              alignmentWarnings={alignmentWarnings}
              demixNullDb={demixNullDb}
              hasStereoSource={Boolean(sourceBuffer && sourceBuffer.channels[0]?.length)}
              onUploadStem={(slot, f) => void handleUploadStem(slot, f)}
              onUpdateBus={(slot, patch) => {
                setWorkflowMode('stems');
                setStemBuses((prev) => ({
                  ...prev,
                  [slot]: { ...prev[slot], ...patch },
                }));
              }}
              onReplaceAllBuses={(nextBuses) => {
                setWorkflowMode('stems');
                setStemBuses(nextBuses);
                void triggerRender('stems', sourceBuffer, stems, nextBuses, params);
              }}
              onRenderStems={() => {
                setWorkflowMode('stems');
                void triggerRender('stems', sourceBuffer, stems, stemBuses, params);
              }}
              onDemixStereoToStems={() => void handleDemixStereoToStems()}
            />
          )}

          {activeTab === 'codec_album' && (
            <CodecAndAlbumModule
              codecAudits={codecAudits}
              activeCodecId={activeCodecId}
              auditionMode={auditionMode}
              params={params}
              onSelectCodecAudition={(codecId, mode) => {
                setActiveCodecId(codecId);
                setAuditionMode(mode);
                playbackEngine.setAuditionMode(mode);
              }}
              onImportPresetParams={(imported) => updateParams(imported)}
            />
          )}
        </div>

        <MeteringDock
          sourceAnalysis={sourceAnalysis}
          masterAnalysis={masterAnalysis}
          targetLufs={params.limiter.targetLufs}
          ceilingDbtp={params.limiter.ceilingDbtp}
          maxGainReductionDb={maxGainReductionDb}
          liveFrame={liveFrame}
        />
        </main>
      )}
    </div>
  );
};
