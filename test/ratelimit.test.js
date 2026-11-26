'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { RateLimiter } = require('../lib/ratelimit');
const h = require('./helpers');

test('RateLimiter: fixed window per key', () => {
  const rl = new RateLimiter(3, 60e3);
  for (let i = 0; i < 3; i++) { assert.equal(rl.blocked('a'), false); rl.hit('a'); }
  assert.equal(rl.blocked('a'), true);
  assert.equal(rl.blocked('b'), false);
  rl.clear('a');
  assert.equal(rl.blocked('a'), false);
});

test('/mcp allows 60 calls per minute per client', async () => {
  const ctx = await h.startApp();
  try {
    const a = await h.connect(ctx);
    const b = await h.connect(ctx);
    for (let i = 0; i < 60; i++) assert.equal((await h.rpc(ctx, a.access_token, 'tools/list')).status, 200, `call ${i + 1}`);
    const r = await h.rpc(ctx, a.access_token, 'tools/list');
    assert.equal(r.status, 429);
    assert.equal(r.headers.get('retry-after'), '60');
    assert.equal((await h.rpc(ctx, b.access_token, 'tools/list')).status, 200, 'another client has its own budget');
  } finally { await ctx.close(); }
});

test('client IP comes from CF-Connecting-IP', async () => {
  const ctx = await h.startApp();
  try {
    const reg = ip => fetch(`${ctx.base}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip }, body: JSON.stringify({ redirect_uris: [h.CLAUDE_REDIRECT] }) });
    for (let i = 0; i < 10; i++) assert.equal((await reg('203.0.113.5')).status, 201);
    assert.equal((await reg('203.0.113.5')).status, 429);
    assert.equal((await reg('203.0.113.6')).status, 201);
  } finally { await ctx.close(); }
});
