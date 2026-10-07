// Optional durable storage for serverless deployments (Vercel), using an Upstash Redis REST endpoint.
// Enabled only when KV_REST_API_URL/KV_REST_API_TOKEN (Vercel's Upstash integration) or
// UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN are set; otherwise every function is a no-op and
// the app keeps its normal file/in-memory storage.
//
// Model: the whole JSON document store is saved under one key with a version counter. Each request
// reloads the state when another instance has saved a newer version, and saves after any committed
// transaction (last writer wins — adequate for a demo, not for production traffic).
import { adoptState, snapshotState, takeDirty } from '../db.js';

const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const PREFIX = process.env.VHC_STORE_PREFIX || 'vhc';
export const remoteEnabled = () => Boolean(URL_ && TOKEN);

async function redis(...command) {
  const res = await fetch(URL_, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) throw new Error(`Remote store error: ${body.error || res.status}`);
  return body.result;
}

let localVersion = null;

/** Pull the latest saved state if another instance has written since we last looked. Returns false when nothing is stored yet. */
export async function syncIn() {
  if (!remoteEnabled()) return true;
  const v = await redis('GET', `${PREFIX}:ver`);
  if (v == null) return false;
  if (String(v) !== localVersion) {
    const json = await redis('GET', `${PREFIX}:state`);
    if (json) adoptState(JSON.parse(json));
    localVersion = String(v);
    takeDirty();
  }
  return true;
}

/** Save the state if a transaction committed during this request. */
export async function syncOut(force = false) {
  if (!remoteEnabled()) return;
  if (!takeDirty() && !force) return;
  const json = snapshotState();
  await redis('SET', `${PREFIX}:state`, json); // write the state first so a reader never sees a new version with old data
  const v = await redis('INCR', `${PREFIX}:ver`);
  localVersion = String(v);
}

// Private document bodies (base64). Files are also written to local disk by the documents route.
export async function saveBlob(id, buffer) {
  if (!remoteEnabled()) return;
  await redis('SET', `${PREFIX}:doc:${id}`, buffer.toString('base64'));
}
export async function loadBlob(id) {
  if (!remoteEnabled()) return null;
  const b64 = await redis('GET', `${PREFIX}:doc:${id}`);
  return b64 ? Buffer.from(b64, 'base64') : null;
}
