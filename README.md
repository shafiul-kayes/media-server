# Media Server

imgbb / uploadcare এর মতো self-hosted ইমেজ ও PDF হোস্টিং সার্ভার। যেকোনো ওয়েবসাইট, অ্যাপ বা ব্যাকএন্ড থেকে API দিয়ে আপলোড করা যায়, আর পাওয়া লিংক যেকোনো জায়গায় embed করা যায়।

- **তিনভাবে আপলোড:** ফাইল, base64, অথবা ইমেজের URL
- **imgbb-compatible API:** `POST /1/upload?key=...`। imgbb এর কোডে শুধু বেস URL বদলালেই চলে
- **অন্য ডোমেইন থেকে ব্যবহার:** প্রতিটি key এর আলাদা `allowed_origins` (CORS)
- **Viewer পেজ** (`/v/<id>`), যেখানে Direct link, HTML, BBCode ও Markdown embed কোড থাকে
- **delete_url:** key ছাড়াই ফাইল মোছার এককালীন লিংক
- On-the-fly রিসাইজ/ফরম্যাট (`?w=600&format=webp`), private ফাইলের signed URL, অটো-ডিলিট
- **API ডকুমেন্টেশন:** সার্ভার চালু করে `/docs` খুলুন (Swagger UI, বাংলা গাইড সহ)। মেশিনের জন্য স্পেক পাবেন `/openapi.json` এ

**সাপোর্টেড ফাইল:** JPEG, PNG, WebP, GIF (অ্যানিমেটেড সহ), AVIF, PDF
**ডাটাবেস:** MySQL 5.7+ / 8.x অথবা MariaDB 10.3+। ইমেজ ও PDF এর আসল বাইটও MySQL এ রাখা হয়।

## MySQL সেটআপ

**১. ডাটাবেস ও আলাদা user তৈরি করুন** (একবারই)। [database/create-user.sql](database/create-user.sql) এ পাসওয়ার্ড বদলে root হিসেবে চালান:

```bash
mysql -u root -p < database/create-user.sql
```

phpMyAdmin বা cPanel ব্যবহার করলে সেখান থেকে একটি ডাটাবেস ও user বানান, আর user কে শুধু সেই ডাটাবেসে `SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES` অনুমতি দিন। root user দিয়ে অ্যাপ চালাবেন না।

**২. `.env` এ তথ্য দিন:**

```ini
DB_HOST=127.0.0.1
DB_PORT=3306
DB_NAME=media_server
DB_USER=media_server
DB_PASSWORD=আপনার-পাসওয়ার্ড
STORAGE_DRIVER=mysql
```

**৩. টেবিল তৈরি করুন:**

```bash
npm run db:setup
```

অথবা phpMyAdmin → Import এ [database/schema.sql](database/schema.sql) দিন। সার্ভার চালু হওয়ার সময়ও নতুন migration নিজে থেকে চলে।

### টেবিলগুলো

| টেবিল | কী থাকে |
|---|---|
| `api_keys` | key এর নাম, scope, quota, allowed_origins, key এর SHA-256 hash (আসল key নয়) |
| `files` | প্রতিটি ফাইলের তথ্য: টাইপ, সাইজ, মাপ, টাইটেল, visibility, মেয়াদ, কোথায় রাখা (`storage`) |
| `file_blobs` | আসল ইমেজ/PDF এর বাইট (`LONGBLOB`) |
| `file_variants` | রিসাইজ করা থাম্বনেইল/ভ্যারিয়েন্ট (`LONGBLOB`) |
| `schema_migrations` | কোন migration চলেছে |

ফাইল মুছলে তার blob ও variant নিজে থেকেই মুছে যায় (`ON DELETE CASCADE`)।

### `STORAGE_DRIVER`: mysql নাকি disk

