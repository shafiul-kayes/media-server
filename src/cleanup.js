import * as repo from './repo.js';
import { removeStoredBytes } from './services/storage.js';

/** Deletes files whose `expiration` has passed. Returns the number removed. */
export async function purgeExpired(now = Date.now()) {
  let removed = 0;
  for (;;) {
    const batch = await repo.files.expired(now, 500);
    if (!batch.length) return removed;
    for (const file of batch) {
      if (await repo.files.removeWithQuota(file)) {
        await removeStoredBytes(file);
        removed++;
      }
    }
  }
}

export function startCleanupJob(intervalMs = 5 * 60 * 1000) {
  const run = () => purgeExpired()
    .then((n) => n && console.log(`[cleanup] removed ${n} expired file(s)`))
    .catch((err) => console.error('[cleanup] failed', err));
  run();
  return setInterval(run, intervalMs).unref();
}
