import { measureLoudnessBs1770 } from './lufs';
import { measureTruePeak } from './truePeak';
import type {
  ExportFormatParams,
  PlanarAudioBuffer,
  WavMetadata,
  WavVerificationReport,
} from './types';

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) {
    view.setUint8(offset + i, text.charCodeAt(i) & 0x7f);
  }
}

function readAscii(view: DataView, offset: number, len: number): string {
  let out = '';
  for (let i = 0; i < len && offset + i < view.byteLength; i++) {
    out += String.fromCharCode(view.getUint8(offset + i));
  }
  return out;
}

function createPrng(seed = 0x534f4e49): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildListInfoChunkBytes(meta?: WavMetadata): Uint8Array {
  const fields: Array<[string, string]> = [];
  if (meta?.title?.trim()) fields.push(['INAM', meta.title.trim()]);
  if (meta?.artist?.trim()) fields.push(['IART', meta.artist.trim()]);
  if (meta?.album?.trim()) fields.push(['IPRD', meta.album.trim()]);
  if (meta?.isrc?.trim()) fields.push(['ISRC', meta.isrc.trim().toUpperCase()]);
  if (meta?.comment?.trim()) fields.push(['ICMT', meta.comment.trim()]);
  fields.push(['ISFT', 'SonicForge Pro BS.1770-5 Mastering Engine']);

  if (fields.length <= 1 && !meta) {
    return new Uint8Array(0);
  }

  // Compute LIST chunk payload size: 'INFO' (4 bytes) + sum of subchunks (8 + null-terminated even-padded str)
  let payloadSize = 4;
  const encodedSubchunks: Array<{ tag: string; bytes: Uint8Array }> = [];

  for (const [tag, val] of fields) {
    const clean = val.replace(/[^\x20-\x7e]/g, '');
    const strWithNullLen = clean.length + 1;
    const paddedLen = strWithNullLen + (strWithNullLen % 2);
    const bytes = new Uint8Array(paddedLen);
    for (let i = 0; i < clean.length; i++) {
      bytes[i] = clean.charCodeAt(i);
    }
    encodedSubchunks.push({ tag, bytes });
    payloadSize += 8 + paddedLen;
  }

  const chunk = new Uint8Array(8 + payloadSize);
  const view = new DataView(chunk.buffer);
  writeAscii(view, 0, 'LIST');
  view.setUint32(4, payloadSize, true);
  writeAscii(view, 8, 'INFO');

  let pos = 12;
  for (const sub of encodedSubchunks) {
    writeAscii(view, pos, sub.tag);
    view.setUint32(pos + 4, sub.bytes.length, true);
    chunk.set(sub.bytes, pos + 8);
    pos += 8 + sub.bytes.length;
  }

  return chunk;
}

