'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const h = require('./helpers');

let ctx;
test.beforeEach(async () => { ctx = await h.startApp(); });
test.afterEach(() => ctx.close());

const exchange = (clientId, code, verifier, extra = {}) => h.token(ctx, { grant_type: 'authorization_code', code, redirect_uri: h.CLAUDE_REDIRECT, client_id: clientId, code_verifier: verifier, ...extra });

test('metadata: protected resource and authorization server', async () => {
  for (const p of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
    const m = await (await fetch(ctx.base + p)).json();
    assert.equal(m.resource, `${ctx.base}/mcp`);
    assert.deepEqual(m.authorization_servers, [ctx.base]);
    assert.ok(m.scopes_supported.length);
  }
  const as = await (await fetch(`${ctx.base}/.well-known/oauth-authorization-server`)).json();
  assert.equal(as.issuer, ctx.base);
  assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
  assert.deepEqual(as.grant_types_supported, ['authorization_code', 'refresh_token']);
  assert.deepEqual(as.token_endpoint_auth_methods_supported, ['none']);
  assert.deepEqual(as.response_types_supported, ['code']);
  assert.ok(as.scopes_supported.includes('offline_access'));
  assert.equal(as.registration_endpoint, `${ctx.base}/oauth/register`);
});

test('register: allowed redirect URIs only, JSON only', async () => {
  const ok = await h.register(ctx);
  assert.equal(ok.status, 201);
  assert.match(ok.body.client_id, /^dhc_/);
  assert.equal(ok.body.token_endpoint_auth_method, 'none');
  assert.equal((await h.register(ctx, { redirect_uris: ['https://claude.com/api/mcp/auth_callback'] })).status, 201);

  const bad = await h.register(ctx, { redirect_uris: ['https://evil.example/callback'] });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'invalid_redirect_uri');
  assert.equal((await h.register(ctx, { redirect_uris: ['http://localhost:3333/callback'] })).status, 400, 'loopback is off by default');

  const form = await fetch(`${ctx.base}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'redirect_uris=x' });
  assert.equal(form.status, 400);
});

test('register: MCP_ALLOW_LOOPBACK accepts localhost and 127.0.0.1 callbacks on any port', async () => {
  await ctx.close();
  ctx = await h.startApp({ allowLoopback: true });
  for (const u of ['http://localhost:33418/callback', 'http://127.0.0.1:5000/callback', 'http://localhost/callback']) {
    assert.equal((await h.register(ctx, { redirect_uris: [u] })).status, 201, u);
  }
  for (const u of ['http://localhost:1/other', 'http://evil.example/callback', 'https://localhost/callback', 'http://localhost:1/callback?x=1']) {
    assert.equal((await h.register(ctx, { redirect_uris: [u] })).status, 400, u);
  }
});

test('authorize: approve page names the client and the redirect host', async () => {
  const reg = await h.register(ctx, { client_name: 'Claude <b>x</b>' });
  const { challenge } = h.pkce();
  const r = await fetch(h.authorizeUrl(ctx, reg.body.client_id, challenge), { headers: h.accessHeaders(ctx) });
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.ok(html.includes('Claude &lt;b&gt;x&lt;/b&gt;'), 'client name is escaped');
  assert.ok(html.includes('claude.ai'), 'redirect host is shown');
  assert.ok(html.includes(h.EMAIL));
  assert.match(r.headers.get('content-security-policy'), /form-action 'self' https:\/\/claude\.ai/);
});

test('authorize: requires Cloudflare Access', async () => {
  const reg = await h.register(ctx);
  const r = await fetch(h.authorizeUrl(ctx, reg.body.client_id, h.pkce().challenge));
  assert.equal(r.status, 403);
});

test('authorize: PKCE S256 is required', async () => {
  const reg = await h.register(ctx);
  for (const extra of [{ code_challenge: undefined }, { code_challenge_method: 'plain' }, { code_challenge_method: undefined }]) {
    const r = await fetch(h.authorizeUrl(ctx, reg.body.client_id, h.pkce().challenge, extra), { headers: h.accessHeaders(ctx), redirect: 'manual' });
    assert.equal(r.status, 302);
    const loc = new URL(r.headers.get('location'));
    assert.equal(loc.searchParams.get('error'), 'invalid_request');
    assert.equal(loc.searchParams.get('state'), 'st4te');
  }
});

test('authorize: a bad redirect URI or unknown client is shown, never redirected to', async () => {
  const reg = await h.register(ctx);
  const { challenge } = h.pkce();
  for (const url of [
    h.authorizeUrl(ctx, reg.body.client_id, challenge, { redirect_uri: 'https://evil.example/cb' }),
    h.authorizeUrl(ctx, reg.body.client_id, challenge, { redirect_uri: 'https://claude.com/api/mcp/auth_callback' }), // allowed, but not registered by this client
    h.authorizeUrl(ctx, 'dhc_unknown', challenge),
  ]) {
    const r = await fetch(url, { headers: h.accessHeaders(ctx), redirect: 'manual' });
    assert.equal(r.status, 400);
    assert.equal(r.headers.get('location'), null);
  }
});

test('authorize: deny redirects with access_denied', async () => {
  const reg = await h.register(ctx);
  const r = await h.approve(ctx, reg.body.client_id, h.pkce().challenge, 'deny');
  const loc = new URL(r.location);
  assert.equal(loc.searchParams.get('error'), 'access_denied');
  assert.equal(loc.searchParams.get('code'), null);
});

test('authorize: the decision needs the CSRF token and the same signed-in person', async () => {
  const reg = await h.register(ctx);
  const page = await (await fetch(h.authorizeUrl(ctx, reg.body.client_id, h.pkce().challenge), { headers: h.accessHeaders(ctx) })).text();
  const request = page.match(/name="request" value="([^"]+)"/)[1];
  const post = (headers, body) => fetch(`${ctx.base}/oauth/authorize`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(body) });
  let r = await post({ ...h.accessHeaders(ctx), origin: ctx.base }, { request, csrf: 'forged', decision: 'approve' });
  assert.equal(r.status, 400);
  r = await post({ 'cf-access-jwt-assertion': ctx.jwt({ email: 'other@example.com' }), origin: ctx.base }, { request, csrf: page.match(/name="csrf" value="([^"]+)"/)[1], decision: 'approve' });
  assert.equal(r.status, 400);
  r = await post({ ...h.accessHeaders(ctx), origin: 'https://evil.example' }, { request, csrf: 'x', decision: 'approve' });
  assert.equal(r.status, 403);
});

test('token: code exchange with PKCE; wrong verifier, reused and expired codes fail', async () => {
  const reg = await h.register(ctx);
  const id = reg.body.client_id;

  // Wrong verifier
  let p = h.pkce();
  let code = new URL((await h.approve(ctx, id, p.challenge)).location).searchParams.get('code');
  let t = await exchange(id, code, h.pkce().verifier);
  assert.deepEqual([t.status, t.body.error], [400, 'invalid_grant']);

  // Missing verifier
  p = h.pkce();
  code = new URL((await h.approve(ctx, id, p.challenge)).location).searchParams.get('code');
  t = await exchange(id, code, '');
  assert.deepEqual([t.status, t.body.error], [400, 'invalid_grant']);

  // Good exchange, then the same code again
  p = h.pkce();
  const loc = new URL((await h.approve(ctx, id, p.challenge)).location);
  assert.equal(loc.searchParams.get('iss'), ctx.base);
  assert.equal(loc.searchParams.get('state'), 'st4te');
  code = loc.searchParams.get('code');
  t = await exchange(id, code, p.verifier);
  assert.equal(t.status, 200);
  assert.equal(t.body.token_type, 'Bearer');
  assert.equal(t.body.expires_in, 3600);
  assert.match(t.body.access_token, /^dha_/);
  assert.match(t.body.refresh_token, /^dhr_/);
  assert.equal(t.headers.get('cache-control'), 'no-store');
  const again = await exchange(id, code, p.verifier);
  assert.equal(again.body.error, 'invalid_grant');
  assert.equal((await h.rpc(ctx, t.body.access_token, 'tools/list')).status, 401, 'a replayed code revokes its tokens');

  // Expired code (5 minutes)
  p = h.pkce();
  code = new URL((await h.approve(ctx, id, p.challenge)).location).searchParams.get('code');
  ctx.clock.advance(6 * 60e3);
  t = await exchange(id, code, p.verifier);
  assert.equal(t.body.error, 'invalid_grant');
});

test('token: unknown client gets 401 invalid_client; form encoding is required', async () => {
  let t = await h.token(ctx, { grant_type: 'refresh_token', refresh_token: 'x', client_id: 'dhc_gone' });
  assert.deepEqual([t.status, t.body.error], [401, 'invalid_client']);
  const reg = await h.register(ctx);
  t = await h.token(ctx, { grant_type: 'password', client_id: reg.body.client_id });
  assert.equal(t.body.error, 'unsupported_grant_type');
  const r = await fetch(`${ctx.base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ grant_type: 'refresh_token' }) });
  assert.equal(r.status, 400);
});

