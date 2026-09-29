import { config } from '../config.js';

const mb = Math.round(config.maxFileSize / 1048576);

const guide = `
নিজের সার্ভারে imgbb / uploadcare এর মতো ইমেজ ও PDF হোস্টিং। যেকোনো ওয়েবসাইট, মোবাইল অ্যাপ বা ব্যাকএন্ড থেকে API দিয়ে ফাইল আপলোড করুন, আর পাওয়া লিংক যেকোনো জায়গায় ব্যবহার করুন।

**সাপোর্টেড ফাইল:** JPEG, PNG, WebP, GIF, AVIF, PDF · **সর্বোচ্চ সাইজ:** ${mb} MB

---

## ১. API key নিন

1. [রেজিস্ট্রেশন](/register) করুন, তারপর লগইন করুন।
2. ড্যাশবোর্ড থেকে **নতুন API অনুরোধ** করুন: অ্যাপের নাম, ব্যবহারের উদ্দেশ্য আর (ব্রাউজার থেকে ব্যবহার করলে) ডোমেইন দিন।
3. অ্যাডমিন অনুমোদন দিলে অ্যাপের পেজ থেকে **API key তৈরি করুন**। key শুধু একবারই দেখানো হয়।
4. আপনার অ্যাকাউন্টের **ইন্টিগ্রেশন গাইডে** আপনার অ্যাপের জন্য সাজানো কোড পাবেন।

key পাঠানোর নিয়ম:

| পদ্ধতি | উদাহরণ | কোথায় চলে |
|---|---|---|
| Header | \`X-API-Key: ms_xxx\` | সব এন্ডপয়েন্ট (সুপারিশকৃত) |
| Bearer | \`Authorization: Bearer ms_xxx\` | সব এন্ডপয়েন্ট |
| Query / form field | \`?key=ms_xxx\` | শুধু imgbb-compatible \`/1/upload\` |

## ২. আপলোড করুন: তিনভাবে

\`image\` (বা \`file\`) ফিল্ডে দিতে পারেন **বাইনারি ফাইল**, **base64 স্ট্রিং** (data URI সহ বা ছাড়া), অথবা **ইমেজের URL**।

**ফাইল (curl):**
\`\`\`bash
curl -H "X-API-Key: $KEY" -F "image=@photo.jpg" ${config.baseUrl}/api/v1/upload
\`\`\`

**URL থেকে:**
\`\`\`bash
curl -H "X-API-Key: $KEY" -F "image=https://example.com/cat.png" ${config.baseUrl}/api/v1/upload
\`\`\`

**base64 (JSON):**
\`\`\`bash
curl -H "X-API-Key: $KEY" -H "Content-Type: application/json" \\
     -d '{"image":"iVBORw0KGgoAAAANSUhEUg...","name":"logo.png"}' ${config.baseUrl}/api/v1/upload
\`\`\`

**imgbb থেকে আসছেন?** শুধু বেস URL বদলান, বাকি কোড একই থাকবে:
\`\`\`bash
# আগে:  https://api.imgbb.com/1/upload?key=KEY
curl --location --request POST "${config.baseUrl}/1/upload?expiration=600&key=$KEY" --form "image=@photo.jpg"
\`\`\`

## ৩. অন্য ওয়েবসাইট থেকে (ব্রাউজার JavaScript)

ব্রাউজার থেকে কল করতে হলে সেই ওয়েবসাইটের ডোমেইন key এর **allowed_origins** এ থাকতে হবে। অন্য ডোমেইন থেকে এলে \`403 origin_not_allowed\` আসবে।

\`\`\`html
<input type="file" id="picker" accept="image/*,application/pdf">
<script>
document.getElementById('picker').addEventListener('change', async (e) => {
  const form = new FormData();
  form.append('image', e.target.files[0]);
  const res = await fetch('${config.baseUrl}/api/v1/upload', {
    method: 'POST',
    headers: { 'X-API-Key': 'ms_xxx' },   // upload-only key ব্যবহার করুন
    body: form,
  });
  const { data } = await res.json();
  document.body.insertAdjacentHTML('beforeend', '<img src="' + data.thumb_url + '">');
});
</script>
\`\`\`

> ⚠️ ব্রাউজার কোডে রাখা key যে কেউ দেখতে পারে। তাই ব্রাউজারের জন্য আলাদা key বানান, যাতে শুধু \`upload\` scope, ছোট quota, আর নির্দিষ্ট allowed_origins থাকে। ফাইল মোছা বা লিস্ট দেখার key শুধু নিজের সার্ভারে রাখুন।

**Node.js / ব্যাকএন্ড:**
\`\`\`js
import fs from 'node:fs';
const form = new FormData();
form.append('image', new Blob([fs.readFileSync('photo.jpg')]), 'photo.jpg');
const res = await fetch('${config.baseUrl}/api/v1/upload', {
  method: 'POST', headers: { 'X-API-Key': process.env.MEDIA_KEY }, body: form,
});
console.log((await res.json()).data.url);
\`\`\`

**PHP:**
\`\`\`php
$ch = curl_init('${config.baseUrl}/api/v1/upload');
curl_setopt_array($ch, [
  CURLOPT_POST => true,
  CURLOPT_RETURNTRANSFER => true,
  CURLOPT_HTTPHEADER => ['X-API-Key: ' . getenv('MEDIA_KEY')],
  CURLOPT_POSTFIELDS => ['image' => new CURLFile('photo.jpg')],
]);
$data = json_decode(curl_exec($ch), true)['data'];
echo $data['url'];
\`\`\`

**Python:**
\`\`\`python
import os, requests
r = requests.post('${config.baseUrl}/api/v1/upload',
                  headers={'X-API-Key': os.environ['MEDIA_KEY']},
                  files={'image': open('photo.jpg', 'rb')})
print(r.json()['data']['url'])
\`\`\`

## ৪. লিংক ব্যবহার (GET)

আপলোডের পর পাওয়া \`url\` যেকোনো সাইটে সরাসরি embed করা যায়। এর জন্য key লাগে না:

\`\`\`html
<img src="${config.baseUrl}/f/AbCdEfGhIjKlMnOp.jpg?w=600&format=webp" alt="">
\`\`\`

| প্যারামিটার | মান |
|---|---|
| \`w\`, \`h\` | 1 – ${config.maxTransformDimension} পিক্সেল (শুধু ছোট হয়) |
| \`fit\` | \`cover\` · \`contain\` · \`fill\` · \`inside\` · \`outside\` |
| \`format\` | \`jpeg\` · \`png\` · \`webp\` · \`avif\` |
| \`q\` | কোয়ালিটি 1–100 |
| \`download=1\` | ব্রাউজারে না খুলে ডাউনলোড |

\`viewer_url\` (\`/v/<id>\`) এ imgbb এর মতো একটি পেজ খোলে, যেখানে ছবি আর HTML/BBCode/Markdown embed কোড থাকে। আপলোডের রেসপন্সে একটি \`delete_url\`ও আসে। এটা শুধু একবারই দেখানো হয়; এটি দিয়ে key ছাড়াই ফাইলটি মোছা যায়।

## ৫. রেসপন্স ও এরর

সফল হলে \`{ "success": true, "data": {...} }\`, আর এরর হলে \`{ "success": false, "error": { "code", "message" } }\`। \`/1/upload\` এর এরর imgbb এর মতো: \`{ "status_code", "error": { "message", "code" }, "status_txt" }\`।

| HTTP | code | অর্থ |
|---|---|---|
| 400 | \`bad_request\`, \`missing_image\`, \`invalid_url\` | ভুল প্যারামিটার |
| 401 | \`unauthorized\` | key নেই বা ভুল |
| 403 | \`forbidden\` / \`origin_not_allowed\` | scope নেই / ডোমেইন অনুমোদিত নয় |
| 404 | \`not_found\` | ফাইল নেই (বা অন্য key এর) |
| 413 | \`file_too_large\` / \`quota_exceeded\` | সাইজ বা storage সীমা পার |
| 415 | \`unsupported_type\` | অনুমোদিত নয় এমন ফাইল টাইপ |
| 422 | \`invalid_image\`, \`unsafe_pdf\`, \`remote_url_blocked\`, \`remote_fetch_failed\` | নষ্ট/ঝুঁকিপূর্ণ ফাইল, অথবা URL আনা যায়নি |
| 429 | \`rate_limited\` | অনেক বেশি রিকোয়েস্ট। \`RateLimit\` হেডার দেখুন |

## ৬. Rate limit

| কী | সীমা |
|---|---|
| API রিকোয়েস্ট (প্রতি IP) | ${config.rateLimit.apiPer15Min} / ১৫ মিনিট |
| আপলোড (প্রতি key) | ${config.rateLimit.uploadsPerHour} / ঘণ্টা |
| ভুল key দিয়ে চেষ্টা (প্রতি IP) | ${config.rateLimit.authFailuresPer15Min} / ১৫ মিনিট |
| পাবলিক ফাইল (প্রতি IP) | ${config.rateLimit.publicPerMin} / মিনিট |
| নতুন সাইজ তৈরি (প্রতি IP) | ${config.rateLimit.transformsPerMin} / মিনিট |
`;

