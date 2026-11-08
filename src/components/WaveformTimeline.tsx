import React from 'react';
import type { AuditionMode } from '../audio/playbackEngine';
import type { AudioAnalysisReport } from '../dsp/types';

interface Props {
  sourceAnalysis: AudioAnalysisReport | null;
  masterAnalysis: AudioAnalysisReport | null;
  currentTimeSec: number;
  durationSec: number;
  auditionMode: AuditionMode;
  loopEnabled: boolean;
  onSeek: (sec: number) => void;
  onToggleLoop: () => void;
}

function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00.0';
  const mins = Math.floor(sec / 60);
  const rem = sec - mins * 60;
  return `${mins}:${rem < 10 ? '0' : ''}${rem.toFixed(1)}`;
}

export const WaveformTimeline: React.FC<Props> = ({
  sourceAnalysis,
  masterAnalysis,
  currentTimeSec,
  durationSec,
  auditionMode,
  loopEnabled,
  onSeek,
  onToggleLoop,
}) => {
  const srcWave = sourceAnalysis?.waveform ?? [];
  const mstWave = masterAnalysis?.waveform ?? [];
  const width = 960;
  const height = 140;
  const midY = height / 2;

  const handleSvgClick = (e: React.MouseEvent<SVGSVGElement>) => {
    if (durationSec <= 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    onSeek(frac * durationSec);
  };

  const playheadX = durationSec > 0 ? Math.min(width, (currentTimeSec / durationSec) * width) : 0;

  // Build Gain Reduction polyline along top edge (0 dB at y=2, 12 dB GR at y=44)
  const grPoints = mstWave
    .map((pt, idx) => {
      const x = (idx / Math.max(1, mstWave.length - 1)) * width;
      const gr = Math.min(14, pt.grDb ?? 0);
      const y = 2 + (gr / 14) * 44;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  return (
    <div className="panel">
      <div className="panel-header">
        <div className="panel-title">
          <span>Measured PCM Waveform &amp; Limiter Gain Reduction</span>
          {sourceAnalysis && (
            <span className="badge num">
              {(sourceAnalysis.sampleRate / 1000).toFixed(1)} kHz • {sourceAnalysis.channelCount}ch
            </span>
          )}
          <span className="badge badge-cyan">
            Audition: {auditionMode.replace('_', ' ').toUpperCase()}
          </span>
        </div>

        <div className="toolbar-group">
          <span className="num" style={{ color: 'var(--cyan)', fontWeight: 700, fontSize: 12 }}>
            {formatTime(currentTimeSec)} / {formatTime(durationSec)}
          </span>
          <button
            type="button"
            className={`seg-btn ${loopEnabled ? 'active' : ''}`}
            style={{ border: '1px solid var(--border)' }}
            onClick={onToggleLoop}
          >
            Loop {loopEnabled ? 'ON' : 'OFF'}
          </button>
        </div>
      </div>

      <div
        style={{
          background: '#05070b',
          borderRadius: 7,
          border: '1px solid var(--border)',
          overflow: 'hidden',
          position: 'relative',
        }}
      >
        <svg
          viewBox={`0 0 ${width} ${height}`}
          style={{ width: '100%', height: 142, display: 'block', cursor: 'pointer' }}
          onClick={handleSvgClick}
        >
          {/* Center 0 line & -1 dBTP ceiling guide lines */}
          <line x1={0} y1={midY} x2={width} y2={midY} stroke="rgba(148,163,184,0.16)" strokeWidth={1} />
          <line
            x1={0}
            y1={midY - 0.89 * (midY - 6)}
            x2={width}
            y2={midY - 0.89 * (midY - 6)}
            stroke="rgba(239,68,68,0.22)"
            strokeDasharray="4 4"
            strokeWidth={1}
          />
          <line
            x1={0}
            y1={midY + 0.89 * (midY - 6)}
            x2={width}
            y2={midY + 0.89 * (midY - 6)}
            stroke="rgba(239,68,68,0.22)"
            strokeDasharray="4 4"
            strokeWidth={1}
          />

          {/* Rendered Master Waveform Bars (Cyan) */}
          {mstWave.map((pt, i) => {
            const x = (i / Math.max(1, mstWave.length)) * width;
            const barW = Math.max(1.5, width / Math.max(1, mstWave.length) - 0.8);
            const yTop = midY - Math.min(1, Math.abs(pt.max)) * (midY - 6);
            const yBot = midY + Math.min(1, Math.abs(pt.min)) * (midY - 6);
            return (
              <rect
                key={`m-${i}`}
                x={x}
                y={yTop}
                width={barW}
                height={Math.max(1.5, yBot - yTop)}
                fill="rgba(34, 211, 238, 0.42)"
              />
            );
          })}

          {/* Original Source Waveform Overlay (Slate inner core) */}
          {srcWave.map((pt, i) => {
            const x = (i / Math.max(1, srcWave.length)) * width;
            const barW = Math.max(1.2, width / Math.max(1, srcWave.length) - 1.1);
            const yTop = midY - Math.min(1, Math.abs(pt.max)) * (midY - 6);
            const yBot = midY + Math.min(1, Math.abs(pt.min)) * (midY - 6);
            return (
              <rect
                key={`s-${i}`}
                x={x}
                y={yTop}
                width={barW}
                height={Math.max(1, yBot - yTop)}
                fill="rgba(148, 163, 184, 0.45)"
              />
            );
          })}

          {/* Amber Limiter Gain Reduction Trace from Top */}
          {grPoints.length > 0 && (
            <polyline
              fill="none"
              stroke="#f59e0b"
              strokeWidth={1.8}
              points={grPoints}
              opacity={0.95}
            />
          )}

          {/* Playhead */}
          <line x1={playheadX} y1={0} x2={playheadX} y2={height} stroke="#f8fafc" strokeWidth={2} />
        </svg>

        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            padding: '4px 10px',
            fontSize: 10.5,
            color: 'var(--text-2)',
            background: 'rgba(13, 17, 25, 0.8)',
            borderTop: '1px solid var(--border)',
          }}
        >
          <span>
            <span style={{ color: '#94a3b8' }}>■</span> Source PCM &nbsp;&nbsp;
            <span style={{ color: '#22d3ee' }}>■</span> Rendered Master PCM &nbsp;&nbsp;
            <span style={{ color: '#f59e0b' }}>━</span> Limiter Gain Reduction (dB)
          </span>
          <span>Click anywhere on timeline to seek instantaneously</span>
        </div>
      </div>
    </div>
  );
};
