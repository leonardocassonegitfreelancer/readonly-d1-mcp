// First-use approval gate.
//
// Even with read-only access, the owner may want a human to approve every new
// person (or AI client) once before its first query. The flow:
//   1. A person with a valid token makes a first call.
//   2. The call is BLOCKED and returns a one-time approval link instead.
//   3. A human opens the link and presses a button; only then is the person
//      trusted.
// Nothing the tools do can mark anyone approved: only a POST to the approval
// route can, and that route is meant to sit behind an identity layer such as
// Cloudflare Access (see README "Known limits").
//
// KV keys: "trust:<actor>", "pending:<one-time token>" and
// "pending-for:<actor>" (so a client that retries gets the SAME link instead
// of creating a new record, and a retry loop cannot flood the namespace with
// writes).
const PENDING_TTL_SECONDS = 3600;

function randomHex(bytes = 24) {
  const values = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(values, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function blockedMessage(actor, origin, token) {
  return {
    blocked: true,
    message:
      `First call from "${actor}": blocked until a human approves it. ` +
      `Open this link to grant access (valid for 1 hour, single use): ` +
      `${origin}/approve?token=${token}. Then repeat the same call.`,
  };
}

// Returns null when the actor is already trusted; otherwise a blocking
// message that contains the approval link.
export async function checkTrust(kv, actor, origin, { now = () => new Date() } = {}) {
  if (await kv.get(`trust:${actor}`)) return null;

  const existing = await kv.get(`pending-for:${actor}`);
  if (existing && (await kv.get(`pending:${existing}`))) {
    return blockedMessage(actor, origin, existing);
  }

  const token = randomHex();
  const options = { expirationTtl: PENDING_TTL_SECONDS };
  await kv.put(`pending:${token}`, JSON.stringify({ actor, requestedAt: now().toISOString() }), options);
  await kv.put(`pending-for:${actor}`, token, options);
  return blockedMessage(actor, origin, token);
}

// One-time: the pending records are deleted as soon as they are used.
export async function approve(kv, token, { now = () => new Date() } = {}) {
  const raw = token ? await kv.get(`pending:${token}`) : null;
  if (!raw) return { ok: false };

  const pending = JSON.parse(raw);
  await kv.put(`trust:${pending.actor}`, `approved ${now().toISOString()}`);
  await kv.delete(`pending:${token}`);
  await kv.delete(`pending-for:${pending.actor}`);
  return { ok: true, actor: pending.actor };
}
