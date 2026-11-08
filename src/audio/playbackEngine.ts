import type { MasteringChainParams, PlanarAudioBuffer } from '../dsp/types';

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

export type HeadphoneProfile =
  | 'flat'
  | 'dt990'
  | 'm50x'
  | 'hd650'
  | 'airpods_pro'
  | 'mdr7506';

export type SplMonitorMode = 'ref_78' | 'quiet_55' | 'club_98';

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

function buildSafetySoftClipCurve(ceilingLin: number): Float32Array<ArrayBuffer> {
  const N = 8193;
  const curve = new Float32Array(new ArrayBuffer(N * 4));
  const c = Math.max(0.25, Math.min(1.0, ceilingLin));
  const knee = c * 0.88;
  const span = Math.max(1e-4, c - knee);
  for (let i = 0; i < N; i++) {
    const x = ((i / (N - 1)) * 2 - 1) * 2.0; // domain [-2, +2] via 0.5x pre-scale
    const ax = Math.abs(x);
    if (ax <= knee) {
      curve[i] = x;
    } else {
      const s = x >= 0 ? 1 : -1;
      curve[i] = s * (knee + span * Math.tanh((ax - knee) / span));
    }
  }
  return curve;
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

  // Zero-latency (<3 ms) incremental M/S live knob-drag preview nodes on the Master path
  private liveTrimGain: GainNode | null = null;
  private liveSplit: ChannelSplitterNode | null = null;
  private liveMidSumL: GainNode | null = null;
  private liveMidSumR: GainNode | null = null;
  private liveSideSumL: GainNode | null = null;
  private liveSideSumR: GainNode | null = null;
  private liveMidEq: BiquadFilterNode[] = [];
  private liveSideEq: BiquadFilterNode[] = [];
  private liveSideWidth: GainNode | null = null;
  private liveOutL: GainNode | null = null;
  private liveOutR: GainNode | null = null;
  private liveSideInvR: GainNode | null = null;
  private liveMerge: ChannelMergerNode | null = null;
  private liveSafetyPreGain: GainNode | null = null;
  private liveSafetyShaper: WaveShaperNode | null = null;

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

  // Headphone Harman Compensation + ISO 226 SPL Equal-Loudness (strictly monitor-only)
  private hpLow: BiquadFilterNode | null = null;
  private hpMid: BiquadFilterNode | null = null;
  private hpHigh: BiquadFilterNode | null = null;
  private splLow: BiquadFilterNode | null = null;
  private splPres: BiquadFilterNode | null = null;
  private splTrim: GainNode | null = null;

  private analyserL: AnalyserNode | null = null;
  private analyserR: AnalyserNode | null = null;
  private meterSplitter: ChannelSplitterNode | null = null;
  private timeBufL = new Float32Array(1024);
  private timeBufR = new Float32Array(1024);

  private auditionMode: AuditionMode = 'master';
  private monitorMode: MonitorMode = 'stereo';
  private monitorVoicing: MonitorVoicing = 'flat';
  private headphoneProfile: HeadphoneProfile = 'flat';
  private splMonitorMode: SplMonitorMode = 'ref_78';
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

    // Build zero-latency incremental M/S live preview chain on Master bus
    this.liveTrimGain = ctx.createGain();
    this.liveSplit = ctx.createChannelSplitter(2);
    this.liveMidSumL = ctx.createGain();
    this.liveMidSumR = ctx.createGain();
    this.liveSideSumL = ctx.createGain();
    this.liveSideSumR = ctx.createGain();
    this.liveMidSumL.gain.value = 0.5;
    this.liveMidSumR.gain.value = 0.5;
    this.liveSideSumL.gain.value = 0.5;
    this.liveSideSumR.gain.value = -0.5;

    this.liveMidEq = Array.from({ length: 6 }, () => {
      const f = ctx.createBiquadFilter();
      f.type = 'peaking';
      f.frequency.value = 1000;
      f.gain.value = 0;
      return f;
    });
    this.liveSideEq = Array.from({ length: 6 }, () => {
      const f = ctx.createBiquadFilter();
      f.type = 'peaking';
      f.frequency.value = 1000;
      f.gain.value = 0;
      return f;
    });

    for (let i = 0; i < 5; i++) {
      this.liveMidEq[i].connect(this.liveMidEq[i + 1]);
      this.liveSideEq[i].connect(this.liveSideEq[i + 1]);
    }

    this.liveSideWidth = ctx.createGain();
    this.liveSideWidth.gain.value = 1.0;

    this.liveOutL = ctx.createGain();
    this.liveOutR = ctx.createGain();
    this.liveSideInvR = ctx.createGain();
    this.liveSideInvR.gain.value = -1.0;
    this.liveMerge = ctx.createChannelMerger(2);

    this.liveSafetyPreGain = ctx.createGain();
    this.liveSafetyPreGain.gain.value = 0.5; // maps [-2, +2] into WaveShaper [-1, +1]
    this.liveSafetyShaper = ctx.createWaveShaper();
    this.liveSafetyShaper.oversample = '4x';
    this.liveSafetyShaper.curve = buildSafetySoftClipCurve(0.891); // -1.0 dBTP default

    // Wire mstNode -> liveTrimGain -> M/S Split -> 6x Mid/Side EQ -> Width -> M/S Decode -> 4x Safety Shaper -> mstGain
    this.liveTrimGain.connect(this.liveSplit);
    this.liveSplit.connect(this.liveMidSumL, 0);
    this.liveSplit.connect(this.liveMidSumR, 1);
    this.liveSplit.connect(this.liveSideSumL, 0);
    this.liveSplit.connect(this.liveSideSumR, 1);

    this.liveMidSumL.connect(this.liveMidEq[0]);
    this.liveMidSumR.connect(this.liveMidEq[0]);
    this.liveSideSumL.connect(this.liveSideEq[0]);
    this.liveSideSumR.connect(this.liveSideEq[0]);

    this.liveSideEq[5].connect(this.liveSideWidth);

    // L = Mid + Side, R = Mid - Side
    this.liveMidEq[5].connect(this.liveOutL);
    this.liveSideWidth.connect(this.liveOutL);
    this.liveMidEq[5].connect(this.liveOutR);
    this.liveSideWidth.connect(this.liveSideInvR);
    this.liveSideInvR.connect(this.liveOutR);

    this.liveOutL.connect(this.liveMerge, 0, 0);
    this.liveOutR.connect(this.liveMerge, 0, 1);
    this.liveMerge.connect(this.liveSafetyPreGain);
    this.liveSafetyPreGain.connect(this.liveSafetyShaper);
    this.liveSafetyShaper.connect(this.mstGain);

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

    this.vHpf = ctx.createBiquadFilter();
    this.vMid = ctx.createBiquadFilter();
    this.vLpf = ctx.createBiquadFilter();
    this.vTrim = ctx.createGain();

    this.merger.connect(this.vHpf);
    this.vHpf.connect(this.vMid);
    this.vMid.connect(this.vLpf);
    this.vLpf.connect(this.vTrim);

    this.hpLow = ctx.createBiquadFilter();
    this.hpMid = ctx.createBiquadFilter();
    this.hpHigh = ctx.createBiquadFilter();
    this.splLow = ctx.createBiquadFilter();
    this.splPres = ctx.createBiquadFilter();
    this.splTrim = ctx.createGain();

    this.meterSplitter = ctx.createChannelSplitter(2);
    this.analyserL = ctx.createAnalyser();
    this.analyserR = ctx.createAnalyser();
    this.analyserL.fftSize = 1024;
    this.analyserR.fftSize = 1024;

    this.vTrim.connect(this.meterSplitter);
    this.meterSplitter.connect(this.analyserL, 0);
    this.meterSplitter.connect(this.analyserR, 1);

    this.vTrim.connect(this.hpLow);
    this.hpLow.connect(this.hpMid);
    this.hpMid.connect(this.hpHigh);
    this.hpHigh.connect(this.splLow);
    this.splLow.connect(this.splPres);
    this.splPres.connect(this.splTrim);
    this.splTrim.connect(ctx.destination);

    this.applyAuditionGains(true);
    this.applyMonitorMatrix(true);
    this.applyVoicingFilters();
    this.applyHeadphoneAndSplFilters();
  }

  /**
   * Zero-latency (<3 ms) live knob-drag preview!
   * Applies the exact differential EQ/Width/Gain change in Web Audio immediately while dragging
   * sliders, before the background 64-bit Linear-Phase / 16x True-Peak Worker render completes.
   */
  applyLivePreviewDelta(
    committed: MasteringChainParams | null,
    live: MasteringChainParams
  ): void {
    if (!this.ctx || !committed || !this.liveTrimGain || !this.liveSideWidth) return;
    const now = this.ctx.currentTime;
    const tau = 0.004;

    const deltaTrimDb =
      live.inputGainDb -
      committed.inputGainDb +
      (live.limiter.manualDriveDb - committed.limiter.manualDriveDb) * 0.65;
    const trimLin = Math.pow(10, Math.max(-12, Math.min(12, deltaTrimDb)) / 20);
    this.liveTrimGain.gain.setTargetAtTime(trimLin, now, tau);

    const commW = committed.stereo.enabled ? Math.max(15, committed.stereo.widthPct) : 100;
    const liveW = live.stereo.enabled ? Math.max(0, live.stereo.widthPct) : 100;
    this.liveSideWidth.gain.setTargetAtTime(Math.min(2.2, liveW / commW), now, tau);

    if (this.liveSafetyShaper && Math.abs(live.limiter.ceilingDbtp - committed.limiter.ceilingDbtp) > 0.05) {
      this.liveSafetyShaper.curve = buildSafetySoftClipCurve(
        Math.pow(10, live.limiter.ceilingDbtp / 20)
      );
    }

    for (let i = 0; i < Math.min(6, live.eqBands.length); i++) {
      const lb = live.eqBands[i];
      const cb = committed.eqBands[i];
      const mNode = this.liveMidEq[i];
      const sNode = this.liveSideEq[i];
      if (!lb || !cb || !mNode || !sNode) continue;

      if (lb.type === 'highpass') {
        mNode.type = 'peaking';
        sNode.type = 'peaking';
        mNode.gain.setTargetAtTime(0, now, tau);
        sNode.gain.setTargetAtTime(0, now, tau);
        continue;
      }

      const bType: BiquadFilterType =
        lb.type === 'lowshelf' ? 'lowshelf' : lb.type === 'highshelf' ? 'highshelf' : 'peaking';
      mNode.type = bType;
      sNode.type = bType;
      mNode.frequency.setTargetAtTime(lb.freqHz, now, tau);
      sNode.frequency.setTargetAtTime(lb.freqHz, now, tau);
      mNode.Q.setTargetAtTime(lb.q, now, tau);
      sNode.Q.setTargetAtTime(lb.q, now, tau);

      const commMidGain =
        committed.eqEnabled && cb.enabled && (cb.placement === 'stereo' || cb.placement === 'mid')
          ? cb.gainDb
          : 0;
      const commSideGain =
        committed.eqEnabled && cb.enabled && (cb.placement === 'stereo' || cb.placement === 'side')
          ? cb.gainDb
          : 0;
      const liveMidGain =
        live.eqEnabled && lb.enabled && (lb.placement === 'stereo' || lb.placement === 'mid')
          ? lb.gainDb
          : 0;
      const liveSideGain =
        live.eqEnabled && lb.enabled && (lb.placement === 'stereo' || lb.placement === 'side')
          ? lb.gainDb
          : 0;

      mNode.gain.setTargetAtTime(liveMidGain - commMidGain, now, tau);
      sNode.gain.setTargetAtTime(liveSideGain - commSideGain, now, tau);
    }
  }

  resetLivePreviewDelta(ceilingDbtp = -1.0): void {
    if (!this.ctx || !this.liveTrimGain || !this.liveSideWidth) return;
    const now = this.ctx.currentTime;
    this.liveTrimGain.gain.setValueAtTime(1.0, now);
    this.liveSideWidth.gain.setValueAtTime(1.0, now);
    for (let i = 0; i < this.liveMidEq.length; i++) {
      this.liveMidEq[i].gain.setValueAtTime(0, now);
      this.liveSideEq[i].gain.setValueAtTime(0, now);
    }
    if (this.liveSafetyShaper) {
      this.liveSafetyShaper.curve = buildSafetySoftClipCurve(Math.pow(10, ceilingDbtp / 20));
    }
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
    codecPreview?: PlanarAudioBuffer | null,
    ceilingDbtp = -1.0
  ): void {
    const wasPlaying = this.isPlayingState;
    const resumePos = this.getCurrentTimeSec();
    if (wasPlaying) {
      this.stopNodesOnly();
    }

    // Reset live preview delta filters the exact instant the new 64-bit rendered master buffer swaps in
    this.resetLivePreviewDelta(ceilingDbtp);

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

  setHeadphoneProfile(profile: HeadphoneProfile): void {
    this.headphoneProfile = profile;
    if (this.ctx) {
      this.applyHeadphoneAndSplFilters();
    }
  }

  setSplMonitorMode(mode: SplMonitorMode): void {
    this.splMonitorMode = mode;
    if (this.ctx) {
      this.applyHeadphoneAndSplFilters();
    }
  }

  private applyHeadphoneAndSplFilters(): void {
    if (!this.hpLow || !this.hpMid || !this.hpHigh || !this.splLow || !this.splPres || !this.splTrim) {
      return;
    }

    // 1. Headphone Harman-Target Compensation (monitor-only, never baked into WAV)
    switch (this.headphoneProfile) {
      case 'flat':
        this.hpLow.type = 'peaking';
        this.hpLow.gain.value = 0;
        this.hpMid.type = 'peaking';
        this.hpMid.gain.value = 0;
        this.hpHigh.type = 'peaking';
        this.hpHigh.gain.value = 0;
        break;
      case 'dt990':
        this.hpLow.type = 'peaking';
        this.hpLow.frequency.value = 145;
        this.hpLow.Q.value = 1.0;
        this.hpLow.gain.value = -2.2;
        this.hpMid.type = 'peaking';
        this.hpMid.frequency.value = 3200;
        this.hpMid.Q.value = 1.2;
        this.hpMid.gain.value = 1.5;
        this.hpHigh.type = 'peaking';
        this.hpHigh.frequency.value = 8600;
        this.hpHigh.Q.value = 2.4;
        this.hpHigh.gain.value = -5.2;
        break;
      case 'm50x':
        this.hpLow.type = 'peaking';
        this.hpLow.frequency.value = 105;
        this.hpLow.Q.value = 1.1;
        this.hpLow.gain.value = -3.0;
        this.hpMid.type = 'peaking';
        this.hpMid.frequency.value = 440;
        this.hpMid.Q.value = 1.2;
        this.hpMid.gain.value = 2.6;
        this.hpHigh.type = 'peaking';
        this.hpHigh.frequency.value = 9400;
        this.hpHigh.Q.value = 1.8;
        this.hpHigh.gain.value = -2.4;
        break;
      case 'hd650':
        this.hpLow.type = 'lowshelf';
        this.hpLow.frequency.value = 60;
        this.hpLow.gain.value = 4.2;
        this.hpMid.type = 'peaking';
        this.hpMid.frequency.value = 3100;
        this.hpMid.Q.value = 1.1;
        this.hpMid.gain.value = 1.8;
        this.hpHigh.type = 'highshelf';
        this.hpHigh.frequency.value = 10500;
        this.hpHigh.gain.value = 2.0;
        break;
      case 'airpods_pro':
        this.hpLow.type = 'lowshelf';
        this.hpLow.frequency.value = 75;
        this.hpLow.gain.value = -2.3;
        this.hpMid.type = 'peaking';
        this.hpMid.frequency.value = 2600;
        this.hpMid.Q.value = 1.1;
        this.hpMid.gain.value = 2.2;
        this.hpHigh.type = 'highshelf';
        this.hpHigh.frequency.value = 10500;
        this.hpHigh.gain.value = 1.4;
        break;
      case 'mdr7506':
        this.hpLow.type = 'lowshelf';
        this.hpLow.frequency.value = 58;
        this.hpLow.gain.value = 2.8;
        this.hpMid.type = 'peaking';
        this.hpMid.frequency.value = 3400;
        this.hpMid.Q.value = 1.6;
        this.hpMid.gain.value = -3.6;
        this.hpHigh.type = 'peaking';
        this.hpHigh.frequency.value = 9800;
        this.hpHigh.Q.value = 1.8;
        this.hpHigh.gain.value = -2.0;
        break;
    }

    // 2. ISO 226:2023 Equal-Loudness Fletcher-Munson Perception Simulator
    this.splLow.type = 'lowshelf';
    this.splLow.frequency.value = 115;
    this.splPres.type = 'peaking';
    this.splPres.frequency.value = 3500;
    this.splPres.Q.value = 1.25;

    if (this.splMonitorMode === 'quiet_55') {
      this.splLow.gain.value = -5.5;
      this.splPres.gain.value = 1.6;
      this.splTrim.gain.value = 0.56;
    } else if (this.splMonitorMode === 'club_98') {
      this.splLow.gain.value = 3.2;
      this.splPres.gain.value = 2.6;
      this.splTrim.gain.value = 0.82;
    } else {
      this.splLow.gain.value = 0;
      this.splPres.gain.value = 0;
      this.splTrim.gain.value = 0.92;
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
        this.vHpf.Q.value = 1.15;
        this.vMid.frequency.value = 420;
        this.vMid.Q.value = 1.2;
        this.vMid.gain.value = -2.8;
        this.vLpf.frequency.value = 15500;
        this.vLpf.Q.value = 0.9;
        this.vTrim.gain.value = 0.9;
        break;
      case 'club':
        this.vHpf.frequency.value = 32;
        this.vHpf.Q.value = 1.35;
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
      dest: AudioNode
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
    // Route mstNode through the <3 ms incremental M/S live preview chain -> mstGain
    this.mstNode = makeSource(this.masterAudioBuf, this.liveTrimGain!);
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
