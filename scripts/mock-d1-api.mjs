// A stand-in for Cloudflare's D1 REST endpoint, for trying the server
// locally without an account. It serves a small in-memory SQLite database and
// mimics the "read-only token" behaviour by refusing writes with the same
// shape of error the real API returns.
//
//   node scripts/mock-d1-api.mjs            (listens on http://127.0.0.1:8799)
//   npx wrangler dev --var CF_API_BASE:http://127.0.0.1:8799 \
//        --var CF_ACCOUNT_ID:local --var CF_D1_DATABASE_ID:local \
//        --var CF_D1_READ_TOKEN:local
//
// Not a faithful copy of D1: it exists to exercise this server end to end.
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';

const PORT = Number(process.env.PORT ?? 8799);
const db = new DatabaseSync(':memory:');
db.exec(`
  CREATE TABLE web_traffic_daily (
    date TEXT NOT NULL, page_path TEXT NOT NULL DEFAULT '', channel TEXT NOT NULL DEFAULT '',
    sessions REAL NOT NULL DEFAULT 0
  );
  CREATE VIEW v_page_funnel_daily AS
    SELECT date, page_path, SUM(sessions) AS sessions FROM web_traffic_daily GROUP BY date, page_path;
  INSERT INTO web_traffic_daily VALUES
    ('2026-09-01', '/pricing', 'Organic Search', 10),
    ('2026-09-01', '/pricing', 'Direct', 5),
    ('2026-09-02', '/blog', 'Organic Search', 80);
`);

const WRITE_PATTERN = /^\s*(insert|update|delete|drop|create|alter|replace|attach|pragma\s+\w+\s*=)/i;

function send(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

http.createServer((request, response) => {
  let raw = '';
  request.on('data', (chunk) => { raw += chunk; });
  request.on('end', () => {
    const { sql = '', params = [] } = JSON.parse(raw || '{}');
    if (WRITE_PATTERN.test(sql)) {
      return send(response, 403, {
        success: false,
        errors: [{ message: 'You do not have permission to perform this operation' }],
      });
    }
    try {
      const results = db.prepare(sql).all(...params).map((row) => ({ ...row }));
      return send(response, 200, { success: true, errors: [], result: [{ success: true, results }] });
    } catch (error) {
      return send(response, 400, { success: false, errors: [{ message: String(error.message) }] });
    }
  });
}).listen(PORT, '127.0.0.1', () => {
  console.error(`mock D1 API on http://127.0.0.1:${PORT}`);
});
