import React from 'react';
import type {
  AudioAnalysisReport,
  ExciterParams,
  StereoStageParams,
} from '../dsp/types';

interface Props {
  stereo: StereoStageParams;
  exciter: ExciterParams;
  sourceAnalysis: AudioAnalysisReport | null;
  masterAnalysis: AudioAnalysisReport | null;
  onChangeStereo: (next: StereoStageParams) => void;
  onChangeExciter: (next: ExciterParams) => void;
}

export const StereoExciterModule: React.FC<Props> = ({
  stereo,
  exciter,
  sourceAnalysis,
  masterAnalysis,
  onChangeStereo,
  onChangeExciter,
}) => {
  const activeStereo = masterAnalysis?.stereo ?? sourceAnalysis?.stereo;
  const pts = activeStereo?.vectorscopePoints ?? [];

  const renderCorrRow = (label: string, val: number) => {
    const pct = ((val + 1) / 2) * 100;
    const color = val < 0 ? '#ef4444' : val < 0.35 ? '#f59e0b' : '#10b981';
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <div className="param-row">
          <span>{label}</span>
          <span className="num" style={{ color, fontWeight: 700 }}>
            {val >= 0 ? '+' : ''}
            {val.toFixed(2)}
          </span>
        </div>
        <div className="horiz-bar-bg" style={{ height: 7 }}>
          <div
            style={{
              position: 'absolute',
              left: '50%',
              top: 0,
              bottom: 0,
              width: 1,
              background: 'rgba(255,255,255,0.25)',
            }}
          />
          <div
            style={{
              position: 'absolute',
              left: `${Math.min(50, pct)}%`,
              width: `${Math.abs(pct - 50)}%`,
              top: 0,
              bottom: 0,
              background: color,
            }}
          />
        </div>
      </div>
    );
  };

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.3fr) minmax(260px, 1fr)', gap: 12 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {/* Stereo M/S Imager & Bass Mono */}
        <div className="panel">
          <div className="panel-header">
            <div className="panel-title">
              <span>M/S Stereo Imager &amp; Elliptical Bass Mono</span>
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input
                type="checkbox"
                checked={stereo.enabled}
                onChange={(e) => onChangeStereo({ ...stereo, enabled: e.target.checked })}
              />
              <span style={{ fontWeight: 600 }}>Active</span>
            </label>
          </div>

          <div className="param-grid">
            <div className={`param-card ${!stereo.enabled ? 'disabled' : ''}`}>
              <div className="param-row">
                <label style={{ display: 'flex', alignItems: 'center', gap: 5, color: 'var(--text-0)', fontWeight: 700 }}>
                  <input
                    type="checkbox"
                    checked={stereo.bassMonoEnabled}
                    onChange={(e) =>
                      onChangeStereo({ ...stereo, bassMonoEnabled: e.target.checked })
                    }
                  />
                  Bass Mono Filter
                </label>
                <span className="param-val">&lt; {stereo.bassMonoHz} Hz</span>
              </div>
              <input
                type="range"
                min={40}
                max={250}
                value={stereo.bassMonoHz}
                onChange={(e) => onChangeStereo({ ...stereo, bassMonoHz: Number(e.target.value) })}
              />
              <div style={{ fontSize: 10.5, color: 'var(--text-2)' }}>
                High-passes Side channel below cutoff for 100% phase-coherent club/vinyl sub-bass.
              </div>
            </div>

            <div className={`param-card ${!stereo.enabled ? 'disabled' : ''}`}>
              <div className="param-row">
                <span>Broadband Width</span>
                <span className="param-val">{stereo.widthPct}%</span>
              </div>
              <input
                type="range"
                min={0}
                max={200}
                value={stereo.widthPct}
                onChange={(e) => onChangeStereo({ ...stereo, widthPct: Number(e.target.value) })}
              />
              <div className="param-row">
                <span>High Width (&gt;{stereo.highCrossoverHz} Hz)</span>
                <span className="param-val">{stereo.highWidthPct}%</span>
              </div>
              <input
                type="range"
                min={0}
                max={200}
                value={stereo.highWidthPct}
                onChange={(e) =>
                  onChangeStereo({ ...stereo, highWidthPct: Number(e.target.value) })
                }
              />
            </div>
          </div>
        </div>

        {/* 2x Oversampled Harmonic Exciter */}
        <div className="panel">
          <div className="panel-header">
            <div className="panel-title">
              <span>2x Oversampled Analog Harmonic Exciter</span>
              <span className="badge">Anti-Aliased Half-Band LP</span>
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input
                type="checkbox"
                checked={exciter.enabled}
                onChange={(e) => onChangeExciter({ ...exciter, enabled: e.target.checked })}
              />
              <span style={{ fontWeight: 600 }}>Active</span>
            </label>
          </div>

          <div className="param-grid">
            <div className={`param-card ${!exciter.enabled ? 'disabled' : ''}`}>
              <div className="param-row">
                <span>Harmonic Circuit</span>
                <select
                  className="select-input"
                  value={exciter.mode}
                  onChange={(e) =>
                    onChangeExciter({
                      ...exciter,
                      mode: e.target.value as ExciterParams['mode'],
                    })
                  }
                >
                  <option value="tape">Tape (Odd Symmetric)</option>
                  <option value="tube">Triode Tube (Warm 2nd+3rd)</option>
                  <option value="transformer">Iron Transformer</option>
                </select>
              </div>
              <div className="param-row">
                <span>Saturation Drive</span>
                <span className="param-val">{exciter.drivePct}%</span>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                value={exciter.drivePct}
                onChange={(e) =>
                  onChangeExciter({ ...exciter, drivePct: Number(e.target.value) })
                }
              />
            </div>

            <div className={`param-card ${!exciter.enabled ? 'disabled' : ''}`}>
              <div className="param-row">
                <span>Excitation Focus HPF</span>
                <span className="param-val">{exciter.highFocusHz} Hz</span>
              </div>
              <input
                type="range"
                min={100}
                max={8000}
                step={50}
                value={exciter.highFocusHz}
                onChange={(e) =>
                  onChangeExciter({ ...exciter, highFocusHz: Number(e.target.value) })
                }
              />
              <div className="param-row">
                <span>Harmonic Wet Blend</span>
                <span className="param-val">{exciter.mixPct}%</span>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                value={exciter.mixPct}
                onChange={(e) => onChangeExciter({ ...exciter, mixPct: Number(e.target.value) })}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Lissajous Polar Vectorscope & Multi-Band Correlation */}
      <div className="panel" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div className="panel-title">Lissajous Vectorscope &amp; Mono Check</div>
        <div
          style={{
            background: '#05070b',
            borderRadius: 7,
            border: '1px solid var(--border)',
            display: 'flex',
            justifyContent: 'center',
            padding: 8,
          }}
        >
          <svg viewBox="-110 -110 220 220" style={{ width: 175, height: 175 }}>
            <circle cx={0} cy={0} r={96} fill="none" stroke="rgba(148,163,184,0.16)" />
            <circle cx={0} cy={0} r={52} fill="none" stroke="rgba(148,163,184,0.09)" />
            {/* Mid vertical, Side horizontal, L/R 45 deg diagonals */}
            <line x1={0} y1={-98} x2={0} y2={98} stroke="rgba(34,211,238,0.22)" />
            <line x1={-98} y1={0} x2={98} y2={0} stroke="rgba(239,68,68,0.22)" />
            <line x1={-70} y1={-70} x2={70} y2={70} stroke="rgba(148,163,184,0.12)" />
            <line x1={70} y1={-70} x2={-70} y2={70} stroke="rgba(148,163,184,0.12)" />
            <text x={0} y={-101} fill="#22d3ee" fontSize={8} textAnchor="middle">
              MID
            </text>
            <text x={-96} y={-4} fill="#94a3b8" fontSize={8}>
              +S
            </text>
            <text x={82} y={-4} fill="#94a3b8" fontSize={8}>
              -S
            </text>
            {pts.map((p, i) => (
              <circle
                key={i}
                cx={-p.s * 90}
                cy={-p.m * 90}
                r={1.6}
                fill="#22d3ee"
                opacity={0.62}
              />
            ))}
          </svg>
        </div>

        {activeStereo && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {renderCorrRow('Broadband Correlation', activeStereo.correlation)}
            {renderCorrRow('Sub / Low (<150 Hz)', activeStereo.lowBandCorrelation)}
            {renderCorrRow('Midrange (150–2.5k Hz)', activeStereo.midBandCorrelation)}
            {renderCorrRow('Highs (>2.5 kHz)', activeStereo.highBandCorrelation)}

            <div className="param-row" style={{ paddingTop: 4, borderTop: '1px solid var(--border)' }}>
              <span>Mono Fold-Down Loss</span>
              <span
                className="num"
                style={{
                  color: activeStereo.monoFoldDownLossDb > 3.0 ? '#f59e0b' : '#10b981',
                  fontWeight: 700,
                }}
              >
                -{activeStereo.monoFoldDownLossDb.toFixed(2)} dB
              </span>
            </div>
            <div className="param-row">
              <span>L/R Balance Offset</span>
              <span className="num">
                {activeStereo.balanceDb >= 0 ? '+' : ''}
                {activeStereo.balanceDb.toFixed(2)} dB
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
