# SonicForge AI — engineering audit

**Review date:** 4 November 2026  
**Scope:** Static review of the supplied source archive and second-pass review of the working tree. This is not a certified DSP, security, or browser QA report.

## Executive verdict

**Not production-ready.** The project contains a substantial React/TypeScript interface, browser Web Audio processing, stereo and four-bus stem workflows, and an Express/Vite server. However, the API receives metadata rather than audio samples, several result values remain synthetic or formula-generated, and the project has not passed a clean install, typecheck, build, automated tests, or browser/audio QA.

The strongest credible product direction is a local-first browser workspace for producers who already have separate stems. It is not yet a validated AI mastering engine, stem separator, or release-compliance validator.

## Critical findings

### Authentication and entitlements
- The original archive included a fixed bearer value in frontend state while the API only checked whether a non-empty bearer header existed. That was not authentication.
- The API previously trusted a client-supplied subscription tier.
- The fixed bearer pattern and server-side trust in the client tier were removed in the local remediation.
- The UI tier selector and paywall are still demo-only and bypassable. There is no production identity provider, billing integration, or server-verified entitlement enforcement.

**Release requirement:** implement verified identity and derive subscription permissions server-side. Use shared rate limiting and abuse controls.

## High-severity audio findings
- Input loudness is sampled channel-1 RMS in dBFS, not ITU-R BS.1770 / EBU R128 integrated LUFS.
- Input peak is sampled channel-1 sample peak, not oversampled true peak. Sampling at intervals can miss peaks.
- The API receives track metadata only; it does not receive PCM samples or FFT frames.
- The analysis function still returns formula-generated frequency-band values, synthetic waveform comparison points, fixed stereo correlation, and target-based output values.
- The mastered integrated-LUFS field still represents the requested target rather than a measurement of rendered PCM. Some downstream fields and history still use LUFS naming.
- Reference-track level is RMS-derived and must not be described as integrated LUFS.
- The browser audio graph applies DSP settings for audition/export, but the final render is not independently measured to prove the requested loudness or peak ceiling was achieved.
- Stem metrics and initial session history include illustrative values.

**Release requirement:** build one analysis pipeline over decoded source PCM and final rendered PCM. Implement and validate BS.1770-5 / EBU R128 loudness, gating, momentary/short-term loudness, loudness range, oversampled true peak, and limiter behavior. Replace every synthetic chart/metric with real signal measurements or label it clearly as illustrative.

## Security and operations
- A basic request-size limit, request validation, per-process IP rate guard, and configurable PORT were added.
- The in-memory rate guard is not suitable for horizontally scaled production.
- API validation is not yet comprehensive for every enum, string length, numeric range, and request quota.
- The Gemini key must remain server-side; do not expose it to browser bundles.
- A privacy policy must explain that audio DSP runs in the browser but metadata may be sent to the analysis API.

## Competitive claims corrected in the working tree
- Removed unsupported zero-millisecond / zero-latency claims.
- Reworked the competitor matrix to remove invented queue times, stale pricing, and unsupported claims about competitor limitations.
- Clarified that SonicForge accepts user-supplied stems; it does not currently separate a stereo mix into stems.
- Clarified that a requested LUFS target is not a measured output result and a sample-peak estimate is not true peak.
- Removed the Gemini code-execution request from the metadata-only API path. The model is asked for cautious text suggestions only.
- Removed the client-selected subscription tier from the browser's mastering API request.

## Verification status
- Static inspection: completed for the main app, API, context, audio engine, stem console, server and key analytics UI.
- git diff --check: passed in the current working tree.
- Dependency install: attempted; timed out.
- Typecheck: attempted with global TypeScript compiler; blocked because vite/client dependencies were unavailable.
- Production build: not run successfully.
- Automated tests: none run.
- Browser QA, export integrity tests, blind listening tests and reference-meter validation: not performed.

## Release decision

**Do not launch as a paid mastering service yet.** Prioritize signal measurement, validated rendering, and security before adding more marketing claims or feature badges. See COMPETITIVE-REVIEW.md for the competitor analysis and staged roadmap.
