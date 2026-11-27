'use strict';
// Every MCP tool, called over HTTP through the real /mcp endpoint.
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

let ctx, tok;
const call = (name, args) => h.callTool(ctx, tok, name, args);
const iso = ms => new Date(ms).toISOString();
const ago = min => iso(ctx.clock.now() - min * 60e3);

test.before(async () => { ctx = await h.startApp(); tok = (await h.connect(ctx)).access_token; });
test.after(() => ctx.close());

test('tools/list: names, short descriptions, annotations, strict schemas', async () => {
  const r = await h.rpc(ctx, tok, 'tools/list');
  const tools = Object.fromEntries(r.body.result.tools.map(t => [t.name, t]));
  assert.deepEqual(Object.keys(tools).sort(), ['delete_entry', 'get_state', 'list_entries', 'publish', 'raise_alert', 'resolve_alert', 'set_need_to_read']);
  assert.equal(tools.get_state.annotations.readOnlyHint, true);
  assert.equal(tools.list_entries.annotations.readOnlyHint, true);
  assert.equal(tools.delete_entry.annotations.destructiveHint, true);
  assert.equal(tools.publish.annotations.readOnlyHint, false);
  for (const t of Object.values(tools)) {
    assert.ok(t.description.length < 200, `${t.name} description is short`);
    assert.equal(t.inputSchema.type, 'object');
    assert.equal(t.inputSchema.additionalProperties, false);
  }
});

test('get_state on an empty hub', async () => {
  const s = await call('get_state');
  assert.deepEqual(s.latest, { update: null, news_at: null, email_received_at: null });
  assert.equal('sites' in s, false);
  assert.deepEqual(Object.keys(s.counts).sort(), ['alerts_open', 'emails', 'need_to_read', 'news', 'updates']);
  assert.deepEqual(s.open_alerts, []);
  assert.deepEqual(s.need_to_read, []);
  assert.equal(s.counts.updates, 0);
});

test('publish: all parts in one call, compact response', async () => {
  const r = await call('publish', {
    update: { kind: 'daily', status: 'warn', title: 'Morning run', summary: 'All fine\nexcept backups.', items: [{ name: 'backup', state: 'warn', detail: 'late' }] },
    news: [{ topic: 'Tech', source: 'Example', headline: 'Big news', summary: 's', url: 'https://example.com/a' }],
    emails: [{ id: 'm1', received_at: ago(30), sender: 'Bank', subject: 'Statement', label: 'Finance', need_to_read: true }],
    alerts: { raise: [{ key: 'backup-late', severity: 'warn', title: 'Backup late' }] },
  });
  assert.deepEqual(r, { ok: true, added: { updates: 1, news: 1, emails: 1, alerts: 1 }, updated: {}, rejected: [], _isError: false });
  assert.ok(!JSON.stringify(r).includes('Morning run'), 'content is not echoed');

  const s = await call('get_state');
  assert.equal(s.latest.update.title, 'Morning run');
  assert.equal(s.latest.news_at, ago(0));
  assert.equal(s.latest.email_received_at, ago(30));
  assert.equal(s.open_alerts[0].key, 'backup-late');
  assert.deepEqual(s.need_to_read.map(e => e.id), ['m1']);
  assert.equal(s.counts.need_to_read, 1);
});

test('publish: bad items are rejected one by one, the rest is applied', async () => {
  const r = await call('publish', {
    news: [
      { topic: 'Tech', headline: 'Good', url: 'https://example.com/good' },
      { topic: 'Tech', headline: 'No url' },
      { topic: 'Tech', headline: 'x'.repeat(501), url: 'https://example.com/long' },
    ],
    update: { kind: 'weekly', status: 'ok', title: 'bad kind' },
    bogus: {},
  });
  assert.equal(r.ok, false);
  assert.deepEqual(r.added, { news: 1 });
  const parts = r.rejected.map(x => `${x.part}${x.index !== undefined ? `[${x.index}]` : ''}`).sort();
  assert.deepEqual(parts, ['bogus', 'news[1]', 'news[2]', 'update']);
  assert.match(r.rejected.find(x => x.part === 'bogus').reason, /unknown part/);
});

test('publish: news is deduplicated by url', async () => {
  const r = await call('publish', { news: [
    { topic: 'Tech', headline: 'Good (edited)', url: 'https://example.com/good' },
    { topic: 'Tech', headline: 'Twice', url: 'https://example.com/twice' },
    { topic: 'Tech', headline: 'Twice again', url: 'https://example.com/twice' },
  ] });
  assert.deepEqual(r.added, { news: 1 });
  assert.deepEqual(r.updated, { news: 2 });
  const urls = ctx.app.store.hub.news.map(n => n.url);
  assert.equal(urls.filter(u => u === 'https://example.com/good').length, 1);
  assert.equal(urls.filter(u => u === 'https://example.com/twice').length, 1);
});

