import { createMcpHandler } from 'agents/mcp/server';
import { handleApprove } from './approve-route.js';
import { authenticate } from './auth.js';
import { createD1Client } from './d1-client.js';
import { createServer } from './server.js';

function notConfigured() {
  // Deliberately vague: the reason (a missing binding) is for the operator's
  // logs, not for a caller.
  return new Response('Server is not configured', { status: 500 });
}

export default {
  async fetch(request, env, ctx) {
    if (!env.STATE) return notConfigured();
    const url = new URL(request.url);

    // Meant to sit behind an identity layer (e.g. Cloudflare Access); see
    // README "Known limits". It never executes queries.
    if (url.pathname === '/approve') return handleApprove(request, env.STATE);

    const actor = await authenticate(request, env.STATE);
    if (!actor) return new Response('Unauthorized', { status: 401 });

    let client;
    try {
      client = createD1Client({
        accountId: env.CF_ACCOUNT_ID,
        databaseId: env.CF_D1_DATABASE_ID,
        token: env.CF_D1_READ_TOKEN,
        // Only for local testing against a stand-in API; leave unset in production.
        ...(env.CF_API_BASE ? { apiBase: env.CF_API_BASE } : {}),
      });
    } catch (error) {
      console.error('readonly-d1-mcp misconfigured:', error.message);
      return notConfigured();
    }

    const handler = createMcpHandler(() =>
      createServer({
        client,
        actor,
        stateKv: env.STATE,
        origin: url.origin,
        audit: env.AUDIT_ENABLED === 'true',
      })
    );
    return handler(request, env, ctx);
  },
};
