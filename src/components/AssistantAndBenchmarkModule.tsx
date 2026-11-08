import React, { useState } from 'react';
import { browserAiClient } from '../audio/browserAiClient';
import { simulateStreamingNormalization } from '../dsp/assistant';
import {
  type ArchetypeClassification,
  type CopilotPatchItem,
  type SignalSummaryInput,
  solveNaturalLanguageMasteringCopilot,
} from '../dsp/ownAiEngine';
import { DELIVERY_PROFILES } from '../dsp/profiles';
import type {
  AudioAnalysisReport,
  CodecAuditResult,
  DeliveryProfileId,
  MasteringChainParams,
  TonalPresetId,
} from '../dsp/types';

export type UiAiEngineMode = 'auto' | 'browser_local' | 'own_ai' | 'custom_key';

export interface ServerAdviceData {
  provider: string;
  modelLabel?: string;
  archetype?: ArchetypeClassification;
  headline: string;
  observations: string[];
  actionableSteps: string[];
  complianceVerdict: string;
  privacyNotice: string;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  modelLabel?: string;
  archetype?: ArchetypeClassification;
  patchItems?: CopilotPatchItem[];
  updatedParams?: MasteringChainParams | null;
  applied?: boolean;
}

interface Props {
  trackName: string;
  params: MasteringChainParams;
  codecAudits: CodecAuditResult[];
  deliveryProfile: DeliveryProfileId;
  tonalPreset: TonalPresetId;
  sourceAnalysis: AudioAnalysisReport | null;
  masterAnalysis: AudioAnalysisReport | null;
  referenceName: string | null;
  referenceAnalysis: AudioAnalysisReport | null;
  assistantRationale: string[];
  assistantWarnings: string[];
  serverAdvice: ServerAdviceData | null;
  advisingLoading: boolean;
  aiEngineMode: UiAiEngineMode;
  customProvider: 'groq' | 'gemini' | 'openrouter' | 'openai';
  customApiKey: string;
  onChangeAiEngineMode: (mode: UiAiEngineMode) => void;
  onChangeCustomCreds: (
    provider: 'groq' | 'gemini' | 'openrouter' | 'openai',
    apiKey: string
  ) => void;
  onApplyAiParams: (nextParams: MasteringChainParams) => void;
  onSelectDeliveryProfile: (id: DeliveryProfileId) => void;
  onSelectTonalPreset: (id: TonalPresetId) => void;
  onRunSignalAssistant: () => void;
  onRequestServerAdvice: () => void;
  onUploadReference: (file: File) => void;
  onClearReference: () => void;
}

function reportToSummary(r: AudioAnalysisReport): SignalSummaryInput {
  return {
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
  };
}

const QUICK_PROMPTS = [
  'Make vocals cut through without harshness',
  'Punchy -9 LUFS club master with tight sub',
  'Warm analog tape glue & wider stereo air',
  'Tame 3-8 kHz ear fatigue with Stabilizer',
  'Prevent Spotify Ogg & MP3 codec clipping',
];

