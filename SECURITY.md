# Security and Audio Integrity Checklist

## Implemented security controls

- **Zero client-tier trust**: `/api/mastering/advise` enforces `.strict()` Zod validation (`server/schemas.ts`) and rejects unexpected fields such as `subscriptionTier` with HTTP `400`.
- **Cryptographically signed sessions**: `server/auth.ts` issues HMAC-SHA256 signed `HttpOnly; SameSite=Lax` cookies (`sf_session`) verified via `crypto.timingSafeEqual`.
- **Server-side secret isolation**: `GEMINI_API_KEY` is read exclusively in `server/advisor.ts` and never exposed in `VITE_*` variables or browser bundles.
- **Payload & rate guards**: Express applies a `32kb` JSON body cap, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, and sliding-window IP rate limiting (`RateLimit-*` headers, HTTP `429`).
- **Browser decode guards**: `src/audio/decodeAudioFile.ts` enforces file extension/MIME validation, non-empty checks, and a `180 MB` file size budget before decoding.

## Implemented audio measurement integrity guarantees

- **Standards-compliant LUFS**: Integrated loudness, Momentary, Short-Term, and LRA are computed strictly via ITU-R BS.1770-5 K-weighting and EBU Tech 3341/3342 gating (`src/dsp/lufs.ts`). RMS is reported separately in `dBFS` and never labeled as LUFS.
- **Oversampled True Peak**: True Peak (`dBTP`) is computed via 4x (48-tap) or 8x (96-tap) polyphase Kaiser-windowed sinc FIR interpolation (`src/dsp/truePeak.ts`), distinct from discrete Sample Peak (`dBFS`).
- **Measured output verification**: Rendered masters and exported WAV files are independently measured after processing and encoding (`src/dsp/wav.ts`), never populated from requested target settings.

## Required before commercial SaaS deployment

- Set a strong 32-byte random `SESSION_HMAC_SECRET` in production environment secrets.
- Connect a production OAuth/OIDC identity provider and server-side billing webhooks before gating paid tiers.
- Back rate limiting with Redis when deploying across multiple horizontal instances.
