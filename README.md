# Media Server

imgbb / uploadcare এর মতো self-hosted ইমেজ ও PDF হোস্টিং প্ল্যাটফর্ম। ডেভেলপাররা অ্যাকাউন্ট খুলে API অ্যাক্সেসের অনুরোধ করেন, অ্যাডমিন অনুমোদন দিলে নিজের API key দিয়ে যেকোনো ওয়েবসাইট, অ্যাপ বা ব্যাকএন্ড থেকে ইমেজ ও PDF আপলোড করেন।

## ইকোসিস্টেম এক নজরে

```
 ডেভেলপার                              অ্যাডমিন
 ─────────                              ────────
 ১. /register  অ্যাকাউন্ট খোলা → ইমেইলের লিংকে যাচাই
 ২. /account/apps/new  API অনুরোধ ───►  /admin/requests  রিভিউ
                                          ├─ অনুমোদন (scope, quota, ডোমেইন ঠিক করে)
                                          └─ প্রত্যাখ্যান (কারণসহ)
 ৩. অনুমোদিত হলে "API key তৈরি" ◄──────┘
 ৪. /account/docs  ব্যক্তিগত ইন্টিগ্রেশন গাইড
 ৫. নিজের অ্যাপ থেকে API কল ──────────►  ইমেজ + PDF সার্ভার
 ৬. /account/apps/:id/files  ফাইল ম্যানেজার, ব্যবহারের হিসাব
                                          অ্যাডমিন যেকোনো সময়: key বাতিল, সীমা বদল,
                                          ইউজার স্থগিত, অডিট লগ দেখা
```

| কার জন্য | কোথায় | কী কী আছে |
|---|---|---|
| সবাই | `/` | ল্যান্ডিং পেজ, রেজিস্ট্রেশন, লগইন |
| ইউজার | `/account` | ড্যাশবোর্ড, API অনুরোধ, key তৈরি/rotate, ফাইল ম্যানেজার, ব্যবহারের হিসাব, ইন্টিগ্রেশন গাইড, সেটিংস |
| অ্যাডমিন | `/admin` | ওভারভিউ, অনুরোধ অনুমোদন/প্রত্যাখ্যান, সীমা বদল, key বাতিল, ইউজার ব্যবস্থাপনা, সব key, অডিট লগ |
| ডেভেলপার | `/docs` | Swagger API রেফারেন্স (try-it-out সহ), `/openapi.json` |

