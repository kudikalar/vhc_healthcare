// Spins up the API on an ephemeral port with an in-memory database and fresh seed data.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.DB_IN_MEMORY = '1';
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vhc-test-'));

const { createApp } = await import('../src/app.js');
const { resetAndSeed } = await import('../src/services/seed.js');

export const LAKH = 10000000; // paise
export const PASSWORD = 'VisionDemo#2026';

/** Builds a session handle from a response that set the session + CSRF cookies. */
export function sessionFrom(res) {
  const jar = {};
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    jar[pair.slice(0, i)] = decodeURIComponent(pair.slice(i + 1));
  }
  return { cookie: `vhc_sid=${jar.vhc_sid}`, csrf: jar.vhc_csrf };
}
export const R = (rupees) => rupees * 100;

export async function startServer() {
  resetAndSeed();
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;

  /** `token` is a session { cookie, csrf } returned by login()/sessionFrom(). */
  async function api(method, url, { token, body, form, headers: extra = {} } = {}) {
    const headers = { ...extra };
    if (token) {
      headers.Cookie = token.cookie;
      if (method !== 'GET') headers['x-csrf-token'] = token.csrf;
    }
    let payload;
    if (form) payload = form;
    else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(base + url, { method, headers, body: payload });
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : await res.arrayBuffer();
    return { status: res.status, body: data, headers: res.headers };
  }
  async function login(email, password = PASSWORD, extra = {}) {
    const r = await api('POST', '/auth/login', { body: { email, password, ...extra } });
    if (r.status !== 200) throw new Error(`login failed for ${email}: ${JSON.stringify(r.body)}`);
    return sessionFrom(r);
  }
  const tokens = {
    admin: await login('admin@vhc.test'), agent: await login('agent@vhc.test'), uw: await login('underwriter@vhc.test'),
    claims: await login('claims@vhc.test'), claims2: await login('claims2@vhc.test'),
    cust1: await login('customer@vhc.test'), cust2: await login('customer2@vhc.test'),
  };
  const setClock = (body) => api('POST', '/dev/clock', { token: tokens.admin, body });
  const close = () => new Promise((r) => server.close(r));
  return { api, login, tokens, setClock, close };
}

export const pdfBytes = () => Buffer.from('%PDF-1.4\n% test document\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
export function fileForm(fields, buf, name = 'doc.pdf') {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  f.append('file', new Blob([buf]), name);
  return f;
}

export function isoAddDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function yearsAgo(today, years, extraDays = 0) {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() - years);
  d.setUTCDate(d.getUTCDate() + extraDays);
  return d.toISOString().slice(0, 10);
}
