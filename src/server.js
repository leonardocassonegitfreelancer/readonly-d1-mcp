import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { checkTrust } from './approval.js';
import { recordAudit } from './audit.js';
import { GENERAL_NOTES, TABLE_NOTES, toolDescription } from './dictionary.js';
import { DEFAULT_MAX_ROWS, describeTable, listTables, runQuery } from './tools.js';

function textResult(payload, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

// Builds one server for one authenticated person. Every tool goes through the
// same gate: first-use approval, then (optionally) an audit entry, then the work.
export function createServer({
  client,
  actor,
  stateKv,
  origin,
  generalNotes = GENERAL_NOTES,
  tableNotes = TABLE_NOTES,
  maxRows = DEFAULT_MAX_ROWS,
  audit = false,
}) {
  const server = new McpServer({ name: 'readonly-d1-mcp', version: '0.1.0' });

  async function guarded(tool, detail, work) {
    const gate = await checkTrust(stateKv, actor, origin);
    if (gate) return textResult({ error: true, message: gate.message });

    if (audit) await recordAudit(stateKv, { actor, tool, detail });
    try {
      const outcome = await work();
      return outcome?.ok === false
        ? textResult({ error: true, message: outcome.error }, true)
        : textResult(outcome);
    } catch (error) {
      return textResult({ error: true, message: String(error?.message ?? error).slice(0, 300) }, true);
    }
  }

  server.registerTool(
    'list_tables',
    { description: 'List the tables and views in the database. Start here.', inputSchema: {} },
    () => guarded('list_tables', '', () => listTables(client).then((tables) => ({ tables })))
  );

  server.registerTool(
    'describe_table',
    {
      description:
        'Columns of one table or view, plus notes about how its data really behaves. Read the notes before writing SQL. ' +
        toolDescription(generalNotes),
      inputSchema: { name: z.string().describe('Exact table or view name from list_tables') },
    },
    ({ name }) => guarded('describe_table', name, () => describeTable(client, name, tableNotes))
  );

  server.registerTool(
    'query',
    {
      description:
        `Run ONE read-only SELECT. Writes are impossible: the database credential is read-only, and non-SELECT SQL is refused before it is sent. Results are capped at ${maxRows} rows ("truncated": true says when more existed).`,
      inputSchema: { sql: z.string().describe('A single SELECT or WITH ... SELECT statement') },
    },
    ({ sql }) => guarded('query', sql, () => runQuery(client, sql, { maxRows }))
  );

  return server;
}