## API ফিচার

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
| `users` | ইউজারের নাম, ইমেইল, scrypt পাসওয়ার্ড hash, ভূমিকা (user/admin), অবস্থা, লগইন লক |
| `sessions` | লগইন সেশন (শুধু token এর hash), CSRF token, মেয়াদ |
| `api_applications` | API অনুরোধ: অ্যাপের তথ্য, উদ্দেশ্য, স্ট্যাটাস, অ্যাডমিনের মন্তব্য, সংযুক্ত key |
| `audit_logs` | কে, কখন, কী করেছে (লগইন, অনুমোদন, key rotate, স্থগিত…) |
| `user_tokens` | ইমেইলে পাঠানো একবার ব্যবহারযোগ্য লিংক (যাচাই, পাসওয়ার্ড রিসেট, আমন্ত্রণ); শুধু hash, মেয়াদসহ |
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
npm run create-admin -- --email you@example.com --name "আপনার নাম"   # প্রথম অ্যাডমিন: ইমেইলে আমন্ত্রণ লিংক যাবে
npm start                                       # http://localhost:3000
npm test                                        # ১১৫টি টেস্ট (প্রথমবার টেস্টের জন্য MySQL নিজে থেকে ডাউনলোড হয়)
```

`create-admin` কোনো পাসওয়ার্ড বানায় না। নতুন অ্যাডমিনের ইমেইলে একটা আমন্ত্রণ লিংক যায়, যেখান থেকে তিনি নিজের পাসওয়ার্ড সেট করেন, আর তাতে তার ইমেইলও যাচাই হয়ে যায়। SMTP সেট করা না থাকলে (`MAIL_TRANSPORT=log`) বা ইমেইল পাঠানো না গেলে লিংকটি টার্মিনালেই দেখানো হয়, তাই প্রথম অ্যাডমিন সবসময় ঢুকতে পারবেন। আগে থেকে থাকা কোনো ইউজারকে অ্যাডমিন বানাতে: `npm run create-admin -- --email user@example.com --promote`। পরের অ্যাডমিন বা ইউজারদের প্যানেলের **ইউজার → + আমন্ত্রণ** থেকে যোগ করা যায়।

## Hostinger এ ডেপ্লয় (Business / Cloud হোস্টিং)

Single ও Premium প্ল্যানে Node.js চলে না; লাগবে **Business Web Hosting** বা যেকোনো **Cloud** প্ল্যান।

**১. ডাটাবেস:** hPanel → **Databases → Management** থেকে একটি MySQL ডাটাবেস ও user তৈরি করুন (নাম হবে `u123456789_media` এর মতো)।

**২. ইমেইল অ্যাকাউন্ট:** hPanel → **Emails** থেকে `no-reply@আপনার-ডোমেইন` তৈরি করুন (SMTP এর জন্য)।

**৩. অ্যাপ:** **Websites → Add Website → Deploy Web App** → GitHub রিপো অথবা zip আপলোড। zip এ `node_modules`, `.env`, `storage` রাখবেন না।

| সেটিং | কী দেবেন |
|---|---|
| Framework preset | **Express.js** (না থাকলে **Other**) |
| Node.js version | **22.x** |
| Package manager | **npm** |
| Build command | খালি রাখুন (build ধাপ নেই) |
| Output directory | খালি রাখুন |
| Entry file | **`server.cjs`** |

**৪. Environment variables** (ডেপ্লয় পেজে; `PORT` আর `HOST` দেবেন না, Hostinger নিজে দেয়):

```ini
NODE_ENV=production
PUBLIC_BASE_URL=https://আপনার-ডোমেইন.com
TRUST_PROXY=1
ADMIN_TOKEN=লোকাল .env থেকে কপি
SIGNING_SECRET=লোকাল .env থেকে কপি
DB_HOST=localhost
DB_PORT=3306
DB_NAME=u123456789_media
DB_USER=u123456789_media
DB_PASSWORD=ডাটাবেসের পাসওয়ার্ড
STORAGE_DRIVER=mysql
MAIL_TRANSPORT=smtp
SMTP_HOST=smtp.hostinger.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=no-reply@আপনার-ডোমেইন.com
SMTP_PASSWORD=ইমেইল অ্যাকাউন্টের পাসওয়ার্ড
MAIL_FROM=Media Server <no-reply@আপনার-ডোমেইন.com>
```

`TRUST_PROXY=1` অবশ্যই দিন। না দিলে সব ভিজিটরকে একই IP মনে হবে, আর একজনের rate limit এ সবাই আটকে যাবে। টেবিলগুলো প্রথমবার চালুর সময় নিজে থেকে তৈরি হয়।

**৫. প্রথম অ্যাডমিন:** Hostinger এ টার্মিনাল থেকে npm কমান্ড চালানো যায় না, তাই সাইটে সাধারণভাবে রেজিস্ট্রেশন করে ইমেইল যাচাই করুন। তারপর hPanel → **Databases → phpMyAdmin** এ চালান:

```sql
UPDATE users SET role = 'admin', email_verified_at = COALESCE(email_verified_at, NOW(3))
WHERE email = 'you@আপনার-ডোমেইন.com';
```

পেজ রিফ্রেশ করলেই বাঁদিকের মেনুতে অ্যাডমিন প্যানেল আসবে।

**৬. স্টোরেজ:** Hostinger প্রতিবার ডেপ্লয়ে অ্যাপের ফোল্ডার নতুন করে লেখে, তাই `STORAGE_DRIVER=mysql` (ডিফল্ট) নিরাপদ। অনেক ফাইল হলে ডাটাবেসের সাইজ সীমা দেখে নিন। বিকল্প হলো `STORAGE_DRIVER=disk` আর `STORAGE_DIR=/home/u123456789/media-storage`, অর্থাৎ ডেপ্লয় ফোল্ডারের **বাইরে** একটা পাথ, যাতে ডেপ্লয়ে ফাইল মুছে না যায়।

## ইমেইল সেটআপ (SMTP)

ইমেইল যাচাই, পাসওয়ার্ড রিসেট, আমন্ত্রণ আর নোটিফিকেশনের জন্য `.env` এ SMTP দিন:

```ini
MAIL_TRANSPORT=smtp
SMTP_HOST=smtp.gmail.com          # অথবা mail.yourdomain.com, smtp-relay.brevo.com ...
SMTP_PORT=465
SMTP_SECURE=true                  # 465 হলে true; 587 হলে false (তখন STARTTLS বাধ্যতামূলক)
SMTP_USER=you@gmail.com
SMTP_PASSWORD=app-password        # Gmail এ সাধারণ পাসওয়ার্ড নয়, "App Password" লাগবে
MAIL_FROM="Media Server <you@gmail.com>"
```

সার্ভার চালু হওয়ার সময় SMTP সংযোগ পরীক্ষা করে ফলাফল দেখায় (`[mail] SMTP ready`)। ডেভেলপমেন্টে `MAIL_TRANSPORT=log` রাখলে কোনো ইমেইল পাঠানো হয় না, সব ইমেইল (লিংকসহ) সার্ভারের কনসোলে দেখা যায়। ইমেইল স্প্যামে যাওয়া কমাতে নিজের ডোমেইনে SPF আর DKIM রেকর্ড যোগ করুন।

| ইমেইল | কখন যায় |
|---|---|
| ইমেইল যাচাই | রেজিস্ট্রেশনের পর, আর "ইমেইল আবার পাঠান" চাপলে (লিংক ৪৮ ঘণ্টা) |
| পাসওয়ার্ড রিসেট | `/forgot-password` থেকে, বা অ্যাডমিন পাঠালে (লিংক ৬০ মিনিট) |
| পাসওয়ার্ড বদলানো হয়েছে | রিসেট বা সেটিংস থেকে পাসওয়ার্ড বদলালে (সতর্কতা হিসেবে) |
| আমন্ত্রণ | অ্যাডমিন নতুন ইউজার/অ্যাডমিন যোগ করলে (লিংক ৭ দিন) |
| নতুন API অনুরোধ | অ্যাডমিনদের কাছে (`NOTIFY_ADMINS_ON_REQUEST`) |
| অনুমোদিত / প্রত্যাখ্যাত / বাতিল | অ্যাপের মালিকের কাছে, অ্যাডমিনের মন্তব্যসহ |

যাচাই না করা পর্যন্ত ইউজার লগইন করতে পারেন, কিন্তু API অনুরোধ বা key তৈরি করতে পারেন না। অ্যাডমিনও যাচাই না করে অ্যাডমিন প্যানেলে ঢুকতে পারেন না। এই নিয়ম বন্ধ করতে চাইলে `REQUIRE_EMAIL_VERIFICATION=false` দিন। এই ফিচার আসার আগে যেসব অ্যাকাউন্ট ছিল, সেগুলো নিজে থেকেই যাচাইকৃত ধরা হয়।

নিজের সার্ভার বা অটোমেশনের জন্য প্যানেল ছাড়াই সরাসরি key বানানো যায়:

```bash
npm run create-key -- --name "Backend"          # সার্ভার-সাইড key (সব scope)
npm run create-key -- --name "Website" --scopes upload --quota 500 \
  --origins https://mysite.com,https://*.mysite.com   # ব্রাউজারের জন্য key
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

