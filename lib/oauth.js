'use strict';
// OAuth 2.1 authorization server for the MCP endpoint (MCP authorization spec):
// protected resource + authorization server metadata, dynamic client registration,
// authorization code with PKCE (S256 only) and refresh token rotation.
// Tokens are random, signed with HUB_SECRET, and only their SHA-256 hashes are stored.
const crypto = require('crypto');

const ACCESS_TTL = 3600e3;
const REFRESH_TTL = 30 * 24 * 3600e3;
const CODE_TTL = 5 * 60e3;
const REQUEST_TTL = 10 * 60e3;
const MAX_CLIENTS = 50;
const SCOPE = 'hub';
const SCOPES = [SCOPE, 'offline_access'];
const DEFAULT_REDIRECTS = 'https://claude.ai/api/mcp/auth_callback,https://claude.com/api/mcp/auth_callback';

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const rand = (n = 32) => crypto.randomBytes(n).toString('base64url');
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

class OAuthError extends Error {
  constructor(status, error, description) { super(description || error); this.status = status; this.error = error; }
}

class OAuth {
  constructor({ store, publicUrl, secret, redirectAllowlist, allowLoopback = false, title = 'Daily hub', now = Date.now }) {
    this.store = store;
    this.base = publicUrl;
    this.resource = `${publicUrl}/mcp`;
    this.secret = secret;
    this.allowlist = new Set(String(redirectAllowlist || DEFAULT_REDIRECTS).split(',').map(s => s.trim()).filter(Boolean));
    this.allowLoopback = allowLoopback;
    this.title = title;
    this.now = now;
    this.codes = new Map();    // hash -> pending code (memory only: they live 5 minutes)
    this.usedCodes = new Map(); // hash -> { family, exp } to catch a replayed code
    this.requests = new Map(); // id -> authorization request awaiting Approve / Deny
    this.lastUsedSave = 0;
  }

  get db() { return this.store.oauth; }

  // ---------------------------------------------------------------- metadata

  protectedResource() {
    return {
      resource: this.resource,
      authorization_servers: [this.base],
      scopes_supported: [SCOPE],
      bearer_methods_supported: ['header'],
      resource_name: this.title,
    };
  }

  authServer() {
    return {
      issuer: this.base,
      authorization_endpoint: `${this.base}/oauth/authorize`,
      token_endpoint: `${this.base}/oauth/token`,
      registration_endpoint: `${this.base}/oauth/register`,
      scopes_supported: SCOPES,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
      authorization_response_iss_parameter_supported: true,
    };
  }

  wwwAuthenticate(error) {
    return `Bearer resource_metadata="${this.base}/.well-known/oauth-protected-resource"${error ? `, error="${error}"` : ''}`;
  }

  // ---------------------------------------------------------------- tokens

  sign(prefix) {
    const body = prefix + rand(32);
    return `${body}.${crypto.createHmac('sha256', this.secret).update(body).digest('base64url')}`;
  }

  signed(token, prefix) {
    if (typeof token !== 'string' || token.length > 200 || !token.startsWith(prefix)) return false;
    const i = token.lastIndexOf('.');
    if (i < 0) return false;
    const expect = crypto.createHmac('sha256', this.secret).update(token.slice(0, i)).digest('base64url');
    return safeEqual(token.slice(i + 1), expect);
  }

