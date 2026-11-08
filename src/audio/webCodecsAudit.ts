import { measureCodecPairMetrics } from '../dsp/codecSim';
import type { CodecAuditResult, CodecProfileId, PlanarAudioBuffer } from '../dsp/types';

/**
 *Sample-aligns a decoded hardware codec buffer against the original master via cross-correlation
 * to compensate for AAC / Opus MDCT encoder priming delay (typically 312 to 2048 samples),
 * ensuring sample-accurate Artifact Solo (codec_delta) nulling.
 */
export function alignPrimingDelay(
  master: PlanarAudioBuffer,
  decoded: PlanarAudioBuffer
): PlanarAudioBuffer {
  const n = master.channels[0]?.length ?? 0;
  const mLen = decoded.channels[0]?.length ?? 0;
  if (n === 0 || mLen === 0) return master;

  const ref = master.channels[0];
  const tst = decoded.channels[0];
  const probeStart = Math.min(Math.floor(n * 0.15), 24000);
  const probeLen = Math.min(8192, n - probeStart);
  const maxLag = 2400;

  let bestLag = 0;
  let bestCorr = -Infinity;

  if (probeLen > 512) {
    for (let lag = -256; lag <= maxLag; lag += 4) {
      let sum = 0;
      for (let i = 0; i < probeLen; i += 2) {
        const j = probeStart + i + lag;
        if (j >= 0 && j < mLen) {
          sum += ref[probeStart + i] * tst[j];
        }
      }
      if (sum > bestCorr) {
        bestCorr = sum;
        bestLag = lag;
      }
    }
    // Single-sample fine refinement around coarse peak
    const coarse = bestLag;
    for (let lag = coarse - 4; lag <= coarse + 4; lag++) {
      let sum = 0;
      for (let i = 0; i < probeLen; i++) {
        const j = probeStart + i + lag;
        if (j >= 0 && j < mLen) {
          sum += ref[probeStart + i] * tst[j];
        }
      }
      if (sum > bestCorr) {
        bestCorr = sum;
        bestLag = lag;
      }
    }
  }

  const alignedChannels = decoded.channels.map((src) => {
    const dst = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const j = i + bestLag;
      dst[i] = j >= 0 && j < src.length ? src[j] : 0;
    }
    return dst;
  });

  return {
    sampleRate: master.sampleRate,
    channels: alignedChannels,
    duration: n / master.sampleRate,
  };
}

/**
 * Attempts real hardware/browser bitstream encode -> decode via W3C WebCodecs AudioEncoder & AudioDecoder
 * (supports native OS CoreAudio/MediaFoundation AAC-LC 'mp4a.40.2' @ 256k and native libopus 'opus' @ 160k).
 * Returns null cleanly if WebCodecs or the requested codec is unsupported by the current browser/OS.
 */
export async function tryWebCodecsRoundTrip(
  master: PlanarAudioBuffer,
  profileId: CodecProfileId
): Promise<{ decoded: PlanarAudioBuffer; audit: CodecAuditResult } | null> {
  const g = globalThis as unknown as {
    AudioEncoder?: any;
    AudioDecoder?: any;
    AudioData?: any;
    EncodedAudioChunk?: any;
  };

  if (!g.AudioEncoder || !g.AudioDecoder || !g.AudioData) {
    return null;
  }

  // MP3 encoding is not part of W3C WebCodecs AudioEncoder; use Opus 160k / AAC-LC 256k where available
  if (profileId === 'mp3_128') {
    return null;
  }

  const sr = master.sampleRate;
  const numCh = Math.min(2, master.channels.length);
  if (numCh === 0 || (master.channels[0]?.length ?? 0) === 0) return null;

  const codecStr = profileId === 'aac_256' ? 'mp4a.40.2' : 'opus';
  const bitrate = profileId === 'aac_256' ? 256_000 : 160_000;
  const label =
    profileId === 'aac_256'
      ? 'AAC-LC 256 kbps (Hardware WebCodecs Bitstream)'
      : 'Opus 160 kbps (Native WebCodecs Bitstream)';
  const cutoffHz = profileId === 'aac_256' ? 20400 : 20000;

  try {
    const encSup = await g.AudioEncoder.isConfigSupported({
      codec: codecStr,
      sampleRate: sr,
      numberOfChannels: numCh,
      bitrate,
    });
    if (!encSup?.supported) return null;

    const encodedChunks: Array<{ chunk: any; meta?: any }> = [];
    let decoderConfig: any = null;

    const encoder = new g.AudioEncoder({
      output: (chunk: any, meta?: any) => {
        if (meta?.decoderConfig) {
          decoderConfig = meta.decoderConfig;
        }
        encodedChunks.push({ chunk });
      },
      error: () => {
        // Handled via flush rejection
      },
    });

    encoder.configure({
      codec: codecStr,
      sampleRate: sr,
      numberOfChannels: numCh,
      bitrate,
    });

    const totalFrames = master.channels[0].length;
    const chunkSize = 4096;

    for (let offset = 0; offset < totalFrames; offset += chunkSize) {
      const frames = Math.min(chunkSize, totalFrames - offset);
      const planarData = new Float32Array(frames * numCh);
      for (let ch = 0; ch < numCh; ch++) {
        planarData.set(master.channels[ch].subarray(offset, offset + frames), ch * frames);
      }
      const audioData = new g.AudioData({
        format: 'f32-planar',
        sampleRate: sr,
        numberOfFrames: frames,
        numberOfChannels: numCh,
        timestamp: Math.round((offset / sr) * 1_000_000),
        data: planarData,
      });
      encoder.encode(audioData);
      audioData.close();
    }

    await encoder.flush();
    encoder.close();

    if (encodedChunks.length === 0) return null;

    const finalDecConfig = decoderConfig ?? {
      codec: codecStr,
      sampleRate: sr,
      numberOfChannels: numCh,
    };

    const decSup = await g.AudioDecoder.isConfigSupported(finalDecConfig);
    if (!decSup?.supported) return null;

    const outChunksCh: Float32Array[][] = Array.from({ length: numCh }, () => []);
    let decodedFramesTotal = 0;

    const decoder = new g.AudioDecoder({
      output: (audioData: any) => {
        const frames = audioData.numberOfFrames as number;
        for (let ch = 0; ch < numCh; ch++) {
          const buf = new Float32Array(frames);
          audioData.copyTo(buf, { planeIndex: ch, format: 'f32-planar' });
          outChunksCh[ch].push(buf);
        }
        decodedFramesTotal += frames;
        audioData.close();
      },
      error: () => {
        // Handled via flush rejection
      },
    });

    decoder.configure(finalDecConfig);
    for (const item of encodedChunks) {
      decoder.decode(item.chunk);
    }
    await decoder.flush();
    decoder.close();

    if (decodedFramesTotal === 0) return null;

    const mergedChannels = outChunksCh.map((parts) => {
      const merged = new Float32Array(decodedFramesTotal);
      let pos = 0;
      for (const p of parts) {
        merged.set(p, pos);
        pos += p.length;
      }
      return merged;
    });

    const rawDecoded: PlanarAudioBuffer = {
      sampleRate: sr,
      channels: mergedChannels,
      duration: decodedFramesTotal / sr,
    };

    const aligned = alignPrimingDelay(master, rawDecoded);
    const audit = measureCodecPairMetrics(
      master,
      aligned,
      profileId,
      label,
      cutoffHz,
      'webcodecs_hardware'
    );

    return { decoded: aligned, audit };
  } catch {
    return null;
  }
}
