# Competitive Review: SonicForge Pro v2.0 vs. Industry Mastering Suites

**Benchmark Targets:** iZotope Ozone 12 Advanced, FabFilter Mastering Bundle (Pro-Q 4 / Pro-MB / Pro-L 2), LANDR / eMastered / CloudBounce.

---

## 1. Feature & DSP Capability Matrix

| Capability | SonicForge Pro v2.0 (Browser Local) | iZotope Ozone 12 Adv. (Desktop DAW) | FabFilter Bundle (Desktop DAW) | LANDR / eMastered (Cloud SaaS) |
| :--- | :--- | :--- | :--- | :--- |
| **Deployment & Privacy** | **Zero-install browser app; 100% local PCM DSP (audio never uploaded)** | Desktop installer + iLok/auth ($499) | Desktop installer ($499+) | Mandatory cloud upload + subscription |
| **EQ Topology** | **8-band 64-bit M/S IIR + 2049-tap Zero-Phase Linear FIR** | 8-band IIR + Linear Phase | 24-band IIR + Linear Phase | Hidden black-box preset |
| **Dynamic Spectral Shaping** | **75%-COLA STFT Dynamic Spectral Stabilizer (`De-Harsh`, `Tonal`, `Smooth`)** | Ozone Stabilizer + Clarity | Pro-Q 4 Spectral Dynamics | Fixed automated EQ |
| **Multiband Dynamics** | **Phase-compensated 4-band LR4 (24 dB/oct) w/ all-pass alignment** | 4-band IIR / Linear Phase | Free-form 6-band dynamic phase | 3 intensity buttons |
| **Low-End & Stereo** | **LR2 Elliptical Bass-Mono + M/S Width + Goniometer + Mono Fold Loss** | Imager + Low-End Focus | Pro-Q / Pro-MB M/S | Simple width slider |
| **Harmonic Saturation** | **2x Polyphase Oversampled Tube (even) & Tape (odd) Exciter** | Multiband Exciter (6 modes) | Saturn 2 (separate purchase) | Fixed warmth toggle |
| **Maximizer / Limiter** | **3 ms Look-Ahead + 4x/8x Polyphase True Peak + IRC-V Transient/Sustain Split** | IRC I–V + Transient/Sustain | Pro-L 2 (8 styles + 32x TP) | Opaque loudness Low/Med/High |
| **Stem Workflow** | **Discrete 4-Stem Console + Local Partition-of-Unity 4-Stem Demixer (`<-115 dB` sum null)** | Stem Focus (neural RX weights) | Requires external DAW routing | Paid add-on / stereo only |
| **Auditioning & Translation** | ** Loudness-Matched A/B, Effect Delta, Lossy Codec (`AAC/Ogg/MP3`) + Artifact Solo, 5 Speaker Voicings** | Gain Match, Codec Preview | Gain Match + Audition Limiting | Frequently uncalibrated A/B |
| **Delivery & Batching** | **Album Cohesive Batch Queue + JSON Presets + RIFF `LIST-INFO` (`ISRC`) + Post-Encode WAV Audit** | Standalone/DAW render | DAW host dependent | Paid per-release / subscription |

---

## 2. Architectural Tradeoffs & Engineering Honesty

1. **Local HPSS + M/S Demixer vs. Multi-Hundred-MB Neural Demixers (`Demucs v4` / `MDX-Net`)**
   - *Design choice*: SonicForge Pro ships a deterministic, zero-download `2048-pt` 75%-COLA STFT Harmonic-Percussive + Mid/Side Partition-of-Unity 4-stem separator (`src/dsp/stemDemixer.ts`).
   - *Advantage*: Instant browser execution with zero external weights, zero cloud uploads, and **mathematically lossless unity reconstruction (`<-115 dB` null)** — adjusting a stem by `0 dB` introduces zero artifacts, and gentle `±1–3 dB` stem rebalancing stays phase-coherent.
   - *Limitation*: On dense overlapping center instruments (e.g., center-panned lead guitar sharing vocal formants), neural source separation models like `HTDemucs` isolate vocal timbres more cleanly than azimuthal M/S + HPSS masks. For surgical isolation, SonicForge also accepts discrete DAW stems directly in the 4-stem console.

2. **Perceptual Subband Codec Simulator vs. Licensed Native `FDK-AAC` / `LAME` WASM Binaries**
   - *Design choice*: `src/dsp/codecSim.ts` models psychoacoustic Bark-band spectral quantization and brickwall high-frequency truncation (`20.4 kHz` AAC-256, `18.2 kHz` Ogg-160, `15.8 kHz` MP3-128) via a zero-phase COLA transform.
   - *Advantage*: Patent-clean, deterministic, zero-phase passband alignment so **`Artifact Solo` (`codec_delta`)** cleanly cancels untouched program material to isolate truncated air, pre-echo, and Gibbs True-Peak overshoot (`+0.3` to `+1.5 dBTP`).

3. **Zero-Latency Auditioning vs. Heavy Linear-Phase / STFT Processing**
   - Linear-phase FIR convolution (`2049 taps`) and 75%-COLA STFT stabilization have inherent look-ahead/window latency that makes live main-thread `ScriptProcessorNode` audio glitch-prone. SonicForge renders the full 64-bit chain asynchronously inside a dedicated Web Worker (`dsp.worker.ts`) and hot-swaps sample-aligned `AudioBuffer` nodes in Web Audio with `15 ms` equal-gain crossfades — delivering glitch-free playback even with `2049-tap` Linear-Phase EQ + STFT Stabilizer + `8x` True-Peak oversampling active simultaneously.
