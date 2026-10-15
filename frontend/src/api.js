// REST client. Authentication uses an HttpOnly session cookie set by the API; JavaScript never
// sees the session token. State-changing requests echo the CSRF token (from the readable
// vhc_csrf cookie) in the X-CSRF-Token header. All money values are integer paise.
const BASE = import.meta.env.VITE_API_URL || '/api';
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function csrfToken() {
  const m = document.cookie.match(/(?:^|;\s*)vhc_csrf=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error || `Request failed (${status})`);
    this.status = status;
    this.details = body?.details;
  }
  /** Field-level messages keyed by input name (from 422 responses). */
  get fields() {
    return this.details?.fields || {};
  }
  /** Non-field validation messages as a flat list. */
  get messages() {
    const d = this.details || {};
    const out = [...(d.errors || []), ...(d.problems || [])];
    for (const [i, errs] of Object.entries(d.memberErrors || {})) out.push(...errs.map((e) => `Member ${Number(i) + 1}: ${e}`));
    return out;
  }
}

async function request(method, path, body, { raw, quiet401 } = {}) {
  const headers = {};
  if (MUTATING.has(method)) headers['X-CSRF-Token'] = csrfToken();
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let res;
  // A 503 STORE_BUSY means the server applied nothing, so the same request is safe to repeat.
  for (let attempt = 0; ; attempt += 1) {
    try {
      res = await fetch(BASE + path, { method, headers, body: payload, credentials: 'include', cache: 'no-store' });
    } catch {
      throw new ApiError(0, { error: 'We could not reach the server. Check your connection and try again — it is safe to retry.' });
    }
    if (res.status !== 503 || attempt >= 3 || body instanceof FormData) break;
    await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
  }
  if (raw && res.ok) return res;
  const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : null;
  if (!res.ok) {
    if (res.status === 401 && !quiet401) window.dispatchEvent(new CustomEvent('vhc:unauthorized', { detail: data?.details?.code }));
    throw new ApiError(res.status, data);
  }
  return data;
}

export const api = {
  get: (p, opts) => request('GET', p, undefined, opts),
  post: (p, b = {}, opts) => request('POST', p, b, opts),
  put: (p, b) => request('PUT', p, b),
  patch: (p, b) => request('PATCH', p, b),
  delete: (p) => request('DELETE', p),
  upload: (p, form) => request('POST', p, form),
  async download(path, filename) {
    const res = await request('GET', path, undefined, { raw: true });
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: filename });
    a.click();
    URL.revokeObjectURL(url);
  },
};

export const idempotencyKey = () => crypto.randomUUID();
