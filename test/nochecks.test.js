'use strict';
// The app makes no outbound site checks: everything on the page comes through the MCP connector.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const h = require('./helpers');

test('no site checks: no outbound requests besides Access keys, and old sites.json is removed', async () => {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'daily-hub-old-'));
  fs.writeFileSync(path.join(dir, 'sites.json'), '{"webmanager":{"results":[]}}');
  new (require('../lib/store').Store)(dir);
  assert.equal(fs.existsSync(path.join(dir, 'sites.json')), false);
  fs.rmSync(dir, { recursive: true, force: true });

  const ctx = await h.startApp();
  try {
    ctx.app.startBackground();
    await new Promise(r => setTimeout(r, 2500));
    assert.equal(fs.existsSync(path.join(ctx.dir, 'sites.json')), false);
    assert.ok(!fs.readFileSync(path.join(__dirname, '..', 'lib', 'app.js'), 'utf8').includes('webmgr.dev'));
    const d = await (await fetch(`${ctx.base}/api/dashboard`, { headers: h.accessHeaders(ctx) })).json();
    assert.deepEqual(d.sites, []);
    assert.deepEqual(ctx.unexpected, [], 'no site checks were made');
  } finally { await ctx.close(); }
});
