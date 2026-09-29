// Usage: npm run create-key -- --name "My App" [--scopes upload,read,delete] [--quota 1024]
//        [--origins https://example.com,https://*.example.com]
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    name: { type: 'string' },
    scopes: { type: 'string' },
    quota: { type: 'string' },
    origins: { type: 'string' },
  },
});

const { createApiKey, parseName, parseQuotaMb, parseScopes } = await import('../src/services/apiKeys.js');
const { parseOrigins } = await import('../src/services/origins.js');
const { closeDb } = await import('../src/db.js');
const { migrate } = await import('../src/schema.js');

try {
  await migrate();
  const { secret, key } = await createApiKey({
    name: parseName(values.name),
    scopes: parseScopes(values.scopes),
    quotaBytes: parseQuotaMb(values.quota),
    allowedOrigins: parseOrigins(values.origins) ?? [],
  });
  console.log(`API key created for "${key.name}" (${key.id})`);
  console.log(`Scopes: ${key.scopes}   Quota: ${Math.round(key.quota_bytes / 1048576)} MB`);
  console.log(`Allowed browser origins: ${key.allowed_origins || '(none, server-side only)'}`);
  console.log(`\n  ${secret}\n`);
  console.log('Store it now. It cannot be shown again.');
} catch (err) {
  console.error(err.code ? `${err.code}: ${err.message}` : err.message);
  process.exitCode = 1;
} finally {
  await closeDb();
}
