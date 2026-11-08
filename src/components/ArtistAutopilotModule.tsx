import React, { useMemo, useState } from 'react';
import { decodeUploadedAudioFile } from '../audio/decodeAudioFile';
import { dspWorker } from '../audio/dspWorkerClient';
import type { AuditionMode } from '../audio/playbackEngine';
import {
  type AlbumTrackInput,
  computeAlbumCohesionPlan,
  generateAlbumQcReportHtml,
} from '../dsp/albumCohesion';
import {
  type AutoMasterIntensity,
  AUTOPILOT_GENRE_CARDS,
  type AutopilotFeelMacros,
  type AutopilotGenreId,
  type AutopilotReleaseGoal,
  buildAutopilotMasteringChain,
  computeAdaptiveAutoMasterParams,
  computeArtistReadinessScorecard,
} from '../dsp/autopilotEngine';
import { applyMixDoctorAutoFix } from '../dsp/mixDoctor';
import { createDefaultMasteringParams } from '../dsp/profiles';
import type {
  AudioAnalysisReport,
  CodecAuditResult,
  DetectedSection,
  LoudnessSweetSpotReport,
  MasteringChainParams,
  MixDoctorIssue,
  PlanarAudioBuffer,
} from '../dsp/types';
import { encodeWav } from '../dsp/wav';
import {
  createZipArchive,
  generateMasteringQcCertificateHtml,
  type ZipFileEntry,
} from '../dsp/zipBuilder';

interface Props {
  trackName: string;
  sourceBuffer: PlanarAudioBuffer | null;
  sourceAnalysis: AudioAnalysisReport | null;
  masterAnalysis: AudioAnalysisReport | null;
  params: MasteringChainParams;
  codecAudits: CodecAuditResult[];
  detectedSections: DetectedSection[];
  mixDoctorIssues: MixDoctorIssue[];
  sweetSpot: LoudnessSweetSpotReport | null;
  auditionMode: AuditionMode;
  onApplyParams: (next: MasteringChainParams) => void;
  onJumpAndLoopMoment: (startSec: number, endSec: number) => void;
  onSetAuditionMode: (mode: AuditionMode) => void;
  onSwitchToProRack: () => void;
}

