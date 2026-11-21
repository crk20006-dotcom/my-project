import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { createServer as createViteServer } from 'vite';
import { getDb } from './server/db.ts';
import { createApiRouter } from './server/routes/api.ts';
import { logSystemEvent } from './server/system/logger.ts';

async function startServer(): Promise<void> {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '0.0.0.0';

  // Initialize local SQLite database
  getDb();

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  // Security headers compatible with local execution & AI Studio preview iframe
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-DNS-Prefetch-Control', 'off');
    res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), payment=(), usb=()');
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' data: https://fonts.gstatic.com",
        "img-src 'self' data: blob:",
        "media-src 'self' data: blob:",
        "worker-src 'self' blob:",
        "connect-src 'self' http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*",
        "object-src 'none'",
        "base-uri 'self'",
        "frame-ancestors 'self' https://aistudio.google.com https://*.aistudio.google.com https://*.googleusercontent.com",
      ].join('; ')
    );
    next();
  });

  app.use(express.json({ limit: '12mb' }));

  // Mount Project Genesis modular API
  app.use('/api', createApiRouter());

  if (process.env.NODE_ENV === 'production') {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(
      express.static(distDir, {
        maxAge: '1h',
        setHeaders: (res, filePath) => {
          if (filePath.endsWith('sw.js') || filePath.endsWith('index.html') || filePath.endsWith('manifest.webmanifest')) {
            res.setHeader('Cache-Control', 'no-cache');
          }
        },
      })
    );
    app.get('*', (_req, res) => {
      const indexFile = path.join(distDir, 'index.html');
      if (fs.existsSync(indexFile)) {
        res.sendFile(indexFile);
      } else {
        res.status(404).send('Build output not found. Run npm run build first.');
      }
    });
  } else {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  // Centralized error boundary (never exposes stack traces to clients)
  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction
    ) => {
      const isSyntaxErr = err instanceof SyntaxError && 'body' in err;
      const status = isSyntaxErr ? 400 : 500;
      const safeMsg = isSyntaxErr
        ? 'Malformed JSON request payload.'
        : 'An unexpected internal server error occurred.';
      logSystemEvent('error', 'http', safeMsg, err);
      if (!res.headersSent) {
        res.status(status).json({ error: safeMsg });
      }
    }
  );

  app.listen(port, host, () => {
    logSystemEvent('info', 'startup', `Core Platform listening on http://${host}:${port}`);
    console.log(`[Project Genesis] Core Platform listening on http://${host}:${port}`);
  });
}

startServer().catch((err) => {
  logSystemEvent('error', 'startup', 'Failed to start server', err);
  console.error('[Project Genesis] Failed to start server:', err);
  process.exit(1);
});