| | `mysql` (ডিফল্ট) | `disk` |
|---|---|---|
| বাইট কোথায় | MySQL টেবিলে | `STORAGE_DIR` ফোল্ডারে, তথ্য MySQL এ |
| ব্যাকআপ | শুধু `mysqldump` | ডাটাবেস + `storage/` ফোল্ডার |
| একাধিক সার্ভার | সহজ, সবাই একই DB পড়ে | শেয়ার্ড ফোল্ডার লাগবে |
| পারফরম্যান্স | প্রতিটি রিকোয়েস্টে পুরো ফাইল DB থেকে মেমোরিতে আসে | ডিস্ক থেকে stream হয়, বেশি ট্রাফিকে দ্রুত |

প্রতিটি ফাইল নিজের `storage` মনে রাখে, তাই পরে driver বদলালেও পুরনো ফাইল ঠিকমতো পাওয়া যাবে। `mysql` মোডে বেশি ট্রাফিক হলে সামনে একটা CDN (যেমন Cloudflare) রাখুন। পাবলিক ফাইলে এক বছরের cache header থাকে, তাই বেশিরভাগ রিকোয়েস্ট ডাটাবেস পর্যন্ত আসবেই না।

**`max_allowed_packet`:** MySQL এক রিকোয়েস্টে এর চেয়ে বড় ডাটা নেয় না। MySQL 8 এ ডিফল্ট 64 MB, যা যথেষ্ট। কিন্তু MySQL 5.7 এ ডিফল্ট মাত্র 4 MB। কম থাকলে সার্ভার চালুর সময় সতর্কবার্তা দেখাবে; তখন `my.cnf` / `my.ini` এর `[mysqld]` অংশে `max_allowed_packet=16M` (বা `MAX_FILE_SIZE_MB` + কিছু বেশি) দিয়ে MySQL রিস্টার্ট করুন।

## চালু করা

```bash
npm install
npm run setup                                   # .env বানায়, র‍্যান্ডম সিক্রেট সহ
# .env এ DB_* তথ্য দিন (উপরে দেখুন)
npm run db:setup                                # MySQL টেবিল তৈরি
npm run create-key -- --name "Backend"          # সার্ভার-সাইড key (সব scope)
npm run create-key -- --name "Website" --scopes upload --quota 500 \
  --origins https://mysite.com,https://*.mysite.com   # ব্রাউজারের জন্য key
npm start                                       # http://localhost:3000/docs
npm test                                        # ৭৩টি টেস্ট (প্রথমবার টেস্টের জন্য MySQL নিজে থেকে ডাউনলোড হয়)
```

প্রোডাকশনে `.env` এ `NODE_ENV=production` আর `PUBLIC_BASE_URL` এ আপনার https ডোমেইন দিন। reverse proxy (nginx/Cloudflare) এর পেছনে থাকলে `TRUST_PROXY=1` দিন।

## দ্রুত উদাহরণ

```bash
# ফাইল
curl -H "X-API-Key: $KEY" -F "image=@photo.jpg" https://media.example.com/api/v1/upload

# URL থেকে
curl -H "X-API-Key: $KEY" -F "image=https://example.com/cat.png" https://media.example.com/api/v1/upload

# base64
curl -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
     -d '{"image":"iVBORw0KGgo...","name":"logo.png"}' https://media.example.com/api/v1/upload

# imgbb-compatible
curl -X POST "https://media.example.com/1/upload?key=$KEY&expiration=600" -F "image=@photo.jpg"
```

রেসপন্স (native API):

```json
{
  "success": true,
  "data": {
    "id": "8-PzJnQZIqPom5x1",
    "title": "photo.jpg",
    "kind": "image",
    "mime": "image/jpeg",
    "width": 1920,
    "height": 1080,
    "url": "https://media.example.com/f/8-PzJnQZIqPom5x1.jpg",
    "thumb_url": "https://media.example.com/f/8-PzJnQZIqPom5x1.jpg?w=320&h=320&fit=cover&format=webp",
    "viewer_url": "https://media.example.com/v/8-PzJnQZIqPom5x1",
    "delete_url": "https://media.example.com/d/8-PzJnQZIqPom5x1/Xb3...",
    "download_url": "https://media.example.com/f/8-PzJnQZIqPom5x1.jpg?download=1",
    "visibility": "public",
    "created_at": "2026-09-29T03:09:38.012Z",
    "expires_at": null
  }
}
```

