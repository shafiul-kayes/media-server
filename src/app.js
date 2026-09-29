import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import swaggerUiDist from 'swagger-ui-dist';
import { config } from './config.js';
import { buildOpenApiSpec } from './docs/openapi.js';
import { errorHandler, notFoundHandler, requestLogger } from './middleware/errors.js';
import { router as adminRouter } from './routes/admin.js';
import { router as apiRouter } from './routes/api.js';
import { router as compatRouter } from './routes/compat.js';
import { router as pagesRouter } from './routes/pages.js';
import { router as publicRouter } from './routes/public.js';
import { router as webRouter } from './web/index.js';

const assetsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/assets');

const DOCS_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  `connect-src 'self' ${new URL(config.baseUrl).origin}`,
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

const DOCS_HTML = `<!doctype html>
<html lang="bn">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Media Server API Docs</title>
<link rel="stylesheet" href="/docs/assets/swagger-ui.css">
</head>
<body>
<div id="swagger-ui"></div>
<script src="/docs/assets/swagger-ui-bundle.js"></script>
<script src="/assets/docs-init.js"></script>
</body>
</html>`;

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.set('query parser', 'simple');

  app.use(requestLogger);
  app.use(helmet({
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    hsts: config.baseUrl.startsWith('https://'),
  }));

  app.get('/health', (req, res) => res.json({ status: 'ok' }));

  // ---- Documentation ----
  const spec = JSON.stringify(buildOpenApiSpec());
  app.get('/openapi.json', (req, res) => res.type('application/json').set('Access-Control-Allow-Origin', '*').send(spec));
  app.get('/docs', (req, res) => res.set('Content-Security-Policy', DOCS_CSP).type('html').send(DOCS_HTML));
  app.use('/docs/assets', express.static(swaggerUiDist.getAbsoluteFSPath(), { index: false, maxAge: '1d' }));
  app.use('/assets', express.static(assetsDir, { index: false, maxAge: '1h' }));

  // ---- Web panel: landing, login/registration, /account dashboard, /admin panel ----
  app.use(webRouter);

  // ---- Public delivery: files, viewer pages, delete links ----
  app.use('/f', publicRouter);
  app.use(pagesRouter);

  // ---- APIs ----
  app.use('/1', compatRouter); // imgbb-compatible
  app.use('/api/v1/admin', express.json({ limit: '16kb', strict: true }), adminRouter);
  app.use('/api/v1', apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
