'use strict';
// The app makes no site checks of its own: WebManager and Homelab Status appear only through what
// Claude publishes. An old sites.json in /data is left alone and never read.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const h = require('./helpers');

test('no site checks: no outbound requests, no sites field, old sites.json untouched', async () => {
  const ctx = await h.startApp();
  const old = path.join(ctx.dir, 'sites.json');
  const body = '{"webmanager":{"results":[{"t":1,"ok":true}]}}';
  fs.writeFileSync(old, body);
  try {
    ctx.app.startBackground();
    await new Promise(r => setTimeout(r, 2500));
    assert.deepEqual(ctx.unexpected, [], 'no site checks were made');
    assert.equal(fs.readFileSync(old, 'utf8'), body, 'sites.json left alone');
    assert.equal(fs.existsSync(path.join(__dirname, '..', 'lib', 'sites.js')), false);
    const d = await (await fetch(`${ctx.base}/api/dashboard`, { headers: h.accessHeaders(ctx) })).json();
    assert.equal('sites' in d, false);
    const src = ['lib/app.js', 'lib/store.js', 'lib/hub.js', 'public/app.js', 'public/index.html', 'README.md']
      .map(f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')).join('\n');
    assert.doesNotMatch(src, /webmgr\.dev\/healthz|upt\.webmgr\.dev\/api\/health|SiteChecker|saveSites/);
  } finally { await ctx.close(); }
});
