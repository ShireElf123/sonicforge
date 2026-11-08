import type { NextFunction, Request, Response } from 'express';

interface WindowBucket {
  count: number;
  resetAtMs: number;
}

export function createRateLimiter(options: { windowMs: number; maxRequests: number }) {
  const buckets = new Map<string, WindowBucket>();

  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    let entry = buckets.get(ip);

    if (!entry || now >= entry.resetAtMs) {
      entry = { count: 0, resetAtMs: now + options.windowMs };
      buckets.set(ip, entry);
    }

    entry.count++;

    const remaining = Math.max(0, options.maxRequests - entry.count);
    res.setHeader('RateLimit-Limit', String(options.maxRequests));
    res.setHeader('RateLimit-Remaining', String(remaining));
    res.setHeader('RateLimit-Reset', String(Math.ceil((entry.resetAtMs - now) / 1000)));

    if (entry.count > options.maxRequests) {
      res.status(429).json({
        error: 'Rate limit exceeded. Please wait before requesting additional mastering diagnostics.',
        retryAfterSec: Math.ceil((entry.resetAtMs - now) / 1000),
      });
      return;
    }

    // Periodic cleanup of expired buckets to prevent unbounded memory growth
    if (buckets.size > 2000) {
      for (const [k, v] of buckets.entries()) {
        if (now >= v.resetAtMs) buckets.delete(k);
      }
    }

    next();
  };
}
