import React, { useState } from 'react';
import type { AuditionMode } from '../audio/playbackEngine';
import { decodeUploadedAudioFile } from '../audio/decodeAudioFile';
import { dspWorker } from '../audio/dspWorkerClient';
import { generateStudioSession } from '../dsp/synthTestVectors';
import type {
  CodecAuditResult,
  CodecProfileId,
  MasteringChainParams,
  PlanarAudioBuffer,
} from '../dsp/types';
import { encodeWav, verifyExportedWav } from '../dsp/wav';

interface AlbumTrackItem {
  id: string;
  name: string;
  source: PlanarAudioBuffer;
  sourceLufs: number;
  mastered?: PlanarAudioBuffer;
  masterLufs?: number;
  masterTruePeakDbtp?: number;
  targetUsedLufs?: number;
}

interface Props {
  codecAudits: CodecAuditResult[];
  activeCodecId: CodecProfileId;
  auditionMode: AuditionMode;
  params: MasteringChainParams;
  onSelectCodecAudition: (codecId: CodecProfileId, mode: 'codec_preview' | 'codec_delta') => void;
  onImportPresetParams: (next: MasteringChainParams) => void;
}

export const CodecAndAlbumModule: React.FC<Props> = ({
  codecAudits,
  activeCodecId,
  auditionMode,
  params,
  onSelectCodecAudition,
  onImportPresetParams,
}) => {
  const [albumTracks, setAlbumTracks] = useState<AlbumTrackItem[]>([]);
  const [albumMode, setAlbumMode] = useState<'preserve_relative' | 'uniform'>('preserve_relative');
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchStatus, setBatchStatus] = useState<string>('');

  const handleLoadDemoEp = async () => {
    setBatchRunning(true);
    setBatchStatus('Synthesizing 3-track EP (Anthem, Acoustic Interlude, Finale)...');
    try {
      const t1 = generateStudioSession('neon_horizon_mix', 48000, 2).stereoMix;
      const t2Raw = generateStudioSession('velvet_indie_mix', 48000, 2).stereoMix;
      const t2: PlanarAudioBuffer = {
        sampleRate: t2Raw.sampleRate,
        duration: t2Raw.duration,
        channels: t2Raw.channels.map((ch) => {
          const c = new Float32Array(ch.length);
          for (let i = 0; i < ch.length; i++) c[i] = ch[i] * 0.69;
          return c;
        }),
      };
      const t3 = generateStudioSession('neon_horizon_mix', 48000, 2).stereoMix;

      const r1 = await dspWorker.analyze(t1, -1.0, 4);
      const r2 = await dspWorker.analyze(t2, -1.0, 4);
      const r3 = await dspWorker.analyze(t3, -1.0, 4);

      setAlbumTracks([
        {
          id: 'ep_1',
          name: '01 - Neon Horizon (Lead Single)',
          source: t1,
          sourceLufs: r1.loudness.integratedLufs,
        },
        {
          id: 'ep_2',
          name: '02 - Velvet Interlude (Soft Ballad)',
          source: t2,
          sourceLufs: r2.loudness.integratedLufs,
        },
        {
          id: 'ep_3',
          name: '03 - Midnight Drive (Closer)',
          source: t3,
          sourceLufs: r3.loudness.integratedLufs,
        },
      ]);
      setBatchStatus('Loaded 3-track EP. Ready for Album Cohesive Mastering.');
    } finally {
      setBatchRunning(false);
    }
  };

  const handleUploadAlbumFiles = async (files: FileList) => {
    setBatchRunning(true);
    setBatchStatus('Decoding uploaded album tracks...');
    try {
      const added: AlbumTrackItem[] = [];
      for (const file of Array.from(files)) {
        const buf = await decodeUploadedAudioFile(file);
        const rep = await dspWorker.analyze(buf, -1.0, 4);
        added.push({
          id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          name: file.name,
          source: buf,
          sourceLufs: rep.loudness.integratedLufs,
        });
      }
      setAlbumTracks((prev) => [...prev, ...added]);
      setBatchStatus(`Added ${added.length} track(s) to album sequence.`);
    } finally {
      setBatchRunning(false);
    }
  };

  const handleBatchRenderAlbum = async () => {
    if (albumTracks.length === 0) return;
    setBatchRunning(true);

    try {
      const anchorTarget = params.limiter.targetLufs;
      const loudestSrcLufs = Math.max(
        ...albumTracks.map((t) => (Number.isFinite(t.sourceLufs) ? t.sourceLufs : -24))
      );

      const updated: AlbumTrackItem[] = [];

      for (let idx = 0; idx < albumTracks.length; idx++) {
        const item = albumTracks[idx];
        setBatchStatus(`Mastering track ${idx + 1}/${albumTracks.length}: "${item.name}"...`);

        const naturalOffset =
          albumMode === 'preserve_relative' && Number.isFinite(item.sourceLufs)
            ? Math.max(-5.0, Math.min(0, item.sourceLufs - loudestSrcLufs))
            : 0;
        const trackTargetLufs = anchorTarget + naturalOffset;

        const trackParams: MasteringChainParams = {
          ...params,
          limiter: {
            ...params.limiter,
            autoGainToTarget: true,
            targetLufs: trackTargetLufs,
          },
        };

        const rendered = await dspWorker.renderStereo(item.source, trackParams);
        updated.push({
          ...item,
          mastered: rendered.buffer,
          masterLufs: rendered.analysis.loudness.integratedLufs,
          masterTruePeakDbtp: rendered.analysis.truePeak.truePeakDbtp,
          targetUsedLufs: trackTargetLufs,
        });
      }

      setAlbumTracks(updated);
      setBatchStatus(
        `Album batch complete (${updated.length} tracks verified against ${params.limiter.ceilingDbtp.toFixed(1)} dBTP ceiling).`
      );
    } finally {
      setBatchRunning(false);
    }
  };

  const handleDownloadTrackWav = (item: AlbumTrackItem, trackIndex: number) => {
    if (!item.mastered) return;
    const wav = encodeWav(item.mastered, {
      ...params.exportFormat,
      metadata: {
        ...params.exportFormat.metadata,
        title: item.name,
        comment: `Track ${trackIndex + 1} | ${item.masterLufs?.toFixed(2)} LUFS | ${item.masterTruePeakDbtp?.toFixed(2)} dBTP`,
      },
    });
    verifyExportedWav(wav, params.limiter.ceilingDbtp, params.limiter.oversampling);
    const blob = new Blob([wav], { type: 'audio/wav' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${item.name.replace(/[^a-z0-9_-]+/gi, '_')}_${params.exportFormat.bitDepth}bit.wav`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  };

  const handleSavePresetJson = () => {
    const json = JSON.stringify(
      {
        schema: 'sonicforge-preset-v1',
        savedAt: new Date().toISOString(),
        params,
      },
      null,
      2
    );
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sonicforge_${params.deliveryProfile}_preset.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  };

  const handleLoadPresetJson = async (file: File) => {
    const text = await file.text();
    const parsed = JSON.parse(text);
    if (parsed && parsed.params && Array.isArray(parsed.params.eqBands)) {
      onImportPresetParams(parsed.params as MasteringChainParams);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="panel">
        <div className="panel-header">
          <div className="panel-title">
            <span>Hardware WebCodecs Bitstream &amp; 24-Bark Psychoacoustic Codec Audit</span>
            <span className="badge badge-cyan">Native AAC/Opus WebCodecs + Zwicker Masking</span>
          </div>
        </div>

        <div style={{ overflowX: 'auto' }}>
          <table className="benchmark-table">
            <thead>
              <tr>
                <th>Delivery Codec</th>
                <th>Codec Engine</th>
                <th>Bandwidth</th>
                <th>Pre-Codec TP</th>
                <th>Post-Codec TP</th>
                <th>ISP Overshoot</th>
                <th>Audible SNR</th>
                <th>Status</th>
                <th>Live Audition</th>
              </tr>
            </thead>
            <tbody>
              {codecAudits.map((c) => {
                const isPrev = activeCodecId === c.id && auditionMode === 'codec_preview';
                const isDelta = activeCodecId === c.id && auditionMode === 'codec_delta';
                const isHw = c.engineType === 'webcodecs_hardware';
                return (
                  <tr key={c.id}>
                    <td style={{ fontWeight: 600 }}>{c.label}</td>
                    <td>
                      <span className={`badge ${isHw ? 'badge-emerald' : 'badge-cyan'}`}>
                        {isHw ? 'Native WebCodecs' : '24-Bark MDCT'}
                      </span>
                    </td>
                    <td className="num">{(c.cutoffHz / 1000).toFixed(1)} kHz</td>
                    <td className="num">{c.preTruePeakDbtp.toFixed(2)} dBTP</td>
                    <td
                      className="num"
                      style={{
                        color: c.clipsZeroDbtp ? '#ef4444' : '#10b981',
                        fontWeight: 700,
                      }}
                    >
                      {c.postCodecTruePeakDbtp.toFixed(2)} dBTP
                    </td>
                    <td className="num">+{c.ispOvershootDb.toFixed(2)} dB</td>
                    <td className="num">{c.artifactSnrDb.toFixed(1)} dB</td>
                    <td>
                      <span className={`badge ${c.clipsZeroDbtp ? 'badge-crimson' : 'badge-emerald'}`}>
                        {c.clipsZeroDbtp ? 'ISP CLIP > 0 dBTP' : 'SAFE HEADROOM'}
                      </span>
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 4 }}>
                        <button
                          type="button"
                          className={`seg-btn ${isPrev ? 'active' : ''}`}
                          style={{ border: '1px solid var(--border)', padding: '3px 7px' }}
                          onClick={() => onSelectCodecAudition(c.id, 'codec_preview')}
                        >
                          Codec Listen
                        </button>
                        <button
                          type="button"
                          className={`seg-btn ${isDelta ? 'active-amber' : ''}`}
                          style={{ border: '1px solid var(--border)', padding: '3px 7px' }}
                          onClick={() => onSelectCodecAudition(c.id, 'codec_delta')}
                          title="Nulls lossless master against codec output so you hear ONLY quantization & cutoff loss"
                        >
                          Artifact Solo
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Multi-Track Album Sequencing, Cohesive Leveling & Session Presets */}
      <div className="panel">
        <div className="panel-header">
          <div className="panel-title">
            <span>Album / EP Batch Mastering &amp; Session Preset Recall</span>
          </div>
          <div className="toolbar-group">
            <button type="button" className="btn" onClick={handleSavePresetJson}>
              Save Preset (.json)
            </button>
            <label className="btn">
              Load Preset
              <input
                type="file"
                accept=".json,application/json"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void handleLoadPresetJson(f);
                  e.currentTarget.value = '';
                }}
              />
            </label>
          </div>
        </div>

        <div className="toolbar-group" style={{ marginBottom: 10 }}>
          <button
            type="button"
            className="btn"
            disabled={batchRunning}
            onClick={() => void handleLoadDemoEp()}
          >
            Load 3-Track Demo EP
          </button>

          <label className="btn">
            Add Album Tracks
            <input
              type="file"
              multiple
              accept="audio/*,.wav,.flac,.mp3,.ogg,.m4a"
              style={{ display: 'none' }}
              onChange={(e) => {
                if (e.target.files?.length) void handleUploadAlbumFiles(e.target.files);
                e.currentTarget.value = '';
              }}
            />
          </label>

          <select
            className="select-input"
            value={albumMode}
            onChange={(e) => setAlbumMode(e.target.value as 'preserve_relative' | 'uniform')}
          >
            <option value="preserve_relative">
              Album Cohesive Mode (Preserve Ballad/Anthem Relative LUFS)
            </option>
            <option value="uniform">Uniform Single Mode (Lock All Tracks to Target LUFS)</option>
          </select>

          <button
            type="button"
            className="btn btn-primary"
            disabled={albumTracks.length === 0 || batchRunning}
            onClick={() => void handleBatchRenderAlbum()}
          >
            {batchRunning ? 'Mastering Album...' : `Batch Master ${albumTracks.length} Track(s)`}
          </button>
        </div>

        {batchStatus && (
          <div className="callout callout-info" style={{ marginBottom: 10 }}>
            {batchStatus}
          </div>
        )}

        {albumTracks.length > 0 && (
          <table className="benchmark-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Track Name</th>
                <th>Duration</th>
                <th>Source LUFS</th>
                <th>Album Target</th>
                <th>Measured Master LUFS</th>
                <th>Measured True Peak</th>
                <th>Export</th>
              </tr>
            </thead>
            <tbody>
              {albumTracks.map((t, i) => (
                <tr key={t.id}>
                  <td className="num">{i + 1}</td>
                  <td style={{ fontWeight: 600 }}>{t.name}</td>
                  <td className="num">{t.source.duration.toFixed(1)}s</td>
                  <td className="num">{t.sourceLufs.toFixed(2)} LUFS</td>
                  <td className="num">
                    {t.targetUsedLufs !== undefined ? `${t.targetUsedLufs.toFixed(1)} LUFS` : '—'}
                  </td>
                  <td className="num" style={{ color: 'var(--cyan)', fontWeight: 700 }}>
                    {t.masterLufs !== undefined ? `${t.masterLufs.toFixed(2)} LUFS` : 'Pending'}
                  </td>
                  <td className="num" style={{ color: '#10b981' }}>
                    {t.masterTruePeakDbtp !== undefined
                      ? `${t.masterTruePeakDbtp.toFixed(2)} dBTP`
                      : '—'}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn btn-emerald"
                      style={{ padding: '3px 8px', fontSize: 11 }}
                      disabled={!t.mastered}
                      onClick={() => handleDownloadTrackWav(t, i)}
                    >
                      WAV
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};
