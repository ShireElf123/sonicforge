import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createApiApp } from './app.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

async function startServer(): Promise<void> {
  const app = createApiApp();
  const httpServer = http.createServer(app);
  const isProd = process.env.NODE_ENV === 'production';
  const port = Number(process.env.PORT) || 3000;
  const host = '0.0.0.0';

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      root: rootDir,
      server: {
        middlewareMode: true,
        host: '0.0.0.0',
        allowedHosts: true,
        hmr: {
          server: httpServer,
        },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(rootDir, 'dist');
    if (fs.existsSync(distDir)) {
      app.use(express.static(distDir));
      app.get('*', (req, res, next) => {
        if (req.path.startsWith('/api/')) {
          next();
          return;
        }
        res.sendFile(path.join(distDir, 'index.html'));
      });
    }
  }

  httpServer.listen(port, host, () => {
    console.log(
      `[SonicForge Pro] Studio server listening on http://${host}:${port} (${isProd ? 'production' : 'development'})`
    );
  });
}

void startServer();
