# readonly-d1-mcp

A **read-only MCP server for a Cloudflare D1 database**, built so that giving an AI client (or a colleague) access to your data does not mean trusting it with your data.

[MCP](https://modelcontextprotocol.io) is a standard way for AI clients to call tools. This server exposes three: list the tables, describe one, run a `SELECT`. The interesting part is everything around them.

## Safety model

Three layers, and it matters which one is the guarantee.

| Layer | What it does | Is it the guarantee? |
|---|---|---|
| **A read-only credential** | The server talks to D1 over the REST API with a token that has *one* permission, `Account > D1 > Read`. A write is refused by Cloudflare itself, whatever SQL arrives. | **Yes.** |
| **A SQL guard** ([`src/sql-guard.js`](src/sql-guard.js)) | Accepts a single `SELECT` / `WITH … SELECT`; refuses writes, schema changes, `PRAGMA`, `ATTACH`, extra statements, unbalanced parentheses. Keywords inside strings and comments are ignored. | No. Defence in depth and clearer errors. It errs on the side of refusing, and a SQL scanner must never be the only wall. |
| **People, not shared keys** | One token per person or client, stored as a **hash**; first call from anyone new is **blocked until a human approves it**; optional audit trail. | Access control, not data protection. |

Why REST instead of a Workers D1 *binding*? A binding always has full access, so it cannot give the credential-level guarantee. That is the one deliberate cost of this design.

## What a client sees

| Tool | Does |
|---|---|
| `list_tables` | Tables and views (internal ones hidden). |
| `describe_table` | Columns, plus **notes about how the data really behaves** from [`src/dictionary.js`](src/dictionary.js). |
| `query` | One read-only `SELECT`, capped at 500 rows with a `"truncated"` flag. |

### The data dictionary is the part that earns its keep

A model that sees only column names writes plausible SQL that returns a wrong answer. The dictionary carries the facts a column name hides: "empty text is stored as `''`, never `NULL`", "this table has no personal data, so finding nothing proves nothing", "never join these raw tables yourself, use the view". The notes in the repository describe the tables of the companion project [zero-cost-marketing-data-hub](https://github.com/leonardocassonegitfreelancer/zero-cost-marketing-data-hub); replace them with the traps of your own data. A note is worth adding the moment a wrong number was nearly shipped because of something the schema did not say.

## First-use approval

1. A person with a valid token calls a tool for the first time.
2. The call is **blocked** and returns a one-time link (valid one hour). A retry returns the same link, not a new one.
3. A human opens it. **`GET` only shows a button; only `POST` approves.** Chat apps, mail scanners and link previewers open links automatically, so if `GET` approved, pasting the link into a message could grant access with nobody deciding.
4. Only then does the person's first call go through. The link is single use.

## Set up

Needs Node 20+, a Cloudflare account and a D1 database.

```
npm install
cp wrangler.toml.example wrangler.toml      # fill in your own ids; never commit it
npx wrangler kv namespace create STATE      # paste the id into wrangler.toml
npx wrangler secret put CF_D1_READ_TOKEN    # a token with ONLY  Account > D1 > Read
npx wrangler deploy
npm run token -- "Ana Perez"                # prints a token once + the command to register it
```

**Check the guarantee yourself, once.** Send a write with your read token to the D1 REST endpoint and confirm Cloudflare refuses it. This repository's tests prove the guard and the flow; they cannot prove how your token is scoped.

Revoke a person: delete their `token:<hash>` key (the script prints the command). Nobody else is affected and nothing is redeployed.

### Calling it

The server speaks MCP over HTTP at `/mcp` and expects `Authorization: Bearer <token>`. How you register a remote server differs between MCP clients, so follow your client's documentation for custom headers. A raw check:

```
curl -X POST https://<your-worker>/mcp \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Try it without an account

```
node scripts/mock-d1-api.mjs      # a stand-in D1 REST endpoint with demo data (needs Node 22.5+)
npx wrangler dev --var CF_API_BASE:http://127.0.0.1:8799 --var CF_D1_READ_TOKEN:local
```

The mock refuses writes the way a read-only token would. It exists to exercise this server end to end, not to imitate D1.

## What was tested, and what was not

- **67 unit tests** (`npm test`): the SQL guard (accepted and rejected queries, including comment tricks, a second statement, a data-modifying CTE and breaking out of the row cap), token hashing and revocation, the approval flow (single use, retries, `GET` does not approve), the REST client, and the tools against real SQLite.
- **An end-to-end run on a local `wrangler dev`** against the mock: no token and a wrong token are refused, the first call is blocked with a link, opening the link does not approve, `POST` approves, the three tools work, writes and a second statement are refused, the link cannot be reused.
- **Checked against live D1 (2026-10-20):** the SQL behind `list_tables`, the `pragma_table_info` query behind `describe_table`, and the row-cap wrapper with a trailing comment all ran correctly through the real D1 REST API (sent through an existing read-only D1 connection, schema metadata only, no table data).
- **Not tested:** a deployment of this Worker on Cloudflare, the bound-parameter (`params`) path of the REST call against live D1, and a real MCP client.
- **Not measured:** CPU time per request on the Workers Free plan (10 ms). An MCP server object is built on every request; test under your own load.

## Known limits

- **The approval route has no identity check of its own.** Anyone holding the link can approve, so put `/approve` behind an identity layer such as Cloudflare Access, and remember the Worker is also reachable on its `workers.dev` address unless you disable it.
- **The row cap limits the size of the response, not the rows the database reads.** A full-table aggregate still scans the table.
- **Workers KV free plan: 1,000 writes per day** (checked 2026-10-20). Tokens and trust are read-mostly, but each new approval writes, and audit writes once per call. Audit is therefore **off by default** (`AUDIT_ENABLED`).
- **A token is a bearer secret.** Hashing it in KV protects against a leaked namespace, not against a leaked token. There is no per-person rate limit.
- **Read access is still access.** Decide what the database holds before exposing it; this server cannot hide a column you stored.

## Layout

```
src/sql-guard.js     single-SELECT check + row cap
src/auth.js          hashed per-person bearer tokens
src/approval.js      first-use approval (single use, retry-safe)
src/approve-route.js GET shows a button, POST approves
src/d1-client.js     D1 REST client (read-only token)
src/tools.js         list_tables, describe_table, query
src/dictionary.js    notes the model reads before writing SQL
src/audit.js         optional, best-effort trail
src/server.js        MCP tool registration + the common gate
src/worker.js        routing: /approve, auth, /mcp
scripts/             create-token.mjs, mock-d1-api.mjs
test/                node:test suite
```

## License

MIT
