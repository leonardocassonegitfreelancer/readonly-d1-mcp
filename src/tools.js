import { capRows, checkReadOnlySql } from './sql-guard.js';
import { notesFor } from './dictionary.js';

export const DEFAULT_MAX_ROWS = 500;

// `client` is anything with an async query(sql, params) returning row objects.
// Tools return plain data; turning it into an MCP response happens in
// server.js, which keeps these functions easy to test.

export async function listTables(client) {
  return client.query(
    `SELECT name, type FROM sqlite_master
     WHERE type IN ('table', 'view')
       AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
       AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'
     ORDER BY name`
  );
}

// The table name is checked against the real list first, so what reaches the
// pragma is never free text from the caller.
export async function describeTable(client, name, tableNotes) {
  const tables = await listTables(client);
  const match = tables.find((table) => table.name === name);
  if (!match) {
    return { ok: false, error: `Unknown table or view "${String(name).slice(0, 80)}". Call list_tables first.` };
  }

  const columns = await client.query(
    'SELECT name, type, "notnull" AS not_null, pk FROM pragma_table_info(?) ORDER BY cid',
    [match.name]
  );
  return { ok: true, name: match.name, type: match.type, columns, notes: notesFor(match.name, tableNotes) };
}

export async function runQuery(client, sql, { maxRows = DEFAULT_MAX_ROWS } = {}) {
  const checked = checkReadOnlySql(sql);
  if (!checked.ok) return { ok: false, error: checked.error };

  const rows = await client.query(capRows(checked.sql, maxRows));
  const truncated = rows.length > maxRows;
  return {
    ok: true,
    rowCount: Math.min(rows.length, maxRows),
    truncated,
    rows: truncated ? rows.slice(0, maxRows) : rows,
  };
}