export function encodeWav(
  buffer: PlanarAudioBuffer,
  format: ExportFormatParams = { bitDepth: 24, dither: 'tpdf' }
): ArrayBuffer {
  const numChannels = Math.max(1, buffer.channels.length);
  const sampleRate = Math.round(buffer.sampleRate || 48000);
  const frameCount = buffer.channels.length > 0 ? buffer.channels[0].length : 0;
  const bitDepth = format.bitDepth;
  const bytesPerSample = bitDepth / 8;
  const formatCode = bitDepth === 32 ? 3 : 1;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = frameCount * blockAlign;
  const dataPad = dataSize % 2;

  const infoChunk = buildListInfoChunkBytes(format.metadata);
  const totalSize = 44 + dataSize + dataPad + infoChunk.byteLength;

  const out = new ArrayBuffer(totalSize);
  const view = new DataView(out);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, totalSize - 8, true);
  writeAscii(view, 8, 'WAVE');

  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, formatCode, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);

  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  const rand = createPrng(0x20261108);
  const quantError = new Float64Array(numChannels);

  let offset = 44;

  if (bitDepth === 32) {
    for (let i = 0; i < frameCount; i++) {
      for (let ch = 0; ch < numChannels; ch++) {
        const s = buffer.channels[ch]?.[i] ?? 0;
        const safe = Number.isFinite(s) ? s : 0;
        view.setFloat32(offset, safe, true);
        offset += 4;
      }
    }
  } else if (bitDepth === 24) {
    const fullScale = 8388607;
    const useDither = format.dither !== 'none';
    for (let i = 0; i < frameCount; i++) {
      for (let ch = 0; ch < numChannels; ch++) {
        const raw = buffer.channels[ch]?.[i] ?? 0;
        const safe = Number.isFinite(raw) ? raw : 0;
        let scaled = safe * fullScale;
        if (useDither) {
          const tpdf = rand() - rand();
          if (format.dither === 'tpdf_shaped') {
            scaled += tpdf - 0.5 * quantError[ch];
          } else {
            scaled += tpdf;
          }
        }
        const quantized = Math.max(-8388608, Math.min(8388607, Math.round(scaled)));
        if (format.dither === 'tpdf_shaped') {
          quantError[ch] = quantized - safe * fullScale;
        }
        const u = quantized < 0 ? quantized + 16777216 : quantized;
        view.setUint8(offset, u & 0xff);
        view.setUint8(offset + 1, (u >> 8) & 0xff);
        view.setUint8(offset + 2, (u >> 16) & 0xff);
        offset += 3;
      }
    }
  } else {
    const fullScale = 32767;
    const useDither = format.dither !== 'none';
    for (let i = 0; i < frameCount; i++) {
      for (let ch = 0; ch < numChannels; ch++) {
        const raw = buffer.channels[ch]?.[i] ?? 0;
        const safe = Number.isFinite(raw) ? raw : 0;
        let scaled = safe * fullScale;
        if (useDither) {
          const tpdf = rand() - rand();
          if (format.dither === 'tpdf_shaped') {
            scaled += tpdf - 0.65 * quantError[ch];
          } else {
            scaled += tpdf;
          }
        }
        const quantized = Math.max(-32768, Math.min(32767, Math.round(scaled)));
        if (format.dither === 'tpdf_shaped') {
          quantError[ch] = quantized - safe * fullScale;
        }
        view.setInt16(offset, quantized, true);
        offset += 2;
      }
    }
  }

  if (infoChunk.byteLength > 0) {
    new Uint8Array(out).set(infoChunk, 44 + dataSize + dataPad);
  }

  return out;
}

