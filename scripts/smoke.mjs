#!/usr/bin/env node
// Black-box check of an OpenVoid example server. Exercises void/db, void/kv and void/storage
// through HTTP and exits non-zero on the first failure.
//   node scripts/smoke.mjs http://127.0.0.1:3000
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const base = (process.argv[2] ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const run = randomUUID().slice(0, 8);

async function call(method, path, body, headers = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.body = typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body);
    if (!headers['content-type']) init.headers['content-type'] = 'application/json';
  }
  const res = await fetch(base + path, init);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, headers: res.headers, text, json };
}

const checks = [
  ['health + void/env', async () => {
    const r = await call('GET', '/api/health');
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.app, process.env.EXPECT_APP_NAME ?? 'OpenVoid notes', 'void/env value');
  }],
  ['anonymous request to a signed-in route', async () => {
    const r = await call('GET', '/api/me');
    assert.equal(r.status, 401, r.text);
  }],
  ['void/db insert + select', async () => {
    const created = await call('POST', '/api/notes', { title: `note ${run}` });
    assert.equal(created.status, 201, created.text);
    assert.equal(created.json.title, `note ${run}`);
    const list = await call('GET', '/api/notes');
    assert.equal(list.status, 200, list.text);
    assert.ok(list.json.some((n) => n.id === created.json.id && n.title === `note ${run}`));
  }],
  ['void/db validation path', async () => {
    const bad = await call('POST', '/api/notes', {});
    assert.equal(bad.status, 400, bad.text);
  }],
  ['void/kv put + get json', async () => {
    const put = await call('PUT', `/api/kv/k-${run}`, { value: { city: 'Ames', n: 1 } });
    assert.equal(put.status, 200, put.text);
    const got = await call('GET', `/api/kv/k-${run}`);
    assert.deepEqual(got.json, { value: { city: 'Ames', n: 1 } });
  }],
  ['void/kv missing key', async () => {
    const got = await call('GET', `/api/kv/missing-${run}`);
    assert.equal(got.status, 404, got.text);
  }],
  ['void/storage put + get with metadata', async () => {
    const put = await call('PUT', `/api/files/f-${run}.txt`, 'great scott', { 'content-type': 'text/plain' });
    assert.equal(put.status, 201, put.text);
    assert.equal(put.json.size, 11);
    const got = await call('GET', `/api/files/f-${run}.txt`);
    assert.equal(got.status, 200);
    assert.equal(got.text, 'great scott');
    assert.equal(got.headers.get('content-type'), 'text/plain');
    assert.equal(got.headers.get('etag'), `"${put.json.etag}"`);
  }],
  ['void/storage binary round trip', async () => {
    const bytes = new Uint8Array(256).map((_, i) => i);
    const put = await call('PUT', `/api/files/b-${run}.bin`, bytes, { 'content-type': 'application/octet-stream' });
    assert.equal(put.status, 201, put.text);
    const res = await fetch(`${base}/api/files/b-${run}.bin`);
    assert.deepEqual(new Uint8Array(await res.arrayBuffer()), bytes);
  }],
];

let failed = 0;
for (const [name, fn] of checks) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL  ${name}\n      ${String(error.message).split('\n').join('\n      ')}`);
  }
}
console.log(`\n${checks.length - failed}/${checks.length} passed against ${base}`);
process.exit(failed === 0 ? 0 : 1);
