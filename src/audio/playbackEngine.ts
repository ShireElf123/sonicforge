import type { PlanarAudioBuffer } from '../dsp/types';

export type AuditionMode =
  | 'master'
  | 'master_matched'
  | 'original'
  | 'delta'
  | 'reference'
  | 'codec_preview'
  | 'codec_delta';

export type MonitorMode = 'stereo' | 'mono' | 'mid' | 'side';

export type MonitorVoicing = 'flat' | 'phone' | 'car' | 'club' | 'auratone';

export interface LivePlaybackMeterFrame {
  isPlaying: boolean;
  currentTimeSec: number;
  durationSec: number;
  peakLeftDbfs: number;
  peakRightDbfs: number;
  rmsLeftDbfs: number;
  rmsRightDbfs: number;
  liveCorrelation: number;
}

function ampToDb(amp: number): number {
  return amp > 1e-6 ? 20 * Math.log10(amp) : -96;
}

export class StudioPlaybackEngine {
  private ctx: AudioContext | null = null;
  private sourceAudioBuf: AudioBuffer | null = null;
  private masterAudioBuf: AudioBuffer | null = null;
  private refAudioBuf: AudioBuffer | null = null;
  private codecAudioBuf: AudioBuffer | null = null;

  private srcNode: AudioBufferSourceNode | null = null;
  private mstNode: AudioBufferSourceNode | null = null;
  private refNode: AudioBufferSourceNode | null = null;
  private codecNode: AudioBufferSourceNode | null = null;

  private srcGain: GainNode | null = null;
  private mstGain: GainNode | null = null;
  private refGain: GainNode | null = null;
  private codecGain: GainNode | null = null;

  private preMatrixBus: GainNode | null = null;
  private splitter: ChannelSplitterNode | null = null;
  private merger: ChannelMergerNode | null = null;
  private matLL: GainNode | null = null;
  private matRL: GainNode | null = null;
  private matLR: GainNode | null = null;
  private matRR: GainNode | null = null;

  // Device translation filter bank (post-matrix, monitor-only)
  private vHpf: BiquadFilterNode | null = null;
  private vMid: BiquadFilterNode | null = null;
  private vLpf: BiquadFilterNode | null = null;
  private vTrim: GainNode | null = null;

  private analyserL: AnalyserNode | null = null;
  private analyserR: AnalyserNode | null = null;
  private meterSplitter: ChannelSplitterNode | null = null;
  private timeBufL = new Float32Array(1024);
  private timeBufR = new Float32Array(1024);

  private auditionMode: AuditionMode = 'master';
  private monitorMode: MonitorMode = 'stereo';
  private monitorVoicing: MonitorVoicing = 'flat';
  private masterMatchGainLin = 1.0;
  private refMatchGainLin = 1.0;

  private isPlayingState = false;
  private startContextTime = 0;
  private pauseOffsetSec = 0;
  private loopEnabled = true;
  private loopStartSec = 0;
  private loopEndSec = 0;

  private ensureContext(): AudioContext {
    if (!this.ctx) {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AudioCtx();
      this.buildStaticGraph();
    }
    return this.ctx;
  }