  issue(clientId, family, scope) {
    const now = this.now();
    const access = this.sign('dha_'), refresh = this.sign('dhr_');
    this.db.access[sha256(access)] = { client_id: clientId, family, scope, exp: now + ACCESS_TTL };
    this.db.refresh[sha256(refresh)] = { client_id: clientId, family, scope, exp: now + REFRESH_TTL, used: false, created: now };
    const c = this.db.clients[clientId];
    if (c) c.last_used_at = now;
    this.store.saveOauth();
    return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL / 1000, refresh_token: refresh, scope };
  }

  revokeFamily(family) {
    for (const t of ['access', 'refresh']) for (const [h, r] of Object.entries(this.db[t])) if (r.family === family) delete this.db[t][h];
    this.store.saveOauth();
  }

  // Bearer token for /mcp -> { client_id, scope, exp } or null.
  verifyAccess(token) {
    if (!this.signed(token, 'dha_')) return null;
    const r = this.db.access[sha256(token)];
    if (!r || r.exp <= this.now() || !this.db.clients[r.client_id]) return null;
    const c = this.db.clients[r.client_id];
    const now = this.now();
    c.last_used_at = now;
    if (now - this.lastUsedSave > 10 * 60e3) { this.lastUsedSave = now; this.store.saveOauth(); }
    return { client_id: r.client_id, scope: r.scope, exp: r.exp };
  }

  // ---------------------------------------------------------------- registration

  redirectAllowed(uri) {
    if (typeof uri !== 'string' || uri.length > 500) return false;
    if (this.allowlist.has(uri)) return true;
    if (!this.allowLoopback) return false;
    let u;
    try { u = new URL(uri); } catch { return false; }
    return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')
      && u.pathname === '/callback' && !u.search && !u.hash && !u.username && !u.password
      && uri === `http://${u.host}/callback`;
  }

  register(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new OAuthError(400, 'invalid_client_metadata', 'Expected a JSON object');
    const uris = body.redirect_uris;
    if (!Array.isArray(uris) || !uris.length || uris.length > 5) throw new OAuthError(400, 'invalid_redirect_uri', 'redirect_uris is required');
    for (const u of uris) if (!this.redirectAllowed(u)) throw new OAuthError(400, 'invalid_redirect_uri', 'Redirect URI not allowed');
    const grants = body.grant_types ?? ['authorization_code', 'refresh_token'];
    if (!Array.isArray(grants) || !grants.includes('authorization_code') || grants.some(g => !['authorization_code', 'refresh_token'].includes(g))) {
      throw new OAuthError(400, 'invalid_client_metadata', 'Unsupported grant_types');
    }
    const rtypes = body.response_types ?? ['code'];
    if (!Array.isArray(rtypes) || rtypes.some(t => t !== 'code')) throw new OAuthError(400, 'invalid_client_metadata', 'Unsupported response_types');
    const name = typeof body.client_name === 'string' ? body.client_name.replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, 100) : '';

    this.prune();
    const ids = Object.keys(this.db.clients);
    if (ids.length >= MAX_CLIENTS) {
      // Drop the oldest client that was never approved to make room.
      const idle = ids.filter(id => !this.hasTokens(id)).sort((a, b) => this.db.clients[a].created_at - this.db.clients[b].created_at);
      if (!idle.length) throw new OAuthError(400, 'invalid_client_metadata', 'Too many clients; revoke one first');
      delete this.db.clients[idle[0]];
    }
    const now = this.now();
    const client = { client_id: `dhc_${rand(16)}`, client_name: name || 'MCP client', redirect_uris: uris, created_at: now, approved_at: null, last_used_at: null };
    this.db.clients[client.client_id] = client;
    this.store.saveOauth();
    return {
      client_id: client.client_id,
      client_id_issued_at: Math.floor(now / 1000),
      client_name: client.client_name,
      redirect_uris: uris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }

  // ---------------------------------------------------------------- authorize

  grantedScope(requested) {
    const want = String(requested || '').split(/\s+/).filter(Boolean);
    return want.includes('offline_access') ? `${SCOPE} offline_access` : SCOPE;
  }

  resourceOk(r) {
    if (r == null || r === '') return true;
    return [this.resource, `${this.resource}/`, this.base, `${this.base}/`].includes(r);
  }

  // GET /oauth/authorize. Returns { page } (HTML for the person), { redirect } or { error } (shown, not redirected).
  authorizeStart(q, email) {
    const client = this.db.clients[q.client_id];
    if (!client) return { error: 'Unknown client. Remove the connector in Claude and add it again.' };
    const redirect = q.redirect_uri;
    if (!redirect || !client.redirect_uris.includes(redirect) || !this.redirectAllowed(redirect)) return { error: 'This redirect URI is not allowed.' };
    const back = (error, description) => ({ redirect: this.redirectUrl(redirect, { error, error_description: description, state: q.state }) });
    if (q.response_type !== 'code') return back('unsupported_response_type', 'Only response_type=code is supported');
    if (!q.code_challenge || q.code_challenge_method !== 'S256') return back('invalid_request', 'PKCE with code_challenge_method=S256 is required');
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(q.code_challenge)) return back('invalid_request', 'Invalid code_challenge');
    if (!this.resourceOk(q.resource)) return back('invalid_target', 'Unknown resource');
    if (q.state && String(q.state).length > 2000) return back('invalid_request', 'state is too long');

    this.pruneMemory();
    const id = rand(18);
    this.requests.set(id, {
      client_id: client.client_id, redirect_uri: redirect, code_challenge: q.code_challenge,
      scope: this.grantedScope(q.scope), state: q.state || '', email, exp: this.now() + REQUEST_TTL,
    });
    return { page: this.approvePage(client, redirect, email, id, this.csrf(id, email)), formTarget: new URL(redirect).origin };
  }

  csrf(id, email) { return crypto.createHmac('sha256', this.secret).update(`csrf:${id}:${email}`).digest('base64url'); }

  // POST /oauth/authorize (the Approve / Deny form).
  authorizeDecide(form, email) {
    const id = String(form.request || '');
    const r = this.requests.get(id);
    if (!r || r.exp <= this.now() || r.email !== email || !safeEqual(form.csrf || '', this.csrf(id, email))) {
      return { error: 'This approval request expired. Start connecting again from Claude.' };
    }
    this.requests.delete(id);
    if (form.decision !== 'approve') {
      return { redirect: this.redirectUrl(r.redirect_uri, { error: 'access_denied', error_description: 'The request was denied', state: r.state }) };
    }
    const client = this.db.clients[r.client_id];
    if (!client) return { error: 'Unknown client. Remove the connector in Claude and add it again.' };
    const code = rand(32);
    this.codes.set(sha256(code), { ...r, family: rand(12), exp: this.now() + CODE_TTL });
    client.approved_at = this.now();
    client.approved_by = email;
    this.store.saveOauth();
    return { redirect: this.redirectUrl(r.redirect_uri, { code, state: r.state }) };
  }

  redirectUrl(uri, params) {
    const u = new URL(uri);
    for (const [k, v] of Object.entries({ ...params, iss: this.base })) if (v) u.searchParams.set(k, v);
    return u.toString();
  }

  approvePage(client, redirect, email, id, csrf) {
    const host = new URL(redirect).host;
    const e = escapeHtml;
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect ${e(client.client_name)} – ${e(this.title)}</title>
<link rel="stylesheet" href="/style.css"><link rel="icon" href="/favicon.svg" type="image/svg+xml"></head>
<body class="consent"><main class="card consent-card">
<h1>Connect to ${e(this.title)}?</h1>
<p><strong>${e(client.client_name)}</strong> wants to read and publish to your hub.</p>
<dl class="kv">
<dt>Sends you back to</dt><dd><code>${e(host)}</code></dd>
<dt>Signed in as</dt><dd>${e(email)}</dd>
</dl>
<p class="muted">Only approve if you just started connecting from Claude. You can revoke it later under Connected clients.</p>
<form method="post" action="/oauth/authorize" class="actions">
<input type="hidden" name="request" value="${e(id)}"><input type="hidden" name="csrf" value="${e(csrf)}">
<button type="submit" name="decision" value="deny" class="btn">Deny</button>
<button type="submit" name="decision" value="approve" class="btn primary">Approve</button>
</form></main></body></html>`;
  }

  // ---------------------------------------------------------------- token endpoint

  token(form, basicClientId) {
    const clientId = form.client_id || basicClientId;
    const client = clientId && this.db.clients[clientId];
    if (!client) throw new OAuthError(401, 'invalid_client', 'Unknown client');
    if (form.grant_type === 'authorization_code') return this.exchangeCode(form, client);
    if (form.grant_type === 'refresh_token') return this.refresh(form, client);
    throw new OAuthError(400, 'unsupported_grant_type', 'Unsupported grant_type');
  }

  exchangeCode(form, client) {
    if (!form.code) throw new OAuthError(400, 'invalid_request', 'code is required');
    const h = sha256(String(form.code));
    const c = this.codes.get(h);
    if (!c) {
      const used = this.usedCodes.get(h);
      if (used) { this.usedCodes.delete(h); this.revokeFamily(used.family); } // a replayed code revokes what it issued
      throw new OAuthError(400, 'invalid_grant', 'Invalid or expired code');
    }
    this.codes.delete(h);
    this.usedCodes.set(h, { family: c.family, exp: c.exp });
    if (c.exp <= this.now()) throw new OAuthError(400, 'invalid_grant', 'Invalid or expired code');
    if (c.client_id !== client.client_id) throw new OAuthError(400, 'invalid_grant', 'Code was issued to another client');
    if (form.redirect_uri !== c.redirect_uri) throw new OAuthError(400, 'invalid_grant', 'redirect_uri does not match');
    const v = String(form.code_verifier || '');
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(v)) throw new OAuthError(400, 'invalid_grant', 'Invalid code_verifier');
    if (!safeEqual(crypto.createHash('sha256').update(v).digest('base64url'), c.code_challenge)) throw new OAuthError(400, 'invalid_grant', 'PKCE verification failed');
    if (!this.resourceOk(form.resource)) throw new OAuthError(400, 'invalid_target', 'Unknown resource');
    return this.issue(client.client_id, c.family, c.scope);
  }

  refresh(form, client) {
    const t = String(form.refresh_token || '');
    if (!this.signed(t, 'dhr_')) throw new OAuthError(400, 'invalid_grant', 'Invalid refresh token');
    const h = sha256(t);
    const r = this.db.refresh[h];
    if (!r) throw new OAuthError(400, 'invalid_grant', 'Invalid refresh token');
    if (r.client_id !== client.client_id) throw new OAuthError(400, 'invalid_grant', 'Invalid refresh token');
    if (r.used) { this.revokeFamily(r.family); throw new OAuthError(400, 'invalid_grant', 'Refresh token was already used'); }
    if (r.exp <= this.now()) { delete this.db.refresh[h]; this.store.saveOauth(); throw new OAuthError(400, 'invalid_grant', 'Refresh token expired'); }
    if (!this.resourceOk(form.resource)) throw new OAuthError(400, 'invalid_target', 'Unknown resource');
    r.used = true; // rotation: the old one stays only to detect reuse, until it would have expired
    // The access tokens issued alongside the old refresh token stop working.
    for (const [ah, a] of Object.entries(this.db.access)) if (a.family === r.family) delete this.db.access[ah];
    return this.issue(client.client_id, r.family, r.scope);
  }

  // ---------------------------------------------------------------- clients

  hasTokens(clientId) {
    const now = this.now();
    return Object.values(this.db.refresh).some(r => r.client_id === clientId && !r.used && r.exp > now)
      || Object.values(this.db.access).some(a => a.client_id === clientId && a.exp > now);
  }

  listClients() {
    return Object.values(this.db.clients).filter(c => this.hasTokens(c.client_id)).map(c => ({
      client_id: c.client_id,
      name: c.client_name,
      redirect_host: (() => { try { return new URL(c.redirect_uris[0]).host; } catch { return ''; } })(),
      approved_at: c.approved_at ? new Date(c.approved_at).toISOString() : null,
      last_used_at: c.last_used_at ? new Date(c.last_used_at).toISOString() : null,
    })).sort((a, b) => (a.approved_at < b.approved_at ? 1 : -1));
  }

  revokeClient(clientId) {
    if (!this.db.clients[clientId]) return false;
    delete this.db.clients[clientId];
    for (const t of ['access', 'refresh']) for (const [h, r] of Object.entries(this.db[t])) if (r.client_id === clientId) delete this.db[t][h];
    for (const [h, c] of this.codes) if (c.client_id === clientId) this.codes.delete(h);
    this.store.saveOauth();
    return true;
  }

  pruneMemory() {
    const now = this.now();
    for (const m of [this.codes, this.usedCodes, this.requests]) for (const [k, v] of m) if (v.exp <= now) m.delete(k);
  }

  // Expired tokens; clients never approved after a day; clients without tokens for 31 days.
  prune() {
    const now = this.now();
    this.pruneMemory();
    let changed = false;
    for (const t of ['access', 'refresh']) for (const [h, r] of Object.entries(this.db[t])) if (r.exp <= now) { delete this.db[t][h]; changed = true; }
    for (const [id, c] of Object.entries(this.db.clients)) {
      if (this.hasTokens(id)) continue;
      const last = Math.max(c.created_at || 0, c.approved_at || 0, c.last_used_at || 0);
      if ((!c.approved_at && now - c.created_at > 24 * 3600e3) || now - last > 31 * 24 * 3600e3) { delete this.db.clients[id]; changed = true; }
    }
    if (changed) this.store.saveOauth();
  }
}

module.exports = { OAuth, OAuthError, escapeHtml, DEFAULT_REDIRECTS, ACCESS_TTL, REFRESH_TTL };
