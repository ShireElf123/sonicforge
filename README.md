# SonicForge Pro v2.0 — Browser Mastering & Stem Finishing Workstation

**SonicForge Pro** is a browser-native audio mastering and stem-finishing workstation built around deterministic 64-bit floating-point PCM DSP in dedicated Web Workers, real ITU-R BS.1770-5 loudness & 4x/8x polyphase True-Peak metering, Linear-Phase FIR & Dynamic Spectral Stabilization, local 4-stem HPSS + M/S extraction, lossy codec ISP & speaker translation auditioning, album batch mastering, and hardened Express API services.

---

## Core Architecture & Signal Chain

All mastering DSP runs off the main thread inside a dedicated Web Worker (`src/workers/dsp.worker.ts`) using 64-bit internal filter state and zero-latency sample-synced Web Audio auditioning (`src/audio/playbackEngine.ts`).

### 9-Stage Mastering Signal Chain (`src/dsp/processors.ts`)

1. **Multi-Stem Sum Bus & Local 4-Stem Demixer (`src/dsp/stemDemixer.ts`)**
   - Discrete 4-slot stem mixer (`Drums`, `Bass`, `Vocals`, `Instruments`) with trim, pan, width, mute, solo, and phase-invert, plus cubic Hermite sample-rate alignment.
   - **Local Zero-Upload 4-Stem Extraction**: 2048-pt / 75%-overlap COLA STFT Harmonic-Percussive Source Separation (HPSS) + azimuthal Mid/Side center isolation + sub crossover (`140 Hz`) with strict **Partition-of-Unity complex Wiener masks** (`reconstructionNullDb < -115 dB` float32 machine epsilon).
2. **Input Trim & Subsonic Protection**
   - Cascaded 24 dB/oct Butterworth DC / rumble high-pass filter (`10–80 Hz`).
3. **8-Band Mid/Side Mastering Parametric EQ (`src/dsp/biquad.ts` & `src/dsp/linearPhaseAndStabilizer.ts`)**
   - Switchable **Minimum-Phase IIR** (64-bit RBJ biquads) or **Zero-Phase Linear-Phase FIR** (`2049-tap` Blackman-Harris windowed impulse via `N = 8192` Overlap-Add FFT convolution — `0.0°` phase shift across Stereo, Mid, and Side channels).
4. **75%-COLA STFT Dynamic Spectral Stabilizer (`src/dsp/linearPhaseAndStabilizer.ts`)**
   - Per-bin adaptive resonance suppressor (`2048-pt` Hann STFT, `4x` overlap COLA) with selectable **De-Harsh (`2–9 kHz`)**, **Tonal Anchor**, or **Full-Spectrum Smooth** curves, frequency-smoothed envelope tracking, and live 64-bin dynamic suppression telemetry on the EQ graph.
5. **Phase-Compensated 4-Band Linkwitz-Riley (LR4, 24 dB/oct) Multiband Compressor**
   - Crossover tree (`120 Hz`, `1.2 kHz`, `6.5 kHz`) with matched all-pass phase compensation (`AP2 @ fMid`) so unity-gain crossover splits sum flat in magnitude and phase.
6. **Elliptical Bass-Mono Crossover & Mid/Side Stereo Imager**
   - Phase-aligned LR2 bass-mono Side high-pass (`20–250 Hz`), Mid/Side width matrix, and live goniometer phase correlation (`-1.0` to `+1.0`) + mono fold-down loss metering.
7. **2x Oversampled Harmonic Exciter**
   - Half-band polyphase 2x upsampler/downsampler with asymmetrical tube (`tanh` + even-order bias) or odd-order tape saturation above a high-pass drive crossover (`600–8000 Hz`).
8. **Look-Ahead Brickwall True-Peak Limiter + IRC-V Transient/Sustain Split (`src/dsp/truePeak.ts`)**
   - Selectable **Transparent**, **Punch**, or **IRC-V Transient/Sustain Split** (`irc_transient`) dynamics — separating differential fast/slow envelopes ahead of the 3 ms look-ahead sliding-minimum gain computer + program-dependent dual-stage release + 4x/8x polyphase Sinc inter-sample True-Peak ceiling enforcement.
9. **TPDF Dither, RIFF `LIST-INFO` Metadata & Verified Master WAV Export (`src/dsp/wav.ts`)**
   - 16-bit PCM (with 2-LSB TPDF triangular dither + optional shaped high-pass dither), 24-bit PCM, or 32-bit IEEE Float WAV export (`44.1 / 48 / 96 kHz`), embedding standard **RIFF `LIST-INFO`** tags (`INAM`, `IART`, `IPRD`, `ISRC`, `ICMT`, `ISFT`) with automatic **post-encode decode & BS.1770-5 verification** before download.