  private buildStaticGraph(): void {
    const ctx = this.ctx!;
    this.srcGain = ctx.createGain();
    this.mstGain = ctx.createGain();
    this.refGain = ctx.createGain();
    this.codecGain = ctx.createGain();
    this.preMatrixBus = ctx.createGain();

    this.srcGain.connect(this.preMatrixBus);
    this.mstGain.connect(this.preMatrixBus);
    this.refGain.connect(this.preMatrixBus);
    this.codecGain.connect(this.preMatrixBus);

    this.splitter = ctx.createChannelSplitter(2);
    this.merger = ctx.createChannelMerger(2);
    this.matLL = ctx.createGain();
    this.matRL = ctx.createGain();
    this.matLR = ctx.createGain();
    this.matRR = ctx.createGain();

    this.preMatrixBus.connect(this.splitter);
    this.splitter.connect(this.matLL, 0);
    this.splitter.connect(this.matLR, 0);
    this.splitter.connect(this.matRL, 1);
    this.splitter.connect(this.matRR, 1);

    this.matLL.connect(this.merger, 0, 0);
    this.matRL.connect(this.merger, 0, 0);
    this.matLR.connect(this.merger, 0, 1);
    this.matRR.connect(this.merger, 0, 1);

    // Acoustic device translation simulation chain
    this.vHpf = ctx.createBiquadFilter();
    this.vMid = ctx.createBiquadFilter();
    this.vLpf = ctx.createBiquadFilter();
    this.vTrim = ctx.createGain();

    this.merger.connect(this.vHpf);
    this.vHpf.connect(this.vMid);
    this.vMid.connect(this.vLpf);
    this.vLpf.connect(this.vTrim);

    this.meterSplitter = ctx.createChannelSplitter(2);
    this.analyserL = ctx.createAnalyser();
    this.analyserR = ctx.createAnalyser();
    this.analyserL.fftSize = 1024;
    this.analyserR.fftSize = 1024;

    this.vTrim.connect(ctx.destination);
    this.vTrim.connect(this.meterSplitter);
    this.meterSplitter.connect(this.analyserL, 0);
    this.meterSplitter.connect(this.analyserR, 1);

    this.applyAuditionGains(true);
    this.applyMonitorMatrix(true);
    this.applyVoicingFilters();
  }

  private planarToAudioBuffer(planar: PlanarAudioBuffer): AudioBuffer {
    const ctx = this.ensureContext();
    const numCh = Math.max(2, planar.channels.length);
    const len = planar.channels[0]?.length ?? 1;
    const ab = ctx.createBuffer(numCh, Math.max(1, len), planar.sampleRate);
    if (planar.channels.length === 1) {
      ab.copyToChannel(new Float32Array(planar.channels[0]), 0);
      ab.copyToChannel(new Float32Array(planar.channels[0]), 1);
    } else if (planar.channels.length >= 2) {
      ab.copyToChannel(new Float32Array(planar.channels[0]), 0);
      ab.copyToChannel(new Float32Array(planar.channels[1]), 1);
    }
    return ab;
  }

  setBuffers(
    source: PlanarAudioBuffer | null,
    master: PlanarAudioBuffer | null,
    sourceLufs: number,
    masterLufs: number,
    reference?: PlanarAudioBuffer | null,
    referenceLufs?: number,
    codecPreview?: PlanarAudioBuffer | null
  ): void {
    const wasPlaying = this.isPlayingState;
    const resumePos = this.getCurrentTimeSec();
    if (wasPlaying) {
      this.stopNodesOnly();
    }

    this.sourceAudioBuf =
      source && source.channels[0]?.length ? this.planarToAudioBuffer(source) : null;
    this.masterAudioBuf =
      master && master.channels[0]?.length ? this.planarToAudioBuffer(master) : null;
    this.refAudioBuf =
      reference && reference.channels[0]?.length ? this.planarToAudioBuffer(reference) : null;
    this.codecAudioBuf =
      codecPreview && codecPreview.channels[0]?.length
        ? this.planarToAudioBuffer(codecPreview)
        : null;

    if (Number.isFinite(sourceLufs) && Number.isFinite(masterLufs)) {
      const deltaDb = Math.max(-24, Math.min(18, sourceLufs - masterLufs));
      this.masterMatchGainLin = Math.pow(10, deltaDb / 20);
    } else {
      this.masterMatchGainLin = 1.0;
    }

    if (
      reference &&
      referenceLufs !== undefined &&
      Number.isFinite(referenceLufs) &&
      Number.isFinite(sourceLufs)
    ) {
      const refDeltaDb = Math.max(-24, Math.min(18, sourceLufs - referenceLufs));
      this.refMatchGainLin = Math.pow(10, refDeltaDb / 20);
    } else {
      this.refMatchGainLin = 1.0;
    }

    const dur = this.getDurationSec();
    if (this.loopEndSec <= 0 || this.loopEndSec > dur) {
      this.loopStartSec = 0;
      this.loopEndSec = dur;
    }
    this.pauseOffsetSec = Math.min(resumePos, Math.max(0, dur - 0.05));

    if (wasPlaying && dur > 0) {
      void this.play(this.pauseOffsetSec);
    } else {
      this.applyAuditionGains(true);
    }
  }