**ইউজার অ্যাকাউন্ট ও প্যানেল**
- পাসওয়ার্ড scrypt দিয়ে hash করা (memory-hard, প্রতিটিতে আলাদা salt)। কমপক্ষে ১০ অক্ষর; সহজ বা ইমেইলের নাম থাকা পাসওয়ার্ড গ্রহণ হয় না।
- সেশন cookie: HttpOnly, SameSite=Lax, আর https এ `Secure` ও `__Host-` prefix। DB তে শুধু token এর hash থাকে। idle ও সর্বোচ্চ মেয়াদ আছে, আর প্রতিবার লগইনে নতুন token দেওয়া হয়।
- প্রতিটি ফর্মে CSRF token, সাথে Origin/Referer যাচাই। লগআউট শুধু POST দিয়ে হয়।
- লগইন ব্রুট-ফোর্স রোধ: প্রতি IP rate limit, আর পরপর ৫ বার ভুল হলে অ্যাকাউন্ট ১৫ মিনিট লক। অজানা ইমেইল আর ভুল পাসওয়ার্ডে একই বার্তা ও একই সময় লাগে, তাই কোন ইমেইল নিবন্ধিত তা বোঝা যায় না।
- রেজিস্ট্রেশনে প্রতি IP সীমা আর bot ধরার জন্য honeypot ফিল্ড।
- API key: অনুমোদনের পর ইউজার নিজে key তৈরি করেন, যা শুধু একবার দেখানো হয়। rotate করলে পুরনো key সাথে সাথে বন্ধ হয়। ইউজার স্থগিত হলে তার সব key আর সেশন তৎক্ষণাৎ বন্ধ।
- একজন ইউজার অন্যের অ্যাপ বা ফাইল দেখতে পারেন না (SQL এ ownership যাচাই)। `/admin` এ ঢুকতে admin ভূমিকা লাগে, আর অ্যাডমিন নিজেকে স্থগিত বা নামাতে পারেন না।
- লগইনের পর শুধু নিজের সাইটের পাথে redirect হয় (open redirect রোধ)।
- প্যানেলের HTML টেমপ্লেট নিজে থেকে সব ইউজার টেক্সট escape করে। কোনো inline script নেই, strict CSP।
- সব গুরুত্বপূর্ণ কাজ অডিট লগে থাকে।