test('refresh: rotates on use; a reused refresh token fails and revokes the family', async () => {
  const c = await h.connect(ctx);
  const r1 = await h.token(ctx, { grant_type: 'refresh_token', refresh_token: c.refresh_token, client_id: c.clientId });
  assert.equal(r1.status, 200);
  assert.notEqual(r1.body.refresh_token, c.refresh_token);
  assert.notEqual(r1.body.access_token, c.access_token);
  assert.equal((await h.rpc(ctx, c.access_token, 'tools/list')).status, 401, 'old access token stops working');
  assert.equal((await h.rpc(ctx, r1.body.access_token, 'tools/list')).status, 200);

  const reuse = await h.token(ctx, { grant_type: 'refresh_token', refresh_token: c.refresh_token, client_id: c.clientId });
  assert.deepEqual([reuse.status, reuse.body.error], [400, 'invalid_grant']);
  assert.equal((await h.rpc(ctx, r1.body.access_token, 'tools/list')).status, 401, 'family revoked');
  const next = await h.token(ctx, { grant_type: 'refresh_token', refresh_token: r1.body.refresh_token, client_id: c.clientId });
  assert.equal(next.body.error, 'invalid_grant');

  const bad = await h.token(ctx, { grant_type: 'refresh_token', refresh_token: 'dhr_forged.sig', client_id: c.clientId });
  assert.equal(bad.body.error, 'invalid_grant');
});

