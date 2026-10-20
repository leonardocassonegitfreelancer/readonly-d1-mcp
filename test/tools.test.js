import test from 'node:test';
import assert from 'node:assert/strict';
import { createD1Client } from '../src/d1-client.js';
import { describeTable, listTables, runQuery } from '../src/tools.js';

// The tools run against real SQLite (the engine under D1) through a client
// with the same query(sql, params) shape as the REST client. Needs
// node:sqlite (Node 22.5+); skipped on older Node.
let DatabaseSync;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  DatabaseSync = undefined;
}
const skip = DatabaseSync ? false : 'node:sqlite is not available on this Node version';

function sqliteClient() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE web_traffic_daily (date TEXT NOT NULL, page_path TEXT NOT NULL DEFAULT '', sessions REAL NOT NULL DEFAULT 0);
    CREATE VIEW v_page_funnel_daily AS SELECT date, page_path, sessions FROM web_traffic_daily;
    CREATE TABLE _cf_KV (key TEXT);
  `);
  const insert = db.prepare('INSERT INTO web_traffic_daily VALUES (?, ?, ?)');
  for (let i = 1; i <= 12; i += 1) insert.run(`2026-09-${String(i).padStart(2, '0')}`, '/pricing', i);
  return { db, query: async (sql, params = []) => db.prepare(sql).all(...params).map((row) => ({ ...row })) };
}

test('listTables returns tables and views, hiding internal ones', { skip }, async () => {
  const names = (await listTables(sqliteClient())).map((table) => table.name);
  assert.deepEqual(names, ['v_page_funnel_daily', 'web_traffic_daily']);
});

test('describeTable returns columns and the dictionary notes', { skip }, async () => {
  const result = await describeTable(sqliteClient(), 'web_traffic_daily', {
    web_traffic_daily: ['note one'],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.columns.map((column) => column.name), ['date', 'page_path', 'sessions']);
  assert.deepEqual(result.notes, ['note one']);
});

test('describeTable refuses a name that is not a real table, including injection attempts', { skip }, async () => {
  const client = sqliteClient();
  for (const name of ['nope', 'web_traffic_daily; DROP TABLE x', '"', "x') --", undefined]) {
    assert.equal((await describeTable(client, name)).ok, false);
  }
});

test('runQuery returns rows for a valid SELECT', { skip }, async () => {
  const result = await runQuery(sqliteClient(), 'SELECT SUM(sessions) AS total FROM web_traffic_daily');
  assert.equal(result.ok, true);
  assert.deepEqual(result.rows, [{ total: 78 }]);
  assert.equal(result.truncated, false);
});

test('runQuery caps the rows and says so', { skip }, async () => {
  const result = await runQuery(sqliteClient(), 'SELECT * FROM web_traffic_daily ORDER BY date', { maxRows: 5 });
  assert.equal(result.ok, true);
  assert.equal(result.rowCount, 5);
  assert.equal(result.truncated, true);
  assert.equal(result.rows[0].date, '2026-09-01');
});

test('runQuery does not flag truncation when the result fits exactly', { skip }, async () => {
  const result = await runQuery(sqliteClient(), 'SELECT * FROM web_traffic_daily', { maxRows: 12 });
  assert.equal(result.rowCount, 12);
  assert.equal(result.truncated, false);
});

test('runQuery refuses writes without touching the database', { skip }, async () => {
  const client = sqliteClient();
  let calls = 0;
  const counting = { query: (...args) => { calls += 1; return client.query(...args); } };
  for (const sql of ['DELETE FROM web_traffic_daily', 'SELECT 1; DROP TABLE web_traffic_daily', 'PRAGMA table_info(x)']) {
    assert.equal((await runQuery(counting, sql)).ok, false);
  }
  assert.equal(calls, 0);
  assert.equal(client.db.prepare('SELECT COUNT(*) AS n FROM web_traffic_daily').get().n, 12);
});

test('a trailing comment cannot break out of the row cap', { skip }, async () => {
  const result = await runQuery(sqliteClient(), 'SELECT * FROM web_traffic_daily -- all of it', { maxRows: 3 });
  assert.equal(result.ok, true);
  assert.equal(result.rowCount, 3);
});

// --- REST client ---------------------------------------------------------

const config = { accountId: 'acc', databaseId: 'db', token: 'read-only-token' };

test('the REST client sends the read-only token and returns the rows', async () => {
  let seen;
  const client = createD1Client({
    ...config,
    fetchImpl: async (url, options) => {
      seen = { url, options };
      return { ok: true, status: 200, json: async () => ({ success: true, result: [{ results: [{ a: 1 }] }] }) };
    },
  });
  assert.deepEqual(await client.query('SELECT 1 AS a'), [{ a: 1 }]);
  assert.equal(seen.url, 'https://api.cloudflare.com/client/v4/accounts/acc/d1/database/db/query');
  assert.equal(seen.options.headers.Authorization, 'Bearer read-only-token');
  assert.deepEqual(JSON.parse(seen.options.body), { sql: 'SELECT 1 AS a', params: [] });
});

test('the REST client turns an API refusal into a short error', async () => {
  const client = createD1Client({
    ...config,
    fetchImpl: async () => ({
      ok: false, status: 403,
      json: async () => ({ success: false, errors: [{ message: 'You do not have permission to perform this operation' }] }),
    }),
  });
  await assert.rejects(client.query('DELETE FROM t'), /do not have permission/);
});

test('the REST client reports an unreadable response', async () => {
  const client = createD1Client({
    ...config,
    fetchImpl: async () => ({ ok: false, status: 502, json: async () => { throw new Error('html'); } }),
  });
  await assert.rejects(client.query('SELECT 1'), /502/);
});

test('the REST client refuses to start without its three settings', () => {
  assert.throws(() => createD1Client({ accountId: 'a', databaseId: 'b' }));
  assert.throws(() => createD1Client({}));
});
