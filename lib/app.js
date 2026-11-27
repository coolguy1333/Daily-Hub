'use strict';
// HTTP routing: public endpoints (health, OAuth discovery/registration/token, MCP), and the
// page + page API behind Cloudflare Access.
const http = require('http');
const fs = require('fs');
const path = require('path');

const { Store } = require('./store');
const { Hub } = require('./hub');
const { OAuth, OAuthError, escapeHtml } = require('./oauth');
const { AccessVerifier } = require('./access');
const { SiteChecker } = require('./sites');
const { RateLimiter } = require('./ratelimit');
const { createMcp } = require('./mcp');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const STATIC = {
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};
const IP_RE = /^[0-9a-fA-F:.]{2,45}$/;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function createApp(config, deps = {}) {
  const now = deps.now || Date.now;
  const fetchFn = deps.fetch || globalThis.fetch;
  const log = deps.log || (msg => console.log(msg));
  const publicUrl = config.publicUrl.replace(/\/+$/, '');
  const ownOrigin = new URL(publicUrl).origin;

  const store = new Store(config.dataDir);
  const hub = new Hub(store, { now });
  const oauth = new OAuth({
    store, publicUrl, secret: config.secret, redirectAllowlist: config.redirectAllowlist,
    allowLoopback: config.allowLoopback, title: config.title, now,
  });
  const access = new AccessVerifier({ teamDomain: config.teamDomain, aud: config.aud, allowedEmails: config.allowedEmails, fetch: fetchFn, now });
  const sites = new SiteChecker(store, { fetch: fetchFn, now, version: config.version });
  hub.sitesState = () => sites.summary();
  const mcp = createMcp({ hub, version: config.version, title: config.title, log });
  const limits = {
    mcp: new RateLimiter(config.mcpRateLimit || 60),
    register: new RateLimiter(10),
    token: new RateLimiter(60),
    unauth: new RateLimiter(120),
  };

  const files = {};
  for (const [route, [file, type]] of Object.entries(STATIC)) files[route] = { body: fs.readFileSync(path.join(PUBLIC_DIR, file)), type };
  const indexHtml = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8').replaceAll('{{TITLE}}', escapeHtml(config.title));

  // ---------------------------------------------------------------- helpers

  const clientIp = req => {
    const cf = String(req.headers['cf-connecting-ip'] || '').trim();
    return IP_RE.test(cf) ? cf : (req.socket.remoteAddress || '');
  };

  function send(res, status, body, headers = {}) {
    const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
    const data = isJson ? JSON.stringify(body) : body;
    res.writeHead(status, { 'Content-Type': isJson ? 'application/json' : 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(data), ...headers });
    res.end(data);
  }

  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      const declared = parseInt(req.headers['content-length'] || '0', 10);
      if (declared > limit) { req.resume(); return reject(new HttpError(413, 'Request body too large')); }
      const chunks = [];
      let size = 0;
      req.on('data', c => {
        size += c.length;
        if (size > limit) { reject(new HttpError(413, 'Request body too large')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  const contentType = req => String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const formOf = text => Object.fromEntries(new URLSearchParams(text));

  // Browser requests that change something must come from this site.
  function sameOrigin(req) {
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== ownOrigin) return false;
    const site = req.headers['sec-fetch-site'];
    return site === undefined || site === 'same-origin' || site === 'none';
  }

  function rateLimited(res, limiter, key) {
    if (limiter.blocked(key)) {
      send(res, 429, { error: 'rate_limited', error_description: 'Too many requests' }, { 'Retry-After': '60' });
      return true;
    }
    limiter.hit(key);
    return false;
  }

  function oauthError(res, err) {
    if (!(err instanceof OAuthError)) throw err;
    send(res, err.status, { error: err.error, error_description: err.message });
  }

  // ---------------------------------------------------------------- routes

  async function route(req, res, url) {
    const p = url.pathname, m = req.method;

    if (p === '/api/health' && (m === 'GET' || m === 'HEAD')) return send(res, 200, { status: 'ok', version: config.version });

    if (p.startsWith('/.well-known/')) {
      const meta = {
        '/.well-known/oauth-protected-resource': () => oauth.protectedResource(),
        '/.well-known/oauth-protected-resource/mcp': () => oauth.protectedResource(),
        '/.well-known/oauth-authorization-server': () => oauth.authServer(),
      }[p];
      if (!meta || (m !== 'GET' && m !== 'HEAD')) return send(res, 404, { error: 'not_found' });
      return send(res, 200, meta(), { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=300' });
    }

    if (p === '/mcp') {
      res.setHeader('X-Accel-Buffering', 'no');
      res.setHeader('Cache-Control', 'no-store');
      const h = String(req.headers.authorization || '');
      const token = /^Bearer\s+/i.test(h) ? h.replace(/^Bearer\s+/i, '').trim() : '';
      const auth = token ? oauth.verifyAccess(token) : null;
      if (!auth) {
        if (rateLimited(res, limits.unauth, clientIp(req))) return;
        return send(res, 401, { error: 'invalid_token', error_description: 'Missing or invalid access token' }, { 'WWW-Authenticate': oauth.wwwAuthenticate(token ? 'invalid_token' : '') });
      }
      if (m !== 'POST') return send(res, 405, { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null }, { Allow: 'POST' });
      if (limits.mcp.blocked(auth.client_id)) {
        return send(res, 429, { jsonrpc: '2.0', error: { code: -32000, message: 'Rate limit: 60 calls per minute' }, id: null }, { 'Retry-After': '60' });
      }
      limits.mcp.hit(auth.client_id);
      let body;
      try { body = JSON.parse(await readBody(req, 1024 * 1024)); } catch (err) {
        if (err instanceof HttpError) throw err;
        return send(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null });
      }
      return mcp.handle(req, res, body, auth);
    }

    if (p === '/oauth/register') {
      res.setHeader('Cache-Control', 'no-store');
      if (m !== 'POST') return send(res, 405, { error: 'invalid_request' }, { Allow: 'POST' });
      if (rateLimited(res, limits.register, clientIp(req))) return;
      if (contentType(req) !== 'application/json') return send(res, 400, { error: 'invalid_client_metadata', error_description: 'Expected application/json' });
      let body;
      try { body = JSON.parse(await readBody(req, 16 * 1024)); } catch (err) {
        if (err instanceof HttpError) throw err;
        return send(res, 400, { error: 'invalid_client_metadata', error_description: 'Invalid JSON' });
      }
      try { return send(res, 201, oauth.register(body)); } catch (err) { return oauthError(res, err); }
    }

    if (p === '/oauth/token') {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Pragma', 'no-cache');
      if (m !== 'POST') return send(res, 405, { error: 'invalid_request' }, { Allow: 'POST' });
      if (rateLimited(res, limits.token, clientIp(req))) return;
      if (contentType(req) !== 'application/x-www-form-urlencoded') return send(res, 400, { error: 'invalid_request', error_description: 'Expected application/x-www-form-urlencoded' });
      const form = formOf(await readBody(req, 16 * 1024));
      let basicId = '';
      const ah = String(req.headers.authorization || '');
      if (/^Basic\s+/i.test(ah)) {
        try { basicId = decodeURIComponent(Buffer.from(ah.slice(6).trim(), 'base64').toString('utf8').split(':')[0]); } catch { /* ignore */ }
      }
      try { return send(res, 200, oauth.token(form, basicId)); } catch (err) { return oauthError(res, err); }
    }

    // ---------- everything below requires a valid Cloudflare Access token ----------
    let who;
    try {
      who = await access.verify(req.headers['cf-access-jwt-assertion']);
    } catch (err) {
      log(`[access] denied ${m} ${p}: ${err.message}`);
      return send(res, 403, 'Forbidden. Sign in through Cloudflare Access with an allowed account.');
    }

    if (p === '/oauth/authorize') {
      res.setHeader('Cache-Control', 'no-store');
      let result;
      if (m === 'GET') result = oauth.authorizeStart(Object.fromEntries(url.searchParams), who.email);
      else if (m === 'POST') {
        if (!sameOrigin(req)) return send(res, 403, 'Forbidden.');
        result = oauth.authorizeDecide(formOf(await readBody(req, 16 * 1024)), who.email);
      } else return send(res, 405, 'Method not allowed.', { Allow: 'GET, POST' });
      if (result.error) return send(res, 400, result.error);
      if (result.redirect) { res.writeHead(302, { Location: result.redirect }); return res.end(); }
      // The form posts here and is then redirected to the client, so form-action must allow its origin.
      return send(res, 200, result.page, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': CSP.replace("form-action 'self'", `form-action 'self' ${result.formTarget}`),
      });
    }

    if (p === '/' && (m === 'GET' || m === 'HEAD')) return send(res, 200, indexHtml, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    if (files[p] && (m === 'GET' || m === 'HEAD')) return send(res, 200, files[p].body, { 'Content-Type': files[p].type, 'Cache-Control': 'no-cache' });

    if (p === '/api/dashboard' && m === 'GET') {
      // Each site's feed: the checker's own events plus Claude's notes, newest first.
      const notes = hub.siteNotes();
      const siteView = sites.view().map(({ events, ...s }) => ({
        ...s,
        updates: [...events, ...(notes[s.id] || [])].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, 8),
      }));
      return send(res, 200, {
        title: config.title, user: who.email, now: new Date(now()).toISOString(),
        sites: siteView, clients: oauth.listClients(), ...hub.view(),
      }, { 'Cache-Control': 'no-store' });
    }

    if (p === '/api/clients/revoke' && m === 'POST') {
      if (!sameOrigin(req) || contentType(req) !== 'application/json') return send(res, 403, 'Forbidden.');
      let body;
      try { body = JSON.parse(await readBody(req, 4096)); } catch (err) {
        if (err instanceof HttpError) throw err;
        return send(res, 400, { error: 'Invalid JSON' });
      }
      const ok = oauth.revokeClient(String(body && body.client_id || ''));
      if (ok) log('[oauth] client revoked from the page');
      return send(res, ok ? 200 : 404, { ok });
    }

    return send(res, 404, 'Not found.');
  }

  const QUIET = new Set(['/api/health', '/app.js', '/style.css', '/favicon.svg']);
  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { return send(res, 400, 'Bad request.'); }
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    // Only the path is logged: query strings can hold OAuth parameters.
    if (!QUIET.has(url.pathname)) res.on('finish', () => log(`${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`));
    try {
      await route(req, res, url);
    } catch (err) {
      if (res.headersSent) { res.destroy(); return; }
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      console.error(`[http] ${req.method} ${url.pathname}: ${err.stack || err.message}`);
      send(res, 500, { error: 'Internal error' });
    }
  });
  server.headersTimeout = 20e3;
  server.requestTimeout = 60e3;

  const timers = [];
  function startBackground() {
    if (config.siteChecks !== false) sites.start();
    const runRetention = () => {
      try {
        const removed = hub.retention();
        if (Object.keys(removed).length) log(`[retention] removed ${JSON.stringify(removed)}`);
        oauth.prune();
      } catch (err) { console.error(`[retention] ${err.message}`); }
    };
    timers.push(setTimeout(runRetention, 5000), setInterval(runRetention, 24 * 3600e3), setInterval(() => oauth.prune(), 3600e3));
    for (const t of timers) t.unref();
  }

  function close() {
    for (const t of timers) clearTimeout(t);
    sites.stop();
    store.saveOauth();
    return new Promise(resolve => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  return { server, store, hub, oauth, access, sites, limits, startBackground, close };
}

module.exports = { createApp };