  setAuditionMode(mode: AuditionMode): void {
    this.auditionMode = mode;
    if (this.ctx) {
      this.applyAuditionGains(false);
    }
  }

  setMonitorMode(mode: MonitorMode): void {
    this.monitorMode = mode;
    if (this.ctx) {
      this.applyMonitorMatrix(false);
    }
  }

  setMonitorVoicing(voicing: MonitorVoicing): void {
    this.monitorVoicing = voicing;
    if (this.ctx) {
      this.applyVoicingFilters();
      this.applyMonitorMatrix(false);
    }
  }

  setLoop(enabled: boolean, startSec?: number, endSec?: number): void {
    this.loopEnabled = enabled;
    const dur = this.getDurationSec();
    if (startSec !== undefined) this.loopStartSec = Math.max(0, Math.min(dur, startSec));
    if (endSec !== undefined)
      this.loopEndSec = Math.max(this.loopStartSec + 0.1, Math.min(dur, endSec));

    for (const node of [this.srcNode, this.mstNode, this.refNode, this.codecNode]) {
      if (node && node.buffer) {
        node.loop = this.loopEnabled;
        node.loopStart = Math.min(this.loopStartSec, node.buffer.duration);
        node.loopEnd = Math.min(
          this.loopEndSec > this.loopStartSec ? this.loopEndSec : node.buffer.duration,
          node.buffer.duration
        );
      }
    }
  }

  private applyAuditionGains(immediate: boolean): void {
    if (!this.ctx || !this.srcGain || !this.mstGain || !this.refGain || !this.codecGain) return;
    const now = this.ctx.currentTime;
    const tau = immediate ? 0.001 : 0.012;

    let sG = 0;
    let mG = 0;
    let rG = 0;
    let cG = 0;

    switch (this.auditionMode) {
      case 'master':
        mG = 1.0;
        break;
      case 'master_matched':
        mG = this.masterMatchGainLin;
        break;
      case 'original':
        sG = 1.0;
        break;
      case 'delta':
        mG = this.masterMatchGainLin;
        sG = -1.0;
        break;
      case 'reference':
        if (this.refAudioBuf) rG = this.refMatchGainLin;
        else mG = 1.0;
        break;
      case 'codec_preview':
        if (this.codecAudioBuf) cG = 1.0;
        else mG = 1.0;
        break;
      case 'codec_delta':
        // Hear ONLY the lossy codec quantization + bandwidth truncation artifacts!
        if (this.codecAudioBuf) {
          cG = 1.0;
          mG = -1.0;
        } else {
          mG = 1.0;
        }
        break;
    }

    this.srcGain.gain.setTargetAtTime(sG, now, tau);
    this.mstGain.gain.setTargetAtTime(mG, now, tau);
    this.refGain.gain.setTargetAtTime(rG, now, tau);
    this.codecGain.gain.setTargetAtTime(cG, now, tau);
  }

  private applyMonitorMatrix(immediate: boolean): void {
    if (!this.ctx || !this.matLL || !this.matRL || !this.matLR || !this.matRR) return;
    const now = this.ctx.currentTime;
    const tau = immediate ? 0.001 : 0.01;

    // Force mono fold-down when checking Phone or Auratone single-driver speakers!
    const forceMonoSpeaker =
      this.monitorVoicing === 'phone' || this.monitorVoicing === 'auratone';
    const mode = forceMonoSpeaker && this.monitorMode === 'stereo' ? 'mono' : this.monitorMode;

    let ll = 1;
    let rl = 0;
    let lr = 0;
    let rr = 1;

    if (mode === 'mono' || mode === 'mid') {
      ll = 0.5;
      rl = 0.5;
      lr = 0.5;
      rr = 0.5;
    } else if (mode === 'side') {
      ll = 0.5;
      rl = -0.5;
      lr = 0.5;
      rr = -0.5;
    }

    this.matLL.gain.setTargetAtTime(ll, now, tau);
    this.matRL.gain.setTargetAtTime(rl, now, tau);
    this.matLR.gain.setTargetAtTime(lr, now, tau);
    this.matRR.gain.setTargetAtTime(rr, now, tau);
  }

