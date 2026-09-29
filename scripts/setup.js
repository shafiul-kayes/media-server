// Creates .env from .env.example with freshly generated secrets.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, '.env');

if (fs.existsSync(target)) {
  console.log('.env already exists; not overwriting it.');
  process.exit(0);
}

const secret = () => crypto.randomBytes(48).toString('base64url');
const template = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
const content = template
  .replace(/^ADMIN_TOKEN=.*$/m, `ADMIN_TOKEN=${secret()}`)
  .replace(/^SIGNING_SECRET=.*$/m, `SIGNING_SECRET=${secret()}`);

fs.writeFileSync(target, content, { mode: 0o600 });
console.log('Created .env with a new ADMIN_TOKEN and SIGNING_SECRET.');
