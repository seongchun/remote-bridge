// Supabase REST client (no deps). Retry on transient network errors.

import https from 'node:https';

const RETRY_MAX = 5;
const RETRYABLE = ['EAI_AGAIN', 'ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED'];

export function makeClient({ supaUrl, supaKey }) {
  const host = new URL(supaUrl).host;

  async function req(method, urlPath, body, extraHeaders, retry = 0) {
    return new Promise((resolve, reject) => {
      const bodyStr = body ? JSON.stringify(body) : null;
      const headers = {
        apikey: supaKey,
        Authorization: 'Bearer ' + supaKey,
        'Content-Type': 'application/json',
      };
      if (extraHeaders) Object.assign(headers, extraHeaders);
      if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);
      const r = https.request(
        { hostname: host, path: '/rest/v1/' + urlPath, method, headers },
        (res) => {
          let raw = '';
          res.on('data', (c) => (raw += c));
          res.on('end', () => {
            const ok = res.statusCode >= 200 && res.statusCode < 300;
            let parsed = null;
            try {
              parsed = raw ? JSON.parse(raw) : null;
            } catch {
              parsed = raw;
            }
            if (ok) resolve(parsed);
            else reject(new Error('HTTP ' + res.statusCode + ': ' + JSON.stringify(parsed)));
          });
        }
      );
      r.on('error', async (e) => {
        if (RETRYABLE.includes(e.code) && retry < RETRY_MAX) {
          const delay = Math.min((retry + 1) * 3000, 30000);
          await new Promise((x) => setTimeout(x, delay));
          req(method, urlPath, body, extraHeaders, retry + 1).then(resolve, reject);
        } else reject(e);
      });
      if (bodyStr) r.write(bodyStr);
      r.end();
    });
  }

  return {
    select: (t, q) => req('GET', t + (q ? '?' + q : ''), null, null),
    insert: (t, o) => req('POST', t, o, { Prefer: 'return=minimal' }),
    update: (t, q, o) => req('PATCH', t + '?' + q, o, { Prefer: 'return=minimal' }),
    upsert: (t, o) =>
      req('POST', t + '?on_conflict=id', o, {
        Prefer: 'resolution=merge-duplicates,return=minimal',
      }),
    delete: (t, q) => req('DELETE', t + '?' + q, null, null),
  };
}
