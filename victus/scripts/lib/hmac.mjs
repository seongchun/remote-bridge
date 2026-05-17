// HMAC-SHA256 payload signing. Cloud signs, relay verifies.
// Without the shared secret, an attacker with only the public anon key cannot inject
// arbitrary commands.

import { createHmac, randomBytes } from 'node:crypto';

const VERSION = 1;
const DEFAULT_MAX_AGE_MS = 10 * 60 * 1000;

function canonical(obj) {
  // Only fields involved in routing/execution are signed.
  return JSON.stringify({
    action: obj.action,
    task: obj.task ?? null,
    session: obj.session ?? null,
    session_id: obj.session_id ?? null,
    fresh: obj.fresh ?? false,
    ts: obj.ts,
    nonce: obj.nonce,
  });
}

export function signPayload(obj, secret) {
  return createHmac('sha256', secret).update(canonical(obj)).digest('hex');
}

export function buildPayload(fields, secret) {
  const payload = {
    action: fields.action,
    task: fields.task ?? null,
    session: fields.session ?? 'default',
    session_id: fields.session_id ?? null,
    fresh: fields.fresh ?? false,
    ts: Date.now(),
    nonce: randomBytes(8).toString('hex'),
  };
  payload.sig = signPayload(payload, secret);
  payload.v = VERSION;
  return payload;
}

export function verifyPayload(payload, secret, maxAgeMs = DEFAULT_MAX_AGE_MS) {
  if (!payload || typeof payload !== 'object') return { ok: false, reason: 'no_payload' };
  if (payload.v !== VERSION) return { ok: false, reason: 'bad_version' };
  if (typeof payload.action !== 'string') return { ok: false, reason: 'no_action' };
  if (typeof payload.ts !== 'number') return { ok: false, reason: 'bad_ts' };
  if (Math.abs(Date.now() - payload.ts) > maxAgeMs) return { ok: false, reason: 'expired' };
  if (typeof payload.sig !== 'string') return { ok: false, reason: 'no_sig' };
  const expected = signPayload(payload, secret);
  if (payload.sig.length !== expected.length) return { ok: false, reason: 'bad_sig' };
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= payload.sig.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0 ? { ok: true } : { ok: false, reason: 'bad_sig' };
}
