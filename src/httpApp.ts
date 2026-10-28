import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import type { Logger } from './logger.js';
import { bearerMatches, type SendService } from './sendService.js';

export type HttpAppDeps = {
  sendService: SendService;
  /** The bearer is checked before the body is read or parsed. */
  sendToken: string;
  logger: Logger;
};

/** Routes that sit beside the SDK's /api/messages. The SDK mounts its own route on the same Express app. */
export function mountRoutes(app: Express, deps: HttpAppDeps): void {
  app.disable('x-powered-by');

  // Liveness only: no auth, no secrets, no dependency checks (the bot has no database).
  app.get('/healthz', (_req, res) => {
    res.status(200).json({ ok: true });
  });

  const guard = (req: Request, res: Response, next: NextFunction) => {
    if (!bearerMatches(req.get('authorization'), deps.sendToken)) {
      res.status(401).json({ status: 'unauthorized' });
      return;
    }
    next();
  };

  app.post('/v1/send', guard, express.json({ limit: '64kb' }), async (req: Request, res: Response) => {
    const out = await deps.sendService.handle({
      authorization: req.get('authorization'),
      idempotencyKey: req.get('idempotency-key'),
      body: req.body as unknown,
    });
    for (const [k, v] of Object.entries(out.headers ?? {})) res.setHeader(k, v);
    res.status(out.status).json(out.body);
  });
}

/** Mounted after the SDK has registered its routes. */
export function mountFallbacks(app: Express, logger: Logger): void {
  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const type = (err as { type?: string } | null)?.type;
    if (type === 'entity.parse.failed' || type === 'entity.too.large') {
      res.status(400).json({ status: 'invalid_request', detail: type === 'entity.too.large' ? 'body too large' : 'body must be valid JSON' });
      return;
    }
    logger.error('http_error', { code: 'UNHANDLED' });
    res.status(500).json({ error: 'internal' });
  });
}