**অন্য ওয়েবসাইট থেকে (ব্রাউজার):**

```js
const form = new FormData();
form.append('image', fileInput.files[0]);
const res = await fetch('https://media.example.com/api/v1/upload', {
  method: 'POST',
  headers: { 'X-API-Key': 'ms_xxx' },   // upload-only key, যার allowed_origins এ এই সাইট আছে
  body: form,
});
const { data } = await res.json();
img.src = data.thumb_url;
```

> ব্রাউজার কোডে রাখা key যে কেউ দেখতে পারে। তাই ব্রাউজারের জন্য আলাদা key রাখুন, যাতে শুধু `upload` scope, ছোট quota আর নির্দিষ্ট `allowed_origins` থাকে। লিস্ট/ডিলিট করার key শুধু নিজের সার্ভারে রাখুন। মনে রাখবেন, `allowed_origins` শুধু ব্রাউজারের ক্ষেত্রে কার্যকর। কেউ key চুরি করে নিজের সার্ভার থেকে ব্যবহার করলে তাকে scope, quota আর rate limit দিয়েই সীমিত রাখা হয়।

সব এন্ডপয়েন্ট, প্যারামিটার, এরর কোড, আর PHP/Python/Node উদাহরণ পাবেন **`/docs`** এ।

## এন্ডপয়েন্ট সংক্ষেপে

| মেথড | পাথ | কাজ |
|---|---|---|
| POST | `/api/v1/upload` | আপলোড (file / base64 / URL) |
| POST | `/1/upload` | imgbb-compatible আপলোড |
| GET | `/api/v1/me` | key এর তথ্য ও storage ব্যবহার |
| GET | `/api/v1/files` | নিজের ফাইলের লিস্ট |
| GET · PATCH · DELETE | `/api/v1/files/:id` | তথ্য / visibility বদল / মোছা |
| GET | `/api/v1/files/:id/content` | আসল ফাইল ডাউনলোড |
| POST | `/api/v1/files/:id/sign` | private ফাইলের মেয়াদি লিংক |
| GET | `/f/<id>.<ext>` | পাবলিক ফাইল ও রিসাইজ |
| GET | `/v/<id>` | viewer পেজ |
| GET · POST | `/d/<id>/<token>` | delete লিংক (GET এ নিশ্চিতকরণ পেজ, POST এ মোছা) |
| * | `/api/v1/admin/...` | key ম্যানেজমেন্ট (`Authorization: Bearer <ADMIN_TOKEN>`) |

## সিকিউরিটি

**আপলোড যাচাই**
- ফাইলের আসল টাইপ magic bytes দেখে নির্ধারণ হয়। শুধু whitelist টাইপ গ্রহণ হয়; SVG, HTML, PHP সবসময় বাতিল।
- প্রতিটি ইমেজ decode করে নতুন করে encode করা হয়। এতে EXIF/GPS metadata আর লুকানো payload (polyglot) মুছে যায়।
- Decompression bomb, ফ্রেম সংখ্যা, ফাইল সাইজ আর form field এর সীমা আছে।
- PDF এ JavaScript, Launch, embedded file, XFA ইত্যাদি থাকলে বাতিল হয়। hex দিয়ে লুকানো নাম আর compressed object stream এর ভেতরেও খোঁজা হয়। Encrypted PDF ডিফল্টে বাতিল।

**URL থেকে আপলোড (SSRF সুরক্ষা)**
- শুধু http/https, পোর্ট 80/443। URL এর ভেতরে username/password থাকলে বাতিল।
- Private, loopback, link-local (যেমন cloud metadata `169.254.169.254`), CGNAT, multicast আর IPv4-mapped IPv6 ঠিকানা ব্লক।
- ঠিকানা যাচাই হয় ঠিক কানেক্ট করার মুহূর্তে (DNS rebinding রোধ)। প্রতিটি redirect আবার যাচাই হয়, সর্বোচ্চ ৩টি।
- সময়সীমা ও সাইজের সীমা ডাউনলোড চলার সময়েই প্রয়োগ হয়।

