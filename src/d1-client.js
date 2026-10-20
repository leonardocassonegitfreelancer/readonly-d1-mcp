// Talks to D1 through Cloudflare's REST API using a token scoped to
// "D1: Read" only. That scope, not any code in this repository, is what
// guarantees nothing can be written: a write sent with this token is refused
// by Cloudflare before it reaches the database.
//
// (A Workers D1 *binding* would be simpler, but a binding always has full
// access, so it cannot give that guarantee. That is why this goes over REST.)
export function createD1Client({ accountId, databaseId, token, fetchImpl = fetch, apiBase = 'https://api.cloudflare.com/client/v4' }) {
  if (!accountId || !databaseId || !token) {
    throw new Error('D1 client needs accountId, databaseId and a read-only token');
  }
  const url =
    `${apiBase}/accounts/${encodeURIComponent(accountId)}` +
    `/d1/database/${encodeURIComponent(databaseId)}/query`;

  return {
    async query(sql, params = []) {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ sql, params }),
      });

      let body;
      try {
        body = await response.json();
      } catch {
        throw new Error(`D1 responded ${response.status} with an unreadable body`);
      }

      if (!response.ok || body?.success !== true) {
        const message = body?.errors?.[0]?.message ?? `D1 responded ${response.status}`;
        throw new Error(String(message).slice(0, 300));
      }
      return body.result?.[0]?.results ?? [];
    },
  };
}
