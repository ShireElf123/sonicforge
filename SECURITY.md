# Security and release checklist

## Known blockers

- Do not treat a client-side token or client-supplied subscription tier as authentication or authorization.
- Production authentication must validate signed sessions or tokens on the server.
- Subscription access must be derived from server-verified entitlements, never request-body fields.
- Keep Gemini and other provider credentials server-side; never expose secrets in Vite-prefixed variables or browser bundles.
- Apply request-size limits, input validation, rate limits and safe error handling to API routes.
- Restrict upload types and sizes, and validate audio files before decoding or processing.

## Audio measurement integrity

- Do not label RMS-derived estimates as integrated LUFS.
- Do not label sample peak as true peak.
- Implement and verify ITU-R BS.1770 / EBU R128 loudness measurement and oversampled true-peak measurement before making compliance claims.
- Test with known reference signals and independently verified measurement tools.

## Before production

- Configure real identity and billing providers.
- Rotate any credentials that may have been exposed in earlier builds.
- Review dependencies and lockfile.
- Run type-check, production build, unit tests and end-to-end tests.
- Perform security review of upload, API and entitlement paths.
- Remove demo-only claims and synthetic metrics from customer-facing output.
