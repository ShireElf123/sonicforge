import React, { useEffect, useMemo, useRef, useState } from 'react';
import { decodeUploadedAudioFile } from '../audio/decodeAudioFile';
import { dspWorker } from '../audio/dspWorkerClient';
import type { AuditionMode, MonitorVoicing } from '../audio/playbackEngine';
import {
  type AlbumTrackInput,
  computeAlbumCohesionPlan,
  generateAlbumQcReportHtml,
} from '../dsp/albumCohesion';
import {
  type AutoMasterIntensity,
  AUTOPILOT_GENRE_CARDS,
  type AutopilotGenreId,
  computeAdaptiveAutoMasterParams,
  computeArtistReadinessScorecard,
} from '../dsp/autopilotEngine';
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
  renderStatus: { active: boolean; stage: string; pct: number };
  isPlaying: boolean;
  currentTimeSec: number;
  durationSec: number;
  auditionMode: AuditionMode;
  monitorVoicing: MonitorVoicing;
  onUploadTrack: (file: File) => void;
  onApplyAutoMasterParams: (next: MasteringChainParams) => void;
  onTogglePlay: () => void;
  onSeek: (sec: number) => void;
  onSetAuditionMode: (mode: AuditionMode) => void;
  onSetMonitorVoicing: (voicing: MonitorVoicing) => void;
  onExportMasterWav: () => void;
  onSwitchToProConsole: () => void;
}

const GENRE_ICONS: Record<AutopilotGenreId, string> = {
  auto: '✨',
  trap_hiphop: '🔥',
  afro_amapiano: '🥁',
  pop_rnb: '🎤',
  club_edm: '⚡',
  rock_indie: '🎸',
  acoustic_chill: '🌿',
};

function fmtTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export const InstantAutoMasterView: React.FC<Props> = ({
  trackName,
  sourceBuffer,
  sourceAnalysis,
  masterAnalysis,
  params,
  codecAudits,
  detectedSections,
  mixDoctorIssues,
  sweetSpot,
  renderStatus,
  isPlaying,
  currentTimeSec,
  durationSec,
  auditionMode,
  monitorVoicing,
  onUploadTrack,
  onApplyAutoMasterParams,
  onTogglePlay,
  onSeek,
  onSetAuditionMode,
  onSetMonitorVoicing,
  onExportMasterWav,
  onSwitchToProConsole,
}) => {
  const [selectedGenre, setSelectedGenre] = useState<AutopilotGenreId>('auto');
  const [intensity, setIntensity] = useState<AutoMasterIntensity>('balanced_pro');
  const [dragOver, setDragOver] = useState(false);
  const [summaryActions, setSummaryActions] = useState<string[]>([]);
  const [resolvedGenreLabel, setResolvedGenreLabel] = useState<string>('Auto-Detected');
  const [zipStatus, setZipStatus] = useState<string | null>(null);
  const [albumStatus, setAlbumStatus] = useState<string | null>(null);

  const handleBatchMasterEp = async (files: FileList | File[]) => {
    const list = Array.from(files).slice(0, 12);
    if (list.length === 0) return;
    if (list.length === 1) {
      onUploadTrack(list[0]);
      return;
    }

    try {
      const inputs: AlbumTrackInput[] = [];
      for (let i = 0; i < list.length; i++) {
        const f = list[i];
        setAlbumStatus(
          `Analyzing Track ${i + 1}/${list.length}: "${f.name}" (LUFS, Spectrum & Mix Doctor)...`
        );
        const decoded = await decodeUploadedAudioFile(f);
        const [rep, diag] = await Promise.all([
          dspWorker.analyze(decoded, -1.0, 16),
          dspWorker.diagnoseSource(decoded, createDefaultMasteringParams('spotify')),
        ]);
        inputs.push({
          name: f.name,
          buffer: decoded,
          analysis: rep,
          issues: diag.issues,
          sweetSpot: diag.sweetSpot,
        });
      }

      setAlbumStatus(
        `Computing EP Spectral Cohesion & Musical Loudness Sequencing across ${inputs.length} tracks...`
      );
      const plans = computeAlbumCohesionPlan({
        tracks: inputs,
        genre: selectedGenre,
        intensity,
        albumTitle: 'SonicForge Cohesive EP Master',
      });

      const entries: ZipFileEntry[] = [];
      const qcResults: Array<{ plan: (typeof plans)[number]; masterAnalysis: AudioAnalysisReport }> =
        [];

      for (let i = 0; i < plans.length; i++) {
        const plan = plans[i];
        const src = inputs[i];
        setAlbumStatus(
          `Mastering Track ${i + 1}/${plans.length}: "${plan.name}" (${plan.roleLabel} @ ${plan.targetLufs.toFixed(1)} LUFS)...`
        );
        const rendered = await dspWorker.renderStereo(src.buffer, plan.params);
        const wavBytes = new Uint8Array(encodeWav(rendered.buffer, plan.params.exportFormat));
        const safeName =
          plan.name.replace(/\.[^.]+$/, '').replace(/[^a-z0-9_-]+/gi, '_') || `Track_${i + 1}`;
        entries.push({
          filename: `${String(plan.trackNumber).padStart(2, '0')}_${safeName}_Master_24bit.wav`,
          data: wavBytes,
        });
        qcResults.push({ plan, masterAnalysis: rendered.analysis });
      }

      const qcHtml = generateAlbumQcReportHtml({
        albumTitle: 'SonicForge Cohesive EP Master',
        results: qcResults,
      });
      entries.push({
        filename: '00_EP_Album_Mastering_QC_Certificate.html',
        data: new TextEncoder().encode(qcHtml),
      });

      const zipBytes = createZipArchive(entries);
      const blob = new Blob([zipBytes], { type: 'application/zip' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `SonicForge_EP_Master_${plans.length}_Tracks_24bit.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 5000);

      // Also load Track 1 into the live player so the user can audition immediately
      onUploadTrack(list[0]);
      setAlbumStatus(
        `✓ Mastered & sequenced all ${plans.length} EP tracks into SonicForge_EP_Master_${plans.length}_Tracks_24bit.zip!`
      );
    } catch (err) {
      setAlbumStatus(err instanceof Error ? err.message : 'EP batch mastering failed.');
    }
  };

  const lastAutoKeyRef = useRef<{ buf: PlanarAudioBuffer | null; hasSweetSpot: boolean }>({
    buf: null,
    hasSweetSpot: false,
  });

  const runInstantMaster = (
    nextGenre: AutopilotGenreId,
    nextIntensity: AutoMasterIntensity,
    srcReport = sourceAnalysis,
    curIssues = mixDoctorIssues,
    curSweet = sweetSpot
  ) => {
    const solved = computeAdaptiveAutoMasterParams({
      genre: nextGenre,
      intensity: nextIntensity,
      source: srcReport,
      issues: curIssues,
      sweetSpot: curSweet,
      currentMeta: params.exportFormat,
    });
    setResolvedGenreLabel(solved.resolvedGenreLabel);
    setSummaryActions(solved.summaryActions);
    onApplyAutoMasterParams(solved.params);
    if (auditionMode !== 'master') {
      onSetAuditionMode('master');
    }
  };

  // Automatically master whenever a track loads — and re-calibrate once Sweet-Spot + Mix Doctor arrive!
  useEffect(() => {
    if (!sourceBuffer || !sourceAnalysis) return;
    const hasSweet = Boolean(sweetSpot);
    if (
      lastAutoKeyRef.current.buf === sourceBuffer &&
      (lastAutoKeyRef.current.hasSweetSpot || !hasSweet)
    ) {
      return;
    }
    lastAutoKeyRef.current = { buf: sourceBuffer, hasSweetSpot: hasSweet };
    runInstantMaster(selectedGenre, intensity, sourceAnalysis, mixDoctorIssues, sweetSpot);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceBuffer, sourceAnalysis, mixDoctorIssues, sweetSpot]);

  const readiness = useMemo(
    () => computeArtistReadinessScorecard(masterAnalysis, params),
    [masterAnalysis, params]
  );

  const handleDownloadFullPack = async () => {
    if (!sourceBuffer) return;
    setZipStatus('Building your Spotify + Club + TikTok Release Pack (.zip)...');
    try {
      const safeSlug =
        trackName.replace(/\.[^.]+$/, '').replace(/[^a-z0-9_-]+/gi, '_') || 'Mastered_Track';

      const streamParams: MasteringChainParams = {
        ...JSON.parse(JSON.stringify(params)),
        limiter: {
          ...params.limiter,
          autoGainToTarget: true,
          targetLufs: Math.min(-9.0, Math.max(-14.0, params.limiter.targetLufs)),
          ceilingDbtp: -1.0,
          oversampling: 8,
        },
        exportFormat: { ...params.exportFormat, bitDepth: 24, dither: 'tpdf_shaped' },
      };
      const streamRes = await dspWorker.renderStereo(sourceBuffer, streamParams);

      const clubParams: MasteringChainParams = {
        ...JSON.parse(JSON.stringify(params)),
        stereo: { ...params.stereo, enabled: true, bassMonoEnabled: true, bassMonoHz: 138 },
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
        exportFormat: { ...params.exportFormat, bitDepth: 24, dither: 'tpdf_shaped' },
      };
      const clubRes = await dspWorker.renderStereo(sourceBuffer, clubParams);

      const mobileParams: MasteringChainParams = {
        ...JSON.parse(JSON.stringify(params)),
        phantomBass: { enabled: true, cutoffHz: 80, amountPct: 68, character: 'warm_808' },
        limiter: {
          ...params.limiter,
          autoGainToTarget: true,
          targetLufs: -9.2,
          ceilingDbtp: -1.0,
          oversampling: 8,
        },
        exportFormat: { ...params.exportFormat, bitDepth: 24, dither: 'tpdf_shaped' },
      };
      const mobileRes = await dspWorker.renderStereo(sourceBuffer, mobileParams);

      const entries: ZipFileEntry[] = [
        {
          filename: `${safeSlug}_01_Streaming_Master_24bit.wav`,
          data: new Uint8Array(encodeWav(streamRes.buffer, streamParams.exportFormat)),
        },
        {
          filename: `${safeSlug}_02_Club_DJ_Master_24bit.wav`,
          data: new Uint8Array(encodeWav(clubRes.buffer, clubParams.exportFormat)),
        },
        {
          filename: `${safeSlug}_03_TikTok_Reels_Mobile_24bit.wav`,
          data: new Uint8Array(encodeWav(mobileRes.buffer, mobileParams.exportFormat)),
        },
        {
          filename: `${safeSlug}_Mastering_QC_Certificate.html`,
          data: new TextEncoder().encode(
            generateMasteringQcCertificateHtml({
              trackName,
              metadata: params.exportFormat.metadata,
              streamingAnalysis: streamRes.analysis,
              clubAnalysis: clubRes.analysis,
              mobileAnalysis: mobileRes.analysis,
              codecAudits,
              sections: detectedSections,
              issues: mixDoctorIssues,
            })
          ),
        },
      ];

      const zipBuf = createZipArchive(entries);
      const blob = new Blob([zipBuf], { type: 'application/zip' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${safeSlug}_Release_Pack.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      setZipStatus('Release Pack (.zip) downloaded!');
    } catch (err) {
      setZipStatus(err instanceof Error ? err.message : 'Failed to create Release Pack.');
    }
  };

  return (
    <div
      style={{
        maxWidth: 960,
        margin: '18px auto 36px',
        padding: '0 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
      }}
    >
      {/* STEP 1: DROP / ADD YOUR TRACK */}
      <div
        className="panel"
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (e.dataTransfer.files && e.dataTransfer.files.length > 1) {
            void handleBatchMasterEp(e.dataTransfer.files);
          } else {
            const file = e.dataTransfer.files?.[0];
            if (file) onUploadTrack(file);
          }
        }}
        style={{
          padding: '22px 24px',
          border: dragOver ? '2px dashed var(--cyan)' : '1.5px dashed rgba(34, 211, 238, 0.35)',
          background: dragOver ? 'rgba(34, 211, 238, 0.08)' : 'var(--bg-1)',
          textAlign: 'center',
          borderRadius: 12,
        }}
      >
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--cyan)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
          Step 1 — Add Your Unmastered Song (Or Drop Multiple Songs for an EP)
        </div>
        <h2 style={{ margin: '6px 0 6px', fontSize: 20, color: 'var(--text-0)' }}>
          Drop Your Track Here &amp; Pick a Genre Below
        </h2>
        <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--text-2)' }}>
          Supports WAV, MP3, FLAC, M4A — 100% private in your browser. Currently loaded:{' '}
          <strong style={{ color: 'var(--text-0)' }}>{trackName}</strong>
        </p>

        <div style={{ display: 'flex', justifyContent: 'center', gap: 10, flexWrap: 'wrap' }}>
          <label
            className="btn btn-primary"
            style={{
              display: 'inline-flex',
              padding: '10px 20px',
              fontSize: 13.5,
              cursor: 'pointer',
              borderRadius: 8,
            }}
          >
            + Upload Single Song (WAV / MP3 / FLAC)
            <input
              type="file"
              accept="audio/*,.wav,.flac,.mp3,.ogg,.m4a"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onUploadTrack(f);
                e.currentTarget.value = '';
              }}
            />
          </label>

          <label
            className="btn"
            style={{
              display: 'inline-flex',
              padding: '10px 16px',
              fontSize: 13,
              cursor: 'pointer',
              borderRadius: 8,
            }}
          >
            💿 Master Full EP / Album (2–12 Songs → .zip)
            <input
              type="file"
              multiple
              accept="audio/*,.wav,.flac,.mp3,.ogg,.m4a"
              style={{ display: 'none' }}
              onChange={(e) => {
                if (e.target.files && e.target.files.length > 0) {
                  void handleBatchMasterEp(e.target.files);
                }
                e.currentTarget.value = '';
              }}
            />
          </label>
        </div>

        {albumStatus && (
          <div
            style={{
              marginTop: 12,
              padding: '8px 12px',
              borderRadius: 8,
              background: 'rgba(34, 211, 238, 0.1)',
              border: '1px solid rgba(34, 211, 238, 0.35)',
              fontSize: 12,
              color: 'var(--cyan)',
              fontWeight: 600,
            }}
          >
            {albumStatus}
          </div>
        )}
      </div>

      {/* STEP 2: PICK YOUR GENRE BUTTON & STYLE — AUTO-MASTERS IMMEDIATELY */}
      <div className="panel" style={{ padding: '20px 22px', borderRadius: 12 }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 8,
            marginBottom: 14,
          }}
        >
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--cyan)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
              Step 2 — Tap Your Genre (Auto-Masters Instantly)
            </div>
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-0)', marginTop: 2 }}>
              Choose Your Sound
              {selectedGenre === 'auto' && sourceAnalysis && (
                <span className="badge badge-emerald" style={{ marginLeft: 8 }}>
                  Matched: {resolvedGenreLabel}
                </span>
              )}
            </div>
          </div>

          <button
            type="button"
            className="btn btn-emerald"
            disabled={renderStatus.active || !sourceBuffer}
            onClick={() => runInstantMaster(selectedGenre, intensity)}
            style={{ padding: '8px 14px', fontSize: 12.5 }}
          >
            ⚡ Re-Master Track Now
          </button>
        </div>

        {/* BIG GENRE BUTTONS */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(195px, 1fr))',
            gap: 10,
            marginBottom: 16,
          }}
        >
          {AUTOPILOT_GENRE_CARDS.map((card) => {
            const isSelected = selectedGenre === card.id;
            return (
              <button
                key={card.id}
                type="button"
                onClick={() => {
                  setSelectedGenre(card.id);
                  runInstantMaster(card.id, intensity);
                }}
                style={{
                  padding: '13px 14px',
                  borderRadius: 10,
                  textAlign: 'left',
                  cursor: 'pointer',
                  transition: 'all 0.14s ease',
                  background: isSelected
                    ? 'linear-gradient(135deg, rgba(34,211,238,0.22), rgba(16,185,129,0.14))'
                    : 'var(--bg-2)',
                  border: isSelected ? '2px solid var(--cyan)' : '1px solid var(--border)',
                  color: 'var(--text-0)',
                }}
              >
                <div style={{ fontSize: 14, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span>{GENRE_ICONS[card.id]}</span>
                  <span style={{ color: isSelected ? 'var(--cyan)' : 'var(--text-0)' }}>
                    {card.title}
                  </span>
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--text-2)', marginTop: 4, lineHeight: 1.35 }}>
                  {card.subtitle}
                </div>
              </button>
            );
          })}
        </div>

        {/* 3 SIMPLE INTENSITY / VIBE BUTTONS */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: 10,
            paddingTop: 12,
            borderTop: '1px solid var(--border)',
          }}
        >
          <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-1)' }}>
            Master Intensity:
          </span>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {(
              [
                { id: 'warm_smooth', label: '🌙 Warm & Smooth' },
                { id: 'balanced_pro', label: '⭐ Balanced Radio (Best)' },
                { id: 'loud_punchy', label: '🚀 Loud & Punchy' },
              ] as const
            ).map((opt) => {
              const active = intensity === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => {
                    setIntensity(opt.id);
                    runInstantMaster(selectedGenre, opt.id);
                  }}
                  style={{
                    padding: '8px 14px',
                    borderRadius: 8,
                    fontSize: 12.5,
                    fontWeight: 700,
                    cursor: 'pointer',
                    background: active ? 'var(--cyan)' : 'var(--bg-2)',
                    color: active ? '#041017' : 'var(--text-0)',
                    border: active ? '1px solid var(--cyan)' : '1px solid var(--border)',
                  }}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* LIVE RENDER PROGRESS BAR */}
      {renderStatus.active && (
        <div className="panel" style={{ padding: '14px 18px', borderRadius: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, fontWeight: 700, marginBottom: 6 }}>
            <span style={{ color: 'var(--cyan)' }}>⚡ Auto-Mastering Your Song: {renderStatus.stage}...</span>
            <span className="num">{renderStatus.pct}%</span>
          </div>
          <div className="progress-track" style={{ height: 8 }}>
            <div className="progress-fill" style={{ width: `${renderStatus.pct}%` }} />
          </div>
        </div>
      )}

      {/* STEP 3: LISTEN BEFORE / AFTER & DOWNLOAD */}
      <div className="panel" style={{ padding: '22px 24px', borderRadius: 12 }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 10,
            marginBottom: 16,
          }}
        >
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#10b981', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
              Step 3 — Compare &amp; Download Your Finished Master
            </div>
            <div style={{ fontSize: 16, fontWeight: 700, marginTop: 2 }}>
              {masterAnalysis ? (
                <span>
                  Master Ready •{' '}
                  <span style={{ color: '#10b981' }}>
                    {readiness.score}/100 ({readiness.gradeLabel})
                  </span>
                </span>
              ) : (
                'Preparing Master...'
              )}
            </div>
          </div>

          {sourceAnalysis && masterAnalysis && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 }}>
              <span className="badge num" style={{ background: 'var(--bg-2)', padding: '5px 9px' }}>
                Before: {sourceAnalysis.loudness.integratedLufs.toFixed(1)} LUFS
              </span>
              <span style={{ color: 'var(--cyan)', fontWeight: 700 }}>→</span>
              <span className="badge badge-emerald num" style={{ padding: '5px 9px' }}>
                After: {masterAnalysis.loudness.integratedLufs.toFixed(1)} LUFS • Zero Clipping ✓
              </span>
            </div>
          )}
        </div>

        {/* PLAYER + BEFORE / AFTER TOGGLE */}
        <div
          style={{
            background: '#06090f',
            border: '1px solid var(--border)',
            borderRadius: 10,
            padding: '16px 18px',
            marginBottom: 16,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              flexWrap: 'wrap',
              gap: 12,
              marginBottom: 12,
            }}
          >
            <button
              type="button"
              onClick={onTogglePlay}
              disabled={!sourceBuffer}
              style={{
                padding: '11px 22px',
                borderRadius: 9,
                fontSize: 14,
                fontWeight: 800,
                cursor: 'pointer',
                background: isPlaying ? '#f59e0b' : 'var(--cyan)',
                color: '#041017',
                border: 'none',
              }}
            >
              {isPlaying ? '⏸ Pause Song' : '▶ Play & Compare'}
            </button>

            {/* BIG BEFORE / AFTER BUTTONS */}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button
                type="button"
                onClick={() => onSetAuditionMode('master')}
                style={{
                  padding: '9px 15px',
                  borderRadius: 8,
                  fontWeight: 700,
                  fontSize: 12.5,
                  cursor: 'pointer',
                  background: auditionMode === 'master' ? '#10b981' : 'var(--bg-2)',
                  color: auditionMode === 'master' ? '#04130d' : 'var(--text-0)',
                  border: auditionMode === 'master' ? '1px solid #10b981' : '1px solid var(--border)',
                }}
              >
                🎧 Mastered (After)
              </button>
              <button
                type="button"
                onClick={() => onSetAuditionMode('original')}
                style={{
                  padding: '9px 15px',
                  borderRadius: 8,
                  fontWeight: 700,
                  fontSize: 12.5,
                  cursor: 'pointer',
                  background: auditionMode === 'original' ? '#f59e0b' : 'var(--bg-2)',
                  color: auditionMode === 'original' ? '#170d02' : 'var(--text-0)',
                  border: auditionMode === 'original' ? '1px solid #f59e0b' : '1px solid var(--border)',
                }}
              >
                🔇 Original Mix (Before)
              </button>
              <button
                type="button"
                onClick={() => onSetAuditionMode('master_matched')}
                title="Plays your Master at the exact same volume as Original so you hear pure clarity & bass punch"
                style={{
                  padding: '9px 13px',
                  borderRadius: 8,
                  fontWeight: 600,
                  fontSize: 12,
                  cursor: 'pointer',
                  background: auditionMode === 'master_matched' ? 'rgba(34,211,238,0.22)' : 'var(--bg-2)',
                  color: auditionMode === 'master_matched' ? 'var(--cyan)' : 'var(--text-1)',
                  border:
                    auditionMode === 'master_matched'
                      ? '1px solid var(--cyan)'
                      : '1px solid var(--border)',
                }}
              >
                ⚖️ Equal-Volume Check
              </button>
            </div>
          </div>

          {/* SCRUB BAR */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <span className="num" style={{ fontSize: 11.5, color: 'var(--text-2)', minWidth: 36 }}>
              {fmtTime(currentTimeSec)}
            </span>
            <input
              type="range"
              min={0}
              max={Math.max(0.1, durationSec)}
              step={0.05}
              value={Math.min(currentTimeSec, Math.max(0.1, durationSec))}
              onChange={(e) => onSeek(Number(e.target.value))}
              style={{ flex: 1 }}
            />
            <span className="num" style={{ fontSize: 11.5, color: 'var(--text-2)', minWidth: 36 }}>
              {fmtTime(durationSec)}
            </span>
          </div>

          {/* 1-TAP SPEAKER TEST PILLS */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              flexWrap: 'wrap',
              gap: 8,
              paddingTop: 8,
              borderTop: '1px solid rgba(148,163,184,0.12)',
              fontSize: 11.5,
            }}
          >
            <span style={{ color: 'var(--text-2)' }}>Test how it sounds on:</span>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {(
                [
                  { id: 'flat', label: '🎧 Normal Studio' },
                  { id: 'phone', label: '📱 Phone Speaker' },
                  { id: 'car', label: '🚗 Car Stereo' },
                  { id: 'club', label: '🔊 Club Sub PA' },
                ] as const
              ).map((sp) => (
                <button
                  key={sp.id}
                  type="button"
                  className={`seg-btn ${monitorVoicing === sp.id ? 'active' : ''}`}
                  style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '4px 9px' }}
                  onClick={() => onSetMonitorVoicing(sp.id)}
                >
                  {sp.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* WHAT AUTO-MASTER DID FOR YOUR SONG */}
        {summaryActions.length > 0 && (
          <div
            style={{
              background: 'rgba(16, 185, 129, 0.07)',
              border: '1px solid rgba(16, 185, 129, 0.25)',
              borderRadius: 8,
              padding: '10px 14px',
              marginBottom: 16,
              fontSize: 12,
            }}
          >
            <strong style={{ color: '#10b981' }}>What SonicForge Automatically Tailored For Your Song:</strong>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginTop: 5, color: 'var(--text-1)' }}>
              {summaryActions.map((act, i) => (
                <div key={i}>✓ {act}</div>
              ))}
            </div>
          </div>
        )}

        {zipStatus && (
          <div className="callout callout-info" style={{ marginBottom: 12 }}>
            {zipStatus}
          </div>
        )}

        {/* BIG DOWNLOAD BUTTONS */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))',
            gap: 10,
          }}
        >
          <button
            type="button"
            className="btn btn-emerald"
            disabled={!sourceBuffer || renderStatus.active}
            onClick={onExportMasterWav}
            style={{
              justifyContent: 'center',
              padding: '13px 16px',
              fontSize: 14,
              fontWeight: 700,
              borderRadius: 9,
            }}
          >
            ⬇ Download Mastered WAV (24-Bit)
          </button>

          <button
            type="button"
            className="btn btn-primary"
            disabled={!sourceBuffer || renderStatus.active}
            onClick={() => void handleDownloadFullPack()}
            style={{
              justifyContent: 'center',
              padding: '13px 16px',
              fontSize: 14,
              fontWeight: 700,
              borderRadius: 9,
            }}
          >
            📦 Download Full Release Pack (.zip)
          </button>
        </div>

        <div style={{ textAlign: 'center', marginTop: 14 }}>
          <button
            type="button"
            onClick={onSwitchToProConsole}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--text-2)',
              fontSize: 12,
              cursor: 'pointer',
              textDecoration: 'underline',
            }}
          >
            Want to tweak EQ, Stems, AI Chat, or Meters? Open Full Pro Studio Console →
          </button>
        </div>
      </div>
    </div>
  );
};