// ---- Reusable schema pieces -------------------------------------------------------------------

const errorSchema = {
  type: 'object',
  properties: {
    success: { type: 'boolean', example: false },
    error: {
      type: 'object',
      properties: { code: { type: 'string', example: 'unsupported_type' }, message: { type: 'string' } },
    },
  },
};

const errorResponses = (...codes) => Object.fromEntries(codes.map((c) => [c, { $ref: `#/components/responses/E${c}` }]));

const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'string', pattern: '^[A-Za-z0-9_-]{16}$' }, example: 'AbCdEfGhIjKlMnOp' };

const uploadFields = {
  image: {
    description: 'ফাইল (binary), base64 স্ট্রিং, data: URI অথবা http(s) URL। `file` নামেও পাঠানো যায়।',
    oneOf: [{ type: 'string', format: 'binary' }, { type: 'string' }],
  },
  name: { type: 'string', maxLength: 200, description: 'টাইটেল / ফাইলের নাম (ঐচ্ছিক)' },
  visibility: { type: 'string', enum: ['public', 'private'], default: 'public', description: '`private` হলে শুধু signed URL দিয়ে খোলা যাবে' },
  expiration: {
    type: 'integer', minimum: 60, maximum: config.maxExpirationSeconds,
    description: 'কত সেকেন্ড পর ফাইলটি অটো-ডিলিট হবে (ঐচ্ছিক)',
  },
};

