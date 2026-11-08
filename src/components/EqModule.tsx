import React, { useMemo } from 'react';
import { evaluateEqCurveDb } from '../dsp/biquad';
import type {
  EqBandParams,
  EqPhaseMode,
  EqPlacement,
  StabilizerParams,
} from '../dsp/types';

interface Props {
  enabled: boolean;
  phaseMode: EqPhaseMode;
  bands: EqBandParams[];
  stabilizer: StabilizerParams;
  stabilizerAttenuationDb: number[];
  sampleRate: number;
  onToggleModule: (enabled: boolean) => void;
  onChangePhaseMode: (mode: EqPhaseMode) => void;
  onUpdateBand: (index: number, patch: Partial<EqBandParams>) => void;
  onChangeStabilizer: (next: StabilizerParams) => void;
}

const PLOT_FREQS = Array.from({ length: 120 }, (_, i) => 20 * Math.pow(20000 / 20, i / 119));

export const EqModule: React.FC<Props> = ({
  enabled,
  phaseMode,
  bands,
  stabilizer,
  stabilizerAttenuationDb,
  sampleRate,
  onToggleModule,
  onChangePhaseMode,
  onUpdateBand,
  onChangeStabilizer,
}) => {
  const width = 820;
  const height = 140;

  const { stereoCurve, midCurve, sideCurve } = useMemo(() => {
    const sr = sampleRate || 48000;
    return {
      stereoCurve: evaluateEqCurveDb(bands, PLOT_FREQS, sr),
      midCurve: evaluateEqCurveDb(bands, PLOT_FREQS, sr, 'mid'),
      sideCurve: evaluateEqCurveDb(bands, PLOT_FREQS, sr, 'side'),
    };
  }, [bands, sampleRate]);

  const toPath = (dbs: number[]) =>
    dbs
      .map((db, idx) => {
        const x = (idx / (dbs.length - 1)) * width;
        const clamped = Math.max(-14, Math.min(14, db));
        const y = ((14 - clamped) / 28) * height;
        return `${idx === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');

  const stabPath =
    stabilizer.enabled && stabilizerAttenuationDb.length > 0
      ? stabilizerAttenuationDb
          .map((redDb, idx) => {
            const x = (idx / Math.max(1, stabilizerAttenuationDb.length - 1)) * width;
            const y = ((14 - -Math.min(14, redDb)) / 28) * height;
            return `${idx === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
          })
          .join(' ')
      : '';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="panel">
        <div className="panel-header">
          <div className="panel-title">
            <span>6-Band Dynamic M/S Mastering EQ</span>
            <span className="badge badge-cyan">
              {phaseMode === 'linear'
                ? '2049-Tap Zero-Phase Linear FIR + Live <3ms Preview'
                : '64-Bit Minimum-Phase RBJ IIR + Live <3ms Preview'}
            </span>
          </div>

          <div className="toolbar-group">
            <div className="segmented">
              <button
                type="button"
                className={`seg-btn ${phaseMode === 'linear' ? 'active' : ''}`}
                onClick={() => onChangePhaseMode('linear')}
                title="2049-tap Blackman-Harris overlap-add FFT FIR — zero phase rotation"
              >
                Linear Phase FIR
              </button>
              <button
                type="button"
                className={`seg-btn ${phaseMode === 'minimum' ? 'active' : ''}`}
                onClick={() => onChangePhaseMode('minimum')}
                title="64-bit RBJ analog-modeled minimum-phase cascade — zero pre-ringing"
              >
                Minimum Phase IIR
              </button>
            </div>

            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => onToggleModule(e.target.checked)}
              />
              <span style={{ fontWeight: 600 }}>EQ Active</span>
            </label>
          </div>
        </div>

        <div
          style={{
            background: '#05070b',
            border: '1px solid var(--border)',
            borderRadius: 7,
            marginBottom: 12,
            padding: '6px 6px 4px',
          }}
        >
          <svg
            viewBox={`0 0 ${width} ${height}`}
            style={{ width: '100%', height: 136, display: 'block' }}
          >
            {[-12, -6, 0, 6, 12].map((db) => {
              const y = ((14 - db) / 28) * height;
              return (
                <g key={db}>
                  <line
                    x1={0}
                    y1={y}
                    x2={width}
                    y2={y}
                    stroke={db === 0 ? 'rgba(148,163,184,0.28)' : 'rgba(148,163,184,0.09)'}
                    strokeWidth={1}
                  />
                  <text x={5} y={y - 2} fill="#64748b" fontSize={9}>
                    {db > 0 ? `+${db}` : db} dB
                  </text>
                </g>
              );
            })}
            {enabled && (
              <>
                <path
                  d={toPath(midCurve)}
                  fill="none"
                  stroke="#10b981"
                  strokeWidth={1.4}
                  opacity={0.75}
                />
                <path
                  d={toPath(sideCurve)}
                  fill="none"
                  stroke="#a78bfa"
                  strokeWidth={1.4}
                  opacity={0.75}
                />
                <path d={toPath(stereoCurve)} fill="none" stroke="#22d3ee" strokeWidth={2.2} />
              </>
            )}
            {stabPath && (
              <path
                d={stabPath}
                fill="none"
                stroke="#f59e0b"
                strokeWidth={1.9}
                strokeDasharray="4 2"
              />
            )}
          </svg>
          <div style={{ fontSize: 10.5, color: 'var(--text-2)', padding: '2px 6px' }}>
            <span style={{ color: '#22d3ee' }}>━ Composite EQ</span> &nbsp;&nbsp;
            <span style={{ color: '#10b981' }}>━ Mid EQ</span> &nbsp;&nbsp;
            <span style={{ color: '#a78bfa' }}>━ Side EQ</span> &nbsp;&nbsp;
            <span style={{ color: '#f59e0b' }}>┅ Dynamic Spectral Stabilizer Attenuation</span>
          </div>
        </div>

        <div className="param-grid">
          {bands.map((band, idx) => (
            <div
              key={band.id}
              className={`param-card ${!band.enabled || !enabled ? 'disabled' : ''}`}
            >
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
                    checked={band.enabled}
                    onChange={(e) => onUpdateBand(idx, { enabled: e.target.checked })}
                  />
                  {band.label}
                </label>
                <select
                  className="select-input"
                  style={{ padding: '2px 5px', fontSize: 10.5 }}
                  value={band.placement}
                  onChange={(e) =>
                    onUpdateBand(idx, { placement: e.target.value as EqPlacement })
                  }
                >
                  <option value="stereo">Stereo</option>
                  <option value="mid">Mid Only</option>
                  <option value="side">Side Only</option>
                </select>
              </div>

              <div className="param-row">
                <span>Frequency</span>
                <span className="param-val">{Math.round(band.freqHz)} Hz</span>
              </div>
              <input
                type="range"
                min={band.type === 'highpass' ? 18 : 30}
                max={band.type === 'highpass' ? 160 : 18000}
                step={1}
                value={band.freqHz}
                onChange={(e) => onUpdateBand(idx, { freqHz: Number(e.target.value) })}
              />

              {band.type !== 'highpass' && (
                <>
                  <div className="param-row">
                    <span>Static Gain</span>
                    <span className="param-val">
                      {band.gainDb >= 0 ? '+' : ''}
                      {band.gainDb.toFixed(1)} dB
                    </span>
                  </div>
                  <input
                    type="range"
                    min={-12}
                    max={12}
                    step={0.1}
                    value={band.gainDb}
                    onChange={(e) => onUpdateBand(idx, { gainDb: Number(e.target.value) })}
                  />
                </>
              )}

              <div className="param-row">
                <span>Q Factor</span>
                <span className="param-val">{band.q.toFixed(2)}</span>
              </div>
              <input
                type="range"
                min={0.35}
                max={8.0}
                step={0.05}
                value={band.q}
                onChange={(e) => onUpdateBand(idx, { q: Number(e.target.value) })}
              />

              {band.type !== 'highpass' && (
                <div
                  style={{
                    marginTop: 6,
                    paddingTop: 6,
                    borderTop: '1px solid var(--border)',
                  }}
                >
                  <div className="param-row">
                    <label
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 4,
                        fontSize: 10.5,
                        color: band.dynEnabled ? '#f59e0b' : 'var(--text-2)',
                        cursor: 'pointer',
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={Boolean(band.dynEnabled)}
                        onChange={(e) =>
                          onUpdateBand(idx, {
                            dynEnabled: e.target.checked,
                            dynThresholdDb: band.dynThresholdDb ?? -22,
                            dynRangeDb: band.dynRangeDb ?? -3.0,
                          })
                        }
                      />
                      Pro-Q Dynamic Band
                    </label>
                    {band.dynEnabled && (
                      <span className="param-val" style={{ color: '#f59e0b', fontSize: 10.5 }}>
                        {(band.dynRangeDb ?? -3) >= 0 ? '+' : ''}
                        {(band.dynRangeDb ?? -3).toFixed(1)} dB @ {band.dynThresholdDb ?? -22} dB
                      </span>
                    )}
                  </div>
                  {band.dynEnabled && (
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                      <input
                        type="range"
                        title="Dynamic Range (-12 dB cut to +8 dB transient expand)"
                        min={-12}
                        max={8}
                        step={0.5}
                        value={band.dynRangeDb ?? -3}
                        onChange={(e) =>
                          onUpdateBand(idx, { dynRangeDb: Number(e.target.value) })
                        }
                      />
                      <input
                        type="range"
                        title="Dynamic Sidechain Threshold (dBFS)"
                        min={-42}
                        max={-4}
                        step={1}
                        value={band.dynThresholdDb ?? -22}
                        onChange={(e) =>
                          onUpdateBand(idx, { dynThresholdDb: Number(e.target.value) })
                        }
                      />
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Dynamic Spectral Resonance Suppressor */}
      <div className="panel">
        <div className="panel-header">
          <div className="panel-title">
            <span>STFT Dynamic Spectral Stabilizer &amp; Resonance Suppressor</span>
            <span className="badge badge-amber">75% COLA Zero-Phase Per-Bin Suppression</span>
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={stabilizer.enabled}
              onChange={(e) => onChangeStabilizer({ ...stabilizer, enabled: e.target.checked })}
            />
            <span style={{ fontWeight: 600 }}>Stabilizer Active</span>
          </label>
        </div>

        <div className="param-grid">
          <div className={`param-card ${!stabilizer.enabled ? 'disabled' : ''}`}>
            <div className="param-row">
              <span>Detection Mode</span>
              <select
                className="select-input"
                value={stabilizer.mode}
                onChange={(e) =>
                  onChangeStabilizer({
                    ...stabilizer,
                    mode: e.target.value as StabilizerParams['mode'],
                  })
                }
              >
                <option value="tame_harshness">Tame Harsh Resonances (Soothe)</option>
                <option value="tonal_balance">Dynamic Tonal Stabilizer</option>
                <option value="de_ess">High-Band Sibilance De-Ess</option>
              </select>
            </div>
            <div className="param-row">
              <span>Suppression Sensitivity</span>
              <span className="param-val">{stabilizer.amountPct}%</span>
            </div>
            <input
              type="range"
              min={0}
              max={100}
              value={stabilizer.amountPct}
              onChange={(e) =>
                onChangeStabilizer({ ...stabilizer, amountPct: Number(e.target.value) })
              }
            />
          </div>

          <div className={`param-card ${!stabilizer.enabled ? 'disabled' : ''}`}>
            <div className="param-row">
              <span>Spectral Sharpness (Q Selectivity)</span>
              <span className="param-val">{stabilizer.sharpnessPct}%</span>
            </div>
            <input
              type="range"
              min={10}
              max={95}
              value={stabilizer.sharpnessPct}
              onChange={(e) =>
                onChangeStabilizer({ ...stabilizer, sharpnessPct: Number(e.target.value) })
              }
            />
            <div className="param-row">
              <span>Max Dynamic Attenuation</span>
              <span className="param-val">-{stabilizer.maxReductionDb.toFixed(1)} dB</span>
            </div>
            <input
              type="range"
              min={1.0}
              max={12.0}
              step={0.5}
              value={stabilizer.maxReductionDb}
              onChange={(e) =>
                onChangeStabilizer({ ...stabilizer, maxReductionDb: Number(e.target.value) })
              }
            />
          </div>

          <div className={`param-card ${!stabilizer.enabled ? 'disabled' : ''}`}>
            <div className="param-row">
              <span>Active Band Min Freq</span>
              <span className="param-val">{stabilizer.minFreqHz} Hz</span>
            </div>
            <input
              type="range"
              min={80}
              max={3000}
              step={20}
              value={stabilizer.minFreqHz}
              onChange={(e) =>
                onChangeStabilizer({ ...stabilizer, minFreqHz: Number(e.target.value) })
              }
            />
            <div className="param-row">
              <span>Active Band Max Freq</span>
              <span className="param-val">{stabilizer.maxFreqHz} Hz</span>
            </div>
            <input
              type="range"
              min={3500}
              max={18000}
              step={100}
              value={stabilizer.maxFreqHz}
              onChange={(e) =>
                onChangeStabilizer({ ...stabilizer, maxFreqHz: Number(e.target.value) })
              }
            />
          </div>
        </div>
      </div>
    </div>
  );
};