export const AssistantAndBenchmarkModule: React.FC<Props> = ({
  trackName,
  params,
  codecAudits,
  deliveryProfile,
  tonalPreset,
  sourceAnalysis,
  masterAnalysis,
  referenceName,
  referenceAnalysis,
  assistantRationale,
  assistantWarnings,
  serverAdvice,
  advisingLoading,
  aiEngineMode,
  customProvider,
  customApiKey,
  onChangeAiEngineMode,
  onChangeCustomCreds,
  onApplyAiParams,
  onSelectDeliveryProfile,
  onSelectTonalPreset,
  onRunSignalAssistant,
  onRequestServerAdvice,
  onUploadReference,
  onClearReference,
}) => {
  const [chatInput, setChatInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  const [autoApplyChain, setAutoApplyChain] = useState(true);
  const [browserModelStatus, setBrowserModelStatus] = useState<{
    active: boolean;
    text: string;
    pct: number;
  }>({ active: false, text: '', pct: 0 });
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  const sims = masterAnalysis
    ? simulateStreamingNormalization(
        masterAnalysis.loudness.integratedLufs,
        masterAnalysis.truePeak.truePeakDbtp
      )
    : [];

  const handlePreloadBrowserModel = async () => {
    setBrowserModelStatus({
      active: true,
      text: 'Initializing Browser Neural LLM Worker...',
      pct: 5,
    });
    try {
      const info = await browserAiClient.preloadTransformersModel((statusText, pct) => {
        setBrowserModelStatus({ active: true, text: statusText, pct });
      });
      setBrowserModelStatus({
        active: false,
        text: `Ready: ${info.modelId} (${info.device.toUpperCase()} q4 cached in browser)`,
        pct: 100,
      });
    } catch (err) {
      setBrowserModelStatus({
        active: false,
        text: `Browser CDN offline (${err instanceof Error ? err.message : 'fallback'}); SonicForge Built-In Acoustic AI active`,
        pct: 100,
      });
    }
  };

  const submitCopilotPrompt = async (promptText: string) => {
    const clean = promptText.trim();
    if (!clean || !sourceAnalysis || chatLoading) return;

    const userMsg: ChatMessage = {
      id: `u_${Date.now()}`,
      role: 'user',
      content: clean,
    };
    setMessages((prev) => [...prev, userMsg]);
    setChatInput('');
    setChatLoading(true);

    const srcSummary = reportToSummary(sourceAnalysis);
    const mstSummary = masterAnalysis ? reportToSummary(masterAnalysis) : undefined;

    // Always compute local deterministic DSP patch & telemetry baseline so offline/fallback never fails
    const localTurn = solveNaturalLanguageMasteringCopilot({
      prompt: clean,
      trackName,
      currentParams: params,
      source: srcSummary,
      master: mstSummary,
      codecAudits,
    });

    try {
      if (aiEngineMode === 'own_ai') {
        const applied = Boolean(autoApplyChain && localTurn.updatedParams);
        if (applied && localTurn.updatedParams) {
          onApplyAiParams(localTurn.updatedParams);
        }
        setMessages((prev) => [
          ...prev,
          {
            id: `a_${Date.now()}`,
            role: 'assistant',
            content: localTurn.reply,
            modelLabel: localTurn.modelLabel,
            archetype: localTurn.archetype,
            patchItems: localTurn.patchItems,
            updatedParams: localTurn.updatedParams,
            applied,
          },
        ]);
      } else if (aiEngineMode === 'browser_local') {
        setBrowserModelStatus({
          active: true,
          text: 'Starting in-browser neural LLM inference...',
          pct: 10,
        });
        try {
          const sysPrompt =
            'You are SonicForge Pro AI Mastering Engineer running locally in the browser. Give a concise 2-4 sentence professional mastering explanation referencing the exact LUFS, dBTP, LRA, and EQ/Limiter actions provided.';
          const usrPrompt = `Track: "${trackName}" (${localTurn.archetype.label}). Source: ${srcSummary.integratedLufs.toFixed(1)} LUFS, ${srcSummary.truePeakDbtp.toFixed(2)} dBTP, Tilt ${srcSummary.spectralTiltDbPerOct.toFixed(1)} dB/oct. User request: "${clean}". Prepared DSP moves: ${localTurn.patchItems.map((p) => p.summary).join('; ') || 'Diagnostic check'}.`;

          const gen = await browserAiClient.generateLocalResponse(
            sysPrompt,
            usrPrompt,
            (statusText, pct) => {
              setBrowserModelStatus({ active: true, text: statusText, pct });
            }
          );
          setBrowserModelStatus({
            active: false,
            text: `Active: ${gen.modelLabel}`,
            pct: 100,
          });

          const applied = Boolean(autoApplyChain && localTurn.updatedParams);
          if (applied && localTurn.updatedParams) {
            onApplyAiParams(localTurn.updatedParams);
          }

          setMessages((prev) => [
            ...prev,
            {
              id: `a_${Date.now()}`,
              role: 'assistant',
              content: gen.text,
              modelLabel: `${gen.modelLabel} + DSP Patch Solver`,
              archetype: localTurn.archetype,
              patchItems: localTurn.patchItems,
              updatedParams: localTurn.updatedParams,
              applied,
            },
          ]);
        } catch {
          setBrowserModelStatus({
            active: false,
            text: 'Used SonicForge Built-In Acoustic AI (Browser CDN unreachable)',
            pct: 100,
          });
          const applied = Boolean(autoApplyChain && localTurn.updatedParams);
          if (applied && localTurn.updatedParams) {
            onApplyAiParams(localTurn.updatedParams);
          }
          setMessages((prev) => [
            ...prev,
            {
              id: `a_${Date.now()}`,
              role: 'assistant',
              content: localTurn.reply,
              modelLabel: `${localTurn.modelLabel} (Local Fallback)`,
              archetype: localTurn.archetype,
              patchItems: localTurn.patchItems,
              updatedParams: localTurn.updatedParams,
              applied,
            },
          ]);
        }
      } else {
        // 'auto' (Free Cloud AI -> Own Acoustic AI) or 'custom_key' via Vercel /api/mastering/chat
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (aiEngineMode === 'custom_key' && customApiKey.trim()) {
          headers['x-ai-provider'] = customProvider;
          headers['x-ai-api-key'] = customApiKey.trim();
        }

        const res = await fetch('/api/mastering/chat', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            prompt: clean,
            trackName,
            preferEngine: aiEngineMode === 'custom_key' ? 'custom_key' : 'auto',
            currentParams: params,
            source: srcSummary,
            renderedMaster: mstSummary,
            codecAudits,
            history: messages.slice(-6).map((m) => ({
              role: m.role,
              content: m.content,
            })),
          }),
        });

        if (!res.ok) {
          throw new Error('Server unreachable');
        }

        const data = (await res.json()) as {
          modelLabel: string;
          archetype: ArchetypeClassification;
          reply: string;
          patchItems: CopilotPatchItem[];
          updatedParams: MasteringChainParams | null;
        };

        const applied = Boolean(autoApplyChain && data.updatedParams);
        if (applied && data.updatedParams) {
          onApplyAiParams(data.updatedParams);
        }

        setMessages((prev) => [
          ...prev,
          {
            id: `a_${Date.now()}`,
            role: 'assistant',
            content: data.reply,
            modelLabel: data.modelLabel,
            archetype: data.archetype,
            patchItems: data.patchItems,
            updatedParams: data.updatedParams,
            applied,
          },
        ]);
      }
    } catch {
      // Zero-downtime offline browser fallback if API route ever fails
      const applied = Boolean(autoApplyChain && localTurn.updatedParams);
      if (applied && localTurn.updatedParams) {
        onApplyAiParams(localTurn.updatedParams);
      }
      setMessages((prev) => [
        ...prev,
        {
          id: `a_${Date.now()}`,
          role: 'assistant',
          content: localTurn.reply,
          modelLabel: `${localTurn.modelLabel} (Browser Direct)`,
          archetype: localTurn.archetype,
          patchItems: localTurn.patchItems,
          updatedParams: localTurn.updatedParams,
          applied,
        },
      ]);
    } finally {
      setChatLoading(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="panel">
        <div className="panel-header">
          <div className="panel-title">
            <span>Signal-Driven Master Assistant &amp; Reference Matcher</span>
            <span className="badge badge-emerald">100% Measured PCM Driven</span>
          </div>
          <div className="toolbar-group">
            <button
              type="button"
              className="btn btn-primary"
              disabled={!sourceAnalysis}
              onClick={onRunSignalAssistant}
            >
              Auto-Configure Chain from Measured PCM
            </button>
            <button
              type="button"
              className="btn btn-emerald"
              disabled={!sourceAnalysis || advisingLoading}
              onClick={onRequestServerAdvice}
            >
              {advisingLoading ? 'Analyzing...' : 'Run AI Mastering Diagnostic'}
            </button>
          </div>
        </div>

        <div className="param-grid" style={{ marginBottom: 10 }}>
          <div className="param-card">
            <div className="param-row">
              <span>Delivery Loudness Profile</span>
            </div>
            <select
              className="select-input"
              value={deliveryProfile}
              onChange={(e) => onSelectDeliveryProfile(e.target.value as DeliveryProfileId)}
            >
              {Object.values(DELIVERY_PROFILES).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.targetLufs.toFixed(1)} LUFS / {p.ceilingDbtp.toFixed(1)} dBTP)
                </option>
              ))}
            </select>
            <div style={{ fontSize: 11, color: 'var(--text-2)' }}>
              {DELIVERY_PROFILES[deliveryProfile].notes}
            </div>
          </div>

          <div className="param-card">
            <div className="param-row">
              <span>Tonal Curve Target</span>
            </div>
            <select
              className="select-input"
              value={tonalPreset}
              onChange={(e) => onSelectTonalPreset(e.target.value as TonalPresetId)}
            >
              <option value="transparent">Transparent / Balanced Studio</option>
              <option value="modern_punch">Modern Punch &amp; Top Air</option>
              <option value="warm_analog">Warm Analog Tape/Tube</option>
              <option value="vocal_presence">Vocal Presence Focus</option>
              <option value="reference_match" disabled={!referenceAnalysis}>
                Reference Track Spectral Match {referenceAnalysis ? '(Ready)' : '(Load Ref First)'}
              </option>
            </select>
            <div style={{ fontSize: 11, color: 'var(--text-2)' }}>
              Automatically selects Zero-Phase Linear FIR or Minimum-Phase EQ + STFT Stabilizer.
            </div>
          </div>

          <div className="param-card">
            <div className="param-row">
              <strong style={{ color: 'var(--text-0)' }}>Reference Track Mastering</strong>
              {referenceAnalysis && (
                <button
                  type="button"
                  className="seg-btn"
                  style={{ padding: '1px 6px', border: '1px solid var(--border)' }}
                  onClick={onClearReference}
                >
                  Clear
                </button>
              )}
            </div>
            {referenceAnalysis ? (
              <div style={{ fontSize: 11, color: '#34d399' }}>
                <div>
                  <strong>{referenceName}</strong>
                </div>
                <div className="num">
                  Measured: {referenceAnalysis.loudness.integratedLufs.toFixed(1)} LUFS •{' '}
                  {referenceAnalysis.truePeak.truePeakDbtp.toFixed(2)} dBTP • Tilt{' '}
                  {referenceAnalysis.spectral.spectralTiltDbPerOct.toFixed(1)} dB/oct
                </div>
              </div>
            ) : (
              <div style={{ fontSize: 11, color: 'var(--text-2)' }}>
                Import a commercial reference track for loudness-matched A/B audition &amp; 6-band
                spectral curve matching.
              </div>
            )}
            <label className="btn" style={{ justifyContent: 'center', fontSize: 11 }}>
              Import Reference Audio
              <input
                type="file"
                accept="audio/*,.wav,.flac,.mp3,.ogg,.m4a"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) onUploadReference(f);
                  e.currentTarget.value = '';
                }}
              />
            </label>
          </div>
        </div>

        {assistantWarnings.map((w, idx) => (
          <div key={idx} className="callout callout-warn" style={{ marginBottom: 6 }}>
            {w}
          </div>
        ))}

        {assistantRationale.length > 0 && (
          <div className="callout callout-info" style={{ marginBottom: 8 }}>
            <div style={{ fontWeight: 700, marginBottom: 4 }}>
              Master Assistant Signal Decisions:
            </div>
            {assistantRationale.map((line, idx) => (
              <div key={idx} style={{ fontSize: 11.5, marginBottom: 2 }}>
                • {line}
              </div>
            ))}
          </div>
        )}

        {serverAdvice && (
          <div className="callout" style={{ borderColor: 'rgba(16,185,129,0.35)' }}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: 8,
                flexWrap: 'wrap',
                marginBottom: 6,
              }}
            >
              <strong>{serverAdvice.headline}</strong>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {serverAdvice.archetype && (
                  <span className="badge badge-cyan">
                    {serverAdvice.archetype.label} ({serverAdvice.archetype.confidencePct}%)
                  </span>
                )}
                <span className="badge badge-emerald">
                  {serverAdvice.modelLabel || serverAdvice.provider}
                </span>
              </div>
            </div>
            <div style={{ marginBottom: 6 }}>
              {serverAdvice.observations.map((o, i) => (
                <div key={i} style={{ color: 'var(--text-1)', marginBottom: 2 }}>
                  • {o}
                </div>
              ))}
            </div>
            <div style={{ fontWeight: 600, color: 'var(--cyan)', marginBottom: 3 }}>
              Recommended Engineering Adjustments:
            </div>
            {serverAdvice.actionableSteps.map((s, i) => (
              <div key={i} style={{ marginBottom: 2 }}>
                → {s}
              </div>
            ))}
            <div
              style={{
                marginTop: 6,
                paddingTop: 6,
                borderTop: '1px solid var(--border)',
                fontSize: 11,
                color: 'var(--text-2)',
              }}
            >
              {serverAdvice.complianceVerdict} • {serverAdvice.privacyNotice}
            </div>
          </div>
        )}
      </div>

      {/* Multi-Engine Conversational AI Mastering Co-Pilot */}
      <div className="panel">
        <div className="panel-header">
          <div className="panel-title">
            <span>AI Mastering Co-Pilot &amp; Natural-Language DSP Controller</span>
            <span className="badge badge-cyan">Zero-Key Ready • Browser AI • Own Acoustic AI</span>
          </div>
          <div className="toolbar-group">
            <select
              className="select-input"
              aria-label="AI Engine Selector"
              value={aiEngineMode}
              onChange={(e) => onChangeAiEngineMode(e.target.value as UiAiEngineMode)}
            >
              <option value="auto">Auto: Free Cloud LLM → SonicForge Own AI (Zero Key)</option>
              <option value="browser_local">
                Browser Local Neural AI (WebGPU/WASM SmolLM2 + window.ai)
              </option>
              <option value="own_ai">
                SonicForge Own Acoustic AI (Instant &lt;5ms Offline Engine)
              </option>
              <option value="custom_key">
                Bring Your Own Key (Groq Free / Gemini / OpenRouter / OpenAI)
              </option>
            </select>

            <label
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                fontSize: 11.5,
                color: 'var(--text-1)',
                cursor: 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={autoApplyChain}
                onChange={(e) => setAutoApplyChain(e.target.checked)}
              />
              Auto-apply DSP chain patches
            </label>
          </div>
        </div>

        {aiEngineMode === 'browser_local' && (
          <div
            className="callout callout-info"
            style={{
              marginBottom: 10,
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 10,
              flexWrap: 'wrap',
            }}
          >
            <div style={{ fontSize: 11.5 }}>
              <strong>100% Browser-Resident Neural LLM:</strong> Uses Chrome Built-In{' '}
              <code>window.ai</code> when available or loads quantized{' '}
              <code>SmolLM2-135M-Instruct</code> (ONNX WebGPU / WASM) inside a dedicated Web Worker
              cached in browser storage.
              {browserModelStatus.text && (
                <div style={{ marginTop: 3, color: 'var(--cyan)' }}>
                  Status: {browserModelStatus.text}
                </div>
              )}
            </div>
            <button
              type="button"
              className="btn"
              disabled={browserModelStatus.active}
              onClick={() => void handlePreloadBrowserModel()}
            >
              {browserModelStatus.active
                ? `Loading (${browserModelStatus.pct}%)...`
                : 'Preload Browser LLM'}
            </button>
          </div>
        )}

        {aiEngineMode === 'custom_key' && (
          <div
            className="param-card"
            style={{
              marginBottom: 10,
              display: 'grid',
              gridTemplateColumns: '180px 1fr',
              gap: 8,
              alignItems: 'center',
            }}
          >
            <select
              className="select-input"
              value={customProvider}
              onChange={(e) =>
                onChangeCustomCreds(
                  e.target.value as 'groq' | 'gemini' | 'openrouter' | 'openai',
                  customApiKey
                )
              }
            >
              <option value="groq">Groq (Llama 3.3 70B Free)</option>
              <option value="gemini">Google Gemini 2.5 Flash</option>
              <option value="openrouter">OpenRouter (Free Models)</option>
              <option value="openai">OpenAI (GPT-4o-mini)</option>
            </select>
            <input
              type="password"
              className="select-input"
              placeholder="Paste API key (kept in browser session only; never stored on server)..."
              value={customApiKey}
              onChange={(e) => onChangeCustomCreds(customProvider, e.target.value)}
            />
          </div>
        )}

        {/* Quick Prompt Chips */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
          {QUICK_PROMPTS.map((chip) => (
            <button
              key={chip}
              type="button"
              className="btn"
              style={{ fontSize: 11, padding: '4px 9px' }}
              disabled={!sourceAnalysis || chatLoading}
              onClick={() => void submitCopilotPrompt(chip)}
            >
              ✦ {chip}
            </button>
          ))}
        </div>

        {/* Conversation Thread */}
        {messages.length > 0 && (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              maxHeight: 320,
              overflowY: 'auto',
              marginBottom: 10,
              paddingRight: 4,
            }}
          >
            {messages.map((m) => (
              <div
                key={m.id}
                className="param-card"
                style={{
                  borderColor:
                    m.role === 'assistant' ? 'rgba(6,182,212,0.35)' : 'var(--border)',
                  background:
                    m.role === 'assistant'
                      ? 'rgba(6,182,212,0.05)'
                      : 'rgba(255,255,255,0.02)',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: 6,
                    marginBottom: 4,
                    flexWrap: 'wrap',
                  }}
                >
                  <strong style={{ fontSize: 11.5, color: 'var(--text-0)' }}>
                    {m.role === 'user' ? 'You (Studio Prompt)' : 'SonicForge AI Co-Pilot'}
                  </strong>
                  {m.role === 'assistant' && (
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {m.archetype && (
                        <span className="badge">
                          {m.archetype.label} • {m.archetype.confidencePct}%
                        </span>
                      )}
                      {m.modelLabel && (
                        <span className="badge badge-emerald">{m.modelLabel}</span>
                      )}
                    </div>
                  )}
                </div>

                <div
                  style={{
                    fontSize: 12,
                    color: 'var(--text-1)',
                    whiteSpace: 'pre-line',
                    lineHeight: 1.45,
                  }}
                >
                  {m.content}
                </div>

                {m.patchItems && m.patchItems.length > 0 && (
                  <div style={{ marginTop: 8 }}>
                    <div
                      style={{
                        display: 'flex',
                        flexWrap: 'wrap',
                        gap: 6,
                        marginBottom: 6,
                      }}
                    >
                      {m.patchItems.map((p, idx) => (
                        <span key={idx} className="badge badge-cyan">
                          {p.module}: {p.summary}
                        </span>
                      ))}
                    </div>
                    {m.updatedParams && !m.applied && (
                      <button
                        type="button"
                        className="btn btn-primary"
                        style={{ fontSize: 11 }}
                        onClick={() => {
                          if (m.updatedParams) {
                            onApplyAiParams(m.updatedParams);
                            setMessages((prev) =>
                              prev.map((item) =>
                                item.id === m.id ? { ...item, applied: true } : item
                              )
                            );
                          }
                        }}
                      >
                        Apply AI Patch to Mastering Chain
                      </button>
                    )}
                    {m.applied && (
                      <span style={{ fontSize: 11, color: '#34d399' }}>
                        ✓ Applied to 64-bit DSP Mastering Chain (Undo available in top bar)
                      </span>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Chat Input Form */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submitCopilotPrompt(chatInput);
          }}
          style={{ display: 'flex', gap: 8 }}
        >
          <input
            type="text"
            className="select-input"
            style={{ flex: 1 }}
            placeholder='Describe the sound you want (e.g. "bring vocals forward, tame 4kHz harshness, master to -9.5 LUFS for club")...'
            value={chatInput}
            disabled={!sourceAnalysis || chatLoading}
            onChange={(e) => setChatInput(e.target.value)}
          />
          <button
            type="submit"
            className="btn btn-primary"
            disabled={!sourceAnalysis || chatLoading || !chatInput.trim()}
          >
            {chatLoading ? 'Thinking...' : 'Ask / Patch Chain'}
          </button>
        </form>
      </div>

      {sims.length > 0 && (
        <div className="panel">
          <div className="panel-header">
            <div className="panel-title">
              <span>Streaming Platform Loudness Normalization &amp; Transcode Risk</span>
              <span className="badge">Computed on Rendered Master PCM</span>
            </div>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="benchmark-table">
              <thead>
                <tr>
                  <th>Platform</th>
                  <th>Ref Target</th>
                  <th>Rec. Ceiling</th>
                  <th>Playback Gain Change</th>
                  <th>Post-Norm Peak</th>
                  <th>Lossy Codec Risk</th>
                  <th>Behavior</th>
                </tr>
              </thead>
              <tbody>
                {sims.map((s) => (
                  <tr key={s.platform}>
                    <td style={{ fontWeight: 600 }}>{s.platform}</td>
                    <td className="num">{s.referenceLufs.toFixed(1)} LUFS</td>
                    <td className="num">{s.recommendedMaxTruePeakDbtp.toFixed(1)} dBTP</td>
                    <td className="num">
                      {s.playbackGainDeltaDb >= 0 ? '+' : ''}
                      {s.playbackGainDeltaDb.toFixed(1)} dB
                    </td>
                    <td className="num">{s.effectivePlaybackPeakDbtp.toFixed(2)} dBTP</td>
                    <td>
                      <span
                        className={`badge ${
                          s.transcodeClipRisk === 'low'
                            ? 'badge-emerald'
                            : s.transcodeClipRisk === 'moderate'
                              ? 'badge-amber'
                              : 'badge-crimson'
                        }`}
                      >
                        {s.transcodeClipRisk}
                      </span>
                    </td>
                    <td style={{ color: 'var(--text-1)' }}>{s.verdict}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="panel">
        <div className="panel-header">
          <div className="panel-title">
            <span>Pro Architecture Benchmark vs Industry Mastering Suites</span>
          </div>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table className="benchmark-table">
            <thead>
              <tr>
                <th>Capability</th>
                <th>SonicForge Pro (Full Suite)</th>
                <th>iZotope Ozone 12</th>
                <th>FabFilter Pro-L 2 / Pro-Q 4</th>
                <th>LANDR / eMastered</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  <strong>AI Architecture</strong>
                </td>
                <td>
                  4-Tier Multi-Engine AI (Zero-Key Free Cloud + Browser WebGPU/WASM LLM + Built-in
                  Acoustic Neural-Heuristic Co-Pilot + BYOK)
                </td>
                <td>Local DSP Assistant (no conversational prompt patching)</td>
                <td>Manual pro interface</td>
                <td>Cloud-only black-box AI</td>
              </tr>
              <tr>
                <td>
                  <strong>EQ &amp; Spectral Dynamics</strong>
                </td>
                <td>
                  2049-tap Zero-Phase Linear FIR + 64-bit Min-Phase M/S EQ + 75%-COLA STFT Dynamic
                  Spectral Stabilizer
                </td>
                <td>Linear/Analog EQ + Dynamic EQ + Stabilizer module</td>
                <td>Pro-Q 4 Natural/Linear Phase + Spectral Dynamics</td>
                <td>3-band macro tone sliders</td>
              </tr>
              <tr>
                <td>
                  <strong>True-Peak Maximizer</strong>
                </td>
                <td>
                  IRC-V Transient/Sustain Split Shaper + 4x/8x Kaiser-sinc ISP detector + O(N)
                  monotonic-deque look-ahead
                </td>
                <td>IRC I–V Transient/Sustain True-Peak Maximizer</td>
                <td>Up to 32x oversampled True-Peak limiting (8 styles)</td>
                <td>Automated cloud brickwall limiting</td>
              </tr>
              <tr>
                <td>
                  <strong>Stem Workflow</strong>
                </td>
                <td>
                  Local 4-bus stem console + in-browser STFT HPSS+M/S Partition-of-Unity 4-stem
                  demixer (lossless sum)
                </td>
                <td>Stem Focus / Stem EQ (Advanced)</td>
                <td>DAW multi-bus routing</td>
                <td>Cloud stem separation + revision sliders</td>
              </tr>
              <tr>
                <td>
                  <strong>Codec &amp; Device Translation</strong>
                </td>
                <td>
                  AAC 256 / Ogg 160 / MP3 128 ISP overshoot audit + Artifact Solo + Phone/Car/Club/Cube
                  Monitor Voicing
                </td>
                <td>Codec Preview in standalone/older versions</td>
                <td>External Streamliner / MixChecker plugin required</td>
                <td>No codec artifact solo or speaker voicing matrix</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
