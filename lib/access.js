'use strict';
// Verifies the Cloudflare Access JWT (Cf-Access-Jwt-Assertion) with node:crypto only:
// RS256 signature against the team's published keys, aud, iss, exp, nbf and the allowed emails.
const crypto = require('crypto');

const LEEWAY_S = 30;
const REFETCH_MIN_MS = 10e3; // an unknown kid triggers at most one refetch per 10 s
const MAX_AGE_MS = 12 * 3600e3; // refresh the key set twice a day anyway

const b64json = s => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

class AccessError extends Error {}

class AccessVerifier {
  constructor({ teamDomain, aud, allowedEmails, fetch = globalThis.fetch, now = Date.now }) {
    this.team = String(teamDomain || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase();
    this.issuer = `https://${this.team}`;
    this.certsUrl = `${this.issuer}/cdn-cgi/access/certs`;
    this.aud = new Set(String(aud || '').split(',').map(s => s.trim()).filter(Boolean));
    this.allowed = new Set(String(allowedEmails || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
    this.fetch = fetch;
    this.now = now;
    this.keys = new Map();
    this.fetchedAt = 0;
    this.inflight = null;
  }

  async loadKeys() {
    if (!this.inflight) {
      this.inflight = (async () => {
        try {
          const r = await this.fetch(this.certsUrl, { signal: AbortSignal.timeout(5000), headers: { accept: 'application/json' } });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const body = await r.json();
          const keys = new Map();
          for (const jwk of Array.isArray(body.keys) ? body.keys : []) {
            if (jwk.kty !== 'RSA' || !jwk.kid) continue;
            try { keys.set(jwk.kid, crypto.createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' })); } catch { /* skip bad key */ }
          }
          this.keys = keys;
          this.fetchedAt = this.now();
        } catch (err) {
          console.error(`[access] Could not fetch Access certs: ${err.message}`);
          this.fetchedAt = this.now(); // don't hammer the endpoint while it's failing
        } finally {
          this.inflight = null;
        }
      })();
    }
    return this.inflight;
  }

  async keyFor(kid) {
    const age = this.now() - this.fetchedAt;
    if (age > MAX_AGE_MS || (!this.keys.has(kid) && age >= REFETCH_MIN_MS)) await this.loadKeys();
    return this.keys.get(kid);
  }

  // Returns { email } or throws AccessError with the reason (for logs, not for the visitor).
  async verify(token) {
    if (!this.team || !this.aud.size) throw new AccessError('Access is not configured');
    if (typeof token !== 'string' || token.length > 8192) throw new AccessError('missing token');
    const parts = token.split('.');
    if (parts.length !== 3) throw new AccessError('malformed token');
    let header, payload;
    try { header = b64json(parts[0]); payload = b64json(parts[1]); } catch { throw new AccessError('malformed token'); }
    if (header.alg !== 'RS256') throw new AccessError('unexpected alg');
    const key = await this.keyFor(String(header.kid || ''));
    if (!key) throw new AccessError('unknown kid');
    const ok = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'));
    if (!ok) throw new AccessError('bad signature');

    const now = Math.floor(this.now() / 1000);
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.some(a => this.aud.has(a))) throw new AccessError('wrong aud');
    if (payload.iss !== this.issuer) throw new AccessError('wrong iss');
    if (typeof payload.exp !== 'number' || payload.exp + LEEWAY_S < now) throw new AccessError('expired');
    if (typeof payload.nbf === 'number' && payload.nbf - LEEWAY_S > now) throw new AccessError('not yet valid');
    const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
    if (!email || !this.allowed.has(email)) throw new AccessError('email not allowed');
    return { email };
  }
}

module.exports = { AccessVerifier, AccessError };
