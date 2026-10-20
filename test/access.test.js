import test from 'node:test';
import assert from 'node:assert/strict';
import { authenticate, bearerTokenFrom, hashToken, tokenKey } from '../src/auth.js';
import { approve, checkTrust } from '../src/approval.js';
import { handleApprove } from '../src/approve-route.js';
import { recordAudit } from '../src/audit.js';

function fakeKv() {
  const data = new Map();
  return {
    data,
    async get(key) { return data.get(key) ?? null; },
    async put(key, value) { data.set(key, value); },
    async delete(key) { data.delete(key); },
  };
}

function requestWith(authorization) {
  return new Request('https://mcp.example/mcp', {
    headers: authorization ? { Authorization: authorization } : {},
  });
}

// --- tokens ------------------------------------------------------------

test('hashToken is a stable 64-character hex digest', async () => {
  const hash = await hashToken('secret');
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(hash, await hashToken('secret'));
  assert.notEqual(hash, await hashToken('secret2'));
});

test('bearerTokenFrom reads the token and ignores other schemes', () => {
  assert.equal(bearerTokenFrom(requestWith('Bearer abc')), 'abc');
  assert.equal(bearerTokenFrom(requestWith('bearer  abc ')), 'abc');
  assert.equal(bearerTokenFrom(requestWith('Basic abc')), '');
  assert.equal(bearerTokenFrom(requestWith(undefined)), '');
});

test('authenticate returns the person for a registered token', async () => {
  const kv = fakeKv();
  await kv.put(tokenKey(await hashToken('good-token')), 'Ana');
  assert.equal(await authenticate(requestWith('Bearer good-token'), kv), 'Ana');
});

test('authenticate rejects unknown, missing and revoked tokens', async () => {
  const kv = fakeKv();
  const key = tokenKey(await hashToken('good-token'));
  await kv.put(key, 'Ana');
  assert.equal(await authenticate(requestWith('Bearer other'), kv), null);
  assert.equal(await authenticate(requestWith(undefined), kv), null);
  await kv.delete(key);
  assert.equal(await authenticate(requestWith('Bearer good-token'), kv), null);
});

test('the token itself is never stored, only its hash', async () => {
  const kv = fakeKv();
  await kv.put(tokenKey(await hashToken('plain-token')), 'Ana');
  assert.equal([...kv.data.keys()].some((key) => key.includes('plain-token')), false);
});

// --- first-use approval --------------------------------------------------

test('an unknown actor is blocked and given a one-time link', async () => {
  const kv = fakeKv();
  const gate = await checkTrust(kv, 'Ana', 'https://mcp.example');
  assert.equal(gate.blocked, true);
  const match = gate.message.match(/https:\/\/mcp\.example\/approve\?token=([a-f0-9]{48})/);
  assert.ok(match, 'message contains the approval link');
  assert.ok(kv.data.has(`pending:${match[1]}`));
  assert.equal(kv.data.has('trust:Ana'), false);
});

test('approving once trusts the actor, and the link cannot be reused', async () => {
  const kv = fakeKv();
  const gate = await checkTrust(kv, 'Ana', 'https://mcp.example');
  const token = gate.message.match(/token=([a-f0-9]{48})/)[1];

  assert.deepEqual(await approve(kv, token), { ok: true, actor: 'Ana' });
  assert.equal(await checkTrust(kv, 'Ana', 'https://mcp.example'), null);
  assert.deepEqual(await approve(kv, token), { ok: false });
});

test('approving with an unknown token does nothing', async () => {
  const kv = fakeKv();
  assert.deepEqual(await approve(kv, 'f'.repeat(48)), { ok: false });
  assert.equal(kv.data.size, 0);
});

test('GET on the approval link only shows a button and approves nothing', async () => {
  const kv = fakeKv();
  const gate = await checkTrust(kv, 'Ana', 'https://mcp.example');
  const token = gate.message.match(/token=([a-f0-9]{48})/)[1];

  const response = await handleApprove(new Request(`https://mcp.example/approve?token=${token}`), kv);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /<form method="post"/);
  assert.equal(kv.data.has('trust:Ana'), false);
});

test('POST approves; a malformed token is refused', async () => {
  const kv = fakeKv();
  const gate = await checkTrust(kv, 'Ana', 'https://mcp.example');
  const token = gate.message.match(/token=([a-f0-9]{48})/)[1];

  const post = (value) => handleApprove(new Request('https://mcp.example/approve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `token=${value}`,
  }), kv);

  assert.equal((await post('not-a-token')).status, 404);
  assert.equal((await post(token)).status, 200);
  assert.ok(kv.data.has('trust:Ana'));
  assert.equal((await post(token)).status, 404);
});

test('the approval route refuses other methods and bad GET tokens', async () => {
  const kv = fakeKv();
  assert.equal((await handleApprove(new Request('https://mcp.example/approve', { method: 'PUT' }), kv)).status, 405);
  assert.equal((await handleApprove(new Request('https://mcp.example/approve?token=zzz'), kv)).status, 404);
});

// --- audit ---------------------------------------------------------------

test('recordAudit stores actor, tool and a truncated detail with an expiry', async () => {
  const kv = fakeKv();
  let ttl;
  const store = { ...kv, async put(key, value, options) { ttl = options.expirationTtl; return kv.put(key, value); } };
  await recordAudit(store, { actor: 'Ana', tool: 'query', detail: 'x'.repeat(900) });
  const [[key, value]] = [...kv.data.entries()];
  assert.match(key, /^audit:/);
  assert.equal(JSON.parse(value).detail.length, 500);
  assert.equal(ttl, 30 * 24 * 60 * 60);
});

test('recordAudit never throws, even when the store is broken or missing', async () => {
  await recordAudit(undefined, { actor: 'Ana', tool: 'query', detail: '' });
  await recordAudit({ put: async () => { throw new Error('kv down'); } }, { actor: 'Ana', tool: 'query', detail: '' });
});

// --- retries ---------------------------------------------------------------

test('a retrying client gets the same link and creates no extra records', async () => {
  const kv = fakeKv();
  const first = await checkTrust(kv, 'Ana', 'https://mcp.example');
  const sizeAfterFirst = kv.data.size;
  const second = await checkTrust(kv, 'Ana', 'https://mcp.example');
  assert.equal(second.message, first.message);
  assert.equal(kv.data.size, sizeAfterFirst);
});

test('approving clears every pending record for that actor', async () => {
  const kv = fakeKv();
  const gate = await checkTrust(kv, 'Ana', 'https://mcp.example');
  const token = gate.message.match(/token=([a-f0-9]{48})/)[1];
  await approve(kv, token);
  assert.deepEqual([...kv.data.keys()], ['trust:Ana']);
});

test('after an expired link, a new one is issued', async () => {
  const kv = fakeKv();
  const first = await checkTrust(kv, 'Ana', 'https://mcp.example');
  const oldToken = first.message.match(/token=([a-f0-9]{48})/)[1];
  kv.data.delete(`pending:${oldToken}`); // simulates the 1-hour expiry
  const second = await checkTrust(kv, 'Ana', 'https://mcp.example');
  assert.notEqual(second.message, first.message);
});
