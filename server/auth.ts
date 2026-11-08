import crypto from 'node:crypto';
import type { Request, Response } from 'express';

export interface VerifiedSession {
  sessionId: string;
  mode: 'local_studio_workspace';
  entitlements: {
    stereoMastering: boolean;
    stemConsole: boolean;
    losslessWavExport: boolean;
    aiDiagnostics: boolean;
    billingConfigured: boolean;
  };
  issuedAtIso: string;
}

const COOKIE_NAME = 'sf_session';

function getHmacSecret(): string {
  return process.env.SESSION_HMAC_SECRET || 'sonicforge-dev-ephemeral-hmac-key-do-not-use-in-prod';
}

function signPayload(payloadB64: string): string {
  return crypto.createHmac('sha256', getHmacSecret()).update(payloadB64).digest('base64url');
}

export function issueSignedSessionToken(session: VerifiedSession): string {
  const payloadB64 = Buffer.from(JSON.stringify(session), 'utf8').toString('base64url');
  const sig = signPayload(payloadB64);
  return `${payloadB64}.${sig}`;
}

export function verifySignedSessionToken(token: string | undefined): VerifiedSession | null {
  if (!token || !token.includes('.')) return null;
  const [payloadB64, sig] = token.split('.', 2);
  if (!payloadB64 || !sig) return null;

  const expectedSig = signPayload(payloadB64);
  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as VerifiedSession;
    if (!parsed.sessionId || parsed.mode !== 'local_studio_workspace') return null;
    return parsed;
  } catch {
    return null;
  }
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) return {};
  const out: Record<string, string> = {};
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) {
      const k = part.slice(0, idx).trim();
      const v = part.slice(idx + 1).trim();
      out[k] = decodeURIComponent(v);
    }
  }
  return out;
}

export function getOrCreateVerifiedSession(req: Request, res: Response): VerifiedSession {
  const cookies = parseCookies(req.headers.cookie);
  const existing = verifySignedSessionToken(cookies[COOKIE_NAME]);
  if (existing) {
    return existing;
  }

  const fresh: VerifiedSession = {
    sessionId: crypto.randomUUID(),
    mode: 'local_studio_workspace',
    entitlements: {
      stereoMastering: true,
      stemConsole: true,
      losslessWavExport: true,
      aiDiagnostics: true,
      billingConfigured: false,
    },
    issuedAtIso: new Date().toISOString(),
  };

  const token = issueSignedSessionToken(fresh);
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`
  );
  return fresh;
}
