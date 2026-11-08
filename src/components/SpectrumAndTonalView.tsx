import React from 'react';
import { TONAL_PRESET_TARGETS } from '../dsp/profiles';
import type { AudioAnalysisReport, TonalPresetId } from '../dsp/types';

interface Props {
  sourceAnalysis: AudioAnalysisReport | null;
  masterAnalysis: AudioAnalysisReport | null;
  referenceAnalysis: AudioAnalysisReport | null;
  tonalPreset: TonalPresetId;
}

function freqToX(f: number, width: number): number {
  const minLog = Math.log10(20);
  const maxLog = Math.log10(20000);
  const clamped = Math.max(20, Math.min(20000, f));
  return ((Math.log10(clamped) - minLog) / (maxLog - minLog)) * width;
}

function relDbToY(relDb: number, height: number): number {
  // Range: +18 dB (top) to -36 dB (bottom)
  const clamped = Math.max(-36, Math.min(18, relDb));
  return ((18 - clamped) / 54) * height;
}

export const SpectrumAndTonalView: React.FC<Props> = ({
  sourceAnalysis,
  masterAnalysis,
  referenceAnalysis,
  tonalPreset,
}) => {
  const w = 660;
  const h = 155;

  const buildPath = (report: AudioAnalysisReport | null): string => {
    if (!report || report.spectral.bins.length === 0) return '';
    return report.spectral.bins
      .map((pt, i) => {
        const x = freqToX(pt.freqHz, w);
        const y = relDbToY(pt.relativeDb, h);
        return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');
  };

  const srcPath = buildPath(sourceAnalysis);
  const mstPath = buildPath(masterAnalysis);
  const refPath = buildPath(referenceAnalysis);

  const presetTarget =
    tonalPreset !== 'reference_match'
      ? TONAL_PRESET_TARGETS[tonalPreset]
      : TONAL_PRESET_TARGETS.transparent;

  const gridFreqs = [30, 60, 120, 250, 500, 1000, 2000, 4000, 8000, 16000];

  return (
    <div className="panel">
      <div className="panel-header">
        <div className="panel-title">
          <span>4096-pt FFT Spectral Analyzer &amp; 6-Band Tonal Balance</span>
          {masterAnalysis && (
            <span className="badge num">
              Centroid: {Math.round(masterAnalysis.spectral.centroidHz)} Hz • Tilt:{' '}
              {masterAnalysis.spectral.spectralTiltDbPerOct.toFixed(1)} dB/oct
            </span>
          )}
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-2)' }}>
          <span style={{ color: '#94a3b8' }}>━ Source</span> &nbsp;
          <span style={{ color: '#22d3ee' }}>━ Master</span> &nbsp;
          {referenceAnalysis && <span style={{ color: '#10b981' }}>┅ Reference</span>}
        </div>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1.55fr) minmax(240px, 1fr)',
          gap: 12,
          alignItems: 'stretch',
        }}
      >
        {/* 64-bin Log FFT Plot */}
        <div
          style={{
            background: '#05070b',
            border: '1px solid var(--border)',
            borderRadius: 7,
            padding: '6px 6px 2px',
          }}
        >
          <svg viewBox={`0 0 ${w} ${h + 18}`} style={{ width: '100%', height: 168, display: 'block' }}>
            {/* Horizontal dB guides */}
            {[-24, -12, 0, 12].map((db) => {
              const y = relDbToY(db, h);
              return (
                <g key={db}>
                  <line x1={0} y1={y} x2={w} y2={y} stroke="rgba(148,163,184,0.1)" strokeWidth={1} />
                  <text x={4} y={y - 2} fill="#64748b" fontSize={9}>
                    {db > 0 ? `+${db}` : db} dB
                  </text>
                </g>
              );
            })}

            {/* Log frequency vertical lines */}
            {gridFreqs.map((f) => {
              const x = freqToX(f, w);
              return (
                <g key={f}>
                  <line x1={x} y1={0} x2={x} y2={h} stroke="rgba(148,163,184,0.08)" strokeWidth={1} />
                  <text x={x} y={h + 13} fill="#64748b" fontSize={9} textAnchor="middle">
                    {f >= 1000 ? `${f / 1000}k` : f}
                  </text>
                </g>
              );
            })}

            {srcPath && <path d={srcPath} fill="none" stroke="#64748b" strokeWidth={1.6} />}
            {refPath && (
              <path
                d={refPath}
                fill="none"
                stroke="#10b981"
                strokeWidth={1.5}
                strokeDasharray="4 3"
              />
            )}
            {mstPath && <path d={mstPath} fill="none" stroke="#22d3ee" strokeWidth={2.1} />}
          </svg>
        </div>

        {/* 6-Band Tonal Balance Comparison */}
        <div
          style={{
            background: 'var(--bg-2)',
            border: '1px solid var(--border)',
            borderRadius: 7,
            padding: '8px 10px',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            gap: 5,
          }}
        >
          <div style={{ fontSize: 10.5, color: 'var(--text-2)', fontWeight: 700, textTransform: 'uppercase' }}>
            Measured Tonal Balance vs{' '}
            {referenceAnalysis && tonalPreset === 'reference_match'
              ? 'Reference Track'
              : presetTarget.name}
          </div>

          {(masterAnalysis ?? sourceAnalysis)?.spectral.bands.map((band) => {
            const targetRel =
              referenceAnalysis && tonalPreset === 'reference_match'
                ? (referenceAnalysis.spectral.bands.find((b) => b.id === band.id)?.relativeDb ?? 0)
                : presetTarget.bands[band.id];

            const pct = Math.max(4, Math.min(98, ((band.relativeDb + 16) / 28) * 100));
            const targetPct = Math.max(4, Math.min(98, ((targetRel + 16) / 28) * 100));
            const diff = band.relativeDb - targetRel;

            return (
              <div key={band.id} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <div className="param-row" style={{ fontSize: 10.5 }}>
                  <span style={{ color: 'var(--text-1)', fontWeight: 600 }}>{band.label}</span>
                  <span className="num">
                    {band.energyDb.toFixed(1)} dBFS{' '}
                    <span style={{ color: Math.abs(diff) > 3.5 ? '#f59e0b' : '#10b981' }}>
                      ({diff >= 0 ? '+' : ''}
                      {diff.toFixed(1)})
                    </span>
                  </span>
                </div>
                <div className="horiz-bar-bg" style={{ height: 6 }}>
                  <div
                    className="horiz-bar-fill"
                    style={{
                      width: `${pct}%`,
                      background: 'linear-gradient(90deg, #0891b2, #22d3ee)',
                    }}
                  />
                  {/* Target marker */}
                  <div
                    style={{
                      position: 'absolute',
                      left: `${targetPct}%`,
                      top: 0,
                      bottom: 0,
                      width: 2,
                      background: '#10b981',
                    }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
