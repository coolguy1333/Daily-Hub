'use strict';
// Shared test setup: an app on a random port with a fake clock, a fake Cloudflare Access key set,
// and helpers for the OAuth flow and MCP calls.
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { createApp } = require('../lib/app');

const TEAM = 'myteam.cloudflareaccess.com';
const AUD = 'aud-tag-123';
const EMAIL = 'me@example.com';
const SECRET = 'test-secret-'.padEnd(48, 'x');
const CLAUDE_REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

function rsaKey(kid) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { kid, privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' } };
}

const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
function signJwt(payload, key, header = {}) {
  const h = b64({ alg: 'RS256', kid: key.kid, typ: 'JWT', ...header });
  const p = b64(payload);
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`), key.privateKey).toString('base64url');
  return `${h}.${p}.${sig}`;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function startApp(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-hub-test-'));
  let t = opts.start || Date.parse('2026-11-26T12:00:00Z');
  const clock = { now: () => t, advance: ms => { t += ms; }, set: v => { t = v; } };
  const keys = { list: [rsaKey('k1')], fetches: 0 };
  const unexpected = [];
  const fakeFetch = async (url, init) => {
    if (url === `https://${TEAM}/cdn-cgi/access/certs`) {
      keys.fetches++;
      return new Response(JSON.stringify({ keys: keys.list.map(k => k.jwk) }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    unexpected.push(String(url));
    throw new Error(`unexpected fetch ${url}`);
  };
  const logs = [];
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const app = createApp({
    version: '1.0.0-test', dataDir: dir, publicUrl: base, title: 'Daily hub',
    teamDomain: TEAM, aud: AUD, allowedEmails: `${EMAIL}, Other@Example.com`, secret: SECRET,
    redirectAllowlist: opts.redirectAllowlist, allowLoopback: opts.allowLoopback || false,
    mcpRateLimit: opts.mcpRateLimit,
  }, { now: clock.now, fetch: fakeFetch, log: m => logs.push(m) });
  await new Promise(r => app.server.listen(port, '127.0.0.1', r));

  const jwt = (claims = {}, key = keys.list[0], header) => signJwt({
    aud: [AUD], email: EMAIL, iss: `https://${TEAM}`, iat: Math.floor(t / 1000), nbf: Math.floor(t / 1000) - 5,
    exp: Math.floor(t / 1000) + 3600, sub: 'user-1', type: 'app', ...claims,
  }, key, header);

  const ctx = {
    app, base, dir, clock, keys, logs, jwt, rsaKey, unexpected,
    async close() { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
  return ctx;
}

// ---------------------------------------------------------------- OAuth helpers

const pkce = () => {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
};

async function register(ctx, body = {}) {
  const r = await fetch(`${ctx.base}/oauth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Claude', redirect_uris: [CLAUDE_REDIRECT], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', ...body }),
  });
  return { status: r.status, body: await r.json() };
}

function authorizeUrl(ctx, clientId, challenge, extra = {}) {
  const u = new URL(`${ctx.base}/oauth/authorize`);
  const params = { response_type: 'code', client_id: clientId, redirect_uri: CLAUDE_REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 'st4te', scope: 'hub offline_access', resource: `${ctx.base}/mcp`, ...extra };
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  return u.toString();
}

const accessHeaders = ctx => ({ 'cf-access-jwt-assertion': ctx.jwt() });

// GET the Approve page, then POST the decision. Returns the redirect URL.
async function approve(ctx, clientId, challenge, decision = 'approve', extra = {}) {
  const page = await fetch(authorizeUrl(ctx, clientId, challenge, extra), { headers: accessHeaders(ctx), redirect: 'manual' });
  if (page.status !== 200) return { page };
  const html = await page.text();
  const request = html.match(/name="request" value="([^"]+)"/)[1];
  const csrf = html.match(/name="csrf" value="([^"]+)"/)[1];
  const r = await fetch(`${ctx.base}/oauth/authorize`, {
    method: 'POST', redirect: 'manual',
    headers: { ...accessHeaders(ctx), 'content-type': 'application/x-www-form-urlencoded', origin: ctx.base },
    body: new URLSearchParams({ request, csrf, decision }),
  });
  return { page, html, status: r.status, location: r.headers.get('location') };
}

async function token(ctx, form) {
  const r = await fetch(`${ctx.base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form) });
  return { status: r.status, body: await r.json(), headers: r.headers };
}

// Register, approve and exchange the code: returns { clientId, access_token, refresh_token }.
async function connect(ctx) {
  const reg = await register(ctx);
  const { verifier, challenge } = pkce();
  const { location } = await approve(ctx, reg.body.client_id, challenge);
  const code = new URL(location).searchParams.get('code');
  const t = await token(ctx, { grant_type: 'authorization_code', code, redirect_uri: CLAUDE_REDIRECT, client_id: reg.body.client_id, code_verifier: verifier, resource: `${ctx.base}/mcp` });
  return { clientId: reg.body.client_id, ...t.body };
}

// ---------------------------------------------------------------- MCP helpers

let rpcId = 1;
async function rpc(ctx, accessToken, method, params, { notification = false } = {}) {
  const msg = { jsonrpc: '2.0', method, ...(params ? { params } : {}), ...(notification ? {} : { id: rpcId++ }) };
  const r = await fetch(`${ctx.base}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
    body: JSON.stringify(msg),
  });
  const text = await r.text();
  return { status: r.status, headers: r.headers, body: text ? JSON.parse(text) : null };
}

async function callTool(ctx, accessToken, name, args = {}) {
  const r = await rpc(ctx, accessToken, 'tools/call', { name, arguments: args });
  if (r.status !== 200) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body)}`);
  const res = r.body.result;
  return { ...JSON.parse(res.content[0].text), _isError: Boolean(res.isError) };
}

module.exports = { TEAM, AUD, EMAIL, SECRET, CLAUDE_REDIRECT, startApp, signJwt, rsaKey, pkce, register, authorizeUrl, approve, token, connect, rpc, callTool, accessHeaders };
