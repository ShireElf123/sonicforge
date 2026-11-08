import React from 'react';
import type { LivePlaybackMeterFrame } from '../audio/playbackEngine';
import type { AudioAnalysisReport } from '../dsp/types';

interface Props {
  sourceAnalysis: AudioAnalysisReport | null;
  masterAnalysis: AudioAnalysisReport | null;
  targetLufs: number;
  ceilingDbtp: number;
  maxGainReductionDb: number;
  liveFrame: LivePlaybackMeterFrame;
}

function fmtLufs(v: number | undefined): string {
  if (v === undefined || !Number.isFinite(v) || v < -115) return '-∞';
  return v.toFixed(2);
}

function fmtDb(v: number | undefined): string {
  if (v === undefined || !Number.isFinite(v) || v <= -119) return '-∞';
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}`;
}

function dbToBarPct(db: number): number {
  // Map -60 dBFS .. 0 dBFS -> 0 .. 100%
  return Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
}

export const MeteringDock: React.FC<Props> = ({
  sourceAnalysis,
  masterAnalysis,
  targetLufs,
  ceilingDbtp,
  maxGainReductionDb,
  liveFrame,
}) => {
  const mstTp = masterAnalysis?.truePeak.truePeakDbtp;
  const tpPass = mstTp !== undefined ? mstTp <= ceilingDbtp + 0.05 : true;

  const corr = liveFrame.isPlaying
    ? liveFrame.liveCorrelation
    : (masterAnalysis?.stereo.correlation ?? sourceAnalysis?.stereo.correlation ?? 1);
  const corrPct = ((corr + 1) / 2) * 100;

  return (
    <aside className="meter-dock">
      {/* Live Real-Time Output Bus Meters */}
      <div className="panel">
        <div className="panel-header" style={{ marginBottom: 8 }}>
          <div className="panel-title">Live Monitor Bus</div>
          <span className={`badge ${liveFrame.isPlaying ? 'badge-emerald' : ''}`}>
            {liveFrame.isPlaying ? 'REAL-TIME 60FPS' : 'STANDBY'}
          </span>
        </div>

        <div className="meter-bars-row" style={{ marginBottom: 8 }}>
          <div className="bar-meter-wrap">
            <div className="param-row" style={{ marginBottom: 4 }}>
              <span>Left Ch</span>
              <span className="num">
                {liveFrame.isPlaying ? `${liveFrame.peakLeftDbfs.toFixed(1)} dB` : '—'}
              </span>
            </div>
            <div className="horiz-bar-bg">
              <div
                className="horiz-bar-fill"
                style={{
                  width: `${dbToBarPct(liveFrame.peakLeftDbfs)}%`,
                  background:
                    liveFrame.peakLeftDbfs > -0.5
                      ? '#ef4444'
                      : 'linear-gradient(90deg, #10b981, #22d3ee)',
                }}
              />
            </div>
          </div>

          <div className="bar-meter-wrap">
            <div className="param-row" style={{ marginBottom: 4 }}>
              <span>Right Ch</span>
              <span className="num">
                {liveFrame.isPlaying ? `${liveFrame.peakRightDbfs.toFixed(1)} dB` : '—'}
              </span>
            </div>
            <div className="horiz-bar-bg">
              <div
                className="horiz-bar-fill"
                style={{
                  width: `${dbToBarPct(liveFrame.peakRightDbfs)}%`,
                  background:
                    liveFrame.peakRightDbfs > -0.5
                      ? '#ef4444'
                      : 'linear-gradient(90deg, #10b981, #22d3ee)',
                }}
              />
            </div>
          </div>
        </div>

        <div className="bar-meter-wrap">
          <div className="param-row" style={{ marginBottom: 4 }}>
            <span>Phase Correlation (-1 .. +1)</span>
            <span
              className="num"
              style={{ color: corr < 0 ? '#ef4444' : corr < 0.3 ? '#f59e0b' : '#10b981' }}
            >
              {corr >= 0 ? '+' : ''}
              {corr.toFixed(2)}
            </span>
          </div>
          <div className="horiz-bar-bg">
            <div
              style={{
                position: 'absolute',
                left: '50%',
                top: 0,
                bottom: 0,
                width: 1,
                background: 'rgba(255,255,255,0.3)',
              }}
            />
            <div
              style={{
                position: 'absolute',
                left: `${Math.min(50, corrPct)}%`,
                width: `${Math.abs(corrPct - 50)}%`,
                top: 0,
                bottom: 0,
                background: corr < 0 ? '#ef4444' : '#10b981',
              }}
            />
          </div>
        </div>
      </div>

      {/* Standards-Compliant BS.1770-5 & True-Peak Readout Table */}
      <div className="panel">
        <div className="panel-header" style={{ marginBottom: 6 }}>
          <div className="panel-title">ITU-R BS.1770-5 &amp; True Peak</div>
          <span className={`badge ${tpPass ? 'badge-emerald' : 'badge-crimson'}`}>
            {tpPass ? 'CEILING OK' : 'TP OVER'}
          </span>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 8,
            marginBottom: 10,
          }}
        >
          <div
            style={{
              background: 'var(--bg-2)',
              borderRadius: 7,
              padding: '8px 10px',
              border: '1px solid var(--border)',
            }}
          >
            <div style={{ fontSize: 10, color: 'var(--text-2)', textTransform: 'uppercase' }}>
              Measured Master LUFS
            </div>
            <div className="num" style={{ fontSize: 20, fontWeight: 800, color: 'var(--cyan)' }}>
              {fmtLufs(masterAnalysis?.loudness.integratedLufs)}
            </div>
            <div className="num" style={{ fontSize: 10.5, color: 'var(--text-2)' }}>
              Target: {targetLufs.toFixed(1)} LUFS
            </div>
          </div>

          <div
            style={{
              background: 'var(--bg-2)',
              borderRadius: 7,
              padding: '8px 10px',
              border: '1px solid var(--border)',
            }}
          >
            <div style={{ fontSize: 10, color: 'var(--text-2)', textTransform: 'uppercase' }}>
              Measured True Peak
            </div>
            <div
              className="num"
              style={{
                fontSize: 20,
                fontWeight: 800,
                color: tpPass ? '#10b981' : '#ef4444',
              }}
            >
              {fmtDb(masterAnalysis?.truePeak.truePeakDbtp)}
            </div>
            <div className="num" style={{ fontSize: 10.5, color: 'var(--text-2)' }}>
              Ceiling: {ceilingDbtp.toFixed(2)} dBTP
            </div>
          </div>
        </div>

        <table className="metric-table">
          <thead>
            <tr>
              <th>Metric</th>
              <th className="num">Source</th>
              <th className="num">Master</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Integrated (LUFS)</td>
              <td className="num">{fmtLufs(sourceAnalysis?.loudness.integratedLufs)}</td>
              <td className="num" style={{ color: 'var(--cyan)', fontWeight: 700 }}>
                {fmtLufs(masterAnalysis?.loudness.integratedLufs)}
              </td>
            </tr>
            <tr>
              <td>Short-Term Max (3s)</td>
              <td className="num">{fmtLufs(sourceAnalysis?.loudness.shortTermMaxLufs)}</td>
              <td className="num">{fmtLufs(masterAnalysis?.loudness.shortTermMaxLufs)}</td>
            </tr>
            <tr>
              <td>Momentary Max (400ms)</td>
              <td className="num">{fmtLufs(sourceAnalysis?.loudness.momentaryMaxLufs)}</td>
              <td className="num">{fmtLufs(masterAnalysis?.loudness.momentaryMaxLufs)}</td>
            </tr>
            <tr>
              <td>Loudness Range (LRA)</td>
              <td className="num">
                {sourceAnalysis ? `${sourceAnalysis.loudness.loudnessRangeLu.toFixed(1)} LU` : '—'}
              </td>
              <td className="num">
                {masterAnalysis ? `${masterAnalysis.loudness.loudnessRangeLu.toFixed(1)} LU` : '—'}
              </td>
            </tr>
            <tr>
              <td>
                True Peak ({masterAnalysis?.truePeak.oversamplingFactor ?? 4}x dBTP)
              </td>
              <td className="num">{fmtDb(sourceAnalysis?.truePeak.truePeakDbtp)}</td>
              <td
                className="num"
                style={{ color: tpPass ? '#10b981' : '#ef4444', fontWeight: 700 }}
              >
                {fmtDb(masterAnalysis?.truePeak.truePeakDbtp)}
              </td>
            </tr>
            <tr>
              <td>Sample Peak (dBFS)</td>
              <td className="num">{fmtDb(sourceAnalysis?.truePeak.samplePeakDbfs)}</td>
              <td className="num">{fmtDb(masterAnalysis?.truePeak.samplePeakDbfs)}</td>
            </tr>
            <tr>
              <td>Inter-Sample Delta</td>
              <td className="num">
                {sourceAnalysis ? `+${sourceAnalysis.truePeak.ispMarginDb.toFixed(2)} dB` : '—'}
              </td>
              <td className="num">
                {masterAnalysis ? `+${masterAnalysis.truePeak.ispMarginDb.toFixed(2)} dB` : '—'}
              </td>
            </tr>
            <tr>
              <td>PLR (TP − LUFS)</td>
              <td className="num">
                {sourceAnalysis ? `${sourceAnalysis.dynamics.plrDb.toFixed(1)} dB` : '—'}
              </td>
              <td className="num">
                {masterAnalysis ? `${masterAnalysis.dynamics.plrDb.toFixed(1)} dB` : '—'}
              </td>
            </tr>
            <tr>
              <td>Crest Factor</td>
              <td className="num">
                {sourceAnalysis ? `${sourceAnalysis.dynamics.crestFactorDb.toFixed(1)} dB` : '—'}
              </td>
              <td className="num">
                {masterAnalysis ? `${masterAnalysis.dynamics.crestFactorDb.toFixed(1)} dB` : '—'}
              </td>
            </tr>
            <tr>
              <td>Max Limiter GR</td>
              <td className="num">—</td>
              <td className="num" style={{ color: '#f59e0b', fontWeight: 700 }}>
                -{maxGainReductionDb.toFixed(2)} dB
              </td>
            </tr>
            <tr>
              <td>Clipped Samples</td>
              <td className="num">{sourceAnalysis?.truePeak.clippedSampleCount ?? 0}</td>
              <td className="num">{masterAnalysis?.truePeak.clippedSampleCount ?? 0}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="panel" style={{ fontSize: 11, color: 'var(--text-2)' }}>
        <strong style={{ color: 'var(--text-1)' }}>Measurement Honesty Guarantee:</strong> Every
        Master value above is computed by running BS.1770-5 gating, 4096-pt FFT, and polyphase FIR
        oversampling directly over the final rendered PCM buffer — never copied from the target
        setting.
      </div>
    </aside>
  );
};
