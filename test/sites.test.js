'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../lib/store');
const { SiteChecker } = require('../lib/sites');

function setup(responses) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-hub-sites-'));
  let t = Date.parse('2026-11-26T12:00:00Z');
  const fetch = async url => {
    const r = responses[url];
    if (r instanceof Error) throw r;
    return new Response(r.body, { status: r.status || 200 });
  };
  const store = new Store(dir);
  const sites = new SiteChecker(store, { fetch, now: () => t });
  return { sites, store, advance: ms => { t += ms; }, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('sites: healthy only when status is "ok"; version and uptime are shown', async () => {
  const s = setup({
    'https://webmgr.dev/healthz': { body: '{"status":"ok"}' },
    'https://upt.webmgr.dev/api/health': { body: '{"status":"ok","uptime":90061,"version":"2.14.0","time":"x"}' },
  });
  await s.sites.checkAll();
  const v = s.sites.view();
  assert.deepEqual(v.map(x => x.state), ['up', 'up']);
  assert.deepEqual(v[1].info, { version: '2.14.0', uptime: 90061 });
  assert.equal(v[0].info, null);
  assert.equal(v[0].bars.length, 24);
  assert.equal(v[0].bars[23].pct, 100);
  s.cleanup();
});

test('sites: wrong body, HTTP errors and network errors are down', async () => {
  const s = setup({
    'https://webmgr.dev/healthz': { body: '{"status":"degraded"}' },
    'https://upt.webmgr.dev/api/health': { body: 'Bad gateway', status: 502 },
  });
  await s.sites.checkAll();
  let v = s.sites.view();
  assert.deepEqual(v.map(x => [x.state, x.error]), [['down', 'unexpected response'], ['down', 'HTTP 502']]);
  s.sites.fetch = async () => { throw new TypeError('fetch failed'); };
  await s.sites.checkAll();
  v = s.sites.view();
  assert.equal(v[0].error, 'unreachable');
  s.cleanup();
});

test('sites: 7 days of results are kept, and saved to sites.json', async () => {
  const s = setup({ 'https://webmgr.dev/healthz': { body: '{"status":"ok"}' }, 'https://upt.webmgr.dev/api/health': { body: '{"status":"ok"}' } });
  await s.sites.checkAll();
  s.advance(7 * 24 * 3600e3 + 1000);
  await s.sites.checkAll();
  assert.equal(s.store.sites.webmanager.results.length, 1);
  s.store.saveSites(true);
  assert.equal(new Store(s.store.dir).sites.webmanager.results.length, 1);
  s.cleanup();
});
