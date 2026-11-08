import React from 'react';
import type {
  AudioAnalysisReport,
  PlanarAudioBuffer,
  StemBusParams,
  StemSlotId,
} from '../dsp/types';

interface Props {
  stems: Partial<Record<StemSlotId, PlanarAudioBuffer>>;
  stemNames: Partial<Record<StemSlotId, string>>;
  stemReports: Partial<Record<StemSlotId, AudioAnalysisReport>>;
  busParams: Record<StemSlotId, StemBusParams>;
  alignmentWarnings: string[];
  demixNullDb: number | null;
  hasStereoSource: boolean;
  onUploadStem: (slot: StemSlotId, file: File) => void;
  onUpdateBus: (slot: StemSlotId, patch: Partial<StemBusParams>) => void;
  onRenderStems: () => void;
  onDemixStereoToStems: () => void;
}

const SLOTS: StemSlotId[] = ['drums', 'bass', 'vocals', 'instruments'];

export const StemConsoleModule: React.FC<Props> = ({
  stems,
  stemNames,
  stemReports,
  busParams,
  alignmentWarnings,
  demixNullDb,
  hasStereoSource,
  onUploadStem,
  onUpdateBus,
  onRenderStems,
  onDemixStereoToStems,
}) => {
  return (
    <div className="panel">
      <div className="panel-header">
        <div className="panel-title">
          <span>4-Bus Multi-Stem Console &amp; Local HPSS+M/S Demixer</span>
          {demixNullDb !== null && (
            <span className="badge badge-emerald num">
              Partition-of-Unity Sum Null: {demixNullDb.toFixed(1)} dB
            </span>
          )}
        </div>
        <div className="toolbar-group">
          <button
            type="button"
            className="btn btn-emerald"
            disabled={!hasStereoSource}
            onClick={onDemixStereoToStems}
            title="Decomposes the active stereo mix locally in your browser using 75% COLA STFT Harmonic-Percussive + Mid/Side + Sub masks"
          >
            Extract 4 Stems Locally from Stereo Mix
          </button>
          <button type="button" className="btn btn-primary" onClick={onRenderStems}>
            Sum Stems &amp; Render Master
          </button>
        </div>
      </div>

      <div className="callout callout-info" style={{ marginBottom: 10 }}>
        <strong>Dual Stem Workflow:</strong> Load discrete studio stems directly into each bus OR
        click <strong>Extract 4 Stems Locally</strong> to decompose any 2-channel stereo mix via our
        in-browser 75%-COLA STFT Harmonic-Percussive + Azimuthal Mid/Side Partition-of-Unity demixer
        (guaranteed lossless reconstruction when summed at unity, zero cloud upload).
      </div>

      {alignmentWarnings.length > 0 && (
        <div className="callout callout-warn" style={{ marginBottom: 10 }}>
          {alignmentWarnings.map((w, i) => (
            <div key={i}>• {w}</div>
          ))}
        </div>
      )}

      <div className="param-grid">
        {SLOTS.map((slot) => {
          const cfg = busParams[slot];
          const buf = stems[slot];
          const rep = stemReports[slot];

          return (
            <div key={slot} className={`param-card ${cfg.mute ? 'disabled' : ''}`}>
              <div className="param-row">
                <strong style={{ color: 'var(--text-0)', fontSize: 12.5 }}>{cfg.label}</strong>
                <div style={{ display: 'flex', gap: 4 }}>
                  <button
                    type="button"
                    className={`seg-btn ${cfg.solo ? 'active-amber' : ''}`}
                    style={{ border: '1px solid var(--border)', padding: '2px 6px' }}
                    onClick={() => onUpdateBus(slot, { solo: !cfg.solo })}
                  >
                    S
                  </button>
                  <button
                    type="button"
                    className={`seg-btn ${cfg.mute ? 'active' : ''}`}
                    style={{ border: '1px solid var(--border)', padding: '2px 6px' }}
                    onClick={() => onUpdateBus(slot, { mute: !cfg.mute })}
                  >
                    M
                  </button>
                </div>
              </div>

              <div
                style={{
                  fontSize: 11,
                  color: 'var(--cyan)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {buf
                  ? `${stemNames[slot] || slot} (${buf.duration.toFixed(1)}s @ ${(buf.sampleRate / 1000).toFixed(1)}k)`
                  : 'No stem loaded'}
              </div>

              {rep && (
                <div className="param-row" style={{ fontSize: 10.5 }}>
                  <span>Measured Stem</span>
                  <span className="num">
                    {Number.isFinite(rep.loudness.integratedLufs)
                      ? `${rep.loudness.integratedLufs.toFixed(1)} LUFS`
                      : '-∞'}{' '}
                    / {rep.truePeak.truePeakDbtp.toFixed(1)} dBTP
                  </span>
                </div>
              )}

              <label
                className="btn"
                style={{ justifyContent: 'center', fontSize: 11, padding: '4px 8px' }}
              >
                Load {slot.toUpperCase()} File
                <input
                  type="file"
                  accept="audio/*,.wav,.flac,.mp3,.ogg,.m4a"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) onUploadStem(slot, f);
                    e.currentTarget.value = '';
                  }}
                />
              </label>

              <div className="param-row">
                <span>Bus Fader</span>
                <span className="param-val">
                  {cfg.gainDb >= 0 ? '+' : ''}
                  {cfg.gainDb.toFixed(1)} dB
                </span>
              </div>
              <input
                type="range"
                min={-24}
                max={12}
                step={0.2}
                value={cfg.gainDb}
                onChange={(e) => onUpdateBus(slot, { gainDb: Number(e.target.value) })}
              />

              <div className="param-row">
                <span>Pan / Width</span>
                <span className="param-val">
                  {cfg.pan === 0
                    ? 'C'
                    : cfg.pan < 0
                      ? `L${Math.round(Math.abs(cfg.pan) * 100)}`
                      : `R${Math.round(cfg.pan * 100)}`}{' '}
                  • {cfg.widthPct}%
                </span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                <input
                  type="range"
                  min={-1}
                  max={1}
                  step={0.02}
                  value={cfg.pan}
                  onChange={(e) => onUpdateBus(slot, { pan: Number(e.target.value) })}
                />
                <input
                  type="range"
                  min={0}
                  max={180}
                  value={cfg.widthPct}
                  onChange={(e) => onUpdateBus(slot, { widthPct: Number(e.target.value) })}
                />
              </div>

              <div className="param-row">
                <span>Low / Mid / High EQ</span>
                <span className="param-val">
                  {cfg.lowShelfDb.toFixed(1)} / {cfg.midBellDb.toFixed(1)} /{' '}
                  {cfg.highShelfDb.toFixed(1)} dB
                </span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 4 }}>
                <input
                  type="range"
                  min={-9}
                  max={9}
                  step={0.5}
                  value={cfg.lowShelfDb}
                  onChange={(e) => onUpdateBus(slot, { lowShelfDb: Number(e.target.value) })}
                />
                <input
                  type="range"
                  min={-9}
                  max={9}
                  step={0.5}
                  value={cfg.midBellDb}
                  onChange={(e) => onUpdateBus(slot, { midBellDb: Number(e.target.value) })}
                />
                <input
                  type="range"
                  min={-9}
                  max={9}
                  step={0.5}
                  value={cfg.highShelfDb}
                  onChange={(e) => onUpdateBus(slot, { highShelfDb: Number(e.target.value) })}
                />
              </div>

              <div className="param-row">
                <span>HPF / Glue Comp</span>
                <span className="param-val">
                  {cfg.hpfHz} Hz • {cfg.compAmountPct}%
                </span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                <input
                  type="range"
                  min={20}
                  max={220}
                  value={cfg.hpfHz}
                  onChange={(e) => onUpdateBus(slot, { hpfHz: Number(e.target.value) })}
                />
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={cfg.compAmountPct}
                  onChange={(e) => onUpdateBus(slot, { compAmountPct: Number(e.target.value) })}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
