import express from 'express';
import { config } from '../config.js';
import { deletePageLimiter, publicLimiter } from '../middleware/rateLimit.js';
import { esc, renderMessage, renderPage } from '../pages/html.js';
import * as repo from '../repo.js';
import { viewerUrl } from '../services/serialize.js';
import { isValidId, removeStoredBytes } from '../services/storage.js';
import { deleteTokenMatches } from '../services/upload.js';

export const router = express.Router();

const formatSize = (bytes) =>
  bytes >= 1048576 ? `${(bytes / 1048576).toFixed(2)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

async function livePublicFile(id) {
  const file = isValidId(id) ? await repo.files.findById(id) : undefined;
  if (!file || (file.expires_at && file.expires_at <= Date.now())) return undefined;
  return file;
}

function codeRow(id, label, value) {
  return `<div class="code-row">
  <label for="${id}">${esc(label)}</label>
  <div class="code-field"><input id="${id}" type="text" readonly value="${esc(value)}"><button type="button" data-copy="${id}">কপি</button></div>
</div>`;
}

// ---- Viewer page: /v/:id (like ibb.co/<id>) -----------------------------------------------------

router.get('/v/:id', publicLimiter, async (req, res) => {
  const file = await livePublicFile(req.params.id);
  if (!file || file.visibility !== 'public') return renderMessage(res, 404, 'ফাইল পাওয়া যায়নি', 'লিংকটি ভুল, অথবা ফাইলটি মুছে ফেলা হয়েছে।');

  const direct = `${config.baseUrl}/f/${file.id}.${file.ext}`;
  const viewer = viewerUrl(file);
  const local = `/f/${file.id}.${file.ext}`;
  const isImage = file.kind === 'image';
  const preview = isImage
    ? `<img class="preview" src="${esc(local)}" alt="${esc(file.original_name)}" width="${file.width}" height="${file.height}">`
    : `<iframe class="pdf" src="${esc(local)}" title="${esc(file.original_name)}"></iframe>`;

  const codes = isImage
    ? [
        codeRow('c-direct', 'সরাসরি লিংক (Direct link)', direct),
        codeRow('c-viewer', 'ভিউয়ার লিংক', viewer),
        codeRow('c-html', 'HTML embed', `<a href="${viewer}"><img src="${direct}" alt="${file.original_name}"></a>`),
        codeRow('c-bbcode', 'BBCode (ফোরাম)', `[url=${viewer}][img]${direct}[/img][/url]`),
        codeRow('c-md', 'Markdown', `![${file.original_name}](${direct})`),
      ]
    : [
        codeRow('c-direct', 'সরাসরি লিংক (Direct link)', direct),
        codeRow('c-viewer', 'ভিউয়ার লিংক', viewer),
        codeRow('c-html', 'HTML embed', `<iframe src="${direct}" width="100%" height="600"></iframe>`),
      ];

  const meta = [
    isImage ? `${file.width} × ${file.height}` : file.pages ? `${file.pages} পৃষ্ঠা` : 'PDF',
    formatSize(file.size),
    file.ext.toUpperCase(),
  ];

  res.set('Cache-Control', 'public, max-age=300');
  renderPage(res, 200, {
    title: file.original_name,
    head: [
      `<meta property="og:title" content="${esc(file.original_name)}">`,
      `<meta property="og:url" content="${esc(viewer)}">`,
      isImage ? `<meta property="og:image" content="${esc(direct)}">` : '',
      isImage ? '<meta name="twitter:card" content="summary_large_image">' : '',
    ].join('\n'),
    body: `
<section class="card">
  <div class="stage">${preview}</div>
  <div class="info">
    <h1>${esc(file.original_name)}</h1>
    <p class="muted">${meta.map(esc).join(' · ')}</p>
    <p><a class="btn" href="${esc(local)}?download=1">ডাউনলোড</a></p>
  </div>
</section>
<section class="card">
  <h2>শেয়ার ও embed কোড</h2>
  ${codes.join('\n')}
</section>`,
  });
});

// ---- Delete link: /d/:id/:token (like imgbb's delete_url) -----------------------------------------

async function deletable(req) {
  const file = isValidId(req.params.id) ? await repo.files.findById(req.params.id) : undefined;
  return file && deleteTokenMatches(file, req.params.token) ? file : undefined;
}

// Deletion requires a POST from this page, so link previews, crawlers and prefetchers that
// merely GET the URL can never delete anything.
router.get('/d/:id/:token', deletePageLimiter, async (req, res) => {
  const file = await deletable(req);
  if (!file) return renderMessage(res, 404, 'লিংকটি সঠিক নয়', 'এই delete লিংকটি ভুল, অথবা ফাইলটি আগেই মুছে ফেলা হয়েছে।');

  const thumb = file.kind === 'image' && file.visibility === 'public'
    ? `<img class="thumb" src="/f/${file.id}.${file.ext}?w=320&amp;h=320&amp;fit=inside&amp;format=webp" alt="">`
    : '';
  renderPage(res, 200, {
    title: 'ফাইল মুছুন',
    body: `
<section class="card center">
  ${thumb}
  <h1>এই ফাইলটি মুছে ফেলবেন?</h1>
  <p class="muted">${esc(file.original_name)} · ${esc(formatSize(file.size))}</p>
  <p>মুছে ফেললে আর ফেরত আনা যাবে না।</p>
  <form method="post" action="/d/${file.id}/${esc(req.params.token)}">
    <button class="btn danger" type="submit">হ্যাঁ, স্থায়ীভাবে মুছুন</button>
  </form>
</section>`,
  });
});

router.post('/d/:id/:token', deletePageLimiter, async (req, res) => {
  const file = await deletable(req);
  if (!file || !(await repo.files.removeWithQuota(file))) return renderMessage(res, 404, 'লিংকটি সঠিক নয়', 'এই delete লিংকটি ভুল, অথবা ফাইলটি আগেই মুছে ফেলা হয়েছে।');
  await removeStoredBytes(file);
  renderMessage(res, 200, 'ফাইলটি মুছে ফেলা হয়েছে', 'ফাইল ও এর সব ভ্যারিয়েন্ট সার্ভার থেকে স্থায়ীভাবে মুছে গেছে।');
});