export function decodeWav(arrayBuffer: ArrayBuffer): {
  buffer: PlanarAudioBuffer;
  formatCode: 1 | 3;
  bitDepth: 16 | 24 | 32;
  hasNaNOrInf: boolean;
  hasInfoMetadata: boolean;
} {
  const view = new DataView(arrayBuffer);
  if (view.byteLength < 44) {
    throw new Error('Invalid WAV file: shorter than 44-byte RIFF header.');
  }

  const riff = readAscii(view, 0, 4);
  const wave = readAscii(view, 8, 4);
  if (riff !== 'RIFF' || wave !== 'WAVE') {
    throw new Error(`Invalid WAV container headers: expected RIFF/WAVE, got ${riff}/${wave}.`);
  }

  let pos = 12;
  let formatCode = 1;
  let numChannels = 2;
  let sampleRate = 48000;
  let bitDepth = 16;
  let dataOffset = -1;
  let dataLength = 0;
  let hasInfoMetadata = false;

  while (pos + 8 <= view.byteLength) {
    const chunkId = readAscii(view, pos, 4);
    const chunkSize = view.getUint32(pos + 4, true);
    const chunkDataStart = pos + 8;

    if (chunkId === 'fmt ' && chunkSize >= 16) {
      formatCode = view.getUint16(chunkDataStart, true);
      numChannels = view.getUint16(chunkDataStart + 2, true);
      sampleRate = view.getUint32(chunkDataStart + 4, true);
      bitDepth = view.getUint16(chunkDataStart + 14, true);
    } else if (chunkId === 'data') {
      dataOffset = chunkDataStart;
      dataLength = Math.min(chunkSize, view.byteLength - chunkDataStart);
    } else if (chunkId === 'LIST' && chunkDataStart + 4 <= view.byteLength) {
      if (readAscii(view, chunkDataStart, 4) === 'INFO') {
        hasInfoMetadata = true;
      }
    }

    pos = chunkDataStart + chunkSize + (chunkSize % 2);
  }

  if (dataOffset < 0) {
    throw new Error('Invalid WAV file: missing data chunk.');
  }
  if (formatCode !== 1 && formatCode !== 3) {
    throw new Error(`Unsupported WAV format code: ${formatCode}.`);
  }
  if (bitDepth !== 16 && bitDepth !== 24 && bitDepth !== 32) {
    throw new Error(`Unsupported WAV bit depth: ${bitDepth}.`);
  }

  const bytesPerSample = bitDepth / 8;
  const blockAlign = numChannels * bytesPerSample;
  const frameCount = Math.floor(dataLength / blockAlign);
  const channels = Array.from({ length: numChannels }, () => new Float32Array(frameCount));

  let offset = dataOffset;
  let hasNaNOrInf = false;

  for (let i = 0; i < frameCount; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      let val = 0;
      if (formatCode === 3 && bitDepth === 32) {
        val = view.getFloat32(offset, true);
        offset += 4;
      } else if (bitDepth === 24) {
        const b0 = view.getUint8(offset);
        const b1 = view.getUint8(offset + 1);
        const b2 = view.getUint8(offset + 2);
        const combined = b0 | (b1 << 8) | (b2 << 16);
        const signed = combined >= 0x800000 ? combined - 0x1000000 : combined;
        val = signed / 8388608;
        offset += 3;
      } else if (bitDepth === 16) {
        val = view.getInt16(offset, true) / 32768;
        offset += 2;
      } else {
        val = view.getInt32(offset, true) / 2147483648;
        offset += 4;
      }

      if (!Number.isFinite(val)) {
        hasNaNOrInf = true;
        val = 0;
      }
      channels[ch][i] = val;
    }
  }

  return {
    buffer: {
      sampleRate,
      channels,
      duration: sampleRate > 0 ? frameCount / sampleRate : 0,
    },
    formatCode: formatCode as 1 | 3,
    bitDepth: bitDepth as 16 | 24 | 32,
    hasNaNOrInf,
    hasInfoMetadata,
  };
}

export function verifyExportedWav(
  wavBinary: ArrayBuffer,
  expectedCeilingDbtp = -1.0,
  oversamplingFactor: 4 | 8 | 16 = 4
): WavVerificationReport {
  const decoded = decodeWav(wavBinary);
  const loudness = measureLoudnessBs1770(decoded.buffer);
  const tp = measureTruePeak(decoded.buffer, oversamplingFactor, expectedCeilingDbtp);
  const frameCount = decoded.buffer.channels[0]?.length ?? 0;

  const ditherToleranceDb = decoded.bitDepth === 16 ? 0.08 : 0.05;
  const ceilingCompliant = tp.truePeakDbtp <= expectedCeilingDbtp + ditherToleranceDb;

  return {
    validRiffHeader: true,
    formatCode: decoded.formatCode,
    bitDepth: decoded.bitDepth,
    sampleRate: decoded.buffer.sampleRate,
    channels: decoded.buffer.channels.length,
    frameCount,
    durationSec: decoded.buffer.duration,
    byteLength: wavBinary.byteLength,
    hasNaNOrInf: decoded.hasNaNOrInf,
    hasInfoMetadata: decoded.hasInfoMetadata,
    measuredIntegratedLufs: loudness.integratedLufs,
    measuredTruePeakDbtp: tp.truePeakDbtp,
    measuredSamplePeakDbfs: tp.samplePeakDbfs,
    ceilingCompliant,
  };
}
