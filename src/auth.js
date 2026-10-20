// Per-person bearer tokens, stored as SHA-256 hashes.
//
// The KV key is "token:<sha256 of the token>" and the value is the person's
// name. Storing only the hash means reading the namespace does not reveal
// usable tokens. Adding or revoking someone is one KV put or delete; nobody
// else is affected and nothing is redeployed.
const encoder = new TextEncoder();

export async function hashToken(token) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(String(token)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function tokenKey(hash) {
  return `token:${hash}`;
}

export function bearerTokenFrom(request) {
  const header = request.headers.get('Authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : '';
}

// Returns the person's name, or null when the token is missing or unknown.
export async function authenticate(request, kv) {
  const token = bearerTokenFrom(request);
  if (token === '') return null;
  const actor = await kv.get(tokenKey(await hashToken(token)));
  return actor || null;
}