const uploadBody = (required = ['image']) => ({
  required: true,
  content: {
    'multipart/form-data': { schema: { type: 'object', required, properties: { ...uploadFields, image: { type: 'string', format: 'binary', description: uploadFields.image.description } } } },
    'application/x-www-form-urlencoded': { schema: { type: 'object', required, properties: { ...uploadFields, image: { type: 'string', description: 'base64 অথবা URL' } } } },
    'application/json': {
      schema: { type: 'object', required, properties: { ...uploadFields, image: { type: 'string', description: 'base64, data: URI অথবা URL' } } },
      examples: {
        url: { summary: 'URL থেকে', value: { image: 'https://upload.wikimedia.org/wikipedia/commons/4/47/PNG_transparency_demonstration_1.png' } },
        base64: { summary: 'base64', value: { image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', name: 'pixel.png' } },
      },
    },
  },
});

export function buildOpenApiSpec() {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Media Server API',
      version: '1.1.0',
      description: guide,
    },
    servers: [{ url: config.baseUrl }],
    tags: [
      { name: 'Upload', description: 'ফাইল, base64 বা URL থেকে আপলোড' },
      { name: 'imgbb compatible', description: 'imgbb API এর সাথে ১০০% সামঞ্জস্যপূর্ণ এন্ডপয়েন্ট' },
      { name: 'Files', description: 'নিজের আপলোড করা ফাইল দেখা, লিংক বানানো, মোছা' },
      { name: 'Public', description: 'key ছাড়া ব্যবহারযোগ্য লিংক: ফাইল, viewer ও delete পেজ' },
      { name: 'Admin', description: 'API key ব্যবস্থাপনা (ADMIN_TOKEN লাগবে)' },
    ],
    paths: {
      '/api/v1/upload': {
        post: {
          tags: ['Upload'],
          summary: 'ফাইল আপলোড (file / base64 / URL)',
          description: 'Scope: `upload`। ইমেজ সার্ভারে পুনরায় encode করা হয়, ফলে metadata (GPS/EXIF) মুছে যায়। PDF এ JavaScript বা এরকম active content থাকলে বাতিল হয়। URL থেকে আপলোডে প্রাইভেট/লোকাল নেটওয়ার্কের ঠিকানা ব্লক থাকে।',
          security: [{ ApiKeyHeader: [] }, { ApiKeyBearer: [] }],
          requestBody: uploadBody(),
          responses: {
            201: { description: 'আপলোড সফল', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { $ref: '#/components/schemas/UploadedFile' } } } } } },
            ...errorResponses(400, 401, 403, 413, 415, 422, 429),
          },
        },
      },
      '/1/upload': {
        post: {
          tags: ['imgbb compatible'],
          summary: 'imgbb-compatible আপলোড',
          description: '`https://api.imgbb.com/1/upload` এর বদলি। key দেওয়া যায় `?key=` query তে, `key` form field এ, অথবা header এ। রেসপন্সের মান imgbb এর মতোই string হিসেবে আসে।',
          security: [{ ApiKeyQuery: [] }, { ApiKeyHeader: [] }],
          parameters: [
            { name: 'key', in: 'query', schema: { type: 'string' }, description: 'API key' },
            { name: 'expiration', in: 'query', schema: { type: 'integer', minimum: 60 }, description: 'অটো-ডিলিটের সময় (সেকেন্ড)' },
          ],
          requestBody: uploadBody(),
          responses: {
            200: { description: 'imgbb ফরম্যাটে রেসপন্স', content: { 'application/json': { schema: { $ref: '#/components/schemas/ImgbbResponse' } } } },
            400: { description: 'Error (imgbb format)', content: { 'application/json': { schema: { $ref: '#/components/schemas/ImgbbError' } } } },
          },
        },
      },
      '/api/v1/me': {
        get: {
          tags: ['Files'],
          summary: 'key এর তথ্য ও storage ব্যবহার',
          security: [{ ApiKeyHeader: [] }, { ApiKeyBearer: [] }],
          responses: { 200: { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { $ref: '#/components/schemas/ApiKey' } } } } } }, ...errorResponses(401) },
        },
      },
      '/api/v1/files': {
        get: {
          tags: ['Files'],
          summary: 'নিজের ফাইলের লিস্ট',
          description: 'Scope: `read`। নতুন ফাইল আগে আসে। Private ফাইলের URL ১ ঘণ্টার জন্য signed থাকে।',
          security: [{ ApiKeyHeader: [] }, { ApiKeyBearer: [] }],
          parameters: [
            { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
            { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
            { name: 'kind', in: 'query', schema: { type: 'string', enum: ['image', 'pdf'] } },
          ],
          responses: {
            200: {
              description: 'OK',
              content: { 'application/json': { schema: { type: 'object', properties: {
                success: { type: 'boolean' },
                data: { type: 'array', items: { $ref: '#/components/schemas/File' } },
                pagination: { type: 'object', properties: { page: { type: 'integer' }, limit: { type: 'integer' }, total: { type: 'integer' }, pages: { type: 'integer' } } },
              } } } },
            },
            ...errorResponses(400, 401, 403),
          },
        },
      },
      '/api/v1/files/{id}': {
        parameters: [idParam],
        get: {
          tags: ['Files'], summary: 'একটি ফাইলের তথ্য', description: 'Scope: `read`',
          security: [{ ApiKeyHeader: [] }, { ApiKeyBearer: [] }],
          responses: { 200: { $ref: '#/components/responses/FileOk' }, ...errorResponses(401, 404) },
        },
        patch: {
          tags: ['Files'], summary: 'visibility বদলানো', description: 'Scope: `upload`',
          security: [{ ApiKeyHeader: [] }, { ApiKeyBearer: [] }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { visibility: { type: 'string', enum: ['public', 'private'] } } } } } },
          responses: { 200: { $ref: '#/components/responses/FileOk' }, ...errorResponses(400, 401, 404) },
        },
        delete: {
          tags: ['Files'], summary: 'ফাইল মোছা', description: 'Scope: `delete`। ফাইল ও এর সব রিসাইজ করা ভ্যারিয়েন্ট মুছে যায়।',
          security: [{ ApiKeyHeader: [] }, { ApiKeyBearer: [] }],
          responses: { 200: { description: 'মুছে ফেলা হয়েছে', content: { 'application/json': { example: { success: true, data: { id: 'AbCdEfGhIjKlMnOp', deleted: true } } } } }, ...errorResponses(401, 404) },
        },
      },
      '/api/v1/files/{id}/content': {
        parameters: [idParam],
        get: {
          tags: ['Files'], summary: 'আসল ফাইল ডাউনলোড (private হলেও)', description: 'Scope: `read`',
          security: [{ ApiKeyHeader: [] }, { ApiKeyBearer: [] }],
          responses: { 200: { description: 'ফাইলের বাইনারি', content: { 'application/octet-stream': {} } }, ...errorResponses(401, 404) },
        },
      },
      '/api/v1/files/{id}/sign': {
        parameters: [idParam],
        post: {
          tags: ['Files'], summary: 'Private ফাইলের মেয়াদি লিংক',
          description: `Scope: \`read\`। সর্বোচ্চ ${config.maxSignedUrlSeconds} সেকেন্ড। লিংকটি শুধু এই ফাইলের জন্য কাজ করবে।`,
          security: [{ ApiKeyHeader: [] }, { ApiKeyBearer: [] }],
          requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { expires_in: { type: 'integer', minimum: 60, default: 3600 } } } } } },
          responses: { 200: { $ref: '#/components/responses/FileOk' }, ...errorResponses(400, 401, 404) },
        },
      },
      '/f/{file}': {
        get: {
          tags: ['Public'],
          summary: 'ফাইল দেখা / embed / রিসাইজ',
          description: 'key লাগে না। Private ফাইলের জন্য `exp` ও `sig` লাগবে। রিসাইজ করা ভ্যারিয়েন্ট ক্যাশ হয়।',
          security: [],
          parameters: [
            { name: 'file', in: 'path', required: true, schema: { type: 'string' }, example: 'AbCdEfGhIjKlMnOp.jpg' },
            { name: 'w', in: 'query', schema: { type: 'integer', minimum: 1, maximum: config.maxTransformDimension } },
            { name: 'h', in: 'query', schema: { type: 'integer', minimum: 1, maximum: config.maxTransformDimension } },
            { name: 'fit', in: 'query', schema: { type: 'string', enum: ['cover', 'contain', 'fill', 'inside', 'outside'] } },
            { name: 'format', in: 'query', schema: { type: 'string', enum: ['jpeg', 'png', 'webp', 'avif'] } },
            { name: 'q', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } },
            { name: 'download', in: 'query', schema: { type: 'string', enum: ['1'] } },
            { name: 'exp', in: 'query', schema: { type: 'integer' }, description: 'signed URL এর মেয়াদ (private)' },
            { name: 'sig', in: 'query', schema: { type: 'string' }, description: 'signed URL এর signature (private)' },
          ],
          responses: {
            200: { description: 'ফাইল', content: { 'image/*': {}, 'application/pdf': {} } },
            400: { description: 'ভুল ট্রান্সফর্ম প্যারামিটার' },
            403: { description: 'Signature ভুল বা মেয়াদোত্তীর্ণ' },
            404: { description: 'ফাইল নেই' },
          },
        },
      },
      '/v/{id}': {
        parameters: [idParam],
        get: {
          tags: ['Public'], summary: 'Viewer পেজ (HTML)', security: [],
          description: 'ibb.co/<id> এর মতো পেজ, যেখানে ছবি আর Direct link, HTML, BBCode ও Markdown embed কোড থাকে। শুধু public ফাইলের জন্য।',
          responses: { 200: { description: 'HTML', content: { 'text/html': {} } }, 404: { description: 'নেই' } },
        },
      },
      '/d/{id}/{token}': {
        parameters: [idParam, { name: 'token', in: 'path', required: true, schema: { type: 'string' } }],
        get: {
          tags: ['Public'], summary: 'Delete লিংক: নিশ্চিতকরণ পেজ', security: [],
          description: 'আপলোডের সময় পাওয়া `delete_url`। শুধু GET করলে কিছু মোছে না, একটি নিশ্চিতকরণ পেজ দেখায়।',
          responses: { 200: { description: 'HTML', content: { 'text/html': {} } }, 404: { description: 'ভুল লিংক' } },
        },
        post: {
          tags: ['Public'], summary: 'Delete লিংক: মুছে ফেলা', security: [],
          responses: { 200: { description: 'মুছে ফেলা হয়েছে (HTML)' }, 404: { description: 'ভুল লিংক' } },
        },
      },
      '/api/v1/admin/keys': {
        post: {
          tags: ['Admin'], summary: 'নতুন API key', security: [{ AdminToken: [] }],
          requestBody: { required: true, content: { 'application/json': {
            schema: { type: 'object', required: ['name'], properties: {
              name: { type: 'string' },
              scopes: { type: 'array', items: { type: 'string', enum: ['upload', 'read', 'delete'] } },
              quota_mb: { type: 'integer', minimum: 1 },
              allowed_origins: { type: 'array', items: { type: 'string' }, description: 'যেসব ওয়েবসাইট ব্রাউজার থেকে এই key ব্যবহার করতে পারবে। যেমন `https://mysite.com`, `https://*.mysite.com`' },
            } },
            example: { name: 'My Website (browser)', scopes: ['upload'], quota_mb: 500, allowed_origins: ['https://mysite.com', 'https://*.mysite.com'] },
          } } },
          responses: { 201: { description: 'key তৈরি হয়েছে। `key` মানটি শুধু একবারই দেখানো হয়।' }, ...errorResponses(400, 401) },
        },
        get: {
          tags: ['Admin'], summary: 'সব key', security: [{ AdminToken: [] }],
          responses: { 200: { description: 'OK' }, ...errorResponses(401) },
        },
      },
      '/api/v1/admin/keys/{id}': {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, example: 'key_0123456789abcdef' }],
        patch: {
          tags: ['Admin'], summary: 'key আপডেট / বন্ধ', security: [{ AdminToken: [] }],
          requestBody: { content: { 'application/json': { schema: { type: 'object', properties: {
            name: { type: 'string' }, active: { type: 'boolean' }, quota_mb: { type: 'integer' },
            scopes: { type: 'array', items: { type: 'string' } }, allowed_origins: { type: 'array', items: { type: 'string' } },
          } } } } },
          responses: { 200: { description: 'OK' }, ...errorResponses(400, 401, 404) },
        },
        delete: {
          tags: ['Admin'], summary: 'key ও এর সব ফাইল স্থায়ীভাবে মোছা', security: [{ AdminToken: [] }],
          responses: { 200: { description: 'OK' }, ...errorResponses(401, 404) },
        },
      },
      '/api/v1/admin/stats': {
        get: { tags: ['Admin'], summary: 'মোট key, ফাইল ও storage', security: [{ AdminToken: [] }], responses: { 200: { description: 'OK' } } },
      },
    },
    components: {
      securitySchemes: {
        ApiKeyHeader: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
        ApiKeyBearer: { type: 'http', scheme: 'bearer', description: 'Authorization: Bearer ms_xxx' },
        ApiKeyQuery: { type: 'apiKey', in: 'query', name: 'key', description: 'শুধু /1/upload এ' },
        AdminToken: { type: 'http', scheme: 'bearer', description: '.env এর ADMIN_TOKEN' },
      },
      schemas: {
        File: {
          type: 'object',
          properties: {
            id: { type: 'string', example: 'AbCdEfGhIjKlMnOp' },
            title: { type: 'string', example: 'photo.jpg' },
            kind: { type: 'string', enum: ['image', 'pdf'] },
            mime: { type: 'string', example: 'image/jpeg' },
            extension: { type: 'string', example: 'jpg' },
            size: { type: 'integer', example: 183422 },
            width: { type: ['integer', 'null'], example: 1920 },
            height: { type: ['integer', 'null'], example: 1080 },
            pages: { type: ['integer', 'null'], description: 'PDF এর পৃষ্ঠা সংখ্যা (আনুমানিক)' },
            sha256: { type: 'string' },
            visibility: { type: 'string', enum: ['public', 'private'] },
            url: { type: 'string', example: `${config.baseUrl}/f/AbCdEfGhIjKlMnOp.jpg` },
            thumb_url: { type: ['string', 'null'], example: `${config.baseUrl}/f/AbCdEfGhIjKlMnOp.jpg?w=320&h=320&fit=cover&format=webp` },
            download_url: { type: 'string' },
            viewer_url: { type: ['string', 'null'], example: `${config.baseUrl}/v/AbCdEfGhIjKlMnOp` },
            signed_url_expires_at: { type: 'string', format: 'date-time', description: 'শুধু private ফাইলে' },
            created_at: { type: 'string', format: 'date-time' },
            expires_at: { type: ['string', 'null'], format: 'date-time' },
          },
        },
        UploadedFile: {
          allOf: [
            { $ref: '#/components/schemas/File' },
            { type: 'object', properties: { delete_url: { type: 'string', example: `${config.baseUrl}/d/AbCdEfGhIjKlMnOp/7Hq...`, description: 'শুধু আপলোডের সময় একবার দেখানো হয়' } } },
          ],
        },
        ImgbbImage: {
          type: 'object',
          properties: { filename: { type: 'string' }, name: { type: 'string' }, mime: { type: 'string' }, extension: { type: 'string' }, url: { type: 'string' } },
        },
        ImgbbResponse: {
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                url_viewer: { type: 'string' },
                url: { type: 'string' },
                display_url: { type: 'string' },
                width: { type: 'string', example: '1920' },
                height: { type: 'string', example: '1080' },
                size: { type: 'string', example: '183422' },
                time: { type: 'string', example: '1759114178' },
                expiration: { type: 'string', example: '0' },
                image: { $ref: '#/components/schemas/ImgbbImage' },
                thumb: { $ref: '#/components/schemas/ImgbbImage' },
                medium: { $ref: '#/components/schemas/ImgbbImage' },
                delete_url: { type: 'string' },
              },
            },
            success: { type: 'boolean', example: true },
            status: { type: 'integer', example: 200 },
          },
        },
        ImgbbError: {
          type: 'object',
          properties: {
            status_code: { type: 'integer', example: 400 },
            error: { type: 'object', properties: { message: { type: 'string' }, code: { type: 'string' } } },
            status_txt: { type: 'string', example: 'Bad Request' },
          },
        },
        ApiKey: {
          type: 'object',
          properties: {
            id: { type: 'string' }, name: { type: 'string' }, prefix: { type: 'string', example: 'ms_dgB6' },
            scopes: { type: 'array', items: { type: 'string' } },
            allowed_origins: { type: 'array', items: { type: 'string' } },
            quota_bytes: { type: 'integer' }, used_bytes: { type: 'integer' }, active: { type: 'boolean' },
            created_at: { type: 'string', format: 'date-time' }, last_used_at: { type: ['string', 'null'], format: 'date-time' },
          },
        },
        Error: errorSchema,
      },
      responses: {
        FileOk: { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { $ref: '#/components/schemas/File' } } } } } },
        ...Object.fromEntries(
          [[400, 'ভুল রিকোয়েস্ট'], [401, 'key নেই বা ভুল'], [403, 'scope নেই বা origin অনুমোদিত নয়'], [404, 'পাওয়া যায়নি'],
            [413, 'ফাইল বড় বা quota শেষ'], [415, 'অনুমোদিত নয় এমন ফাইল টাইপ'], [422, 'নষ্ট/ঝুঁকিপূর্ণ ফাইল বা URL আনা যায়নি'], [429, 'Rate limit']]
            .map(([code, description]) => [`E${code}`, { description, content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }]),
        ),
      },
    },
  };
}
