#!/usr/bin/env node
'use strict';
/*
 * Daily hub - a small private dashboard that Claude fills through the app's own MCP server.
 *   node server.js
 * Configuration is read from environment variables; see README.md and .env.example.
 */
const path = require('path');
const { createApp } = require('./lib/app');
const { DEFAULT_REDIRECTS } = require('./lib/oauth');

const VERSION = require('./package.json').version;
const env = process.env;
const truthy = v => /^(1|true|yes|on)$/i.test(String(v || '').trim());
const PORT = parseInt(env.PORT || '8080', 10);
const HOST = env.HOST || '0.0.0.0';

const missing = ['CF_ACCESS_TEAM_DOMAIN', 'CF_ACCESS_AUD', 'ALLOWED_EMAILS', 'HUB_SECRET'].filter(k => !String(env[k] || '').trim());
if (missing.length) {
  console.error(`[config] Missing required settings: ${missing.join(', ')}. See README.md.`);
  process.exit(1);
}
if (env.HUB_SECRET.trim().length < 32) {
  console.error('[config] HUB_SECRET must be at least 32 characters (e.g. the output of: openssl rand -hex 32).');
  process.exit(1);
}
let PUBLIC_URL = String(env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
if (!/^https?:\/\/[^\s/]+$/i.test(PUBLIC_URL)) {
  if (PUBLIC_URL) console.warn(`[config] PUBLIC_URL "${PUBLIC_URL}" should look like https://hub.example.com (scheme and host, no path).`);
  PUBLIC_URL = `http://localhost:${PORT}`;
  console.warn(`[config] Using ${PUBLIC_URL} as PUBLIC_URL; OAuth for Claude needs the real https:// address.`);
}

const app = createApp({
  version: VERSION,
  dataDir: path.resolve(__dirname, env.DATA_DIR || 'data'),
  publicUrl: PUBLIC_URL,
  title: (env.SITE_TITLE || 'Daily hub').trim().slice(0, 100) || 'Daily hub',
  teamDomain: env.CF_ACCESS_TEAM_DOMAIN,
  aud: env.CF_ACCESS_AUD,
  allowedEmails: env.ALLOWED_EMAILS,
  secret: env.HUB_SECRET.trim(),
  redirectAllowlist: (env.OAUTH_REDIRECT_ALLOWLIST || '').trim() || DEFAULT_REDIRECTS,
  allowLoopback: truthy(env.MCP_ALLOW_LOOPBACK),
});

app.server.listen(PORT, HOST, () => {
  console.log(`[daily-hub] v${VERSION} listening on ${HOST}:${PORT}, public URL ${PUBLIC_URL}`);
  app.startBackground();
});

let stopping = false;
function shutdown(sig) {
  if (stopping) return;
  stopping = true;
  console.log(`[daily-hub] ${sig} received, shutting down`);
  app.close().then(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => shutdown(sig));
process.on('uncaughtException', err => console.error('[uncaught]', err));
process.on('unhandledRejection', err => console.error('[unhandled]', err));
