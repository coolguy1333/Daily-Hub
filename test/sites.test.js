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

function flaky() {
  const state = { web: { body: '{"status":"ok"}' }, upt: { body: '{"status":"ok","uptime":1000,"version":"2.14.0"}' } };
  const s = setup({});
  s.sites.fetch = async url => {
    const r = url.includes('upt.') ? state.upt : state.web;
    if (r instanceof Error) throw r;
    return new Response(r.body, { status: r.status || 200 });
  };
  return { ...s, state, titles: id => s.store.sites[id].events.map(e => e.title) };
}

test('site events: one failed check is ignored; two in a row mark it down; recovery says for how long', async () => {
  const s = flaky();
  await s.sites.checkAll();
  s.state.web = { body: 'Bad gateway', status: 502 };
  s.advance(60e3); await s.sites.checkAll();
  assert.deepEqual(s.titles('webmanager'), [], 'a single blip makes no event');
  s.state.web = { body: '{"status":"ok"}' };
  s.advance(60e3); await s.sites.checkAll();
  assert.deepEqual(s.titles('webmanager'), []);

  s.state.web = { body: 'Bad gateway', status: 502 };
  s.advance(60e3); await s.sites.checkAll();
  s.advance(60e3); await s.sites.checkAll();
  s.advance(60e3); await s.sites.checkAll();
  assert.deepEqual(s.titles('webmanager'), ['Down: HTTP 502'], 'one down event, not one per check');
  assert.equal(s.sites.summary()[0].state, 'down');

  s.state.web = { body: '{"status":"ok"}' };
  s.advance(5 * 60e3); await s.sites.checkAll();
  assert.deepEqual(s.titles('webmanager'), ['Down: HTTP 502', 'Back up after 7m']);
  assert.equal(s.sites.summary()[0].state, 'up');
  s.cleanup();
});

test('site events: new version and restart of Homelab Status', async () => {
  const s = flaky();
  await s.sites.checkAll();
  s.advance(60e3);
  s.state.upt = { body: '{"status":"ok","uptime":1060,"version":"2.14.0"}' };
  await s.sites.checkAll();
  assert.deepEqual(s.titles('homelab'), [], 'uptime grew normally');

  s.advance(60e3);
  s.state.upt = { body: '{"status":"ok","uptime":30,"version":"2.15.0"}' };
  await s.sites.checkAll();
  assert.deepEqual(s.titles('homelab'), ['Updated to v2.15.0'], 'a version change is reported once, not also as a restart');
  assert.equal(s.store.sites.homelab.events[0].detail, 'was v2.14.0');

  s.advance(60e3);
  s.state.upt = { body: '{"status":"ok","uptime":15,"version":"2.15.0"}' };
  await s.sites.checkAll();
  assert.deepEqual(s.titles('homelab'), ['Updated to v2.15.0', 'Restarted']);

  const v = s.sites.view().find(x => x.id === 'homelab');
  assert.deepEqual(v.events.map(e => e.title), ['Restarted', 'Updated to v2.15.0'], 'newest first');
  s.cleanup();
});

test('site events: kept 7 days', async () => {
  const s = flaky();
  await s.sites.checkAll();
  s.state.web = new TypeError('fetch failed');
  s.advance(60e3); await s.sites.checkAll();
  s.advance(60e3); await s.sites.checkAll();
  assert.deepEqual(s.titles('webmanager'), ['Down: unreachable']);
  s.state.web = { body: '{"status":"ok"}' };
  s.advance(8 * 24 * 3600e3); await s.sites.checkAll();
  assert.deepEqual(s.titles('webmanager'), ['Back up after 8d 0h'], 'the 8-day-old down event is gone');
  s.cleanup();
});