test('publish: emails accept only the six fields, are upserted by id, masked and stripped', async () => {
  const r = await call('publish', { emails: [
    { id: 'm2', received_at: ago(10), sender: 'Shop https://shop.example/track', subject: 'Your verification code is 123456 – see www.x.com/a', label: 'Security', need_to_read: false },
    { id: 'm3', received_at: ago(10), sender: 'A', subject: 'B', body: 'the whole email' },
    { id: 'm4', received_at: ago(10), sender: 'A', subject: 'B', snippet: 'x' },
    { id: 'm1', received_at: ago(30), sender: 'Bank', subject: 'Statement (updated)', label: 'Finance', need_to_read: true },
  ] });
  assert.deepEqual(r.added, { emails: 1 });
  assert.deepEqual(r.updated, { emails: 1 });
  assert.deepEqual(r.rejected.map(x => [x.index, x.reason]), [[1, 'unknown field "body"'], [2, 'unknown field "snippet"']]);
  const m2 = ctx.app.store.hub.emails.find(e => e.id === 'm2');
  assert.equal(m2.sender, 'Shop');
  assert.equal(m2.subject, 'Your verification code is ••• – see');
  assert.deepEqual(Object.keys(m2).sort(), ['at', 'id', 'label', 'need_to_read', 'received_at', 'sender', 'subject']);
  assert.equal(ctx.app.store.hub.emails.filter(e => e.id === 'm1').length, 1);
  // The page never shows the Gmail id.
  assert.ok(!JSON.stringify(ctx.app.hub.view().email).includes('"m2"'));
});

test('publish: republishing an email keeps its stored label, Need to Read flag and subject', async () => {
  const base = { id: 'keep1', received_at: ago(20), sender: 'Landlord' };
  await call('publish', { emails: [{ ...base, subject: 'Lease renewal', label: 'Home', need_to_read: true }] });
  const stored = () => ctx.app.store.hub.emails.find(e => e.id === 'keep1');

  let r = await call('publish', { emails: [{ ...base, sender: 'Landlord (new name)' }] });
  assert.deepEqual(r.updated, { emails: 1 });
  assert.deepEqual([stored().label, stored().need_to_read, stored().subject, stored().sender], ['Home', true, 'Lease renewal', 'Landlord (new name)']);

  r = await call('publish', { emails: [{ ...base, label: 'Bills', need_to_read: false, subject: 'Lease renewal (reply)' }] });
  assert.deepEqual([stored().label, stored().need_to_read, stored().subject], ['Bills', false, 'Lease renewal (reply)'], 'sent fields still update');

  // Defaults apply only to new emails.
  await call('publish', { emails: [{ id: 'new1', received_at: ago(5), sender: 'Someone' }] });
  const n = ctx.app.store.hub.emails.find(e => e.id === 'new1');
  assert.deepEqual([n.label, n.need_to_read, n.subject], ['', false, '']);
  await call('delete_entry', { section: 'emails', id: 'keep1' });
  await call('delete_entry', { section: 'emails', id: 'new1' });
});

test('publish: more than 200 items per call are rejected individually', async () => {
  const news = Array.from({ length: 205 }, (_, i) => ({ topic: 'Bulk', headline: `n${i}`, url: `https://example.com/bulk/${i}` }));
  const r = await call('publish', { news });
  assert.equal(r.added.news, 200);
  assert.equal(r.rejected.length, 5);
  assert.match(r.rejected[0].reason, /over 200 items/);
});

test('removed in 1.3.0: network and sites parts are rejected, the rest of the call still applies', async () => {
  const r = await call('publish', {
    network: { taken_at: ago(1), items: [{ group: 'proxmox', name: 'pve1', state: 'ok' }] },
    sites: [{ site: 'WebManager', status: 'ok', title: 'Backup finished' }],
    news: [{ topic: 'Tech', headline: 'Still accepted', url: 'https://example.com/still' }],
  });
  assert.equal(r._isError, false, 'an old run calling with network/sites does not fail');
  assert.deepEqual(r.added, { news: 1 });
  assert.deepEqual(r.rejected, [{ part: 'network', reason: 'unknown part' }, { part: 'sites', reason: 'unknown part' }]);
  assert.equal('snapshots' in ctx.app.store.hub, false);
  assert.equal('site_notes' in ctx.app.store.hub, false);

  const tools = Object.fromEntries((await h.rpc(ctx, tok, 'tools/list')).body.result.tools.map(t => [t.name, t]));
  assert.deepEqual(Object.keys(tools.publish.inputSchema.properties), ['update', 'news', 'emails', 'alerts']);
  for (const t of ['list_entries', 'delete_entry']) assert.deepEqual(tools[t].inputSchema.properties.section.enum, ['updates', 'news', 'emails', 'alerts']);
  assert.doesNotMatch(JSON.stringify(Object.values(tools).map(t => t.description)), /network|sites?\b/i);
  for (const section of ['network', 'sites']) {
    assert.equal((await call('list_entries', { section }))._isError, true, `list_entries ${section}`);
    assert.equal((await call('delete_entry', { section, id: 'x' }))._isError, true, `delete_entry ${section}`);
  }
});