**ইমেইল যাচাই, পাসওয়ার্ড রিসেট ও আমন্ত্রণ**
- ইমেইলের লিংকে 256-bit র‍্যান্ডম টোকেন থাকে। DB তে শুধু তার SHA-256 থাকে, প্রতিটির মেয়াদ আছে, আর প্রতিটি **একবারই** ব্যবহার করা যায়। দুটো অনুরোধ একসাথে এলেও শুধু একটা সফল হয়।
- নতুন রিসেট লিংক পাঠালে আগের সব রিসেট লিংক বাতিল হয়ে যায়।
- "পাসওয়ার্ড ভুলে গেছেন" পেজে ইমেইল নিবন্ধিত থাকুক বা না থাকুক, একই উত্তর আর একই সময় লাগে, আর ইমেইল পাঠানো হয় ব্যাকগ্রাউন্ডে। তাই কোন ইমেইল নিবন্ধিত তা বোঝা যায় না।
- সীমা: প্রতি IP ১৫ মিনিটে ৫টি রিসেট অনুরোধ, প্রতি অ্যাকাউন্ট ঘণ্টায় ৩টি রিসেট ইমেইল, আর যাচাই ইমেইল মিনিটে একটি ও ঘণ্টায় ৫টি।
- রিসেট সফল হলে অ্যাকাউন্টের সব সেশন বন্ধ হয় (হ্যাকারের সেশনও), লক খুলে যায়, আর "পাসওয়ার্ড বদলানো হয়েছে" সতর্কতা ইমেইল যায়।
- লিংক শুধু খুললে (GET) কিছু বদলায় না, একটা বোতাম চাপতে হয় (POST)। তাই ইমেইল স্ক্যানার বা লিংক প্রিভিউ টোকেন খরচ করে ফেলতে পারে না। এসব পেজে `Referrer-Policy: no-referrer` থাকে, যাতে টোকেন অন্য সাইটে ফাঁস না হয়।
- অ্যাডমিন কারো পাসওয়ার্ড দেখতে বা সেট করতে পারেন না; শুধু ইউজারের নিজের ইমেইলে রিসেট লিংক পাঠাতে পারেন।
- ইমেইলের সব ইউজার-টেক্সট HTML-escape করা হয়, আর subject এ লাইন-ব্রেক সরিয়ে ফেলা হয় (header injection রোধ)। SMTP সংযোগ TLS 1.2+ ছাড়া হয় না।

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
  accounts/               পাসওয়ার্ড hashing, সেশন ও CSRF, ইমেইল টোকেন, ইনপুট যাচাই, ইউজার/অ্যাপ/অডিট কুয়েরি
  mail/                   SMTP মেইলার ও বাংলা ইমেইল টেমপ্লেট
  web/                    ল্যান্ডিং, লগইন/রেজিস্ট্রেশন, পাসওয়ার্ড রিসেট ও ইমেইল যাচাই, ইউজার ড্যাশবোর্ড, অ্যাডমিন প্যানেল, গাইড
  services/               upload, remote (SSRF-safe fetch), image, pdf, signer, origins
database/                 schema.sql (phpMyAdmin import), create-user.sql
scripts/                  setup, db-setup, create-admin, create-key
public/assets/            প্যানেল, viewer ও docs পেজের CSS ও JS
test/                     api, imgbb, mysql, accounts, recovery টেস্ট (সাময়িক MySQL সার্ভারে চলে)
```