export const ArtistAutopilotModule: React.FC<Props> = ({
  trackName,
  sourceBuffer,
  sourceAnalysis,
  masterAnalysis,
  params,
  codecAudits,
  detectedSections,
  mixDoctorIssues,
  sweetSpot,
  auditionMode,
  onApplyParams,
  onJumpAndLoopMoment,
  onSetAuditionMode,
  onSwitchToProRack,
}) => {
  const [macros, setMacros] = useState<AutopilotFeelMacros>({
    genre: 'auto',
    releaseGoal: 'streaming',
    loudnessSlamPct: 64,
    vocalUpfrontPct: 60,
    bassPhonePunchPct: 62,
    chorusBloomWidthPct: 62,
  });

  // Blind Volume-Matched ABX Ear Test State
  const [abxActive, setAbxActive] = useState(false);
  const [abxTargetIsMaster, setAbxTargetIsMaster] = useState<boolean>(() => Math.random() >= 0.5);
  const [abxTrials, setAbxTrials] = useState<Array<{ pickedMaster: boolean; correct: boolean }>>([]);
  const [copiedDawNotes, setCopiedDawNotes] = useState(false);

  // 1-Click Complete Release Pack (.zip) Export State
  const [includeInstrumental, setIncludeInstrumental] = useState(false);
  const [packProgress, setPackProgress] = useState<string | null>(null);
  const [proAutoIntensity, setProAutoIntensity] = useState<AutoMasterIntensity>('balanced_pro');
  const [proAutoActions, setProAutoActions] = useState<string[]>([]);

  const readiness = useMemo(
    () => computeArtistReadinessScorecard(masterAnalysis, params),
    [masterAnalysis, params]
  );

  const applyMacros = (nextMacros: AutopilotFeelMacros) => {
    setMacros(nextMacros);
    const built = buildAutopilotMasteringChain(
      nextMacros,
      sourceAnalysis,
      sweetSpot,
      params.exportFormat,
      mixDoctorIssues
    );
    onApplyParams(built);
  };

  const handleRunStudioAutoMaster = (intensity: AutoMasterIntensity) => {
    setProAutoIntensity(intensity);
    const res = computeAdaptiveAutoMasterParams({
      genre: macros.genre,
      intensity,
      source: sourceAnalysis,
      issues: mixDoctorIssues,
      sweetSpot,
      currentMeta: params.exportFormat,
    });
    setProAutoActions(res.summaryActions);
    onApplyParams(res.params);
  };

  const handleSelectGenre = (g: AutopilotGenreId) => {
    const card = AUTOPILOT_GENRE_CARDS.find((c) => c.id === g) ?? AUTOPILOT_GENRE_CARDS[0];
    setProAutoActions([]);
    applyMacros({
      ...macros,
      genre: g,
      loudnessSlamPct: card.defaultSlam,
      vocalUpfrontPct: card.defaultVocal,
      bassPhonePunchPct: card.defaultBass,
      chorusBloomWidthPct: card.defaultBloom,
    });
  };

  const handleSelectGoal = (goal: AutopilotReleaseGoal) => {
    applyMacros({ ...macros, releaseGoal: goal });
  };

  const handleFixAllMixIssues = () => {
    let cur = params;
    for (const issue of mixDoctorIssues) {
      cur = applyMixDoctorAutoFix(cur, issue);
    }
    onApplyParams(cur);
  };

  const handleCopyDawNotes = async () => {
    if (mixDoctorIssues.length === 0) return;
    const lines = [
      `SonicForge Pro — Mix Doctor Notes for "${trackName}"`,
      `====================================================`,
      ...mixDoctorIssues.map(
        (iss, idx) =>
          `${idx + 1}. ${iss.title} (${iss.measuredValueLabel})\n   Why: ${iss.plainEnglishWhy}\n   DAW Tip: ${iss.dawMixAdvice}`
      ),
    ];
    try {
      await navigator.clipboard.writeText(lines.join('\n\n'));
      setCopiedDawNotes(true);
      setTimeout(() => setCopiedDawNotes(false), 2500);
    } catch {
      // Ignore clipboard permission restrictions
    }
  };

  // Blind ABX handlers (locks Master & Original to IDENTICAL volume via master_matched vs original!)
  const startBlindTest = () => {
    const nextX = Math.random() >= 0.5;
    setAbxTargetIsMaster(nextX);
    setAbxTrials([]);
    setAbxActive(true);
    onSetAuditionMode(nextX ? 'master_matched' : 'original');
  };

  const listenBlindX = () => {
    onSetAuditionMode(abxTargetIsMaster ? 'master_matched' : 'original');
  };

  const voteBlindPrefer = (preferX: boolean) => {
    const pickedMaster = preferX ? abxTargetIsMaster : !abxTargetIsMaster;
    const nextTrials = [...abxTrials, { pickedMaster, correct: pickedMaster }];
    setAbxTrials(nextTrials);
    const nextX = Math.random() >= 0.5;
    setAbxTargetIsMaster(nextX);
    onSetAuditionMode(nextX ? 'master_matched' : 'original');
  };

  const handleDownloadReleasePackZip = async () => {
    if (!sourceBuffer) return;
    setPackProgress('1/4 Rendering Streaming Master (Spotify / Apple / DistroKid 24-bit)...');
    try {
      const safeSlug =
        trackName.replace(/\.[^.]+$/, '').replace(/[^a-z0-9_-]+/gi, '_') || 'SonicForge_Track';

      // 1. Streaming Master (-1.0 dBTP codec-safe)
      const streamParams: MasteringChainParams = {
        ...JSON.parse(JSON.stringify(params)),
        limiter: {
          ...params.limiter,
          autoGainToTarget: true,
          targetLufs: Math.min(-9.0, Math.max(-14.0, params.limiter.targetLufs)),
          ceilingDbtp: -1.0,
          oversampling: 8,
        },
        exportFormat: {
          ...params.exportFormat,
          bitDepth: 24,
          dither: 'tpdf_shaped',
        },
      };
      const streamRes = await dspWorker.renderStereo(sourceBuffer, streamParams);
      const streamWav = new Uint8Array(encodeWav(streamRes.buffer, streamParams.exportFormat));

      // 2. Club / DJ Loud Master (-7.8 LUFS, -0.6 dBTP, 16x True-Peak + Soft Clipper + Mono Sub)
      setPackProgress('2/4 Rendering Club & DJ Loud Master (-7.8 LUFS, 16x True Peak)...');
      const clubParams: MasteringChainParams = {
        ...JSON.parse(JSON.stringify(params)),
        stereo: {
          ...params.stereo,
          enabled: true,
          bassMonoEnabled: true,
          bassMonoHz: 138,
        },
        limiter: {
          ...params.limiter,
          autoGainToTarget: true,
          targetLufs: -7.8,
          maxAutoDriveDb: 17.0,
          ceilingDbtp: -0.6,
          releaseMode: 'irc_spectral',
          oversampling: 16,
          softClipEnabled: true,
          softClipMode: 'crisp_cubic',
          softClipThresholdDb: -1.6,
          softClipAmountPct: 52,
        },
        exportFormat: {
          ...params.exportFormat,
          bitDepth: 24,
          dither: 'tpdf_shaped',
        },
      };
      const clubRes = await dspWorker.renderStereo(sourceBuffer, clubParams);
      const clubWav = new Uint8Array(encodeWav(clubRes.buffer, clubParams.exportFormat));

      // 3. TikTok / Reels / YouTube Shorts Cut (Phantom 808 Harmonics + Upfront Vocal Presence)
      setPackProgress('3/4 Rendering TikTok / Reels Mobile Cut (Phantom 808 Translation)...');
      const mobileParams: MasteringChainParams = {
        ...JSON.parse(JSON.stringify(params)),
        phantomBass: {
          enabled: true,
          cutoffHz: 80,
          amountPct: 68,
          character: 'warm_808',
        },
        limiter: {
          ...params.limiter,
          autoGainToTarget: true,
          targetLufs: -9.2,
          ceilingDbtp: -1.0,
          oversampling: 8,
        },
        exportFormat: {
          ...params.exportFormat,
          bitDepth: 24,
          dither: 'tpdf_shaped',
        },
      };
      const mobileRes = await dspWorker.renderStereo(sourceBuffer, mobileParams);
      const mobileWav = new Uint8Array(encodeWav(mobileRes.buffer, mobileParams.exportFormat));

      const entries: ZipFileEntry[] = [
        { filename: `${safeSlug}_01_Streaming_Master_24bit.wav`, data: streamWav },
        { filename: `${safeSlug}_02_Club_DJ_Master_24bit.wav`, data: clubWav },
        { filename: `${safeSlug}_03_TikTok_Reels_Mobile_24bit.wav`, data: mobileWav },
      ];

      // Optional 4. Performance / TV Instrumental via REPET-SIM Demixer
      if (includeInstrumental) {
        setPackProgress('4/4 Extracting Vocal-Free Performance Instrumental (REPET-SIM v2)...');
        const demixed = await dspWorker.demixStems(sourceBuffer);
        const len = sourceBuffer.channels[0].length;
        const instL = new Float32Array(len);
        const instR = new Float32Array(len);
        for (const slot of ['drums', 'bass', 'instruments'] as const) {
          const st = demixed.stems[slot];
          const sl = st.channels[0];
          const srCh = st.channels[1] ?? sl;
          for (let i = 0; i < len; i++) {
            instL[i] += sl[i];
            instR[i] += srCh[i];
          }
        }
        const instMaster = await dspWorker.renderStereo(
          {
            sampleRate: sourceBuffer.sampleRate,
            duration: sourceBuffer.duration,
            channels: [instL, instR],
          },
          streamParams
        );
        entries.push({
          filename: `${safeSlug}_04_Performance_Instrumental_24bit.wav`,
          data: new Uint8Array(encodeWav(instMaster.buffer, streamParams.exportFormat)),
        });
      }

      const certHtml = generateMasteringQcCertificateHtml({
        trackName,
        metadata: params.exportFormat.metadata,
        streamingAnalysis: streamRes.analysis,
        clubAnalysis: clubRes.analysis,
        mobileAnalysis: mobileRes.analysis,
        codecAudits,
        sections: detectedSections,
        issues: mixDoctorIssues,
      });
      entries.push({
        filename: `${safeSlug}_Mastering_QC_Certificate.html`,
        data: new TextEncoder().encode(certHtml),
      });

      const notesTxt = [
        `SONICFORGE PRO v4.0 — RELEASE PACK README & MIX DOCTOR NOTES`,
        `Track: ${trackName}`,
        `1. 01_Streaming_Master_24bit.wav -> Upload this to DistroKid, TuneCore, Spotify, Apple Music, YouTube.`,
        `2. 02_Club_DJ_Master_24bit.wav   -> Send this to DJs, SoundCloud, and club sound systems.`,
        `3. 03_TikTok_Reels_Mobile_24bit.wav -> Use this in CapCut / Instagram Reels / TikTok so 808s cut through on phones.`,
        includeInstrumental
          ? `4. 04_Performance_Instrumental_24bit.wav -> Vocal-free show / performance backing track.`
          : '',
        ``,
        `MIX DOCTOR DIAGNOSTICS:`,
        ...(mixDoctorIssues.length === 0
          ? ['No major mix headroom thieves detected!']
          : mixDoctorIssues.map((m) => `- ${m.title}: ${m.plainEnglishWhy} (DAW Tip: ${m.dawMixAdvice})`)),
      ]
        .filter(Boolean)
        .join('\n');

      entries.push({
        filename: `${safeSlug}_Where_To_Upload_Guide.txt`,
        data: new TextEncoder().encode(notesTxt),
      });

      const zipBuf = createZipArchive(entries);
      const blob = new Blob([zipBuf], { type: 'application/zip' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${safeSlug}_Complete_Release_Pack.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      setPackProgress('Release Pack downloaded! Check your Downloads folder (.zip).');
    } catch (err) {
      setPackProgress(err instanceof Error ? err.message : 'Failed to build Release Pack.');
    }
  };

  const masterPreferredCount = abxTrials.filter((t) => t.pickedMaster).length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* STEP 1: Pick Genre/Vibe & Release Goal */}
      <div className="panel">
        <div className="panel-header">
          <div className="panel-title">
            <span>Step 1 — Pick Your Song&apos;s Vibe &amp; Release Destination</span>
            <span className="badge badge-emerald">Zero Engineering Jargon — Guided Pro Sound</span>
          </div>
          <button type="button" className="btn" onClick={onSwitchToProRack}>
            Inspect Full Pro DSP Rack →
          </button>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(185px, 1fr))',
            gap: 8,
            marginBottom: 12,
          }}
        >
          {AUTOPILOT_GENRE_CARDS.map((card) => {
            const active = macros.genre === card.id;
            return (
              <button
                key={card.id}
                type="button"
                onClick={() => handleSelectGenre(card.id)}
                style={{
                  textAlign: 'left',
                  padding: '10px 12px',
                  borderRadius: 8,
                  cursor: 'pointer',
                  background: active ? 'rgba(34, 211, 238, 0.13)' : 'var(--bg-2)',
                  border: active ? '1.5px solid var(--cyan)' : '1px solid var(--border)',
                  color: 'var(--text-0)',
                }}
              >
                <div style={{ fontWeight: 700, fontSize: 12.5, color: active ? 'var(--cyan)' : 'var(--text-0)' }}>
                  {card.title}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-2)', marginTop: 3 }}>
                  {card.subtitle}
                </div>
              </button>
            );
          })}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-1)' }}>
            Primary Release Goal:
          </span>
          <div className="segmented">
            <button
              type="button"
              className={`seg-btn ${macros.releaseGoal === 'streaming' ? 'active' : ''}`}
              onClick={() => handleSelectGoal('streaming')}
            >
              DistroKid / Spotify / Apple Music
            </button>
            <button
              type="button"
              className={`seg-btn ${macros.releaseGoal === 'club_loud' ? 'active-amber' : ''}`}
              onClick={() => handleSelectGoal('club_loud')}
            >
              Club / DJ / SoundCloud (Max Loudness)
            </button>
            <button
              type="button"
              className={`seg-btn ${macros.releaseGoal === 'social_mobile' ? 'active' : ''}`}
              onClick={() => handleSelectGoal('social_mobile')}
            >
              TikTok / Reels / YouTube Shorts
            </button>
          </div>

          <span
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: 'var(--cyan)',
              marginLeft: 'auto',
            }}
          >
            ⚡ 1-Click Studio Auto-Master:
          </span>
          <div className="segmented">
            <button
              type="button"
              className={`seg-btn ${proAutoActions.length > 0 && proAutoIntensity === 'warm_smooth' ? 'active' : ''}`}
              onClick={() => handleRunStudioAutoMaster('warm_smooth')}
            >
              ☁️ Warm &amp; Smooth
            </button>
            <button
              type="button"
              className={`seg-btn ${proAutoActions.length > 0 && proAutoIntensity === 'balanced_pro' ? 'active' : ''}`}
              onClick={() => handleRunStudioAutoMaster('balanced_pro')}
            >
              ✨ Balanced Radio
            </button>
            <button
              type="button"
              className={`seg-btn ${proAutoActions.length > 0 && proAutoIntensity === 'loud_punchy' ? 'active-amber' : ''}`}
              onClick={() => handleRunStudioAutoMaster('loud_punchy')}
            >
              🔥 Loud &amp; Punchy
            </button>
          </div>
        </div>

        {proAutoActions.length > 0 && (
          <div
            style={{
              marginTop: 10,
              padding: '8px 12px',
              borderRadius: 8,
              background: 'rgba(16, 185, 129, 0.09)',
              border: '1px solid rgba(16, 185, 129, 0.35)',
              fontSize: 11.5,
              color: 'var(--text-1)',
              display: 'flex',
              flexWrap: 'wrap',
              gap: '6px 14px',
            }}
          >
            <strong style={{ color: '#34d399' }}>✓ Studio Auto-Master Applied to Pro Rack:</strong>
            {proAutoActions.map((act, idx) => (
              <span key={idx}>• {act}</span>
            ))}
          </div>
        )}
      </div>

      {/* STEP 2: 4 Musical Feel Sliders + Loudness Sweet-Spot Scanner + Chorus Section Map */}
      <div className="panel">
        <div className="panel-header">
          <div className="panel-title">
            <span>Step 2 — Shape Your Sound With 4 Plain-English Feel Controls</span>
            {sweetSpot && (
              <span className="badge badge-cyan num">
                Measured Punch Sweet Spot: {sweetSpot.recommendedLufs.toFixed(1)} LUFS
              </span>
            )}
          </div>
        </div>

        <div className="param-grid" style={{ marginBottom: 12 }}>
          <div className="param-card">
            <div className="param-row">
              <strong style={{ color: 'var(--text-0)' }}>🔥 Competitive Loudness &amp; Slam</strong>
              <span className="param-val">
                {macros.loudnessSlamPct}% ({params.limiter.targetLufs.toFixed(1)} LUFS)
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={100}
              value={macros.loudnessSlamPct}
              onChange={(e) =>
                applyMacros({ ...macros, loudnessSlamPct: Number(e.target.value) })
              }
            />
            <div style={{ fontSize: 11, color: 'var(--text-2)' }}>
              Sets commercial volume + 4x Soft Clipper + 16x True-Peak safety ceiling automatically.
            </div>
          </div>

          <div className="param-card">
            <div className="param-row">
              <strong style={{ color: 'var(--text-0)' }}>🎤 Vocal Upfront &amp; Silk</strong>
              <span className="param-val">{macros.vocalUpfrontPct}%</span>
            </div>
            <input
              type="range"
              min={0}
              max={100}
              value={macros.vocalUpfrontPct}
              onChange={(e) =>
                applyMacros({ ...macros, vocalUpfrontPct: Number(e.target.value) })
              }
            />
            <div style={{ fontSize: 11, color: 'var(--text-2)' }}>
              Clears 290 Hz mud out of the center while lifting vocal clarity with automatic de-essing.
            </div>
          </div>

          <div className="param-card">
            <div className="param-row">
              <strong style={{ color: 'var(--text-0)' }}>🔊 808 / Bass Phone &amp; Sub Punch</strong>
              <span className="param-val">{macros.bassPhonePunchPct}%</span>
            </div>
            <input
              type="range"
              min={0}
              max={100}
              value={macros.bassPhonePunchPct}
              onChange={(e) =>
                applyMacros({ ...macros, bassPhonePunchPct: Number(e.target.value) })
              }
            />
            <div style={{ fontSize: 11, color: 'var(--text-2)' }}>
              Locks sub-bass mono for clubs AND adds Phantom Harmonics so 808s hit on iPhone speakers.
            </div>
          </div>

          <div className="param-card">
            <div className="param-row">
              <strong style={{ color: 'var(--text-0)' }}>🌌 Chorus Explosion &amp; Stereo Width</strong>
              <span className="param-val">{macros.chorusBloomWidthPct}%</span>
            </div>
            <input
              type="range"
              min={0}
              max={100}
              value={macros.chorusBloomWidthPct}
              onChange={(e) =>
                applyMacros({ ...macros, chorusBloomWidthPct: Number(e.target.value) })
              }
            />
            <div style={{ fontSize: 11, color: 'var(--text-2)' }}>
              Rides macro-dynamics automatically so your Chorus opens wider &amp; brighter than your Verse!
            </div>
          </div>
        </div>

        {/* Loudness-vs-Punch Sweet-Spot Curve */}
        {sweetSpot && (
          <div
            style={{
              background: '#06090f',
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: '10px 12px',
              marginBottom: 10,
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: 8,
                flexWrap: 'wrap',
                gap: 6,
              }}
            >
              <strong style={{ fontSize: 12, color: 'var(--text-0)' }}>
                Loudness-vs-Punch Breaking-Point Scanner (Click any point to lock target):
              </strong>
              <span style={{ fontSize: 11, color: 'var(--text-2)' }}>{sweetSpot.explanation}</span>
            </div>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
                gap: 6,
              }}
            >
              {sweetSpot.points.map((pt) => {
                const isSelected = Math.abs(params.limiter.targetLufs - pt.targetLufs) < 0.6;
                return (
                  <button
                    key={pt.targetLufs}
                    type="button"
                    onClick={() =>
                      onApplyParams({
                        ...params,
                        deliveryProfile: 'custom',
                        limiter: {
                          ...params.limiter,
                          autoGainToTarget: true,
                          targetLufs: pt.targetLufs,
                        },
                      })
                    }
                    style={{
                      padding: '7px 9px',
                      borderRadius: 6,
                      cursor: 'pointer',
                      textAlign: 'left',
                      background: pt.isSweetSpot
                        ? 'rgba(16, 185, 129, 0.14)'
                        : isSelected
                          ? 'rgba(34, 211, 238, 0.12)'
                          : 'var(--bg-2)',
                      border: pt.isSweetSpot
                        ? '1.5px solid #10b981'
                        : isSelected
                          ? '1.5px solid var(--cyan)'
                          : '1px solid var(--border)',
                      color: 'var(--text-0)',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                      <strong className="num">{pt.targetLufs.toFixed(1)} LUFS</strong>
                      {pt.isSweetSpot && (
                        <span style={{ color: '#10b981', fontSize: 10, fontWeight: 700 }}>
                          SWEET SPOT
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 10.5, color: 'var(--text-2)', marginTop: 2 }}>
                      Drum Punch: <strong style={{ color: pt.punchRetentionPct >= 75 ? '#10b981' : '#f59e0b' }}>{pt.punchRetentionPct}%</strong> • GR -{pt.maxGainReductionDb.toFixed(1)} dB
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Section-Aware Arrangement Map */}
        {detectedSections.length > 0 && (
          <div>
            <div style={{ fontSize: 11, color: 'var(--text-2)', marginBottom: 4 }}>
              <strong>Auto-Detected Song Sections</strong> (Click any section to audition how Verse vs Chorus hits):
            </div>
            <div style={{ display: 'flex', width: '100%', gap: 3, overflowX: 'auto' }}>
              {detectedSections.map((sec) => {
                const span = Math.max(0.5, sec.endSec - sec.startSec);
                const bg =
                  sec.type === 'chorus'
                    ? 'rgba(34, 211, 238, 0.22)'
                    : sec.type === 'build'
                      ? 'rgba(245, 158, 11, 0.2)'
                      : 'rgba(148, 163, 184, 0.12)';
                return (
                  <button
                    key={sec.id}
                    type="button"
                    onClick={() => onJumpAndLoopMoment(sec.startSec, sec.endSec)}
                    style={{
                      flex: `${span} 1 70px`,
                      background: bg,
                      border:
                        sec.type === 'chorus'
                          ? '1px solid rgba(34,211,238,0.55)'
                          : '1px solid var(--border)',
                      borderRadius: 5,
                      padding: '5px 7px',
                      color: 'var(--text-0)',
                      cursor: 'pointer',
                      textAlign: 'left',
                      fontSize: 10.5,
                    }}
                  >
                    <div style={{ fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {sec.label}
                    </div>
                    <div className="num" style={{ color: 'var(--text-2)', fontSize: 9.5 }}>
                      {sec.startSec.toFixed(1)}s–{sec.endSec.toFixed(1)}s
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* STEP 3: Time-Stamped "Mix Doctor" Headroom Thief Detector */}
      <div className="panel">
        <div className="panel-header">
          <div className="panel-title">
            <span>Step 3 — Mix Doctor: Exact Moments Holding Your Mix Back</span>
            <span className={`badge ${mixDoctorIssues.length === 0 ? 'badge-emerald' : 'badge-amber'}`}>
              {mixDoctorIssues.length === 0
                ? 'Clean Pre-Master!'
                : `${mixDoctorIssues.length} Mix Fix(es) Found`}
            </span>
          </div>
          {mixDoctorIssues.length > 0 && (
            <div className="toolbar-group">
              <button type="button" className="btn" onClick={() => void handleCopyDawNotes()}>
                {copiedDawNotes ? 'Copied DAW Mix Notes!' : 'Copy Notes for FL / Logic / Ableton'}
              </button>
              <button type="button" className="btn btn-primary" onClick={handleFixAllMixIssues}>
                1-Click Fix All in Master
              </button>
            </div>
          )}
        </div>

        {mixDoctorIssues.length === 0 ? (
          <div className="callout callout-ok">
            No severe headroom-stealing spikes, phase cancellations, or harsh resonances were detected in your mix!
          </div>
        ) : (
          <div className="param-grid">
            {mixDoctorIssues.map((issue) => (
              <div key={issue.id} className="param-card">
                <div className="param-row">
                  <strong style={{ color: issue.severity === 'high' ? '#f59e0b' : 'var(--cyan)' }}>
                    {issue.title}
                  </strong>
                  <span className="badge badge-amber num">{issue.measuredValueLabel}</span>
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--text-1)', lineHeight: 1.45 }}>
                  {issue.plainEnglishWhy}
                </div>
                <div style={{ fontSize: 10.5, color: 'var(--text-2)', marginTop: 3 }}>
                  <strong>Optional DAW Mix Tip:</strong> {issue.dawMixAdvice}
                </div>
                <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className="btn"
                    style={{ fontSize: 11, padding: '4px 8px' }}
                    onClick={() => onJumpAndLoopMoment(issue.timestampSec, issue.endSec)}
                  >
                    ▶ Hear Exact Moment
                  </button>
                  <button
                    type="button"
                    className="btn btn-emerald"
                    style={{ fontSize: 11, padding: '4px 8px' }}
                    onClick={() => onApplyParams(applyMixDoctorAutoFix(params, issue))}
                  >
                    ✨ {issue.autoFixLabel}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* STEP 4: Readiness Scorecard + Blind Ear Test + 1-Click Complete Release Pack (.zip) */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
          gap: 12,
        }}
      >
        <div className="panel">
          <div className="panel-header">
            <div className="panel-title">
              <span>Release Readiness &amp; Blind Volume-Matched Ear Test</span>
            </div>
            <span className="badge badge-emerald num" style={{ fontSize: 12 }}>
              Score: {readiness.score}/100 — {readiness.gradeLabel}
            </span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
            {readiness.checks.map((chk, idx) => (
              <div
                key={idx}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '6px 9px',
                  borderRadius: 6,
                  background: 'var(--bg-2)',
                  fontSize: 11.5,
                }}
              >
                <span>
                  <strong style={{ color: chk.passed ? '#10b981' : '#f59e0b' }}>
                    {chk.passed ? '✓' : '!'}
                  </strong>{' '}
                  {chk.label}
                </span>
                <span className="num" style={{ color: 'var(--text-2)', fontSize: 11 }}>
                  {chk.detail}
                </span>
              </div>
            ))}
          </div>

          {/* Blind Volume-Matched ABX Ear Shootout */}
          <div
            style={{
              background: '#06090f',
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: 10,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <strong style={{ fontSize: 12 }}>
                Blind Equal-Volume Ear Test (Don&apos;t Get Fooled by Loudness!)
              </strong>
              <button type="button" className="btn" style={{ fontSize: 11, padding: '3px 8px' }} onClick={startBlindTest}>
                {abxActive ? 'Restart Blind Test' : 'Start Blind Ear Test'}
              </button>
            </div>
            <p style={{ fontSize: 11, color: 'var(--text-2)', margin: '5px 0 8px' }}>
              Locks Original &amp; Master to the exact same loudness so your ears judge pure clarity, bass punch &amp; vocal shine.
            </p>
            {abxActive && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className={`btn ${auditionMode === 'original' ? 'btn-primary' : ''}`}
                    onClick={() => onSetAuditionMode('original')}
                  >
                    Listen: Original Mix
                  </button>
                  <button
                    type="button"
                    className={`btn ${auditionMode === 'master_matched' ? 'btn-primary' : ''}`}
                    onClick={() => onSetAuditionMode('master_matched')}
                  >
                    Listen: Master (Volume-Matched)
                  </button>
                  <button type="button" className="btn btn-emerald" onClick={listenBlindX}>
                    Listen: Mystery X
                  </button>
                </div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 11 }}>Is Mystery X the Master?</span>
                  <button type="button" className="btn" onClick={() => voteBlindPrefer(true)}>
                    Yes, X = Master
                  </button>
                  <button type="button" className="btn" onClick={() => voteBlindPrefer(false)}>
                    No, X = Original
                  </button>
                  {abxTrials.length > 0 && (
                    <span className="badge badge-cyan num">
                      {masterPreferredCount}/{abxTrials.length} Correct Identifications
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* 1-Click Complete Release Pack (.zip) */}
        <div className="panel" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
          <div>
            <div className="panel-header">
              <div className="panel-title">
                <span>Step 4 — Download Complete Multi-Platform Release Pack (.zip)</span>
              </div>
              <span className="badge badge-cyan">All Versions in 1 Click</span>
            </div>

            <p style={{ fontSize: 12, color: 'var(--text-1)', margin: '0 0 10px', lineHeight: 1.5 }}>
              Just like hiring a professional mastering studio, download one <strong>.zip Release Pack</strong> containing every version you need for distribution, DJs, and social media:
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 11.5, marginBottom: 12 }}>
              <div style={{ padding: '6px 9px', background: 'var(--bg-2)', borderRadius: 6 }}>
                <strong>01_Streaming_Master_24bit.wav</strong> — Codec-safe (-1.0 dBTP) for DistroKid, TuneCore, Spotify, Apple Music &amp; YouTube.
              </div>
              <div style={{ padding: '6px 9px', background: 'var(--bg-2)', borderRadius: 6 }}>
                <strong>02_Club_DJ_Master_24bit.wav</strong> — Maximum punch (-7.8 LUFS, 16x True Peak, mono-locked sub) for Pioneer CDJs &amp; SoundCloud.
              </div>
              <div style={{ padding: '6px 9px', background: 'var(--bg-2)', borderRadius: 6 }}>
                <strong>03_TikTok_Reels_Mobile_24bit.wav</strong> — Phantom 808 upper-harmonics boosted so bass knocks on iPhone &amp; Android speakers.
              </div>
              <div style={{ padding: '6px 9px', background: 'var(--bg-2)', borderRadius: 6 }}>
                <strong>Mastering_QC_Certificate.html + Upload Guide</strong> — Official loudness &amp; codec verification receipt.
              </div>
            </div>

            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 7,
                fontSize: 12,
                cursor: 'pointer',
                marginBottom: 12,
              }}
            >
              <input
                type="checkbox"
                checked={includeInstrumental}
                onChange={(e) => setIncludeInstrumental(e.target.checked)}
              />
              <span>
                Also generate &amp; include <strong>04_Performance_Instrumental_24bit.wav</strong> (Vocal-Free Show Track)
              </span>
            </label>
          </div>

          <div>
            {packProgress && (
              <div className="callout callout-info" style={{ marginBottom: 8 }}>
                {packProgress}
              </div>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <button
                type="button"
                className="btn btn-primary"
                style={{ width: '100%', justifyContent: 'center', padding: '10px 14px', fontSize: 13 }}
                disabled={!sourceBuffer || Boolean(packProgress && packProgress.startsWith('1/4'))}
                onClick={() => void handleDownloadReleasePackZip()}
              >
                Download Complete Release Pack (.zip)
              </button>

              <label
                className="btn"
                style={{
                  width: '100%',
                  justifyContent: 'center',
                  padding: '9px 14px',
                  fontSize: 12.5,
                  cursor: 'pointer',
                  textAlign: 'center',
                }}
              >
                💿 Batch Master Cohesive EP / Album (2–12 Songs → .zip)
                <input
                  type="file"
                  multiple
                  accept="audio/*,.wav,.flac,.mp3,.ogg,.m4a"
                  style={{ display: 'none' }}
                  onChange={async (e) => {
                    const list = Array.from(e.target.files ?? []).slice(0, 12);
                    e.currentTarget.value = '';
                    if (list.length === 0) return;
                    try {
                      const inputs: AlbumTrackInput[] = [];
                      for (let i = 0; i < list.length; i++) {
                        setPackProgress(
                          `EP Analysis ${i + 1}/${list.length}: "${list[i].name}"...`
                        );
                        const decoded = await decodeUploadedAudioFile(list[i]);
                        const [rep, diag] = await Promise.all([
                          dspWorker.analyze(decoded, -1.0, 16),
                          dspWorker.diagnoseSource(decoded, createDefaultMasteringParams('spotify')),
                        ]);
                        inputs.push({
                          name: list[i].name,
                          buffer: decoded,
                          analysis: rep,
                          issues: diag.issues,
                          sweetSpot: diag.sweetSpot,
                        });
                      }
                      const plans = computeAlbumCohesionPlan({
                        tracks: inputs,
                        genre: macros.genre,
                        intensity: proAutoIntensity,
                        albumTitle: params.exportFormat.metadata?.album || 'SonicForge Studio EP',
                        artistName: params.exportFormat.metadata?.artist || '',
                      });
                      const entries: ZipFileEntry[] = [];
                      const qcResults: Array<{
                        plan: (typeof plans)[number];
                        masterAnalysis: AudioAnalysisReport;
                      }> = [];
                      for (let i = 0; i < plans.length; i++) {
                        const plan = plans[i];
                        setPackProgress(
                          `Mastering EP Track ${i + 1}/${plans.length}: "${plan.name}" (${plan.roleLabel} @ ${plan.targetLufs.toFixed(1)} LUFS)...`
                        );
                        const res = await dspWorker.renderStereo(inputs[i].buffer, plan.params);
                        const safeName =
                          plan.name.replace(/\.[^.]+$/, '').replace(/[^a-z0-9_-]+/gi, '_') ||
                          `Track_${i + 1}`;
                        entries.push({
                          filename: `${String(plan.trackNumber).padStart(2, '0')}_${safeName}_Master_24bit.wav`,
                          data: new Uint8Array(encodeWav(res.buffer, plan.params.exportFormat)),
                        });
                        qcResults.push({ plan, masterAnalysis: res.analysis });
                      }
                      entries.push({
                        filename: '00_EP_Album_Mastering_QC_Certificate.html',
                        data: new TextEncoder().encode(
                          generateAlbumQcReportHtml({
                            albumTitle:
                              params.exportFormat.metadata?.album || 'SonicForge Studio EP',
                            results: qcResults,
                          })
                        ),
                      });
                      const zipBuf = createZipArchive(entries);
                      const blob = new Blob([zipBuf], { type: 'application/zip' });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement('a');
                      a.href = url;
                      a.download = `SonicForge_EP_Master_${plans.length}_Tracks_24bit.zip`;
                      document.body.appendChild(a);
                      a.click();
                      document.body.removeChild(a);
                      setTimeout(() => URL.revokeObjectURL(url), 5000);
                      setPackProgress(
                        `✓ Sequenced & exported ${plans.length}-track EP Master Pack (.zip)!`
                      );
                    } catch (err) {
                      setPackProgress(
                        err instanceof Error ? err.message : 'EP batch mastering failed.'
                      );
                    }
                  }}
                />
              </label>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