  private applyVoicingFilters(): void {
    if (!this.ctx || !this.vHpf || !this.vMid || !this.vLpf || !this.vTrim) return;

    // Reset neutral defaults
    this.vHpf.type = 'highpass';
    this.vMid.type = 'peaking';
    this.vLpf.type = 'lowpass';

    switch (this.monitorVoicing) {
      case 'flat':
        this.vHpf.frequency.value = 10;
        this.vHpf.Q.value = 0.707;
        this.vMid.frequency.value = 1000;
        this.vMid.gain.value = 0;
        this.vLpf.frequency.value = 22000;
        this.vLpf.Q.value = 0.707;
        this.vTrim.gain.value = 1.0;
        break;
      case 'phone':
        this.vHpf.frequency.value = 390;
        this.vHpf.Q.value = 0.9;
        this.vMid.frequency.value = 2400;
        this.vMid.Q.value = 1.4;
        this.vMid.gain.value = 3.8;
        this.vLpf.frequency.value = 9200;
        this.vLpf.Q.value = 0.8;
        this.vTrim.gain.value = 0.92;
        break;
      case 'auratone':
        this.vHpf.frequency.value = 150;
        this.vHpf.Q.value = 0.8;
        this.vMid.frequency.value = 1350;
        this.vMid.Q.value = 1.1;
        this.vMid.gain.value = 2.2;
        this.vLpf.frequency.value = 6200;
        this.vLpf.Q.value = 0.75;
        this.vTrim.gain.value = 0.95;
        break;
      case 'car':
        this.vHpf.frequency.value = 38;
        this.vHpf.Q.value = 1.15; // Cabin resonance bump
        this.vMid.frequency.value = 420;
        this.vMid.Q.value = 1.2;
        this.vMid.gain.value = -2.8;
        this.vLpf.frequency.value = 15500;
        this.vLpf.Q.value = 0.9;
        this.vTrim.gain.value = 0.9;
        break;
      case 'club':
        this.vHpf.frequency.value = 32;
        this.vHpf.Q.value = 1.35; // Horn sub resonance
        this.vMid.frequency.value = 68;
        this.vMid.Q.value = 1.1;
        this.vMid.gain.value = 4.5;
        this.vLpf.frequency.value = 16500;
        this.vLpf.Q.value = 0.707;
        this.vTrim.gain.value = 0.8;
        break;
    }
  }

  async play(fromOffsetSec?: number): Promise<void> {
    const ctx = this.ensureContext();
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }

    const dur = this.getDurationSec();
    if (dur <= 0) return;

    this.stopNodesOnly();

    const offset =
      fromOffsetSec !== undefined
        ? Math.max(0, Math.min(dur - 0.02, fromOffsetSec))
        : Math.max(0, Math.min(dur - 0.02, this.pauseOffsetSec));

    this.pauseOffsetSec = offset;
    this.startContextTime = ctx.currentTime;

    const makeSource = (
      buf: AudioBuffer | null,
      dest: GainNode
    ): AudioBufferSourceNode | null => {
      if (!buf) return null;
      const node = ctx.createBufferSource();
      node.buffer = buf;
      node.loop = this.loopEnabled;
      node.loopStart = Math.min(this.loopStartSec, buf.duration);
      node.loopEnd = Math.min(
        this.loopEndSec > this.loopStartSec ? this.loopEndSec : buf.duration,
        buf.duration
      );
      node.connect(dest);
      node.start(0, Math.min(offset, Math.max(0, buf.duration - 0.01)));
      return node;
    };

    this.srcNode = makeSource(this.sourceAudioBuf, this.srcGain!);
    this.mstNode = makeSource(this.masterAudioBuf, this.mstGain!);
    this.refNode = makeSource(this.refAudioBuf, this.refGain!);
    this.codecNode = makeSource(this.codecAudioBuf, this.codecGain!);

