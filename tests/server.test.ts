import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiApp } from '../server/app.js';
import { issueSignedSessionToken, verifySignedSessionToken } from '../server/auth.js';
import { createDefaultMasteringParams } from '../src/dsp/profiles.js';

describe('Express & Vercel Serverless API Security, Validation & Multi-Engine AI Co-Pilot', () => {
  let server: Server;
  let baseUrl = '';

  beforeAll(async () => {
    const app = createApiApp();
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          baseUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('signs and verifies HMAC-SHA256 session tokens and rejects tampered signatures', () => {
    const token = issueSignedSessionToken({
      sessionId: 'test-uuid-123',
      mode: 'local_studio_workspace',
      entitlements: {
        stereoMastering: true,
        stemConsole: true,
        losslessWavExport: true,
        aiDiagnostics: true,
        billingConfigured: false,
      },
      issuedAtIso: new Date().toISOString(),
    });
    expect(verifySignedSessionToken(token)?.sessionId).toBe('test-uuid-123');
    expect(verifySignedSessionToken(`${token}tampered`)).toBeNull();
  });

  it('serves /api/health (and Vercel-rewritten /health) and issues HttpOnly signed session cookie', async () => {
    const hRes = await fetch(`${baseUrl}/api/health`);
    expect(hRes.status).toBe(200);
    const hBody = await hRes.json();
    expect(hBody.status).toBe('ok');
    expect(hBody.aiEngines.sonicforgeOwnAi).toBe(true);
    expect(hRes.headers.get('x-content-type-options')).toBe('nosniff');

    // Verify Vercel serverless URL normalization (/health -> /api/health)
    const vRes = await fetch(`${baseUrl}/health`);
    expect(vRes.status).toBe(200);

    const sRes = await fetch(`${baseUrl}/api/session`);
    expect(sRes.status).toBe(200);
    expect(sRes.headers.get('set-cookie')).toContain('HttpOnly');
    const sBody = await sRes.json();
    expect(sBody.session.mode).toBe('local_studio_workspace');
  });

  const validSourceSummary = {
    sampleRate: 48000,
    channelCount: 2,
    durationSec: 8.1,
    integratedLufs: -18.4,
    shortTermMaxLufs: -17.2,
    momentaryMaxLufs: -15.8,
    loudnessRangeLu: 4.6,
    truePeakDbtp: -3.2,
    samplePeakDbfs: -3.8,
    ispMarginDb: 0.6,
    plrDb: 15.2,
    crestFactorDb: 13.5,
    centroidHz: 1850,
    spectralTiltDbPerOct: -4.6,
    correlation: 0.72,
    lowBandCorrelation: 0.64,
    monoFoldDownLossDb: 1.4,
    bands: [
      { id: 'sub' as const, energyDb: -24, relativeDb: -2.0 },
      { id: 'low' as const, energyDb: -16, relativeDb: 6.0 },
      { id: 'lowMid' as const, energyDb: -17, relativeDb: 5.0 },
      { id: 'highMid' as const, energyDb: -21, relativeDb: 1.0 },
      { id: 'high' as const, energyDb: -25, relativeDb: -3.0 },
      { id: 'air' as const, energyDb: -29, relativeDb: -7.0 },
    ],
  };

  const validAdvisePayload = {
    trackName: 'Neon Horizon Mix',
    workflowMode: 'stereo',
    deliveryProfile: 'spotify',
    tonalPreset: 'modern_punch',
    targetLufs: -14.0,
    ceilingDbtp: -1.0,
    source: validSourceSummary,
  };

  it('rejects spoofed client subscriptionTier fields in /api/mastering/advise', async () => {
    const res = await fetch(`${baseUrl}/api/mastering/advise`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...validAdvisePayload,
        subscriptionTier: 'enterprise_pro_spoof',
      }),
    });
    expect(res.status).toBe(400);
  });

  it('returns acoustic archetype classification and signal-grounded mastering advice', async () => {
    const res = await fetch(`${baseUrl}/api/mastering/advise`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validAdvisePayload),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.provider).toBe('sonicforge_own_ai');
    expect(body.archetype.confidencePct).toBeGreaterThanOrEqual(68);
    expect(body.observations.length).toBeGreaterThan(0);
    expect(body.actionableSteps.length).toBeGreaterThan(0);
    expect(body.privacyNotice).toContain('browser');
  });

  it('compiles natural-language mastering prompts into concrete DSP chain patches on /api/mastering/chat', async () => {
    const defaultChain = createDefaultMasteringParams('spotify');
    const res = await fetch(`${baseUrl}/api/mastering/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt:
          'Make the vocals cut through without harshness and push club loudness to -9.5 LUFS',
        trackName: 'Neon Horizon Mix',
        preferEngine: 'own_ai',
        currentParams: defaultChain,
        source: validSourceSummary,
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.provider).toBe('sonicforge_own_ai');
    expect(body.patchItems.length).toBeGreaterThanOrEqual(3);
    expect(body.updatedParams).toBeTruthy();
    expect(body.updatedParams.limiter.targetLufs).toBeCloseTo(-9.5, 1);
    expect(body.updatedParams.stabilizer.enabled).toBe(true);
    expect(body.updatedParams.eqBands[4].gainDb).toBeGreaterThan(0);
    expect(body.reply).toContain('-18.4 LUFS');
  });
});
