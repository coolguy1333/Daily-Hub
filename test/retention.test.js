'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

const DAY = 24 * 3600e3;

test('retention: 30 days for entries and resolved alerts', async () => {
  const ctx = await h.startApp();
  try {
    const hub = ctx.app.hub;
    const d0 = () => ctx.app.store.hub;
    const iso = ms => new Date(ms).toISOString();
    const t0 = ctx.clock.now();
    hub.publish({
      update: { kind: 'note', status: 'ok', title: 'old' },
      news: [{ topic: 'T', headline: 'old', url: 'https://example.com/old' }],
      emails: [{ id: 'old', received_at: iso(t0 - 1000), sender: 'a', subject: 'b' }],
      alerts: { raise: [{ key: 'resolved-old', severity: 'info', title: 't' }, { key: 'still-open', severity: 'warn', title: 't' }] },
    });
    hub.resolveAlert({ key: 'resolved-old' });

    ctx.clock.advance(8 * DAY);
    assert.deepEqual(hub.retention(), {}, 'nothing is 30 days old yet');

    ctx.clock.advance(23 * DAY);
    hub.publish({ update: { kind: 'note', status: 'ok', title: 'new' }, news: [{ topic: 'T', headline: 'new', url: 'https://example.com/new' }] });
    const removed = hub.retention();
    assert.deepEqual(removed, { updates: 1, news: 1, emails: 1, alerts: 1 });
    const d = d0();
    assert.deepEqual(d.updates.map(u => u.title), ['new']);
    assert.deepEqual(d.news.map(n => n.headline), ['new']);
    assert.deepEqual(d.emails, []);
    assert.deepEqual(d.alerts.map(a => a.key), ['still-open'], 'open alerts are kept however old');
    assert.deepEqual(hub.retention(), {}, 'nothing more to do');
  } finally { await ctx.close(); }
});

test('retention: expired OAuth tokens and abandoned clients are pruned', async () => {
  const ctx = await h.startApp();
  try {
    await h.connect(ctx);
    await h.register(ctx); // never approved
    ctx.clock.advance(2 * DAY);
    ctx.app.oauth.prune();
    const db = ctx.app.store.oauth;
    assert.equal(Object.keys(db.clients).length, 1, 'unapproved client removed after a day');
    assert.equal(Object.keys(db.access).length, 0, 'expired access token removed');
    assert.equal(Object.keys(db.refresh).length, 1);
  } finally { await ctx.close(); }
});

test('startup drops network snapshots and site notes from hub.json (removed in 1.3.0)', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { Store } = require('../lib/store');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-hub-130-'));
  const file = path.join(dir, 'hub.json');
  const update = { id: 'u_1', at: '2026-11-27T10:00:00.000Z', kind: 'daily', status: 'ok', title: 'kept', summary: '', items: [] };
  fs.writeFileSync(file, JSON.stringify({
    updates: [update], news: [], emails: [], alerts: [],
    snapshots: [{ id: 'n_1', taken_at: '2026-11-27T10:00:00.000Z', items: [{ group: 'other', name: 'x', state: 'ok' }] }],
    site_notes: [{ id: 's_1', site: 'WebManager', title: 'note' }],
  }));
  const logs = [];
  const orig = console.log;
  console.log = m => logs.push(m);
  try { new Store(dir); } finally { console.log = orig; }
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(after).sort(), ['alerts', 'emails', 'news', 'updates']);
  assert.deepEqual(after.updates, [update], 'everything else is kept');
  assert.match(logs.join('\n'), /Dropped 1 snapshots, 1 site_notes/);

  // A second start has nothing to drop and leaves the file alone.
  const mtime = fs.statSync(file).mtimeMs;
  new Store(dir);
  assert.equal(fs.statSync(file).mtimeMs, mtime);
  fs.rmSync(dir, { recursive: true, force: true });
});
