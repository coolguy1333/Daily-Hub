'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

const DAY = 24 * 3600e3;

test('retention: 30 days for entries and resolved alerts, 7 days for snapshots', async () => {
  const ctx = await h.startApp();
  try {
    const hub = ctx.app.hub;
    const iso = ms => new Date(ms).toISOString();
    const t0 = ctx.clock.now();
    hub.publish({
      update: { kind: 'note', status: 'ok', title: 'old' },
      news: [{ topic: 'T', headline: 'old', url: 'https://example.com/old' }],
      emails: [{ id: 'old', received_at: iso(t0 - 1000), sender: 'a', subject: 'b' }],
      network: { taken_at: iso(t0), items: [{ group: 'other', name: 'x', state: 'ok' }] },
      alerts: { raise: [{ key: 'resolved-old', severity: 'info', title: 't' }, { key: 'still-open', severity: 'warn', title: 't' }] },
    });
    hub.resolveAlert({ key: 'resolved-old' });

    ctx.clock.advance(8 * DAY);
    hub.publish({ network: { taken_at: iso(ctx.clock.now()), items: [{ group: 'other', name: 'y', state: 'ok' }] } });
    assert.deepEqual(hub.retention(), { snapshots: 1 });
    assert.equal(ctx.app.store.hub.snapshots.length, 1);

    ctx.clock.advance(23 * DAY);
    hub.publish({ update: { kind: 'note', status: 'ok', title: 'new' }, news: [{ topic: 'T', headline: 'new', url: 'https://example.com/new' }] });
    const removed = hub.retention();
    assert.deepEqual(removed, { updates: 1, news: 1, emails: 1, alerts: 1, snapshots: 1 });
    const d = ctx.app.store.hub;
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
