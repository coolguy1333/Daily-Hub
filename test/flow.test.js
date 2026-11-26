'use strict';
// The whole connector flow, step by step the way Claude runs it.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const h = require('./helpers');

test('Claude connector flow: 401 -> discovery -> register -> authorize (PKCE) -> token -> initialize -> tools/list -> refresh', async () => {
  const ctx = await h.startApp();
  try {
    const mcpUrl = `${ctx.base}/mcp`;
    const accept = { accept: 'application/json, text/event-stream', 'content-type': 'application/json' };
    const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-ai', version: '0.1.0' } } };

    // 1. Unauthenticated POST /mcp
    const r401 = await fetch(mcpUrl, { method: 'POST', headers: accept, body: JSON.stringify(init) });
    assert.equal(r401.status, 401);
    const wa = r401.headers.get('www-authenticate');
    const prmUrl = wa.match(/resource_metadata="([^"]+)"/)[1];
    assert.equal(prmUrl, `${ctx.base}/.well-known/oauth-protected-resource`);

    // 2. Discovery
    const prm = await (await fetch(prmUrl)).json();
    assert.equal(prm.resource, mcpUrl);
    const asUrl = `${prm.authorization_servers[0]}/.well-known/oauth-authorization-server`;
    const as = await (await fetch(asUrl)).json();
    assert.equal(as.issuer, prm.authorization_servers[0]);

    // 3. Dynamic client registration
    const reg = await fetch(as.registration_endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Claude', redirect_uris: [h.CLAUDE_REDIRECT], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }),
    });
    assert.equal(reg.status, 201);
    const client = await reg.json();

    // 4. Authorize with PKCE (the person's browser, through Cloudflare Access)
    const verifier = crypto.randomBytes(48).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const state = crypto.randomBytes(16).toString('base64url');
    const authUrl = new URL(as.authorization_endpoint);
    for (const [k, v] of Object.entries({ response_type: 'code', client_id: client.client_id, redirect_uri: h.CLAUDE_REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state, scope: as.scopes_supported.join(' '), resource: prm.resource })) authUrl.searchParams.set(k, v);
    const page = await fetch(authUrl, { headers: h.accessHeaders(ctx) });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.ok(html.includes('Claude') && html.includes('claude.ai'));
    const form = { request: html.match(/name="request" value="([^"]+)"/)[1], csrf: html.match(/name="csrf" value="([^"]+)"/)[1], decision: 'approve' };
    const decided = await fetch(as.authorization_endpoint, { method: 'POST', redirect: 'manual', headers: { ...h.accessHeaders(ctx), 'content-type': 'application/x-www-form-urlencoded', origin: ctx.base }, body: new URLSearchParams(form) });
    assert.equal(decided.status, 302);
    const cb = new URL(decided.headers.get('location'));
    assert.equal(`${cb.origin}${cb.pathname}`, h.CLAUDE_REDIRECT);
    assert.equal(cb.searchParams.get('state'), state);

    // 5. Token
    const tok = await fetch(as.token_endpoint, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: cb.searchParams.get('code'), redirect_uri: h.CLAUDE_REDIRECT, client_id: client.client_id, code_verifier: verifier, resource: prm.resource }),
    });
    assert.equal(tok.status, 200);
    const tokens = await tok.json();
    assert.ok(tokens.access_token && tokens.refresh_token);
    assert.match(tokens.scope, /offline_access/);
    const auth = { authorization: `Bearer ${tokens.access_token}` };

    // 6. initialize: a JSON response (no SSE), unbuffered for Nginx, no session id (stateless)
    const ir = await fetch(mcpUrl, { method: 'POST', headers: { ...accept, ...auth }, body: JSON.stringify(init) });
    assert.equal(ir.status, 200);
    assert.match(ir.headers.get('content-type'), /application\/json/);
    assert.equal(ir.headers.get('x-accel-buffering'), 'no');
    assert.equal(ir.headers.get('mcp-session-id'), null);
    const initBody = await ir.json();
    assert.equal(initBody.result.serverInfo.name, 'daily-hub');
    assert.ok(initBody.result.capabilities.tools);
    const proto = initBody.result.protocolVersion;

    const note = await fetch(mcpUrl, { method: 'POST', headers: { ...accept, ...auth, 'mcp-protocol-version': proto }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
    assert.equal(note.status, 202);

    // 7. tools/list
    const lr = await fetch(mcpUrl, { method: 'POST', headers: { ...accept, ...auth, 'mcp-protocol-version': proto }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) });
    const tools = (await lr.json()).result.tools.map(t => t.name);
    assert.ok(tools.includes('publish') && tools.includes('get_state'));

    // The official SDK client works against the endpoint too.
    const sdk = new Client({ name: 'sdk-check', version: '1.0.0' });
    await sdk.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), { requestInit: { headers: auth } }));
    const listed = await sdk.listTools();
    assert.equal(listed.tools.length, 7);
    const res = await sdk.callTool({ name: 'get_state', arguments: {} });
    assert.equal(JSON.parse(res.content[0].text).counts.updates, 0);
    await sdk.close();

    // 8. Refresh
    ctx.clock.advance(61 * 60e3);
    assert.equal((await fetch(mcpUrl, { method: 'POST', headers: { ...accept, ...auth }, body: JSON.stringify(init) })).status, 401);
    const rr = await fetch(as.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id, resource: prm.resource }) });
    assert.equal(rr.status, 200);
    const fresh = await rr.json();
    assert.notEqual(fresh.refresh_token, tokens.refresh_token);
    const again = await fetch(mcpUrl, { method: 'POST', headers: { ...accept, authorization: `Bearer ${fresh.access_token}` }, body: JSON.stringify(init) });
    assert.equal(again.status, 200);
  } finally { await ctx.close(); }
});