test('publish: every update kind is still accepted', async () => {
  const r = await call('publish', { update: { kind: 'hourly', status: 'ok', title: 'Hourly check' } });
  assert.deepEqual(r.added, { updates: 1 });
  assert.equal((await call('publish', { update: { kind: 'note', status: 'ok', title: 'A note' } })).added.updates, 1);
});

test('raise_alert / resolve_alert are idempotent by key', async () => {
  let r = await call('raise_alert', { key: 'disk', severity: 'warn', title: 'Disk 85%' });
  assert.equal(r.result, 'added');
  const since = ctx.app.store.hub.alerts.find(a => a.key === 'disk').since;
  ctx.clock.advance(60e3);
  r = await call('raise_alert', { key: 'disk', severity: 'critical', title: 'Disk 95%' });
  assert.equal(r.result, 'updated');
  const open = ctx.app.store.hub.alerts.filter(a => a.key === 'disk');
  assert.equal(open.length, 1);
  assert.equal(open[0].severity, 'critical');
  assert.equal(open[0].since, since, 'raising an open alert keeps its start time');

  const s = await call('get_state');
  assert.equal(s.open_alerts[0].key, 'disk', 'most severe first');

  r = await call('resolve_alert', { key: 'disk' });
  assert.equal(r.result, 'resolved');
  r = await call('resolve_alert', { key: 'disk' });
  assert.equal(r.result, 'already_resolved');
  r = await call('resolve_alert', { key: 'never-raised' });
  assert.deepEqual([r.ok, r.result], [true, 'not_found']);

  r = await call('raise_alert', { key: 'disk', severity: 'info', title: 'Disk again' });
  assert.equal(r.result, 'added', 'a resolved alert opens again');

  r = await call('raise_alert', { key: 'disk', severity: 'loud', title: 'x' });
  assert.equal(r._isError, true);
  assert.match(r.error, /severity/);
});

test('publish: alerts.raise and alerts.resolve', async () => {
  const r = await call('publish', { alerts: { raise: [{ key: 'a1', severity: 'info', title: 'A1' }], resolve: ['disk', 'backup-late', 'unknown'] } });
  assert.deepEqual(r.added, { alerts: 1 });
  assert.deepEqual(r.updated, { resolved: 2 });
});

test('set_need_to_read clears flags by id', async () => {
  let r = await call('set_need_to_read', { ids: ['m1', 'nope'], value: false });
  assert.deepEqual(r, { ok: true, updated: 1, unchanged: 0, not_found: 1, _isError: false });
  r = await call('set_need_to_read', { ids: ['m1'] });
  assert.equal(r.unchanged, 1, 'value defaults to false');
  assert.equal((await call('get_state')).counts.need_to_read, 0);
});

test('list_entries: newest first, limit <= 50, since filter', async () => {
  let r = await call('list_entries', { section: 'news', limit: 3 });
  assert.equal(r.items.length, 3);
  assert.equal(r.more, true);
  assert.deepEqual(Object.keys(r.items[0]).sort(), ['at', 'headline', 'id', 'topic']);
  r = await call('list_entries', { section: 'news', limit: 51 });
  assert.equal(r._isError, true);
  const m2At = ctx.app.store.hub.emails.find(e => e.id === 'm2').received_at;
  r = await call('list_entries', { section: 'emails', since: m2At });
  assert.deepEqual(r.items.map(e => e.id), ['m2']);
  r = await call('list_entries', { section: 'nope' });
  assert.equal(r._isError, true);
});

test('delete_entry removes one entry', async () => {
  const { items } = await call('list_entries', { section: 'updates', limit: 1 });
  let r = await call('delete_entry', { section: 'updates', id: items[0].id });
  assert.deepEqual([r.ok, r.deleted], [true, 1]);
  r = await call('delete_entry', { section: 'updates', id: items[0].id });
  assert.equal(r.deleted, 0);
  r = await call('delete_entry', { section: 'alerts', id: 'a1' });
  assert.equal(r.deleted, 1);
  r = await call('delete_entry', { section: 'emails', id: 'm2', extra: true });
  assert.equal(r._isError, true);
});

test('stored data survives a restart (written to /data)', async () => {
  const { Store } = require('../lib/store');
  const s = new Store(ctx.dir);
  assert.ok(s.hub.news.length > 0);
  assert.ok(s.hub.emails.some(e => e.id === 'm1'));
});
