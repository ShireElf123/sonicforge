import type { PlanarAudioBuffer } from '../dsp/types';
import { decodeWav } from '../dsp/wav';

const MAX_UPLOAD_BYTES = 180 * 1024 * 1024; // 180 MB browser safety budget
const ALLOWED_EXTENSIONS = ['.wav', '.mp3', '.flac', '.ogg', '.m4a', '.aac', '.webm', '.aiff'];

export async function decodeUploadedAudioFile(file: File): Promise<PlanarAudioBuffer> {
  if (file.size === 0) {
    throw new Error('Selected file is empty (0 bytes).');
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error(
      `File exceeds 180 MB browser memory budget (${(file.size / (1024 * 1024)).toFixed(1)} MB).`
    );
  }

  const lower = file.name.toLowerCase();
  const hasAllowedExt = ALLOWED_EXTENSIONS.some((ext) => lower.endsWith(ext));
  const hasAudioMime = file.type.startsWith('audio/') || file.type === 'video/mp4';
  if (!hasAllowedExt && !hasAudioMime) {
    throw new Error(
      `Unsupported audio format "${file.name}". Upload WAV, FLAC, MP3, OGG, AAC, or M4A.`
    );
  }

  const arrayBuffer = await file.arrayBuffer();

  // Try native Web Audio API decoder first (supports WAV, FLAC, MP3, AAC, OGG)
  const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  if (AudioCtx) {
    const tempCtx = new AudioCtx();
    try {
      const copy = arrayBuffer.slice(0);
      const audioBuf = await tempCtx.decodeAudioData(copy);
      const channels: Float32Array[] = [];
      const count = Math.min(2, audioBuf.numberOfChannels);
      for (let ch = 0; ch < count; ch++) {
        channels.push(new Float32Array(audioBuf.getChannelData(ch)));
      }
      return {
        sampleRate: audioBuf.sampleRate,
        channels,
        duration: audioBuf.duration,
      };
    } catch {
      // Fallback to pure-TS RIFF/WAVE decoder (e.g. 24-bit/32-bit float WAV edge cases)
      if (lower.endsWith('.wav')) {
        const wav = decodeWav(arrayBuffer);
        return wav.buffer;
      }
      throw new Error(`Could not decode audio stream in "${file.name}". File may be corrupted.`);
    } finally {
      void tempCtx.close();
    }
  }

  const wav = decodeWav(arrayBuffer);
  return wav.buffer;
}
