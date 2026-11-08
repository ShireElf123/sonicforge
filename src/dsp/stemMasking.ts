import type { AudioAnalysisReport, StemBusParams, StemSlotId } from './types';

export interface StemMaskingCollision {
  pair: [StemSlotId, StemSlotId];
  regionLabel: string;
  centerHz: number;
  overlapSeverityDb: number;
  recommendation: string;
}

function bandEnergy(rep: AudioAnalysisReport | undefined, id: string): number {
  return rep?.spectral.bands.find((b) => b.id === id)?.energyDb ?? -96;
}

/**
 * Pro-Q 4 / Neutron Style Inter-Stem Spectral Masking & Frequency Collision Detector.
 * Compares absolute spectral band energies across loaded stems to pinpoint exact
 * Kick/Bass low-end collisions and Vocal/Instrument midrange masking.
 */
export function detectStemMaskingCollisions(
  stemReports: Partial<Record<StemSlotId, AudioAnalysisReport>>
): StemMaskingCollision[] {
  const collisions: StemMaskingCollision[] = [];
  const drums = stemReports.drums;
  const bass = stemReports.bass;
  const vocals = stemReports.vocals;
  const inst = stemReports.instruments;

  // 1. Drums vs Bass Sub/Low Collision (45 - 125 Hz)
  if (drums && bass) {
    const dLow = Math.max(bandEnergy(drums, 'sub'), bandEnergy(drums, 'low'));
    const bLow = Math.max(bandEnergy(bass, 'sub'), bandEnergy(bass, 'low'));
    if (dLow > -42 && bLow > -42 && Math.abs(dLow - bLow) < 7.5) {
      const severity = Math.max(0.5, 8.0 - Math.abs(dLow - bLow));
      collisions.push({
        pair: ['drums', 'bass'],
        regionLabel: 'Sub / Kick Fundamental (55–115 Hz)',
        centerHz: 85,
        overlapSeverityDb: Number(severity.toFixed(1)),
        recommendation:
          'Carve -1.8 dB @ 105 Hz on Bass & tighten Bass HPF @ 30 Hz so Kick punch & Sub 808 separate cleanly.',
      });
    }
  }

  // 2. Vocals vs Instruments Presence Masking (1.5 - 4.2 kHz)
  if (vocals && inst) {
    const vPres = bandEnergy(vocals, 'highMid');
    const iPres = bandEnergy(inst, 'highMid');
    if (vPres > -45 && iPres > -45 && iPres > vPres - 5.5) {
      const severity = Math.max(0.5, 6.0 - Math.max(0, vPres - iPres));
      collisions.push({
        pair: ['vocals', 'instruments'],
        regionLabel: 'Vocal Articulation Pocket (2.0–3.5 kHz)',
        centerHz: 2750,
        overlapSeverityDb: Number(severity.toFixed(1)),
        recommendation:
          'Dip -2.0 dB @ 2.75 kHz on Instruments & widen Instruments to 118% while lifting +1.4 dB @ 2.8 kHz on Vocals.',
      });
    }
  }

  // 3. Vocals vs Instruments Low-Mid Boxiness (250 - 650 Hz)
  if (vocals && inst) {
    const vMid = bandEnergy(vocals, 'lowMid');
    const iMid = bandEnergy(inst, 'lowMid');
    if (vMid > -42 && iMid > -42 && Math.abs(vMid - iMid) < 6.0) {
      const severity = Math.max(0.5, 6.5 - Math.abs(vMid - iMid));
      collisions.push({
        pair: ['vocals', 'instruments'],
        regionLabel: 'Low-Mid Warmth / Mud Zone (280–520 Hz)',
        centerHz: 360,
        overlapSeverityDb: Number(severity.toFixed(1)),
        recommendation:
          'Apply 85 Hz Vocal HPF & -1.5 dB Low-Mid pocket on Instruments @ 360 Hz to clear vocal chest clarity.',
      });
    }
  }

  return collisions;
}

/**
 * Generates complementary EQ / Width / HPF bus adjustments to resolve detected inter-stem collisions.
 */
export function computeAutoUnmaskBusPatches(
  current: Record<StemSlotId, StemBusParams>,
  collisions: StemMaskingCollision[]
): Record<StemSlotId, StemBusParams> {
  const next: Record<StemSlotId, StemBusParams> = JSON.parse(JSON.stringify(current));

  for (const col of collisions) {
    if (col.pair[0] === 'drums' && col.pair[1] === 'bass') {
      next.drums.lowShelfDb = Math.min(4, next.drums.lowShelfDb + 1.0);
      next.bass.hpfHz = Math.max(next.bass.hpfHz, 30);
      next.bass.midFreqHz = 110;
      next.bass.midBellDb = Math.max(-6, Math.min(next.bass.midBellDb, -1.8));
      next.bass.widthPct = Math.min(next.bass.widthPct, 75);
    }
    if (col.pair[0] === 'vocals' && col.pair[1] === 'instruments') {
      if (col.centerHz > 1500) {
        next.vocals.midFreqHz = 2800;
        next.vocals.midBellDb = Math.min(5, Math.max(next.vocals.midBellDb, 1.6));
        next.instruments.midFreqHz = 2750;
        next.instruments.midBellDb = Math.max(-6, Math.min(next.instruments.midBellDb, -2.0));
        next.instruments.widthPct = Math.max(next.instruments.widthPct, 118);
      } else {
        next.vocals.hpfHz = Math.max(next.vocals.hpfHz, 88);
        next.instruments.lowShelfDb = Math.max(-5, Math.min(next.instruments.lowShelfDb, -1.2));
      }
    }
  }

  return next;
}