    const primaryNode = this.mstNode || this.srcNode;
    if (primaryNode) {
      primaryNode.onended = () => {
        if (!this.loopEnabled && this.isPlayingState) {
          this.isPlayingState = false;
          this.pauseOffsetSec = 0;
        }
      };
    }

    this.isPlayingState = true;
    this.applyAuditionGains(true);
  }

  pause(): void {
    if (!this.isPlayingState) return;
    this.pauseOffsetSec = this.getCurrentTimeSec();
    this.stopNodesOnly();
    this.isPlayingState = false;
  }

  stop(): void {
    this.stopNodesOnly();
    this.isPlayingState = false;
    this.pauseOffsetSec = this.loopEnabled ? this.loopStartSec : 0;
  }

  seek(timeSec: number): void {
    const dur = this.getDurationSec();
    const clamped = Math.max(0, Math.min(dur, timeSec));
    this.pauseOffsetSec = clamped;
    if (this.isPlayingState) {
      void this.play(clamped);
    }
  }

  private stopNodesOnly(): void {
    for (const node of [this.srcNode, this.mstNode, this.refNode, this.codecNode]) {
      if (node) {
        node.onended = null;
        try {
          node.stop();
          node.disconnect();
        } catch {
          // Ignore already stopped
        }
      }
    }
    this.srcNode = null;
    this.mstNode = null;
    this.refNode = null;
    this.codecNode = null;
  }

  getDurationSec(): number {
    return this.masterAudioBuf?.duration ?? this.sourceAudioBuf?.duration ?? 0;
  }

  getCurrentTimeSec(): number {
    const dur = this.getDurationSec();
    if (dur <= 0) return 0;
    if (!this.isPlayingState || !this.ctx) {
      return Math.min(dur, this.pauseOffsetSec);
    }
    const elapsed = this.ctx.currentTime - this.startContextTime;
    const raw = this.pauseOffsetSec + elapsed;
    if (this.loopEnabled) {
      const lStart = this.loopStartSec;
      const lEnd = this.loopEndSec > lStart ? this.loopEndSec : dur;
      const span = Math.max(0.05, lEnd - lStart);
      if (raw >= lEnd) {
        return lStart + ((raw - lStart) % span);
      }
    }
    return Math.min(dur, raw);
  }

  getLiveMeterFrame(): LivePlaybackMeterFrame {
    const dur = this.getDurationSec();
    const cur = this.getCurrentTimeSec();

    if (!this.isPlayingState || !this.analyserL || !this.analyserR) {
      return {
        isPlaying: false,
        currentTimeSec: cur,
        durationSec: dur,
        peakLeftDbfs: -96,
        peakRightDbfs: -96,
        rmsLeftDbfs: -96,
        rmsRightDbfs: -96,
        liveCorrelation: 1,
      };
    }

    this.analyserL.getFloatTimeDomainData(this.timeBufL);
    this.analyserR.getFloatTimeDomainData(this.timeBufR);

    let peakL = 0;
    let peakR = 0;
    let sqL = 0;
    let sqR = 0;
    let crossLR = 0;
    const len = this.timeBufL.length;

    for (let i = 0; i < len; i++) {
      const l = this.timeBufL[i];
      const r = this.timeBufR[i];
      const al = Math.abs(l);
      const ar = Math.abs(r);
      if (al > peakL) peakL = al;
      if (ar > peakR) peakR = ar;
      sqL += l * l;
      sqR += r * r;
      crossLR += l * r;
    }

    const denom = Math.sqrt(sqL * sqR);
    const liveCorrelation = denom > 1e-10 ? Math.max(-1, Math.min(1, crossLR / denom)) : 1;

    return {
      isPlaying: true,
      currentTimeSec: cur,
      durationSec: dur,
      peakLeftDbfs: ampToDb(peakL),
      peakRightDbfs: ampToDb(peakR),
      rmsLeftDbfs: ampToDb(Math.sqrt(sqL / len)),
      rmsRightDbfs: ampToDb(Math.sqrt(sqR / len)),
      liveCorrelation,
    };
  }
}

export const playbackEngine = new StudioPlaybackEngine();
