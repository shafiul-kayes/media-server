import { config } from '../config.js';
import { html } from './html.js';

let blockId = 0;

/** A copyable code block. */
export function codeBlock(code, lang = '') {
  const id = `code-${++blockId}`;
  return html`<div class="code">
  <div class="code-head"><span>${lang}</span><button type="button" class="copy" data-copy="${id}">কপি</button></div>
  <pre><code id="${id}">${code}</code></pre>
</div>`;
}

/** Tabbed code samples; without JavaScript all panels simply show one after another. */
export function codeTabs(tabs) {
  const group = `tabs-${++blockId}`;
  return html`<div class="tabs" data-tabs>
  <div class="tab-list" role="tablist">
    ${tabs.map(([label], i) => html`<button type="button" role="tab" class="tab" id="${group}-t${i}" aria-controls="${group}-p${i}" aria-selected="${i === 0 ? 'true' : 'false'}">${label}</button>`)}
  </div>
  ${tabs.map(([label, code, lang], i) => html`<div class="tab-panel" role="tabpanel" id="${group}-p${i}" aria-labelledby="${group}-t${i}" data-panel="${i}">${codeBlock(code, lang ?? label)}</div>`)}
</div>`;
}

/**
 * The integration guide shown in every user account. `app` (optional) personalises it with the
 * application's key prefix, allowed origins and scopes.
 */