**অ্যাক্সেস**
- API key তে 256-bit র‍্যান্ডমনেস; ডাটাবেসে শুধু hash থাকে। প্রতিটি key এর scope, quota আর `allowed_origins` আছে।
- CORS: কোনো cookie/credential ব্যবহার হয় না। প্রতিটি ব্রাউজার রিকোয়েস্টের Origin সংশ্লিষ্ট key এর allow-list এর সাথে মিলিয়ে দেখা হয়। Admin API তে CORS নেই।
- Private ফাইল খোলে শুধু HMAC-signed, মেয়াদি ও নির্দিষ্ট ফাইলের সাথে বাঁধা URL দিয়ে।
- delete_url এর token এ 192-bit র‍্যান্ডমনেস, hash করে রাখা হয়। শুধু GET করলে ফাইল মোছে না (link preview বা crawler থেকে নিরাপদ)।
- Rate limit: API, আপলোড (প্রতি key), ভুল key দিয়ে চেষ্টা, পাবলিক ফাইল, রিসাইজ, delete পেজ, admin।

**ডাটাবেস**
- সব কুয়েরি parameterized (`?` placeholder); stacked query (`multipleStatements`) বন্ধ।
- আলাদা, সীমিত অনুমতির MySQL user; production এ `DB_PASSWORD` ছাড়া সার্ভার চালু হয় না।
- ID কলামে `ascii_bin` collation, যাতে `abc` আর `ABC` আলাদা ID হিসেবে গণ্য হয়।
- আপলোডে ফাইলের তথ্য, বাইট আর quota হিসাব একই transaction এ হয়। key এর row lock থাকায় একসাথে অনেক আপলোডেও quota পার হয় না।
- MySQL অন্য মেশিনে থাকলে `DB_SSL=true` দিয়ে TLS সংযোগ।

**পরিবেশন**
- `nosniff`, আর ইমেজে `CSP sandbox` থাকে। HTML পেজে কোনো inline script নেই (`script-src 'self'`), আর সব ইউজার টেক্সট HTML-escape করা হয়।
- ফাইল ডিস্কে র‍্যান্ডম ID দিয়ে সেভ হয়, তাই path traversal সম্ভব নয়।

### প্রোডাকশন পরামর্শ
- ফাইল **আলাদা ডোমেইন** থেকে সার্ভ করুন (যেমন `media.example.com`), যাতে মূল সাইটের কুকি সেখানে না যায়।
- HTTPS বাধ্যতামূলক। Nginx এ `client_max_body_size 15m;` দিন (base64 আপলোড ফাইলের চেয়ে ~৩৩% বড় হয়)।
- নিয়মিত ব্যাকআপ রাখুন: `mysqldump --single-transaction --hex-blob media_server > backup.sql` (`disk` মোডে `storage/` ফোল্ডারও)। CDN ব্যবহার করলে ফাইল মোছার পর CDN ক্যাশ purge করুন।

## প্রজেক্ট কাঠামো

```
src/
  app.js, server.js       Express app ও সার্ভার
  config.js               .env থেকে কনফিগ ও যাচাই
  db.js                   MySQL connection pool ও transaction
  schema.js               টেবিল ও migration
  repo.js                 সব SQL কুয়েরি
  docs/openapi.js         API ডকুমেন্টেশন (OpenAPI 3.1 + বাংলা গাইড)
  routes/api.js           /api/v1 (upload, files)
  routes/compat.js        /1/upload (imgbb-compatible)
  routes/public.js        /f/<id>.<ext>
  routes/pages.js         /v/<id> viewer, /d/<id>/<token> delete
  routes/admin.js         key ম্যানেজমেন্ট
  middleware/             auth, cors, rate limit, errors
  services/storage.js     MySQL/disk ফাইল স্টোরেজ (ETag, Range সহ)
  services/               upload, remote (SSRF-safe fetch), image, pdf, signer, origins
database/                 schema.sql (phpMyAdmin import), create-user.sql
scripts/                  setup, db-setup, create-key
public/assets/            viewer/docs পেজের CSS ও JS
test/                     api, imgbb, mysql টেস্ট (সাময়িক MySQL সার্ভারে চলে)
```
