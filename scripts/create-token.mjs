// Creates a token for one person and prints the command that registers it.
//
//   node scripts/create-token.mjs "Ana Perez"
//
// The token is shown ONCE, for you to hand to that person. Only its hash is
// stored in KV, so it cannot be recovered later: lose it and you issue a new
// one. To revoke someone, delete their "token:<hash>" key.
import { hashToken, tokenKey } from '../src/auth.js';

const actor = process.argv.slice(2).join(' ').trim();
if (actor === '') {
  console.error('Usage: node scripts/create-token.mjs "<person or client name>"');
  process.exit(1);
}

const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
  byte.toString(16).padStart(2, '0')
).join('');
const key = tokenKey(await hashToken(token));

console.log(`Token for "${actor}" (shown once, give it to them):\n\n  ${token}\n`);
console.log('Register it (run from this folder, after creating the STATE namespace):\n');
console.log(`  npx wrangler kv key put --binding STATE "${key}" "${actor.replace(/"/g, '')}"\n`);
console.log('Revoke later with:\n');
console.log(`  npx wrangler kv key delete --binding STATE "${key}"`);