export function integrationGuide({ app } = {}) {
  const base = config.baseUrl;
  const key = app?.key_prefix && app.key_issued_at ? `${app.key_prefix}…আপনার_পুরো_key` : 'YOUR_API_KEY';
  const origins = app?.key_origins ? app.key_origins.split(',').filter(Boolean) : [];
  const exampleOrigin = origins.find((o) => o !== '*' && !o.includes('*')) ?? 'https://your-site.com';
  const scopes = app?.key_scopes ? app.key_scopes.split(',') : ['upload', 'read', 'delete'];
  const maxMb = Math.round(config.maxFileSize / 1048576);

  return html`
<section class="guide">
  <nav class="toc card" aria-label="সূচিপত্র">
    <strong>সূচিপত্র</strong>
    <ol>
      <li><a href="#g-auth">Authentication</a></li>
      <li><a href="#g-upload">ফাইল আপলোড</a></li>
      <li><a href="#g-browser">ওয়েবসাইট থেকে (ব্রাউজার)</a></li>
      <li><a href="#g-response">রেসপন্স</a></li>
      <li><a href="#g-display">ছবি দেখানো ও রিসাইজ</a></li>
      <li><a href="#g-manage">ফাইল লিস্ট ও মোছা</a></li>
      <li><a href="#g-private">প্রাইভেট ফাইল</a></li>
      <li><a href="#g-imgbb">imgbb থেকে মাইগ্রেশন</a></li>
      <li><a href="#g-errors">এরর ও সীমা</a></li>
      <li><a href="#g-security">নিরাপত্তা চেকলিস্ট</a></li>
    </ol>
  </nav>

  <article class="guide-body">
    <div class="card">
      <h2 id="g-auth">১. Authentication</h2>
      <p>প্রতিটি রিকোয়েস্টে আপনার API key header এ পাঠান। বেস URL: <code>${base}</code></p>
      ${codeBlock(`X-API-Key: ${key}\n# অথবা\nAuthorization: Bearer ${key}`, 'HTTP header')}
      <p class="muted">key কখনো URL এ, git রিপোজিটরিতে বা পাবলিক JavaScript এ রাখবেন না। সার্ভারে environment variable (যেমন <code>MEDIA_API_KEY</code>) এ রাখুন।</p>
      ${app ? html`<p>এই অ্যাপের অনুমতি: ${scopes.map((s) => html`<code>${s}</code> `)}</p>` : ''}
    </div>

    <div class="card">
      <h2 id="g-upload">২. ফাইল আপলোড</h2>
      <p><code>POST ${base}/api/v1/upload</code>। <code>image</code> ফিল্ডে দিন ফাইল, base64 অথবা ইমেজের URL। সর্বোচ্চ ${maxMb} MB; JPEG, PNG, WebP, GIF, AVIF, PDF।</p>
      <p>ঐচ্ছিক ফিল্ড: <code>name</code> (টাইটেল), <code>visibility</code> (<code>public</code>/<code>private</code>), <code>expiration</code> (কত সেকেন্ড পর অটো-ডিলিট)।</p>
      ${codeTabs([
        ['cURL', `curl -X POST "${base}/api/v1/upload" \\
  -H "X-API-Key: ${key}" \\
  -F "image=@/path/to/photo.jpg" \\
  -F "name=প্রোডাক্ট ছবি"`, 'bash'],
        ['Node.js', `// Node 18+ (built-in fetch & FormData)
import fs from 'node:fs';

const form = new FormData();
form.append('image', new Blob([fs.readFileSync('photo.jpg')]), 'photo.jpg');

const res = await fetch('${base}/api/v1/upload', {
  method: 'POST',
  headers: { 'X-API-Key': process.env.MEDIA_API_KEY },
  body: form,
});
const { success, data, error } = await res.json();
if (!success) throw new Error(error.message);
console.log(data.url, data.thumb_url);`, 'javascript'],
        ['PHP', `<?php
$ch = curl_init('${base}/api/v1/upload');
curl_setopt_array($ch, [
    CURLOPT_POST           => true,
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_HTTPHEADER     => ['X-API-Key: ' . getenv('MEDIA_API_KEY')],
    CURLOPT_POSTFIELDS     => ['image' => new CURLFile($_FILES['photo']['tmp_name'], $_FILES['photo']['type'], $_FILES['photo']['name'])],
]);
$result = json_decode(curl_exec($ch), true);
curl_close($ch);

if ($result['success']) {
    echo $result['data']['url'];
}`, 'php'],
        ['Laravel', `use Illuminate\\Support\\Facades\\Http;

$response = Http::withHeaders(['X-API-Key' => env('MEDIA_API_KEY')])
    ->attach('image', file_get_contents($request->file('photo')), $request->file('photo')->getClientOriginalName())
    ->post('${base}/api/v1/upload');

$url = $response->json('data.url');`, 'php'],
        ['Python', `import os, requests

with open("photo.jpg", "rb") as f:
    r = requests.post(
        "${base}/api/v1/upload",
        headers={"X-API-Key": os.environ["MEDIA_API_KEY"]},
        files={"image": f},
        data={"visibility": "public"},
    )
r.raise_for_status()
print(r.json()["data"]["url"])`, 'python'],
        ['URL থেকে', `curl -X POST "${base}/api/v1/upload" \\
  -H "X-API-Key: ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{"image": "https://example.com/picture.png"}'`, 'bash'],
        ['base64', `curl -X POST "${base}/api/v1/upload" \\
  -H "X-API-Key: ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{"image": "data:image/png;base64,iVBORw0KGgo...", "name": "logo.png"}'`, 'bash'],
      ])}
    </div>

    <div class="card">
      <h2 id="g-browser">৩. ওয়েবসাইট থেকে সরাসরি (ব্রাউজার JavaScript)</h2>
      <p>ব্রাউজার থেকে কল শুধু সেইসব ডোমেইন থেকে চলবে, যেগুলো অ্যাডমিন আপনার অ্যাপের জন্য অনুমোদন করেছেন${origins.length ? html`: ${origins.map((o) => html`<code>${o}</code> `)}` : '। অনুমোদিত ডোমেইন না থাকলে key শুধু সার্ভার থেকে কাজ করবে'}।</p>
      <div class="alert alert-warn">ব্রাউজারের কোডে রাখা key যে কেউ দেখতে পারে। তাই সবচেয়ে নিরাপদ হলো আপনার নিজের ব্যাকএন্ড দিয়ে আপলোড করানো। সরাসরি ব্রাউজার থেকে দিতেই হলে আলাদা একটা অ্যাপ অনুরোধ করুন, যার শুধু <code>upload</code> অনুমতি আর ছোট quota থাকবে।</div>
      ${codeBlock(`<!-- ${exampleOrigin} এর যেকোনো পেজে -->
<input type="file" id="picker" accept="image/*,application/pdf">
<img id="preview" alt="">
<script>
document.getElementById('picker').addEventListener('change', async (e) => {
  const form = new FormData();
  form.append('image', e.target.files[0]);
  const res = await fetch('${base}/api/v1/upload', {
    method: 'POST',
    headers: { 'X-API-Key': '${key}' },
    body: form,
  });
  const { success, data, error } = await res.json();
  if (!success) return alert(error.message);
  document.getElementById('preview').src = data.thumb_url;
});
</script>`, 'html')}
    </div>

    <div class="card">
      <h2 id="g-response">৪. রেসপন্স</h2>
      ${codeBlock(`{
  "success": true,
  "data": {
    "id": "8-PzJnQZIqPom5x1",
    "title": "photo.jpg",
    "kind": "image",
    "mime": "image/jpeg",
    "size": 183422,
    "width": 1920,
    "height": 1080,
    "visibility": "public",
    "url": "${base}/f/8-PzJnQZIqPom5x1.jpg",
    "thumb_url": "${base}/f/8-PzJnQZIqPom5x1.jpg?w=320&h=320&fit=cover&format=webp",
    "viewer_url": "${base}/v/8-PzJnQZIqPom5x1",
    "download_url": "${base}/f/8-PzJnQZIqPom5x1.jpg?download=1",
    "delete_url": "${base}/d/8-PzJnQZIqPom5x1/…",
    "created_at": "2026-09-29T03:09:38.012Z",
    "expires_at": null
  }
}`, 'json')}
      <p>ডাটাবেসে <code>id</code> আর <code>url</code> সংরক্ষণ করুন। <code>delete_url</code> শুধু এই একবারই আসে; key ছাড়াই ফাইল মোছার জন্য এটা দরকার হলে এখনই রেখে দিন।</p>
    </div>

    <div class="card">
      <h2 id="g-display">৫. ছবি দেখানো ও রিসাইজ</h2>
      <p>পাবলিক ফাইলের <code>url</code> যেকোনো পেজে সরাসরি ব্যবহার করুন। এর জন্য key লাগে না। query parameter দিয়ে যেকোনো সাইজ বানানো যায়, আর প্রথমবার তৈরির পর সেটা cache হয়ে থাকে।</p>
      ${codeBlock(`<img src="${base}/f/8-PzJnQZIqPom5x1.jpg?w=800&format=webp" alt="">

<!-- রেসপন্সিভ ছবি -->
<img src="${base}/f/8-PzJnQZIqPom5x1.jpg?w=400&format=webp"
     srcset="${base}/f/8-PzJnQZIqPom5x1.jpg?w=400&format=webp 400w,
             ${base}/f/8-PzJnQZIqPom5x1.jpg?w=800&format=webp 800w,
             ${base}/f/8-PzJnQZIqPom5x1.jpg?w=1600&format=webp 1600w"
     sizes="(max-width: 600px) 100vw, 800px" alt="">

<!-- PDF -->
<iframe src="${base}/f/AbCdEfGhIjKlMnOp.pdf" width="100%" height="600"></iframe>`, 'html')}
      <table class="table">
        <thead><tr><th>প্যারামিটার</th><th>মান</th></tr></thead>
        <tbody>
          <tr><td><code>w</code>, <code>h</code></td><td>১ – ${config.maxTransformDimension} পিক্সেল (শুধু ছোট হয়)</td></tr>
          <tr><td><code>fit</code></td><td><code>cover</code> · <code>contain</code> · <code>fill</code> · <code>inside</code> · <code>outside</code></td></tr>
          <tr><td><code>format</code></td><td><code>jpeg</code> · <code>png</code> · <code>webp</code> · <code>avif</code></td></tr>
          <tr><td><code>q</code></td><td>কোয়ালিটি ১ – ১০০</td></tr>
          <tr><td><code>download=1</code></td><td>ব্রাউজারে না খুলে ডাউনলোড</td></tr>
        </tbody>
      </table>
      <p class="muted">প্রতিটি ফাইলের সর্বোচ্চ ${config.maxVariantsPerFile}টি আলাদা সাইজ বানানো যায়, তাই অল্প কয়েকটা নির্দিষ্ট সাইজ ব্যবহার করুন।</p>
    </div>

    <div class="card">
      <h2 id="g-manage">৬. ফাইল লিস্ট ও মোছা</h2>
      ${codeTabs([
        ['লিস্ট', `curl "${base}/api/v1/files?page=1&limit=20&kind=image" -H "X-API-Key: ${key}"`, 'bash'],
        ['একটি ফাইল', `curl "${base}/api/v1/files/8-PzJnQZIqPom5x1" -H "X-API-Key: ${key}"`, 'bash'],
        ['মোছা', `curl -X DELETE "${base}/api/v1/files/8-PzJnQZIqPom5x1" -H "X-API-Key: ${key}"`, 'bash'],
        ['ব্যবহার', `curl "${base}/api/v1/me" -H "X-API-Key: ${key}"
# → quota_bytes, used_bytes, scopes, allowed_origins`, 'bash'],
      ])}
    </div>

    <div class="card">
      <h2 id="g-private">৭. প্রাইভেট ফাইল</h2>
      <p><code>visibility=private</code> দিয়ে আপলোড করলে ফাইলটি শুধু মেয়াদি signed লিংক দিয়ে খোলা যায়। যেমন ইনভয়েস, আইডি কার্ড বা ব্যক্তিগত ডকুমেন্টের জন্য।</p>
      ${codeBlock(`# ১ ঘণ্টার লিংক (সর্বোচ্চ ${Math.round(config.maxSignedUrlSeconds / 86400)} দিন)
curl -X POST "${base}/api/v1/files/8-PzJnQZIqPom5x1/sign" \\
  -H "X-API-Key: ${key}" -H "Content-Type: application/json" \\
  -d '{"expires_in": 3600}'`, 'bash')}
    </div>

    <div class="card">
      <h2 id="g-imgbb">৮. imgbb থেকে মাইগ্রেশন</h2>
      <p>imgbb এর API ব্যবহার করলে শুধু বেস URL আর key বদলান। রেসপন্সের ফরম্যাট imgbb এর মতোই থাকবে।</p>
      ${codeBlock(`# আগে
curl -X POST "https://api.imgbb.com/1/upload?key=IMGBB_KEY" -F "image=@photo.jpg"

# এখন
curl -X POST "${base}/1/upload?key=${key}" -F "image=@photo.jpg"`, 'bash')}
    </div>

    <div class="card">
      <h2 id="g-errors">৯. এরর ও সীমা</h2>
      <p>এরর হলে রেসপন্স আসে: <code>{"success": false, "error": {"code": "...", "message": "..."}}</code></p>
      <table class="table">
        <thead><tr><th>HTTP</th><th>code</th><th>কী করবেন</th></tr></thead>
        <tbody>
          <tr><td>401</td><td><code>unauthorized</code></td><td>key ভুল, rotate হয়েছে, বা অ্যাক্সেস বাতিল হয়েছে</td></tr>
          <tr><td>403</td><td><code>forbidden</code> / <code>origin_not_allowed</code></td><td>এই কাজের অনুমতি নেই / ডোমেইনটি অনুমোদিত নয়</td></tr>
          <tr><td>413</td><td><code>file_too_large</code> / <code>quota_exceeded</code></td><td>ফাইল ছোট করুন / পুরনো ফাইল মুছুন বা বেশি quota চান</td></tr>
          <tr><td>415</td><td><code>unsupported_type</code></td><td>শুধু JPEG, PNG, WebP, GIF, AVIF, PDF</td></tr>
          <tr><td>422</td><td><code>invalid_image</code>, <code>unsafe_pdf</code>, <code>remote_url_blocked</code></td><td>ফাইল নষ্ট, PDF এ স্ক্রিপ্ট আছে, বা URL আনা যায়নি</td></tr>
          <tr><td>429</td><td><code>rate_limited</code></td><td><code>RateLimit</code> header দেখে অপেক্ষা করে আবার চেষ্টা করুন</td></tr>
        </tbody>
      </table>
      <p class="muted">আপলোড সীমা: প্রতি key ঘণ্টায় ${config.rateLimit.uploadsPerHour}টি। সব এন্ডপয়েন্টের বিস্তারিত পাবেন <a href="/docs">API রেফারেন্সে</a>।</p>
    </div>

    <div class="card">
      <h2 id="g-security">১০. নিরাপত্তা চেকলিস্ট</h2>
      <ul class="checklist">
        <li>key শুধু সার্ভারের environment variable এ রাখুন; কোড বা git এ নয়।</li>
        <li>key ফাঁস হয়েছে মনে হলে ড্যাশবোর্ড থেকে সাথে সাথে <strong>Rotate</strong> করুন। পুরনো key তখনই বন্ধ হয়ে যাবে।</li>
        <li>ব্যবহারকারীর আপলোড নিজের সার্ভারেও যাচাই করুন (লগইন করা ইউজার কিনা, কতগুলো আপলোড করছে)।</li>
        <li>ব্যক্তিগত ডকুমেন্ট সবসময় <code>private</code> হিসেবে আপলোড করুন।</li>
        <li>যে অনুমতি দরকার নেই, তা চাইবেন না। যেমন শুধু আপলোড হলে <code>delete</code> লাগবে না।</li>
      </ul>
    </div>
  </article>
</section>`;
}
