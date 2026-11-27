'use strict';
// Cloudflare Access JWT verification on the page and page API.
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

let ctx;
test.before(async () => { ctx = await h.startApp(); });
test.after(() => ctx.close());

const get = (p, token) => fetch(ctx.base + p, { headers: token ? { 'cf-access-jwt-assertion': token } : {} });

test('valid token: page and page API load and show the email', async () => {
  const page = await get('/', ctx.jwt());
  assert.equal(page.status, 200);
  const r = await get('/api/dashboard', ctx.jwt());
  assert.equal(r.status, 200);
  assert.equal((await r.json()).user, h.EMAIL);
  const other = await get('/api/dashboard', ctx.jwt({ email: 'OTHER@example.com' }));
  assert.equal(other.status, 200, 'emails compare case-insensitively');
});

test('rejected tokens get a short plain 403', async () => {
  const now = Math.floor(ctx.clock.now() / 1000);
  const cases = {
    missing: undefined,
    garbage: 'not.a.jwt',
    'wrong aud': ctx.jwt({ aud: ['someone-else'] }),
    'wrong issuer': ctx.jwt({ iss: 'https://evil.cloudflareaccess.com' }),
    expired: ctx.jwt({ exp: now - 120 }),
    'not yet valid': ctx.jwt({ nbf: now + 600 }),
    'unknown email': ctx.jwt({ email: 'stranger@example.com' }),
    'no email (service token)': ctx.jwt({ email: undefined }),
    'other key': ctx.jwt({}, h.rsaKey('k1')),
    'alg none': (() => { const [, p] = ctx.jwt().split('.'); return `${Buffer.from('{"alg":"none","kid":"k1"}').toString('base64url')}.${p}.`; })(),
    'alg HS256': ctx.jwt({}, ctx.keys.list[0], { alg: 'HS256' }),
  };
  for (const [name, token] of Object.entries(cases)) {
    for (const p of ['/', '/api/dashboard', '/app.js', '/oauth/authorize']) {
      const r = await get(p, token);
      assert.equal(r.status, 403, `${name} ${p}`);
      assert.match(r.headers.get('content-type'), /text\/plain/);
      assert.ok((await r.text()).length < 120);
    }
  }
});

test('tampered payload fails the signature check', async () => {
  const [hd, , sig] = ctx.jwt().split('.');
  const p = Buffer.from(JSON.stringify({ aud: [h.AUD], email: h.EMAIL, iss: `https://${h.TEAM}`, exp: 9e9 })).toString('base64url');
  assert.equal((await get('/api/dashboard', `${hd}.${p}.${sig}`)).status, 403);
});

test('keys are cached, and an unknown kid triggers a refetch (key rotation)', async () => {
  const before = ctx.keys.fetches;
  await get('/api/dashboard', ctx.jwt());
  await get('/api/dashboard', ctx.jwt());
  assert.equal(ctx.keys.fetches, before, 'cached');

  const k2 = h.rsaKey('k2');
  ctx.keys.list.push(k2);
  ctx.clock.advance(11e3);
  assert.equal((await get('/api/dashboard', ctx.jwt({}, k2))).status, 200);
  assert.equal(ctx.keys.fetches, before + 1);

  // An unknown kid right after a fetch doesn't hammer the certs endpoint.
  await get('/api/dashboard', ctx.jwt({}, h.rsaKey('k3')));
  assert.equal(ctx.keys.fetches, before + 1);
});

test('public paths skip the Access check', async () => {
  const health = await get('/api/health');
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok', version: '1.0.0-test' });
  assert.equal((await get('/.well-known/oauth-protected-resource')).status, 200);
  assert.equal((await get('/.well-known/oauth-authorization-server')).status, 200);
  assert.equal((await fetch(`${ctx.base}/mcp`, { method: 'POST' })).status, 401, '/mcp uses its own OAuth check');
  const reg = await h.register(ctx);
  assert.equal(reg.status, 201);
  assert.equal((await h.token(ctx, { grant_type: 'refresh_token', client_id: reg.body.client_id, refresh_token: 'x' })).status, 400);
});

test('security headers: strict CSP, no framing', async () => {
  for (const p of ['/', '/api/health', '/api/dashboard']) {
    const r = await get(p, ctx.jwt());
    assert.match(r.headers.get('content-security-policy'), /default-src 'none'; script-src 'self'/);
    assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  }
  const html = await (await get('/', ctx.jwt())).text();
  assert.ok(!/<script>|\sstyle=|\son\w+=/i.test(html), 'no inline script, style or handlers');
  const js = await (await get('/app.js', ctx.jwt())).text();
  assert.ok(js.includes("href: '/cdn-cgi/access/logout'"), 'Sign out is on the Clients page');
});

test('stored text reaches the page only as JSON data, rendered with textContent', async () => {
  ctx.app.hub.publish({ news: [{ topic: '<img src=x onerror=alert(1)>', headline: '<script>alert(1)</script>', url: 'javascript:alert(1)' }] });
  const html = await (await get('/', ctx.jwt())).text();
  assert.ok(!html.includes('alert(1)'));
  const js = await (await get('/app.js', ctx.jwt())).text();
  assert.ok(!/\.innerHTML\s*=|insertAdjacentHTML|document\.write/.test(js));
  assert.ok(js.includes("x.protocol === 'https:'"), 'links only for https://');
});
