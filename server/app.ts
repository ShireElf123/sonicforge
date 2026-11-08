import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import {
  type CustomAiCredentials,
  generateMasteringAdvice,
  generateMasteringChatReply,
} from './advisor.js';
import { getOrCreateVerifiedSession } from './auth.js';
import { createRateLimiter } from './rateLimit.js';
import {
  MasteringAdviseRequestSchema,
  MasteringChatRequestSchema,
} from './schemas.js';

function extractCustomAiCreds(req: Request): CustomAiCredentials | undefined {
  const rawKey = req.header('x-ai-api-key')?.trim();
  const rawProvider = req.header('x-ai-provider')?.trim();
  if (!rawKey || !rawProvider) return undefined;
  if (
    rawProvider === 'gemini' ||
    rawProvider === 'groq' ||
    rawProvider === 'openrouter' ||
    rawProvider === 'openai'
  ) {
    return { provider: rawProvider, apiKey: rawKey.slice(0, 260) };
  }
  return undefined;
}

export function createApiApp(): Express {
  const app = express();
  app.disable('x-powered-by');

  // Normalize rewritten serverless URLs on Vercel (/health -> /api/health)
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (!req.url.startsWith('/api')) {
      req.url = `/api${req.url.startsWith('/') ? '' : '/'}${req.url}`;
    }
    next();
  });

  // Security headers (preserving iframe preview compatibility while hardening MIME & referrer)
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
    next();
  });

  // Strict 64 KB JSON body size limit
  app.use('/api', express.json({ limit: '64kb' }));

  const apiLimiter = createRateLimiter({ windowMs: 60_000, maxRequests: 60 });
  app.use('/api', apiLimiter);

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      engine: 'SonicForge Pro DSP v5.0',
      standards: [
        'ITU-R BS.1770-5 (2-Pass Iterative ±0.05 LU Closed-Loop Convergence)',
        'EBU R128 / Tech 3341 & 3342',
        '4x/8x/16x Polyphase Kaiser-Sinc True Peak (192-Tap FIR)',
        'Cubic Hermite Waveform De-Clipper + Band-Focused Drum Transient Recovery',
        'Split-Band Mid Vocal Sibilance De-Esser + Parallel Upward Inflator Micro-Lift',
        '4x Polyphase Kaiser-Sinc M/S Dual-Stage Analog Harmonic Exciter + 24dB/oct LR4 Bass Mono',
        'Multi-Track EP / Album Spectral Cohesion & Loudness Sequencer + Zero-Click Polish',
        'Section-Aware Arrangement Macro-Dynamics + Phantom-Fundamental Bass Translator',
        'REPET-SIM + Formant 4-Stem Demixer v2 + Inter-Stem Collision Unmasker',
        'Hardware W3C WebCodecs AAC/Opus + 24-Bark Psychoacoustic Codec Engine',
      ],
      aiEngines: {
        sonicforgeOwnAi: true,
        freeCloudAi: process.env.DISABLE_FREE_CLOUD_AI !== 'true',
        browserTransformersWebGpuWasm: true,
        groqConfigured: Boolean(process.env.GROQ_API_KEY?.trim()),
        geminiConfigured: Boolean(process.env.GEMINI_API_KEY?.trim()),
        openRouterConfigured: Boolean(process.env.OPENROUTER_API_KEY?.trim()),
        openAiConfigured: Boolean(process.env.OPENAI_API_KEY?.trim()),
      },
      timestamp: new Date().toISOString(),
    });
  });

  // Server-derived signed session & workspace entitlements (never trusts client-supplied tiers)
  app.get('/api/session', (req: Request, res: Response) => {
    const session = getOrCreateVerifiedSession(req, res);
    res.json({ session });
  });

  // Validated mastering diagnostic endpoint
  app.post('/api/mastering/advise', async (req: Request, res: Response) => {
    getOrCreateVerifiedSession(req, res);

    const parsed = MasteringAdviseRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'Invalid mastering metrics payload.',
        details: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
      return;
    }

    const creds = extractCustomAiCreds(req);
    const advice = await generateMasteringAdvice(parsed.data, creds);
    res.json(advice);
  });

  // Conversational AI Mastering Co-Pilot & Natural-Language DSP Patch endpoint
  app.post('/api/mastering/chat', async (req: Request, res: Response) => {
    getOrCreateVerifiedSession(req, res);

    const parsed = MasteringChatRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'Invalid mastering co-pilot chat payload.',
        details: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
      return;
    }

    const creds = extractCustomAiCreds(req);
    const reply = await generateMasteringChatReply(parsed.data, creds);
    res.json(reply);
  });

  // Clean JSON error handler for malformed JSON or payload-too-large errors
  app.use(
    (
      err: Error & { status?: number; type?: string },
      _req: Request,
      res: Response,
      next: NextFunction
    ) => {
      if (res.headersSent) {
        next(err);
        return;
      }
      if (err.type === 'entity.too.large' || err.status === 413) {
        res.status(413).json({ error: 'Request payload exceeds 64 KB limit.' });
        return;
      }
      if (err instanceof SyntaxError) {
        res.status(400).json({ error: 'Malformed JSON body.' });
        return;
      }
      res.status(500).json({ error: 'Internal server error.' });
    }
  );

  return app;
}