test('expiry: access tokens last 1 hour, refresh tokens 30 days', async () => {
  const c = await h.connect(ctx);
  ctx.clock.advance(59 * 60e3);
  assert.equal((await h.rpc(ctx, c.access_token, 'tools/list')).status, 200);
  ctx.clock.advance(2 * 60e3);
  const r = await h.rpc(ctx, c.access_token, 'tools/list');
  assert.equal(r.status, 401);
  assert.match(r.headers.get('www-authenticate'), /error="invalid_token"/);

  const fresh = await h.token(ctx, { grant_type: 'refresh_token', refresh_token: c.refresh_token, client_id: c.clientId });
  assert.equal(fresh.status, 200);
  ctx.clock.advance(31 * 24 * 3600e3);
  const late = await h.token(ctx, { grant_type: 'refresh_token', refresh_token: fresh.body.refresh_token, client_id: c.clientId });
  assert.equal(late.body.error, 'invalid_grant');
});

test('revoked client: tokens stop working and refresh says invalid_client', async () => {
  const c = await h.connect(ctx);
  const list = await (await fetch(`${ctx.base}/api/dashboard`, { headers: h.accessHeaders(ctx) })).json();
  assert.deepEqual(list.clients.map(x => x.client_id), [c.clientId]);
  assert.equal(list.clients[0].redirect_host, 'claude.ai');

  const revoke = body => fetch(`${ctx.base}/api/clients/revoke`, { method: 'POST', headers: { ...h.accessHeaders(ctx), 'content-type': 'application/json', origin: ctx.base }, body: JSON.stringify(body) });
  // CSRF: another origin, or a form post, is refused.
  const csrf = await fetch(`${ctx.base}/api/clients/revoke`, { method: 'POST', headers: { ...h.accessHeaders(ctx), 'content-type': 'application/json', origin: 'https://evil.example' }, body: JSON.stringify({ client_id: c.clientId }) });
  assert.equal(csrf.status, 403);
  const form = await fetch(`${ctx.base}/api/clients/revoke`, { method: 'POST', headers: { ...h.accessHeaders(ctx), 'content-type': 'text/plain' }, body: JSON.stringify({ client_id: c.clientId }) });
  assert.equal(form.status, 403);

  assert.equal((await revoke({ client_id: c.clientId })).status, 200);
  assert.equal((await h.rpc(ctx, c.access_token, 'tools/list')).status, 401);
  const r = await h.token(ctx, { grant_type: 'refresh_token', refresh_token: c.refresh_token, client_id: c.clientId });
  assert.deepEqual([r.status, r.body.error], [401, 'invalid_client']);
});

test('only SHA-256 hashes of tokens are stored', async () => {
  const c = await h.connect(ctx);
  const raw = fs.readFileSync(path.join(ctx.dir, 'oauth.json'), 'utf8');
  assert.ok(!raw.includes(c.access_token) && !raw.includes(c.refresh_token));
  assert.ok(!raw.includes(c.access_token.split('.')[0]));
  const db = JSON.parse(raw);
  for (const k of [...Object.keys(db.access), ...Object.keys(db.refresh)]) assert.match(k, /^[0-9a-f]{64}$/);
});

test('tokens signed with another HUB_SECRET are rejected', async () => {
  const c = await h.connect(ctx);
  ctx.app.oauth.secret = 'a-different-secret'.padEnd(40, 'y');
  assert.equal((await h.rpc(ctx, c.access_token, 'tools/list')).status, 401);
});

test('discovery, registration and token endpoints answer fast', async () => {
  const t0 = performance.now();
  await fetch(`${ctx.base}/.well-known/oauth-protected-resource`);
  await fetch(`${ctx.base}/.well-known/oauth-authorization-server`);
  const reg = await h.register(ctx);
  await h.token(ctx, { grant_type: 'refresh_token', refresh_token: 'x', client_id: reg.body.client_id });
  assert.ok(performance.now() - t0 < 1000);
});
