import React from 'react';
import type {
  ExportFormatParams,
  LimiterParams,
  WavMetadata,
  WavVerificationReport,
} from '../dsp/types';

interface Props {
  limiter: LimiterParams;
  exportFormat: ExportFormatParams;
  appliedDriveDb: number;
  autoDriveCapped: boolean;
  maxGainReductionDb: number;
  lastWavVerification: WavVerificationReport | null;
  onChangeLimiter: (next: LimiterParams) => void;
  onChangeExportFormat: (next: ExportFormatParams) => void;
  onExportWav: () => void;
}

export const LimiterExportModule: React.FC<Props> = ({
  limiter,
  exportFormat,
  appliedDriveDb,
  autoDriveCapped,
  maxGainReductionDb,
  lastWavVerification,
  onChangeLimiter,
  onChangeExportFormat,
  onExportWav,
}) => {
  const meta: WavMetadata = exportFormat.metadata ?? {};

  const updateMeta = (patch: Partial<WavMetadata>) => {
    onChangeExportFormat({
      ...exportFormat,
      metadata: { ...meta, ...patch },
    });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="panel">
        <div className="panel-header">
          <div className="panel-title">
            <span>IRC-V Transient/Sustain Split Oversampled True-Peak Maximizer</span>
            <span className="badge badge-cyan">
              {limiter.oversampling}x Polyphase Kaiser-Sinc Sidechain
            </span>
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input
              type="checkbox"
              checked={limiter.enabled}
              onChange={(e) => onChangeLimiter({ ...limiter, enabled: e.target.checked })}
            />
            <span style={{ fontWeight: 600 }}>Brickwall Active</span>
          </label>
        </div>

        {autoDriveCapped && (
          <div className="callout callout-warn" style={{ marginBottom: 10 }}>
            <strong>Dynamic Preservation Guard Triggered:</strong> Reaching{' '}
            {limiter.targetLufs.toFixed(1)} LUFS from this quiet source exceeded the safe +
            {limiter.maxAutoDriveDb.toFixed(1)} dB auto-drive cap. Drive was capped at +
            {appliedDriveDb.toFixed(1)} dB to prevent distortion.
          </div>
        )}

        <div className="param-grid">
          <div className="param-card">
            <div className="param-row">
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 5,
                  color: 'var(--text-0)',
                  fontWeight: 700,
                }}
              >
                <input
                  type="checkbox"
                  checked={limiter.autoGainToTarget}
                  onChange={(e) =>
                    onChangeLimiter({ ...limiter, autoGainToTarget: e.target.checked })
                  }
                />
                Closed-Loop Target LUFS
              </label>
              <span className="param-val">{limiter.targetLufs.toFixed(1)} LUFS</span>
            </div>
            <input
              type="range"
              min={-26}
              max={-6}
              step={0.5}
              disabled={!limiter.autoGainToTarget}
              value={limiter.targetLufs}
              onChange={(e) =>
                onChangeLimiter({ ...limiter, targetLufs: Number(e.target.value) })
              }
            />

            <div className="param-row">
              <span>Max Auto-Drive Safety Cap</span>
              <span className="param-val">+{limiter.maxAutoDriveDb.toFixed(1)} dB</span>
            </div>
            <input
              type="range"
              min={3}
              max={18}
              step={0.5}
              disabled={!limiter.autoGainToTarget}
              value={limiter.maxAutoDriveDb}
              onChange={(e) =>
                onChangeLimiter({ ...limiter, maxAutoDriveDb: Number(e.target.value) })
              }
            />
          </div>

          <div className="param-card">
            <div className="param-row">
              <span>Manual Drive / Trim Offset</span>
              <span className="param-val">
                {limiter.manualDriveDb >= 0 ? '+' : ''}
                {limiter.manualDriveDb.toFixed(1)} dB
              </span>
            </div>
            <input
              type="range"
              min={-12}
              max={15}
              step={0.1}
              value={limiter.manualDriveDb}
              onChange={(e) =>
                onChangeLimiter({ ...limiter, manualDriveDb: Number(e.target.value) })
              }
            />

            <div className="param-row">
              <span>True-Peak Brickwall Ceiling</span>
              <span className="param-val" style={{ color: 'var(--cyan)' }}>
                {limiter.ceilingDbtp.toFixed(2)} dBTP
              </span>
            </div>
            <input
              type="range"
              min={-3.0}
              max={-0.1}
              step={0.05}
              value={limiter.ceilingDbtp}
              onChange={(e) =>
                onChangeLimiter({ ...limiter, ceilingDbtp: Number(e.target.value) })
              }
            />
          </div>

          <div className="param-card">
            <div className="param-row">
              <span>Maximizer Algorithm</span>
              <select
                className="select-input"
                value={limiter.releaseMode}
                onChange={(e) =>
                  onChangeLimiter({
                    ...limiter,
                    releaseMode: e.target.value as LimiterParams['releaseMode'],
                  })
                }
              >
                <option value="irc_transient">IRC-V Transient/Sustain Split</option>
                <option value="transparent">IRC Transparent Dual-Release</option>
                <option value="punchy">Modern Punch Fast Recovery</option>
                <option value="dynamic">Dynamic Safe Sustain</option>
              </select>
            </div>

            <div className="param-row">
              <span>Transient Punch Emphasis</span>
              <span className="param-val">
                {limiter.transientEmphasisPct >= 0 ? '+' : ''}
                {limiter.transientEmphasisPct}%
              </span>
            </div>
            <input
              type="range"
              min={-40}
              max={100}
              step={5}
              value={limiter.transientEmphasisPct}
              onChange={(e) =>
                onChangeLimiter({
                  ...limiter,
                  transientEmphasisPct: Number(e.target.value),
                })
              }
            />

            <div className="param-row">
              <span>Lookahead / Oversampling</span>
              <div style={{ display: 'flex', gap: 5 }}>
                <span className="param-val">{limiter.lookaheadMs.toFixed(1)} ms</span>
                <select
                  className="select-input"
                  style={{ padding: '2px 5px', fontSize: 10.5 }}
                  value={limiter.oversampling}
                  onChange={(e) =>
                    onChangeLimiter({
                      ...limiter,
                      oversampling: Number(e.target.value) as 4 | 8,
                    })
                  }
                >
                  <option value={4}>4x ITU</option>
                  <option value={8}>8x Ultra</option>
                </select>
              </div>
            </div>
            <input
              type="range"
              min={1.5}
              max={10.0}
              step={0.5}
              value={limiter.lookaheadMs}
              onChange={(e) =>
                onChangeLimiter({ ...limiter, lookaheadMs: Number(e.target.value) })
              }
            />
          </div>
        </div>

        <div
          style={{
            marginTop: 10,
            display: 'flex',
            gap: 18,
            fontSize: 12,
            color: 'var(--text-1)',
          }}
        >
          <span>
            Applied Limiter Drive:{' '}
            <strong className="num">
              {appliedDriveDb >= 0 ? '+' : ''}
              {appliedDriveDb.toFixed(2)} dB
            </strong>
          </span>
          <span>
            Measured Max Gain Reduction:{' '}
            <strong className="num" style={{ color: '#f59e0b' }}>
              -{maxGainReductionDb.toFixed(2)} dB
            </strong>
          </span>
        </div>
      </div>

      {/* Export, TPDF Dither & RIFF INFO Mastering Metadata */}
      <div className="panel">
        <div className="panel-header">
          <div className="panel-title">
            <span>Lossless WAV Export, Noise-Shaped TPDF Dither &amp; RIFF INFO Metadata</span>
          </div>
          <button type="button" className="btn btn-primary" onClick={onExportWav}>
            Export &amp; Verify Master WAV
          </button>
        </div>

        <div className="param-grid" style={{ marginBottom: 10 }}>
          <div className="param-card">
            <div className="param-row">
              <span>PCM Bit Depth</span>
              <select
                className="select-input"
                value={exportFormat.bitDepth}
                onChange={(e) => {
                  const bitDepth = Number(e.target.value) as 16 | 24 | 32;
                  onChangeExportFormat({
                    ...exportFormat,
                    bitDepth,
                    dither:
                      bitDepth === 32
                        ? 'none'
                        : exportFormat.dither === 'none'
                          ? 'tpdf_shaped'
                          : exportFormat.dither,
                  });
                }}
              >
                <option value={24}>24-bit Signed PCM (Mastering Standard)</option>
                <option value={16}>16-bit Signed PCM (CD / Red Book)</option>
                <option value={32}>32-bit IEEE Float (Archival / DAW)</option>
              </select>
            </div>

            <div className="param-row">
              <span>Quantization Dither</span>
              <select
                className="select-input"
                disabled={exportFormat.bitDepth === 32}
                value={exportFormat.bitDepth === 32 ? 'none' : exportFormat.dither}
                onChange={(e) =>
                  onChangeExportFormat({
                    ...exportFormat,
                    dither: e.target.value as ExportFormatParams['dither'],
                  })
                }
              >
                <option value="tpdf_shaped">Noise-Shaped TPDF (High-Pass Error Feedback)</option>
                <option value="tpdf">Flat TPDF Triangular Dither</option>
                <option value="none">Truncate (None)</option>
              </select>
            </div>
          </div>

          <div className="param-card">
            <div className="param-row">
              <span>Track Title (INAM)</span>
            </div>
            <input
              className="select-input"
              placeholder="Track Title"
              value={meta.title ?? ''}
              onChange={(e) => updateMeta({ title: e.target.value })}
            />
            <div className="param-row">
              <span>Artist (IART)</span>
            </div>
            <input
              className="select-input"
              placeholder="Artist / Producer"
              value={meta.artist ?? ''}
              onChange={(e) => updateMeta({ artist: e.target.value })}
            />
          </div>

          <div className="param-card">
            <div className="param-row">
              <span>Album / Release (IPRD)</span>
            </div>
            <input
              className="select-input"
              placeholder="Album or EP Name"
              value={meta.album ?? ''}
              onChange={(e) => updateMeta({ album: e.target.value })}
            />
            <div className="param-row">
              <span>ISRC Code (ISRC)</span>
            </div>
            <input
              className="select-input num"
              placeholder="ZA-A01-26-00001"
              maxLength={15}
              value={meta.isrc ?? ''}
              onChange={(e) => updateMeta({ isrc: e.target.value })}
            />
          </div>
        </div>

        {lastWavVerification && (
          <div className="callout callout-ok">
            <strong>Independent Post-Encode RIFF/WAVE Verification Receipt:</strong>{' '}
            {lastWavVerification.bitDepth}-bit{' '}
            {lastWavVerification.formatCode === 3 ? 'IEEE Float' : 'PCM'} •{' '}
            {(lastWavVerification.sampleRate / 1000).toFixed(1)} kHz • {lastWavVerification.channels}ch •{' '}
            {(lastWavVerification.byteLength / (1024 * 1024)).toFixed(2)} MB • RIFF INFO Chunk:{' '}
            {lastWavVerification.hasInfoMetadata ? 'Embedded' : 'None'} • NaN/Inf:{' '}
            {lastWavVerification.hasNaNOrInf ? 'FAIL' : '0 (Clean)'} • Decoded Integrated:{' '}
            <strong className="num">
              {lastWavVerification.measuredIntegratedLufs.toFixed(2)} LUFS
            </strong>{' '}
            • Decoded True Peak:{' '}
            <strong className="num">
              {lastWavVerification.measuredTruePeakDbtp.toFixed(2)} dBTP
            </strong>{' '}
            ({lastWavVerification.ceilingCompliant ? 'CEILING VERIFIED PASS' : 'OVER CEILING'})
          </div>
        )}
      </div>
    </div>
  );
};
