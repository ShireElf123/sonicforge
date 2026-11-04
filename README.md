# SonicForge AI

AI-assisted audio mastering platform built with React, TypeScript, Vite, Express and the Web Audio API.

## Project status

This repository is being prepared for its initial application-source import. The current prepared source package is available separately as **sonicforge-ai-prepared.zip**.

The application is a development prototype, not yet production-ready. In particular:

- Integrated loudness and true-peak reporting must be implemented with standards-compliant measurement (EBU R128 / ITU-R BS.1770) and validated against reference audio.
- Authentication and subscription entitlements must be connected to a real identity and billing provider before paid access is enabled.
- Production build, type-check, dependency installation and end-to-end audio tests must pass before deployment.

## Stack

- React 19 + TypeScript + Vite
- Express API
- Web Audio API processing
- Google Gemini SDK integration

## Local development

1. Install dependencies with `npm install`.
2. Copy `.env.example` to `.env` and configure the required API keys.
3. Start the development server with `npm run dev`.

Never commit `.env` files or production secrets.

## Security

Read [SECURITY.md](./SECURITY.md) before deploying. See [AUDIT.md](./AUDIT.md) for known limitations and verification status.
