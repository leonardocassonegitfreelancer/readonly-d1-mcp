// Defence in depth, NOT the guarantee.
//
// The thing that makes writes impossible is the credential: the server talks
// to D1 with an API token scoped to "D1: Read" only, so Cloudflare itself
// rejects any INSERT, UPDATE or DELETE. This guard exists to (1) give a clear
// error before a request is even sent, and (2) add a second wall in case the
// token is ever scoped too broadly by mistake. Parsing SQL with a small
// scanner is deliberately conservative: it may refuse an odd but harmless
// query (it errs on the side of "no"), and it must never be the only
// protection.
//
// A query is accepted only if, after removing comments and the CONTENT of
// string literals and quoted identifiers:
//   - it is a single statement (no ";" except one trailing),
//   - parentheses are balanced (so it cannot break out of the row-cap wrapper),
//   - it starts with SELECT or WITH,
//   - it contains no write, schema, pragma or extension keyword.
export const MAX_SQL_LENGTH = 5000;

const FORBIDDEN_KEYWORDS = [
  'insert', 'update', 'delete', 'drop', 'alter', 'create', 'attach', 'detach',
  'pragma', 'vacuum', 'reindex', 'truncate', 'begin', 'commit', 'rollback',
  'savepoint', 'release', 'load_extension',
];
const FORBIDDEN_PATTERN = new RegExp(`\\b(?:${FORBIDDEN_KEYWORDS.join('|')})\\b`, 'i');

// Replaces comments and the inside of quoted text with nothing, so keywords
// that merely appear in a string ("please delete me") or a comment do not
// trigger the guard. Returns null when a quote or comment is never closed.
function maskQuotedAndComments(sql) {
  let masked = '';
  let i = 0;
  while (i < sql.length) {
    const char = sql[i];
    const next = sql[i + 1];

    if (char === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end + 1;
      masked += ' ';
    } else if (char === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      if (end === -1) return null;
      i = end + 2;
      masked += ' ';
    } else if (char === "'" || char === '"' || char === '`' || char === '[') {
      const close = char === '[' ? ']' : char;
      let j = i + 1;
      for (;;) {
        if (j >= sql.length) return null;
        if (sql[j] === close) {
          if (close !== ']' && sql[j + 1] === close) { j += 2; continue; } // doubled quote = escaped
          break;
        }
        j += 1;
      }
      i = j + 1;
      masked += ' _ ';
    } else {
      masked += char;
      i += 1;
    }
  }
  return masked;
}

function parenthesesBalanced(masked) {
  let depth = 0;
  for (const char of masked) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (depth < 0) return false;
  }
  return depth === 0;
}

export function checkReadOnlySql(sql) {
  if (typeof sql !== 'string' || sql.trim() === '') {
    return { ok: false, error: 'SQL must be a non-empty string' };
  }
  if (sql.length > MAX_SQL_LENGTH) {
    return { ok: false, error: `SQL is too long (max ${MAX_SQL_LENGTH} characters)` };
  }

  const masked = maskQuotedAndComments(sql);
  if (masked === null) {
    return { ok: false, error: 'unterminated string, identifier or comment' };
  }

  const body = masked.trim().replace(/;+\s*$/, '').trim();
  if (body.includes(';')) {
    return { ok: false, error: 'only a single statement is allowed' };
  }
  if (!parenthesesBalanced(body)) {
    return { ok: false, error: 'parentheses are not balanced' };
  }
  if (!/^(select|with)\b/i.test(body)) {
    return { ok: false, error: 'only SELECT queries are allowed' };
  }
  const forbidden = body.match(FORBIDDEN_PATTERN);
  if (forbidden) {
    return { ok: false, error: `"${forbidden[0].toLowerCase()}" is not allowed in a read-only query` };
  }

  return { ok: true, sql: sql.trim().replace(/;+\s*$/, '').trim() };
}

// Wraps the query so no more than maxRows + 1 rows come back (the extra row
// tells the caller the result was cut). This limits the SIZE OF THE RESPONSE,
// not the rows the database reads to produce it: a full-table aggregate still
// scans the table.
export function capRows(sql, maxRows) {
  const limit = Math.max(1, Math.floor(maxRows)) + 1;
  // The newline stops a trailing "-- comment" from swallowing the closing
  // parenthesis.
  return `SELECT * FROM (\n${sql}\n) LIMIT ${limit}`;
}
