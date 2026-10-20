import { approve } from './approval.js';

const TOKEN_PATTERN = /^[a-f0-9]{48}$/;

function page(message, status = 200) {
  return new Response(`<!doctype html><meta charset="utf-8"><title>Access approval</title><p>${message}</p>`, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

// GET shows a confirmation button; only POST approves.
//
// This split matters: chat apps, mail scanners and link previewers open links
// automatically with GET. If GET approved, merely pasting the link into a
// message could grant access without a human ever deciding to.
export async function handleApprove(request, kv) {
  const url = new URL(request.url);

  if (request.method === 'GET') {
    const token = url.searchParams.get('token') ?? '';
    if (!TOKEN_PATTERN.test(token)) return page('Invalid or expired approval link.', 404);
    return page(
      `<form method="post" action="/approve"><input type="hidden" name="token" value="${token}">` +
        '<button type="submit">Approve access</button></form>'
    );
  }

  if (request.method === 'POST') {
    const form = await request.formData().catch(() => null);
    const token = String(form?.get('token') ?? '');
    if (!TOKEN_PATTERN.test(token)) return page('Invalid or expired approval link.', 404);

    const result = await approve(kv, token);
    if (!result.ok) return page('Invalid, already-used or expired approval link.', 404);
    return page(`Access approved for "${result.actor.replace(/[<>&"]/g, '')}". You can close this page.`);
  }

  return new Response('Method not allowed', { status: 405 });
}
