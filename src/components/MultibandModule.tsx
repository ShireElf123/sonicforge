import React from 'react';
import type { MultibandBandParams, MultibandParams } from '../dsp/types';

interface Props {
  params: MultibandParams;
  onChange: (next: MultibandParams) => void;
}

export const MultibandModule: React.FC<Props> = ({ params, onChange }) => {
  const updateBand = (idx: number, patch: Partial<MultibandBandParams>) => {
    const nextBands = params.bands.map((b, i) =>
      i === idx ? { ...b, ...patch } : b
    ) as MultibandParams['bands'];
    onChange({ ...params, bands: nextBands });
  };

  const updateCrossover = (idx: 0 | 1 | 2, val: number) => {
    const next: [number, number, number] = [...params.crossoversHz];
    next[idx] = val;
    if (next[0] >= next[1] - 40) next[0] = next[1] - 40;
    if (next[1] >= next[2] - 200) next[1] = next[2] - 200;
    onChange({ ...params, crossoversHz: next });
  };

  return (
    <div className="panel">
      <div className="panel-header">
        <div className="panel-title">
          <span>4-Band Linkwitz-Riley (24 dB/oct) Multiband Dynamics</span>
          <span className="badge badge-emerald">All-Pass Phase Compensated (0.00 dB Flat Sum)</span>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={params.enabled}
            onChange={(e) => onChange({ ...params, enabled: e.target.checked })}
          />
          <span style={{ fontWeight: 600 }}>Multiband Active</span>
        </label>
      </div>

      {/* Crossover Frequency Controls */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: 10,
          marginBottom: 12,
          background: 'var(--bg-2)',
          padding: '9px 12px',
          borderRadius: 7,
          border: '1px solid var(--border)',
        }}
      >
        <div>
          <div className="param-row">
            <span>Low / Low-Mid XO</span>
            <span className="param-val">{params.crossoversHz[0]} Hz</span>
          </div>
          <input
            type="range"
            min={50}
            max={350}
            value={params.crossoversHz[0]}
            onChange={(e) => updateCrossover(0, Number(e.target.value))}
          />
        </div>
        <div>
          <div className="param-row">
            <span>Low-Mid / High-Mid XO</span>
            <span className="param-val">{params.crossoversHz[1]} Hz</span>
          </div>
          <input
            type="range"
            min={450}
            max={3200}
            step={10}
            value={params.crossoversHz[1]}
            onChange={(e) => updateCrossover(1, Number(e.target.value))}
          />
        </div>
        <div>
          <div className="param-row">
            <span>High-Mid / Air XO</span>
            <span className="param-val">{params.crossoversHz[2]} Hz</span>
          </div>
          <input
            type="range"
            min={3500}
            max={12000}
            step={50}
            value={params.crossoversHz[2]}
            onChange={(e) => updateCrossover(2, Number(e.target.value))}
          />
        </div>
      </div>

      <div className="param-grid">
        {params.bands.map((band, idx) => (
          <div
            key={band.id}
            className={`param-card ${band.bypass || !params.enabled ? 'disabled' : ''}`}
          >
            <div className="param-row">
              <strong style={{ color: 'var(--text-0)', fontSize: 12 }}>{band.label}</strong>
              <div style={{ display: 'flex', gap: 4 }}>
                <button
                  type="button"
                  className={`seg-btn ${band.solo ? 'active-amber' : ''}`}
                  style={{ padding: '2px 6px', border: '1px solid var(--border)' }}
                  onClick={() => updateBand(idx, { solo: !band.solo })}
                >
                  S
                </button>
                <button
                  type="button"
                  className={`seg-btn ${band.bypass ? 'active' : ''}`}
                  style={{ padding: '2px 6px', border: '1px solid var(--border)' }}
                  onClick={() => updateBand(idx, { bypass: !band.bypass })}
                >
                  BYP
                </button>
              </div>
            </div>

            <div className="param-row">
              <span>Threshold</span>
              <span className="param-val">{band.thresholdDb.toFixed(1)} dB</span>
            </div>
            <input
              type="range"
              min={-42}
              max={0}
              step={0.5}
              value={band.thresholdDb}
              onChange={(e) => updateBand(idx, { thresholdDb: Number(e.target.value) })}
            />

            <div className="param-row">
              <span>Ratio</span>
              <span className="param-val">{band.ratio.toFixed(2)} : 1</span>
            </div>
            <input
              type="range"
              min={1.0}
              max={8.0}
              step={0.05}
              value={band.ratio}
              onChange={(e) => updateBand(idx, { ratio: Number(e.target.value) })}
            />

            <div className="param-row">
              <span>Attack / Release</span>
              <span className="param-val">
                {Math.round(band.attackMs)} / {Math.round(band.releaseMs)} ms
              </span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
              <input
                type="range"
                min={1}
                max={80}
                value={band.attackMs}
                onChange={(e) => updateBand(idx, { attackMs: Number(e.target.value) })}
              />
              <input
                type="range"
                min={20}
                max={400}
                value={band.releaseMs}
                onChange={(e) => updateBand(idx, { releaseMs: Number(e.target.value) })}
              />
            </div>

            <div className="param-row">
              <span>Band Makeup</span>
              <span className="param-val">
                {band.makeupDb >= 0 ? '+' : ''}
                {band.makeupDb.toFixed(1)} dB
              </span>
            </div>
            <input
              type="range"
              min={-6}
              max={8}
              step={0.1}
              value={band.makeupDb}
              onChange={(e) => updateBand(idx, { makeupDb: Number(e.target.value) })}
            />
          </div>
        ))}
      </div>
    </div>
  );
};
