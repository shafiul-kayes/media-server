const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escapes text for HTML element content and quoted attribute values. */
export const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);

/** Server-rendered pages load only same-origin CSS/JS; no inline scripts are ever emitted. */
export const PAGE_CSP = [
  "default-src 'none'",
  "img-src 'self' data:",
  "style-src 'self'",
  "script-src 'self'",
  "frame-src 'self'",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

export function renderPage(res, status, { title, body, head = '' }) {
  res.status(status).set({
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': PAGE_CSP,
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
  });
  res.send(`<!doctype html>
<html lang="bn">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
${head}
<link rel="stylesheet" href="/assets/pages.css">
</head>
<body>
<main class="wrap">
${body}
</main>
<script src="/assets/pages.js" defer></script>
</body>
</html>`);
}

export function renderMessage(res, status, heading, text) {
  renderPage(res, status, {
    title: heading,
    body: `<section class="card center"><h1>${esc(heading)}</h1><p class="muted">${esc(text)}</p></section>`,
  });
}
