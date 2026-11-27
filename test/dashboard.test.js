'use strict';
// /api/dashboard (one call with every page's data) and the pure functions behind the page.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const h = require('./helpers');
const { staleCheck, badgeCounts, httpsLink, STALE_AFTER } = require('../lib/view');

const HOUR = 3600e3;

test('staleCheck: the banner turns on after 2 hours without an update', () => {
  const now = Date.parse('2026-11-27T12:00:00Z');
  const at = ms => new Date(now - ms).toISOString();
  assert.equal(STALE_AFTER, 2 * HOUR);
  assert.deepEqual(staleCheck(at(5 * 60e3), now), { stale: false, since: at(5 * 60e3) });
  assert.equal(staleCheck(at(2 * HOUR), now).stale, false, 'exactly 2 hours is not yet stale');
  assert.equal(staleCheck(at(2 * HOUR + 1000), now).stale, true);
  assert.deepEqual(staleCheck(null, now), { stale: true, since: null }, 'no update at all');
  assert.equal(staleCheck('garbage', now).stale, true);
});

test('badgeCounts: critical alerts, open alerts, network down, Need to Read, sites down', () => {
  const alert = severity => ({ severity });
  const net = (down, warn) => ({ counts: { ok: 3, warn, down } });
  let b = badgeCounts({ openAlerts: [alert('critical'), alert('warn'), alert('critical'), alert('info')], network: net(2, 5), needToRead: 4, siteCards: [{ status: 'down' }, { status: 'warn' }] });
  assert.deepEqual(b, {
    overview: { n: 2, cls: 'bad' },
    alerts: { n: 4, cls: 'bad' },
    network: { n: 2, cls: 'bad' },
    email: { n: 4, cls: 'new' },
    sites: { n: 1, cls: 'bad' },
  });
  b = badgeCounts({ openAlerts: [alert('warn'), alert('info')], network: net(0, 3), needToRead: 0 });
  assert.deepEqual(b.alerts, { n: 2, cls: 'warn' }, 'amber when nothing is critical');
  assert.equal(b.overview.n, 0);
  assert.equal(b.network.n, 0, 'warn items do not count, only down');
  assert.equal(b.email.n, 0);
  assert.equal(badgeCounts({}).network.n, 0, 'no snapshot');
});

test('httpsLink: only well-formed https:// URLs become links', () => {
  assert.equal(httpsLink('https://example.com/a?b=1'), 'https://example.com/a?b=1');
  for (const u of ['http://example.com', 'javascript:alert(1)', ' https://example.com', 'HTTPS:/x', 'https://', 'ftp://x', 'data:text/html,x', '', null, 42]) {
    assert.equal(httpsLink(u), null, String(u));
  }
});