---

## Measurement, Auditioning & Delivery Suite

- **ITU-R BS.1770-5 Loudness (`src/dsp/lufs.ts`)**: Exact K-weighting cascade (`48 kHz` spec tables + arbitrary sample-rate bilinear adaptation), 400 ms momentary, 3 s short-term, dual-gated (`-70 LUFS` absolute + `-10 LU` relative) integrated LUFS, and Loudness Range (LRA).
- **4x / 8x Polyphase FIR True Peak (`src/dsp/truePeak.ts`)**: Kaiser-windowed polyphase Sinc inter-sample peak detector (`0.00 dBTP` precision on worst-case `Fs/4` phase-shifted tones).
- **5 Sample-Synced Audition Modes + 5 Speaker Translation Voicings (`src/audio/playbackEngine.ts`)**:
  - Instant crossfaded **Original Input**, **Mastered**, **Loudness-Matched Master** (eliminating loudness bias), **Effect Delta (`Master − Dry`)**, **Lossy Codec Preview (`AAC 256k` / `Ogg 160k` / `MP3 128k`)**, and **Codec Artifact Solo (`Post-Codec − Pre-Codec`)**.
  - Real-time acoustic translation filters: **Flat Reference**, **Smartphone Speaker**, **Car Cabin**, **Club PA**, and **Midrange Cube (Mono)**.
- **Multi-Track Album / EP Batch Mastering & JSON Presets (`src/components/CodecAndAlbumModule.tsx`)**:
  - **Album Cohesive Mode** preserves natural inter-track dynamic offsets (up to `-5.0 LU` for intros/interludes relative to the loudest anchor track) or **Uniform Single Mode** normalizes every track to the target LUFS, with one-click verified WAV export per track.
  - Portable `sonicforge-preset-v1` JSON chain save/recall.
- **Signal-Driven Mastering Assistant (`src/dsp/assistant.ts` & `server/advisor.ts`)**:
  - Deterministic DSP parameterization derived from real Crest Factor, LUFS, LRA, 4-band tonal balance vs reference targets, narrowband spectral resonances (auto-engaging the **Spectral Stabilizer** when harshness is detected), and stereo correlation — with optional server-side LLM engineering notes (`OPENAI_API_KEY` stays strictly server-side).

---

## Quick Start

```bash
# Install dependencies
npm install

# Run full-stack studio (Express API + Vite HMR on 0.0.0.0:3000)
npm run dev

# Run TypeScript check, 16-test DSP/ProSuite/API verification suite, and production build
npm run typecheck
npm test
npm run build
```

---

## Automated Verification Suite (`npm test`)

- `tests/dsp.test.ts`:
  - ITU-R BS.1770-5 K-weighting & dual-gate LUFS calibration (`997 Hz` full-scale sine = `-3.01 LUFS ±0.08 LU`).
  - `Fs/4` 45°-shifted Nyquist/2 tone inter-sample overshoot (`+3.01 dBTP` vs `0.00 dBFS` sample peak).
  - Phase-compensated LR4 4-band crossover flat reconstruction (`±0.25 dB` across `40 Hz – 16 kHz`).
  - End-to-end Spotify `-14.0 LUFS / -1.0 dBTP` master render & post-encode 24-bit WAV audit.
  - 4-stem mixer solo/mute/resampling & 16/24/32-bit WAV round-trip verification.
- `tests/proSuite.test.ts`:
  - `2049-tap` Zero-Phase Linear FIR Mastering EQ boost accuracy + `0.0°` passband phase verification (`> 40 dB` null on untouched tones).
  - `75%-COLA` STFT Dynamic Spectral Stabilizer narrowband `4 kHz` harshness suppression (`> 4 dB` targeted cut while preserving `220 Hz` fundamental).
  - Local Partition-of-Unity 4-stem HPSS + M/S demixer (`reconstructionNullDb < -85 dB`).
  - `IRC-V Transient/Sustain Split` `-9.0 LUFS / -0.8 dBTP` 8x True-Peak Club Master, lossy codec headroom audit (`AAC 256k`, `Ogg 160k`, `MP3 128k`), and RIFF `LIST-INFO` (`INAM`, `IART`, `IPRD`, `ISRC`) WAV metadata round-trip.
- `tests/server.test.ts`:
  - Security headers (`CSP`, `X-Frame-Options`, `X-Content-Type-Options`), Zod schema validation, optional HMAC bearer token enforcement, and payload size caps.
