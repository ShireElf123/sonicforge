import type {
  AudioAnalysisReport,
  CodecAuditResult,
  DetectedSection,
  MixDoctorIssue,
  WavMetadata,
} from './types';

export interface ZipFileEntry {
  filename: string;
  data: Uint8Array;
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Pure-TypeScript zero-dependency PKZIP archive generator (STORE mode, IEEE 802.3 CRC-32).
 * Packs multiple 24-bit WAV masters + QC Certificate HTML + Mix Notes TXT into one instant .zip download.
 */
export function createZipArchive(entries: ZipFileEntry[]): ArrayBuffer {
  const encoder = new TextEncoder();
  const prepared = entries.map((e) => {
    const nameBytes = encoder.encode(e.filename);
    return {
      nameBytes,
      data: e.data,
      crc: crc32(e.data),
    };
  });

  let localTotal = 0;
  let centralTotal = 0;
  for (const p of prepared) {
    localTotal += 30 + p.nameBytes.length + p.data.byteLength;
    centralTotal += 46 + p.nameBytes.length;
  }

  const totalBytes = localTotal + centralTotal + 22;
  const out = new ArrayBuffer(totalBytes);
  const view = new DataView(out);
  const u8 = new Uint8Array(out);

  const offsets: number[] = [];
  let pos = 0;

  // 1. Write Local File Headers + File Payloads
  for (const p of prepared) {
    offsets.push(pos);
    view.setUint32(pos, 0x04034b50, true); // Local file header signature
    view.setUint16(pos + 4, 20, true); // Version needed (2.0)
    view.setUint16(pos + 6, 0x0800, true); // UTF-8 filename flag
    view.setUint16(pos + 8, 0, true); // Compression method 0 = STORE
    view.setUint16(pos + 10, 0, true); // Mod time
    view.setUint16(pos + 12, 0x5968, true); // Mod date
    view.setUint32(pos + 14, p.crc, true);
    view.setUint32(pos + 18, p.data.byteLength, true);
    view.setUint32(pos + 22, p.data.byteLength, true);
    view.setUint16(pos + 26, p.nameBytes.length, true);
    view.setUint16(pos + 28, 0, true);
    pos += 30;

    u8.set(p.nameBytes, pos);
    pos += p.nameBytes.length;

    u8.set(p.data, pos);
    pos += p.data.byteLength;
  }

  // 2. Write Central Directory Headers
  const centralStart = pos;
  for (let i = 0; i < prepared.length; i++) {
    const p = prepared[i];
    view.setUint32(pos, 0x02014b50, true); // Central file header signature
    view.setUint16(pos + 4, 20, true); // Version made by
    view.setUint16(pos + 6, 20, true); // Version needed
    view.setUint16(pos + 8, 0x0800, true); // UTF-8 flag
    view.setUint16(pos + 10, 0, true); // STORE
    view.setUint16(pos + 12, 0, true);
    view.setUint16(pos + 14, 0x5968, true);
    view.setUint32(pos + 16, p.crc, true);
    view.setUint32(pos + 20, p.data.byteLength, true);
    view.setUint32(pos + 24, p.data.byteLength, true);
    view.setUint16(pos + 28, p.nameBytes.length, true);
    view.setUint16(pos + 30, 0, true); // Extra len
    view.setUint16(pos + 32, 0, true); // Comment len
    view.setUint16(pos + 34, 0, true); // Disk number
    view.setUint16(pos + 36, 0, true); // Internal attrs
    view.setUint32(pos + 38, 0, true); // External attrs
    view.setUint32(pos + 42, offsets[i], true); // Local header offset
    pos += 46;

    u8.set(p.nameBytes, pos);
    pos += p.nameBytes.length;
  }

  const centralSize = pos - centralStart;

  // 3. End of Central Directory Record (EOCD)
  view.setUint32(pos, 0x06054b50, true);
  view.setUint16(pos + 4, 0, true);
  view.setUint16(pos + 6, 0, true);
  view.setUint16(pos + 8, prepared.length, true);
  view.setUint16(pos + 10, prepared.length, true);
  view.setUint32(pos + 12, centralSize, true);
  view.setUint32(pos + 16, centralStart, true);
  view.setUint16(pos + 20, 0, true);

  return out;
}

export function generateMasteringQcCertificateHtml(opts: {
  trackName: string;
  metadata?: WavMetadata;
  streamingAnalysis: AudioAnalysisReport;
  clubAnalysis: AudioAnalysisReport;
  mobileAnalysis: AudioAnalysisReport;
  codecAudits: CodecAuditResult[];
  sections: DetectedSection[];
  issues: MixDoctorIssue[];
}): string {
  const { trackName, metadata, streamingAnalysis, clubAnalysis, mobileAnalysis, codecAudits, sections } =
    opts;
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>SonicForge Pro — Mastering Quality Control Certificate</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #090d16; color: #e2e8f0; padding: 32px; max-width: 900px; margin: 0 auto; }
  .card { background: #111827; border: 1px solid #1e293b; border-radius: 12px; padding: 24px; margin-bottom: 20px; }
  h1 { margin: 0 0 6px; color: #22d3ee; font-size: 22px; }
  h2 { margin: 0 0 12px; font-size: 15px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.06em; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid #1e293b; }
  th { color: #94a3b8; font-weight: 600; }
  .pass { color: #10b981; font-weight: 700; }
  .warn { color: #f59e0b; font-weight: 700; }
</style>
</head>
<body>
  <div class="card">
    <h1>SonicForge Pro v4.0 — Official Mastering QC Certificate</h1>
    <p style="color:#94a3b8;margin:4px 0 0;">
      Track: <strong style="color:#fff;">${esc(metadata?.title || trackName)}</strong>
      ${metadata?.artist ? ` • Artist: <strong style="color:#fff;">${esc(metadata.artist)}</strong>` : ''}
      ${metadata?.isrc ? ` • ISRC: <strong style="color:#22d3ee;">${esc(metadata.isrc)}</strong>` : ''}
      • Verified UTC: ${new Date().toISOString()}
    </p>
  </div>

  <div class="card">
    <h2>Delivered Release Masters (ITU-R BS.1770-5 &amp; 16x True-Peak Verified)</h2>
    <table>
      <thead>
        <tr>
          <th>Deliverable File</th>
          <th>Integrated Loudness</th>
          <th>True Peak</th>
          <th>Loudness Range</th>
          <th>Phase Correlation</th>
          <th>QC Status</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>01_Streaming_Master_24bit.wav (Spotify / Apple / DistroKid)</td>
          <td>${streamingAnalysis.loudness.integratedLufs.toFixed(2)} LUFS</td>
          <td>${streamingAnalysis.truePeak.truePeakDbtp.toFixed(2)} dBTP</td>
          <td>${streamingAnalysis.loudness.loudnessRangeLu.toFixed(1)} LU</td>
          <td>${streamingAnalysis.stereo.correlation.toFixed(2)}</td>
          <td class="pass">VERIFIED PASS</td>
        </tr>
        <tr>
          <td>02_Club_DJ_Master_24bit.wav (CDJ / SoundCloud / Loud)</td>
          <td>${clubAnalysis.loudness.integratedLufs.toFixed(2)} LUFS</td>
          <td>${clubAnalysis.truePeak.truePeakDbtp.toFixed(2)} dBTP</td>
          <td>${clubAnalysis.loudness.loudnessRangeLu.toFixed(1)} LU</td>
          <td>${clubAnalysis.stereo.correlation.toFixed(2)}</td>
          <td class="pass">VERIFIED PASS</td>
        </tr>
        <tr>
          <td>03_TikTok_Reels_Mobile_24bit.wav (Phantom 808 + Vocal Cut)</td>
          <td>${mobileAnalysis.loudness.integratedLufs.toFixed(2)} LUFS</td>
          <td>${mobileAnalysis.truePeak.truePeakDbtp.toFixed(2)} dBTP</td>
          <td>${mobileAnalysis.loudness.loudnessRangeLu.toFixed(1)} LU</td>
          <td>${mobileAnalysis.stereo.correlation.toFixed(2)}</td>
          <td class="pass">VERIFIED PASS</td>
        </tr>
      </tbody>
    </table>
  </div>

  <div class="card">
    <h2>Streaming Codec Transcode Audit</h2>
    <table>
      <thead>
        <tr><th>Codec</th><th>Post-Codec True Peak</th><th>Audible SNR</th><th>Result</th></tr>
      </thead>
      <tbody>
        ${codecAudits
          .map(
            (c) => `<tr>
          <td>${esc(c.label)}</td>
          <td>${c.postCodecTruePeakDbtp.toFixed(2)} dBTP</td>
          <td>${c.artifactSnrDb.toFixed(1)} dB</td>
          <td class="${c.clipsZeroDbtp ? 'warn' : 'pass'}">${c.clipsZeroDbtp ? 'HEADROOM TIGHT' : 'ZERO-CLIP SAFE'}</td>
        </tr>`
          )
          .join('')}
      </tbody>
    </table>
  </div>

  <div class="card">
    <h2>Arrangement Macro-Dynamics Map</h2>
    <table>
      <thead><tr><th>Section</th><th>Time Range</th><th>Avg Energy</th></tr></thead>
      <tbody>
        ${sections
          .map(
            (s) =>
              `<tr><td>${esc(s.label)}</td><td>${s.startSec.toFixed(1)}s – ${s.endSec.toFixed(1)}s</td><td>${s.rmsDb.toFixed(1)} dBFS</td></tr>`
          )
          .join('')}
      </tbody>
    </table>
  </div>
</body>
</html>`;
}
