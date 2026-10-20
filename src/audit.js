// A short-lived trail of who ran what, kept in KV so questions like "who
// queried this last week?" can be answered. Entries expire on their own.
//
// The query text is stored (truncated); results never are. Audit problems
// must never break a query, so every failure here is swallowed on purpose.
const AUDIT_TTL_SECONDS = 30 * 24 * 60 * 60;
const MAX_DETAIL_LENGTH = 500;

export async function recordAudit(kv, { actor, tool, detail }, { now = () => new Date() } = {}) {
  if (!kv) return;
  try {
    const stamp = now().toISOString();
    const suffix = crypto.randomUUID().slice(0, 8);
    await kv.put(
      `audit:${stamp}:${suffix}`,
      JSON.stringify({ actor, tool, detail: String(detail ?? '').slice(0, MAX_DETAIL_LENGTH) }),
      { expirationTtl: AUDIT_TTL_SECONDS }
    );
  } catch {
    // Intentionally ignored: auditing is best-effort.
  }
}
