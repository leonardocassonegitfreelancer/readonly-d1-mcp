import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_SQL_LENGTH, capRows, checkReadOnlySql } from '../src/sql-guard.js';

const accepted = [
  'SELECT 1',
  'select * from web_traffic_daily;',
  '  SELECT page_path, SUM(sessions) FROM v_page_funnel_daily GROUP BY page_path ;; ',
  'WITH a AS (SELECT 1 AS x) SELECT * FROM a',
  "SELECT * FROM t WHERE note = 'please delete me and drop it'",
  "SELECT 'it''s fine; really' AS text",
  'SELECT update_time, created_at FROM t',
  'SELECT "update" FROM t',
  'SELECT replace(page_path, "/es", "") FROM t',
  'SELECT 1 -- drop table x',
  'SELECT 1 /* delete from t; */',
];

const rejected = [
  ['', 'empty'],
  ['   ', 'blank'],
  [null, 'not a string'],
  ['SELECT 1; DROP TABLE t', 'second statement'],
  ['SELECT 1; SELECT 2', 'two selects'],
  ['DELETE FROM t', 'delete'],
  ['INSERT INTO t VALUES (1)', 'insert'],
  ['UPDATE t SET a = 1', 'update'],
  ['DROP TABLE t', 'drop'],
  ['CREATE TABLE t (a)', 'create'],
  ['ALTER TABLE t ADD COLUMN b', 'alter'],
  ['PRAGMA table_info(t)', 'pragma'],
  ["ATTACH DATABASE 'x' AS y", 'attach'],
  ['/* hello */ DELETE FROM t', 'delete hidden behind a comment'],
  ['-- hi\nDELETE FROM t', 'delete after a line comment'],
  ['WITH x AS (SELECT 1) DELETE FROM t', 'data-modifying CTE'],
  ['SELECT load_extension("evil")', 'extension loading'],
  ["SELECT 'unterminated", 'unterminated string'],
  ['SELECT 1 /* never closed', 'unterminated comment'],
  ['SELECT 1) UNION SELECT 2 --', 'break out of the wrapper'],
  ['SELECT (1', 'unbalanced parenthesis'],
  ['EXPLAIN SELECT 1', 'not a SELECT'],
  ['VACUUM', 'vacuum'],
];

for (const sql of accepted) {
  test(`accepts: ${sql.trim().slice(0, 50)}`, () => {
    assert.equal(checkReadOnlySql(sql).ok, true);
  });
}

for (const [sql, label] of rejected) {
  test(`rejects (${label})`, () => {
    assert.equal(checkReadOnlySql(sql).ok, false);
  });
}

test('rejects a query over the length limit', () => {
  const long = `SELECT ${'1,'.repeat(MAX_SQL_LENGTH)} 1`;
  assert.equal(checkReadOnlySql(long).ok, false);
});

test('returns the query without trailing semicolons', () => {
  assert.equal(checkReadOnlySql('SELECT 1;;').sql, 'SELECT 1');
});

test('capRows wraps the query and asks for one extra row', () => {
  assert.equal(capRows('SELECT 1', 500), 'SELECT * FROM (\nSELECT 1\n) LIMIT 501');
});

test('capRows keeps a trailing line comment from swallowing the wrapper', () => {
  const wrapped = capRows('SELECT 1 -- note', 10);
  assert.match(wrapped, /-- note\n\) LIMIT 11$/);
});

test('capRows never allows a limit below one row', () => {
  assert.match(capRows('SELECT 1', 0), /LIMIT 2$/);
});
