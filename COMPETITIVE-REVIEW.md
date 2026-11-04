# SonicForge AI — Competitive product review

**Review date:** 4 November 2026  
**Scope:** Static source review plus public product documentation. This is not a blind listening test or a lab benchmark.

## Executive position

SonicForge should not try to beat established mastering products by claiming louder, cleaner or more accurate masters before it can prove those outcomes. The strongest credible position in the current prototype is a local-first, browser-based workspace for people who already have separate stems, with fast auditioning and editable bus controls. It is not yet a verified AI mastering engine, stem separator, or release-compliance validator.

## Competitive snapshot

| Product | Demonstrated strengths from current public product material | Implication for SonicForge |
|---|---|---|
| LANDR | AI mastering with adaptive processing; tone/loudness choices and revision workflow; stem separation and distribution ecosystem. | Do not claim LANDR lacks stems, reference tools or professional processing. Differentiate through transparent local processing and hands-on multistem mixing, if measured and tested. |
| eMastered | AI mastering, reference mastering, advanced manual mastering controls, stem separation, and distribution in Studio plans. | A basic genre preset or reference upload alone will not be a differentiator. Build a stronger, measurable reference workflow and explain what runs locally. |
| iZotope Ozone 12 | Master Assistant custom flow, reference tracks, extensive editable modules, IRC 5 Maximizer, Stem EQ and Stem Focus (Advanced). | Ozone is the benchmark for controllability and mature DSP. SonicForge must close measurement, limiting, metering, and export-integrity gaps before claiming parity. |

## What is real in the current code

- React/TypeScript interface with stereo and four-bus stem modes.
- Web Audio API playback graph, EQ, saturation, dynamics, stereo controls and A/B auditioning.
- User-supplied stem slots for drums, bass, vocals and instruments, with bus-level controls.
- WAV rendering/export code paths.
- Optional Gemini metadata-based guidance. The analysis API does not receive the audio PCM samples.

## What must not be marketed as complete

- AI stem separation: not implemented; SonicForge accepts already separated stems.
- BS.1770 / EBU R128 integrated loudness measurement: not implemented.
- Oversampled true-peak measurement and validated true-peak limiting: not implemented or verified.
- Actual output LUFS: the API currently returns the requested target as a model field; it does not measure the rendered file.
- Spectral centroid, phase stability, FFT-based band analysis and waveform comparisons: some current API/profile values are formula-generated or illustrative, not derived from actual PCM.
- Production subscription enforcement, authentication, user accounts, and billing: not implemented.
- Blind listening / codec / device translation benchmark: not performed.

## Recommended product strategy

### P0 — Trust and signal integrity
1. Build one PCM analysis path used for both source and rendered output.
2. Implement and test BS.1770-5 / EBU R128 integrated and momentary/short-term loudness, loudness range, channel weighting, and gating.
3. Implement oversampled true-peak measurement (at least 4x, preferably configurable 4x/8x) and a real look-ahead limiter with release/latency reporting.
4. Replace synthetic waveform and fixed spectral values with measurements from the decoded buffers and final render.
5. Add gain-matched bypass and delta/null audition; never compare louder audio as though it is automatically better.
6. Verify exports with independent decoders and test vectors: PCM bit depth, sample rate, channel layout, clipping, dither, duration and metadata.

### P1 — Competitive mastering workflow
1. Reference mastering: import a reference, loudness-match audition, compare tonal balance by measured bands, and expose target curves as optional suggestions—not automatic truth.
2. Real multiband dynamics and dynamic EQ with user-visible controls, sidechain routing and oversampling options.
3. Mono compatibility, correlation, stereo width by frequency, phase checks and low-frequency mono controls.
4. Streaming delivery profiles with transparent targets and measured post-render reports. Do not promise that one LUFS number guarantees acceptance or best sound on every service.
5. A/B snapshots, undo/redo, presets, session recall, batch mastering and album sequencing with inter-track consistency.
6. Proper stem workflow: alignment checks, sample-rate/channel matching, latency compensation, phase correlation, bus solo/mute, summed-master verification and export of both stems and full mix.

### P2 — Product quality and scale
1. Move heavy offline rendering and analysis to AudioWorklet / Web Workers where appropriate; keep UI responsive and report progress/cancel state.
2. Support long files safely with memory budgets, decode limits, cancellation and recovery from browser tab suspension.
3. Add verified user identity and server-side subscription entitlements before monetization; use a shared rate-limit store and request quotas.
4. Add automated test fixtures, visual regression, accessibility, telemetry with privacy controls, and a public status / privacy page.
5. Create a reproducible benchmark set across genres and source quality. Blind-test against LANDR, eMastered and Ozone with loudness-matched exports and multiple playback systems.

## Success gates before public launch
- No UI claims that an unmeasured target is a measured result.
- Loudness and true peak independently verified on the actual rendered PCM.
- No clipping or export corruption across the supported file matrix.
- Blind-test results published with methodology, source files, level matching and limitations.
- Production authentication, entitlements, billing and privacy disclosures verified.
- Clean install, lockfile, typecheck, build, automated tests and browser QA all pass.

## Public references
- LANDR mastering overview: https://support.landr.com/hc/en-us/articles/115009725688-What-is-LANDR-Mastering
- LANDR supported content: https://support.landr.com/hc/en-us/articles/115009556387-What-can-I-master-with-LANDR
- eMastered product/pricing and reference mastering: https://emastered.com/en/pricing
- eMastered plan features: https://help.emastered.com/hc/en-us/articles/5615662953101-How-much-does-eMastered-cost-and-what-is-included
- iZotope Ozone 12 Standard: https://www.izotope.com/products/ozone-standard?tab=features
- iZotope Ozone 12 Advanced: https://www.izotope.com/products/ozone-advanced?tab=features

Competitor features and plan entitlements change. Re-check vendor pages before publishing price or plan comparisons.