test('/api/dashboard: every page in one call, no sites field', async () => {
  const ctx = await h.startApp();
  try {
    const iso = ms => new Date(ctx.clock.now() - ms).toISOString();
    const hub = ctx.app.hub;
    hub.publish({
      update: { kind: 'hourly', status: 'warn', title: 'Hourly check', summary: 'One host warm.', items: [{ name: 'pve1', state: 'warn', detail: '81 °C' }] },
      network: { taken_at: iso(60e3), items: [
        { group: 'proxmox', name: 'pve1', state: 'ok' }, { group: 'unifi', name: 'ap-1', state: 'down' }, { group: 'services', name: 'dns', state: 'warn' },
      ] },
      news: [
        { topic: 'Tech', headline: 'Safe', url: 'https://example.com/safe' },
        { topic: 'Tech', headline: 'Plain http', url: 'http://example.com/plain' },
        { topic: 'Tech', headline: 'Script', url: 'javascript:alert(1)' },
      ],
      emails: [
        { id: 'a', received_at: iso(10 * 60e3), sender: 'Bank', subject: 'Statement', label: 'Finance', need_to_read: true },
        { id: 'b', received_at: iso(20 * 60e3), sender: 'Shop', subject: 'Shipped', label: 'Orders' },
        { id: 'c', received_at: iso(3 * 24 * HOUR), sender: 'Old', subject: 'Old', label: 'Orders', need_to_read: true },
        { id: 'd', received_at: iso(3 * 24 * HOUR), sender: 'Old', subject: 'Old 2', label: 'Orders' },
      ],
      alerts: { raise: [{ key: 'k1', severity: 'warn', title: 'Disk 85%' }, { key: 'k2', severity: 'critical', title: 'Backup failed' }, { key: 'k3', severity: 'info', title: 'FYI' }] },
      sites: [{ site: 'WebManager', status: 'down', title: 'Down: HTTP 502' }],
    });
    hub.resolveAlert({ key: 'k3' });
    for (let i = 0; i < 105; i++) hub.publish({ update: { kind: i % 2 ? 'note' : 'daily', status: 'ok', title: `u${i}` } });

    const r = await fetch(`${ctx.base}/api/dashboard`, { headers: h.accessHeaders(ctx) });
    assert.equal(r.status, 200);
    const d = await r.json();
    assert.deepEqual(Object.keys(d).sort(), ['alerts', 'badges', 'clients', 'email', 'network', 'news', 'now', 'overview', 'site_notes', 'title', 'updates', 'user']);
    assert.equal('sites' in d, false);
    assert.equal(d.user, h.EMAIL);
    assert.equal(d.title, 'Daily hub');

    // Overview
    assert.equal(d.overview.latest.title, 'u104');
    assert.deepEqual(d.overview.checkin.stale, false);
    assert.deepEqual(d.overview.attention.map(a => a.severity), ['critical', 'warn'], 'most severe first, resolved excluded');
    assert.deepEqual(d.overview.stats, { open_alerts: 2, need_to_read: 2, network_problems: 2, news_24h: 3 });
    // Updates: at most 100, newest first, with items
    assert.equal(d.updates.length, 100);
    assert.equal(d.updates[0].title, 'u104');
    assert.ok(d.updates.every(u => 'items' in u && !('id' in u)));
    // Network: problems first
    assert.deepEqual(d.network.counts, { ok: 1, warn: 1, down: 1 });
    assert.deepEqual(d.network.groups.map(g => g.group), ['unifi', 'services', 'proxmox']);
    // Email: Need to Read (until cleared) on top, the rest of the last 24 hours by label, no ids
    assert.equal(d.email.count_24h, 2);
    assert.deepEqual(d.email.need_to_read.map(m => m.subject), ['Statement', 'Old']);
    assert.deepEqual(d.email.labels, [{ label: 'Orders', items: [{ received_at: iso(20 * 60e3), sender: 'Shop', subject: 'Shipped', label: 'Orders' }] }]);
    assert.ok(!JSON.stringify(d.email).includes('"id"'));
    // News: a link only for https://
    const links = Object.fromEntries(d.news[0].items.map(n => [n.headline, n.link]));
    assert.deepEqual(links, { Safe: 'https://example.com/safe', 'Plain http': null, Script: null });
    assert.ok(!JSON.stringify(d.news).includes('javascript:'), 'unsafe URLs are not sent to the page at all');
    // Alerts: open and resolved
    assert.deepEqual(d.alerts.open.map(a => a.title), ['Backup failed', 'Disk 85%']);
    assert.deepEqual(d.alerts.resolved.map(a => a.title), ['FYI']);
    // Sites (Claude's notes) and badges
    assert.deepEqual(d.site_notes.map(c => [c.site, c.status]), [['WebManager', 'down']]);
    assert.deepEqual(d.badges, { overview: { n: 1, cls: 'bad' }, alerts: { n: 2, cls: 'bad' }, network: { n: 1, cls: 'bad' }, email: { n: 2, cls: 'new' }, sites: { n: 1, cls: 'bad' } });

    // The stale banner turns on 2 hours after the newest update.
    ctx.clock.advance(2 * HOUR + 60e3);
    const later = await (await fetch(`${ctx.base}/api/dashboard`, { headers: h.accessHeaders(ctx) })).json();
    assert.equal(later.overview.checkin.stale, true);
    assert.equal(later.overview.checkin.since, d.overview.latest.at);

    // Resolved alerts older than 30 days drop off the Alerts page.
    ctx.clock.advance(31 * 24 * HOUR);
    const month = await (await fetch(`${ctx.base}/api/dashboard`, { headers: h.accessHeaders(ctx) })).json();
    assert.deepEqual(month.alerts.resolved, []);
  } finally { await ctx.close(); }
});

test('/api/dashboard keeps the Access check', async () => {
  const ctx = await h.startApp();
  try {
    assert.equal((await fetch(`${ctx.base}/api/dashboard`)).status, 403);
    assert.equal((await fetch(`${ctx.base}/api/dashboard`, { headers: { 'cf-access-jwt-assertion': ctx.jwt({ email: 'stranger@example.com' }) } })).status, 403);
  } finally { await ctx.close(); }
});

test('page script: links only for https://, text only through textContent, all eight pages routed', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.doesNotMatch(js, /\.innerHTML\s*=|insertAdjacentHTML|outerHTML\s*=|document\.write/);
  // The client-side check, run on its own.
  const src = js.match(/const httpsUrl = u => \{[\s\S]*?\n  \};/)[0];
  const httpsUrl = new Function(`${src}; return httpsUrl;`)();
  assert.equal(httpsUrl('https://example.com/x'), 'https://example.com/x');
  for (const u of ['http://example.com', 'javascript:alert(1)', null, 'https://']) assert.equal(httpsUrl(u), null, String(u));
  assert.match(js, /href \? el\('a', \{ href, target: '_blank', rel: 'noopener noreferrer'/);
  for (const v of ['overview', 'updates', 'network', 'email', 'news', 'sites', 'alerts', 'clients']) {
    assert.ok(html.includes(`href="#${v}" data-view="${v}"`), `nav ${v}`);
    assert.ok(html.includes(`<section class="view" data-view="${v}" hidden><div id="v-${v}"></div></section>`), `view ${v}`);
    assert.ok(html.includes(`data-badge="${v}"`), `badge ${v}`);
  }
  assert.doesNotMatch(html, /<script>|<style|\sstyle=|\son\w+=/i, 'no inline scripts, styles or handlers');
});
